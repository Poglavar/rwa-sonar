#!/usr/bin/env node
// Daily corporate-action reconciliation: fetches every tracked underlying's splits and cash
// dividends (Yahoo chart v8, keyless), rebuilds each mint's scaled-UI multiplier steps from the
// chain watcher's sonar.mint_state readings, and records per action and per step whether the
// on-chain multiplier moved as the programme's own documents say it should — matched, late, wrong
// ratio, missing — and every multiplier move no corporate action explains (the PreStocks OPENAI
// ×1.4861347 restatement). Stores sonar.corporate_action / corporate_action_check
// (db/2026-10-01-sonar-corporate-actions.sql).
//
// All decisions live in lib/corporate-actions.mjs (tested in corporate-actions.test.js); this file
// is the IO: the paced, cached HTTP reads, psql, the stats file and the one Telegram summary.
//
// Restartable: each symbol's response is cached for the UTC day under stocks/data/raw/ (the
// per-ticker checkpoint), actions are upserted every 50 symbols, and every write is an idempotent
// upsert, so a killed run resumes where it stopped and a re-run the same day re-fetches nothing.

import { mkdir, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import {
    MINT_STATE_RUNS_QUERY, STORED_VERDICTS_QUERY, TOLERANCES, buildActionUpsertSql, buildCheckSql,
    formatTelegramSummary, groupRuns, multiplierSteps, newFindings, parseYahooChart,
    programmePolicy, reconcileToken, snapshotSteps, summarise, yahooChartUrl, yahooSymbolFor
} from './lib/corporate-actions.mjs';
import { wrapTransaction } from './lib/db-load.mjs';
import { readEnvFile } from './lib/env.mjs';
import { isoDate, log, logError, logWarn, parseArgs, readJson, sleep, ts, writeJson } from './lib/io.mjs';
import { describeUrl, psql } from './lib/psql.mjs';
import { postTelegram } from './lib/telegram.mjs';

const HERE = import.meta.dirname;
const REPO = join(HERE, '..');
const STATS_FILE = join(REPO, '.last-corporate-actions-watch-stats.json');
const CACHE_ROOT = join(HERE, 'data', 'raw', 'corporate-actions');
const HISTORY_DIR = join(HERE, 'data', 'history');
const RUN_STARTED_MS = Date.now();
const RUN_STARTED_AT = ts(new Date(RUN_STARTED_MS));

const DEFAULT_DAYS = 90;
/** Days of bars fetched before --since, so the first ex-date in the window has a cum-dividend close. */
const PRICE_LEAD_DAYS = 10;
/** Yahoo's chart endpoint has no published limit; ~1 request/1.5 s ran 1,000+ symbols cleanly (2026-09-30). */
const DEFAULT_PACE_MS = 1500;
const MAX_ATTEMPTS = 4;
const TIMEOUT_MS = 30_000;
const STORE_EVERY = 50;
const USER_AGENT = 'Mozilla/5.0 (compatible; rwa-sonar corporate-action watch; contact@rwasonar.com)';
/** Tokens whose issuer reports nothing in circulation are skipped unless their multiplier moved. */
const IDLE_STATUSES = new Set(['issuer-reports-zero-circulation', 'zero-supply']);

function usage() {
    console.log(`watch-corporate-actions.mjs — do the tokens' multipliers follow the underlying's splits and dividends?

USAGE
  node stocks/watch-corporate-actions.mjs --run [options]

OPTIONS
  --run              Actually fetch and reconcile. Without it this help is printed and nothing runs.
  --since=<iso>      Start of the checked window (default ${DEFAULT_DAYS} days ago).
  --only=<list>      Issuer slugs, tickers or token symbols, comma-separated (xstocks-backed, AAPL, OPENAI).
  --limit=<n>        Only the first n symbols (smoke test).
  --pace=<ms>        Minimum gap between two Yahoo requests (default ${DEFAULT_PACE_MS}).
  --fresh            Ignore today's cached responses and fetch again.
  --no-db            Read the multiplier history from the daily snapshots (stocks/data/history), write no
                     rows and no stats file. Snapshot steps are only placed between two daily builds.
  --no-telegram      Never send the summary, whatever is in .env. It is still logged.
  --print            Print every check, not only the findings.
  --help             This text.

WHAT A RUN DOES
  1. Tokens: every mint the chain watcher reads (sonar.mint_state) that has an underlying ticker, minus
     the ones whose issuer reports zero circulation (unless their multiplier moved in the window), plus
     every mint with a multiplier step in the window (the PreStocks private-company tokens have no
     ticker: any step of theirs is checked against nothing and is "unexplained").
  2. Corporate actions: one Yahoo chart v8 request per listing symbol for the window (+${PRICE_LEAD_DAYS} days of bars),
     paced ${DEFAULT_PACE_MS} ms, 429/5xx retried with backoff; each response cached for the UTC day in
     ${relative(REPO, CACHE_ROOT)}/<date>/ (the checkpoint). Splits (numerator:denominator) and cash
     dividends (amount, ex-date, the close before the ex-date) with Yahoo's own event time.
  3. Multiplier steps per mint from its configuration history (multiplier → newMultiplier at the mint's
     own effective timestamp), and the stretch over which that history is complete ("coverage").
  4. Reconciliation (tolerances in lib/corporate-actions.mjs TOLERANCES): a step on time is within
     [ex − ${TOLERANCES.earlyDays} d, ex + ${TOLERANCES.onTimeDays} d], late up to ex + ${TOLERANCES.lateDays} d; a split matches at ±${TOLERANCES.splitRatio * 100} % of its ratio; a dividend
     when (ratio − 1) × close / dividend is in [${TOLERANCES.dividendNetFractionMin}, ${TOLERANCES.dividendNetFractionMax}] (net of up to ~35 % withholding). Missing is only
     raised where the programme documents that it passes the action through the multiplier
     (xStocks, Ondo: splits and reinvested dividends; Superstate: splits) and the mint's history covers
     the window; otherwise the verdict is no-coverage / pending / unverifiable, never a guess.
  5. Upserts sonar.corporate_action and sonar.corporate_action_check; drops "unexplained" rows of the
     window that this run no longer produces.
  6. Writes ${relative(REPO, STATS_FILE)}; ONE Telegram summary when there are NEW findings (a finding
     verdict not stored before) or failures; exits 1 when any symbol could not be read.

SOURCE
  https://query1.finance.yahoo.com/v8/finance/chart/<symbol>?period1=…&period2=…&interval=1d&events=div,split
  Unofficial and keyless; it covers US, London (.L), Hong Kong (.HK) and Frankfurt (.DE) listings in
  one shape. Nasdaq's quote API refuses non-Nasdaq symbols ("Dividend History for Non-Nasdaq symbols
  is not available", checked 2026-09-30) and EDGAR has no per-event dividend data.

REQUIREMENTS
  DATABASE_URL in ${join(REPO, '.env')} (never printed; only host/db are logged).`);
}

// ---------------------------------------------------------------------------------------------
// HTTP: one paced, retrying, cached GET per symbol.
// ---------------------------------------------------------------------------------------------

let lastRequestEnd = 0;
const counters = { requests: 0, retries: 0, cached: 0 };

async function fetchChart(symbol, { period1, period2, paceMs, cacheDir, fresh }) {
    // Keyed by the window's start too: a run with an earlier --since must not reuse a shorter response.
    const from = new Date(period1 * 1000).toISOString().slice(0, 10);
    const cachePath = join(cacheDir, `${symbol.replace(/[^A-Za-z0-9.-]/g, '_')}@${from}.json`);
    if (!fresh) {
        const cached = await readJson(cachePath, null);
        if (cached?.payload) {
            counters.cached += 1;
            return { ...cached, fromCache: true };
        }
    }
    const url = yahooChartUrl(symbol, { period1, period2 });
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const wait = lastRequestEnd + paceMs - Date.now();
        if (wait > 0) await sleep(wait);
        counters.requests += 1;
        let status = null;
        let payload = null;
        let retryAfterMs = null;
        try {
            const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
            status = res.status;
            retryAfterMs = Number(res.headers.get('retry-after')) * 1000 || null;
            const text = await res.text();
            try {
                payload = JSON.parse(text);
            } catch {
                lastError = `HTTP ${status}, not JSON: ${text.slice(0, 120)}`;
            }
        } catch (err) {
            lastError = err.message;
        }
        lastRequestEnd = Date.now();
        // 404 with a chart.error is Yahoo's answer for an unknown symbol: a result, not a retry.
        if (payload && (status === 200 || (status === 404 && payload?.chart?.error))) {
            const record = { symbol, url, status, fetchedAt: ts(), payload };
            await writeJson(cachePath, record);
            return { ...record, fromCache: false };
        }
        if (payload && !lastError) lastError = `HTTP ${status}`;
        const retryable = status === null || status === 429 || status >= 500 || !payload;
        if (!retryable || attempt === MAX_ATTEMPTS) break;
        counters.retries += 1;
        const backoff = retryAfterMs ?? Math.min(60_000, 2000 * 2 ** (attempt - 1));
        logWarn(`${symbol}: ${lastError} — retry ${attempt}/${MAX_ATTEMPTS - 1} in ${Math.round(backoff / 1000)} s`);
        await sleep(backoff);
    }
    throw new Error(`${symbol}: ${lastError ?? 'unreadable response'}`);
}

function eta(done, total, startedMs) {
    if (done === 0) return '';
    const s = Math.round(((Date.now() - startedMs) / 1000 / done) * (total - done));
    return ` · ETA ${s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`}`;
}

// ---------------------------------------------------------------------------------------------
// Multiplier history: the database (hourly configurations) or the daily snapshots.
// ---------------------------------------------------------------------------------------------

async function historyFromDb(dbUrl, tokensByMint) {
    const rows = JSON.parse((await psql(dbUrl, MINT_STATE_RUNS_QUERY, 'mint_state runs', ['-t', '-A'])).trim() || '[]');
    const byMint = groupRuns(rows);
    const out = new Map();
    for (const [mint, { runs, lastObservedAt }] of byMint) {
        out.set(mint, multiplierSteps(runs, { lastObservedAt, existsSince: tokensByMint.get(mint)?.market?.firstPoolAt ?? null }));
    }
    log(`db: ${rows.length} multiplier configuration(s) over ${byMint.size} mint(s)`);
    return out;
}

async function historyFromSnapshots() {
    let days = [];
    try {
        days = (await readdir(HISTORY_DIR)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    } catch (err) {
        throw new Error(`--no-db needs the daily snapshots in ${HISTORY_DIR}: ${err.message}`);
    }
    const series = new Map();
    for (const day of days) {
        const snap = await readJson(join(HISTORY_DIR, day, 'tokens.json'), null);
        if (!snap?.items) continue;
        const observedAt = snap.builtAt ?? null;
        if (!observedAt) {
            logWarn(`snapshot ${day} has no builtAt — skipped (its time would be invented)`);
            continue;
        }
        for (const item of snap.items) {
            if (!series.has(item.mint)) series.set(item.mint, []);
            // Before 2026-09-24 the snapshots kept the account's raw `multiplier` field (the value
            // before any scheduled update), with no uiMultiplierBasis: comparing it with a later
            // effective value invents a step (OPENAI "1 → 1.4861347" between the 09-23 and 09-24
            // builds, though it took effect on 2026-07-17). Only effective values are compared.
            series.get(item.mint).push({ observedAt, multiplier: item.uiMultiplierBasis === 'effective' ? (item.uiMultiplier ?? null) : null });
        }
    }
    const out = new Map();
    for (const [mint, s] of series) out.set(mint, snapshotSteps(s));
    log(`snapshots: ${days.length} day(s), ${series.size} mint(s)`);
    return out;
}

// ---------------------------------------------------------------------------------------------

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return;
    }
    const env = await readEnvFile(join(REPO, '.env'));
    const noDb = Boolean(flags['no-db']);
    const dbUrl = process.env.DATABASE_URL || env.DATABASE_URL || null;
    const nowIso = ts();
    const since = typeof flags.since === 'string' ? flags.since : ts(new Date(RUN_STARTED_MS - DEFAULT_DAYS * 86_400_000));
    if (!Number.isFinite(Date.parse(since))) throw new Error(`--since must be an ISO instant, got ${flags.since}`);
    const paceMs = flags.pace === undefined ? DEFAULT_PACE_MS : Number(flags.pace);
    if (!Number.isFinite(paceMs) || paceMs < 0) throw new Error(`--pace must be milliseconds >= 0, got ${flags.pace}`);
    const limit = flags.limit === undefined ? null : Number(flags.limit);
    if (limit !== null && !(Number.isInteger(limit) && limit > 0)) throw new Error(`--limit must be a whole number > 0, got ${flags.limit}`);
    const only = typeof flags.only === 'string' ? new Set(flags.only.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) : null;
    log(`watch-corporate-actions: window ${since} → ${nowIso}${only ? `, only ${[...only].join(',')}` : ''}${noDb ? ', --no-db (snapshots)' : ''}`);

    // --- tokens and their multiplier history -------------------------------------------------------
    const tokens = (await readJson(join(REPO, 'stocks-tokens.json'), null))?.tokens;
    if (!Array.isArray(tokens) || tokens.length === 0) throw new Error('stocks-tokens.json has no tokens — run `npm run stocks:build` first');
    const tokensByMint = new Map(tokens.map((t) => [t.mint, t]));
    let history;
    let stored = new Map();
    if (noDb) {
        history = await historyFromSnapshots();
    } else {
        if (!dbUrl) throw new Error(`DATABASE_URL is not set in ${join(REPO, '.env')} — pass --no-db to run from the snapshots`);
        log(`db: ${describeUrl(dbUrl)}`);
        history = await historyFromDb(dbUrl, tokensByMint);
        const rows = JSON.parse((await psql(dbUrl, STORED_VERDICTS_QUERY, 'stored verdicts', ['-t', '-A'])).trim() || '[]');
        stored = new Map(rows.map((r) => [`${r.mint}|${r.checkKey}`, r.verdict]));
        log(`db: ${stored.size} stored verdict(s)`);
    }

    const sinceMs = Date.parse(since);
    const movedInWindow = (h) => h?.steps.some((s) => (s.at ?? s.windowTo) >= sinceMs) ?? false;
    const selected = [];
    const skipped = { noHistory: 0, idle: 0, noTicker: 0, unmapped: [] };
    for (const token of tokens) {
        if (only && ![token.issuer, token.underlyingTicker, token.symbol].some((v) => typeof v === 'string' && only.has(v.toLowerCase()))) continue;
        const h = history.get(token.mint);
        if (!h) {
            skipped.noHistory += 1;
            continue;
        }
        const moved = movedInWindow(h);
        if (!moved && IDLE_STATUSES.has(token.identity?.operationalStatus)) {
            skipped.idle += 1;
            continue;
        }
        const policy = programmePolicy(token.issuer);
        const listed = token.underlyingTicker && token.instrumentType !== 'leveraged' ? yahooSymbolFor(token) : { symbol: null, reason: 'no listed underlying' };
        if (!listed.symbol) {
            if (!moved) {
                skipped.noTicker += 1;
                continue;
            }
            if (token.underlyingTicker) skipped.unmapped.push(`${token.symbol} (${listed.reason})`);
        }
        selected.push({ token, policy, history: h, sourceSymbol: listed.symbol });
    }
    const symbols = [...new Set(selected.map((s) => s.sourceSymbol).filter(Boolean))].sort();
    const toFetch = limit ? symbols.slice(0, limit) : symbols;
    log(`tokens: ${selected.length} selected (${skipped.noHistory} without multiplier readings, ${skipped.idle} idle with zero circulation,`
        + ` ${skipped.noTicker} without a listed underlying and no step); ${symbols.length} listing symbol(s)${limit ? `, first ${toFetch.length} fetched (--limit)` : ''}`);
    if (skipped.unmapped.length) logWarn(`no listing symbol for ${skipped.unmapped.length}: ${skipped.unmapped.slice(0, 10).join(', ')}`);

    // --- corporate actions, one symbol at a time (cached per UTC day) -----------------------------
    const cacheDir = join(CACHE_ROOT, isoDate());
    await mkdir(cacheDir, { recursive: true });
    const period1 = Math.floor((sinceMs - PRICE_LEAD_DAYS * 86_400_000) / 1000);
    const period2 = Math.floor(RUN_STARTED_MS / 1000);
    const actionsBySymbol = new Map();
    const failures = [];
    const notFound = [];
    let pendingStore = [];
    let actionsFound = 0;
    let actionsStored = 0;
    const fetchStartedMs = Date.now();
    for (let i = 0; i < toFetch.length; i += 1) {
        const symbol = toFetch[i];
        const ticker = selected.find((s) => s.sourceSymbol === symbol)?.token.underlyingTicker ?? symbol;
        try {
            const res = await fetchChart(symbol, { period1, period2, paceMs, cacheDir, fresh: Boolean(flags.fresh) });
            const parsed = parseYahooChart(res.payload, { ticker, symbol, url: res.url, fetchedAt: res.fetchedAt });
            if (!parsed.ok) {
                notFound.push(`${symbol}: ${parsed.error}`);
            } else {
                actionsBySymbol.set(symbol, parsed.actions);
                actionsFound += parsed.actions.length;
                pendingStore.push(...parsed.actions);
            }
        } catch (err) {
            failures.push(err.message);
            logWarn(`fetch failed: ${err.message}`);
        }
        if (!noDb && (pendingStore.length && ((i + 1) % STORE_EVERY === 0 || i === toFetch.length - 1))) {
            await psql(dbUrl, wrapTransaction([buildActionUpsertSql(pendingStore)]), 'corporate actions');
            actionsStored += pendingStore.length;
            pendingStore = [];
        }
        if ((i + 1) % 25 === 0 || i === toFetch.length - 1) {
            log(`symbols [${i + 1}/${toFetch.length}] ${actionsFound} action(s), ${counters.requests} request(s), ${counters.cached} from today's cache`
                + `${failures.length ? `, ${failures.length} failed` : ''}${eta(i + 1, toFetch.length, fetchStartedMs)}`);
        }
    }
    if (notFound.length) logWarn(`${notFound.length} symbol(s) unknown to the source: ${notFound.slice(0, 10).join('; ')}`);

    // --- reconcile ------------------------------------------------------------------------------------
    const checks = [];
    const reconciledMints = [];
    for (const { token, policy, history: h, sourceSymbol } of selected) {
        // A token whose listing symbol was not read this run is not reconciled: its steps would all
        // look unexplained for want of the actions we failed to fetch.
        if (sourceSymbol && !actionsBySymbol.has(sourceSymbol)) continue;
        const actions = sourceSymbol ? actionsBySymbol.get(sourceSymbol) : [];
        checks.push(...reconcileToken({ token, policy, actions, history: h, since, now: nowIso }));
        reconciledMints.push(token.mint);
    }
    const counts = summarise(checks);
    const fresh = newFindings(checks, stored);
    const expectedCount = checks.filter((c) => c.expectedOnChain).length;
    log(`reconciled ${reconciledMints.length} mint(s): ${counts.checks} check(s) (${expectedCount} for actions the programme passes through) —`
        + ` matched ${counts.matched}, late ${counts.late}, wrong ratio ${counts.wrongRatio}, missing ${counts.missing}, unexplained ${counts.unexplained},`
        + ` pending ${counts.pending}, no coverage ${counts.noCoverage}, unverifiable ${counts.unverifiable}; ${fresh.length} new finding(s)`);
    const shown = flags.print ? checks : checks.filter((c) => c.verdict !== 'no-coverage');
    const order = { warning: 0, caution: 1, info: 2 };
    for (const c of [...shown].sort((a, b) => (order[a.severity] - order[b.severity]) || (a.detail < b.detail ? -1 : 1)).slice(0, flags.print ? shown.length : 60)) {
        log(`  [${c.severity}] ${c.detail}`);
    }

    // --- store -------------------------------------------------------------------------------------------
    if (!noDb) {
        await psql(dbUrl, wrapTransaction(buildCheckSql(checks, { mints: reconciledMints, since, checkedAt: nowIso })), 'corporate action checks');
        const back = (await psql(dbUrl, `SELECT (SELECT count(*) FROM sonar.corporate_action) || '|' || (SELECT count(*) FROM sonar.corporate_action_check)
            || '|' || (SELECT count(*) FROM sonar.corporate_action_check WHERE verdict IN ('late','wrong-ratio','missing','unexplained'));`, 'counts', ['-t', '-A'])).trim().split('|');
        log(`db: ${back[0]} corporate action(s), ${back[1]} check(s) stored, ${back[2]} of them findings`);
    }

    const endedAt = ts();
    const stats = {
        watchStatus: failures.length ? 'partial' : 'ok',
        generatedAt: endedAt,
        lastRunStartedAt: RUN_STARTED_AT,
        lastRunEndedAt: endedAt,
        since,
        durationMs: Date.now() - RUN_STARTED_MS,
        source: 'yahoo-chart-v8',
        tickersChecked: actionsBySymbol.size,
        symbolsSelected: symbols.length,
        symbolsNotFound: notFound.length,
        mintsReconciled: reconciledMints.length,
        actionsFound,
        actionsStored,
        checks: counts.checks,
        matched: counts.matched,
        missing: counts.missing,
        late: counts.late,
        wrongRatio: counts.wrongRatio,
        unexplained: counts.unexplained,
        pending: counts.pending,
        noCoverage: counts.noCoverage,
        unverifiable: counts.unverifiable,
        newFindings: fresh.length,
        requests: counters.requests,
        retries: counters.retries,
        cachedResponses: counters.cached,
        failures: failures.length,
        failureReasons: failures.slice(0, 20),
        notFound: notFound.slice(0, 20)
    };
    if (!noDb) await writeJson(STATS_FILE, stats);

    if ((fresh.length > 0 || failures.length > 0) && !flags['no-telegram']) {
        await postTelegram(formatTelegramSummary({ counts, fresh, failures, tickers: actionsBySymbol.size, durationMs: stats.durationMs }), { env });
    } else if (!flags['no-telegram']) {
        log('telegram: no new findings and no failures — nothing sent');
    }
    if (failures.length) {
        logError(`watch-corporate-actions: run NOT complete — ${failures.length} symbol(s) could not be read`);
        process.exitCode = 1;
        return;
    }
    log(`watch-corporate-actions: done in ${((Date.now() - RUN_STARTED_MS) / 1000).toFixed(0)} s`);
}

main().catch(async (err) => {
    logError(err.stack || err.message);
    if (process.argv.includes('--no-db')) {
        process.exitCode = 1;
        return;
    }
    try {
        await writeJson(STATS_FILE, {
            watchStatus: 'failed', generatedAt: ts(), lastRunStartedAt: RUN_STARTED_AT, lastRunEndedAt: ts(),
            durationMs: Date.now() - RUN_STARTED_MS, failures: 1, failureReasons: [err.message]
        });
    } catch (statsError) {
        logError(`watch-corporate-actions: could not record the failed outcome: ${statsError.message}`);
    }
    process.exitCode = 1;
});
