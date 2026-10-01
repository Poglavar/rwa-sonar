// Pure adapter from the stock issuer/token indexes into programme-scoped research records.
// It preserves legacy token observations but does not bind them to legal instruments.
const DIMENSIONS = ['rights', 'ledger', 'backing', 'controls', 'access', 'exit', 'failure'];
const FIELD_PATTERNS = {
    rights: [/^holderClaim$/, /^holderRights(?:\.|$)/, /^legalForm$/, /^securityInterest\./, /^bankruptcyRemote$/],
    ledger: [/^ownershipLedger(?:\.|$)/, /^vocabulary\.blockchainIsMainLedger\.value$/],
    backing: [/^underlyingAsset(?:\.|$)/, /^underlyingCustodian$/, /^collateral(?:\.|$)/, /^custodyVerification\./, /^attestations\[/],
    controls: [/^keyGovernance\./, /^authorityFacts(?:\.|$)/, /^knownExtensions(?:\[|$)/, /^transferRestrictions\.(?:mechanism|allowlist)$/],
    access: [/^transferRestrictions\./, /^regulatoryStatus$/, /^parties\.audience$/],
    exit: [/^redemption\./],
    failure: []
};
const FALLBACK = {
    rights: 'The legacy programme dossier does not establish this programme-level holder claim; terms may differ by token.',
    ledger: 'The dossier does not establish a single programme-wide legal register or precedence rule between on-chain and off-chain records.',
    backing: 'The dossier does not establish programme-wide underlying assets, custody and holder title as one legally enforceable chain.',
    controls: 'No programme-wide control conclusion can be safely drawn from the available issuer-level evidence.',
    access: 'Programme-wide holder eligibility and access conditions were not established from the available dossier fields.',
    exit: 'A programme-wide holder exit right and operational redemption route were not established from the available dossier fields.',
    failure: 'A programme-wide failure outcome was not established; token-level and scenario-specific terms may differ.'
};
const text = (value) => typeof value === 'string' ? value.trim() : value == null ? '' : JSON.stringify(value);
const clip = (value, max = 900) => {
    const s = text(value).replace(/\s+/g, ' ').trim();
    if (s.length <= max) return s;
    const prefix = s.slice(0, max - 1);
    const boundary = Math.max(prefix.lastIndexOf('. '), prefix.lastIndexOf('; '), prefix.lastIndexOf(' '));
    return `${prefix.slice(0, boundary > max * 0.65 ? boundary : prefix.length).replace(/[\s,;:.]+$/, '')}…`;
};
const slugPart = (s) => String(s || '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
const array = (v) => Array.isArray(v) ? v : [];
const humanLabel = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[._-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
function compactValue(value, max = 300) {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    if (Array.isArray(value)) return clip(value.slice(0, 5).map((v) => compactValue(v, 120)).filter(Boolean).join(', '), max);
    if (typeof value === 'object') return clip(Object.entries(value).slice(0, 8).map(([k, v]) => `${humanLabel(k)}: ${compactValue(v, 160)}`).join('; '), max);
    return clip(value, max);
}
function shortQuote(value, maxWords = 25, maxChars = 220) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const words = value.trim().split(/\s+/);
    const out = words.slice(0, maxWords).join(' ');
    return clip(out, maxChars);
}
const fieldsFor = (dim, issuer) => array(issuer.claims).filter((claim) => claim && (!claim.subjectType || claim.subjectType === 'issuer' || claim.subjectType === 'programme')
    && FIELD_PATTERNS[dim].some((re) => re.test(claim.field || '')));
const isReviewed = (claim) => claim?.status === 'confirmed' || (claim?.status === 'inference' && Boolean(claim.reviewedAt));
const isConflict = (claim) => ['conflicting', 'contradicted'].includes(claim?.status);
function failureScenarios(dossier) {
    const scenarios = array(dossier?.whatIf);
    const preferred = ['issuer-insolvency', 'custodian-insolvency', 'provider-fails', 'issuer-wind-down', 'redemption-refused', 'authority-key-compromised', 'chain-outage'];
    return preferred.map((mode) => scenarios.find((w) => w?.mode === mode && w.outcome)).filter(Boolean).slice(0, 4);
}
function stockResearch(issuerDb, tokenDb, dossiers = {}) {
    if (!Array.isArray(issuerDb?.issuers) || !Array.isArray(tokenDb?.tokens)) throw new Error('stockResearch requires issuer and token arrays');
    const usedMints = new Set();
    const sourceDates = {
        chain: tokenDb.sources?.onchain?.fetchedAt || null,
        venues: tokenDb.sources?.venues?.fetchedAt || null,
        referencePrices: tokenDb.sources?.referencePrices?.fetchedAt || null,
        holders: tokenDb.sources?.holders?.fetchedAt || null,
        holderSupply: tokenDb.sources?.holders?.supplyFetchedAt || null,
        identitiesBuiltAt: tokenDb.sources?.identities?.builtAt || null
    };
    return issuerDb.issuers.map((issuer) => {
        const programmeId = issuer.slug;
        if (!programmeId) throw new Error('Stock issuer is missing a programme slug');
        const contextId = 'programme';
        const termsId = `programme:dossier:${programmeId}`;
        const dossier = dossiers[programmeId] || {};
        const merged = { ...dossier, ...issuer, redemption: { ...(dossier.redemption || {}), ...(issuer.redemption || {}), termScopes: dossier.redemption?.termScopes || issuer.redemption?.termScopes } };
        const sources = [];
        const sourceIndex = new Map();
        const addSource = (claim, fallbackLabel) => {
            const url = claim?.url;
            const locator = claim?.locator;
            if (!/^https:\/\//.test(url || '') || !locator) return null;
            const checkedAt = claim.accessedAt || null;
            const key = `${url}\n${locator}\n${checkedAt || ''}`;
            if (sourceIndex.has(key)) return sourceIndex.get(key);
            const id = `src-${slugPart(programmeId)}-${sources.length + 1}`;
            sources.push({ id, title: `Programme evidence: ${claim.field || fallbackLabel || 'scenario review'}`, url,
                documentDate: null, effectiveDate: null, checkedAt, locator: clip(locator, 500),
                status: claim.status || null, quote: shortQuote(claim.quote) });
            sourceIndex.set(key, id);
            return id;
        };
        const dimensionEvidence = Object.fromEntries(DIMENSIONS.map((dim) => {
            const matched = fieldsFor(dim, issuer).sort((a, b) => Number(isReviewed(b)) - Number(isReviewed(a))).slice(0, 8);
            return [dim, { ids: matched.map((c) => addSource(c, dim)).filter(Boolean), supported: matched.some(isReviewed), conflicting: matched.some(isConflict) }];
        }));
        const scenarios = failureScenarios(dossier);
        const scenarioSourceIds = scenarios.map((w) => addSource({ url: w.url, locator: w.locator, accessedAt: w.accessedAt, quote: w.quote,
            status: w.status === 'documented' ? 'confirmed' : w.status === 'inferred' ? 'inference' : 'unverified', field: `whatIf.${w.mode}` }, w.mode)).filter(Boolean);
        const evidenceIds = [...new Set(DIMENSIONS.flatMap((d) => dimensionEvidence[d].ids).concat(scenarioSourceIds))];

        const summaryFor = (dim) => {
            if (dim === 'rights') {
                const pieces = [merged.legalForm && `Dossier legal-form classification: ${merged.legalForm}.`, merged.holderClaim && `Programme-level holder-claim analysis: ${clip(merged.holderClaim, 1100)}`].filter(Boolean);
                return pieces.join(' ') || FALLBACK.rights;
            }
            if (dim === 'ledger') {
                const ledger = merged.ownershipLedger || merged.vocabulary?.blockchainIsMainLedger?.value;
                return ledger ? `Dossier ledger analysis: ${compactValue(ledger, 900)}. Programme-level summary only; product-specific register and priority rules require separate terms.` : FALLBACK.ledger;
            }
            if (dim === 'backing') {
                const pieces = [merged.underlyingAsset && `Underlying-asset dossier: ${clip(merged.underlyingAsset, 480)}`,
                    merged.collateral && `Disclosed collateral: ${compactValue(merged.collateral, 320)}`,
                    merged.underlyingCustodian && `Disclosed custody chain: ${clip(merged.underlyingCustodian, 480)}`,
                    merged.custodyVerification && `Verification status: ${compactValue({ type: merged.custodyVerification.type, evidenceStatus: merged.custodyVerification.evidenceStatus, agent: merged.custodyVerification.agent, frequency: merged.custodyVerification.frequency, notes: merged.custodyVerification.notes }, 480)}`].filter(Boolean);
                return pieces.length ? `${pieces.join(' ')} Reserve or custody evidence does not itself establish tokenholder title or a direct claim against the custodian.` : FALLBACK.backing;
            }
            if (dim === 'controls') {
                const pieces = [merged.transferRestrictions && `Dossier transfer restrictions: ${compactValue(merged.transferRestrictions, 360)}`,
                    merged.keyGovernance && `Reported key governance: ${compactValue(merged.keyGovernance, 460)}`,
                    merged.knownExtensions?.length && `Reported token extensions: ${compactValue(merged.knownExtensions.slice(0, 5), 300)}`,
                    merged.authorityFacts && `Reported authority facts: ${compactValue(merged.authorityFacts, 420)}`].filter(Boolean);
                return pieces.length ? `${pieces.join(' ')} These legacy dossier facts are not a fresh per-mint chain check.` : FALLBACK.controls;
            }
            if (dim === 'access') {
                const pieces = [merged.transferRestrictions && `Holder/transfer restrictions: ${compactValue(merged.transferRestrictions, 650)}`,
                    merged.redemption?.eligibility && `Redemption eligibility: ${clip(merged.redemption.eligibility, 520)}`,
                    merged.regulatoryStatus && `Programme regulatory description: ${clip(merged.regulatoryStatus, 400)}`].filter(Boolean);
                return pieces.join(' ') || FALLBACK.access;
            }
            if (dim === 'exit') {
                const r = merged.redemption;
                if (!r) return FALLBACK.exit;
                const labels = { available: 'Redemption described', eligibility: 'Eligibility', rails: 'Settlement route', fees: 'Fees', minimum: 'Minimum', kyc: 'Verification', operationalRouteAvailable: 'Route status', successfulRedemptionObserved: 'Successful redemption observation' };
                const pieces = Object.keys(labels).filter((k) => r[k] !== undefined && r[k] !== null).map((k) => `${labels[k]}: ${compactValue(r[k], 420)}`);
                const scopes = r.termScopes && typeof r.termScopes === 'object' ? Object.entries(r.termScopes).map(([field, scope]) => `${humanLabel(field)}=${scope?.kind || 'scope not recorded'}`).join(', ') : null;
                return pieces.length ? `Programme redemption dossier: ${pieces.join('; ')}.${scopes ? ` Explicit termScopes: ${scopes}.` : ''} Product-specific terms, route operation and completed redemption are distinct; do not infer the latter from a documented route.` : FALLBACK.exit;
            }
            if (dim === 'failure') {
                if (!scenarios.length) return FALLBACK.failure;
                const points = scenarios.map((w) => `${humanLabel(w.mode)} (${w.status || 'status not recorded'}): ${clip(w.outcome, 270)}`);
                return `The legacy dossier's scenario analysis (not a record of actual events) includes: ${points.join(' ')} These scenarios may concern sampled products and are not validation of every token in the programme.`;
            }
            return FALLBACK[dim];
        };
        const claims = DIMENSIONS.map((dimension) => {
            const evidence = dimensionEvidence[dimension];
            const sourceIds = dimension === 'failure' ? [...new Set(scenarioSourceIds)] : [...new Set(evidence.ids)];
            const scenarioSupported = dimension === 'failure' && scenarios.some((w) => w.status === 'documented' || (w.status === 'inferred' && w.reviewedAt));
            const conflict = evidence.conflicting;
            const supported = dimension === 'failure' ? scenarioSupported : evidence.supported;
            let summary = summaryFor(dimension);
            if (!supported && sourceIds.length) summary = `Unverified or incomplete programme dossier evidence: ${summary}`;
            if (!supported && !sourceIds.length) summary = FALLBACK[dimension];
            return { dimension, state: conflict ? 'conflicting' : supported && sourceIds.length ? 'supported' : 'unknown', basis: 'analysis', summary, sourceIds,
                scope: { programmeId, contextId, termsId, from: null } };
        });
        const programmeTokens = tokenDb.tokens.filter((t) => t.issuer === programmeId);
        const deployments = programmeTokens.map((t) => {
            if (!t.mint || usedMints.has(t.mint)) throw new Error(`Missing or duplicate stock mint: ${t.mint}`);
            usedMints.add(t.mint);
            const tokenClaims = array(issuer.claims).filter((c) => c.subjectType !== 'issuer' && c.subjectId === t.symbol && /^https:\/\//.test(c.url || '') && c.locator);
            const deploymentSourceIds = tokenClaims.slice(0, 2).map((c) => addSource(c, 'exact mint identity')).filter(Boolean);
            const legacy = {
                identity: t.identity || null,
                tokenProgram: t.tokenProgram || t.recipe?.program || null,
                protocol: t.recipe || null,
                control: t.control || null,
                market: t.market || null,
                activity: t.activity || null,
                reference: t.reference || null,
                holders: t.holders || null,
                issuerApi: t.issuerApi || null,
                metadataUri: t.metadataUri || null,
                cardSlug: t.cardSlug || null,
                sourceDates
            };
            return { id: `solana:${t.mint}`, instrumentId: null, network: 'Solana', address: t.mint,
                symbol: t.symbol || null, name: t.name || null, underlying: t.underlyingTicker || t.companyName || t.issuerApi?.ticker || t.issuerApi?.underlying?.name || null,
                identity: t.identity?.status || 'Indexed mint; legal instrument binding not established',
                identityCheckedAt: null, chainCheckedAt: null, sourceIds: deploymentSourceIds,
                report: t.cardSlug ? `cards/${encodeURIComponent(t.cardSlug)}.html` : null,
                controls: { state: 'unknown', summary: 'Legacy token-index controls are retained for the exact mint below; this adapter did not perform a chain check or establish binding to any particular legal instrument.' },
                legacy };
        });
        const custodyType = merged.custodyVerification?.type || 'not established';
        const custodyStatus = merged.custodyVerification?.evidenceStatus;
        const reserveSourceIds = [...new Set(dimensionEvidence.backing.ids)];
        const evidenceProfiles = [
            { method: 'Legacy issuer dossier and linked source claims', scope: 'Programme-level legal, asset and operational descriptions; individual product terms may differ.',
                availability: 'reviewed', limit: 'The dossier is a historic source collection, not a fresh legal review; exact token-to-instrument binding and complete coverage of every listed product are not established.',
                sourceIds: evidenceIds, sourcePeriod: null, checkedAt: issuer.evidence?.lastCheckedAt || null },
            { method: custodyStatus === 'promised-unpublished' ? 'Promised custody / reserve verification' : `Legacy custody or reserve description (${custodyType})`,
                scope: 'Reserve quantity or custody evidence as described in the dossier; this does not establish tokenholder title, segregation or direct custodian recourse.',
                availability: custodyStatus === 'promised-unpublished' ? 'promised-unpublished' : reserveSourceIds.length ? 'reviewed' : 'not-obtained',
                limit: custodyStatus === 'promised-unpublished' ? 'The dossier describes assurance as promised but unpublished; do not present it as obtained proof.' : 'A reserve feed, attestation or custody description is not equivalent to legal title or an instrument-specific claim.',
                sourceIds: reserveSourceIds, sourcePeriod: null, checkedAt: issuer.evidence?.lastCheckedAt || null }
        ];
        const identity = array(merged.products).map((v) => clip(v, 260)).filter(Boolean).slice(0, 8).join(' | ');
        return { id: `stock:${programmeId}`, kind: 'programme', name: issuer.name, ticker: null, originalName: issuer.name, programmeId,
            exposure: { id: 'equities', label: 'Equity, ETF or private-company exposure; this programme record does not identify every token instrument.' },
            instrument: null,
            programme: { id: `programme:${programmeId}`, legalForm: merged.legalForm || 'Not established in the issuer dossier', issuer: merged.issuingEntity || issuer.issuerText || 'Not identified in the issuer dossier',
                identity: identity || issuer.name, scope: 'Programme-level issuer dossier. The existence of one product, disclosure or observed mint does not validate all products or confer a legal binding on indexed deployments.' },
            reviewedAt: null, evidenceCheckedAt: issuer.evidence?.lastCheckedAt || null, legacyReport: `issuers/${programmeId}.html`,
            sources, contexts: [{ id: contextId, termsId, label: `${issuer.name} programme-level dossier` }], claims, deployments, evidenceProfiles,
            exitDetails: { programme: { obligor: merged.issuingEntity || null, processor: null, onboarding: merged.redemption?.eligibility || null,
                entitlementOnTransfer: null, settlement: merged.redemption?.rails || null, minimumAndFees: [merged.redemption?.minimum, merged.redemption?.fees].filter(Boolean).join('; ') || null,
                independentRoute: null, availability: 'Legacy dossier description only; no route is promoted to currently operational by this adapter.' } } };
    });
}
export { stockResearch };
export default { stockResearch };
