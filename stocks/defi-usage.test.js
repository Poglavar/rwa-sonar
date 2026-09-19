const { readFileSync } = require('node:fs');

const {
    buildDefiUsage,
    curatedUsage,
    dexUsage,
    jupiterUsage,
    kaminoUsage,
    nestUsage
} = require('./lib/defi-usage.mjs');

const AAPL = { mint: 'AAPL', symbol: 'AAPLx', issuer: 'xstocks-backed' };

describe('confirmed DeFi usage', () => {
    test('DEX usage is exact-mint, grouped by protocol and distinguishes DBC from LP pools', () => {
        const rows = dexUsage(AAPL, { dex: [
            { dexId: 'meteora', pairAddress: 'p1', liquidityUsd: 100, volume24Usd: 20, txns24: 2, url: 'https://m/p1' },
            { dexId: 'meteoradbc', pairAddress: 'p2', liquidityUsd: 4, volume24Usd: 1, txns24: 1, url: 'https://m/p2' }
        ] }, new Map([['p1', { endpoint: 'https://api.m/p1', error: null }]]));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ protocolId: 'meteora', status: 'live', actions: ['swap', 'provide-liquidity'] });
        expect(rows[0].metrics).toEqual({ pools: 2, liquidityUsd: 104, volume24Usd: 21, txns24: 3 });
        expect(rows[0].evidence[0].type).toBe('protocol-api');
    });

    test('a DBC-only market is not advertised as a permissionless LP deposit', () => {
        const [row] = dexUsage(AAPL, { dex: [
            { dexId: 'meteoradbc', pairAddress: 'p', liquidityUsd: 0, volume24Usd: 0 }
        ] });
        expect(row.status).toBe('available');
        expect(row.actions).toEqual(['swap']);
    });

    test('Kamino requires an exact collateral mint and exposes actual LTV terms', () => {
        const rows = [{
            collateralMint: 'AAPL', lendingMarketName: 'xStocks Pool', debtCategory: 'Stablecoin assets', sizeUsd: '42',
            borrowReserveTerms: [{ maxLtv: '0.4', liquidationLtv: '0.5' }]
        }];
        expect(kaminoUsage({ ...AAPL, mint: 'OTHER' }, rows)).toEqual([]);
        const [usage] = kaminoUsage(AAPL, rows);
        expect(usage).toMatchObject({ protocolId: 'kamino', status: 'live', actions: ['collateral', 'borrow'] });
        expect(usage.metrics).toMatchObject({ sizeUsd: 42, maxLtvMin: 0.4, liquidationLtvMax: 0.5 });
    });

    test('curated products are exact-mint, never issuer-wide', () => {
        const curated = { integrations: [{ id: 'vault', mints: ['AAPL'], protocolId: 'veda', protocolName: 'Veda', actions: ['earn-yield'] }] };
        expect(curatedUsage(AAPL, curated)).toHaveLength(1);
        expect(curatedUsage({ ...AAPL, mint: 'MSFT' }, curated)).toEqual([]);
    });

    test('Jupiter Lend requires an exact collateral mint and aggregates debt vaults', () => {
        const vaults = [
            { id: 77, supplyToken: { address: 'AAPL', decimals: 8, price: '200' }, borrowToken: { uiSymbol: 'USDC' }, totalSupply: '100000000', totalPositions: 2, collateralFactor: '650', liquidationThreshold: '750' },
            { id: 81, supplyToken: { address: 'AAPL', decimals: 8, price: '200' }, borrowToken: { uiSymbol: 'JupUSD' }, totalSupply: '200000000', totalPositions: 3, collateralFactor: '650', liquidationThreshold: '750' }
        ];
        expect(jupiterUsage({ ...AAPL, mint: 'OTHER' }, vaults)).toEqual([]);
        const [usage] = jupiterUsage(AAPL, vaults);
        expect(usage).toMatchObject({ protocolId: 'jupiter-lend', status: 'live', actions: ['collateral', 'borrow'] });
        expect(usage.metrics).toMatchObject({ sizeUsd: 600, positions: 5, maxLtvMin: 0.65, liquidationLtvMax: 0.75 });
        expect(usage.markets.map((row) => row.name)).toEqual(['Borrow USDC', 'Borrow JupUSD']);
    });

    test('Nest accepts only a full mint match from the reviewed mainnet manifest', () => {
        const manifest = { schema: 'nest-public-deployment-v1', collateral: [{ mint: 'AAPL', displaySymbol: 'AAPLx', borrowLtvBps: 5000, liquidationThresholdBps: 6000 }] };
        expect(nestUsage({ ...AAPL, mint: 'OTHER' }, manifest)).toEqual([]);
        const [usage] = nestUsage(AAPL, manifest);
        expect(usage).toMatchObject({ protocolId: 'nest', status: 'available', actions: ['collateral', 'borrow'] });
        expect(usage.metrics).toMatchObject({ maxLtvMin: 0.5, liquidationLtvMax: 0.6 });
    });

    test('output contains every asset and makes absence explicit', () => {
        const result = buildDefiUsage({
            tokens: [AAPL, { mint: 'NONE', symbol: 'NONE', issuer: 'issuer' }],
            venues: { fetchedAt: '2026-09-19T00:00:00Z', items: [] },
            meteora: { items: [] },
            kamino: { collateralReserves: [] },
            jupiter: [],
            nest: { collateral: [] },
            curated: { integrations: [] },
            fetchedAt: '2026-09-19T12:00:00Z'
        });
        expect(result.items).toHaveLength(2);
        expect(result.items.every((item) => item.integrations.length === 0)).toBe(true);
        expect(result.counts).toMatchObject({ assets: 2, withAnyConfirmedUse: 0, withNoneConfirmed: 2 });
    });

    test('committed data covers the complete current mint universe', () => {
        const tokenDb = JSON.parse(readFileSync('stocks-tokens.json'));
        const usageDb = JSON.parse(readFileSync('stocks/data/defi-usage.json'));
        expect(usageDb.items).toHaveLength(tokenDb.tokens.length);
        expect(new Set(usageDb.items.map((item) => item.mint))).toEqual(new Set(tokenDb.tokens.map((item) => item.mint)));
    });
});
