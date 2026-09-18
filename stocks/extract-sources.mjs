#!/usr/bin/env node
// Builds the source registry (EVIDENCE.md §5.1): every http(s) URL the 12 issuer dossiers and
// canonical-parties.json cite, with the field path that cites it, deduped by normalised URL and
// classified pdf/html/api. Writes stocks/data/sources.json, which stocks/watch-sources.mjs then
// fetches, hashes and diffs. Pure extraction lives in lib/sources.mjs; this file only does the IO
// and the run summary.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { buildRegistry, countBy, topHosts } from './lib/sources.mjs';
import { log, logWarn, parseArgs, readJson, ts, writeJson } from './lib/io.mjs';

const HERE = import.meta.dirname;
const ISSUER_DIR = join(HERE, 'data', 'issuers');
const PARTIES_FILE = join(HERE, 'data', 'canonical-parties.json');
const DEFAULT_OUT = join(HERE, 'data', 'sources.json');

function usage() {
    console.log(`extract-sources.mjs — the source registry the document watcher works from

USAGE
  node stocks/extract-sources.mjs --run [options]

OPTIONS
  --run          Actually walk the dossiers and write the file. Without it this help is printed
                 and nothing runs.
  --out=<path>   Output file (default stocks/data/sources.json).
  --help         This text.

WHAT IT DOES
  Walks every dossier in stocks/data/issuers/*.json and stocks/data/canonical-parties.json,
  string by string, and collects every http(s) URL with the field path it appeared in — so
  \`documents[3].url\`, \`findings[2].evidence\` and a URL buried in \`redemption.fees\` prose are all
  picked up. A \`whatIf[]\` citation is labelled by its failure MODE rather than its array index
  (\`whatIf[issuer-wind-down]\`, \`whatIf[issuer-wind-down].cases[0]\`), because inserting one answer
  renumbers every later one and the index would then point at a different mode.
  URLs are deduped by a normalised form (fragment and utm_* dropped, host lowercased,
  every other query parameter kept, because \`?alt=media&token=…\` IS the document), classified
  \`pdf\` (by extension), \`api\` (api.* host, /api/ path, .json) or \`html\`, and given a title: the
  \`documents[].title\` when that is where the URL came from, otherwise the field path itself.

  A citation written with an ellipsis (\`…/solana/token...\`) is NOT a URL anyone can fetch, so it
  is reported separately instead of being guessed at.

  Nothing is fetched here. stocks/watch-sources.mjs does that.`);
}

async function loadDossiers() {
    const files = (await readdir(ISSUER_DIR)).filter((f) => f.endsWith('.json')).sort();
    if (files.length === 0) throw new Error(`no dossiers in ${ISSUER_DIR}`);
    const dossiers = [];
    for (const file of files) {
        const slug = file.replace(/\.json$/, '');
        dossiers.push({ slug, doc: await readJson(join(ISSUER_DIR, file)) });
    }
    const parties = await readJson(PARTIES_FILE, null);
    if (parties) dossiers.push({ slug: null, doc: parties });
    else logWarn(`${PARTIES_FILE} absent — its URLs are not in the registry`);
    return { dossiers, files };
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return;
    }
    const out = typeof flags.out === 'string' ? flags.out : DEFAULT_OUT;

    const { dossiers, files } = await loadDossiers();
    log(`extract-sources: ${files.length} dossiers${dossiers.length > files.length ? ' + canonical-parties.json' : ''}`);

    const registry = buildRegistry(dossiers, { generatedAt: ts() });
    const { items, truncated } = registry;

    await writeJson(out, {
        generatedAt: registry.generatedAt,
        count: registry.count,
        items,
        truncatedCitations: truncated
    });

    log(`extract-sources: ${registry.count} distinct URLs -> ${out.replace(`${HERE}/`, 'stocks/')}`);
    const kinds = countBy(items, (i) => i.kind);
    log(`  by kind:   ${Object.entries(kinds).map(([k, n]) => `${k}=${n}`).join(' ')}`);
    const issuers = countBy(items, (i) => i.issuer);
    log(`  by issuer: ${Object.entries(issuers).map(([k, n]) => `${k}=${n}`).join(' ')}`);
    log('  top hosts:');
    for (const [host, n] of topHosts(items, 10)) log(`    ${String(n).padStart(3)} ${host}`);
    const shared = items.filter((i) => new Set(i.foundIn.map((p) => p.split(':')[0])).size > 1).length;
    log(`  ${shared} URL(s) cited by more than one dossier`);
    if (truncated.length) {
        logWarn(`${truncated.length} citation(s) are written truncated and cannot be fetched:`);
        for (const t of truncated) logWarn(`    ${t.issuer ?? 'shared'}:${t.path} -> ${t.raw}`);
    }
}

main().catch((err) => {
    console.error(`[${ts()}] ERROR ${err.stack || err.message}`);
    process.exitCode = 1;
});
