#!/usr/bin/env node
// Reads what METEORA'S OWN keyless APIs say about the 22 Meteora pools that hold tokenized stocks,
// which is strictly more than DexScreener reports for the same pools: the pool TYPE (DLMM, DAMM v1,
// DAMM v2 or Dynamic Bonding Curve), the DLMM bin step, the configured base/max fee tiers, the
// dynamic fee actually in force, 24 h FEES as well as 24 h volume, TVL, the pool's own price, and a
// bonding-curve pool's config. DexScreener reports one dexId — `meteora` — for DLMM and both DAMM
// versions, so "which kind of pool is this" is not answerable from it at all.
//
// Writes stocks/data/meteora.json. Every response is checkpointed to
// stocks/data/raw/meteora-checkpoint-<date>.json, so a killed run resumes the same day instead of
// re-probing; a pool whose probe ERRORED is retried on the next run, a terminal answer is not.
//
// The pool address is probed against one endpoint per product until one answers. Two attempts per
// endpoint (backoff on 429/5xx/network), then the pool is recorded with an error and the run moves
// on — nothing loops forever, and the whole run is capped at 150 s.

import { join } from 'node:path';
import { fetchJson, isoDate, log, logError, logWarn, parseArgs, readJson, sleep, ts, writeJson } from './lib/io.mjs';
import { readEnvFile } from './lib/env.mjs';
import {
    DBC_PROGRAM_ID,
    METEORA_ENDPOINTS,
    endpointOrder,
    selectMeteoraPools,
    shapeDammPool,
    shapeDbcPool,
    shapeDlmmPair
} from './lib/meteora.mjs';

const HERE = import.meta.dirname;
const VENUES_PATH = join(HERE, 'data', 'venues.json');
const OUT_PATH = join(HERE, 'data', 'meteora.json');
const RAW_DIR = join(HERE, 'data', 'raw');
const ENV_PATH = join(HERE, '..', '.env');
const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';

// One probe every 150 ms. damm-api sends x-ratelimit-limit: 100 (per minute, observed 2026-09-16),
// and the datapi hosts advertise 10 req/s, so this is inside both with room to spare.
const PACE_MS = 150;
const BACKOFF_MS = [1000, 3000];
// Attempts per endpoint, not per pool: a 404 is a definitive "not this kind of pool" and is never
// retried, so the ladder only ever runs on a rate limit, a 5xx or a network failure.
const ATTEMPTS = 2;
// Whole-run ceiling. 22 pools × 4 possible endpoints at 150 ms is ~30 s, so this only ever fires
// when a host has started to time out; the pools not reached are recorded with an error and the
// next run picks them up from the checkpoint.
const RUN_BUDGET_MS = 150000;

function usage() {
    console.log(`fetch-meteora.mjs — Meteora's own view of the tokenized-stock pools it hosts

USAGE
  node stocks/fetch-meteora.mjs --run [options]

OPTIONS
  --run                 Actually fetch. Without it this help is printed and nothing runs.
  --fresh               Ignore today's checkpoint and re-probe every pool.
  --rpc=<url>           Solana JSON-RPC endpoint for the one DBC account read
                        (default: SOLANA_RPC_URL from ../.env, else ${DEFAULT_RPC}).
  --help                This text.

INPUTS
  stocks/data/venues.json       every DEX pair per mint; the pools with dexId meteora/meteoradbc

OUTPUTS
  stocks/data/meteora.json      one record per Meteora pool: poolType, endpoint, binStep,
                                baseFeePct, maxFeePct, fees24Usd, volume24Usd, liquidityUsd,
                                priceUsd, the DexScreener figures beside them, and curve for a DBC pool
  stocks/data/raw/meteora-checkpoint-<date>.json   the raw response per pair, for the day

NOTES
  Keyless. The endpoints are ${Object.keys(METEORA_ENDPOINTS).join(', ')}, probed in that order per
  pool (a meteoradbc pair starts at dbc), one per product, and the first that answers 200 wins.
  The *-api.meteora.ag hosts named in every older guide (dlmm-api, dammv2-api, dbc-api) answer 404
  on every path including their own roots, measured 2026-09-16; the live data API is
  <product>.datapi.meteora.ag/pools/<address>. Its collection routes IGNORE ?address= and return
  page 1 of all 127k pools, so only the per-address route is used.
  A wrong-kind address answers 404 with {"message":"Pool not found: …"} — that is "not this product",
  not a failure, and the probe moves to the next endpoint without retrying.
  DAMM v1 is the exception: legacy damm-api.meteora.ag/pools needs address AND page and answers 200
  with an ARRAY, empty when the address is not one of its pools.
  The DBC endpoint returns IDENTITY AND CONFIG ONLY — no migration threshold, no curve progress, no
  migrated flag (the /curve, /metrics, /ohlcv and pool-config routes are all 404). So a DBC pool's
  trading figures stay null rather than reading as zero, and curve.curveState is explicitly null
  with one getAccountInfo recorded beside it: the account exists, its owner program and its data
  length. The 424-byte layout is NOT decoded — guessed offsets would produce authoritative-looking
  numbers that are not measurements.
  maxFeePct is passed through verbatim and reads 0 on every DLMM pool here while baseFeePct is
  0.01–10 (2026-09-16). A cap below the base fee is impossible, so that 0 is the source not
  populating the field; it is left as the source's own value rather than a null we invented.`);
}

/**
 * One GET with the retry ladder. `{status, json, ok, gaveUp}` — a 404 returns immediately (it is an
 * answer: this address is not this product's pool), a 429/5xx/network failure is retried.
 */
async function getWithRetry(url, label) {
    for (let attempt = 0; ; attempt += 1) {
        let res = null;
        try {
            res = await fetchJson(url, { headers: { accept: 'application/json' }, timeoutMs: 30000 });
        } catch (err) {
            if (attempt >= ATTEMPTS - 1) return { status: null, json: null, ok: false, gaveUp: true, error: `${err.name}: ${err.message}` };
            logWarn(`${label}: ${err.name}: ${err.message}, retrying in ${BACKOFF_MS[attempt]} ms`);
            await sleep(BACKOFF_MS[attempt]);
            continue;
        }
        if ((res.status === 429 || res.status >= 500) && attempt < ATTEMPTS - 1) {
            logWarn(`${label}: HTTP ${res.status}, retrying in ${BACKOFF_MS[attempt]} ms`);
            await sleep(BACKOFF_MS[attempt]);
            continue;
        }
        if (res.status === 429 || res.status >= 500) {
            return { status: res.status, json: null, ok: false, gaveUp: true, error: `HTTP ${res.status} after ${ATTEMPTS} attempts` };
        }
        if (res.ok && res.json === null) {
            return { status: res.status, json: null, ok: false, gaveUp: false, error: `unparseable body: ${res.parseError} :: ${res.bodyPreview}` };
        }
        return { status: res.status, json: res.json, ok: res.ok, gaveUp: false, error: null };
    }
}

/**
 * Probe one pool across the endpoints its dexId suggests. Returns the first 200 plus which endpoint
 * answered, or `{hit: null}` with every status seen, so "nothing knows this pool" is distinguishable
 * from "every host was rate-limiting".
 */
async function probePool(pool) {
    const tried = [];
    for (const kind of endpointOrder(pool.dexId)) {
        const url = METEORA_ENDPOINTS[kind](pool.pairAddress);
        const label = `${kind} ${pool.symbol ?? pool.pairAddress.slice(0, 8)}`;
        const res = await getWithRetry(url, label);
        await sleep(PACE_MS);
        if (res.ok) {
            // damm-v1's legacy route answers 200 with an array — empty means "not one of ours".
            const body = kind === 'damm-v1' ? (Array.isArray(res.json) ? res.json[0] ?? null : null) : res.json;
            if (body !== null && typeof body === 'object') {
                tried.push({ kind, url, status: res.status, outcome: 'hit' });
                return { hit: { kind, url, body }, tried, error: null };
            }
            tried.push({ kind, url, status: res.status, outcome: 'empty' });
            continue;
        }
        tried.push({ kind, url, status: res.status, outcome: res.gaveUp ? 'gave-up' : 'miss', error: res.error });
        if (res.gaveUp) return { hit: null, tried, error: `${kind}: ${res.error}` };
    }
    return { hit: null, tried, error: null };
}

/**
 * The DBC pool account, read ONCE: does it exist, which program owns it, how long is its data.
 *
 * That is the whole of it deliberately. The owner tells a live bonding-curve pool from one whose
 * account has been closed, and the data length is the evidence for why the layout is not decoded
 * here: 424 bytes of unknown field order would yield a migration threshold that looks like a
 * measurement and is a guess.
 */
async function readDbcAccount(rpc, pair) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [pair, { encoding: 'base64' }] });
    let res = null;
    try {
        res = await fetchJson(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body, timeoutMs: 30000 });
    } catch (err) {
        return { account: null, error: `getAccountInfo: ${err.name}: ${err.message}` };
    }
    if (!res.ok || res.json === null) return { account: null, error: `getAccountInfo: HTTP ${res.status} :: ${res.bodyPreview}` };
    if (res.json.error) return { account: null, error: `getAccountInfo: RPC error ${res.json.error.code}: ${res.json.error.message}` };
    const value = res.json.result?.value ?? null;
    if (value === null) return { account: { exists: false, owner: null, dataLength: null, lamports: null, isDbcProgram: false }, error: null };
    const owner = typeof value.owner === 'string' ? value.owner : null;
    return {
        account: {
            exists: true,
            owner,
            dataLength: typeof value.space === 'number' ? value.space : null,
            lamports: typeof value.lamports === 'number' ? value.lamports : null,
            isDbcProgram: owner === DBC_PROGRAM_ID
        },
        error: null
    };
}

const DBC_NOTE = 'dbc.datapi.meteora.ag reports identity and pool_config only — no migration threshold, no curve progress, no migrated flag (its /curve, /metrics, /ohlcv and pool-config routes are 404). curveState is null: the pool account layout was NOT decoded, only its existence, owner program and data length were read.';

function usd(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
    return `$${Math.round(value).toLocaleString('en-US')}`;
}

async function run({ rpc, fresh }) {
    const startedMs = Date.now();
    const venues = await readJson(VENUES_PATH);
    if (!Array.isArray(venues?.items)) throw new Error(`${VENUES_PATH}: expected {items:[...]}`);
    const pools = selectMeteoraPools(venues.items);
    if (pools.length === 0) throw new Error(`${VENUES_PATH} lists no Meteora pools; nothing to probe`);
    log(`${pools.length} Meteora pool(s) in venues.json (fetched ${venues.fetchedAt}): ${pools.filter((p) => p.dexId === 'meteora').length} meteora, ${pools.filter((p) => p.dexId === 'meteoradbc').length} meteoradbc`);

    const checkpointPath = join(RAW_DIR, `meteora-checkpoint-${isoDate()}.json`);
    const checkpoint = fresh ? { pairs: {} } : (await readJson(checkpointPath, { pairs: {} }));
    if (!checkpoint.pairs || typeof checkpoint.pairs !== 'object') checkpoint.pairs = {};
    const reused = Object.values(checkpoint.pairs).filter((entry) => entry?.status === 'hit' || entry?.status === 'none').length;
    if (reused > 0) log(`checkpoint ${checkpointPath}: reusing ${reused} terminal answer(s) from today; errors are re-probed`);

    const items = [];
    let probed = 0;
    let budgetStopped = 0;
    for (const pool of pools) {
        const cached = checkpoint.pairs[pool.pairAddress];
        const terminal = cached?.status === 'hit' || cached?.status === 'none';
        let hit = terminal && cached.status === 'hit' ? { kind: cached.kind, url: cached.url, body: cached.body } : null;
        let error = terminal ? (cached.error ?? null) : null;
        let tried = terminal ? (cached.tried ?? []) : [];

        if (!terminal) {
            if (Date.now() - startedMs > RUN_BUDGET_MS) {
                budgetStopped += 1;
                items.push(emptyItem(pool, `run budget of ${RUN_BUDGET_MS / 1000}s exhausted before this pool was probed`));
                continue;
            }
            const result = await probePool(pool);
            probed += 1;
            hit = result.hit;
            error = result.error;
            tried = result.tried;
            checkpoint.pairs[pool.pairAddress] = {
                status: hit !== null ? 'hit' : (error === null ? 'none' : 'error'),
                kind: hit?.kind ?? null,
                url: hit?.url ?? null,
                body: hit?.body ?? null,
                tried,
                error,
                fetchedAt: ts()
            };
            await writeJson(checkpointPath, {
                fetchedAt: ts(),
                note: 'raw Meteora API response per pool address. status hit/none is reused for the rest of the day; an "error" entry is re-probed on the next run.',
                pairs: checkpoint.pairs
            });
        }

        if (hit === null) {
            items.push(emptyItem(pool, error ?? `no Meteora endpoint claims this pool (tried ${tried.map((t) => `${t.kind} ${t.status ?? 'network'}`).join(', ')})`));
            log(`  ${pool.symbol ?? pool.mint.slice(0, 6)} ${pool.pairAddress.slice(0, 8)}: no endpoint answered${error === null ? '' : ` — ${error}`}`);
            continue;
        }

        let shaped = null;
        let itemError = null;
        if (hit.kind === 'dlmm') shaped = shapeDlmmPair(hit.body, { mint: pool.mint });
        else if (hit.kind === 'damm-v2' || hit.kind === 'damm-v1') shaped = shapeDammPool(hit.body, { mint: pool.mint });
        else if (hit.kind === 'dbc') {
            const { account, error: rpcError } = await readDbcAccount(rpc, pool.pairAddress);
            itemError = rpcError;
            shaped = shapeDbcPool(hit.body, { account, note: DBC_NOTE });
            if (account !== null) {
                log(`  ${pool.symbol ?? pool.mint.slice(0, 6)} DBC account: exists=${account.exists} owner=${account.owner ?? 'none'}${account.isDbcProgram ? ' (DBC program)' : ''} data=${account.dataLength ?? 'n/a'} bytes — curve state not decoded`);
            }
        }
        if (shaped === null) {
            items.push(emptyItem(pool, `${hit.kind} answered but the body could not be shaped (no pool address in it)`));
            continue;
        }

        items.push({
            mint: pool.mint,
            symbol: pool.symbol,
            issuer: pool.issuer,
            pairAddress: pool.pairAddress,
            dexId: pool.dexId,
            poolType: shaped.poolType,
            endpoint: hit.url,
            poolName: shaped.poolName,
            binStep: shaped.binStep,
            baseFeePct: shaped.baseFeePct,
            maxFeePct: shaped.maxFeePct,
            protocolFeePct: shaped.protocolFeePct,
            dynamicFeePct: shaped.dynamicFeePct,
            fees24Usd: shaped.fees24Usd,
            volume24Usd: shaped.volume24Usd,
            liquidityUsd: shaped.liquidityUsd,
            priceUsd: shaped.priceUsd,
            priceQuote: shaped.priceQuote,
            quoteSymbol: shaped.quoteSymbol ?? pool.quoteSymbol,
            quoteMint: shaped.quoteMint,
            feeTvlRatio24: shaped.feeTvlRatio24,
            apr: shaped.apr,
            apy: shaped.apy,
            cumulativeVolumeUsd: shaped.cumulativeVolumeUsd,
            cumulativeFeesUsd: shaped.cumulativeFeesUsd,
            createdAtMs: shaped.createdAtMs,
            holders: shaped.holders,
            launchpad: shaped.launchpad,
            isBlacklisted: shaped.isBlacklisted,
            dexscreener: pool.dexscreener,
            curve: shaped.curve,
            fetchedAt: ts(),
            error: itemError
        });
        log(`  ${(pool.symbol ?? pool.mint.slice(0, 6)).padEnd(11)} ${shaped.poolType.padEnd(7)} ${hit.kind === 'dbc' ? 'no trading figures (identity only)' : `bin ${shaped.binStep ?? '-'} · base fee ${shaped.baseFeePct ?? '-'}% · dyn ${shaped.dynamicFeePct ?? '-'}% · TVL ${usd(shaped.liquidityUsd)} · 24 h vol ${usd(shaped.volume24Usd)} · 24 h fees ${usd(shaped.fees24Usd)}`}`);
    }

    const byType = items.reduce((acc, item) => {
        const key = item.poolType ?? 'unresolved';
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
    }, {});

    await writeJson(OUT_PATH, {
        fetchedAt: ts(),
        source: 'dlmm.datapi.meteora.ag, damm-v2.datapi.meteora.ag, dbc.datapi.meteora.ag (per-address routes) and legacy damm-api.meteora.ag/pools for DAMM v1 — all keyless',
        note: `One record per Meteora pool in venues.json, probed endpoint by endpoint until one answered; "endpoint" is the URL that did. Facts here that DexScreener does not report: poolType (its single "meteora" dexId covers DLMM and both DAMM versions), binStep, baseFeePct/maxFeePct/protocolFeePct, the dynamic fee in force, 24 h FEES, TVL and APR. maxFeePct is verbatim and reads 0 on every DLMM pool while baseFeePct is 0.01-10 — a cap below the base fee is impossible, so that 0 is the source not populating the field. A DBC pool's endpoint returns identity and config only: no migration threshold, progress or migrated flag exists on the host, so every trading figure stays null and curve.curveState is null with one getAccountInfo (existence, owner program, data length) recorded beside it; the 424-byte layout was not decoded. dexscreener holds the same pool's figures from venues.json so the two sources can be compared instead of one replacing the other.`,
        pools: items.length,
        byType,
        items
    });

    const seconds = Math.round((Date.now() - startedMs) / 100) / 10;
    log(`wrote ${OUT_PATH}: ${items.length} pool(s) in ${seconds}s — ${Object.entries(byType).map(([k, v]) => `${v} ${k}`).join(', ')} (${probed} probed, ${items.length - probed} from the checkpoint)`);
    if (budgetStopped > 0) logWarn(`${budgetStopped} pool(s) were not probed: the ${RUN_BUDGET_MS / 1000}s run budget ran out. Nothing is lost — the next run starts with them.`);
    const errors = items.filter((item) => item.error !== null);
    if (errors.length > 0) logWarn(`${errors.length} pool(s) carry an error: ${errors.map((e) => `${e.symbol ?? e.pairAddress.slice(0, 8)} (${e.error})`).join(' · ')}`);
    return { pools: items.length, byType, errors: errors.length };
}

/** A pool nothing answered for. Every figure null: an unprobed pool must not read as an empty one. */
function emptyItem(pool, error) {
    return {
        mint: pool.mint,
        symbol: pool.symbol,
        issuer: pool.issuer,
        pairAddress: pool.pairAddress,
        dexId: pool.dexId,
        poolType: null,
        endpoint: null,
        poolName: null,
        binStep: null,
        baseFeePct: null,
        maxFeePct: null,
        protocolFeePct: null,
        dynamicFeePct: null,
        fees24Usd: null,
        volume24Usd: null,
        liquidityUsd: null,
        priceUsd: null,
        priceQuote: null,
        quoteSymbol: pool.quoteSymbol,
        quoteMint: null,
        feeTvlRatio24: null,
        apr: null,
        apy: null,
        cumulativeVolumeUsd: null,
        cumulativeFeesUsd: null,
        createdAtMs: null,
        holders: null,
        launchpad: null,
        isBlacklisted: null,
        dexscreener: pool.dexscreener,
        curve: null,
        fetchedAt: ts(),
        error
    };
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }
    const env = await readEnvFile(ENV_PATH);
    const envRpc = typeof env.SOLANA_RPC_URL === 'string' && env.SOLANA_RPC_URL !== '' ? env.SOLANA_RPC_URL : null;
    const rpc = typeof flags.rpc === 'string' ? flags.rpc : (envRpc ?? DEFAULT_RPC);
    // Log the host only: a keyed endpoint carries its secret in the path.
    log(`rpc: ${new URL(rpc).host}${rpc === DEFAULT_RPC ? ' (public, throttled)' : ' (keyed)'} — used only for the one DBC account read`);
    const result = await run({ rpc, fresh: flags.fresh === true });
    return result.errors > 0 ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => {
    logError(err.stack ?? String(err));
    process.exit(1);
});
