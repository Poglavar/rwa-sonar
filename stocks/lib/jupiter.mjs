// Enumerates tokenized stocks from the Jupiter Tokens API v2 search endpoint. There is no
// authoritative "list all tokens with tag X" call (the tag endpoint rejects "stocks"), so the
// universe is the union of ~120 issuer/ticker queries, filtered down to records that actually
// carry a stock tag. Also trims each fat token record to the fields the pipeline uses.

import { fetchJson, logWarn, sleep } from './io.mjs';
import { hasStockTag } from './classify.mjs';

export const SEARCH_ENDPOINT = 'https://lite-api.jup.ag/tokens/v2/search';

// lite-api.jup.ag allows roughly 60 requests/minute and answers 429 above that, so pace
// above one second per call and still back off when it pushes back.
export const DEFAULT_PACE_MS = 1100;
export const BACKOFF_MS = [2000, 5000, 15000];

/** Issuer / product / instrument words. */
export const ISSUER_QUERIES = [
    'xStock', 'xStocks', 'Ondo', 'Ondo Tokenized', 'ondo', 'Backpack', 'Backpack Securities',
    'PreStocks', 'Tessera', 'Shift', 'Remora', 'Superstate', 'Dinari', 'dShares', 'Ventuals',
    'Sunrise', 'tokenized stock', 'stock', 'equity', 'ETF', 'iShares', 'Vanguard', 'SPDR',
    'Invesco', 'T-', '2x Long', '2x Short', '3x Long', '3x Short'
];

/** Well-known US tickers / company names, to catch issuers that carry no issuer tag word. */
export const TICKER_QUERIES = [
    'Apple', 'Microsoft', 'Nvidia', 'Tesla', 'Amazon', 'Alphabet', 'Meta', 'Broadcom', 'AMD',
    'Intel', 'Oracle', 'Salesforce', 'Netflix', 'Coinbase', 'Robinhood', 'Palantir', 'Circle',
    'Strategy', 'MicroStrategy', 'Uber', 'Walmart', 'Visa', 'Mastercard', 'JPMorgan', 'Goldman',
    'BlackRock', 'Berkshire', 'Eli Lilly', 'UnitedHealth', 'Pfizer', 'Merck', 'Exxon', 'Chevron',
    'Boeing', 'Lockheed', 'Disney', 'Nike', 'McDonald', 'Starbucks', 'GameStop', 'AMC', 'Reddit',
    'Marathon', 'Riot', 'Galaxy', 'Ford', 'GM', 'Toyota', 'Sony', 'Alibaba', 'Baidu', 'TSMC',
    'ASML', 'Novo', 'Shopify', 'PayPal', 'Block', 'SpaceX', 'OpenAI', 'Anthropic', 'Qualcomm',
    'Cisco', 'IBM', 'Adobe', 'Micron', 'Applied Materials', 'Arm', 'Dell', 'Snowflake',
    'CrowdStrike', 'Costco', 'Home Depot', 'Target', 'Delta', 'Airbnb', 'Booking', 'Anduril',
    'Stripe', 'Kalshi', 'Figma', 'Gold', 'Silver', 'Oil', 'Treasury', 'Bond', 'S&P', 'Nasdaq',
    'Russell', 'Dow'
];

export const QUERIES = [...ISSUER_QUERIES, ...TICKER_QUERIES];

export function searchUrl(query, limit = 100) {
    return `${SEARCH_ENDPOINT}?query=${encodeURIComponent(query)}&limit=${limit}`;
}

/**
 * One search call, retrying a 429/5xx up the backoff ladder. Returns the records plus the HTTP
 * status; a persistent HTTP error or a non-array payload is reported (never thrown) so the
 * caller can log it, carry on, and pick the query up again on the next resumed run.
 */
export async function searchTokens(query, { limit = 100, timeoutMs = 60000 } = {}) {
    const url = searchUrl(query, limit);
    let res = await fetchJson(url, { timeoutMs, headers: { accept: 'application/json' } });
    for (let attempt = 0; attempt < BACKOFF_MS.length && (res.status === 429 || res.status >= 500); attempt += 1) {
        const wait = BACKOFF_MS[attempt];
        logWarn(`Jupiter HTTP ${res.status} on "${query}"; backing off ${wait} ms (attempt ${attempt + 1}/${BACKOFF_MS.length})`);
        await sleep(wait);
        res = await fetchJson(url, { timeoutMs, headers: { accept: 'application/json' } });
    }
    if (!res.ok) {
        return { url, status: res.status, tokens: [], error: `HTTP ${res.status}: ${res.bodyPreview}` };
    }
    if (!Array.isArray(res.json)) {
        return {
            url,
            status: res.status,
            tokens: [],
            error: `expected an array, got ${res.parseError ? `unparseable body (${res.parseError})` : typeof res.json}`
        };
    }
    return { url, status: res.status, tokens: res.json, error: null };
}

/** Keep only equity-tagged records (a query for "Apple" also returns memecoins). */
export function filterStockTokens(tokens) {
    return tokens.filter((token) => token && typeof token.id === 'string' && hasStockTag(token.tags));
}

function pickStats24h(stats) {
    if (!stats || typeof stats !== 'object') return null;
    return {
        buyVolume: stats.buyVolume ?? null,
        sellVolume: stats.sellVolume ?? null,
        buyOrganicVolume: stats.buyOrganicVolume ?? null,
        sellOrganicVolume: stats.sellOrganicVolume ?? null,
        // The trade COUNTS, kept because MODEL.md §11.2 grades trades-per-trader on them; without
        // them the wash-trading tell has no numerator.
        numBuys: stats.numBuys ?? null,
        numSells: stats.numSells ?? null,
        numOrganicBuyers: stats.numOrganicBuyers ?? null,
        numTraders: stats.numTraders ?? null,
        priceChange: stats.priceChange ?? null
    };
}

/**
 * Trim a Jupiter record to the committed shape. Drops `icon` and the 5m/1h/6h stat blocks,
 * which are the bulk of the payload and useless for grading. Field order is fixed so the
 * output file stays diffable.
 */
export function trimJupiterToken(token) {
    return {
        mint: token.id,
        name: token.name ?? null,
        symbol: token.symbol ?? null,
        decimals: token.decimals ?? null,
        tokenProgram: token.tokenProgram ?? null,
        mintAuthority: token.mintAuthority ?? null,
        freezeAuthority: token.freezeAuthority ?? null,
        dev: token.dev ?? null,
        circSupply: token.circSupply ?? null,
        totalSupply: token.totalSupply ?? null,
        holderCount: token.holderCount ?? null,
        usdPrice: token.usdPrice ?? null,
        mcap: token.mcap ?? null,
        fdv: token.fdv ?? null,
        liquidity: token.liquidity ?? null,
        stats24h: pickStats24h(token.stats24h),
        audit: token.audit ?? null,
        organicScore: token.organicScore ?? null,
        organicScoreLabel: token.organicScoreLabel ?? null,
        isVerified: token.isVerified ?? null,
        tags: Array.isArray(token.tags) ? [...token.tags] : [],
        firstPool: token.firstPool ? { id: token.firstPool.id ?? null, createdAt: token.firstPool.createdAt ?? null } : null,
        createdAt: token.createdAt ?? null,
        website: token.website ?? null
    };
}
