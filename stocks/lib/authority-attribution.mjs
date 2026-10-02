// Pure authority-attribution model.  It records what a mint can do separately from how the key is
// governed and from any contractual limit.  No signer threshold, operator identity, rotation, or
// legal permission is inferred from an address, a key type, or descriptive prose.

export const AUTHORITY_CAPABILITIES = [
    ['mint', 'Mint'],
    ['freeze', 'Freeze accounts'],
    ['pause', 'Pause transfers'],
    ['permanentDelegate', 'Permanent delegate'],
    ['clawback', 'Claw back / burn'],
    ['allowlist', 'Allowlist / transfer restriction'],
    ['transferHook', 'Transfer hook'],
    ['transferFee', 'Transfer-fee configuration'],
    ['rebase', 'Rebase / balance multiplier'],
    ['upgrade', 'Programme upgrade']
];

function boolOrNull(value) {
    return typeof value === 'boolean' ? value : null;
}

function capability(value) {
    if (value === true || (typeof value === 'string' && value.trim() !== '')) return 'present';
    if (value === false) return 'absent';
    return 'unknown';
}

function transferFeeCapability(control) {
    // A zero configured fee is still a mutable fee extension.  Conversely, an authority can be
    // retained even where a collector has not decoded the current bps field.
    if (control?.transferFee === true) return 'present';
    if (control?.transferFee === false) return 'absent';
    if (typeof control?.transferFeeConfigAuthority === 'string' && control.transferFeeConfigAuthority.trim() !== '') return 'present';
    if (typeof control?.transferFeeWithdrawAuthority === 'string' && control.transferFeeWithdrawAuthority.trim() !== '') return 'present';
    if (Number.isFinite(control?.transferFeeBps)) return 'present';
    return 'unknown';
}

function sourceControl(control, id) {
    if (id === 'mint') return control.mintAuthority;
    if (id === 'freeze') return control.freezeAuthority;
    if (id === 'pause') return control.pausable;
    if (id === 'permanentDelegate') return control.permanentDelegate;
    if (id === 'transferHook') return control.hookActive;
    if (id === 'transferFee') return control.transferFee;
    return control[id];
}

/** Governance types where one private key alone can act (a plain key, or a 1-of-n multisig). */
export const SINGLE_SIGNER_GOVERNANCE = ['hot-key', 'single-signer-multisig'];

/**
 * A program (or its PDA) holding an authority is only as strong as whoever can replace the
 * program's code: an upgrade can make the program sign anything. So a `program` path whose
 * reviewed `upgradeGovernance` is a single signer resolves to that single signer. Any other
 * value, and any program without reviewed upgrade evidence, is returned unchanged.
 */
export function resolveProgramGovernance(type, fact) {
    if (type === 'program' && SINGLE_SIGNER_GOVERNANCE.includes(fact?.upgradeGovernance)) return fact.upgradeGovernance;
    return type;
}

function governanceFor(id, keyGovernance, facts, factsSource = null) {
    const governanceKey = id === 'permanentDelegate' ? 'delegate' : id;
    const fact = facts?.[id] && typeof facts[id] === 'object' ? facts[id] : {};
    // `effectiveGovernance` records the actor that can actually exercise this capability. It
    // deliberately overrides a technical PDA/program label only when reviewed evidence traces a
    // direct signer or the governing multisig beyond that program.
    const governance = typeof fact.effectiveGovernance === 'string'
        ? fact.effectiveGovernance
        : (typeof keyGovernance?.[governanceKey] === 'string' ? keyGovernance[governanceKey] : 'unknown');
    const resolved = resolveProgramGovernance(governance, fact);
    return {
        type: resolved,
        // True when the path is technically a program/PDA but its upgrade key is a single signer.
        viaProgramUpgrade: resolved !== governance,
        controller: typeof fact.controller === 'string' ? fact.controller : null,
        signerThreshold: typeof fact.signerThreshold === 'string' ? fact.signerThreshold : null,
        upgradeAuthority: typeof fact.upgradeAuthority === 'string' ? fact.upgradeAuthority : null,
        upgradeGovernance: typeof fact.upgradeGovernance === 'string' ? fact.upgradeGovernance : null,
        observedAt: /^\d{4}-\d{2}-\d{2}$/.test(fact.observedAt ?? '') ? fact.observedAt : null,
        source: typeof fact.source === 'string' ? fact.source : (typeof factsSource === 'string' ? factsSource : null),
        lastRotatedAt: typeof fact.lastRotatedAt === 'string' ? fact.lastRotatedAt : null,
        technicalNotes: typeof fact.technicalNotes === 'string' ? fact.technicalNotes : null,
        contractualCircumstances: typeof fact.contractualCircumstances === 'string' ? fact.contractualCircumstances : null
    };
}

/**
 * `authorityFacts` is a reviewed structured supplement, keyed by capability.  It is optional so
 * current issuer/token data can render honestly: all unstructured attribution facts remain null.
 */
export function shapeAuthorityAttribution({ token = null, issuer = null, authorityFacts = null } = {}) {
    const control = token?.control && typeof token.control === 'object' ? token.control : {};
    const keyGovernance = issuer?.keyGovernance ?? issuer?.control?.keyGovernance ?? {};
    // Facts are issuer research, not a UI-only caller option.  A caller may add a narrow override
    // for a reviewed token, but omitting it must still render the issuer's published attribution.
    const issuerFacts = issuer?.authorityFacts && typeof issuer.authorityFacts === 'object' ? issuer.authorityFacts : {};
    const facts = authorityFacts && typeof authorityFacts === 'object'
        ? { ...issuerFacts, ...authorityFacts }
        : issuerFacts;
    const authorities = AUTHORITY_CAPABILITIES.map(([id, label]) => {
        const fact = facts[id] && typeof facts[id] === 'object' ? facts[id] : null;
        const raw = fact && Object.hasOwn(fact, 'capability')
            ? boolOrNull(fact.capability)
            : sourceControl(control, id);
        const technicalCapability = id === 'transferFee' && !(fact && Object.hasOwn(fact, 'capability'))
            ? transferFeeCapability(control)
            : capability(raw);
        return { id, label, technicalCapability, governance: governanceFor(id, keyGovernance, facts, issuer?.authorityFactsSource) };
    });
    return { authorities };
}

function governanceStrength(row) {
    if (row.governance.type === 'hot-key' || row.governance.type === 'single-signer-multisig') return 'direct';
    if (row.governance.type === 'multisig'
        || (row.governance.type === 'program' && row.governance.upgradeGovernance === 'multisig')) return 'constrained';
    return 'unknown';
}

function groupedRolePhrases(rows) {
    const groups = new Map();
    for (const row of rows) {
        const detail = [row.governance.controller, row.governance.signerThreshold].filter(Boolean).join(' · ');
        // With no attribution, two roles may still be controlled by different unknown keys. Keep
        // them separate instead of implying shared control merely because both detail fields are null.
        const key = detail ? JSON.stringify([row.governance.type, detail]) : `role:${row.id}`;
        if (!groups.has(key)) groups.set(key, { labels: [], detail });
        groups.get(key).labels.push(row.label);
    }
    return [...groups.values()].map((group) => `${group.labels.join(', ')}${group.detail ? ` (${group.detail})` : ''}`);
}

/**
 * One plain-language conclusion over an already-shaped exact-token authority model. It leads with
 * the least constrained known path while keeping incomplete attribution visible. `constrained`
 * describes key governance only; it is never a claim that exercising the power is legally proper.
 */
export function summarizeAuthorityAttribution(model) {
    const installed = Array.isArray(model?.authorities)
        ? model.authorities.filter((row) => row.technicalCapability === 'present') : [];
    const direct = installed.filter((row) => governanceStrength(row) === 'direct');
    const constrained = installed.filter((row) => governanceStrength(row) === 'constrained');
    const unknown = installed.filter((row) => governanceStrength(row) === 'unknown');
    const parts = [];
    if (direct.length) parts.push(`Direct or one-signer control: ${groupedRolePhrases(direct).join('; ')}.`);
    if (unknown.length) parts.push(`Ultimate controller not established: ${unknown.map((row) => row.label).join(', ')}.`);
    if (constrained.length) parts.push(`Threshold-governed paths: ${groupedRolePhrases(constrained).join('; ')}.`);
    if (!installed.length) parts.push('No installed authority path was established from the supplied token observation.');
    return {
        status: direct.length ? 'caution' : unknown.length || !installed.length ? 'unknown' : 'constrained',
        headline: parts.join(' '),
        coverageComplete: installed.length > 0 && unknown.length === 0,
        installedCount: installed.length,
        direct: direct.map((row) => row.id),
        unknown: unknown.map((row) => row.id),
        constrained: constrained.map((row) => row.id),
        authorities: installed
    };
}
