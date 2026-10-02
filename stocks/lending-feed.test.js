// Tests the lending rules of the latest-events feed (stocks/lib/events.mjs liquidationEvents,
// freezeEvents and their place in buildEventsFeed / mergeLiveFeed): how liquidations are grouped
// and floored, when a burst is told as a wave, how freeze episodes from several markets and tokens
// become one event, and that an ongoing freeze stays in the feed. Every rule has a case that fails
// when the rule is removed. Rows are in the shape lendingRowsSelect returns; the freeze rows mirror
// the episodes the watcher recorded for 2026-09-19/21 (QQQx) and 2026-09-24 (the refresh gap).

import {
    FREEZE_FLOOR_MS, LIQUIDATION_FLOOR_USD, LIQUIDATION_WAVE_MIN, TITLE_MAX, buildEventsFeed, eventContext, finaliseEvents,
    freezeEvents, lendingRowsPsql, lendingRowsSelect, liquidationEvents, mergeLiveFeed
} from './lib/events.mjs';

const NVDAX = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const QQQX = 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ';
const SPYX = 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W';
const TSLAX = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';

function ctx() {
    return eventContext({
        cardSlugs: { [NVDAX]: 'NVDAx', [QQQX]: 'QQQx' },
        protocolPages: { [`${NVDAX}|kamino`]: 'nvdax-kamino-kamino-collateral-xsc9qv', [`${QQQX}|kamino`]: 'qqqx-kamino-kamino-collateral-xs8s1u' }
    });
}

function liq(at, fields = {}) {
    return {
        signature: `sig-${at}-${fields.mint ?? NVDAX}`, ix_index: 5, block_time: at, protocol: 'kamino', market_id: 'kamino:xstocks-pool',
        mint: NVDAX, symbol: 'NVDAx', collateral_amount: 10, collateral_usd: 2200, card_slug: 'NVDAx', ...fields
    };
}

function freeze(fields) {
    return { protocol: 'kamino', market_id: 'kamino:xstocks-pool', mint: QQQX, symbol: 'QQQx', ended_at: null, last_seen_stale_at: null, cause: null, card_slug: null, ...fields };
}

// As the watcher stored them: Kamino's ends are the Scope resume (exact), Jupiter Lend's the next refresh (exact).
const QQQX_FREEZE = [
    freeze({ started_at: '2026-09-19T17:28:45Z', ended_at: '2026-09-21T13:42:13Z', last_seen_stale_at: '2026-09-21T13:39:54Z', cause: 'scope-suspension', end_basis: 'scope-resume' }),
    freeze({ market_id: 'kamino:sentora-xstocks-market', started_at: '2026-09-19T17:28:45Z', ended_at: '2026-09-21T13:42:13Z', last_seen_stale_at: '2026-09-21T13:19:34Z', cause: 'scope-suspension', end_basis: 'scope-resume' }),
    freeze({ protocol: 'jupiter-lend', market_id: 'jupiter-lend:xstocks-vaults', started_at: '2026-09-19T17:29:01Z', ended_at: '2026-09-21T12:31:24Z', cause: 'operator-suspension', end_basis: 'next-refresh' })
];
// Kamino saw these stale once or a few times and fresh again later: their end is only bounded.
const GAP_0924 = [
    freeze({ mint: NVDAX, symbol: 'NVDAx', started_at: '2026-09-24T08:39:40Z', last_seen_stale_at: '2026-09-24T09:03:50Z', ended_at: '2026-09-24T09:37:54Z', end_basis: 'first-fresh-observation' }),
    freeze({ mint: SPYX, symbol: 'SPYx', started_at: '2026-09-24T08:39:40Z', last_seen_stale_at: '2026-09-24T09:03:50Z', ended_at: '2026-09-24T09:08:37Z', end_basis: 'first-fresh-observation' }),
    freeze({ protocol: 'jupiter-lend', market_id: 'jupiter-lend:xstocks-vaults', mint: TSLAX, symbol: 'TSLAx', started_at: '2026-09-24T08:38:00Z', ended_at: '2026-09-24T09:07:45Z', end_basis: 'next-refresh' }),
    freeze({ protocol: 'jupiter-lend', market_id: 'jupiter-lend:xstocks-vaults', mint: QQQX, symbol: 'QQQx', started_at: '2026-09-24T08:38:00Z', ended_at: '2026-09-24T09:07:45Z', end_basis: 'next-refresh' })
];

describe('liquidations', () => {
    // Lending events link to the token card's "When the market is closed" section, which names each
    // lending market, its liquidation LTV and its recent freezes; the protocol dossier mentions none of them.
    test('grouped per market, token and UTC day with the collateral summed, linked to the token card\'s closed-market section', () => {
        const events = liquidationEvents([liq('2026-09-21T13:31:00Z'), liq('2026-09-21T18:02:00Z', { collateral_usd: 80000 }), liq('2026-09-21T20:00:00Z')], ctx());
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            at: '2026-09-21T20:00:00Z', category: 'lending', kind: 'liquidations', source: 'lending watcher', severity: 'caution', origin: 'lending',
            title: 'Kamino liquidated 3 NVDAx positions ($84k collateral)', href: './cards/NVDAx.html#closed-market'
        });
    });

    test(`a day's dust under $${LIQUIDATION_FLOOR_USD} is not news; three unpriced liquidations are, worded by amount`, () => {
        const tally = {};
        expect(liquidationEvents([liq('2026-09-21T13:31:00Z', { collateral_usd: 45 })], ctx(), tally)).toEqual([]);
        expect(Object.keys(tally)[0]).toMatch(/under \$1,000/);
        const unpriced = liquidationEvents([1, 2, 3].map((h) => liq(`2026-09-22T0${h}:00:00Z`, { collateral_usd: null, collateral_amount: 0.5 })), ctx());
        expect(unpriced[0].title).toBe('Kamino liquidated 3 NVDAx positions (1.5 NVDAx collateral)');
        const partly = liquidationEvents([liq('2026-09-22T01:00:00Z'), liq('2026-09-22T02:00:00Z', { collateral_usd: null })], ctx());
        expect(partly[0].title).toBe('Kamino liquidated 2 NVDAx positions (at least $2k collateral)');
    });

    test(`${LIQUIDATION_WAVE_MIN} or more at one protocol within an hour is one wave event, the rest stay per day`, () => {
        const wave = [0, 7, 15, 31, 44, 58].map((m, i) => liq(`2026-09-21T13:${String(m).padStart(2, '0')}:00Z`, i % 2 ? { mint: QQQX, symbol: 'QQQx', card_slug: 'QQQx' } : {}));
        const events = liquidationEvents([...wave, liq('2026-09-21T19:00:00Z', { collateral_usd: 5000 })], ctx());
        expect(events.map((e) => e.kind).sort()).toEqual(['liquidation-wave', 'liquidations']);
        const w = events.find((e) => e.kind === 'liquidation-wave');
        expect(w).toMatchObject({ at: '2026-09-21T13:00:00Z', severity: 'warning', title: 'Kamino liquidation wave: 6 positions in an hour ($13k collateral) (NVDAx, QQQx)' });
        expect(events.find((e) => e.kind === 'liquidations').title).toBe('Kamino liquidated 1 NVDAx position ($5k collateral)');
        // Spread over more than an hour, the same six are ordinary day groups.
        const spread = liquidationEvents([0, 15, 30, 45, 61, 75].map((m) => liq(new Date(Date.parse('2026-09-21T13:00:00Z') + m * 60000).toISOString().replace('.000', ''))), ctx());
        expect(spread.map((e) => e.kind)).toEqual(['liquidations']);
    });

    test('a second market of the same protocol is named', () => {
        const [event] = liquidationEvents([liq('2026-09-21T13:31:00Z', { market_id: 'kamino:sentora-xstocks-market', collateral_usd: 12000 })], ctx());
        expect(event.title).toBe('Kamino (Sentora market) liquidated 1 NVDAx position ($12k collateral)');
    });
});

describe('collateral price freezes', () => {
    test('one corporate action frozen at two protocols is one event, as long as the longest', () => {
        const [event] = freezeEvents(QQQX_FREEZE, ctx());
        expect(event).toMatchObject({
            at: '2026-09-19T17:28:45Z', kind: 'price-freeze', category: 'lending', severity: 'warning',
            title: 'Kamino and Jupiter Lend froze the QQQx collateral price for 44 h', href: './cards/QQQx.html#closed-market'
        });
        // Exact lengths that differ by more than a tenth are given as a range.
        const [ranged] = freezeEvents([QQQX_FREEZE[0], { ...QQQX_FREEZE[2], ended_at: '2026-09-20T12:00:00Z' }], ctx());
        expect(ranged.title).toBe('Kamino and Jupiter Lend froze the QQQx collateral price for 19–44 h');
        // A different freeze a day earlier (METAx, 18 Sep) stays its own event.
        const metax = freeze({ mint: 'META', symbol: 'METAx', started_at: '2026-09-18T20:31:07Z', ended_at: '2026-09-21T13:42:33Z', cause: 'scope-suspension', end_basis: 'scope-resume' });
        const feed = buildEventsFeed({ lending: { liquidations: [], freezes: [...QQQX_FREEZE, metax] }, ctx: ctx(), asOf: '2026-09-24T12:00:00Z' });
        expect(feed.events.map((e) => e.title)).toEqual([
            'Kamino and Jupiter Lend froze the QQQx collateral price for 44 h', 'Kamino froze the METAx collateral price for 65 h'
        ]);
    });

    test('tokens frozen together (one upstream gap) are one event naming them, as long as the exactly dated ends say', () => {
        const [event] = freezeEvents(GAP_0924, ctx());
        expect(event).toMatchObject({
            at: '2026-09-24T08:38:00Z', severity: 'caution', title: 'Kamino and Jupiter Lend froze 4 collateral prices for 30 min (NVDAx, QQQx, SPYx, TSLAx)',
            // The first token the title names: NVDAx.
            href: './cards/NVDAx.html#closed-market'
        });
        expect(freezeEvents([...QQQX_FREEZE, ...GAP_0924], ctx())).toHaveLength(2);
        // A token with no known card falls back to its protocol dossier, then to the explorer.
        const [noCard] = freezeEvents([{ ...QQQX_FREEZE[0], mint: 'XNOCARD' }], eventContext({ protocolPages: { 'XNOCARD|kamino': 'x-kamino' } }));
        expect(noCard.href).toBe('./protocols/x-kamino.html');
    });

    test('with only KLend sightings, the length is the range between the last stale and the first fresh one', () => {
        const [event] = freezeEvents(GAP_0924.slice(0, 2), ctx());
        expect(event.title).toBe('Kamino froze 2 collateral prices for 24–58 min (NVDAx, SPYx)');
        const [mstrx] = freezeEvents([freeze({ mint: 'M', symbol: 'MSTRx', started_at: '2026-09-21T08:45:56Z', last_seen_stale_at: '2026-09-21T13:00:01Z', ended_at: '2026-09-21T13:34:51Z', end_basis: 'first-fresh-observation' })], ctx());
        expect(mstrx.title).toBe('Kamino froze the MSTRx collateral price for 4–5 h');
    });

    test(`a freeze that certainly lasted less than ${FREEZE_FLOOR_MS / 60000} min is a keeper hiccup, not news`, () => {
        const tally = {};
        expect(freezeEvents([freeze({ started_at: '2026-09-22T10:00:00Z', ended_at: '2026-09-22T10:07:30Z', end_basis: 'next-refresh' })], ctx(), tally)).toEqual([]);
        expect(Object.keys(tally)).toEqual(['lending watcher: price freezes shorter than 20 min']);
        // Seen stale once 13 min in and fresh 50 min in: it may have been long, but nothing shows it was.
        expect(freezeEvents([freeze({ started_at: '2026-09-22T10:00:00Z', last_seen_stale_at: '2026-09-22T10:13:00Z', ended_at: '2026-09-22T10:50:00Z', end_basis: 'first-fresh-observation' })], ctx())).toEqual([]);
    });

    test('an ongoing freeze says since when, and stays in the feed after the window has passed its start', () => {
        const loopscale = [SPYX, NVDAX].map((mint, i) => freeze({
            protocol: 'loopscale', market_id: 'loopscale:xstocks-orca-vaults', mint, symbol: ['SPYx', 'NVDAx'][i],
            started_at: '2026-08-26T15:54:46Z', last_seen_stale_at: '2026-09-24T18:09:46Z', cause: 'stale-oracle-account'
        }));
        const [event] = freezeEvents(loopscale, ctx());
        expect(event).toMatchObject({ kind: 'price-freeze-ongoing', ongoing: true, severity: 'warning', title: 'Loopscale: 2 collateral prices frozen since 26 Aug (NVDAx, SPYx)' });
        const [single] = freezeEvents(loopscale.slice(0, 1), ctx());
        expect(single.title).toBe('Loopscale: the SPYx collateral price has been frozen since 26 Aug');
        const kept = finaliseEvents([event, { ...event, id: 'old', ongoing: undefined }], { asOf: '2026-10-30T00:00:00Z', windowDays: 30 });
        expect(kept.map((e) => e.id)).toEqual([event.id]);
    });
});

describe('the feed', () => {
    const lending = { liquidations: [liq('2026-09-21T13:31:00Z', { collateral_usd: 5000 })], freezes: QQQX_FREEZE };

    test('lending events sit beside the other sources with their own category, and every title fits a line', () => {
        const feed = buildEventsFeed({ lending, ctx: ctx(), asOf: '2026-09-24T12:00:00Z' });
        expect(feed.counts.byCategory).toEqual({ lending: 2 });
        expect(feed.counts.bySource).toEqual({ 'lending watcher': 2 });
        for (const event of feed.events) expect(event.title.length).toBeLessThanOrEqual(TITLE_MAX);
        expect(feed.methodology).toMatch(/liquidations of stock collateral/);
    });

    test('the live feed swaps the file\'s lending events for fresh rows, and keeps them when rows are unavailable', () => {
        const file = buildEventsFeed({ lending, ctx: ctx(), asOf: '2026-09-24T12:00:00Z' });
        const fresh = { liquidations: [liq('2026-09-24T13:00:00Z', { collateral_usd: 9000 })], freezes: QQQX_FREEZE };
        const live = mergeLiveFeed(file, [], ctx(), { lending: fresh });
        expect(live.asOf).toBe('2026-09-24T13:00:00Z');
        expect(live.events.filter((e) => e.kind === 'liquidations').map((e) => e.at)).toEqual(['2026-09-24T13:00:00Z']);
        const stale = mergeLiveFeed(file, [], ctx());
        expect(stale.events.map((e) => e.id).sort()).toEqual(file.events.map((e) => e.id).sort());
    });

    test('the lending rows query inlines nothing but a checked instant', () => {
        expect(lendingRowsSelect({ sinceExpr: '$1::timestamptz' })).toContain('f.ended_at IS NULL OR f.ended_at >= $1::timestamptz');
        expect(lendingRowsPsql({ since: '2026-08-23T12:00:00Z' })).toContain("'2026-08-23T12:00:00Z'::timestamptz");
        expect(() => lendingRowsPsql({ since: "2026-08-23'; DROP TABLE x; --" })).toThrow(/ISO UTC instant/);
    });
});
