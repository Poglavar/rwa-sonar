// Fast tests for the flows shaping (stocks/lib/flows.mjs) and the observer's amount accumulator
// (lib/redemption-feed.mjs addFlow): an unread day is missing not zero, amounts only after
// `flowsFrom`, an unpriced remainder makes the day's USD a lower bound, and net needs both sides.
const { addFlow, publicFeed } = require('./lib/redemption-feed.mjs');
const { buildFlows, buildFloat, clipCoverage, dayWindow, makePriceFor, valueCells } = require('./lib/flows.mjs');

const REDEEM = 'CgyuW2dWDJzWW2H1XTjPRkbg9Y41dW2Fjj69KWsiir8C';
const ONDO = 'XzTT4XB8m7sLD2xi6snefSasaswsKCxx5Tifjondogm';
const symbolOf = (m) => ({ A: 'AX', B: 'BX' }[m] ?? null);
const noPrice = () => null;

describe('addFlow', () => {
    test('accumulates units, priced USD and unmeasured events separately', () => {
        const daily = {};
        addFlow(daily, '2026-09-23T10:00:00Z', 'redeemed', 'A', 2, 20, 'settlement');
        addFlow(daily, '2026-09-23T11:00:00Z', 'redeemed', 'A', 3, null);
        addFlow(daily, '2026-09-23T12:00:00Z', 'redeemed', 'A', null);
        expect(daily['2026-09-23'].flows.redeemed.A).toEqual({ n: 3, units: 5, usd: 20, usdUnits: 2, unmeasured: 1, priced: { settlement: 1 } });
        expect(() => addFlow(daily, '2026-09-23T12:00:00Z', 'sideways', 'A', 1)).toThrow();
    });
    test('the public issuer feed does not carry the per-mint flow maps', () => {
        const daily = { '2026-09-23': { redemptions: 1 } };
        addFlow(daily, '2026-09-23T10:00:00Z', 'redeemed', 'A', 2);
        const feed = publicFeed({ observable: true, daily, coverage: [{ from: '2026-09-23T00:00:00Z', to: '2026-09-23T12:00:00Z' }], lastScan: { at: '2026-09-23T12:00:00Z', status: 'ok' } }, { now: '2026-09-23T12:00:00Z' });
        expect(feed.daily['2026-09-23']).toEqual({ redemptions: 1, coveredHours: 12 });
    });
});

describe('valueCells', () => {
    test('prices the remainder with the day price and marks unpriced units as a lower bound', () => {
        const cells = { A: { n: 2, units: 5, usd: 20, usdUnits: 2, unmeasured: 0, priced: { settlement: 1 } }, B: { n: 1, units: 1, usd: 0, usdUnits: 0, unmeasured: 0 } };
        const v = valueCells(cells, '2026-09-23', { priceFor: (m) => (m === 'A' ? { usdPerUnit: 10, source: 'daily-snapshot' } : null), symbolOf });
        expect(v).toMatchObject({ events: 3, usd: 50, complete: false, unpricedMints: ['BX'], sources: { settlement: 1, 'daily-snapshot': 1 } });
        expect(v.top[0]).toMatchObject({ symbol: 'AX', usd: 50 });
        expect(v.top[1]).toMatchObject({ symbol: 'BX', usd: null });
    });
});

describe('buildFlows', () => {
    const now = '2026-09-23T20:00:00Z';
    const observations = {
        generatedAt: now,
        issuers: {
            'xstocks-backed': {
                observable: true, flowsFrom: '2026-09-23T06:00:00Z',
                addresses: { [REDEEM]: { coverage: [{ from: '2026-09-22T12:00:00Z', to: '2026-09-23T18:00:00Z' }] } },
                coverage: [{ from: '2026-09-23T01:00:00Z', to: '2026-09-23T18:00:00Z' }],
                daily: {
                    '2026-09-22': { deposits: 4 },
                    '2026-09-23': { deposits: 7, flows: { redeemed: { A: { n: 5, units: 5, usd: 50, usdUnits: 5, unmeasured: 0 } } } }
                },
                lastScan: { at: now, status: 'ok' }
            },
            'ondo-global-markets': {
                observable: true, flowsFrom: null,
                addresses: { [ONDO]: { coverage: [{ from: '2026-09-23T00:00:00Z', to: '2026-09-24T00:00:00Z' }] } },
                daily: { '2026-09-23': { mints: 2, redemptions: 1, intermediated: 1, flows: {
                    created: { A: { n: 2, units: 3, usd: 30, usdUnits: 3, unmeasured: 0 } },
                    redeemed: { A: { n: 2, units: 1, usd: 10, usdUnits: 1, unmeasured: 0 } } } } },
                lastScan: { at: now, status: 'ok' }
            },
            prestocks: { slug: 'prestocks', observable: false, mechanism: 'm', whyNotObservable: 'w', lastScan: { at: now } }
        }
    };
    const out = buildFlows(observations, { now, days: 3, priceFor: noPrice, symbolOf });
    const xs = out.issuers.find((i) => i.slug === 'xstocks-backed');
    const ondo = out.issuers.find((i) => i.slug === 'ondo-global-markets');
    const day = (issuer, d) => issuer.days.find((r) => r.date === d);

    test('an unread day is missing (null), not zero', () => {
        expect(day(xs, '2026-09-21').redeemed).toMatchObject({ coveredHours: 0, count: null, value: null });
    });
    test('a day read before amounts began carries its count but no amounts', () => {
        expect(day(xs, '2026-09-22').redeemed).toMatchObject({ coveredHours: 12, amountHours: 0, count: 4, value: null });
        expect(day(xs, '2026-09-23').redeemed).toMatchObject({ coveredHours: 18, amountHours: 12, count: 7 });
        expect(day(xs, '2026-09-23').redeemed.value.usd).toBe(50);
    });
    test('a side that is not collected is null and there is no net', () => {
        expect(day(xs, '2026-09-23').created).toBeNull();
        expect(day(xs, '2026-09-23').netUsd).toBeNull();
        expect(xs.created.counted).toBe(false);
        expect(xs.created.why).toMatch(/not collected/);
    });
    test('net = created − redeemed only for a whole, fully priced day with both sides', () => {
        expect(day(ondo, '2026-09-23').created.count).toBe(2);
        expect(day(ondo, '2026-09-23').redeemed.count).toBe(2);
        expect(day(ondo, '2026-09-23').netUsd).toBe(20);
    });
    test('not-observable programmes are listed with their reason; a missing issuer says so', () => {
        expect(out.notObservable).toEqual([{ slug: 'prestocks', mechanism: 'm', why: 'w', checkedAt: now }]);
        expect(out.issuers.find((i) => i.slug === 'superstate-opening-bell').state).toBe('no-observation-file');
    });
    test('an entry recorded before amounts existed (no flowsFrom) has counts only', () => {
        const old = JSON.parse(JSON.stringify(observations));
        delete old.issuers['ondo-global-markets'].flowsFrom;
        const o = buildFlows(old, { now, days: 1, priceFor: noPrice, symbolOf }).issuers.find((i) => i.slug === 'ondo-global-markets');
        expect(o.amountsFrom).toBeNull();
        expect(o.days[0].created).toMatchObject({ count: 2, amountHours: 0, value: null });
    });
});

describe('helpers', () => {
    test('dayWindow ends on today', () => {
        expect(dayWindow('2026-09-23T05:00:00Z', 3)).toEqual(['2026-09-21', '2026-09-22', '2026-09-23']);
    });
    test('clipCoverage starts coverage at flowsFrom', () => {
        expect(clipCoverage([{ from: '2026-09-22T00:00:00Z', to: '2026-09-23T00:00:00Z' }], '2026-09-22T12:00:00Z'))
            .toEqual([{ from: '2026-09-22T12:00:00Z', to: '2026-09-23T00:00:00Z' }]);
    });
    test('makePriceFor uses only that day\'s snapshot or a same-day catalogue price', () => {
        const tokensByMint = new Map([['A', { decimals: 2, uiMultiplier: '1.5', market: { usdPrice: 4 } }]]);
        const snapshots = new Map([['2026-09-22', new Map([['A', { marketValueUsd: 1000, supplyRaw: '10000' }]])]]);
        const priceFor = makePriceFor({ snapshots, tokensByMint, catalogueDay: '2026-09-23' });
        expect(priceFor('A', '2026-09-22')).toEqual({ usdPerUnit: 10, source: 'daily-snapshot' });
        expect(priceFor('A', '2026-09-23')).toEqual({ usdPerUnit: 6, source: 'same-day-catalogue' });
        expect(priceFor('A', '2026-09-21')).toBeNull();
    });
    test('buildFloat ranks priced tokens by float value and flags a float above the issuer\'s all-chain figure', () => {
        const floatFile = { readAt: '2026-09-23T22:00:00Z', previous: { readAt: '2026-09-22T22:00:00Z', floats: { A: '300' } }, items: [
            { mint: 'A', symbol: 'AX', status: 'ok', supplyRaw: '1000', inventoryRaw: '600', floatRaw: '400', inventorySharePct: 60, decimals: 0, uiMultiplier: '1' },
            { mint: 'B', symbol: 'BX', status: 'ok', supplyRaw: '100', inventoryRaw: '0', floatRaw: '100', inventorySharePct: 0, decimals: 0, uiMultiplier: '1' }] };
        const tokensByMint = new Map([['A', { market: { usdPrice: 2 } }], ['B', { market: {} }]]);
        const f = buildFloat(floatFile, { tokensByMint, por: new Map([['AX', { circulatingSupply: '350', timestamp: 't' }]]) });
        expect(f.top.map((r) => r.symbol)).toEqual(['AX']);
        expect(f.top[0]).toMatchObject({ floatUi: 400, floatUsd: 800, floatChangeUi: 100, porCirculatingAllChains: 350, floatExceedsPor: true });
        expect(f.unpricedWithFloat).toBe(1);
        expect(f.porConflicts).toEqual(['AX']);
        expect(buildFloat(null, { tokensByMint })).toBeNull();
    });
});
