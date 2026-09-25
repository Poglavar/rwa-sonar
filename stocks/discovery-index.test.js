import { buildDiscoveryIndex } from './lib/discovery-index.mjs';

describe('compact discovery index', () => {
    test('keeps identity, market summary and decision filters without dossier prose', () => {
        const issuer = {
            slug: 'issuer', name: 'Issuer', status: 'live', legalForm: 'note', issuingEntity: 'Entity',
            redemption: { available: true, rails: 'cash in USDC', eligibility: 'non-US investors' },
            control: { freezeAuthority: false, pausable: false, clawback: false },
            grades: { claimRung: 4 }, evidence: { lastCheckedAt: '2026-09-20T00:00:00Z' },
            claims: [{ quote: 'large prose must not ship' }]
        };
        const token = {
            mint: 'mint', symbol: 'TESTx', name: 'Test xStock', issuer: 'issuer',
            underlyingTicker: 'TEST', instrumentType: 'Stock', cardSlug: 'TESTx',
            market: { liquidity: 10, vol24: 2, holderCount: 3 },
            issuerApi: { underlying: { name: 'Test Inc.' }, large: 'omit' },
            recipe: { label: 'recipe' }, venues: [{ large: 'omit' }]
        };
        const result = buildDiscoveryIndex({
            issuerDb: { builtAt: '2026-09-22T00:00:00Z', issuers: [issuer] },
            tokenDb: { builtAt: '2026-09-22T00:00:00Z', tokens: [token] }
        });
        expect(result.counts).toEqual({ issuers: 1, tokens: 1 });
        expect(result.tokens[0]).toMatchObject({ mint: 'mint', cardSlug: 'TESTx',
            discoveryProfile: { cashRedemption: true, noDiscretionaryFreeze: true } });
        expect(JSON.stringify(result)).not.toContain('large prose');
        expect(JSON.stringify(result)).not.toContain('venues');
    });

    test('carries the company a pre-IPO token references, so the first page can group it', () => {
        const result = buildDiscoveryIndex({
            issuerDb: { builtAt: '2026-09-22T00:00:00Z', issuers: [{ slug: 'tessera', name: 'Tessera' }] },
            tokenDb: { builtAt: '2026-09-22T00:00:00Z', tokens: [
                { mint: 't', symbol: 'tOpenAI', issuer: 'tessera', underlyingTicker: null, companyKey: 'OPENAI', companyName: 'OpenAI', instrumentType: 'private-company' },
                { mint: 'l', symbol: 'AAPLx', issuer: 'tessera', underlyingTicker: 'AAPL', instrumentType: 'stock' }
            ] }
        });
        expect(result.tokens[0]).toMatchObject({ underlyingTicker: null, companyKey: 'OPENAI', companyName: 'OpenAI', instrumentType: 'private-company' });
        expect(result.tokens[1]).toMatchObject({ underlyingTicker: 'AAPL', companyKey: null, companyName: null });
    });
});
