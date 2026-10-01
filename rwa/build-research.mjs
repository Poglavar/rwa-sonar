#!/usr/bin/env node
// Builds the shared report runtime from retained source research and chain observations; does not fetch.
import { join, resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { readJson, writeJson, parseArgs, ts } from '../stocks/lib/io.mjs';
import { buildResearch } from './lib/build-research.mjs';
const { flags } = parseArgs(process.argv.slice(2));
if (!flags.run) console.log('Usage: node rwa/build-research.mjs --run [--root=<repository>]');
else {
    const root = resolve(typeof flags.root === 'string' ? flags.root : join(import.meta.dirname, '..'));
    const [curated, issuers, tokens, observations] = await Promise.all([
        readJson(join(root, 'rwa/data/research.json')), readJson(join(root, 'stocks-issuers.json')), readJson(join(root, 'stocks-tokens.json')),
        readJson(join(root, 'rwa/data/deployment-observations.json'), { records: {} })
    ]);
    const dir = join(root, 'stocks/data/issuers'), dossiers = {};
    for (const file of (await readdir(dir)).filter((f) => f.endsWith('.json'))) dossiers[file.slice(0, -5)] = await readJson(join(dir, file));
    const data = buildResearch(curated, issuers, tokens, dossiers, observations, ts());
    await writeJson(join(root, 'rwa-research.json'), data, 0);
    console.log(`[${ts()}] shared research: ${data.counts.publicProductReviews} product reviews, ${data.counts.programmeDossiers} programme dossiers, ${data.counts.indexedDeployments} indexed deployments, ${data.counts.recentSuccessfulMonitors}/${data.counts.configuredMonitors} recent cross-asset observations`);
}
