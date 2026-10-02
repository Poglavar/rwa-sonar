// PURE: the Monday gap in a lender's collateral price. Given one Kamino reserve's hourly price
// series (the keyless reserve-history API's `assetOraclePriceUSD`) and the US equity schedule, find
// every weekend closed stretch and compare the price the lender held after Friday's close with the
// price it used at its first reading after the market reopened. No I/O and no clock (tested in
// ../lender-gaps.test.js); stocks/fetch-lender-price-history.mjs does the fetching and storing.
//
// Why the SECOND closed reading is "Friday's close": the hourly sample stamped at the close hour
// still carries the last intraday update (NVDAx 222.46 at 20:00 UTC on 2026-09-18), and the settled
// close appears one reading later (222.3476 at 21:00 UTC, held until Monday 13:00 UTC). This is the
// research note's "Friday 21:00 to Monday 14:00 UTC" comparison, generalised to any DST offset and
// to a holiday Monday.

import { sessionAt } from './market-hours.mjs';

const HOUR_MS = 60 * 60 * 1000;
/** Readings further apart than this around a boundary make that weekend unmeasurable, not guessed. */
export const MAX_READING_GAP_MS = 2 * HOUR_MS;
/** Weekends kept in the store, newest first. */
export const KEEP_WEEKENDS = 26;

function positive(value) {
    const n = typeof value === 'string' ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

function isoOf(ms) {
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * `[{t: ms, price}]` from the API's `history[]`, oldest first, keeping only readings with a real
 * positive price. A missing or zero price is a hole in the series, never a price of 0.
 */
export function seriesFromHistory(history) {
    const out = [];
    for (const row of Array.isArray(history) ? history : []) {
        const t = Date.parse(row?.timestamp);
        const price = positive(row?.metrics?.assetOraclePriceUSD);
        if (!Number.isFinite(t) || price === null) continue;
        out.push({ t, price });
    }
    return out.sort((a, b) => a.t - b.t);
}

/** Whether any hour of [fromMs, toMs] is a UTC Saturday — true for every weekend, never for a weeknight. */
function spansSaturday(fromMs, toMs) {
    for (let t = fromMs; t <= toMs; t += HOUR_MS) if (new Date(t).getUTCDay() === 6) return true;
    return false;
}

/**
 * One row per weekend the series fully covers: the closed stretch (every reading not in the open
 * session) must be preceded and followed by open readings, contain a UTC Saturday, and have no
 * reading gap over MAX_READING_GAP_MS at either boundary. `movedWhileClosedPct` is the largest
 * distance of any closed reading from the close value: 0 for a lender frozen at the close, and
 * non-zero for one that follows extended hours (GLXY) or broke its freeze.
 */
export function weekendGaps(series, schedule) {
    const points = Array.isArray(series) ? series : [];
    const rows = [];
    let i = 0;
    while (i < points.length) {
        if (sessionAt(schedule, points[i].t) === 'open') {
            i += 1;
            continue;
        }
        const start = i;
        while (i < points.length && sessionAt(schedule, points[i].t) !== 'open') i += 1;
        const end = i - 1; // last closed reading
        const before = start - 1;
        const after = i; // first open reading after the stretch, if any
        if (before < 0 || after >= points.length) continue;
        if (sessionAt(schedule, points[start].t) === 'unknown') continue;
        const closed = points.slice(start, end + 1);
        if (!spansSaturday(points[start].t, points[end].t)) continue;
        if (points[start].t - points[before].t > MAX_READING_GAP_MS || points[after].t - points[end].t > MAX_READING_GAP_MS) continue;
        const closeReading = closed.length > 1 ? closed[1] : closed[0];
        const reopen = points[after];
        let moved = 0;
        for (const reading of closed.slice(closed.indexOf(closeReading))) {
            moved = Math.max(moved, Math.abs(reading.price / closeReading.price - 1) * 100);
        }
        rows.push({
            closeAt: isoOf(closeReading.t),
            closeValue: closeReading.price,
            heldValue: closed.at(-1).price,
            reopenAt: isoOf(reopen.t),
            reopenValue: reopen.price,
            gapPct: (reopen.price / closeReading.price - 1) * 100,
            movedWhileClosedPct: moved
        });
    }
    return rows;
}

/**
 * The stored weekends plus this run's, one row per market, mint and reopening (this run's reading
 * wins: the API's newest answer for the same hours), newest first, KEEP_WEEKENDS per market and mint.
 */
export function mergeWeekends(previous, next) {
    const byKey = new Map();
    for (const row of [...(Array.isArray(previous) ? previous : []), ...(Array.isArray(next) ? next : [])]) {
        if (typeof row?.marketId !== 'string' || typeof row?.mint !== 'string' || typeof row?.reopenAt !== 'string') continue;
        byKey.set(`${row.marketId}|${row.mint}|${row.reopenAt}`, row);
    }
    const groups = new Map();
    for (const row of byKey.values()) {
        const key = `${row.marketId}|${row.mint}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }
    const out = [];
    for (const rows of groups.values()) {
        rows.sort((a, b) => (a.reopenAt < b.reopenAt ? 1 : -1));
        out.push(...rows.slice(0, KEEP_WEEKENDS));
    }
    return out.sort((a, b) => (a.marketId === b.marketId ? (a.mint === b.mint ? (a.reopenAt < b.reopenAt ? 1 : -1) : a.mint < b.mint ? -1 : 1) : a.marketId < b.marketId ? -1 : 1));
}

/**
 * Where the next fetch starts for one reserve: a week before its newest stored reopening (so the
 * weekend just gone is re-read whole), else `maxDays` back from `nowMs`; never earlier than that.
 */
export function fetchStartMs(weekends, marketId, mint, nowMs, maxDays = 35) {
    const floor = nowMs - maxDays * 24 * HOUR_MS;
    const newest = (Array.isArray(weekends) ? weekends : [])
        .filter((row) => row?.marketId === marketId && row?.mint === mint)
        .map((row) => Date.parse(row.reopenAt))
        .filter(Number.isFinite)
        .sort((a, b) => b - a)[0];
    if (newest === undefined) return floor;
    return Math.max(floor, newest - 8 * 24 * HOUR_MS);
}

/** The Kamino reserves to read: every collateral entry of a Kamino oraclePricing market. */
export function kaminoReserves(oraclePricing) {
    const out = [];
    for (const market of Array.isArray(oraclePricing?.markets) ? oraclePricing.markets : []) {
        if (market?.protocolId !== 'kamino' || typeof market.marketAddress !== 'string') continue;
        for (const c of Array.isArray(market.collateral) ? market.collateral : []) {
            if (typeof c?.reserve !== 'string' || typeof c?.mint !== 'string') continue;
            out.push({ marketId: String(market.id).replace(/:oracle$/, ''), marketAddress: market.marketAddress, reserve: c.reserve, mint: c.mint, symbol: c.symbol ?? null });
        }
    }
    return out;
}

/** The keyless reserve-history URL (hourly) for one reserve and window. */
export function historyUrl({ marketAddress, reserve }, startMs, endMs) {
    const iso = (ms) => new Date(ms).toISOString();
    return `https://api.kamino.finance/kamino-market/${marketAddress}/reserves/${reserve}/metrics/history`
        + `?env=mainnet-beta&start=${iso(startMs)}&end=${iso(endMs)}&frequency=hour`;
}
