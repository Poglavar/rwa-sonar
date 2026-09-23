/*
 * Trading-activity rows (MODEL.md §11): per-issuer activity with its wash-trading and bot-flow
 * flags, and one token's venues as uniform rows for the detail panel, busiest first.
 *
 * Moved verbatim out of stocks.js (next-steps.md F11). Pure: no DOM, no fetch, no clock. UMD like the
 * other stocks/lib/*.js files: the browser loads it as a classic script before stocks.js and reads
 * window.__rwaActivityRows; jest requires it. Tested in stocks/activity-rows.test.js.
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./fmt.js'), require('./sort-values.js'));
    else root.__rwaActivityRows = factory(root.__rwaFmt, root.__rwaSortValues);
})(this, function (fmt, sortValues) {
    const { DASH, fmtPct, fmtTradesPerTrader, isNum, isSafeUrl } = fmt;
    const { compareValues } = sortValues;

    /** Above this many trades per trader, a row is flagged (MODEL §11.1, the wash-trading tell). */
    const ACTIVITY_FLAG_TRADES_PER_TRADER = 25;

    /** Below this organic share, in percent, a row is flagged. */
    const ACTIVITY_FLAG_ORGANIC_PCT = 5;

    /**
     * Which warnings a row earns (MODEL §11.1): too many trades per trader is the wash-trading tell,
     * and a tiny organic share means Jupiter classified almost all of the volume as bot flow. A null
     * never trips a flag — a mint nobody reports on is not a mint with zero organic volume.
     */
    function activityFlags(activity) {
        const flags = [];
        if (!activity || typeof activity !== 'object') return flags;
        const perTrader = activity.tradesPerTrader;
        if (isNum(perTrader) && perTrader > ACTIVITY_FLAG_TRADES_PER_TRADER) {
            flags.push({
                code: 'wash',
                label: 'wash?',
                glyph: '↻',
                detail: `${fmtTradesPerTrader(perTrader)} trades per trader, over the ` +
                    `${ACTIVITY_FLAG_TRADES_PER_TRADER} threshold: a few wallets are producing most of the trades.`
            });
        }
        const organic = activity.organicSharePct;
        if (isNum(organic) && organic < ACTIVITY_FLAG_ORGANIC_PCT) {
            flags.push({
                code: 'inorganic',
                label: 'bot flow',
                glyph: '⚠',
                detail: `${fmtPct(organic)} of 24h volume is classified as organic, under the ` +
                    `${ACTIVITY_FLAG_ORGANIC_PCT}% threshold: almost all of it is bot flow.`
            });
        }
        return flags;
    }

    /**
     * One issuer as a Trading-activity row (MODEL §11.3). Every number stays null when the build has
     * not produced it; organic share falls back to the §3.5 market aggregate, which is the same
     * quantity (Σ organic / Σ total × 100) computed in the same build.
     */
    function issuerActivityRow(issuer) {
        const activity = (issuer && issuer.activity) || {};
        const market = (issuer && issuer.market) || {};
        const num = (value) => (isNum(value) ? value : null);
        const organicSharePct = isNum(activity.organicSharePct)
            ? activity.organicSharePct
            : num(market.organicSharePct);
        const tradesPerTrader = num(activity.tradesPerTrader);
        return {
            slug: (issuer && issuer.slug) || '',
            name: (issuer && issuer.name) || '',
            status: (issuer && issuer.status) || '',
            // The aggregate's own denominator when the build states it, so "traded / mints" compares
            // like with like; the §3.5 market count is the fallback.
            tokens: isNum(activity.tokens) ? activity.tokens : num(market.tokens),
            tokensTraded24: num(activity.tokensTraded24),
            trades24: num(activity.trades24),
            traders24: num(activity.traders24),
            tradesPerTrader,
            organicSharePct,
            venueCount: num(activity.venueCount),
            venueSpreadMedianPct: num(activity.venueSpreadMedianPct),
            venuesTop: Array.isArray(activity.venuesTop) ? activity.venuesTop : [],
            lastTradedAt: typeof activity.lastTradedAt === 'string' && activity.lastTradedAt.trim()
                ? activity.lastTradedAt
                : null,
            lastTradedVenue: typeof activity.lastTradedVenue === 'string' && activity.lastTradedVenue.trim()
                ? activity.lastTradedVenue
                : null,
            flags: activityFlags({ tradesPerTrader, organicSharePct })
        };
    }

    /** The Trading-activity table's rows: live issuers only (§11.3), defunct ones are omitted. */
    function activityRows(issuers) {
        if (!Array.isArray(issuers)) return [];
        return issuers.filter((issuer) => issuer && issuer.status === 'live').map(issuerActivityRow);
    }

    /**
     * A pair leg as something readable. CoinGecko reports a DEX ticker's base and target as raw mint
     * addresses, which would make the pair column of the venue table wider than a phone, so an address
     * is shortened to its ends; a real symbol (USDC, SOL) is never touched.
     */
    function shortenPairLeg(value) {
        if (typeof value !== 'string' || !value.trim()) return null;
        const leg = value.trim();
        if (leg.length <= 12 || /[^A-Za-z0-9]/.test(leg)) return leg;
        return `${leg.slice(0, 4)}…${leg.slice(-4)}`;
    }

    /**
     * The venues of one token as uniform rows for the detail panel, busiest first. Accepts either the
     * `{dex: [...], cex: [...]}` shape of venues.json or one flat array, and infers the kind from the
     * fields when an item does not name it, so a pair keeps rendering if the builder reshapes it.
     */
    function venueRows(source) {
        const items = [];
        if (Array.isArray(source)) {
            items.push(...source);
        } else if (source && typeof source === 'object') {
            if (Array.isArray(source.dex)) items.push(...source.dex.map((v) => ({ kind: 'dex', ...v })));
            if (Array.isArray(source.cex)) items.push(...source.cex.map((v) => ({ kind: 'cex', ...v })));
        }
        const rows = [];
        for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            const kind = item.kind === 'dex' || item.kind === 'cex'
                ? item.kind
                : (item.dexId || item.pairAddress) ? 'dex' : item.market ? 'cex' : null;
            if (!kind) continue;
            const name = kind === 'dex'
                ? (item.dexId || item.name || null)
                : (item.market || item.name || null);
            const pairFull = kind === 'dex'
                ? (item.quoteSymbol ? `/${item.quoteSymbol}` : null)
                : (item.base && item.target ? `${item.base}/${item.target}` : null);
            const pair = kind === 'dex'
                ? pairFull
                : (item.base && item.target ? `${shortenPairLeg(item.base)}/${shortenPairLeg(item.target)}` : null);
            rows.push({
                kind,
                name: typeof name === 'string' && name.trim() ? name.trim() : DASH,
                pair,
                pairFull,
                liquidityUsd: isNum(item.liquidityUsd) ? item.liquidityUsd : null,
                volume24Usd: isNum(item.volume24Usd) ? item.volume24Usd : null,
                priceUsd: isNum(item.priceUsd) ? item.priceUsd : null,
                txns24: isNum(item.txns24) ? item.txns24 : null,
                lastTradedAt: typeof item.lastTradedAt === 'string' && item.lastTradedAt.trim()
                    ? item.lastTradedAt
                    : null,
                url: isSafeUrl(item.url) ? item.url : null
            });
        }
        rows.sort((a, b) => compareValues(a.volume24Usd, b.volume24Usd, false) ||
            compareValues(a.liquidityUsd, b.liquidityUsd, false) ||
            compareValues(a.name, b.name, true));
        return rows;
    }

    return {
        ACTIVITY_FLAG_TRADES_PER_TRADER,
        ACTIVITY_FLAG_ORGANIC_PCT,
        activityFlags,
        issuerActivityRow,
        activityRows,
        shortenPairLeg,
        venueRows
    };
});
