#!/usr/bin/env node
// Restates every RWA Sonar record in Tokenizario's attestation vocabulary and writes rwa-restatements.json:
// per programme what its parties already say, recipe checks and gaps; every attestation and finding instance
// mapped through rwa/data/attestation-schema-map.json; and every universe token resolved to its programme.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const R = require('./lib/restatement.js');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);
const readJson = async (path) => JSON.parse(await readFile(join(ROOT, path), 'utf8'));

const USAGE = `Usage: node rwa/build-restatements.mjs --run [--out=rwa-restatements.json]

Reads rwa/data/restatements/*.json with the vocabulary snapshot, gap register and schema map, validates them,
restates every attestation and finding instance and every universe token, and writes the summary file.
Fails on any invalid restatement, unmapped schema or record of the database that no restatement covers.`;

export async function loadInputs() {
    const [vocabulary, gaps, schemaMapDoc, research, catalogue, attestations, universe] = await Promise.all([
        readJson('rwa/data/tokenizario-vocabulary.json'), readJson('rwa/data/tokenizario-gaps.json'),
        readJson('rwa/data/attestation-schema-map.json'), readJson('rwa/data/research.json'), readJson('rwa-assets-db.json'),
        readJson('attestations-db.json'), readJson('stocks/data/universe.json')
    ]);
    const restatementFiles = (await readdir(join(ROOT, 'rwa/data/restatements'))).filter((f) => f.endsWith('.json')).sort();
    const restatements = await Promise.all(restatementFiles.map((f) => readJson(`rwa/data/restatements/${f}`)));
    const dossierFiles = (await readdir(join(ROOT, 'stocks/data/issuers'))).filter((f) => f.endsWith('.json')).sort();
    const dossiers = await Promise.all(dossierFiles.map(async (f) => ({ slug: f.replace(/\.json$/, ''), data: await readJson(`stocks/data/issuers/${f}`) })));
    return { vocabulary, gaps, schemaMapDoc, research, catalogue, attestations, universe, restatements, restatementFiles, dossiers };
}

export function build(inputs) {
    const { vocabulary, gaps, schemaMapDoc, research, catalogue, attestations, universe, restatements, restatementFiles, dossiers } = inputs;
    const problems = [];
    restatements.forEach((r, i) => {
        if (`${r.id}.json` !== restatementFiles[i]) problems.push(`${restatementFiles[i]}: id ${r.id} does not match the file name`);
        problems.push(...R.validateRestatement(r, { vocabulary, gaps }));
    });
    const schemaMap = new Map(schemaMapDoc.schemas.map((e) => [e.schema, e]));
    const { index, problems: duplicateSubjects } = R.subjectIndex(restatements);
    problems.push(...duplicateSubjects);
    const cover = R.coverage(index, {
        researchIds: research.products.map((p) => p.id), dossierSlugs: dossiers.map((d) => d.slug),
        catalogueNames: catalogue.map((c) => c.name), universe: universe.items
    });
    for (const [key, list] of Object.entries(cover.missing)) for (const id of list) problems.push(`no restatement covers ${key} ${id}`);
    if (cover.tokens.unrestated.length) problems.push(`${cover.tokens.unrestated.length} universe tokens have no programme restatement`);

    // Every attestation and finding instance in the database, restated and attached to its programme.
    const observed = new Map(restatements.map((r) => [r.id, []]));
    const unmapped = new Set();
    const attach = (programme, instance, options) => {
        const restated = R.restateInstance(instance, schemaMap, options);
        if (restated.fit === 'unmapped') unmapped.add(instance.schema);
        if (programme && observed.has(programme)) observed.get(programme).push(restated);
        else problems.push(`instance ${instance.schema} (${instance.assetName || options.source}) has no programme`);
    };
    for (const a of attestations) attach(index.catalogueNames.get(a.assetName), a, { catalogue: 'attestation', source: 'attestations-db.json' });
    for (const { slug, data } of dossiers) {
        const programme = index.issuerDossiers.get(slug);
        for (const a of data.attestations || []) attach(programme, a, { catalogue: 'attestation', source: slug });
        for (const f of data.findings || []) attach(programme, f, { catalogue: 'finding', signer: f.observer === 'rwa-sonar' ? 'RWA Sonar' : f.observer, source: slug });
    }
    for (const schema of unmapped) problems.push(`schema ${schema} is not in the schema map`);
    if (problems.length) return { problems };

    const tally = (rows, key) => rows.reduce((acc, row) => ({ ...acc, [row[key]]: (acc[row[key]] || 0) + 1 }), {});
    const programmes = restatements.map((r) => {
        const ready = R.readiness(r);
        const recipe = R.checkRecipe(r);
        const instances = observed.get(r.id);
        return {
            id: r.id, name: r.name, path: r.path, fit: r.verdict.fit, summary: r.verdict.summary,
            readable: r.tokens.some((t) => t.readable), subjects: r.subjects, holderPosition: r.holderPosition,
            readiness: ready, recipe, tokens: cover.tokens.byProgramme[r.id] || 0,
            observed: { total: instances.length, byFit: tally(instances, 'fit'), instances }
        };
    });
    const allStatements = restatements.flatMap((r) => r.statements);
    const allInstances = programmes.flatMap((p) => p.observed.instances);
    const byState = tally(allStatements.map((s) => ({ state: s.today.state })), 'state');
    return {
        problems: [],
        output: {
            _comment: 'Generated by rwa/build-restatements.mjs from rwa/data/restatements/ and the database; do not edit.',
            generatedAt: new Date().toISOString(),
            vocabulary: { version: vocabulary.version, catalogueDated: vocabulary.catalogueDated },
            summary: {
                programmes: programmes.length, statements: allStatements.length, byState,
                saidBySignerShare: (byState.onchain || 0) + (byState.published || 0) ? ((byState.onchain || 0) + (byState.published || 0)) / allStatements.length : 0,
                fits: tally(programmes, 'fit'), readableProgrammes: programmes.filter((p) => p.readable).length,
                recipes: { checked: programmes.filter((p) => p.recipe).length, metIfSigned: programmes.filter((p) => p.recipe && p.recipe.metIfSigned).length },
                instances: { total: allInstances.length, byFit: tally(allInstances, 'fit') },
                schemaMap: tally(schemaMapDoc.schemas.map((e) => ({ k: `${e.catalogue}:${e.fit}` })), 'k'),
                tokens: { total: cover.tokens.total, restated: cover.tokens.restated }
            },
            gaps: R.gapUse(gaps, restatements, schemaMapDoc.schemas).sort((a, b) => a.priority - b.priority || b.programmes.length - a.programmes.length),
            programmes,
            tokenIndex: Object.fromEntries(universe.items.map((item) => [item.mint, index.universeIssuers.get(item.issuer)]))
        }
    };
}

async function main() {
    const args = process.argv.slice(2);
    if (!args.includes('--run') || args.includes('--help')) { console.log(USAGE); return; }
    const out = (args.find((a) => a.startsWith('--out=')) || '--out=rwa-restatements.json').slice(6);
    const inputs = await loadInputs();
    log(`read ${inputs.restatements.length} restatements, ${inputs.dossiers.length} dossiers, ${inputs.research.products.length} research products, ${inputs.universe.items.length} universe tokens`);
    const { problems, output } = build(inputs);
    if (problems.length) {
        for (const p of problems) console.error(`[${new Date().toISOString()}] problem: ${p}`);
        throw new Error(`${problems.length} problems; nothing written`);
    }
    await writeFile(join(ROOT, out), `${JSON.stringify(output, null, 1)}\n`);
    const s = output.summary;
    log(`wrote ${out}: ${s.programmes} programmes, ${s.statements} statements (${Math.round(s.saidBySignerShare * 100)}% already said by their own signer), ${s.instances.total} instances restated, ${s.tokens.restated}/${s.tokens.total} tokens`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => { console.error(`[${new Date().toISOString()}] failed: ${error.message}`); process.exit(1); });
}
