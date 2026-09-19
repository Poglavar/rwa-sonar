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
