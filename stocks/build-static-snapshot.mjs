#!/usr/bin/env node
// Rewrites the marked snapshot regions of index.html and pitch/index.html with the counts of the
// release just built (last step of the `surfaces` release phase). The live pages refine the numbers
// from the API; this makes the HTML truthful before any script runs and in link previews.
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log, logError, parseArgs, readJson } from './lib/io.mjs';
import { STATIC_SNAPSHOT_PAGES, renderStaticSnapshots, snapshotFacts } from './lib/static-snapshot.mjs';

const REPO_ROOT = join(import.meta.dirname, '..');

function usage() {
    console.log(`build-static-snapshot.mjs — write current catalogue counts into the landing and pitch HTML

USAGE
  node stocks/build-static-snapshot.mjs --run [--root=<repo>]

INPUTS
  stocks-tokens.json, stocks-issuers.json, stocks-legal-templates.json, stocks-health.json,
  stocks/data/defi-usage.json

OUTPUTS (rewritten in place, only between their snapshot markers)
  ${STATIC_SNAPSHOT_PAGES.join(', ')}`);
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (!flags.run || flags.help) return usage();
    const root = flags.root ?? REPO_ROOT;
    const [tokens, issuers, templates, health, defi] = await Promise.all([
        readJson(join(root, 'stocks-tokens.json')), readJson(join(root, 'stocks-issuers.json')),
        readJson(join(root, 'stocks-legal-templates.json')), readJson(join(root, 'stocks-health.json')),
        readJson(join(root, 'stocks/data/defi-usage.json'))
    ]);
    const facts = snapshotFacts({ tokens, issuers, templates, health, defi });
    const pages = {};
    for (const page of STATIC_SNAPSHOT_PAGES) pages[page] = await readFile(join(root, page), 'utf8');
    const rendered = renderStaticSnapshots(pages, facts);
    for (const page of STATIC_SNAPSHOT_PAGES) {
        if (rendered[page] === pages[page]) continue;
        const target = join(root, page);
        const temporary = `${target}.${process.pid}.tmp`;
        await writeFile(temporary, rendered[page]);
        await rename(temporary, target);
    }
    log(`static snapshot: ${facts.tokenCount} tokens, ${facts.programmes.withTokens}/${facts.programmes.total} programmes with tokens, built ${facts.builtAt} → ${STATIC_SNAPSHOT_PAGES.join(', ')}`);
}
if (import.meta.filename === process.argv[1]) main().catch((error) => { logError(error.stack ?? String(error)); process.exit(1); });
