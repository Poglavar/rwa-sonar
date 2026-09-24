#!/usr/bin/env node
// Rebuilds exact-token protocol proof dossiers from saved inputs and retires obsolete generated routes.
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readJson, parseArgs, log, logError, writeJson } from './lib/io.mjs';
import { buildProtocolDossiers, renderProtocolDossier, renderProtocolIndex } from './lib/protocol-dossiers.mjs';
import { loadSchematics } from './lib/schematics-load.mjs';
import { absoluteImage, familyOgImage, finishFamilyOg, prepareFamilyOg } from './lib/og-family.mjs';
import { fmtCount, pageOgModel, protocolOgModel } from './lib/page-og.mjs';
const HERE = import.meta.dirname; const ROOT = join(HERE, '..');
async function main() {
 const { flags } = parseArgs(process.argv.slice(2)); if (!flags.run) { console.log('node stocks/build-protocol-dossiers.mjs --run [--base-url=https://rwasonar.com] [--out-dir=protocols] [--no-og-images]\n  writes <out-dir>/<slug>.html|.json, index.html|.json and <out-dir>/og/<slug>.<hash>.png (1200×630 previews; need npm ci --prefix stocks/og)'); return; }
 const out = resolve(ROOT, flags['out-dir'] ?? 'protocols'); const [tokens, issuers, usage, templates, marketResearch] = await Promise.all([readJson(join(ROOT, 'stocks-tokens.json')), readJson(join(ROOT, 'stocks-issuers.json')), readJson(join(HERE, 'data/defi-usage.json')), readJson(join(HERE, 'data/composability-templates.json')), readJson(join(HERE, 'data/protocol-market-research.json'), { markets: [] })]);
 const dossiers = buildProtocolDossiers({ tokens: tokens.tokens, issuers: issuers.issuers, usage, templates: templates.templates, marketResearch }); await mkdir(out, { recursive: true });
 // DeFi schematics (vault loops, liquidation dependencies) drawn on the dossiers they name in `appliesTo`.
 const schematics = (await loadSchematics({ issuers: issuers.issuers })).defi;
 const origin = typeof flags['base-url'] === 'string' && flags['base-url'].trim() ? flags['base-url'].trim().replace(/\/+$/, '') : null;
 // One 1200×630 preview per dossier (token × protocol and its proof ladder), content-hashed in <out>/og/.
 const og = await prepareFamilyOg({ outDir: out, urlPrefix: 'protocols', label: 'protocol', enabled: flags['no-og-images'] !== true && origin !== null });
 const keep = new Set(['index.html', 'index.json']); for (const dossier of dossiers) { keep.add(`${dossier.slug}.html`); keep.add(`${dossier.slug}.json`); const ogImage = absoluteImage(origin, await familyOgImage(og, dossier.slug, protocolOgModel(dossier))); await writeFile(join(out, `${dossier.slug}.html`), renderProtocolDossier(dossier, { baseUrl: flags['base-url'], version: '20260924y', ogImage, schematics })); await writeJson(join(out, `${dossier.slug}.json`), dossier, 0); }
 const indexImage = absoluteImage(origin, await familyOgImage(og, 'index', pageOgModel({ kicker: 'Protocol dossiers', title: 'Where can this exact token be used?', subtitle: 'One record per observed integration; unperformed decoding and simulation steps stay explicit.', stats: [{ value: fmtCount(dossiers.length), label: 'exact-token integrations' }, { value: fmtCount(new Set(dossiers.map((d) => d.integration?.protocolId ?? d.integration?.protocolName)).size), label: 'protocols' }, { value: fmtCount(dossiers.filter((d) => d.proof?.configurationDecoded).length), label: 'with decoded configuration' }], path: 'protocols/' })));
 await writeFile(join(out, 'index.html'), renderProtocolIndex(dossiers, { baseUrl: flags['base-url'], version: '20260924y', ogImage: indexImage })); await finishFamilyOg(og); await writeJson(join(out, 'index.json'), dossiers.map(({ slug, symbol, mint, issuer, integration, proof }) => ({ slug, symbol, mint, issuer, protocol: integration.protocolName, actions: integration.actions, proofStage: proof.sourceStatus })), 0);
 for (const name of await readdir(out)) if (!keep.has(name) && /\.(html|json)$/.test(name)) await rm(join(out, name)); log(`wrote ${dossiers.length} protocol dossier(s) to ${out}`);
}
if (import.meta.filename === process.argv[1]) main().catch((e) => { logError(e.stack ?? String(e)); process.exit(1); });
