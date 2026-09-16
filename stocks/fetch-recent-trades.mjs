#!/usr/bin/env node
// Collects INDIVIDUAL trades from the busiest tokenized-stock pools on Solana (MODEL.md §12) —
// the one layer of this dataset where per-trade truth exists, because every swap against a pool is
// a transaction on the pool's address that a public RPC will hand over. Per run it reads the newest
// signatures for the top pools by 24 h volume, counts the reverted ones without fetching them,
// decodes the successful ones from the pool's own token-balance changes, and rolls the result into
// a 24-hour window. Nothing is interpolated or smoothed: a trade in the output happened.
//
// Writes stocks/data/trades-24h.json (the rolling store, with the collector's own bookkeeping) and
// publishes stocks-trades.json at the repo root for live.html. Restartable at any point: the store
// is the checkpoint, dedupe is by signature, and a killed run costs at most a handful of requests.

import { join } from 'node:path';
import { fetchJson, log, logError, logWarn, parseArgs, readJson, sleep, ts, writeJson } from './lib/io.mjs';
import {
    buildPayload,
    decodeTrade,
    mergeSeenSignatures,
    mergeTrades,
    partitionSignatures,
    quoteUsdRate,
    selectPools,
    selectSignaturesToFetch,
    USDC_MINT,
    USDT_MINT,
    WINDOW_HOURS,
    WSOL_MINT
} from './lib/trades.mjs';

const HERE = import.meta.dirname;
const VENUES_PATH = join(HERE, 'data', 'venues.json');
const STORE_PATH = join(HERE, 'data', 'trades-24h.json');
const PUBLISH_PATH = join(HERE, '..', 'stocks-trades.json');

const DEX_PAIR_URL = 'https://api.dexscreener.com/latest/dex/pairs/solana';
const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';

const DEFAULT_POOLS = 15;
const SIGNATURE_LIMIT = 50;
// The public RPC is shared and unmetered; 600 ms between calls kept 130+ consecutive requests clean
// (2026-09-16). Every 429 costs far more than going slowly, so this is not tuned down.
const RPC_PACE_MS = 600;
const RPC_BACKOFF_MS = [1000, 2000, 4000, 8000];
// A run's ceiling on getTransaction calls. At 600 ms apart, 120 is ~72 s of requests.
const DEFAULT_BUDGET = 120;
const DEX_PACE_MS = 250;
const DEX_BACKOFF_MS = [1000, 2000, 4000];
// The store is rewritten this often rather than after every transaction: at ~24 h of trades the
// file is several hundred KB, and a kill costs at most this many requests' worth of progress.
const CHECKPOINT_EVERY = 10;

function usage() {
    console.log(`fetch-recent-trades.mjs — individual trades from the busiest tokenized-stock pools

USAGE
  node stocks/fetch-recent-trades.mjs --run [options]

OPTIONS
  --run                 Actually fetch. Without it this help is printed and nothing runs.
  --every=<seconds>     Loop forever, one pass per interval, with a progress line per run.
  --pools=<n>           How many pools to sample, by 24 h volume (default ${DEFAULT_POOLS}).
  --budget=<n>          Max getTransaction calls per run (default ${DEFAULT_BUDGET}).
  --rpc=<url>           Solana JSON-RPC endpoint (default ${DEFAULT_RPC}).
  --help                This text.

INPUTS
  stocks/data/venues.json       the DEX pools per mint; the sample is its top pools by volume24Usd

OUTPUTS
  stocks/data/trades-24h.json   rolling ${WINDOW_HOURS} h store: trades by signature, plus the
                                signatures already fetched that held no trade, and collectingSince
  stocks-trades.json            published for live.html (MODEL.md §12.2)

NOTES
  Keyless: DexScreener and a public Solana RPC, both read-only GETs/POSTs.
  Signatures whose transaction REVERTED are counted per pool and never fetched — there is nothing in
  them to decode, and their share is the honest measure of how much pool "activity" never happened.
  getTransaction is paced ${RPC_PACE_MS} ms apart with exponential backoff on 429; once the ladder is
  exhausted the run stops early, writes what it has and publishes. Nothing is lost: the next run
  re-selects the same signatures.
  The sample is the newest ${SIGNATURE_LIMIT} signatures per pool per run. The busiest pool turns that
  window over in ~137 s (measured 2026-09-16), so the tape SAMPLES those pools rather than
  capturing every trade; --every=120 keeps the sample close to contiguous.
  A trade's time is the transaction's own blockTime, never the collector's clock. A pool quoted in
  anything but SOL/USDC/USDT gets no USD rate, so its trades carry size and a quote price and no
  USD figure at all.`);
}

/** One JSON-RPC call with retries on 429/5xx. `{result, gaveUp}`; gaveUp ends the run politely. */
async function rpcCall(rpc, method, params, label) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    let rateLimited = 0;
    for (let attempt = 0; ; attempt += 1) {
        let res = null;
        try {
            res = await fetchJson(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body, timeoutMs: 60000 });
        } catch (err) {
            if (attempt >= RPC_BACKOFF_MS.length) {
                logWarn(`${label}: ${err.name}: ${err.message} — giving up for this run`);
                return { result: null, gaveUp: true, rateLimited, error: null };
            }
            logWarn(`${label}: ${err.name}: ${err.message}, retrying in ${RPC_BACKOFF_MS[attempt]} ms`);
            await sleep(RPC_BACKOFF_MS[attempt]);
            continue;
        }

        if (res.status === 429 || res.status >= 500) {
            if (res.status === 429) rateLimited += 1;
            if (attempt >= RPC_BACKOFF_MS.length) {
                logWarn(`${label}: HTTP ${res.status} after ${RPC_BACKOFF_MS.length} retries — giving up for this run`);
                return { result: null, gaveUp: true, rateLimited, error: null };
            }
            logWarn(`${label}: HTTP ${res.status}, retrying in ${RPC_BACKOFF_MS[attempt]} ms`);
            await sleep(RPC_BACKOFF_MS[attempt]);
            continue;
        }
        if (!res.ok) {
            logWarn(`${label}: HTTP ${res.status} :: ${res.bodyPreview}`);
            return { result: null, gaveUp: false, rateLimited, error: null };
        }
        if (res.json === null) {
            logWarn(`${label}: unparseable body: ${res.parseError} :: ${res.bodyPreview}`);
            return { result: null, gaveUp: false, rateLimited, error: null };
        }
        if (res.json.error) {
            return { result: null, gaveUp: false, rateLimited, error: res.json.error };
        }
        return { result: res.json.result ?? null, gaveUp: false, rateLimited, error: null };
    }
}

/**
 * One transaction, asking for legacy support first.
 *
 * `maxSupportedTransactionVersion: 0` is not enough on its own: the RPC refuses a transaction whose
 * version is above the one asked for (error -32015) and names the version it wants. Five of the
 * first 120 swaps sampled were version 1 (2026-09-16), so taking the refusal at face value would
 * have dropped 4% of real trades while reporting nothing wrong. The refusal is retried once at the
 * version the node named. That second request is not charged to the transaction budget — it is the
 * same transaction — and is counted separately so the cost stays visible.
 */
async function fetchTransaction(rpc, signature, label) {
    const first = await rpcCall(rpc, 'getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }], label);
    if (first.result !== null || first.gaveUp) return { ...first, extraRequests: 0, versionBumped: false };

    const wanted = first.error?.code === -32015 ? Number(/version \((\d+)\)/.exec(first.error.message ?? '')?.[1]) : NaN;
    if (!Number.isFinite(wanted)) {
        if (first.error !== null) logWarn(`${label}: RPC error ${first.error.code}: ${first.error.message}`);
        return { ...first, extraRequests: 0, versionBumped: false };
    }
    await sleep(RPC_PACE_MS);
    const retry = await rpcCall(rpc, 'getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: wanted }], `${label} v${wanted}`);
    if (retry.error !== null) logWarn(`${label}: RPC error ${retry.error.code}: ${retry.error.message}`);
    return { ...retry, rateLimited: first.rateLimited + retry.rateLimited, extraRequests: 1, versionBumped: true };
}

/**
 * The USD value of one unit of the pool's quote asset, from the pool's OWN DexScreener quote.
 * A stable-quoted pool needs no request at all, so none is made.
 */
async function fetchQuoteUsdRate(pool) {
    if (pool.quoteMint === USDC_MINT || pool.quoteMint === USDT_MINT) {
        return { rate: quoteUsdRate({ quoteMint: pool.quoteMint }), basis: 'stablecoin quote, taken as $1', requested: false };
    }
    if (pool.quoteMint !== WSOL_MINT) {
        return { rate: null, basis: `quote ${pool.quoteSymbol ?? 'unknown'} has no USD reference — trades stay unpriced in USD`, requested: false };
    }

    const url = `${DEX_PAIR_URL}/${pool.pair}`;
    for (let attempt = 0; ; attempt += 1) {
        let res = null;
        try {
            res = await fetchJson(url, { headers: { accept: 'application/json' }, timeoutMs: 60000 });
        } catch (err) {
            if (attempt >= DEX_BACKOFF_MS.length) return { rate: null, basis: `DexScreener unreachable: ${err.message}`, requested: true };
            await sleep(DEX_BACKOFF_MS[attempt]);
            continue;
        }
        if ((res.status === 429 || res.status >= 500) && attempt < DEX_BACKOFF_MS.length) {
            logWarn(`dexscreener ${pool.pair.slice(0, 8)}: HTTP ${res.status}, retrying in ${DEX_BACKOFF_MS[attempt]} ms`);
            await sleep(DEX_BACKOFF_MS[attempt]);
            continue;
        }
        if (!res.ok || res.json === null) return { rate: null, basis: `DexScreener HTTP ${res.status}`, requested: true };

        const raw = res.json.pair ?? res.json.pairs?.[0] ?? null;
        const rate = quoteUsdRate({ quoteMint: pool.quoteMint, priceUsd: raw?.priceUsd, priceNative: raw?.priceNative });
        return {
            rate,
            basis: rate === null
                ? `priceUsd/priceNative unusable (${JSON.stringify(raw?.priceUsd)}/${JSON.stringify(raw?.priceNative)})`
                : `priceUsd ${raw.priceUsd} / priceNative ${raw.priceNative}`,
            requested: true
        };
    }
}

function usd(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
    return `$${Math.round(value).toLocaleString('en-US')}`;
}

function pct(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
    return `${(value * 100).toFixed(1)}%`;
}

/** One pass. Reads the store, fetches within the budget, writes the store and publishes. */
async function runOnce({ rpc, poolCount, budget }) {
    const startedMs = Date.now();
    const startedAt = ts(new Date(startedMs));

    const venues = await readJson(VENUES_PATH);
    if (!Array.isArray(venues?.items)) throw new Error(`${VENUES_PATH}: expected {items:[...]}`);
    const pools = selectPools(venues, poolCount);
    if (pools.length === 0) throw new Error(`${VENUES_PATH} lists no DEX pools; nothing to sample`);
    log(`sampling ${pools.length} pool(s) by 24 h volume from venues.json (fetched ${venues.fetchedAt}): ${pools.map((p) => `${p.symbol ?? p.mint.slice(0, 6)}/${p.quoteSymbol ?? '?'} ${p.dex} ${usd(p.volume24Usd)}`).join(' · ')}`);

    const store = await readJson(STORE_PATH, null);
    const collectingSince = store?.collectingSince ?? startedAt;
    const storedTrades = Array.isArray(store?.trades) ? store.trades : [];
    const storedSeen = Array.isArray(store?.seen) ? store.seen : [];
    if (store === null) log(`no store at ${STORE_PATH} — this is the first run, collectingSince ${collectingSince}`);
    else log(`store: ${storedTrades.length} trade(s) and ${storedSeen.length} known non-trade signature(s), collecting since ${collectingSince}`);

    // --- quote rates, one DexScreener call per SOL-quoted pool ---------------------------------
    const priced = [];
    for (let i = 0; i < pools.length; i += 1) {
        const pool = pools[i];
        const { rate, basis, requested } = await fetchQuoteUsdRate(pool);
        priced.push({ ...pool, quoteUsdRate: rate });
        log(`quote rate ${pool.symbol ?? pool.mint.slice(0, 6)}/${pool.quoteSymbol ?? '?'}: ${rate === null ? 'none' : `$${rate.toFixed(4)} per ${pool.quoteSymbol}`} — ${basis}`);
        if (requested && i < pools.length - 1) await sleep(DEX_PACE_MS);
    }

    // --- signatures per pool ------------------------------------------------------------------
    const known = new Set([...storedTrades.map((t) => t?.sig), ...storedSeen.map((s) => s?.sig)].filter((sig) => typeof sig === 'string'));
    const perPool = new Map();
    const candidates = [];
    let gaveUp = false;
    let rateLimited = 0;
    for (let i = 0; i < priced.length; i += 1) {
        const pool = priced[i];
        const call = await rpcCall(rpc, 'getSignaturesForAddress', [pool.pair, { limit: SIGNATURE_LIMIT }], `signatures ${pool.symbol ?? pool.pair.slice(0, 8)}`);
        rateLimited += call.rateLimited;
        if (call.gaveUp) {
            gaveUp = true;
            break;
        }
        const page = Array.isArray(call.result) ? call.result : [];
        const { ok, failed } = partitionSignatures(page, { pair: pool.pair });
        perPool.set(pool.pair, { signaturesSeen: page.length, failedTx: failed.length, decoded: 0, undecodable: 0 });
        candidates.push(...ok);
        log(`signatures ${pool.symbol ?? pool.pair.slice(0, 8)} (${pool.dex}): ${page.length} seen · ${failed.length} reverted (${pct(page.length === 0 ? null : failed.length / page.length)}) · ${ok.filter((s) => !known.has(s.sig)).length} new to fetch`);
        if (i < priced.length - 1) await sleep(RPC_PACE_MS);
    }
    for (const pool of priced) {
        if (!perPool.has(pool.pair)) perPool.set(pool.pair, { signaturesSeen: 0, failedTx: 0, decoded: 0, undecodable: 0 });
    }

    // --- transactions, oldest first, within the budget ----------------------------------------
    const chosen = gaveUp ? [] : selectSignaturesToFetch(candidates, { now: Date.now(), budget, windowHours: WINDOW_HOURS, known });
    const skippedForBudget = candidates.filter((c) => !known.has(c.sig)).length - chosen.length;
    log(`transactions: ${chosen.length} to fetch of ${candidates.length} successful signature(s) seen${skippedForBudget > 0 ? ` — ${skippedForBudget} left for the next run by the budget of ${budget}` : ''}`);

    const poolByPair = new Map(priced.map((pool) => [pool.pair, pool]));
    const decodedTrades = [];
    const newSeen = [];
    let fetched = 0;
    let missing = 0;
    let extraRequests = 0;
    let versionBumped = 0;

    const flush = async () => {
        const now = Date.now();
        const merged = mergeTrades(storedTrades, decodedTrades, { now, seenAt: ts(new Date(now)), windowHours: WINDOW_HOURS });
        const seen = mergeSeenSignatures(storedSeen, newSeen, { now, windowHours: WINDOW_HOURS });
        const poolRecords = priced.map((pool) => {
            const counts = perPool.get(pool.pair) ?? { signaturesSeen: 0, failedTx: 0, decoded: 0, undecodable: 0 };
            return {
                pair: pool.pair,
                mint: pool.mint,
                symbol: pool.symbol,
                dex: pool.dex,
                quoteMint: pool.quoteMint,
                quoteSymbol: pool.quoteSymbol,
                quoteUsdRate: pool.quoteUsdRate,
                signaturesSeen: counts.signaturesSeen,
                failedTx: counts.failedTx,
                decoded: counts.decoded,
                undecodable: counts.undecodable
            };
        });
        await writeJson(STORE_PATH, {
            collectingSince,
            updatedAt: ts(new Date(now)),
            windowHours: WINDOW_HOURS,
            rpc,
            note: 'rolling store for the live tape. `trades` carries the collector\'s own `seenAt` beside the chain\'s `time` so a transaction with no blockTime can still be aged out; `seen` remembers signatures that were fetched and held no trade, so a later run does not spend its budget on them again. Both are pruned to the window. Published to stocks-trades.json without `seenAt`.',
            lastRun: {
                at: startedAt,
                finishedAt: ts(new Date(now)),
                seconds: Math.round((now - startedMs) / 100) / 10,
                poolsSampled: priced.length,
                poolsRead: [...perPool.values()].filter((c) => c.signaturesSeen > 0).length,
                budget,
                transactionsFetched: fetched,
                decoded: decodedTrades.length,
                undecodable: newSeen.length,
                transactionsMissing: missing,
                versionBumpedRetries: versionBumped,
                extraRequests,
                newTrades: merged.added,
                prunedTrades: merged.pruned,
                skippedForBudget: Math.max(0, skippedForBudget),
                rateLimited,
                gaveUpEarly: gaveUp
            },
            pools: poolRecords,
            trades: merged.trades,
            seen
        });
        const payload = buildPayload({ generatedAt: ts(new Date(now)), collectingSince, pools: poolRecords, trades: merged.trades, now, hours: WINDOW_HOURS });
        await writeJson(PUBLISH_PATH, payload);
        return { merged, payload, poolRecords };
    };

    for (let i = 0; i < chosen.length; i += 1) {
        const candidate = chosen[i];
        const pool = poolByPair.get(candidate.pair) ?? null;
        if (pool === null) continue;
        const call = await fetchTransaction(rpc, candidate.sig, `tx ${candidate.sig.slice(0, 8)}`);
        rateLimited += call.rateLimited;
        extraRequests += call.extraRequests;
        if (call.versionBumped && call.result !== null) versionBumped += 1;
        if (call.gaveUp) {
            gaveUp = true;
            logWarn(`stopping after ${fetched} transaction(s); the remaining ${chosen.length - i} signature(s) are re-selected next run`);
            break;
        }
        fetched += 1;
        const counts = perPool.get(pool.pair);

        if (call.result === null) {
            // Confirmed but not returned by this node even at the version it asked for. Remembered
            // so the budget is not spent on it again, counted against the pool so it cannot pass as
            // a pool with nothing to decode, and given its own reason in the store.
            missing += 1;
            counts.undecodable += 1;
            newSeen.push({ sig: candidate.sig, pair: pool.pair, reason: 'no transaction returned' });
        } else {
            const trade = decodeTrade(call.result, pool, { signature: candidate.sig });
            if (trade === null) {
                counts.undecodable += 1;
                newSeen.push({ sig: candidate.sig, pair: pool.pair, reason: 'pool balances unchanged — mentioned, not traded against' });
            } else {
                counts.decoded += 1;
                decodedTrades.push(trade);
            }
        }

        const done = i + 1;
        if (done % CHECKPOINT_EVERY === 0) {
            await flush();
            log(`transactions: ${done}/${chosen.length} · ${decodedTrades.length} decoded · ${newSeen.length} held no trade · checkpointed`);
        }
        if (done < chosen.length) await sleep(RPC_PACE_MS);
    }

    const { merged, payload, poolRecords } = await flush();
    const seconds = Math.round((Date.now() - startedMs) / 100) / 10;
    const totals = payload.totals;
    log(`run finished in ${seconds}s: ${fetched} transaction(s) fetched · ${decodedTrades.length} decoded · ${newSeen.length} held no trade · ${merged.added} new trade(s) stored · ${merged.pruned} pruned`);
    log(`window now holds ${totals.trades} trade(s) from ${totals.traders} distinct fee payer(s), ${usd(totals.volumeUsd)} of priced volume, failed share ${pct(totals.failedShare)}`);
    for (const record of poolRecords) {
        log(`  ${record.symbol ?? record.mint.slice(0, 6)}/${record.quoteSymbol ?? '?'} ${record.dex}: ${record.signaturesSeen} sig(s) · ${record.failedTx} reverted (${pct(record.signaturesSeen === 0 ? null : record.failedTx / record.signaturesSeen)}) · ${record.decoded} decoded · ${record.undecodable} undecodable · rate ${record.quoteUsdRate === null ? 'none' : `$${record.quoteUsdRate.toFixed(2)}`}`);
    }
    log(`wrote ${STORE_PATH} and ${PUBLISH_PATH}`);
    if (gaveUp) logWarn('the run ended early on a rate limit or an unreachable endpoint; nothing was lost and the next run re-selects the same signatures');

    return { pools: priced.length, poolsRead: [...perPool.values()].filter((c) => c.signaturesSeen > 0).length, fetched, decoded: decodedTrades.length, undecodable: newSeen.length, newTrades: merged.added, totals, gaveUp, seconds };
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }
    const rpc = typeof flags.rpc === 'string' ? flags.rpc : DEFAULT_RPC;
    const poolCount = typeof flags.pools === 'string' ? Number(flags.pools) : DEFAULT_POOLS;
    if (!Number.isFinite(poolCount) || poolCount <= 0) throw new Error(`--pools must be a positive number, got "${flags.pools}"`);
    const budget = typeof flags.budget === 'string' ? Number(flags.budget) : DEFAULT_BUDGET;
    if (!Number.isFinite(budget) || budget < 0) throw new Error(`--budget must be a non-negative number, got "${flags.budget}"`);
    const every = typeof flags.every === 'string' ? Number(flags.every) : null;
    if (every !== null && (!Number.isFinite(every) || every <= 0)) throw new Error(`--every must be a positive number of seconds, got "${flags.every}"`);

    log(`rpc ${rpc} · ${poolCount} pool(s) · budget ${budget} transaction(s)/run${every === null ? ' · single pass' : ` · every ${every}s`}`);
    if (every === null) {
        const result = await runOnce({ rpc, poolCount, budget });
        return result.gaveUp ? 1 : 0;
    }

    // Loop forever. A failed pass is logged and the next one still happens: the store is the
    // checkpoint, so recovery is automatic and a transient RPC failure must not end the collection.
    for (let pass = 1; ; pass += 1) {
        try {
            const result = await runOnce({ rpc, poolCount, budget });
            log(`pass ${pass}: pools ${result.poolsRead}/${result.pools} · ${result.newTrades} new trade(s) · failed share ${pct(result.totals.failedShare)} · next run in ${every}s`);
        } catch (err) {
            logError(`pass ${pass} failed: ${err.stack ?? String(err)}`);
            log(`pass ${pass}: failed · next run in ${every}s`);
        }
        await sleep(every * 1000);
    }
}

main().then((code) => process.exit(code), (err) => {
    logError(err.stack ?? String(err));
    process.exit(1);
});
