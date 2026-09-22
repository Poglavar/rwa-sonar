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
        expect(result.documentedButNotIndependentlyObserved).toBe(false);
        expect(result.fields.find((x) => x.id === 'route-currently-available').evidence).toBe('observed');
        expect(result.fields.find((x) => x.id === 'successful-redemption').evidence).toBe('not-recorded');
        expect(result.fields.find((x) => x.id === 'secondary-market-exit').evidence).toBe('observed');
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
            summary: 'Documented — see complete terms.', completeText: eligibility, applicable: null, scope: 'programme-unspecified'
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
});
