// Tests for the pure half of tracking.js (tracking.html): underlying selection from ?u=, the
// premium chart geometry and markup (points, never lines; closed bands only when hours are known),
// the tapped-point detail, and the scatter (log x, the corner, card links, not-plotted counts).
const T = require('./tracking.js');

const underlying = {
    ticker: 'NVDA',
    schedule: 0,
    observations: 3,
    wrappers: [
        { mint: 'M1', symbol: 'NVDAx', issuer: 'xstocks-backed', cardSlug: 'NVDAx', refSource: 'ondo-implied', points: [
            { kind: 'trades', t: '2026-09-23T21:30:00Z', p: 0.5, n: 10, src: 'ondo-implied', lo: -0.1, hi: 0.9, hour: '2026-09-23T21:00:00Z', basis: 'same-closed-session', refAt: ['2026-09-23T22:19:53Z'], session: 'closed' },
            { kind: 'quote', t: '2026-09-23T22:19:53Z', p: 1.35, n: 1, src: 'ondo-implied', price: 228.5, ref: 225.5, atBasis: 'fetched-at', session: 'closed' }
        ] },
        { mint: 'M2', symbol: 'NVDA/on', issuer: 'ondo-global-markets', cardSlug: 'NVDA-on', refSource: null, points: [
            { kind: 'snapshot', t: '2026-09-22T18:00:00Z', p: -2, n: 1, src: null, date: '2026-09-22', session: 'open' }
        ] },
        { mint: 'M3', symbol: 'NVDAz', issuer: 'bullish', cardSlug: 'NVDAz', refSource: null, points: [] }
    ]
};
const schedule = { closed: [['2026-09-22T20:00:00Z', '2026-09-23T13:30:00Z', 0], ['2026-09-23T20:00:00Z', '2026-09-24T00:00:00Z', 1]] };

describe('pickUnderlying', () => {
    const list = [{ ticker: 'SPCX' }, { ticker: 'NVDA' }];
    test('deep link wins, case-insensitive', () => {
        expect(T.pickUnderlying(list, '?u=spcx')).toEqual({ asked: 'SPCX', found: true, ticker: 'SPCX' });
    });
    test('unknown ticker falls back to NVDA and says it was not found', () => {
        expect(T.pickUnderlying(list, '?u=ZZZ')).toEqual({ asked: 'ZZZ', found: false, ticker: 'NVDA' });
    });
    test('no NVDA: first listed', () => {
        expect(T.pickUnderlying([{ ticker: 'SPCX' }], '').ticker).toBe('SPCX');
    });
});

describe('premium chart', () => {
    const model = T.premiumModel(underlying, schedule, '2026-09-24T00:00:00Z');

    test('the y domain contains zero and every point; x starts at the first day', () => {
        expect(model.y0).toBeLessThan(-2);
        expect(model.y1).toBeGreaterThan(1.35);
        expect(new Date(model.x0).toISOString()).toBe('2026-09-22T00:00:00.000Z');
        expect(model.points).toHaveLength(3);
        const q = model.points.find((p) => p.kind === 'quote');
        const s = model.points.find((p) => p.kind === 'snapshot');
        expect(q.cy).toBeLessThan(model.zeroY);
        expect(s.cy).toBeGreaterThan(model.zeroY);
        expect(q.cx).toBeGreaterThan(s.cx);
    });

    test('marks are points by kind, never a connecting line; holiday bands are distinct', () => {
        const svg = T.renderPremiumSvg(model);
        expect(svg).not.toMatch(/<polyline|class="trk-line/);
        expect(svg.match(/class="trk-pt /g)).toHaveLength(3);
        expect(svg).toMatch(/trk-kind-quote[^>]*>.*?<rect/);
        expect(svg).toMatch(/trk-kind-snapshot[^>]*>.*?<path/);
        expect(svg.match(/class="trk-band"/g)).toHaveLength(1);
        expect(svg.match(/trk-band-holiday/g)).toHaveLength(1);
    });

    test('the phone layout uses a narrower viewBox so text is not shrunk to illegibility', () => {
        const svg = T.renderPremiumSvg(T.premiumModel(underlying, schedule, '2026-09-24T00:00:00Z', true));
        expect(svg).toMatch(/viewBox="0 0 380 280"/);
        expect(T.renderScatterSvg(T.scatterModel({ plotted: [{ mint: 'A', liquidityUsd: 10, top1SharePct: 5 }] }, true), {})).toMatch(/viewBox="0 0 380 400"/);
    });

    test('unknown market hours draw no band at all', () => {
        const m = T.premiumModel(underlying, { closed: null }, '2026-09-24T00:00:00Z');
        expect(m.hoursKnown).toBe(false);
        expect(T.renderPremiumSvg(m)).not.toMatch(/<rect class="trk-band/);
    });

    test('an underlying with no observation renders a message, not an empty axis', () => {
        expect(T.premiumModel({ wrappers: [{ points: [] }] }, schedule, null)).toBeNull();
        expect(T.renderPremiumSvg(null)).toMatch(/No premium observation/);
    });

    test('legend counts per kind and shows a wrapper never observed', () => {
        const html = T.legendHtml(underlying, { 'xstocks-backed': 'Kraken xStocks' });
        expect(html).toMatch(/2 points: 1 trade-hour \(10 trades\), 1 quote, 0 snapshots/);
        expect(html).toMatch(/Kraken xStocks/);
        expect(html).toMatch(/NVDAz<\/a><\/strong>.*no observation/);
        expect(html).toMatch(/href="\.\/cards\/NVDA-on\.html"/);
    });

    test('point detail names the reference source, the pairing basis and the trade count', () => {
        const trades = T.pointDetailHtml(underlying.wrappers[0], underlying.wrappers[0].points[0]);
        expect(trades).toMatch(/10 trades, range −0\.10% to \+0\.90%/);
        expect(trades).toMatch(/issuer-implied/);
        expect(trades).toMatch(/same closed session/);
        const snap = T.pointDetailHtml(underlying.wrappers[1], underlying.wrappers[1].points[0]);
        expect(snap).toMatch(/not recorded in the daily snapshot/);
        expect(snap).toMatch(/−2\.00%/);
    });

    test('table lists every observation newest first', () => {
        const html = T.tableHtml(underlying);
        const rows = html.match(/<tr><td>[^<]+/g).map((r) => r.slice(8));
        expect(rows).toEqual(['2026-09-23 22:19 UTC', '2026-09-23 21:30 UTC', '2026-09-22 18:00 UTC']);
    });
});

describe('concentration scatter', () => {
    const concentration = {
        corner: { minTop1SharePct: 50, maxLiquidityUsd: 10000 },
        counts: { plotted: 3 },
        plotted: [
            { mint: 'A', symbol: 'AAAx', issuer: 'xstocks-backed', cardSlug: 'AAAx', liquidityUsd: 2000000, top1SharePct: 20, holderCount: 90000, liquiditySource: 'jupiter', corner: false },
            { mint: 'B', symbol: 'BBBon', issuer: 'ondo-global-markets', cardSlug: 'BBBon', liquidityUsd: 100, top1SharePct: 90, holderCount: null, liquiditySource: 'jupiter', corner: true },
            { mint: 'C', symbol: 'CCC', issuer: 'tessera', cardSlug: 'CCC', liquidityUsd: 5000, top1SharePct: 30, holderCount: 3, liquiditySource: 'dexscreener', corner: false }
        ],
        notPlotted: [
            { mint: 'D', symbol: 'DDD', missing: ['liquidity'] },
            { mint: 'E', symbol: 'EEE', missing: ['holders'] },
            { mint: 'F', symbol: 'FFF', missing: ['zero-liquidity', 'holders'] }
        ]
    };

    test('log x axis: each decade is equally wide, the corner ends at $10k', () => {
        const m = T.scatterModel(concentration);
        const dx = m.xTicks.map((t, i, a) => (i ? t.x - a[i - 1].x : null)).slice(1);
        expect(new Set(dx.map((d) => d.toFixed(3))).size).toBe(1);
        const tenK = m.xTicks.find((t) => t.v === 10000);
        expect(m.corner.x + m.corner.w).toBeCloseTo(tenK.x, 6);
        const b = m.dots.find((d) => d.mint === 'B');
        expect(b.cy).toBeLessThan(m.corner.y + m.corner.h);
    });

    test('dots link to the collision-aware card; unknown holders is a hollow ring; minor issuers fold to other', () => {
        const svg = T.renderScatterSvg(T.scatterModel(concentration), {});
        expect(svg).toMatch(/<a href="\.\/cards\/BBBon\.html"/);
        expect(svg).toMatch(/trk-dot trk-i2 trk-dot-nocount trk-dot-corner/);
        expect(svg).toMatch(/trk-dot trk-iother/);
        expect(svg.match(/<a /g)).toHaveLength(3);
    });

    test('the y-axis title sits above the plot, and the last x tick keeps room at the right edge', () => {
        for (const compact of [false, true]) {
            const m = T.scatterModel(concentration, compact);
            const svg = T.renderScatterSvg(m, {});
            const titleY = Number(/<text class="trk-axis-title" x="[\d.]+" y="([\d.]+)">↑ top unlabelled wallet/.exec(svg)[1]);
            expect(titleY).toBeLessThan(m.dims.ST - 8);
            // A "$10M" label is ~28 px at 11 px: half of it must fit right of the last tick.
            expect(m.dims.SW - m.xTicks[m.xTicks.length - 1].x).toBeGreaterThanOrEqual(14);
        }
    });

    test('radius grows with holder count and is null when unknown (never zero)', () => {
        expect(T.radiusFor(null)).toBeNull();
        expect(T.radiusFor(90000)).toBeGreaterThan(T.radiusFor(3));
    });

    test('not-plotted counts partition the missing tokens', () => {
        const s = T.notPlottedSummary(concentration);
        expect(s.text).toBe('Not plotted: 3 (missing liquidity: 1, missing holders: 1, missing both: 1)');
    });

    test('nothing plottable renders a message', () => {
        expect(T.scatterModel({ plotted: [] })).toBeNull();
    });
});

describe('formatting', () => {
    test('signed percentages and null', () => {
        expect(T.fmtSignedPct(1.234)).toBe('+1.23%');
        expect(T.fmtSignedPct(-0.5)).toBe('−0.50%');
        expect(T.fmtSignedPct(null)).toBe('—');
        expect(T.sourceLabel('pyth')).toMatch(/Pyth/);
    });
});
