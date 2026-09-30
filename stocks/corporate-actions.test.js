// Unit tests for stocks/lib/corporate-actions.mjs — the corporate-action reconciliation's decisions.
// Each guards something a reader of the verdicts would notice if it broke: a split or dividend read
// with the wrong date or size, a multiplier step placed at the time the watcher NOTICED it instead of
// the chain's effective time, a missing price or multiplier turned into 0 or 1, a tolerance edge on
// the wrong side, an action called "missing" for a mint we never read, and SQL naming a column the
// DDL does not have.
//
// The fixtures in fixtures/corporate-actions/ are REAL: Yahoo chart v8 responses captured on
// 2026-09-30 (APH with its 2:1 split of 2026-09-03, MDT, 0001.HK, SHEL.L and an unknown symbol), and
// sonar.mint_state configuration runs read from the local database the same day (APHx, MDTx, AAPLx,
// LRCXx, SATAx, AAPLon, CIBRon, Backpack MU, and the PreStocks OPENAI and SPACEX restatements).

import { readFileSync } from 'node:fs';

import {
    ACTION_COLUMNS, CHECK_COLUMNS, FINDING_VERDICTS, PROGRAMME_POLICY, TOLERANCES, VERDICTS,
    actionEvents, buildActionUpsertSql, buildCheckSql, expectedRange, formatTelegramSummary, groupRuns, localDate,
    multiplierSteps, netFraction, newFindings, num, parseYahooChart, programmePolicy, reconcileToken,
    snapshotSteps, summarise, yahooChartUrl, yahooSymbolFor
} from './lib/corporate-actions.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/corporate-actions/${name}`, import.meta.url), 'utf8'));
const DDL = readFileSync(new URL('../db/2026-10-01-sonar-corporate-actions.sql', import.meta.url), 'utf8');
const RUNS = fixture('mint-state-runs.json').tokens;

function parsed(file, ticker) {
    const rec = fixture(file);
    return parseYahooChart(rec.payload, { ticker, symbol: rec.symbol, url: rec.url, fetchedAt: rec.fetchedAt });
}

function historyOf(symbol, opts = {}) {
    const t = RUNS[symbol];
    return multiplierSteps(t.runs, { lastObservedAt: t.runs[0]?.lastObservedAt ?? null, existsSince: t.firstPoolAt, ...opts });
}

const token = (symbol, extra = {}) => ({ mint: RUNS[symbol]?.mint ?? `${symbol}-mint`, symbol, issuer: RUNS[symbol]?.issuer ?? 'xstocks-backed', underlyingTicker: RUNS[symbol]?.underlyingTicker ?? null, ...extra });

const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// A synthetic mint read hourly from 2026-06-01 to 2026-09-28 whose only update is `steps`.
function syntheticHistory(steps, { from = '2026-06-01T00:00:00Z', to = '2026-09-28T18:00:00Z' } = {}) {
    return { steps, coverageFrom: from, coverageTo: to, coverageBasis: 'test' };
}
const step = (atIso, before, after) => ({ before, after, ratio: before === null ? null : after / before, at: Date.parse(atIso), windowFrom: null, windowTo: Date.parse(atIso), basis: 'chain-effective-timestamp' });
const dividend = (exIso, amount, close, extra = {}) => ({
    ticker: 'T', sourceSymbol: 'T', kind: 'dividend', exDate: exIso.slice(0, 10), eventAt: exIso, amount, currency: 'USD',
    numerator: null, denominator: null, ratio: null, referenceClose: close, referenceCloseDate: close === null ? null : '2026-08-07', ...extra
});
const split = (exIso, n, d) => ({ ticker: 'T', sourceSymbol: 'T', kind: 'split', exDate: exIso.slice(0, 10), eventAt: exIso, amount: null, currency: 'USD', numerator: n, denominator: d, ratio: n / d, referenceClose: null, referenceCloseDate: null });
const reconcile = (actions, history, extra = {}) => reconcileToken({
    token: token('T', { mint: 'T-mint', underlyingTicker: 'T' }), policy: programmePolicy('xstocks-backed'), actions, history,
    since: '2026-06-01T00:00:00Z', now: '2026-09-30T00:00:00Z', ...extra
});
const EX = '2026-08-10T13:30:00Z';
const EX_MS = Date.parse(EX);

describe('Yahoo chart payloads (real)', () => {
    test("APH: the 2:1 split with Yahoo's own event time and the exchange-local ex-date", () => {
        const p = parsed('yahoo-APH.json', 'APH');
        expect(p.ok).toBe(true);
        expect(p.currency).toBe('USD');
        const s = p.actions.filter((a) => a.kind === 'split');
        expect(s).toEqual([expect.objectContaining({ exDate: '2026-09-03', eventAt: '2026-09-03T13:30:00Z', numerator: 2, denominator: 1, ratio: 2, sourceSymbol: 'APH', source: 'yahoo-chart-v8' })]);
    });

    test('a dividend carries the last close strictly BEFORE its ex-date, and none when the bars start on it', () => {
        const divs = parsed('yahoo-APH.json', 'APH').actions.filter((a) => a.kind === 'dividend');
        const sep = divs.find((a) => a.exDate === '2026-09-22');
        expect(sep).toMatchObject({ amount: 0.125, referenceCloseDate: '2026-09-21' });
        expect(sep.referenceClose).toBeCloseTo(80.72, 2);
        // The fetched window starts on 2026-03-23, APH's ex-date that day: no cum-dividend close, and null — never 0.
        const mar = divs.find((a) => a.exDate === '2026-03-23');
        expect(mar.referenceClose).toBeNull();
        expect(expectedRange(mar)).toBeNull();
    });

    test('Hong Kong (0001.HK): ex-date in Hong Kong time, event time as Yahoo gives it (01:30 UTC)', () => {
        const p = parsed('yahoo-0001.HK.json', '1');
        expect(p.ok).toBe(true);
        expect(p.currency).toBe('HKD');
        expect(p.timeZone).toBe('Asia/Hong_Kong');
        expect(p.actions).toEqual([expect.objectContaining({ kind: 'dividend', exDate: '2026-09-14', eventAt: '2026-09-14T01:30:00Z', amount: 0.7455, currency: 'HKD', referenceCloseDate: '2026-09-11' })]);
        expect(localDate(Date.parse('2026-09-13T17:00:00Z') / 1000, 'Asia/Hong_Kong')).toBe('2026-09-14');
    });

    test('London quotes in pence; dividends are kept as the source states them', () => {
        const p = parsed('yahoo-SHEL.L.json', 'SHELL');
        expect(p.ok).toBe(true);
        expect(p.currency).toBe('GBp');
        expect(p.actions).toEqual([expect.objectContaining({ kind: 'dividend', amount: 28.92, currency: 'GBp' })]);
    });

    test('an unknown symbol is a clean "not found", no actions', () => {
        const p = parseYahooChart(fixture('yahoo-unknown-symbol.json'), { ticker: 'X', symbol: 'NOSUCHTICKERZZ' });
        expect(p).toMatchObject({ ok: false, actions: [] });
        expect(p.error).toMatch(/Not Found/);
    });

    test('a malformed event (no date, zero amount, 0 denominator) is dropped, not coerced', () => {
        const p = parseYahooChart({ chart: { result: [{ meta: { exchangeTimezoneName: 'America/New_York', currency: 'USD' }, timestamp: [], indicators: { quote: [{ close: [] }] },
            events: { dividends: { a: { amount: 0, date: 1790343000 }, b: { amount: 0.5 } }, splits: { c: { date: 1790343000, numerator: 2, denominator: 0 } } } }] } }, { ticker: 'X', symbol: 'X' });
        expect(p.actions).toEqual([]);
    });

    test('the request URL asks for daily bars and both event kinds', () => {
        expect(yahooChartUrl('BRK-B', { period1: 1, period2: 2 })).toBe('https://query1.finance.yahoo.com/v8/finance/chart/BRK-B?period1=1&period2=2&interval=1d&events=div%2Csplit&includeAdjustedClose=false');
    });
});

describe('listing symbols', () => {
    test.each([
        [{ underlyingTicker: 'AAPL', issuer: 'ondo-global-markets' }, 'AAPL'],
        [{ underlyingTicker: 'BRK.B', issuer: 'xstocks-backed', issuerApi: { listingCountry: 'US' } }, 'BRK-B'],
        [{ underlyingTicker: '700', issuer: 'xstocks-backed', issuerApi: { listingCountry: 'HK' } }, '0700.HK'],
        [{ underlyingTicker: 'LGENL', issuer: 'xstocks-backed', issuerApi: { listingCountry: 'GB' } }, 'LGEN.L'],
        [{ underlyingTicker: 'SHELL', issuer: 'xstocks-backed', issuerApi: { listingCountry: 'GB' } }, 'SHEL.L'],
        [{ underlyingTicker: 'LSEG', issuer: 'xstocks-backed', issuerApi: { listingCountry: 'GB' } }, 'LSEG.L'],
        [{ underlyingTicker: 'BTL', issuer: 'xstocks-backed', issuerApi: { listingCountry: 'GB' } }, 'BT-A.L'],
        [{ underlyingTicker: 'VOW3D', issuer: 'xstocks-backed', issuerApi: { listingCountry: 'DE' } }, 'VOW3.DE']
    ])('%j → %s', (t, symbol) => {
        expect(yahooSymbolFor(t).symbol).toBe(symbol);
    });

    test('no ticker, or an xStock without a listing country, has no symbol — never a guess', () => {
        expect(yahooSymbolFor({ underlyingTicker: null, issuer: 'prestocks' })).toEqual({ symbol: null, reason: 'no underlying ticker' });
        expect(yahooSymbolFor({ underlyingTicker: 'HRB', issuer: 'xstocks-backed' }).symbol).toBeNull();
    });
});

describe('multiplier steps from the chain watcher (real mint_state)', () => {
    test("APHx: the split at the mint's own effective time, not when the watcher noticed the raw field move (2026-09-21)", () => {
        const h = historyOf('APHx');
        expect(h.steps.map((s) => [s.before, s.after, iso(s.at)])).toEqual([
            [1, 2, '2026-09-03T08:45:00Z'],
            [2, 2.002167988108, '2026-09-22T00:30:00Z']
        ]);
        expect(h.coverageFrom).toBe('2026-09-03T08:45:00Z');
        expect(h.coverageBasis).toBe('first-configuration-effective-time');
    });

    test('OPENAI: one ×1.4861347 step effective 2026-07-17T16:30Z, recovered from the still-pending-shaped account', () => {
        const h = historyOf('OPENAI');
        expect(h.steps).toHaveLength(1);
        expect(h.steps[0]).toMatchObject({ before: 1, after: 1.4861347, basis: 'chain-effective-timestamp' });
        expect(iso(h.steps[0].at)).toBe('2026-07-17T16:30:00Z');
    });

    test("Ondo's immediate updates: the first one's prior value is unknown (ratio null), the mass re-set of 09-18 is a no-op", () => {
        const h = historyOf('AAPLon');
        expect(h.noOps).toBe(1);
        expect(h.steps).toHaveLength(1);
        expect(h.steps[0].before).toBeNull();
        expect(h.steps[0].ratio).toBeNull();
        expect(h.coverageFrom).toBe('2026-09-02T10:14:04Z');
    });

    test('CIBRon: an immediate update after the first reading takes its prior value from the reading before', () => {
        const h = historyOf('CIBRon');
        const s = h.steps.find((x) => iso(x.at) === '2026-09-24T00:04:04Z');
        expect(s.before).toBe(1.001877709100959);
        expect(s.ratio).toBeCloseTo(1.0000195594, 9);
    });

    test("Backpack MU's hourly 1e-11 drift is dust: no step at all", () => {
        const h = historyOf('MU');
        expect(h.steps).toEqual([]);
        expect(h.dust).toBeGreaterThan(0);
    });

    test('coverage runs to the watcher\'s newest reading of ANY mint (rows are only written on change)', () => {
        expect(historyOf('SATAx').coverageTo).toBe(RUNS.OPENAI.runs[0].lastObservedAt.replace(/\.\d+/, '').replace('+00:00', 'Z'));
    });

    test('a never-updated mint (1, 1, no timestamp) is covered from its first pool, else from the first reading', () => {
        const runs = [{ mint: 'M', observedAt: '2026-09-20T12:00:00Z', prevObservedAt: null, multiplier: '1', next: '1', effectiveAt: null }];
        expect(multiplierSteps(runs, { existsSince: '2026-07-01T00:00:00Z' })).toMatchObject({ coverageFrom: '2026-07-01T00:00:00Z', coverageBasis: 'never-updated-since-first-pool', steps: [] });
        expect(multiplierSteps(runs, {})).toMatchObject({ coverageFrom: '2026-09-20T12:00:00Z', coverageBasis: 'first-reading' });
        // Not 1/1: an update without a timestamp once happened; coverage cannot reach back past the reading.
        const moved = [{ ...runs[0], multiplier: '1.2', next: '1.2' }];
        expect(multiplierSteps(moved, { existsSince: '2026-07-01T00:00:00Z' }).coverageFrom).toBe('2026-09-20T12:00:00Z');
    });

    test('a null multiplier is a gap, never 1: no step to or from it', () => {
        const runs = [
            { mint: 'M', observedAt: '2026-09-20T12:00:00Z', prevObservedAt: null, multiplier: '1.1', next: '1.1', effectiveAt: '2026-09-01T00:00:00Z' },
            { mint: 'M', observedAt: '2026-09-21T12:00:00Z', prevObservedAt: '2026-09-20T12:00:00Z', multiplier: null, next: null, effectiveAt: null }
        ];
        expect(multiplierSteps(runs).steps.filter((s) => s.ratio !== null)).toEqual([]);
        const snap = snapshotSteps([
            { observedAt: '2026-09-22T18:00:00Z', multiplier: '1.5' },
            { observedAt: '2026-09-23T18:00:00Z', multiplier: null },
            { observedAt: '2026-09-24T18:00:00Z', multiplier: '1.5' }
        ]);
        expect(snap.steps).toEqual([]);
        expect(num(null)).toBeNull();
        expect(num('')).toBeNull();
    });

    test('groupRuns keeps each mint\'s runs and its last reading', () => {
        const g = groupRuns(RUNS.CIBRon.runs);
        expect(g.get(RUNS.CIBRon.mint).runs).toHaveLength(3);
    });
});

describe('reconciliation on real data', () => {
    test('APHx: the 2:1 split matched on time (−0.2 d), and the dividend after it matched at 30 % withholding', () => {
        const checks = reconcileToken({
            token: token('APHx'), policy: programmePolicy('xstocks-backed'), actions: parsed('yahoo-APH.json', 'APH').actions,
            history: historyOf('APHx'), since: '2026-06-01T00:00:00Z', now: '2026-09-30T00:00:00Z'
        });
        const bySplit = checks.find((c) => c.actionKind === 'split');
        expect(bySplit).toMatchObject({ verdict: 'matched', stepRatio: 2, stepAt: '2026-09-03T08:45:00Z', severity: 'info' });
        expect(bySplit.lagDays).toBeCloseTo(-0.2, 1);
        const div = checks.find((c) => c.checkKey === 'dividend:APH:2026-09-22');
        expect(div.verdict).toBe('matched');
        expect(div.netFraction).toBeCloseTo(0.70, 2);
        // The June dividend predates the mint's history: unknown, not missing.
        expect(checks.find((c) => c.checkKey === 'dividend:APH:2026-06-23').verdict).toBe('no-coverage');
        expect(checks.filter((c) => c.verdict === 'unexplained')).toEqual([]);
    });

    test('MDTx: both quarterly dividends matched net of 25 % Irish withholding', () => {
        const checks = reconcileToken({
            token: token('MDTx'), policy: programmePolicy('xstocks-backed'), actions: parsed('yahoo-MDT.json', 'MDT').actions,
            history: historyOf('MDTx'), since: '2026-06-01T00:00:00Z', now: '2026-09-30T00:00:00Z'
        });
        const matched = checks.filter((c) => c.verdict === 'matched');
        expect(matched.map((c) => c.exDate)).toEqual(expect.arrayContaining(['2026-09-25']));
        for (const c of matched) expect(c.netFraction).toBeCloseTo(0.75, 2);
    });

    test('OPENAI (PreStocks): the ×1.486 restatement has no corporate action behind it — an unexplained warning', () => {
        const checks = reconcileToken({
            token: token('OPENAI'), policy: programmePolicy('prestocks'), actions: [],
            history: historyOf('OPENAI'), since: '2026-07-02T00:00:00Z', now: '2026-09-30T00:00:00Z'
        });
        expect(checks).toEqual([expect.objectContaining({ verdict: 'unexplained', severity: 'warning', stepAt: '2026-07-17T16:30:00Z', checkKey: 'step:2026-07-17T16:30:00Z:1.4861347' })]);
        expect(checks[0].detail).toMatch(/no listed underlying/);
    });
});

describe('tolerances, at their edges', () => {
    const covered = (s) => syntheticHistory([s]);

    test('split ratio: ±0.5 % matches, beyond is wrong-ratio', () => {
        const at = '2026-08-10T08:00:00Z';
        expect(reconcile([split(EX, 2, 1)], covered(step(at, 1, 2 * 1.0049)))[0].verdict).toBe('matched');
        expect(reconcile([split(EX, 2, 1)], covered(step(at, 1, 2 * 0.9951)))[0].verdict).toBe('matched');
        const wrong = reconcile([split(EX, 2, 1)], covered(step(at, 1, 2 * 1.0051)));
        expect(wrong[0]).toMatchObject({ verdict: 'wrong-ratio', severity: 'warning' });
        // A 1:10 reverse split read as ×0.1.
        expect(reconcile([split(EX, 1, 10)], covered(step(at, 1, 0.1)))[0].verdict).toBe('matched');
    });

    test(`dividend net fraction: [${TOLERANCES.dividendNetFractionMin}, ${TOLERANCES.dividendNetFractionMax}] matches, outside is wrong-ratio`, () => {
        const y = 1 / 100; // $1 on a $100 close
        const verdictAt = (f) => reconcile([dividend(EX, 1, 100)], covered(step('2026-08-10T00:30:00Z', 1, 1 + y * f)))[0].verdict;
        expect(verdictAt(0.7)).toBe('matched');
        expect(verdictAt(0.6001)).toBe('matched');
        expect(verdictAt(1.0499)).toBe('matched');
        expect(verdictAt(0.5999)).toBe('wrong-ratio');
        expect(verdictAt(1.0501)).toBe('wrong-ratio');
    });

    test(`timing: on time from ex − ${TOLERANCES.earlyDays} d to ex + ${TOLERANCES.onTimeDays} d, then late up to ex + ${TOLERANCES.lateDays} d`, () => {
        const verdictAt = (ms) => reconcile([split(EX, 3, 1)], covered(step(iso(ms), 1, 3)))[0];
        expect(verdictAt(EX_MS - TOLERANCES.earlyDays * DAY).verdict).toBe('matched');
        expect(verdictAt(EX_MS + TOLERANCES.onTimeDays * DAY).verdict).toBe('matched');
        const late = verdictAt(EX_MS + TOLERANCES.onTimeDays * DAY + 3600_000);
        expect(late).toMatchObject({ verdict: 'late', severity: 'caution' });
        expect(late.lagDays).toBeCloseTo(3.04, 2);
        // Too early is not this action's step: the split is missing and the step is unexplained.
        const early = reconcile([split(EX, 3, 1)], covered(step(iso(EX_MS - TOLERANCES.earlyDays * DAY - 3600_000), 1, 3)));
        expect(early.map((c) => c.verdict).sort()).toEqual(['missing', 'unexplained']);
        // Past the late limit it is no longer matched to the action either.
        const tooLate = reconcile([split(EX, 3, 1)], covered(step(iso(EX_MS + (TOLERANCES.lateDays + 1) * DAY), 1, 3)));
        expect(tooLate.map((c) => c.verdict).sort()).toEqual(['missing', 'unexplained']);
    });

    test('dust: a step under 1e-6 is not a step', () => {
        const h = multiplierSteps([
            { mint: 'M', observedAt: '2026-09-20T12:00:00Z', prevObservedAt: null, multiplier: '1.0001', next: '1.0001', effectiveAt: '2026-09-01T00:00:00Z' },
            { mint: 'M', observedAt: '2026-09-21T12:00:00Z', prevObservedAt: '2026-09-20T12:00:00Z', multiplier: '1.00010099', next: '1.00010099', effectiveAt: '2026-09-21T11:00:00Z' },
            { mint: 'M', observedAt: '2026-09-22T12:00:00Z', prevObservedAt: '2026-09-21T12:00:00Z', multiplier: '1.00020099', next: '1.00020099', effectiveAt: '2026-09-22T11:00:00Z' }
        ]);
        expect(h.dust).toBe(1);
        expect(h.steps.filter((s) => s.ratio !== null)).toHaveLength(1);
    });

    test('unexplained severity: ≥ 5 % is a warning, below a caution', () => {
        expect(reconcile([], covered(step('2026-08-01T00:00:00Z', 1, 1.05)))[0].severity).toBe('warning');
        expect(reconcile([], covered(step('2026-08-01T00:00:00Z', 1, 1.0499)))[0].severity).toBe('caution');
    });
});

describe('missing data stays unknown', () => {
    test('no step and the mint read throughout → missing; the mint read only from after the ex-date → no-coverage', () => {
        expect(reconcile([dividend(EX, 1, 100)], syntheticHistory([]))[0]).toMatchObject({ verdict: 'missing', severity: 'caution' });
        expect(reconcile([split(EX, 2, 1)], syntheticHistory([]))[0]).toMatchObject({ verdict: 'missing', severity: 'warning' });
        expect(reconcile([dividend(EX, 1, 100)], syntheticHistory([], { from: '2026-08-09T00:00:00Z' }))[0].verdict).toBe('no-coverage');
        expect(reconcile([dividend(EX, 1, 100)], { steps: [], coverageFrom: null, coverageTo: null })[0].verdict).toBe('no-coverage');
    });

    test('readings ending before the on-time window closes → pending, not missing', () => {
        expect(reconcile([dividend(EX, 1, 100)], syntheticHistory([], { to: '2026-08-12T00:00:00Z' }))[0].verdict).toBe('pending');
    });

    test('no cum-dividend close: an increase on time is unverifiable, never matched nor wrong-ratio', () => {
        const [c] = reconcile([dividend(EX, 1, null)], syntheticHistory([step('2026-08-10T00:30:00Z', 1, 1.5)].map((s) => ({ ...s, after: 1.007, ratio: 1.007 }))));
        expect(c).toMatchObject({ verdict: 'unverifiable', expectedRatio: null, netFraction: null });
    });

    test('an update whose prior value was never read, on time: unverifiable, and never reported as unexplained', () => {
        const checks = reconcile([dividend(EX, 1, 100)], syntheticHistory([step('2026-08-10T00:04:00Z', null, 1.007)]));
        expect(checks.map((c) => c.verdict)).toEqual(['unverifiable']);
        expect(reconcile([], syntheticHistory([step('2026-08-10T00:04:00Z', null, 1.007)]))).toEqual([]);
    });

    test('a right-sized step after the on-time window, with the window itself unread: unverifiable (not late), and it is not unexplained', () => {
        const h = syntheticHistory([step(iso(EX_MS + 10 * DAY), 1, 1.007)], { from: iso(EX_MS + 5 * DAY) });
        expect(reconcile([dividend(EX, 1, 100)], h).map((c) => c.verdict)).toEqual(['unverifiable']);
    });

    test('equal daily dividends each take their own on-time step before any late match (SATA)', () => {
        const days = ['2026-09-21', '2026-09-22', '2026-09-23'];
        const actions = days.map((d) => dividend(`${d}T13:30:00Z`, 0.052, 100));
        const steps = days.map((d, i) => step(`${d}T00:30:00Z`, 1 + i * 0.0005, 1 + (i + 1) * 0.0005));
        const checks = reconcile(actions, syntheticHistory(steps));
        expect(checks.map((c) => [c.exDate, c.verdict, c.stepAt])).toEqual(days.map((d) => [d, 'matched', `${d}T00:30:00Z`]));
    });
});

describe('programme policy', () => {
    test('each policy quotes its dossier, and the dossier still says so', () => {
        for (const [slug, p] of Object.entries(PROGRAMME_POLICY)) {
            const text = readFileSync(new URL(`./data/issuers/${p.dossier}`, import.meta.url), 'utf8');
            expect([slug, text.includes(p.quote.replace(/"/g, '\\"'))]).toEqual([slug, true]);
        }
    });

    test('a programme that does not pass dividends through the multiplier gets no "missing" for one', () => {
        const backpack = reconcileToken({ token: token('MU'), policy: programmePolicy('backpack-securities'), actions: [dividend(EX, 1, 100)], history: syntheticHistory([]), since: '2026-06-01T00:00:00Z', now: '2026-09-30T00:00:00Z' });
        expect(backpack).toEqual([]);
        expect(programmePolicy('no-such-issuer')).toMatchObject({ dividends: 'unknown', splits: 'unknown' });
    });

    test('…but an action that explains a step is recorded for any programme', () => {
        const checks = reconcileToken({ token: token('X'), policy: programmePolicy('bullish'), actions: [split(EX, 2, 1)], history: syntheticHistory([step('2026-08-10T08:00:00Z', 1, 2)]), since: '2026-06-01T00:00:00Z', now: '2026-09-30T00:00:00Z' });
        expect(checks).toEqual([expect.objectContaining({ verdict: 'matched', expectedOnChain: false })]);
    });
});

describe('outcome, summary and SQL', () => {
    const sample = reconcile([dividend(EX, 1, 100), split('2026-09-01T13:30:00Z', 2, 1)], syntheticHistory([step('2026-08-10T00:30:00Z', 1, 1.007), step('2026-07-01T00:00:00Z', 1, 1.3)]));

    test('summarise counts each verdict; findings are late / wrong-ratio / missing / unexplained', () => {
        expect(summarise(sample)).toMatchObject({ checks: 3, matched: 1, missing: 1, unexplained: 1 });
        expect([...FINDING_VERDICTS].sort()).toEqual(['late', 'missing', 'unexplained', 'wrong-ratio']);
        for (const v of FINDING_VERDICTS) expect(VERDICTS).toContain(v);
    });

    test('a finding is new only when its stored verdict differs', () => {
        const stored = new Map(sample.map((c) => [`${c.mint}|${c.checkKey}`, c.verdict]));
        expect(newFindings(sample, stored)).toEqual([]);
        const missing = sample.find((c) => c.verdict === 'missing');
        stored.delete(`${missing.mint}|${missing.checkKey}`);
        expect(newFindings(sample, stored)).toHaveLength(1);
    });

    test('change events only for warning findings, dated by when the finding was first stored', () => {
        const warnings = sample.filter((c) => FINDING_VERDICTS.has(c.verdict) && c.severity === 'warning');
        expect(warnings.length).toBeGreaterThan(0);
        const fresh = actionEvents(sample, [], '2026-10-01T05:13:00Z');
        expect(fresh.map((e) => e.subjectId)).toEqual(warnings.map((c) => c.mint));
        expect(fresh[0]).toMatchObject({ kind: 'corporate-action', subjectType: 'token', severity: 'warning', detectedAt: '2026-10-01T05:13:00Z',
            field: `${warnings[0].checkKey}:${warnings[0].verdict}`, after: warnings[0].verdict, summary: warnings[0].detail });
        const stored = warnings.map((c) => ({ mint: c.mint, checkKey: c.checkKey, verdict: c.verdict, firstCheckedAt: '2026-09-30T13:51:04.491031+00:00' }));
        expect(actionEvents(sample, stored, '2026-10-01T05:13:00Z')[0].detectedAt).toBe('2026-09-30T13:51:04Z');
        // A stored row with another verdict is a new finding: dated now.
        expect(actionEvents(sample, stored.map((r) => ({ ...r, verdict: 'matched' })), '2026-10-01T05:13:00Z')[0].detectedAt).toBe('2026-10-01T05:13:00Z');
        // A caution-level finding (a small unexplained step, a missed dividend) stays off the feed.
        expect(actionEvents([{ ...warnings[0], severity: 'caution' }], [], '2026-10-01T05:13:00Z')).toEqual([]);
    });

    test('ONE message, warnings first, capped', () => {
        const msg = formatTelegramSummary({ counts: summarise(sample), fresh: sample.filter((c) => FINDING_VERDICTS.has(c.verdict)), failures: ['APH: HTTP 500'], tickers: 1, durationMs: 1000 });
        const lines = msg.split('\n');
        expect(lines[0]).toBe('RWA Sonar corporate-action watch: 2 new finding(s), 1 failure(s)');
        expect(lines[2]).toMatch(/^• \[warning\]/);
        expect(msg).toContain('✗ APH: HTTP 500');
    });

    test('every column the SQL writes exists in the DDL, and values travel only inside a jsonb literal', () => {
        for (const [col] of [...ACTION_COLUMNS, ...CHECK_COLUMNS]) expect(DDL).toMatch(new RegExp(`\\n\\s+${col}\\s`));
        const sql = buildCheckSql(sample, { mints: ['T-mint'], since: '2026-06-01T00:00:00Z', checkedAt: '2026-09-30T00:00:00Z' }).join('\n');
        expect(sql).toMatch(/DELETE FROM sonar\.corporate_action_check/);
        expect(sql).toMatch(/INSERT INTO sonar\.corporate_action_check/);
        expect(sql).toContain(`$sonar$"2026-06-01T00:00:00Z"$sonar$::jsonb #>> '{}')::timestamptz`);
        const actions = parsed('yahoo-APH.json', 'APH').actions;
        const a = buildActionUpsertSql([...actions, actions[0]]);
        expect(a).toMatch(/ON CONFLICT \(source_symbol, kind, ex_date\)/);
        expect(JSON.parse(/\$sonar\$(.*)\$sonar\$/s.exec(a)[1])).toHaveLength(actions.length);
    });

    test('multipliers keep every digit on their way into numeric columns', () => {
        const sql = buildCheckSql(reconcileToken({ token: token('OPENAI'), policy: programmePolicy('prestocks'), actions: [], history: historyOf('OPENAI'), since: '2026-07-01T00:00:00Z', now: '2026-09-30T00:00:00Z' }),
            { mints: [], since: '2026-07-01T00:00:00Z', checkedAt: '2026-09-30T00:00:00Z' }).join('\n');
        expect(sql).toContain('"step_after":"1.4861347"');
        expect(sql).not.toContain('DELETE');
    });

    test('netFraction is null without its inputs', () => {
        expect(netFraction(dividend(EX, 1, null), 1.007)).toBeNull();
        expect(netFraction(dividend(EX, 1, 100), null)).toBeNull();
        expect(netFraction(split(EX, 2, 1), 2)).toBeNull();
    });
});
