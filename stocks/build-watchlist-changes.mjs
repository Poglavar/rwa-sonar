#!/usr/bin/env node
// Refresh every persistent comparison watch, store its new baseline and publish bounded lines for
// the existing once-daily Telegram digest. A first run records a baseline and never invents news.

import { join } from 'node:path';

import { readEnvFile } from './lib/env.mjs';
import { log, logError, parseArgs, readJson, ts, writeJson } from './lib/io.mjs';
import { psql } from './lib/psql.mjs';
import { buildWatchSnapshot, diffWatch, formatWatchNoticeLines } from './lib/watchlists.mjs';

const HERE = import.meta.dirname;
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'stocks-watchlist-changes.json');

function literal(value) {
    return `'${String(value).replaceAll("'", "''")}'`;
}

async function readWatches(databaseUrl) {
    const sql = `
        SELECT COALESCE(json_agg(row_to_json(w) ORDER BY w.created_at), '[]'::json)::text
        FROM (
            SELECT watch_id, title, underlying_ticker, issuer_slugs, filters, baseline,
                   last_changes, created_at, updated_at, last_checked_at
            FROM sonar.stock_watchlist
        ) w;`;
    const out = await psql(databaseUrl, sql, 'read stock watches', ['-t', '-A']);
    return JSON.parse(out.trim() || '[]');
}

function updateSql(results, checkedAt) {
    if (results.length === 0) return '';
    const statements = results.map(({ watch, snapshot, changes }) => `
        UPDATE sonar.stock_watchlist
        SET baseline = ${literal(JSON.stringify(snapshot))}::jsonb,
            last_changes = ${literal(JSON.stringify(changes))}::jsonb,
            last_checked_at = ${literal(checkedAt)}::timestamptz
        WHERE watch_id = ${literal(watch.watch_id)}::uuid;`).join('\n');
    return `BEGIN;\n${statements}\nCOMMIT;`;
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (!flags.run) {
        console.log('Usage: node stocks/build-watchlist-changes.mjs --run');
        return 0;
    }
    const env = { ...(await readEnvFile(join(ROOT, '.env'))), ...process.env };
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL is missing from .env');
    const [issuerDb, tokenDb, defiUsage, composability, watches] = await Promise.all([
        readJson(join(ROOT, 'stocks-issuers.json')),
        readJson(join(ROOT, 'stocks-tokens.json')),
        readJson(join(HERE, 'data', 'defi-usage.json')),
        readJson(join(HERE, 'data', 'composability-templates.json')),
        readWatches(env.DATABASE_URL)
    ]);
    const checkedAt = ts();
    const data = {
        issuers: issuerDb.issuers ?? [], tokens: tokenDb.tokens ?? [], defiUsage, composability
    };
    const results = watches.map((watch) => {
        const snapshot = buildWatchSnapshot(watch, data, Date.parse(checkedAt));
        const changes = diffWatch(watch, snapshot);
        return { watch, snapshot, changes };
    });
    const sql = updateSql(results, checkedAt);
    if (sql) await psql(env.DATABASE_URL, sql, 'update stock watches');
    const events = results.flatMap((row) => row.changes);
    const output = {
        generatedAt: checkedAt,
        watchlistsChecked: watches.length,
        watchesBaselined: results.filter((row) => !row.watch.baseline).length,
        materialChanges: events.length,
        noticeLines: formatWatchNoticeLines(events),
        events
    };
    await writeJson(OUT, output);
    log(`watchlists: ${watches.length} checked, ${output.watchesBaselined} baselined, ${events.length} material change(s)`);
    return 0;
}

main().then((code) => process.exit(code), (err) => {
    logError(err.stack ?? String(err));
    process.exit(1);
});
