// Pure evidence applicability and comparison rules; never inherit legal or chain findings by name.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.__rwaResearch = factory();
})(this, function () {
    const DIMENSIONS = { rights: 'What do I own?', ledger: 'Which record counts?', backing: 'What backs it?', controls: 'Who can intervene?', access: 'Who can hold and use it?', exit: 'How can I exit?', failure: 'What happens if it fails?' };
    const STATES = { supported: 'Documented', unknown: 'Not established', 'not-applicable': 'Not applicable', stale: 'Historical evidence', conflicting: 'Unresolved source conflict' };
    const BASES = { 'source-statement': 'Source statement', analysis: 'Research interpretation', observed: 'Observed' };
    const unavailable = (reason) => ({ state: 'unknown', basis: 'analysis', summary: reason, sourceIds: [] });
    function applies(scope, target) {
        if (!scope || !target) return false;
        if (scope.programmeId) {
            if (target.kind !== 'programme' || target.programmeId !== scope.programmeId || target.deploymentId || target.instrumentId) return false;
        } else if (!scope.instrumentId || scope.instrumentId !== target.instrumentId || target.kind === 'programme') return false;
        for (const key of ['contextId', 'termsId', 'deploymentId']) if (scope[key] && scope[key] !== target[key]) return false;
        if ((scope.from || scope.through) && !target.asOf) return false;
        return (!scope.from || target.asOf >= scope.from) && (!scope.through || target.asOf <= scope.through);
    }
    function resolveClaim(product, contextId, dimension, options = {}) {
        const context = product.contexts.find((c) => c.id === contextId);
        if (!context) return unavailable('Select a documented holder context.');
        if (options.deploymentId) {
            const deployment = product.deployments.find((d) => d.id === options.deploymentId);
            if (!deployment || !product.instrument || deployment.instrumentId !== product.instrument.id) return unavailable('This deployment has no verified binding to the reviewed instrument and terms.');
        }
        const target = { kind: product.kind || 'instrument', instrumentId: product.instrument?.id || null, programmeId: product.programmeId, contextId, termsId: context.termsId, asOf: product.reviewedAt?.slice(0, 10) || null, ...options };
        const claims = product.claims.filter((c) => c.dimension === dimension && applies(c.scope, target));
        if (!claims.length) return unavailable('No finding applicable to this instrument, context and terms period.');
        if (claims.length > 1) return { ...unavailable('Multiple applicable findings require reconciliation.'), state: 'conflicting' };
        return claims[0];
    }
    function compare(left, leftContext, right, rightContext, leftOptions = {}, rightOptions = {}) {
        const ld = left.deployments.find((d) => d.id === leftOptions.deploymentId), rd = right.deployments.find((d) => d.id === rightOptions.deploymentId);
        const sameInstrument = Boolean(left.instrument?.id && left.instrument.id === right.instrument?.id);
        const sameUnderlying = Boolean(ld?.underlying && ld.underlying === rd?.underlying);
        return { mode: sameInstrument && ld && rd && ld.id !== rd.id ? 'instrument-networks' : sameUnderlying ? 'underlying-products' : 'similar-exposure', differentExposure: left.exposure.id !== right.exposure.id,
            rows: Object.entries(DIMENSIONS).map(([key, label]) => ({ key, label, left: resolveClaim(left, leftContext, key, leftOptions), right: resolveClaim(right, rightContext, key, rightOptions) })) };
    }
    function validateResearch(data) {
        if (data.schemaVersion !== 1 || !Array.isArray(data.products)) throw new Error('Invalid research schema');
        const ids = new Set(), instruments = new Set(), deployments = new Set();
        for (const p of data.products) {
            const programme = p.kind === 'programme';
            const subject = programme ? p.programme : p.instrument;
            if (!p.id || ids.has(p.id) || !subject?.id || (!programme && instruments.has(subject.id))) throw new Error('Duplicate or missing research identity');
            ids.add(p.id); if (!programme) instruments.add(subject.id);
            if (programme && p.instrument) throw new Error(`Programme cannot imply instrument identity: ${p.id}`);
            if (!p.programmeId || !p.exposure?.id || (!programme && !p.reviewedAt) || !p.contexts?.length) throw new Error(`Incomplete identity: ${p.id}`);
            const sources = new Set(p.sources.map((s) => s.id));
            if (sources.size !== p.sources.length) throw new Error(`Duplicate source: ${p.id}`);
            for (const s of p.sources) if (!/^https:\/\//.test(s.url) || (!programme && !s.checkedAt) || !s.locator) throw new Error(`Incomplete source: ${s.id}`);
            if (new Set(p.contexts.map((c) => c.id)).size !== p.contexts.length) throw new Error(`Duplicate context: ${p.id}`);
            for (const c of p.contexts) if (!c.termsId) throw new Error(`Missing terms: ${p.id}`);
            for (const c of p.claims) {
                if (!DIMENSIONS[c.dimension] || !STATES[c.state] || !BASES[c.basis] || !c.summary) throw new Error(`Invalid claim: ${p.id}`);
                if ((programme ? c.scope?.programmeId !== p.programmeId || Boolean(c.scope?.instrumentId || c.scope?.deploymentId) : c.scope?.instrumentId !== p.instrument.id) || !p.contexts.some((x) => x.id === c.scope.contextId && x.termsId === c.scope.termsId)) throw new Error(`Unbound claim: ${p.id}`);
                if (c.scope.from && c.scope.through && c.scope.from > c.scope.through) throw new Error(`Invalid claim period: ${p.id}`);
                if (c.sourceIds.some((id) => !sources.has(id)) || (c.state === 'supported' && !c.sourceIds.length)) throw new Error(`Missing claim evidence: ${p.id}`);
                if (c.basis === 'observed' && (!c.scope.deploymentId || !c.observedAt)) throw new Error(`Observation lacks deployment/date: ${p.id}`);
                if (c.scope.deploymentId && !p.deployments.some((d) => d.id === c.scope.deploymentId)) throw new Error(`Unknown claim deployment: ${p.id}`);
            }
            for (const c of p.contexts) for (const dimension of Object.keys(DIMENSIONS)) {
                if (!p.claims.some((claim) => claim.dimension === dimension && claim.scope.contextId === c.id)) throw new Error(`Missing dimension: ${p.id}/${c.id}/${dimension}`);
            }
            for (const d of p.deployments) {
                if (!d.id || deployments.has(d.id) || !d.network || !d.address || !STATES[d.controls.state]) throw new Error(`Invalid deployment: ${p.id}`);
                deployments.add(d.id);
                if (d.instrumentId && (!p.instrument || d.instrumentId !== p.instrument.id)) throw new Error(`Wrong deployment instrument: ${p.id}`);
                if (d.sourceIds.some((id) => !sources.has(id))) throw new Error(`Unknown deployment evidence: ${p.id}`);
                if (d.controls.state === 'supported' && !d.chainCheckedAt) throw new Error(`Controls lack chain check: ${p.id}`);
            }
            for (const e of p.evidenceProfiles) {
                if (!['reviewed', 'obtained', 'not-obtained', 'promised-unpublished'].includes(e.availability) || !e.method || !e.scope || !e.limit || e.sourceIds.some((id) => !sources.has(id))) throw new Error(`Invalid evidence profile: ${p.id}`);
            }
        }
        return data;
    }
    return { DIMENSIONS, STATES, BASES, applies, resolveClaim, compare, validateResearch };
});
