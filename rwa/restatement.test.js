// Tests the restatement of RWA Sonar's database in Tokenizario's attestation vocabulary: the schema map covers every
// attestation and finding schema, restatements validate, readiness and recipe checks count what parties say today,
// and the full build leaves no research product, dossier, catalogue entry or universe token unrestated.
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const R = require('./lib/restatement.js');

const ROOT = join(__dirname, '..');
const read = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const vocabulary = read('rwa/data/tokenizario-vocabulary.json');
const gaps = read('rwa/data/tokenizario-gaps.json');
const schemaMap = read('rwa/data/attestation-schema-map.json');
const exemplar = read('rwa/data/restatements/xstocks-backed.json');
const clone = (value) => JSON.parse(JSON.stringify(value));

describe('vocabulary snapshot', () => {
    it('lists the 32 v3 types once each, with the A/H/T claim kinds and units', () => {
        const ids = vocabulary.types.map((t) => t.id);
        expect(ids).toHaveLength(32);
        expect(new Set(ids).size).toBe(32);
        expect(vocabulary.fungibleDeclaration.claimKinds).toEqual(['issuer-obligation', 'ownership-interest']);
    });

    const repo = process.env.TOKENIZARIO_REPO;
    const source = repo && join(repo, 'frontend/src/lib/vocabulary.ts');
    (source && existsSync(source) ? it : it.skip)('matches the canonical catalogue in the Tokenizario checkout (TOKENIZARIO_REPO)', () => {
        const ts = readFileSync(source, 'utf8');
        const catalogue = ts.slice(ts.indexOf('export const CATALOGUE'), ts.indexOf('export type TypeId'));
        const canonical = [...catalogue.matchAll(/\bid: '([a-z-]+)', label:/g)].map((m) => m[1]);
        expect(vocabulary.types.map((t) => t.id).sort()).toEqual(canonical.sort());
        const list = (name) => JSON.parse(ts.match(new RegExp(`${name} = (\\[[^\\]]*\\])`))[1].replace(/'/g, '"'));
        expect(vocabulary.statusPredicates).toEqual(list('STATUS_PREDICATES'));
        expect(vocabulary.certificationEvents).toEqual(list('CERTIFICATION_EVENTS'));
        expect(vocabulary.credentialRoles).toEqual(list('CREDENTIAL_ROLES'));
    });
});

describe('attestation schema map', () => {
    const types = new Set(vocabulary.types.map((t) => t.id));
    const gapIds = new Set(gaps.gaps.map((g) => g.id));

    it('translates every attestation and finding schema exactly once', () => {
        const expected = [
            ...read('attestation-types.json').map((t) => `attestation:${t.schema}`),
            ...read('finding-types.json').map((t) => `finding:${t.schema}`)
        ].sort();
        expect(schemaMap.schemas.map((e) => `${e.catalogue}:${e.schema}`).sort()).toEqual(expected);
    });

    it('uses only v3 types, known fits, known signer roles and registered gaps', () => {
        for (const e of schemaMap.schemas) {
            expect(schemaMap.fits).toContain(e.fit);
            for (const a of e.as || []) {
                expect(types.has(a.type)).toBe(true);
                expect(schemaMap.signerRoles).toContain(a.signer);
            }
            for (const g of e.gaps || []) expect(gapIds.has(g)).toBe(true);
            if (e.fit === 'gap') expect((e.gaps || []).length).toBeGreaterThan(0);
            if (['exact', 'approximate'].includes(e.fit)) expect((e.as || []).length).toBeGreaterThan(0);
        }
    });
});

describe('validateRestatement', () => {
    const check = (r) => R.validateRestatement(r, { vocabulary, gaps });

    it('accepts the hand-written exemplar', () => {
        expect(check(exemplar)).toEqual([]);
    });

    it('rejects an unknown signer, gap, reference, type and an unflagged proposal', () => {
        const broken = clone(exemplar);
        broken.statements[0].signer = 'nobody';
        broken.statements[1].gaps = ['no-such-gap'];
        broken.statements[2].refs = ['Z'];
        broken.statements[3].type = 'attest';
        const lent = broken.statements.find((s) => s.predicate === 'lent');
        delete lent.proposed;
        const problems = check(broken).join('\n');
        expect(problems).toMatch(/unknown signer nobody/);
        expect(problems).toMatch(/unknown gap no-such-gap/);
        expect(problems).toMatch(/unknown reference Z/);
        expect(problems).toMatch(/attest is not a v3 type/);
        expect(problems).toMatch(/proposed predicate lent needs proposed: true and gap reserves-lent/);
    });

    it('rejects a predicate that is neither v3 nor an allowed proposal', () => {
        const broken = clone(exemplar);
        broken.statements.find((s) => s.type === 'status').predicate = 'solvent';
        expect(check(broken).join('\n')).toMatch(/solvent is neither a v3 predicate nor an allowed proposal/);
    });
});

describe('readiness and recipes', () => {
    const tiny = {
        statements: [
            { id: 'T', signer: 'issuer', type: 'declaration', today: { state: 'published' } },
            { id: 'H', signer: 'custodian', type: 'holds', today: { state: 'reported' } },
            { id: 'audit', signer: 'auditor', type: 'certification', event: 'audited', today: { state: 'unnamed' } },
            { id: 'feed', signer: 'issuer', type: 'status', predicate: 'backed', today: { state: 'onchain' } }
        ],
        recipe: { name: 'Hold it', ingredients: [
            { type: 'declaration', label: 'terms' }, { type: 'holds', label: 'custody' },
            { type: 'status', label: 'backed', params: { predicate: 'backed' } },
            { type: 'status', label: 'allocated', params: { predicate: 'allocated' } }
        ] }
    };

    it('counts what each signer already says itself', () => {
        const ready = R.readiness(tiny);
        expect(ready).toMatchObject({ total: 4, saidBySigner: 2, share: 0.5 });
        expect(ready.byState).toMatchObject({ onchain: 1, published: 1, reported: 1, unnamed: 1 });
        expect(ready.silentParties.sort()).toEqual(['auditor', 'custodian']);
    });

    it('meets a recipe only when every ingredient is said by its own signer', () => {
        const recipe = R.checkRecipe(tiny);
        expect(recipe.rows.map((row) => row.state)).toEqual(['said', 'silent', 'said', 'absent']);
        expect(recipe.metIfSigned).toBe(false);
        const met = R.checkRecipe({ ...tiny, recipe: { name: 'x', ingredients: tiny.recipe.ingredients.slice(0, 1) } });
        expect(met.metIfSigned).toBe(true);
    });

    it('keeps custody declarations and other statements of the same type out of a pinned ingredient', () => {
        const two = {
            statements: [
                { id: 'A', type: 'declaration', form: 'custody', today: { state: 'published' } },
                { id: 'T', type: 'declaration', form: 'token', today: { state: 'unnamed' } },
                { id: 'total', type: 'register-entry', today: { state: 'published' } }
            ],
            recipe: { name: 'x', ingredients: [
                { type: 'declaration', label: 'token terms', params: { form: 'token' } },
                { type: 'register-entry', label: 'entry for my wallet', matches: [] }
            ] }
        };
        const rows = R.checkRecipe(two).rows;
        expect(rows.map((row) => [row.statement, row.state])).toEqual([['T', 'silent'], [null, 'absent']]);
    });

    it('restates a database attestation through the map', () => {
        const map = new Map(schemaMap.schemas.map((e) => [e.schema, e]));
        const row = R.restateInstance({ schema: 'custodian-confirms-holding', attestor: 'Zodia', statement: 'Holds it', attestationDate: '2026-01-01', link: '#' }, map);
        expect(row).toMatchObject({ signer: 'Zodia', fit: 'exact', link: null, as: [{ type: 'holds', signer: 'custodian' }] });
        expect(R.restateInstance({ schema: 'made-up' }, map).fit).toBe('unmapped');
    });
});

describe('the whole database, restated', () => {
    let result, inputs;
    beforeAll(async () => {
        const builder = await import('./build-restatements.mjs');
        inputs = await builder.loadInputs();
        result = builder.build(inputs);
    });

    it('builds without a single problem', () => {
        expect(result.problems).toEqual([]);
    });

    it('covers every research product, dossier, catalogue entry and universe token', () => {
        const { summary, programmes } = result.output;
        expect(summary.tokens).toEqual({ total: inputs.universe.items.length, restated: inputs.universe.items.length });
        const subjects = (key) => programmes.flatMap((p) => p.subjects[key]);
        expect(subjects('researchProducts').sort()).toEqual(inputs.research.products.map((p) => p.id).sort());
        expect(subjects('issuerDossiers').sort()).toEqual(inputs.dossiers.map((d) => d.slug).sort());
        expect(subjects('catalogueNames').sort()).toEqual(inputs.catalogue.map((c) => c.name).sort());
    });

    it('restates every attestation and finding instance through the map', () => {
        const dossierInstances = inputs.dossiers.reduce((n, d) => n + (d.data.attestations || []).length + (d.data.findings || []).length, 0);
        expect(result.output.summary.instances.total).toBe(inputs.attestations.length + dossierInstances);
        expect(result.output.summary.instances.byFit.unmapped).toBeUndefined();
    });

    it('uses every registered gap somewhere, so the register cannot carry dead entries', () => {
        const unused = result.output.gaps.filter((g) => !g.programmes.length && !g.schemas.length).map((g) => g.id);
        expect(unused).toEqual([]);
    });

    it('fails the build when a programme loses its restatement', async () => {
        const builder = await import('./build-restatements.mjs');
        const without = { ...inputs, restatements: inputs.restatements.slice(1), restatementFiles: inputs.restatementFiles.slice(1) };
        expect(builder.build(without).problems.join('\n')).toMatch(/no restatement covers|have no programme/);
    });
});
