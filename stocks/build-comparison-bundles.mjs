#!/usr/bin/env node
// Build one decision bundle per underlying (including lone wrappers and pre-IPO companies, keyed by
// company: lib/private-companies.mjs) from existing snapshots;
// this is a local derivation, never a collector or a source-review timestamp refresh.
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { log, logError, parseArgs, readJson, writeJson } from './lib/io.mjs';
import { buildComparisonBundles, comparisonBundleIndex } from './lib/comparison-bundles.mjs';

const ROOT = join(import.meta.dirname, '..');
export async function buildComparisonFiles({ root = ROOT, outDir = join(root, 'comparisons') } = {}) {
    // The buyer table reads the closed-market lenders (build-closed-market.mjs) and the key holders
    // (build-power-map.mjs); both run earlier in the release (lib/release-manifest.mjs). A missing
    // file leaves those cells "not checked", never "no lender".
    const [issuerDb, tokenDb, defiUsage, composability, reviewQueue, closedMarket, powerMap] = await Promise.all([
        readJson(join(root, 'stocks-issuers.json')), readJson(join(root, 'stocks-tokens.json')),
        readJson(join(root, 'stocks/data/defi-usage.json'), null),
        readJson(join(root, 'stocks/data/composability-templates.json'), null),
        readJson(join(root, 'stocks-review-queue.json'), null),
        readJson(join(root, 'stocks-closed-market.json'), null),
        readJson(join(root, 'stocks-power-map.json'), null)
    ]);
    if (!closedMarket) log('stocks-closed-market.json not built: the lender cells will say "not checked here"');
    if (!powerMap) log('stocks-power-map.json not built: the powers cells will not name key holders');
    const bundles = buildComparisonBundles({ issuerDb, tokenDb, defiUsage, composability, reviewQueue, closedMarket, powerMap });
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
    const preIpo = index.groups.filter((group) => group.preIpo);
    log(`wrote ${index.groups.length} scoped underlying decision bundles, ${preIpo.length} of them pre-IPO companies with no listed ticker (${preIpo.map((group) => group.ticker).join(', ') || 'none'})`);
}
if (import.meta.filename === process.argv[1]) main().catch((error) => { logError(error.stack ?? String(error)); process.exit(1); });
