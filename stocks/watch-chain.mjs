#!/usr/bin/env node
// The hourly on-chain watcher (stocks/EVIDENCE.md §2.4): reads every universe mint's account and
// the labelled treasury/authority wallets, stores each NEW state in sonar.mint_state /
// sonar.wallet_balance, and writes a sonar.change_event row for every difference against the last
// stored state — a rotated authority key, an extension toggled, a rebase, a supply move past 1 %, a
// changed metadata document, a treasury balance moving. One Telegram summary per run.
//
// The daily document watcher (watch-sources.mjs) does the same job for the PDFs and pages the
// dossiers cite; this is its on-chain half, and the two share lib/watch.mjs's outcome taxonomy,
// lib/db-load.mjs's SQL helpers and sonar.change_event.
//
// All the decisions live in lib/chainwatch.mjs and are unit tested (chainwatch.test.js); this file
// is the IO: RPC batching and pacing, the metadata fetches, psql, the summary.
//
// No checkpoint, deliberately: a run is ~50 RPC calls and about a minute, every insert is
// idempotent on (mint, observed_at), and a state must be read at one instant to be a coherent
// reading. A kill therefore loses at most one hourly pass and can never lose correctness — so the
// run prints progress instead of writing a resume file it would have to invalidate anyway.

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

import {
    METADATA_LIMIT, WALLET_LIMIT, baselineEvents, buildLatestBalanceQuery, buildLatestStateQuery,
    buildMintStateSql, buildWalletBalanceSql, buildWalletIndex, countBy, diffStates,
    formatTelegramSummary, parseMintState, parseStateRows, selectMetadataFetches,
    selectWatchedWallets, stateHash, uiAmount, walletMoves
} from './lib/chainwatch.mjs';
import { ISSUER_FREEZE_AUTHORITIES, ISSUER_MINT_AUTHORITIES } from './lib/classify.mjs';
import { buildChangeEventSql, decideOutcome } from './lib/watch.mjs';
import { wrapTransaction } from './lib/db-load.mjs';
import { readEnvFile } from './lib/env.mjs';
import { buildOwnerLabels } from './lib/holders.mjs';
import { byString, log, logError, logWarn, parseArgs, readJson, sleep, ts, writeJson } from './lib/io.mjs';
import { describeUrl, psql } from './lib/psql.mjs';
import {
    DEFAULT_RPC, MAX_ACCOUNTS_PER_REQUEST, fetchMintAccounts, getAccountsWithContext,
    getTokenAccountsByOwner
} from './lib/solana-rpc.mjs';
import { postTelegram } from './lib/telegram.mjs';
import { refreshCollectorStatus } from './build-collector-status.mjs';

const HERE = import.meta.dirname;
const REPO = join(HERE, '..');
const TOKENS_FILE = join(REPO, 'stocks-tokens.json');
const ONCHAIN_FILE = join(HERE, 'data', 'onchain.json');
const DDL_FILE = join(REPO, 'db', '2026-09-18-sonar-chain.sql');
const STATS_FILE = join(REPO, '.last-chain-watch-stats.json');
const RUN_STARTED_MS = Date.now();
const RUN_STARTED_AT = ts(new Date(RUN_STARTED_MS));

const BATCH_PACE_MS = 250;
const WALLET_PACE_MS = 250;
const METADATA_PACE_MS = 1000;
const METADATA_TIMEOUT_MS = 10_000;
const SOL_DECIMALS = 9;

function usage() {
    console.log(`watch-chain.mjs — hourly on-chain watcher: mint state, authorities, treasuries

USAGE
  node stocks/watch-chain.mjs --run [options]

OPTIONS
  --run             Actually read the chain. Without it this help is printed and nothing runs.
  --ddl             Apply db/${DDL_FILE.split('/').pop()} before loading. Idempotent.
  --only=<issuer>   Only this issuer's mints (e.g. --only=xstocks-backed).
  --limit=<n>       Only the first n mints after filtering (smoke test).
  --rpc=<url>       RPC endpoint (default SOLANA_RPC_URL from .env, else ${DEFAULT_RPC}).
  --wallets=<n>     Labelled wallets to read, default ${WALLET_LIMIT} (0 skips the treasury pass).
  --metadata=<n>    Metadata documents to fetch, default ${METADATA_LIMIT} (0 skips them).
  --no-db           Read and compare nothing; fetch, parse and print only. No previous state is
                    available without the DB, so this reports states and never events.
  --no-telegram     Never send the summary, whatever is in .env. It is still logged.
  --help            This text.

WHAT A RUN DOES
  1. Reads every mint in stocks-tokens.json with getMultipleAccounts (jsonParsed, ${MAX_ACCOUNTS_PER_REQUEST} per call,
     ${BATCH_PACE_MS} ms apart) and flattens the Token-2022 extensions into one comparable state per mint,
     keeping the response's context.slot as the chain's own clock for that reading.
  2. Fetches up to ${METADATA_LIMIT} metadata JSON documents (the ones never hashed, and any whose URI moved)
     and hashes the body — the metadata is a document, watched like any other.
  3. Reads the SOL and token balances of up to ${WALLET_LIMIT} labelled wallets (issuer authorities and the
     burn address this repo can name), one getTokenAccountsByOwner call each.
  4. Compares each state against the latest row in sonar.mint_state. Same state_hash -> nothing is
     written at all. A difference -> one new state row plus a change event per changed field
     (authority-key, extension-toggle, rebase, supply, metadata, treasury).
  5. A mint read for the first time raises NO field events; its issuer gets one info "baseline
     recorded" event instead.
  6. Sends ONE Telegram summary when there are events or failures, writes ${relative(REPO, STATS_FILE)},
     and exits non-zero if any mint, wallet or document failed for a reason that is ours.

COST
  About ${Math.ceil(471 / MAX_ACCOUNTS_PER_REQUEST) + 1 + WALLET_LIMIT} RPC calls per run at the full universe: ${Math.ceil(471 / MAX_ACCOUNTS_PER_REQUEST)} account batches, 1 for the wallets' SOL
  balances and one per labelled wallet. Metadata documents are plain HTTPS, not RPC.

FILES
  stocks-tokens.json                  the universe (mint, symbol, issuer) — built by build-stocks-db
  stocks/data/onchain.json            which addresses are authorities, for the wallet labels
  sonar.mint_state / sonar.wallet_balance / sonar.change_event   the record in Postgres
  ${relative(REPO, STATS_FILE)}          last run's counts, for an outcome check

REQUIREMENTS
  SOLANA_RPC_URL and DATABASE_URL in ${join(REPO, '.env')} (never printed; only hosts are logged).
  TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are optional: without them the summary is logged.`);
}

/** sha256 of a metadata document's bytes, exactly as served. */
function hashBody(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Fetch one metadata JSON document and hash it. The verdict comes from lib/watch.mjs
 * `decideOutcome`, so a 404 is the same "gone" finding here as it is for a cited PDF and a 5xx is
 * the same failure — one taxonomy, not two.
 */
async function fetchMetadata(uri) {
    try {
        const res = await fetch(uri, {
            headers: { accept: 'application/json,*/*' },
            signal: AbortSignal.timeout(METADATA_TIMEOUT_MS)
        });
        const body = await res.text();
        const outcome = decideOutcome({ httpStatus: res.status });
        if (outcome.status === 'ok' || outcome.status === 'changed') {
            return { hash: hashBody(body), bytes: body.length, status: 'fetched', reason: `http-${res.status}` };
        }
        return { hash: null, bytes: body.length, status: outcome.status, reason: outcome.reason };
    } catch (err) {
        const code = err.name === 'TimeoutError' ? 'ETIMEDOUT' : (err.cause?.code ?? err.code ?? 'EFETCH');
        const outcome = decideOutcome({ networkErrorCode: code });
        return { hash: null, bytes: 0, status: outcome.status, reason: `${outcome.reason}: ${err.message}` };
    }
}

/** The latest stored state per mint, keyed by mint. Empty when the table is empty. */
async function readPreviousStates(dbUrl) {
    const out = await psql(dbUrl, buildLatestStateQuery(), 'latest mint_state', ['-t', '-A']);
    const rows = parseStateRows(out);
    return new Map(rows.map((row) => [row.mint, row]));
}

async function readPreviousBalances(dbUrl) {
    const out = await psql(dbUrl, buildLatestBalanceQuery(), 'latest wallet_balance', ['-t', '-A']);
    return parseStateRows(out);
}

function progress(done, total, startedMs) {
    const pct = total === 0 ? 100 : Math.round((done / total) * 100);
    const elapsed = (Date.now() - startedMs) / 1000;
    const eta = done === 0 ? null : Math.round((elapsed / done) * (total - done));
    return `${done}/${total} ${pct}%${eta === null ? '' : ` ETA ${eta}s`}`;
}

/**
 * Read the labelled wallets: one getMultipleAccounts for every wallet's lamports, then one
 * getTokenAccountsByOwner per wallet. Only balances in mints we watch are recorded — a labelled
 * key's position in some unrelated memecoin is not evidence about a tokenized share, and keeping it
 * would make the table unbounded.
 */
async function readWallets(watched, { rpc, watchedMints, failures }) {
    const balances = [];
    if (watched.length === 0) return balances;

    const labelByWallet = new Map(watched.map((w) => [w.wallet, w.label]));
    const addresses = watched.map((w) => w.wallet);
    let noAccount = 0;
    for (let i = 0; i < addresses.length; i += MAX_ACCOUNTS_PER_REQUEST) {
        const batch = addresses.slice(i, i + MAX_ACCOUNTS_PER_REQUEST);
        const observedAt = ts();
        const { value } = await getAccountsWithContext(batch, { rpc });
        batch.forEach((wallet, idx) => {
            const entry = value[idx] ?? null;
            // A null entry is the RPC saying the account does not exist, and an address with no
            // account on Solana holds no lamports — so 0 is the chain's answer, not a guess. A
            // present account whose lamports are not a number IS a malformed response and is
            // reported rather than read as 0.
            if (entry === null) noAccount += 1;
            const lamports = entry === null ? 0 : entry.lamports;
            if (typeof lamports !== 'number' || !Number.isFinite(lamports)) {
                failures.push({ kind: 'wallet', subject: wallet, reason: `${wallet}: account has no numeric lamports` });
                return;
            }
            balances.push({
                wallet,
                mint: null,
                label: labelByWallet.get(wallet) ?? null,
                observedAt,
                amount: uiAmount(String(lamports), SOL_DECIMALS)
            });
        });
        if (i + MAX_ACCOUNTS_PER_REQUEST < addresses.length) await sleep(BATCH_PACE_MS);
    }
    if (noAccount) log(`wallets: ${noAccount} labelled address(es) have no account on chain — recorded as 0 SOL`);

    const startedMs = Date.now();
    for (let i = 0; i < watched.length; i += 1) {
        const entry = watched[i];
        try {
            const observedAt = ts();
            const { accounts } = await getTokenAccountsByOwner(entry.wallet, { rpc });
            // One owner can hold several token accounts in the same mint, so the position is their
            // SUM, not whichever the RPC happened to list first. Summed in base units with BigInt:
            // adding two UI amounts as doubles would round a large treasury position.
            const byMint = new Map();
            for (const account of accounts) {
                if (account.mint === null || !watchedMints.has(account.mint)) continue;
                if (typeof account.amount !== 'string' || !/^\d+$/.test(account.amount)) continue;
                if (account.decimals === null) continue;
                const held = byMint.get(account.mint) ?? { raw: 0n, decimals: account.decimals };
                held.raw += BigInt(account.amount);
                byMint.set(account.mint, held);
            }
            for (const [mint, held] of [...byMint.entries()].sort((a, b) => byString(a[0], b[0]))) {
                balances.push({
                    wallet: entry.wallet,
                    mint,
                    label: entry.label,
                    observedAt,
                    amount: uiAmount(held.raw.toString(), held.decimals)
                });
            }
        } catch (err) {
            failures.push({ kind: 'wallet', subject: entry.wallet, reason: `${entry.wallet}: ${err.message}` });
            logWarn(`wallet ${entry.wallet} failed: ${err.message}`);
        }
        if (i % 10 === 9 || i === watched.length - 1) {
            log(`wallets [${progress(i + 1, watched.length, startedMs)}]`);
        }
        if (i < watched.length - 1) await sleep(WALLET_PACE_MS);
    }
    return balances;
}

async function loadToPostgres({ states, balances, events }, { url, applyDdl }) {
    if (applyDdl) {
        const ddl = await readFile(DDL_FILE, 'utf8');
        log(`db: applying ${relative(REPO, DDL_FILE)} (${ddl.length} bytes, idempotent)`);
        await psql(url, ddl, 'ddl');
    }
    if (states.length) {
        const sql = buildMintStateSql(states);
        log(`db: ${sql.rows} new mint_state row(s)`);
        await psql(url, wrapTransaction(sql.sql), sql.table);
    }
    if (balances.length) {
        const sql = buildWalletBalanceSql(balances);
        log(`db: ${sql.rows} wallet_balance row(s)`);
        await psql(url, wrapTransaction(sql.sql), sql.table);
    }
    if (events.length) {
        const sql = buildChangeEventSql(events);
        log(`db: ${sql.rows} change_event row(s) offered`);
        await psql(url, wrapTransaction(sql.sql), sql.table);
    }
    const counts = await psql(url,
        "SELECT 'mint_state' AS t, count(*) FROM sonar.mint_state"
        + " UNION ALL SELECT 'wallet_balance', count(*) FROM sonar.wallet_balance"
        + " UNION ALL SELECT 'change_event', count(*) FROM sonar.change_event ORDER BY 1;\n",
        'counts', ['-t', '-A', '-F', '|']);
    for (const line of counts.trim().split('\n').filter(Boolean)) {
        const [table, n] = line.split('|');
        log(`  sonar.${table}: ${n} rows`);
    }
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return;
    }
    const startedMs = RUN_STARTED_MS;
    const env = await readEnvFile(join(REPO, '.env'));
    const rpc = typeof flags.rpc === 'string' ? flags.rpc : (env.SOLANA_RPC_URL || DEFAULT_RPC);
    const dbUrl = process.env.DATABASE_URL || env.DATABASE_URL || null;
    const walletLimit = flags.wallets === undefined ? WALLET_LIMIT : Number(flags.wallets);
    const metadataLimit = flags.metadata === undefined ? METADATA_LIMIT : Number(flags.metadata);
    if (!Number.isFinite(walletLimit) || walletLimit < 0) throw new Error(`--wallets must be >= 0, got ${flags.wallets}`);
    if (!Number.isFinite(metadataLimit) || metadataLimit < 0) throw new Error(`--metadata must be >= 0, got ${flags.metadata}`);

    let rpcHost = '(unparseable)';
    try {
        rpcHost = new URL(rpc).host;
    } catch { /* reported as unparseable; the URL itself is never logged */ }
    log(`watch-chain: rpc ${rpcHost}`);

    const universe = await readJson(TOKENS_FILE, null);
    const allTokens = universe?.tokens;
    if (!Array.isArray(allTokens) || allTokens.length === 0) {
        throw new Error(`${TOKENS_FILE} has no tokens array — run \`npm run stocks:build\` first`);
    }
    let tokens = allTokens;
    if (typeof flags.only === 'string') {
        tokens = tokens.filter((t) => t.issuer === flags.only);
        if (tokens.length === 0) throw new Error(`no mints for issuer ${flags.only}`);
    }
    tokens = tokens.slice().sort((a, b) => byString(a.mint, b.mint));
    if (flags.limit) {
        const limit = Number(flags.limit);
        if (!Number.isFinite(limit) || limit < 1) throw new Error(`--limit must be a positive number, got ${flags.limit}`);
        tokens = tokens.slice(0, limit);
    }
    const tokenByMint = new Map(tokens.map((t) => [t.mint, t]));
    log(`watch-chain: ${tokens.length} mint(s) of ${allTokens.length}, universe built ${universe.builtAt}`
        + `${flags.only ? `, only ${flags.only}` : ''}`);

    // --- previous state -----------------------------------------------------------------------
    let previous = new Map();
    let previousBalances = [];
    if (flags['no-db']) {
        logWarn('--no-db: no previous state is available, so this run reports states and NO events');
    } else if (!dbUrl) {
        throw new Error(`DATABASE_URL is not set in ${join(REPO, '.env')} — pass --no-db to run without Postgres`);
    } else {
        log(`db: ${describeUrl(dbUrl)}`);
        if (flags.ddl) {
            const ddl = await readFile(DDL_FILE, 'utf8');
            log(`db: applying ${relative(REPO, DDL_FILE)} before reading (${ddl.length} bytes, idempotent)`);
            await psql(dbUrl, ddl, 'ddl');
        }
        previous = await readPreviousStates(dbUrl);
        previousBalances = await readPreviousBalances(dbUrl);
        log(`db: ${previous.size} stored mint state(s), ${previousBalances.length} stored balance(s)`);
        if (previous.size === 0) log('db: nothing stored yet — this run is the baseline');
    }

    // --- read the mint accounts ---------------------------------------------------------------
    const failures = [];
    const states = [];
    const batchStartedMs = Date.now();
    let read = 0;
    await fetchMintAccounts(tokens.map((t) => t.mint), {
        rpc,
        batchSize: MAX_ACCOUNTS_PER_REQUEST,
        paceMs: BATCH_PACE_MS,
        onBatch: (results, meta) => {
            const observedAt = ts();
            for (const { mint, account } of results) {
                read += 1;
                if (account === null) {
                    failures.push({ kind: 'mint', subject: mint, reason: `${mint}: no account on ${rpcHost}` });
                    continue;
                }
                const prev = previous.get(mint) ?? null;
                const state = parseMintState(account, { mint, slot: meta.slot, observedAt });
                if (state.supply === null || state.decimals === null) {
                    failures.push({ kind: 'mint', subject: mint, reason: `${mint}: account has no supply/decimals — unparseable` });
                    continue;
                }
                // Carry the metadata hash forward while the URI is unchanged: it describes the
                // document we last read, and dropping it would re-fetch the whole universe hourly.
                if (prev && prev.metadataUri === state.metadataUri) state.metadataHash = prev.metadataHash ?? null;
                states.push(state);
            }
            log(`mints [${progress(read, tokens.length, batchStartedMs)}] slot ${meta.slot ?? '?'}`);
        }
    });

    // --- metadata documents -------------------------------------------------------------------
    const wanted = metadataLimit === 0 ? [] : selectMetadataFetches(states, previous, { limit: metadataLimit });
    const stateByMint = new Map(states.map((s) => [s.mint, s]));
    let metadataFetched = 0;
    const metadataFindings = [];
    if (wanted.length) {
        log(`metadata: ${wanted.length} document(s) to hash (${wanted.filter((w) => w.uriMoved).length} because the URI moved)`);
        const metaStartedMs = Date.now();
        for (let i = 0; i < wanted.length; i += 1) {
            const { mint, uri } = wanted[i];
            const result = await fetchMetadata(uri);
            if (result.status === 'fetched') {
                stateByMint.get(mint).metadataHash = result.hash;
                metadataFetched += 1;
            } else if (result.status === 'error') {
                failures.push({ kind: 'metadata', subject: mint, reason: `${mint} ${uri}: ${result.reason}` });
            } else {
                metadataFindings.push({ mint, uri, status: result.status, reason: result.reason });
            }
            if (i % 10 === 9 || i === wanted.length - 1) {
                log(`metadata [${progress(i + 1, wanted.length, metaStartedMs)}] ${metadataFetched} hashed`);
            }
            if (i < wanted.length - 1) await sleep(METADATA_PACE_MS);
        }
        if (metadataFindings.length) {
            logWarn(`${metadataFindings.length} metadata document(s) could not be read — a finding about`
                + ' the citation, not a run failure:');
            for (const f of metadataFindings.slice(0, 10)) logWarn(`    ${f.status} ${f.reason} ${f.uri}`);
        }
    }

    // --- compare ------------------------------------------------------------------------------
    const events = [];
    const newStates = [];
    const firstSight = [];
    let unchanged = 0;
    for (const state of states) {
        state.stateHash = stateHash(state);
        const prev = previous.get(state.mint) ?? null;
        if (prev === null) {
            firstSight.push({ mint: state.mint, issuer: tokenByMint.get(state.mint)?.issuer ?? null,
                slot: state.slot, observedAt: state.observedAt });
            newStates.push(state);
            continue;
        }
        if (prev.stateHash === state.stateHash) {
            unchanged += 1;
            continue;
        }
        newStates.push(state);
        const token = tokenByMint.get(state.mint) ?? {};
        events.push(...diffStates(prev, state, { symbol: token.symbol ?? null, issuer: token.issuer ?? null }));
    }
    if (firstSight.length) events.push(...baselineEvents(firstSight, { detectedAt: ts() }));

    // --- labelled wallets ---------------------------------------------------------------------
    const onchain = await readJson(ONCHAIN_FILE, { items: [] });
    const extensionAuthorities = states.flatMap((s) => [s.feeConfigAuthority, s.withdrawWithheldAuthority,
        s.hookAuthority, s.uiMultiplierAuthority, s.metadataUpdateAuthority, s.permanentDelegate])
        .filter((a) => typeof a === 'string');
    const labels = buildOwnerLabels(onchain.items ?? [], extensionAuthorities);
    const namedKeys = { ...ISSUER_MINT_AUTHORITIES, ...ISSUER_FREEZE_AUTHORITIES };
    const index = buildWalletIndex(labels, onchain.items ?? [], namedKeys);
    const { watched, skipped } = selectWatchedWallets(index, { limit: walletLimit });
    const issuerByWallet = Object.fromEntries([...index.values()].map((e) => [e.wallet, e.issuer]));
    log(`wallets: ${labels.size} labelled address(es), reading ${watched.length}`
        + `${skipped ? `, ${skipped} not read this run (cap ${walletLimit})` : ''}`);
    const watchedMints = new Set(tokens.map((t) => t.mint));
    const balances = await readWallets(watched, { rpc, watchedMints, failures });
    const treasuryEvents = walletMoves(previousBalances, balances, { issuerByWallet });
    events.push(...treasuryEvents);

    // --- report and write ---------------------------------------------------------------------
    const byKind = countBy(events, 'kind');
    const bySeverity = countBy(events, 'severity');
    log(`watch-chain: ${read} mint(s) read · ${unchanged} unchanged · ${newStates.length - firstSight.length} changed`
        + ` · ${firstSight.length} first sight · ${balances.length} balance reading(s)`);
    log(`watch-chain: ${events.length} event(s)`
        + `${events.length ? ` — ${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}`);
    if (events.length) log(`watch-chain: severity — ${Object.entries(bySeverity).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    for (const event of events.slice(0, 20)) {
        log(`  [${event.severity}] ${event.kind} ${event.subjectId} ${event.field}: ${event.summary}`);
    }

    if (!flags['no-db']) {
        await loadToPostgres({ states: newStates, balances, events }, { url: dbUrl, applyDdl: false });
    }

    const durationMs = Date.now() - startedMs;
    const endedAt = ts();
    const stats = {
        watchStatus: failures.length ? 'partial' : 'ok',
        generatedAt: endedAt,
        lastRunStartedAt: RUN_STARTED_AT,
        lastRunEndedAt: endedAt,
        rpcHost,
        durationMs,
        mintsRequested: tokens.length,
        mintsRead: read,
        unchanged,
        changed: newStates.length - firstSight.length,
        firstSight: firstSight.length,
        statesWritten: newStates.length,
        walletsLabelled: labels.size,
        walletsRead: watched.length,
        walletsSkipped: skipped,
        balanceReadings: balances.length,
        metadataWanted: wanted.length,
        metadataFetched,
        metadataFindings: metadataFindings.length,
        events: events.length,
        eventsByKind: byKind,
        eventsBySeverity: bySeverity,
        failures: failures.length,
        failureReasons: failures.slice(0, 20).map((f) => f.reason),
        rpcCalls: Math.ceil(tokens.length / MAX_ACCOUNTS_PER_REQUEST)
            + (watched.length ? Math.ceil(watched.length / MAX_ACCOUNTS_PER_REQUEST) + watched.length : 0)
    };
    await writeJson(STATS_FILE, stats);
    const collectorOutputs = [join(REPO, 'stocks-collector-status.json')];
    if (process.env.RWA_DOCROOT) collectorOutputs.push(join(process.env.RWA_DOCROOT, 'stocks-collector-status.json'));
    await refreshCollectorStatus({ outputs: collectorOutputs });
    log(`watch-chain: wrote ${relative(REPO, STATS_FILE)} — ${stats.rpcCalls} RPC call(s) in ${(durationMs / 1000).toFixed(1)} s`);

    if ((events.length > 0 || failures.length > 0) && !flags['no-telegram']) {
        await postTelegram(formatTelegramSummary({
            events, failures, mintsRead: read, unchanged, changed: stats.changed,
            walletsRead: watched.length, metadataFetched, durationMs, host: rpcHost
        }), { env });
    } else if (!flags['no-telegram']) {
        log('watch-chain: no events and no failures — no Telegram message (one per run, only when there is news)');
    }

    if (failures.length) {
        logError(`watch-chain: run NOT successful — ${failures.length} item(s) failed:`);
        for (const failure of failures.slice(0, 20)) logError(`    ${failure.kind}: ${failure.reason}`);
        process.exitCode = 1;
        return;
    }
    log('watch-chain: done');
}

main().catch(async (err) => {
    logError(err.stack || err.message);
    try {
        await writeJson(STATS_FILE, {
            watchStatus: 'failed',
            generatedAt: ts(),
            lastRunStartedAt: RUN_STARTED_AT,
            lastRunEndedAt: ts(),
            durationMs: Date.now() - RUN_STARTED_MS,
            mintsRequested: null,
            mintsRead: null,
            failures: 1,
            failureReasons: [err.message]
        });
        const outputs = [join(REPO, 'stocks-collector-status.json')];
        if (process.env.RWA_DOCROOT) outputs.push(join(process.env.RWA_DOCROOT, 'stocks-collector-status.json'));
        await refreshCollectorStatus({ outputs });
    } catch (statsError) {
        logError(`watch-chain: could not record failed outcome: ${statsError.message}`);
    }
    process.exitCode = 1;
});
