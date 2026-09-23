// Contract tests for the small, publishable comparison payloads. Fixtures deliberately carry
// distracting issuer prose so this catches accidental full-catalogue/full-dossier coupling.
const { sameUnderlyingGroups } = require('./lib/discovery.js');
const { comparisonBundleFilename, comparisonBundleMatches } = require('./lib/comparison-shape.js');
const { buildComparisonBundles, comparisonBundleIndex } = require('./lib/comparison-bundles.mjs');

const token = (mint, symbol, issuer, underlyingTicker, market = null) => ({
    mint, symbol, issuer, underlyingTicker, name: `${symbol} token`, cardSlug: `${symbol}-card`, market
});
const issuer = (slug) => ({
    slug, name: `Issuer ${slug}`, longPrivateProse: `DO NOT PUBLISH FULL DOSSIER ${slug}`,
    redemption: { available: false }, control: {}, grades: { claimRung: 2 },
    evidence: { coverage: { sourced: 2, needed: 2 }, unverified: 0, inference: 0 },
    documents: [{ url: `https://issuer.example/${slug}`, quote: 'A very long document should not be copied.' }]
});

function fixture() {
    const issuers = ['alpha', 'beta', 'single', ...Array.from({ length: 12 }, (_, index) => `big-${index + 1}`)].map(issuer);
    const tokens = [
        token('a-1', 'ALPHA', 'alpha', 'ACME', { liquidity: 20, vol24: 5 }),
        token('a-2', 'ALPHA2', 'alpha', 'ACME', { liquidity: 10, vol24: 2 }),
        token('b-1', 'BETA', 'beta', 'ACME', { liquidity: 4, vol24: 1 }),
        token('s-1', 'SINGLE', 'single', 'SOLO', null),
        ...Array.from({ length: 12 }, (_, index) => token(`big-${index + 1}`, `BIG${index + 1}`, `big-${index + 1}`, 'BIG', null)),
        // Invalid catalogue rows must neither form bundles nor leak into a valid bundle.
        { mint: 'unknown-ticker', symbol: 'BAD', issuer: 'alpha' },
        { mint: 'unknown-issuer', symbol: 'BAD2', underlyingTicker: 'ACME' }
    ];
    return {
        issuerDb: { builtAt: '2026-09-18T10:00:00Z', issuers },
        tokenDb: { builtAt: '2026-09-20T11:00:00Z', tokens },
        defiUsage: { fetchedAt: '2026-09-21T12:00:00Z', items: [] },
        composability: { reviewedAt: '2026-09-15T09:00:00Z', templates: [] },
        reviewQueue: { items: [{ priority: 'P0', issuerSlug: 'beta' }, { priority: 'P1', issuerSlug: 'alpha' }] }
    };
}

describe('same-underlying comparison groups', () => {
    test('keeps one, two, three and twelve-plus issuer underlyings, with all mints under each issuer', () => {
        const groups = sameUnderlyingGroups(fixture().tokenDb.tokens, { includeSingle: true });
        expect(groups.map((group) => [group.ticker, group.issuerCount, group.tokenCount])).toEqual([
            ['BIG', 12, 12], ['ACME', 2, 3], ['SOLO', 1, 1]
        ]);
        expect(groups.find((group) => group.ticker === 'ACME').rows.find((row) => row.issuer === 'alpha').tokens.map((row) => row.mint))
            .toEqual(['a-1', 'a-2']);
        expect(sameUnderlyingGroups(fixture().tokenDb.tokens).map((group) => group.ticker)).toEqual(['BIG', 'ACME']);
    });

    test('never admits rows lacking either exact underlying or issuer identity', () => {
        const groups = sameUnderlyingGroups(fixture().tokenDb.tokens, { includeSingle: true });
        expect(groups.flatMap((group) => group.rows).flatMap((row) => row.tokens).map((row) => row.mint))
            .not.toEqual(expect.arrayContaining(['unknown-ticker', 'unknown-issuer']));
    });
});

describe('comparison bundle filename and mixed-release matching', () => {
    test('encodes punctuation and traversal-looking tickers as one safe deterministic filename', () => {
        expect(comparisonBundleFilename(' BRK.B ')).toBe('u-42-52-4b-2e-42.json');
        expect(comparisonBundleFilename('../A')).toBe('u-2e-2e-2f-41.json');
        expect(comparisonBundleFilename('A/B')).not.toBe(comparisonBundleFilename('A?B'));
        expect(comparisonBundleFilename('a/b')).toBe(comparisonBundleFilename('A/B'));
        expect(comparisonBundleFilename('')).toBeNull();
        for (const ticker of ['../A', 'A/B', 'A?B']) expect(comparisonBundleFilename(ticker)).not.toMatch(/[\\/]/);
    });

    test('accepts only the exact issuer/mint membership of the current group', () => {
        const group = sameUnderlyingGroups(fixture().tokenDb.tokens, { includeSingle: true }).find((row) => row.ticker === 'ACME');
        const exact = { schemaVersion: 1, ticker: 'ACME', models: group.rows.map((row) => ({ issuerSlug: row.issuer, tokens: row.tokens })) };
        expect(comparisonBundleMatches(exact, group)).toBe(true);
        expect(comparisonBundleMatches({ ...exact, builtAt: '2026-09-21T12:00:00Z' }, group, '2026-09-21T12:00:00Z')).toBe(true);
        expect(comparisonBundleMatches({ ...exact, builtAt: '2026-09-20T12:00:00Z' }, group, '2026-09-21T12:00:00Z')).toBe(false);
        expect(comparisonBundleMatches({ ...exact, models: [...exact.models, { issuerSlug: 'unknown', tokens: [token('foreign', 'F', 'unknown', 'ACME')] }] }, group)).toBe(false);
        expect(comparisonBundleMatches({ ...exact, ticker: 'OTHER' }, group)).toBe(false);
        expect(comparisonBundleMatches({ ...exact, models: [{ issuerSlug: 'alpha', tokens: [token('a-1', 'ALPHA', 'alpha', 'ACME')] }] }, group)).toBe(false);
    });
});

describe('scoped comparison bundle generation', () => {
    test('keeps exact known membership, source-specific dates and only comparison-model data', () => {
        const input = fixture();
        const bundles = buildComparisonBundles(input);
        const acme = bundles.find((bundle) => bundle.ticker === 'ACME');
        const big = bundles.find((bundle) => bundle.ticker === 'BIG');
        const solo = bundles.find((bundle) => bundle.ticker === 'SOLO');
        expect(bundles.map((bundle) => bundle.ticker)).toEqual(['BIG', 'ACME', 'SOLO']);
        expect(acme).toMatchObject({ schemaVersion: 1, builtAt: '2026-09-20T11:00:00Z', sources: {
            tokensBuiltAt: '2026-09-20T11:00:00Z', issuersBuiltAt: '2026-09-18T10:00:00Z',
            defiFetchedAt: '2026-09-21T12:00:00Z', templateReviewedAt: '2026-09-15T09:00:00Z'
        }, reviewPendingIssuers: ['beta'] });
        expect(acme.models.map((model) => [model.issuerSlug, model.tokens.map((row) => row.mint)])).toEqual([
            ['alpha', ['a-1', 'a-2']], ['beta', ['b-1']]
        ]);
        expect(acme.models.every((model) => model.redemptionUsability.answerScope === 'product')).toBe(true);
        expect(acme.models.every((model) => model.redemptionUsability.productSymbol)).toBe(true);
        expect(big.models).toHaveLength(12);
        expect(solo.models).toHaveLength(1);
        const published = JSON.stringify(bundles);
        expect(published).not.toContain('unknown-ticker');
        expect(published).not.toContain('unknown-issuer');
        expect(published).not.toContain('DO NOT PUBLISH FULL DOSSIER');
        expect(published).not.toContain('A very long document should not be copied.');
    });

    test('preserves unavailable market observations as null rather than converting them to zero', () => {
        const solo = buildComparisonBundles(fixture()).find((bundle) => bundle.ticker === 'SOLO').models[0];
        expect(solo).toMatchObject({ liquidityUsd: null, volume24Usd: null });
        expect(solo.liquidityUsd).not.toBe(0);
        expect(solo.volume24Usd).not.toBe(0);
    });

    test('indexes every scoped bundle with exact counts, mints and collision-safe path', () => {
        const bundles = buildComparisonBundles(fixture());
        const index = comparisonBundleIndex(bundles);
        const acme = index.groups.find((group) => group.ticker === 'ACME');
        expect(index).toMatchObject({ schemaVersion: 1, builtAt: '2026-09-20T11:00:00Z' });
        expect(acme).toEqual({ ticker: 'ACME', path: comparisonBundleFilename('ACME'), issuerCount: 2, tokenCount: 3,
            issuers: ['alpha', 'beta'], mints: ['a-1', 'a-2', 'b-1'] });
        expect(index.groups.every((group) => group.mints.every((mint) => !['unknown-ticker', 'unknown-issuer'].includes(mint)))).toBe(true);
    });
});
