// Unit tests for the pure section of monitor.js — the shaping behind monitor.html's health monitor.
// Every test asserts an outcome a reader would notice if it broke: that a missing measurement sorts
// LAST rather than heading the descending liquidity column, that the tiles take their counts from
// the health file rather than recounting and drifting, that the change log is grouped in the order
// the diff declares rather than in a copy kept here, that a Meteora pool the trade collector never
// reached shows a dash instead of a 0 % failure rate, and that a card link is built from
// cards/index.json when it names the mint. The health rules themselves are NOT tested here: they
// live in stocks/lib/health.mjs and are covered by stocks/health.test.js — this page only displays
// what that file decided.

const M = require('./monitor.js');

/** A stocks-health.json shaped small enough to assert by hand. */
function health() {
    return {
        generatedAt: '2026-09-16T23:07:00Z',
        counts: { good: 1, caution: 1, warning: 2, unknown: 1 },
        byWorstRule: { liquidity: 2, concentration: 1, tracking: 0, spread: 1 },
        rules: [
            { id: 'tracking', label: 'Price tracking' },
            { id: 'liquidity', label: 'Pool liquidity' },
            { id: 'concentration', label: 'Holder concentration' },
            { id: 'spread', label: 'Venue spread' }
        ],
        items: [
            { mint: 'MINT_A', symbol: 'AAPLx', issuer: 'xstocks-backed', status: 'warning', worstRuleId: 'liquidity', rules: {}, values: {} },
            { mint: 'MINT_B', symbol: 'TSLAx', issuer: 'xstocks-backed', status: 'good', worstRuleId: 'tracking', rules: {}, values: {} },
            { mint: 'MINT_C', symbol: 'AAPLon', issuer: 'ondo-global-markets', status: 'caution', worstRuleId: 'concentration', rules: {}, values: {} },
            { mint: 'MINT_D', symbol: 'SPCXx', issuer: 'xstocks-backed', status: 'warning', worstRuleId: 'spread', rules: {}, values: {} },
            { mint: 'MINT_E', symbol: 'GHOST', issuer: 'remora-markets', status: 'unknown', worstRuleId: null, rules: {}, values: {} }
        ]
    };
}

/** A stocks-tokens.json with one token deliberately absent (MINT_E), to prove nulls survive. */
function tokens() {
    return {
        builtAt: '2026-09-16T22:57:26Z',
        issuerIndex: {
            'xstocks-backed': { name: 'Backed (xStocks)', status: 'live' },
            'ondo-global-markets': { name: 'Ondo Global Markets', status: 'live' }
        },
        tokens: [
            {
                mint: 'MINT_A', symbol: 'AAPLx', name: 'Apple xStock', issuer: 'xstocks-backed',
                market: { liquidity: 4000, vol24: 12000 }, activity: { venueSpreadPct: 0.52, lastTradedAt: '2026-09-16T20:12:30Z' },
                reference: { premiumPct: -0.28, price: 241, source: 'pyth' }, holders: { top1SharePct: 48.7 }
            },
            {
                mint: 'MINT_B', symbol: 'TSLAx', name: 'Tesla xStock', issuer: 'xstocks-backed',
                market: { liquidity: 900000 }, activity: { venueSpreadPct: 6.1, lastTradedAt: '2026-09-16T22:00:00Z' },
                reference: { premiumPct: 0.9, price: 430 }, holders: { top1SharePct: 12.1 }
            },
            {
                mint: 'MINT_C', symbol: 'AAPLon', name: 'Apple (Ondo Tokenized)', issuer: 'ondo-global-markets',
                market: { liquidity: 892.057 }, activity: { venueSpreadPct: null, lastTradedAt: null },
                reference: { premiumPct: null, price: null }, holders: { top1SharePct: 99.1 }
            },
            {
                mint: 'MINT_D', symbol: 'SPCXx', name: 'SpaceX xStock', issuer: 'xstocks-backed',
                market: { liquidity: 50000 }, activity: { venueSpreadPct: 5.33, lastTradedAt: '2026-09-16T18:00:00Z' },
                reference: { premiumPct: 2.5, price: 210 }, holders: { top1SharePct: null }
            }
        ]
    };
}

function afterhours() {
    return {
        items: [
            { mint: 'MINT_A', gapPct: -1.4, openPremiumPct: 0.2, closedPremiumPct: -1.2 },
            { mint: 'MINT_B', gapPct: null, openPremiumPct: null, closedPremiumPct: -0.3 }
        ]
    };
}

function rows() {
    return M.monitorRows({ health: health(), tokens: tokens(), afterhours: afterhours() });
}

// -------------------------------------------------------------------- rows

describe('monitorRows', () => {
    test('health is the spine: one row per health item, even for a mint absent from the token build', () => {
        const out = rows();
        expect(out).toHaveLength(5);
        const ghost = out.find((row) => row.mint === 'MINT_E');
        expect(ghost.status).toBe('unknown');
        // Nothing measured, and nothing invented: every market number is null, not 0.
        expect(ghost.liquidity).toBeNull();
        expect(ghost.premiumPct).toBeNull();
        expect(ghost.venueSpreadPct).toBeNull();
        expect(ghost.gapPct).toBeNull();
        expect(ghost.lastTradedAt).toBeNull();
    });

    test('joins the market numbers, the reference premium and the after-hours gap by mint', () => {
        const row = rows().find((r) => r.mint === 'MINT_A');
        expect(row).toMatchObject({
            symbol: 'AAPLx',
            issuer: 'xstocks-backed',
            issuerName: 'Backed (xStocks)',
            status: 'warning',
            worstRuleId: 'liquidity',
            worstRuleLabel: 'Pool liquidity',
            liquidity: 4000,
            premiumPct: -0.28,
            venueSpreadPct: 0.52,
            gapPct: -1.4,
            top1SharePct: 48.7,
            lastTradedAt: '2026-09-16T20:12:30Z'
        });
    });

    test('a mint with no after-hours record, or a null gap, keeps a null gap rather than 0', () => {
        const byMint = new Map(rows().map((row) => [row.mint, row]));
        expect(byMint.get('MINT_B').gapPct).toBeNull();
        expect(byMint.get('MINT_D').gapPct).toBeNull();
    });

    test('the worst-rule LABEL comes from the health file, so the page never names a rule itself', () => {
        const withoutLabels = M.monitorRows({
            health: { ...health(), rules: [] },
            tokens: tokens(),
            afterhours: afterhours()
        });
        // No labels published: the id is shown verbatim rather than a phrase invented here.
        expect(withoutLabels.find((row) => row.mint === 'MINT_A').worstRuleLabel).toBe('liquidity');
    });

    test('an issuer the token build does not index is humanized rather than left blank', () => {
        const row = rows().find((r) => r.mint === 'MINT_E');
        expect(row.issuer).toBe('remora-markets');
        expect(row.issuerName).toBe('Remora markets');
    });

    test('issuerIndex is read as the ARRAY it actually is, not only as a slug-keyed object', () => {
        // stocks-tokens.json writes issuerIndex as [{slug, name, …}] despite the name. Reading only
        // the object shape misses every lookup SILENTLY: no error, just "Xstocks backed" everywhere.
        const asArray = { issuerIndex: [{ slug: 'xstocks-backed', name: 'Backed (xStocks)' }], tokens: [] };
        expect(M.issuerNames(asArray).get('xstocks-backed')).toBe('Backed (xStocks)');
        const asObject = { issuerIndex: { 'xstocks-backed': { name: 'Backed (xStocks)' } }, tokens: [] };
        expect(M.issuerNames(asObject).get('xstocks-backed')).toBe('Backed (xStocks)');
        expect(M.issuerNames(null).size).toBe(0);
        // And the rows built from the real array shape carry the published name, not the slug.
        const out = M.monitorRows({ health: health(), tokens: { ...tokens(), issuerIndex: [
            { slug: 'xstocks-backed', name: 'Backed (xStocks)' },
            { slug: 'ondo-global-markets', name: 'Ondo Global Markets' }
        ] } });
        expect(out.find((row) => row.mint === 'MINT_A').issuerName).toBe('Backed (xStocks)');
    });

    test('an unrecognised status is reported as unknown, never silently treated as good', () => {
        const out = M.monitorRows({
            health: { ...health(), items: [{ mint: 'MINT_X', symbol: 'X', status: 'probably fine' }] },
            tokens: tokens()
        });
        expect(out[0].status).toBe('unknown');
    });

    test('no sources at all yields no rows and throws nothing', () => {
        expect(M.monitorRows()).toEqual([]);
        expect(M.monitorRows({ health: null, tokens: null, afterhours: null })).toEqual([]);
    });
});

// ------------------------------------------------------------------- tiles

describe('statusTiles', () => {
    test('all four statuses always appear, in order, with the health file\'s own counts', () => {
        const tiles = M.statusTiles(health(), rows());
        expect(tiles.map((tile) => tile.status)).toEqual(['good', 'caution', 'warning', 'unknown']);
        expect(tiles.map((tile) => tile.count)).toEqual([1, 1, 2, 1]);
    });

    test('the counts are READ from the file, not recounted — a tile cannot disagree with what it filters', () => {
        // A file claiming 301 warnings must show 301 even if this page were handed three rows.
        const tiles = M.statusTiles({ ...health(), counts: { good: 23, caution: 117, warning: 301, unknown: 0 } }, rows());
        expect(tiles.find((tile) => tile.status === 'warning').count).toBe(301);
        expect(tiles.find((tile) => tile.status === 'unknown').count).toBe(0);
    });

    test('a file with no counts block falls back to counting the rows rather than showing nothing', () => {
        const tiles = M.statusTiles({ ...health(), counts: undefined }, rows());
        expect(tiles.find((tile) => tile.status === 'warning').count).toBe(2);
        expect(tiles.find((tile) => tile.status === 'unknown').count).toBe(1);
    });

    test('every tile carries a sentence, and the unknown one refuses to read as a pass', () => {
        for (const tile of M.statusTiles(health(), rows())) {
            expect(typeof tile.blurb).toBe('string');
            expect(tile.blurb.length).toBeGreaterThan(10);
        }
        expect(M.STATUS_BLURBS.unknown).toMatch(/not a clean bill of health/);
    });
});

// -------------------------------------------------------------- rule strip

describe('ruleStrip', () => {
    test('biggest first, rules that are nobody\'s worst left out, shares adding to 100', () => {
        const strip = M.ruleStrip(health());
        expect(strip.map((rule) => rule.id)).toEqual(['liquidity', 'concentration', 'spread']);
        expect(strip.map((rule) => rule.count)).toEqual([2, 1, 1]);
        // `tracking` is 0 in byWorstRule and must not occupy a slot.
        expect(strip.some((rule) => rule.id === 'tracking')).toBe(false);
        expect(strip.reduce((sum, rule) => sum + rule.share, 0)).toBeCloseTo(100, 6);
        expect(strip[0].label).toBe('Pool liquidity');
    });

    test('an empty or missing byWorstRule is an empty strip, not a crash', () => {
        expect(M.ruleStrip({ byWorstRule: {} })).toEqual([]);
        expect(M.ruleStrip(null)).toEqual([]);
    });
});

// ----------------------------------------------------------------- filters

describe('filterRows', () => {
    const all = rows();

    test('no filters returns everything', () => {
        expect(M.filterRows(all, {})).toHaveLength(5);
        expect(M.filterRows(all)).toHaveLength(5);
    });

    test('the status filter matches the token status', () => {
        expect(M.filterRows(all, { status: 'warning' }).map((r) => r.symbol)).toEqual(['AAPLx', 'SPCXx']);
        expect(M.filterRows(all, { status: 'unknown' }).map((r) => r.symbol)).toEqual(['GHOST']);
    });

    test('the rule filter matches the WORST rule only, which is what the column and the strip show', () => {
        expect(M.filterRows(all, { rule: 'liquidity' }).map((r) => r.symbol)).toEqual(['AAPLx']);
        expect(M.filterRows(all, { rule: 'spread' }).map((r) => r.symbol)).toEqual(['SPCXx']);
    });

    test('the issuer filter matches the slug, so two issuers with similar names cannot merge', () => {
        expect(M.filterRows(all, { issuer: 'ondo-global-markets' }).map((r) => r.symbol)).toEqual(['AAPLon']);
    });

    test('search matches symbol, name, issuer or mint, case-insensitively', () => {
        expect(M.filterRows(all, { search: 'aapl' }).map((r) => r.symbol)).toEqual(['AAPLx', 'AAPLon']);
        expect(M.filterRows(all, { search: 'Tesla' }).map((r) => r.symbol)).toEqual(['TSLAx']);
        expect(M.filterRows(all, { search: 'MINT_D' }).map((r) => r.symbol)).toEqual(['SPCXx']);
        expect(M.filterRows(all, { search: 'ondo' }).map((r) => r.symbol)).toEqual(['AAPLon']);
        expect(M.filterRows(all, { search: '   ' })).toHaveLength(5);
        expect(M.filterRows(all, { search: 'nothing matches this' })).toHaveLength(0);
    });

    test('filters combine, so a status and an issuer narrow together', () => {
        expect(M.filterRows(all, { status: 'warning', issuer: 'xstocks-backed' }).map((r) => r.symbol))
            .toEqual(['AAPLx', 'SPCXx']);
        expect(M.filterRows(all, { status: 'good', issuer: 'ondo-global-markets' })).toHaveLength(0);
    });
});

// ------------------------------------------------------------------ sorting

describe('sortRows', () => {
    const all = rows();

    test('descending liquidity puts the largest pool first and the UNMEASURED ones last', () => {
        const sorted = M.sortRows(all, 'liquidity', 'desc');
        expect(sorted.map((row) => row.symbol)).toEqual(['TSLAx', 'SPCXx', 'AAPLx', 'AAPLon', 'GHOST']);
        // GHOST has no liquidity at all; heading the column it would read as the largest pool.
        expect(sorted[sorted.length - 1].liquidity).toBeNull();
    });

    test('ascending liquidity ALSO puts the unmeasured ones last, not first', () => {
        const sorted = M.sortRows(all, 'liquidity', 'asc');
        expect(sorted.map((row) => row.symbol)).toEqual(['AAPLon', 'AAPLx', 'SPCXx', 'TSLAx', 'GHOST']);
    });

    test('status sorts by severity, good first ascending, and unknown last in both directions', () => {
        expect(M.sortRows(all, 'status', 'asc').map((row) => row.status))
            .toEqual(['good', 'caution', 'warning', 'warning', 'unknown']);
        expect(M.sortRows(all, 'status', 'desc').map((row) => row.status))
            .toEqual(['warning', 'warning', 'caution', 'good', 'unknown']);
    });

    test('text columns sort case-insensitively and a blank sorts last', () => {
        expect(M.sortRows(all, 'symbol', 'asc').map((row) => row.symbol))
            .toEqual(['AAPLon', 'AAPLx', 'GHOST', 'SPCXx', 'TSLAx']);
    });

    test('ties break on the mint, so the same rows always render in the same order', () => {
        const tied = [
            { mint: 'ZZZ', symbol: 'A', liquidity: 5 },
            { mint: 'AAA', symbol: 'B', liquidity: 5 }
        ];
        expect(M.sortRows(tied, 'liquidity', 'desc').map((row) => row.mint)).toEqual(['AAA', 'ZZZ']);
        expect(M.sortRows(tied, 'liquidity', 'asc').map((row) => row.mint)).toEqual(['AAA', 'ZZZ']);
    });

    test('an unknown sort key leaves the order alone instead of throwing', () => {
        expect(M.sortRows(all, 'nope', 'desc').map((row) => row.mint)).toEqual(all.map((row) => row.mint));
    });

    test('every sortable column the table declares has a reader here', () => {
        expect(Object.keys(M.SORT_KEYS).sort()).toEqual(
            ['gap', 'issuer', 'lastTrade', 'liquidity', 'premium', 'rule', 'spread', 'status', 'symbol', 'top1']
        );
    });
});

// -------------------------------------------------------------- card links

describe('cardHref and buildCardIndex', () => {
    test('cards/index.json wins when it names the mint, so a collision the builder resolved is honoured', () => {
        const index = M.buildCardIndex({ cards: [{ mint: 'MINT_A', slug: 'AAPLx-xstocks' }] });
        expect(M.cardHref('AAPLx', 'MINT_A', index)).toBe('./cards/AAPLx-xstocks.html');
    });

    test('falls back to the symbol when the index is absent or silent about this mint', () => {
        expect(M.cardHref('AAPLx', 'MINT_A', null)).toBe('./cards/AAPLx.html');
        expect(M.cardHref('AAPLx', 'MINT_A', M.buildCardIndex(null))).toBe('./cards/AAPLx.html');
    });

    test('a symbol that is not path-safe is sanitised rather than written into a URL raw', () => {
        // A space and a slash in a symbol would otherwise escape the cards directory entirely.
        expect(M.cardHref('t Open/AI', 'MINT_A', null)).toBe('./cards/t-Open-AI.html');
        expect(M.cardHref('../../etc/passwd', 'MINT_A', null)).toBe('./cards/etc-passwd.html');
    });

    test('a mint with neither a slug nor a symbol gets no link at all, rather than ./cards/.html', () => {
        expect(M.cardHref(null, null, null)).toBeNull();
        expect(M.cardHref('', '', null)).toBeNull();
    });

    test('buildCardIndex reads a list under cards, under items, a bare list, or a mint→file map', () => {
        expect(M.buildCardIndex({ items: [{ mint: 'M', slug: 'S' }] }).get('M')).toBe('S');
        expect(M.buildCardIndex([{ mint: 'M', file: 'S.html' }]).get('M')).toBe('S');
        expect(M.buildCardIndex({ M: 'S.html' }).get('M')).toBe('S');
        expect(M.buildCardIndex('nonsense').size).toBe(0);
    });

    test('the page links every row it can, so a card is reachable from the table', () => {
        const linked = rows().filter((row) => row.href !== null);
        expect(linked).toHaveLength(5);
        expect(linked.find((row) => row.symbol === 'GHOST').href).toBe('./cards/GHOST.html');
    });
});

// ------------------------------------------------------------- change log

describe('groupChanges and dayCounts', () => {
    const kinds = [
        { id: 'paused', label: 'Trading paused' },
        { id: 'liquidity-drop', label: 'Pool liquidity halved or worse' },
        { id: 'spread-wide', label: 'Venue spread crossed 5 %' }
    ];
    const changes = [
        { kind: 'spread-wide', mint: 'MINT_D', symbol: 'SPCXx', field: 'venueSpreadPct', before: 4.8, after: 5.3, note: 'crossed' },
        { kind: 'paused', mint: 'MINT_A', symbol: 'AAPLx', field: 'paused', before: false, after: true, note: 'paused' },
        { kind: 'spread-wide', mint: 'MINT_B', symbol: 'TSLAx', field: 'venueSpreadPct', before: 4.9, after: 6.1, note: 'crossed' }
    ];

    test('groups in the order the DIFF declares, not in the order the changes arrived', () => {
        const groups = M.groupChanges(changes, kinds);
        expect(groups.map((group) => group.id)).toEqual(['paused', 'spread-wide']);
        expect(groups.map((group) => group.label)).toEqual(['Trading paused', 'Venue spread crossed 5 %']);
        expect(groups[1].items.map((change) => change.symbol)).toEqual(['SPCXx', 'TSLAx']);
    });

    test('a kind with no changes gets no section', () => {
        expect(M.groupChanges(changes, kinds).some((group) => group.id === 'liquidity-drop')).toBe(false);
    });

    test('a kind the file does not declare is still shown, at the end, rather than dropped silently', () => {
        const groups = M.groupChanges([...changes, { kind: 'brand-new-kind', mint: 'M', symbol: 'X' }], kinds);
        const last = groups[groups.length - 1];
        expect(last.id).toBe('brand-new-kind');
        expect(last.label).toBe('Brand new kind');
    });

    test('no kinds published at all still groups every change rather than showing none', () => {
        const groups = M.groupChanges(changes, null);
        expect(groups.map((group) => group.id).sort()).toEqual(['paused', 'spread-wide']);
        expect(groups.reduce((sum, group) => sum + group.items.length, 0)).toBe(3);
    });

    test('dayCounts totals each pair and names the kinds, oldest first', () => {
        const days = M.dayCounts([
            { from: '2026-09-15', to: '2026-09-16', counts: { paused: 1, 'liquidity-drop': 2 } },
            { from: '2026-09-16', to: '2026-09-17', counts: {} }
        ]);
        expect(days).toHaveLength(2);
        expect(days[0]).toMatchObject({ from: '2026-09-15', to: '2026-09-16', total: 3 });
        expect(days[0].counts).toEqual([{ kind: 'paused', count: 1 }, { kind: 'liquidity-drop', count: 2 }]);
        expect(days[1].total).toBe(0);
        expect(days[1].counts).toEqual([]);
    });

    test('an absent history is an empty strip', () => {
        expect(M.dayCounts(null)).toEqual([]);
        expect(M.dayCounts([])).toEqual([]);
    });
});

// ------------------------------------------------------------------ events

describe('sortEvents', () => {
    test('newest first, whatever order the file is in', () => {
        const out = M.sortEvents([
            { date: '2026-01-28', kind: 'governance' },
            { date: '2026-09-16', kind: 'pause' },
            { date: '2026-06-12', kind: 'shortfall' }
        ]);
        expect(out.map((event) => event.date)).toEqual(['2026-09-16', '2026-06-12', '2026-01-28']);
    });

    test('does not mutate the array it was handed, and drops nothing but non-objects', () => {
        const input = [{ date: '2026-01-01' }, null, { date: '2026-02-01' }];
        const out = M.sortEvents(input);
        expect(input[0].date).toBe('2026-01-01');
        expect(out).toHaveLength(2);
        expect(M.sortEvents(null)).toEqual([]);
    });
});

// ----------------------------------------------------------- Meteora pools

describe('meteoraRows', () => {
    function meteora() {
        return {
            items: [
                {
                    mint: 'MINT_A', symbol: 'AAPLx', issuer: 'xstocks-backed', pairAddress: 'PAIR_A',
                    dexId: 'meteora', poolType: 'dlmm', binStep: 80, baseFeePct: 0.1, maxFeePct: 0, dynamicFeePct: 0.0048,
                    liquidityUsd: 2426800, volume24Usd: 2629890, fees24Usd: 2437.9, priceUsd: 253.05,
                    quoteSymbol: 'USDC', dexscreener: { liquidityUsd: 2417756, volume24Usd: 1769347, txns24: 1858 },
                    curve: null, error: null
                },
                {
                    mint: 'MINT_B', symbol: 'TSLAx', issuer: 'xstocks-backed', pairAddress: 'PAIR_B',
                    dexId: 'meteora', poolType: 'dlmm', binStep: 20, baseFeePct: 0.2,
                    liquidityUsd: 4459042, volume24Usd: 2969379, fees24Usd: 5370, priceUsd: 430,
                    quoteSymbol: 'USDC', dexscreener: {}, curve: null, error: null
                },
                {
                    mint: 'MINT_C', symbol: 'AAPLon', issuer: 'ondo-global-markets', pairAddress: 'PAIR_C',
                    dexId: 'meteoradbc', poolType: 'dbc', binStep: null, baseFeePct: null,
                    liquidityUsd: null, volume24Usd: null, fees24Usd: null, priceUsd: null,
                    quoteSymbol: 'AU', dexscreener: { liquidityUsd: null, volume24Usd: 0, txns24: 2 },
                    curve: {
                        address: 'PAIR_C',
                        tokenX: { symbol: 'AU' }, tokenY: { symbol: 'AAPLon' },
                        account: { exists: true, owner: 'dbcij', dataLength: 424, isDbcProgram: true },
                        curveState: null, migrated: null,
                        note: 'the pool account layout was NOT decoded'
                    },
                    error: null
                }
            ]
        };
    }

    function trades() {
        return {
            pools: [
                { pair: 'PAIR_A', mint: 'MINT_A', signaturesSeen: 50, failedTx: 19, decoded: 0 },
                { pair: 'PAIR_C', mint: 'MINT_C', signaturesSeen: 0, failedTx: 0, decoded: 0 }
            ],
            trades: [
                { pair: 'PAIR_A', time: '2026-09-16T22:00:00Z', mint: 'MINT_A' },
                { pair: 'PAIR_A', time: '2026-09-16T22:47:35Z', mint: 'MINT_A' },
                { pair: 'PAIR_A', time: '2026-09-16T21:00:00Z', mint: 'MINT_A' }
            ]
        };
    }

    function pools() {
        return M.meteoraRows({ meteora: meteora(), tokens: tokens(), trades: trades() });
    }

    test('one row per pool, largest liquidity first, the unmeasured pool last', () => {
        expect(pools().map((pool) => pool.symbol)).toEqual(['TSLAx', 'AAPLx', 'AAPLon']);
    });

    test('carries the Meteora-only facts DexScreener does not report', () => {
        const pool = pools().find((p) => p.symbol === 'AAPLx');
        expect(pool).toMatchObject({
            poolType: 'dlmm', binStep: 80, baseFeePct: 0.1, dynamicFeePct: 0.0048,
            liquidityUsd: 2426800, volume24Usd: 2629890, fees24Usd: 2437.9,
            dexscreenerLiquidityUsd: 2417756
        });
    });

    test('premium is the pool price against the token reference price, in per cent', () => {
        // 253.05 against a 241 reference is +5.0 %.
        expect(pools().find((p) => p.symbol === 'AAPLx').premiumPct).toBeCloseTo(5.0, 1);
        // 430 against a 430 reference is exactly flat — a real 0, not a missing value.
        expect(pools().find((p) => p.symbol === 'TSLAx').premiumPct).toBe(0);
    });

    test('a pool with no price, or a token with no reference price, has a NULL premium not a 0 %', () => {
        expect(pools().find((p) => p.symbol === 'AAPLon').premiumPct).toBeNull();
        const noRef = M.meteoraRows({
            meteora: meteora(),
            tokens: { tokens: [{ mint: 'MINT_A', reference: { price: null } }] },
            trades: trades()
        });
        expect(noRef.find((p) => p.mint === 'MINT_A').premiumPct).toBeNull();
    });

    test('the failed share is the reverted portion of the sampled signatures', () => {
        const pool = pools().find((p) => p.symbol === 'AAPLx');
        expect(pool.signaturesSeen).toBe(50);
        expect(pool.failedTx).toBe(19);
        expect(pool.failedShare).toBe(38);
    });

    test('a pool the collector never reached shows a NULL failed share, never 0 %', () => {
        // TSLAx has no pools[] entry at all; AAPLon has one that sampled zero signatures.
        expect(pools().find((p) => p.symbol === 'TSLAx').failedShare).toBeNull();
        expect(pools().find((p) => p.symbol === 'AAPLon').failedShare).toBeNull();
    });

    test('the last trade is the newest trade on that pool, and null when there is none', () => {
        expect(pools().find((p) => p.symbol === 'AAPLx').lastTradeAt).toBe('2026-09-16T22:47:35Z');
        expect(pools().find((p) => p.symbol === 'TSLAx').lastTradeAt).toBeNull();
    });

    test('no Meteora file is no rows, not a crash', () => {
        expect(M.meteoraRows()).toEqual([]);
        expect(M.meteoraRows({ meteora: { items: [] }, tokens: tokens(), trades: trades() })).toEqual([]);
    });
});

describe('curveSummary', () => {
    test('reports existence, the owning program and the data length — and says the state is undecoded', () => {
        const summary = M.curveSummary({
            address: 'PAIR_C',
            tokenX: { symbol: 'AU' }, tokenY: { symbol: 'TSMon' },
            account: { exists: true, dataLength: 424, isDbcProgram: true },
            curveState: null, migrated: null,
            note: 'layout was NOT decoded'
        });
        expect(summary.text).toBe('curve account exists · 424 bytes of state · owned by the DBC program · state not decoded');
        expect(summary.pairName).toBe('AU / TSMon');
        expect(summary.note).toBe('layout was NOT decoded');
    });

    test('never implies a progress figure nobody read', () => {
        const summary = M.curveSummary({ account: { exists: true }, curveState: null });
        expect(summary.text).not.toMatch(/%|progress|threshold/i);
        expect(summary.text).toMatch(/state not decoded/);
    });

    test('a decoded state and a migration flag are reported when they are actually there', () => {
        const summary = M.curveSummary({ account: { exists: true }, curveState: { reserve: 1 }, migrated: true });
        expect(summary.text).toMatch(/state decoded/);
        expect(summary.text).toMatch(/migrated/);
    });

    test('a pool with no curve record has no curve line', () => {
        expect(M.curveSummary(null)).toBeNull();
        expect(M.curveSummary('nonsense')).toBeNull();
    });
});

// --------------------------------------------------------- filter options

describe('issuerOptions and ruleOptions', () => {
    test('issuer options are the issuers present, by display name, sorted, no duplicates', () => {
        expect(M.issuerOptions(rows())).toEqual([
            { slug: 'xstocks-backed', name: 'Backed (xStocks)' },
            { slug: 'ondo-global-markets', name: 'Ondo Global Markets' },
            { slug: 'remora-markets', name: 'Remora markets' }
        ]);
    });

    test('rule options are the health file\'s ten rules in ITS display order, not alphabetical', () => {
        expect(M.ruleOptions(health()).map((rule) => rule.id))
            .toEqual(['tracking', 'liquidity', 'concentration', 'spread']);
        expect(M.ruleOptions(null)).toEqual([]);
    });
});
