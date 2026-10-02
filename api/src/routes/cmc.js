// GET /api/tokens/:mint/cmc — CoinMarketCap's market data for one token, fetched on demand when a
// reader opens the token's Markets block (card.js). The key (CMC_API_KEY in the clone's .env) stays
// on the server; answers are cached (lib/cmc.js) and a UTC day's credits are capped, so a busy page
// cannot exhaust the plan. A token CoinMarketCap does not list answers `listed: false`.

import { Hono } from 'hono';

import { logWarn } from '../lib/log.js';
import {
    INFO_TTL_MS, QUOTE_TTL_MS, cmcAnswer, creditBudget, infoEntry, quoteFigures, ttlCache
} from '../lib/cmc.js';

const BASE = 'https://pro-api.coinmarketcap.com';
/** A Solana mint: base58, 32–44 characters. Anything else is refused before any credit is spent. */
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** GET a CoinMarketCap endpoint; resolves with {status, body}. */
async function cmcGet(path, key) {
    const res = await fetch(`${BASE}${path}`, { headers: { 'X-CMC_PRO_API_KEY': key, accept: 'application/json' } });
    return { status: res.status, body: await res.json().catch(() => null) };
}

/**
 * The routes with their inputs injectable, so a test runs them without the network: `get(path)`
 * → {status, body}; `key` the API key (null: not configured); `now` the clock for the caches.
 */
export function createCmcRoutes({ key = process.env.CMC_API_KEY || null, get = (path) => cmcGet(path, key), now = () => Date.now(), budget = creditBudget(undefined, now) } = {}) {
    const routes = new Hono();
    const infoCache = ttlCache(INFO_TTL_MS, now);
    const quoteCache = ttlCache(QUOTE_TTL_MS, now);

    routes.get('/tokens/:mint/cmc', async (c) => {
        const mint = c.req.param('mint');
        if (!MINT_RE.test(mint)) return c.json({ error: { code: 'bad_mint', message: 'not a Solana mint address' } }, 400);
        if (!key) return c.json({ error: { code: 'cmc_not_configured', message: 'CoinMarketCap is not configured on this server' } }, 503);

        let entry = infoCache.get(mint);
        if (entry === undefined) {
            if (!budget.take(1)) return c.json({ error: { code: 'cmc_budget', message: 'today’s CoinMarketCap budget is spent; try tomorrow' } }, 503);
            const info = await get(`/v2/cryptocurrency/info?address=${encodeURIComponent(mint)}`);
            // 400 is CoinMarketCap's answer for an address it does not list: a fact worth caching.
            if (info.status !== 200 && info.status !== 400) {
                logWarn(`cmc: info for ${mint} answered ${info.status}: ${info.body?.status?.error_message ?? ''}`);
                return c.json({ error: { code: 'cmc_unavailable', message: `CoinMarketCap answered ${info.status}` } }, 502);
            }
            entry = info.status === 200 ? infoEntry(info.body) : null;
            infoCache.set(mint, entry);
        }
        if (entry === null) {
            c.header('Cache-Control', 'public, max-age=3600');
            return c.json(cmcAnswer({ mint, entry: null }));
        }

        let figures = quoteCache.get(String(entry.id));
        if (figures === undefined) {
            if (!budget.take(1)) return c.json({ error: { code: 'cmc_budget', message: 'today’s CoinMarketCap budget is spent; try tomorrow' } }, 503);
            const quote = await get(`/v2/cryptocurrency/quotes/latest?id=${entry.id}`);
            if (quote.status !== 200) {
                logWarn(`cmc: quote for ${entry.id} answered ${quote.status}: ${quote.body?.status?.error_message ?? ''}`);
                return c.json({ error: { code: 'cmc_unavailable', message: `CoinMarketCap answered ${quote.status}` } }, 502);
            }
            figures = quoteFigures(quote.body, entry.id);
            quoteCache.set(String(entry.id), figures);
        }
        c.header('Cache-Control', 'public, max-age=300');
        return c.json(cmcAnswer({ mint, entry, figures }));
    });

    return routes;
}

export default createCmcRoutes();
