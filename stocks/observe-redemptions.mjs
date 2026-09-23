#!/usr/bin/env node
// Daily recurring observer of issuer redemptions on Solana (next-steps.md item 11). For every
// programme whose redemption leaves an on-chain trail it reads the NEW transactions at the issuer's
// redemption addresses since its per-address checkpoint (getSignaturesForAddress with `until`),
// classifies them with lib/redemption-observation.mjs and keeps a rolling, compact record in
// stocks/data/redemption-observations.json: last observed redemption, counts per day for 30 days,
// the block-time coverage those counts rest on, rejected counts and an explicit "no redemption
// observed in N days of coverage" state. The builder (build-stocks-db.mjs) merges it into each
// issuer's redemption block via lib/redemption-feed.mjs.
//
// Programmes with no identifiable on-chain redemption leg (PreStocks, Tessera) are recorded as not
// observable, with the precise reason, plus a cheap tripwire (supply decreases, and for Tessera the
// program's deploy slot and on-chain IDL) that would show the day that changes.

import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { join, relative } from 'node:path';

import {
    ONDO_GM_MINT_AUTHORITY, ONDO_GM_PROGRAM, SUPERSTATE_EQUITY_BURN_ADDRESS, XSTOCKS_REDEMPTION_ADDRESS, XSTOCKS_TREASURY,
    classifyOndoTransaction, classifySuperstateLeg, classifyXstocksLeg, pairSuperstateConversion, pairXstocksRedemption,
    referencePriceAt
} from './lib/redemption-observation.mjs';
import {
    RETENTION_DAYS, bump, dayOf, intersectCoverage, pruneDaily, pruneIntervals, pushRecent,
    resolveXstocksDeposits, runInterval, selectBatch, summariseFeed
} from './lib/redemption-feed.mjs';
import { readEnvFile } from './lib/env.mjs';
import { fetchJson, log, logError, logWarn, parseArgs, readJson, sleep, ts, writeJson } from './lib/io.mjs';
import { findProgramAddress, fromBase58 } from './lib/squads.mjs';
import { base58 } from './lib/loopscale.mjs';
import { DEFAULT_RPC } from './lib/solana-rpc.mjs';
import { postTelegram } from './lib/telegram.mjs';
import { USDC_MINT, USDT_MINT } from './lib/trades.mjs';

const HERE = import.meta.dirname;
const REPO = join(HERE, '..');
const DEFAULT_OUT = join(HERE, 'data', 'redemption-observations.json');
const TOKENS_FILE = join(REPO, 'stocks-tokens.json');
const TRADES_FILE = join(HERE, 'data', 'trades-24h.json');
const ENV_FILE = join(REPO, '.env');

const USDON_MINT = 'ZPFtoCe7WWqG4N3ZFRccS8T9SMBeHsd1Vmgv2i7ondo';
const USDG_MINT = '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const TESSERA_TOKEN_PROGRAM = 'TESQvsR4TmYxiroPPQgZpVRoSFG8pru4fsYr67iv6kf';
const PRESTOCKS_AUTHORITY_VAULT = 'WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc';

const DEFAULT_BUDGET = 1500;
const DEFAULT_MAX_PAGES = 5;
const DEFAULT_PACE_MS = 150;
const SIGNATURE_PACE_MS = 500;
const PAGE = 1000;
const FINALITY_LAG_SECONDS = 60;
const XSTOCKS_WINDOW_SECONDS = 180;
const PRICE_WINDOW_SECONDS = 1800;
const SUPERSTATE_MAX_SECONDS = 7 * 86400;
const NO_REDEMPTION_NOTICE_DAYS = 3;
const BACKOFF_MS = [1000, 2000, 4000, 8000];

const OBSERVABLE = ['ondo-global-markets', 'xstocks-backed', 'superstate-opening-bell'];
const NOT_OBSERVABLE = ['prestocks', 'tessera'];

const MECHANISMS = {
    'ondo-global-markets': {
        mechanism: 'atomic-program-redemption',
        route: `Direct stablecoin redemption through the Ondo GM program ${ONDO_GM_PROGRAM} (redeem_for_usdc / redeem_for_usdon): one transaction burns the holder's GM token and pays USDon or USDC to the same signer.`,
        classifier: 'classifyOndoTransaction'
    },
    'xstocks-backed': {
        mechanism: 'three-leg-transfer-redemption',
        route: `Holder sends the xStock to the redemption address ${XSTOCKS_REDEMPTION_ADDRESS}, the issuer sweeps it to the treasury ${XSTOCKS_TREASURY}, and the treasury pays a stablecoin back; linked by wallet, ${XSTOCKS_WINDOW_SECONDS} s window and an independent DEX price (±2%).`,
        classifier: 'classifyXstocksLeg + pairXstocksRedemption'
    },
    'superstate-opening-bell': {
        mechanism: 'burn-to-book-entry-conversion',
        route: `Holder sends the equity token to the published burn address ${SUPERSTATE_EQUITY_BURN_ADDRESS}, whose owner burns it; the transfer agent then credits book-entry shares OFF-CHAIN. No cash payout by design. Observed here: the deposit and the issuer burn; not observable: the book-entry credit.`,
        classifier: 'classifySuperstateLeg + pairSuperstateConversion',
        completionObservable: false
    },
    prestocks: {
        mechanism: 'discretionary-off-chain-request',
        whyNotObservable: `Redemption is a discretionary off-chain request under the PreStocks Terms of Service ("A holder may request redemption of Tokens for USDC or another mutually agreed form of value"; "A request for redemption does not of itself create an entitlement to have Tokens redeemed"). No redemption address, program instruction, form or settlement procedure is published (prestocks.com/openai; the FAQ points holders to on-chain sale). A processed redemption could appear on-chain only as a transfer to, or a permanent-delegate burn by, the single Squads vault ${PRESTOCKS_AUTHORITY_VAULT} that holds every authority on all eight mints, which is indistinguishable from its other operations (issuance, fee withdrawal, clawback) without a documented address. The tripwire records raw-supply decreases as unattributed events, never as redemptions.`
    },
    tessera: {
        mechanism: 'terminal-burn-after-liquidity-event',
        whyNotObservable: `Redemption is terminal and contingent: holders burn T-Tokens to the Tessera smart contracts only during a Redemption Period, which opens after a Liquidity Event, receipt of the proceeds in full and a Redemption Start Date announced by TWF; per the Terms no Liquidity Event Proceeds have been received and no Redemption Period has commenced. The deployed Token Program ${TESSERA_TOKEN_PROGRAM} exposes no redeem or burn instruction in its on-chain Anchor IDL (see tripwire.programInstructions), so no on-chain redemption leg exists to observe yet. The tripwire flags a T-token supply decrease, a program upgrade (new deploy slot) or a redeem/burn/claim instruction appearing in the IDL.`
    }
};

function usage() {
    console.log(`observe-redemptions.mjs — recurring on-chain redemption observer (Ondo GM, xStocks, Superstate)

USAGE
  node stocks/observe-redemptions.mjs --run [options]

OPTIONS
  --run              Actually read the chain. Without it this help is printed and nothing runs.
  --only=<slugs>     Comma-separated issuer slugs (${[...OBSERVABLE, ...NOT_OBSERVABLE].join(', ')}).
  --budget=<n>       Max getTransaction calls per scanned address per run (default ${DEFAULT_BUDGET}).
                     What is not reached stays for the next run: the checkpoint only advances over
                     what was read, and the issuer's scan is marked partial with its backlog.
  --max-pages=<n>    Max getSignaturesForAddress pages (${PAGE} each) per address (default ${DEFAULT_MAX_PAGES}).
                     A backlog deeper than that is recorded as an explicit coverage GAP.
  --pace=<ms>        Spacing between getTransaction calls (default ${DEFAULT_PACE_MS}).
  --rpc=<url>        RPC endpoint (default SOLANA_RPC_URL from .env, else ${DEFAULT_RPC}). Never printed.
  --out=<file>       Output (default ${relative(REPO, DEFAULT_OUT)}).
  --no-telegram      Never send the summary; it is logged and kept in lastRun.noticeLines.
  --help             This text.

WHAT A RUN DOES
  Per observable issuer, per address: list signatures newer than the checkpoint, consume them
  OLDEST-first up to --budget, classify, and record coverage (the block-time interval whose every
  transaction was read). First run per address: the newest --budget signatures (baseline).
  - Ondo GM: program ${ONDO_GM_PROGRAM.slice(0, 8)}…; a burned mint not in stocks-tokens.json is accepted
    only if its on-chain mint authority is the GM PDA ${ONDO_GM_MINT_AUTHORITY.slice(0, 8)}….
  - xStocks: redemption address ${XSTOCKS_REDEMPTION_ADDRESS.slice(0, 8)}… first; then the treasury ${XSTOCKS_TREASURY.slice(0, 8)}…, fetching
    only signatures inside a deposit's ${XSTOCKS_WINDOW_SECONDS} s settlement window and never past the redemption
    address's coverage. A deposit is decided only when both addresses cover its window; prices come
    from ${relative(REPO, TRADES_FILE)}.
  - Superstate: the burn address's token accounts for the equity mints (deposits and burns).
  - PreStocks / Tessera: not observable (reason recorded); tripwire of 1–3 calls.
  The issuer record and its checkpoints are written together after each issuer (atomic write), so
  a kill loses at most the issuer in progress, never correctness.

FAILURE SEMANTICS
  A failed RPC call marks that issuer's lastScan.status "failed" with the error; coverage extends
  only over what was read, and the feed state becomes scan-failed — never "no redemptions".
  The run exits non-zero if any issuer failed.

FILES
  ${relative(REPO, DEFAULT_OUT)}   the rolling observation file (and lastRun for the outcome check)
  stocks-tokens.json                        mint → symbol per issuer
  ${relative(REPO, TRADES_FILE)}           independent DEX prices for xStocks pairing

REQUIREMENTS
  SOLANA_RPC_URL in ${relative(REPO, ENV_FILE) || '.env'} (never printed; only the host is logged). TELEGRAM_* optional.`);
}

function rpcHost(url) {
    try { return new URL(url).hostname; } catch { return 'configured RPC'; }
}

/** JSON-RPC with backoff on 429/5xx; counts calls; throws loudly on anything else. */
function makeRpc(url, counter) {
    return async function rpc(method, params) {
        for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt += 1) {
            counter.calls += 1;
            counter.byMethod[method] = (counter.byMethod[method] ?? 0) + 1;
            const res = await fetchJson(url, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), timeoutMs: 60000
            });
            if ((res.status === 429 || res.status >= 500) && attempt < BACKOFF_MS.length) {
                logWarn(`RPC ${method} HTTP ${res.status}; backing off ${BACKOFF_MS[attempt]} ms`);
                await sleep(BACKOFF_MS[attempt]);
                continue;
            }
            if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
            if (res.json === null) throw new Error(`${method} unparseable body: ${res.parseError}`);
            if (res.json.error) throw new Error(`${method} RPC error ${res.json.error.code}: ${res.json.error.message}`);
            return res.json.result;
        }
        throw new Error(`${method}: backoff exhausted`);
    };
}

/**
 * Newest-first signatures newer than `until`. Without a checkpoint: one page of `baseline`.
 * `reachedCheckpoint` is false when the page cap stopped the walk before the checkpoint — the
 * caller records the unlisted stretch as a gap instead of pretending it was read.
 */
async function listSignatures(rpc, address, { until, baseline, maxPages }) {
    // Signatures are listed at the default (finalized) commitment, which trails the tip; coverage
    // is claimed only up to a minute before the listing so a not-yet-finalized tx is never inside it.
    const listedAt = ts(new Date(Date.now() - FINALITY_LAG_SECONDS * 1000));
    if (!until) {
        const page = await rpc('getSignaturesForAddress', [address, { limit: Math.min(PAGE, baseline) }]);
        return { listed: page, reachedCheckpoint: true, completeHistory: page.length < Math.min(PAGE, baseline), listedAt };
    }
    const listed = [];
    let before;
    for (let pageNo = 0; pageNo < maxPages; pageNo += 1) {
        const page = await rpc('getSignaturesForAddress', [address, { limit: PAGE, until, ...(before ? { before } : {}) }]);
        listed.push(...page);
        if (page.length < PAGE) return { listed, reachedCheckpoint: true, completeHistory: false, listedAt };
        before = page.at(-1).signature;
        await sleep(SIGNATURE_PACE_MS);
    }
    return { listed, reachedCheckpoint: false, completeHistory: false, listedAt };
}

/**
 * Read one address: list, select oldest-first, fetch and hand each consumed signature to `onTx`
 * (tx null when no fetch was needed). An RPC error stops the address where it is: what was read
 * stays read, the error is returned, and the checkpoint covers exactly the consumed prefix.
 */
async function scanAddress(rpc, addrState, address, { budget, maxPages, pace, needsFetch, horizonFor, onTx, now }) {
    const checkpoint = addrState.checkpoint ?? null;
    let listing;
    try {
        listing = await listSignatures(rpc, address, { until: checkpoint?.signature ?? null, baseline: budget, maxPages });
    } catch (err) {
        return { error: `list ${address.slice(0, 8)}…: ${err.message}`, consumed: [], backlog: null, fetches: 0 };
    }
    const horizon = horizonFor ? horizonFor() : null;
    const { batch, heldBack } = selectBatch(listing.listed, { budget, needsFetch, horizon });
    const consumed = [];
    let fetches = 0;
    let error = null;
    const started = Date.now();
    for (const entry of batch) {
        try {
            let tx = null;
            if (entry.fetch) {
                tx = await rpc('getTransaction', [entry.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
                fetches += 1;
                if (tx === null) throw new Error(`getTransaction returned null for ${entry.signature}`);
                await sleep(pace);
            }
            onTx(entry, tx);
            consumed.push(entry);
        } catch (err) {
            error = `${address.slice(0, 8)}… at ${entry.signature.slice(0, 12)}…: ${err.message}`;
            break;
        }
        if (fetches > 0 && fetches % 100 === 0 && entry.fetch) {
            const rate = fetches / ((Date.now() - started) / 1000);
            const left = batch.filter((e) => e.fetch).length - fetches;
            log(`  ${address.slice(0, 8)}… ${fetches}/${batch.filter((e) => e.fetch).length} fetched · ETA ${Math.round(left / rate)} s`);
        }
    }
    // Unread because of the budget or an error; signatures past the horizon are deliberately left.
    const left = listing.listed.length - consumed.length - heldBack;
    const interval = runInterval({
        previousThrough: addrState.coveredThrough ?? null, consumed, backlog: left, listedAt: listing.listedAt, horizon,
        reachedCheckpoint: listing.reachedCheckpoint,
        completeHistorySince: listing.completeHistory ? ts(new Date(Date.parse(now) - RETENTION_DAYS * 86400000)) : null
    });
    const gap = !listing.reachedCheckpoint && addrState.coveredThrough && consumed.length
        ? { from: addrState.coveredThrough, to: ts(new Date(consumed[0].blockTime * 1000)), reason: `more than ${maxPages} signature pages since the checkpoint; the older stretch was not read` }
        : null;
    const last = consumed.at(-1) ?? null;
    return {
        error, consumed, fetches, backlog: left, interval, gap, listed: listing.listed.length,
        checkpoint: last ? { signature: last.signature, slot: last.slot ?? null, blockTime: ts(new Date(last.blockTime * 1000)) } : checkpoint
    };
}

/** Fold one address scan into its state. Coverage only ever grows by what was actually read. */
function commitAddress(addrState, result, { role, cutoff, now }) {
    const coverage = result.interval ? [...(addrState.coverage ?? []), result.interval] : (addrState.coverage ?? []);
    return {
        role,
        checkpoint: result.checkpoint ?? addrState.checkpoint ?? null,
        coverage: pruneIntervals(coverage, cutoff),
        coveredThrough: result.interval?.to ?? addrState.coveredThrough ?? null,
        lastScanAt: now,
        lastStatus: result.error ? 'failed' : result.backlog > 0 ? 'partial' : 'ok',
        lastError: result.error ?? null,
        backlog: result.backlog ?? null,
        lastListed: result.listed ?? 0,
        lastFetched: result.fetches ?? 0
    };
}

function explorer(signature) {
    return `https://solscan.io/tx/${signature}`;
}

function blank(slug) {
    return { slug, observable: true, ...MECHANISMS[slug], addresses: {}, coverage: [], gaps: [], daily: {}, recent: [],
        lastObserved: null, byProduct: {}, pending: {}, lastScan: null };
}

/** Common tail: coverage, pruning, verdict, status. */
function finishIssuer(entry, results, { now, cutoff }) {
    const errors = results.map((r) => r.error).filter(Boolean);
    const backlog = results.reduce((n, r) => n + (r.backlog ?? 0), 0);
    entry.coverage = pruneIntervals(intersectCoverage(Object.values(entry.addresses).map((a) => a.coverage ?? [])), cutoff);
    entry.gaps = [...(entry.gaps ?? []), ...results.map((r) => r.gap).filter(Boolean)].filter((g) => g.to >= cutoff);
    entry.daily = pruneDaily(entry.daily, now);
    entry.byProduct = Object.fromEntries(Object.entries(entry.byProduct ?? {}).filter(([, p]) => p.lastAt >= cutoff));
    entry.lastScan = {
        at: now,
        status: errors.length ? 'failed' : backlog > 0 ? 'partial' : 'ok',
        error: errors.length ? errors.join('; ') : null,
        fetched: results.reduce((n, r) => n + (r.fetches ?? 0), 0),
        consumed: results.reduce((n, r) => n + (r.consumed?.length ?? 0), 0),
        backlog
    };
    entry.summary = summariseFeed(entry, { now });
    return entry;
}

function acceptRow(entry, row, symbolOf) {
    const symbol = symbolOf(row.tokenMint);
    const full = { ...row, symbol };
    entry.recent = pushRecent(entry.recent, [full]);
    if (!entry.lastObserved || row.blockTime > entry.lastObserved.blockTime) entry.lastObserved = full;
    const prev = entry.byProduct[row.tokenMint];
    if (!prev || prev.lastAt < row.blockTime) entry.byProduct[row.tokenMint] = { symbol, lastAt: row.blockTime };
    bump(entry.daily, row.blockTime, 'redemptions');
}

// --- Ondo GM ---------------------------------------------------------------------------------
async function observeOndo(entry, ctx) {
    const known = ctx.mintsOf('ondo-global-markets');
    entry.verifiedMints ??= {};
    const stablecoins = { [USDC_MINT]: 'USDC', [USDON_MINT]: 'USDon' };
    const candidates = [];
    const counts = [];
    const addrState = entry.addresses[ONDO_GM_PROGRAM] ?? {};
    const result = await scanAddress(ctx.rpc, addrState, ONDO_GM_PROGRAM, {
        ...ctx.scan, onTx: (sig, tx) => {
            const when = ts(new Date(sig.blockTime * 1000));
            if (!tx) { counts.push([when, 'failedTx']); return; }
            const r = classifyOndoTransaction(tx, { stablecoins });
            if (r.kind === 'issuer-redemption') candidates.push(r);
            else if (r.kind === 'intermediated-redemption') counts.push([when, 'intermediated']);
            else if (r.kind === 'issuer-mint') counts.push([when, 'mints']);
            else if (r.kind === 'unclassified') counts.push([when, 'rejected', r.reason]);
            else if (r.kind === 'failed') counts.push([when, 'failedTx']);
            else counts.push([when, 'other']);
        }
    });
    // A burned mint must be a GM token: in the universe, or carrying the GM mint-authority PDA.
    const unknown = [...new Set(candidates.map((c) => c.tokenMint).filter((m) => !known.has(m) && !(m in entry.verifiedMints)))];
    for (let i = 0; i < unknown.length && !result.error; i += 100) {
        try {
            const res = await ctx.rpc('getMultipleAccounts', [unknown.slice(i, i + 100), { encoding: 'jsonParsed' }]);
            res.value.forEach((acct, j) => {
                const info = acct?.data?.parsed?.info;
                const symbol = info?.extensions?.find((e) => e.extension === 'tokenMetadata')?.state?.symbol ?? null;
                entry.verifiedMints[unknown[i + j]] = info?.mintAuthority === ONDO_GM_MINT_AUTHORITY ? { symbol } : false;
            });
        } catch (err) {
            result.error = `mint-authority check: ${err.message}`;
        }
    }
    if (result.error && unknown.some((m) => !(m in entry.verifiedMints))) {
        // Without the mint check the batch cannot be judged: nothing is committed for this issuer.
        return finishIssuer(entry, [{ ...result, interval: null, consumed: [], checkpoint: addrState.checkpoint ?? null }], ctx);
    }
    entry.addresses[ONDO_GM_PROGRAM] = commitAddress(addrState, result, { role: 'issuer-program', ...ctx });
    for (const [when, field, reason] of counts) bump(entry.daily, when, field, 1, reason ?? null);
    const symbolOf = (mint) => known.get(mint) ?? entry.verifiedMints[mint]?.symbol ?? null;
    for (const c of candidates) {
        if (!known.has(c.tokenMint) && !entry.verifiedMints[c.tokenMint]) {
            bump(entry.daily, c.blockTime, 'rejected', 1, 'burned mint is not an Ondo GM mint');
            continue;
        }
        acceptRow(entry, {
            id: c.signature, signature: c.signature, url: explorer(c.signature), slot: c.slot, blockTime: c.blockTime,
            holder: c.holder, tokenMint: c.tokenMint, tokenAmount: c.tokenAmount, payoutSymbol: c.payoutSymbol, payoutAmount: c.payoutAmount,
            instruction: c.instruction
        }, symbolOf);
    }
    return finishIssuer(entry, [result], ctx);
}

// --- xStocks ---------------------------------------------------------------------------------
async function observeXstocks(entry, ctx) {
    const known = ctx.mintsOf('xstocks-backed');
    const opts = { treasury: XSTOCKS_TREASURY, redemptionAddresses: [XSTOCKS_REDEMPTION_ADDRESS], xstockMints: new Set(known.keys()),
        stablecoins: { [USDC_MINT]: 'USDC', [USDT_MINT]: 'USDT', [USDG_MINT]: 'USDG' } };
    const pending = { deposits: [], sweeps: [], payouts: [], ...(entry.pending ?? {}) };
    const counts = [];
    const newDeposits = [];
    const newSweeps = [];
    const newPayouts = [];

    const redState = entry.addresses[XSTOCKS_REDEMPTION_ADDRESS] ?? {};
    const red = await scanAddress(ctx.rpc, redState, XSTOCKS_REDEMPTION_ADDRESS, {
        ...ctx.scan, onTx: (sig, tx) => {
            const when = ts(new Date(sig.blockTime * 1000));
            if (!tx) { counts.push([when, 'failedTx']); return; }
            const leg = classifyXstocksLeg(tx, opts);
            if (leg.kind === 'holder-deposit') { newDeposits.push(leg); counts.push([when, 'deposits']); }
            else if (leg.kind === 'redemption-sweep') { newSweeps.push(leg); counts.push([when, 'sweeps']); }
            else counts.push([when, leg.kind === 'failed' ? 'failedTx' : 'other']);
        }
    });
    const redCommitted = commitAddress(redState, red, { role: 'redemption-address', ...ctx });
    // The treasury is read only up to the redemption address's coverage: a payout beyond it could
    // belong to a deposit this run has not listed yet.
    const horizon = redCommitted.coveredThrough;
    const windows = [...pending.deposits, ...newDeposits].map((d) => [Date.parse(d.blockTime), Date.parse(d.blockTime) + XSTOCKS_WINDOW_SECONDS * 1000]);
    const inWindow = (sig) => !sig.err && windows.some(([a, b]) => sig.blockTime * 1000 >= a && sig.blockTime * 1000 <= b);
    const tState = entry.addresses[XSTOCKS_TREASURY] ?? {};
    const tre = horizon === null
        ? { error: null, consumed: [], fetches: 0, backlog: 0, interval: null, checkpoint: tState.checkpoint ?? null, listed: 0 }
        : await scanAddress(ctx.rpc, tState, XSTOCKS_TREASURY, {
            ...ctx.scan, needsFetch: inWindow, horizonFor: () => horizon, onTx: (sig, tx) => {
                if (!tx) return;
                const leg = classifyXstocksLeg(tx, opts);
                if (leg.kind === 'treasury-stablecoin-payout') { newPayouts.push(leg); counts.push([leg.blockTime, 'payoutsInWindows']); }
            }
        });
    entry.addresses[XSTOCKS_REDEMPTION_ADDRESS] = redCommitted;
    entry.addresses[XSTOCKS_TREASURY] = commitAddress(tState, tre, { role: 'treasury', ...ctx });
    for (const [when, field] of counts) bump(entry.daily, when, field);

    const coverage = intersectCoverage([entry.addresses[XSTOCKS_REDEMPTION_ADDRESS].coverage, entry.addresses[XSTOCKS_TREASURY].coverage]);
    const deposits = [...pending.deposits, ...newDeposits];
    const sweeps = [...pending.sweeps, ...newSweeps];
    const payouts = [...pending.payouts, ...newPayouts];
    let noPrice = 0;
    const { accepted, rejected, pending: still } = resolveXstocksDeposits({
        deposits, sweeps, payouts, coverage, now: ctx.now, maxSeconds: XSTOCKS_WINDOW_SECONDS, pair: pairXstocksRedemption,
        // The trade collector runs every 3 h: a deposit is priced only once its ±30 min window is behind it.
        priceReadyFor: (d) => Number.isFinite(ctx.tradesUpdatedAt) && ctx.tradesUpdatedAt >= Date.parse(d.blockTime) + PRICE_WINDOW_SECONDS * 1000,
        priceFor: (d) => {
            const price = referencePriceAt(ctx.trades, { mint: d.tokenMint, time: d.blockTime, windowSeconds: PRICE_WINDOW_SECONDS });
            if (price === null) noPrice += 1;
            return price;
        }
    });
    const symbolOf = (mint) => known.get(mint) ?? null;
    for (const { deposit, sweep, result } of accepted) {
        acceptRow(entry, {
            id: deposit.signature, blockTime: deposit.blockTime, holder: deposit.holder, tokenMint: deposit.tokenMint, tokenAmount: deposit.tokenAmount,
            payoutSymbol: result.payoutSymbol, payoutAmount: result.payoutAmount, impliedPriceUsd: result.impliedPriceUsd,
            referencePriceUsd: result.referencePriceUsd, settlementSeconds: result.settlementSeconds,
            legs: [
                { role: 'holder-deposit', signature: deposit.signature, url: explorer(deposit.signature), blockTime: deposit.blockTime },
                { role: 'issuer-sweep-to-treasury', signature: sweep.signature, url: explorer(sweep.signature), blockTime: sweep.blockTime },
                { role: 'treasury-stablecoin-payout', signature: result.legs.payout, url: explorer(result.legs.payout) }
            ]
        }, symbolOf);
    }
    for (const { deposit, reason } of rejected) bump(entry.daily, deposit.blockTime, 'rejected', 1, reason);
    const keepFrom = still.length ? Math.min(...still.map((d) => Date.parse(d.blockTime))) : Infinity;
    const usedSweeps = new Set(accepted.map((a) => a.sweep.signature));
    entry.pending = {
        deposits: still,
        sweeps: sweeps.filter((s) => !usedSweeps.has(s.signature) && Date.parse(s.blockTime) >= keepFrom),
        payouts: payouts.filter((p) => Date.parse(p.blockTime) >= keepFrom)
    };
    if (noPrice) log(`  xstocks: ${noPrice} deposit(s) had no independent reference price in ${relative(REPO, TRADES_FILE)}`);
    return finishIssuer(entry, [red, tre], ctx);
}

// --- Superstate ------------------------------------------------------------------------------
async function observeSuperstate(entry, ctx) {
    const known = ctx.mintsOf('superstate-opening-bell');
    const equityMints = new Set(known.keys());
    let accounts;
    try {
        const res = await ctx.rpc('getTokenAccountsByOwner', [SUPERSTATE_EQUITY_BURN_ADDRESS, { programId: TOKEN_2022 }, { encoding: 'jsonParsed' }]);
        accounts = res.value.map((a) => ({ address: a.pubkey, mint: a.account?.data?.parsed?.info?.mint })).filter((a) => equityMints.has(a.mint));
    } catch (err) {
        return finishIssuer(entry, [{ error: `burn-address token accounts: ${err.message}`, consumed: [], backlog: 0 }], ctx);
    }
    const pending = { deposits: [], ...(entry.pending ?? {}) };
    const deposits = [];
    const burns = [];
    const counts = [];
    const results = [];
    const seen = new Set();
    for (const account of accounts) {
        const state = entry.addresses[account.address] ?? {};
        const result = await scanAddress(ctx.rpc, state, account.address, {
            ...ctx.scan, onTx: (sig, tx) => {
                if (!tx || seen.has(sig.signature)) return;
                seen.add(sig.signature);
                const leg = classifySuperstateLeg(tx, { equityMints });
                if (leg.kind === 'holder-deposit') { deposits.push(leg); counts.push([leg.blockTime, 'deposits']); }
                else if (leg.kind === 'issuer-burn') burns.push(leg);
                else if (leg.kind === 'unclassified') counts.push([leg.blockTime, 'rejected', leg.reason]);
            }
        });
        entry.addresses[account.address] = { ...commitAddress(state, result, { role: `burn-address token account (${known.get(account.mint)})`, ...ctx }), mint: account.mint };
        results.push(result);
    }
    for (const [when, field, reason] of counts) bump(entry.daily, when, field, 1, reason ?? null);
    const pool = [...pending.deposits, ...deposits];
    const used = new Set();
    for (const burn of burns.sort((a, b) => Date.parse(a.blockTime) - Date.parse(b.blockTime))) {
        const pair = pairSuperstateConversion({ burn, deposits: pool, used, maxSeconds: SUPERSTATE_MAX_SECONDS });
        if (pair.legs.deposit) used.add(pair.legs.deposit);
        acceptRow(entry, {
            id: burn.signature, blockTime: burn.blockTime, holder: pair.holder, tokenMint: burn.tokenMint, tokenAmount: burn.tokenAmount,
            memo: pair.memo, secondsToBurn: pair.secondsToBurn, payoutSymbol: null, payoutAmount: null,
            completion: 'book-entry credit off-chain (not observable)',
            legs: [
                ...(pair.legs.deposit ? [{ role: 'holder-deposit-to-burn-address', signature: pair.legs.deposit, url: explorer(pair.legs.deposit) }] : []),
                { role: 'issuer-burn', signature: burn.signature, url: explorer(burn.signature), blockTime: burn.blockTime }
            ]
        }, (mint) => known.get(mint) ?? null);
    }
    const nowMs = Date.parse(ctx.now);
    const open = pool.filter((d) => !used.has(d.signature));
    for (const d of open.filter((d) => nowMs - Date.parse(d.blockTime) > SUPERSTATE_MAX_SECONDS * 1000)) {
        bump(entry.daily, d.blockTime, 'rejected', 1, 'deposit to the burn address not burned within 7 days');
    }
    entry.pending = { deposits: open.filter((d) => nowMs - Date.parse(d.blockTime) <= SUPERSTATE_MAX_SECONDS * 1000) };
    if (!results.length) results.push({ error: `no equity token account found at the burn address`, consumed: [], backlog: 0 });
    return finishIssuer(entry, results, ctx);
}

// --- not observable: tripwires ---------------------------------------------------------------
function anchorIdlAddress(program) {
    const { address: base } = findProgramAddress([], program);
    return base58(new Uint8Array(createHash('sha256').update(fromBase58(base)).update('anchor:idl').update(fromBase58(program)).digest()));
}

async function tripwire(entry, slug, ctx) {
    const mints = [...ctx.mintsOf(slug).entries()];
    const previous = entry.tripwire?.supplies ?? {};
    const events = [...(entry.tripwire?.events ?? [])];
    const errors = [];
    const supplies = {};
    let slot = null;
    try {
        const res = await ctx.rpc('getMultipleAccounts', [mints.map(([m]) => m), { encoding: 'jsonParsed' }]);
        slot = res.context?.slot ?? null;
        res.value.forEach((acct, i) => {
            const [mint, symbol] = mints[i];
            const supply = acct?.data?.parsed?.info?.supply;
            if (typeof supply !== 'string') { errors.push(`${symbol}: no supply in account`); return; }
            supplies[mint] = supply;
            if (typeof previous[mint] === 'string' && BigInt(supply) < BigInt(previous[mint])) {
                events.push({ kind: 'supply-decrease', mint, symbol, before: previous[mint], after: supply, slot, detectedAt: ctx.now,
                    note: 'Unattributed raw-supply decrease (a burn). Not counted as a redemption; inspect the mint history.' });
            }
        });
    } catch (err) {
        errors.push(`supply read: ${err.message}`);
    }
    const out = { supplies: Object.keys(supplies).length ? supplies : previous, suppliesSlot: slot, suppliesReadAt: ctx.now };
    if (slug === 'tessera') {
        try {
            const program = await ctx.rpc('getAccountInfo', [TESSERA_TOKEN_PROGRAM, { encoding: 'jsonParsed' }]);
            const programData = program?.value?.data?.parsed?.info?.programData;
            const pd = await ctx.rpc('getAccountInfo', [programData, { encoding: 'base64', dataSlice: { offset: 0, length: 12 } }]);
            const deploySlot = Number(Buffer.from(pd.value.data[0], 'base64').readBigUInt64LE(4));
            const idl = await ctx.rpc('getAccountInfo', [anchorIdlAddress(TESSERA_TOKEN_PROGRAM), { encoding: 'base64' }]);
            let names = null;
            if (idl?.value) {
                const buf = Buffer.from(idl.value.data[0], 'base64');
                names = JSON.parse(inflateSync(buf.subarray(44, 44 + buf.readUInt32LE(40))).toString()).instructions.map((i) => i.name);
            }
            const prev = entry.tripwire ?? {};
            if (prev.programDeploySlot && prev.programDeploySlot !== deploySlot) {
                events.push({ kind: 'program-upgrade', program: TESSERA_TOKEN_PROGRAM, before: prev.programDeploySlot, after: deploySlot, detectedAt: ctx.now,
                    note: 'The Tessera Token Program was redeployed: re-check whether a redemption instruction now exists.' });
            }
            const redeemLike = (names ?? []).filter((n) => /redeem|burn|claim/i.test(n));
            if (redeemLike.length && !(prev.redeemLikeInstructions ?? []).length) {
                events.push({ kind: 'redeem-instruction', program: TESSERA_TOKEN_PROGRAM, instructions: redeemLike, detectedAt: ctx.now,
                    note: 'A redeem/burn/claim instruction appeared in the on-chain IDL: a redemption leg may now be observable.' });
            }
            Object.assign(out, { program: TESSERA_TOKEN_PROGRAM, programData, programDeploySlot: deploySlot, programInstructions: names, redeemLikeInstructions: redeemLike });
        } catch (err) {
            errors.push(`program/IDL read: ${err.message}`);
            Object.assign(out, { program: TESSERA_TOKEN_PROGRAM, programDeploySlot: entry.tripwire?.programDeploySlot ?? null,
                programInstructions: entry.tripwire?.programInstructions ?? null, redeemLikeInstructions: entry.tripwire?.redeemLikeInstructions ?? [] });
        }
    }
    const fresh = events.length - (entry.tripwire?.events ?? []).length;
    return {
        slug, observable: false, ...MECHANISMS[slug],
        tripwire: { ...out, events: events.slice(-10) },
        lastScan: { at: ctx.now, status: errors.length ? 'failed' : 'ok', error: errors.length ? errors.join('; ') : null, newEvents: fresh }
    };
}

// --- main ------------------------------------------------------------------------------------
function noticesFor(slug, before, after) {
    const lines = [];
    if (after.lastScan?.status === 'failed') lines.push(`${slug}: scan FAILED — ${after.lastScan.error}`);
    if (after.observable === false) {
        const fresh = after.lastScan?.newEvents ?? 0;
        for (const e of fresh > 0 ? (after.tripwire?.events ?? []).slice(-fresh) : []) {
            lines.push(`${slug}: ${e.kind} ${e.symbol ?? e.program ?? ''} — ${e.note}`);
        }
        return lines;
    }
    const was = before?.summary?.state ?? null;
    const now = after.summary?.state;
    if (now === 'none-observed' && after.summary.noRedemptionDays >= NO_REDEMPTION_NOTICE_DAYS && was !== 'none-observed') {
        lines.push(`${slug}: ${after.summary.message}`);
    }
    if (now === 'observed' && was === 'none-observed') lines.push(`${slug}: redemptions observed again — ${after.summary.message}`);
    return lines;
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return;
    }
    const startedAt = ts();
    const env = await readEnvFile(ENV_FILE);
    const url = typeof flags.rpc === 'string' ? flags.rpc : env.SOLANA_RPC_URL ?? process.env.SOLANA_RPC_URL ?? DEFAULT_RPC;
    const outFile = typeof flags.out === 'string' ? flags.out : DEFAULT_OUT;
    const only = typeof flags.only === 'string' ? new Set(flags.only.split(',')) : null;
    const budget = Number(flags.budget ?? DEFAULT_BUDGET);
    const maxPages = Number(flags['max-pages'] ?? DEFAULT_MAX_PAGES);
    const pace = Number(flags.pace ?? DEFAULT_PACE_MS);
    for (const [name, value] of Object.entries({ budget, maxPages, pace })) {
        if (!Number.isInteger(value) || value < (name === 'pace' ? 0 : 1)) throw new Error(`--${name} must be a positive integer`);
    }
    const slugs = [...OBSERVABLE, ...NOT_OBSERVABLE].filter((s) => !only || only.has(s));
    if (only) for (const s of only) if (!slugs.includes(s)) throw new Error(`unknown issuer ${s}`);

    const tokens = (await readJson(TOKENS_FILE)).tokens;
    const mintsOf = (slug) => new Map(tokens.filter((t) => t.issuer === slug).map((t) => [t.mint, t.symbol ?? null]));
    const tradesFile = await readJson(TRADES_FILE, { trades: [] });
    const trades = Array.isArray(tradesFile.trades) ? tradesFile.trades : [];
    const data = await readJson(outFile, { schema: 1, issuers: {} });
    const counter = { calls: 0, byMethod: {} };
    const rpc = makeRpc(url, counter);
    log(`observe-redemptions: ${slugs.length} issuer(s) via ${rpcHost(url)} · budget ${budget}/address · ${maxPages} page(s) · pace ${pace} ms · ${trades.length} reference trade(s)`);

    const notices = [];
    const statuses = {};
    for (let i = 0; i < slugs.length; i += 1) {
        const slug = slugs[i];
        const now = ts();
        const cutoff = ts(new Date(Date.parse(now) - RETENTION_DAYS * 86400000));
        const ctx = { rpc, now, cutoff, mintsOf, trades, tradesUpdatedAt: Date.parse(tradesFile.updatedAt ?? ''), scan: { budget, maxPages, pace, now } };
        const before = data.issuers[slug] ?? null;
        const callsBefore = counter.calls;
        log(`[${i + 1}/${slugs.length}] ${slug}`);
        let after;
        try {
            // Static mechanism fields come from this file, so a corrected description reaches old records.
            const entry = before && before.observable !== false ? { ...structuredClone(before), ...MECHANISMS[slug] } : blank(slug);
            if (slug === 'ondo-global-markets') after = await observeOndo(entry, ctx);
            else if (slug === 'xstocks-backed') after = await observeXstocks(entry, ctx);
            else if (slug === 'superstate-opening-bell') after = await observeSuperstate(entry, ctx);
            else after = await tripwire(before ?? {}, slug, ctx);
        } catch (err) {
            logError(`${slug}: ${err.stack || err.message}`);
            const base = before ?? (NOT_OBSERVABLE.includes(slug) ? { slug, observable: false, ...MECHANISMS[slug] } : blank(slug));
            after = { ...base, lastScan: { at: now, status: 'failed', error: err.message } };
            if (after.observable !== false) after.summary = summariseFeed(after, { now });
        }
        data.issuers[slug] = after;
        statuses[slug] = after.lastScan?.status ?? 'failed';
        notices.push(...noticesFor(slug, before, after));
        data.generatedAt = ts();
        await writeJson(outFile, data);
        const s = after.summary;
        const today = after.daily?.[dayOf(now)] ?? {};
        log(`  ${slug}: ${after.lastScan?.status}${after.lastScan?.error ? ` (${after.lastScan.error})` : ''} · ${counter.calls - callsBefore} RPC call(s)`
            + (after.observable === false ? ` · not observable · tripwire ${after.tripwire?.events?.length ?? 0} event(s)`
                : ` · fetched ${after.lastScan.fetched} · consumed ${after.lastScan.consumed} · backlog ${after.lastScan.backlog}`
                + ` · today ${JSON.stringify(today)} · state ${s.state}: ${s.message}`));
    }

    const failed = Object.entries(statuses).filter(([, s]) => s === 'failed').map(([slug]) => slug);
    data.lastRun = {
        status: failed.length ? 'failed' : Object.values(statuses).includes('partial') ? 'partial' : 'ok',
        startedAt, endedAt: ts(), rpcHost: rpcHost(url), rpcCalls: counter.calls, rpcByMethod: counter.byMethod,
        budgetPerAddress: budget, issuers: statuses, failed, noticeLines: notices
    };
    data.generatedAt = data.lastRun.endedAt;
    await writeJson(outFile, data);
    log(`observe-redemptions: ${data.lastRun.status} · ${counter.calls} RPC call(s) ${JSON.stringify(counter.byMethod)} · wrote ${relative(REPO, outFile)}`);
    if (notices.length && !flags['no-telegram']) {
        await postTelegram(['RWA Sonar redemption observer', ...notices].join('\n'), { env });
    } else if (notices.length) for (const line of notices) log(`notice | ${line}`);
    if (failed.length) {
        logError(`observe-redemptions: run NOT successful — failed: ${failed.join(', ')}`);
        process.exitCode = 1;
    }
}

main().catch((err) => {
    logError(err.stack || err.message);
    process.exitCode = 1;
});
