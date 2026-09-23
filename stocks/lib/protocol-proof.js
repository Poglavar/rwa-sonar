/* Dependency-free proof wording for both the static dossier builder and stocks.html. */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.__rwaProtocolProof = factory();
})(this, function () {
    function protocolProofModel({ proof = {}, integration = {}, fetchedAt = null } = {}) {
        const sourceStatus = proof.sourceStatus ?? 'not established';
        const simulated = proof.readOnlyExecutionSimulated === true;
        const decoded = proof.configurationDecoded === true;
        const sourceListed = ['exact-token-registry', 'named-product-page'].includes(sourceStatus);
        const observedMarket = sourceStatus === 'observed-market';
        const observedAt = proof.observedAt ?? proof.activityObservedAt ?? null;
        const asOf = observedAt ?? fetchedAt;
        let stage = 'not-established';
        let headline = 'No exact-token support was established';
        if (simulated) { stage = 'simulated'; headline = 'Read-only execution was simulated for this exact token'; }
        else if (decoded) { stage = 'decoded'; headline = 'Configuration was decoded for this exact token'; }
        else if (sourceListed) { stage = 'source-listed'; headline = 'Exact-token support is source-listed'; }
        else if (observedMarket) { stage = 'observed-market'; headline = 'An exact-token market was observed'; }
        const sourceLabel = sourceListed ? 'The protocol or product source names this exact token.'
            : observedMarket ? 'Market-data collection observed this exact-token market.'
                : 'No qualifying exact-token source listing was recorded.';
        const execution = simulated ? 'This is a read-only simulation, not a completed user transaction.'
            : decoded ? 'Configuration decoding is not execution proof.'
                : 'No configuration decoding or read-only execution simulation was performed.';
        const activityBasis = Array.isArray(proof.activityBasis) ? proof.activityBasis.filter((value) => typeof value === 'string' && value) : [];
        const activityStatement = proof.activityObserved === true
            ? `An activity indicator was observed${observedAt ? ` at ${observedAt}` : ''}; its stated basis is ${activityBasis.join(', ') || 'not recorded'}. Reported metrics are not independently executed trades.`
            : 'Reported market metrics, if shown, are source-reported parameters or activity indicators, not independently executed trades.';
        return { stage, headline, sourceStatus, observedAt, fetchedAt, asOf,
            detail: `${sourceLabel} ${execution}`, activityStatement };
    }
    return { protocolProofModel };
});
