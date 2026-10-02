#!/usr/bin/env node
// Collects Solana depth for every tokenized stock a lending market takes as collateral: the USD
// sale into USDC at which Jupiter's KEYLESS quote reports a 5 % and a 10 % average price impact.
// Each run quotes a ladder of sale sizes per token (smallest first, stopping at 10 % impact) and
// appends one sample per token to stocks/data/solana-depth.json, tagged with the US session it was
// taken in, so weekday and weekend depth build up over time. Rules in lib/solana-depth.mjs (tested).
// Budgeted and paced for lite-api.jup.ag's ~60 requests/minute; checkpoints after every token and
// skips a token already sampled in the same session kind recently, so a killed run resumes.

import { join } from 'node:path';

import { fetchJson, log, logError, logWarn, parseArgs, readJson, sleep, ts, writeJson } from './lib/io.mjs';
import { DEFAULT_PACE_MS } from './lib/jupiter.mjs';
import { usEquitySchedule } from './lib/lending-events.mjs';
import { parseSchedule } from './lib/market-hours.mjs';
import {
    LADDER_USD, PRICE_URL, QUOTE_URL, USDC_MINT, buildSample, ladderDone, ladderPrice, lenderMints, mergeSamples,
    rawAmountForUsd, refinementSizes, sampledRecently, sessionKind, stepFromQuote, withSteps
} from './lib/solana-depth.mjs';

const HERE = import.meta.dirname;
const DEFAULT_OUT = join(HERE, 'data', 'solana-depth.json');
const DEFAULT_BUDGET = 260;
const DEFAULT_MIN_AGE_HOURS = 5;
// The keyless quote API is shared with every other caller from this address; a 429 burst on
// 2026-09-24 outlasted 2 + 5 + 15 s, so this collector waits longer before giving a token up.
const BACKOFF_MS = [10000, 30000, 60000];
/** Jupiter's answer when a size simply cannot be routed. */
const NO_ROUTE_CODES = new Set(['COULD_NOT_FIND_ANY_ROUTE', 'NO_ROUTES_FOUND', 'ROUTE_NOT_FOUND']);

function usage() {
    console.log(`fetch-solana-depth.mjs — the USD sale that moves each lender-accepted stock token 5 % and 10 % on Solana

USAGE
  node stocks/fetch-solana-depth.mjs --run [options]

OPTIONS
  --run                  Actually quote. Without it this help is printed and nothing runs.
  --budget=<n>           Max Jupiter calls this run, price reads included (default ${DEFAULT_BUDGET}).
  --only=<SYM,SYM>       Only these symbols (a small first run).
  --min-age-hours=<n>    Skip a token sampled in the same session kind within n hours (default ${DEFAULT_MIN_AGE_HOURS}).
  --pace-ms=<n>          Delay between calls (default ${DEFAULT_PACE_MS}, lite-api allows ~60/min).
  --out=<path>           Store (default stocks/data/solana-depth.json).
  --help                 This text.

SOURCE
  ${PRICE_URL}?ids=…         price and decimals (pre-scaled price for scaled-UI mints)
  ${QUOTE_URL}?inputMint=<token>&outputMint=USDC&amount=<raw>   all routes, ExactIn
  Ladder: ${LADDER_USD.map((u) => `$${u.toLocaleString('en-US')}`).join(', ')}; stops at 10 % impact or no route,
  then one quote at the geometric midpoint of each bracket the 5 % and 10 % thresholds fell into.
  About 5–9 calls per token; ~31 tokens (2026-09-24) fit the default budget in ~4–5 minutes.

OUTPUT
  {fetchedAt, source, method, samples[]}: per token and run, the request time (the quote is live,
  so that IS the measurement time), the session (open / closed / weekend), the price used, the
  ladder, and at5Pct / at10Pct {usd, bound}: bound "interpolated" between two ladder sizes, "below"
  the smallest, "above" the largest, or "no-route". Samples older than 45 days are dropped.`);
}

/** One quote, with 429 back-off. Returns {step} or {error}. */
async function quote(mint, usd, price, paceMs, counter) {
    const raw = rawAmountForUsd(usd, price);
    if (raw === null) return { error: 'no usable amount' };
    const url = `${QUOTE_URL}?inputMint=${mint}&outputMint=${USDC_MINT}&amount=${raw}&slippageBps=50&swapMode=ExactIn`;
    for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt += 1) {
        counter.calls += 1;
        const res = await fetchJson(url, { timeoutMs: 30000 }).catch((err) => ({ ok: false, status: null, parseError: err.message }));
        if (res.status === 429 && attempt < BACKOFF_MS.length) {
            logWarn(`429 from the quote API; backing off ${BACKOFF_MS[attempt]} ms`);
            await sleep(BACKOFF_MS[attempt]);
            continue;
        }
        await sleep(paceMs);
        if (res.ok) {
            const step = stepFromQuote(usd, res.json);
            return step === null ? { error: `unreadable quote: ${res.bodyPreview}` } : { step };
        }
        const code = res.json?.errorCode ?? null;
        if (NO_ROUTE_CODES.has(code)) return { step: { usd, impactPct: null, outUsd: null, noRoute: true, contextSlot: null } };
        return { error: `HTTP ${res.status} ${code ?? ''} ${res.json?.error ?? res.parseError ?? ''}`.trim() };
    }
    return { error: 'rate limited' };
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }
    const outPath = typeof flags.out === 'string' ? flags.out : DEFAULT_OUT;
    const budget = Number.isInteger(Number(flags.budget)) && Number(flags.budget) > 0 ? Number(flags.budget) : DEFAULT_BUDGET;
    const paceMs = Number.isInteger(Number(flags['pace-ms'])) && Number(flags['pace-ms']) >= 0 ? Number(flags['pace-ms']) : DEFAULT_PACE_MS;
    const minAgeHours = Number.isFinite(Number(flags['min-age-hours'])) ? Number(flags['min-age-hours']) : DEFAULT_MIN_AGE_HOURS;
    const only = typeof flags.only === 'string' ? new Set(flags.only.split(',').map((s) => s.trim()).filter(Boolean)) : null;

    const research = await readJson(join(HERE, 'data', 'protocol-market-research.json'));
    const defiUsage = await readJson(join(HERE, 'data', 'defi-usage.json'), { items: [] });
    const schedule = parseSchedule(usEquitySchedule(await readJson(join(HERE, 'data', 'reference-prices.json'), { items: [] })));
    if (schedule === null) throw new Error('no US equity schedule in stocks/data/reference-prices.json (run stocks/fetch-reference-prices.mjs)');
    const store = await readJson(outPath, { samples: [] });
    let samples = Array.isArray(store.samples) ? store.samples : [];

    const nowMs = Date.now();
    const session = sessionKind(schedule, nowMs);
    let tokens = lenderMints(research?.oraclePricing, defiUsage);
    if (only !== null) tokens = tokens.filter((t) => only.has(t.symbol));
    const skipped = tokens.filter((t) => sampledRecently(samples, t.mint, session, nowMs, minAgeHours));
    tokens = tokens.filter((t) => !skipped.includes(t));
    // Oldest sample first, so a budget that runs out rotates rather than always dropping the tail.
    const lastAt = (mint) => samples.filter((s) => s.mint === mint).map((s) => s.at).sort().at(-1) ?? '';
    tokens.sort((a, b) => (lastAt(a.mint) < lastAt(b.mint) ? -1 : lastAt(a.mint) > lastAt(b.mint) ? 1 : 0));
    log(`session ${session}; ${tokens.length} token(s) to quote, ${skipped.length} skipped as sampled in this session within ${minAgeHours} h`
        + `${skipped.length ? ` (${skipped.map((t) => t.symbol).join(', ')})` : ''}; budget ${budget} call(s)`);

    const counter = { calls: 0 };
    const prices = new Map();
    for (let i = 0; i < tokens.length; i += 50) {
        const ids = tokens.slice(i, i + 50).map((t) => t.mint);
        counter.calls += 1;
        const res = await fetchJson(`${PRICE_URL}?ids=${ids.join(',')}`, { timeoutMs: 30000 });
        if (!res.ok || res.json === null) throw new Error(`price v3 HTTP ${res.status}: ${res.bodyPreview}`);
        for (const id of ids) {
            const price = ladderPrice(res.json[id]);
            if (price !== null) prices.set(id, price);
        }
        await sleep(paceMs);
    }

    // Checkpoint after every token, measured or not: a killed run keeps what it learned.
    const save = () => writeJson(outPath, {
        fetchedAt: ts(),
        source: 'Jupiter keyless quote API (lite-api.jup.ag/swap/v1/quote, all routes, token → USDC)',
        method: 'Average price impact Jupiter reports for a sale of each ladder size; the 5 % and 10 % sizes are interpolated log-linearly between the two sizes that bracket them. noPrice: Jupiter reported no price for the token, so there is no Solana market to sell into.',
        samples
    });
    const errors = [];
    let measured = 0;
    const startedMs = Date.now();
    for (const [index, token] of tokens.entries()) {
        const price = prices.get(token.mint) ?? null;
        if (price === null) {
            // No Jupiter price means no Solana market to sell into: stored, so the page can say so.
            log(`${index + 1}/${tokens.length} ${token.symbol}: Jupiter reports no price (no Solana market); stored as such`);
            samples = mergeSamples(samples, [buildSample({ at: ts(new Date()), session, mint: token.mint, symbol: token.symbol, price: null, steps: [] })], Date.now());
            await save();
            continue;
        }
        if (counter.calls + 2 > budget) {
            logWarn(`budget of ${budget} call(s) reached; ${tokens.length - index} token(s) left for the next run`);
            break;
        }
        const at = ts(new Date());
        let steps = [];
        let error = null;
        for (const usd of LADDER_USD) {
            if (counter.calls >= budget) {
                error = 'budget reached mid-ladder';
                break;
            }
            const result = await quote(token.mint, usd, price, paceMs, counter);
            if (result.error) {
                error = result.error;
                break;
            }
            steps.push(result.step);
            if (ladderDone(steps)) break;
        }
        // One more quote inside each bracket the thresholds fell into, budget permitting.
        for (const usd of error === null ? refinementSizes(steps) : []) {
            if (counter.calls >= budget) break;
            const result = await quote(token.mint, usd, price, paceMs, counter);
            if (result.error) {
                error = result.error;
                break;
            }
            steps = withSteps(steps, [result.step]);
        }
        if (error !== null) {
            // A partial ladder is not stored: an unfinished ladder would read as a bound it never reached.
            errors.push(`${token.symbol}: ${error}`);
            logWarn(`${token.symbol}: ${error}; not stored`);
            continue;
        }
        const sample = buildSample({ at, session, mint: token.mint, symbol: token.symbol, price, steps });
        samples = mergeSamples(samples, [sample], Date.now());
        await save();
        measured += 1;
        const fmt = (x) => (x === null ? 'n/a' : `${x.bound === 'interpolated' ? '≈' : x.bound === 'below' ? '<' : x.bound === 'above' ? '>' : 'no route at'} $${Math.round(x.usd).toLocaleString('en-US')}`);
        const elapsed = (Date.now() - startedMs) / 1000;
        const eta = Math.round((elapsed / (index + 1)) * (tokens.length - index - 1));
        log(`${index + 1}/${tokens.length} ${token.symbol}: ${steps.length} quote(s) · 5 % ${fmt(sample.at5Pct)} · 10 % ${fmt(sample.at10Pct)} · ${counter.calls} call(s) · ETA ${eta}s`);
    }
    log(`wrote ${outPath}: ${measured} token(s) measured this run (${session}), ${samples.length} sample(s) stored, ${counter.calls} call(s), ${errors.length} error(s)`);
    if (errors.length) {
        logError(`depth errors: ${errors.join(' | ')}`);
        return 1;
    }
    return 0;
}

main().then((code) => process.exit(code), (err) => {
    logError(err.stack ?? String(err));
    process.exit(1);
});
