// Pure legal-template shaping for the tokenized-stock product. It turns one issuer dossier plus
// one observed control recipe into a reusable analysis inherited by every matching mint.

export const EVIDENCE_LEVELS = [
    { id: 'binding-legal', label: 'Binding legal terms', rank: 1 },
    { id: 'regulatory-record', label: 'Regulatory or official register', rank: 2 },
    { id: 'onchain-observation', label: 'Observed on-chain configuration', rank: 3 },
    { id: 'official-operational', label: 'Official operational documentation', rank: 4 },
    { id: 'independent-attestation', label: 'Independent attestation', rank: 5 },
    { id: 'observed-transaction', label: 'Observed transaction', rank: 6 },
    { id: 'third-party-claim', label: 'Third-party claim', rank: 7 },
    { id: 'inference', label: 'Analytical inference', rank: 8 },
    { id: 'unknown', label: 'Not established', rank: 9 }
];

export const DOCUMENT_PRECEDENCE = [
    {
        rank: 1,
        label: 'Mandatory law, court orders and official registers',
        rule: 'These can override private terms and determine legal title, perfection, insolvency priority or eligibility.'
    },
    {
        rank: 2,
        label: 'Product-specific final terms and operative agreements',
        rule: 'The document governing this product or series controls over a general description, subject to mandatory law.'
    },
    {
        rank: 3,
        label: 'Base prospectus and binding programme terms',
        rule: 'These govern the programme except where valid product-specific terms supplement or disapply them.'
    },
    {
        rank: 4,
        label: 'On-chain state',
        rule: 'Authoritative for what the program and current keys can technically do, but not by itself for legal ownership or enforceability.'
    },
    {
        rank: 5,
        label: 'Official operating documentation and attestations',
        rule: 'Evidence of process or reserves; it cannot silently enlarge rights excluded by the controlling legal documents.'
    },
    {
        rank: 6,
        label: 'Marketing, press and third-party descriptions',
        rule: 'Useful context only. A conflict is resolved in favour of the higher-authority source and remains visibly recorded.'
    }
];

const FACETS = [
    { id: 'ownership', label: 'Ownership and claim', fields: ['legalForm', 'holderClaim', 'issuingEntity'] },
    { id: 'custody', label: 'Custody and insolvency', fields: ['underlyingCustodian', 'bankruptcyRemote', 'securityInterest.', 'collateral.'] },
    { id: 'eligibility', label: 'Jurisdiction and eligibility', fields: ['entityJurisdiction', 'governingLaw', 'transferRestrictions.'] },
    { id: 'redemption', label: 'Redemption', fields: ['redemption.'] },
    { id: 'corporateActions', label: 'Corporate actions', fields: ['dividends', 'voting', 'corporateActions'] },
    { id: 'technicalControl', label: 'Technical control', fields: ['knownExtensions', 'keyGovernance.'] }
];

const LEVELS = new Map(EVIDENCE_LEVELS.map((row) => [row.id, row]));

function text(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function bool(value) {
    return typeof value === 'boolean' ? value : null;
}

function list(value) {
    return Array.isArray(value) ? value.filter((row) => row !== null && row !== undefined) : [];
}

function fieldMatches(field, patterns) {
    return patterns.some((pattern) => pattern.endsWith('.') ? field.startsWith(pattern) : field === pattern);
}

/** Classify a source by what it can prove, not merely by who published it. */
export function documentAuthority(document) {
    const type = text(document?.type)?.toLowerCase() ?? '';
    const title = text(document?.title)?.toLowerCase() ?? '';
    if (/court|judg|decision|statute/.test(type + ' ' + title)) return 'regulatory-record';
    if (type === 'regulatory') return 'regulatory-record';
    if (/final terms|terms and conditions|sales terms|declaration of trust|account control|security agreement/.test(title)) {
        return 'binding-legal';
    }
    if (['terms', 'prospectus'].includes(type)) return 'binding-legal';
    if (type === 'verification-report') return 'independent-attestation';
    if (['docs', 'api', 'risk-disclosure'].includes(type)) return 'official-operational';
    if (type === 'press') return 'third-party-claim';
    return 'third-party-claim';
}

function evidenceLevel(claim, documentsByUrl) {
    const status = text(claim?.status)?.toLowerCase();
    if (status === 'inference') return 'inference';
    const method = text(claim?.method)?.toLowerCase() ?? '';
    if (method.includes('on-chain') || method.includes('onchain')) return 'onchain-observation';
    if (method.includes('transaction')) return 'observed-transaction';
    const document = documentsByUrl.get(text(claim?.url));
    return document ? documentAuthority(document) : (status ? 'third-party-claim' : 'unknown');
}

function strongestLevel(claims, documentsByUrl) {
    if (claims.length === 0) return LEVELS.get('unknown');
    return claims.map((claim) => LEVELS.get(evidenceLevel(claim, documentsByUrl)) ?? LEVELS.get('unknown'))
        .sort((a, b) => a.rank - b.rank)[0];
}

function evidenceFacets(issuer) {
    const documents = list(issuer?.documents);
    const documentsByUrl = new Map(documents.map((document) => [text(document?.url), document]).filter(([url]) => url));
    const claims = list(issuer?.claims);
    return FACETS.map((facet) => {
        const matching = claims.filter((claim) => fieldMatches(text(claim?.field) ?? '', facet.fields));
        let level = strongestLevel(matching, documentsByUrl);
        // The recipe is built from live mint accounts. This facet must not be demoted merely
        // because the issuer has no prose claim for a capability the chain itself exposes.
        if (facet.id === 'technicalControl') level = LEVELS.get('onchain-observation');
        return {
            id: facet.id,
            label: facet.label,
            level: level.id,
            levelLabel: level.label,
            claimCount: matching.length,
            correctedOrConflicting: matching.filter((claim) => /contradicted|changed/.test(text(claim?.status) ?? '')).length,
            latestCheckedAt: matching.map((claim) => text(claim?.accessedAt)).filter(Boolean).sort().at(-1) ?? null
        };
    });
}

function sourceRegister(issuer, archives) {
    const claims = list(issuer?.claims);
    const byUrl = new Map();
    for (const claim of claims) {
        const url = text(claim?.url);
        if (!url) continue;
        if (!byUrl.has(url)) byUrl.set(url, []);
        byUrl.get(url).push(claim);
    }
    return list(issuer?.documents).map((document) => {
        const url = text(document?.url);
        const sourceClaims = url ? byUrl.get(url) ?? [] : [];
        const authority = documentAuthority(document);
        return {
            title: text(document?.title) ?? url ?? 'Untitled source',
            url,
            type: text(document?.type),
            authority,
            authorityLabel: LEVELS.get(authority)?.label ?? authority,
            version: text(document?.version),
            effectiveDate: text(document?.effectiveDate),
            accessedAt: sourceClaims.map((claim) => text(claim?.accessedAt)).filter(Boolean).sort().at(-1) ?? null,
            archiveUrl: url && archives && typeof archives[url]?.archiveUrl === 'string' ? archives[url].archiveUrl : null,
            claimCount: sourceClaims.length
        };
    }).sort((a, b) => (LEVELS.get(a.authority)?.rank ?? 99) - (LEVELS.get(b.authority)?.rank ?? 99)
        || b.claimCount - a.claimCount || a.title.localeCompare(b.title));
}

function sourceConflicts(issuer) {
    return list(issuer?.claims).filter((claim) => /contradicted|changed|source-gone/.test(text(claim?.status) ?? ''))
        .map((claim) => ({
            field: text(claim?.field),
            status: text(claim?.status),
            note: text(claim?.note),
            url: text(claim?.url),
            accessedAt: text(claim?.accessedAt)
        }));
}

function insolvencyAnalysis(issuer) {
    const legalForm = text(issuer?.legalForm);
    const remote = bool(issuer?.bankruptcyRemote);
    const security = issuer?.securityInterest ?? {};
    let rating = 'unknown';
    let headline = 'Insolvency outcome is not established.';
    if (legalForm === 'registered-share') {
        rating = 'registered-title';
        headline = 'The holder claim is the registered share itself; transfer-agent and register continuity remain operational dependencies.';
    } else if (security.exists === true) {
        rating = 'secured-claim';
        headline = 'The holder relies on a security package and its perfection, priority, collateral scope and enforcement machinery—not direct ownership of the shares.';
    } else if (remote === true) {
        rating = 'structurally-separated';
        headline = 'The structure is described as bankruptcy-remote, but that is not the same as a perfected direct proprietary claim for every wallet holder.';
    } else if (remote === false) {
        rating = 'estate-exposed';
        headline = 'No bankruptcy-remoteness conclusion protects the holder from issuer-estate exposure.';
    }
    const corpus = [issuer?.holderClaim, issuer?.underlyingCustodian, issuer?.bankruptcyRemote,
        issuer?.securityInterest?.holder, issuer?.securityInterest?.priority,
        issuer?.collateral?.composition, issuer?.collateral?.rehypothecation]
        .filter((value) => typeof value === 'string').join(' ');
    const excerpt = (pattern) => {
        const sentences = corpus.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) ?? [];
        const match = sentences.find((sentence) => pattern.test(sentence));
        if (!match) return null;
        const clean = match.replace(/\s+/g, ' ').trim();
        return clean.length > 650 ? `${clean.slice(0, 647).replace(/\s+\S*$/, '')}…` : clean;
    };
    return {
        rating,
        headline,
        bankruptcyRemote: remote,
        securityInterest: {
            exists: bool(security.exists),
            holder: text(security.holder),
            priority: text(security.priority)
        },
        collateral: {
            ratio: text(issuer?.collateral?.ratio),
            composition: text(issuer?.collateral?.composition),
            rehypothecation: text(issuer?.collateral?.rehypothecation),
            onLoanDisclosed: bool(issuer?.collateral?.onLoanDisclosed)
        },
        holderStanding: text(issuer?.holderClaim),
        operationalDetails: {
            segregationOrTrust: excerpt(/segregat|bare trust|held on trust|beneficial/i),
            omnibusOrCommingling: excerpt(/omnibus|commingl/i),
            perfectionOrPriority: excerpt(/perfect|first.priority|control agreement|security interest/i),
            custodianLienOrSetoff: excerpt(/custodian lien|lien|set.?off|right of retention/i),
            enforcementStanding: security.exists === true && text(security.holder)
                ? `${text(security.holder)} is the recorded security holder or enforcement representative; the tokenholder depends on that agent and the operative security documents.`
                : legalForm === 'registered-share'
                    ? 'The person recognised on the official share register has shareholder standing; the token and transfer-agent process determine whether the wallet holder is that person.'
                    : 'No separate enforcement representative is structured here; standing depends on the holder claim and governing terms reproduced above.'
        },
        caveat: 'A contractual label such as “segregated”, “trust” or “first priority” is not treated as a court-tested insolvency result unless the dossier records that authority.'
    };
}

function redemptionAnalysis(issuer) {
    const redemption = issuer?.redemption ?? {};
    const claims = list(issuer?.claims).filter((claim) => fieldMatches(text(claim?.field) ?? '', ['redemption.']));
    const transactionEvidence = claims.some((claim) => {
        const method = text(claim?.method)?.toLowerCase() ?? '';
        const note = text(claim?.note)?.toLowerCase() ?? '';
        return method.includes('transaction') || /observed (redemption|redeem)|transaction hash/.test(note);
    });
    const documented = claims.length > 0;
    return {
        available: bool(redemption.available),
        eligibility: text(redemption.eligibility),
        rails: text(redemption.rails),
        fees: text(redemption.fees),
        kyc: bool(redemption.kyc),
        minimum: text(redemption.minimum),
        timing: text(redemption.timing) ?? text(redemption.sla),
        notes: text(redemption.notes),
        evidenceStatus: transactionEvidence ? 'observed-transaction' : documented ? 'documented-process' : 'not-established',
        evidenceLabel: transactionEvidence
            ? 'A completed redemption transaction is recorded.'
            : documented
                ? 'A redemption process is documented, but no independently observed completed redemption is recorded.'
                : 'No sufficiently evidenced redemption path is recorded.'
    };
}

function corporateActionAnalysis(issuer) {
    const legalForm = text(issuer?.legalForm);
    return {
        mode: legalForm === 'registered-share' ? 'registered-shareholder-process' : 'issuer-or-contract-mediated',
        dividends: text(issuer?.dividends),
        voting: text(issuer?.voting),
        actions: text(issuer?.corporateActions),
        caveat: legalForm === 'registered-share'
            ? 'Registration supports shareholder rights, but the operational channel for a token-held position must still be documented.'
            : 'Economic equivalence may be delivered by cash, balance adjustment or issuer calculation; it is not assumed to reproduce the underlying shareholder right.'
    };
}

function scopeAnalysis(issuer) {
    const restrictions = issuer?.transferRestrictions ?? {};
    const audience = list(issuer?.parties?.audience).map((party) => ({
        name: text(party?.name), jurisdiction: text(party?.jurisdiction), note: text(party?.note), source: text(party?.source)
    })).filter((party) => party.name);
    return {
        entityJurisdiction: text(issuer?.entityJurisdiction),
        governingLaw: text(issuer?.governingLaw),
        eligibleHolders: audience,
        transfer: {
            allowlist: bool(restrictions.allowlist),
            kycToHold: bool(restrictions.kycToHold),
            usPersonsExcluded: bool(restrictions.usPersonsExcluded),
            mechanism: text(restrictions.mechanism)
        },
        distinction: 'A wallet may be technically able to receive a token while its owner is contractually ineligible, unable to redeem, or excluded from rights under the governing documents.'
    };
}

function inheritedAssets(tokens) {
    const rows = list(tokens).map((token) => ({
        mint: text(token?.mint), symbol: text(token?.symbol), name: text(token?.name),
        underlyingTicker: text(token?.underlyingTicker), instrumentType: text(token?.instrumentType),
        recipe: text(token?.recipe?.label) ?? text(token?.recipe)
    })).filter((token) => token.mint).sort((a, b) => (a.symbol ?? a.mint).localeCompare(b.symbol ?? b.mint));
    return {
        count: rows.length,
        underlyingCount: new Set(rows.map((row) => row.underlyingTicker ?? row.name ?? row.symbol).filter(Boolean)).size,
        items: rows,
        exceptions: []
    };
}

function claimChainAnalysis(issuer) {
    const source = issuer?.chain ?? { nodes: [], links: [] };
    const chain = {
        nodes: list(source.nodes).map((node) => ({
            ...node,
            parties: list(node?.parties).map((party) => ({ ...party }))
        })),
        links: list(source.links).map((link) => ({ ...link }))
    };
    const securityNode = chain.nodes.find((node) => node.actor === 'security-agent');
    const securityHolder = text(issuer?.securityInterest?.holder);
    if (securityNode && securityNode.parties.length === 0 && securityHolder) {
        securityNode.parties.push({
            name: securityHolder,
            role: 'security-agent',
            jurisdiction: null,
            identifier: null
        });
    }
    return chain;
}

/** One reusable record inherited by all exact issuer + control-recipe matches. */
export function buildLegalTemplate({ template, issuer, tokens = [], archives = null }) {
    if (!template || !issuer) return null;
    const sources = sourceRegister(issuer, archives);
    return {
        id: text(template.id),
        issuer: { slug: text(issuer.slug), name: text(issuer.name), status: text(issuer.status) },
        reviewedAt: text(template.reviewedAt),
        legalTemplate: text(template.legalTemplate),
        technologyRecipe: text(template.recipe),
        summary: text(template.summary),
        composabilityStatus: text(template.healthStatus),
        inheritance: inheritedAssets(tokens),
        claimChain: claimChainAnalysis(issuer),
        sourceAuthority: {
            precedence: DOCUMENT_PRECEDENCE,
            sources,
            conflicts: sourceConflicts(issuer),
            rule: 'The conclusion follows the highest-authority source applicable to the specific product, holder and issue. A technical capability cannot create a legal right, and marketing cannot override operative terms.'
        },
        scope: scopeAnalysis(issuer),
        insolvency: insolvencyAnalysis(issuer),
        corporateActions: corporateActionAnalysis(issuer),
        redemption: redemptionAnalysis(issuer),
        evidenceConfidence: evidenceFacets(issuer),
        evidenceSummary: issuer.evidence ?? null,
        openQuestions: list(issuer.openQuestions).map(text).filter(Boolean)
    };
}

export function buildLegalTemplates({ templates = [], issuers = [], tokens = [], archives = null }) {
    const issuersBySlug = new Map(list(issuers).map((issuer) => [issuer.slug, issuer]));
    return list(templates).map((template) => {
        const issuer = issuersBySlug.get(template.issuer);
        const matching = list(tokens).filter((token) => token.issuer === template.issuer
            && (text(token?.recipe?.label) ?? text(token?.recipe)) === template.recipe);
        return buildLegalTemplate({ template, issuer, tokens: matching, archives });
    }).filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
}
