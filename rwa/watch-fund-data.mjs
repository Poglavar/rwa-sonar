#!/usr/bin/env node
// Local, read-only polling. No scheduler, notifications or database writes.
import { join } from 'node:path';
import { parseArgs, readJson, writeJson, ts } from '../stocks/lib/io.mjs';
import { jsonRpc } from './lib/chain-observer.mjs';
import { superstateFund, decodeNav } from './lib/fund-data.mjs';
import monitor from './lib/monitor.js';
const root = join(import.meta.dirname, '..');
const { flags } = parseArgs(process.argv.slice(2));
if (!flags.run) console.log('Usage: node rwa/watch-fund-data.mjs --run [--only=ustb|ustbl]');
else {
    const jobs = [{ id: 'ustb', async read() {
        const response = await fetch('https://api.superstate.com/v2/instruments', { signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error(`Registry HTTP ${response.status}`);
        return superstateFund(await response.json());
    } }, { id: 'ustbl', async read() {
        const rpc = (method, params) => jsonRpc(process.env.ETHEREUM_RPC_URL || 'https://ethereum-rpc.publicnode.com', method, params);
        if (await rpc('eth_chainId', []) !== '0x1') throw new Error('RPC is not Ethereum mainnet');
        const block = await rpc('eth_getBlockByNumber', ['finalized', false]);
        if (!block?.hash || !block.timestamp) throw new Error('No finalized block');
        const tag = { blockHash: block.hash, requireCanonical: true };
        const to = '0x477e363c51ab0c4d13b22cd6b57d56d4a3cb7abe'; // USTBL Chainlink feed in official Spiko NAV table.
        const round = await rpc('eth_call', [{ to, data: '0xfeaf968c' }, tag]);
        const decimals = await rpc('eth_call', [{ to, data: '0x313ce567' }, tag]);
        return { ...decodeNav(round, decimals, Number(BigInt(block.timestamp))), blockHash: block.hash, blockTimestamp: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString() };
    } }].filter(j => !flags.only || j.id === flags.only);
    if (!jobs.length) throw new Error('Unknown fund data scope');
    const file = join(root, 'rwa/data/fund-observations.json');
    const state = await readJson(file, { schemaVersion: 1, records: {}, events: [] });
    const startedAt = ts(); let failures = 0, stale = 0, successfulReads = 0;
    for (const job of jobs) {
        const now = ts(), old = state.records[job.id];
        try {
            const observation = await job.read();
            // NAV and supply changes are routine; identity/deployment changes need review.
            const changes = monitor.materialChanges(old?.observation, observation).filter(c => !['navRaw', 'price'].includes(c.field));
            for (const change of changes) state.events.push({ productId: job.id, firstObservedAt: now, eventAt: null, ...change });
            state.records[job.id] = monitor.recordAttempt(old, { ok: true, observation }, { now });
            if (observation.evidenceStatus === 'stale') stale++;
            successfulReads++; console.log(`${job.id}: saved (${observation.evidenceStatus || 'metadata; source period unknown'})`);
        } catch (error) {
            failures++; state.records[job.id] = monitor.recordAttempt(old, { ok: false, error: error.message }, { now });
            console.error(`${job.id}: ${error.message}`);
        }
    }
    await writeJson(file, state);
    const suffix = flags.only ? '-' + String(flags.only).replace(/[^a-z0-9-]/gi, '') : '';
    await writeJson(join(root, `.last-rwa-fund-watch-stats${suffix}.json`), { startedAt, lastRunEndedAt: ts(), watchStatus: failures || stale ? 'degraded' : 'ok', feedsExpected: jobs.length, successfulReads, failures, staleEvidence: stale });
    if (failures || stale) process.exitCode = 1;
}
