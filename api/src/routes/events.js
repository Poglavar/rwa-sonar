// GET /api/events — the latest-events feed, live. The release's stocks-events.json already holds the
// catalogue, change-journal, DeFi and daily-snapshot events; this route merges it at request time
// with the watcher rows in sonar.change_event (the hourly chain watcher, the document and court
// watchers) and the lending watcher's liquidations and price freezes (sonar.lending_*) through the
// same rules the builder uses (stocks/lib/events.mjs), so the live feed and the static fallback
// cannot disagree. The merged answer is kept in memory for CACHE_MS; when the database does not
// answer, the file is served as it is, marked `live: false`.

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { Hono } from 'hono';

import { query } from '../db.js';
import { clampLimit } from '../lib/query.js';
import { log, logWarn } from '../lib/log.js';
import { WINDOW_DAYS, changeRowsSelect, eventContext, lendingRowsSelect, mergeLiveFeed } from '../../../stocks/lib/events.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/** The built feed, `EVENTS_FILE` overriding; resolved against this file so jest and the server agree. */
export const EVENTS_PATH = process.env.EVENTS_FILE ? resolve(process.cwd(), process.env.EVENTS_FILE) : join(REPO_ROOT, 'stocks-events.json');
/** Editorial decisions on watcher events: a resolved row is never shown on its own. */
export const RESOLUTIONS_PATH = join(REPO_ROOT, 'stocks', 'data', 'event-resolutions.json');
/** The release's protocol dossier index, so a live lending event links to the token's dossier. */
export const PROTOCOL_INDEX_PATH = join(REPO_ROOT, 'protocols', 'index.json');
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

/**
 * The watcher rows since `since`, the lending rows (null while the lending watcher's tables do not
 * exist yet, so the file's lending events stand) and the issuer display names the rules use.
 */
async function queryWatcherRows(since) {
    const probe = await query(`SELECT to_regclass('sonar.change_judgment') IS NOT NULL AS judgments,
        to_regclass('sonar.lending_liquidation') IS NOT NULL AND to_regclass('sonar.lending_price_freeze') IS NOT NULL AS lending`);
    const judgments = probe.rows[0]?.judgments === true;
    const [rows, issuers, lending] = await Promise.all([
        query(changeRowsSelect({ sinceExpr: '$1::timestamptz', judgments }), [since]),
        query('SELECT slug, name FROM sonar.stock_issuer'),
        probe.rows[0]?.lending === true ? query(lendingRowsSelect({ sinceExpr: '$1::timestamptz' }), [since]) : null
    ]);
    return {
        rows: rows.rows,
        lending: lending?.rows[0]?.lending ?? null,
        issuerNames: Object.fromEntries(issuers.rows.map((row) => [row.slug, row.name ?? row.slug]))
    };
}

/** `mint|protocol` → dossier slug, the builder's own reading of protocols/index.json. */
async function readProtocolPages() {
    const index = await readJsonFile(PROTOCOL_INDEX_PATH);
    const pages = {};
    for (const entry of Array.isArray(index) ? index : []) {
        if (typeof entry?.mint !== 'string' || typeof entry?.protocol !== 'string' || typeof entry?.slug !== 'string') continue;
        const key = `${entry.mint}|${entry.protocol.toLowerCase()}`;
        if (!(key in pages)) pages[key] = entry.slug;
    }
    return pages;
}

/**
 * The route with its inputs injectable, so a test can run it without a database or files:
 * `readFeed()` → the built feed or null, `readResolutions()` → resolution items, `queryRows(since)` →
 * {rows, issuerNames, lending?}, `readPages()` → protocol dossier slugs, `now()` → ms (used only to
 * age the cache and, with no file, to bound the query).
 */
export function createEventsRoutes({
    readFeed = () => readJsonFile(EVENTS_PATH),
    readResolutions = async () => (await readJsonFile(RESOLUTIONS_PATH))?.items ?? [],
    queryRows = queryWatcherRows,
    readPages = readProtocolPages,
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
        const lending = watcher.lending ?? null;
        const ctx = eventContext({ issuerNames: watcher.issuerNames, resolutions: await readResolutions(), protocolPages: lending ? await readPages() : {} });
        const merged = mergeLiveFeed(feed, watcher.rows, ctx, { windowDays, lending });
        log(`events: ${merged.events.length} event(s) from ${watcher.rows.length} watcher row(s)`
            + `${lending ? `, ${lending.liquidations?.length ?? 0} liquidation(s) and ${lending.freezes?.length ?? 0} price freeze(s)` : ''}`
            + ` + ${feed?.events?.length ?? 0} release event(s), as of ${merged.asOf}`);
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
