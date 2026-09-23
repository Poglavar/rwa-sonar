/*
 * Pure shaping for exits.html ("Where can you exit?"): the underlying picker, the per-wrapper
 * stacked bar of observed DEX pool liquidity by venue, the redemption and lending route lanes, and
 * the sortable all-wrappers table. No DOM, no fetch, no clock. A token whose venues were never
 * collected and a token collected with no pool are different states, and neither is $0.
 * UMD like the other stocks/lib/*.js files (window.__rwaExitsView). Tested in stocks/exits-view.test.js.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./sort-values.js'));
    else root.__rwaExitsView = factory(root.__rwaSortValues);
})(this, function (sortValues) {
    'use strict';

    const { compareValues } = sortValues;

    const DEFAULT_UNDERLYING = 'NVDA';

    const COVERAGE_LABELS = {
        observed: 'DEX pool observed',
        'none-observed': 'No DEX pool observed',
        'not-collected': 'Venues not collected for this mint'
    };

    /** Route states in strength order, for sorting the table's redemption column. */
    const ROUTE_ORDER = ['observed-onchain', 'operational', 'documented', 'no-public-route', 'no-right', 'not-recorded'];

    const LENDER_EXIT_ORDER = ['autonomous', 'conditional', 'issuer-dependent', 'fragile', 'unavailable', 'unknown'];

    /** Venue colour slots; a venue keeps its slot on every bar so the legend reads across wrappers. */
    const VENUE_SLOTS = ['raydium', 'orca', 'meteora', 'meteoradbc'];

    function finite(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }

    function venueSlot(venue) {
        const i = VENUE_SLOTS.indexOf(venue);
        return i < 0 ? 'other' : venue;
    }

    /** Underlyings with at least one wrapper, most-wrapped first, then by ticker. */
    function underlyingOptions(tokens) {
        const by = new Map();
        for (const t of Array.isArray(tokens) ? tokens : []) {
            if (typeof t?.underlying !== 'string' || !t.underlying) continue;
            if (!by.has(t.underlying)) by.set(t.underlying, { ticker: t.underlying, wrappers: 0, withPool: 0 });
            const row = by.get(t.underlying);
            row.wrappers += 1;
            if (t.venueCoverage === 'observed') row.withPool += 1;
        }
        return [...by.values()].sort((a, b) => b.wrappers - a.wrappers || b.withPool - a.withPool || a.ticker.localeCompare(b.ticker));
    }

    /** The `?u=` ticker if it names a known underlying (case-insensitive), else the default. */
    function selectedUnderlying(search, options) {
        const wanted = new URLSearchParams(typeof search === 'string' ? search : '').get('u');
        const list = Array.isArray(options) ? options : [];
        const hit = typeof wanted === 'string' ? list.find((o) => o.ticker.toLowerCase() === wanted.trim().toLowerCase()) : null;
        if (hit) return hit.ticker;
        return list.some((o) => o.ticker === DEFAULT_UNDERLYING) ? DEFAULT_UNDERLYING : (list[0]?.ticker ?? null);
    }

    /** Wrappers of one underlying, deepest observed liquidity first, unknown depth last. */
    function wrappersOf(tokens, ticker) {
        return (Array.isArray(tokens) ? tokens : []).filter((t) => t?.underlying === ticker)
            .sort((a, b) => compareValues(a.dexLiquidityUsd, b.dexLiquidityUsd, false) || String(a.symbol).localeCompare(String(b.symbol)));
    }

    /** Pool liquidity summed per venue, largest first. Pools with no liquidity figure are counted, not summed. */
    function venueTotals(pools) {
        const by = new Map();
        for (const p of Array.isArray(pools) ? pools : []) {
            const key = p?.venue ?? 'unknown';
            if (!by.has(key)) by.set(key, { venue: key, venueName: p?.venueName ?? key, slot: venueSlot(key), usd: null, pools: 0, unpriced: 0 });
            const row = by.get(key);
            row.pools += 1;
            const usd = finite(p?.liquidityUsd);
            if (usd === null) row.unpriced += 1; else row.usd = (row.usd ?? 0) + usd;
        }
        return [...by.values()].sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
    }

    /**
     * Stacked-bar geometry in percent of a shared scale (`scaleMax` = the deepest wrapper on screen),
     * so bars compare across wrappers. A venue with liquidity below 0.6 % keeps a visible sliver.
     */
    function barSegments(pools, scaleMax) {
        const totals = venueTotals(pools);
        const max = finite(scaleMax) !== null && scaleMax > 0 ? scaleMax : null;
        let x = 0;
        const segments = [];
        for (const v of totals) {
            if (v.usd === null || max === null) continue;
            const w = Math.max(0.6, (v.usd / max) * 100);
            segments.push({ ...v, x, w });
            x += w;
        }
        return { segments, totalPct: x, venues: totals };
    }

    function pctRange(r) {
        if (!r || finite(r.min) === null) return null;
        const f = (v) => `${Math.round(v * 1000) / 10}%`;
        return r.min === r.max ? f(r.min) : `${f(r.min)}–${f(r.max)}`;
    }

    /** One wrapper's redemption lane: the programme route plus whether THIS token's redemption was seen. */
    function redemptionLane(token, issuer) {
        const r = issuer?.redemption ?? null;
        if (!r) return { state: 'not-recorded', label: 'Not recorded', lines: ['No redemption terms are recorded for this issuer.'] };
        const lines = [];
        if (r.documentedRight === true) lines.push(`Contractual right documented${r.kyc === true ? '; KYC/AML-approved holders only' : ''}.`);
        else if (r.documentedRight === false) lines.push('The documents give holders no redemption right.');
        if (r.operational?.value === true) lines.push(`Official source says the route is currently available (checked ${r.operational.checkedAt ?? 'at an unrecorded time'}).`);
        else if (r.state === 'no-public-route') lines.push(`No public operational route found (checked ${r.operational?.checkedAt ?? 'at an unrecorded time'}).`);
        if (r.observed?.value === true) {
            lines.push(token?.redemptionObservedForToken === true
                ? `Observed on-chain for ${token.symbol} itself; latest programme redemption ${r.observed.latestObservedAt ?? 'at an unrecorded time'}.`
                : `Observed on-chain for other ${issuer.name} products, not for ${token?.symbol ?? 'this token'} itself.`);
        }
        if (r.observed?.feedText) lines.push(`Recurring scan: ${r.observed.feedText}`);
        lines.push(r.minimum ? 'No capacity limit is stated; a minimum ticket is (see terms).' : 'No capacity limit is stated, so no dollar figure is shown.');
        return { state: r.state, label: r.label, lines, url: r.operational?.url ?? null, minimum: r.minimum?.completeText ?? null };
    }

    /** One wrapper's lending lane rows, readable without the dossier. */
    function lendingLane(token) {
        const rows = (token?.lending ?? []).map((l) => ({
            protocol: l.protocol, stage: l.stage, stageAsOf: l.stageAsOf, dossier: l.dossier, use: l.use,
            text: [
                l.action === 'loan' ? 'Observed loan position' : 'Borrow against it',
                pctRange(l.maxLtv) ? `max LTV ${pctRange(l.maxLtv)}` : 'max LTV not reported',
                l.debt?.length ? `debt ${l.debt.join(', ')}` : null
            ].filter(Boolean).join(' · '),
            sizeUsd: finite(l.sizeUsd)
        }));
        return { rows, lenderExit: token?.lenderExit ?? null };
    }

    /** Table rows for every wrapper of every underlying. */
    function tableRows(tokens, issuers) {
        return (Array.isArray(tokens) ? tokens : []).map((t) => {
            const issuer = issuers?.[t.issuer] ?? null;
            const venues = venueTotals(t.pools);
            return {
                mint: t.mint, symbol: t.symbol, underlying: t.underlying, issuer: t.issuer, issuerName: issuer?.name ?? t.issuer,
                issuerStatus: issuer?.status ?? null, cardSlug: t.cardSlug,
                depth: t.venueCoverage === 'observed' ? finite(t.dexLiquidityUsd) : null,
                coverage: t.venueCoverage, dexFetchedAt: t.dexFetchedAt ?? null,
                pools: t.venueCoverage === 'not-collected' ? null : (t.pools ?? []).length,
                topVenue: venues[0]?.venueName ?? null,
                route: issuer?.redemption?.state ?? 'not-recorded',
                routeLabel: issuer?.redemption?.label ?? 'Not recorded',
                routeExact: t.redemptionObservedForToken,
                lending: (t.lending ?? []).length,
                lenderExit: t.lenderExit?.rating ?? null
            };
        });
    }

    const SORT_KEYS = {
        symbol: (r) => r.symbol, underlying: (r) => r.underlying, issuer: (r) => r.issuerName,
        depth: (r) => r.depth, pools: (r) => r.pools, venue: (r) => r.topVenue,
        route: (r) => { const i = ROUTE_ORDER.indexOf(r.route); return i < 0 ? null : i; },
        lending: (r) => r.lending
    };

    /** Stable sort with missing values last in both directions; ties broken by symbol. */
    function sortRows(rows, key, ascending) {
        const get = SORT_KEYS[key] ?? SORT_KEYS.depth;
        return rows.map((row, i) => [row, i]).sort(([a, ai], [b, bi]) => compareValues(get(a), get(b), ascending)
            || String(a.symbol).localeCompare(String(b.symbol)) || ai - bi).map(([row]) => row);
    }

    /** Case-insensitive match on symbol, underlying or issuer name. */
    function filterRows(rows, query) {
        const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
        if (!q) return rows;
        return rows.filter((r) => [r.symbol, r.underlying, r.issuerName].some((v) => typeof v === 'string' && v.toLowerCase().includes(q)));
    }

    return {
        DEFAULT_UNDERLYING, COVERAGE_LABELS, ROUTE_ORDER, LENDER_EXIT_ORDER, VENUE_SLOTS, SORT_KEYS,
        underlyingOptions, selectedUnderlying, wrappersOf, venueTotals, barSegments, pctRange,
        redemptionLane, lendingLane, tableRows, sortRows, filterRows
    };
});
