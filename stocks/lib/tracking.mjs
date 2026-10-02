// PURE analytics behind tracking.html: (1) how far each Solana wrapper of one underlying share
// traded from that share's reference price over time, with the underlying market's closed periods,
// and (2) where every token sits on holder concentration against pool liquidity. No I/O and no
// clock — every instant comes from the inputs — so all of it is unit-tested headlessly
// (../tracking.test.js). stocks/build-tracking.mjs reads the files and writes stocks-tracking.json.
//
// The central honesty rule for (1): a premium is only computed against a reference price that was
// valid AT THE INSTANT of the price it is compared with. Three kinds of point satisfy that:
//   quote     the Jupiter price and the reference fetched in the same run (stocks/data/reference-
//             prices.json), accumulated run by run in the tracking log;
//   snapshot  the premium frozen into a daily snapshot (stocks/data/history/<date>/tokens.json) —
//             the same same-run comparison, but the snapshot does not record the reference source;
//   trades    the median of on-chain trades in one hour and one market session, each trade paired
//             with a reference observed in the SAME closed stretch of the underlying market (the
//             price cannot move while the listed market is shut) or within PAIR_TOLERANCE_MS of it.
// A trade with no such reference is not plotted at all: a premium against a stale reference would
// be the reference's drift, not the wrapper's.

import { median } from './grade.mjs';
import { topSharePctExcludingLabels } from './health.mjs';
import { dedupeOwners } from './holders.mjs';
import { parseSchedule, sessionAt } from './market-hours.mjs';
import { premiumPct } from './pyth.mjs';

/** Resolution of the closed-period scan. US schedule boundaries (09:30, 13:00, 16:00) are multiples. */
export const STEP_MS = 5 * 60 * 1000;
/** An open-market trade pairs only with a reference observed this close to it. */
export const PAIR_TOLERANCE_MS = 10 * 60 * 1000;
/** The tracking log keeps this much history; older entries are pruned on each run. */
export const LOG_KEEP_MS = 90 * 24 * 60 * 60 * 1000;
/** Two snapshot/quote premia closer than this (percentage points) are the same observation. */
export const SAME_PREMIUM_EPS = 1e-4;
/** A snapshot within this of a logged quote with the same premium is that quote, not a second one. */
export const SNAPSHOT_QUOTE_MATCH_MS = 6 * 60 * 60 * 1000;

/** The "one wallet, nowhere to sell" corner of the concentration scatter. */
export const CORNER = { minTop1SharePct: 50, maxLiquidityUsd: 10_000 };

const HOUR_MS = 60 * 60 * 1000;

function positiveOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function finiteOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function isoOrNull(ms) {
    return Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
}

function parseMs(iso) {
    if (typeof iso !== 'string') return null;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
}

/** Pyth publish times are unix seconds; accept ms too rather than land in 1970. */
function publishTimeMs(value) {
    const n = finiteOrNull(value);
    if (n === null || n <= 0) return null;
    return n < 1e12 ? n * 1000 : n;
}

// --- market sessions ----------------------------------------------------------------------------

/**
 * The underlying market's non-open stretches between `fromMs` and `toMs`, merged, as
 * `[{from, to, holiday}]` in unix ms (`to` is the first open instant, or `toMs`). Null when the
 * schedule is unknown — "we do not know the hours" must never be drawn as "closed".
 */
export function closedIntervals(schedule, fromMs, toMs, stepMs = STEP_MS) {
    if (!schedule || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return null;
    const out = [];
    let run = null;
    const start = Math.floor(fromMs / stepMs) * stepMs;
    for (let t = start; t <= toMs; t += stepMs) {
        const session = sessionAt(schedule, t);
        if (session === 'unknown') return null;
        if (session === 'open') {
            if (run !== null) {
                run.to = t;
                out.push(run);
                run = null;
            }
            continue;
        }
        if (run === null) run = { from: Math.max(t, fromMs), to: toMs, holiday: false };
        if (session === 'holiday') run.holiday = true;
    }
    if (run !== null) {
        run.to = toMs;
        out.push(run);
    }
    return out;
}

/** Index of the closed stretch containing `ms` (from inclusive, to exclusive), or -1 when open. */
export function stretchIndex(intervals, ms) {
    if (!Array.isArray(intervals) || !Number.isFinite(ms)) return -1;
    let lo = 0;
    let hi = intervals.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const iv = intervals[mid];
        if (ms < iv.from) hi = mid - 1;
        else if (ms >= iv.to) lo = mid + 1;
        else return mid;
    }
    return -1;
}

/**
 * The reference observation a price at `atMs` may be compared with, or null. Preference: the
 * nearest observation in the same closed stretch (basis `same-closed-session`), else the nearest
 * within `toleranceMs` (basis `within-10-min`). `observations` need `atMs`.
 */
export function pairReference(atMs, observations, intervals, toleranceMs = PAIR_TOLERANCE_MS) {
    if (!Number.isFinite(atMs) || !Array.isArray(observations)) return null;
    const k = stretchIndex(intervals, atMs);
    let best = null;
    if (k >= 0) {
        for (const obs of observations) {
            if (stretchIndex(intervals, obs.atMs) !== k) continue;
            const gap = Math.abs(obs.atMs - atMs);
            if (best === null || gap < best.gap) best = { obs, gap, basis: 'same-closed-session' };
        }
        if (best !== null) return best;
    }
    for (const obs of observations) {
        const gap = Math.abs(obs.atMs - atMs);
        if (gap > toleranceMs) continue;
        if (best === null || gap < best.gap) best = { obs, gap, basis: 'within-10-min' };
    }
    return best;
}

// --- reference observations and the log -------------------------------------------------------

/**
 * One observation per usable reference-price item: the underlying's reference price, the
 * Jupiter price of the wrapper fetched in the same run and the premium between them. The instant
 * is the Pyth publish time when there is one, else the run's fetchedAt (Ondo's implied price and
 * issuer marks carry no publish time of their own) — `atBasis` says which.
 */
export function referenceObservations(referenceDoc) {
    const fetchedAt = stringOrNull(referenceDoc?.fetchedAt);
    const fetchedMs = parseMs(fetchedAt);
    const out = [];
    for (const item of Array.isArray(referenceDoc?.items) ? referenceDoc.items : []) {
        const mint = stringOrNull(item?.mint);
        const refPrice = positiveOrNull(item?.refPrice);
        if (mint === null || refPrice === null || fetchedMs === null) continue;
        const published = publishTimeMs(item.refPublishTime);
        const atMs = published ?? fetchedMs;
        const jupiterPrice = positiveOrNull(item.jupiterPrice);
        out.push({
            mint,
            ticker: stringOrNull(item.underlyingTicker),
            at: isoOrNull(atMs),
            atBasis: published === null ? 'fetched-at' : 'publish-time',
            fetchedAt,
            source: stringOrNull(item.refSource),
            refPrice,
            jupiterPrice,
            premiumPct: premiumPct(jupiterPrice, refPrice)
        });
    }
    return out;
}

/** An empty tracking log, the shape build-tracking.mjs persists between runs. */
export function emptyLog() {
    return { version: 1, references: [], trades: [] };
}

function refKey(ref) {
    return `${ref.mint}|${ref.fetchedAt}`;
}

/**
 * Pair every usable trade with a reference observation of the same mint, as log trade records.
 * Returns `{records, skipped}`; `skipped` counts why trades were not paired so a run can say so.
 */
export function pairTrades(trades, references, intervalsByMint) {
    const byMint = new Map();
    for (const ref of Array.isArray(references) ? references : []) {
        const atMs = parseMs(ref.at);
        if (atMs === null) continue;
        if (!byMint.has(ref.mint)) byMint.set(ref.mint, []);
        byMint.get(ref.mint).push({ ...ref, atMs });
    }
    const skipped = { suspect: 0, noPriceUsd: 0, badTime: 0, noReferenceRecord: 0, noContemporaneousReference: 0 };
    const records = [];
    for (const trade of Array.isArray(trades) ? trades : []) {
        const mint = stringOrNull(trade?.mint);
        const sig = stringOrNull(trade?.sig);
        if (mint === null || sig === null) continue;
        // Round-trip or out-of-band prints are arithmetically real and economically meaningless.
        if (trade.suspect) { skipped.suspect += 1; continue; }
        const priceUsd = positiveOrNull(trade.priceUsd ?? trade.price_usd);
        if (priceUsd === null) { skipped.noPriceUsd += 1; continue; }
        const atMs = parseMs(typeof trade.time === 'string' ? trade.time : null);
        if (atMs === null) { skipped.badTime += 1; continue; }
        const refs = byMint.get(mint);
        if (refs === undefined) { skipped.noReferenceRecord += 1; continue; }
        const paired = pairReference(atMs, refs, intervalsByMint?.get(mint) ?? null);
        if (paired === null) { skipped.noContemporaneousReference += 1; continue; }
        records.push({
            sig,
            t: isoOrNull(atMs),
            mint,
            priceUsd,
            refPrice: paired.obs.refPrice,
            refSource: paired.obs.source,
            refAt: paired.obs.at,
            basis: paired.basis,
            premiumPct: premiumPct(priceUsd, paired.obs.refPrice)
        });
    }
    return { records, skipped };
}

/**
 * Merge this run's reference observations and trades into the log, idempotently: references are
 * keyed by (mint, fetchedAt), trades by signature. Every trade — old and new — is re-paired against
 * the merged reference set, so a later reference in the same closed stretch can only tighten a
 * pairing. Entries older than `keepFromMs` are pruned. Sorted output, so a rerun is byte-identical.
 */
export function mergeLog(log, { references = [], trades = [], intervalsByMint = new Map(), keepFromMs = null } = {}) {
    const refs = new Map();
    for (const ref of [...(log?.references ?? []), ...references]) {
        if (!stringOrNull(ref?.mint) || !stringOrNull(ref?.fetchedAt)) continue;
        refs.set(refKey(ref), ref);
    }
    const keep = (iso) => keepFromMs === null || (parseMs(iso) ?? -Infinity) >= keepFromMs;
    const mergedRefs = [...refs.values()].filter((ref) => keep(ref.at))
        .sort((a, b) => (a.at === b.at ? (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0) : a.at < b.at ? -1 : 1));

    const rawTrades = new Map();
    for (const old of log?.trades ?? []) {
        if (stringOrNull(old?.sig)) rawTrades.set(old.sig, { sig: old.sig, time: old.t, mint: old.mint, priceUsd: old.priceUsd });
    }
    for (const trade of Array.isArray(trades) ? trades : []) {
        if (stringOrNull(trade?.sig)) rawTrades.set(trade.sig, trade);
    }
    const { records, skipped } = pairTrades([...rawTrades.values()], mergedRefs, intervalsByMint);
    const mergedTrades = records.filter((row) => keep(row.t))
        .sort((a, b) => (a.t === b.t ? (a.sig < b.sig ? -1 : 1) : a.t < b.t ? -1 : 1));
    return { log: { version: 1, references: mergedRefs, trades: mergedTrades }, skipped };
}

// --- points -----------------------------------------------------------------------------------

/**
 * Daily-snapshot premia per mint: `{mint, t, date, premiumPct}`. A value identical to the same
 * mint's previous snapshot is the same reference fetch copied forward (a snapshot taken without a
 * fresh price run), so it is dropped and counted in `repeated` instead of drawn twice.
 */
export function snapshotPoints(historyDocs) {
    const docs = (Array.isArray(historyDocs) ? historyDocs : [])
        .filter((doc) => /^\d{4}-\d{2}-\d{2}$/.test(doc?.date ?? ''))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const last = new Map();
    const points = [];
    let repeated = 0;
    for (const doc of docs) {
        const t = stringOrNull(doc.builtAt);
        if (t === null || parseMs(t) === null) continue;
        for (const item of Array.isArray(doc.items) ? doc.items : []) {
            const mint = stringOrNull(item?.mint);
            const premium = finiteOrNull(item?.premiumPct);
            if (mint === null || premium === null) continue;
            const previous = last.get(mint);
            if (previous !== undefined && Math.abs(previous - premium) < SAME_PREMIUM_EPS) {
                repeated += 1;
                continue;
            }
            last.set(mint, premium);
            points.push({ mint, t, date: doc.date, premiumPct: premium });
        }
    }
    return { points, repeated };
}

/**
 * Drop snapshot points that are a logged quote under another name: same mint, same premium, and
 * built within SNAPSHOT_QUOTE_MATCH_MS of that quote's fetch.
 */
export function dropSnapshotsCoveredByQuotes(snapshots, references) {
    const quotes = new Map();
    for (const ref of references ?? []) {
        if (finiteOrNull(ref?.premiumPct) === null) continue;
        if (!quotes.has(ref.mint)) quotes.set(ref.mint, []);
        quotes.get(ref.mint).push({ ms: parseMs(ref.fetchedAt), premium: ref.premiumPct });
    }
    let covered = 0;
    const kept = (snapshots ?? []).filter((point) => {
        const ms = parseMs(point.t);
        const match = (quotes.get(point.mint) ?? []).some((q) => Number.isFinite(q.ms) && Math.abs(q.ms - ms) <= SNAPSHOT_QUOTE_MATCH_MS
            && Math.abs(q.premium - point.premiumPct) < SAME_PREMIUM_EPS);
        if (match) covered += 1;
        return !match;
    });
    return { points: kept, covered };
}

/**
 * Hourly trade points: the log's paired trades grouped by (mint, UTC hour, market session), each
 * group one point at the median premium with its trade count, spread and reference sources. A
 * group never straddles the open/close bell, so a point is either an open- or a closed-market one.
 */
export function hourlyTradePoints(tradeRecords, schedulesByMint) {
    const groups = new Map();
    for (const row of Array.isArray(tradeRecords) ? tradeRecords : []) {
        const ms = parseMs(row?.t);
        const premium = finiteOrNull(row?.premiumPct);
        if (ms === null || premium === null) continue;
        const session = sessionAt(schedulesByMint?.get(row.mint) ?? null, ms);
        const hour = Math.floor(ms / HOUR_MS) * HOUR_MS;
        const key = `${row.mint}|${hour}|${session}`;
        let g = groups.get(key);
        if (g === undefined) {
            g = { mint: row.mint, hour, session, premia: [], times: [], sources: new Set(), bases: new Set(), refAts: new Set() };
            groups.set(key, g);
        }
        g.premia.push(premium);
        g.times.push(ms);
        if (row.refSource) g.sources.add(row.refSource);
        if (row.basis) g.bases.add(row.basis);
        if (row.refAt) g.refAts.add(row.refAt);
    }
    return [...groups.values()].map((g) => ({
        mint: g.mint,
        t: isoOrNull(median(g.times)),
        hourStart: isoOrNull(g.hour),
        session: g.session,
        n: g.premia.length,
        premiumPct: median(g.premia),
        minPct: Math.min(...g.premia),
        maxPct: Math.max(...g.premia),
        sources: [...g.sources].sort(),
        bases: [...g.bases].sort(),
        refAts: [...g.refAts].sort()
    })).sort((a, b) => (a.t === b.t ? (a.mint < b.mint ? -1 : 1) : a.t < b.t ? -1 : 1));
}

function round(value, digits = 4) {
    if (!Number.isFinite(value)) return null;
    const f = 10 ** digits;
    return Math.round(value * f) / f;
}

/**
 * The premium section of stocks-tracking.json: one entry per underlying ticker that has at least
 * one wrapper with at least one point, wrappers listed even when they have no points (so "never
 * observed" is visible), closed stretches per schedule over the observed window.
 */
export function buildPremiumSection({ tokens, referenceDoc, log, snapshots, nowMs }) {
    const refByMint = new Map();
    for (const item of Array.isArray(referenceDoc?.items) ? referenceDoc.items : []) {
        if (stringOrNull(item?.mint)) refByMint.set(item.mint, item);
    }
    const scheduleTextByMint = new Map();
    const schedulesByMint = new Map();
    for (const [mint, item] of refByMint) {
        const parsed = parseSchedule(item.schedule);
        if (parsed !== null) {
            scheduleTextByMint.set(mint, item.schedule);
            schedulesByMint.set(mint, parsed);
        }
    }

    const quotePoints = (log?.references ?? []).filter((ref) => finiteOrNull(ref.premiumPct) !== null);
    const { points: snapshotKept, covered } = dropSnapshotsCoveredByQuotes(snapshots?.points ?? [], log?.references ?? []);
    const tradePoints = hourlyTradePoints(log?.trades ?? [], schedulesByMint);

    const byTicker = new Map();
    for (const token of Array.isArray(tokens) ? tokens : []) {
        const ticker = stringOrNull(token?.underlyingTicker);
        const mint = stringOrNull(token?.mint);
        if (ticker === null || mint === null) continue;
        if (!byTicker.has(ticker)) byTicker.set(ticker, []);
        byTicker.get(ticker).push(token);
    }

    const allMs = [];
    const pointsByMint = new Map();
    const push = (mint, point) => {
        if (!pointsByMint.has(mint)) pointsByMint.set(mint, []);
        pointsByMint.get(mint).push(point);
        allMs.push(parseMs(point.t));
    };
    for (const q of quotePoints) {
        push(q.mint, { kind: 'quote', t: q.at, p: round(q.premiumPct), n: 1, src: q.source, price: q.jupiterPrice, ref: q.refPrice, atBasis: q.atBasis });
    }
    for (const s of snapshotKept) {
        push(s.mint, { kind: 'snapshot', t: s.t, p: round(s.premiumPct), n: 1, src: null, date: s.date });
    }
    for (const tp of tradePoints) {
        push(tp.mint, { kind: 'trades', t: tp.t, p: round(tp.premiumPct), n: tp.n, src: tp.sources.length === 1 ? tp.sources[0] : (tp.sources.length ? tp.sources.join('+') : null), lo: round(tp.minPct), hi: round(tp.maxPct), hour: tp.hourStart, basis: tp.bases.join('+'), refAt: tp.refAts });
    }
    const finiteMs = allMs.filter(Number.isFinite);
    const fromMs = finiteMs.length ? Math.min(...finiteMs) : null;
    const toMs = Number.isFinite(nowMs) ? nowMs : (finiteMs.length ? Math.max(...finiteMs) : null);

    const scheduleIds = new Map();
    const schedules = [];
    const scheduleIdFor = (text) => {
        if (text === null || text === undefined) return null;
        if (!scheduleIds.has(text)) {
            const parsed = parseSchedule(text);
            const intervals = fromMs === null ? null : closedIntervals(parsed, fromMs, toMs);
            scheduleIds.set(text, schedules.length);
            schedules.push({
                text,
                timezone: parsed?.timezone ?? null,
                closed: intervals === null ? null : intervals.map((iv) => [isoOrNull(iv.from), isoOrNull(iv.to), iv.holiday ? 1 : 0])
            });
        }
        return scheduleIds.get(text);
    };

    const underlyings = [];
    for (const [ticker, wrappers] of byTicker) {
        const rows = wrappers.map((token) => {
            const points = (pointsByMint.get(token.mint) ?? []).map((point) => ({
                ...point,
                session: sessionAt(schedulesByMint.get(token.mint) ?? null, parseMs(point.t))
            })).sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
            const ref = refByMint.get(token.mint) ?? null;
            return {
                mint: token.mint,
                symbol: stringOrNull(token.symbol),
                issuer: stringOrNull(token.issuer),
                cardSlug: stringOrNull(token.cardSlug),
                refSource: stringOrNull(ref?.refSource),
                scheduleText: scheduleTextByMint.get(token.mint) ?? null,
                points
            };
        }).sort((a, b) => b.points.length - a.points.length || String(a.symbol).localeCompare(String(b.symbol)));
        const observed = rows.reduce((sum, row) => sum + row.points.length, 0);
        if (observed === 0) continue;
        const scheduleText = rows.find((row) => row.scheduleText !== null)?.scheduleText ?? null;
        underlyings.push({
            ticker,
            schedule: scheduleIdFor(scheduleText),
            observations: observed,
            wrappers: rows.map(({ scheduleText: _s, ...rest }) => rest)
        });
    }
    underlyings.sort((a, b) => b.observations - a.observations || a.ticker.localeCompare(b.ticker));

    return {
        window: { from: isoOrNull(fromMs), to: isoOrNull(toMs) },
        counts: {
            underlyings: underlyings.length,
            quotePoints: quotePoints.length,
            snapshotPoints: snapshotKept.length,
            snapshotRepeatsDropped: snapshots?.repeated ?? 0,
            snapshotsCoveredByQuotes: covered,
            tradePoints: tradePoints.length,
            pairedTrades: (log?.trades ?? []).length
        },
        schedules,
        underlyings
    };
}

// --- concentration vs liquidity ------------------------------------------------------------------

/** Σ DexScreener pool liquidity for one venues item, or null when no pool states a finite one. */
export function dexPoolLiquidity(venueItem) {
    const values = (Array.isArray(venueItem?.dex) ? venueItem.dex : [])
        .map((pair) => finiteOrNull(pair?.liquidityUsd))
        .filter((value) => value !== null);
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
}

/**
 * One scatter row per token with both a positive liquidity and a top-1 unlabelled share; every
 * other token is listed in `notPlotted` with what it lacks — never placed at zero. Liquidity is the
 * Jupiter token-market figure when present, else the sum of DexScreener pools; `liquiditySource`
 * says which. A liquidity of 0 is not plottable on a log axis and is reported as such, not dropped.
 */
export function buildConcentrationSection({ tokens, holdersDoc, venuesDoc, universeFetchedAt = null, corner = CORNER }) {
    const holdersByMint = new Map();
    for (const item of Array.isArray(holdersDoc?.items) ? holdersDoc.items : []) {
        if (stringOrNull(item?.mint)) holdersByMint.set(item.mint, item);
    }
    const venuesByMint = new Map();
    for (const item of Array.isArray(venuesDoc?.items) ? venuesDoc.items : []) {
        if (stringOrNull(item?.mint)) venuesByMint.set(item.mint, item);
    }
    const plotted = [];
    const notPlotted = [];
    for (const token of Array.isArray(tokens) ? tokens : []) {
        const mint = stringOrNull(token?.mint);
        if (mint === null) continue;
        const jupiterLiquidity = finiteOrNull(token?.market?.liquidity);
        const venue = venuesByMint.get(mint) ?? null;
        const dexLiquidity = dexPoolLiquidity(venue);
        let liquidityUsd = null;
        let liquiditySource = null;
        let liquidityAt = null;
        if (jupiterLiquidity !== null) {
            liquidityUsd = jupiterLiquidity;
            liquiditySource = 'jupiter';
            liquidityAt = universeFetchedAt;
        } else if (dexLiquidity !== null) {
            liquidityUsd = dexLiquidity;
            liquiditySource = 'dexscreener';
            liquidityAt = stringOrNull(venue?.dexFetchedAt);
        }
        const holders = holdersByMint.get(mint) ?? null;
        const top1 = holders === null ? null : topSharePctExcludingLabels(holders.top20, 1);
        const base = {
            mint,
            symbol: stringOrNull(token.symbol),
            issuer: stringOrNull(token.issuer),
            cardSlug: stringOrNull(token.cardSlug)
        };
        const missing = [];
        if (liquidityUsd === null) missing.push('liquidity');
        else if (liquidityUsd <= 0) missing.push('zero-liquidity');
        if (top1 === null) missing.push('holders');
        if (missing.length) {
            notPlotted.push({ ...base, missing });
            continue;
        }
        const top1Raw = finiteOrNull(holders.top1SharePct);
        // What was set aside to reach the first unlabelled wallet: issuer authorities, burn address.
        const labelled = dedupeOwners(holders.top20).filter((row) => row.ownerLabel !== null);
        const excludedLabels = [...new Set(labelled.map((row) => row.ownerLabel))].sort();
        const excludedSharePct = labelled.length ? labelled.reduce((sum, row) => sum + (row.sharePct ?? 0), 0) : null;
        plotted.push({
            ...base,
            liquidityUsd: round(liquidityUsd, 2),
            liquiditySource,
            liquidityAt,
            top1SharePct: round(top1, 4),
            top1SharePctRaw: round(top1Raw, 4),
            excludedLabels,
            excludedSharePct: round(excludedSharePct, 4),
            holderCount: finiteOrNull(token?.market?.holderCount),
            corner: top1 >= corner.minTop1SharePct && liquidityUsd <= corner.maxLiquidityUsd
        });
    }
    plotted.sort((a, b) => a.mint < b.mint ? -1 : 1);
    notPlotted.sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)) || (a.mint < b.mint ? -1 : 1));
    const countMissing = (tag) => notPlotted.filter((row) => row.missing.includes(tag)).length;
    return {
        corner,
        holdersFetchedAt: stringOrNull(holdersDoc?.fetchedAt),
        venuesFetchedAt: stringOrNull(venuesDoc?.fetchedAt),
        universeFetchedAt,
        counts: {
            tokens: plotted.length + notPlotted.length,
            plotted: plotted.length,
            inCorner: plotted.filter((row) => row.corner).length,
            notPlotted: notPlotted.length,
            missingLiquidity: countMissing('liquidity'),
            zeroLiquidity: countMissing('zero-liquidity'),
            missingHolders: countMissing('holders'),
            liquidityFromJupiter: plotted.filter((row) => row.liquiditySource === 'jupiter').length,
            liquidityFromDexScreener: plotted.filter((row) => row.liquiditySource === 'dexscreener').length
        },
        plotted,
        notPlotted
    };
}
