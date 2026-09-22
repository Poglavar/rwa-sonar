const { readFileSync } = require('node:fs');

const {
    applyOnchainCorroboration,
    buildDefiUsage,
    capabilityRecords,
    curatedUsage,
    dexUsage,
    jupiterUsage,
    kaminoUsage,
    nestUsage,
    project0Usage,
    integrationProof,
    integrationAccountRefs,
    saveUsage
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
            lendingMarket: '11111111111111111111111111111111', collateralReserve: 'Vote111111111111111111111111111111111111111',
            collateralBackingDebtUsd: '40', debtAgainstCollateralUsd: '12',
            borrowReserveTerms: [{ reserve: 'Stake11111111111111111111111111111111111111', maxLtv: '0.4', liquidationLtv: '0.5', borrowFactor: '1.1' }]
        }];
        expect(kaminoUsage({ ...AAPL, mint: 'OTHER' }, rows)).toEqual([]);
        const [usage] = kaminoUsage(AAPL, rows);
        expect(usage).toMatchObject({ protocolId: 'kamino', status: 'live', actions: ['collateral', 'borrow'] });
        expect(usage.metrics).toMatchObject({ sizeUsd: 42, maxLtvMin: 0.4, liquidationLtvMax: 0.5, borrowFactorMax: 1.1, debtAgainstCollateralUsd: 12 });
        expect(usage.markets[0]).toMatchObject({ marketAddress: '11111111111111111111111111111111', reserveAddress: 'Vote111111111111111111111111111111111111111' });
    });

    test('curated products are exact-mint, never issuer-wide', () => {
        const curated = { integrations: [{ id: 'vault', mints: ['AAPL'], protocolId: 'veda', protocolName: 'Veda', actions: ['earn-yield'] }] };
        expect(curatedUsage(AAPL, curated)).toHaveLength(1);
        expect(curatedUsage({ ...AAPL, mint: 'MSFT' }, curated)).toEqual([]);
    });

    test('Jupiter Lend requires an exact collateral mint and aggregates debt vaults', () => {
        const vaults = [
            { id: 77, supplyToken: { address: 'AAPL', decimals: 8, price: '200' }, borrowToken: { uiSymbol: 'USDC' }, totalSupply: '100000000', totalPositions: 2, collateralFactor: '650', liquidationThreshold: '750' },
            { id: 81, address: 'Vote111111111111111111111111111111111111111', supplyToken: { address: 'AAPL', decimals: 8, price: '200' }, borrowToken: { uiSymbol: 'JupUSD' }, totalSupply: '200000000', totalPositions: 3, collateralFactor: '650', liquidationThreshold: '750', liquidationPenalty: '300', oracle: 'Stake11111111111111111111111111111111111111', oracleSources: [{ sourceType: { chainlinkDataStreams: {} } }] }
        ];
        expect(jupiterUsage({ ...AAPL, mint: 'OTHER' }, vaults)).toEqual([]);
        const [usage] = jupiterUsage(AAPL, vaults);
        expect(usage).toMatchObject({ protocolId: 'jupiter-lend', status: 'live', actions: ['collateral', 'borrow'] });
        expect(usage.metrics).toMatchObject({ sizeUsd: 600, positions: 5, maxLtvMin: 0.65, liquidationLtvMax: 0.75, liquidationPenaltyMax: 0.03 });
        expect(usage.markets.map((row) => row.name)).toEqual(['Borrow USDC', 'Borrow JupUSD']);
        expect(usage.markets[1]).toMatchObject({ vaultAddress: 'Vote111111111111111111111111111111111111111', oracleProviders: ['chainlinkDataStreams'] });
    });

    test('Nest accepts only a full mint match from the reviewed mainnet manifest', () => {
        const manifest = { schema: 'nest-public-deployment-v1', collateral: [{ mint: 'AAPL', displaySymbol: 'AAPLx', borrowLtvBps: 5000, liquidationThresholdBps: 6000 }] };
        expect(nestUsage({ ...AAPL, mint: 'OTHER' }, manifest)).toEqual([]);
        const [usage] = nestUsage(AAPL, manifest);
        expect(usage).toMatchObject({ protocolId: 'nest', status: 'available', actions: ['collateral', 'borrow'] });
        expect(usage.metrics).toMatchObject({ maxLtvMin: 0.5, liquidationLtvMax: 0.6 });
    });

    test('Project 0 counts only an operational collateral bank for the exact mint', () => {
        const registry = { banks: [
            { mint: 'AAPL', address: 'bank-live', symbol: 'AAPLx', venue: 'P0', risk_tier: 'Collateral', operational_state: 'Operational', weights: { asset_weight_init: 0.55 }, size: { deposits_usd: '1250' } },
            { mint: 'AAPL', address: 'bank-paused', symbol: 'AAPLx', venue: 'P0', risk_tier: 'Collateral', operational_state: 'Paused', weights: { asset_weight_init: 0.8 }, size: { deposits_usd: '9000' } },
            { mint: 'AAPL', address: 'bank-isolated', symbol: 'AAPLx', venue: 'P0', risk_tier: 'Isolated', operational_state: 'Operational', weights: { asset_weight_init: 0.9 }, size: { deposits_usd: '5000' } }
        ] };
        expect(project0Usage({ ...AAPL, mint: 'OTHER' }, registry)).toEqual([]);
        const [usage] = project0Usage(AAPL, registry);
        expect(usage).toMatchObject({ protocolId: 'project0', status: 'live', actions: ['lend', 'collateral', 'borrow'] });
        expect(usage.metrics).toMatchObject({ sizeUsd: 1250, collateralWeightMin: 0.55, collateralWeightMax: 0.55 });
        expect(usage.markets).toHaveLength(1);
    });

    test('Save counts only an exact liquidity mint with positive collateral LTV', () => {
        const registry = { results: [{ reserve: {
            address: 'Vote111111111111111111111111111111111111111',
            lendingMarket: 'Stake11111111111111111111111111111111111111',
            liquidity: {
                mintPubkey: 'AAPL', mintDecimals: 8, availableAmount: '100000000',
                pythOracle: 'SysvarC1ock11111111111111111111111111111111'
            },
            config: {
                loanToValueRatio: 45, liquidationThreshold: 55, liquidationBonus: 5,
                depositLimit: '10000000000', borrowLimit: '5000000000'
            }
        } }] };
        expect(saveUsage({ ...AAPL, mint: 'OTHER' }, registry)).toEqual([]);
        const [usage] = saveUsage(AAPL, registry);
        expect(usage).toMatchObject({ protocolId: 'save', status: 'available', actions: ['lend', 'collateral', 'borrow'] });
        expect(usage.metrics).toMatchObject({
            maxLtvMin: 0.45, liquidationLtvMax: 0.55, liquidationPenaltyMax: 0.05,
            depositLimitTokens: 100, borrowLimitTokens: 50, oracleProviders: ['pyth']
        });
        expect(usage.markets[0]).toMatchObject({ reserveAddress: 'Vote111111111111111111111111111111111111111' });
        expect(saveUsage(AAPL, { results: [{ reserve: { liquidity: { mintPubkey: 'AAPL' }, config: { loanToValueRatio: 0 } } }] })).toEqual([]);
    });

    test('output contains every asset and makes absence explicit', () => {
        const result = buildDefiUsage({
            tokens: [AAPL, { mint: 'NONE', symbol: 'NONE', issuer: 'issuer' }],
            venues: { fetchedAt: '2026-09-19T00:00:00Z', items: [] },
            meteora: { items: [] },
            kamino: { collateralReserves: [] },
            jupiter: [],
            nest: { collateral: [] },
            project0: { banks: [] },
            curated: { integrations: [] },
            fetchedAt: '2026-09-19T12:00:00Z'
        });
        expect(result.items).toHaveLength(2);
        expect(result.items.every((item) => item.integrations.length === 0)).toBe(true);
        expect(result.counts).toMatchObject({ assets: 2, withAnyConfirmedUse: 0, withNoneConfirmed: 2 });
    });

    test('records action mechanics and corroborates only published on-chain account roles', () => {
        expect(capabilityRecords(['borrow', 'collateral'])).toEqual(expect.arrayContaining([
            expect.objectContaining({ action: 'collateral', status: 'confirmed', custody: 'protocol', enforcement: 'smart-contract' })
        ]));
        const integration = {
            protocolId: 'nest', category: 'lending', actions: ['collateral', 'borrow'],
            markets: [{ collateralConfig: 'Vote111111111111111111111111111111111111111', collateralVault: 'Stake11111111111111111111111111111111111111' }],
            evidence: [{ type: 'deployment-manifest' }]
        };
        expect(integrationAccountRefs(integration).map((row) => row.role)).toEqual(['collateral-config', 'collateral-vault']);
        const usage = { counts: {}, items: [{ integrations: [integration] }] };
        applyOnchainCorroboration(usage, new Map([
            ['Vote111111111111111111111111111111111111111', { exists: true, owner: 'owner' }],
            ['Stake11111111111111111111111111111111111111', { exists: true, owner: 'owner' }]
        ]), '2026-09-19T12:00:00Z', 'rpc.example');
        expect(integration).toMatchObject({
            evidenceTier: 'account-existence-checked',
            corroboration: { status: 'confirmed', accountCount: 2, verifiedCount: 2 },
            proof: {
                sourceStatus: 'exact-token-registry', accountExistence: 'checked',
                configurationDecoded: false, readOnlyExecutionSimulated: false, activityObserved: false
            },
            capabilities: expect.arrayContaining([expect.objectContaining({ action: 'borrow' })])
        });
        expect(usage.counts).toMatchObject({ accountExistenceChecked: 1, withAccountExistenceChecked: 1 });
        expect(integrationProof({ evidence: [{ type: 'official-product-page' }], metrics: { positions: 2 } }))
            .toMatchObject({ sourceStatus: 'named-product-page', accountExistence: 'not-checked', activityObserved: true });
    });

    test('committed data covers the complete current mint universe', () => {
        const tokenDb = JSON.parse(readFileSync('stocks-tokens.json'));
        const usageDb = JSON.parse(readFileSync('stocks/data/defi-usage.json'));
        expect(usageDb.items).toHaveLength(tokenDb.tokens.length);
        expect(new Set(usageDb.items.map((item) => item.mint))).toEqual(new Set(tokenDb.tokens.map((item) => item.mint)));
    });
});
