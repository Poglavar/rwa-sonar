#!/usr/bin/env node
// Hourly run-and-exit sender for personal saved-watch digests (next-steps.md item 12). Each watch
// whose owner enabled the digest AND whose private Telegram chat was verified gets at most one
// message per local day, at its chosen hour, and only when build-watchlist-changes.mjs recorded a
// material change, or the watcher a change event for the watched target, since its last digest
// (change events carry the change judge's model assessment beside them when there is one). Legacy rows with the reserved flag but no verified chat
// are excluded by the join. Writes .last-watch-digest-stats.json for the outcome check; on any
// failure sends ONE operator summary without watch contents.
//
//   node --env-file=/root/code/rwa-sonar/.env api/src/jobs/send-watch-digests.js --run

import { writeFile, rename } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { closePool, query } from '../db.js';
import { log, logError } from '../lib/log.js';
import { decryptChatId, deliveryConfig, watchBotClient } from '../lib/watch-delivery.js';
import { JUDGMENT_TABLE } from '../lib/evidence.js';
import { buildTargetChangesSql, runDigests } from '../lib/watch-digest.js';
import { postTelegram } from '../../../stocks/lib/telegram.mjs';

const STATS_PATH = fileURLToPath(new URL('../../../.last-watch-digest-stats.json', import.meta.url));

/** The persistence runDigests needs, over sonar.* in geodata. */
export function pgDigestStore(run = query) {
    return {
        async enabledBoundWatches() {
            const { rows } = await run(`
                SELECT w.watch_id, w.title, w.watch_type, w.target, w.underlying_ticker, w.issuer_slugs,
                       w.digest_hour, w.digest_timezone, d.chat_enc, d.verified_at, d.digest_since,
                       (SELECT max(l.covered_until) FROM sonar.stock_watch_digest_log l
                        WHERE l.watch_id = w.watch_id AND l.status IN ('sent', 'no-change')) AS last_covered
                FROM sonar.stock_watchlist w
                JOIN sonar.stock_watch_delivery d ON d.watch_id = w.watch_id
                WHERE w.digest_enabled
                ORDER BY w.created_at`);
            return rows;
        },
        // True when this run owns today's digest for the watch: a fresh day, or a failed attempt
        // that may be retried. A row left in `sending` by a crash is never resent.
        async claim(watchId, date) {
            const { rows } = await run(`
                INSERT INTO sonar.stock_watch_digest_log (watch_id, digest_date, status)
                VALUES ($1, $2::date, 'sending')
                ON CONFLICT (watch_id, digest_date) DO UPDATE
                    SET status = 'sending', attempts = sonar.stock_watch_digest_log.attempts + 1,
                        error = NULL, updated_at = now()
                    WHERE sonar.stock_watch_digest_log.status = 'failed' AND sonar.stock_watch_digest_log.attempts < 3
                RETURNING attempts`, [watchId, date]);
            return rows.length === 1;
        },
        async eventsBetween(watchId, sinceIso, untilIso) {
            const { rows } = await run(`
                SELECT summary, detected_at FROM sonar.stock_watch_event
                WHERE watch_id = $1 AND detected_at > $2::timestamptz AND detected_at <= $3::timestamptz
                ORDER BY detected_at, event_id`, [watchId, sinceIso, untilIso]);
            return rows;
        },
        // The watcher's change events for the watch's target, with the change judge's reading where
        // the judgment table exists (it only does where stocks/judge-changes.mjs has run).
        async changesBetween(watch, sinceIso, untilIso) {
            const probe = await run('SELECT to_regclass($1) IS NOT NULL AS present', [JUDGMENT_TABLE]);
            const sql = buildTargetChangesSql(watch, sinceIso, untilIso, { judgments: probe.rows[0]?.present === true });
            const { rows } = await run(sql.text, sql.values);
            return rows;
        },
        async finish(watchId, date, { status, changeCount, coveredUntil, error = null }) {
            await run(`
                UPDATE sonar.stock_watch_digest_log
                SET status = $3, change_count = $4, covered_until = $5::timestamptz, error = $6, updated_at = now()
                WHERE watch_id = $1 AND digest_date = $2::date`,
            [watchId, date, status, changeCount, coveredUntil, error ? String(error).slice(0, 200) : null]);
        },
        async disconnect(watchId) {
            await run(`
                WITH gone AS (DELETE FROM sonar.stock_watch_delivery WHERE watch_id = $1)
                UPDATE sonar.stock_watchlist SET digest_enabled = false, updated_at = now() WHERE watch_id = $1`,
            [watchId]);
        }
    };
}

async function writeStats(stats) {
    const tmp = `${STATS_PATH}.next-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(stats, null, 2)}\n`);
    await rename(tmp, STATS_PATH);
}

async function main(argv) {
    if (!argv.includes('--run')) {
        console.log('Usage: node --env-file=.env api/src/jobs/send-watch-digests.js --run\n'
            + 'Sends each due personal saved-watch digest once (hourly; see ecosystem.config.cjs rwa-watch-digest).');
        return 0;
    }
    const startedAt = new Date().toISOString();
    const config = deliveryConfig();
    if (!config.configured) {
        // Not configured is a state, not a crash: nothing can be bound, so nothing is due.
        log(`watch digests: delivery not configured (${config.problem}); nothing sent`);
        await writeStats({ ok: true, configured: false, startedAt, finishedAt: new Date().toISOString() });
        return 0;
    }
    const baseUrl = (process.env.RWA_BASE_URL || 'https://rwasonar.com').replace(/\/+$/, '');
    const stats = await runDigests({
        store: pgDigestStore(),
        telegram: watchBotClient(config),
        decrypt: (value) => decryptChatId(value, config.key),
        notifyOperator: (text) => postTelegram(text),
        baseUrl,
        log
    });
    await writeStats({ ...stats, configured: true });
    log(`watch digests: ${stats.eligible} enabled, ${stats.due} due, ${stats.sent} sent, ${stats.noChange} without change, `
        + `${stats.alreadyHandled} already handled today, ${stats.failed} failed, ${stats.disconnected} disconnected`);
    return stats.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2))
        .then(async (code) => {
            await closePool();
            process.exit(code);
        }, async (err) => {
            logError(err.stack ?? String(err));
            await writeStats({ ok: false, error: err.message, finishedAt: new Date().toISOString() }).catch(() => {});
            await postTelegram('RWA Sonar watch digests: the run crashed before finishing; see logs/rwa-watch-digest-error.log.')
                .catch(() => {});
            await closePool().catch(() => {});
            process.exit(1);
        });
}
