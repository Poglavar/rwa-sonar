// Unit tests for lib/closed-market-view.js: the wording the token cards and the monitor share for
// "When the market is closed". Inputs are in the exact shapes stocks-closed-market.json carries.

const V = require('./lib/closed-market-view.js');

describe('depth', () => {
    test('spells each threshold with its bound, dated by session', () => {
        const depth = {
            read: true,
            weekday: { at: '2026-09-24T19:37:07Z', at5Pct: { usd: 1016454, bound: 'interpolated' }, at10Pct: { usd: 2500000, bound: 'no-route' } },
            weekend: null
        };
        expect(V.depthText(depth)).toBe('5 % ≈ $1.02M · 10 % no route at $2.50M (weekday, 24 Sep); no weekend sample yet');
        expect(V.saleText({ usd: 1000, bound: 'below' })).toBe('< $1.0k');
        expect(V.depthText({ read: true, weekday: { at: '2026-09-24T19:55:49Z', noPrice: true }, weekend: null }))
            .toBe('no Solana price found by Jupiter (weekday, 24 Sep); no weekend sample yet');
        expect(V.saleText({ usd: 2500000, bound: 'above' })).toBe('> $2.50M');
        expect(V.saleText(null)).toBe('—');
    });

    test('never collected and not yet measured are different sentences, and neither is a zero', () => {
        expect(V.depthText({ read: false })).toBe('not collected');
        expect(V.depthText(null)).toBe('not collected');
        expect(V.depthText({ read: true, weekday: null, weekend: null })).toBe('not measured yet');
    });
});

describe('freezes and gaps', () => {
    test('lists the longest-running episodes with their cause and says how far the watcher read', () => {
        const freezes = {
            read: true, watched: true, shorter: 0,
            coverage: { readTo: '2026-09-24T18:39:33Z', checkedAt: '2026-09-24T18:53:00Z' },
            episodes: [
                { startedAt: '2026-09-24T08:39:40Z', ongoing: false, lowHours: 0.9, highHours: 0.9, cause: null },
                { startedAt: '2026-09-19T17:28:45Z', ongoing: false, lowHours: 44.2, highHours: 44.2, cause: 'scope-suspension' }
            ]
        };
        expect(V.freezeText(freezes, 'kamino')).toBe('0.9 h from 24 Sep, 44 h from 19 Sep (operator suspension); read to 24 Sep');
    });

    test('an ongoing stale price, a range of lengths, and the empty and unread cases', () => {
        expect(V.episodeText({ startedAt: '2026-08-26T15:54:46Z', ongoing: true, cause: 'stale-oracle-account' })).toBe('since 26 Aug, ongoing (price account not updated)');
        expect(V.episodeText({ startedAt: '2026-09-21T08:45:56Z', ongoing: false, lowHours: 2, highHours: 4.8, cause: null })).toBe('2.0 h–4.8 h from 21 Sep');
        expect(V.freezeText({ read: true, watched: true, episodes: [], coverage: { readTo: null, checkedAt: '2026-09-24T19:05:52Z' } }, 'loopscale')).toBe('none of 20 min or more; checked 24 Sep');
        expect(V.freezeText({ read: false, watched: true, episodes: [] }, 'kamino')).toBe('not collected');
        expect(V.freezeText({ read: true, watched: false, episodes: [] }, 'nest')).toMatch(/^not watched/);
        expect(V.freezeText({ read: true, watched: false, episodes: [] }, 'loopscale')).toBeNull();
    });

    test('Monday gaps, newest first as stored', () => {
        expect(V.gapsText({ read: true, weeks: [{ reopenAt: '2026-09-21T14:00:00Z', gapPct: 8.71 }, { reopenAt: '2026-09-14T14:00:00Z', gapPct: -1.26 }] }))
            .toBe('+8.71% (21 Sep), -1.26% (14 Sep)');
        expect(V.gapsText({ read: false, weeks: [] })).toBe('not collected');
        expect(V.gapsText({ read: true, weeks: [] })).toBe('not measured yet');
        expect(V.gapsText(null)).toBeNull();
        expect(V.gapsText({ read: true, weeks: [], unmeasured: 're-marked Sunday 20:00 ET; not measured' })).toBe('re-marked Sunday 20:00 ET; not measured');
    });
});

describe('weekend move and the monitor column', () => {
    test('the weekend move reads against Friday\'s close, or says what is missing', () => {
        const move = { weekendFrom: '2026-09-18T20:00:00Z', weekendTo: '2026-09-21T13:30:00Z', observations: 2, medianPct: -0.05, widestPct: -0.18 };
        expect(V.weekendMoveText({ read: true, move })).toBe('median -0.05%, widest -0.18% against Friday\'s close (2 observations, 18 Sep–21 Sep)');
        expect(V.weekendMoveText({ read: true, move: null })).toMatch(/no observation/);
        expect(V.weekendMoveText({ read: false })).toBe('not collected');
        expect(V.weekendMoveText(null)).toBeNull();
    });

    test('compactLenders folds the two Kamino xStocks markets into one entry with both thresholds', () => {
        const item = { lenders: [
            { protocolName: 'Kamino', displayName: 'Kamino Sentora xStocks Market', label: 'frozen at close', labelKind: 'frozen-at-close', liquidationLtvPct: 73 },
            { protocolName: 'Kamino', displayName: 'Kamino xStocks Pool', label: 'frozen at close', labelKind: 'frozen-at-close', liquidationLtvPct: 65 },
            { protocolName: 'Nest', displayName: 'Nest xStocks', label: '24/7 token price', labelKind: 'token-24x7', liquidationLtvPct: 60 },
            { protocolName: 'Loopscale', displayName: 'Loopscale', label: 'stale since 26 Aug 2026', labelKind: 'stale', liquidationLtvPct: 60 }
        ] };
        const out = V.compactLenders(item);
        expect(out.map((e) => [e.protocolName, e.label, e.className])).toEqual([
            ['Kamino', 'frozen at close', 'cm-frozen'], ['Nest', '24/7 token price', 'cm-token'], ['Loopscale', 'stale since 26 Aug 2026', 'cm-stale']
        ]);
        expect(out[0].title).toBe('Kamino Sentora xStocks Market, Kamino xStocks Pool: frozen at close; liquidation at 65 / 73 % LTV');
        expect(V.compactLenders(null)).toEqual([]);
        expect(V.labelClass('something')).toBe('cm-unknown');
    });
});
