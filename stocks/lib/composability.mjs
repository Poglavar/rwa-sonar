// Pure helpers for matching a token to its reviewed issuer-plus-control template and turning that
// template into the DeFi-composability health rule. The legal conclusions remain data in
// data/composability-templates.json; this module only validates, indexes and exposes them.

export const COMPOSABILITY_SCENARIOS = [
    { id: 'escrow', label: 'Smart-contract escrow', question: 'Can a protocol account hold and release it?' },
    { id: 'borrowerDefault', label: 'Borrower default', question: 'Can the lender seize and realise value?' },
    { id: 'protocolHack', label: 'Protocol hacked', question: 'Can the transfer be stopped or reversed?' },
    { id: 'accessLoss', label: 'Access or key loss', question: 'Can a stranded balance be recovered?' }
];

export const COMPOSABILITY_STATUSES = ['good', 'caution', 'warning', 'unknown'];

export const EXIT_QUALITY_LABELS = {
    autonomous: 'Autonomous exit established',
    conditional: 'Conditional market exit',
    'issuer-dependent': 'Issuer-dependent exit',
    fragile: 'Fragile exit',
    unavailable: 'No confirmed collateral route',
    unknown: 'Exit quality unknown'
};

function finite(value) {
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(number) ? number : null;
}

function protocolNames(rows) {
    return [...new Set(rows.map((entry) => entry?.protocolName ?? entry?.protocolId).filter(Boolean))].sort();
}

/**
 * Separate technical possession from economic realisation. A protocol can hold a token while the
 * lender still lacks an autonomous buyer, redemption right, or final claim against the issuer.
 */
export function lenderExitQuality(template, integrations = [], redemption = null) {
    const rows = Array.isArray(integrations) ? integrations : [];
    const collateral = rows.filter((entry) => entry?.category === 'lending'
        && Array.isArray(entry.actions) && entry.actions.includes('collateral'));
    const dex = rows.filter((entry) => entry?.category === 'dex'
        && Array.isArray(entry.actions) && entry.actions.includes('swap'));
    const liquidityUsd = dex.map((entry) => finite(entry?.metrics?.liquidityUsd))
        .filter((value) => value !== null).reduce((total, value) => total + value, 0);
    const defaultOutcome = template?.scenarios?.borrowerDefault?.outcome ?? null;
    const escrowOutcome = template?.scenarios?.escrow?.outcome ?? null;
    const hackOutcome = template?.scenarios?.protocolHack?.outcome ?? null;
    const accessLossOutcome = template?.scenarios?.accessLoss?.outcome ?? null;
    const redemptionAvailable = redemption?.available === true;
    const redemptionKyc = redemption?.kyc === true;

    let rating = 'unknown';
    let reason = 'The legal/control template or an exit route has not been sufficiently established.';
    if (collateral.length === 0) {
        rating = 'unavailable';
        reason = 'No checked protocol currently accepts this exact token as programmatic collateral.';
    } else if (['issuer-mediated', 'weak-claim'].includes(defaultOutcome)) {
        rating = 'issuer-dependent';
        reason = 'Code can hold the balance, but seizure or realisation still depends on issuer recognition, allowlisting, or a claim weaker than possession suggests.';
    } else if (defaultOutcome === 'onchain-enforceable' && dex.length > 0 && !['issuer-can-freeze', 'issuer-may-recover'].includes(hackOutcome)) {
        rating = 'autonomous';
        reason = 'A checked lending market can seize the token and a checked pool offers a smart-contract sale route without a reviewed issuer override.';
    } else if (dex.length > 0) {
        rating = 'conditional';
        reason = 'The lender can use a checked on-chain sale route, but issuer controls, transfer conditions, or thin liquidity may prevent full realisation.';
    } else if (redemptionAvailable) {
        rating = 'issuer-dependent';
        reason = redemptionKyc
            ? 'The remaining cash route is issuer redemption, which requires an eligible KYC/AML-approved holder.'
            : 'The remaining cash route is contractual issuer redemption rather than an autonomous smart-contract sale.';
    } else {
        rating = 'fragile';
        reason = 'A checked protocol can take collateral, but no checked DEX sale route or holder redemption route is established.';
    }

    return {
        rating,
        label: EXIT_QUALITY_LABELS[rating],
        reason,
        custody: {
            outcome: escrowOutcome,
            meaning: template?.scenarios?.escrow?.headline ?? 'Technical custody not assessed'
        },
        economicControl: {
            outcome: defaultOutcome,
            meaning: template?.scenarios?.borrowerDefault?.headline ?? 'Default enforcement not assessed'
        },
        lossRecovery: {
            protocolHack: hackOutcome,
            accessLoss: accessLossOutcome,
            controller: ['issuer-can-freeze', 'issuer-may-recover'].includes(hackOutcome)
                || accessLossOutcome === 'discretionary-recovery' ? 'issuer-discretion' : 'protocol-or-market'
        },
        routes: {
            collateralProtocols: protocolNames(collateral),
            dexProtocols: protocolNames(dex),
            observedDexLiquidityUsd: liquidityUsd || null,
            issuerRedemption: redemptionAvailable,
            issuerRedemptionKyc: redemptionKyc
        }
    };
}

/** Stable identity of a legal programme plus the exact on-chain control recipe it currently uses. */
export function composabilityTemplateKey(issuer, recipe) {
    const issuerSlug = typeof issuer === 'string' ? issuer.trim() : '';
    const recipeLabel = typeof recipe === 'string' ? recipe.trim() : '';
    return issuerSlug && recipeLabel ? `${issuerSlug}\u0000${recipeLabel}` : null;
}
/** A duplicate means two reviewed conclusions claim to govern the same token, so fail loudly. */
export function indexComposabilityTemplates(templates) {
    const index = new Map();
    for (const template of Array.isArray(templates) ? templates : []) {
        const key = composabilityTemplateKey(template?.issuer, template?.recipe);
        if (key === null) continue;
        if (index.has(key)) throw new Error(`duplicate composability template for ${template.issuer} / ${template.recipe}`);
        index.set(key, template);
    }
    return index;
}

/** The reviewed template for one built token, or null so an unreviewed new recipe stays unknown. */
export function composabilityTemplateFor(token, index) {
    const key = composabilityTemplateKey(token?.issuer, token?.recipe?.label);
    return key === null || !(index instanceof Map) ? null : (index.get(key) ?? null);
}

/**
 * The one health check for this dimension. Its status measures permissionless protocol custody and
 * default enforcement; the hack and access-loss results are deliberately inputs, not separately
 * ranked checks, because admin reversibility is both a recovery feature and a finality cost.
 */
export function composabilityHealthRule(template) {
    const status = COMPOSABILITY_STATUSES.includes(template?.healthStatus)
        ? template.healthStatus
        : 'unknown';
    const inputs = {
        templateId: typeof template?.id === 'string' ? template.id : null,
        escrow: typeof template?.scenarios?.escrow?.outcome === 'string'
            ? template.scenarios.escrow.outcome : null,
        borrowerDefault: typeof template?.scenarios?.borrowerDefault?.outcome === 'string'
            ? template.scenarios.borrowerDefault.outcome : null,
        protocolHack: typeof template?.scenarios?.protocolHack?.outcome === 'string'
            ? template.scenarios.protocolHack.outcome : null,
        accessLoss: typeof template?.scenarios?.accessLoss?.outcome === 'string'
            ? template.scenarios.accessLoss.outcome : null
    };
    const note = status === 'unknown'
        ? 'this issuer and control-recipe combination has not had a DeFi composability review'
        : template.summary;
    return { status, value: null, inputs, note };
}
