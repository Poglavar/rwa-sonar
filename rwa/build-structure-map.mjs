#!/usr/bin/env node
// Builds the all-RWA structure map from retained, mutually consistent research and discovery artifacts.
import { readJson, writeJson, parseArgs, ts } from '../stocks/lib/io.mjs';
import { resolve, join } from 'node:path';
import map from './lib/structure-map.js';
const { flags } = parseArgs(process.argv.slice(2));
if (!flags.run) console.log('Usage: node rwa/build-structure-map.mjs --run [--root=<repository>]');
else {
    const root = resolve(typeof flags.root === 'string' ? flags.root : join(import.meta.dirname, '..'));
    const [research, catalogue] = await Promise.all(['rwa-research.json', 'rwa-catalogue.json'].map((f) => readJson(join(root, f))));
    const data = map.buildMap(research, catalogue);
    await writeJson(join(root, 'rwa-structure-map.json'), data, 0);
    console.log(`[${ts()}] structure map: ${data.counts.deployments} indexed deployments, ${data.counts.programmes} programmes, ${data.counts.subjects} research subjects`);
}
