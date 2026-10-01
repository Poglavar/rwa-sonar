const { applies, resolveClaim } = require('../rwa/lib/research.js');
let stockResearch;
beforeAll(async () => { ({ stockResearch } = await import('../rwa/lib/stock-research.mjs')); });

function fixture() {
    return {
        issuerDb: { issuers: [{ slug: 'demo-equities', name: 'Demo Equities', issuerText: 'Demo platform', status: 'live',
            issuingEntity: 'Demo Issuer Ltd', legalForm: 'contractual tracker', holderClaim: 'Holders have a contractual claim against the issuer.',
            products: ['Demo shares token'], ownershipLedger: null,
            collateral: { composition: 'shares', ratio: '1:1' }, underlyingCustodian: 'Custodian Bank',
            custodyVerification: { type: 'proof-of-reserve', evidenceStatus: 'promised-unpublished', agent: 'Unidentified auditor' },
            transferRestrictions: { allowlist: true }, keyGovernance: { freeze: 'multisig' },
            redemption: { eligibility: 'Eligible holders only', rails: 'Stablecoin payment', fees: 'Fee applies', termScopes: { eligibility: { kind: 'programme-all-products' } } },
            evidence: { lastCheckedAt: '2026-08-15T12:00:00Z' },
            claims: [
                { issuerSlug: 'demo-equities', subjectType: 'issuer', subjectId: 'demo-equities', field: 'holderClaim', quote: 'A contractual claim against Demo Issuer Ltd.', url: 'https://demo.example/terms', locator: 'Terms § 3', accessedAt: '2026-08-01T12:00:00Z', status: 'confirmed' },
                { issuerSlug: 'demo-equities', subjectType: 'issuer', subjectId: 'demo-equities', field: 'custodyVerification.type', quote: 'Annual proof of reserve promised but not published.', url: 'https://demo.example/faq', locator: 'FAQ / Reserves', accessedAt: '2026-08-02T12:00:00Z', status: 'confirmed' },
                { issuerSlug: 'demo-equities', subjectType: 'issuer', subjectId: 'demo-equities', field: 'redemption.rails', quote: 'Eligible users may request stablecoin settlement.', url: 'https://demo.example/redeem', locator: 'Redemption section', accessedAt: '2026-08-03T12:00:00Z', status: 'confirmed' },
                { issuerSlug: 'demo-equities', subjectType: 'product', subjectId: 'DEMO', field: 'holderClaim', quote: 'Product-specific share right.', url: 'https://demo.example/specific', locator: 'Product sheet', accessedAt: '2026-08-04T12:00:00Z', status: 'confirmed' }
            ]
        }] },
        tokenDb: { sources: { onchain: { fetchedAt: '2026-08-10T12:00:00Z' }, venues: { fetchedAt: '2026-08-11T12:00:00Z' }, referencePrices: { fetchedAt: '2026-08-12T12:00:00Z' }, holders: { fetchedAt: '2026-08-13T12:00:00Z', supplyFetchedAt: '2026-08-14T12:00:00Z' }, identities: { builtAt: '2026-08-09T12:00:00Z' } }, tokens: [{ issuer: 'demo-equities', mint: 'DemoMint111', symbol: 'DEMO', name: 'Demo share token', underlyingTicker: 'DEMOCO', tokenProgram: 'token-2022',
            identity: { status: 'catalogued', currentIssuerRegistry: 'not-published' }, recipe: { program: 'token-2022', extensions: ['pausable'] },
            control: { freezeAuthority: 'DemoAuthority' }, market: { liquidity: null }, lastSeenAt: '2026-09-20T00:00:00Z', cardSlug: 'DEMO' }] },
        dossiers: { 'demo-equities': { whatIf: [{ mode: 'issuer-insolvency', status: 'documented', outcome: 'The scenario analysis says the holder may have only the disclosed issuer claim.',
            url: 'https://demo.example/terms', locator: 'Risk factors / insolvency', accessedAt: '2026-08-05T12:00:00Z' }] } }
    };
}

test('builds only programme-scoped records and keeps one exact token deployment separately', () => {
    const { issuerDb, tokenDb, dossiers } = fixture();
    const [p] = stockResearch(issuerDb, tokenDb, dossiers);
    expect(p).toMatchObject({ id: 'stock:demo-equities', kind: 'programme', programmeId: 'demo-equities', instrument: null, reviewedAt: null, evidenceCheckedAt: '2026-08-15T12:00:00Z', legacyReport: 'issuers/demo-equities.html' });
    expect(p.programme.id).toBe('programme:demo-equities');
    expect(p.contexts).toEqual([{ id: 'programme', termsId: 'programme:dossier:demo-equities', label: 'Demo Equities programme-level dossier' }]);
    expect(p.claims.map((c) => c.dimension)).toEqual(['rights', 'ledger', 'backing', 'controls', 'access', 'exit', 'failure']);
    expect(p.claims.every((c) => c.scope.programmeId === 'demo-equities' && !c.scope.instrumentId && !c.scope.deploymentId)).toBe(true);
    expect(p.claims.find((c) => c.dimension === 'ledger').state).toBe('unknown');
    expect(resolveClaim(p, 'programme', 'rights').state).toBe('supported');
    expect(p.claims.find((c) => c.dimension === 'exit').summary).toMatch(/Eligibility=programme-all-products/);
    expect(applies(p.claims[0].scope, { kind: 'instrument', programmeId: 'demo-equities', instrumentId: 'instrument:demo', contextId: 'programme', termsId: p.contexts[0].termsId })).toBe(false);
    const [d] = p.deployments;
    expect(d).toMatchObject({ id: 'solana:DemoMint111', instrumentId: null, network: 'Solana', address: 'DemoMint111', symbol: 'DEMO', name: 'Demo share token', underlying: 'DEMOCO', report: 'cards/DEMO.html', chainCheckedAt: null, identityCheckedAt: null });
    expect(d.controls.state).toBe('unknown');
    expect(resolveClaim(p, 'programme', 'rights', { deploymentId: d.id }).state).toBe('unknown');
    expect(d.legacy).toMatchObject({ control: { freezeAuthority: 'DemoAuthority' }, market: { liquidity: null }, protocol: { program: 'token-2022', extensions: ['pausable'] }, cardSlug: 'DEMO' });
    expect(d.legacy).not.toHaveProperty('lastSeenAt');
    expect(d.legacy.sourceDates).toEqual({ chain: '2026-08-10T12:00:00Z', venues: '2026-08-11T12:00:00Z', referencePrices: '2026-08-12T12:00:00Z', holders: '2026-08-13T12:00:00Z', holderSupply: '2026-08-14T12:00:00Z', identitiesBuiltAt: '2026-08-09T12:00:00Z' });
    expect(d.identityCheckedAt).toBeNull();
    expect(d.legacy.sourceDates.identitiesBuiltAt).not.toBe(d.identityCheckedAt);
    expect(p.sources.some((s) => s.url === 'https://demo.example/terms' && s.locator === 'Terms § 3' && s.checkedAt === '2026-08-01T12:00:00Z')).toBe(true);
});

test('leaves unverified-only findings unknown while retaining their source provenance', () => {
    const { issuerDb, tokenDb } = fixture();
    const issuer = issuerDb.issuers[0];
    issuer.ownershipLedger = 'The ledger source is not verified.';
    issuer.claims.push({ issuerSlug: 'demo-equities', subjectType: 'issuer', subjectId: 'demo-equities', field: 'ownershipLedger', quote: 'An unverified claim.', url: 'https://demo.example/ledger', locator: 'Ledger statement', accessedAt: null, status: 'unverified' });
    const [p] = stockResearch(issuerDb, tokenDb);
    const ledger = p.claims.find((c) => c.dimension === 'ledger');
    expect(ledger.state).toBe('unknown');
    expect(ledger.sourceIds.length).toBe(1);
    expect(ledger.summary).toMatch(/Unverified or incomplete/);
    expect(p.sources.find((s) => s.id === ledger.sourceIds[0])).toMatchObject({ checkedAt: null, status: 'unverified', quote: 'An unverified claim.' });
});

test('explicit conflicting source statuses remain conflicting', () => {
    const { issuerDb, tokenDb } = fixture();
    issuerDb.issuers[0].claims.push({ issuerSlug: 'demo-equities', subjectType: 'issuer', subjectId: 'demo-equities', field: 'holderClaim', quote: 'Conflicting claim.', url: 'https://demo.example/conflict', locator: 'Terms conflict', accessedAt: '2026-08-06T12:00:00Z', status: 'conflicting' });
    const [p] = stockResearch(issuerDb, tokenDb);
    expect(p.claims.find((c) => c.dimension === 'rights').state).toBe('conflicting');
});

test('uses source dossiers for scenario analysis and distinguishes unpublished reserve assurance', () => {
    const { issuerDb, tokenDb, dossiers } = fixture();
    const [p] = stockResearch(issuerDb, tokenDb, dossiers);
    const failure = p.claims.find((c) => c.dimension === 'failure');
    expect(failure.summary).toMatch(/Issuer insolvency/);
    expect(failure.sourceIds.length).toBeGreaterThan(0);
    expect(p.evidenceProfiles.find((e) => e.method === 'Promised custody / reserve verification').availability).toBe('promised-unpublished');
    expect(p.evidenceProfiles.some((e) => /does not establish tokenholder title/.test(e.scope))).toBe(true);
});

test('rejects malformed inputs and duplicate exact token mints', () => {
    expect(() => stockResearch({}, {})).toThrow('requires issuer and token arrays');
    const { issuerDb, tokenDb, dossiers } = fixture();
    tokenDb.tokens.push({ ...tokenDb.tokens[0], symbol: 'DEMO2' });
    expect(() => stockResearch(issuerDb, tokenDb, dossiers)).toThrow('Missing or duplicate stock mint');
});
