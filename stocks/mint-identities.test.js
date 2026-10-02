// Verifies that issuer exact-mint evidence stays separate from catalogue admission and chain data.

import { buildMintIdentities } from './lib/mint-identities.mjs';

test('keeps issuer-listed but uningested mints and flags catalogued mints removed from a live registry', () => {
    const result = buildMintIdentities({
        universe: { fetchedAt: '2026-09-20T00:00:00Z', items: [
            { mint: 'old', symbol: 'OLDx', issuer: 'xstocks-backed', listedOnJupiter: true },
            { mint: 'manual', symbol: 'BLSH', issuer: 'bullish' }
        ] },
        onchain: { fetchedAt: '2026-09-20T00:01:00Z', items: [{ mint: 'old', supply: '0', tokenProgram: 'token-2022' }] },
        sponsorApis: {
            fetchedAt: '2026-09-20T00:02:00Z',
            source: { sources: { xstocks: { url: 'https://api.xstocks.fi/api/v2/public/assets', fetchedAt: '2026-09-20T00:02:00Z', ok: true } } },
            items: { xstocks: [{ mint: 'new', symbol: 'NEWx', ticker: 'NEW', sourceStatus: 'issuer-listed' }] }
        },
        manualMints: [{ mint: 'manual', symbol: 'BLSH', issuer: 'bullish', source: 'https://issuer.example/mint' }]
    });
    expect(result.counts).toMatchObject({
        total: 3, catalogued: 2, chainObserved: 1, pendingCatalogueIngestion: 1, pendingChainIngestion: 2
    });
    expect(result.items.find((item) => item.mint === 'new')).toMatchObject({
        identityStatus: 'issuer-confirmed', catalogued: false, currentIssuerRegistry: 'listed'
    });
    expect(result.items.find((item) => item.mint === 'old')).toMatchObject({
        identityStatus: 'not-in-current-issuer-registry', catalogued: true, currentIssuerRegistry: 'not-listed'
    });
    expect(result.items.find((item) => item.mint === 'manual')).toMatchObject({ identityStatus: 'reviewed-primary-source' });
});

test('a failed issuer registry is unavailable rather than evidence that a mint was removed', () => {
    const result = buildMintIdentities({
        universe: { fetchedAt: '2026-09-20T00:00:00Z', items: [
            { mint: 'known', symbol: 'OLDx', issuer: 'xstocks-backed' },
            { mint: 'cached', symbol: 'CACHEDx', issuer: 'xstocks-backed' }
        ] },
        onchain: { fetchedAt: '2026-09-20T00:01:00Z', items: [] },
        sponsorApis: {
            source: { sources: { xstocks: { url: 'https://api.xstocks.fi/api/v2/public/assets', ok: false } } },
            items: { xstocks: [{ mint: 'cached', symbol: 'CACHEDx', ticker: 'CACHED' }] }
        },
        manualMints: []
    });
    expect(result.items.find((item) => item.mint === 'known')).toMatchObject({
        identityStatus: 'programme-corroborated', currentIssuerRegistry: 'unavailable'
    });
    expect(result.items.find((item) => item.mint === 'cached')).toMatchObject({
        identityStatus: 'issuer-confirmed-last-successful', currentIssuerRegistry: 'last-known-listed'
    });
});

test('classifies registry-only mints from chain state and issuer reserve evidence', () => {
    const result = buildMintIdentities({
        universe: { fetchedAt: '2026-09-20T00:00:00Z', items: [] },
        onchain: { items: [] },
        identityOnchain: { fetchedAt: '2026-09-20T00:03:00Z', items: [
            { mint: 'live', supply: '250000000', decimals: 8, paused: false },
            { mint: 'inventory', supply: '500000000', decimals: 8, paused: false },
            { mint: 'missing-proof', supply: '100000000', decimals: 8, paused: false }
        ] },
        sponsorApis: {
            source: { sources: {
                xstocks: { url: 'https://api.xstocks.fi/api/v2/public/assets', ok: true },
                xstocksPor: { url: 'https://api.xstocks.fi/api/v2/public/proof-of-reserves', ok: true }
            } },
            items: {
                xstocks: [
                    { mint: 'live', symbol: 'LIVEx' },
                    { mint: 'inventory', symbol: 'INVENTORYx' },
                    { mint: 'missing-proof', symbol: 'MISSINGx' }
                ],
                xstocksPor: [
                    { symbol: 'LIVEx', sharesHeld: '3', circulatingSupply: '2.5', holdings: [] },
                    { symbol: 'INVENTORYx', sharesHeld: '0', circulatingSupply: '0', holdings: [] }
                ]
            }
        },
        manualMints: []
    });
    expect(result.counts).toMatchObject({ chainObserved: 3, pendingCatalogueIngestion: 3, pendingChainIngestion: 0 });
    expect(result.items.find((item) => item.mint === 'live')).toMatchObject({
        analysisStatus: 'pending-catalogue-ingestion', operationalStatus: 'issuer-reports-positive-circulation'
    });
    expect(result.items.find((item) => item.mint === 'inventory')).toMatchObject({
        operationalStatus: 'issuer-reports-zero-circulation'
    });
    expect(result.items.find((item) => item.mint === 'missing-proof')).toMatchObject({
        operationalStatus: 'reserve-evidence-missing'
    });
});
