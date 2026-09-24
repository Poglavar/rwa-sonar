#!/usr/bin/env node
// Reads every universe mint account from a public Solana RPC (getMultipleAccounts, jsonParsed)
// and flattens its Token-2022 extensions into capability flags — who can seize, freeze, pause,
// tax or re-denominate the token. Writes stocks/data/onchain.json plus the full raw parsed
// accounts to data/raw/; resumable, since the raw file doubles as the checkpoint.

import { join, relative } from 'node:path';
import { summarizeExtensions } from './lib/classify.mjs';
import { DEFAULT_RPC, MAX_ACCOUNTS_PER_REQUEST, fetchMintAccounts } from './lib/solana-rpc.mjs';
import { byString, isoDate, log, logError, logWarn, parseArgs, readJson, ts, writeJson } from './lib/io.mjs';

const HERE = import.meta.dirname;
const DEFAULT_IN = join(HERE, 'data', 'universe.json');
const DEFAULT_OUT = join(HERE, 'data', 'onchain.json');

function usage() {
    console.log(`fetch-onchain.mjs — read on-chain mint facts and Token-2022 extensions for the universe

USAGE
  node stocks/fetch-onchain.mjs --run [options]

OPTIONS
  --run            Actually fetch. Without it this help is printed and nothing runs.
  --force          Ignore today's checkpoint and re-read every mint.
  --rpc=<url>      RPC endpoint (default ${DEFAULT_RPC}).
  --batch=<n>      Pubkeys per request, RPC max ${MAX_ACCOUNTS_PER_REQUEST} (default ${MAX_ACCOUNTS_PER_REQUEST}).
  --pace=<ms>      Delay between requests (default 400).
  --limit=<n>      Only read the first n mints (smoke test).
  --in=<path>      Universe file (default stocks/data/universe.json).
  --out=<path>     Output file (default stocks/data/onchain.json).
  --help           This text.

NOTES
  Run fetch-universe.mjs first. Raw parsed accounts land in
  stocks/data/raw/mints-parsed-<date>.json and are the resume checkpoint: mints already
  present there are skipped. A 429 backs off 1s/2s/4s and then fails loudly rather than
  silently reporting a mint with no extensions.`);
}

function buildItems(accounts, universeByMint) {
    const items = [];
    const missing = [];
    for (const [mint, entry] of Object.entries(accounts)) {
        const universeItem = universeByMint.get(mint);
        if (!entry || !entry.account) {
            missing.push(mint);
            continue;
        }
        items.push({
            mint,
            symbol: universeItem?.symbol ?? null,
            issuer: universeItem?.issuer ?? null,
            ...summarizeExtensions(entry.account),
            owner: entry.account.owner ?? null,
            space: entry.account.space ?? null
        });
    }
    items.sort((a, b) => byString(a.mint, b.mint));
    missing.sort(byString);
    return { items, missing };
}

function tally(items, key) {
    const counts = {};
    for (const item of items) {
        const value = String(item[key]);
        counts[value] = (counts[value] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || byString(a[0], b[0])));
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }

    const rpc = typeof flags.rpc === 'string' ? flags.rpc : DEFAULT_RPC;
    const batchSize = Number(flags.batch ?? MAX_ACCOUNTS_PER_REQUEST);
    const paceMs = Number(flags.pace ?? 400);
    if (!Number.isFinite(batchSize) || batchSize < 1 || batchSize > MAX_ACCOUNTS_PER_REQUEST) {
        throw new Error(`--batch must be 1..${MAX_ACCOUNTS_PER_REQUEST}, got ${flags.batch}`);
    }
    if (!Number.isFinite(paceMs) || paceMs < 0) throw new Error(`--pace must be a non-negative number, got ${flags.pace}`);

    const inPath = typeof flags.in === 'string' ? flags.in : DEFAULT_IN;
    const outPath = typeof flags.out === 'string' ? flags.out : DEFAULT_OUT;
    const rawName = `mints-parsed-${isoDate()}.json`;
    const rawPath = join(HERE, 'data', 'raw', rawName);

    const universe = await readJson(inPath);
    if (!Array.isArray(universe.items)) throw new Error(`${inPath} has no items array — run fetch-universe.mjs --run first`);
    const universeByMint = new Map(universe.items.map((item) => [item.mint, item]));
    let mints = universe.items.map((item) => item.mint).sort(byString);
    if (flags.limit) mints = mints.slice(0, Number(flags.limit));
    log(`universe ${inPath}: ${mints.length} mint(s), fetched ${universe.fetchedAt}`);

    const empty = { startedAt: ts(), rpc, accounts: {} };
    const checkpoint = flags.force ? empty : await readJson(rawPath, empty);
    const todo = mints.filter((mint) => !checkpoint.accounts[mint]);
    const skipped = mints.length - todo.length;
    if (skipped > 0) log(`resuming from ${rawPath}: ${skipped} mint(s) already read and skipped`);

    const writeAll = async () => {
        const { items, missing } = buildItems(checkpoint.accounts, universeByMint);
        await writeJson(outPath, {
            fetchedAt: ts(),
            source: {
                rpc,
                method: 'getMultipleAccounts',
                encoding: 'jsonParsed',
                batchSize,
                universeFile: relative(join(HERE, '..'), inPath),
                rawFile: rawName,
                counts: {
                    mintsRequested: mints.length,
                    mintsRead: items.length,
                    byTokenProgram: tally(items, 'tokenProgram'),
                    permanentDelegate: items.filter((i) => i.permanentDelegate).length,
                    pausable: items.filter((i) => i.pausable).length,
                    transferHookConfigured: items.filter((i) => i.transferHookConfigured).length,
                    transferHookActive: items.filter((i) => i.transferHookProgram !== null).length,
                    withTransferFee: items.filter((i) => i.transferFeeBps !== null).length,
                    defaultAccountStateFrozen: items.filter((i) => i.defaultAccountStateFrozen).length
                },
                missingMints: missing
            },
            items
        });
        return { items, missing };
    };

    if (todo.length > 0) {
        await fetchMintAccounts(todo, {
            rpc,
            batchSize,
            paceMs,
            onBatch: async (results) => {
                const fetchedAt = ts();
                for (const { mint, account } of results) {
                    checkpoint.accounts[mint] = { account, _fetchedAt: fetchedAt };
                }
                checkpoint.rpc = rpc;
                await writeJson(rawPath, checkpoint);
                await writeAll();
            }
        });
    } else {
        log('nothing to fetch; rebuilding the output from the checkpoint');
    }

    const { items, missing } = await writeAll();
    log(`wrote ${outPath}: ${items.length} mint(s); raw accounts in ${rawPath}`);
    log(`token programs: ${Object.entries(tally(items, 'tokenProgram')).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    log(`capabilities: permanentDelegate ${items.filter((i) => i.permanentDelegate).length}, pausable ${items.filter((i) => i.pausable).length}, transferHook configured ${items.filter((i) => i.transferHookConfigured).length} (active ${items.filter((i) => i.transferHookProgram !== null).length}), transferFee ${items.filter((i) => i.transferFeeBps !== null).length}, defaultAccountState frozen ${items.filter((i) => i.defaultAccountStateFrozen).length}`);
    if (missing.length) {
        logWarn(`${missing.length} mint(s) had no account on ${rpc}: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ' …' : ''}`);
    }
    return 0;
}

main().then((code) => process.exit(code), (err) => {
    logError(err.stack ?? String(err));
    process.exit(1);
});
