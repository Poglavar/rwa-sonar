#!/usr/bin/env node
// Build one decision bundle per underlying (including lone wrappers) from existing snapshots;
// this is a local derivation, never a collector or a source-review timestamp refresh.
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { log, logError, parseArgs, readJson, writeJson } from './lib/io.mjs';
import { buildComparisonBundles, comparisonBundleIndex } from './lib/comparison-bundles.mjs';

const ROOT = join(import.meta.dirname, '..');
export async function buildComparisonFiles({ root = ROOT, outDir = join(root, 'comparisons') } = {}) {
    const [issuerDb, tokenDb, defiUsage, composability, reviewQueue] = await Promise.all([
        readJson(join(root, 'stocks-issuers.json')), readJson(join(root, 'stocks-tokens.json')),
        readJson(join(root, 'stocks/data/defi-usage.json'), null),
        readJson(join(root, 'stocks/data/composability-templates.json'), null),
        readJson(join(root, 'stocks-review-queue.json'), null)
    ]);
    const bundles = buildComparisonBundles({ issuerDb, tokenDb, defiUsage, composability, reviewQueue });
    const index = comparisonBundleIndex(bundles);
    await mkdir(outDir, { recursive: true });
    for (const [position, bundle] of bundles.entries()) await writeJson(join(outDir, index.groups[position].path), bundle, 0);
    await writeJson(join(outDir, 'index.json'), index, 0);
    const keep = new Set(index.groups.map((group) => group.path));
    for (const name of await readdir(outDir)) {
        if (/^u-[0-9a-f]+(?:-[0-9a-f]+)*\.json$/.test(name) && !keep.has(name)) await rm(join(outDir, name));
    }
    return index;
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (!flags.run) { console.log('node stocks/build-comparison-bundles.mjs --run [--out-dir=comparisons]'); return; }
    const index = await buildComparisonFiles({ outDir: resolve(ROOT, flags['out-dir'] ?? 'comparisons') });
    log(`wrote ${index.groups.length} scoped underlying decision bundles`);
}
if (import.meta.filename === process.argv[1]) main().catch((error) => { logError(error.stack ?? String(error)); process.exit(1); });
