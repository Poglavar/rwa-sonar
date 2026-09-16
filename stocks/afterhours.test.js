// Unit tests for the pure after-hours premium analytic (lib/afterhours.mjs). The schedule string
// is the VERBATIM US equity `attributes.schedule` from the public Hermes feed list read on
// 2026-09-16, and the mints/symbols are the real ones from the trade tape; the prices are
// synthetic and round so the medians and the gap can be checked by hand.
//
// The reference price is 100 throughout, so a trade at 103.00 is exactly a +3% premium.

const { parseSchedule } = require('./lib/market-hours.mjs');
const {
    MIN_SIDE_TRADES,
    NOTE,
    unusableReason,
    indexReferences,
    buildAfterhoursItems,
    summarize,
    buildPayload
} = require('./lib/afterhours.mjs');

const US_EQUITY = 'America/New_York;0930-1600,0930-1600,0930-1600,0930-1600,0930-1600,C,C;0907/C,1126/C,1127/0930-1300,1224/0930-1300,1225/C,0101/C,0118/C,0215/C,0326/C,0531/C,0618/C,0705/C';

const QQQX = 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ';
const SPYX = 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W';
const GLDX = 'Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re';
const TOPENAI = 'ToPENAIprivatecompanymintnoListedMarketAtAll';
const NOREF = 'NoRefPricesJsonRecordForThisMintAtAllHere';

// 10:00 in New York on Wednesday 2026-09-16 — inside 0930-1600 EDT (UTC-4).
const OPEN_AT = '2026-09-16T14:00:00Z';
// 17:00 the same day — after the close, the token's own venue still quoting.
const CLOSED_AT = '2026-09-16T21:00:00Z';
// Labor Day, the 0907/C holiday override.
const HOLIDAY_AT = '2026-09-07T14:00:00Z';

function reference(mint, symbol, overrides = {}) {
    return {
        mint,
        symbol,
        issuer: 'xstocks-backed',
        underlyingTicker: symbol.replace(/x$/, ''),
        jupiterPrice: 100,
        pythFeedId: 'f'.repeat(64),
        pythEntitled: true,
        marketOpen: false,
        schedule: US_EQUITY,
        marketHours: { isOpen: false, nextOpen: 1789651800, nextClose: 1789675200 },
        refSource: 'pyth',
        refPrice: 100,
        refConf: 0.05,
        refPublishTime: 1789598946,
        refAgeSeconds: 0,
        note: null,
        premiumPct: 0,
        ...overrides
    };
}

let sig = 0;
function trade(mint, symbol, time, priceUsd, overrides = {}) {
    sig += 1;
    return {
        sig: `sig${sig}`,
        time,
        mint,
        symbol,
        dex: 'raydium',
        pair: 'BS9uyGV6XmNnPkM4f3xgxCdQEaFv7RSKs6fwrpvYHxfL',
        side: 'buy',
        size: 1,
        quoteAmount: 1,
        priceQuote: 1,
        priceUsd,
        suspect: null,
        ...overrides
    };
}

/** n trades at the given instant, priced refPrice*(1 + pct/100) for each pct. */
function tradesAt(mint, symbol, time, percents) {
    return percents.map((pct) => trade(mint, symbol, time, 100 * (1 + pct / 100)));
}

describe('unusableReason / indexReferences', () => {
    test('a record with a schedule and a positive refPrice is usable', () => {
        expect(unusableReason(reference(QQQX, 'QQQx'))).toBe(null);
        const { usable, unusable } = indexReferences([reference(QQQX, 'QQQx')]);
        expect(unusable.size).toBe(0);
        expect(usable.get(QQQX).refPrice).toBe(100);
        expect(usable.get(QQQX).source).toBe('pyth');
        // The schedule is parsed once per mint, not once per trade.
        expect(usable.get(QQQX).schedule).toEqual(parseSchedule(US_EQUITY));
    });

    test('names why a record cannot be measured', () => {
        expect(unusableReason(null)).toBe('no reference-price record');
        expect(unusableReason(undefined)).toBe('no reference-price record');
        expect(unusableReason(reference(TOPENAI, 'tOpenAI', { schedule: null }))).toBe('no Pyth feed schedule');
        expect(unusableReason(reference(TOPENAI, 'tOpenAI', { schedule: 'nonsense' }))).toBe('no Pyth feed schedule');
        expect(unusableReason(reference(GLDX, 'GLDx', { refPrice: null }))).toBe('no reference price');
        expect(unusableReason(reference(GLDX, 'GLDx', { refPrice: 0 }))).toBe('no reference price');
    });

    test('sorts the records into usable and unusable', () => {
        const { usable, unusable } = indexReferences([
            reference(QQQX, 'QQQx'),
            reference(TOPENAI, 'tOpenAI', { schedule: null, refSource: 'issuer-mark', refPrice: 812.79 }),
            reference(GLDX, 'GLDx', { refPrice: null, refSource: null })
        ]);
        expect([...usable.keys()]).toEqual([QQQX]);
        expect(unusable.get(TOPENAI).reason).toBe('no Pyth feed schedule');
        expect(unusable.get(GLDX).reason).toBe('no reference price');
        expect(indexReferences(null).usable.size).toBe(0);
        expect(indexReferences(undefined).unusable.size).toBe(0);
    });
});

describe('buildAfterhoursItems', () => {
    test('medians each side and reports the gap between them', () => {
        const trades = [
            ...tradesAt(QQQX, 'QQQx', OPEN_AT, [0, 1, 2, 3, 4, 5]),
            ...tradesAt(QQQX, 'QQQx', CLOSED_AT, [6, 7, 8, 9, 10])
        ];
        const { items, omittedMints, skipped } = buildAfterhoursItems(trades, [reference(QQQX, 'QQQx')]);
        expect(items).toHaveLength(1);
        const item = items[0];
        expect(item.tradesOpen).toBe(6);
        expect(item.tradesClosed).toBe(5);
        expect(item.openPremiumPct).toBeCloseTo(2.5, 9);
        expect(item.closedPremiumPct).toBeCloseTo(8, 9);
        expect(item.gapPct).toBeCloseTo(5.5, 9);
        expect(item.symbol).toBe('QQQx');
        expect(item.issuer).toBe('xstocks-backed');
        expect(item.underlyingTicker).toBe('QQQ');
        expect(item.source).toBe('pyth');
        expect(item.refPrice).toBe(100);
        expect(item.refPublishTime).toBe(1789598946);
        expect(omittedMints).toEqual([]);
        expect(skipped).toEqual({ suspect: 0, noPriceUsd: 0, noPremium: 0, unknownSession: 0, badTime: 0 });
    });

    test('a side below the minimum stays null, and so does the gap', () => {
        const trades = [
            ...tradesAt(QQQX, 'QQQx', OPEN_AT, [1, 2, 3, 4]),
            ...tradesAt(QQQX, 'QQQx', CLOSED_AT, [6, 7, 8, 9, 10, 11])
        ];
        const [item] = buildAfterhoursItems(trades, [reference(QQQX, 'QQQx')]).items;
        expect(MIN_SIDE_TRADES).toBe(5);
        expect(item.tradesOpen).toBe(4);
        expect(item.openPremiumPct).toBe(null);
        expect(item.closedPremiumPct).toBeCloseTo(8.5, 9);
        expect(item.gapPct).toBe(null);
    });

    test('a holiday trade counts as a closed-market trade', () => {
        const trades = [
            ...tradesAt(QQQX, 'QQQx', OPEN_AT, [1, 1, 1, 1, 1]),
            ...tradesAt(QQQX, 'QQQx', HOLIDAY_AT, [20, 21, 22, 23, 24])
        ];
        const [item] = buildAfterhoursItems(trades, [reference(QQQX, 'QQQx')]).items;
        expect(item.tradesOpen).toBe(5);
        expect(item.tradesClosed).toBe(5);
        expect(item.openPremiumPct).toBeCloseTo(1, 9);
        expect(item.closedPremiumPct).toBeCloseTo(22, 9);
        expect(item.gapPct).toBeCloseTo(21, 9);
    });

    test('suspect trades and trades without a USD price never reach a median', () => {
        const trades = [
            ...tradesAt(QQQX, 'QQQx', OPEN_AT, [1, 1, 1, 1, 1]),
            ...tradesAt(QQQX, 'QQQx', CLOSED_AT, [2, 2, 2, 2, 2]),
            // A round-trip: arithmetically real, economically meaningless, +60000%.
            trade(QQQX, 'QQQx', CLOSED_AT, 60799.88, { suspect: 'round-trip' }),
            trade(QQQX, 'QQQx', CLOSED_AT, null),
            trade(QQQX, 'QQQx', CLOSED_AT, 0),
            trade(QQQX, 'QQQx', CLOSED_AT, Number.NaN),
            trade(QQQX, 'QQQx', 'not a timestamp', 102)
        ];
        const { items, skipped } = buildAfterhoursItems(trades, [reference(QQQX, 'QQQx')]);
        expect(items[0].tradesClosed).toBe(5);
        expect(items[0].closedPremiumPct).toBeCloseTo(2, 9);
        expect(skipped.suspect).toBe(1);
        expect(skipped.noPriceUsd).toBe(3);
        expect(skipped.badTime).toBe(1);
        expect(skipped.unknownSession).toBe(0);
    });

    test('the window spans only the trades actually used', () => {
        const trades = [
            trade(QQQX, 'QQQx', '2026-09-16T13:35:00Z', 101),
            ...tradesAt(QQQX, 'QQQx', OPEN_AT, [1, 2, 3, 4]),
            trade(QQQX, 'QQQx', '2026-09-16T22:42:57Z', 104),
            // Newest of all, but suspect — it must not stretch the window.
            trade(QQQX, 'QQQx', '2026-09-16T23:59:00Z', 60799.88, { suspect: 'round-trip' })
        ];
        const [item] = buildAfterhoursItems(trades, [reference(QQQX, 'QQQx')]).items;
        expect(item.windowFrom).toBe('2026-09-16T13:35:00Z');
        expect(item.windowTo).toBe('2026-09-16T22:42:57Z');
    });

    test('a mint with no listed market is omitted with its reason and trade count, not emitted as nulls', () => {
        const trades = [
            ...tradesAt(QQQX, 'QQQx', CLOSED_AT, [1, 2, 3, 4, 5]),
            ...tradesAt(TOPENAI, 'tOpenAI', CLOSED_AT, [1, 2, 3]),
            ...tradesAt(GLDX, 'GLDx', CLOSED_AT, [1, 2]),
            trade(NOREF, 'BROS', CLOSED_AT, 101)
        ];
        const references = [
            reference(QQQX, 'QQQx'),
            reference(TOPENAI, 'tOpenAI', { schedule: null, refSource: 'issuer-mark', refPrice: 812.79 }),
            reference(GLDX, 'GLDx', { refPrice: null, refSource: null })
        ];
        const { items, omittedMints } = buildAfterhoursItems(trades, references);
        expect(items.map((i) => i.mint)).toEqual([QQQX]);
        expect(omittedMints).toEqual([
            { mint: NOREF, symbol: 'BROS', reason: 'no reference-price record', trades: 1 },
            { mint: TOPENAI, symbol: 'tOpenAI', reason: 'no Pyth feed schedule', trades: 3 },
            { mint: GLDX, symbol: 'GLDx', reason: 'no reference price', trades: 2 }
        ].sort((a, b) => (a.mint < b.mint ? -1 : 1)));
    });

    test('items are sorted by mint', () => {
        const trades = [
            ...tradesAt(SPYX, 'SPYx', CLOSED_AT, [1, 1, 1, 1, 1]),
            ...tradesAt(QQQX, 'QQQx', CLOSED_AT, [2, 2, 2, 2, 2]),
            ...tradesAt(GLDX, 'GLDx', CLOSED_AT, [3, 3, 3, 3, 3])
        ];
        const references = [reference(SPYX, 'SPYx'), reference(QQQX, 'QQQx'), reference(GLDX, 'GLDx')];
        const { items } = buildAfterhoursItems(trades, references);
        expect(items.map((i) => i.mint)).toEqual([QQQX, SPYX, GLDX].sort((a, b) => (a < b ? -1 : 1)));
    });

    test('no trades at all is an empty build, not a crash', () => {
        expect(buildAfterhoursItems([], [reference(QQQX, 'QQQx')]).items).toEqual([]);
        expect(buildAfterhoursItems(null, null).items).toEqual([]);
        expect(buildAfterhoursItems(undefined, [reference(QQQX, 'QQQx')]).omittedMints).toEqual([]);
    });
});

describe('summarize', () => {
    test('counts the sides and picks the widest gap by absolute value', () => {
        const items = [
            { mint: 'a', symbol: 'A', openPremiumPct: 1, closedPremiumPct: 6, gapPct: 5, tradesOpen: 6, tradesClosed: 6 },
            { mint: 'b', symbol: 'B', openPremiumPct: 2, closedPremiumPct: -6, gapPct: -8, tradesOpen: 9, tradesClosed: 9 },
            { mint: 'c', symbol: 'C', openPremiumPct: null, closedPremiumPct: 3, gapPct: null, tradesOpen: 2, tradesClosed: 7 },
            { mint: 'd', symbol: 'D', openPremiumPct: 4, closedPremiumPct: null, gapPct: null, tradesOpen: 7, tradesClosed: 1 }
        ];
        const stats = summarize(items);
        expect(stats.items).toBe(4);
        expect(stats.bothSides).toBe(2);
        expect(stats.closedOnly).toBe(1);
        expect(stats.openOnly).toBe(1);
        expect(stats.largestGap.symbol).toBe('B');
    });

    test('no gap anywhere leaves largestGap null rather than 0', () => {
        const stats = summarize([{ mint: 'a', openPremiumPct: null, closedPremiumPct: 3, gapPct: null }]);
        expect(stats.bothSides).toBe(0);
        expect(stats.largestGap).toBe(null);
        expect(summarize(null).largestGap).toBe(null);
        expect(summarize(undefined).items).toBe(0);
    });
});

describe('buildPayload', () => {
    test('carries the provenance of both inputs and the honest reference caveat', () => {
        const payload = buildPayload({
            generatedAt: '2026-09-16T23:00:00Z',
            tradesGeneratedAt: '2026-09-16T22:44:11Z',
            referenceFetchedAt: '2026-09-16T22:49:06Z',
            items: [],
            omittedMints: [],
            skipped: { suspect: 0, noPriceUsd: 0, noPremium: 0, unknownSession: 0, badTime: 0 }
        });
        expect(payload.generatedAt).toBe('2026-09-16T23:00:00Z');
        expect(payload.tradesGeneratedAt).toBe('2026-09-16T22:44:11Z');
        expect(payload.referenceFetchedAt).toBe('2026-09-16T22:49:06Z');
        expect(payload.minSideTrades).toBe(MIN_SIDE_TRADES);
        expect(payload.note).toBe(NOTE);
        // The caveat must actually say that the reference is the one at build time.
        expect(payload.note).toMatch(/LAST reference price at build time/);
        expect(payload.items).toEqual([]);
    });

    test('missing input timestamps are null, never invented', () => {
        const payload = buildPayload({ generatedAt: '2026-09-16T23:00:00Z', items: [], omittedMints: [], skipped: {} });
        expect(payload.tradesGeneratedAt).toBe(null);
        expect(payload.referenceFetchedAt).toBe(null);
    });
});
