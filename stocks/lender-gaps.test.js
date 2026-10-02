// Unit tests for lib/lender-gaps.mjs: the Monday gap in a Kamino reserve's collateral price. The
// NVDAx numbers are the real hourly `assetOraclePriceUSD` readings around the weekend of
// 2026-09-18/21 (Kamino reserve history, read 2026-09-24): 222.4628 at the Friday 20:00 UTC reading,
// 222.3476 from 21:00 UTC until Monday 13:00 UTC, 224.5664 at 14:00 UTC. The schedule is the
// verbatim US equity schedule from the keyless Hermes feed list, holidays included.

const {
    MAX_READING_GAP_MS, KEEP_WEEKENDS, seriesFromHistory, weekendGaps, mergeWeekends, fetchStartMs, kaminoReserves, historyUrl
} = require('./lib/lender-gaps.mjs');
const { parseSchedule } = require('./lib/market-hours.mjs');
const fs = require('fs');
const path = require('path');

const US = parseSchedule('America/New_York;0930-1600,0930-1600,0930-1600,0930-1600,0930-1600,C,C;0907/C,1126/C,1127/0930-1300,1224/0930-1300,1225/C,0101/C,0118/C,0215/C,0326/C,0531/C,0618/C,0705/C');
const HOUR = 3600 * 1000;

/** Hourly readings from `from` to `to` (inclusive), priced by `priceAt(ms)`. */
function hourly(from, to, priceAt) {
    const out = [];
    for (let t = Date.parse(from); t <= Date.parse(to); t += HOUR) out.push({ t, price: priceAt(t) });
    return out;
}

const FRI_CLOSE_READING = Date.parse('2026-09-18T20:00:00Z');
const MON_OPEN_READING = Date.parse('2026-09-21T14:00:00Z');
function nvdax(t) {
    if (t < FRI_CLOSE_READING) return 219.9085;
    if (t === FRI_CLOSE_READING) return 222.462810291566519;
    if (t < MON_OPEN_READING) return 222.347614653934396;
    return 224.566382804848775;
}

describe('seriesFromHistory', () => {
    test('keeps readings with a real positive price, oldest first; a missing price is a hole, not 0', () => {
        const series = seriesFromHistory([
            { timestamp: '2026-09-21T14:00:00.000Z', metrics: { assetOraclePriceUSD: '224.566382804848775' } },
            { timestamp: '2026-09-21T13:00:00.000Z', metrics: { assetOraclePriceUSD: '222.347614653934396' } },
            { timestamp: '2026-09-21T12:00:00.000Z', metrics: { assetOraclePriceUSD: null } },
            { timestamp: '2026-09-21T11:00:00.000Z', metrics: { assetOraclePriceUSD: '0' } },
            { timestamp: 'garbage', metrics: { assetOraclePriceUSD: '1' } }
        ]);
        expect(series.map((p) => new Date(p.t).toISOString())).toEqual(['2026-09-21T13:00:00.000Z', '2026-09-21T14:00:00.000Z']);
        expect(series[1].price).toBeCloseTo(224.566382804848775, 9);
        expect(seriesFromHistory(null)).toEqual([]);
    });
});

describe('weekendGaps', () => {
    test('NVDAx 2026-09-21: Friday close 222.3476 (second closed reading) → Monday 14:00 UTC 224.5664 = +1.00 %', () => {
        const rows = weekendGaps(hourly('2026-09-18T12:00:00Z', '2026-09-22T18:00:00Z', nvdax), US);
        expect(rows).toHaveLength(1);
        const [row] = rows;
        expect(row.closeAt).toBe('2026-09-18T21:00:00Z');
        expect(row.closeValue).toBeCloseTo(222.3476, 4);
        expect(row.heldValue).toBeCloseTo(222.3476, 4);
        expect(row.reopenAt).toBe('2026-09-21T14:00:00Z');
        expect(row.gapPct).toBeCloseTo(0.9979, 3);
        expect(row.movedWhileClosedPct).toBe(0);
    });

    test('weeknight stretches are not weekends', () => {
        const rows = weekendGaps(hourly('2026-09-22T12:00:00Z', '2026-09-24T18:00:00Z', () => 100), US);
        expect(rows).toEqual([]);
    });

    test('a holiday Monday (Labor Day, 0907/C) reopens on Tuesday', () => {
        const reopen = Date.parse('2026-09-08T14:00:00Z');
        const rows = weekendGaps(hourly('2026-09-04T12:00:00Z', '2026-09-08T18:00:00Z', (t) => (t < reopen ? 100 : 104)), US);
        expect(rows).toHaveLength(1);
        expect(rows[0].reopenAt).toBe('2026-09-08T14:00:00Z');
        expect(rows[0].gapPct).toBeCloseTo(4, 9);
    });

    test('a hole in the readings around the reopening makes that weekend unmeasurable, not guessed', () => {
        const series = hourly('2026-09-18T12:00:00Z', '2026-09-22T18:00:00Z', nvdax)
            .filter((p) => p.t <= Date.parse('2026-09-21T09:00:00Z') || p.t >= Date.parse('2026-09-21T16:00:00Z'));
        expect(MAX_READING_GAP_MS).toBe(2 * HOUR);
        expect(weekendGaps(series, US)).toEqual([]);
    });

    test('a price that follows extended hours shows how far it moved while "closed"', () => {
        const monPre = Date.parse('2026-09-21T08:00:00Z');
        const series = hourly('2026-09-18T12:00:00Z', '2026-09-21T16:00:00Z', (t) => (t < monPre ? 24.6 : t < MON_OPEN_READING ? 25.2 : 25.745));
        const [row] = weekendGaps(series, US);
        expect(row.closeValue).toBe(24.6);
        expect(row.heldValue).toBe(25.2);
        expect(row.gapPct).toBeCloseTo(4.654, 2);
        expect(row.movedWhileClosedPct).toBeCloseTo(2.439, 2);
    });

    test('a series that starts or ends inside a weekend yields no row for it', () => {
        expect(weekendGaps(hourly('2026-09-19T12:00:00Z', '2026-09-21T18:00:00Z', nvdax), US)).toEqual([]);
        expect(weekendGaps(hourly('2026-09-18T12:00:00Z', '2026-09-20T18:00:00Z', nvdax), US)).toEqual([]);
    });
});

describe('store', () => {
    const row = (reopenAt, gapPct, extra = {}) => ({ marketId: 'kamino:xstocks-pool', mint: 'M', reopenAt, gapPct, ...extra });

    test('mergeWeekends: one row per market, mint and reopening, this run wins, newest first, capped', () => {
        const merged = mergeWeekends([row('2026-09-14T14:00:00Z', 1), row('2026-09-21T14:00:00Z', 2)], [row('2026-09-21T14:00:00Z', 3)]);
        expect(merged.map((r) => [r.reopenAt, r.gapPct])).toEqual([['2026-09-21T14:00:00Z', 3], ['2026-09-14T14:00:00Z', 1]]);
        const many = Array.from({ length: KEEP_WEEKENDS + 5 }, (_, i) => row(new Date(Date.parse('2026-01-05T15:00:00Z') + i * 7 * 86400000).toISOString(), i));
        expect(mergeWeekends(many, [])).toHaveLength(KEEP_WEEKENDS);
        expect(mergeWeekends(null, [{ bad: true }])).toEqual([]);
    });

    test('fetchStartMs re-reads a week before the newest stored weekend, never past maxDays', () => {
        const now = Date.parse('2026-09-24T19:00:00Z');
        expect(fetchStartMs([], 'kamino:xstocks-pool', 'M', now)).toBe(now - 35 * 86400000);
        expect(fetchStartMs([row('2026-09-21T14:00:00Z', 1)], 'kamino:xstocks-pool', 'M', now)).toBe(Date.parse('2026-09-13T14:00:00Z'));
        expect(fetchStartMs([row('2026-01-05T14:00:00Z', 1)], 'kamino:xstocks-pool', 'M', now)).toBe(now - 35 * 86400000);
    });

    test('kaminoReserves reads every Kamino collateral reserve from the research, and the URL is the keyless history', () => {
        const research = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'protocol-market-research.json'), 'utf8'));
        const reserves = kaminoReserves(research.oraclePricing);
        expect(reserves).toHaveLength(16);
        const nvda = reserves.find((r) => r.marketId === 'kamino:xstocks-pool' && r.symbol === 'NVDAx');
        expect(nvda.reserve).toBe('7B66Az3tJhAo4bLkX8PzTixQ9ZGyHkkjxfVLhF26sP5q');
        expect(historyUrl(nvda, Date.parse('2026-09-11T12:00:00Z'), Date.parse('2026-09-24T14:00:00Z'))).toBe(
            'https://api.kamino.finance/kamino-market/5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua/reserves/7B66Az3tJhAo4bLkX8PzTixQ9ZGyHkkjxfVLhF26sP5q/metrics/history?env=mainnet-beta&start=2026-09-11T12:00:00.000Z&end=2026-09-24T14:00:00.000Z&frequency=hour');
    });
});
