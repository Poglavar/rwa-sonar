// Unit tests for lib/tracking.mjs: closed-market stretches, the contemporaneous-reference pairing
// rule, the idempotent tracking log, snapshot/quote de-duplication, hourly trade points and the
// concentration scatter rows. The schedule is the verbatim US equity Pyth schedule; prices are
// synthetic round numbers so every premium can be checked by hand.

const { parseSchedule } = require('./lib/market-hours.mjs');
const {
    closedIntervals, stretchIndex, pairReference, referenceObservations, mergeLog, emptyLog,
    snapshotPoints, dropSnapshotsCoveredByQuotes, hourlyTradePoints, buildPremiumSection,
    dexPoolLiquidity, buildConcentrationSection, PAIR_TOLERANCE_MS
} = require('./lib/tracking.mjs');

const US = 'America/New_York;0930-1600,0930-1600,0930-1600,0930-1600,0930-1600,C,C;0907/C,1126/C,1127/0930-1300,1224/0930-1300,1225/C,0101/C,0118/C,0215/C,0326/C,0531/C,0618/C,0705/C';
const SCHEDULE = parseSchedule(US);
const t = (iso) => Date.parse(iso);

// Wed 2026-09-23: NY open 13:30Z–20:00Z (EDT). Thu 2026-09-24 open again 13:30Z.
const FROM = t('2026-09-23T12:00:00Z');
const TO = t('2026-09-24T15:00:00Z');

describe('closedIntervals', () => {
    test('marks the overnight stretch from the 16:00 close to the 09:30 open', () => {
        const iv = closedIntervals(SCHEDULE, FROM, TO);
        expect(iv.map((x) => [new Date(x.from).toISOString(), new Date(x.to).toISOString()])).toEqual([
            ['2026-09-23T12:00:00.000Z', '2026-09-23T13:30:00.000Z'],
            ['2026-09-23T20:00:00.000Z', '2026-09-24T13:30:00.000Z']
        ]);
    });

    test('an unknown schedule is null, never "closed"', () => {
        expect(closedIntervals(null, FROM, TO)).toBeNull();
    });

    test('a holiday stretch is flagged', () => {
        // 2026-11-26 Thanksgiving: closed all day, merged with the nights either side.
        const iv = closedIntervals(SCHEDULE, t('2026-11-26T12:00:00Z'), t('2026-11-26T18:00:00Z'));
        expect(iv).toHaveLength(1);
        expect(iv[0].holiday).toBe(true);
    });

    test('stretchIndex finds the stretch and returns -1 in open hours', () => {
        const iv = closedIntervals(SCHEDULE, FROM, TO);
        expect(stretchIndex(iv, t('2026-09-23T23:00:00Z'))).toBe(1);
        expect(stretchIndex(iv, t('2026-09-23T15:00:00Z'))).toBe(-1);
    });
});

describe('pairReference', () => {
    const iv = closedIntervals(SCHEDULE, FROM, TO);
    const night = { atMs: t('2026-09-24T02:00:00Z'), refPrice: 100 };
    const openRef = { atMs: t('2026-09-23T15:00:00Z'), refPrice: 90 };

    test('a closed-market trade pairs with a reference hours away in the same closed stretch', () => {
        const pair = pairReference(t('2026-09-23T21:00:00Z'), [night, openRef], iv);
        expect(pair.obs).toBe(night);
        expect(pair.basis).toBe('same-closed-session');
    });

    test('an open-market trade pairs only within the tolerance', () => {
        expect(pairReference(t('2026-09-23T15:05:00Z'), [night, openRef], iv).basis).toBe('within-10-min');
        expect(pairReference(t('2026-09-23T15:00:00Z') + PAIR_TOLERANCE_MS + 1, [night, openRef], iv)).toBeNull();
    });

    test('a closed trade does not pair with a reference from the previous night', () => {
        const lastNight = { atMs: t('2026-09-23T12:30:00Z'), refPrice: 95 };
        expect(pairReference(t('2026-09-23T21:00:00Z'), [lastNight], iv)).toBeNull();
    });
});

describe('the tracking log', () => {
    const referenceDoc = {
        fetchedAt: '2026-09-24T02:00:00Z',
        items: [
            { mint: 'M1', underlyingTicker: 'NVDA', refSource: 'ondo-implied', refPrice: 100, jupiterPrice: 101, schedule: US },
            { mint: 'M2', underlyingTicker: 'NVDA', refSource: 'pyth', refPrice: 100, refPublishTime: 1790215200, jupiterPrice: 99, schedule: US },
            { mint: 'M3', underlyingTicker: 'XYZ', refSource: null, refPrice: null, jupiterPrice: 5 }
        ]
    };
    const iv = closedIntervals(SCHEDULE, FROM, TO);
    const intervalsByMint = new Map([['M1', iv], ['M2', iv]]);
    const trades = [
        { sig: 's1', time: '2026-09-23T21:00:00Z', mint: 'M1', priceUsd: 102 },
        { sig: 's2', time: '2026-09-23T21:10:00Z', mint: 'M1', priceUsd: 98, suspect: 'round-trip' },
        { sig: 's3', time: '2026-09-23T16:00:00Z', mint: 'M1', priceUsd: 150 },
        { sig: 's4', time: '2026-09-23T21:20:00Z', mint: 'NOREF', priceUsd: 1 },
        { sig: 's5', time: '2026-09-23T21:30:00Z', mint: 'M1', priceUsd: null }
    ];

    test('referenceObservations keeps priced items, prefers the Pyth publish time', () => {
        const refs = referenceObservations(referenceDoc);
        expect(refs.map((r) => r.mint)).toEqual(['M1', 'M2']);
        expect(refs[0]).toMatchObject({ at: '2026-09-24T02:00:00Z', atBasis: 'fetched-at', premiumPct: expect.closeTo(1, 9) });
        expect(refs[1]).toMatchObject({ at: '2026-09-24T02:00:00Z', atBasis: 'publish-time', source: 'pyth' });
    });

    test('mergeLog pairs only contemporaneous trades and counts the rest', () => {
        const { log, skipped } = mergeLog(emptyLog(), { references: referenceObservations(referenceDoc), trades, intervalsByMint });
        expect(log.trades).toHaveLength(1);
        expect(log.trades[0]).toMatchObject({ sig: 's1', refSource: 'ondo-implied', basis: 'same-closed-session', premiumPct: expect.closeTo(2, 9) });
        expect(skipped).toEqual({ suspect: 1, noPriceUsd: 1, badTime: 0, noReferenceRecord: 1, noContemporaneousReference: 1 });
    });

    test('rerunning with the same inputs is a no-op; pruning drops old entries', () => {
        const once = mergeLog(emptyLog(), { references: referenceObservations(referenceDoc), trades, intervalsByMint }).log;
        const twice = mergeLog(once, { references: referenceObservations(referenceDoc), trades, intervalsByMint }).log;
        expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
        const pruned = mergeLog(once, { intervalsByMint, keepFromMs: t('2026-09-24T00:00:00Z') }).log;
        expect(pruned.trades).toHaveLength(0);
        expect(pruned.references).toHaveLength(2);
    });

    test('a trade kept in the log survives after it leaves the 24 h tape', () => {
        const once = mergeLog(emptyLog(), { references: referenceObservations(referenceDoc), trades, intervalsByMint }).log;
        const later = mergeLog(once, { references: [], trades: [], intervalsByMint }).log;
        expect(later.trades.map((r) => r.sig)).toEqual(['s1']);
    });
});

describe('snapshot and trade points', () => {
    test('a value copied forward unchanged is dropped as a repeat', () => {
        const { points, repeated } = snapshotPoints([
            { date: '2026-09-17', builtAt: '2026-09-17T12:00:00Z', items: [{ mint: 'M1', premiumPct: 0.5 }] },
            { date: '2026-09-16', builtAt: '2026-09-16T12:00:00Z', items: [{ mint: 'M1', premiumPct: 0.5 }, { mint: 'M2', premiumPct: null }] },
            { date: '2026-09-18', builtAt: '2026-09-18T12:00:00Z', items: [{ mint: 'M1', premiumPct: -1 }] }
        ]);
        expect(points.map((p) => [p.date, p.premiumPct])).toEqual([['2026-09-16', 0.5], ['2026-09-18', -1]]);
        expect(repeated).toBe(1);
    });

    test('a snapshot equal to a logged quote from the same run is not drawn twice', () => {
        const snaps = [{ mint: 'M1', t: '2026-09-23T22:20:00Z', premiumPct: 1.35336 }, { mint: 'M1', t: '2026-09-22T18:00:00Z', premiumPct: -1 }];
        const refs = [{ mint: 'M1', fetchedAt: '2026-09-23T22:19:53Z', premiumPct: 1.353361 }];
        const { points, covered } = dropSnapshotsCoveredByQuotes(snaps, refs);
        expect(points).toHaveLength(1);
        expect(covered).toBe(1);
    });

    test('hourly points split at the closing bell and report the median and count', () => {
        const rows = [
            { t: '2026-09-23T19:50:00Z', mint: 'M1', premiumPct: 1, refSource: 'pyth', basis: 'within-10-min' },
            { t: '2026-09-23T20:10:00Z', mint: 'M1', premiumPct: 2, refSource: 'pyth', basis: 'same-closed-session' },
            { t: '2026-09-23T20:20:00Z', mint: 'M1', premiumPct: 4, refSource: 'pyth', basis: 'same-closed-session' },
            { t: '2026-09-23T20:30:00Z', mint: 'M1', premiumPct: 9, refSource: 'pyth', basis: 'same-closed-session' }
        ];
        const points = hourlyTradePoints(rows, new Map([['M1', SCHEDULE]]));
        expect(points.map((p) => [p.session, p.n, p.premiumPct])).toEqual([['open', 1, 1], ['closed', 3, 4]]);
    });

    test('buildPremiumSection lists wrappers with no points and skips underlyings with none', () => {
        const section = buildPremiumSection({
            tokens: [
                { mint: 'M1', symbol: 'NVDAx', issuer: 'xstocks-backed', underlyingTicker: 'NVDA', cardSlug: 'NVDAx' },
                { mint: 'M2', symbol: 'NVDAon', issuer: 'ondo-global-markets', underlyingTicker: 'NVDA', cardSlug: 'NVDAon' },
                { mint: 'M9', symbol: 'ZZZx', issuer: 'xstocks-backed', underlyingTicker: 'ZZZ', cardSlug: 'ZZZx' }
            ],
            referenceDoc: { items: [{ mint: 'M1', schedule: US, refSource: 'pyth' }] },
            log: { references: [{ mint: 'M1', at: '2026-09-23T22:00:00Z', fetchedAt: '2026-09-23T22:00:00Z', source: 'pyth', premiumPct: 0.25, refPrice: 100, jupiterPrice: 100.25 }], trades: [] },
            snapshots: { points: [], repeated: 0 },
            nowMs: t('2026-09-24T00:00:00Z')
        });
        expect(section.underlyings.map((u) => u.ticker)).toEqual(['NVDA']);
        const nvda = section.underlyings[0];
        expect(nvda.wrappers.map((w) => [w.symbol, w.points.length])).toEqual([['NVDAx', 1], ['NVDAon', 0]]);
        expect(nvda.wrappers[0].points[0]).toMatchObject({ kind: 'quote', p: 0.25, src: 'pyth', session: 'closed' });
        expect(section.schedules[nvda.schedule].closed.length).toBeGreaterThan(0);
    });
});

describe('concentration scatter rows', () => {
    const holdersDoc = {
        fetchedAt: '2026-09-20T08:19:40Z',
        items: [
            { mint: 'A', top1SharePct: 90, top20: [
                { owner: 'auth', ownerLabel: 'issuer-authority', amountUi: 90, sharePct: 90 },
                { owner: 'w1', ownerLabel: null, amountUi: 6, sharePct: 6 }
            ] },
            { mint: 'B', top1SharePct: 70, top20: [{ owner: 'w2', ownerLabel: null, amountUi: 70, sharePct: 70 }] },
            { mint: 'D', top1SharePct: 40, top20: [{ owner: 'w3', ownerLabel: null, amountUi: 40, sharePct: 40 }] }
        ]
    };
    const venuesDoc = { fetchedAt: '2026-09-20T08:52:13Z', items: [{ mint: 'D', dexFetchedAt: '2026-09-20T08:10:53Z', dex: [{ liquidityUsd: 100 }, { liquidityUsd: 50 }] }] };
    const tokens = [
        { mint: 'A', symbol: 'AAAx', issuer: 'xstocks-backed', cardSlug: 'AAAx', market: { liquidity: 50000, holderCount: 10 } },
        { mint: 'B', symbol: 'BBBon', issuer: 'ondo-global-markets', cardSlug: 'BBBon', market: { liquidity: 900, holderCount: null } },
        { mint: 'C', symbol: 'CCC', issuer: 'prestocks', cardSlug: 'CCC', market: { liquidity: 0 } },
        { mint: 'D', symbol: 'DDD', issuer: 'tessera', cardSlug: 'DDD', market: {} },
        { mint: 'E', symbol: 'EEE', issuer: 'shift', cardSlug: 'EEE' }
    ];

    test('dexPoolLiquidity sums stated pools and is null when none is stated', () => {
        expect(dexPoolLiquidity(venuesDoc.items[0])).toBe(150);
        expect(dexPoolLiquidity({ dex: [{ liquidityUsd: null }] })).toBeNull();
    });

    test('labelled issuer wallets are set aside; missing values are listed, never zero', () => {
        const s = buildConcentrationSection({ tokens, holdersDoc, venuesDoc, universeFetchedAt: '2026-09-23T22:08:36Z' });
        expect(s.plotted.map((r) => [r.symbol, r.top1SharePct, r.liquiditySource, r.corner])).toEqual([
            ['AAAx', 6, 'jupiter', false],
            ['BBBon', 70, 'jupiter', true],
            ['DDD', 40, 'dexscreener', false]
        ]);
        expect(s.plotted[0]).toMatchObject({ excludedLabels: ['issuer-authority'], excludedSharePct: 90, top1SharePctRaw: 90 });
        expect(s.plotted[1].holderCount).toBeNull();
        expect(s.notPlotted.map((r) => [r.symbol, r.missing])).toEqual([
            ['CCC', ['zero-liquidity', 'holders']],
            ['EEE', ['liquidity', 'holders']]
        ]);
        expect(s.counts).toMatchObject({ plotted: 3, inCorner: 1, notPlotted: 2, missingLiquidity: 1, zeroLiquidity: 1, missingHolders: 2 });
    });
});
