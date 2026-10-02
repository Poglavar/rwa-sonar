// Unit tests for stocks/lib/pyth-onchain.mjs — reading Pyth prices straight off Solana, keylessly:
// the push-oracle account address for a feed and shard, the decoded price with its confidence and
// Pyth's own publish time, which tokenized-stock feed belongs to which token, and the comparisons a
// card draws (token vs stock, premium over Pyth) only when their instants allow it. Fixtures are
// real: fixtures/pyth-onchain/accounts.sample.json is one getMultipleAccounts read of the Clock
// sysvar and ten push-oracle PDAs (2026-09-25), crypto-feeds.sample.json verbatim entries of the
// keyless Hermes crypto feed list, and fixtures/lending/accounts.sample.json the account Loopscale reads.

import { readFileSync } from 'node:fs';

import {
    PYTH_PUSH_ORACLE_PROGRAM, PYTH_SHARDS, buildPythOnchain, feedPageUrl, freshestReading, indexTokenFeeds,
    planAccountReads, premiumOverPyth, priceFeedAddress, readingFrom, tokenFeedFor, tokenStockGap
} from './lib/pyth-onchain.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const FIX = read('./fixtures/pyth-onchain/accounts.sample.json');
const CRYPTO = read('./fixtures/pyth-onchain/crypto-feeds.sample.json').body;
const LENDING = read('./fixtures/lending/accounts.sample.json').accounts;
const CLOCK = 'SysvarC1ock11111111111111111111111111111111';
const ID = Object.fromEntries(FIX.feeds.map((f) => [f.symbol, f.id]));
const accountFor = (symbol, shard) => FIX.feeds.find((f) => f.symbol === symbol && f.shard === shard).address;
const clockUnix = Number(Buffer.from(FIX.accounts[CLOCK].data, 'base64').readBigInt64LE(32));

describe('push-oracle account addresses', () => {
    test('shard 0 of Equity.US.SPY/USD is the very account Loopscale prices SPYx from; shard 1 is another', () => {
        expect(priceFeedAddress(ID['Equity.US.SPY/USD'], 0)).toBe('9owhtgrdLiUMAH9JKxYFt5pUY4Luy4EzzLhdcWPVuDyy');
        expect(priceFeedAddress(ID['Equity.US.SPY/USD'], 1)).toBe('CRDaGwcVnKdRNRtx6fjHtvrBgKM5U55AhbqBWhtPMDA');
        expect(PYTH_PUSH_ORACLE_PROGRAM).toBe('pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT');
        expect(PYTH_SHARDS).toEqual([0, 1]);
    });

    test('rejects a feed id that is not 32 bytes of hex, and a shard outside u16', () => {
        expect(() => priceFeedAddress('abc', 0)).toThrow(/feed id/);
        expect(() => priceFeedAddress(ID['Equity.US.SPY/USD'], 70000)).toThrow(/shard/);
    });
});

describe('decoding one account', () => {
    test('a live shard-1 equity account: price, confidence and Pyth\'s own publish time', () => {
        const r = readingFrom(FIX.accounts[accountFor('Equity.US.AAPL/USD', 1)], ID['Equity.US.AAPL/USD']);
        expect(r).toMatchObject({ exists: true, feedMismatch: false, verification: 'full', expo: -5 });
        expect(r.price).toBeGreaterThan(100);
        expect(r.conf).toBeGreaterThan(0);
        expect(r.conf).toBeLessThan(r.price / 100);
        expect(r.publishedAt).toBe(new Date(r.publishTime * 1000).toISOString().replace('.000Z', 'Z'));
        // Read seconds after it was published: the shard-1 accounts were being updated at read time.
        expect(clockUnix - r.publishTime).toBeLessThan(600);
    });

    test('the Loopscale TSLA account decodes with its confidence: 365.275 ± 0.1991, last published 2026-09-11 23:59:59', () => {
        const r = readingFrom(LENDING.E8WFH8brgP58arcuW2wwsPHiomYrSvrgWTsRLZLAEZUQ, '16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1');
        expect(r.price).toBeCloseTo(365.275, 3);
        expect(r.conf).toBeCloseTo(0.1991, 4);
        expect(r.publishedAt).toBe('2026-09-11T23:59:59Z');
    });

    test('a missing account stays missing, and an account for another feed is never read as this one', () => {
        expect(readingFrom(null, ID['Equity.US.CRCL/USD'])).toEqual({ exists: false });
        const wrong = readingFrom(FIX.accounts[accountFor('Equity.US.AAPL/USD', 1)], ID['Equity.US.SPY/USD']);
        expect(wrong).toMatchObject({ exists: true, feedMismatch: true, price: null, publishTime: null });
        // Not a PriceUpdateV2 at all (a Kamino account in the lending fixture).
        expect(readingFrom(LENDING.An6n6M3jjkCuDrU5JSLnhrvaLjDfcVDvJBVwFoi7eArt, ID['Equity.US.SPY/USD'])).toMatchObject({ exists: true, price: null });
    });

    test('the freshest shard wins: shard 1 for the stock, shard 0 (the only one) for the xStock token', () => {
        const readings = (symbol) => [0, 1].map((shard) => ({ shard, address: accountFor(symbol, shard), ...readingFrom(FIX.accounts[accountFor(symbol, shard)], ID[symbol]) }));
        expect(freshestReading(readings('Equity.US.AAPL/USD')).shard).toBe(1);
        expect(freshestReading(readings('Crypto.AAPLX/USD')).shard).toBe(0);
        expect(freshestReading(readings('Crypto.AAPLON/USD'))).toBeNull();
    });
});

describe('which tokenized-stock feed belongs to a token', () => {
    const index = indexTokenFeeds(CRYPTO);

    test('exact symbol AND the issuer named in the feed description', () => {
        expect(tokenFeedFor({ symbol: 'AAPLx', issuer: 'xstocks-backed' }, index)?.attributes.symbol).toBe('Crypto.AAPLX/USD');
        expect(tokenFeedFor({ symbol: 'AAPLon', issuer: 'ondo-global-markets' }, index)?.attributes.symbol).toBe('Crypto.AAPLON/USD');
        expect(tokenFeedFor({ symbol: 'SPCXx', issuer: 'xstocks-backed' }, index)?.id).toBe(CRYPTO.find((f) => f.attributes.symbol === 'Crypto.SPCXX/USD').id);
    });

    test('a crypto coin whose ticker collides with a stock token is not that token\'s feed', () => {
        expect(tokenFeedFor({ symbol: 'AMC', issuer: 'backpack-securities' }, index)).toBeNull();
        expect(tokenFeedFor({ symbol: 'GMx', issuer: 'xstocks-backed' }, index)).toBeNull();
        expect(tokenFeedFor({ symbol: 'LIon', issuer: 'ondo-global-markets' }, index)).toBeNull();
        expect(tokenFeedFor({ symbol: 'AAPLx', issuer: 'ondo-global-markets' }, index)).toBeNull();
    });

    test('links a feed to its public Pyth page, the slash encoded', () => {
        expect(feedPageUrl('Equity.US.AAPL/USD')).toBe('https://app.pyth.com/explore/Equity.US.AAPL%2FUSD');
        expect(feedPageUrl(null)).toBeNull();
    });
});

describe('comparisons drawn only when their instants allow it', () => {
    const stock = { price: 100, publishTime: 1_000_000 };

    test('token vs stock: the 24/7 token price against the stock\'s latest Pyth price', () => {
        const weekend = tokenStockGap({ price: 102, publishTime: 1_000_000 + 2 * 86400 }, stock);
        expect(weekend.comparable).toBe(true);
        expect(weekend.pct).toBeCloseTo(2, 6);
        expect(weekend.apartSeconds).toBe(2 * 86400);
    });

    test('a token price older than the stock\'s is not a gap, it is a stale reading', () => {
        const stale = tokenStockGap({ price: 90, publishTime: 1_000_000 - 3 * 86400 }, stock);
        expect(stale).toMatchObject({ comparable: false, pct: null, reason: 'token-older', apartSeconds: -3 * 86400 });
        expect(tokenStockGap(null, stock)).toBeNull();
        expect(tokenStockGap({ price: null, publishTime: 1 }, stock)).toBeNull();
    });

    test('premium over the on-chain Pyth price only when the Jupiter price and the Pyth read are within an hour', () => {
        const readAt = '2026-09-25T00:00:00Z';
        expect(premiumOverPyth(101, '2026-09-24T23:30:00Z', { price: 100 }, readAt)).toMatchObject({ comparable: true });
        expect(premiumOverPyth(101, '2026-09-24T23:30:00Z', { price: 100 }, readAt).pct).toBeCloseTo(1, 6);
        expect(premiumOverPyth(101, '2026-09-20T10:28:13Z', { price: 100 }, readAt)).toMatchObject({ comparable: false, pct: null, reason: 'read-apart' });
        expect(premiumOverPyth(null, '2026-09-24T23:30:00Z', { price: 100 }, readAt)).toBeNull();
    });
});

describe('one bounded read and the file it writes', () => {
    const feeds = [
        { id: ID['Equity.US.AAPL/USD'], symbol: 'Equity.US.AAPL/USD', kind: 'stock' },
        { id: ID['Crypto.AAPLX/USD'], symbol: 'Crypto.AAPLX/USD', kind: 'token' },
        { id: ID['Crypto.AAPLON/USD'], symbol: 'Crypto.AAPLON/USD', kind: 'token' }
    ];

    test('plans the Clock plus every feed on both shards, in requests of at most 100, and refuses to exceed its cap', () => {
        const plan = planAccountReads(feeds, { maxRequests: 1 });
        expect(plan.requests).toHaveLength(1);
        expect(plan.requests[0][0]).toBe(CLOCK);
        expect(plan.requests[0]).toHaveLength(1 + feeds.length * 2);
        const many = Array.from({ length: 120 }, (_, i) => ({ id: i.toString(16).padStart(64, '0'), symbol: `X${i}`, kind: 'stock' }));
        expect(planAccountReads(many, { maxRequests: 3 }).requests.map((r) => r.length)).toEqual([100, 100, 41]);
        expect(() => planAccountReads(many, { maxRequests: 2 })).toThrow(/cap/);
    });

    test('the default cap fits the full catalogue (about 790 feeds on the server, 25 Sep 2026)', () => {
        const catalogue = Array.from({ length: 790 }, (_, i) => ({ id: i.toString(16).padStart(64, '0'), symbol: `X${i}`, kind: 'stock' }));
        expect(planAccountReads(catalogue).requests).toHaveLength(16);
        const runaway = Array.from({ length: 1700 }, (_, i) => ({ id: i.toString(16).padStart(64, '0'), symbol: `X${i}`, kind: 'stock' }));
        expect(() => planAccountReads(runaway)).toThrow(/cap of 32/);
    });

    test('writes the chain clock as readAt and each account with its own publish time', () => {
        const plan = planAccountReads(feeds, { maxRequests: 1 });
        const out = buildPythOnchain({
            feeds, plan, accounts: plan.requests.flat().map((address) => FIX.accounts[address] ?? null),
            slots: [FIX.slot], tokens: [{ mint: 'M', symbol: 'AAPLx', stockFeedId: feeds[0].id, tokenFeedId: feeds[1].id }], inputs: {}
        });
        expect(out.readAt).toBe(new Date(clockUnix * 1000).toISOString().replace('.000Z', 'Z'));
        expect(out.readSlot).toBe(FIX.slot);
        expect(out.counts).toMatchObject({ feeds: 3, accountsRead: 6, accountsFound: 3, feedsWithPrice: 2 });
        const aapl = out.feeds.find((f) => f.symbol === 'Equity.US.AAPL/USD');
        expect(aapl.accounts.map((a) => [a.shard, a.exists])).toEqual([[0, true], [1, true]]);
        expect(aapl.accounts[1].publishTime).toBeGreaterThan(aapl.accounts[0].publishTime);
        expect(out.feeds.find((f) => f.symbol === 'Crypto.AAPLON/USD').accounts.every((a) => a.exists === false)).toBe(true);
    });

    test('refuses a read whose Clock sysvar is missing: no chain time, no file', () => {
        const plan = planAccountReads(feeds, { maxRequests: 1 });
        expect(() => buildPythOnchain({ feeds, plan, accounts: plan.requests.flat().map(() => null), slots: [1], tokens: [], inputs: {} })).toThrow(/Clock/);
    });
});

describe('wiring into the server refresh', () => {
    const script = readFileSync(new URL('./refresh-on-server.sh', import.meta.url), 'utf8');
    const gitignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');

    test('runs as a soft step after the reference prices it reads and before the cards are built', () => {
        const at = (needle) => script.indexOf(needle);
        expect(at('soft "pyth on-chain" node stocks/fetch-pyth-onchain.mjs --run')).toBeGreaterThan(at('node stocks/fetch-reference-prices.mjs --run'));
        expect(at('soft "pyth on-chain"')).toBeLessThan(at('--phase=surfaces'));
    });

    test('its output is runtime state, never committed', () => {
        expect(gitignore.split('\n')).toContain('/stocks/data/pyth-onchain.json');
    });
});
