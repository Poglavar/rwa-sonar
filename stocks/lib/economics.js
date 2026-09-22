/*
 * Economics selection is deliberately kept separate from the page.  It does
 * not calculate an all-in cost: a missing amount is evidence of a gap, not a
 * zero.  This UMD wrapper lets the page use `window.__rwaEconomics` while the
 * fast unit tests use require().
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.__rwaEconomics = api;
})(this, function () {
    function text(value) {
        return typeof value === 'string' && value.trim() ? value.trim() : null;
    }

    function selected(value, wanted) {
        return !wanted || value === wanted;
    }

    /** Return one named programme/profile, or null when the data does not contain it. */
    function selectProfile(data, id) {
        const profiles = Array.isArray(data?.profiles) ? data.profiles : [];
        return profiles.find((profile) => profile?.id === id) || null;
    }

    function applicability(scope, options) {
        const level = scope?.level || 'programme';
        const products = Array.isArray(scope?.products) ? scope.products : [];
        let missingContext = false;
        const equals = (a, b) => text(a)?.toLowerCase() === text(b)?.toLowerCase();
        if (level === 'product' || products.length) {
            const symbol = text(options?.productSymbol);
            if (!symbol || !products.length) missingContext = true;
            else if (!products.some(product => equals(product, symbol))) {
                return { applicability: 'not-applicable', scope: 'other-product-example' };
            }
        }
        // A programme term may still be limited to a route, chain or holder.
        // Without that context it is visible, but it is not silently applicable.
        // Every constraint applies at every scope level: a matching product or route must
        // never bypass a conflicting chain or an unresolved holder qualification.
        for (const field of ['route', 'chain', 'holder']) {
            if (!text(scope?.[field])) continue;
            if (!text(options?.[field])) missingContext = true;
            else if (!equals(scope[field], options[field])) {
                return { applicability: 'not-applicable', scope: field === 'route' ? 'other-route' : `other-${field}` };
            }
        }
        if (missingContext) return { applicability: `${level}-context`, scope: level };
        return { applicability: 'applicable', scope: level };
    }

    /**
     * Select fee disclosures without turning programme permissions into current
     * charges.  `collapseProductExamples` is a presentation aid for a selected
     * symbol: it replaces non-matching product examples with one explicit gap,
     * but leaves programme-wide fees and caps visible.
     */
    function selectFees(profile, options = {}) {
        const fees = (Array.isArray(profile?.fees) ? profile.fees : [])
            .filter((fee) => selected(fee?.stage, options.stage))
            .map((fee) => {
                const state = applicability(fee.scope, options);
                return { ...fee, applicability: state.applicability, scopeState: state.scope };
            });

        if (!options.collapseProductExamples || !text(options.productSymbol)) return fees;

        const productExamples = fees.filter((fee) => fee.scopeState === 'other-product-example');
        const exactProductFee = fees.some((fee) => fee.scopeState === 'product' && fee.applicability !== 'not-applicable');
        if (!productExamples.length) return fees;

        const names = [...new Set(productExamples.flatMap((fee) => fee.scope?.products || []))];
        const remaining = fees.filter((fee) => fee.scopeState !== 'other-product-example');
        if (exactProductFee) return remaining;
        remaining.push({
            id: 'no-exact-fee-confirmed',
            stage: 'unknown',
            label: `No ${options.productSymbol}-specific fee is confirmed`,
            amountText: null,
            kind: 'unknown',
            status: 'unknown',
            payer: null,
            payee: null,
            scope: { level: 'product', products: [options.productSymbol], route: null, chain: null, holder: null },
            sourceIds: productExamples.flatMap((fee) => fee.sourceIds || []),
            note: names.length ? `Published examples apply to ${names.join(', ')}, not ${options.productSymbol}.` : null,
            applicability: 'no-exact-fee-confirmed',
            scopeState: 'product',
            originalExamples: productExamples.map((fee) => fee.id)
        });
        return remaining;
    }

    return { selectProfile, selectFees, applicability };
});
