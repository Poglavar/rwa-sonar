// Shareable comparison, exact-token, issuer and protocol-market watches. Owner and read-only keys
// are accepted only as headers and stored only as SHA-256 hashes. Raw keys stay in URL fragments,
// which are never sent to nginx or the API.

import { readFileSync } from 'node:fs';
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
    if (payload.type === 'token') {
        const { rows } = await query('SELECT mint FROM sonar.stock_token WHERE mint = $1', [payload.target.mint]);
        if (!rows[0]) throw new ApiError(400, 'invalid_token', 'the exact token is not in the current catalogue');
        return;
    }
    if (payload.type === 'issuer') {
        const { rows } = await query('SELECT slug FROM sonar.stock_issuer WHERE slug = $1', [payload.target.issuerSlug]);
        if (!rows[0]) throw new ApiError(400, 'invalid_issuer', 'the issuer is not in the current catalogue');
        return;
    }
    if (payload.type === 'protocol-market') {
        const usage = JSON.parse(readFileSync(new URL('../../../stocks/data/defi-usage.json', import.meta.url), 'utf8'));
        const item = (usage.items ?? []).find((row) => row.mint === payload.target.mint);
        const integration = item?.integrations?.find((row) => row.id === payload.target.integrationId);
        const market = integration?.markets?.find((row) => Object.values(row ?? {})
            .some((value) => String(value) === payload.target.marketKey));
        if (!integration || !market) {
            throw new ApiError(400, 'invalid_protocol_market', 'the exact token and market route are not in the current protocol registry');
        }
        return;
    }
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

export async function ownedWatch(c) {
    const id = watchId(c);
    const ownerHash = hashWatchKey(watchKeyFromRequest(c));
    const { rows } = await query(`
        SELECT watch_id, title, watch_type, target, underlying_ticker, issuer_slugs, filters,
               digest_enabled, digest_hour, digest_timezone, baseline, last_changes,
               created_at, updated_at, last_checked_at
        FROM sonar.stock_watchlist
        WHERE watch_id = $1 AND owner_hash = $2`, [id, ownerHash]);
    if (!rows[0]) throw notFound('no such watchlist or owner key');
    return rows[0];
}

async function readableWatch(c) {
    const id = watchId(c);
    const keyHash = hashWatchKey(watchKeyFromRequest(c));
    const { rows } = await query(`
        SELECT watch_id, title, watch_type, target, underlying_ticker, issuer_slugs, filters,
               digest_enabled, digest_hour, digest_timezone, baseline, last_changes,
               created_at, updated_at, last_checked_at,
               owner_hash = $2 AS owner_access
        FROM sonar.stock_watchlist
        WHERE watch_id = $1 AND (owner_hash = $2 OR read_hash = $2)`, [id, keyHash]);
    if (!rows[0]) throw notFound('no such watchlist or access key');
    return rows[0];
}

routes.post('/watchlists', async (c) => {
    takeCreateSlot(c);
    const payload = parseWatchPayload(await jsonBody(c));
    await validateProducts(payload);
    const { watchId: id, watchKey, readKey } = createWatchCredentials();
    const { rows } = await query(`
        INSERT INTO sonar.stock_watchlist
            (watch_id, owner_hash, read_hash, title, watch_type, target, underlying_ticker,
             issuer_slugs, filters, digest_enabled, digest_hour, digest_timezone)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::text[], $9::jsonb, $10, $11, $12)
        RETURNING watch_id, title, watch_type, target, underlying_ticker, issuer_slugs, filters,
                  digest_enabled, digest_hour, digest_timezone, baseline, last_changes,
                  created_at, updated_at, last_checked_at`,
    [id, hashWatchKey(watchKey), hashWatchKey(readKey), payload.title, payload.type,
        JSON.stringify(payload.target), payload.ticker, payload.issuers, JSON.stringify(payload.filters),
        payload.digest.enabled, payload.digest.hour, payload.digest.timezone]);
    return c.json({ ...publicWatch(rows[0]), access: 'owner', watchKey, readKey }, 201);
});

routes.get('/watchlists/:watchId', async (c) => {
    const row = await readableWatch(c);
    // Keyed by a header, not the URL: a shared cache must never serve one key's answer to another.
    c.header('Cache-Control', 'private, no-store');
    return c.json({ ...publicWatch(row), access: row.owner_access ? 'owner' : 'read-only' });
});

routes.put('/watchlists/:watchId', async (c) => {
    const current = await ownedWatch(c);
    const payload = parseWatchPayload(await jsonBody(c));
    await validateProducts(payload);
    const { rows } = await query(`
        UPDATE sonar.stock_watchlist
        SET title = $3, watch_type = $4, target = $5::jsonb, underlying_ticker = $6,
            issuer_slugs = $7::text[], filters = $8::jsonb,
            -- Digest settings are owned by PUT /watchlists/:id/digest, which requires a verified
            -- private chat; editing the target keeps the owner's delivery choice and hour.
            baseline = NULL, last_changes = '[]'::jsonb, last_checked_at = NULL, updated_at = now()
        WHERE watch_id = $1 AND owner_hash = $2
        RETURNING watch_id, title, watch_type, target, underlying_ticker, issuer_slugs, filters,
                  digest_enabled, digest_hour, digest_timezone, baseline, last_changes,
                  created_at, updated_at, last_checked_at`,
    [current.watch_id, hashWatchKey(watchKeyFromRequest(c)), payload.title, payload.type,
        JSON.stringify(payload.target), payload.ticker, payload.issuers, JSON.stringify(payload.filters)]);
    return c.json({ ...publicWatch(rows[0]), access: 'owner' });
});

routes.post('/watchlists/:watchId/share', async (c) => {
    const current = await ownedWatch(c);
    const { readKey } = createWatchCredentials();
    await query('UPDATE sonar.stock_watchlist SET read_hash = $2, updated_at = now() WHERE watch_id = $1',
        [current.watch_id, hashWatchKey(readKey)]);
    return c.json({ watchId: current.watch_id, readKey });
});

routes.delete('/watchlists/:watchId', async (c) => {
    const current = await ownedWatch(c);
    await query('DELETE FROM sonar.stock_watchlist WHERE watch_id = $1', [current.watch_id]);
    return c.body(null, 204);
});

export default routes;
