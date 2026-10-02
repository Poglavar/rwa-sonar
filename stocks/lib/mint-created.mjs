// Pure selection and folding for stocks/fetch-mint-created.mjs: which recently first-seen mints to
// ask the chain about, and what a mint account's signature history says about when it was created.
// The chain's own blockTime of the mint's oldest transaction is its creation time; when the page
// budget runs out first, the oldest transaction seen is only a bound ("created at or before"), which
// is still enough to tell that a mint existed long before we first saw it. Tested in ../events.test.js.

import { PREDATES_MS, creationVerdict, eventTime, timeMs } from './events.mjs';

/** getSignaturesForAddress returns at most this many signatures per call. */
export const PAGE_LIMIT = 1000;

/** A cached record that needs no more reads: its creation is known, or it provably predates first sight. */
export function isSettled(record) {
    return record?.state === 'created' || record?.state === 'predates' || record?.state === 'undecided';
}

/**
 * The mints worth one bounded look, most useful first: the newest unchecked mint of every issuer-day
 * batch of first sightings inside the window (so every catalogue row can be worded correctly), then
 * the newest mints overall. Skipped: the founding cohort, anything already settled in `cache`, and a
 * batch in which one mint already proved older than its first sighting.
 */
export function mintsToCheck(tokens, cache, { asOf, recordsBeginOn = null, windowDays = 30, newest = 10 } = {}) {
    const end = timeMs(asOf);
    if (end === null) return [];
    const cutoff = end - windowDays * 86400000;
    const rows = [];
    // A batch in which one mint already proved older is decided (lib/events.mjs leaves it out).
    const decided = new Set();
    for (const token of Array.isArray(tokens) ? tokens : []) {
        const mint = typeof token?.mint === 'string' ? token.mint : null;
        const seen = eventTime(token?.firstSeenAt);
        const seenMs = timeMs(seen);
        if (mint === null || seenMs === null || seen.length === 10 || seenMs < cutoff) continue;
        if (recordsBeginOn && seen.slice(0, 10) <= recordsBeginOn) continue;
        const group = `${token.issuer ?? null}|${seen.slice(0, 10)}`;
        if (cache?.[mint]?.state === 'predates' || creationVerdict(cache?.[mint], seen)?.verdict === 'predates') decided.add(group);
        if (isSettled(cache?.[mint])) continue;
        rows.push({ mint, firstSeenAt: seen, issuer: token.issuer ?? null, group, seenMs });
    }
    rows.sort((a, b) => b.seenMs - a.seenMs || (a.mint < b.mint ? -1 : 1));
    const picked = [];
    const groups = new Set(decided);
    for (const row of rows) {
        if (groups.has(row.group)) continue;
        groups.add(row.group);
        picked.push(row);
    }
    for (const row of rows.slice(0, newest)) if (!picked.includes(row) && !decided.has(row.group)) picked.push(row);
    return picked.map(({ mint, firstSeenAt, group }) => ({ mint, firstSeenAt, group }));
}

function blockTimeIso(seconds) {
    return typeof seconds === 'number' && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
}

/**
 * One page of getSignaturesForAddress (newest first) folded into the record. A short page is the
 * start of the history: its last signature is the mint's first transaction. A full page moves the
 * bound back; the record is `predates` once that bound is PREDATES_MS before first sight.
 * `lastPage` marks the budget's final page, after which an open record is `undecided`.
 */
export function foldSignaturePage(record, page, { firstSeenAt, pageLimit = PAGE_LIMIT, lastPage = false } = {}) {
    const rows = Array.isArray(page) ? page.filter((row) => typeof row?.signature === 'string') : [];
    const next = { ...record, firstSeenAt, pages: (record?.pages ?? 0) + 1 };
    const oldest = rows.at(-1) ?? null;
    if (oldest !== null) {
        next.oldestSignature = oldest.signature;
        const at = blockTimeIso(oldest.blockTime);
        if (at !== null) next.createdBefore = at;
    }
    if (rows.length < pageLimit) {
        next.state = next.createdBefore ? 'created' : 'undecided';
        next.createdAt = next.state === 'created' ? next.createdBefore : null;
        return next;
    }
    const bound = timeMs(next.createdBefore);
    const seen = timeMs(firstSeenAt);
    if (bound !== null && seen !== null && bound < seen - PREDATES_MS) next.state = 'predates';
    else next.state = lastPage ? 'undecided' : 'open';
    next.createdAt = null;
    return next;
}
