#!/usr/bin/env node
// Resolves WHEN recently first-seen mints were created, so the latest-events feed can say "created"
// instead of "first seen" — or say that a mint existed long before the catalogue saw it. One bounded
// pass per run: getSignaturesForAddress on the mint account, paging back to its oldest transaction,
// under a small call budget (the method is priced high on Alchemy). A creation time never changes,
// so every answer is cached for good in stocks/data/mint-created.json (gitignored, written after
// each mint: a killed run loses at most the mint in hand). Pure parts: lib/mint-created.mjs.

import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { readEnvFile } from './lib/env.mjs';
import { log, logError, logWarn, parseArgs, readJson, sleep, writeJson } from './lib/io.mjs';
import { creationVerdict } from './lib/events.mjs';
import { PAGE_LIMIT, foldSignaturePage, mintsToCheck } from './lib/mint-created.mjs';
import { DEFAULT_RPC, rpcCall } from './lib/solana-rpc.mjs';

const REPO_ROOT = join(import.meta.dirname, '..');
const DEFAULT_BUDGET = 30;
const DEFAULT_MAX_PAGES = 3;
const PACE_MS = 400;

function usage() {
    console.log(`fetch-mint-created.mjs — creation times of recently first-seen mints (bounded RPC)

USAGE
  node stocks/fetch-mint-created.mjs --run [options]

OPTIONS
  --run               Actually fetch. Without it this help is printed and nothing runs.
  --budget=<n>        Max getSignaturesForAddress calls this run (default ${DEFAULT_BUDGET}).
  --max-pages=<n>     Max pages (${PAGE_LIMIT} signatures each) per mint (default ${DEFAULT_MAX_PAGES}).
  --root=<dir>        Repo root holding stocks-tokens.json and stocks/data (default: this repo).
  --pace=<ms>         Pause between calls (default ${PACE_MS}).
  --help              This text.

INPUTS   <root>/stocks-tokens.json (firstSeenAt), <root>/stocks/data/history/ (first recorded day),
         SOLANA_RPC_URL from ${join(REPO_ROOT, '.env')} (never printed)
OUTPUT   <root>/stocks/data/mint-created.json  {mints: {<mint>: {state, createdAt, createdBefore, ...}}}
         state: created (oldest transaction reached) | predates (existed well before first sight)
                | undecided (budget ran out first; not retried)`);
}

function count(value, fallback) {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }
    const root = resolve(typeof flags.root === 'string' ? flags.root : REPO_ROOT);
    const budget = count(flags.budget, DEFAULT_BUDGET);
    const maxPages = Math.max(1, count(flags['max-pages'], DEFAULT_MAX_PAGES));
    const pace = count(flags.pace, PACE_MS);
    const cachePath = join(root, 'stocks', 'data', 'mint-created.json');

    const env = await readEnvFile(join(REPO_ROOT, '.env'));
    const rpc = typeof env.SOLANA_RPC_URL === 'string' && env.SOLANA_RPC_URL ? env.SOLANA_RPC_URL : DEFAULT_RPC;
    if (rpc === DEFAULT_RPC) logWarn('no SOLANA_RPC_URL in .env — using the throttled public endpoint');
    else log(`rpc host ${new URL(rpc).hostname}`);

    const tokenDb = await readJson(join(root, 'stocks-tokens.json'));
    if (!Array.isArray(tokenDb?.tokens)) throw new Error('stocks-tokens.json: expected {tokens:[...]}');
    const cacheDoc = await readJson(cachePath, { mints: {} });
    const cache = cacheDoc.mints ?? {};
    const days = (await readdir(join(root, 'stocks', 'data', 'history')).catch((err) => {
        if (err.code === 'ENOENT') return [];
        throw err;
    }))
        .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort();
    const queue = mintsToCheck(tokenDb.tokens, cache, { asOf: tokenDb.builtAt, recordsBeginOn: days[0] ?? null });
    const settled = Object.keys(cache).length;
    log(`${queue.length} mint(s) to check, ${settled} already cached; budget ${budget} call(s), ≤${maxPages} page(s) per mint`);

    let calls = 0;
    let done = 0;
    const decided = new Set();
    for (const { mint, firstSeenAt, group } of queue) {
        if (calls >= budget) break;
        if (decided.has(group)) {
            done += 1;
            continue; // this run already proved the batch older than its first sighting
        }
        let record = { ...(cache[mint] ?? {}) };
        // An `open` record (an earlier run's budget ended mid-mint) resumes below its oldest signature.
        let before = record.state === 'open' ? record.oldestSignature ?? null : null;
        for (let page = 1; page <= maxPages && calls < budget; page += 1) {
            const params = [mint, { limit: PAGE_LIMIT, ...(before ? { before } : {}) }];
            const signatures = await rpcCall('getSignaturesForAddress', params, { rpc });
            calls += 1;
            record = foldSignaturePage(record, signatures, { firstSeenAt, lastPage: page === maxPages });
            record.checkedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
            before = record.oldestSignature ?? null;
            await sleep(pace);
            if (record.state !== 'open') break;
        }
        // A record still `open` (the budget ended mid-mint) is kept so the next run resumes from it.
        cache[mint] = record;
        if (creationVerdict(record, firstSeenAt)?.verdict === 'predates') decided.add(group);
        await writeJson(cachePath, { note: 'Creation times of mint accounts from their oldest transaction (stocks/fetch-mint-created.mjs). Cached for good: a creation time never changes.', mints: cache });
        done += 1;
        log(`${done}/${queue.length} ${mint.slice(0, 6)}…: ${record.state}`
            + `${record.createdAt ? ` created ${record.createdAt}` : record.createdBefore ? ` (oldest seen ${record.createdBefore})` : ''}`
            + ` · first seen ${firstSeenAt} · ${calls}/${budget} calls`);
    }
    const left = queue.length - done;
    log(`checked ${done} mint(s) with ${calls} call(s)${left > 0 ? `; ${left} left for the next run (budget)` : ''}`);
    return 0;
}

if (import.meta.filename === process.argv[1]) {
    main().then((code) => process.exit(code), (err) => {
        logError(err.stack ?? String(err));
        process.exit(1);
    });
}
