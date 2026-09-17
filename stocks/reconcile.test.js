// Enforces the attestation/finding reconciliation policy of stocks/MODEL.md §5: every slug an
// issuer dossier uses must exist in the right taxonomy, both taxonomies must have unique slugs,
// no proposed "NEW:" slug may survive anywhere, every dossier must carry status and
// keyGovernance (all four authorities of §2.7, the rebase key included), and every recipe must
// reference real attestation types.
//
// It also enforces the parties policy of stocks/MODEL.md §10.2, so the graph of §10.4 can be built
// from the dossiers without inference: every dossier carries the ten party arrays, every party name
// resolves to one entry in stocks/data/canonical-parties.json (that is what makes nodes merge
// across dossiers), every role is the singular form of the array it sits in, and every party's
// source is a URL the dossier already cites — a party may not introduce new, unreviewed evidence.

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
// `rebase` is the only authority that can be genuinely ABSENT rather than uncharacterised: a mint
// with no scaledUiAmountConfig extension has no such key to hold (MODEL.md §2.7). The other three
// keep the narrower set, so 'none' cannot quietly spread to them.
const REBASE_GOVERNANCE = [...GOVERNANCE, 'none'];
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
            // The six §2.5 keys are required. `quote`, `accessedAt` and `quoteNote` are the three
            // the evidence pass adds (stocks/EVIDENCE.md §1: a quoted finding IS a claim, and
            // stocks/lib/evidence.js reads exactly these), so they are allowed and nothing else is
            // — an invented seventh key would still fail here rather than being silently dropped
            // by every consumer.
            const keys = Object.keys(f).sort();
            expect(keys.filter((k) => !['quote', 'accessedAt', 'quoteNote'].includes(k))).toEqual([
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

    test('has keyGovernance per MODEL.md §2.7, all FOUR authorities', () => {
        expect(data.keyGovernance).toBeDefined();
        expect(Object.keys(data.keyGovernance).sort())
            .toEqual(['delegate', 'evidence', 'freeze', 'mint', 'rebase']);
        for (const k of ['mint', 'freeze', 'delegate']) {
            expect(GOVERNANCE).toContain(data.keyGovernance[k]);
        }
        expect(REBASE_GOVERNANCE).toContain(data.keyGovernance.rebase);
        expect(data.keyGovernance.evidence.length).toBeGreaterThan(20);
    });

    test('the rebase authority is evidenced, not just asserted', () => {
        // Every other keyGovernance value is on stocks/data/claim-fields.json, so the fourth one is
        // too: a governance value nobody has to source is a governance value nobody has checked.
        const claims = (data.claims ?? []).filter((c) => c.field === 'keyGovernance.rebase');
        expect(claims.length).toBeGreaterThanOrEqual(1);
        for (const claim of claims) {
            expect(typeof claim.note).toBe('string');
            expect(claim.note.length).toBeGreaterThan(20);
            // A dossier with a mint to read must have READ it; only the two issuers with no Solana
            // mint at all (Republic Mirror, Ventuals) may rest on an inference.
            if (data.keyGovernance.rebase === 'unknown') {
                expect(['inference', 'unverified']).toContain(claim.status);
            } else {
                expect(claim.status).toBe('confirmed');
                expect(claim.locator).toMatch(/^rpc:/);
                expect(claim.quote.length).toBeGreaterThan(10);
            }
        }
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

// --- MODEL.md §10.2 parties ------------------------------------------------------------------

const canonicalParties = readJson(path.join(__dirname, 'data', 'canonical-parties.json'));

// Array key -> the `role` string a record sitting in it must carry (the array key, singular).
const PARTY_ARRAYS = {
    securitiesIssuers: 'security-issuer',
    tokenIssuers: 'token-issuer',
    tokenizationProviders: 'tokenization-provider',
    transferAgents: 'transfer-agent',
    custodians: 'custodian',
    verificationAgents: 'verification-agent',
    distributors: 'distributor',
    regulators: 'regulator',
    parents: 'parent',
    audience: 'audience'
};
const PARTY_KEYS = Object.keys(PARTY_ARRAYS);

// The MODEL.md §10.4 node types, minus "programme" (which is the issuer record itself, not a party).
const PARTY_TYPES = [
    'security-issuer', 'token-issuer', 'tokenization-provider', 'transfer-agent', 'custodian',
    'verification-agent', 'distributor', 'dex', 'lending', 'regulator', 'parent', 'audience'
];

const canonicalNames = canonicalParties.map((p) => p.name);
const canonicalNameSet = new Set(canonicalNames);

// Every non-empty URL a dossier already cites. A party's `source` must appear inside one of these,
// so the parties layer can only point at evidence that was already reviewed for that dossier.
const citedEvidence = (data) =>
    [...data.documents.map((d) => d.url), ...data.sources]
        .filter((s) => typeof s === 'string' && s.length > 0);

describe('canonical-parties.json', () => {
    test('is a non-empty array of registry entries', () => {
        expect(Array.isArray(canonicalParties)).toBe(true);
        expect(canonicalParties.length).toBeGreaterThan(40);
    });

    test('canonical names are unique and non-empty', () => {
        expect(dupes(canonicalNames)).toEqual([]);
        expect(canonicalNames.every((n) => typeof n === 'string' && n.trim().length > 0)).toBe(true);
    });

    test('every entry has the MODEL.md §10.2 registry shape', () => {
        for (const p of canonicalParties) {
            expect(Object.keys(p).filter((k) => k !== 'alsoRoles').sort())
                .toEqual(['identifier', 'jurisdiction', 'name', 'note', 'type', 'website']);
            expect(PARTY_TYPES).toContain(p.type);
            for (const k of ['jurisdiction', 'identifier', 'website', 'note']) {
                expect(typeof p[k]).toBe('string');
            }
            if (p.website) expect(p.website).toMatch(/^https?:\/\//);
        }
    });

    test('alsoRoles are real types and never repeat the primary type', () => {
        for (const p of canonicalParties.filter((x) => x.alsoRoles !== undefined)) {
            expect(Array.isArray(p.alsoRoles)).toBe(true);
            expect(p.alsoRoles.length).toBeGreaterThan(0);
            expect(dupes(p.alsoRoles)).toEqual([]);
            for (const r of p.alsoRoles) expect(PARTY_TYPES).toContain(r);
            expect(p.alsoRoles).not.toContain(p.type);
        }
    });

    test('the canonical audience names exist, so audiences merge across dossiers', () => {
        for (const name of ['non-US persons', 'KYC-verified platform users', 'allowlisted wallets',
            'everyone (no KYC)', 'accredited investors']) {
            const entry = canonicalParties.find((p) => p.name === name);
            expect(entry).toBeDefined();
            expect(entry.type).toBe('audience');
        }
    });

    test('no registry entry is a dead graph node — every canonical party is used by a dossier or is a trading venue', () => {
        const used = new Set();
        for (const { data } of dossiers) {
            for (const key of PARTY_KEYS) for (const p of data.parties[key]) used.add(p.name);
        }
        // Venue rows (DEXes and exchanges) are referenced by stocks/data/venues.json, not by
        // dossiers: a canonical row counts as used when its name is a market label or a dexId there.
        const venuesPath = path.join(__dirname, 'data', 'venues.json');
        if (fs.existsSync(venuesPath)) {
            const venues = readJson(venuesPath);
            for (const item of venues.items ?? []) {
                for (const d of item.dex ?? []) if (d.dexId) used.add(String(d.dexId).toLowerCase());
                for (const c of item.cex ?? []) if (c.market) used.add(String(c.market));
            }
        }
        const isUsed = (n) => used.has(n) || used.has(n.toLowerCase());
        expect(canonicalNames.filter((n) => !isUsed(n))).toEqual([]);
    });
});

describe.each(dossiers)('$file parties', ({ data }) => {
    test('has a parties object with exactly the ten MODEL.md §10.2 keys', () => {
        expect(data.parties).toBeDefined();
        expect(Object.keys(data.parties).sort()).toEqual([...PARTY_KEYS].sort());
        for (const key of PARTY_KEYS) expect(Array.isArray(data.parties[key])).toBe(true);
    });

    test('every party record has the six MODEL.md §10.2 fields', () => {
        for (const key of PARTY_KEYS) {
            for (const p of data.parties[key]) {
                expect(Object.keys(p).sort())
                    .toEqual(['identifier', 'jurisdiction', 'name', 'note', 'role', 'source']);
                for (const k of ['jurisdiction', 'identifier', 'note']) {
                    expect(typeof p[k]).toBe('string');
                }
                expect(p.note.length).toBeGreaterThan(10);
            }
        }
    });

    test('every party name exists in canonical-parties.json', () => {
        const unknown = [];
        for (const key of PARTY_KEYS) {
            for (const p of data.parties[key]) {
                if (!canonicalNameSet.has(p.name)) unknown.push(`${key}: ${p.name}`);
            }
        }
        expect(unknown).toEqual([]);
    });

    test('every role is the singular form of the array it sits in', () => {
        const wrong = [];
        for (const [key, role] of Object.entries(PARTY_ARRAYS)) {
            for (const p of data.parties[key]) {
                if (p.role !== role) wrong.push(`${key}: ${p.name} has role "${p.role}"`);
            }
        }
        expect(wrong).toEqual([]);
    });

    test('every party source is a URL this dossier already cites, or stocks/findings.md', () => {
        const cited = citedEvidence(data);
        const unsourced = [];
        for (const key of PARTY_KEYS) {
            for (const p of data.parties[key]) {
                if (p.source === 'stocks/findings.md') continue;
                if (!p.source || !/^https?:\/\//.test(p.source)) {
                    unsourced.push(`${key}: ${p.name} -> "${p.source}" is not a URL`);
                } else if (!cited.some((c) => c.includes(p.source))) {
                    unsourced.push(`${key}: ${p.name} -> ${p.source}`);
                }
            }
        }
        expect(unsourced).toEqual([]);
    });

    test('no party is listed twice in the same array', () => {
        for (const key of PARTY_KEYS) {
            expect(dupes(data.parties[key].map((p) => p.name))).toEqual([]);
        }
    });
});
