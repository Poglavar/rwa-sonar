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
import { byString, log, logError, logWarn, parseArgs, readJson, ts } from './lib/io.mjs';
import {
    buildClaimOrphanSql, buildClaimSql, buildIssuerSql, buildSnapshotSql, buildTokenSql,
    buildTradeSql, claimRows, wrapTransaction
} from './lib/db-load.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
// Applied in this order by --ddl: the claim table's foreign key needs sonar.source, which the
// evidence file creates. All three are idempotent, so applying all of them every time is right.
const DDL_FILES = [
    join(REPO, 'db', '2026-09-17-sonar-stocks.sql'),
    join(REPO, 'db', '2026-09-18-sonar-evidence.sql'),
    join(REPO, 'db', '2026-09-18-sonar-claims.sql')
];
const HISTORY_DIR = join(REPO, 'stocks', 'data', 'history');
const ISSUERS_DIR = join(REPO, 'stocks', 'data', 'issuers');
const STEPS = ['issuers', 'tokens', 'snapshots', 'trades', 'claims'];
const TABLES = ['claim', 'stock_issuer', 'stock_token', 'stock_token_snapshot', 'stock_trade'];

/**
 * Dossier file base -> the issuer slug everything else uses. Only the three files whose name
 * carries a ticker need mapping. The same map is in build-stocks-db.mjs, which is what publishes
 * the slug; a claim must be filed under the published slug or it joins to no issuer.
 */
const DOSSIER_SLUGS = {
    'backpack-securities-spcx': 'backpack-securities',
    'bullish-blsh': 'bullish',
    'securitize-secz': 'securitize'
};

function usage() {
    console.log(`Load the built stocks JSON into schema \`sonar\` of the geodata database.

  node stocks/load-db.mjs --run [--ddl] [--only=issuers,tokens,snapshots,trades,claims]

  --run     actually connect and load. Without it nothing happens (this message is printed).
  --ddl     apply ${DDL_FILES.map((f) => f.replace(`${REPO}/`, '')).join(', ')} first,
            in that order. All idempotent; safe on every run.
  --only    limit to some of the steps, comma separated. Default: all five, in FK order
            (${STEPS.join(' -> ')}).
  --help    this message.

Inputs, all relative to the repo root:
  stocks-issuers.json                      -> sonar.stock_issuer
  stocks-tokens.json + stocks-health.json  -> sonar.stock_token
  stocks/data/history/<date>/tokens.json   -> sonar.stock_token_snapshot (every date present)
  stocks-trades.json                       -> sonar.stock_trade (accumulates past the 24 h window)
  stocks/data/issuers/<slug>.json          -> sonar.claim (the dossiers' own claims[] plus every
                                              quote-bearing finding, incident and attestation)

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
    for (const file of DDL_FILES) {
        const name = file.replace(`${REPO}/`, '');
        const ddl = await readFile(file, 'utf8');
        log(`ddl: applying ${name} (${ddl.length} bytes, idempotent)`);
        await psql(url, ddl, `ddl ${name}`);
    }
    log(`ddl: applied ${DDL_FILES.length} file(s)`);
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

/**
 * Claims from the dossiers (stocks/EVIDENCE.md §1). Nothing here invents a claim: a dossier with
 * no `claims` array still contributes its quote-bearing findings, incidents and attestations, and
 * a dossier with neither contributes nothing — which is a count of 0, not an error, because the
 * research pass fills the arrays issuer by issuer. `source_id` is resolved inside the statement by
 * exact URL against sonar.source, so a URL the registry has not seen leaves it null rather than
 * dropping the claim.
 */
async function loadClaims(url) {
    let files;
    try {
        files = (await readdir(ISSUERS_DIR)).filter((f) => f.endsWith('.json')).sort(byString);
    } catch (err) {
        if (err.code === 'ENOENT') {
            logWarn(`claims: ${ISSUERS_DIR} absent — nothing to load`);
            return 0;
        }
        throw err;
    }
    const dossiers = [];
    for (const file of files) {
        // The dossier file base is the slug except for the three that carry a ticker; the same map
        // lives in build-stocks-db.mjs, which is the one that publishes the slug.
        const base = file.replace(/\.json$/, '');
        dossiers.push({
            slug: DOSSIER_SLUGS[base] ?? base,
            dossier: await readJson(join(ISSUERS_DIR, file))
        });
    }
    const rows = claimRows(dossiers);
    const withQuote = rows.filter((r) => r.quote !== null).length;
    const withUrl = rows.filter((r) => r.url !== null).length;
    const byStatus = {};
    for (const row of rows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    log(`claims: ${rows.length} claim(s) from ${dossiers.length} dossier(s) — `
        + `${withQuote} with a quote, ${withUrl} with a URL`
        + `${rows.length ? `, ${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}`);
    if (rows.length === 0) {
        logWarn('claims: no dossier carries a claims[] entry or a quoted finding/incident/'
            + 'attestation yet — nothing to load, which is a count of 0, not a failure');
        return 0;
    }
    const built = buildClaimSql(rows, { builtAt: ts() });
    await psql(url, wrapTransaction(built.sql), built.table);

    // A claim id is content-addressed, so an EDITED quote or URL writes a new row and leaves the
    // old one behind. Nothing here deletes it (EVIDENCE.md §1: a claim whose words moved is a
    // `changed` for a human to decide), but an orphan nobody is told about is how a stale quote
    // lives on in the API, so say so.
    const orphans = buildClaimOrphanSql(rows);
    const out = await psql(url, orphans.text, 'claim orphans', ['-t', '-A', '-F', '|']);
    const lines = out.trim().split('\n').filter(Boolean);
    if (lines.length) {
        const total = lines.reduce((sum, line) => sum + Number(line.split('|')[1] || 0), 0);
        logWarn(`claims: ${total} row(s) in sonar.claim are no longer offered by any dossier — a `
            + 'quote or URL was edited, so the claim got a new id. Not deleted; review them: '
            + lines.map((line) => {
                const [slug, n, oldest] = line.split('|');
                return `${slug}=${n} (oldest ${oldest})`;
            }).join(' '));
    }
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
    // Claims reference sonar.source (nullable) and name an issuer slug, so they go last.
    if (only.includes('claims')) loaded.claims = await loadClaims(url);

    log(`load-db: offered ${Object.entries(loaded).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    await reportCounts(url, since);
    log('load-db: done');
}

main().catch((err) => {
    logError(err.message);
    process.exitCode = 1;
});
