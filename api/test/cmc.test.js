// Tests GET /api/tokens/:mint/cmc without the network: the route is built with an injected fetcher
// that serves real CoinMarketCap payloads saved in test/fixtures/cmc/ (AAPLx on 30 Sep 2026, and the
// 400 CoinMarketCap gives an address it does not list), an injected clock and credit budget.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Hono } from 'hono';

import { creditBudget, infoEntry, quoteFigures } from '../src/lib/cmc.js';
import { createCmcRoutes } from '../src/routes/cmc.js';

const fixture = (name) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'cmc', name), 'utf8'));
const INFO = fixture('info-aaplx.json');
const QUOTE = fixture('quote-aaplx.json');
const UNLISTED = fixture('info-unlisted.json');
const AAPLX = 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp';
const OTHER = 'So11111111111111111111111111111111111111112x';

function app({ key = 'test-key', budget = undefined, clock = { t: Date.parse('2026-09-30T12:00:00Z') } } = {}) {
    const calls = [];
    const get = async (path) => {
        calls.push(path);
        if (path.includes(`address=${AAPLX}`)) return { status: 200, body: INFO };
        if (path.includes('address=')) return { status: UNLISTED.httpStatus, body: UNLISTED.body };
        if (path.includes('quotes/latest?id=36994')) return { status: 200, body: QUOTE };
        return { status: 500, body: null };
    };
    const hono = new Hono();
    hono.route('/api', createCmcRoutes({ key, get, now: () => clock.t, ...(budget ? { budget } : {}) }));
    return { hono, calls, clock };
}

describe('CoinMarketCap payloads', () => {
    test('the info entry names the token and whether CoinMarketCap tags it a tokenized stock', () => {
        expect(infoEntry(INFO)).toMatchObject({ id: 36994, symbol: 'AAPLX', slug: 'apple-tokenized-stock-xstock' });
        expect(infoEntry(INFO).tags).toContain('tokenized-stock');
        expect(infoEntry(UNLISTED.body)).toBeNull();
    });

    test('the quote keeps CoinMarketCap’s own time and splits exchange from DEX volume; an empty field stays null', () => {
        const figures = quoteFigures(QUOTE, 36994);
        expect(figures.price).toBeGreaterThan(0);
        expect(figures.cexVolume24h + figures.dexVolume24h).toBeCloseTo(figures.volume24h, -2);
        expect(figures.lastUpdated).toMatch(/^2026-09-30T\d{2}:\d{2}:\d{2}\.000Z$/);
        expect(Number.isInteger(figures.marketPairs)).toBe(true);
        const noTvl = structuredClone(QUOTE);
        noTvl.data['36994'].quote.USD.price = null;
        expect(quoteFigures(noTvl, 36994).price).toBeNull();
        expect(quoteFigures({ data: {} }, 36994)).toBeNull();
    });
});

describe('GET /api/tokens/:mint/cmc', () => {
    test('answers a listed token with its figures and link, from two calls; the next five minutes cost nothing', async () => {
        const { hono, calls, clock } = app();
        const res = await hono.request(`/api/tokens/${AAPLX}/cmc`);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body).toMatchObject({ listed: true, id: 36994, symbol: 'AAPLX', tokenizedStock: true,
            url: 'https://coinmarketcap.com/currencies/apple-tokenized-stock-xstock/' });
        expect(body.volume24h).toBeGreaterThan(0);
        expect(calls).toHaveLength(2);
        clock.t += 4 * 60_000;
        await hono.request(`/api/tokens/${AAPLX}/cmc`);
        expect(calls).toHaveLength(2);
        clock.t += 2 * 60_000;
        await hono.request(`/api/tokens/${AAPLX}/cmc`);
        expect(calls).toHaveLength(3); // a fresh quote; the id lookup is still cached
        expect(calls[2]).toContain('quotes/latest');
    });

    test('an address CoinMarketCap does not list answers listed: false, and that answer is cached too', async () => {
        const { hono, calls } = app();
        const body = await (await hono.request(`/api/tokens/${OTHER}/cmc`)).json();
        expect(body).toEqual({ mint: OTHER, listed: false, source: 'CoinMarketCap' });
        await hono.request(`/api/tokens/${OTHER}/cmc`);
        expect(calls).toHaveLength(1);
    });

    test('refuses a non-mint before spending a credit, says when it is not configured, and stops at the daily budget', async () => {
        const { hono, calls } = app();
        expect((await hono.request('/api/tokens/not-a-mint!/cmc')).status).toBe(400);
        expect(calls).toHaveLength(0);
        expect((await app({ key: null }).hono.request(`/api/tokens/${AAPLX}/cmc`)).status).toBe(503);
        const tight = app({ budget: creditBudget(1) });
        const res = await tight.hono.request(`/api/tokens/${AAPLX}/cmc`);
        expect(res.status).toBe(503);
        expect((await res.json()).error.code).toBe('cmc_budget');
    });

    test('the credit budget resets each UTC day', () => {
        let t = Date.parse('2026-09-30T23:59:00Z');
        const budget = creditBudget(2, () => t);
        expect(budget.take()).toBe(true);
        expect(budget.take()).toBe(true);
        expect(budget.take()).toBe(false);
        t = Date.parse('2026-10-01T00:01:00Z');
        expect(budget.take()).toBe(true);
    });
});
