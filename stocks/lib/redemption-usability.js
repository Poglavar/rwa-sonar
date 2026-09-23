/* Shared scope-aware redemption answers for browser, generated pages, bundles and API responses. */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.__rwaRedemptionUsability = factory();
})(this, function () {
    const REDEMPTION_EVIDENCE_STATES = ['documented', 'observed', 'not-recorded', 'unknown'];

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
        return term.applicable === false || term.applicable === null && term.answerScope === 'product'
            ? 'unknown' : documented(term.value);
    }

    function observation(value) {
        if (value === true) return 'observed';
        if (value === false) return 'not-recorded';
        return 'unknown';
    }

    function operationalEvidence(value, evidence) {
        if (value === null) return 'unknown';
        return evidence?.status === 'official-current-source' ? 'documented' : observation(value);
    }

    function sameProduct(a, b) {
        return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
    }

    function fieldLabel(field) {
        return field ?? 'term';
    }

    /**
     * Scope one documented term to either an exact product or a programme/template answer.
     * `completeText` is never abbreviated; compact consumers use `summary` and disclose the full
     * conditions separately. A programme example is never promoted to another exact product.
     */
    function scopeRedemptionTerm(value, {
        productSymbol = null, field = null, termScope = null, answerScope = productSymbol ? 'product' : 'programme'
    } = {}) {
        const completeText = textOrNull(value);
        if (completeText === null) return {
            value: null, summary: null, completeText: null, scope: 'not-recorded', applicable: null,
            exampleProduct: null, scopeContext: null, answerScope
        };

        const scope = termScope && typeof termScope === 'object' ? termScope : null;
        const products = Array.isArray(scope?.products)
            ? scope.products.filter((product) => typeof product === 'string' && product) : [];
        const exampleProduct = products[0] ?? null;
        const scopeContext = scope === null ? null : {
            kind: typeof scope.kind === 'string' ? scope.kind : null,
            products,
            source: textOrNull(scope.source),
            holders: textOrNull(scope.holders),
            jurisdictions: textOrNull(scope.jurisdictions)
        };

        if (scope?.kind === 'product-example') {
            if (answerScope === 'programme' || productSymbol === null) {
                const named = exampleProduct ?? 'a named product';
                return {
                    value: `Product example only — ${named}; no programme-wide ${fieldLabel(field)} is confirmed.`,
                    summary: `Product example only — ${named}; no programme-wide ${fieldLabel(field)} is confirmed.`,
                    completeText, scope: 'product-example-only', applicable: false, exampleProduct,
                    scopeContext, answerScope: 'programme'
                };
            }
            if (!products.some((product) => sameProduct(product, productSymbol))) {
                return {
                    value: `No ${productSymbol}-specific ${fieldLabel(field)} is confirmed; ${exampleProduct} is a programme example only.`,
                    summary: `No ${productSymbol}-specific ${fieldLabel(field)} is confirmed; ${exampleProduct} is a programme example only.`,
                    completeText, scope: 'other-product-example', applicable: false, exampleProduct,
                    scopeContext, answerScope: 'product'
                };
            }
            return {
                value: completeText, summary: 'Documented for this exact product — see complete terms.',
                completeText, scope: 'exact-product-example', applicable: true, exampleProduct,
                scopeContext, answerScope: 'product'
            };
        }

        if (scope?.kind === 'programme-all-products') {
            return {
                value: completeText,
                summary: answerScope === 'product'
                    ? `Programme term expressly applies across the product set, including ${productSymbol ?? 'this token'}.`
                    : 'Documented across the programme product set — see complete terms.',
                completeText, scope: 'programme-all-products', applicable: true, exampleProduct: null,
                scopeContext, answerScope
            };
        }

        if (answerScope === 'product') {
            const label = productSymbol ?? 'this token';
            return {
                value: completeText,
                summary: `Programme-level term; ${label} applicability unconfirmed.`,
                completeText, scope: 'programme-unspecified', applicable: null, exampleProduct: null,
                scopeContext, answerScope: 'product'
            };
        }

        return {
            value: completeText, summary: 'Documented at programme level — see complete terms.',
            completeText, scope: 'programme', applicable: true, exampleProduct: null,
            scopeContext, answerScope: 'programme'
        };
    }

    /**
     * Scope an observed execution record. An observation names the products whose redemption was
     * actually seen; on another product's card it is evidence that the programme route executes,
     * never that this exact token was redeemed.
     */
    function scopeObservedExecution(evidence, { productSymbol = null, answerScope = 'programme' } = {}) {
        if (!evidence || typeof evidence !== 'object') return null;
        const accepted = Array.isArray(evidence.accepted) ? evidence.accepted : [];
        // A recurring scan (stocks/observe-redemptions.mjs) carries a newest-first SAMPLE in
        // `accepted`, the true count in `acceptedCount` and every product seen in `observedProducts`.
        const listed = Array.isArray(evidence.observedProducts) ? evidence.observedProducts.map(textOrNull).filter(Boolean) : null;
        const products = [...new Set(listed ?? accepted.map((row) => textOrNull(row?.symbol)).filter(Boolean))];
        if (accepted.length === 0) return null;
        const total = Number.isInteger(evidence.acceptedCount) && evidence.acceptedCount >= accepted.length ? evidence.acceptedCount : accepted.length;
        const latest = textOrNull(evidence.latestObservedAt);
        const count = `${total} completed redemption${total === 1 ? '' : 's'}`;
        const named = products.length > 6 ? `${products.slice(0, 5).join(', ')} and ${products.length - 5} more` : products.join(', ');
        const window = evidence.searchWindow && textOrNull(evidence.searchWindow.from) && textOrNull(evidence.searchWindow.to)
            ? ` between ${evidence.searchWindow.from} and ${evidence.searchWindow.to}` : '';
        const exact = answerScope === 'product' && productSymbol !== null
            && products.some((product) => sameProduct(product, productSymbol));
        const summary = answerScope !== 'product' || productSymbol === null
            ? `Observed on-chain: ${count} (${named}).`
            : exact ? `Observed on-chain for ${productSymbol} itself (${count} in the programme sample).`
                : `Observed on-chain for the programme route (${named}), not for ${productSymbol} itself.`;
        const completeText = [
            `${count} observed on ${textOrNull(evidence.chain) ?? 'chain'}${window}.`,
            latest ? `Latest observed ${latest} (recurring scan).` : null,
            textOrNull(evidence.settlement),
            textOrNull(evidence.caveats)
        ].filter(Boolean).join(' ');
        return {
            summary, completeText, observedProducts: products, exactProductObserved: answerScope === 'product' ? exact : null,
            detail: {
                status: textOrNull(evidence.status), checkedAt: textOrNull(evidence.checkedAt),
                searchWindow: evidence.searchWindow ?? null, transactions: total, products,
                ...(latest ? { latestObservedAt: latest } : {})
            }
        };
    }

    /** Contractual terms, operational availability and observed completion remain separate facts. */
    function shapeRedemptionUsability({
        redemption = null, productSymbol = null, answerScope = productSymbol ? 'product' : 'programme',
        operationalRouteAvailable = null, operationalRouteEvidence = null, successfulRedemptionObserved = null,
        successfulRedemptionEvidence = null, secondaryMarketAvailable = null, reviewStatus = null, includeEvidenceDetail = true
    } = {}) {
        const terms = redemption && typeof redemption === 'object' ? redemption : {};
        const right = boolOrNull(terms.available);
        const scopes = terms.termScopes && typeof terms.termScopes === 'object' ? terms.termScopes : {};
        const scoped = (value, field, termScope) => scopeRedemptionTerm(value, {
            productSymbol, field, termScope, answerScope
        });
        const eligibility = scoped(terms.eligibility, 'eligibility', scopes.eligibility);
        const minimum = scoped(terms.minimum, 'minimum', scopes.minimum);
        const fees = scoped(terms.fees, 'fee', scopes.fees);
        const rails = scoped(terms.rails, 'route', scopes.rails);
        const observed = boolOrNull(successfulRedemptionObserved) === true
            ? scopeObservedExecution(successfulRedemptionEvidence, { productSymbol, answerScope }) : null;
        const fields = [
            { id: 'contractual-right', label: 'Contractual right', value: right, evidence: documented(right) },
            { id: 'eligibility-and-place', label: 'Eligible holder and route', ...eligibility, evidence: termEvidence(eligibility) },
            { id: 'kyc', label: 'KYC / AML', value: boolOrNull(terms.kyc), evidence: documented(boolOrNull(terms.kyc)) },
            { id: 'minimum', label: 'Minimum', ...minimum, evidence: termEvidence(minimum) },
            { id: 'fees', label: 'Fees', ...fees, evidence: termEvidence(fees) },
            { id: 'timing-and-settlement', label: 'Timing and settlement asset', ...rails, evidence: termEvidence(rails) },
            { id: 'route-currently-available', label: 'Route currently available', value: boolOrNull(operationalRouteAvailable), evidence: operationalEvidence(boolOrNull(operationalRouteAvailable), operationalRouteEvidence),
                ...(includeEvidenceDetail ? { evidenceDetail: operationalRouteEvidence && typeof operationalRouteEvidence === 'object' ? operationalRouteEvidence : null } : {}) },
            { id: 'successful-redemption', label: 'Successful redemption independently observed', value: boolOrNull(successfulRedemptionObserved), evidence: observation(boolOrNull(successfulRedemptionObserved)),
                ...(observed ? { summary: observed.summary, completeText: observed.completeText, observedProducts: observed.observedProducts,
                    exactProductObserved: observed.exactProductObserved } : {}),
                ...(includeEvidenceDetail && observed ? { evidenceDetail: observed.detail } : {}) },
            { id: 'secondary-market-exit', label: 'Secondary-market exit', value: boolOrNull(secondaryMarketAvailable), evidence: observation(boolOrNull(secondaryMarketAvailable)) }
        ];
        return {
            answerScope,
            productSymbol: productSymbol ?? null,
            reviewStatus: reviewStatus && typeof reviewStatus === 'object' ? reviewStatus : null,
            directRedemption: right,
            documentedButNotIndependentlyObserved: right !== null
                && boolOrNull(successfulRedemptionObserved) !== true,
            fields
        };
    }

    return { REDEMPTION_EVIDENCE_STATES, scopeRedemptionTerm, scopeObservedExecution, shapeRedemptionUsability };
});
