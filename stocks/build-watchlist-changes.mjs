#!/usr/bin/env node
// Refresh every typed saved watch, store its new baseline and publish bounded opt-in lines for the
// existing once-daily morning digest. A first run records a baseline and never invents news.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
            SELECT watch_id, title, watch_type, target, underlying_ticker, issuer_slugs, filters,
                   digest_enabled, digest_hour, digest_timezone, baseline, last_changes,
                   created_at, updated_at, last_checked_at
            FROM sonar.stock_watchlist
        ) w;`;
    const out = await psql(databaseUrl, sql, 'read stock watches', ['-t', '-A']);
    return JSON.parse(out.trim() || '[]');
}

/**
 * One transaction: every watch's new baseline, plus each material change as a row in
 * sonar.stock_watch_event. The events outlive the next baseline, so a personal morning digest
 * (api/src/jobs/send-watch-digests.js) covers everything found since the watch's last digest.
 */
export function updateSql(results, checkedAt) {
    if (results.length === 0) return '';
    const statements = results.map(({ watch, snapshot, changes }) => `
        UPDATE sonar.stock_watchlist
        SET baseline = ${literal(JSON.stringify(snapshot))}::jsonb,
            last_changes = ${literal(JSON.stringify(changes))}::jsonb,
            last_checked_at = ${literal(checkedAt)}::timestamptz
        WHERE watch_id = ${literal(watch.watch_id)}::uuid;${changes.map((change) => `
        INSERT INTO sonar.stock_watch_event (watch_id, summary, detected_at)
        VALUES (${literal(watch.watch_id)}::uuid, ${literal(String(change.summary).slice(0, 1000))}, ${literal(checkedAt)}::timestamptz);`).join('')}`).join('\n');
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
    const [issuerDb, tokenDb, defiUsage, composability, protocolMarketResearch, watches] = await Promise.all([
        readJson(join(ROOT, 'stocks-issuers.json')),
        readJson(join(ROOT, 'stocks-tokens.json')),
        readJson(join(HERE, 'data', 'defi-usage.json')),
        readJson(join(HERE, 'data', 'composability-templates.json')),
        readJson(join(HERE, 'data', 'protocol-market-research.json'), { markets: [] }),
        readWatches(env.DATABASE_URL)
    ]);
    const checkedAt = ts();
    const data = {
        issuers: issuerDb.issuers ?? [], tokens: tokenDb.tokens ?? [], defiUsage, composability,
        protocolMarketResearch
    };
    const results = watches.map((watch) => {
        const snapshot = buildWatchSnapshot(watch, data, Date.parse(checkedAt));
        const changes = diffWatch(watch, snapshot);
        return { watch, snapshot, changes };
    });
    const sql = updateSql(results, checkedAt);
    if (sql) await psql(env.DATABASE_URL, sql, 'update stock watches');
    const events = results.flatMap((row) => row.changes);
    // Personal delivery happens only through a verified private chat, from the stored events, in
    // api/src/jobs/send-watch-digests.js. Never place anonymous visitors' saved-watch contents into
    // the operator's Telegram notice stream, including for legacy rows whose reserved flag is true.
    const digestResults = [];
    const output = {
        generatedAt: checkedAt,
        watchlistsChecked: watches.length,
        watchesBaselined: results.filter((row) => !row.watch.baseline).length,
        materialChanges: events.length,
        digestWatchesWithChanges: digestResults.length,
        noticeLines: [],
        digests: digestResults.map((row) => ({
            watchId: row.watch.watch_id,
            hour: row.watch.digest_hour,
            timezone: row.watch.digest_timezone,
            noticeLines: formatWatchNoticeLines(row.changes)
        })),
        events
    };
    await writeJson(OUT, output);
    log(`watchlists: ${watches.length} checked, ${output.watchesBaselined} baselined, ${events.length} material change(s)`);
    return 0;
}

// Importable by tests (updateSql) without running a pass.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().then((code) => process.exit(code), (err) => {
        logError(err.stack ?? String(err));
        process.exit(1);
    });
}
