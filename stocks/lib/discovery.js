/*
 * Pure discovery and explanation helpers shared by stocks.html and its unit tests. UMD keeps the
 * browser path dependency-free while letting Jest require the exact same code. No DOM or clock is
 * read here: callers pass records and, for freshness, the time they want to judge against.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.__rwaDiscovery = factory();
})(this, function () {
    const CLAIMS = [
        'price exposure only — not ownership of the share',
        'an unsecured claim against the token issuer — not a share in the company',
        'a claim secured over collateral — not the underlying share itself',
        'a beneficial interest in shares held through an intermediary',
        'the registered share itself, subject to the official shareholder register'
    ];

    function clean(value) {
        return typeof value === 'string' ? value.trim() : '';
    }

    function controlIsOn(value) {
        if (value === true) return true;
        const v = clean(value).toLowerCase();
        return v === 'all' || v === 'some' || v === 'yes' || (v !== '' && v !== 'none' && v !== 'no');
    }

    function laypersonVerdict({ claimRung = null, redemptionAvailable = null, control = {} } = {}) {
        const rung = Number.isInteger(claimRung) && claimRung >= 0 && claimRung <= 4 ? claimRung : null;
        const headline = rung === null ? 'The legal claim is not established yet.' : `You own ${CLAIMS[rung]}.`;
        const redemption = redemptionAvailable === true
            ? 'Eligible holders can redeem through the issuer.'
            : redemptionAvailable === false
                ? 'There is no holder redemption right recorded.'
                : 'Redemption rights are not established.';
        const powers = [];
        if (controlIsOn(control.clawback)) powers.push('reclaim');
        if (controlIsOn(control.freezeAuthority)) powers.push('freeze');
        if (controlIsOn(control.pausable)) powers.push('pause');
        const controlNote = powers.length === 0
            ? 'No freeze, pause or clawback power was detected in this record.'
            : `The issuer or its operator can ${powers.join(', ').replace(/, ([^,]*)$/, ' or $1')} tokens on-chain.`;
        return { headline, redemption, controlNote, text: `${headline} ${redemption} ${controlNote}` };
    }

    function legalReviewStatus(issuer) {
        const evidence = issuer && issuer.evidence && typeof issuer.evidence === 'object' ? issuer.evidence : {};
        const coverage = evidence.coverage && typeof evidence.coverage === 'object' ? evidence.coverage : {};
        const needed = Number.isFinite(coverage.needed) ? coverage.needed : 0;
        const sourced = Number.isFinite(coverage.sourced) ? coverage.sourced : 0;
        const unverified = Number.isFinite(evidence.unverified) ? evidence.unverified : 0;
        const inference = Number.isFinite(evidence.inference) ? evidence.inference : 0;
        const missing = Math.max(0, needed - sourced);
        const pending = needed === 0 || missing > 0 || unverified > 0 || inference > 0;
        const reasons = [];
        if (needed === 0) reasons.push('coverage has not been measured');
        else if (missing > 0) reasons.push(`${missing} required field${missing === 1 ? ' lacks' : 's lack'} sourced evidence`);
        if (unverified > 0) reasons.push(`${unverified} claim${unverified === 1 ? '' : 's'} await re-checking`);
        if (inference > 0) reasons.push(`${inference} conclusion${inference === 1 ? '' : 's'} ${inference === 1 ? 'is' : 'are'} inferential`);
        return {
            pending,
            label: pending ? 'Legal review pending' : 'Legal evidence reviewed',
            detail: reasons.length ? reasons.join('; ') : `${sourced}/${needed} required fields sourced`
        };
    }

    function tokenSearchText(token, issuer) {
        return [
            token && token.symbol, token && token.name, token && token.underlyingTicker,
            token && token.mint, token && token.issuer,
            issuer && issuer.name, issuer && issuer.slug, issuer && issuer.issuingEntity
        ].map(clean).filter(Boolean).join(' ').toLowerCase();
    }

    function globalSearch(tokens, issuers, query, limit = 12) {
        const q = clean(query).toLowerCase();
        if (!q) return { issuers: [], tokens: [] };
        const issuerList = Array.isArray(issuers) ? issuers : [];
        const tokenList = Array.isArray(tokens) ? tokens : [];
        const bySlug = new Map(issuerList.map((issuer) => [issuer.slug, issuer]));
        const issuerMatches = issuerList.filter((issuer) => [issuer.name, issuer.slug, issuer.issuingEntity, issuer.legalForm]
            .map(clean).join(' ').toLowerCase().includes(q));
        const tokenMatches = tokenList.filter((token) => tokenSearchText(token, bySlug.get(token.issuer)).includes(q));
        return { issuers: issuerMatches.slice(0, limit), tokens: tokenMatches.slice(0, limit) };
    }

    function sameUnderlyingGroups(tokens) {
        const groups = new Map();
        for (const token of Array.isArray(tokens) ? tokens : []) {
            const ticker = clean(token && token.underlyingTicker).toUpperCase();
            const issuer = clean(token && token.issuer);
            if (!ticker || !issuer) continue;
            if (!groups.has(ticker)) groups.set(ticker, new Map());
            const byIssuer = groups.get(ticker);
            if (!byIssuer.has(issuer)) byIssuer.set(issuer, []);
            byIssuer.get(issuer).push(token);
        }
        return [...groups.entries()]
            .filter(([, byIssuer]) => byIssuer.size >= 2)
            .map(([ticker, byIssuer]) => ({
                ticker,
                issuerCount: byIssuer.size,
                tokenCount: [...byIssuer.values()].reduce((sum, list) => sum + list.length, 0),
                rows: [...byIssuer.entries()].map(([issuer, list]) => ({
                    issuer,
                    tokens: list.slice().sort((a, b) => ((b.market && b.market.liquidity) || 0) - ((a.market && a.market.liquidity) || 0))
                })).sort((a, b) => a.issuer.localeCompare(b.issuer))
            }))
            .sort((a, b) => b.issuerCount - a.issuerCount || b.tokenCount - a.tokenCount || a.ticker.localeCompare(b.ticker));
    }

    function collectorHealth(sources, nowMs, maxAgeHours = 48) {
        const labels = {
            universe: 'Asset universe', onchain: 'On-chain state', sponsorApis: 'Issuer APIs',
            referencePrices: 'Reference prices', venues: 'Trading venues', holders: 'Holders'
        };
        const rows = Object.entries(labels).map(([key, label]) => {
            const raw = sources && sources[key];
            const stamp = typeof raw === 'string' ? raw : raw && raw.fetchedAt;
            const time = typeof stamp === 'string' ? Date.parse(stamp) : NaN;
            const ageHours = Number.isFinite(time) && Number.isFinite(nowMs) ? Math.max(0, (nowMs - time) / 3600000) : null;
            return { key, label, fetchedAt: Number.isFinite(time) ? stamp : null, ageHours, fresh: ageHours !== null && ageHours <= maxAgeHours };
        });
        const fresh = rows.filter((row) => row.fresh).length;
        return { rows, fresh, total: rows.length, healthy: fresh === rows.length };
    }

    return { controlIsOn, laypersonVerdict, legalReviewStatus, tokenSearchText, globalSearch, sameUnderlyingGroups, collectorHealth };
});
