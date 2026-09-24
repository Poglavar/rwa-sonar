// GET /api/events — the latest-events feed, live. The release's stocks-events.json already holds the
// catalogue, change-journal, DeFi and daily-snapshot events; this route merges it at request time
// with the watcher rows in sonar.change_event (the hourly chain watcher, the document and court
// watchers) through the same rules the builder uses (stocks/lib/events.mjs), so the live feed and
// the static fallback cannot disagree. The merged answer is kept in memory for CACHE_MS; when the
// database does not answer, the file is served as it is, marked `live: false`.

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { Hono } from 'hono';

import { query } from '../db.js';
import { clampLimit } from '../lib/query.js';
import { log, logWarn } from '../lib/log.js';
import { WINDOW_DAYS, changeRowsSelect, eventContext, mergeLiveFeed } from '../../../stocks/lib/events.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/** The built feed, `EVENTS_FILE` overriding; resolved against this file so jest and the server agree. */
export const EVENTS_PATH = process.env.EVENTS_FILE ? resolve(process.cwd(), process.env.EVENTS_FILE) : join(REPO_ROOT, 'stocks-events.json');
/** Editorial decisions on watcher events: a resolved row is never shown on its own. */
export const RESOLUTIONS_PATH = join(REPO_ROOT, 'stocks', 'data', 'event-resolutions.json');
/** How long one merged answer is reused. The chain watcher runs hourly, so a minute is plenty fresh. */
export const CACHE_MS = 60_000;

const DAY_MS = 86400000;

async function readJsonFile(path) {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
}

/** The watcher rows since `since`, and the issuer display names the rules name them with. */
async function queryWatcherRows(since) {
    const probe = await query('SELECT to_regclass($1) IS NOT NULL AS present', ['sonar.change_judgment']);
    const judgments = probe.rows[0]?.present === true;
    const [rows, issuers] = await Promise.all([
        query(changeRowsSelect({ sinceExpr: '$1::timestamptz', judgments }), [since]),
        query('SELECT slug, name FROM sonar.stock_issuer')
    ]);
    return {
        rows: rows.rows,
        issuerNames: Object.fromEntries(issuers.rows.map((row) => [row.slug, row.name ?? row.slug]))
    };
}

/**
 * The route with its inputs injectable, so a test can run it without a database or files:
 * `readFeed()` → the built feed or null, `readResolutions()` → resolution items, `queryRows(since)` →
 * {rows, issuerNames}, `now()` → ms (used only to age the cache and, with no file, to bound the query).
 */
export function createEventsRoutes({
    readFeed = () => readJsonFile(EVENTS_PATH),
    readResolutions = async () => (await readJsonFile(RESOLUTIONS_PATH))?.items ?? [],
    queryRows = queryWatcherRows,
    now = () => Date.now(),
    cacheMs = CACHE_MS
} = {}) {
    const routes = new Hono();
    let cached = null;
    let pending = null;

    async function build() {
        const feed = await readFeed();
        const windowDays = Number.isInteger(feed?.windowDays) ? feed.windowDays : WINDOW_DAYS;
        const anchor = Date.parse(feed?.asOf ?? '');
        const since = new Date((Number.isFinite(anchor) ? anchor : now()) - (windowDays + 1) * DAY_MS).toISOString();
        let watcher = null;
        try {
            watcher = await queryRows(since);
        } catch (err) {
            logWarn(`events: watcher rows unavailable (${err.message}); serving ${feed ? 'the release file' : 'nothing'}`);
        }
        if (watcher === null) {
            if (feed === null) return null;
            return { ...feed, live: false, note: 'The watcher database did not answer; these are the events of the last release.' };
        }
        const ctx = eventContext({ issuerNames: watcher.issuerNames, resolutions: await readResolutions() });
        const merged = mergeLiveFeed(feed, watcher.rows, ctx, { windowDays });
        log(`events: ${merged.events.length} event(s) from ${watcher.rows.length} watcher row(s) + ${feed?.events?.length ?? 0} release event(s), as of ${merged.asOf}`);
        return { ...merged, live: true };
    }

    routes.get('/events', async (c) => {
        const limit = clampLimit(c.req.query('limit'), { def: 50, max: 200 });
        if (cached === null || now() - cached.at > cacheMs) {
            pending ??= build().finally(() => { pending = null; });
            const body = await pending;
            cached = body === null ? null : { at: now(), body };
        }
        if (cached === null) {
            return c.json({ error: { code: 'events_unavailable', message: 'no built events file and no watcher database' } }, 503);
        }
        const body = cached.body;
        c.header('Cache-Control', 'public, max-age=60');
        return c.json({ ...body, count: Math.min(limit, body.events.length), limit, events: body.events.slice(0, limit) });
    });

    return routes;
}

export default createEventsRoutes();
