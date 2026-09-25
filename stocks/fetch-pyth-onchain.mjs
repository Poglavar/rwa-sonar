#!/usr/bin/env node
// Reads Pyth prices for every tokenized stock straight off Solana, with no Pyth key: for each
// stock's Equity.US.<T>/USD feed and each token's own Crypto.<SYMBOL>/USD feed, the push-oracle
// PriceUpdateV2 accounts on shards 0 and 1, in ONE bounded getMultipleAccounts pass (at most
// --max-requests requests of 100 keys) together with the Clock sysvar. Writes
// stocks/data/pyth-onchain.json (gitignored): price, confidence and Pyth's own publish time per
// account, and the chain clock of the read. The cards' "Where prices come from" block reads it.
// Decisions live in lib/pyth-onchain.mjs (tested); this file is the IO.

import { join } from 'node:path';

import { readEnvFile } from './lib/env.mjs';
import { byString, fetchJson, isoDate, log, logError, logWarn, parseArgs, readJson, ts, writeJson } from './lib/io.mjs';
import { equitySymbolForTicker } from './lib/pyth.mjs';
import {
    PYTH_SHARDS, buildPythOnchain, freshestReading, indexTokenFeeds, planAccountReads, tokenFeedFor
} from './lib/pyth-onchain.mjs';
import { DEFAULT_RPC, getAccountsWithContext } from './lib/solana-rpc.mjs';

const HERE = import.meta.dirname;
const REPO = join(HERE, '..');
const REFERENCE_PRICES_PATH = join(HERE, 'data', 'reference-prices.json');
const DEFAULT_OUT = join(HERE, 'data', 'pyth-onchain.json');
const RAW_DIR = join(HERE, 'data', 'raw');
// Keyless. The tokenized-stock feeds (Crypto.AAPLX/USD, Crypto.AAPLON/USD, …) are in the crypto list.
const CRYPTO_FEEDS_URL = 'https://hermes.pyth.network/v2/price_feeds?asset_type=crypto';
// The full catalogue matched about 790 feeds on the server (25 Sep 2026): two shards each, so 16
// requests. 32 leaves room for growth and still stops a runaway feed list.
const DEFAULT_MAX_REQUESTS = 32;

function usage() {
    console.log(`fetch-pyth-onchain.mjs — Pyth prices for every tokenized stock, read from Solana without a key

USAGE
  node stocks/fetch-pyth-onchain.mjs --run [options]

OPTIONS
  --run                 Actually read. Without it this help is printed and nothing runs.
  --limit=<n>           Read only the first n feeds (sorted by symbol) — a small batch to check a change.
  --max-requests=<n>    Cap on getMultipleAccounts requests of 100 keys (default ${DEFAULT_MAX_REQUESTS}); over it the run fails.
  --force               Re-fetch the keyless crypto feed list even if today's copy is in stocks/data/raw/.
  --rpc=<url>           RPC endpoint (default SOLANA_RPC_URL from .env, else ${DEFAULT_RPC}).
  --out=<path>          Output (default stocks/data/pyth-onchain.json).
  --help                This text.

INPUTS
  stocks/data/reference-prices.json   each token's underlying ticker and Equity.US.<T>/USD feed id
  ${CRYPTO_FEEDS_URL}
                                      the tokens' own Crypto.<SYMBOL>/USD feeds (xStocks, Ondo), keyless;
                                      cached per day in stocks/data/raw/pyth-crypto-feeds-<date>.json

OUTPUT
  {readAt (the chain's Clock sysvar), readSlot, counts, feeds[{id, symbol, kind: stock|token, accounts[{shard,
  address, exists, price, conf, publishTime, publishedAt, verification, postedSlot}]}], tokens[{mint, symbol,
  stockFeedId, tokenFeedId}]}. Every publish time is Pyth's own; nothing is our clock but fetchedAt.`);
}

/** Today's keyless crypto feed list, from the raw cache unless --force. */
async function cryptoFeedList(force) {
    const rawPath = join(RAW_DIR, `pyth-crypto-feeds-${isoDate()}.json`);
    if (!force) {
        const cached = await readJson(rawPath, null);
        if (Array.isArray(cached?.body)) {
            log(`pyth: reusing today's crypto feed list (${cached.body.length} feeds, fetched ${cached.fetchedAt})`);
            return { feeds: cached.body, fetchedAt: cached.fetchedAt };
        }
    }
    const fetchedAt = ts();
    log(`pyth: GET ${CRYPTO_FEEDS_URL}`);
    const res = await fetchJson(CRYPTO_FEEDS_URL, { headers: { accept: 'application/json' }, timeoutMs: 120000 });
    if (!res.ok) throw new Error(`Pyth crypto feed list failed: HTTP ${res.status} :: ${res.bodyPreview}`);
    if (!Array.isArray(res.json)) throw new Error(`Pyth crypto feed list: expected an array :: ${res.bodyPreview}`);
    await writeJson(rawPath, { fetchedAt, url: CRYPTO_FEEDS_URL, status: res.status, count: res.json.length, body: res.json });
    log(`pyth: ${res.json.length} crypto feeds, ${res.bytes} bytes`);
    return { feeds: res.json, fetchedAt };
}

function ageText(seconds) {
    if (!Number.isFinite(seconds)) return '?';
    if (seconds < 120) return `${seconds} s`;
    if (seconds < 7200) return `${Math.round(seconds / 60)} min`;
    if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} h`;
    return `${(seconds / 86400).toFixed(1)} d`;
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }
    const outPath = typeof flags.out === 'string' ? flags.out : DEFAULT_OUT;
    const limit = flags.limit === undefined ? null : Number(flags.limit);
    if (limit !== null && (!Number.isInteger(limit) || limit < 1)) throw new Error(`--limit must be a positive integer, got ${flags.limit}`);
    const maxRequests = flags['max-requests'] === undefined ? DEFAULT_MAX_REQUESTS : Number(flags['max-requests']);
    if (!Number.isInteger(maxRequests) || maxRequests < 1) throw new Error(`--max-requests must be a positive integer, got ${flags['max-requests']}`);

    const reference = await readJson(REFERENCE_PRICES_PATH);
    if (!Array.isArray(reference?.items)) throw new Error(`${REFERENCE_PRICES_PATH}: expected {items:[...]}`);
    const crypto = await cryptoFeedList(Boolean(flags.force));
    const tokenIndex = indexTokenFeeds(crypto.feeds);

    // One entry per unique feed: the listed stock's (from the reference-price collector's match)
    // and the token's own 24/7 feed where its issuer publishes one.
    const feedsById = new Map();
    const tokens = [];
    for (const item of reference.items) {
        const stockSymbol = item.pythFeedId ? equitySymbolForTicker(item.underlyingTicker) : null;
        const stockFeedId = stockSymbol === null ? null : item.pythFeedId;
        if (stockFeedId !== null && !feedsById.has(stockFeedId)) {
            feedsById.set(stockFeedId, { id: stockFeedId, symbol: stockSymbol, kind: 'stock', schedule: item.schedule ?? null });
        }
        const tokenFeed = tokenFeedFor(item, tokenIndex);
        if (tokenFeed !== null && !feedsById.has(tokenFeed.id)) {
            feedsById.set(tokenFeed.id, { id: tokenFeed.id, symbol: tokenFeed.attributes.symbol, kind: 'token', schedule: tokenFeed.attributes.schedule ?? null });
        }
        if (stockFeedId !== null || tokenFeed !== null) {
            tokens.push({ mint: item.mint, symbol: item.symbol ?? null, stockFeedId, tokenFeedId: tokenFeed?.id ?? null });
        }
    }
    let feeds = [...feedsById.values()].sort((a, b) => byString(a.symbol, b.symbol));
    log(`feeds: ${feeds.filter((f) => f.kind === 'stock').length} stock (Equity.US) and ${feeds.filter((f) => f.kind === 'token').length} token (Crypto.<SYMBOL>/USD) feeds for ${tokens.length} of ${reference.items.length} tokens`);
    if (limit !== null) {
        feeds = feeds.slice(0, limit);
        const kept = new Set(feeds.map((f) => f.id));
        logWarn(`--limit=${limit}: reading ${feeds.length} feed(s) only (${feeds.map((f) => f.symbol).join(', ')})`);
        for (const t of tokens) {
            if (!kept.has(t.stockFeedId)) t.stockFeedId = null;
            if (!kept.has(t.tokenFeedId)) t.tokenFeedId = null;
        }
    }
    const keptTokens = tokens.filter((t) => t.stockFeedId !== null || t.tokenFeedId !== null);

    const plan = planAccountReads(feeds, { shards: PYTH_SHARDS, maxRequests });
    const env = await readEnvFile(join(REPO, '.env'));
    const rpc = typeof flags.rpc === 'string' ? flags.rpc : (env.SOLANA_RPC_URL || DEFAULT_RPC);
    log(`reading ${plan.slots.length} Pyth account(s) (shards ${PYTH_SHARDS.join(', ')}) and the Clock sysvar in ${plan.requests.length} getMultipleAccounts request(s) via ${new URL(rpc).host}`);

    const accounts = [];
    const slots = [];
    for (let i = 0; i < plan.requests.length; i += 1) {
        const res = await getAccountsWithContext(plan.requests[i], { rpc, encoding: 'base64' });
        accounts.push(...res.value);
        slots.push(res.slot);
        log(`request ${i + 1}/${plan.requests.length}: ${res.value.filter(Boolean).length}/${plan.requests[i].length} account(s) exist, slot ${res.slot}`);
    }

    const out = buildPythOnchain({
        feeds, plan, accounts, slots, tokens: keptTokens,
        inputs: {
            referencePricesFetchedAt: reference.fetchedAt ?? null,
            cryptoFeedListUrl: CRYPTO_FEEDS_URL,
            cryptoFeedListFetchedAt: crypto.fetchedAt ?? null,
            limit
        }
    });
    out.fetchedAt = ts();

    // How fresh the freshest account of each feed is against the chain clock, per kind.
    const readUnix = Date.parse(out.readAt) / 1000;
    for (const kind of ['stock', 'token']) {
        const ages = out.feeds.filter((f) => f.kind === kind).map((f) => freshestReading(f.accounts)).map((r) => (r ? readUnix - r.publishTime : null));
        const within = (s) => ages.filter((a) => a !== null && a <= s).length;
        log(`${kind} feeds: ${ages.length} · with a price ${ages.filter((a) => a !== null).length} · published within 1 h ${within(3600)} · within 1 d ${within(86400)} · none on shards ${PYTH_SHARDS.join('/')} ${ages.filter((a) => a === null).length}`);
    }
    for (const f of out.feeds.slice(0, 6)) {
        const parts = f.accounts.map((a) => (a.exists ? `shard ${a.shard} ${a.price ?? '?'} @ ${a.publishedAt ?? '?'} (${ageText(readUnix - a.publishTime)} old)` : `shard ${a.shard} none`));
        log(`  ${f.symbol}: ${parts.join(' · ')}`);
    }
    if (out.counts.feedMismatches > 0) logWarn(`${out.counts.feedMismatches} account(s) held another feed than their address implies — their prices are left out`);

    await writeJson(outPath, out);
    log(`wrote ${outPath}: ${out.counts.feeds} feed(s), ${out.counts.accountsFound}/${out.counts.accountsRead} account(s) found, read at ${out.readAt} (chain clock, slot ${out.readSlot})`);
    return 0;
}

main().then((code) => process.exit(code), (err) => {
    logError(err.stack ?? String(err));
    process.exit(1);
});
