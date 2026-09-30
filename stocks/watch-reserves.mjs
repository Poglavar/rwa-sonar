#!/usr/bin/env node
// Daily reserves-vs-supply ("proof of reserve") watcher: for every issuer programme that publishes
// a machine-readable reserve figure, reads it from the issuer's own source, reads the matching
// Solana supply over RPC and records the coverage per token in sonar.reserve_observation
// (db/2026-10-01-sonar-reserves.sql). Built to catch the class of the June-2026 SpaceX xStocks
// collateral shortfall. All rules and parsers live in lib/reserves.mjs (tested); this file is IO.
//
// Restartable and idempotent: every run re-reads everything (≈ 20 HTTP + RPC calls, no backlog to
// carry), and a reading equal to the latest stored one only moves that row's last_seen_at, so a
// re-run the same day writes no new rows. All rows of a run are written in one transaction.

import { join, relative } from 'node:path';

import { wrapTransaction } from './lib/db-load.mjs';
import { readEnvFile } from './lib/env.mjs';
import { fetchJson, log, logError, logWarn, parseArgs, readJson, sleep, ts, writeJson } from './lib/io.mjs';
import { describeUrl, psql } from './lib/psql.mjs';
import {
    LATEST_QUERY, PROGRAMMES, assessReading, buildWriteSql, chainOutstanding, formatSummary, mintSupply, parseLatest,
    parseSuperstateInstruments, parseXstocksPor, planWrites, readingHash, round, transitions, xstocksHasNextPage
} from './lib/reserves.mjs';
import { DEFAULT_RPC, chunk, getAccountsWithContext, getTokenAccountsByOwner, rpcCall } from './lib/solana-rpc.mjs';
import { postTelegram } from './lib/telegram.mjs';
import { XSTOCKS_ISSUER_WALLETS, sumInventory } from './lib/xstocks-float.mjs';

const HERE = import.meta.dirname;
const REPO = join(HERE, '..');
const STATS_FILE = join(REPO, '.last-reserves-watch-stats.json');
const TOKENS_FILE = join(REPO, 'stocks-tokens.json');
const RUN_STARTED_MS = Date.now();
const RUN_STARTED_AT = ts(new Date(RUN_STARTED_MS));
const RPC_PACE_MS = 400;
const HTTP_PACE_MS = 300;
const MAX_XSTOCKS_PAGES = 30;
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

function usage() {
    const readable = Object.entries(PROGRAMMES).filter(([, p]) => p.access === 'keyless');
    console.log(`watch-reserves.mjs — issuer reserve figures against Solana supply, per token (daily)

USAGE
  node stocks/watch-reserves.mjs --run [options]

OPTIONS
  --run            Actually read. Without it this help is printed and nothing runs.
  --only=<list>    Issuers (catalogue keys), comma-separated, e.g. xstocks-backed,superstate-opening-bell.
  --no-db          Write no rows (every reading is printed as if new).
  --no-telegram    Log the summary instead of sending it.
  --print          Print every token's reading, not only the flagged ones.
  --rpc=<url>      RPC endpoint (default SOLANA_RPC_URL from .env, else ${DEFAULT_RPC}). Never printed.
  --help           This text.

READ EVERY RUN (keyless)
${readable.map(([k, p]) => `  ${k.padEnd(26)} ${p.url}`).join('\n')}

RECORDED WITHOUT A READ
${Object.entries(PROGRAMMES).filter(([, p]) => p.access !== 'keyless').map(([k, p]) => `  ${k.padEnd(26)} ${p.access}: ${p.note}`).join('\n')}

WHAT A RUN DOES
  1. Fetches each keyless source (xStocks: all pages of the proof-of-reserves feed).
  2. getMultipleAccounts over those programmes' mints (supply, decimals, scaled-UI multiplier), one
     getBlockTime per distinct slot, and getTokenAccountsByOwner for the issuer-held wallets whose
     balances are not outstanding (the ${XSTOCKS_ISSUER_WALLETS.length} xStocks issuer wallets, Superstate's burn address).
  3. Per token: coverage = reserve / issuer's all-chain circulating, and reserve / Solana outstanding;
     status covered | shortfall | stale | unreadable | not-published | nothing-outstanding.
  4. Inserts a row per changed reading into sonar.reserve_observation; unchanged ones only move last_seen_at.
  5. Writes ${relative(REPO, STATS_FILE)}; ONE Telegram summary when there is a shortfall, a stale
     proof or a failure; exits 1 when any read failed.

REQUIREMENTS
  DATABASE_URL and SOLANA_RPC_URL in ${join(REPO, '.env')} (never printed; only hosts are logged).
  The table comes from db/2026-10-01-sonar-reserves.sql (node stocks/apply-schema.mjs --run); this job never applies schema.`);
}

function host(url) {
    try { return new URL(url).hostname; } catch { return 'configured RPC'; }
}

async function fetchXstocks(url, failures) {
    const pages = [];
    for (let page = 1; page <= MAX_XSTOCKS_PAGES; page += 1) {
        const u = new URL(url);
        u.searchParams.set('page', String(page));
        u.searchParams.set('pageSize', '100');
        const res = await fetchJson(u.toString(), { headers: { accept: 'application/json' }, timeoutMs: 60000 });
        if (!res.ok || !res.json) {
            failures.push(`xstocks-por page ${page}: HTTP ${res.status}${res.parseError ? ` (${res.parseError})` : ''}`);
            return null;
        }
        pages.push(res.json);
        log(`xstocks-por: page ${page}/${res.json.page?.totalPages ?? '?'}, ${res.json.nodes?.length ?? 0} row(s)`);
        if (!xstocksHasNextPage(res.json)) return pages;
        await sleep(HTTP_PACE_MS);
    }
    failures.push(`xstocks-por: more than ${MAX_XSTOCKS_PAGES} pages — stopped`);
    return null;
}

async function fetchSuperstate(url, failures) {
    const res = await fetchJson(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 rwa-sonar reserves watch' }, timeoutMs: 60000 });
    if (!res.ok || !res.json) {
        failures.push(`superstate-instruments: HTTP ${res.status}${res.parseError ? ` (${res.parseError})` : ''}`);
        return null;
    }
    return res.json;
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return;
    }
    const env = await readEnvFile(join(REPO, '.env'));
    const rpc = flags.rpc || process.env.SOLANA_RPC_URL || env.SOLANA_RPC_URL || DEFAULT_RPC;
    const dbUrl = flags['no-db'] ? null : (process.env.DATABASE_URL || env.DATABASE_URL || null);
    if (!flags['no-db'] && !dbUrl) throw new Error(`DATABASE_URL is not set in ${join(REPO, '.env')} — pass --no-db to run without Postgres`);
    const only = typeof flags.only === 'string' ? new Set(flags.only.split(',').map((s) => s.trim()).filter(Boolean)) : null;
    log(`watch-reserves: rpc ${host(rpc)} · db ${dbUrl ? describeUrl(dbUrl) : '(--no-db)'}${only ? ` · only ${[...only].join(',')}` : ''}`);

    const catalogue = await readJson(TOKENS_FILE);
    const tokens = (catalogue?.tokens ?? []).filter((t) => t?.mint && t?.issuer && (!only || only.has(t.issuer)));
    if (only) for (const k of only) if (!tokens.some((t) => t.issuer === k)) throw new Error(`--only: no catalogued token has issuer "${k}"`);
    const byIssuer = new Map();
    for (const t of tokens) byIssuer.set(t.issuer, [...(byIssuer.get(t.issuer) ?? []), t]);
    log(`watch-reserves: ${tokens.length} token(s) across ${byIssuer.size} issuer(s) from ${relative(REPO, TOKENS_FILE)}`);

    const failures = [];
    const counters = { http: 0, getMultipleAccounts: 0, getBlockTime: 0, getTokenAccountsByOwner: 0 };

    // 1. Sources ------------------------------------------------------------------------------
    let xstocks = null;
    let superstate = null;
    if (byIssuer.has('xstocks-backed')) {
        const pages = await fetchXstocks(PROGRAMMES['xstocks-backed'].url, failures);
        counters.http += pages?.length ?? 1;
        if (pages) {
            try { xstocks = parseXstocksPor(pages); } catch (err) { failures.push(`xstocks-por: ${err.message}`); }
        }
        if (xstocks) log(`xstocks-por: ${xstocks.size} symbol(s)`);
    }
    if (byIssuer.has('superstate-opening-bell')) {
        const json = await fetchSuperstate(PROGRAMMES['superstate-opening-bell'].url, failures);
        counters.http += 1;
        if (json) {
            try { superstate = parseSuperstateInstruments(json); } catch (err) { failures.push(`superstate-instruments: ${err.message}`); }
        }
        if (superstate) log(`superstate-instruments: ${superstate.size} Solana equity instrument(s)`);
    }

    // 2. Supply ---------------------------------------------------------------------------------
    const needSupply = [
        ...(xstocks ? byIssuer.get('xstocks-backed') : []),
        ...(superstate ? byIssuer.get('superstate-opening-bell') : [])
    ].map((t) => t.mint);
    const accounts = new Map();
    const slotOf = new Map();
    const batches = chunk(needSupply, 100);
    for (const [i, batch] of batches.entries()) {
        try {
            counters.getMultipleAccounts += 1;
            const { slot, value } = await getAccountsWithContext(batch, { rpc });
            batch.forEach((mint, idx) => { accounts.set(mint, value[idx]); slotOf.set(mint, slot); });
            log(`supply: batch ${i + 1}/${batches.length} · ${batch.length} mint(s) · slot ${slot}`);
        } catch (err) {
            failures.push(`getMultipleAccounts batch ${i + 1}: ${err.message}`);
        }
        await sleep(RPC_PACE_MS);
    }
    const blockTimes = new Map();
    for (const slot of new Set([...slotOf.values()].filter((s) => Number.isInteger(s)))) {
        try {
            counters.getBlockTime += 1;
            const t = await rpcCall('getBlockTime', [slot], { rpc });
            blockTimes.set(slot, Number.isFinite(t) ? new Date(t * 1000).toISOString() : null);
        } catch (err) {
            // A slot's own time is unavailable (e.g. a skipped slot): keep the slot, leave the time null.
            logWarn(`getBlockTime ${slot}: ${err.message} — supply_block_time stays null`);
            blockTimes.set(slot, null);
        }
        await sleep(RPC_PACE_MS);
    }

    // Issuer-held balances that are not outstanding.
    const excludedWallets = [];
    if (xstocks) excludedWallets.push(...XSTOCKS_ISSUER_WALLETS.map((w) => ({ address: w.address, role: `xstocks ${w.role}` })));
    if (superstate) {
        for (const b of new Set([...superstate.values()].map((r) => r.burnAddress).filter(Boolean))) excludedWallets.push({ address: b, role: 'superstate burn address' });
    }
    const byWallet = {};
    const walletFailed = new Set();
    for (const [i, w] of excludedWallets.entries()) {
        try {
            counters.getTokenAccountsByOwner += 1;
            const { accounts: held } = await getTokenAccountsByOwner(w.address, { rpc, programId: TOKEN_2022 });
            byWallet[w.address] = held;
            log(`excluded wallets: ${i + 1}/${excludedWallets.length} ${w.role} · ${held.length} token account(s)`);
        } catch (err) {
            walletFailed.add(w.address);
            failures.push(`getTokenAccountsByOwner ${w.role}: ${err.message}`);
        }
        await sleep(RPC_PACE_MS);
    }
    const inventory = sumInventory(byWallet, new Set(needSupply));
    const nowSeconds = Math.floor(RUN_STARTED_MS / 1000);

    // 3. Rows -----------------------------------------------------------------------------------
    const rows = [];
    const supplyFacts = (mint) => {
        const facts = mintSupply(accounts.get(mint) ?? null, nowSeconds);
        const excludedRaw = inventory.get(mint)?.total ?? 0n;
        const outstanding = walletFailed.size ? null : chainOutstanding({ ...facts, excludedRaw: String(excludedRaw) });
        const slot = slotOf.get(mint) ?? null;
        return { ...facts, excludedRaw: String(excludedRaw), outstanding, supplySlot: slot, supplyBlockTime: slot === null ? null : (blockTimes.get(slot) ?? null),
            excludedByWallet: inventory.get(mint)?.byWallet ?? {} };
    };
    const base = (t, programme) => ({
        mint: t.mint, symbol: t.symbol ?? null, issuer: t.issuer, source: programme?.source ?? 'none',
        sourceKind: programme?.sourceKind ?? null, sourceUrl: programme?.url ?? null
    });
    const empty = { reserve: null, issuerCirculating: null, sourceTime: null, supplyRaw: null, excludedRaw: null, decimals: null,
        uiMultiplier: null, outstanding: null, supplySlot: null, supplyBlockTime: null, coverageIssuer: null, coverageChain: null, stale: null };

    // xStocks: the reserve is per symbol and covers every chain; two catalogued mints sharing a
    // symbol are compared together against it.
    const xFacts = new Map();
    if (xstocks) for (const t of byIssuer.get('xstocks-backed')) xFacts.set(t.mint, supplyFacts(t.mint));
    const xGroup = new Map();
    if (xstocks) {
        for (const t of byIssuer.get('xstocks-backed')) xGroup.set(t.symbol, [...(xGroup.get(t.symbol) ?? []), t.mint]);
    }
    const groupOutstanding = (symbol) => {
        const values = (xGroup.get(symbol) ?? []).map((m) => xFacts.get(m)?.outstanding ?? null);
        return values.some((v) => v === null) ? null : values.reduce((a, b) => a + b, 0);
    };

    for (const [issuer, list] of byIssuer) {
        const programme = PROGRAMMES[issuer] ?? null;
        for (const t of list) {
            const b = base(t, programme);
            if (!programme || programme.access === 'none') {
                rows.push({ ...b, ...empty, status: 'not-published', reasons: [programme?.note ?? 'programme not researched for a reserve source'], detail: {} });
                continue;
            }
            if (programme.access === 'credentials-required') {
                rows.push({ ...b, ...empty, status: 'unreadable', reasons: [`credentials required: ${programme.note}`], detail: { restricted: true } });
                continue;
            }
            if (issuer === 'xstocks-backed') {
                if (!xstocks) continue; // the source failed: recorded as a run failure, no row
                const reading = xstocks.get(t.symbol) ?? null;
                const facts = xFacts.get(t.mint);
                if (!reading) {
                    rows.push({ ...b, ...empty, ...pickFacts(facts), status: 'not-published',
                        reasons: [`symbol ${t.symbol} absent from the issuer's proof-of-reserves feed`], detail: { absentFromFeed: true } });
                    continue;
                }
                const outstanding = groupOutstanding(t.symbol);
                const a = assessReading({ reserve: reading.reserve, issuerCirculating: reading.issuerCirculating, outstanding,
                    sourceTime: reading.sourceTime, now: RUN_STARTED_AT, staleAfterHours: programme.staleAfterHours });
                rows.push({ ...b, ...pickFacts(facts), outstanding: facts.outstanding, reserve: reading.reserve, issuerCirculating: reading.issuerCirculating,
                    sourceTime: reading.sourceTime, ...a,
                    detail: { holdings: reading.holdings, excludedByWallet: facts.excludedByWallet,
                        ...(xGroup.get(t.symbol).length > 1 ? { comparedWithMints: xGroup.get(t.symbol), groupOutstanding: round(outstanding) } : {}) } });
                continue;
            }
            if (issuer === 'superstate-opening-bell') {
                if (!superstate) continue;
                const reading = superstate.get(t.mint) ?? null;
                const facts = supplyFacts(t.mint);
                if (!reading) {
                    rows.push({ ...b, ...empty, ...pickFacts(facts), status: 'not-published', reasons: ['mint absent from the Superstate instruments API'], detail: {} });
                    continue;
                }
                const a = assessReading({ reserve: reading.reserve, outstanding: facts.outstanding, sourceTime: null,
                    now: RUN_STARTED_AT, staleAfterHours: programme.staleAfterHours });
                rows.push({ ...b, ...pickFacts(facts), outstanding: facts.outstanding, reserve: reading.reserve, issuerCirculating: null,
                    sourceTime: null, ...a,
                    detail: { registerTotal: reading.registerTotal, splitMultiplier: reading.splitMultiplier, chains: reading.chains,
                        burnAddress: reading.burnAddress, excludedByWallet: facts.excludedByWallet } });
            }
        }
    }
    for (const r of rows) r.readingHash = readingHash(r);

    // 4. Store ----------------------------------------------------------------------------------
    let plan = { inserts: rows, touches: [] };
    if (dbUrl) {
        const latest = parseLatest(await psql(dbUrl, LATEST_QUERY, 'reserve_observation latest'));
        plan = planWrites(rows, latest);
        const sql = buildWriteSql(plan, { seenAt: RUN_STARTED_AT });
        if (sql) await psql(dbUrl, wrapTransaction(sql), 'reserve_observation write');
        log(`db: ${plan.inserts.length} new reading(s), ${plan.touches.length} unchanged (last_seen_at moved)`);
    } else {
        log('db: --no-db — nothing written');
    }
    const trans = dbUrl ? transitions(plan.inserts) : [];

    // 5. Report ---------------------------------------------------------------------------------
    const counts = {};
    for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
    const unreadableItems = rows.filter((r) => r.status === 'unreadable' && !r.detail?.restricted);
    for (const r of unreadableItems) failures.push(`${r.symbol} (${r.mint}): ${r.reasons.join('; ')}`);
    const restricted = rows.filter((r) => r.detail?.restricted).length;
    const flagged = rows.filter((r) => ['shortfall', 'stale', 'unreadable'].includes(r.status) || r.reasons?.some((x) => x.includes('exceeds')));
    log(`watch-reserves: ${rows.length} token(s) — ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    for (const r of (flags.print ? rows : flagged).slice(0, flags.print ? rows.length : 40)) {
        log(`  [${r.status}${r.shortfallBasis ? `:${r.shortfallBasis}` : ''}] ${r.issuer} ${r.symbol} reserve ${r.reserve ?? '—'} · issuer circ ${r.issuerCirculating ?? '—'} · Solana ${round(r.outstanding, 6) ?? '—'}`
            + ` · cov issuer ${round(r.coverageIssuer, 4) ?? '—'} · cov chain ${round(r.coverageChain, 4) ?? '—'} · at ${r.sourceTime ?? '—'}${r.reasons?.length ? ` · ${r.reasons.join('; ')}` : ''}`);
    }
    for (const tr of trans) log(`  transition ${tr.kind}: ${tr.row.symbol} ${tr.from ?? '(first)'} → ${tr.row.status}`);

    const durationMs = Date.now() - RUN_STARTED_MS;
    const stats = {
        watchStatus: failures.length ? 'partial' : 'ok',
        generatedAt: ts(),
        lastRunStartedAt: RUN_STARTED_AT,
        lastRunEndedAt: ts(),
        durationMs,
        counts: { tokens: rows.length, ...counts, restricted, newReadings: plan.inserts.length, unchanged: plan.touches.length, transitions: trans.length },
        // Flat fields for the alerts-server outcome check (minValues/maxValues read top-level keys).
        tokensCompared: rows.filter((r) => ['covered', 'shortfall', 'stale', 'nothing-outstanding'].includes(r.status)).length,
        shortfallCount: counts.shortfall ?? 0,
        requests: counters,
        shortfalls: rows.filter((r) => r.status === 'shortfall').map((r) => ({ symbol: r.symbol, mint: r.mint, basis: r.shortfallBasis, coverageIssuer: round(r.coverageIssuer, 6), coverageChain: round(r.coverageChain, 6), sourceTime: r.sourceTime })),
        failures: failures.length,
        failureReasons: failures.slice(0, 20)
    };
    await writeJson(STATS_FILE, stats);

    const summary = formatSummary({ rows, failures, restricted, transitionsList: trans, durationMs });
    if (summary && !flags['no-telegram']) await postTelegram(summary, { env });
    else if (summary) for (const line of summary.split('\n')) log(`summary | ${line}`);
    else log('watch-reserves: no shortfall, no stale proof, no failure — no Telegram message');

    if (failures.length) {
        logError(`watch-reserves: run NOT successful — ${failures.length} failure(s):`);
        for (const f of failures.slice(0, 20)) logError(`    ${f}`);
        process.exitCode = 1;
        return;
    }
    log(`watch-reserves: done in ${(durationMs / 1000).toFixed(0)} s`);
}

function pickFacts(f) {
    return f ? { supplyRaw: f.supplyRaw, excludedRaw: f.excludedRaw, decimals: f.decimals, uiMultiplier: f.uiMultiplier,
        supplySlot: f.supplySlot, supplyBlockTime: f.supplyBlockTime } : {};
}

main().catch(async (err) => {
    logError(err.stack || err.message);
    try {
        await writeJson(STATS_FILE, {
            watchStatus: 'failed', generatedAt: ts(), lastRunStartedAt: RUN_STARTED_AT, lastRunEndedAt: ts(),
            durationMs: Date.now() - RUN_STARTED_MS, failures: 1, failureReasons: [err.message]
        });
    } catch (statsError) {
        logError(`watch-reserves: could not record the failed outcome: ${statsError.message}`);
    }
    process.exitCode = 1;
});
