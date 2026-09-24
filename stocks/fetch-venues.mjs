#!/usr/bin/env node
// Records WHERE every tokenized stock in data/universe.json actually trades. Two read-only sources,
// kept separate because they measure different things: DexScreener lists the on-chain pools for a
// mint (pool liquidity and 24 h volume per pair), CoinGecko lists the markets that quote the coin
// the mint maps to (24 h volume per exchange ticker, no liquidity figure at all). Nothing is
// merged or summed across the two here — venues.json stores both verbatim per token and
// lib/venues.mjs does the aggregating, so a CEX volume can never be mistaken for pool depth.
// Writes stocks/data/venues.json.

import { join, relative } from 'node:path';
import { byString, fetchJson, isoDate, log, logError, logWarn, parseArgs, readJson, sleep, ts, writeJson } from './lib/io.mjs';
import { aggregateByIssuer, aggregateVenues, indexSolanaCoinIds, planCoinIdRefresh, selectCoinIdsForRefresh, shapeDexPair, shapeTicker, topVenues } from './lib/venues.mjs';
import { readEnvFile } from './lib/env.mjs';

const HERE = import.meta.dirname;
const UNIVERSE_PATH = join(HERE, 'data', 'universe.json');
const DEFAULT_OUT = join(HERE, 'data', 'venues.json');
const RAW_DIR = join(HERE, 'data', 'raw');

const DEX_URL = 'https://api.dexscreener.com/tokens/v1/solana';
const CG_LIST_URL = 'https://api.coingecko.com/api/v3/coins/list?include_platform=true';
const CG_TICKERS_URL = 'https://api.coingecko.com/api/v3/coins';

// DexScreener allows ~300 req/min on this endpoint and answered a full-universe run at 250 ms apart with
// zero 429s (2026-09-16). CoinGecko answers 429 rather than queueing, so its pace — see below — is
// what sets the run's wall time.
const DEX_PACE_MS = 250;
const DEX_BACKOFF_MS = [1000, 2000, 4000, 8000];
const CG_PACE_MS = 2500;
// With a CoinGecko Demo key (COINGECKO_API_KEY in ../.env) the documented 30 req/min applies: 2.1 s.
const CG_PACE_KEYED_MS = 2100;
const ENV_PATH = join(HERE, '..', '.env');
// Filled in main() from ../.env; the key is sent as the x-cg-demo-api-key header and never logged.
let cgHeaders = { accept: 'application/json' };
let cgPaceMs = CG_PACE_MS;
const CG_RATE_LIMIT_WAIT_MS = 60000;
const CG_RATE_LIMIT_RETRIES = 3;
const CG_BACKOFF_MS = [2000, 5000, 10000];

// The documented free-tier allowance (~30/min) is for a Demo API KEY; keyless, this endpoint served
// only ~5 requests before answering 429 on three separate attempts (2026-09-16, measured: 429 after
// 6, 3 and 5 requests at a flat 2.5 s pace). A 429 then costs a 60 s wait, which is far more than
// simply going slower — so the pace DOUBLES on every 429, up to a ceiling of 5 requests/min, and
// never speeds back up within a run. That finds whatever the tier is really allowing in two or
// three steps instead of guessing a constant, and an additive step would have needed ten.
const CG_PACE_MAX_MS = 12000;

// The checkpoint is written after EVERY item (it is ~6 KB per coin, so ~2.5 MB at the end — cheap),
// so a kill costs at most one request and never costs correctness: the next run reads the file back
// and skips every mint/coin already recorded. Progress is only LOGGED every LOG_EVERY items.
const LOG_EVERY = 10;

function usage() {
    console.log(`fetch-venues.mjs — DEX pools and CEX markets per tokenized stock

USAGE
  node stocks/fetch-venues.mjs --run [options]

OPTIONS
  --run                 Actually fetch. Without it this help is printed and nothing runs.
  --only-dex            DexScreener only (the default; fast, a few minutes for the full universe).
  --with-coingecko      DexScreener plus CoinGecko. Explicit opt-in because this spends one
                        CoinGecko ticker request per mapped token.
  --only-cex            CoinGecko only. Explicit opt-in; needs today's coin list and is slow.
  --coin-limit=<n>      Query at most n unique CoinGecko ids, choosing the oldest/unseen first.
                        Intended for a quota-safe daily rotation; has no effect on DexScreener.
  --max=<n>             Process only the first n tokens by mint. For smoke tests.
  --force               Ignore today's checkpoint and re-fetch everything.
  --out=<path>          Output file (default stocks/data/venues.json).
  --help                This text.

INPUTS
  stocks/data/universe.json     the current mints, their symbol and issuer

OUTPUT
  stocks/data/venues.json       { fetchedAt, source, items[] } sorted by mint

NOTES
  DexScreener-only is the default. CoinGecko is never called unless --with-coingecko or
  --only-cex is present. Both sources are read-only GETs.
  DexScreener is paced ${DEX_PACE_MS} ms apart and retries 429/5xx with exponential backoff.
  CoinGecko starts at ${CG_PACE_MS} ms apart (${CG_PACE_KEYED_MS} ms with COINGECKO_API_KEY in ../.env); a 429 waits ${CG_RATE_LIMIT_WAIT_MS / 1000} s, retries up to ${CG_RATE_LIMIT_RETRIES}x, and
  doubles the pace (up to ${CG_PACE_MAX_MS} ms) — keyless, it serves ~5/min, not the documented 30.
  The 3.7 MB coins/list?include_platform=true is cached for the day in data/raw and the mint is
  matched against platforms.solana — an exact, case-sensitive base58 match, never the symbol.
  Existing data from the source not fetched in this run is carried forward with its own per-item
  fetchedAt. Every response is checkpointed to stocks/data/raw/venues-checkpoint-<date>.json, so a killed or
  rate-limited run resumes the same day and re-fetches only what failed. That file is shared, so do
  not run two instances at once — the second would overwrite the first's section of it.
  CoinGecko's tickers[].trust_score is null for every coin on the free tier (re-measured
  2026-09-16, including for bitcoin); the field is carried through as null rather than dropped.
  CoinGecko markets include some DEXes (e.g. "Raydium (CLMM)"), so the cex[] array is
  "markets CoinGecko lists", not "centralised venues only".`);
}

/** GET with retry on 429/5xx only. Returns `{res, rateLimited}`; `res` is null when it kept failing. */
async function getWithBackoff(url, label, { backoffMs, rateLimitWaitMs = null, rateLimitRetries = 0, headers = { accept: 'application/json' } }) {
    let rateLimited = 0;
    let rateLimitAttempts = 0;
    for (let attempt = 0; ; attempt += 1) {
        let res = null;
        try {
            res = await fetchJson(url, { headers, timeoutMs: 60000 });
        } catch (err) {
            // A timeout or socket error is worth the same retry as a 5xx.
            if (attempt >= backoffMs.length) {
                logWarn(`${label}: ${err.name}: ${err.message} — giving up for this run`);
                return { res: null, rateLimited };
            }
            logWarn(`${label}: ${err.name}: ${err.message}, retrying in ${backoffMs[attempt]} ms`);
            await sleep(backoffMs[attempt]);
            continue;
        }

        if (res.status === 429) {
            rateLimited += 1;
            if (rateLimitWaitMs === null) {
                if (attempt >= backoffMs.length) {
                    logWarn(`${label}: HTTP 429 after ${backoffMs.length} retries — giving up for this run`);
                    return { res: null, rateLimited };
                }
                logWarn(`${label}: HTTP 429, retrying in ${backoffMs[attempt]} ms`);
                await sleep(backoffMs[attempt]);
                continue;
            }
            rateLimitAttempts += 1;
            if (rateLimitAttempts > rateLimitRetries) {
                logWarn(`${label}: HTTP 429 after ${rateLimitRetries} long wait(s) — giving up for this run`);
                return { res: null, rateLimited };
            }
            logWarn(`${label}: HTTP 429 (rate limited), waiting ${rateLimitWaitMs / 1000} s (attempt ${rateLimitAttempts}/${rateLimitRetries})`);
            await sleep(rateLimitWaitMs);
            continue;
        }

        if (res.status >= 500) {
            if (attempt >= backoffMs.length) {
                logWarn(`${label}: HTTP ${res.status} after ${backoffMs.length} retries — giving up for this run :: ${res.bodyPreview}`);
                return { res: null, rateLimited };
            }
            logWarn(`${label}: HTTP ${res.status}, retrying in ${backoffMs[attempt]} ms`);
            await sleep(backoffMs[attempt]);
            continue;
        }

        return { res, rateLimited };
    }
}

/**
 * The checkpoint holds the raw response per mint (DexScreener) and per coin id (CoinGecko), with a
 * terminal status. `ok` / `empty` / `not-found` are reused for the rest of the day; `error` is
 * re-fetched on the next run, exactly like the Pyth entitlement probe in fetch-reference-prices.
 */
const TERMINAL = new Set(['ok', 'empty', 'not-found']);

function loadCheckpointSection(section) {
    const kept = {};
    for (const [key, value] of Object.entries(section ?? {})) {
        if (TERMINAL.has(value?.status)) kept[key] = value;
    }
    return kept;
}

async function flushCheckpoint(path, state) {
    await writeJson(path, {
        fetchedAt: state.startedAt,
        updatedAt: ts(),
        note: 'raw DexScreener pairs per mint and raw CoinGecko tickers per coin id. status ok/empty/not-found is reused for the rest of the day; "error" entries are re-fetched on the next run.',
        dex: state.dex,
        cex: state.cex
    });
}

/** The 21k-entry coin list, cached for the day — it is 3.7 MB and changes slowly. */
async function fetchCoinsList({ force }) {
    const cachePath = join(RAW_DIR, `coingecko-coins-list-${isoDate()}.json`);
    if (!force) {
        const cached = await readJson(cachePath, null);
        if (cached !== null && Array.isArray(cached.body)) {
            log(`coingecko: reusing today's coin list from ${cachePath} (${cached.body.length} coins, fetched ${cached.fetchedAt})`);
            return { coins: cached.body, fetchedAt: cached.fetchedAt, cached: true, rateLimited: 0 };
        }
    }
    log(`coingecko: GET ${CG_LIST_URL}`);
    const { res, rateLimited } = await getWithBackoff(CG_LIST_URL, 'coingecko coin list', {
        headers: cgHeaders,
        backoffMs: CG_BACKOFF_MS,
        rateLimitWaitMs: CG_RATE_LIMIT_WAIT_MS,
        rateLimitRetries: CG_RATE_LIMIT_RETRIES
    });
    if (res === null) throw new Error('CoinGecko coin list kept failing; without it no mint can be mapped to a coin id');
    if (!res.ok) throw new Error(`CoinGecko coin list failed: HTTP ${res.status} :: ${res.bodyPreview}`);
    if (!Array.isArray(res.json)) throw new Error(`CoinGecko coin list: expected an array, got ${typeof res.json} :: ${res.bodyPreview}`);
    const fetchedAt = ts();
    await writeJson(cachePath, { fetchedAt, url: CG_LIST_URL, status: res.status, count: res.json.length, body: res.json });
    log(`coingecko: ${res.json.length} coins, ${res.bytes} bytes, cached in ${cachePath}`);
    return { coins: res.json, fetchedAt, cached: false, rateLimited };
}

function etaSeconds(startedMs, done, total) {
    if (done === 0) return null;
    return Math.round(((Date.now() - startedMs) / done) * (total - done) / 1000);
}

/** DexScreener pairs for every mint not already in the checkpoint. */
async function fetchDexPairs(mints, state, checkpointPath) {
    const todo = mints.filter((mint) => state.dex[mint] === undefined);
    const reused = mints.length - todo.length;
    if (reused > 0) log(`dexscreener: reusing ${reused} checkpointed mint(s)`);
    if (todo.length === 0) return { rateLimited: 0, errors: [] };

    log(`dexscreener: querying ${todo.length} mint(s), ${DEX_PACE_MS} ms apart (~${Math.ceil(todo.length * DEX_PACE_MS / 1000)} s)`);
    const startedMs = Date.now();
    let rateLimited = 0;
    const errors = [];
    for (let i = 0; i < todo.length; i += 1) {
        const mint = todo[i];
        const url = `${DEX_URL}/${mint}`;
        const attempt = await getWithBackoff(url, `dexscreener ${mint.slice(0, 8)}`, { backoffMs: DEX_BACKOFF_MS });
        rateLimited += attempt.rateLimited;
        const res = attempt.res;

        if (res === null) {
            state.dex[mint] = { fetchedAt: ts(), status: 'error', error: 'request failed after retries', pairs: [] };
            errors.push(mint);
        } else if (res.status === 404) {
            state.dex[mint] = { fetchedAt: ts(), status: 'not-found', httpStatus: 404, pairs: [] };
        } else if (!res.ok) {
            state.dex[mint] = { fetchedAt: ts(), status: 'error', httpStatus: res.status, error: res.bodyPreview, pairs: [] };
            errors.push(mint);
            logWarn(`dexscreener ${mint.slice(0, 8)}: HTTP ${res.status} :: ${res.bodyPreview}`);
        } else if (!Array.isArray(res.json)) {
            // The endpoint answers with a bare array; anything else is a shape change worth seeing.
            state.dex[mint] = { fetchedAt: ts(), status: 'error', httpStatus: res.status, error: `expected an array, got ${typeof res.json}`, pairs: [] };
            errors.push(mint);
            logWarn(`dexscreener ${mint.slice(0, 8)}: expected an array :: ${res.bodyPreview}`);
        } else {
            state.dex[mint] = { fetchedAt: ts(), status: res.json.length === 0 ? 'empty' : 'ok', httpStatus: res.status, pairs: res.json };
        }

        const done = i + 1;
        await flushCheckpoint(checkpointPath, state);
        if (done % LOG_EVERY === 0 || done === todo.length) {
            const withPairs = Object.values(state.dex).filter((e) => e.status === 'ok').length;
            log(`dexscreener: ${done}/${todo.length} · ${withPairs} mint(s) with pairs · ${errors.length} error(s) · ETA ${etaSeconds(startedMs, done, todo.length)}s`);
        }
        if (done < todo.length) await sleep(DEX_PACE_MS);
    }
    return { rateLimited, errors };
}

/** CoinGecko tickers for every mapped coin id not already in the checkpoint. */
async function fetchCexTickers(coinIds, state, checkpointPath) {
    const todo = coinIds.filter((id) => state.cex[id] === undefined);
    const reused = coinIds.length - todo.length;
    if (reused > 0) log(`coingecko: reusing ${reused} checkpointed coin(s)`);
    if (todo.length === 0) return { rateLimited: 0, errors: [], paceMs: CG_PACE_MS };

    log(`coingecko: querying ${todo.length} coin(s), ${cgPaceMs} ms apart to start (~${Math.ceil(todo.length * cgPaceMs / 1000 / 60)} min if it is never rate limited)`);
    const startedMs = Date.now();
    let rateLimited = 0;
    let paceMs = cgPaceMs;
    const errors = [];
    for (let i = 0; i < todo.length; i += 1) {
        const id = todo[i];
        const url = `${CG_TICKERS_URL}/${encodeURIComponent(id)}/tickers`;
        const attempt = await getWithBackoff(url, `coingecko ${id}`, {
            headers: cgHeaders,
            backoffMs: CG_BACKOFF_MS,
            rateLimitWaitMs: CG_RATE_LIMIT_WAIT_MS,
            rateLimitRetries: CG_RATE_LIMIT_RETRIES
        });
        rateLimited += attempt.rateLimited;
        if (attempt.rateLimited > 0 && paceMs < CG_PACE_MAX_MS) {
            paceMs = Math.min(paceMs * 2 ** attempt.rateLimited, CG_PACE_MAX_MS);
            logWarn(`coingecko: slowing to ${paceMs} ms between requests after ${rateLimited} rate limit(s) so far`);
        }
        const res = attempt.res;

        if (res === null) {
            state.cex[id] = { fetchedAt: ts(), status: 'error', error: 'request failed after retries', tickers: [] };
            errors.push(id);
        } else if (res.status === 404) {
            state.cex[id] = { fetchedAt: ts(), status: 'not-found', httpStatus: 404, tickers: [] };
        } else if (!res.ok) {
            state.cex[id] = { fetchedAt: ts(), status: 'error', httpStatus: res.status, error: res.bodyPreview, tickers: [] };
            errors.push(id);
            logWarn(`coingecko ${id}: HTTP ${res.status} :: ${res.bodyPreview}`);
        } else if (!Array.isArray(res.json?.tickers)) {
            state.cex[id] = { fetchedAt: ts(), status: 'error', httpStatus: res.status, error: 'expected {tickers:[...]}', tickers: [] };
            errors.push(id);
            logWarn(`coingecko ${id}: expected {tickers:[...]} :: ${res.bodyPreview}`);
        } else {
            state.cex[id] = { fetchedAt: ts(), status: res.json.tickers.length === 0 ? 'empty' : 'ok', httpStatus: res.status, tickers: res.json.tickers };
        }

        const done = i + 1;
        await flushCheckpoint(checkpointPath, state);
        if (done % LOG_EVERY === 0 || done === todo.length) {
            const withTickers = Object.values(state.cex).filter((e) => e.status === 'ok').length;
            log(`coingecko: ${done}/${todo.length} · ${withTickers} coin(s) with tickers · ${rateLimited} 429(s) · ${errors.length} error(s) · pace ${paceMs} ms · ETA ${etaSeconds(startedMs, done, todo.length)}s`);
        }
        if (done < todo.length) await sleep(paceMs);
    }
    return { rateLimited, errors, paceMs };
}

function usd(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
    return `$${Math.round(value).toLocaleString('en-US')}`;
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }
    const outPath = typeof flags.out === 'string' ? flags.out : DEFAULT_OUT;
    const force = Boolean(flags.force);
    const requestedOnlyDex = Boolean(flags['only-dex']);
    const withCoinGecko = Boolean(flags['with-coingecko']);
    const onlyCex = Boolean(flags['only-cex']);
    if (requestedOnlyDex && (onlyCex || withCoinGecko)) {
        throw new Error('--only-dex cannot be combined with --only-cex or --with-coingecko');
    }
    if (onlyCex && withCoinGecko) throw new Error('--only-cex and --with-coingecko are mutually exclusive');
    const onlyDex = requestedOnlyDex || (!onlyCex && !withCoinGecko);
    const max = typeof flags.max === 'string' ? Number(flags.max) : null;
    if (max !== null && (!Number.isFinite(max) || max <= 0)) throw new Error(`--max must be a positive number, got "${flags.max}"`);
    const coinLimit = typeof flags['coin-limit'] === 'string' ? Number(flags['coin-limit']) : null;
    if (coinLimit !== null && (!Number.isInteger(coinLimit) || coinLimit <= 0)) {
        throw new Error(`--coin-limit must be a positive integer, got "${flags['coin-limit']}"`);
    }
    if (onlyDex && coinLimit !== null) throw new Error('--coin-limit requires --only-cex or --with-coingecko');

    const universe = await readJson(UNIVERSE_PATH);
    if (!Array.isArray(universe?.items)) throw new Error(`${UNIVERSE_PATH}: expected {items:[...]}`);
    const tokens = universe.items
        .map((item) => ({
            mint: typeof item?.mint === 'string' && item.mint !== '' ? item.mint : null,
            symbol: typeof item?.symbol === 'string' && item.symbol !== '' ? item.symbol : null,
            issuer: typeof item?.issuer === 'string' && item.issuer !== '' ? item.issuer : null
        }))
        .filter((token) => token.mint !== null)
        .sort((a, b) => byString(a.mint, b.mint));
    if (tokens.length !== universe.items.length) {
        logWarn(`${universe.items.length - tokens.length} universe item(s) have no mint and are skipped`);
    }
    const selected = max === null ? tokens : tokens.slice(0, max);
    log(`read ${tokens.length} token(s) from universe.json (fetched ${universe.fetchedAt})${max === null ? '' : ` — --max=${max}, processing ${selected.length}`}`);

    const previous = await readJson(outPath, null);
    const previousItems = Array.isArray(previous?.items) ? previous.items : [];
    const previousByMint = new Map(previousItems.map((item) => [item?.mint, item]));

    const checkpointPath = join(RAW_DIR, `venues-checkpoint-${isoDate()}.json`);
    const existing = await readJson(checkpointPath, null);
    const state = {
        startedAt: existing?.fetchedAt ?? ts(),
        // `--force` applies only to sources this invocation will fetch. The untouched section is
        // retained verbatim (including failed attempts), so a forced Dex pass cannot erase the
        // daily CoinGecko quota ledger and allow a same-day rerun to spend it twice.
        dex: onlyCex
            ? { ...(existing?.dex ?? {}) }
            : force ? {} : loadCheckpointSection(existing?.dex),
        cex: onlyDex
            ? { ...(existing?.cex ?? {}) }
            : force ? {}
                : coinLimit !== null ? { ...(existing?.cex ?? {}) }
                    : loadCheckpointSection(existing?.cex)
    };
    if (force) logWarn(`--force: re-fetching ${onlyDex ? 'DexScreener' : onlyCex ? 'CoinGecko' : 'both sources'}; the unrequested source checkpoint is preserved`);
    else if (existing !== null) log(`checkpoint: ${checkpointPath} has ${Object.keys(state.dex).length} mint(s) and ${Object.keys(state.cex).length} coin(s) done`);
    if (!onlyDex) {
        const env = await readEnvFile(ENV_PATH);
        if (typeof env.COINGECKO_API_KEY === 'string' && env.COINGECKO_API_KEY !== '') {
            cgHeaders = { ...cgHeaders, 'x-cg-demo-api-key': env.COINGECKO_API_KEY };
            cgPaceMs = CG_PACE_KEYED_MS;
            log(`coingecko: Demo API key found in ${ENV_PATH} — 30 req/min tier, pacing ${cgPaceMs} ms`);
        } else {
            log(`coingecko: no COINGECKO_API_KEY in ${ENV_PATH} — keyless tier (~5 req/min), pacing ${cgPaceMs} ms`);
        }
    } else {
        log('coingecko: disabled by --only-dex; no CoinGecko request will be made');
    }

    // --- DexScreener -------------------------------------------------------------------------
    let dexFetchedAt = null;
    let dexRateLimited = 0;
    let dexErrors = [];
    if (!onlyCex) {
        const result = await fetchDexPairs(selected.map((t) => t.mint), state, checkpointPath);
        dexRateLimited = result.rateLimited;
        dexErrors = result.errors;
        dexFetchedAt = ts();
    }

    // --- CoinGecko ---------------------------------------------------------------------------
    let coinIdByMint = new Map();
    let cgListFetchedAt = null;
    let cgRateLimited = 0;
    let cexErrors = [];
    let cgDuplicates = [];
    let coinsQueried = 0;
    let newTickerIdsSelected = 0;
    let cexFetchedAt = null;
    let cgFinalPaceMs = CG_PACE_MS;
    if (!onlyDex) {
        const list = await fetchCoinsList({ force });
        cgListFetchedAt = list.fetchedAt;
        cgRateLimited += list.rateLimited;
        const index = indexSolanaCoinIds(list.coins);
        cgDuplicates = index.duplicates;
        for (const token of selected) {
            const id = index.byAddress.get(token.mint);
            if (id !== undefined) coinIdByMint.set(token.mint, id);
        }
        const solanaCoins = [...index.byAddress.keys()].length;
        log(`coingecko: ${solanaCoins} coin(s) carry a Solana address; ${coinIdByMint.size}/${selected.length} of our mints map to a coin id${cgDuplicates.length > 0 ? `, ${cgDuplicates.length} address(es) claimed by more than one coin` : ''}`);
        const allCoinIds = [...new Set(coinIdByMint.values())];
        const orderedCoinIds = selectCoinIdsForRefresh(coinIdByMint, previousItems, null);
        const attemptedToday = new Set(force ? [] : Object.keys(existing?.cex ?? {}));
        const doneToday = new Set(Object.entries(state.cex)
            .filter(([, entry]) => TERMINAL.has(entry?.status))
            .map(([id]) => id));
        const { coinIds, newCoinIds } = planCoinIdRefresh(
            orderedCoinIds,
            attemptedToday,
            doneToday,
            coinLimit
        );
        coinsQueried = coinIds.length;
        newTickerIdsSelected = newCoinIds.length;
        if (coinLimit !== null) {
            log(`coingecko: daily quota cap ${coinLimit}; ${attemptedToday.size} id(s) already attempted today, ${newCoinIds.length} new id(s) selected oldest/unseen first (${allCoinIds.length} mapped total)`);
        }
        const result = await fetchCexTickers(coinIds, state, checkpointPath);
        cgRateLimited += result.rateLimited;
        cexErrors = result.errors;
        cgFinalPaceMs = result.paceMs;
        cexFetchedAt = ts();
    }

    // --- Shape the output --------------------------------------------------------------------
    let quoteSidePairs = 0;
    let droppedPairs = 0;
    const items = selected.map((token) => {
        const prior = previousByMint.get(token.mint) ?? null;
        const candidateDexEntry = state.dex[token.mint] ?? null;
        const dexEntry = TERMINAL.has(candidateDexEntry?.status) ? candidateDexEntry : null;
        let dex;
        let itemDexFetchedAt;
        if (dexEntry !== null) {
            const rawPairs = Array.isArray(dexEntry.pairs) ? dexEntry.pairs : [];
            dex = [];
            for (const raw of rawPairs) {
                const shaped = shapeDexPair(raw, token.mint);
                if (shaped === null) {
                    droppedPairs += 1;
                    continue;
                }
                if (raw?.baseToken?.address !== token.mint) quoteSidePairs += 1;
                dex.push(shaped);
            }
            dex.sort((a, b) => byString(a.pairAddress, b.pairAddress));
            itemDexFetchedAt = dexEntry.fetchedAt ?? dexFetchedAt;
        } else {
            dex = Array.isArray(prior?.dex) ? prior.dex : [];
            itemDexFetchedAt = prior?.dexFetchedAt ?? previous?.source?.dexscreener?.fetchedAt ?? null;
        }

        const mappedId = coinIdByMint.get(token.mint) ?? null;
        const coingeckoId = onlyDex ? prior?.coingeckoId ?? null : mappedId;
        const candidateCexEntry = coingeckoId === null ? null : state.cex[coingeckoId] ?? null;
        const cexEntry = TERMINAL.has(candidateCexEntry?.status) ? candidateCexEntry : null;
        let cex;
        let itemCexFetchedAt;
        if (cexEntry !== null) {
            cex = (Array.isArray(cexEntry.tickers) ? cexEntry.tickers : [])
                .map((raw) => shapeTicker(raw))
                .filter((shaped) => shaped !== null)
                .sort((a, b) => byString(`${a.market}|${a.base}|${a.target}`, `${b.market}|${b.base}|${b.target}`));
            itemCexFetchedAt = cexEntry.fetchedAt ?? cexFetchedAt;
        } else if (coingeckoId !== null && prior?.coingeckoId === coingeckoId) {
            cex = Array.isArray(prior?.cex) ? prior.cex : [];
            itemCexFetchedAt = prior?.cexFetchedAt ?? previous?.source?.coingecko?.fetchedAt ?? null;
        } else {
            cex = [];
            itemCexFetchedAt = null;
        }

        return {
            mint: token.mint,
            symbol: token.symbol,
            issuer: token.issuer,
            coingeckoId,
            dexFetchedAt: itemDexFetchedAt,
            cexFetchedAt: itemCexFetchedAt,
            dex,
            cex
        };
    }).sort((a, b) => byString(a.mint, b.mint));

    const mintsWithPairs = items.filter((i) => i.dex.length > 0).length;
    const coinsWithTickers = items.filter((i) => i.cex.length > 0).length;
    const venues = aggregateVenues(items);
    const perIssuer = aggregateByIssuer(items);
    const tickerCount = items.reduce((sum, i) => sum + i.cex.length, 0);
    const withTrustScore = items.reduce((sum, i) => sum + i.cex.filter((t) => t.trustScore !== null).length, 0);

    await writeJson(outPath, {
        fetchedAt: ts(),
        source: {
            note: onlyDex
                ? 'DexScreener-only refresh: dex[] was refreshed; existing CoinGecko mapping and cex[] data were carried forward with their original cexFetchedAt to conserve quota.'
                : 'dex[] is DexScreener pools for the mint (pool liquidity + 24 h volume per pair); cex[] is the markets CoinGecko lists for the coin the mint maps to (24 h volume per ticker, no liquidity figure). Some CoinGecko markets are DEXes, so cex[] is not "centralised only". The two sources are never summed together.',
            dexscreener: {
                fetchedAt: items.map((item) => item.dexFetchedAt).filter(Boolean).sort().at(-1) ?? null,
                url: DEX_URL,
                mintsQueried: onlyCex ? 0 : selected.length,
                mintsWithPairs,
                pairsKept: items.reduce((sum, i) => sum + i.dex.length, 0),
                pairsDropped: droppedPairs,
                quoteSidePairs,
                paceMs: DEX_PACE_MS,
                rateLimited: dexRateLimited,
                errors: dexErrors.sort(byString)
            },
            coingecko: {
                requestedThisRun: !onlyDex,
                fetchedAt: items.map((item) => item.cexFetchedAt).filter(Boolean).sort().at(-1) ?? null,
                listUrl: CG_LIST_URL,
                tickersUrl: `${CG_TICKERS_URL}/<id>/tickers`,
                listFetchedAt: cgListFetchedAt ?? previous?.source?.coingecko?.listFetchedAt ?? null,
                coinsMapped: new Set(items.map((item) => item.coingeckoId).filter(Boolean)).size,
                coinsQueried,
                newTickerIdsSelected,
                coinLimit,
                coinsWithTickers,
                tickers: tickerCount,
                tickersWithTrustScore: withTrustScore,
                trustScoreNote: 'tickers[].trust_score is null for every coin on the free tier (re-measured 2026-09-16 against bitcoin too); it is carried through as null, not dropped',
                duplicateSolanaAddresses: cgDuplicates,
                paceMs: CG_PACE_MS,
                paceMsFinal: cgFinalPaceMs,
                rateLimited: cgRateLimited,
                errors: cexErrors.sort(byString)
            },
            checkpoint: relative(join(HERE, '..'), checkpointPath),
            inputs: {
                universeFetchedAt: universe.fetchedAt ?? null,
                universeCount: universe.items.length,
                tokensProcessed: selected.length
            }
        },
        items
    });

    log(`wrote ${outPath}: ${items.length} item(s) — ${mintsWithPairs} with DEX pairs, ${coinsWithTickers} with CoinGecko markets`);
    log(`dex venues: ${venues.dex.length} dexId(s) — ${topVenues(venues.dex, 5, 'liquidityUsd').map((v) => `${v.venue} ${usd(v.liquidityUsd)} liq / ${usd(v.volume24Usd)} vol (${v.mints} mints)`).join(' · ')}`);
    log(`cex venues: ${venues.cex.length} market(s) — ${topVenues(venues.cex, 5, 'volume24Usd').map((v) => `${v.venue} ${usd(v.volume24Usd)} vol (${v.mints} mints)`).join(' · ')}`);
    for (const row of perIssuer) {
        log(`issuer ${row.issuer}: ${row.tokens} token(s), ${row.tokensWithDex} on a DEX, ${row.tokensWithCex} on a CoinGecko market, dex liq ${usd(row.dexLiquidityUsd)}, cex vol ${usd(row.cexVolume24Usd)}, top venue ${row.topVenue === null ? 'none' : `${row.topVenue.venue} (${row.topVenue.kind}, ${usd(row.topVenue.volume24Usd)} vol)`}`);
    }
    if (quoteSidePairs > 0) logWarn(`${quoteSidePairs} pair(s) had our mint on the quote side; their quoteSymbol is the counter-asset`);
    if (droppedPairs > 0) logWarn(`${droppedPairs} pair(s) were dropped as unusable (wrong chain, no dexId/pairAddress, or naming neither side)`);

    const errorCount = dexErrors.length + cexErrors.length;
    if (errorCount > 0) {
        logError(`${errorCount} item(s) failed and will be retried on the next run: ${[...dexErrors, ...cexErrors].slice(0, 10).join(', ')}${errorCount > 10 ? ', …' : ''}`);
        return 1;
    }
    return 0;
}

main().then((code) => process.exit(code), (err) => {
    logError(err.stack ?? String(err));
    process.exit(1);
});
