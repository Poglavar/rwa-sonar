// Provenance and shaping tests for the schematics (stocks/lib/schematics.js and the curated step
// lists in stocks/data/schematics.json). The rule under test is the owner's: never invent a step.
// Every curated step must point at a real field whose words it rests on, every URL it cites must be
// in that same file, and every what-if step must come from the catalogue or the answer — the
// outcome sentences re-join to exactly the answer's outcome.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import schematics from './lib/schematics.js';
import kit from './lib/flow-diagram.js';
import { dossierFileFor } from './lib/issuer-whatif.mjs';

const {
    KEY_MODES, resolvePath, splitRef, claimFor, publishedSource, curatedSpec, sentences,
    whatIfLanes, whatIfSpec, relationshipSpec, buildSchematics, indexSpecs, specsForToken
} = schematics;

const REPO = join(import.meta.dirname, '..');
const DATA = join(REPO, 'stocks', 'data');
const read = (path) => readFileSync(path, 'utf8');
const curated = JSON.parse(read(join(DATA, 'schematics.json')));
const catalogue = JSON.parse(read(join(DATA, 'trust-chain.json')));
const issuersDb = JSON.parse(read(join(REPO, 'stocks-issuers.json')));
const SLUGS = issuersDb.issuers.map((issuer) => issuer.slug);
const DOSSIER_FILES = readdirSync(join(DATA, 'issuers')).filter((name) => name.endsWith('.json'));

const norm = (text) => String(text).replace(/\s+/g, ' ').trim();
const fileCache = new Map();
function sourceFile(file) {
    if (!fileCache.has(file)) {
        const text = read(join(DATA, file));
        fileCache.set(file, { text, json: JSON.parse(text) });
    }
    return fileCache.get(file);
}

describe('curated schematics never invent a step', () => {
    const entries = curated.diagrams;
    const steps = entries.flatMap((entry) => entry.steps.map((step, index) => ({ entry, step, index })));

    it('has steps to check', () => {
        expect(steps.length).toBeGreaterThan(40);
    });

    it.each(steps.map(({ entry, step, index }) => [`${entry.id} step ${index + 1}`, step]))(
        '%s rests on the verbatim words of the field it names', (_, step) => {
            const ref = splitRef(step.source?.ref);
            expect(ref).not.toBeNull();
            const { text, json } = sourceFile(ref.file);
            const field = resolvePath(json, ref.path);
            expect(typeof field).toBe('string');
            expect(typeof step.source.basis).toBe('string');
            expect(step.source.basis.length).toBeGreaterThan(8);
            expect(norm(field)).toContain(norm(step.source.basis));
            if (step.source.url) expect(text).toContain(step.source.url);
        });

    it('uses only drawable statuses, real lanes and in-range groups', () => {
        for (const entry of entries) {
            const lanes = new Set((entry.lanes ?? []).map((lane) => lane.id));
            for (const step of entry.steps) {
                expect(['observed', 'documented', 'inferred', 'litigated', 'unknown']).toContain(step.status);
                expect(typeof step.label).toBe('string');
                if (entry.kind === 'sequence') {
                    expect(lanes.has(step.from)).toBe(true);
                    expect(lanes.has(step.to)).toBe(true);
                }
            }
            for (const group of entry.groups ?? []) {
                expect(group.from).toBeGreaterThanOrEqual(0);
                expect(group.to).toBeLessThan(entry.steps.length);
            }
        }
    });

    it('names only issuers that exist, and unique ids', () => {
        for (const entry of entries) expect(SLUGS).toContain(entry.issuer);
        const ids = entries.map((entry) => entry.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('marks an observed step only where the source is an on-chain observation', () => {
        for (const { step } of steps.filter(({ step }) => step.status === 'observed')) {
            const onChain = /solscan\.io|on-chain|onchain|Observed|scanner|read|re-check/i.test(`${step.source.label ?? ''} ${step.source.ref}`)
                || /redemption-observations|successfulRedemptionEvidence|lenderExitDependencies|legs\[[13]\]/.test(step.source.ref);
            expect(onChain).toBe(true);
        }
    });
});

describe('resolvePath and sources', () => {
    const doc = { a: { b: [{ id: 'x', v: 1 }, { id: 'y', v: 2 }] } };
    it('reads keys, indexes and [key=value] selectors', () => {
        expect(resolvePath(doc, 'a.b[1].v')).toBe(2);
        expect(resolvePath(doc, 'a.b[id=x].v')).toBe(1);
        expect(resolvePath(doc, 'a.c.d')).toBeUndefined();
    });

    it('attaches a dossier claim only when its quote carries the step’s words', () => {
        const dossier = { claims: [
            { field: 'redemption.rails', quote: 'Holders burn tokens to the contract for stablecoin', url: 'https://a.example/t', locator: 's. 1' },
            { field: 'redemption.rails', quote: 'Unrelated words about lending policy entirely', url: 'https://b.example/u', locator: 's. 9' }
        ] };
        expect(claimFor(dossier, 'redemption.rails', 'holders burn tokens to the contract')?.url).toBe('https://a.example/t');
        expect(claimFor(dossier, 'redemption.rails', 'a liquidity event must occur first')).toBeNull();
        const fallback = publishedSource({ ref: 'issuers/x.json#redemption.rails', basis: 'a liquidity event must occur first' },
            { dossier, issuerName: 'X' });
        expect(fallback).toEqual({ ref: 'issuers/x.json#redemption.rails', label: 'X dossier (redemption.rails)', url: null, locator: null });
    });

    it('keeps the basis out of the published spec', () => {
        const spec = curatedSpec(curated.diagrams[0], {});
        expect(JSON.stringify(spec)).not.toContain('"basis"');
        expect(spec.steps[0].source.url).toMatch(/^https:\/\/solscan\.io\/tx\//);
    });
});

describe('sentences', () => {
    it('splits on sentence ends and never inside U.S. or s. 2.4', () => {
        const text = 'Nothing comes back. The U.S. Custodian holds it under s. 2.4 of the terms. A court may help.';
        const parts = sentences(text);
        expect(parts).toEqual(['Nothing comes back.', 'The U.S. Custodian holds it under s. 2.4 of the terms.', 'A court may help.']);
        expect(parts.join(' ')).toBe(text);
    });
    it('folds anything past the maximum into the last step', () => {
        expect(sentences('A a. B b. C c. D d.', 3)).toEqual(['A a.', 'B b.', 'C c. D d.']);
    });
});

describe('what-if sequences', () => {
    const modes = new Map(catalogue.failureModes.map((mode) => [mode.id, mode]));
    const flows = new Map(catalogue.flows.map((flow) => [flow.id, flow]));

    it('walks the catalogue flow from the failing actor to the holder', () => {
        const custodian = modes.get('custodian-insolvency');
        expect(whatIfLanes(custodian, flows.get(custodian.flow))).toEqual(['custodian', 'token-issuer', 'token-program', 'holder']);
        const keys = modes.get('authority-key-compromised');
        expect(whatIfLanes(keys, flows.get(keys.flow))).toEqual(['token-program', 'holder']);
        const stolen = modes.get('keys-stolen');
        expect(whatIfLanes(stolen, flows.get(stolen.flow))[0]).toBe('holder');
    });

    it('draws the trigger and path as catalogue, the outcome in the answer’s status, and adds no words', () => {
        const answer = { mode: 'issuer-insolvency', status: 'inferred', outcome: 'You rank as an unsecured creditor. Recovery waits on the estate.', url: 'https://e.example/p', locator: 'p. 3' };
        const spec = whatIfSpec({ mode: 'issuer-insolvency', answer, catalogue, issuerName: 'X', issuerSlug: 'x' });
        expect(spec.steps.slice(0, 2).map((step) => step.status)).toEqual(['catalogue', 'catalogue']);
        const outcome = spec.steps.slice(2);
        expect(outcome.every((step) => step.status === 'inferred')).toBe(true);
        expect(outcome.map((step) => step.label).join(' ')).toBe(answer.outcome);
        expect(outcome[0].source).toEqual({ label: 'e.example', url: 'https://e.example/p', locator: 'p. 3' });
        expect(spec.steps[0].label).toBe(modes.get('issuer-insolvency').question.split(/(?<=[.?])\s+/)[0]);
    });

    it('draws an unknown answer as unknown steps', () => {
        const spec = whatIfSpec({ mode: 'custodian-insolvency', answer: { status: 'unknown', outcome: 'We could not establish who holds the shares.' }, catalogue });
        const last = spec.steps[spec.steps.length - 1];
        expect(last.status).toBe('unknown');
        expect(kit.sequenceSvg(spec)).toContain('fd-st-unknown');
    });

    it('draws nothing for not-applicable, missing or unknown modes', () => {
        expect(whatIfSpec({ mode: 'keys-stolen', answer: { status: 'not-applicable', outcome: 'x.' }, catalogue })).toBeNull();
        expect(whatIfSpec({ mode: 'keys-stolen', answer: null, catalogue })).toBeNull();
        expect(whatIfSpec({ mode: 'no-such-mode', answer: { status: 'documented', outcome: 'x.' }, catalogue })).toBeNull();
    });

    it('re-joins to the dossier outcome for every key mode of every real dossier', () => {
        let drawn = 0;
        for (const slug of SLUGS) {
            const file = dossierFileFor(slug, DOSSIER_FILES);
            if (!file) continue;
            const dossier = JSON.parse(read(join(DATA, 'issuers', file)));
            for (const mode of KEY_MODES) {
                const answer = (dossier.whatIf ?? []).find((row) => row.mode === mode);
                const spec = answer ? whatIfSpec({ mode, answer, catalogue, issuerSlug: slug }) : null;
                if (!spec) continue;
                drawn += 1;
                const said = spec.steps.filter((step) => step.status !== 'catalogue').map((step) => step.label).join(' ');
                expect(said).toBe(norm(answer.outcome));
            }
        }
        expect(drawn).toBeGreaterThan(50);
    });
});

describe('relationship maps', () => {
    it('draws empty required seats as unknown and only named optional roles', () => {
        const spec = relationshipSpec({ slug: 'x', name: 'X', legalForm: 'tracker-certificate', parties: {
            tokenIssuers: [{ name: 'X Ltd', jurisdiction: 'Jersey', source: 'https://x.example/p' }],
            custodians: [], transferAgents: [], distributors: []
        } });
        const roles = spec.spokes.map((spoke) => spoke.role);
        expect(roles).toEqual(['tokenIssuers', 'transferAgents', 'custodians']);
        expect(spec.spokes[1].status).toBe('unknown');
        expect(spec.spokes[0].source.url).toBe('https://x.example/p');
        expect(spec.centre.sub).toBe('X Ltd · Jersey');
    });

    it('says the company issues the share only for a registered-share programme', () => {
        const parties = { securitiesIssuers: [{ name: 'Co Inc' }] };
        const registered = relationshipSpec({ legalForm: 'registered-share', parties }).spokes.find((s) => s.role === 'securitiesIssuers');
        const wrapper = relationshipSpec({ legalForm: 'tracker-certificate', parties }).spokes.find((s) => s.role === 'securitiesIssuers');
        expect(registered.relation).toMatch(/issues the share/);
        expect(wrapper.relation).toMatch(/not a party/);
        expect(wrapper.direction).toBe('out');
    });
});

describe('buildSchematics', () => {
    const dossiers = new Map();
    for (const slug of SLUGS) {
        const file = dossierFileFor(slug, DOSSIER_FILES);
        if (file) dossiers.set(slug, JSON.parse(read(join(DATA, 'issuers', file))));
    }
    const names = Object.fromEntries(issuersDb.issuers.map((issuer) => [issuer.slug, issuer.name]));
    const built = buildSchematics({ curated, dossiers, catalogue, names });

    it('is deterministic', () => {
        expect(JSON.stringify(buildSchematics({ curated, dossiers, catalogue, names }))).toBe(JSON.stringify(built));
    });

    it('covers every issuer with a relationship map and indexes every spec by id', () => {
        expect(Object.keys(built.issuers).sort()).toEqual([...SLUGS].sort());
        const index = indexSpecs(built);
        for (const slug of SLUGS) expect(index.get(`${slug}:relationships`)).toBeDefined();
        expect(index.get('defi:xstocks-vaults-loop')).toBeDefined();
        expect(index.get('ondo-global-markets:redemption').steps).toHaveLength(6);
    });

    it('resolves page placeholder tokens, and says null for anything it does not hold', () => {
        expect(specsForToken(built, 'issuer:xstocks-backed').map((spec) => spec.id)).toEqual([
            'xstocks-backed:redemption-stablecoin', 'xstocks-backed:redemption-xport', 'xstocks-backed:creation', 'xstocks-backed:relationships'
        ]);
        expect(specsForToken(built, 'whatif:custodian-insolvency:xstocks-backed')[0].mode).toBe('custodian-insolvency');
        expect(specsForToken(built, 'defi:secz-loopscale-liquidation')).toHaveLength(1);
        expect(specsForToken(built, 'issuer:nobody')).toBeNull();
        expect(specsForToken(built, 'no-such-id')).toBeNull();
    });
});
