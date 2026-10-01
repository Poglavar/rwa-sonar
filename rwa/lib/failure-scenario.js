// Pure hypothetical scenario selection. Evidence basis is independent of route availability.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./research.js'));
    else root.__rwaFailureScenario = factory(root.__rwaResearch);
})(this, function (research) {
    const MODES = { normal: 'Normal arrangement', 'issuer-unavailable': 'Issuer unavailable', 'custodian-fails': 'Custodian fails' };
    function scenario(product, contextId, mode = 'normal', options = {}) {
        if (!MODES[mode]) throw new Error('Unknown scenario');
        const context = product.contexts.find((c) => c.id === contextId);
        const exact = options.deploymentId && !product.deployments.some((d) => d.id === options.deploymentId && d.instrumentId && d.instrumentId === product.instrument?.id);
        const answer = !exact && context ? product.scenarios?.find((a) => a.mode === mode && a.contextId === contextId && a.termsId === context.termsId) : null;
        const failure = research.resolveClaim(product, contextId, 'failure', options);
        const normal = mode === 'normal';
        return { mode, label: MODES[mode], hypothetical: !normal, affected: mode === 'issuer-unavailable' ? 'issuer' : mode === 'custodian-fails' ? 'custodian' : null,
            issuer: product.scenarioIssuer || (product.instrument || product.programme).issuer,
            custodyActors: exact ? [] : product.scenarioActors || [],
            state: normal ? 'description' : answer?.status || 'unknown',
            summary: normal ? 'The claim, custody arrangement and exit route are separate relationships. Select a scenario to inspect what is established about a party becoming unavailable.'
                : answer?.outcome || (exact ? 'This exact token is not bound to the reviewed terms. No scenario outcome is inherited.' : mode === 'issuer-unavailable' ? 'An operational outage is not insolvency. The reviewed evidence does not establish an independent route during issuer unavailability.' : failure.summary),
            sourceIds: answer?.sourceIds || (!normal && mode === 'custodian-fails' ? failure.sourceIds : []),
            routes: normal ? Object.fromEntries([['claim','rights'],['custody','backing'],['exit','exit']].map(([route,dimension]) => [route,research.resolveClaim(product,contextId,dimension,options).state === 'supported' ? 'described' : 'unknown'])) : answer?.routes || { claim: 'unknown', custody: 'unknown', exit: 'unknown' },
            checkedAt: answer?.checkedAt || product.reviewedAt || product.evidenceCheckedAt || null,
            scope: product.kind === 'programme' ? 'Programme scenario; sampled product terms may differ' : context?.label || 'Context unresolved' };
    }
    return { MODES, scenario };
});
