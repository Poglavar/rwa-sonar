// Corporate-action reconciliation, the pure half (stocks/watch-corporate-actions.mjs does the IO):
// parse the underlying stocks' splits and cash dividends out of Yahoo's chart payload, rebuild each
// mint's Token-2022 scaled-UI multiplier steps from the chain watcher's sonar.mint_state readings,
// and decide for every corporate action whether the programme applied it (matched / late /
// wrong-ratio / missing) and for every multiplier step whether any corporate action explains it
// (else "unexplained"). No network, no filesystem, no database here: everything is unit tested in
// ../corporate-actions.test.js against real payloads in ../fixtures/corporate-actions/.
//
// Two rules run through all of it (AGENTS.md):
//   * A missing multiplier, price or date stays null and makes a verdict UNKNOWN ("no-coverage",
//     "unverifiable", "pending"), never a number that looks real.
//   * Every time is the source's own: Yahoo's event time for an action, the mint's own
//     newMultiplierEffectiveTimestamp for a step. The change_event feed's `detected_at` is NOT a
//     step time — it is when the watcher noticed the account's raw `multiplier` field move, which
//     for xStocks happens when the NEXT update is scheduled (APHx's 2:1 split, effective
//     2026-09-03T08:45Z on chain, surfaced as a change_event on 2026-09-21).

import { jsonbLiteral } from './db-load.mjs';

// ---------------------------------------------------------------------------------------------
// Tolerances. One place, so a test and the verdict text read the same numbers.
// ---------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

export const TOLERANCES = {
    /** A multiplier step this close to 1 is dust (Backpack's MU moves ~1e-11 an hour), never a finding. */
    dust: 1e-6,
    /** A split step matches when observed/expected is within ±0.5 %. */
    splitRatio: 0.005,
    /**
     * A dividend step matches when its net fraction f = (ratio − 1) × cum-dividend close / dividend
     * lies in [0.60, 1.05]: 1.0 is a full gross reinvestment at the close, 0.70 is the 30 % US
     * statutory withholding, and the band leaves room for the reinvestment price differing from the
     * previous close by a few percent and for 25 % foreign withholding (Irish DWT on MDT).
     */
    dividendNetFractionMin: 0.60,
    dividendNetFractionMax: 1.05,
    /**
     * A step may take effect up to 4 days before the ex-date's open: xStocks apply at 00:30 UTC on the
     * ex-date, or on the Saturday before it: AAPLx 2026-08-08 for AAPL ex Monday 2026-08-10, and seven
     * xStocks on 2026-09-05 for ex-dates on Tuesday 2026-09-08 after Labor Day (3.5 days).
     */
    earlyDays: 4,
    /** …and up to 3 days after it and still be on time. */
    onTimeDays: 3,
    /** After that it is late, up to 45 days; a later step is not matched to this action at all. */
    lateDays: 45,
    /** An unexplained step moving the multiplier by ≥ 5 % is a warning, below that a caution. */
    unexplainedWarning: 0.05
};

export const VERDICTS = ['matched', 'late', 'wrong-ratio', 'missing', 'pending', 'no-coverage', 'unverifiable', 'unexplained'];
/** Verdicts that are findings: raised in the run's summary and counted in the outcome stats. */
export const FINDING_VERDICTS = new Set(['late', 'wrong-ratio', 'missing', 'unexplained']);

// ---------------------------------------------------------------------------------------------
// Programme policy: which corporate actions each issuer says it passes through the multiplier.
// Each entry cites its dossier (stocks/data/issuers/<file>.json → corporateActions / dividends);
// the test reads the dossiers and fails if the quoted words disappear from them.
// ---------------------------------------------------------------------------------------------

export const PROGRAMME_POLICY = {
    'xstocks-backed': {
        dossier: 'xstocks-backed.json', dividends: 'reinvest-multiplier', splits: 'multiplier',
        quote: 'Cash dividends are reinvested into additional shares of the same stock, net of applicable withholding taxes, and the multiplier increases; splits increase and reverse splits decrease the multiplier proportionally.'
    },
    'ondo-global-markets': {
        dossier: 'ondo-global-markets.json', dividends: 'reinvest-multiplier', splits: 'multiplier',
        quote: "Dividends are reinvested into the referenced stock net of withholding tax and expressed as an increase in the 'shares per token' multiplier"
    },
    'backpack-securities': {
        // Dividends change an off-chain conversion rate, not the on-chain multiplier, which "has
        // never moved"; splits in balances are "still being worked on". Nothing is expected on chain.
        dossier: 'backpack-securities-spcx.json', dividends: 'off-chain', splits: 'unknown',
        quote: 'the mechanism is a CONVERSION-RATIO change, not a balance adjustment'
    },
    'superstate-opening-bell': {
        dossier: 'superstate-opening-bell.json', dividends: 'cash', splits: 'multiplier',
        quote: 'Splits: applied at the mint via the Token-2022 ScaledUiAmount multiplier'
    },
    prestocks: {
        dossier: 'prestocks.json', dividends: 'none', splits: 'unknown',
        quote: 'balances can be restated unilaterally through the scaledUiAmountConfig multiplier'
    }
};

const UNKNOWN_POLICY = { dossier: null, dividends: 'unknown', splits: 'unknown', quote: null };

export function programmePolicy(issuer) {
    return PROGRAMME_POLICY[issuer] ?? UNKNOWN_POLICY;
}

/** Whether this programme says the action moves the on-chain multiplier (so its absence is a finding). */
export function expectsOnChain(policy, kind) {
    return kind === 'split' ? policy.splits === 'multiplier' : policy.dividends === 'reinvest-multiplier';
}

// ---------------------------------------------------------------------------------------------
// Small value helpers. `num` is the one door a number comes through: null, '', NaN → null.
// ---------------------------------------------------------------------------------------------

export function num(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
}

function isoOf(ms) {
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function msOf(value) {
    if (value === null || value === undefined || value === '') return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
}

/** YYYY-MM-DD of a unix-seconds instant in an IANA zone (the exchange's), or null when unreadable. */
export function localDate(unixSec, timeZone) {
    if (typeof unixSec !== 'number' || !Number.isFinite(unixSec)) return null;
    try {
        return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
            .format(new Date(unixSec * 1000));
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------------------------
// Tickers: our underlyingTicker → the symbol Yahoo lists it under.
// ---------------------------------------------------------------------------------------------

/** Exceptions where the listing symbol is not the mechanical one. */
const YAHOO_OVERRIDES = { 'GB:BTL': 'BT-A.L' };

/**
 * `{symbol}` or `{symbol: null, reason}`. xStocks' issuer API names the listing country; the other
 * programmes list US stocks and ETFs only. London tickers arrive with an `L` suffix (LGENL → LGEN.L),
 * Hong Kong ones as the bare number (700 → 0700.HK).
 */
export function yahooSymbolFor(token) {
    const ticker = typeof token?.underlyingTicker === 'string' ? token.underlyingTicker.trim() : '';
    if (!ticker) return { symbol: null, reason: 'no underlying ticker' };
    const country = token.issuerApi?.listingCountry ?? (token.issuer === 'xstocks-backed' ? null : 'US');
    const override = YAHOO_OVERRIDES[`${country}:${ticker}`];
    if (override) return { symbol: override };
    switch (country) {
        case 'US':
            if (!/^[A-Z][A-Z0-9.]*$/.test(ticker)) return { symbol: null, reason: `not a US ticker: ${ticker}` };
            return { symbol: ticker.replace(/\./g, '-') };
        case 'HK':
            if (!/^\d{1,5}$/.test(ticker)) return { symbol: null, reason: `not a HK code: ${ticker}` };
            return { symbol: `${ticker.padStart(4, '0')}.HK` };
        case 'GB':
            if (/^[A-Z0-9]+L$/.test(ticker) && ticker !== 'LSEG') return { symbol: `${ticker.slice(0, -1)}.L` };
            return { symbol: `${ticker}.L` };
        case 'DE':
            return /D$/.test(ticker) ? { symbol: `${ticker.slice(0, -1)}.DE` } : { symbol: null, reason: `unmapped DE ticker ${ticker}` };
        case 'ES':
            return /E$/.test(ticker) ? { symbol: `${ticker.slice(0, -1)}.MC` } : { symbol: null, reason: `unmapped ES ticker ${ticker}` };
        default:
            return { symbol: null, reason: `no listing country for ${ticker}` };
    }
}

// ---------------------------------------------------------------------------------------------
// Yahoo chart v8 (unofficial, keyless): one call per symbol returns the daily bars AND the
// dividend / split events of the requested range.
// ---------------------------------------------------------------------------------------------

export const YAHOO_SOURCE = 'yahoo-chart-v8';

export function yahooChartUrl(symbol, { period1, period2 }) {
    return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
        + `?period1=${period1}&period2=${period2}&interval=1d&events=div%2Csplit&includeAdjustedClose=false`;
}

/**
 * Parse one chart payload. Returns `{ok, error, currency, timeZone, bars, actions}`; `actions` carry
 * the source's own event time (`eventAt`) and the exchange-local ex-date, and a dividend carries the
 * last close strictly before its ex-date (the cum-dividend close) or null when there is none.
 * Yahoo's closes and dividend amounts are both split-adjusted, so their ratio is not disturbed by a
 * later split.
 */
export function parseYahooChart(payload, { ticker, symbol, url = null, fetchedAt = null } = {}) {
    const error = payload?.chart?.error ?? null;
    const result = payload?.chart?.result?.[0] ?? null;
    if (!result) {
        const reason = error ? `${error.code ?? 'error'}: ${error.description ?? ''}`.trim() : 'no chart result';
        return { ok: false, error: reason, currency: null, timeZone: null, bars: [], actions: [] };
    }
    const meta = result.meta ?? {};
    const timeZone = typeof meta.exchangeTimezoneName === 'string' ? meta.exchangeTimezoneName : 'UTC';
    const currency = typeof meta.currency === 'string' ? meta.currency : null;
    const stamps = Array.isArray(result.timestamp) ? result.timestamp : [];
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const bars = [];
    for (let i = 0; i < stamps.length; i += 1) {
        const close = num(closes[i]);
        const date = localDate(stamps[i], timeZone);
        if (close !== null && close > 0 && date) bars.push({ date, close });
    }
    const cumClose = (exDate) => {
        let best = null;
        for (const bar of bars) if (bar.date < exDate && (!best || bar.date > best.date)) best = bar;
        return best;
    };
    const base = { ticker, sourceSymbol: symbol, currency, source: YAHOO_SOURCE, sourceUrl: url, fetchedAt };
    const actions = [];
    for (const d of Object.values(result.events?.dividends ?? {})) {
        const eventSec = num(d?.date);
        const amount = num(d?.amount);
        const exDate = eventSec === null ? null : localDate(eventSec, timeZone);
        if (eventSec === null || !exDate || amount === null || amount <= 0) continue;
        const ref = cumClose(exDate);
        actions.push({
            ...base, kind: 'dividend', exDate, eventAt: isoOf(eventSec * 1000), amount,
            numerator: null, denominator: null, ratio: null,
            referenceClose: ref?.close ?? null, referenceCloseDate: ref?.date ?? null
        });
    }
    for (const s of Object.values(result.events?.splits ?? {})) {
        const eventSec = num(s?.date);
        const numerator = num(s?.numerator);
        const denominator = num(s?.denominator);
        const exDate = eventSec === null ? null : localDate(eventSec, timeZone);
        if (eventSec === null || !exDate || !(numerator > 0) || !(denominator > 0)) continue;
        actions.push({
            ...base, kind: 'split', exDate, eventAt: isoOf(eventSec * 1000), amount: null,
            numerator, denominator, ratio: numerator / denominator,
            referenceClose: null, referenceCloseDate: null
        });
    }
    actions.sort((a, b) => (a.eventAt < b.eventAt ? -1 : a.eventAt > b.eventAt ? 1 : a.kind < b.kind ? -1 : 1));
    return { ok: true, error: null, currency, timeZone, bars, actions };
}

// ---------------------------------------------------------------------------------------------
// Multiplier steps from sonar.mint_state.
//
// A Token-2022 ScaledUiAmountConfig holds (multiplier, newMultiplier, newMultiplierEffectiveTimestamp):
// the last update only. An update scheduled for the future leaves `multiplier` at the value in
// force until then (xStocks: issued ~21:07 UTC, effective 00:30 UTC the next day); one effective
// immediately sets both to the new value (Ondo). So each distinct configuration the watcher saw is
// one step, `multiplier → newMultiplier` at the chain's own timestamp — and because the account
// only ever shows the LAST update, the first configuration seen proves there was no other update
// between its effective time and the first reading. That is the mint's coverage start.
// ---------------------------------------------------------------------------------------------

/**
 * `runs`: one row per mint per configuration change, oldest first — {mint, observedAt,
 * prevObservedAt, multiplier, next, effectiveAt} (strings as psql prints them); `lastObservedAt`:
 * the mint's newest reading; `existsSince`: an instant the token provably existed (its first DEX
 * pool), used only for a mint whose multiplier was never updated (1, 1, no timestamp).
 *
 * Returns {steps, coverageFrom, coverageTo, coverageBasis, noOps, dust}. A step:
 * {before, after, ratio, at, windowFrom, windowTo, basis}. `before`/`ratio` are null when the
 * value before the update was never seen; `at` is null for an update without a timestamp, which
 * is then placed in the observation window [windowFrom, windowTo].
 */
export function multiplierSteps(runs, { lastObservedAt = null, existsSince = null, dust = TOLERANCES.dust } = {}) {
    const rows = [...runs].sort((a, b) => (msOf(a.observedAt) ?? 0) - (msOf(b.observedAt) ?? 0));
    const steps = [];
    let noOps = 0;
    let dustSteps = 0;
    const seen = new Set();
    // The value in force at `whenMs` under one configuration: a future-dated update leaves `multiplier`.
    const inForce = (row, whenMs) => {
        const t = msOf(row.effectiveAt);
        const m = num(row.multiplier);
        return t !== null && whenMs !== null && t > whenMs && m !== null ? m : num(row.next);
    };
    for (const [i, row] of rows.entries()) {
        const m = num(row.multiplier);
        const n = num(row.next);
        const tMs = msOf(row.effectiveAt);
        const obsMs = msOf(row.observedAt);
        if (n === null || obsMs === null) continue;
        const prevEffective = i === 0 ? null : inForce(rows[i - 1], tMs ?? obsMs);
        let step = null;
        if (m !== null && m !== n) {
            step = { before: m, after: n, at: tMs, windowFrom: msOf(row.prevObservedAt), windowTo: obsMs };
        } else if (tMs !== null) {
            step = { before: prevEffective, after: n, at: tMs, windowFrom: msOf(row.prevObservedAt), windowTo: obsMs };
        } else if (i > 0) {
            step = { before: prevEffective, after: n, at: null, windowFrom: msOf(row.prevObservedAt), windowTo: obsMs };
        }
        if (!step) continue;
        const key = `${step.at ?? step.windowTo}|${step.after}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (step.before !== null && step.before === step.after) {
            noOps += 1;
            continue;
        }
        const ratio = step.before !== null && step.before !== 0 ? step.after / step.before : null;
        if (ratio !== null && Math.abs(ratio - 1) < dust) {
            dustSteps += 1;
            continue;
        }
        steps.push({
            ...step, ratio,
            basis: step.at !== null ? 'chain-effective-timestamp' : 'observation-window'
        });
    }
    const first = rows[0] ?? null;
    let coverageFrom = null;
    let coverageBasis = null;
    if (first) {
        const firstObs = msOf(first.observedAt);
        const t = msOf(first.effectiveAt);
        const m = num(first.multiplier);
        const n = num(first.next);
        if (t !== null) {
            coverageFrom = Math.min(t, firstObs);
            coverageBasis = 'first-configuration-effective-time';
        } else if (m === 1 && n === 1 && msOf(existsSince) !== null && msOf(existsSince) < firstObs) {
            coverageFrom = msOf(existsSince);
            coverageBasis = 'never-updated-since-first-pool';
        } else {
            coverageFrom = firstObs;
            coverageBasis = 'first-reading';
        }
    }
    const lastMs = msOf(lastObservedAt) ?? (rows.length ? msOf(rows.at(-1).observedAt) : null);
    return {
        steps,
        coverageFrom: coverageFrom === null ? null : isoOf(coverageFrom),
        coverageTo: lastMs === null ? null : isoOf(lastMs),
        coverageBasis,
        noOps,
        dust: dustSteps
    };
}

/**
 * The same, from the daily snapshots (stocks/data/history/<date>/tokens.json uiMultiplier) for a
 * run without the database: a step is only placed between two snapshot builds, and a null
 * multiplier in a snapshot is a gap, never 1.
 */
export function snapshotSteps(series, { dust = TOLERANCES.dust } = {}) {
    const rows = series.filter((r) => msOf(r.observedAt) !== null).sort((a, b) => msOf(a.observedAt) - msOf(b.observedAt));
    const steps = [];
    let prev = null;
    let dustSteps = 0;
    let firstKnown = null;
    for (const row of rows) {
        const v = num(row.multiplier);
        if (v === null) continue;
        if (firstKnown === null) firstKnown = row.observedAt;
        if (prev && prev.value !== v) {
            const ratio = v / prev.value;
            if (Math.abs(ratio - 1) < dust) dustSteps += 1;
            else steps.push({ before: prev.value, after: v, ratio, at: null, windowFrom: msOf(prev.observedAt), windowTo: msOf(row.observedAt), basis: 'snapshot-window' });
        }
        prev = { value: v, observedAt: row.observedAt };
    }
    return {
        steps, coverageFrom: firstKnown ? isoOf(msOf(firstKnown)) : null,
        coverageTo: prev ? isoOf(msOf(prev.observedAt)) : null, coverageBasis: 'daily-snapshots', noOps: 0, dust: dustSteps
    };
}

/** [lo, hi] in ms: the exact effective time, or the observation window of an undated step. */
function stepSpan(step) {
    if (step.at !== null && step.at !== undefined) return [step.at, step.at];
    return [step.windowFrom ?? step.windowTo, step.windowTo];
}

function overlaps(step, lo, hi) {
    const [a, b] = stepSpan(step);
    return a !== null && b !== null && a <= hi && b >= lo;
}

function stepTime(step) {
    return step.at ?? step.windowTo;
}

// ---------------------------------------------------------------------------------------------
// Reconciliation.
// ---------------------------------------------------------------------------------------------

/**
 * The expected multiplier ratio of an action as [low, high], or null when it cannot be computed
 * (a dividend without a cum-dividend close). A split is numerator/denominator ± splitRatio.
 */
export function expectedRange(action, tol = TOLERANCES) {
    if (action.kind === 'split') {
        const r = num(action.ratio);
        return r === null ? null : { mid: r, low: r * (1 - tol.splitRatio), high: r * (1 + tol.splitRatio) };
    }
    const amount = num(action.amount);
    const close = num(action.referenceClose);
    if (amount === null || close === null || close <= 0) return null;
    const y = amount / close;
    return { mid: 1 + y * 0.85, low: 1 + y * tol.dividendNetFractionMin, high: 1 + y * tol.dividendNetFractionMax };
}

/** (ratio − 1) × close / dividend: the share of the dividend that reached the multiplier, or null. */
export function netFraction(action, ratio) {
    const amount = num(action.amount);
    const close = num(action.referenceClose);
    if (action.kind !== 'dividend' || ratio === null || amount === null || close === null || amount <= 0) return null;
    return ((ratio - 1) * close) / amount;
}

function severityFor(verdict, action, step, tol) {
    if (verdict === 'wrong-ratio') return 'warning';
    if (verdict === 'missing') return action?.kind === 'split' ? 'warning' : 'caution';
    if (verdict === 'late') return 'caution';
    if (verdict === 'unexplained') return step?.ratio !== null && Math.abs(step.ratio - 1) >= tol.unexplainedWarning ? 'warning' : 'caution';
    return 'info';
}

function fmtRatio(r) {
    return r === null || r === undefined ? '?' : `×${r.toPrecision(7)}`;
}

/**
 * Reconcile one token. `actions`: its underlying's corporate actions (parseYahooChart shape);
 * `history`: multiplierSteps / snapshotSteps output; `since`/`now`: ISO bounds of the check.
 * Returns one check per action in [since, now] that the programme passes through or that
 * explains a step, plus one `unexplained` check per step in [since, now] no action explains.
 * Each step explains at most one action; splits are matched first, then dividends, oldest first.
 */
export function reconcileToken({ token, policy, actions, history, since, now, tol = TOLERANCES }) {
    const sinceMs = msOf(since);
    const nowMs = msOf(now);
    const coverageFrom = msOf(history.coverageFrom);
    const coverageTo = msOf(history.coverageTo);
    const early = tol.earlyDays * DAY_MS;
    const onTime = tol.onTimeDays * DAY_MS;
    const late = tol.lateDays * DAY_MS;
    const used = new Set();
    const checks = [];
    const base = {
        mint: token.mint, symbol: token.symbol ?? null, issuer: token.issuer ?? null, ticker: token.underlyingTicker ?? null,
        coverageFrom: history.coverageFrom, coverageTo: history.coverageTo, coverageBasis: history.coverageBasis
    };
    const stepFields = (step, action) => (step ? {
        stepBefore: step.before, stepAfter: step.after, stepRatio: step.ratio,
        stepAt: step.at !== null ? isoOf(step.at) : null,
        stepWindowFrom: step.at === null && step.windowFrom !== null ? isoOf(step.windowFrom) : null,
        stepWindowTo: step.at === null && step.windowTo !== null ? isoOf(step.windowTo) : null,
        stepTimeBasis: step.basis,
        lagDays: action ? Math.round(((stepTime(step) - msOf(action.eventAt)) / DAY_MS) * 100) / 100 : null,
        netFraction: action ? netFraction(action, step.ratio) : null
    } : {
        stepBefore: null, stepAfter: null, stepRatio: null, stepAt: null, stepWindowFrom: null, stepWindowTo: null,
        stepTimeBasis: null, lagDays: null, netFraction: null
    });

    const inScope = actions.filter((a) => {
        const t = msOf(a.eventAt);
        return t !== null && t >= sinceMs && t <= nowMs;
    });
    const ordered = [...inScope.filter((a) => a.kind === 'split'), ...inScope.filter((a) => a.kind === 'dividend')];
    const decided = new Map(); // action → {verdict, step, detail}
    const ctx = (action) => {
        const d = msOf(action.eventAt);
        const range = expectedRange(action, tol);
        return {
            d, range,
            fits: (s) => s.ratio !== null && range !== null && s.ratio >= range.low && s.ratio <= range.high,
            free: (lo, hi) => history.steps.filter((s) => !used.has(s) && overlaps(s, lo, hi)),
            nearest: (list) => [...list].sort((a, b) => Math.abs(stepTime(a) - d) - Math.abs(stepTime(b) - d))[0]
        };
    };
    const take = (action, verdict, step, detail = '') => {
        if (step) used.add(step);
        decided.set(action, { verdict, step, detail });
    };
    // Pass 1: every action's on-time step of the right size, the EARLIEST free one, actions oldest
    // first — an order-preserving pairing. Done for all actions before any late match, and not
    // "nearest": with SATA's daily dividends the step at 00:30 UTC on the next ex-date is nearer to
    // the previous day's 13:30 ex-open than its own step is, and nearest-first paired them crosswise.
    for (const action of ordered) {
        const { d, fits, free } = ctx(action);
        const passing = free(d - early, d + onTime).filter(fits).sort((a, b) => stepTime(a) - stepTime(b));
        if (passing.length) take(action, 'matched', passing[0]);
    }
    // Pass 2: a right-sized step after the on-time window is "late" — only when the mint was watched
    // through the on-time window. Without that the step is probably this action applied late, but it
    // may be a repeat of one applied on time before our readings: "unverifiable", and the step is
    // taken so it is not also reported as unexplained.
    for (const action of ordered) {
        if (decided.has(action)) continue;
        const { d, fits, free } = ctx(action);
        const passing = free(d + onTime, d + late).filter(fits).sort((a, b) => stepTime(a) - stepTime(b));
        if (!passing.length) continue;
        if (coverageFrom !== null && coverageFrom <= d - early) take(action, 'late', passing[0]);
        else take(action, 'unverifiable', passing[0], `a step of the right size came after the on-time window, but the mint was not read through it (history from ${history.coverageFrom})`);
    }
    for (const action of ordered) {
        const { d, range, free, nearest } = ctx(action);
        const expected = expectsOnChain(policy, action.kind);
        if (!decided.has(action)) {
            const onTimeFree = free(d - early, d + onTime);
            const known = onTimeFree.filter((s) => s.ratio !== null);
            // A wrong-sized step on time: for a split any step on time is the programme's attempt; for a
            // dividend only an increase smaller than 5 % is (anything bigger is not a reinvestment).
            const attempts = action.kind === 'split' ? known
                : known.filter((s) => s.ratio > 1 && s.ratio - 1 < tol.unexplainedWarning);
            if (attempts.length && range !== null) {
                take(action, 'wrong-ratio', nearest(attempts));
            } else if (attempts.length || onTimeFree.some((s) => s.ratio === null)) {
                take(action, 'unverifiable', nearest(attempts.length ? attempts : onTimeFree.filter((s) => s.ratio === null)),
                    range === null ? 'no cum-dividend close to size the expected step' : 'the value before the update was never read');
            } else if (!expected) {
                continue; // not passed through by this programme and explains no step: nothing to record
            } else if (coverageFrom === null || coverageFrom > d - early) {
                take(action, 'no-coverage', null, coverageFrom === null ? 'no multiplier readings for this mint'
                    : `multiplier history known only from ${history.coverageFrom} (${history.coverageBasis})`);
            } else if (coverageTo === null || coverageTo < d + onTime) {
                take(action, 'pending', null, `readings end ${history.coverageTo}, before the on-time window closes`);
            } else {
                take(action, 'missing', null, `no multiplier update of the expected size between ${isoOf(d - early)} and ${history.coverageTo}`);
            }
        }
        const { verdict, step, detail } = decided.get(action);
        const exp = range ? { expectedRatio: range.mid, expectedLow: range.low, expectedHigh: range.high } : { expectedRatio: null, expectedLow: null, expectedHigh: null };
        const what = action.kind === 'split'
            ? `${action.numerator}:${action.denominator} split`
            : `dividend ${action.amount} ${action.currency ?? ''}`.trim();
        const stepText = step ? ` → step ${fmtRatio(step.ratio)} at ${step.at !== null ? isoOf(step.at) : `${isoOf(step.windowFrom ?? step.windowTo)}…${isoOf(step.windowTo)}`}` : '';
        const f = step ? netFraction(action, step.ratio) : null;
        checks.push({
            ...base,
            checkKey: `${action.kind}:${action.sourceSymbol}:${action.exDate}`,
            actionKind: action.kind, sourceSymbol: action.sourceSymbol, exDate: action.exDate, actionEventAt: action.eventAt,
            expectedOnChain: expected, verdict, severity: severityFor(verdict, action, step, tol),
            ...exp, ...stepFields(step, action),
            detail: `${base.symbol}: ${what} ex ${action.exDate} (${action.sourceSymbol}) — ${verdict}${stepText}`
                + (range ? `; expected ${fmtRatio(range.low)}…${fmtRatio(range.high)}` : '')
                + (f !== null ? `; net fraction ${f.toFixed(3)}` : '')
                + (detail ? `; ${detail}` : '')
        });
    }

    for (const step of history.steps) {
        if (used.has(step)) continue;
        const t = stepTime(step);
        if (t === null || t < sinceMs || t > nowMs) continue;
        if (step.ratio === null) continue; // an update whose prior value was never read: no size to explain
        const why = inScope.length === 0
            ? (token.underlyingTicker ? `no corporate action of ${token.underlyingTicker} in the window` : 'no listed underlying, so no corporate-action source')
            : 'no split or dividend of the underlying within the matching windows';
        checks.push({
            ...base,
            checkKey: `step:${isoOf(t)}:${step.after}`,
            actionKind: null, sourceSymbol: null, exDate: null, actionEventAt: null, expectedOnChain: null,
            verdict: 'unexplained', severity: severityFor('unexplained', null, step, tol),
            expectedRatio: null, expectedLow: null, expectedHigh: null, ...stepFields(step, null),
            detail: `${base.symbol}: multiplier ${step.before} → ${step.after} (${fmtRatio(step.ratio)}) at ${isoOf(t)}`
                + `${step.at === null ? ` (between readings from ${isoOf(step.windowFrom ?? t)})` : ''} — unexplained: ${why}`
        });
    }
    return checks;
}

/** Counts for the stats file and the summary line. */
export function summarise(checks) {
    const count = (v) => checks.filter((c) => c.verdict === v).length;
    return {
        checks: checks.length,
        matched: count('matched'),
        late: count('late'),
        wrongRatio: count('wrong-ratio'),
        missing: count('missing'),
        pending: count('pending'),
        noCoverage: count('no-coverage'),
        unverifiable: count('unverifiable'),
        unexplained: count('unexplained')
    };
}

/**
 * Findings that are new since the stored verdicts: no stored row, or a stored row whose verdict
 * was different. `stored` maps `${mint}|${checkKey}` → verdict.
 */
export function newFindings(checks, stored) {
    return checks.filter((c) => FINDING_VERDICTS.has(c.verdict) && stored.get(`${c.mint}|${c.checkKey}`) !== c.verdict);
}

// ---------------------------------------------------------------------------------------------
// SQL. Rows travel as one jsonb literal (dollar tag proven safe by db-load.mjs) and are unpacked
// with jsonb_to_recordset, so no value is ever spliced into SQL text.
// ---------------------------------------------------------------------------------------------

export const ACTION_COLUMNS = [
    ['source_symbol', 'sourceSymbol', 'text'],
    ['kind', 'kind', 'text'],
    ['ex_date', 'exDate', 'date'],
    ['ticker', 'ticker', 'text'],
    ['event_at', 'eventAt', 'timestamptz'],
    ['amount', 'amount', 'numeric'],
    ['currency', 'currency', 'text'],
    ['split_numerator', 'numerator', 'numeric'],
    ['split_denominator', 'denominator', 'numeric'],
    ['reference_close', 'referenceClose', 'numeric'],
    ['reference_close_date', 'referenceCloseDate', 'date'],
    ['source', 'source', 'text'],
    ['source_url', 'sourceUrl', 'text'],
    ['fetched_at', 'fetchedAt', 'timestamptz']
];

export const CHECK_COLUMNS = [
    ['mint', 'mint', 'text'],
    ['check_key', 'checkKey', 'text'],
    ['symbol', 'symbol', 'text'],
    ['issuer', 'issuer', 'text'],
    ['ticker', 'ticker', 'text'],
    ['action_kind', 'actionKind', 'text'],
    ['source_symbol', 'sourceSymbol', 'text'],
    ['ex_date', 'exDate', 'date'],
    ['action_event_at', 'actionEventAt', 'timestamptz'],
    ['expected_on_chain', 'expectedOnChain', 'boolean'],
    ['verdict', 'verdict', 'text'],
    ['severity', 'severity', 'text'],
    ['expected_ratio', 'expectedRatio', 'numeric'],
    ['expected_low', 'expectedLow', 'numeric'],
    ['expected_high', 'expectedHigh', 'numeric'],
    ['step_before', 'stepBefore', 'numeric'],
    ['step_after', 'stepAfter', 'numeric'],
    ['step_ratio', 'stepRatio', 'numeric'],
    ['step_at', 'stepAt', 'timestamptz'],
    ['step_window_from', 'stepWindowFrom', 'timestamptz'],
    ['step_window_to', 'stepWindowTo', 'timestamptz'],
    ['step_time_basis', 'stepTimeBasis', 'text'],
    ['lag_days', 'lagDays', 'numeric'],
    ['net_fraction', 'netFraction', 'numeric'],
    ['coverage_from', 'coverageFrom', 'timestamptz'],
    ['coverage_to', 'coverageTo', 'timestamptz'],
    ['coverage_basis', 'coverageBasis', 'text'],
    ['detail', 'detail', 'text'],
    ['checked_at', 'checkedAt', 'timestamptz']
];

/** Numbers go into the JSON as strings so jsonb keeps every digit of a multiplier. */
function jsonRow(row, columns) {
    const out = {};
    for (const [col, key, type] of columns) {
        const v = row[key];
        out[col] = v === null || v === undefined ? null : type === 'numeric' ? String(v) : v;
    }
    return out;
}

function upsertSql(table, rows, columns, conflict) {
    if (!rows.length) return null;
    const cols = columns.map(([c]) => c);
    const recordset = columns.map(([c, , type]) => `${c} ${type}`).join(', ');
    const update = cols.filter((c) => !conflict.includes(c));
    // checked_at moves every run; a row whose findings did not change must not bump updated_at.
    const guarded = update.filter((c) => c !== 'checked_at' && c !== 'fetched_at');
    return `INSERT INTO ${table} AS tgt (${cols.join(', ')})\n`
        + `SELECT ${cols.join(', ')} FROM jsonb_to_recordset(${jsonbLiteral(rows.map((r) => jsonRow(r, columns)))}) AS r(${recordset})\n`
        + `ON CONFLICT (${conflict.join(', ')}) DO UPDATE SET\n`
        + `    ${update.map((c) => `${c} = EXCLUDED.${c}`).join(',\n    ')},\n`
        + '    updated_at = CASE WHEN ' + guarded.map((c) => `tgt.${c} IS DISTINCT FROM EXCLUDED.${c}`).join(' OR ')
        + ' THEN now() ELSE tgt.updated_at END;\n';
}

export function buildActionUpsertSql(actions) {
    // One row per key: ON CONFLICT cannot touch the same row twice in one statement.
    const byKey = new Map(actions.map((a) => [`${a.sourceSymbol}|${a.kind}|${a.exDate}`, a]));
    return upsertSql('sonar.corporate_action', [...byKey.values()], ACTION_COLUMNS, ['source_symbol', 'kind', 'ex_date']);
}

/**
 * Upsert this run's checks, and drop the rows of the reconciled mints in the window that this run
 * no longer produces: a step later explained by a newly listed action must not stay "unexplained",
 * and an action whose verdict no longer applies must not keep a stale one. The window is judged by
 * the row's own time (the action's event time, else the step's).
 */
export function buildCheckSql(checks, { mints, since, checkedAt }) {
    const statements = [];
    if (mints.length) {
        const keep = checks.map((c) => ({ mint: c.mint, check_key: c.checkKey }));
        statements.push('DELETE FROM sonar.corporate_action_check t\n'
            + ` WHERE coalesce(t.action_event_at, t.step_at, t.step_window_to) >= (${jsonbLiteral(since)} #>> '{}')::timestamptz\n`
            + `   AND t.mint IN (SELECT jsonb_array_elements_text(${jsonbLiteral(mints)}))\n`
            + `   AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(${jsonbLiteral(keep)}) AS k(mint text, check_key text)`
            + ' WHERE k.mint = t.mint AND k.check_key = t.check_key);\n');
    }
    const sql = upsertSql('sonar.corporate_action_check', checks.map((c) => ({ ...c, checkedAt })), CHECK_COLUMNS, ['mint', 'check_key']);
    if (sql) statements.push(sql);
    return statements;
}

/** The chain watcher's readings, one row per configuration change per mint, as a JSON array. */
export const MINT_STATE_RUNS_QUERY = `
WITH s AS (
    SELECT mint, observed_at, ui_multiplier, ui_multiplier_next, ui_multiplier_effective_at,
           lag(ui_multiplier) OVER w AS pm, lag(ui_multiplier_next) OVER w AS pn,
           lag(ui_multiplier_effective_at) OVER w AS pt, lag(observed_at) OVER w AS prev_observed_at,
           max(observed_at) OVER () AS last_observed_at
      FROM sonar.mint_state
    WINDOW w AS (PARTITION BY mint ORDER BY observed_at)
)
SELECT coalesce(json_agg(json_build_object(
           'mint', mint, 'observedAt', observed_at, 'prevObservedAt', prev_observed_at,
           'multiplier', ui_multiplier::text, 'next', ui_multiplier_next::text,
           'effectiveAt', ui_multiplier_effective_at, 'lastObservedAt', last_observed_at)
         ORDER BY mint, observed_at), '[]'::json)
  FROM s
 WHERE prev_observed_at IS NULL OR ui_multiplier IS DISTINCT FROM pm
    OR ui_multiplier_next IS DISTINCT FROM pn OR ui_multiplier_effective_at IS DISTINCT FROM pt;`;

export const STORED_VERDICTS_QUERY = `SELECT coalesce(json_agg(json_build_object('mint', mint, 'checkKey', check_key, 'verdict', verdict)), '[]'::json)
  FROM sonar.corporate_action_check;`;

/** Group the runs query's rows by mint. */
export function groupRuns(rows) {
    const byMint = new Map();
    for (const row of rows) {
        if (!byMint.has(row.mint)) byMint.set(row.mint, { runs: [], lastObservedAt: row.lastObservedAt ?? null });
        byMint.get(row.mint).runs.push(row);
    }
    return byMint;
}

// ---------------------------------------------------------------------------------------------
// The one Telegram message.
// ---------------------------------------------------------------------------------------------

export function formatTelegramSummary({ counts, fresh, failures, tickers, durationMs }) {
    const lines = [`RWA Sonar corporate-action watch: ${fresh.length} new finding(s), ${failures.length} failure(s)`];
    lines.push(`${tickers} ticker(s) · matched ${counts.matched} · late ${counts.late} · wrong ratio ${counts.wrongRatio}`
        + ` · missing ${counts.missing} · unexplained ${counts.unexplained} · ${(durationMs / 1000).toFixed(0)} s`);
    const rank = { warning: 0, caution: 1, info: 2 };
    const top = [...fresh].sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3)).slice(0, 8);
    for (const c of top) lines.push(`• [${c.severity}] ${c.detail.slice(0, 220)}`);
    if (fresh.length > top.length) lines.push(`… and ${fresh.length - top.length} more in sonar.corporate_action_check`);
    for (const f of failures.slice(0, 5)) lines.push(`✗ ${String(f).slice(0, 200)}`);
    if (failures.length > 5) lines.push(`… and ${failures.length - 5} more failure(s)`);
    return lines.join('\n');
}
