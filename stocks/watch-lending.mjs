#!/usr/bin/env node
// Hourly watcher of the Solana lending markets that take tokenized stocks as collateral (Kamino,
// Jupiter Lend, Nest, Loopscale): every liquidation whose seized collateral is a tracked stock
// token, and every stretch in which a market's collateral price stopped updating (a "price
// freeze"). Stores sonar.lending_liquidation / lending_price_freeze / lending_scan
// (db/2026-09-24-sonar-lending.sql); the latest-events feed reads them (stocks/lib/events.mjs).
//
// All decisions live in lib/lending-decode.mjs and lib/lending-events.mjs (tested); this file is
// the IO: listing signatures since each account's checkpoint, reading the transactions oldest
// first within a budget, the per-run account reads, psql and the run's stats.
//
// Restartable: every write is an idempotent upsert and each account's checkpoint only moves past
// what was read and stored in the same database transaction, so a killed run loses at most that
// run's reads and the next one resumes from the checkpoints.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { decodeLendingTransaction } from './lib/lending-decode.mjs';
import {
    BACKFILL_FROM, CLOCK_SYSVAR, FETCH_ROLES, JL_CACHE_MAX_GAP_S, LISTED_ROLES, LIST_EVERY_HOURS, SCAN_STATE_QUERY, SCOPE_CONFIGURATION,
    TRADE_PRICE_FILL_SQL, advanceCheckpoints, applyCacheSignatures, applyPythReading, applyReserveObservation,
    applyScopeResume, buildFreezeSql, buildLiquidationSql, buildScanSql, buildWatchList, completedCut,
    decodePriceUpdateV2, dueForListing, freezeRow, isoFromUnix, jupiterGapCause, liquidationRow, obligationOwner,
    ongoingCacheEpisode, pendingOldestFirst, reservesByScopeEntry, selectBatch, unixFromIso, usEquitySchedule
} from './lib/lending-events.mjs';
import { wrapTransaction } from './lib/db-load.mjs';
import { readEnvFile } from './lib/env.mjs';
import { log, logError, logWarn, parseArgs, readJson, sleep, ts, writeJson } from './lib/io.mjs';
import { parseSchedule, sessionAt } from './lib/market-hours.mjs';
import { describeUrl, psql } from './lib/psql.mjs';
import { base58Encode } from './lib/solana-address.mjs';
import { DEFAULT_RPC, getAccountsWithContext, rpcCall } from './lib/solana-rpc.mjs';
import { refreshCollectorStatus } from './build-collector-status.mjs';

const HERE = import.meta.dirname;
const REPO = join(HERE, '..');
const DDL_FILE = join(REPO, 'db', '2026-09-24-sonar-lending.sql');
const STATS_FILE = join(REPO, '.last-lending-watch-stats.json');
const RUN_STARTED_MS = Date.now();
const RUN_STARTED_AT = ts(new Date(RUN_STARTED_MS));

const DEFAULT_BUDGET = 1000;
const DEFAULT_MAX_PAGES = 30;
const PAGE = 1000;
// getSignaturesForAddress weighs far more than getTransaction on Alchemy's compute-unit meter:
// 1 s apart drew a 429 on most calls during the first backfill (2026-09-24, with the trade tape
// running), as fetch-recent-trades.mjs found; 2 s is its measured clean spacing. The ladder in
// lib/solana-rpc.mjs absorbs any 429 left.
const SIG_PACE_MS = 2000;
const TX_PACE_MS = 150;
/** Jupiter Lend gap episodes whose boundary transactions are read for a cause, per run. */
const CAUSE_READS = 20;

function usage() {
    console.log(`watch-lending.mjs — liquidations and collateral price freezes on Solana lending markets

USAGE
  node stocks/watch-lending.mjs --run [options]

OPTIONS
  --run              Actually read the chain. Without it this help is printed and nothing runs.
  --ddl              Apply db/${DDL_FILE.split('/').pop()} first. Idempotent.
  --budget=<n>       Max getTransaction reads this run, oldest unprocessed first (default ${DEFAULT_BUDGET}).
  --since=<iso>      Where a never-read account starts (default ${BACKFILL_FROM}, the start of our records).
  --max-pages=<n>    Max signature pages (${PAGE} each) listed per account per run (default ${DEFAULT_MAX_PAGES}).
  --only=<list>      Protocols to watch, comma-separated: kamino, jupiter-lend, nest, loopscale.
  --rpc=<url>        RPC endpoint (default SOLANA_RPC_URL from .env, else ${DEFAULT_RPC}).
  --no-db            Keep nothing: start every account at --since, print what was found, write no rows.
  --print            Print every liquidation and freeze episode found this run.
  --tx-cache=<dir>   Keep every transaction read as <dir>/<signature>.json and read it from there next
                     time (for re-running the decoders during development; the hourly job does not use it).
  --help             This text.

WHAT A RUN DOES
  1. Builds the watch list from stocks/data/protocol-market-research.json (oraclePricing) and
     stocks/data/defi-usage.json: Kamino stock reserves (+ Scope's configuration account),
     Jupiter Lend xStock vaults and their Chainlink caches, Nest collateral configs, Loopscale loans
     against stock tokens and the Pyth accounts Loopscale prices them from.
  2. Reads the Clock sysvar and every Pyth account in one getMultipleAccounts call.
  3. Lists each account's signatures since its checkpoint (or back to --since), ${SIG_PACE_MS} ms apart;
     the nearly silent Nest configs and Loopscale loans every ${LIST_EVERY_HOURS['nest-config']} h.
  4. Reads the transactions of all fetched accounts together, oldest slot first, up to --budget,
     and decodes liquidations, KLend price observations and Scope resumes. Each account's
     checkpoint moves to the newest slot read, so a backlog carries over, never skipped.
  5. Freeze episodes: KLend "Price is too old" logs per reserve; gaps over ${JL_CACHE_MAX_GAP_S} s between successful
     transactions on a Jupiter Lend cache (the gap's first and last transactions are read for a
     suspension event); a Pyth account older than its market's max age while the US market is open.
  6. Upserts liquidations, episodes and checkpoints in one transaction, then prices collateral
     that has no protocol-logged price from the trade tape (median within ±1 h).
  7. Writes ${relative(REPO, STATS_FILE)} and refreshes stocks-collector-status.json. Exits non-zero
     when any account or transaction could not be read.

COST
  One getSignaturesForAddress per listed account (29 every run, 38 more every ${LIST_EVERY_HOURS['nest-config']} h), one getMultipleAccounts, and
  one getTransaction per new transaction on a fetched account (~15–50 an hour). The first runs
  backfill about 6,700 transactions since ${BACKFILL_FROM.slice(0, 10)} (measured 2026-09-24), --budget at a time.

REQUIREMENTS
  SOLANA_RPC_URL and DATABASE_URL in ${join(REPO, '.env')} (never printed; only hosts are logged).`);
}

function counterFor() {
    return { getSignaturesForAddress: 0, getTransaction: 0, getMultipleAccounts: 0 };
}

async function call(rpc, counter, method, params) {
    counter[method] = (counter[method] ?? 0) + 1;
    return rpcCall(method, params, { rpc });
}

/**
 * Newest-first signatures of one account, down to its checkpoint (`until`) or to `sinceSec`.
 * Without a checkpoint it also returns the newest successful signature older than `sinceSec`
 * (`olderOk`), which seeds a refresh stream. `complete` is false when the page cap stopped the
 * walk first: the older stretch was not listed.
 */
async function listAccount(rpc, counter, account, { untilSig, sinceSec, maxPages }) {
    const listed = [];
    let before = null;
    let olderOk = null;
    for (let page = 0; page < maxPages; page += 1) {
        const params = { limit: PAGE, ...(before ? { before } : {}), ...(untilSig ? { until: untilSig } : {}) };
        const rows = await call(rpc, counter, 'getSignaturesForAddress', [account, params]);
        await sleep(SIG_PACE_MS);
        let reachedStart = false;
        for (const s of rows) {
            if (!untilSig && Number.isFinite(s.blockTime) && s.blockTime < sinceSec) {
                reachedStart = true;
                if (s.err === null) {
                    olderOk = s;
                    break;
                }
                continue;
            }
            listed.push(s);
        }
        if (reachedStart && (olderOk || rows.length < PAGE)) return { listed, complete: true, olderOk };
        if (rows.length < PAGE) return { listed, complete: true, olderOk };
        before = rows.at(-1).signature;
        if (reachedStart) continue; // still looking for the first successful one before the start
    }
    return { listed, complete: false, olderOk };
}

/** getTransaction, through the optional on-disk cache. */
async function readTransaction(rpc, counter, signature, cacheDir) {
    const path = cacheDir ? join(cacheDir, `${signature}.json`) : null;
    if (path) {
        const cached = await readJson(path, null);
        if (cached) return cached;
    }
    // Version 1 transactions exist since 2026-09 and are refused unless asked for; the JSON shape
    // is the same (message.accountKeys, instructions, meta), so every read asks for up to 1.
    const tx = await call(rpc, counter, 'getTransaction', [signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
    if (tx && path) await writeFile(path, JSON.stringify(tx));
    if (tx) await sleep(TX_PACE_MS);
    return tx;
}

async function readScanState(dbUrl) {
    const out = (await psql(dbUrl, SCAN_STATE_QUERY, 'lending_scan', ['-t', '-A'])).trim();
    const rows = JSON.parse(out || '[]');
    return new Map(rows.map((row) => [row.account, row]));
}

function eta(done, total, startedMs) {
    if (done === 0) return '';
    const s = Math.round(((Date.now() - startedMs) / 1000 / done) * (total - done));
    return ` · ETA ${s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`}`;
}

function usd(value) {
    return typeof value === 'number' && Number.isFinite(value) ? `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : 'USD unknown';
}

function hours(startIso, endIso) {
    const ms = Date.parse(endIso) - Date.parse(startIso);
    return Number.isFinite(ms) ? `${(ms / 3600000).toFixed(ms < 3600000 ? 2 : 1)} h` : '?';
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return;
    }
    const env = await readEnvFile(join(REPO, '.env'));
    const rpc = typeof flags.rpc === 'string' ? flags.rpc : (env.SOLANA_RPC_URL || DEFAULT_RPC);
    const dbUrl = process.env.DATABASE_URL || env.DATABASE_URL || null;
    const noDb = Boolean(flags['no-db']);
    const budget = flags.budget === undefined ? DEFAULT_BUDGET : Number(flags.budget);
    const maxPages = flags['max-pages'] === undefined ? DEFAULT_MAX_PAGES : Number(flags['max-pages']);
    const since = typeof flags.since === 'string' ? flags.since : BACKFILL_FROM;
    const cacheDir = typeof flags['tx-cache'] === 'string' ? flags['tx-cache'] : null;
    if (cacheDir) await mkdir(cacheDir, { recursive: true });
    const sinceSec = unixFromIso(since);
    if (!Number.isInteger(budget) || budget < 0) throw new Error(`--budget must be a whole number >= 0, got ${flags.budget}`);
    if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error(`--max-pages must be >= 1, got ${flags['max-pages']}`);
    if (sinceSec === null) throw new Error(`--since must be an ISO instant, got ${flags.since}`);
    let rpcHost = '(unparseable)';
    try {
        rpcHost = new URL(rpc).host;
    } catch { /* the URL itself is never logged */ }
    log(`watch-lending: rpc ${rpcHost}, budget ${budget} transaction(s), new accounts start ${since}`);

    // --- the watch list ------------------------------------------------------------------------
    const tokens = (await readJson(join(REPO, 'stocks-tokens.json'), null))?.tokens;
    if (!Array.isArray(tokens) || tokens.length === 0) throw new Error('stocks-tokens.json has no tokens — run `npm run stocks:build` first');
    const research = await readJson(join(HERE, 'data', 'protocol-market-research.json'), null);
    if (!research?.oraclePricing) throw new Error('stocks/data/protocol-market-research.json has no oraclePricing block');
    const defiUsage = await readJson(join(HERE, 'data', 'defi-usage.json'), { items: [] });
    const schedule = parseSchedule(usEquitySchedule(await readJson(join(HERE, 'data', 'reference-prices.json'), { items: [] })));
    if (!schedule) logWarn('no US equity schedule in stocks/data/reference-prices.json: Pyth freezes are not checked this run');
    const watch = buildWatchList({ research, defiUsage, tokens });
    const only = typeof flags.only === 'string' ? new Set(flags.only.split(',').map((s) => s.trim())) : null;
    const accounts = watch.accounts.filter((a) => !only || only.has(a.protocol));
    const byRole = {};
    for (const a of accounts) byRole[a.role] = (byRole[a.role] ?? 0) + 1;
    log(`watch list: ${accounts.length} account(s) — ${Object.entries(byRole).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    const stockMints = new Map(Object.entries(watch.stockMints));
    const loanMints = new Map(Object.entries(watch.loanMints));
    const byEntry = reservesByScopeEntry(watch.reserves);

    // --- stored checkpoints ----------------------------------------------------------------------
    let scan = new Map();
    if (noDb) {
        logWarn('--no-db: every account starts at --since and nothing is written');
    } else {
        if (!dbUrl) throw new Error(`DATABASE_URL is not set in ${join(REPO, '.env')} — pass --no-db to run without Postgres`);
        log(`db: ${describeUrl(dbUrl)}`);
        if (flags.ddl) {
            const ddl = await readFile(DDL_FILE, 'utf8');
            log(`db: applying ${relative(REPO, DDL_FILE)} (${ddl.length} bytes, idempotent)`);
            await psql(dbUrl, ddl, 'ddl');
        }
        scan = await readScanState(dbUrl);
        log(`db: ${scan.size} stored checkpoint(s)`);
    }

    const counter = counterFor();
    const failures = [];
    const states = new Map(accounts.map((a) => [a.account, scan.get(a.account)?.state ?? null]));
    const checkpoints = new Map();
    const freezeRows = [];
    const liquidations = [];

    // --- 1. the chain's clock and the Pyth accounts ---------------------------------------------
    const pythAccounts = accounts.filter((a) => a.role === 'pyth-price');
    const readNow = await getAccountsWithContext([CLOCK_SYSVAR, ...pythAccounts.map((a) => a.account)], { rpc, encoding: 'base64' });
    counter.getMultipleAccounts += 1;
    const clockData = readNow.value[0] ? Buffer.from(readNow.value[0].data[0], 'base64') : null;
    const nowTs = clockData ? Number(clockData.readBigInt64LE(32)) : null;
    if (nowTs === null) throw new Error('Clock sysvar could not be read: no chain time for this run');
    log(`chain clock ${isoFromUnix(nowTs)} (slot ${readNow.slot})`);

    // --- 2. list every account since its checkpoint ------------------------------------------------
    const listed = accounts.filter((a) => dueForListing(a.role, scan.get(a.account)?.listedAt, Date.now()));
    const notDue = accounts.filter((a) => LISTED_ROLES.has(a.role)).length - listed.length;
    if (notDue) log(`listing: ${notDue} quiet account(s) not due this run (${Object.entries(LIST_EVERY_HOURS).map(([r, h]) => `${r} every ${h} h`).join(', ')})`);
    const pendingByAccount = new Map();
    const streamListings = new Map();
    let signaturesListed = 0;
    let coverageGaps = 0;
    const listStartedMs = Date.now();
    for (let i = 0; i < listed.length; i += 1) {
        const a = listed[i];
        const prev = scan.get(a.account) ?? null;
        const accountSince = unixFromIso(prev?.backfillFrom) ?? sinceSec;
        try {
            const listing = await listAccount(rpc, counter, a.account, { untilSig: prev?.lastSignature ?? null, sinceSec: accountSince, maxPages });
            signaturesListed += listing.listed.length;
            if (!listing.complete) {
                coverageGaps += 1;
                logWarn(`${a.role} ${a.account}: more than ${maxPages} pages since its checkpoint — the older stretch is not read (coverage gap)`);
            }
            const pending = pendingOldestFirst(listing.listed);
            if (FETCH_ROLES.has(a.role)) pendingByAccount.set(a.account, pending);
            else streamListings.set(a.account, { pending, complete: listing.complete, olderOk: listing.olderOk, first: !prev?.lastSignature });
        } catch (err) {
            failures.push({ kind: 'list', subject: a.account, reason: `${a.role} ${a.account}: ${err.message}` });
            logWarn(`list ${a.role} ${a.account} failed: ${err.message}`);
        }
        if (i % 10 === 9 || i === listed.length - 1) {
            log(`listed [${i + 1}/${listed.length}] ${signaturesListed} new signature(s)${eta(i + 1, listed.length, listStartedMs)}`);
        }
    }

    // --- 3. read the fetched accounts' transactions, oldest slot first ---------------------------
    const { batch, cutSlot: plannedCut, backlog } = selectBatch(pendingByAccount, { budget });
    log(`transactions: ${batch.length} to read this run${backlog ? `, ${backlog} left for the next run(s)` : ''}`);
    const txs = new Map();
    const fetchStartedMs = Date.now();
    for (let i = 0; i < batch.length; i += 1) {
        const entry = batch[i];
        try {
            const tx = await readTransaction(rpc, counter, entry.signature, cacheDir);
            if (tx === null) throw new Error('getTransaction returned null');
            txs.set(entry.signature, tx);
        } catch (err) {
            failures.push({ kind: 'transaction', subject: entry.signature, reason: `${entry.signature.slice(0, 16)}…: ${err.message}` });
            logWarn(`transaction ${entry.signature} failed: ${err.message} — stopping reads here; the rest is read next run`);
            break;
        }
        if (i % 100 === 99 || i === batch.length - 1) log(`read [${i + 1}/${batch.length}]${eta(i + 1, batch.length, fetchStartedMs)}`);
    }
    const cutSlot = txs.size === batch.length ? plannedCut : completedCut(batch, new Set(txs.keys()));
    for (const [account, cp] of advanceCheckpoints(pendingByAccount, cutSlot)) checkpoints.set(account, cp);

    // --- 4. decode, in slot order ------------------------------------------------------------------
    let observationCount = 0;
    let staleObservations = 0;
    let otherCollateral = 0;
    const warnings = {};
    for (const entry of batch) {
        if (!Number.isFinite(cutSlot) || entry.slot > cutSlot) break;
        const tx = txs.get(entry.signature);
        if (!tx) continue;
        const decoded = decodeLendingTransaction(tx, { stockMints, loanMints });
        for (const w of decoded.warnings) warnings[w] = (warnings[w] ?? 0) + 1;
        otherCollateral += decoded.otherCollateralLiquidations;
        liquidations.push(...decoded.liquidations);
        const listedBy = new Set(entry.accounts);
        for (const obs of decoded.observations) {
            const meta = watch.reserves[obs.reserve];
            // Only a reserve whose own list carried this transaction takes its observation, so each
            // reserve's episodes are built from its transactions in order, exactly once.
            if (!meta || !listedBy.has(obs.reserve)) continue;
            observationCount += 1;
            if (obs.stale) staleObservations += 1;
            const { state, emit } = applyReserveObservation(states.get(obs.reserve), obs, { protocol: 'kamino', ...meta, reserve: obs.reserve });
            states.set(obs.reserve, state);
            freezeRows.push(...emit.map(freezeRow));
        }
        if (listedBy.has(SCOPE_CONFIGURATION)) {
            for (const resume of decoded.scopeResumes.filter((r) => !r.failed)) {
                for (const reserve of byEntry.get(resume.entry) ?? []) {
                    const { state, emit } = applyScopeResume(states.get(reserve), resume, { protocol: 'kamino', ...watch.reserves[reserve], reserve });
                    states.set(reserve, state);
                    freezeRows.push(...emit.map(freezeRow));
                }
                log(`scope: ResumeSuspendedPrice entry ${resume.entry} (${resume.label}) at ${resume.at}`);
            }
        }
    }
    for (const [reserve] of Object.entries(watch.reserves)) {
        const open = states.get(reserve)?.open ?? null;
        if (open) freezeRows.push(freezeRow(open));
    }

    // --- 5. Jupiter Lend caches: gaps between successful transactions ------------------------------
    const cacheEpisodes = [];
    for (const [account, listing] of streamListings) {
        const meta = { protocol: 'jupiter-lend', ...watch.caches[account], account };
        let state = states.get(account) ?? {};
        if (listing.first && listing.olderOk) {
            state = { ...state, lastOk: { signature: listing.olderOk.signature, blockTime: listing.olderOk.blockTime, slot: listing.olderOk.slot } };
        }
        const applied = applyCacheSignatures(state, listing.pending, meta, { coverageGap: !listing.complete && !listing.first });
        states.set(account, applied.state);
        cacheEpisodes.push(...applied.emit);
        const ongoing = ongoingCacheEpisode(applied.state, nowTs, meta);
        if (ongoing) cacheEpisodes.push(ongoing);
        const newest = listing.pending.at(-1);
        if (newest) checkpoints.set(account, { signature: newest.signature, slot: newest.slot, blockTime: isoFromUnix(newest.blockTime), consumed: listing.pending.length });
    }
    let causeReads = 0;
    for (const ep of cacheEpisodes) {
        if (causeReads < CAUSE_READS) {
            const events = [];
            for (const sig of [ep.startSignature, ep.endSignature].filter(Boolean)) {
                try {
                    const tx = await readTransaction(rpc, counter, sig, cacheDir);
                    if (tx) events.push(...decodeLendingTransaction(tx, { stockMints }).oracleEvents);
                } catch (err) {
                    failures.push({ kind: 'transaction', subject: sig, reason: `gap boundary ${sig.slice(0, 16)}…: ${err.message}` });
                }
            }
            causeReads += 1;
            const cause = jupiterGapCause(ep, events);
            if (cause) Object.assign(ep, cause);
        }
        freezeRows.push(freezeRow(ep));
    }

    // --- 6. Pyth accounts (Loopscale) ----------------------------------------------------------------
    const session = schedule ? sessionAt(schedule, nowTs * 1000) : 'unknown';
    for (let i = 0; i < pythAccounts.length; i += 1) {
        const a = pythAccounts[i];
        const decoded = readNow.value[i + 1] ? decodePriceUpdateV2(readNow.value[i + 1].data[0]) : null;
        if (!decoded) {
            failures.push({ kind: 'account', subject: a.account, reason: `${a.account}: not a readable PriceUpdateV2 account` });
            continue;
        }
        const meta = { protocol: 'loopscale', marketId: a.marketId, mint: a.mint, symbol: watch.stockMints[a.mint], account: a.account };
        let reading = applyPythReading(states.get(a.account), { publishTs: decoded.publishTs, nowTs, session, maxAgeS: a.maxAgeS }, meta);
        if (reading.needsFirstUpdate) {
            const openStart = states.get(a.account).open.startedTs;
            let firstUpdate = { signature: null, blockTime: decoded.publishTs };
            try {
                const rows = await call(rpc, counter, 'getSignaturesForAddress', [a.account, { limit: PAGE }]);
                const after = rows.filter((s) => s.err === null && s.blockTime > openStart);
                if (after.length) firstUpdate = { signature: after.at(-1).signature, blockTime: after.at(-1).blockTime };
            } catch (err) {
                failures.push({ kind: 'list', subject: a.account, reason: `${a.account}: ${err.message}` });
            }
            reading = applyPythReading(states.get(a.account), { publishTs: decoded.publishTs, nowTs, session, maxAgeS: a.maxAgeS, firstUpdate }, meta);
        }
        states.set(a.account, reading.state);
        freezeRows.push(...reading.emit.map(freezeRow));
        log(`pyth ${watch.stockMints[a.mint]} ${a.account.slice(0, 8)}…: published ${isoFromUnix(decoded.publishTs)} (${hours(isoFromUnix(decoded.publishTs), isoFromUnix(nowTs))} before the chain clock), US market ${session}`);
    }

    // --- 7. liquidation rows (+ Kamino obligation owners) --------------------------------------------
    const liqRows = new Map();
    for (const liq of liquidations) liqRows.set(`${liq.signature}|${liq.invocation}`, liquidationRow(liq, watch));
    const obligations = [...new Set([...liqRows.values()].filter((r) => r.protocol === 'kamino' && r.position && !r.borrower).map((r) => r.position))];
    for (let i = 0; i < obligations.length; i += 100) {
        const chunk = obligations.slice(i, i + 100);
        try {
            const { value } = await getAccountsWithContext(chunk, { rpc, encoding: 'base64' });
            counter.getMultipleAccounts += 1;
            const owners = new Map(chunk.map((o, k) => [o, value[k] ? obligationOwner(value[k].data[0], base58Encode) : null]));
            for (const row of liqRows.values()) if (owners.get(row.position)) row.borrower = owners.get(row.position);
        } catch (err) {
            failures.push({ kind: 'account', subject: 'obligations', reason: `obligation owners: ${err.message}` });
        }
    }

    // --- 8. store ------------------------------------------------------------------------------------
    const freezes = new Map();
    for (const row of freezeRows) freezes.set(`${row.marketId}|${row.mint}|${row.startedAt}`, row);
    const scanRows = [];
    for (const a of accounts) {
        const prev = scan.get(a.account) ?? null;
        const cp = checkpoints.get(a.account) ?? null;
        const listedOk = !LISTED_ROLES.has(a.role) || pendingByAccount.has(a.account) || streamListings.has(a.account);
        if (!listedOk) continue;
        scanRows.push({
            account: a.account, protocol: a.protocol, role: a.role, marketId: a.marketId ?? null, mint: a.mint ?? null,
            backfillFrom: prev?.backfillFrom ?? since,
            lastSignature: cp?.signature ?? prev?.lastSignature ?? null, lastSlot: cp?.slot ?? prev?.lastSlot ?? null,
            lastBlockTime: cp?.blockTime ?? prev?.lastBlockTime ?? null,
            state: states.get(a.account) ?? null,
            signaturesSeen: (Number(prev?.signaturesSeen) || 0) + (cp?.consumed ?? 0),
            listedAt: LISTED_ROLES.has(a.role) ? ts() : null
        });
    }
    const liqList = [...liqRows.values()];
    const freezeList = [...freezes.values()];
    if (!noDb) {
        const statements = [buildLiquidationSql(liqList), buildFreezeSql(freezeList), buildScanSql(scanRows)].filter(Boolean);
        if (statements.length) await psql(dbUrl, wrapTransaction(statements), 'lending rows');
        const hasTrades = (await psql(dbUrl, "SELECT to_regclass('sonar.stock_trade') IS NOT NULL;", 'probe', ['-t', '-A'])).trim() === 't';
        if (hasTrades) await psql(dbUrl, TRADE_PRICE_FILL_SQL, 'trade-tape prices');
        const counts = (await psql(dbUrl, `SELECT (SELECT count(*) FROM sonar.lending_liquidation) || '|' || (SELECT count(*) FROM sonar.lending_price_freeze)
            || '|' || (SELECT count(*) FROM sonar.lending_price_freeze WHERE ended_at IS NULL) || '|' || (SELECT count(*) FROM sonar.lending_scan);`, 'counts', ['-t', '-A'])).trim().split('|');
        log(`db: ${counts[0]} liquidation(s), ${counts[1]} freeze episode(s) (${counts[2]} ongoing), ${counts[3]} checkpoint(s) stored`);
    }

    // --- 9. report -----------------------------------------------------------------------------------
    const ongoing = freezeList.filter((r) => r.endedAt === null);
    log(`watch-lending: ${txs.size} transaction(s) read, ${observationCount} reserve price observation(s) (${staleObservations} stale), `
        + `${liqList.length} stock-collateral liquidation(s), ${otherCollateral} liquidation(s) of other collateral, `
        + `${freezeList.length} freeze episode row(s) written (${ongoing.length} ongoing)`);
    if (Object.keys(warnings).length) logWarn(`decode warnings: ${Object.entries(warnings).map(([k, v]) => `${k} ×${v}`).join(', ')}`);
    if (flags.print || liqList.length || freezeList.length) {
        for (const r of liqList.sort((a, b) => (a.blockTime < b.blockTime ? -1 : 1)).slice(0, flags.print ? liqList.length : 20)) {
            log(`  liquidation ${r.blockTime} ${r.marketId} ${r.symbol} ${r.collateralAmount ?? '?'} (${usd(r.collateralUsd)}) for ${r.debtAmount ?? '?'} ${r.debtSymbol ?? ''} ${r.signature}`);
        }
        for (const r of freezeList.sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1)).slice(0, flags.print ? freezeList.length : 30)) {
            log(`  freeze ${r.marketId} ${r.symbol} ${r.startedAt} → ${r.endedAt ?? `ongoing (seen stale ${r.lastSeenStaleAt})`}`
                + ` ${r.endedAt ? hours(r.startedAt, r.endedAt) : ''} ${r.observation}${r.cause ? ` · ${r.cause}` : ''}`);
        }
    }
    const endedAt = ts();
    const stats = {
        watchStatus: failures.length ? 'partial' : 'ok',
        generatedAt: endedAt,
        lastRunStartedAt: RUN_STARTED_AT,
        lastRunEndedAt: endedAt,
        chainClockAt: isoFromUnix(nowTs),
        rpcHost,
        durationMs: Date.now() - RUN_STARTED_MS,
        accountsWatched: accounts.length,
        accountsListed: pendingByAccount.size + streamListings.size,
        signaturesListed,
        transactionsRead: txs.size,
        backlog,
        coverageGaps,
        observations: observationCount,
        staleObservations,
        liquidations: liqList.length,
        otherCollateralLiquidations: otherCollateral,
        freezeRows: freezeList.length,
        ongoingFreezes: ongoing.length,
        rpcCalls: counter,
        failures: failures.length,
        failureReasons: failures.slice(0, 20).map((f) => f.reason)
    };
    if (!noDb) {
        await writeJson(STATS_FILE, stats);
        const outputs = [join(REPO, 'stocks-collector-status.json')];
        if (process.env.RWA_DOCROOT) outputs.push(join(process.env.RWA_DOCROOT, 'stocks-collector-status.json'));
        await refreshCollectorStatus({ outputs });
    }
    log(`watch-lending: RPC ${Object.entries(counter).map(([k, v]) => `${k} ${v}`).join(', ')} in ${((Date.now() - RUN_STARTED_MS) / 1000).toFixed(0)} s`);
    if (failures.length) {
        logError(`watch-lending: run NOT complete — ${failures.length} read(s) failed:`);
        for (const f of failures.slice(0, 20)) logError(`    ${f.kind}: ${f.reason}`);
        process.exitCode = 1;
        return;
    }
    log(`watch-lending: done${backlog ? ` (${backlog} transaction(s) still queued)` : ''}`);
}

main().catch(async (err) => {
    logError(err.stack || err.message);
    try {
        await writeJson(STATS_FILE, {
            watchStatus: 'failed', generatedAt: ts(), lastRunStartedAt: RUN_STARTED_AT, lastRunEndedAt: ts(),
            durationMs: Date.now() - RUN_STARTED_MS, failures: 1, failureReasons: [err.message]
        });
    } catch (statsError) {
        logError(`watch-lending: could not record the failed outcome: ${statsError.message}`);
    }
    process.exitCode = 1;
});
