// PURE merge of the tokenized-stock universe across runs (no fs, no network, no clock): Jupiter's
// search is a RANKING over ~100-record pages, not a listing, so a mint today's queries did not
// return has almost never gone anywhere — it fell off the end of a page. Measured 2026-09-17: a
// fresh run of the same 118 queries dropped 24 of the 441 mints known on 2026-09-16 and added 30,
// while a direct `?query=<symbol>` still returned both of two dropped mints with their full stock
// tags. So the universe is kept MONOTONIC: a previously known mint is carried over with
// `seenInSearch: false` instead of vanishing, and `firstSeenAt` / `lastSeenAt` record when the
// search actually saw it. Unit-tested in ../universe.test.js.

/** A non-empty trimmed string, or null — a blank timestamp must never pass for a real one. */
function str(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Byte-order comparator on mint, so the file sorts identically on every machine. */
function byMint(a, b) {
    if (a.mint === b.mint) return 0;
    return a.mint < b.mint ? -1 : 1;
}

/**
 * This run's universe: every mint the search returned, plus every mint a previous run knew that it
 * did not return this time.
 *
 * - a returned mint gets the fresh record, `seenInSearch: true` and `lastSeenAt` = this run;
 * - a carried-over mint keeps its previous record untouched and gets `seenInSearch: false`, so a
 *   consumer can tell a stale row from a fresh one rather than reading month-old market numbers as
 *   today's;
 * - `firstSeenAt` is carried over from the previous record whenever there is one, so a mint that
 *   drops out for a week and comes back keeps the day we FIRST saw it;
 * - `lastSeenAt` on a carried-over mint stays whatever the previous record said (null when the
 *   previous record predates these fields) — it is never advanced to this run, which is the whole
 *   point of recording it.
 *
 * @param {Array<object>|null} previousItems `items` from the previous universe.json, if any
 * @param {Array<object>|null} freshItems this run's items, manual seeds included (they count as seen)
 * @param {{fetchedAt: string}} options this run's ISO timestamp — required, never invented here
 * @returns {Array<object>} one record per mint, sorted by mint
 */
export function mergeUniverse(previousItems, freshItems, { fetchedAt } = {}) {
    const runAt = str(fetchedAt);
    if (runAt === null) throw new Error('mergeUniverse needs this run\'s fetchedAt as an ISO string');

    // The previous file is one source, so a repeated mint in it is degenerate rather than a second
    // opinion: the first wins and the rest are dropped.
    const previous = new Map();
    for (const item of Array.isArray(previousItems) ? previousItems : []) {
        const mint = str(item?.mint);
        if (mint === null || previous.has(mint)) continue;
        previous.set(mint, item);
    }

    const merged = new Map();
    for (const item of Array.isArray(freshItems) ? freshItems : []) {
        const mint = str(item?.mint);
        if (mint === null) continue;
        const prev = previous.get(mint) ?? null;
        merged.set(mint, {
            ...item,
            firstSeenAt: str(prev?.firstSeenAt) ?? runAt,
            lastSeenAt: runAt,
            seenInSearch: true
        });
    }
    for (const [mint, prev] of previous) {
        if (merged.has(mint)) continue;
        merged.set(mint, {
            ...prev,
            firstSeenAt: str(prev.firstSeenAt) ?? runAt,
            lastSeenAt: str(prev.lastSeenAt),
            seenInSearch: false
        });
    }

    return [...merged.values()].sort(byMint);
}

/**
 * What the merge did, for the run's log and the output envelope. `newThisRun` counts records whose
 * `firstSeenAt` IS this run's timestamp — on a first run that is every mint, which is honest: no
 * file proves we saw them earlier.
 */
export function provenanceCounts(items, fetchedAt) {
    const list = Array.isArray(items) ? items : [];
    const runAt = str(fetchedAt);
    return {
        total: list.length,
        seenInSearch: list.filter((item) => item?.seenInSearch === true).length,
        carriedOverUnseen: list.filter((item) => item?.seenInSearch === false).length,
        newThisRun: runAt === null ? 0 : list.filter((item) => str(item?.firstSeenAt) === runAt).length
    };
}
