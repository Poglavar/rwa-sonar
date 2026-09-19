// Shareable comparison watchlists. The owner key is accepted only as a header and stored only as
// a SHA-256 hash; the browser keeps the raw key in a URL fragment, which never reaches web logs.

import { Hono } from 'hono';

import { query } from '../db.js';
import { ApiError, notFound } from '../lib/query.js';
import {
    createWatchCredentials, hashWatchKey, parseWatchPayload, publicWatch, watchKeyFromRequest
} from '../lib/watchlists.js';

const routes = new Hono();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREATE_LIMIT = 5;
const CREATE_WINDOW_MS = 60 * 60 * 1000;
const createsByIp = new Map();

function watchId(c) {
    const value = c.req.param('watchId');
    if (!UUID.test(value)) throw notFound('no such watchlist');
    return value;
}

function clientIp(c) {
    return c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown';
}

function takeCreateSlot(c, now = Date.now()) {
    const ip = clientIp(c);
    const recent = (createsByIp.get(ip) ?? []).filter((time) => now - time < CREATE_WINDOW_MS);
    if (recent.length >= CREATE_LIMIT) {
        throw new ApiError(429, 'watchlist_rate_limit', 'at most five watchlists may be created per hour');
    }
    recent.push(now);
    createsByIp.set(ip, recent);
}

async function jsonBody(c) {
    const bytes = Number(c.req.header('Content-Length'));
    if (Number.isFinite(bytes) && bytes > 8192) throw new ApiError(413, 'body_too_large', 'watchlist body exceeds 8 KiB');
    try {
        return await c.req.json();
    } catch {
        throw new ApiError(400, 'invalid_json', 'request body must be valid JSON');
    }
}

async function validateProducts(payload) {
    const { rows } = await query(`
        SELECT DISTINCT issuer_slug
        FROM sonar.stock_token
        WHERE upper(underlying_ticker) = $1 AND issuer_slug = ANY($2::text[])
        ORDER BY issuer_slug`, [payload.ticker, payload.issuers]);
    const found = rows.map((row) => row.issuer_slug);
    if (found.length !== payload.issuers.length) {
        throw new ApiError(400, 'invalid_products', 'every issuer must currently offer the selected underlying');
    }
}

async function ownedWatch(c) {
    const id = watchId(c);
    const ownerHash = hashWatchKey(watchKeyFromRequest(c));
    const { rows } = await query(`
        SELECT watch_id, title, underlying_ticker, issuer_slugs, filters, baseline,
               last_changes, created_at, updated_at, last_checked_at
        FROM sonar.stock_watchlist
        WHERE watch_id = $1 AND owner_hash = $2`, [id, ownerHash]);
    if (!rows[0]) throw notFound('no such watchlist or owner key');
    return rows[0];
}

routes.post('/watchlists', async (c) => {
    takeCreateSlot(c);
    const payload = parseWatchPayload(await jsonBody(c));
    await validateProducts(payload);
    const { watchId: id, watchKey } = createWatchCredentials();
    const { rows } = await query(`
        INSERT INTO sonar.stock_watchlist
            (watch_id, owner_hash, title, underlying_ticker, issuer_slugs, filters)
        VALUES ($1, $2, $3, $4, $5::text[], $6::jsonb)
        RETURNING watch_id, title, underlying_ticker, issuer_slugs, filters, baseline,
                  last_changes, created_at, updated_at, last_checked_at`,
    [id, hashWatchKey(watchKey), payload.title, payload.ticker, payload.issuers, JSON.stringify(payload.filters)]);
    return c.json({ ...publicWatch(rows[0]), watchKey }, 201);
});

routes.get('/watchlists/:watchId', async (c) => c.json(publicWatch(await ownedWatch(c))));

routes.put('/watchlists/:watchId', async (c) => {
    const current = await ownedWatch(c);
    const payload = parseWatchPayload(await jsonBody(c));
    await validateProducts(payload);
    const { rows } = await query(`
        UPDATE sonar.stock_watchlist
        SET title = $3, underlying_ticker = $4, issuer_slugs = $5::text[], filters = $6::jsonb,
            baseline = NULL, last_changes = '[]'::jsonb, last_checked_at = NULL, updated_at = now()
        WHERE watch_id = $1 AND owner_hash = $2
        RETURNING watch_id, title, underlying_ticker, issuer_slugs, filters, baseline,
                  last_changes, created_at, updated_at, last_checked_at`,
    [current.watch_id, hashWatchKey(watchKeyFromRequest(c)), payload.title, payload.ticker,
        payload.issuers, JSON.stringify(payload.filters)]);
    return c.json(publicWatch(rows[0]));
});

routes.delete('/watchlists/:watchId', async (c) => {
    const current = await ownedWatch(c);
    await query('DELETE FROM sonar.stock_watchlist WHERE watch_id = $1', [current.watch_id]);
    return c.body(null, 204);
});

export default routes;
