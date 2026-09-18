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
    buildClaimOrphanSql, buildClaimSql, buildFailureModeSql, buildIssuerSql, buildSnapshotSql,
    buildTokenSql, buildTradeSql, buildWhatIfDeleteSql, buildWhatIfSql, claimRows, whatIfRows,
    wrapTransaction
} from './lib/db-load.mjs';
import { TRUST_CHAIN, TRUST_CHAIN_PATH, validateWhatIf } from './lib/trustchain.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
// Applied in this order by --ddl: the claim and what_if tables' foreign keys need sonar.source,
// which the evidence file creates. All four are idempotent, so applying all of them every time is
// right.
const DDL_FILES = [
    join(REPO, 'db', '2026-09-17-sonar-stocks.sql'),
    join(REPO, 'db', '2026-09-18-sonar-evidence.sql'),
    join(REPO, 'db', '2026-09-18-sonar-claims.sql'),
    join(REPO, 'db', '2026-09-18-sonar-whatif.sql')
];
const HISTORY_DIR = join(REPO, 'stocks', 'data', 'history');
const ISSUERS_DIR = join(REPO, 'stocks', 'data', 'issuers');
const STEPS = ['issuers', 'tokens', 'snapshots', 'trades', 'claims', 'whatif'];
const TABLES = ['claim', 'failure_mode', 'stock_issuer', 'stock_token', 'stock_token_snapshot',
    'stock_trade', 'what_if'];

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

  node stocks/load-db.mjs --run [--ddl] [--only=issuers,tokens,snapshots,trades,claims,whatif]

  --run     actually connect and load. Without it nothing happens (this message is printed).
  --ddl     apply ${DDL_FILES.map((f) => f.replace(`${REPO}/`, '')).join(', ')} first,
            in that order. All idempotent; safe on every run.
  --only    limit to some of the steps, comma separated. Default: all six, in FK order
            (${STEPS.join(' -> ')}).
  --help    this message.

Inputs, all relative to the repo root:
  stocks-issuers.json                      -> sonar.stock_issuer
  stocks-tokens.json + stocks-health.json  -> sonar.stock_token
  stocks/data/history/<date>/tokens.json   -> sonar.stock_token_snapshot (every date present)
  stocks-trades.json                       -> sonar.stock_trade (accumulates past the 24 h window)
  stocks/data/issuers/<slug>.json          -> sonar.claim (the dossiers' own claims[] plus every
                                              quote-bearing finding, incident and attestation)
  stocks/data/trust-chain.json             -> sonar.failure_mode (the 38 shared questions)
  stocks/data/issuers/<slug>.json          -> sonar.what_if (each dossier's whatIf[] answers; an
                                              answer a dossier no longer offers is deleted)

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
    const dossiers = await readDossiers('claims');
    if (dossiers === null) return 0;
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

/**
 * Read every dossier once, mapped to the slug the rest of the pipeline publishes. Shared by the
 * claims and what-if steps, so the two can never disagree about which file is which issuer.
 */
async function readDossiers(label) {
    let files;
    try {
        files = (await readdir(ISSUERS_DIR)).filter((f) => f.endsWith('.json')).sort(byString);
    } catch (err) {
        if (err.code === 'ENOENT') {
            logWarn(`${label}: ${ISSUERS_DIR} absent — nothing to load`);
            return null;
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
    return dossiers;
}

/**
 * The failure-mode catalogue and every dossier's `whatIf[]` answers (stocks/EVIDENCE.md, "Trust
 * chain and what-if"). Two things here are deliberate:
 *
 *  - Every entry is run through trustchain.js `validateWhatIf()` FIRST and a malformed one makes
 *    the step throw rather than load. The table's CHECK constraints would catch some of these,
 *    but not a missing `outcome` or a case with no url, and half-loading a research pass whose
 *    answers do not meet the evidence discipline is worse than not loading it.
 *  - An answer a dossier no longer offers is DELETED. Unlike a claim (content-addressed, so an
 *    edited quote leaves a row a human must judge) a what_if id is `<issuer>:<mode>`, so the only
 *    way a row stops being offered is the researcher having withdrawn that answer.
 */
async function loadWhatIf(url) {
    const modes = buildFailureModeSql(TRUST_CHAIN);
    log(`whatif: ${modes.rows} failure mode(s) from `
        + `${TRUST_CHAIN_PATH.replace(`${REPO}/`, '')} (catalogue version ${TRUST_CHAIN.version ?? 'unknown'})`);
    await psql(url, wrapTransaction(modes.sql), modes.table);

    const dossiers = await readDossiers('whatif');
    if (dossiers === null) return 0;

    const problems = [];
    for (const { slug, dossier } of dossiers) {
        for (const problem of validateWhatIf(dossier?.whatIf ?? null, TRUST_CHAIN)) {
            problems.push(`${slug}: ${problem}`);
        }
    }
    if (problems.length) {
        throw new Error(`whatif: ${problems.length} malformed answer(s); nothing loaded:\n  `
            + problems.join('\n  '));
    }

    const { rows, dropped } = whatIfRows(dossiers);
    if (dropped) logWarn(`whatif: ${dropped} entr(ies) name no mode and were skipped`);
    const byStatus = {};
    for (const row of rows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    const answering = new Set(rows.map((r) => r.issuerSlug)).size;
    log(`whatif: ${rows.length} answer(s) from ${answering}/${dossiers.length} dossier(s)`
        + `${rows.length ? ` — ${Object.entries(byStatus).sort().map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}`);
    if (rows.length === 0) {
        logWarn('whatif: no dossier carries a whatIf[] entry yet — nothing to load, which is a '
            + 'count of 0, not a failure. Every mode shows as `missing` in the API until one does.');
        return 0;
    }

    const built = buildWhatIfSql(rows, { builtAt: ts() });
    await psql(url, wrapTransaction(built.sql), built.table);

    const gone = buildWhatIfDeleteSql(rows);
    const out = await psql(url, gone.text, 'what_if withdrawn', ['-t', '-A', '-F', '|']);
    const lines = out.trim().split('\n').filter(Boolean);
    if (lines.length) {
        logWarn(`whatif: ${lines.length} answer(s) withdrawn from a dossier and deleted: `
            + lines.join(' '));
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
    // what_if references sonar.failure_mode (created by the same step) and sonar.source.
    if (only.includes('whatif')) loaded.whatif = await loadWhatIf(url);

    log(`load-db: offered ${Object.entries(loaded).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    await reportCounts(url, since);
    log('load-db: done');
}

main().catch((err) => {
    logError(err.message);
    process.exitCode = 1;
});
