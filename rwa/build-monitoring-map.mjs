#!/usr/bin/env node
// Publish a compact monitoring map from retained local inputs. This builder never runs collectors.
import { readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildMonitoringInventory } from './lib/monitoring-inventory.mjs';
import { JOBS } from './lib/monitoring-jobs.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
async function json(root, file, optional = false) {
    try { return JSON.parse(await readFile(join(root, file), 'utf8')); }
    catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}
export async function buildMonitoringMap({ root = ROOT, output = join(root, 'monitoring-map.json'), generatedAt = new Date().toISOString() } = {}) {
    const files = (await readdir(join(root, 'stocks/data/issuers'))).filter((file) => file.endsWith('.json')).sort();
    const dossiers = await Promise.all(files.map(async (file) => ({ slug: file.slice(0, -5), dossier: await json(root, `stocks/data/issuers/${file}`) })));
    const paths = { research: 'rwa/data/research.json', canonical: 'stocks/data/canonical-parties.json', retirements: 'stocks/data/retired-sources.json',
        extra: 'stocks/data/caselaw-extra.json', entityRegistry: 'stocks/data/entity-registry-ids.json', registration: 'rwa/monitor-registration.json',
        monitorPlan: 'rwa/data/monitor-plan.json', sourceState: 'stocks/data/sources-state.json', sourceAudit: 'rwa/data/source-access-audit.json',
        tokens: 'stocks-tokens.json', defi: 'stocks/data/defi-usage.json', protocolResearch: 'stocks/data/protocol-market-research.json',
        venues: 'stocks/data/venues.json', referencePrices: 'stocks/data/reference-prices.json', pythOnchain: 'stocks/data/pyth-onchain.json' };
    const input = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, file]) => [key, await json(root, file, !['research', 'canonical', 'entityRegistry', 'extra'].includes(key))])));
    for (const [key, value] of Object.entries(input)) if (value === null) delete input[key];
    const statsFiles = [...new Set(Object.values(JOBS).map((row) => row[4]).filter(Boolean))];
    input.stats = Object.fromEntries(await Promise.all(statsFiles.map(async (file) => [file, await json(root, file, true)])));
    input.tokens = input.tokens?.tokens || [];
    input.apps = require(join(root, 'ecosystem.config.cjs')).apps;
    input.refreshScript = await readFile(join(root, 'stocks/refresh-on-server.sh'), 'utf8');
    input.dossiers = dossiers;
    const data = buildMonitoringInventory(input, generatedAt);
    const temp = `${output}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(data) + '\n');
    await rename(temp, output);
    return data;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    if (!args.includes('--run') || args.includes('--help')) console.log('Usage: node rwa/build-monitoring-map.mjs --run [--root=<source repository>] [--out=<output JSON>]');
    else {
        const root = resolve(args.find((a) => a.startsWith('--root='))?.slice(7) || ROOT);
        const output = resolve(args.find((a) => a.startsWith('--out='))?.slice(6) || join(ROOT, 'monitoring-map.json'));
        const data = await buildMonitoringMap({ root, output });
        console.log(`[${data.generatedAt}] Monitoring map: ${data.issuers.length} issuer/product scopes, ${data.jobs.length} missions, ${data.sources.length} destinations, ${data.routes.length} routes`);
    }
}
