#!/usr/bin/env node
// Hourly watcher of issuer powers being USED: every freeze or thaw of one account, permanent-
// delegate transfer or burn out of a holder's account, pause or resume, transfer-fee, default-
// state or authority change signed by a tracked mint's authority key, and every configuration
// change of the Squads v4 multisigs behind those keys. The chain watcher (watch-chain.mjs) reads
// what each mint IS; this reads what its keys DID. Stores sonar.power_use / power_use_daily /
// power_scan (db/2026-10-01-sonar-powers.sql).
//
// All decisions live in lib/powers.mjs (tested on real transactions in stocks/fixtures/powers/);
// this file is the IO: the live mint accounts, listing each address's signatures since its
// checkpoint, reading the transactions within a budget, psql, the stats file and one Telegram.
//
// Restartable: reads are committed in chunks, and each chunk's rows, routine counts and every
// address's checkpoint go into Postgres in ONE transaction, so a kill loses at most the chunk in
// flight and the next run resumes from the checkpoints. A checkpoint only ever passes signatures
// whose transactions were read (or failed on chain), so nothing is skipped silently.

import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { wrapTransaction } from './lib/db-load.mjs';
import { readEnvFile } from './lib/env.mjs';
import { buildOwnerLabels, mintAuthorityAddresses } from './lib/holders.mjs';
import { log, logError, logWarn, parseArgs, readJson, sleep, ts, writeJson } from './lib/io.mjs';
import {
    SCAN_STATE_QUERY, SQUADS_V4_PROGRAM_ID, buildDailySql, buildScanSql, buildUseSql, buildWatchList, classifyUse, committedPrefix,
    decodePowerUses, planReads, proposalActionsQuery, rollupRoutine, squadsVaultOf, summaryText, useRow
} from './lib/powers.mjs';
import { describeUrl, psql } from './lib/psql.mjs';
import { isOnCurve } from './lib/solana-address.mjs';
import { DEFAULT_RPC, getAccountsWithContext, rpcCall } from './lib/solana-rpc.mjs';
import { decodeSquadsMultisig } from './lib/squads.mjs';
import { postTelegram } from './lib/telegram.mjs';
import { XSTOCKS_ISSUER_WALLETS } from './lib/xstocks-float.mjs';

const HERE = import.meta.dirname;
const REPO = join(HERE, '..');
const STATS_FILE = join(REPO, '.last-powers-watch-stats.json');
const RUN_STARTED_MS = Date.now();
const RUN_STARTED_AT = ts(new Date(RUN_STARTED_MS));

const DEFAULT_BUDGET = 1500;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_SINCE_DAYS = 30;
// Routine-only keys (mint, multiplier) start one day back: their history is supply and multiplier
// moves the chain watcher already has, and Backpack's 66 per-mint keys alone carry ~60,000
// signatures a month (measured 2026-09-30).
const DEFAULT_ROUTINE_SINCE_DAYS = 1;
const PAGE = 1000;
const CHUNK = 250;
// getSignaturesForAddress is the heavier call on Alchemy's compute-unit meter (watch-lending.mjs
// measured 2 s as clean while the trade collector runs); the retry ladder absorbs a stray 429.
const SIG_PACE_MS = 1500;
const TX_PACE_MS = 100;
const DISCOVERY_READS = 5;

function usage() {
    console.log(`watch-powers.mjs — uses of issuer powers on Solana stock tokens, and Squads multisig changes

USAGE
  node stocks/watch-powers.mjs --run [options]

OPTIONS
  --run              Actually read the chain. Without it this help is printed and nothing runs.
  --budget=<n>       Max getTransaction reads this run (default ${DEFAULT_BUDGET}); holder-power keys first, oldest first.
  --since=<iso>      Where a never-listed holder-power key or multisig starts (default ${DEFAULT_SINCE_DAYS} days before now).
  --routine-since=<iso>  Where a never-listed routine-only key (mint, multiplier) starts (default ${DEFAULT_ROUTINE_SINCE_DAYS} day before now).
  --max-pages=<n>    Max signature pages (${PAGE} each) listed per address per run (default ${DEFAULT_MAX_PAGES}).
  --only=<list>      Issuers to watch, comma-separated slugs (e.g. xstocks-backed,ondo-global-markets).
  --rpc=<url>        RPC endpoint (default SOLANA_RPC_URL from .env, else ${DEFAULT_RPC}).
  --no-db            Keep nothing: start every address at --since, print what was found, write no rows or stats.
  --no-telegram      Log the summary instead of sending it.
  --print            Print every non-routine use found this run.
  --tx-cache=<dir>   Keep every transaction read as <dir>/<signature>.json and read it from there next time
                     (for developing the decoder and saving fixtures; the hourly job does not use it).
  --help             This text.

WHAT A RUN DOES
  1. Reads every tracked mint account (stocks-tokens.json, getMultipleAccounts jsonParsed, 100 a call)
     and collects its authority keys: mint, freeze, permanent delegate, pause, scaled-UI multiplier,
     and transfer-fee config (not the fee-withdraw key: routine). Keys shared by many mints are watched once.
  2. Adds the Squads v4 multisigs found behind those keys (stored in sonar.power_scan), and reads their
     current configuration in one call.
  3. Lists each address's signatures since its checkpoint, ${SIG_PACE_MS} ms apart (a never-listed one back to --since,
     at most --max-pages pages: coverage then starts later and the run says so).
  4. For an off-curve key never checked, reads one of its transactions to learn whether it is a Squads
     vault (the vault PDA derived from the executing multisig must reproduce the key); a new multisig
     is listed in the same run.
  5. Reads the new transactions (jsonParsed), ${CHUNK} at a time up to --budget, and decodes the power uses
     each key made. Freezes, forced transfers and burns, pauses, fee/state/authority changes and
     Squads config changes are stored one row each; mints, multiplier updates, fee withdrawals and
     delegate actions on issuer-held accounts are counted per day.
  6. After each chunk: rows, counts and checkpoints in one database transaction.
  7. Writes ${relative(REPO, STATS_FILE)}; sends ONE Telegram summary when a holder-affecting use above
     info (a freeze, forced transfer or burn, pause, fee or default-state change) was found or
     something failed. Exits non-zero when any read failed.

COST
  ~15 getMultipleAccounts, one getSignaturesForAddress per address (~100) and one getTransaction per new
  transaction touching a watched key — ~300 an hour (measured 2026-09-30: Backpack's shared key sits in
  every Backpack trade, ~5,000 a day; Ondo's mint key ~600 a day; the xStocks treasury ~1,400 a day).

REQUIREMENTS
  SOLANA_RPC_URL and DATABASE_URL in ${join(REPO, '.env')} (never printed; only hosts are logged).`);
}

function eta(done, total, startedMs) {
    if (done === 0) return '';
    const s = Math.round(((Date.now() - startedMs) / 1000 / done) * (total - done));
    return ` · ETA ${s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`}`;
}

const isoFromUnix = (s) => (Number.isFinite(s) ? new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : null);

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
    const since = typeof flags.since === 'string' ? flags.since : ts(new Date(RUN_STARTED_MS - DEFAULT_SINCE_DAYS * 86400000));
    const sinceSec = Math.floor(Date.parse(since) / 1000);
    const routineSince = typeof flags['routine-since'] === 'string' ? flags['routine-since'] : ts(new Date(RUN_STARTED_MS - DEFAULT_ROUTINE_SINCE_DAYS * 86400000));
    const routineSinceSec = Math.floor(Date.parse(routineSince) / 1000);
    const cacheDir = typeof flags['tx-cache'] === 'string' ? flags['tx-cache'] : null;
    if (cacheDir) await mkdir(cacheDir, { recursive: true });
    if (!Number.isInteger(budget) || budget < 0) throw new Error(`--budget must be a whole number >= 0, got ${flags.budget}`);
    if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error(`--max-pages must be >= 1, got ${flags['max-pages']}`);
    if (!Number.isFinite(sinceSec)) throw new Error(`--since must be an ISO instant, got ${flags.since}`);
    if (!Number.isFinite(routineSinceSec)) throw new Error(`--routine-since must be an ISO instant, got ${flags['routine-since']}`);
    const only = typeof flags.only === 'string' ? new Set(flags.only.split(',').map((s) => s.trim()).filter(Boolean)) : null;
    let rpcHost = '(unparseable)';
    try {
        rpcHost = new URL(rpc).host;
    } catch { /* the URL itself is never logged */ }
    log(`watch-powers: rpc ${rpcHost}, budget ${budget} transaction(s), never-listed keys start ${since} (routine-only keys ${routineSince})${only ? `, only ${[...only].join(', ')}` : ''}`);

    const counter = { getMultipleAccounts: 0, getSignaturesForAddress: 0, getTransaction: 0 };
    const call = async (method, params) => {
        counter[method] = (counter[method] ?? 0) + 1;
        return rpcCall(method, params, { rpc });
    };
    const failures = [];

    // --- 1. the mint accounts and their authority keys --------------------------------------------
    const tokens = (await readJson(join(REPO, 'stocks-tokens.json'), null))?.tokens;
    if (!Array.isArray(tokens) || tokens.length === 0) throw new Error('stocks-tokens.json has no tokens — run `npm run stocks:build` first');
    const selected = tokens.filter((t) => !only || only.has(t.issuer));
    if (selected.length === 0) throw new Error(`--only matched no issuer (${[...only].join(', ')})`);
    const mintAccounts = {};
    for (let i = 0; i < selected.length; i += 100) {
        const chunk = selected.slice(i, i + 100).map((t) => t.mint);
        const { value } = await getAccountsWithContext(chunk, { rpc });
        counter.getMultipleAccounts += 1;
        chunk.forEach((m, k) => { mintAccounts[m] = value[k]; });
    }
    const watch = buildWatchList(mintAccounts, selected, { only });
    if (watch.unreadable.length) {
        failures.push(`${watch.unreadable.length} mint account(s) unreadable (${watch.unreadable.slice(0, 3).join(', ')}…)`);
        logWarn(`${watch.unreadable.length} mint account(s) could not be read as mints — their keys are not watched this run`);
    }
    // Every key named by any mint account (metadata, hook and pointer authorities too) is an issuer
    // wallet for labelling targets, with the dossier-cited xStocks wallets and KNOWN_OWNERS.
    const onchain = await readJson(join(HERE, 'data', 'onchain.json'), { items: [] });
    const labels = buildOwnerLabels(onchain.items, Object.values(mintAccounts).flatMap((a) => mintAuthorityAddresses(a)));
    for (const w of XSTOCKS_ISSUER_WALLETS) if (!labels.has(w.address)) labels.set(w.address, 'issuer-wallet');
    const byRole = {};
    for (const a of watch.addresses.values()) for (const r of a.roles) byRole[r] = (byRole[r] ?? 0) + 1;
    log(`watch list: ${watch.byMint.size} mint(s), ${watch.addresses.size} authority key(s) — ${Object.entries(byRole).map(([k, v]) => `${k} ${v}`).join(', ')}`);

    // --- 2. stored checkpoints and known multisigs --------------------------------------------------
    let scan = new Map();
    if (noDb) {
        logWarn('--no-db: every address starts at --since, no multisig is known in advance, and nothing is written');
    } else {
        if (!dbUrl) throw new Error(`DATABASE_URL is not set in ${join(REPO, '.env')} — pass --no-db to run without Postgres`);
        log(`db: ${describeUrl(dbUrl)}`);
        const out = (await psql(dbUrl, SCAN_STATE_QUERY, 'power_scan', ['-t', '-A'])).trim();
        scan = new Map(JSON.parse(out || '[]').map((r) => [r.address, r]));
        log(`db: ${scan.size} stored checkpoint(s)`);
    }
    const watched = new Map(); // address → {address, kind, roles:Set, issuers:Set, priority, state}
    for (const a of watch.addresses.values()) watched.set(a.address, { ...a, state: scan.get(a.address)?.state ?? {} });
    const addMultisig = (multisig, vault, vaultIndex, issuers) => {
        const entry = watched.get(multisig) ?? { address: multisig, kind: 'squads-multisig', roles: new Set(['squads-multisig']), issuers: new Set(), priority: 1, state: scan.get(multisig)?.state ?? {} };
        for (const i of issuers) entry.issuers.add(i);
        const vaults = new Set(entry.state.vaults ?? []);
        vaults.add(`${vault}#${vaultIndex}`);
        entry.state = { ...entry.state, vaults: [...vaults].sort() };
        watched.set(multisig, entry);
        return entry;
    };
    for (const a of [...watched.values()]) {
        const sq = a.state?.squads;
        if (sq?.multisig) addMultisig(sq.multisig, a.address, sq.vaultIndex, a.issuers);
    }
    const multisigSet = () => new Set([...watched.values()].filter((a) => a.kind === 'squads-multisig').map((a) => a.address));

    // --- 3. list every address since its checkpoint ------------------------------------------------
    const listings = new Map(); // address → {priority, pending (oldest first), complete, olderOk, first}
    let signaturesListed = 0;
    let coverageGaps = 0;
    async function listAddress(a) {
        const prev = scan.get(a.address) ?? null;
        const untilSig = prev?.lastSignature ?? null;
        const startSec = a.priority === 1 ? sinceSec : Math.max(sinceSec, routineSinceSec);
        const floor = untilSig ? null : (Math.floor(Date.parse(prev?.backfillFrom ?? '') / 1000) || startSec);
        const listed = [];
        let before = null;
        let olderOk = null;
        let complete = false;
        for (let page = 0; page < maxPages; page += 1) {
            const rows = await call('getSignaturesForAddress', [a.address, { limit: PAGE, ...(before ? { before } : {}), ...(untilSig ? { until: untilSig } : {}) }]);
            await sleep(SIG_PACE_MS);
            let reachedFloor = false;
            for (const s of rows) {
                if (floor !== null && Number.isFinite(s.blockTime) && s.blockTime < floor) {
                    reachedFloor = true;
                    if (s.err === null) { olderOk = s; break; }
                    continue;
                }
                listed.push(s);
            }
            if (rows.length < PAGE || (reachedFloor && olderOk)) { complete = true; break; }
            before = rows.at(-1).signature;
        }
        const pending = listed.slice().reverse();
        signaturesListed += pending.length;
        if (!complete) {
            coverageGaps += 1;
            const to = isoFromUnix(pending[0]?.blockTime) ?? null;
            logWarn(`${a.kind} ${a.address}: more than ${maxPages} page(s) since ${untilSig ? 'its checkpoint' : isoFromUnix(startSec)} — `
                + `coverage starts at ${to ?? '?'}, the older stretch is not read`);
            // A never-listed address records where coverage starts in backfill_from; a later gap is
            // kept in its state so the missing stretch stays visible.
            if (prev) {
                const gap = { from: untilSig ? prev.lastBlockTime : prev.backfillFrom, to, seenAt: RUN_STARTED_AT };
                a.state = { ...a.state, coverageGaps: [...(a.state?.coverageGaps ?? []), gap].slice(-20) };
            }
        }
        listings.set(a.address, { priority: a.priority, pending, complete, olderOk, first: !untilSig, start: isoFromUnix(startSec) });
    }
    const order = [...watched.values()].sort((x, y) => x.priority - y.priority);
    const listStartedMs = Date.now();
    for (let i = 0; i < order.length; i += 1) {
        const a = order[i];
        try {
            await listAddress(a);
        } catch (err) {
            failures.push(`list ${a.address}: ${err.message}`);
            logWarn(`list ${a.kind} ${a.address} failed: ${err.message}`);
        }
        if (i % 10 === 9 || i === order.length - 1) log(`listed [${i + 1}/${order.length}] ${signaturesListed} new signature(s)${eta(i + 1, order.length, listStartedMs)}`);
    }

    // --- 4. transactions: read once, through the optional on-disk cache ------------------------------
    const txs = new Map();
    const readOk = new Set();
    async function readTransaction(signature) {
        if (txs.has(signature)) return txs.get(signature);
        const path = cacheDir ? join(cacheDir, `${signature}.json`) : null;
        let tx = path ? await readJson(path, null) : null;
        if (!tx) {
            // Version-1 transactions exist since 2026-09 and are refused unless asked for; jsonParsed
            // reads them with the same shape (fetch-recent-trades.mjs, companions.mjs).
            tx = await call('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
            if (tx === null) throw new Error('getTransaction returned null');
            if (!Number.isFinite(tx.blockTime)) throw new Error('transaction has no block time');
            if (path) await writeFile(path, JSON.stringify(tx));
            await sleep(TX_PACE_MS);
        }
        txs.set(signature, tx);
        readOk.add(signature);
        return tx;
    }

    // Squads discovery: an off-curve key never checked gets up to DISCOVERY_READS of its newest
    // successful transactions read. A key that only ever appears as a referenced account (the
    // xStocks delegate vault sits in every new mint's initialisation) can still look plain here;
    // every transaction processed later is checked too (see `noteSquads`), so the first time such a
    // vault executes, its multisig is found and watched from the next run.
    let discovered = 0;
    const noteSquads = (a, found) => {
        a.state = { ...a.state, squads: found, squadsCheckedAt: RUN_STARTED_AT, keyType: 'off-curve' };
        if (!found) return null;
        discovered += 1;
        log(`squads: ${a.address} is vault ${found.vaultIndex} of multisig ${found.multisig}`);
        return addMultisig(found.multisig, a.address, found.vaultIndex, a.issuers);
    };
    for (const a of [...watched.values()].filter((x) => x.kind === 'authority' && !x.state?.squadsCheckedAt)) {
        if (isOnCurve(a.address)) {
            a.state = { ...a.state, squads: null, squadsCheckedAt: RUN_STARTED_AT, keyType: 'on-curve' };
            continue;
        }
        const listing = listings.get(a.address);
        const samples = [...(listing?.pending ?? [])].reverse().filter((s) => s.err === null).slice(0, DISCOVERY_READS);
        if (listing?.olderOk && samples.length < DISCOVERY_READS) samples.push(listing.olderOk);
        if (!samples.length) continue; // never used: checked again next run
        try {
            let found = null;
            for (const s of samples) {
                found = squadsVaultOf(await readTransaction(s.signature), a.address);
                if (found) break;
            }
            const m = noteSquads(a, found);
            if (m && !listings.has(m.address)) {
                try { await listAddress(m); } catch (err) { failures.push(`list ${m.address}: ${err.message}`); }
            }
        } catch (err) {
            failures.push(`discovery ${a.address}: ${err.message}`);
            logWarn(`squads discovery for ${a.address} failed: ${err.message}`);
        }
    }

    // Multisig configuration as it stands now (one call), for the record and as a cross-check.
    const multisigs = [...multisigSet()];
    const configChanges = [];
    if (multisigs.length) {
        try {
            const { value } = await getAccountsWithContext(multisigs, { rpc, encoding: 'base64' });
            counter.getMultipleAccounts += 1;
            multisigs.forEach((address, k) => {
                const decoded = value[k] ? decodeSquadsMultisig(value[k].data[0]) : null;
                const entry = watched.get(address);
                if (!decoded) { failures.push(`multisig ${address}: not a readable Squads v4 account`); return; }
                const config = { threshold: decoded.threshold, timeLockSeconds: decoded.timeLockSeconds, configAuthority: decoded.configAuthority,
                    members: decoded.members.map((m) => `${m.key}:${m.mask}`).sort() };
                const before = entry.state?.config ?? null;
                // Field by field: the stored copy comes back from jsonb with its keys reordered.
                const same = before && ['threshold', 'timeLockSeconds', 'configAuthority'].every((k) => before[k] === config[k])
                    && JSON.stringify(before.members ?? []) === JSON.stringify(config.members);
                if (before && !same) {
                    configChanges.push(address);
                    logWarn(`squads: multisig ${address} configuration differs from the last read (threshold ${before.threshold}→${config.threshold}, `
                        + `time lock ${before.timeLockSeconds}→${config.timeLockSeconds}, members ${before.members.length}→${config.members.length})`);
                }
                entry.state = { ...entry.state, config, configReadAt: RUN_STARTED_AT };
                log(`squads: ${address} threshold ${config.threshold} of ${config.members.length}, time lock ${config.timeLockSeconds} s, `
                    + `config authority ${config.configAuthority ?? 'none (the multisig itself)'}`);
            });
        } catch (err) {
            failures.push(`multisig accounts: ${err.message}`);
        }
    }

    // --- 5–6. read in chunks; after each, store what every address can now commit ---------------------
    const { toRead, backlog } = planReads(listings, { budget });
    const discoveryReads = txs.size;
    log(`transactions: ${toRead.length} to read this run${backlog ? `, ${backlog} left for later run(s)` : ''}${discoveryReads ? ` (+${discoveryReads} read for Squads discovery)` : ''}`);
    const committed = new Map([...listings.keys()].map((a) => [a, 0])); // pending entries already stored
    const proposals = new Map(); // config transaction PDA → actions
    const allRows = [];
    const decodeWarnings = {};
    let routineUses = 0;
    let readFailed = false;
    const fetchStartedMs = Date.now();
    const decodedCache = new Map();
    const decodeTx = (sig) => {
        if (!decodedCache.has(sig)) {
            const r = decodePowerUses(txs.get(sig), { byMint: watch.byMint, watched: new Set(watch.addresses.keys()), multisigs: multisigSet() });
            for (const w of r.warnings) decodeWarnings[w] = (decodeWarnings[w] ?? 0) + 1;
            decodedCache.set(sig, r.uses);
        }
        return decodedCache.get(sig);
    };

    for (let c = 0; c <= toRead.length; c += CHUNK) {
        const chunk = toRead.slice(c, c + CHUNK);
        for (let i = 0; i < chunk.length && !readFailed; i += 1) {
            try {
                await readTransaction(chunk[i]);
            } catch (err) {
                failures.push(`transaction ${chunk[i]}: ${err.message}`);
                logWarn(`transaction ${chunk[i]} failed: ${err.message} — stopping reads here; the rest is read next run`);
                readFailed = true;
            }
        }
        if (chunk.length) log(`read [${Math.min(c + chunk.length, toRead.length)}/${toRead.length}]${eta(c + chunk.length, toRead.length, fetchStartedMs)}`);

        // What each address may commit now: the new part of its fully-read oldest-first prefix.
        const newUses = [];
        const scanRows = [];
        for (const [address, listing] of listings) {
            const a = watched.get(address);
            const prefix = committedPrefix(listing.pending, readOk);
            const from = committed.get(address);
            const fresh = prefix.slice(from);
            const isLastChunk = c + CHUNK > toRead.length || readFailed;
            if (fresh.length === 0 && !(isLastChunk && from === 0)) continue;
            for (const s of fresh) {
                if (s.err !== null && s.err !== undefined) continue;
                for (const use of decodeTx(s.signature)) if (use.authority === address) newUses.push(use);
                if (a.kind === 'authority' && a.state?.keyType === 'off-curve' && !a.state?.squads
                    && txs.get(s.signature)?.transaction?.message?.instructions?.some((ix) => ix.programId === SQUADS_V4_PROGRAM_ID)) {
                    noteSquads(a, squadsVaultOf(txs.get(s.signature), address)); // its multisig is listed from the next run
                }
            }
            committed.set(address, prefix.length);
            const prev = scan.get(address) ?? null;
            const last = prefix.at(-1) ?? null;
            // A never-used address in its window checkpoints at the newest signature before it.
            const seed = !last && listing.first && listing.complete && listing.olderOk ? listing.olderOk : null;
            const cp = last ?? seed;
            const backfillFrom = prev?.backfillFrom ?? (listing.complete ? listing.start : (isoFromUnix(listing.pending[0]?.blockTime) ?? listing.start));
            scanRows.push({
                address, kind: a.kind, roles: [...a.roles].sort(), issuers: [...a.issuers].sort(), backfillFrom,
                lastSignature: cp?.signature ?? prev?.lastSignature ?? null, lastSlot: cp?.slot ?? prev?.lastSlot ?? null,
                lastBlockTime: isoFromUnix(cp?.blockTime) ?? prev?.lastBlockTime ?? null, state: a.state ?? null,
                signaturesSeen: (Number(prev?.signaturesSeen) || 0) + prefix.length, listedAt: ts()
            });
        }
        if (!scanRows.length && !newUses.length) { if (readFailed) break; continue; }

        // Owners the transaction did not reveal (a closed or untouched account): the account as it is now.
        const unknown = [...new Set(newUses.filter((u) => u.targetAccount && !u.targetOwner && u.mint).map((u) => u.targetAccount))];
        for (let i = 0; i < unknown.length; i += 100) {
            const part = unknown.slice(i, i + 100);
            try {
                const { value } = await getAccountsWithContext(part, { rpc });
                counter.getMultipleAccounts += 1;
                const owners = new Map(part.map((acc, k) => [acc, value[k]?.data?.parsed?.info?.owner ?? null]));
                for (const u of newUses) {
                    if (u.targetAccount && !u.targetOwner && owners.get(u.targetAccount)) {
                        u.targetOwner = owners.get(u.targetAccount);
                        u.detail = { ...u.detail, ownerSource: 'current-account' };
                    }
                }
            } catch (err) {
                failures.push(`owner lookup: ${err.message}`);
            }
        }

        const rows = [];
        const routine = [];
        for (const use of newUses) {
            const cls = classifyUse(use, labels);
            if (cls.routine) { routine.push({ use, cls }); continue; }
            if (use.action === 'squads-config-proposed') proposals.set(use.targetAccount, use.detail.actions);
            rows.push(useRow(use, cls, { byMint: watch.byMint, issuersOf: (address) => [...(watched.get(address)?.issuers ?? [])] }));
        }
        // An execution carries the actions of its proposal (this run, or stored by an earlier one).
        const executed = rows.filter((r) => r.action === 'squads-config-executed');
        const missing = executed.filter((r) => !proposals.has(r.targetAccount)).map((r) => r.targetAccount);
        if (missing.length && !noDb) {
            const stored = JSON.parse((await psql(dbUrl, proposalActionsQuery(missing), 'proposals', ['-t', '-A'])).trim() || '{}');
            for (const [k, v] of Object.entries(stored)) proposals.set(k, v);
        }
        for (const r of executed) r.detail = { ...r.detail, actions: proposals.get(r.targetAccount) ?? null, ...(proposals.has(r.targetAccount) ? {} : { actionsUnknown: 'proposal before coverage' }) };
        const daily = rollupRoutine(routine);
        routineUses += routine.length;
        allRows.push(...rows);
        if (!noDb) {
            const statements = [buildUseSql(rows), buildDailySql(daily), buildScanSql(scanRows)].filter(Boolean);
            if (statements.length) await psql(dbUrl, wrapTransaction(statements), 'power rows');
        }
        if (rows.length || routine.length) log(`stored: ${rows.length} power use(s), ${routine.length} routine use(s) in ${daily.length} daily count(s), ${scanRows.length} checkpoint(s)`);
        if (readFailed) break;
    }

    // --- 7. report ------------------------------------------------------------------------------------
    const holderRows = allRows.filter((r) => r.holderAffecting);
    const configRows = allRows.filter((r) => r.action.startsWith('squads-config-') && r.action !== 'squads-config-proposed');
    log(`watch-powers: ${readOk.size} transaction(s) read, ${allRows.length} power use(s) stored (${holderRows.length} holder-affecting, `
        + `${configRows.length} multisig change(s)), ${routineUses} routine use(s) counted${discovered ? `, ${discovered} Squads vault(s) found` : ''}`);
    if (Object.keys(decodeWarnings).length) logWarn(`decode warnings: ${Object.entries(decodeWarnings).map(([k, v]) => `${k} ×${v}`).join(', ')}`);
    const shown = flags.print ? allRows : allRows.filter((r) => r.holderAffecting || r.severity !== 'info').slice(0, 40);
    for (const r of shown.sort((x, y) => (x.blockTime < y.blockTime ? -1 : 1))) {
        log(`  ${r.blockTime} ${r.severity.padEnd(8)} ${(r.issuer ?? '-').padEnd(22)} ${r.action.padEnd(22)} ${r.symbol ?? r.mint ?? r.authority} `
            + `${r.amount ?? ''} ${r.targetOwner ? `owner ${r.targetOwner}${r.targetLabel ? ` (${r.targetLabel})` : ''}` : ''}`
            + `${r.detail?.actions ? ` ${JSON.stringify(r.detail.actions)}` : ''} ${r.signature}`);
    }
    const endedAt = ts();
    const stats = {
        watchStatus: failures.length ? 'partial' : 'ok',
        generatedAt: endedAt,
        lastRunStartedAt: RUN_STARTED_AT,
        lastRunEndedAt: endedAt,
        rpcHost,
        durationMs: Date.now() - RUN_STARTED_MS,
        mintsWatched: watch.byMint.size,
        addressesWatched: watched.size,
        multisigsWatched: multisigSet().size,
        signaturesListed,
        transactionsRead: readOk.size,
        powerUses: allRows.length,
        holderAffecting: holderRows.length,
        multisigChanges: configRows.length,
        routineUses,
        backlog: backlog + (readFailed ? toRead.length - [...toRead].filter((s) => readOk.has(s)).length : 0),
        coverageGaps,
        multisigConfigDrift: configChanges.length,
        rpcCalls: counter,
        failures: failures.length,
        failureReasons: failures.slice(0, 20)
    };
    if (!noDb) await writeJson(STATS_FILE, stats);
    const text = summaryText({ holderRows, configRows, failures, stats });
    if (text) {
        if (flags['no-telegram']) {
            log('--no-telegram: the summary is logged instead');
            for (const line of text.split('\n')) log(`telegram | ${line}`);
        } else {
            await postTelegram(text, { env });
        }
    }
    log(`watch-powers: RPC ${Object.entries(counter).map(([k, v]) => `${k} ${v}`).join(', ')} in ${((Date.now() - RUN_STARTED_MS) / 1000).toFixed(0)} s`);
    if (failures.length) {
        logError(`watch-powers: run NOT complete — ${failures.length} failure(s):`);
        for (const f of failures.slice(0, 20)) logError(`    ${f}`);
        process.exitCode = 1;
        return;
    }
    log(`watch-powers: done${stats.backlog ? ` (${stats.backlog} transaction(s) still queued)` : ''}`);
}

main().catch(async (err) => {
    logError(err.stack || err.message);
    try {
        await writeJson(STATS_FILE, {
            watchStatus: 'failed', generatedAt: ts(), lastRunStartedAt: RUN_STARTED_AT, lastRunEndedAt: ts(),
            durationMs: Date.now() - RUN_STARTED_MS, failures: 1, failureReasons: [err.message]
        });
    } catch (statsError) {
        logError(`watch-powers: could not record the failed outcome: ${statsError.message}`);
    }
    process.exitCode = 1;
});
