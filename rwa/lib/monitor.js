// Pure monitoring coverage and material-change rules; failures preserve the last successful state.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.__rwaMonitor = factory();
})(this, function () {
    function coverage(deployment, record, now = Date.now()) {
        if (!record?.configured) return 'not-configured';
        if (!record.lastSuccessAt) return 'awaiting-observation';
        const age = now - Date.parse(record.lastSuccessAt);
        if (!Number.isFinite(age) || age < 0 || age > record.cadenceSeconds * 2000) return 'stale';
        return record.lastAttemptStatus === 'failed' ? 'failed-latest-check' : 'recent-observation';
    }
    function successfulValue(v) { return v && v.state === 'observed'; }
    function materialChanges(previous, next) {
        if (!previous || !next || previous.decoderVersion !== next.decoderVersion) return [];
        const changes = [];
        for (const [field, value] of Object.entries(next.fields || {})) {
            if (['supply', 'supplyRaw', 'decimals'].includes(field)) continue;
            const old = previous.fields?.[field];
            if (successfulValue(old) && successfulValue(value) && JSON.stringify(old.value) !== JSON.stringify(value.value)) changes.push({ field, before: old.value, after: value.value });
        }
        return changes;
    }
    function recordAttempt(previous, attempt, { now, cadenceSeconds = 3600 }) {
        return { configured: true, cadenceSeconds, lastAttemptAt: now, lastAttemptStatus: attempt.ok ? 'successful' : 'failed',
            lastError: attempt.ok ? null : attempt.error, lastSuccessAt: attempt.ok ? now : previous?.lastSuccessAt || null,
            observation: attempt.ok ? attempt.observation : previous?.observation || null };
    }
    function counts(products, records, now) {
        const deployments = products.flatMap((p) => p.deployments);
        const identities = deployments.filter((d) => d.identityCheckedAt);
        return { publicProductReviews: products.filter((p) => p.kind !== 'programme').length,
            programmeDossiers: products.filter((p) => p.kind === 'programme').length,
            instrumentResearchSubjects: new Set(products.map((p) => p.instrument?.id).filter(Boolean)).size,
            exposures: new Set(products.map((p) => p.exposure.id)).size,
            indexedDeployments: new Set(deployments.map((d) => d.id)).size,
            identifiedDeployments: new Set(identities.map((d) => d.id)).size,
            configuredMonitors: deployments.filter((d) => records[d.id]?.configured).length,
            recentSuccessfulMonitors: deployments.filter((d) => coverage(d, records[d.id], now) === 'recent-observation').length };
    }
    return { coverage, materialChanges, recordAttempt, counts };
});
