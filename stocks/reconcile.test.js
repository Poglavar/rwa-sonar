// Enforces the attestation/finding reconciliation policy of stocks/MODEL.md §5: every slug an
// issuer dossier uses must exist in the right taxonomy, both taxonomies must have unique slugs,
// no proposed "NEW:" slug may survive anywhere, every dossier must carry status and
// keyGovernance, and every recipe must reference real attestation types.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ISSUER_DIR = path.join(__dirname, 'data', 'issuers');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const readText = (p) => fs.readFileSync(p, 'utf8');

const attestationTypes = readJson(path.join(ROOT, 'attestation-types.json'));
const findingTypes = readJson(path.join(ROOT, 'finding-types.json'));
const recipes = readJson(path.join(ROOT, 'recipes-db.json'));

const dossierFiles = fs.readdirSync(ISSUER_DIR).filter((f) => f.endsWith('.json')).sort();
const dossiers = dossierFiles.map((f) => ({
    file: f,
    raw: readText(path.join(ISSUER_DIR, f)),
    data: readJson(path.join(ISSUER_DIR, f))
}));

// A _comment-only section header still carries a real entry in attestation-types.json, so slugs
// are read off every element; finding-types.json has no comment entries at all.
const attestationSlugs = attestationTypes.map((t) => t.schema);
const findingSlugs = findingTypes.map((t) => t.schema);
const attestationSet = new Set(attestationSlugs);
const findingSet = new Set(findingSlugs);

const dupes = (list) => list.filter((v, i) => list.indexOf(v) !== i);

const STATUSES = ['live', 'defunct', 'not-launched'];
const GOVERNANCE = ['multisig', 'program', 'hot-key', 'unknown'];
const SEVERITIES = ['info', 'caution', 'warning', 'critical'];
const ATTESTATION_STATUSES = ['valid', 'expired', 'unknown'];
const CATEGORIES = [
    'governance', 'compliance', 'insolvency', 'record', 'custody', 'chain-risk', 'valuation',
    'settlement', 'credit', 'reserves', 'disclosure', 'rights', 'regulatory', 'legal',
    'market', 'lifecycle'
];

describe('taxonomies', () => {
    test('there are dossiers to check', () => {
        expect(dossiers.length).toBeGreaterThanOrEqual(11);
    });

    test('attestation slugs are unique', () => {
        expect(dupes(attestationSlugs)).toEqual([]);
        expect(attestationSlugs.every((s) => typeof s === 'string' && s.length > 0)).toBe(true);
    });

    test('finding slugs are unique', () => {
        expect(dupes(findingSlugs)).toEqual([]);
        expect(findingSlugs.length).toBeGreaterThan(0);
    });

    test('no slug is defined in both taxonomies', () => {
        expect(findingSlugs.filter((s) => attestationSet.has(s))).toEqual([]);
    });

    test('every finding type has the MODEL.md §2.5 shape', () => {
        for (const t of findingTypes) {
            expect(Object.keys(t).sort()).toEqual([
                'category', 'defaultSeverity', 'description', 'howToVerify', 'name', 'polarity',
                'schema'
            ]);
            expect(CATEGORIES).toContain(t.category);
            expect(['negative', 'neutral']).toContain(t.polarity);
            expect(SEVERITIES).toContain(t.defaultSeverity);
            expect(t.description.length).toBeGreaterThan(20);
            expect(t.howToVerify.length).toBeGreaterThan(20);
        }
    });

    test('no "NEW:" prefix survives in the taxonomies or the recipes', () => {
        for (const p of ['attestation-types.json', 'finding-types.json', 'recipes-db.json']) {
            expect(readText(path.join(ROOT, p))).not.toMatch(/NEW:/);
        }
    });
});

describe.each(dossiers)('$file', ({ raw, data }) => {
    test('no "NEW:" prefix survives', () => {
        expect(raw).not.toMatch(/NEW:/);
    });

    test('every attestation slug exists in attestation-types.json', () => {
        expect(Array.isArray(data.attestations)).toBe(true);
        const unknown = data.attestations
            .map((a) => a.schema)
            .filter((s) => !attestationSet.has(s));
        expect(unknown).toEqual([]);
    });

    test('attestations carry an attestor, a real link and a known status', () => {
        for (const a of data.attestations) {
            expect(ATTESTATION_STATUSES).toContain(a.status);
            expect(typeof a.attestor).toBe('string');
            expect(a.attestor.length).toBeGreaterThan(0);
            expect(a.link).toMatch(/^(https?:\/\/)/);
            expect(typeof a.statement).toBe('string');
            expect(a.statement.length).toBeGreaterThan(20);
        }
    });

    test('every finding slug exists in finding-types.json', () => {
        expect(Array.isArray(data.findings)).toBe(true);
        const unknown = data.findings.map((f) => f.schema).filter((s) => !findingSet.has(s));
        expect(unknown).toEqual([]);
    });

    test('findings have the MODEL.md §2.5 record shape', () => {
        for (const f of data.findings) {
            expect(Object.keys(f).sort()).toEqual([
                'evidence', 'observedAt', 'observer', 'schema', 'severity', 'statement'
            ]);
            expect(SEVERITIES).toContain(f.severity);
            expect(f.observer).toBe('rwa-sonar');
            expect(f.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(f.evidence).toMatch(/^(https?:\/\/|rpc:(getAccountInfo|getSignaturesForAddress|getProgramAccounts) \S+|stocks\/findings\.md$)/);
            expect(f.statement.length).toBeGreaterThan(20);
        }
    });

    test('has a lifecycle status', () => {
        expect(STATUSES).toContain(data.status);
    });

    test('has keyGovernance per MODEL.md §2.7', () => {
        expect(data.keyGovernance).toBeDefined();
        expect(Object.keys(data.keyGovernance).sort())
            .toEqual(['delegate', 'evidence', 'freeze', 'mint']);
        for (const k of ['mint', 'freeze', 'delegate']) {
            expect(GOVERNANCE).toContain(data.keyGovernance[k]);
        }
        expect(data.keyGovernance.evidence.length).toBeGreaterThan(20);
    });

    test('the non-schema apiFields key is gone', () => {
        expect(data.apiFields).toBeUndefined();
    });
});

describe('recipes-db.json', () => {
    test('every recipe references attestation types that exist', () => {
        const unknown = [];
        for (const r of recipes) {
            for (const a of r.attestationTypes) {
                if (!attestationSet.has(a.schema)) unknown.push(`${r.name}: ${a.schema}`);
            }
        }
        expect(unknown).toEqual([]);
    });

    test('the tokenized-equity recipe is present and well formed', () => {
        const recipe = recipes.find((r) => r.name === 'Tokenized Public Equity V1');
        expect(recipe).toBeDefined();
        expect(recipe.author).toBe('rwa-sonar');
        expect(recipe.version).toBe('1.0');
        expect(recipe.createdDate).toBe('2026-09-16');
        const slugs = recipe.attestationTypes.map((a) => a.schema);
        expect(dupes(slugs)).toEqual([]);
        for (const a of recipe.attestationTypes) {
            expect(Object.keys(a).sort()).toEqual(['note', 'required', 'schema']);
            expect(typeof a.required).toBe('boolean');
            expect(a.note.length).toBeGreaterThan(10);
        }
        // The claims a tokenized stock cannot be graded without.
        for (const required of [
            'issuer-terms-are-public',
            'product-registered-under-regulation',
            'underlying-custodied-at-named-custodian',
            'reserve-independently-verified',
            'reserve-value-gte-token-supply',
            'no-rehypothecation-of-customer-assets',
            'chain-state-reconciled-with-offchain-register',
            'zero-unresolved-reconciliation-breaks',
            'transfer-agent-is-sec-registered',
            'token-holder-can-redeem-for-underlying',
            'holder-claim-priority-defined',
            'assets-bankruptcy-remote-from-issuer',
            'admin-operations-require-multisig',
            'reversal-authority-is-named-role',
            'issuer-publishes-canonical-mint-address',
            'price-feed-provided-by-oracle',
            'independent-smart-contract-security-audit-completed',
            'corporate-actions-applied-via-onchain-multiplier',
            'token-represents-equity',
            'token-represents-tracker-certificate'
        ]) {
            expect(slugs).toContain(required);
        }
    });
});
