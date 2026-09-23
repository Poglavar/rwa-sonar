const { shapeRedemptionUsability, scopeRedemptionTerm, REDEMPTION_EVIDENCE_STATES } = require('./lib/redemption-usability.mjs');

describe('redemption usability model', () => {
    test('keeps contractual detail separate from unmeasured operational and success evidence', () => {
        const result = shapeRedemptionUsability({ redemption: {
            available: true, eligibility: 'Onboarded purchasers only', kyc: true,
            minimum: '$1', fees: '0.1%', rails: 'USDC; T+5'
        } });
        expect(result.directRedemption).toBe(true);
        expect(result.documentedButNotIndependentlyObserved).toBe(true);
        expect(result.fields.find((x) => x.id === 'contractual-right')).toMatchObject({ value: true, evidence: 'documented' });
        expect(result.fields.find((x) => x.id === 'route-currently-available')).toMatchObject({ value: null, evidence: 'unknown' });
        expect(result.fields.find((x) => x.id === 'successful-redemption')).toMatchObject({ value: null, evidence: 'unknown' });
    });

    test('requires explicit observations and never treats a documented route as a success', () => {
        const result = shapeRedemptionUsability({
            redemption: { available: true },
            operationalRouteAvailable: true,
            successfulRedemptionObserved: false,
            secondaryMarketAvailable: true
        });
        expect(result.documentedButNotIndependentlyObserved).toBe(true);
        expect(result.fields.find((x) => x.id === 'route-currently-available').evidence).toBe('observed');
        expect(result.fields.find((x) => x.id === 'successful-redemption').evidence).toBe('not-recorded');
        expect(result.fields.find((x) => x.id === 'secondary-market-exit').evidence).toBe('observed');
    });

    test('labels a current official operating page as documentation, not independent execution', () => {
        const result = shapeRedemptionUsability({
            redemption: { available: true },
            operationalRouteAvailable: true,
            operationalRouteEvidence: {
                status: 'official-current-source', checkedAt: '2026-09-22',
                url: 'https://example.test/current-route'
            },
            successfulRedemptionObserved: false
        });
        expect(result.fields.find((x) => x.id === 'route-currently-available')).toMatchObject({
            value: true, evidence: 'documented',
            evidenceDetail: { status: 'official-current-source', checkedAt: '2026-09-22' }
        });
        expect(result.fields.find((x) => x.id === 'successful-redemption')).toMatchObject({
            value: false, evidence: 'not-recorded'
        });
    });

    test('preserves an explicit no right and every missing term as distinct answers', () => {
        const result = shapeRedemptionUsability({ redemption: { available: false, kyc: false } });
        expect(result.directRedemption).toBe(false);
        expect(result.fields.find((x) => x.id === 'contractual-right')).toMatchObject({ value: false, evidence: 'documented' });
        expect(result.fields.find((x) => x.id === 'eligibility-and-place')).toMatchObject({ value: null, evidence: 'unknown' });
        expect(result.fields.find((x) => x.id === 'kyc')).toMatchObject({ value: false, evidence: 'documented' });
    });

    test('exports the closed evidence vocabulary', () => {
        expect(REDEMPTION_EVIDENCE_STATES).toEqual(['documented', 'observed', 'not-recorded', 'unknown']);
    });

    test('does not apply a TSLAx product-page fee to FGDLx', () => {
        const terms = 'Current fee schedule: issuance/redemption up to 0.50%. The Base Prospectus permits fees up to 5%.';
        const result = shapeRedemptionUsability({ redemption: { fees: terms, termScopes: {
            fees: { kind: 'product-example', products: ['TSLAx'], source: 'TSLAx product page' }
        } }, productSymbol: 'FGDLx' });
        const fee = result.fields.find((field) => field.id === 'fees');
        expect(fee).toMatchObject({
            value: 'No FGDLx-specific fee is confirmed; TSLAx is a programme example only.',
            summary: 'No FGDLx-specific fee is confirmed; TSLAx is a programme example only.',
            completeText: terms,
            scope: 'other-product-example',
            applicable: false,
            exampleProduct: 'TSLAx',
            evidence: 'unknown'
        });
        expect(fee.value).not.toContain('0.50%');
    });

    test('keeps an exact product example and complete holder/jurisdiction qualifications distinct', () => {
        const exact = scopeRedemptionTerm('Current fee schedule: up to 0.50%.', {
            productSymbol: 'TSLAx', field: 'fee', termScope: {
                kind: 'product-example', products: ['TSLAx'], holders: 'onboarded investors', jurisdictions: 'EEA only'
            }
        });
        expect(exact).toMatchObject({ scope: 'exact-product-example', applicable: true, exampleProduct: 'TSLAx',
            scopeContext: { holders: 'onboarded investors', jurisdictions: 'EEA only' } });

        const eligibility = 'Only holders who complete KYC/AML and applicable jurisdiction checks may request redemption; the issuer may reject the request.';
        const result = shapeRedemptionUsability({ redemption: { eligibility }, productSymbol: 'FGDLx' });
        expect(result.fields.find((field) => field.id === 'eligibility-and-place')).toMatchObject({
            summary: 'Programme-level term; FGDLx applicability unconfirmed.',
            completeText: eligibility, applicable: null, scope: 'programme-unspecified', evidence: 'unknown'
        });
    });

    test('does not infer a product example from wording or promote unknown scope', () => {
        const reworded = 'TSLAx charges up to 0.50% today; the programme caps differ.';
        const unscoped = scopeRedemptionTerm(reworded, { productSymbol: 'FGDLx', field: 'fee' });
        expect(unscoped).toMatchObject({ scope: 'programme-unspecified', applicable: null, exampleProduct: null });

        const scoped = scopeRedemptionTerm(reworded, { productSymbol: 'QQQx', field: 'fee', termScope: {
            kind: 'product-example', products: ['TSLAx']
        } });
        expect(scoped).toMatchObject({ scope: 'other-product-example', applicable: false, exampleProduct: 'TSLAx' });
    });

    test('labels a product example on programme-level surfaces without turning it into a programme fee', () => {
        const result = shapeRedemptionUsability({ redemption: {
            fees: 'TSLAx current fee: up to 0.50%.',
            termScopes: { fees: { kind: 'product-example', products: ['TSLAx'], source: 'TSLAx product page' } }
        }, answerScope: 'programme' });
        expect(result.fields.find((field) => field.id === 'fees')).toMatchObject({
            summary: 'Product example only — TSLAx; no programme-wide fee is confirmed.',
            scope: 'product-example-only', applicable: false, evidence: 'unknown',
            scopeContext: { source: 'TSLAx product page' }
        });
    });

    test('applies an expressly programme-wide term to each exact product', () => {
        const result = shapeRedemptionUsability({ redemption: {
            minimum: '$5,000 for every direct issuer redemption.',
            termScopes: { minimum: { kind: 'programme-all-products', source: 'Current issuer operations page' } }
        }, productSymbol: 'NVDAx' });
        expect(result.fields.find((field) => field.id === 'minimum')).toMatchObject({
            value: '$5,000 for every direct issuer redemption.',
            scope: 'programme-all-products', applicable: true, evidence: 'documented'
        });
    });

    test('scopes an observed execution to the products actually seen and keeps the documented banner off', () => {
        const evidence = { status: 'observed-onchain-transaction', checkedAt: '2026-09-23T18:27:08Z', chain: 'solana',
            searchWindow: { from: '2026-09-22T14:28:43Z', to: '2026-09-23T18:22:22Z' },
            accepted: [{ symbol: 'METAx' }, { symbol: 'SPCXx' }] };
        const other = shapeRedemptionUsability({ redemption: { available: true }, productSymbol: 'TSLAx',
            successfulRedemptionObserved: true, successfulRedemptionEvidence: evidence });
        expect(other.documentedButNotIndependentlyObserved).toBe(false);
        expect(other.fields.find((f) => f.id === 'successful-redemption')).toMatchObject({
            value: true, evidence: 'observed', exactProductObserved: false,
            summary: 'Observed on-chain for the programme route (METAx, SPCXx), not for TSLAx itself.',
            evidenceDetail: { transactions: 2, products: ['METAx', 'SPCXx'] }
        });
        const exact = shapeRedemptionUsability({ redemption: { available: true }, productSymbol: 'METAx',
            successfulRedemptionObserved: true, successfulRedemptionEvidence: evidence });
        expect(exact.fields.find((f) => f.id === 'successful-redemption')).toMatchObject({ exactProductObserved: true });
        // Evidence without an explicit observation flag never turns into an observed result.
        const unflagged = shapeRedemptionUsability({ redemption: { available: true }, successfulRedemptionEvidence: evidence });
        expect(unflagged.fields.find((f) => f.id === 'successful-redemption')).toMatchObject({ value: null, evidence: 'unknown' });
        expect(unflagged.fields.find((f) => f.id === 'successful-redemption')).not.toHaveProperty('summary');
    });
});
