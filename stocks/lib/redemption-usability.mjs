// Pure presentation model for direct redemption.  A documented term is not evidence that a route
// is currently working, and neither is evidence of a completed holder redemption.  Consumers must
// pass those two observations explicitly; this module deliberately never promotes issuer prose,
// reserve evidence, or a web form into either answer.

export const REDEMPTION_EVIDENCE_STATES = ['documented', 'observed', 'not-recorded', 'unknown'];

function boolOrNull(value) {
    return typeof value === 'boolean' ? value : null;
}

function textOrNull(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function documented(value) {
    return value === null ? 'unknown' : 'documented';
}

function termEvidence(term) {
    // A source can document another product's example while this product's term stays unknown.
    return term.applicable === false || term.scope === 'product-example-identity-unknown'
        ? 'unknown' : documented(term.value);
}

function observation(value) {
    if (value === true) return 'observed';
    if (value === false) return 'not-recorded';
    return 'unknown';
}

function sameProduct(a, b) {
    return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/**
 * Scope one documented term to the token being presented. `completeText` is never abbreviated:
 * consumers may use `summary` in a compact row and expose the complete qualification in details.
 *
 * This is intentionally a data contract rather than card logic, so compare, issuer and template
 * surfaces can make the same no-cross-product assertion.
 */
export function scopeRedemptionTerm(value, { productSymbol = null, field = null, termScope = null } = {}) {
    const completeText = textOrNull(value);
    if (completeText === null) return {
        value: null, summary: null, completeText: null, scope: 'not-recorded', applicable: null, exampleProduct: null
    };

    const scope = termScope && typeof termScope === 'object' ? termScope : null;
    const products = Array.isArray(scope?.products) ? scope.products.filter((product) => typeof product === 'string' && product) : [];
    const exampleProduct = products[0] ?? null;
    const scopeContext = scope === null ? null : {
        kind: typeof scope.kind === 'string' ? scope.kind : null,
        products,
        source: textOrNull(scope.source),
        holders: textOrNull(scope.holders),
        jurisdictions: textOrNull(scope.jurisdictions)
    };
    if (scope?.kind === 'product-example' && products.length && !products.some((product) => sameProduct(product, productSymbol))) {
        const label = productSymbol ?? 'this token';
        return {
            value: `No ${label}-specific ${field ?? 'term'} is confirmed; ${exampleProduct} is a programme example only.`,
            summary: `No ${label}-specific ${field ?? 'term'} is confirmed; ${exampleProduct} is a programme example only.`,
            completeText,
            scope: 'other-product-example',
            applicable: false,
            exampleProduct,
            scopeContext
        };
    }
    if (scope?.kind === 'product-example' && products.some((product) => sameProduct(product, productSymbol))) {
        return {
            value: completeText,
            summary: 'Documented — see complete terms.',
            completeText,
            scope: 'exact-product-example',
            applicable: true,
            exampleProduct,
            scopeContext
        };
    }
    return {
        value: completeText,
        summary: 'Documented — see complete terms.',
        completeText,
        scope: scope?.kind === 'product-example' ? 'product-example-identity-unknown' : 'programme-unspecified',
        // A documented issuer term is not silently promoted into a product-specific confirmation.
        applicable: null,
        exampleProduct: null,
        scopeContext
    };
}

/**
 * Shapes the seven separately auditable redemption questions used by the holder-facing UI.
 * `operationalRouteAvailable` and `successfulRedemptionObserved` are deliberately independent
 * inputs: either can be unknown even where the contractual terms are detailed.
 */
export function shapeRedemptionUsability({ redemption = null, productSymbol = null, operationalRouteAvailable = null, successfulRedemptionObserved = null, secondaryMarketAvailable = null } = {}) {
    const terms = redemption && typeof redemption === 'object' ? redemption : {};
    const right = boolOrNull(terms.available);
    const scopes = terms.termScopes && typeof terms.termScopes === 'object' ? terms.termScopes : {};
    const eligibility = scopeRedemptionTerm(terms.eligibility, { productSymbol, field: 'eligibility', termScope: scopes.eligibility });
    const minimum = scopeRedemptionTerm(terms.minimum, { productSymbol, field: 'minimum', termScope: scopes.minimum });
    const fees = scopeRedemptionTerm(terms.fees, { productSymbol, field: 'fee', termScope: scopes.fees });
    const rails = scopeRedemptionTerm(terms.rails, { productSymbol, field: 'route', termScope: scopes.rails });
    const fields = [
        { id: 'contractual-right', label: 'Contractual right', value: right, evidence: documented(right) },
        { id: 'eligibility-and-place', label: 'Eligible holder and route', ...eligibility, evidence: termEvidence(eligibility) },
        { id: 'kyc', label: 'KYC / AML', value: boolOrNull(terms.kyc), evidence: documented(boolOrNull(terms.kyc)) },
        { id: 'minimum', label: 'Minimum', ...minimum, evidence: termEvidence(minimum) },
        { id: 'fees', label: 'Fees', ...fees, evidence: termEvidence(fees) },
        { id: 'timing-and-settlement', label: 'Timing and settlement asset', ...rails, evidence: termEvidence(rails) },
        { id: 'route-currently-available', label: 'Route currently available', value: boolOrNull(operationalRouteAvailable), evidence: observation(boolOrNull(operationalRouteAvailable)) },
        { id: 'successful-redemption', label: 'Successful redemption independently observed', value: boolOrNull(successfulRedemptionObserved), evidence: observation(boolOrNull(successfulRedemptionObserved)) },
        { id: 'secondary-market-exit', label: 'Secondary-market exit', value: boolOrNull(secondaryMarketAvailable), evidence: observation(boolOrNull(secondaryMarketAvailable)) }
    ];
    return {
        directRedemption: right,
        documentedButNotIndependentlyObserved: right !== null
            && boolOrNull(operationalRouteAvailable) === null
            && boolOrNull(successfulRedemptionObserved) === null,
        fields
    };
}
