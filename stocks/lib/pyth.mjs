// PURE helpers for the Pyth Hermes reference-price join: turning a ticker into a Hermes equity
// feed symbol, indexing the public feed list, decoding Pyth's integer+exponent prices into
// numbers, and computing a token's premium over its reference. No I/O and no network, so the
// arithmetic and the matching are unit-tested headlessly (see ../pyth.test.js).

/**
 * Hermes names a US equity feed `Equity.US.<TICKER>/USD`. Matching is EXACT on that string —
 * no prefix, fuzzy or case-insensitive fallback — because a near-miss would silently price a
 * token against the wrong company. Shift truncates its base symbols (`TSL2L` → `TSL`), so those
 * legitimately find nothing and must be reported as unmatched rather than guessed at.
 */
export function equitySymbolForTicker(ticker) {
    if (typeof ticker !== 'string') return null;
    const trimmed = ticker.trim();
    if (trimmed === '') return null;
    return `Equity.US.${trimmed}/USD`;
}

/** Index a `/v2/price_feeds` array by `attributes.symbol`. First entry wins on a duplicate. */
export function indexFeedsBySymbol(feeds) {
    const index = new Map();
    if (!Array.isArray(feeds)) return index;
    for (const feed of feeds) {
        const symbol = feed?.attributes?.symbol;
        if (typeof symbol !== 'string' || symbol === '') continue;
        if (!index.has(symbol)) index.set(symbol, feed);
    }
    return index;
}

/**
 * The feed for a ticker, or null when Hermes has none. Accepts either the raw feed array or an
 * index from `indexFeedsBySymbol`, so a caller can build the index once for 441 lookups.
 */
export function findFeedForTicker(feeds, ticker) {
    const symbol = equitySymbolForTicker(ticker);
    if (symbol === null) return null;
    const index = feeds instanceof Map ? feeds : indexFeedsBySymbol(feeds);
    return index.get(symbol) ?? null;
}

/** The trimmed facts worth keeping off a matched feed: id and whether its market is open now. */
export function feedSummary(feed) {
    if (!feed || typeof feed !== 'object') return { feedId: null, marketOpen: null, displaySymbol: null, description: null };
    const isOpen = feed.market_hours?.is_open;
    return {
        feedId: typeof feed.id === 'string' ? feed.id : null,
        marketOpen: typeof isOpen === 'boolean' ? isOpen : null,
        displaySymbol: feed.attributes?.display_symbol ?? null,
        description: feed.attributes?.description ?? null
    };
}

/** A finite number or null — never a 0 conjured out of null/''/undefined by Number(). */
function finiteOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/**
 * Decode one Hermes `price` block: `{price:"<int string>", conf:"<int string>", expo, publish_time}`
 * where the real value is `int * 10**expo`. A missing component stays null rather than becoming 0,
 * so a token with no usable reference cannot be reported as costing nothing.
 */
export function decodePythPrice(block) {
    const expo = typeof block?.expo === 'number' && Number.isFinite(block.expo) ? block.expo : null;
    const rawPrice = finiteOrNull(block?.price);
    const rawConf = finiteOrNull(block?.conf);
    const scale = expo === null ? null : 10 ** expo;
    return {
        price: rawPrice === null || scale === null ? null : rawPrice * scale,
        conf: rawConf === null || scale === null ? null : rawConf * scale,
        expo,
        publishTime: finiteOrNull(block?.publish_time)
    };
}

/** Seconds between a unix-second publish time and `nowMs`. Null in, null out. */
export function ageSeconds(publishTime, nowMs = Date.now()) {
    if (typeof publishTime !== 'number' || !Number.isFinite(publishTime)) return null;
    return Math.round(nowMs / 1000 - publishTime);
}

/**
 * How far a token trades from its reference, in percent. Defined only when both sides are finite
 * POSITIVE numbers: a null or zero reference has no premium, and returning 0 there would read as
 * "trades exactly at the reference" — the opposite of "we do not know".
 */
export function premiumPct(tokenPrice, referencePrice) {
    const token = finiteOrNull(tokenPrice);
    const reference = finiteOrNull(referencePrice);
    if (token === null || reference === null) return null;
    if (token <= 0 || reference <= 0) return null;
    return (token / reference - 1) * 100;
}
