#!/usr/bin/env node
// Rebuilds the compact first-load catalogue from the current full token and issuer artifacts.
// This is intentionally separate from build-stocks-db.mjs so a deployment that preserves newer
// job-owned server snapshots can regenerate the derived index without recollecting or rewriting them.

import { join } from 'node:path';

import { log, logError, parseArgs, readJson, writeJson } from './lib/io.mjs';
import { buildDiscoveryIndex } from './lib/discovery-index.mjs';

const ROOT = join(import.meta.dirname, '..');

export async function buildDiscoveryFile({ root = ROOT } = {}) {
    const issuerDb = await readJson(join(root, 'stocks-issuers.json'));
    const tokenDb = await readJson(join(root, 'stocks-tokens.json'));
    const defiUsage = await readJson(join(root, 'stocks/data/defi-usage.json'), null);
    const composability = await readJson(join(root, 'stocks/data/composability-templates.json'), null);
    const discovery = buildDiscoveryIndex({ issuerDb, tokenDb, defiUsage, composability });
    const out = await writeJson(join(root, 'stocks-discovery.json'), discovery, 1);
    return { out, tokenCount: discovery.tokens.length, issuerCount: discovery.issuers.length };
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        console.log('USAGE\n  node stocks/build-discovery-index.mjs --run');
        return 0;
    }
    const result = await buildDiscoveryFile();
    log(`wrote ${result.out}: ${result.tokenCount} compact token row(s), ${result.issuerCount} issuer row(s)`);
    return 0;
}

if (import.meta.filename === process.argv[1]) {
    main().then((code) => process.exit(code), (error) => {
        logError(error.stack ?? String(error));
        process.exit(1);
    });
}
