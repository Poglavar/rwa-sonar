// Unit tests for lib/solana-depth.mjs: the USD sale that moves a stock token's Solana price 5 % and
// 10 %, from a ladder of Jupiter keyless quotes. The SPYx quote shape and numbers are a real
// lite-api.jup.ag/swap/v1/quote answer (2026-09-24 19:18 UTC: 325 SPYx → $250,478, impact 0.165 %),
// the SPYx price record a real price/v3 answer; the ladders are synthetic so the interpolation can
// be checked by hand.

const {
    LADDER_USD, rawAmountForUsd, ladderPrice, stepFromQuote, ladderDone, saleForImpact, sessionKind, buildSample,
    mergeSamples, sampledRecently, lenderMints, KEEP_DAYS
} = require('./lib/solana-depth.mjs');
const { parseSchedule } = require('./lib/market-hours.mjs');
const fs = require('fs');
const path = require('path');

const US = parseSchedule('America/New_York;0930-1600,0930-1600,0930-1600,0930-1600,0930-1600,C,C;0907/C,1126/C,1127/0930-1300,1224/0930-1300,1225/C,0101/C,0118/C,0215/C,0326/C,0531/C,0618/C,0705/C');

const SPYX_PRICE = { usdPrice: 767.4580572315199, decimals: 8, scaledUiConfig: { multiplier: 1.0039, usdPricePrescaled: 770.45 } };

describe('sizing', () => {
    test('the ladder is priced pre-scaled (the quote takes raw units of a scaled-UI mint)', () => {
        expect(ladderPrice(SPYX_PRICE)).toEqual({ priceUsd: 770.45, decimals: 8 });
        expect(ladderPrice({ usdPrice: 10, decimals: 6 })).toEqual({ priceUsd: 10, decimals: 6 });
        expect(ladderPrice({ usdPrice: 0, decimals: 6 })).toBeNull();
        expect(ladderPrice({ usdPrice: 10 })).toBeNull();
    });

    test('rawAmountForUsd: $250k of SPYx at 770.45 is 324.49 SPYx in base units', () => {
        expect(rawAmountForUsd(250000, { priceUsd: 770.45, decimals: 8 })).toBe(String(Math.floor((250000 / 770.45) * 1e8)));
        expect(rawAmountForUsd(250000, { priceUsd: 770.45, decimals: 8 })).toMatch(/^32448\d{6}$/);
        expect(rawAmountForUsd(0, { priceUsd: 1, decimals: 6 })).toBeNull();
        expect(rawAmountForUsd(100, { priceUsd: null, decimals: 6 })).toBeNull();
        expect(rawAmountForUsd(100, { priceUsd: 1, decimals: 40 })).toBeNull();
    });
});

describe('quotes and thresholds', () => {
    test('stepFromQuote reads Jupiter\'s fractional impact as percent', () => {
        const step = stepFromQuote(250000, { outAmount: '250477817776', priceImpactPct: '0.0016481785447990165914276803', contextSlot: 450121239 });
        expect(step.impactPct).toBeCloseTo(0.1648, 4);
        expect(step.outUsd).toBeCloseTo(250477.82, 2);
        expect(step.contextSlot).toBe(450121239);
        expect(stepFromQuote(1, { error: 'no route' })).toBeNull();
    });

    const ladder = (impacts) => impacts.map((impactPct, i) => ({ usd: LADDER_USD[i], impactPct, noRoute: false }));

    test('interpolates log-linearly between the two sizes that bracket the impact', () => {
        // 1 % at $250k, 20 % at $1M: 5 % is 4/19 of the way in log size.
        const steps = ladder([0, 0, 0, 0.1, 1, 20]);
        const at5 = saleForImpact(steps, 5);
        expect(at5.bound).toBe('interpolated');
        expect(at5.usd).toBe(Math.round(Math.exp(Math.log(250000) + (4 / 19) * (Math.log(1000000) - Math.log(250000)))));
        expect(saleForImpact(steps, 10).usd).toBeGreaterThan(at5.usd);
    });

    test('bounds: below the smallest size, above the largest, and no route', () => {
        expect(saleForImpact(ladder([20.7]), 5)).toEqual({ usd: 1000, bound: 'below' });
        expect(saleForImpact(ladder([0, 0, 0.1, 0.2, 0.3, 1, 3]), 5)).toEqual({ usd: 2500000, bound: 'above' });
        expect(saleForImpact([{ usd: 1000, impactPct: 1, noRoute: false }, { usd: 5000, impactPct: null, noRoute: true }], 5)).toEqual({ usd: 5000, bound: 'no-route' });
        expect(saleForImpact([], 5)).toBeNull();
    });

    test('the ladder stops at 10 % or at the first size with no route', () => {
        expect(ladderDone(ladder([1, 4]))).toBe(false);
        expect(ladderDone(ladder([1, 12]))).toBe(true);
        expect(ladderDone([{ usd: 1000, impactPct: null, noRoute: true }])).toBe(true);
        expect(ladderDone([])).toBe(false);
    });
});

describe('samples', () => {
    test('sessionKind: open, weeknight, weekend', () => {
        expect(sessionKind(US, Date.parse('2026-09-24T19:18:00Z'))).toBe('open');
        expect(sessionKind(US, Date.parse('2026-09-24T03:00:00Z'))).toBe('closed');
        expect(sessionKind(US, Date.parse('2026-09-19T15:00:00Z'))).toBe('weekend');
        expect(sessionKind(US, Date.parse('2026-09-07T15:00:00Z'))).toBe('closed');
        expect(sessionKind(null, Date.parse('2026-09-19T15:00:00Z'))).toBe('unknown');
    });

    test('buildSample records both thresholds and the ladder it came from', () => {
        const sample = buildSample({ at: '2026-09-24T19:18:00Z', session: 'open', mint: 'M', symbol: 'SPYx', price: { priceUsd: 770.45 },
            steps: [{ usd: 1000000, impactPct: 1.3, noRoute: false }, { usd: 2500000, impactPct: 23.8, noRoute: false }] });
        expect(sample.at5Pct.bound).toBe('interpolated');
        expect(sample.at10Pct.bound).toBe('interpolated');
        expect(sample.steps).toEqual([{ usd: 1000000, impactPct: 1.3, noRoute: false }, { usd: 2500000, impactPct: 23.8, noRoute: false }]);
    });

    test('a token with no Jupiter price is stored as having no Solana market, not skipped', () => {
        const sample = buildSample({ at: '2026-09-24T19:55:49Z', session: 'open', mint: 'GLXY', symbol: 'GLXY', price: null, steps: [] });
        expect(sample).toEqual({ at: '2026-09-24T19:55:49Z', session: 'open', mint: 'GLXY', symbol: 'GLXY', priceUsd: null, noPrice: true, at5Pct: null, at10Pct: null, steps: [] });
    });

    test('mergeSamples drops samples older than KEEP_DAYS and de-duplicates a re-run', () => {
        const now = Date.parse('2026-09-24T20:00:00Z');
        const old = { at: new Date(now - (KEEP_DAYS + 1) * 86400000).toISOString(), mint: 'M' };
        const a = { at: '2026-09-24T19:18:00Z', mint: 'M', v: 1 };
        const a2 = { at: '2026-09-24T19:18:00Z', mint: 'M', v: 2 };
        expect(mergeSamples([old, a], [a2], now)).toEqual([a2]);
    });

    test('sampledRecently lets a killed run resume where it stopped', () => {
        const now = Date.parse('2026-09-24T20:00:00Z');
        const samples = [{ at: '2026-09-24T18:00:00Z', mint: 'M', session: 'open' }];
        expect(sampledRecently(samples, 'M', 'open', now, 5)).toBe(true);
        expect(sampledRecently(samples, 'M', 'closed', now, 5)).toBe(false);
        expect(sampledRecently(samples, 'M', 'open', now, 1)).toBe(false);
    });

    test('lenderMints: every token a lending market takes, research first, then the DeFi collector', () => {
        const research = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'protocol-market-research.json'), 'utf8'));
        const mints = lenderMints(research.oraclePricing, { items: [{ mint: 'EXTRA', symbol: 'X', integrations: [{ category: 'lending' }] }, { mint: 'DEX', integrations: [{ category: 'dex' }] }] });
        expect(mints.find((m) => m.symbol === 'SPYx')).toBeTruthy();
        expect(mints.find((m) => m.symbol === 'SECZ')).toBeTruthy();
        expect(mints.at(-1)).toEqual({ mint: 'EXTRA', symbol: 'X' });
        expect(mints.some((m) => m.mint === 'DEX')).toBe(false);
        expect(new Set(mints.map((m) => m.mint)).size).toBe(mints.length);
    });
});

describe('refinement', () => {
    const { refinementSizes, withSteps } = require('./lib/solana-depth.mjs');
    const step = (usd, impactPct) => ({ usd, impactPct, noRoute: false });

    test('one midpoint per bracket, shared when both thresholds fall in the same one', () => {
        // STRCx 2026-09-24 19:35 UTC: 2.2 % at $100k, 100 % at $250k — both thresholds in one bracket.
        expect(refinementSizes([step(1000, 0.03), step(100000, 2.195), step(250000, 100)])).toEqual([158114]);
        // SPYx: 1.08 % at $1M, 10.14 % at $2.5M — likewise.
        expect(refinementSizes([step(1000000, 1.077), step(2500000, 10.136)])).toEqual([1581139]);
        // Different brackets: 5 % between $1k and $5k, 10 % between $5k and $25k.
        expect(refinementSizes([step(1000, 4.455), step(5000, 7.952), step(25000, 74.183)])).toEqual([2236, 11180]);
    });

    test('a bracket that ends in a size with no route is split too (HOODx 2026-09-24: 8.3 % at $1M, no route at $2.5M)', () => {
        expect(refinementSizes([step(1000000, 8.344), { usd: 2500000, impactPct: null, noRoute: true }])).toEqual([1581139]);
    });

    test('no refinement for a bound, and none for a size already quoted', () => {
        expect(refinementSizes([step(1000, 20)])).toEqual([]);
        expect(refinementSizes([step(1000, 0), step(2500000, 3)])).toEqual([]);
        expect(refinementSizes([step(1000, 1), step(1414, 3), step(2000, 12)])).toEqual([1682]);
    });

    test('the refined ladder moves the interpolated size toward the measured point', () => {
        const coarse = [step(100000, 2.195), step(250000, 100)];
        const refined = withSteps(coarse, [step(158114, 6)]);
        expect(refined.map((s) => s.usd)).toEqual([100000, 158114, 250000]);
        const at5 = saleForImpact(refined, 5);
        expect(at5.usd).toBeGreaterThan(100000);
        expect(at5.usd).toBeLessThan(158114);
    });
});
