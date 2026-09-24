#!/usr/bin/env node
// Daily on-chain DeFi footprint: for every tracked stock mint, which PROGRAMS own its largest token
// accounts, attributed through stocks/data/defi-program-registry.json. An unknown program holding a
// stock above the threshold, or a known protocol holding a stock our registry collection does not
// list, becomes a review candidate; the daily diff (build-defi-changes.mjs) turns first appearances
// into `defi-integration-added` / `-candidate` events. Pure rules live in lib/defi-footprint.mjs.
//
// RPC budget (Alchemy free tier, shared with the trade collector): holders.json already carries the
// top-20 accounts of the mints it covers, so those cost nothing here; the remaining mints are
// scanned in a rotating, budget-capped slice (getTokenLargestAccounts + one getMultipleAccounts per
// 100 token accounts). Owners are resolved with zero-length getMultipleAccounts reads (100 per call)
// and an unresolved PDA above the threshold costs one getSignaturesForAddress plus ≤3 getTransaction,
// cached for good. getProgramAccounts is never used: Alchemy's free tier throttles it on the first
// call (measured 2026-09-24).

import { join } from 'node:path';
import {
    CANDIDATE_MIN_SHARE_PCT, CANDIDATE_MIN_USD, deriveAuthorities, footprintCandidates, indexRegistry,
    listedIndex, mintFootprint, resolvePdaProgram, selectMintsToScan, transferParents
} from './lib/defi-footprint.mjs';
import { rawAmountOrNull, rawToUi } from './lib/holders.mjs';
import { fetchJson, log, logError, logWarn, parseArgs, readJson, sleep, ts, writeJson } from './lib/io.mjs';
import { readEnvFile } from './lib/env.mjs';
import { DEFAULT_RPC, MAX_ACCOUNTS_PER_REQUEST, chunk, getAccountsWithContext, rpcCall } from './lib/solana-rpc.mjs';

const HERE = import.meta.dirname;
const ROOT = join(HERE, '..');
const TOKENS_PATH = join(ROOT, 'stocks-tokens.json');
const HOLDERS_PATH = join(HERE, 'data', 'holders.json');
const REGISTRY_PATH = join(HERE, 'data', 'defi-program-registry.json');
const USAGE_PATH = join(HERE, 'data', 'defi-usage.json');
const STATE_PATH = join(HERE, 'data', 'raw', 'defi-footprint-state.json');
const OUT_PATH = join(HERE, 'data', 'defi-footprint.json');
const ENV_PATH = join(ROOT, '.env');
const KAMINO_MARKETS_URL = 'https://api.kamino.finance/v2/kamino-market?programId=KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';
const JUPITER_LABELS_URL = 'https://lite-api.jup.ag/swap/v1/program-id-to-label';

const DEFAULT_BUDGET = 250;
const DEFAULT_RESOLVE_BUDGET = 15;
const DEFAULT_HOLDERS_MAX_AGE_HOURS = 36;
const SCAN_REUSE_DAYS = 7;
const UNRESOLVED_RETRY_DAYS = 7;
const PACE_MS = 350;

function usage() {
    console.log(`fetch-defi-footprint.mjs — which programs hold each tracked stock (daily discovery)

USAGE
  node stocks/fetch-defi-footprint.mjs --run [options]

OPTIONS
  --run                     Actually scan. Without it this help is printed and nothing runs.
  --budget=<n>              Max mints scanned directly this run (getTokenLargestAccounts each;
                            default ${DEFAULT_BUDGET}). Mints covered by a fresh holders.json cost nothing.
  --resolve-budget=<n>      Max unresolved PDAs looked up via their transactions (default ${DEFAULT_RESOLVE_BUDGET}).
  --holders-max-age-hours=<h>  Use holders.json only when newer than this (default ${DEFAULT_HOLDERS_MAX_AGE_HOURS}).
  --pace=<ms>               Spacing between RPC calls (default ${PACE_MS}).
  --help                    This text.

INPUTS
  stocks-tokens.json, stocks/data/holders.json, stocks/data/defi-program-registry.json,
  stocks/data/defi-usage.json (what registries already list), Kamino's market list and Jupiter's
  program-id-to-label map (both keyless),
  SOLANA_RPC_URL from ../.env (only the host is ever logged).

STATE / OUTPUT
  stocks/data/raw/defi-footprint-state.json — rotation scans + cached PDA resolutions, written after
    every batch, so a killed run resumes and never repeats paid reads.
  stocks/data/defi-footprint.json — per mint: read status, holding programs, wallets summary;
    candidates[]; counts; rpc call count. A mint that could not be read is 'failed'/'not-scanned',
    never an empty holding set.`);
}

function rpcHost(url) {
    try {
        return new URL(url).hostname;
    } catch {
        return 'configured Solana RPC';
    }
}

function number(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }
    const budget = number(flags.budget, DEFAULT_BUDGET);
    const resolveBudget = number(flags['resolve-budget'], DEFAULT_RESOLVE_BUDGET);
    const holdersMaxAgeHours = number(flags['holders-max-age-hours'], DEFAULT_HOLDERS_MAX_AGE_HOURS);
    const paceMs = number(flags.pace, PACE_MS);
    const env = await readEnvFile(ENV_PATH);
    const rpc = typeof env.SOLANA_RPC_URL === 'string' && env.SOLANA_RPC_URL ? env.SOLANA_RPC_URL : DEFAULT_RPC;
    if (rpc === DEFAULT_RPC) logWarn(`rpc: no SOLANA_RPC_URL in ${ENV_PATH} — using the throttled public endpoint`);
    const startedAt = ts();
    const calls = { getTokenLargestAccounts: 0, getMultipleAccounts: 0, getSignaturesForAddress: 0, getTransaction: 0 };
    const call = async (method, params) => {
        calls[method] = (calls[method] ?? 0) + 1;
        const result = await rpcCall(method, params, { rpc });
        await sleep(paceMs);
        return result;
    };
    const accountsCall = async (batch, options) => {
        calls.getMultipleAccounts += 1;
        const result = await getAccountsWithContext(batch, { rpc, ...options });
        await sleep(paceMs);
        return result;
    };

    const [tokenDb, holders, registry, usageDb, previousState] = await Promise.all([
        readJson(TOKENS_PATH),
        readJson(HOLDERS_PATH, null),
        readJson(REGISTRY_PATH),
        readJson(USAGE_PATH, { items: [] }),
        readJson(STATE_PATH, { scans: {}, pdaResolutions: {} })
    ]);
    if (!Array.isArray(tokenDb?.tokens)) throw new Error(`${TOKENS_PATH}: expected {tokens:[...]}`);
    const tokens = tokenDb.tokens;
    const tokenByMint = new Map(tokens.map((token) => [token.mint, token]));
    // Jupiter's keyless map of every DEX program it routes through names programs the curated
    // registry lacks; a failed read only means those stay "unknown" this run.
    const labelsResponse = await fetchJson(JUPITER_LABELS_URL, { headers: { accept: 'application/json' }, timeoutMs: 60000 });
    const externalLabels = labelsResponse.ok && labelsResponse.json && typeof labelsResponse.json === 'object' ? labelsResponse.json : null;
    if (!externalLabels) logWarn(`jupiter program labels: HTTP ${labelsResponse.status} — unlisted DEX programs stay unattributed this run`);
    const index = indexRegistry(registry, { externalLabels });
    const routers = new Set([...index.programs.values()].filter((row) => row.category === 'aggregator').map((row) => row.programId));
    const state = { scans: previousState.scans ?? {}, pdaResolutions: previousState.pdaResolutions ?? {} };
    const flush = () => writeJson(STATE_PATH, { updatedAt: ts(), ...state }, 0);

    // Phase 0: Kamino market list (HTTP, not RPC) → every lending-market authority PDA, so a reserve
    // vault is attributed to its exact market. A failed list costs attribution precision only.
    let kaminoMarkets = [];
    let kaminoMarketsError = null;
    const kaminoResponse = await fetchJson(KAMINO_MARKETS_URL, { headers: { accept: 'application/json' }, timeoutMs: 60000 });
    if (kaminoResponse.ok && Array.isArray(kaminoResponse.json)) {
        kaminoMarkets = kaminoResponse.json.map((row) => ({ address: row.lendingMarket, name: row.name ?? row.description ?? null }));
    } else {
        kaminoMarketsError = `HTTP ${kaminoResponse.status}`;
        logWarn(`kamino markets: ${kaminoMarketsError} — reserve vaults fall back to program-level attribution`);
    }
    const authorities = deriveAuthorities(registry.authorityDerivations, { 'kamino-markets': kaminoMarkets });
    log(`registry: ${index.programs.size} program(s), ${index.addresses.size} known address(es), ${authorities.size} derived authority PDA(s) from ${kaminoMarkets.length} Kamino market(s)`);

    // Phase 1: holdings. holders.json (fresh) first, then a rotating direct scan of the rest.
    const holdings = new Map();
    const holdersAgeHours = holders?.fetchedAt ? (Date.parse(startedAt) - Date.parse(holders.fetchedAt)) / 3_600_000 : null;
    const covered = new Set();
    if (holdersAgeHours !== null && holdersAgeHours <= holdersMaxAgeHours) {
        for (const item of holders.items ?? []) {
            if (!tokenByMint.has(item.mint) || !Array.isArray(item.top20)) continue;
            covered.add(item.mint);
            holdings.set(item.mint, {
                read: { status: 'ok', source: 'holders.json', observedAt: holders.fetchedAt },
                accounts: item.top20.map((row) => ({ tokenAccount: row.tokenAccount, owner: row.owner, amountUi: row.amountUi, sharePct: row.sharePct }))
            });
        }
        log(`holders.json (${holdersAgeHours.toFixed(1)} h old): ${covered.size} mint(s) covered without new RPC reads`);
    } else {
        logWarn(`holders.json is ${holdersAgeHours === null ? 'missing' : `${holdersAgeHours.toFixed(1)} h old`} (> ${holdersMaxAgeHours} h) — every mint is scanned directly within the budget`);
    }
    const toScan = selectMintsToScan(tokens, { coveredMints: covered, scans: state.scans, budget });
    log(`direct scan: ${toScan.length} mint(s) this run (budget ${budget}); ${tokens.length - covered.size} not covered by holders.json`);
    let scanErrors = 0;
    const started = Date.now();
    // 1a: the largest accounts per mint; 1b: their owners, 100 token accounts per call across mints.
    const largestByMint = new Map();
    for (const [i, token] of toScan.entries()) {
        try {
            const largest = await call('getTokenLargestAccounts', [token.mint, { commitment: 'confirmed' }]);
            if (!Array.isArray(largest?.value)) throw new Error('expected {value:[...]}');
            largestByMint.set(token.mint, { slot: largest.context?.slot ?? null, values: largest.value, at: ts() });
        } catch (err) {
            scanErrors += 1;
            logWarn(`scan ${token.symbol ?? token.mint.slice(0, 8)}: ${err.message} — previous scan (if any) kept, never treated as empty`);
        }
        if ((i + 1) % 50 === 0 || i === toScan.length - 1) {
            const eta = Math.round(((Date.now() - started) / (i + 1)) * (toScan.length - i - 1) / 1000);
            log(`largest accounts: ${i + 1}/${toScan.length} · ${scanErrors} error(s) · ETA ${eta}s`);
        }
    }
    const tokenAccountOwner = new Map();
    const failedTokenAccounts = new Set();
    const allTokenAccounts = [...largestByMint.values()].flatMap((row) => row.values.map((value) => value.address));
    for (const batch of chunk(allTokenAccounts, MAX_ACCOUNTS_PER_REQUEST)) {
        try {
            const { value } = await accountsCall(batch, { encoding: 'jsonParsed' });
            batch.forEach((address, j) => tokenAccountOwner.set(address, value[j]?.data?.parsed?.info?.owner ?? null));
        } catch (err) {
            batch.forEach((address) => failedTokenAccounts.add(address));
            logWarn(`token-account batch failed: ${err.message} — ${batch.length} account(s) unread`);
        }
    }
    for (const token of toScan) {
        const largest = largestByMint.get(token.mint);
        if (!largest) continue;
        if (largest.values.some((row) => failedTokenAccounts.has(row.address))) {
            scanErrors += 1;
            logWarn(`scan ${token.symbol ?? token.mint.slice(0, 8)}: owner read failed — previous scan (if any) kept`);
            continue;
        }
        const supply = rawAmountOrNull(token.supplyRaw);
        state.scans[token.mint] = {
            scannedAt: largest.at,
            slot: largest.slot,
            accounts: largest.values.map((row) => {
                const raw = rawAmountOrNull(row.amount);
                return {
                    tokenAccount: row.address,
                    owner: tokenAccountOwner.get(row.address) ?? null,
                    amountUi: rawToUi(row.amount, row.decimals),
                    sharePct: raw === null || supply === null || supply === 0n ? null : Number((raw * 1_000_000n) / supply) / 10_000
                };
            })
        };
    }
    await flush();
    log(`direct scan: ${toScan.length - scanErrors}/${toScan.length} mint(s) read, ${allTokenAccounts.length} token account(s)`);
    const reuseBefore = Date.parse(startedAt) - SCAN_REUSE_DAYS * 86_400_000;
    for (const token of tokens) {
        if (holdings.has(token.mint)) continue;
        const scan = state.scans[token.mint];
        if (scan && Date.parse(scan.scannedAt) >= reuseBefore) {
            holdings.set(token.mint, {
                read: { status: 'ok', source: scan.scannedAt >= startedAt ? 'scan' : 'cached-scan', observedAt: scan.scannedAt, slot: scan.slot ?? null },
                accounts: scan.accounts
            });
        } else {
            holdings.set(token.mint, { read: { status: 'not-scanned', source: null, observedAt: scan?.scannedAt ?? null }, accounts: [] });
        }
    }

    // Phase 2: who owns each owner address (zero-length reads, 100 per call).
    const ownerList = [...new Set([...holdings.values()].flatMap((h) => h.accounts.map((row) => row.owner)).filter(Boolean))].sort();
    const ownerAccounts = new Map();
    const failedOwners = new Set();
    for (const batch of chunk(ownerList, MAX_ACCOUNTS_PER_REQUEST)) {
        try {
            const { value } = await accountsCall(batch, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } });
            batch.forEach((address, j) => ownerAccounts.set(address, value[j] ? { owner: value[j].owner, executable: value[j].executable === true } : null));
        } catch (err) {
            batch.forEach((address) => failedOwners.add(address));
            logWarn(`owner batch failed: ${err.message} — ${batch.length} owner(s) unread, their mints marked partial`);
        }
    }
    log(`owners: ${ownerList.length} distinct, ${failedOwners.size} unread`);

    // Phase 3: resolve the largest unresolved PDAs by the program that moves their tokens.
    const listed = listedIndex(usageDb);
    const provisional = tokens.map((token) => mintFootprint({ token, read: holdings.get(token.mint).read,
        accounts: holdings.get(token.mint).accounts, ownerAccounts, index, authorities, pdaResolutions: state.pdaResolutions, listed }));
    const retryBefore = Date.parse(startedAt) - UNRESOLVED_RETRY_DAYS * 86_400_000;
    const pending = provisional.flatMap((item) => item.unresolved.map((row) => ({ ...row, symbol: item.symbol, usd: (row.amountUi ?? 0) * (tokenByMint.get(item.mint)?.market?.usdPrice ?? 0) })))
        .filter((row) => !failedOwners.has(row.owner))
        .filter((row) => (row.sharePct ?? 0) >= CANDIDATE_MIN_SHARE_PCT || row.usd >= CANDIDATE_MIN_USD)
        .filter((row) => !(state.pdaResolutions[row.owner] && Date.parse(state.pdaResolutions[row.owner].resolvedAt) >= retryBefore))
        .sort((a, b) => b.usd - a.usd || (b.sharePct ?? 0) - (a.sharePct ?? 0));
    const uniquePending = [...new Map(pending.map((row) => [row.owner, row])).values()].slice(0, resolveBudget);
    log(`pda resolution: ${pending.length} unresolved owner row(s) above threshold, resolving ${uniquePending.length} (budget ${resolveBudget})`);
    for (const row of uniquePending) {
        try {
            const signatures = await call('getSignaturesForAddress', [row.tokenAccount, { limit: 8 }]);
            const parents = [];
            for (const sig of (Array.isArray(signatures) ? signatures : []).filter((s) => s.err === null).slice(0, 3)) {
                const tx = await call('getTransaction', [sig.signature, { maxSupportedTransactionVersion: 1, encoding: 'jsonParsed', commitment: 'confirmed' }]);
                parents.push(transferParents(tx, row.tokenAccount));
                if (resolvePdaProgram(parents, { ignore: routers }).basis === 'outgoing-transfer-signer') break;
            }
            const resolution = resolvePdaProgram(parents, { ignore: routers });
            state.pdaResolutions[row.owner] = { ...resolution, tokenAccount: row.tokenAccount, transactionsRead: parents.length, resolvedAt: ts() };
            log(`pda ${row.owner} (${row.symbol}): ${resolution.programId ?? 'unresolved'} via ${resolution.basis}`);
        } catch (err) {
            logWarn(`pda ${row.owner}: ${err.message} — left unresolved for the next run`);
        }
        await flush();
    }
    await flush();

    // Phase 4: final attribution with the new resolutions.
    const items = tokens.map((token) => {
        const holding = holdings.get(token.mint);
        const partial = holding.accounts.some((row) => failedOwners.has(row.owner));
        const read = partial ? { ...holding.read, status: 'partial' } : holding.read;
        const item = mintFootprint({ token, read, accounts: holding.accounts, ownerAccounts, index, authorities, pdaResolutions: state.pdaResolutions, listed });
        delete item.unresolved;
        return item;
    });
    const candidates = footprintCandidates(items);
    const rpcCalls = Object.values(calls).reduce((total, value) => total + value, 0);
    const byStatus = (status) => items.filter((item) => item.read.status === status).length;
    const output = {
        fetchedAt: startedAt,
        finishedAt: ts(),
        methodology: 'Largest token accounts per exact mint (holders.json top-20 or a direct getTokenLargestAccounts scan); each owner attributed by curated address, derived protocol authority PDA, the program owning its data account, wallet key (on the ed25519 curve), or a PDA resolved from the program that signs its outgoing transfers. Only the largest accounts are visible, so absence below the visibility floor proves nothing.',
        thresholds: { candidateMinSharePct: CANDIDATE_MIN_SHARE_PCT, candidateMinUsd: CANDIDATE_MIN_USD },
        sources: {
            rpcHost: rpcHost(rpc),
            holders: { fetchedAt: holders?.fetchedAt ?? null, used: covered.size > 0, mintsCovered: covered.size },
            kaminoMarkets: { url: KAMINO_MARKETS_URL, markets: kaminoMarkets.length, error: kaminoMarketsError },
            registry: { reviewedAt: registry.reviewedAt ?? null, programs: index.programs.size, knownAddresses: index.addresses.size },
            jupiterProgramLabels: { url: JUPITER_LABELS_URL, labels: externalLabels ? Object.keys(externalLabels).length : null }
        },
        rpc: { calls, total: rpcCalls, budget, resolveBudget },
        counts: {
            mints: items.length,
            readOk: byStatus('ok'),
            readPartial: byStatus('partial'),
            notScanned: byStatus('not-scanned'),
            scannedThisRun: toScan.length - scanErrors,
            scanErrors,
            mintsWithProgramHoldings: items.filter((item) => item.programs.length > 0).length,
            mintsWithDefiHoldings: items.filter((item) => item.programs.some((row) => row.defi)).length,
            candidates: candidates.length,
            unknownProgramCandidates: candidates.filter((row) => row.reason !== 'unlisted-integration').length,
            unlistedIntegrationCandidates: candidates.filter((row) => row.reason === 'unlisted-integration').length
        },
        candidates,
        items
    };
    await writeJson(OUT_PATH, output, 0);
    log(`wrote ${OUT_PATH}: ${output.counts.readOk}/${items.length} mint(s) read, ${output.counts.mintsWithDefiHoldings} with DeFi holdings, `
        + `${candidates.length} candidate(s); ${rpcCalls} RPC call(s) ${JSON.stringify(calls)}`);
    return 0;
}

main().then((code) => process.exit(code), (err) => {
    logError(err.stack ?? String(err));
    process.exit(1);
});
