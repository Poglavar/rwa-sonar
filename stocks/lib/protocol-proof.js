/* Dependency-free proof wording for both the static dossier builder and stocks.html: how we know a
   protocol accepts an exact token, in a reader's words. The stage ids are data keys and stay as they are. */
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
        const onchainPosition = sourceStatus === 'onchain-position';
        const observedAt = proof.observedAt ?? proof.activityObservedAt ?? null;
        const asOf = observedAt ?? fetchedAt;
        let stage = 'not-established';
        let headline = 'We found no proof that this protocol accepts this exact token';
        if (simulated) { stage = 'simulated'; headline = 'We simulated using this exact token here, without sending a transaction'; }
        else if (decoded) { stage = 'decoded'; headline = 'We read this market’s settings for this exact token on-chain'; }
        else if (sourceListed) { stage = 'source-listed'; headline = 'The protocol’s own list names this exact token'; }
        else if (observedMarket) { stage = 'observed-market'; headline = 'We saw a live market for this exact token'; }
        else if (onchainPosition) { stage = 'account-observed'; headline = 'We saw a protocol account holding this exact token on-chain'; }
        const sourceLabel = sourceListed ? 'The protocol’s registry or product page names this exact token.'
            : observedMarket ? 'Our market data shows a live market for this exact token.'
                : onchainPosition ? 'No protocol registry lists this token; an account owned by the protocol program was read on-chain holding it.'
                : 'No protocol list or product page we checked names this exact token.';
        const execution = simulated ? 'A simulation is not a completed transaction.'
            : decoded ? 'Reading the settings does not prove a transaction would go through.'
                : 'We have not read its settings or simulated a transaction.';
        const activityBasis = Array.isArray(proof.activityBasis) ? proof.activityBasis.filter((value) => typeof value === 'string' && value) : [];
        const activityStatement = proof.activityObserved === true
            ? `We saw activity${observedAt ? ` at ${observedAt}` : ''}, based on ${activityBasis.join(', ') || 'an unrecorded source'}. Reported figures are not trades we made or checked.`
            : 'Any figures shown are what the protocol reports, not trades we made or checked.';
        return { stage, headline, sourceStatus, observedAt, fetchedAt, asOf,
            detail: `${sourceLabel} ${execution}`, activityStatement };
    }
    /** Who holds a token a protocol uses, and what enforces its terms (capability custody/enforcement ids). */
    const CUSTODY_WORDS = { protocol: 'the protocol holds the token', atomic: 'held only inside one transaction' };
    const ENFORCEMENT_WORDS = { 'smart-contract': 'enforced by code', 'smart-contract-plus-operator': 'enforced by code plus an operator' };
    function capabilityWords(capability) {
        return `${CUSTODY_WORDS[capability?.custody] ?? 'who holds it is unknown'} · ${ENFORCEMENT_WORDS[capability?.enforcement] ?? 'how it is enforced is unknown'}`;
    }

    /** Whether the Solana accounts a protocol publishes for this token exist, and what that does not prove. */
    function accountCheckWords(proof = {}, corroboration = null) {
        const total = proof?.accountCount ?? corroboration?.accountCount;
        if (!(total > 0)) return 'The protocol publishes no Solana account for us to check';
        const existing = proof?.existingAccountCount ?? corroboration?.verifiedCount;
        return `${typeof existing === 'number' ? existing : 'An unknown number'} of ${total} accounts the protocol publishes exist on-chain (that they exist, not that they work)`;
    }

    /**
     * The protocol dossier's file name (protocols/<slug>.html) for one token integration. Shared so
     * the stocks page, cards and journal can link a researched market without rebuilding dossiers.
     */
    function dossierSlug(item, integration, number = 0) {
        const core = [item?.symbol || 'token', integration?.protocolId || 'protocol', integration?.id || number]
            .join('-').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        return `${core}-${String(item?.mint || '').slice(0, 6).toLowerCase()}`;
    }

    return { protocolProofModel, dossierSlug, capabilityWords, accountCheckWords };
});
