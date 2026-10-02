// Unit tests for stocks/lib/exits-view.js (exits.html's pure half) plus the page's static contract:
// the underlying picker and ?u= deep link, the shared-scale stacked bar, the redemption lane's
// wording per evidence state, table sort/filter with missing values last, and exits.html wiring.

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const V = require('./lib/exits-view.js');

const TOKENS = [
    { mint: 'A', symbol: 'NVDAx', issuer: 'xs', underlying: 'NVDA', venueCoverage: 'observed', dexLiquidityUsd: 2500,
        pools: [{ venue: 'raydium', venueName: 'Raydium', liquidityUsd: 2000 }, { venue: 'meteora', venueName: 'Meteora', liquidityUsd: 500 }], lending: [] },
    { mint: 'B', symbol: 'NVDAon', issuer: 'ondo', underlying: 'NVDA', venueCoverage: 'none-observed', dexLiquidityUsd: null, pools: [], lending: [],
        redemptionObservedForToken: false },
    { mint: 'C', symbol: 'TSLAon', issuer: 'ondo', underlying: 'TSLA', venueCoverage: 'not-collected', dexLiquidityUsd: null, pools: [],
        redemptionObservedForToken: true,
        lending: [{ protocol: 'Kamino', action: 'collateral', stage: 'decoded', maxLtv: { min: 0.55, max: 0.6 }, debt: ['USDC'], sizeUsd: null }] }
];
const ISSUERS = {
    xs: { slug: 'xs', name: 'Kraken xStocks', status: 'live', redemption: { state: 'operational', label: 'Route operationally available (official source)',
        documentedRight: true, kyc: true, operational: { value: true, checkedAt: '2026-09-22T16:15:00Z', url: 'https://x.example' }, observed: { value: false, feedText: 'No redemption observed in 1 day of continuous coverage.' }, minimum: { completeText: 'USD 5,000' } } },
    ondo: { slug: 'ondo', name: 'Ondo', status: 'live', redemption: { state: 'observed-onchain', label: 'Redemption observed on-chain', documentedRight: true, kyc: true,
        operational: { value: null }, observed: { value: true, latestObservedAt: '2026-09-23T19:36:44Z' }, minimum: null } }
};

describe('underlying picker', () => {
    const opts = V.underlyingOptions(TOKENS);

    it('lists underlyings deepest combined liquidity first, with wrapper and pool counts', () => {
        expect(opts).toEqual([{ ticker: 'NVDA', wrappers: 2, withPool: 1, liquidityUsd: 2500 }, { ticker: 'TSLA', wrappers: 1, withPool: 0, liquidityUsd: 0 }]);
        // A liquid single wrapper outranks a stock with more, thinner wrappers.
        const more = [...TOKENS, { mint: 'D', symbol: 'AAPLx', underlying: 'AAPL', venueCoverage: 'observed', dexLiquidityUsd: 900000 }];
        expect(V.underlyingOptions(more)[0].ticker).toBe('AAPL');
    });

    it('reads ?u= case-insensitively and falls back to NVDA for unknown tickers', () => {
        expect(V.selectedUnderlying('?u=tsla', opts)).toBe('TSLA');
        expect(V.selectedUnderlying('?u=NOPE', opts)).toBe('NVDA');
        expect(V.selectedUnderlying('', [{ ticker: 'AAPL' }])).toBe('AAPL');
        expect(V.selectedUnderlying('', [])).toBeNull();
    });

    it('orders wrappers deepest first with unknown depth last', () => {
        expect(V.wrappersOf(TOKENS, 'NVDA').map((t) => t.symbol)).toEqual(['NVDAx', 'NVDAon']);
    });
});

describe('stacked bar', () => {
    it('scales segments to the deepest wrapper and stacks them', () => {
        const bar = V.barSegments(TOKENS[0].pools, 5000);
        expect(bar.segments.map((s) => [s.venue, s.x, s.w])).toEqual([['raydium', 0, 40], ['meteora', 40, 10]]);
        expect(bar.totalPct).toBe(50);
    });

    it('draws nothing without a scale and never sums a missing pool figure', () => {
        expect(V.barSegments(TOKENS[0].pools, 0).segments).toEqual([]);
        const totals = V.venueTotals([{ venue: 'orca', venueName: 'Orca', liquidityUsd: null }]);
        expect(totals[0]).toMatchObject({ usd: null, pools: 1, unpriced: 1 });
        expect(V.barSegments([{ venue: 'orca', liquidityUsd: null }], 100).segments).toEqual([]);
    });

    it('keeps a visible sliver for a tiny venue', () => {
        expect(V.barSegments([{ venue: 'orca', liquidityUsd: 1 }], 1e9).segments[0].w).toBe(0.6);
    });
});

describe('route lanes', () => {
    it('states the programme route and that no capacity figure exists', () => {
        const lane = V.redemptionLane(TOKENS[0], ISSUERS.xs);
        expect(lane.state).toBe('operational');
        expect(lane.lines.join(' ')).toMatch(/KYC\/AML-approved/);
        expect(lane.lines.join(' ')).toMatch(/checked 2026-09-22T16:15:00Z/);
        expect(lane.lines.join(' ')).toMatch(/No capacity limit is stated/);
        expect(lane.url).toBe('https://x.example');
    });

    it('distinguishes this token observed from other programme products observed', () => {
        expect(V.redemptionLane(TOKENS[2], ISSUERS.ondo).lines.join(' ')).toMatch(/for TSLAon itself/);
        expect(V.redemptionLane(TOKENS[1], ISSUERS.ondo).lines.join(' ')).toMatch(/other Ondo products, not for NVDAon itself/);
        expect(V.redemptionLane(TOKENS[1], null).state).toBe('not-recorded');
    });

    it('describes lending rows with LTV ranges and missing LTV as missing', () => {
        expect(V.lendingLane(TOKENS[2]).rows[0].text).toBe('Borrow against it · max LTV 55%–60% · debt USDC');
        expect(V.lendingLane({ lending: [{ protocol: 'Nest', action: 'collateral', maxLtv: null, debt: [] }] }).rows[0].text).toBe('Borrow against it · max LTV not reported');
        expect(V.pctRange({ min: 0.5, max: 0.5 })).toBe('50%');
    });
});

describe('table', () => {
    const rows = V.tableRows(TOKENS, ISSUERS);

    it('shows depth only for observed coverage and pool count null when venues were not collected', () => {
        const by = Object.fromEntries(rows.map((r) => [r.symbol, r]));
        expect(by.NVDAx).toMatchObject({ depth: 2500, pools: 2, topVenue: 'Raydium', route: 'operational' });
        expect(by.NVDAon).toMatchObject({ depth: null, pools: 0, coverage: 'none-observed' });
        expect(by.TSLAon).toMatchObject({ depth: null, pools: null, coverage: 'not-collected', lending: 1, routeExact: true });
    });

    it('sorts with missing values last in both directions', () => {
        expect(V.sortRows(rows, 'depth', false).map((r) => r.symbol)).toEqual(['NVDAx', 'NVDAon', 'TSLAon']);
        expect(V.sortRows(rows, 'depth', true).map((r) => r.symbol)).toEqual(['NVDAx', 'NVDAon', 'TSLAon']);
        expect(V.sortRows(rows, 'pools', true).map((r) => r.symbol)).toEqual(['NVDAon', 'NVDAx', 'TSLAon']);
        expect(V.sortRows(rows, 'route', true).map((r) => r.symbol)).toEqual(['NVDAon', 'TSLAon', 'NVDAx']);
    });

    it('filters on symbol, stock or issuer', () => {
        expect(V.filterRows(rows, 'tsla').map((r) => r.symbol)).toEqual(['TSLAon']);
        expect(V.filterRows(rows, 'kraken').map((r) => r.symbol)).toEqual(['NVDAx']);
        expect(V.filterRows(rows, '  ')).toHaveLength(3);
    });
});

describe('exits.html', () => {
    const html = readFileSync(join(__dirname, '..', 'exits.html'), 'utf8');

    it('loads its pure libraries before the page script, with cache-bust stamps', () => {
        const order = ['stocks/lib/fmt.js', 'stocks/lib/sort-values.js', 'stocks/lib/exits-view.js', 'stocks/lib/sankey-layout.js', 'exits.js'];
        const at = order.map((src) => html.indexOf(`<script src="${src}?v=`));
        expect(at.every((i) => i > 0)).toBe(true);
        expect([...at].sort((a, b) => a - b)).toEqual(at);
    });

    it('carries the site header with the compact Learn link and marks itself current', () => {
        expect(html).toContain('<header class="app-header">');
        expect(html).toContain('<a class="nav-compact-only" href="./learn/">Learn</a>');
        expect(html).toContain('<a aria-current="page" href="./exits.html">Exit routes</a>');
        expect(html).toMatch(/nav-menus\.js\?v=\d+[a-z]*" defer/);
    });

    it('has every element exits.js looks up', () => {
        const js = readFileSync(join(__dirname, '..', 'exits.js'), 'utf8');
        const ids = [...new Set([...js.matchAll(/\$\('([A-Za-z]+)'\)/g)].map((m) => m[1]))];
        expect(ids.length).toBeGreaterThan(10);
        for (const id of ids) expect(html).toContain(`id="${id}"`);
    });
});
