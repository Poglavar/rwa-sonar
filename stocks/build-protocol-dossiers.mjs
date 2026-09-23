#!/usr/bin/env node
// Rebuilds exact-token protocol proof dossiers from saved inputs and retires obsolete generated routes.
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readJson, parseArgs, log, logError, writeJson } from './lib/io.mjs';
import { buildProtocolDossiers, renderProtocolDossier, renderProtocolIndex } from './lib/protocol-dossiers.mjs';
const HERE = import.meta.dirname; const ROOT = join(HERE, '..');
async function main() {
 const { flags } = parseArgs(process.argv.slice(2)); if (!flags.run) { console.log('node stocks/build-protocol-dossiers.mjs --run [--base-url=https://rwasonar.com]'); return; }
 const out = resolve(ROOT, flags['out-dir'] ?? 'protocols'); const [tokens, issuers, usage, templates, marketResearch] = await Promise.all([readJson(join(ROOT, 'stocks-tokens.json')), readJson(join(ROOT, 'stocks-issuers.json')), readJson(join(HERE, 'data/defi-usage.json')), readJson(join(HERE, 'data/composability-templates.json')), readJson(join(HERE, 'data/protocol-market-research.json'), { markets: [] })]);
 const dossiers = buildProtocolDossiers({ tokens: tokens.tokens, issuers: issuers.issuers, usage, templates: templates.templates, marketResearch }); await mkdir(out, { recursive: true });
 const keep = new Set(['index.html', 'index.json']); for (const dossier of dossiers) { keep.add(`${dossier.slug}.html`); keep.add(`${dossier.slug}.json`); await writeFile(join(out, `${dossier.slug}.html`), renderProtocolDossier(dossier, { baseUrl: flags['base-url'], version: '20260922a' })); await writeJson(join(out, `${dossier.slug}.json`), dossier, 0); }
 await writeFile(join(out, 'index.html'), renderProtocolIndex(dossiers, { baseUrl: flags['base-url'], version: '20260922a' })); await writeJson(join(out, 'index.json'), dossiers.map(({ slug, symbol, mint, issuer, integration, proof }) => ({ slug, symbol, mint, issuer, protocol: integration.protocolName, actions: integration.actions, proofStage: proof.sourceStatus })), 0);
 for (const name of await readdir(out)) if (!keep.has(name) && /\.(html|json)$/.test(name)) await rm(join(out, name)); log(`wrote ${dossiers.length} protocol dossier(s) to ${out}`);
}
if (import.meta.filename === process.argv[1]) main().catch((e) => { logError(e.stack ?? String(e)); process.exit(1); });
