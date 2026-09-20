import { createHash, timingSafeEqual } from 'node:crypto';

import { ApiError } from './query.js';

export const REVIEW_RESOLUTIONS = new Set(['confirmed', 'corrected', 'superseded', 'false-alarm', 'deferred']);

function clean(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function digest(value) {
    return createHash('sha256').update(String(value)).digest();
}

export function requireReviewToken(header, expected = process.env.RWA_REVIEW_ADMIN_TOKEN) {
    if (!expected) throw new ApiError(503, 'review_auth_unconfigured', 'editor authentication is not configured');
    const match = /^Bearer\s+(.+)$/i.exec(clean(header));
    if (!match || !timingSafeEqual(digest(match[1]), digest(expected))) {
        throw new ApiError(401, 'review_auth_required', 'a valid editor bearer token is required');
    }
    return true;
}

export function parseResolutionPayload(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new ApiError(400, 'invalid_resolution', 'resolution body must be a JSON object');
    }
    const itemId = clean(body.itemId);
    const resolution = clean(body.resolution);
    const note = clean(body.note);
    const reviewer = clean(body.reviewer);
    if (!/^[a-f0-9]{16}$/.test(itemId)) throw new ApiError(400, 'invalid_item', 'itemId is not a review queue id');
    if (!REVIEW_RESOLUTIONS.has(resolution)) throw new ApiError(400, 'invalid_resolution', 'unknown resolution');
    if (note.length < 3 || note.length > 4000) throw new ApiError(400, 'invalid_note', 'note must be 3–4000 characters');
    if (reviewer.length < 2 || reviewer.length > 120) throw new ApiError(400, 'invalid_reviewer', 'reviewer must be 2–120 characters');
    return { itemId, resolution, note, reviewer };
}

export function publicResolution(row) {
    return {
        id: Number(row.id), itemId: row.review_item_id, eventId: row.event_id === null ? null : Number(row.event_id),
        issuerSlug: row.issuer_slug, field: row.field, issue: row.issue, resolution: row.resolution,
        note: row.note, reviewer: row.reviewer, previousText: row.previous_text,
        currentText: row.current_text, claimImpact: row.claim_impact, createdAt: row.created_at
    };
}
