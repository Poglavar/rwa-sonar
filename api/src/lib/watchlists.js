import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { ApiError } from './query.js';

export const WATCH_FILTERS = new Set([
    'cashRedemption', 'noDiscretionaryFreeze', 'confirmedCollateral',
    'autonomousLiquidation', 'segregatedAssets', 'nonUsHolders', 'freshEvidence'
]);

export function hashWatchKey(value) {
    return createHash('sha256').update(String(value)).digest('hex');
}

export function createWatchCredentials() {
    return { watchId: randomUUID(), watchKey: randomBytes(24).toString('base64url') };
}

function string(value) {
    return typeof value === 'string' ? value.trim() : '';
}

export function parseWatchPayload(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new ApiError(400, 'invalid_watchlist', 'watchlist body must be a JSON object');
    }
    const ticker = string(body.ticker).toUpperCase();
    if (!/^[A-Z0-9.-]{1,16}$/.test(ticker)) {
        throw new ApiError(400, 'invalid_ticker', 'ticker must contain 1–16 letters, digits, dots or hyphens');
    }
    const issuers = [...new Set((Array.isArray(body.issuers) ? body.issuers : [])
        .map(string).filter((value) => /^[a-z0-9-]{1,80}$/.test(value)))].sort();
    if (issuers.length < 2 || issuers.length > 12) {
        throw new ApiError(400, 'invalid_issuers', 'a comparison watch requires 2–12 issuer slugs');
    }
    const filters = [...new Set((Array.isArray(body.filters) ? body.filters : []).map(string))].sort();
    const unknown = filters.filter((filter) => !WATCH_FILTERS.has(filter));
    if (unknown.length) {
        throw new ApiError(400, 'invalid_filter', `unknown watch filter: ${unknown.join(', ')}`);
    }
    const title = string(body.title);
    if (title.length > 80) throw new ApiError(400, 'invalid_title', 'title must be at most 80 characters');
    return { ticker, issuers, filters, title: title || null };
}

export function watchKeyFromRequest(c) {
    const key = string(c.req.header('X-Watch-Key'));
    if (!/^[A-Za-z0-9_-]{24,80}$/.test(key)) {
        throw new ApiError(401, 'watch_key_required', 'a valid X-Watch-Key header is required');
    }
    return key;
}

export function publicWatch(row) {
    return {
        watchId: row.watch_id,
        title: row.title,
        ticker: row.underlying_ticker,
        issuers: row.issuer_slugs,
        filters: row.filters,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastCheckedAt: row.last_checked_at,
        changes: row.last_changes ?? [],
        baselineRecorded: row.baseline !== null
    };
}
