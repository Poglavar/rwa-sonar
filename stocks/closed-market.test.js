// Unit tests for lib/closed-market.mjs: the "When the market is closed" view. The lender rows are
// built from the REAL structured research (stocks/data/protocol-market-research.json oraclePricing,
// read on-chain 2026-09-24), so a label, a threshold or a market going missing there fails here.
// Watcher rows, gaps, depth samples and tracking points are small fixtures in the shapes the SQL
// and the collectors produce.

const fs = require('fs');
const path = require('path');
const {
    LABEL_KINDS, FINDING_SCHEMAS, labelKindOf, lenderRowsFor, staleState, freezeSummary, coverageFor, gapsFor,
    depthFor, latestWeekend, weekendMoveFor, tokenFindings, buildClosedMarket, summarize, closedMarketRowsPsql,
    marketIdOf, dayText, buildPayload
} = require('./lib/closed-market.mjs');

const ROOT = path.join(__dirname, '..');
const research = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'protocol-market-research.json'), 'utf8'));
const oraclePricing = research.oraclePricing;
const findingTypes = JSON.parse(fs.readFileSync(path.join(ROOT, 'finding-types.json'), 'utf8'));

const NVDAX = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const QQQX = 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ';
const TSLAX = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';
const SPYON = 'k18WJUULWheRkSpSquYGdNNmtuE2Vbw1hpuUi92ondo';
const SECZ = '5VzwKkvynPJzcgwhBe7ESEyNgqMbo15yBu7Sehssd9ED';
const NOBODY = 'NoLenderTakesThisMint1111111111111111111111';
const AS_OF = '2026-09-24T19:00:00Z';

/** The watcher rows as they stood on the server at 2026-09-24T19:05Z (closedMarketRowsPsql shape). */
const FREEZES = [
    { protocol: 'jupiter-lend', market_id: 'jupiter-lend:xstocks-vaults', mint: QQQX, symbol: 'QQQx', started_at: '2026-09-24T08:38:00Z', ended_at: '2026-09-24T09:07:45Z', last_seen_stale_at: null, observation: 'jl-cache-refresh-gap', cause: null, end_basis: 'next-refresh' },
    { protocol: 'jupiter-lend', market_id: 'jupiter-lend:xstocks-vaults', mint: QQQX, symbol: 'QQQx', started_at: '2026-09-19T17:29:01Z', ended_at: '2026-09-21T12:31:24Z', last_seen_stale_at: null, observation: 'jl-cache-refresh-gap', cause: 'operator-suspension', end_basis: 'next-refresh' },
    { protocol: 'jupiter-lend', market_id: 'jupiter-lend:xstocks-vaults', mint: NVDAX, symbol: 'NVDAx', started_at: '2026-09-24T08:39:00Z', ended_at: '2026-09-24T08:50:00Z', last_seen_stale_at: null, observation: 'jl-cache-refresh-gap', cause: null, end_basis: 'next-refresh' },
    { protocol: 'loopscale', market_id: 'loopscale:xstocks-orca-vaults', mint: TSLAX, symbol: 'TSLAx', started_at: '2026-09-11T23:59:59Z', ended_at: null, last_seen_stale_at: '2026-09-24T18:59:18Z', observation: 'pyth-account-age', cause: 'stale-oracle-account', end_basis: null },
    { protocol: 'loopscale', market_id: 'loopscale:xstocks-orca-vaults', mint: NVDAX, symbol: 'NVDAx', started_at: '2026-08-26T15:54:46Z', ended_at: null, last_seen_stale_at: '2026-09-24T18:59:18Z', observation: 'pyth-account-age', cause: 'stale-oracle-account', end_basis: null }
];
const SCAN = [
    { protocol: 'kamino', role: 'kamino-reserve', market_id: 'kamino:xstocks-pool', mint: NVDAX, backfill_from: '2026-09-16T00:00:00Z', last_block_time: '2026-09-17T13:11:37Z', checked_at: '2026-09-24T19:05:52Z' },
    { protocol: 'jupiter-lend', role: 'jl-cache', market_id: 'jupiter-lend:xstocks-vaults', mint: QQQX, backfill_from: '2026-09-16T00:00:00Z', last_block_time: '2026-09-24T19:01:21Z', checked_at: '2026-09-24T19:05:52Z' },
    { protocol: 'loopscale', role: 'pyth-price', market_id: 'loopscale:xstocks-orca-vaults', mint: NVDAX, backfill_from: '2026-09-16T00:00:00Z', last_block_time: null, checked_at: '2026-09-24T19:05:52Z' }
];

function ctx(overrides = {}) {
    return { oraclePricing, freezeRows: FREEZES, scanRows: SCAN, freezesRead: true, gapDoc: null, gapsRead: false, asOf: AS_OF, ...overrides };
}

describe('labels', () => {
    test('every researched market maps to one of the five labels (or stale), none to a guess', () => {
        const kinds = Object.fromEntries(oraclePricing.markets.map((m) => [m.id, labelKindOf(m)]));
        expect(kinds).toEqual({
            'kamino:xstocks-pool:oracle': 'frozen-at-close',
            'kamino:sentora-xstocks-market:oracle': 'frozen-at-close',
            'kamino:strcx-pool:oracle': 'frozen-at-close',
            'kamino:superstate-pool:oracle': 'frozen-at-close',
            'jupiter-lend:xstocks-vaults:oracle': 'overnight-24x5',
            'nest:xstocks-pyth-lazer:oracle': 'token-24x7',
            'nest:jupiter-signed:oracle': 'signed-quote',
            'loopscale:xstocks-orca-vaults:oracle': 'stale',
            'loopscale:secz-usdc-rwa:oracle': 'frozen-at-close'
        });
        expect(labelKindOf({ whenMarketClosed: { behaviour: 'something-new' } })).toBe('not-researched');
        expect(labelKindOf(null)).toBe('not-researched');
    });

    test('every researched market carries one borrower sentence', () => {
        for (const market of oraclePricing.markets) {
            expect(typeof market.borrowerSentence).toBe('string');
            // One sentence: a single terminal full stop, no second sentence after it.
            expect(market.borrowerSentence.trim()).toMatch(/[.]$/);
            expect(market.borrowerSentence.replace(/\b(e\.g|i\.e)\./g, '').split(/\.\s+[A-Z]/)).toHaveLength(1);
        }
    });

    test('marketIdOf strips the research suffix; dayText is a UTC day', () => {
        expect(marketIdOf('kamino:xstocks-pool:oracle')).toBe('kamino:xstocks-pool');
        expect(dayText('2026-08-26T15:54:46Z')).toBe('26 Aug 2026');
        expect(dayText(null)).toBeNull();
    });
});

describe('lenderRowsFor', () => {
    test('NVDAx: five markets, each with its closed-market label and liquidation threshold', () => {
        const rows = lenderRowsFor(NVDAX, ctx());
        expect(rows.map((r) => [r.marketId, r.label, r.liquidationLtvPct])).toEqual([
            ['kamino:sentora-xstocks-market', 'frozen at close', 73],
            ['kamino:xstocks-pool', 'frozen at close', 65],
            ['jupiter-lend:xstocks-vaults', '24/5 overnight', 75],
            ['nest:xstocks-pyth-lazer', '24/7 token price', 60],
            ['loopscale:xstocks-orca-vaults', 'stale since 26 Aug 2026', 60]
        ]);
        const nest = rows.find((r) => r.protocolId === 'nest');
        expect(nest.sentence).toMatch(/24\/7 price/);
        expect(nest.remark).toMatch(/moves with the token/);
        expect(rows.find((r) => r.protocolId === 'jupiter-lend').remark).toMatch(/Sunday 20:00 ET/);
    });

    test('the stale label takes the watcher\'s ongoing episode: TSLAx stale since 11 Sep, still stale at the last read', () => {
        const row = lenderRowsFor(TSLAX, ctx()).find((r) => r.protocolId === 'loopscale');
        expect(row.label).toBe('stale since 11 Sep 2026');
        expect(row.staleStillAt).toBe('2026-09-24T18:59:18Z');
    });

    test('a stale price the watcher has seen updated again is no longer called stale', () => {
        const ended = FREEZES.map((r) => (r.mint === NVDAX && r.protocol === 'loopscale' ? { ...r, ended_at: '2026-09-25T13:31:00Z', last_seen_stale_at: '2026-09-25T13:00:00Z' } : r));
        const row = lenderRowsFor(NVDAX, ctx({ freezeRows: ended })).find((r) => r.protocolId === 'loopscale');
        expect(row.labelKind).toBe('frozen-at-close');
        expect(row.staleEndedAt).toBe('2026-09-25T13:31:00Z');
    });

    test('without the watcher\'s rows the research date stands, and says so', () => {
        const state = staleState({ mint: TSLAX, lastPublish: '2026-09-11T23:59:59Z' }, [], 'loopscale:xstocks-orca-vaults', false);
        expect(state).toEqual({ since: '2026-09-11T23:59:59Z', stillAt: null, ended: null, basis: 'research' });
    });

    test('a lending integration the research did not price is labelled not researched, never guessed', () => {
        const defiUsageItem = { mint: QQQX, integrations: [{ category: 'lending', protocolId: 'loopscale', protocolName: 'Loopscale', id: 'loopscale:collateral' }] };
        const rows = lenderRowsFor(QQQX, ctx({ defiUsageItem }));
        const loopscale = rows.find((r) => r.protocolId === 'loopscale');
        expect(loopscale.label).toBe('not researched');
        expect(loopscale.liquidationLtvPct).toBeNull();
    });

    test('SECZ is priced once a day: frozen at close, 40 % liquidation', () => {
        const [row] = lenderRowsFor(SECZ, ctx());
        expect(row).toMatchObject({ protocolId: 'loopscale', labelKind: 'frozen-at-close', liquidationLtvPct: 40 });
        expect(row.sentence).toMatch(/end-of-day price/);
    });

    test('Ondo SPYon on Nest is a signed quote', () => {
        const [row] = lenderRowsFor(SPYON, ctx());
        expect(row.label).toBe(LABEL_KINDS['signed-quote']);
        expect(row.liquidationLtvPct).toBe(80);
    });
});

describe('freezeSummary', () => {
    test('lists episodes of 20 min or more in the window with their length, and counts the shorter ones', () => {
        const summary = freezeSummary({ freezeRows: FREEZES, scanRows: SCAN, marketId: 'jupiter-lend:xstocks-vaults', mint: QQQX, protocolId: 'jupiter-lend', freezesRead: true, asOf: AS_OF });
        expect(summary.read).toBe(true);
        expect(summary.episodes.map((e) => [e.startedAt, e.highHours, e.cause])).toEqual([
            ['2026-09-24T08:38:00Z', 0.5, null],
            ['2026-09-19T17:29:01Z', 43, 'operator-suspension']
        ]);
        expect(summary.coverage.readTo).toBe('2026-09-24T19:01:21Z');
        const nvda = freezeSummary({ freezeRows: FREEZES, scanRows: SCAN, marketId: 'jupiter-lend:xstocks-vaults', mint: NVDAX, protocolId: 'jupiter-lend', freezesRead: true, asOf: AS_OF });
        expect(nvda.episodes).toEqual([]);
        expect(nvda.shorter).toBe(1);
    });

    test('an episode that ended before the window is left out; an ongoing one never is', () => {
        const old = [{ ...FREEZES[1], started_at: '2026-08-01T00:00:00Z', ended_at: '2026-08-02T00:00:00Z' }, FREEZES[4]];
        expect(freezeSummary({ freezeRows: old, scanRows: [], marketId: 'jupiter-lend:xstocks-vaults', mint: QQQX, protocolId: 'jupiter-lend', freezesRead: true, asOf: AS_OF }).episodes).toEqual([]);
        const ongoing = freezeSummary({ freezeRows: old, scanRows: [], marketId: 'loopscale:xstocks-orca-vaults', mint: NVDAX, protocolId: 'loopscale', freezesRead: true, asOf: AS_OF });
        expect(ongoing.episodes).toHaveLength(1);
        expect(ongoing.episodes[0].ongoing).toBe(true);
    });

    test('not read is not "no freezes", and Nest is not watched for freezes at all', () => {
        expect(freezeSummary({ freezeRows: [], scanRows: [], marketId: 'kamino:xstocks-pool', mint: NVDAX, protocolId: 'kamino', freezesRead: false, asOf: AS_OF }))
            .toEqual({ read: false, watched: true, coverage: null, episodes: [], shorter: 0 });
        expect(freezeSummary({ freezeRows: FREEZES, scanRows: SCAN, marketId: 'nest:xstocks-pyth-lazer', mint: NVDAX, protocolId: 'nest', freezesRead: true, asOf: AS_OF }).watched).toBe(false);
    });

    test('coverage says how far the Kamino backfill has read', () => {
        expect(coverageFor(SCAN, 'kamino:xstocks-pool', NVDAX)).toEqual({ readTo: '2026-09-17T13:11:37Z', checkedAt: '2026-09-24T19:05:52Z', since: '2026-09-16T00:00:00Z' });
        expect(coverageFor(SCAN, 'kamino:xstocks-pool', QQQX)).toBeNull();
    });
});

describe('Monday gaps, depth, weekend move', () => {
    const gapDoc = { weekends: [
        { marketId: 'kamino:xstocks-pool', mint: NVDAX, closeAt: '2026-09-11T21:00:00Z', closeValue: 200, reopenAt: '2026-09-14T14:00:00Z', reopenValue: 198, gapPct: -1, movedWhileClosedPct: 0 },
        { marketId: 'kamino:xstocks-pool', mint: NVDAX, closeAt: '2026-09-18T21:00:00Z', closeValue: 222.3476, reopenAt: '2026-09-21T14:00:00Z', reopenValue: 224.5664, gapPct: 0.99788, movedWhileClosedPct: 0 },
        { marketId: 'kamino:xstocks-pool', mint: QQQX, closeAt: '2026-09-18T21:00:00Z', closeValue: 1, reopenAt: '2026-09-21T14:00:00Z', reopenValue: 1, gapPct: null }
    ] };

    test('gapsFor: newest first, only real gaps, rounded', () => {
        expect(gapsFor(gapDoc, 'kamino:xstocks-pool', NVDAX).map((g) => [g.reopenAt, g.gapPct])).toEqual([
            ['2026-09-21T14:00:00Z', 1], ['2026-09-14T14:00:00Z', -1]
        ]);
        expect(gapsFor(gapDoc, 'kamino:xstocks-pool', QQQX)).toEqual([]);
        const row = lenderRowsFor(NVDAX, ctx({ gapDoc, gapsRead: true })).find((r) => r.marketId === 'kamino:xstocks-pool');
        expect(row.mondayGaps.read).toBe(true);
        expect(row.mondayGaps.weeks).toHaveLength(2);
        // Jupiter Lend's weekly re-mark is Sunday evening, and no history of its price is collected.
        expect(lenderRowsFor(NVDAX, ctx()).find((r) => r.protocolId === 'jupiter-lend').mondayGaps)
            .toEqual({ read: true, weeks: [], unmeasured: 're-marked Sunday 20:00 ET; not measured' });
        expect(lenderRowsFor(NVDAX, ctx()).find((r) => r.protocolId === 'nest').mondayGaps).toBeNull();
    });

    test('depthFor: the newest weekday and weekend sample, nothing older than 14 days', () => {
        const depthDoc = { samples: [
            { at: '2026-09-24T19:40:00Z', session: 'open', mint: NVDAX, priceUsd: 225, at5Pct: { usd: 300000, bound: 'interpolated' }, at10Pct: { usd: 700000, bound: 'interpolated' } },
            { at: '2026-09-23T02:00:00Z', session: 'closed', mint: NVDAX, priceUsd: 220, at5Pct: { usd: 1, bound: 'interpolated' }, at10Pct: null },
            { at: '2026-09-01T12:00:00Z', session: 'weekend', mint: NVDAX, priceUsd: 200, at5Pct: { usd: 5, bound: 'interpolated' }, at10Pct: null }
        ] };
        const d = depthFor(depthDoc, NVDAX, '2026-09-24T20:00:00Z');
        expect(d.read).toBe(true);
        expect(d.weekday.at).toBe('2026-09-24T19:40:00Z');
        expect(d.weekday.at5Pct).toEqual({ usd: 300000, bound: 'interpolated' });
        expect(d.weekend).toBeNull();
        expect(depthFor(null, NVDAX, AS_OF)).toEqual({ read: false, weekday: null, weekend: null });
    });

    const tracking = { premium: {
        schedules: [{ closed: [['2026-09-17T20:00:00Z', '2026-09-18T13:30:00Z', 0], ['2026-09-18T20:00:00Z', '2026-09-21T13:30:00Z', 0], ['2026-09-21T20:00:00Z', '2026-09-22T13:30:00Z', 0]] }],
        underlyings: [{ ticker: 'SPY', wrappers: [{ mint: SPYON, points: [
            { kind: 'snapshot', t: '2026-09-18T19:00:00Z', p: 0.1, n: 1 },
            { kind: 'snapshot', t: '2026-09-19T23:44:02Z', p: 0.8, n: 1 },
            { kind: 'trades', t: '2026-09-20T18:27:22Z', p: -2.5, n: 12 },
            { kind: 'snapshot', t: '2026-09-21T02:00:00Z', p: 1.2, n: 1 },
            { kind: 'snapshot', t: '2026-09-21T18:00:00Z', p: 9.9, n: 1 }
        ] }] }]
    } };

    test('latestWeekend is the newest closed stretch that contains a Saturday', () => {
        expect(latestWeekend(tracking)).toMatchObject({ from: '2026-09-18T20:00:00Z', to: '2026-09-21T13:30:00Z' });
        expect(latestWeekend(null)).toBeNull();
    });

    test('weekendMoveFor: the points inside the weekend only, median and widest', () => {
        const move = weekendMoveFor(tracking, SPYON, latestWeekend(tracking));
        expect(move).toEqual({ weekendFrom: '2026-09-18T20:00:00Z', weekendTo: '2026-09-21T13:30:00Z', observations: 3, trades: 12, medianPct: 0.8, widestPct: -2.5, widestAt: '2026-09-20T18:27:22Z' });
        expect(weekendMoveFor(tracking, NVDAX, latestWeekend(tracking))).toBeNull();
    });

    test('the weekend move is kept only where a lender prices from the token (Nest), and dropped elsewhere', () => {
        const tokens = [{ mint: SPYON, symbol: 'SPYon' }, { mint: SECZ, symbol: 'SECZ' }, { mint: NOBODY, symbol: 'NONE' }];
        const { items } = buildClosedMarket({ tokens, oraclePricing, defiUsage: { items: [] }, freezeRows: FREEZES, scanRows: SCAN, freezesRead: true, gapDoc: null, depthDoc: null, tracking, findingTypes, asOf: AS_OF });
        const byMint = new Map(items.map((i) => [i.mint, i]));
        expect(byMint.get(SPYON).weekendMove.move.medianPct).toBe(0.8);
        expect(byMint.get(SECZ).weekendMove).toBeNull();
        // A token no lender takes has no item at all; the card says so in one line.
        expect(byMint.has(NOBODY)).toBe(false);
    });
});

describe('findings', () => {
    const lendersOf = (mint) => lenderRowsFor(mint, ctx());

    test('NVDAx carries the token-trading, stale-oracle and docs-fallback findings with sources', () => {
        const found = tokenFindings({ mint: NVDAX, symbol: 'NVDAx', lenders: lendersOf(NVDAX), oraclePricing, findingTypes });
        const schemas = found.map((f) => f.schema);
        expect(schemas).toEqual(expect.arrayContaining([FINDING_SCHEMAS.tokenTrading, FINDING_SCHEMAS.staleOracle, FINDING_SCHEMAS.docsFallback]));
        expect(schemas).not.toContain(FINDING_SCHEMAS.corporateAction);
        const stale = found.find((f) => f.schema === FINDING_SCHEMAS.staleOracle);
        expect(stale.severity).toBe('warning');
        expect(stale.statement).toMatch(/26 Aug 2026/);
        expect(found.find((f) => f.schema === FINDING_SCHEMAS.docsFallback).source.url).toBe('https://kamino.com/docs/security/oracles.md');
    });

    test('QQQx and METAx carry the corporate-action suspension from the dated on-chain episodes', () => {
        const qqq = tokenFindings({ mint: QQQX, symbol: 'QQQx', lenders: lendersOf(QQQX), oraclePricing, findingTypes })
            .find((f) => f.schema === FINDING_SCHEMAS.corporateAction);
        expect(qqq.statement).toMatch(/Kamino and Jupiter Lend .* about 44 h/);
        expect(qqq.source.url).toMatch(/^https:\/\/solscan\.io\/tx\/26SQ52zV/);
        const metaMint = 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu';
        const meta = tokenFindings({ mint: metaMint, symbol: 'METAx', lenders: lenderRowsFor(metaMint, ctx()), oraclePricing, findingTypes })
            .find((f) => f.schema === FINDING_SCHEMAS.corporateAction);
        expect(meta.statement).toMatch(/about 65 h/);
    });

    test('a later operator suspension the watcher records becomes a finding too, linked to the resume transaction', () => {
        const rows = [...FREEZES, { protocol: 'jupiter-lend', market_id: 'jupiter-lend:xstocks-vaults', mint: TSLAX, symbol: 'TSLAx', started_at: '2026-09-22T17:00:00Z', ended_at: '2026-09-23T12:00:00Z', last_seen_stale_at: null, observation: 'jl-cache-refresh-gap', cause: 'operator-suspension', end_basis: 'next-refresh', end_signature: 'ResumeSig111' }];
        const lenders = lenderRowsFor(TSLAX, ctx({ freezeRows: rows }));
        const found = tokenFindings({ mint: TSLAX, symbol: 'TSLAx', lenders, oraclePricing, findingTypes }).filter((f) => f.schema === FINDING_SCHEMAS.corporateAction);
        expect(found).toHaveLength(1);
        expect(found[0].statement).toMatch(/^Jupiter Lend xStock vaults stopped updating the TSLAx collateral price for about 19 h/);
        expect(found[0].source.url).toBe('https://solscan.io/tx/ResumeSig111');
        // QQQx's Jupiter Lend episode is the one the research already dated: not told twice.
        const qqq = tokenFindings({ mint: QQQX, symbol: 'QQQx', lenders: lendersOf(QQQX), oraclePricing, findingTypes }).filter((f) => f.schema === FINDING_SCHEMAS.corporateAction);
        expect(qqq).toHaveLength(1);
    });

    test('a finding type missing from finding-types.json is never emitted', () => {
        expect(tokenFindings({ mint: NVDAX, symbol: 'NVDAx', lenders: lendersOf(NVDAX), oraclePricing, findingTypes: [] })).toEqual([]);
    });

    test('all four emitted types exist in finding-types.json', () => {
        const slugs = new Set(findingTypes.map((t) => t.schema));
        for (const schema of Object.values(FINDING_SCHEMAS)) expect(slugs.has(schema)).toBe(true);
    });
});

describe('buildClosedMarket / payload / SQL', () => {
    test('summarize counts the label kinds and findings', () => {
        const tokens = [{ mint: NVDAX, symbol: 'NVDAx' }, { mint: QQQX, symbol: 'QQQx' }];
        const { items } = buildClosedMarket({ tokens, oraclePricing, defiUsage: null, freezeRows: FREEZES, scanRows: SCAN, freezesRead: true, gapDoc: null, depthDoc: null, tracking: null, findingTypes, asOf: AS_OF });
        const stats = summarize(items);
        expect(stats.tokens).toBe(2);
        expect(stats.byKind['frozen-at-close']).toBe(4);
        expect(stats.byKind.stale).toBe(1);
        expect(stats.freezeEpisodes).toBe(3);
        expect(items[0].depth).toEqual({ read: false, weekday: null, weekend: null });
    });

    test('the payload states what is not measured', () => {
        const payload = buildPayload({ generatedAt: AS_OF, asOf: AS_OF, researchReviewedAt: oraclePricing.reviewedAt, inputs: {}, weekend: null, items: [] });
        expect(payload.method).toMatch(/Exposure \(collateral within the gap of liquidation\) is not measured/);
        expect(payload.freezeWindowDays).toBe(30);
    });

    test('the SQL inlines only an ISO UTC instant', () => {
        expect(closedMarketRowsPsql({ since: '2026-08-25T19:00:00Z' })).toMatch(/'2026-08-25T19:00:00Z'::timestamptz/);
        expect(() => closedMarketRowsPsql({ since: "2026-08-25'; DROP TABLE x; --" })).toThrow(/ISO UTC instant/);
    });
});
