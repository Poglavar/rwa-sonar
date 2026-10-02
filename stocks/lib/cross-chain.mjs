// Every issuer's tokens of one stock across all chains, from CoinMarketCap's "Tokenized Stock"
// category (stocks/fetch-cmc-tokenized.mjs): which underlying each listed token tracks, the total
// held across chains, and each of our tokens' share of it. Pure. A wrapped copy (it would count the
// same shares twice), a dead listing and a listing with no supply figure are left out of the total;
// the last are counted, so the page can say the total is a floor.

/** A listing whose last update is older than this is dead (FTX, Bittrex, Mirrored). */
export const DEAD_AFTER_DAYS = 30;

/**
 * Issuer families and how their CoinMarketCap symbols carry the underlying ticker. Checked on the
 * category listing of 2026-09-30: AAPLX / AAPLon / AAPLB / AAPL.D, Backpack and Robinhood as the
 * bare ticker. First match wins.
 */
const FAMILIES = [
    { id: 'xstocks', name: /\(xStock\)/i, ticker: (s) => s.replace(/X$/i, '') },
    { id: 'ondo', name: /\(Ondo\)/i, ticker: (s) => s.replace(/on$/, '') },
    { id: 'bstocks', name: /bStocks/i, ticker: (s) => s.replace(/B$/, '') },
    { id: 'dinari', name: /\(Dinari\)/i, ticker: (s) => s.replace(/\.D$/i, '') },
    { id: 'other', name: /./, ticker: (s) => s }
];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The underlying ticker a listing tracks, or null when it is not one of `knownTickers`. */
export function tickerOf(coin, knownTickers) {
    const name = String(coin?.name ?? '');
    const symbol = String(coin?.symbol ?? '');
    // A wrapped copy counts the same shares twice; a "(Derivatives)" listing is a price, not a token.
    if (!symbol || /^wrapped\b/i.test(name) || /\(derivatives\)/i.test(name)) return null;
    const family = FAMILIES.find((f) => f.name.test(name));
    const ticker = family.ticker(symbol).toUpperCase();
    return knownTickers.has(ticker) ? ticker : null;
}

/** Live, with a positive circulating supply, and not a wrapped copy. */
function counted(coin, asOfMs) {
    const updated = Date.parse(coin?.last_updated ?? '');
    return Number.isFinite(updated) && asOfMs - updated <= DEAD_AFTER_DAYS * 86400000 && (num(coin?.circulating_supply) ?? 0) > 0;
}

/**
 * Per underlying ticker: `{totalUnits, listings:[{id, symbol, name, platform, units}], withoutSupply}`
 * for every ticker in `knownTickers` that CoinMarketCap lists at least once with a supply.
 */
export function crossChainTotals(coins, knownTickers, asOf) {
    const asOfMs = Date.parse(asOf);
    const out = new Map();
    for (const coin of Array.isArray(coins) ? coins : []) {
        const ticker = tickerOf(coin, knownTickers);
        if (ticker === null) continue;
        if (!out.has(ticker)) out.set(ticker, { totalUnits: 0, listings: [], withoutSupply: 0 });
        const entry = out.get(ticker);
        if (!counted(coin, asOfMs)) {
            // A live listing with no supply figure makes the total a floor; a dead one does not.
            if (Number.isFinite(Date.parse(coin?.last_updated ?? '')) && asOfMs - Date.parse(coin.last_updated) <= DEAD_AFTER_DAYS * 86400000) entry.withoutSupply += 1;
            continue;
        }
        const units = num(coin.circulating_supply);
        entry.totalUnits += units;
        entry.listings.push({ id: coin.id, symbol: coin.symbol, name: coin.name, platform: coin.platform?.name ?? null, units });
    }
    for (const [ticker, entry] of out) {
        if (entry.listings.length === 0) out.delete(ticker);
        else entry.listings.sort((a, b) => b.units - a.units);
    }
    return out;
}

/**
 * One of our tokens' place in its ticker's cross-chain total: its own listing (matched by symbol,
 * case-insensitive, only when exactly one counted listing has it) and its share, or just the total
 * when CoinMarketCap does not list it.
 */
export function crossChainFor(symbol, ticker, totals) {
    const entry = totals.get(ticker);
    if (!entry) return null;
    const own = entry.listings.filter((l) => String(l.symbol).toLowerCase() === String(symbol ?? '').toLowerCase());
    const listing = own.length === 1 ? own[0] : null;
    return {
        ticker,
        totalUnits: entry.totalUnits,
        listings: entry.listings.length,
        withoutSupply: entry.withoutSupply,
        units: listing?.units ?? null,
        sharePct: listing ? (listing.units / entry.totalUnits) * 100 : null
    };
}
