/*
 * Which trades the live tape (live.html) shows: routed trades are hidden by default, and this module
 * decides what "routed" means, picks one tape page from a batch of API or capture rows, and words the
 * toggle. Pure — no DOM, no fetch, no clock — so jest covers it and live.js only wires it up.
 *
 * The rule is the collector's own `routed` flag (stocks/lib/trades.mjs decodeTrade): the transaction
 * moved more than two mints, so this pool was one leg of an aggregator or arbitrage path rather than
 * a plain two-sided swap. It is the only bot signal the page receives — the API and
 * stocks-trades.json carry `routed` and `program_count`, not the program ids — and the evidence says
 * it is mostly automated flow. Measured on the collector's 24 h store (stocks/data/trades-24h.json on
 * the server, 2026-09-29 13:44 → 2026-09-30 13:40 UTC, 2,762 decoded trades):
 *   - 1,897 trades (68.7 %) were routed.
 *   - Of those, 1,230 (65 %) invoked a known bot program at top level (FLASHX8…xtBB9 — 934 alone,
 *     from 774 throwaway fee payers — GMGN's GMGNre…LA1 and term9Y…ZN3), 303 (16 %) went through
 *     some other custom program, and only 364 (19 %) through a public aggregator (Jupiter JUP6Lk…,
 *     DF1ow4…, proVF4…, routeU…), which is the part a person could have clicked.
 *   - Routed tickets are small: median $19 through bot programs and $35 through aggregators, against
 *     $395 for direct swaps; 26 % of routed trades were under $5 (direct: 10 %).
 * So "routed" over-hides the minority of aggregator swaps a person placed; the toggle lets a reader
 * put them back, and nothing is dropped from the replay or any total.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.__rwaLiveTape = factory();
})(this, function () {
    /** How many API rows to read per page while routed trades are hidden (~30 % of rows survive). */
    const HIDDEN_BATCH_FACTOR = 5;

    /** True for a trade the tape hides by default. Only an explicit `true` counts; missing is not routed. */
    function isRoutedTrade(trade) {
        return trade !== null && typeof trade === 'object' && trade.routed === true;
    }

    /** How many rows to request for one page of `limit` visible trades. */
    function batchSize(limit, showRouted) {
        return showRouted ? limit : limit * HIDDEN_BATCH_FACTOR;
    }

    /**
     * One tape page from a newest-first batch: the first `limit` visible rows, how many routed rows
     * were skipped to reach them, and how many batch rows were consumed (`scanned`), so the next page
     * resumes right after the last row shown and never skips a visible trade.
     */
    function pickTapePage(rows, { showRouted = false, limit = 20 } = {}) {
        const list = Array.isArray(rows) ? rows : [];
        const shown = [];
        let hidden = 0;
        let scanned = 0;
        for (const row of list) {
            if (shown.length >= limit) break;
            scanned += 1;
            if (!showRouted && isRoutedTrade(row)) hidden += 1;
            else shown.push(row);
        }
        return { shown, hidden, scanned, exhausted: scanned === list.length };
    }

    /**
     * The API keyset cursor for the page after `pick`: the batch's own `nextBefore` when the whole
     * batch was consumed, else `time,sig` of the last row consumed (the format /api/trades/recent
     * emits and parseBefore reads). Null when there is nothing older.
     */
    function nextApiCursor(rows, pick, batchNextBefore) {
        if (pick.exhausted) return batchNextBefore ?? null;
        const last = rows[pick.scanned - 1];
        const ms = last ? Date.parse(last.time) : NaN;
        if (!Number.isFinite(ms) || typeof last.sig !== 'string' || !last.sig) return batchNextBefore ?? null;
        return `${new Date(ms).toISOString()},${last.sig}`;
    }

    /** Routed count and share over a list of trades (the 24 h capture); share null when empty. */
    function routedSummary(trades) {
        const list = Array.isArray(trades) ? trades : [];
        const routed = list.filter(isRoutedTrade).length;
        return { total: list.length, routed, share: list.length > 0 ? routed / list.length : null };
    }

    /** The toggle's label. `hidden` is the count skipped on the page on screen. */
    function toggleLabel(hidden, showRouted) {
        if (showRouted) return 'Show automated routed trades';
        const n = Number.isInteger(hidden) && hidden > 0 ? hidden : 0;
        return `Show automated routed trades (${n.toLocaleString('en-US')} hidden on this page)`;
    }

    /** The sentence under the toggle: what routed means and how much of the 24 h capture it is. */
    function routedNote(summary) {
        const s = summary && typeof summary === 'object' ? summary : {};
        const base = 'Routed trades moved more than two tokens in one transaction: one leg of an arbitrage bot or aggregator path. ' +
            'In a 24-hour sample about 4 in 5 of them ran through bot or custom trading programs rather than a public aggregator like Jupiter.';
        if (typeof s.share !== 'number' || !Number.isFinite(s.share)) return base;
        return `${base} They are ${Math.round(s.share * 100)}% of the ${s.total.toLocaleString('en-US')} trades in the last 24 h capture.`;
    }

    /** The remembered preference: only the stored string '1' turns routed trades on. */
    function parseShowRouted(stored) {
        return stored === '1';
    }

    return {
        HIDDEN_BATCH_FACTOR,
        STORAGE_KEY: 'rwa-sonar:live-show-routed',
        isRoutedTrade,
        batchSize,
        pickTapePage,
        nextApiCursor,
        routedSummary,
        toggleLabel,
        routedNote,
        parseShowRouted
    };
});
