// CoinMarketCap as on-demand market data for one token: the pure part (payload shaping, caching,
// the daily credit budget), so it is testable without the network. The route
// (routes/cmc.js) fetches; the key never leaves the server. Every figure keeps CoinMarketCap's own
// `last_updated`, never our fetch time, and a field CoinMarketCap leaves empty stays null.

/** The mint → CoinMarketCap id lookup rarely changes: a day, including "not listed". */
export const INFO_TTL_MS = 24 * 3600_000;
/** Quotes are what a reader opened the card for: five minutes keeps the free plan's credits. */
export const QUOTE_TTL_MS = 5 * 60_000;
/**
 * Credits a UTC day may spend. The key's plan allows 15,000 a month (50 a minute); 450 a day leaves
 * a margin, and a day that runs out answers `cmc_budget` instead of silently failing.
 */
export const DAILY_CREDIT_BUDGET = 450;

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/**
 * The CoinMarketCap entry for a mint from /v2/cryptocurrency/info?address=…: `{id, name, symbol,
 * slug, tags}`, or null when the address is not listed (CoinMarketCap answers 400 for an unknown
 * address, which the route passes here as a payload with no data).
 */
export function infoEntry(payload) {
    const entries = payload?.data && typeof payload.data === 'object' ? Object.values(payload.data) : [];
    const entry = entries.find((row) => Number.isInteger(row?.id));
    if (!entry) return null;
    return {
        id: entry.id,
        name: str(entry.name),
        symbol: str(entry.symbol),
        slug: str(entry.slug),
        tags: Array.isArray(entry.tags) ? entry.tags.filter((tag) => typeof tag === 'string') : []
    };
}

/** One token's market figures from /v2/cryptocurrency/quotes/latest?id=…, in USD. */
export function quoteFigures(payload, id) {
    const row = payload?.data?.[id] ?? payload?.data?.[String(id)] ?? null;
    const usd = row?.quote?.USD ?? null;
    if (!row || !usd) return null;
    return {
        price: num(usd.price),
        volume24h: num(usd.volume_24h),
        cexVolume24h: num(usd.cex_volume_24h),
        dexVolume24h: num(usd.dex_volume_24h),
        volumeChange24hPct: num(usd.volume_change_24h),
        change1hPct: num(usd.percent_change_1h),
        change24hPct: num(usd.percent_change_24h),
        change7dPct: num(usd.percent_change_7d),
        change30dPct: num(usd.percent_change_30d),
        marketCap: num(usd.market_cap),
        fullyDilutedMarketCap: num(usd.fully_diluted_market_cap),
        circulatingSupply: num(row.circulating_supply),
        marketPairs: Number.isInteger(row.num_market_pairs) ? row.num_market_pairs : null,
        rank: Number.isInteger(row.cmc_rank) ? row.cmc_rank : null,
        // CoinMarketCap's own time for the quote; the entry's time when the quote carries none.
        lastUpdated: str(usd.last_updated) ?? str(row.last_updated)
    };
}

/** The answer the card renders: who CoinMarketCap says the token is, and its figures. */
export function cmcAnswer({ mint, entry, figures }) {
    if (entry === null) return { mint, listed: false, source: 'CoinMarketCap' };
    return {
        mint,
        listed: true,
        source: 'CoinMarketCap',
        id: entry.id,
        name: entry.name,
        symbol: entry.symbol,
        url: entry.slug ? `https://coinmarketcap.com/currencies/${entry.slug}/` : null,
        tokenizedStock: entry.tags.includes('tokenized-stock'),
        ...(figures ?? {})
    };
}

/** A small TTL cache keyed by string; `now` is injectable for tests. */
export function ttlCache(ttlMs, now = () => Date.now()) {
    const store = new Map();
    return {
        get(key) {
            const hit = store.get(key);
            if (!hit) return undefined;
            if (now() - hit.at > ttlMs) {
                store.delete(key);
                return undefined;
            }
            return hit.value;
        },
        set(key, value) {
            store.set(key, { at: now(), value });
        }
    };
}

/** Credits spent per UTC day; `take(n)` answers false once the day's budget would be exceeded. */
export function creditBudget(limit = DAILY_CREDIT_BUDGET, now = () => Date.now()) {
    let day = null;
    let used = 0;
    return {
        take(n = 1) {
            const today = new Date(now()).toISOString().slice(0, 10);
            if (today !== day) {
                day = today;
                used = 0;
            }
            if (used + n > limit) return false;
            used += n;
            return true;
        },
        used: () => used
    };
}
