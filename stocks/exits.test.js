// Unit tests for stocks/lib/exits.mjs: the stocks-exits.json builder behind exits.html. Covers the
// three venue-coverage states (a never-collected mint is not a mint with no pool, and neither is $0),
// the redemption route ladder, flow rows with proof stages, and dossier links only to real pages.

import { buildExits, flowAction, flowUsd, redemptionRoute, tokenPools, venueName } from './lib/exits.mjs';

const TOKENS = [
    { mint: 'MintA', symbol: 'NVDAx', name: 'NVIDIA xStock', issuer: 'xs', underlyingTicker: 'NVDA', cardSlug: 'NVDAx', recipe: { label: 'r' } },
    { mint: 'MintB', symbol: 'NVDAon', issuer: 'ondo', underlyingTicker: 'NVDA', cardSlug: 'NVDAon', recipe: { label: 'r' } },
    { mint: 'MintC', symbol: 'TSLAon', issuer: 'ondo', underlyingTicker: 'TSLA', cardSlug: 'TSLAon', recipe: { label: 'r' } }
];
const ISSUERS = [
    { slug: 'xs', name: 'Kraken xStocks', status: 'live', redemption: { available: true, kyc: true, operationalRouteAvailable: true,
        operationalEvidence: { status: 'official-current-source', checkedAt: '2026-09-22T16:15:00Z', url: 'https://docs.example/flow' },
        minimum: 'USD 5,000 per transaction' } },
    { slug: 'ondo', name: 'Ondo Global Markets', status: 'live', redemption: { available: true, kyc: true, successfulRedemptionObserved: true,
        successfulRedemptionEvidence: { chain: 'solana', accepted: [{ symbol: 'TSLAon' }], acceptedCount: 3, observedProducts: ['TSLAon'], latestObservedAt: '2026-09-23T19:36:44Z', checkedAt: '2026-09-23T19:44:06Z' } } }
];
const VENUES = { items: [
    { mint: 'MintA', dexFetchedAt: '2026-09-20T08:13:08Z', dex: [
        { dexId: 'raydium', pairAddress: 'PoolR', quoteSymbol: 'USDC', liquidityUsd: 2000, volume24Usd: 10, url: 'https://dexscreener.com/solana/poolr' },
        { dexId: 'meteora', pairAddress: 'PoolM', quoteSymbol: 'USDC', liquidityUsd: 500, volume24Usd: 1 }
    ] },
    { mint: 'MintB', dexFetchedAt: '2026-09-20T08:10:00Z', dex: [] }
] };
const METEORA = { items: [{ pairAddress: 'PoolM', liquidityUsd: 480, fetchedAt: '2026-09-16T23:01:16Z', error: null }] };
const USAGE = { fetchedAt: '2026-09-23T10:50:39Z', items: [{
    mint: 'MintA', symbol: 'NVDAx', issuer: 'xs', integrations: [
        { id: 'raydium:pools', protocolId: 'raydium', protocolName: 'Raydium', category: 'dex', actions: ['swap', 'provide-liquidity'], metrics: { liquidityUsd: 2000 }, proof: { sourceStatus: 'observed-market' } },
        { id: 'kamino:collateral', protocolId: 'kamino', protocolName: 'Kamino', category: 'lending', actions: ['collateral', 'borrow'],
            metrics: { sizeUsd: 900, maxLtvMin: 0.55, maxLtvMax: 0.55 }, markets: [{ debtSymbol: 'USDC' }], proof: { sourceStatus: 'exact-token-registry' } },
        { id: 'nest:collateral', protocolId: 'nest', protocolName: 'Nest', category: 'lending', actions: ['collateral', 'borrow'], metrics: {}, proof: { sourceStatus: 'exact-token-registry' } },
        { id: 'veda', protocolId: 'veda', protocolName: 'Veda', category: 'yield-vault', actions: ['deposit'], metrics: null, proof: { sourceStatus: 'named-product-page' } }
    ]
}] };
const RESEARCH = { markets: [{ tokenMint: 'MintA', protocolId: 'kamino', integrationId: 'kamino:collateral', configurationDecoded: true, observedAt: '2026-09-22T16:01:56Z' }] };

function build(extra = {}) {
    return buildExits({ tokens: TOKENS, issuers: ISSUERS, venues: VENUES, meteora: METEORA, usage: USAGE, marketResearch: RESEARCH,
        dossierSlugs: new Set(['nvdax-kamino-kamino-collateral-minta']), builtAt: '2026-09-24T00:00:00Z', ...extra });
}

describe('venue coverage', () => {
    const out = build();
    const by = Object.fromEntries(out.tokens.map((t) => [t.symbol, t]));

    it('sums observed pool liquidity and keeps each pool with its venue, largest first', () => {
        expect(by.NVDAx.venueCoverage).toBe('observed');
        expect(by.NVDAx.dexLiquidityUsd).toBe(2500);
        expect(by.NVDAx.pools.map((p) => [p.venueName, p.liquidityUsd])).toEqual([['Raydium', 2000], ['Meteora', 500]]);
        expect(by.NVDAx.pools[1].meteora).toEqual({ liquidityUsd: 480, fetchedAt: '2026-09-16T23:01:16Z', endpoint: null });
    });

    it('a collected mint without a pool is "none-observed", a never-collected one is null, neither is zero', () => {
        expect(by.NVDAon).toMatchObject({ venueCoverage: 'none-observed', dexLiquidityUsd: null, dexFetchedAt: '2026-09-20T08:10:00Z' });
        expect(by.TSLAon).toMatchObject({ venueCoverage: 'not-collected', dexLiquidityUsd: null, dexFetchedAt: null });
    });

    it('a pool with no liquidity figure stays null and does not zero the sum', () => {
        const pools = tokenPools({ dex: [{ dexId: 'orca', pairAddress: 'X', liquidityUsd: null }] });
        expect(pools[0].liquidityUsd).toBeNull();
    });

    it('names venues, including unknown dex ids', () => {
        expect(venueName('meteoradbc')).toBe('Meteora (bonding curve)');
        expect(venueName('lifinity')).toBe('Lifinity');
        expect(venueName(null)).toBe('Unknown venue');
    });
});

describe('redemption route', () => {
    it('ranks observed > operational > no public route > documented > no right > not recorded', () => {
        expect(redemptionRoute({ available: true, successfulRedemptionObserved: true, operationalRouteAvailable: true }).state).toBe('observed-onchain');
        expect(redemptionRoute({ available: true, operationalRouteAvailable: true }).state).toBe('operational');
        expect(redemptionRoute({ available: true, operationalRouteAvailable: null, operationalEvidence: { status: 'checked-no-public-route' } }).state).toBe('no-public-route');
        expect(redemptionRoute({ available: true }).state).toBe('documented');
        expect(redemptionRoute({ available: false }).state).toBe('no-right');
        expect(redemptionRoute(null).state).toBe('not-recorded');
    });

    it('never invents a capacity figure, and keeps the minimum as text', () => {
        const r = build().issuers.xs.redemption;
        expect(r.statedLimit).toBeNull();
        expect(r.minimum.completeText).toBe('USD 5,000 per transaction');
        expect(r.operational).toMatchObject({ value: true, checkedAt: '2026-09-22T16:15:00Z', url: 'https://docs.example/flow' });
    });

    it('marks a token whose own redemption was observed, and only that token', () => {
        const by = Object.fromEntries(build().tokens.map((t) => [t.symbol, t]));
        expect(by.TSLAon.redemptionObservedForToken).toBe(true);
        expect(by.NVDAon.redemptionObservedForToken).toBe(false);
        expect(by.NVDAx.redemptionObservedForToken).toBeNull();
    });
});

describe('lending and flows', () => {
    const out = build();
    const nvdax = out.tokens.find((t) => t.symbol === 'NVDAx');

    it('lists lending markets with their own proof stage; the decoded route is promoted only where decoded', () => {
        expect(nvdax.lending.map((l) => [l.protocol, l.stage])).toEqual([['Kamino', 'decoded'], ['Nest', 'source-listed']]);
        expect(nvdax.lending[0]).toMatchObject({ maxLtv: { min: 0.55, max: 0.55 }, sizeUsd: 900, debt: ['USDC'] });
        expect(nvdax.lending[1].sizeUsd).toBeNull();
        expect(nvdax.lenderExit.rating).toBeTruthy();
    });

    it('emits one flow row per integration with action, stage and USD basis', () => {
        expect(out.flows.map((f) => [f.protocol, f.action, f.stage, f.usd, f.usdBasis])).toEqual(expect.arrayContaining([
            ['Raydium', 'liquidity', 'observed-market', 2000, 'pool-liquidity'],
            ['Kamino', 'collateral', 'decoded', 900, 'reported-market-size'],
            ['Nest', 'collateral', 'source-listed', null, null],
            ['Veda', 'vault', 'source-listed', null, null]
        ]));
    });

    it('links a dossier only when that page was generated', () => {
        const kamino = out.flows.find((f) => f.protocol === 'Kamino');
        const nest = out.flows.find((f) => f.protocol === 'Nest');
        expect(kamino.dossier).toBe('nvdax-kamino-kamino-collateral-minta');
        expect(nest.dossier).toBeNull();
        expect(build({ dossierSlugs: null }).flows.every((f) => f.dossier === null)).toBe(true);
    });

    it('maps loans and USD bases', () => {
        expect(flowAction({ category: 'lending', markets: [{ loanAddress: 'L' }] })).toBe('loan');
        expect(flowAction({ category: 'other' })).toBeNull();
        expect(flowUsd({ category: 'dex', metrics: { liquidityUsd: 0 } })).toEqual({ usd: 0, basis: 'pool-liquidity' });
        expect(flowUsd({ category: 'lending', metrics: { sizeUsd: null } })).toEqual({ usd: null, basis: null });
    });
});
