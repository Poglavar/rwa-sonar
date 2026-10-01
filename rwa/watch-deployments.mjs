#!/usr/bin/env node
// Polls officially identified cross-asset deployments; stores observations without changing legal research dates.
import { join } from 'node:path';
import { readJson, writeJson, parseArgs, ts } from '../stocks/lib/io.mjs';
import monitor from './lib/monitor.js';
import { jsonRpc, observeEthereum, observeSolana } from './lib/chain-observer.mjs';
const ROOT = join(import.meta.dirname, '..');
const { flags } = parseArgs(process.argv.slice(2));
if (!flags.run) console.log('Usage: node rwa/watch-deployments.mjs --run [--only=<product-id>] [--root=<repo>]');
else {
    const root = typeof flags.root === 'string' ? flags.root : ROOT;
    const data = await readJson(join(root, 'rwa/data/research.json'));
    const file = join(root, 'rwa/data/deployment-observations.json');
    const state = await readJson(file, { schemaVersion: 1, records: {}, events: [] });
    const startedAt = ts();
    let failures = 0, checks = 0;
    for (const p of data.products.filter((p) => !flags.only || p.id === flags.only)) for (const d of p.deployments.filter((d) => d.identityCheckedAt && ['Ethereum', 'Solana'].includes(d.network))) {
        const now = ts(), old = state.records[d.id];
        try {
            const endpoint = d.network === 'Ethereum' ? (process.env.ETHEREUM_RPC_URL || 'https://ethereum-rpc.publicnode.com') : (process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');
            const rpc = (method, params) => jsonRpc(endpoint, method, params);
            const observation = await (d.network === 'Ethereum' ? observeEthereum : observeSolana)(d, rpc);
            for (const change of monitor.materialChanges(old?.observation, observation)) state.events.push({ id: `${d.id}:${now}:${change.field}`, deploymentId: d.id, productId: p.id, productName: p.name, address: d.address, network: d.network, ...change, firstObservedAt: now, eventAt: null, blockTimestamp: observation.blockTimestamp, blockHash: observation.blockHash || null, slot: observation.slot || null });
            state.records[d.id] = monitor.recordAttempt(old, { ok: true, observation }, { now });
            console.log(`[${now}] ${p.id} ${d.network}: observation saved; ${Object.values(observation.fields).filter((f) => f.state === 'unknown').length} fields unknown`);
        } catch (error) {
            failures += 1;
            state.records[d.id] = monitor.recordAttempt(old, { ok: false, error: error.message }, { now });
            console.error(`[${now}] ${p.id} ${d.network}: ${error.message}`);
        }
        checks += 1;
        state.lastRun = { at: now, checks, failures, status: failures ? 'degraded' : 'successful' };
        await writeJson(file, state);
    }
    if (!checks) throw new Error('No officially identified deployment matched the requested scope');
    const stats = { watchStatus: failures ? 'degraded' : 'ok', startedAt, lastRunEndedAt: ts(), deploymentsRead: checks, failures };
    const suffix = flags.only ? '-' + String(flags.only).replace(/[^a-z0-9-]/gi, '') : '';
    await writeJson(join(root, `.last-rwa-deployment-watch-stats${suffix}.json`), stats);
    if (failures) process.exitCode = 1;
}
