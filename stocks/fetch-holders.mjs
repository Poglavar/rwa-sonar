#!/usr/bin/env node
// Answers "who actually holds this token?" for every tokenized stock in data/universe.json, from
// the chain rather than from an aggregator. Three phases, all in ONE run: getMultipleAccounts on
// the 441 MINT addresses reads each mint's current supply and decimals (the share denominator),
// getTokenLargestAccounts gives the up-to-20 biggest token accounts per mint, then one
// getMultipleAccounts per batch of 100 of those accounts turns each into the WALLET behind it
// (`owner`) and whether the issuer has it frozen (`state`). Token accounts are not holders — one
// wallet can hold several, which is why the owners are deduped — and the concentration figures are
// computed from RAW base units on both sides so a Token-2022 scaled-UI multiplier (200 of the 441
// mints carry one) cancels instead of inflating every share.
//
// The supply is read HERE rather than taken from data/onchain.json because supply moves: the
// 2026-09-16 run divided fresh balances by an 8-hour-old supply and 66 of 441 mints came out with a
// top-20 share above 100% (CRCLon 3,483%). onchain.json is now read for the authority LABELS only.
// Writes stocks/data/holders.json; lib/holders.mjs (pure) does all the arithmetic.

import { join, relative } from 'node:path';
import { byString, fetchJson, isoDate, log, logError, logWarn, parseArgs, readJson, sleep, ts, writeJson } from './lib/io.mjs';
import { readEnvFile } from './lib/env.mjs';
import { buildOwnerLabels, finiteOrNull, median, mintAuthorityAddresses, mintSupplyInfo, summariseMint, tokenAccountInfo } from './lib/holders.mjs';

const HERE = import.meta.dirname;
const UNIVERSE_PATH = join(HERE, 'data', 'universe.json');
const ONCHAIN_PATH = join(HERE, 'data', 'onchain.json');
const DEFAULT_OUT = join(HERE, 'data', 'holders.json');
const RAW_DIR = join(HERE, 'data', 'raw');
const ENV_PATH = join(HERE, '..', '.env');

const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
const MAX_ACCOUNTS_PER_REQUEST = 100;

// The keyed RPC (Alchemy free tier) bills compute units per second rather than requests, and the
// detached trade collector is usually spending from the same budget — two 429s arrived during a
// three-request probe on 2026-09-16. So the pace floor is 350 ms, every 429 DOUBLES the pace up to
// a 3 s ceiling and the run never speeds back up, and a 429 is never fatal: the ladder below is
// retried, and an item that still fails is left for the next run instead of ending this one.
const RPC_PACE_MS = 350;
const RPC_PACE_MAX_MS = 3000;
const RPC_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];

// 441 mints + ~89 account batches, each checkpointed, so a kill costs at most one request.
const LOG_EVERY = 25;
const LIQUID_USD = 50000;

function usage() {
    console.log(`fetch-holders.mjs — top-20 token accounts, their wallets and supply concentration per mint

USAGE
  node stocks/fetch-holders.mjs --run [options]

OPTIONS
  --run                 Actually fetch. Without it this help is printed and nothing runs.
  --max=<n>             Process only the first n tokens by mint. For smoke tests.
  --force               Ignore today's checkpoint and re-fetch everything.
  --rpc=<url>           Solana JSON-RPC endpoint (default: SOLANA_RPC_URL from ../.env, else the public one).
  --pace=<ms>           Spacing between RPC calls (default ${RPC_PACE_MS}; the floor, not a suggestion).
  --out=<path>          Output file (default stocks/data/holders.json).
  --help                This text.

INPUTS
  stocks/data/universe.json     the 441 mints, their symbol, issuer and liquidity
  stocks/data/onchain.json      the authority addresses that become "issuer-authority" owner
                                labels. NOT the supply: that is read live, below.

OUTPUT
  stocks/data/holders.json      { fetchedAt, source, items[] } sorted by mint

NOTES
  Three phases, ~${5 + 441 + 89} requests for a full run: getMultipleAccounts with
  {encoding:'jsonParsed'} over the ${MAX_ACCOUNTS_PER_REQUEST}-mint batches of MINT addresses for
  each mint's CURRENT supply and decimals, then getTokenLargestAccounts once per mint (up to 20
  accounts each), then getMultipleAccounts again in batches of ${MAX_ACCOUNTS_PER_REQUEST} token
  accounts to read each account's owner and frozen/initialized state. The supply is fetched in the
  same run as the balances it is the denominator of — onchain.json's supply is hours old and using
  it put 66 of 441 mints above a 100% top-20 share on 2026-09-16.
  Paced ${RPC_PACE_MS} ms apart with backoff ${RPC_BACKOFF_MS.map((ms) => ms / 1000).join('/')} s on 429 or 5xx; every 429 doubles the pace
  (ceiling ${RPC_PACE_MAX_MS} ms) and none of them fails the run. The RPC key is read from ../.env and only its
  HOST is ever logged.
  Every response is checkpointed per mint (supply) or per batch to
  stocks/data/raw/holders-checkpoint-<date>.json, so a killed run resumes the same day and
  re-fetches only what is missing. That file is shared, so do not run two instances at once.
  supplyUi and amountUi are RAW base units / 10^decimals. The Token-2022 scaled-UI multiplier is
  deliberately NOT applied: the RPC applies it to uiAmount but not to supply, and it accrues over
  time, so mixing the two would overstate every share. Multiply by onchain.json's
  scaledUiAmountMultiplier yourself if you want the issuer-displayed share count.
  A mint with supply 0 (24 of the 441) reports null shares, never 0 — see lib/holders.mjs.`);
}

/** Set in main() from ../.env. The URL itself is never logged, only `new URL(rpc).host`. */
let rpc = DEFAULT_RPC;
let rpcPaceMs = RPC_PACE_MS;
let rateLimited = 0;
let requestCount = 0;

/**
 * One JSON-RPC call, retried on 429/5xx/socket error up the backoff ladder. Returns
 * `{result, error}`; `error` is a string when the call could not be completed, so a caller records
 * it and moves on — a 429 storm must cost items on this run, never the run.
 */
async function rpcCall(method, params, label) {
    for (let attempt = 0; ; attempt += 1) {
        let res = null;
        requestCount += 1;
        try {
            res = await fetchJson(rpc, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
                timeoutMs: 60000
            });
        } catch (err) {
            if (attempt >= RPC_BACKOFF_MS.length) {
                logWarn(`${label}: ${err.name}: ${err.message} — giving up for this run`);
                return { result: null, error: `${err.name}: ${err.message}` };
            }
            logWarn(`${label}: ${err.name}: ${err.message}, retrying in ${RPC_BACKOFF_MS[attempt]} ms`);
            await sleep(RPC_BACKOFF_MS[attempt]);
            continue;
        }

        if (res.status === 429 || res.status >= 500) {
            if (res.status === 429) {
                rateLimited += 1;
                if (rpcPaceMs < RPC_PACE_MAX_MS) {
                    rpcPaceMs = Math.min(rpcPaceMs * 2, RPC_PACE_MAX_MS);
                    logWarn(`rpc: slowing to ${rpcPaceMs} ms between calls after ${rateLimited} rate limit(s)`);
                }
            }
            if (attempt >= RPC_BACKOFF_MS.length) {
                logWarn(`${label}: HTTP ${res.status} after ${RPC_BACKOFF_MS.length} retries — leaving it for the next run`);
                return { result: null, error: `HTTP ${res.status} after ${RPC_BACKOFF_MS.length} retries` };
            }
            logWarn(`${label}: HTTP ${res.status}, retrying in ${RPC_BACKOFF_MS[attempt]} ms`);
            await sleep(RPC_BACKOFF_MS[attempt]);
            continue;
        }

        // An empty 200 body happens on this endpoint under load; it is a retryable non-answer, not
        // a mint with no holders, so it must never be recorded as an empty result.
        if (res.ok && res.json === null) {
            if (attempt >= RPC_BACKOFF_MS.length) {
                logWarn(`${label}: unparseable body after ${RPC_BACKOFF_MS.length} retries :: ${res.parseError}`);
                return { result: null, error: `unparseable body: ${res.parseError}` };
            }
            logWarn(`${label}: unparseable body (${res.bytes} bytes), retrying in ${RPC_BACKOFF_MS[attempt]} ms`);
            await sleep(RPC_BACKOFF_MS[attempt]);
            continue;
        }
        if (!res.ok) return { result: null, error: `HTTP ${res.status}: ${res.bodyPreview}` };
        if (res.json.error) return { result: null, error: `RPC error ${res.json.error.code}: ${res.json.error.message}` };
        return { result: res.json.result ?? null, error: null };
    }
}

/**
 * The supply phase's own slice of the checkpoint: `mint → {fetchedAt, supply, decimals,
 * authorities}`. It is kept OUTSIDE `mints` so it resumes independently of the other two phases —
 * a mint whose largest-accounts call failed must not cost its supply read again, and vice versa.
 * A mint with `supply: null` was read and had no mint account; a mint that is absent was not read.
 */
function loadSupplies(existing) {
    const supplies = {};
    for (const [mint, entry] of Object.entries(existing?.supplies ?? {})) {
        if (entry === null || typeof entry !== 'object') continue;
        supplies[mint] = {
            fetchedAt: entry.fetchedAt ?? null,
            supply: typeof entry.supply === 'string' ? entry.supply : null,
            decimals: Number.isInteger(entry.decimals) ? entry.decimals : null,
            authorities: Array.isArray(entry.authorities) ? entry.authorities.filter((a) => typeof a === 'string') : []
        };
    }
    return supplies;
}

/**
 * The checkpoint holds, per mint, the raw getTokenLargestAccounts value plus the owner/state read
 * back for each of its token accounts. The two phases resume INDEPENDENTLY: a terminal
 * getTokenLargestAccounts (`ok`/`empty`) is reused for the rest of the day whatever happened to
 * phase 2, and phase 2 then re-requests only the addresses that still have no answer. Keying the
 * reuse on both phases together would make a phase-2 failure cost all 441 phase-1 requests again.
 * A `largest.status` of `error` is re-fetched, and so is a partial `accounts.value`.
 */
function loadCheckpoint(existing) {
    const mints = {};
    for (const [mint, entry] of Object.entries(existing?.mints ?? {})) {
        if (entry?.largest?.status !== 'ok' && entry?.largest?.status !== 'empty') continue;
        const accounts = entry.accounts?.value !== undefined && entry.accounts.value !== null
            ? { status: entry.accounts.status ?? 'pending', value: entry.accounts.value }
            : undefined;
        mints[mint] = accounts === undefined ? { largest: entry.largest } : { largest: entry.largest, accounts };
    }
    return mints;
}

async function flushCheckpoint(path, state) {
    await writeJson(path, {
        fetchedAt: state.startedAt,
        updatedAt: ts(),
        note: 'supplies: the mint account\'s own supply/decimals/authority keys, read live, one entry per mint. mints: the raw getTokenLargestAccounts value and the owner/state read back for each of its token accounts. All three phases resume independently; a mint is reused for the rest of the day only when its phase is terminal (supply present, largest ok/empty, accounts ok/none), and an "error" in any of them is re-fetched on the next run.',
        rpcHost: state.rpcHost,
        supplyFetchedAt: state.supplyFetchedAt,
        supplies: state.supplies,
        mints: state.mints
    }, 0);
}

function etaSeconds(startedMs, done, total) {
    if (done === 0) return null;
    return Math.round(((Date.now() - startedMs) / done) * (total - done) / 1000);
}

/**
 * Phase 0, and it runs FIRST because everything after it is measured against what it reads: ONE
 * getMultipleAccounts({encoding:'jsonParsed'}) per batch of up to 100 MINT addresses, for each
 * mint's current `supply` and `decimals` — the denominator of every share in the output — plus the
 * authority keys the mint account names, which no field of onchain.json carries.
 *
 * A mint the RPC answers null for, or answers with something that is not a parsed mint account, is
 * recorded as read-with-no-supply (null, not 0) so its shares come out null rather than invented.
 */
async function fetchMintSupplies(mints, state, checkpointPath) {
    const todo = mints.filter((mint) => state.supplies[mint] === undefined);
    const reused = mints.length - todo.length;
    if (reused > 0) log(`mint-supply: reusing ${reused} checkpointed mint supply(ies)`);
    if (todo.length === 0) return { errors: [], batches: 0 };

    const batches = [];
    for (let i = 0; i < todo.length; i += MAX_ACCOUNTS_PER_REQUEST) batches.push(todo.slice(i, i + MAX_ACCOUNTS_PER_REQUEST));
    log(`mint-supply: reading supply + decimals for ${todo.length} mint(s) in ${batches.length} batch(es) of ≤${MAX_ACCOUNTS_PER_REQUEST}, ${rpcPaceMs} ms apart`);
    if (state.supplyFetchedAt === null) state.supplyFetchedAt = ts();

    const failed = [];
    for (let i = 0; i < batches.length; i += 1) {
        const batch = batches[i];
        const { result, error } = await rpcCall('getMultipleAccounts', [batch, { encoding: 'jsonParsed' }], `mint-supply batch ${i + 1}`);

        if (error !== null || !Array.isArray(result?.value) || result.value.length !== batch.length) {
            const why = error ?? `expected ${batch.length} accounts, got ${result?.value?.length}`;
            logWarn(`mint-supply batch ${i + 1}/${batches.length}: ${why} — ${batch.length} mint(s) left for the next run`);
            failed.push(...batch);
        } else {
            // One timestamp per RPC call, which IS the read time of all 100 mints in it.
            const fetchedAt = ts();
            for (let j = 0; j < batch.length; j += 1) {
                const info = mintSupplyInfo(result.value[j]);
                if (info === null) logWarn(`mint-supply ${batch[j].slice(0, 8)}: no parsed mint account — its shares will be null, not 0`);
                state.supplies[batch[j]] = {
                    fetchedAt,
                    supply: info?.supply ?? null,
                    decimals: info?.decimals ?? null,
                    authorities: mintAuthorityAddresses(result.value[j])
                };
            }
        }

        await flushCheckpoint(checkpointPath, state);
        const done = i + 1;
        const withSupply = Object.values(state.supplies).filter((s) => s.supply !== null).length;
        log(`mint-supply: batch ${done}/${batches.length} · ${withSupply} mint(s) with a live supply · ${rateLimited} 429(s) · pace ${rpcPaceMs} ms`);
        if (done < batches.length) await sleep(rpcPaceMs);
    }
    return { errors: failed.sort(byString), batches: batches.length };
}

/** Phase 1: the up-to-20 biggest token accounts of every mint not already checkpointed. */
async function fetchLargestAccounts(mints, state, checkpointPath) {
    const todo = mints.filter((mint) => state.mints[mint]?.largest === undefined);
    const reused = mints.length - todo.length;
    if (reused > 0) log(`largest-accounts: reusing ${reused} checkpointed mint(s)`);
    if (todo.length === 0) return { errors: [] };

    log(`largest-accounts: querying ${todo.length} mint(s), ${rpcPaceMs} ms apart (~${Math.ceil(todo.length * rpcPaceMs / 1000)} s if never rate limited)`);
    const startedMs = Date.now();
    const errors = [];
    for (let i = 0; i < todo.length; i += 1) {
        const mint = todo[i];
        const { result, error } = await rpcCall('getTokenLargestAccounts', [mint], `largest ${mint.slice(0, 8)}`);
        const entry = state.mints[mint] ?? {};

        if (error !== null) {
            entry.largest = { fetchedAt: ts(), status: 'error', error, value: [] };
            errors.push(mint);
        } else if (!Array.isArray(result?.value)) {
            entry.largest = { fetchedAt: ts(), status: 'error', error: 'expected {value:[...]}', value: [] };
            errors.push(mint);
            logWarn(`largest ${mint.slice(0, 8)}: expected {value:[...]}`);
        } else {
            entry.largest = {
                fetchedAt: ts(),
                status: result.value.length === 0 ? 'empty' : 'ok',
                slot: finiteOrNull(result.context?.slot),
                value: result.value
            };
            if (result.value.length === 0) entry.accounts = { status: 'none', value: {} };
        }
        state.mints[mint] = entry;

        const done = i + 1;
        await flushCheckpoint(checkpointPath, state);
        if (done % LOG_EVERY === 0 || done === todo.length) {
            const accounts = Object.values(state.mints).reduce((sum, e) => sum + (e.largest?.value?.length ?? 0), 0);
            log(`largest-accounts: ${done}/${todo.length} · ${accounts} token account(s) found · ${rateLimited} 429(s) · ${errors.length} error(s) · pace ${rpcPaceMs} ms · ETA ${etaSeconds(startedMs, done, todo.length)}s`);
        }
        if (done < todo.length) await sleep(rpcPaceMs);
    }
    return { errors };
}

/**
 * Phase 2: ONE getMultipleAccounts per batch of up to 100 token accounts. A batch spans several
 * mints (20 accounts each), so results are written back per address and a mint is only marked done
 * once every one of its addresses has an answer — a null account IS an answer (closed account).
 */
async function fetchAccountOwners(mints, state, checkpointPath) {
    const pending = [];
    for (const mint of mints) {
        const entry = state.mints[mint];
        if (entry?.accounts?.status === 'ok' || entry?.accounts?.status === 'none') continue;
        const addresses = (entry?.largest?.value ?? []).map((v) => v?.address).filter((a) => typeof a === 'string' && a !== '');
        if (addresses.length === 0) continue;
        const known = entry?.accounts?.value ?? {};
        for (const address of addresses) {
            if (!(address in known)) pending.push({ mint, address });
        }
    }
    if (pending.length === 0) {
        log('account-owners: nothing pending');
        return { errors: [], batches: 0 };
    }

    const batches = [];
    for (let i = 0; i < pending.length; i += MAX_ACCOUNTS_PER_REQUEST) batches.push(pending.slice(i, i + MAX_ACCOUNTS_PER_REQUEST));
    log(`account-owners: ${pending.length} token account(s) in ${batches.length} batch(es) of ≤${MAX_ACCOUNTS_PER_REQUEST}, ${rpcPaceMs} ms apart`);

    const startedMs = Date.now();
    const failedMints = new Set();
    for (let i = 0; i < batches.length; i += 1) {
        const batch = batches[i];
        const { result, error } = await rpcCall('getMultipleAccounts', [batch.map((p) => p.address), { encoding: 'jsonParsed' }], `accounts batch ${i + 1}`);

        if (error !== null || !Array.isArray(result?.value) || result.value.length !== batch.length) {
            const why = error ?? `expected ${batch.length} accounts, got ${result?.value?.length}`;
            logWarn(`accounts batch ${i + 1}/${batches.length}: ${why} — ${new Set(batch.map((p) => p.mint)).size} mint(s) left for the next run`);
            for (const { mint } of batch) failedMints.add(mint);
        } else {
            for (let j = 0; j < batch.length; j += 1) {
                const { mint, address } = batch[j];
                const entry = state.mints[mint];
                if (entry.accounts === undefined || entry.accounts.value === undefined) entry.accounts = { status: 'pending', value: {} };
                // tokenAccountInfo() is the one unwrapping step, so the checkpoint stores the
                // same {owner, state, mint, program} record the shaping reads back. Keeping the
                // full jsonParsed account instead would make the checkpoint ~25 MB for nothing.
                entry.accounts.value[address] = tokenAccountInfo(result.value[j]);
            }
        }

        // Mark every mint whose addresses are now all answered.
        for (const mint of new Set(batch.map((p) => p.mint))) {
            const entry = state.mints[mint];
            const addresses = (entry?.largest?.value ?? []).map((v) => v?.address).filter((a) => typeof a === 'string' && a !== '');
            const value = entry?.accounts?.value ?? {};
            const complete = addresses.every((address) => address in value);
            entry.accounts = { status: complete ? 'ok' : 'error', value };
        }

        await flushCheckpoint(checkpointPath, state);
        const done = i + 1;
        log(`account-owners: batch ${done}/${batches.length} · ${batch.length} account(s) · ${rateLimited} 429(s) · pace ${rpcPaceMs} ms · ETA ${etaSeconds(startedMs, done, batches.length)}s`);
        if (done < batches.length) await sleep(rpcPaceMs);
    }
    return { errors: [...failedMints].sort(byString), batches: batches.length };
}

function pct(value, digits = 1) {
    return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(digits)}%` : 'n/a';
}

async function main() {
    const startedMs = Date.now();
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }
    const outPath = typeof flags.out === 'string' ? flags.out : DEFAULT_OUT;
    const force = Boolean(flags.force);
    const max = typeof flags.max === 'string' ? Number(flags.max) : null;
    if (max !== null && (!Number.isFinite(max) || max <= 0)) throw new Error(`--max must be a positive number, got "${flags.max}"`);

    // --- RPC endpoint: the key is never logged, only the host --------------------------------
    const env = await readEnvFile(ENV_PATH);
    const envRpc = typeof env.SOLANA_RPC_URL === 'string' && env.SOLANA_RPC_URL !== '' ? env.SOLANA_RPC_URL : null;
    rpc = typeof flags.rpc === 'string' ? flags.rpc : (envRpc ?? DEFAULT_RPC);
    const rpcHost = new URL(rpc).host;
    if (rpc === DEFAULT_RPC) logWarn(`rpc: no SOLANA_RPC_URL in ${ENV_PATH} — falling back to the public endpoint ${rpcHost}, which is heavily throttled and will rate limit a 441-mint run`);
    else log(`rpc: ${rpcHost} (keyed)`);
    const paceFlag = typeof flags.pace === 'string' ? Number(flags.pace) : null;
    if (paceFlag !== null && (!Number.isFinite(paceFlag) || paceFlag < 0)) throw new Error(`--pace must be a non-negative number, got "${flags.pace}"`);
    rpcPaceMs = Math.max(paceFlag ?? RPC_PACE_MS, RPC_PACE_MS);
    if (paceFlag !== null && paceFlag < RPC_PACE_MS) logWarn(`--pace=${paceFlag} is below the ${RPC_PACE_MS} ms floor; using ${rpcPaceMs} ms`);

    // --- Inputs ------------------------------------------------------------------------------
    const universe = await readJson(UNIVERSE_PATH);
    if (!Array.isArray(universe?.items)) throw new Error(`${UNIVERSE_PATH}: expected {items:[...]}`);
    // onchain.json is read for the authority LABELS only. Its `supply` is whenever that fetcher
    // last ran — hours to days old — and dividing today's balances by it is what put 66 of 441
    // mints over a 100% top-20 share on 2026-09-16. The supply comes from phase 0 below.
    const onchain = await readJson(ONCHAIN_PATH);
    if (!Array.isArray(onchain?.items)) throw new Error(`${ONCHAIN_PATH}: expected {items:[...]}`);

    const tokens = universe.items
        .map((item) => ({
            mint: typeof item?.mint === 'string' && item.mint !== '' ? item.mint : null,
            symbol: typeof item?.symbol === 'string' && item.symbol !== '' ? item.symbol : null,
            issuer: typeof item?.issuer === 'string' && item.issuer !== '' ? item.issuer : null,
            liquidityUsd: finiteOrNull(item?.liquidity)
        }))
        .filter((token) => token.mint !== null)
        .sort((a, b) => byString(a.mint, b.mint));
    if (tokens.length !== universe.items.length) logWarn(`${universe.items.length - tokens.length} universe item(s) have no mint and are skipped`);

    const selected = max === null ? tokens : tokens.slice(0, max);
    log(`read ${tokens.length} token(s) from universe.json (fetched ${universe.fetchedAt})${max === null ? '' : ` — --max=${max}, processing ${selected.length}`}`);

    // --- Checkpoint --------------------------------------------------------------------------
    const checkpointPath = join(RAW_DIR, `holders-checkpoint-${isoDate()}.json`);
    const existing = force ? null : await readJson(checkpointPath, null);
    const state = {
        startedAt: existing?.fetchedAt ?? ts(),
        rpcHost,
        supplyFetchedAt: force ? null : (typeof existing?.supplyFetchedAt === 'string' ? existing.supplyFetchedAt : null),
        supplies: force || existing === null ? {} : loadSupplies(existing),
        mints: force || existing === null ? {} : loadCheckpoint(existing)
    };
    if (force) logWarn("--force: ignoring today's checkpoint and re-fetching everything");
    else if (existing !== null) log(`checkpoint: ${checkpointPath} has ${Object.keys(state.supplies).length} supply(ies) and ${Object.keys(state.mints).length} mint(s) fully done`);

    // --- Fetch -------------------------------------------------------------------------------
    const mintList = selected.map((t) => t.mint);
    const phase0 = await fetchMintSupplies(mintList, state, checkpointPath);
    const phase1 = await fetchLargestAccounts(mintList, state, checkpointPath);
    const phase2 = await fetchAccountOwners(mintList, state, checkpointPath);

    // The labels are built AFTER phase 0, because the mint accounts it read are the only place the
    // Token-2022 extension authorities exist — onchain.json keeps the flags, not the keys. The
    // xStocks scaled-UI authority S7vYFF…, which is the largest holder of every xStock, is
    // labelled from that and from nothing hardcoded.
    const liveAuthorities = [...new Set(Object.values(state.supplies).flatMap((s) => s.authorities))].sort(byString);
    const labels = buildOwnerLabels(onchain.items, liveAuthorities);
    const noSupply = mintList.filter((mint) => state.supplies[mint]?.supply === null || state.supplies[mint]?.decimals === null || state.supplies[mint] === undefined);
    if (noSupply.length > 0) logWarn(`${noSupply.length} mint(s) have no live supply/decimals — their shares are null, not 0`);
    log(`owner labels: ${labels.size} address(es) this repo can name (${liveAuthorities.length} authority key(s) off the live mint accounts, the onchain.json authority fields, and the cited Superstate burn address)`);

    // --- Shape the output --------------------------------------------------------------------
    let mintMismatches = 0;
    let decimalsMismatches = 0;
    let unresolved = 0;
    let tokenAccounts = 0;
    const items = selected.map((token) => {
        const entry = state.mints[token.mint] ?? {};
        const supply = state.supplies[token.mint] ?? null;
        const out = summariseMint({
            mint: token.mint,
            symbol: token.symbol,
            issuer: token.issuer,
            decimals: supply?.decimals ?? null,
            rawSupply: supply?.supply ?? null,
            largest: entry.largest?.value ?? [],
            accountByAddress: entry.accounts?.value ?? {},
            labels
        });
        mintMismatches += out.mintMismatches;
        decimalsMismatches += out.decimalsMismatches;
        unresolved += out.unresolved;
        tokenAccounts += out.item.top20.length;
        return out.item;
    }).sort((a, b) => byString(a.mint, b.mint));

    const answered = items.filter((i) => i.top20.length > 0).length;
    const withFrozen = items.filter((i) => i.frozenAccountsTop20 > 0).length;
    const labeled = items.reduce((sum, i) => sum + i.top20.filter((e) => e.ownerLabel !== null).length, 0);
    const nullShares = items.filter((i) => i.top1SharePct === null).length;
    const errors = [...new Set([...phase0.errors, ...phase1.errors, ...phase2.errors])].sort(byString);

    await writeJson(outPath, {
        fetchedAt: ts(),
        source: {
            note: 'getMultipleAccounts({encoding:"jsonParsed"}) over the MINT addresses for the current supply + decimals, then getTokenLargestAccounts per mint (up to 20 token accounts) joined to one getMultipleAccounts({encoding:"jsonParsed"}) per 100 accounts for the owner wallet and frozen/initialized state. The supply is read in the SAME run as the balances, because it moves: against onchain.json\'s hours-old supply, 66 of 441 mints reported a top-20 share above 100% on 2026-09-16. supplyUi and amountUi are RAW base units / 10^decimals: the Token-2022 scaled-UI multiplier is NOT applied, because the RPC applies it to uiAmount but not to supply and it accrues over time — shares are raw/raw, where it cancels. Multiply by onchain.json scaledUiAmountMultiplier for the issuer-displayed count. A mint with no supply figure or supply 0 reports null shares, never 0. top20 is the top TOKEN ACCOUNTS; distinctOwnersTop20 is how many wallets they are.',
            rpcHost,
            mintsQueried: selected.length,
            rateLimited,
            method: 'getMultipleAccounts(jsonParsed, mints) + getTokenLargestAccounts + getMultipleAccounts(jsonParsed, token accounts)',
            requests: requestCount,
            supplyFetchedAt: state.supplyFetchedAt,
            supplyBatches: phase0.batches,
            accountBatches: phase2.batches,
            paceMs: RPC_PACE_MS,
            paceMsFinal: rpcPaceMs,
            backoffMs: RPC_BACKOFF_MS,
            mintsAnswered: answered,
            mintsWithNoAccounts: selected.length - answered,
            mintsWithNullShares: nullShares,
            tokenAccounts,
            accountsUnresolved: unresolved,
            ownersLabeled: labeled,
            ownerLabelsKnown: labels.size,
            authoritiesFromMintAccounts: liveAuthorities.length,
            mintMismatches,
            decimalsMismatches,
            checkpoint: relative(join(HERE, '..'), checkpointPath),
            inputs: {
                universeFetchedAt: universe.fetchedAt ?? null,
                universeCount: universe.items.length,
                // onchain.json contributes the authority LABELS only — never the supply, which is
                // `supplyFetchedAt` above and was read in this run.
                onchainFetchedAtLabelsOnly: onchain.fetchedAt ?? null,
                tokensProcessed: selected.length,
                mintsWithoutRawSupply: noSupply.length
            },
            errors
        },
        items
    });

    const elapsed = Math.round((Date.now() - startedMs) / 1000);
    log(`wrote ${outPath}: ${items.length} item(s) — ${answered} answered, ${tokenAccounts} token account(s), ${unresolved} unresolved, ${labeled} labeled owner(s)`);
    log(`${withFrozen} mint(s) have a frozen account in the top 20; ${nullShares} mint(s) report null shares (no supply figure or supply 0)`);
    // The point of phase 0: shares are only meaningful if no mint exceeds 100% of its own supply.
    const overSupply = items.filter((i) => [i.top1SharePct, i.top5SharePct, i.top20SharePct].some((s) => typeof s === 'number' && s > 100));
    log(`supply read live at ${state.supplyFetchedAt} — ${overSupply.length} mint(s) report a share above 100%${overSupply.length > 0 ? `: ${overSupply.slice(0, 5).map((i) => `${i.symbol} ${pct(i.top20SharePct)}`).join(', ')}` : ''}`);
    if (overSupply.length > 0) logWarn('a share above 100% means the supply moved between phase 0 and the balances — re-run to re-read both');
    if (mintMismatches > 0) logWarn(`${mintMismatches} account(s) named a different mint than the one queried and were not attributed`);
    if (decimalsMismatches > 0) logWarn(`${decimalsMismatches} account(s) disagreed with the mint's decimals; the mint's value was used`);

    // Per-issuer medians: the point of the whole file, so they are printed rather than left to a
    // consumer. Median, not mean, because one omnibus wallet at 99.9% would drag a mean anywhere.
    const byIssuer = new Map();
    for (const item of items) {
        const key = item.issuer ?? 'unknown';
        if (!byIssuer.has(key)) byIssuer.set(key, []);
        byIssuer.get(key).push(item);
    }
    for (const [issuer, rows] of [...byIssuer.entries()].sort((a, b) => byString(a[0], b[0]))) {
        const measurable = rows.filter((r) => r.top1SharePct !== null);
        log(`issuer ${issuer}: ${rows.length} token(s), ${measurable.length} measurable · median top1 ${pct(median(measurable.map((r) => r.top1SharePct)))} · median top20 ${pct(median(measurable.map((r) => r.top20SharePct)))} · ${rows.filter((r) => r.frozenAccountsTop20 > 0).length} with a frozen top-20 account`);
    }

    // The five most concentrated tokens that someone could actually trade.
    const liquidityByMint = new Map(selected.map((t) => [t.mint, t.liquidityUsd]));
    const liquid = items
        .filter((i) => i.top1SharePct !== null && (liquidityByMint.get(i.mint) ?? 0) > LIQUID_USD)
        .sort((a, b) => b.top1SharePct - a.top1SharePct);
    log(`most concentrated of the ${liquid.length} token(s) with >$${(LIQUID_USD / 1000).toFixed(0)}k liquidity: ${liquid.slice(0, 5).map((i) => `${i.symbol} top1 ${pct(i.top1SharePct)} / top20 ${pct(i.top20SharePct)} (${i.distinctOwnersTop20} wallets, $${Math.round(liquidityByMint.get(i.mint)).toLocaleString('en-US')} liq)`).join(' · ')}`);
    log(`done in ${elapsed}s · ${requestCount} request(s) · ${rateLimited} rate limit(s) · final pace ${rpcPaceMs} ms`);

    if (errors.length > 0) {
        logError(`${errors.length} mint(s) failed and will be retried on the next run: ${errors.slice(0, 10).join(', ')}${errors.length > 10 ? ', …' : ''}`);
        return 1;
    }
    return 0;
}

main().then((code) => process.exit(code), (err) => {
    logError(err.stack ?? String(err));
    process.exit(1);
});
