#!/usr/bin/env node
// Loads the built tokenized-stocks JSON into schema `sonar` of the one shared Postgres database
// (`geodata`), so the data can be grouped and joined in ways the static files cannot answer:
// issuers, mints, the per-day snapshot history under stocks/data/history/, and the trade tape —
// which accumulates here well past the rolling 24 h window the JSON keeps. Every load is an
// idempotent upsert guarded by IS DISTINCT FROM, so re-running touches nothing that has not
// changed, `updated_at` included. Uses the `psql` client over a child process rather than a
// driver, because this pipeline has zero npm dependencies. DATABASE_URL comes from the repo .env
// and is never logged — only the host and database name are.

import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readEnvFile } from './lib/env.mjs';
import { log, logError, logWarn, parseArgs, readJson, ts } from './lib/io.mjs';
import {
    buildIssuerSql, buildSnapshotSql, buildTokenSql, buildTradeSql, wrapTransaction
} from './lib/db-load.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const DDL_FILE = join(REPO, 'db', '2026-09-17-sonar-stocks.sql');
const HISTORY_DIR = join(REPO, 'stocks', 'data', 'history');
const STEPS = ['issuers', 'tokens', 'snapshots', 'trades'];
const TABLES = ['stock_issuer', 'stock_token', 'stock_token_snapshot', 'stock_trade'];

function usage() {
    console.log(`Load the built stocks JSON into schema \`sonar\` of the geodata database.

  node stocks/load-db.mjs --run [--ddl] [--only=issuers,tokens,snapshots,trades]

  --run     actually connect and load. Without it nothing happens (this message is printed).
  --ddl     apply db/2026-09-17-sonar-stocks.sql first. Idempotent; safe on every run.
  --only    limit to some of the steps, comma separated. Default: all four, in FK order
            (${STEPS.join(' -> ')}).
  --help    this message.

Inputs, all relative to the repo root:
  stocks-issuers.json                      -> sonar.stock_issuer
  stocks-tokens.json + stocks-health.json  -> sonar.stock_token
  stocks/data/history/<date>/tokens.json   -> sonar.stock_token_snapshot (every date present)
  stocks-trades.json                       -> sonar.stock_trade (accumulates past the 24 h window)

Requires DATABASE_URL in ${join(REPO, '.env')} and the \`psql\` client on PATH. The URL is never
logged; the run reports the host and database name only.`);
}

/** Host and database only — never the user, never the password. */
function describeUrl(url) {
    try {
        const u = new URL(url);
        return `${u.hostname}:${u.port || '5432'}/${decodeURIComponent(u.pathname).replace(/^\//, '')}`;
    } catch {
        return '(DATABASE_URL is not a parseable URL)';
    }
}

/**
 * Run SQL through psql on stdin. ON_ERROR_STOP makes the first error abort, -X ignores any local
 * .psqlrc and -q keeps the output to what the SQL itself prints. A non-zero exit is thrown with
 * psql's own stderr attached; nothing is ever swallowed.
 */
function psql(url, sqlText, label, extraArgs = []) {
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn('psql', ['-v', 'ON_ERROR_STOP=1', '-X', '-q', ...extraArgs, url], {
            stdio: ['pipe', 'pipe', 'pipe']
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', (e) => rejectPromise(new Error(`cannot run psql (${label}): ${e.message}`)));
        child.on('close', (code) => {
            if (code !== 0) {
                rejectPromise(new Error(`psql exited ${code} on ${label}\n${err.trim() || out.trim()}`));
                return;
            }
            if (err.trim()) logWarn(`${label}: ${err.trim()}`);
            resolvePromise(out);
        });
        child.stdin.on('error', (e) => rejectPromise(new Error(`psql stdin (${label}): ${e.message}`)));
        child.stdin.end(sqlText);
    });
}

async function applyDdl(url) {
    const ddl = await readFile(DDL_FILE, 'utf8');
    log(`ddl: applying ${DDL_FILE.replace(`${REPO}/`, '')} (${ddl.length} bytes, idempotent)`);
    await psql(url, ddl, 'ddl');
    log('ddl: applied');
}

async function loadIssuers(url) {
    const doc = await readJson(join(REPO, 'stocks-issuers.json'));
    const built = buildIssuerSql(doc);
    log(`issuers: ${built.rows} records from stocks-issuers.json (builtAt ${doc.builtAt || 'unknown'})`);
    await psql(url, wrapTransaction(built.sql), built.table);
    return built.rows;
}

async function loadTokens(url) {
    const tokensDoc = await readJson(join(REPO, 'stocks-tokens.json'));
    const healthDoc = await readJson(join(REPO, 'stocks-health.json'), null);
    if (!healthDoc) logWarn('tokens: stocks-health.json absent — health_status/worst_rule stay null');
    const built = buildTokenSql({ tokensDoc, healthDoc });
    const verdicts = healthDoc?.items?.length ?? 0;
    log(`tokens: ${built.rows} mints from stocks-tokens.json, ${verdicts} health verdicts joined`);
    await psql(url, wrapTransaction(built.sql), built.table);
    return built.rows;
}

async function loadSnapshots(url) {
    let dates;
    try {
        dates = (await readdir(HISTORY_DIR, { withFileTypes: true }))
            .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
            .map((e) => e.name)
            .sort();
    } catch (err) {
        if (err.code === 'ENOENT') {
            logWarn(`snapshots: ${HISTORY_DIR} absent — nothing to load`);
            return 0;
        }
        throw err;
    }
    if (dates.length === 0) {
        logWarn('snapshots: no <date> directories under stocks/data/history — nothing to load');
        return 0;
    }
    const statements = [];
    let total = 0;
    for (const date of dates) {
        const doc = await readJson(join(HISTORY_DIR, date, 'tokens.json'), null);
        if (!doc) {
            logWarn(`snapshots: ${date}/tokens.json absent — skipped`);
            continue;
        }
        if (doc.date !== date) {
            logWarn(`snapshots: ${date}/tokens.json says date=${doc.date ?? 'null'}; its own value wins`);
        }
        const built = buildSnapshotSql(doc);
        statements.push(built.sql);
        total += built.rows;
        log(`snapshots: ${date} -> ${built.rows} rows`);
    }
    if (statements.length === 0) return 0;
    log(`snapshots: ${statements.length} date(s), ${total} rows, one transaction`);
    await psql(url, wrapTransaction(statements), 'stock_token_snapshot');
    return total;
}

async function loadTrades(url) {
    const doc = await readJson(join(REPO, 'stocks-trades.json'), null);
    if (!doc) {
        logWarn('trades: stocks-trades.json absent — nothing to load');
        return 0;
    }
    const built = buildTradeSql(doc);
    if (built.skipped) logWarn(`trades: ${built.skipped} entries have no sig/time and were skipped`);
    log(`trades: ${built.rows} trades in the window (generatedAt ${doc.generatedAt || 'unknown'})`);
    await psql(url, wrapTransaction(built.sql), built.table);
    return built.rows;
}

/** Row counts straight from the tables, plus how many rows this run actually touched. */
async function reportCounts(url, since) {
    const parts = TABLES.map((t) => `SELECT '${t}' AS t, count(*) AS n,`
        + ` count(*) FILTER (WHERE updated_at >= '${since}'::timestamptz) AS touched`
        + ` FROM sonar.${t}`);
    const out = await psql(url, `${parts.join('\nUNION ALL\n')}\nORDER BY t;\n`, 'counts',
        ['-t', '-A', '-F', '|']);
    for (const line of out.trim().split('\n').filter(Boolean)) {
        const [table, n, touched] = line.split('|');
        log(`  sonar.${table}: ${n} rows (${touched} inserted or updated this run)`);
    }
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return;
    }

    const only = typeof flags.only === 'string'
        ? flags.only.split(',').map((s) => s.trim()).filter(Boolean)
        : STEPS;
    const unknown = only.filter((s) => !STEPS.includes(s));
    if (unknown.length) throw new Error(`unknown --only step(s): ${unknown.join(', ')} (known: ${STEPS.join(', ')})`);

    const env = await readEnvFile(join(REPO, '.env'));
    const url = process.env.DATABASE_URL || env.DATABASE_URL;
    if (!url) {
        throw new Error(`DATABASE_URL is not set — add it to ${join(REPO, '.env')} `
            + '(see .env.example). It must point at the shared `geodata` database.');
    }

    const since = ts();
    log(`load-db: ${describeUrl(url)} — steps ${only.join(', ')}${flags.ddl ? ' (+ddl)' : ''}`);
    if (flags.ddl) await applyDdl(url);

    const loaded = {};
    // FK order: a token references its issuer, so issuers must exist first.
    if (only.includes('issuers')) loaded.issuers = await loadIssuers(url);
    if (only.includes('tokens')) loaded.tokens = await loadTokens(url);
    if (only.includes('snapshots')) loaded.snapshots = await loadSnapshots(url);
    if (only.includes('trades')) loaded.trades = await loadTrades(url);

    log(`load-db: offered ${Object.entries(loaded).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    await reportCounts(url, since);
    log('load-db: done');
}

main().catch((err) => {
    logError(err.message);
    process.exitCode = 1;
});
