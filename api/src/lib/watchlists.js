import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { ApiError } from './query.js';

export const WATCH_FILTERS = new Set([
    'cashRedemption', 'noDiscretionaryFreeze', 'confirmedCollateral',
    'autonomousLiquidation', 'segregatedAssets', 'nonUsHolders', 'freshEvidence'
]);
export const WATCH_TYPES = new Set(['comparison', 'token', 'issuer', 'protocol-market']);

export function hashWatchKey(value) {
    return createHash('sha256').update(String(value)).digest('hex');
}

export function createWatchCredentials() {
    return {
        watchId: randomUUID(),
        watchKey: randomBytes(24).toString('base64url'),
        readKey: randomBytes(24).toString('base64url')
    };
}

function string(value) {
    return typeof value === 'string' ? value.trim() : '';
}

export function parseWatchPayload(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new ApiError(400, 'invalid_watchlist', 'watchlist body must be a JSON object');
    }
    const type = string(body.type) || 'comparison';
    if (!WATCH_TYPES.has(type)) throw new ApiError(400, 'invalid_watch_type', `unknown watch type: ${type}`);
    const rawTarget = body.target && typeof body.target === 'object' && !Array.isArray(body.target)
        ? body.target : body;
    let ticker = null;
    let issuers = [];
    let target;
    if (type === 'comparison') {
        ticker = string(body.ticker ?? rawTarget.ticker).toUpperCase();
        if (!/^[A-Z0-9.-]{1,16}$/.test(ticker)) {
            throw new ApiError(400, 'invalid_ticker', 'ticker must contain 1–16 letters, digits, dots or hyphens');
        }
        issuers = [...new Set((Array.isArray(body.issuers ?? rawTarget.issuers) ? body.issuers ?? rawTarget.issuers : [])
            .map(string).filter((value) => /^[a-z0-9-]{1,80}$/.test(value)))].sort();
        if (issuers.length < 1 || issuers.length > 100) {
            // A singleton is useful and a stock can have many tokenizers. This is a request-size
            // guard, not a product assumption that wrappers only arrive in pairs.
            throw new ApiError(400, 'invalid_issuers', 'a stock watch requires 1–100 issuer slugs');
        }
        target = { ticker, issuers };
    } else if (type === 'token') {
        const mint = string(rawTarget.mint);
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
            throw new ApiError(400, 'invalid_mint', 'token watches require an exact Solana mint address');
        }
        target = { mint };
    } else if (type === 'issuer') {
        const issuerSlug = string(rawTarget.issuerSlug);
        if (!/^[a-z0-9-]{1,80}$/.test(issuerSlug)) {
            throw new ApiError(400, 'invalid_issuer', 'issuer watches require an issuer slug');
        }
        target = { issuerSlug };
    } else {
        const mint = string(rawTarget.mint);
        const integrationId = string(rawTarget.integrationId);
        const marketKey = string(rawTarget.marketKey);
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
            throw new ApiError(400, 'invalid_mint', 'protocol-market watches require an exact Solana mint address');
        }
        if (!/^[a-z0-9:-]{3,120}$/i.test(integrationId)) {
            throw new ApiError(400, 'invalid_integration', 'protocol-market watches require an integration id');
        }
        if (!/^[A-Za-z0-9:._-]{1,120}$/.test(marketKey)) {
            throw new ApiError(400, 'invalid_market', 'protocol-market watches require an exact market key');
        }
        target = { mint, integrationId, marketKey };
    }
    const filters = [...new Set((Array.isArray(body.filters) ? body.filters : []).map(string))].sort();
    const unknown = filters.filter((filter) => !WATCH_FILTERS.has(filter));
    if (unknown.length) {
        throw new ApiError(400, 'invalid_filter', `unknown watch filter: ${unknown.join(', ')}`);
    }
    const title = string(body.title);
    if (title.length > 80) throw new ApiError(400, 'invalid_title', 'title must be at most 80 characters');
    const digestInput = body.digest && typeof body.digest === 'object' && !Array.isArray(body.digest)
        ? body.digest : {};
    const digestEnabled = digestInput.enabled === true;
    if (digestEnabled) {
        throw new ApiError(409, 'digest_delivery_unavailable',
            'personal digests require a verified private delivery channel and are not enabled yet');
    }
    const digestHour = digestInput.hour === undefined ? 6 : Number(digestInput.hour);
    const digestTimezone = string(digestInput.timezone) || 'UTC';
    if (!Number.isInteger(digestHour) || digestHour < 0 || digestHour > 23) {
        throw new ApiError(400, 'invalid_digest_hour', 'digest hour must be an integer from 0 to 23');
    }
    try {
        new Intl.DateTimeFormat('en', { timeZone: digestTimezone }).format();
    } catch {
        throw new ApiError(400, 'invalid_digest_timezone', 'digest timezone must be an IANA timezone');
    }
    return {
        type, target, ticker, issuers, filters, title: title || null,
        digest: { enabled: digestEnabled, hour: digestHour, timezone: digestTimezone }
    };
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
        type: row.watch_type ?? 'comparison',
        target: row.target ?? { ticker: row.underlying_ticker, issuers: row.issuer_slugs },
        ticker: row.underlying_ticker,
        issuers: row.issuer_slugs ?? [],
        filters: row.filters,
        digest: {
            enabled: row.digest_enabled === true,
            hour: row.digest_hour ?? 6,
            timezone: row.digest_timezone ?? 'UTC'
        },
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastCheckedAt: row.last_checked_at,
        changes: row.last_changes ?? [],
        baselineRecorded: row.baseline !== null
    };
}
