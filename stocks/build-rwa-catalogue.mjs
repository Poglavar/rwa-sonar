#!/usr/bin/env node
// Builds the shared all-RWA discovery index from historical products and scoped stock dossiers.
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import catalogue from './lib/rwa-catalogue.js';
import researchModel from '../rwa/lib/research.js';
import { writeJson } from './lib/io.mjs';
const args = process.argv.slice(2);
if (!args.includes('--run')) {
    console.log('Usage: node stocks/build-rwa-catalogue.mjs --run [--root=<repository>]');
} else {
    const root = resolve(args.find((a) => a.startsWith('--root='))?.slice(7) || join(import.meta.dirname, '..'));
    const inputs = await Promise.all(['rwa-assets-db.json', 'stocks-issuers.json', 'stocks-tokens.json', 'rwa-research.json'].map(async (file) => JSON.parse(await readFile(join(root, file), 'utf8'))));
    researchModel.validateResearch(inputs[3]);
    const data = catalogue.buildCatalogue(...inputs);
    await writeJson(join(root, 'rwa-catalogue.json'), data, 0);
    console.log(`[${new Date().toISOString()}] RWA catalogue: ${data.counts.products} products (${data.counts.reviewedProducts} public reviews), ${data.counts.programmes} dossier programmes, ${data.counts.indexedStockDeployments} indexed stock deployments`);
}
