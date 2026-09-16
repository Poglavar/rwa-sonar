// Unit tests for the pure section of live.js — the shaping behind live.html (stocks/MODEL.md §12.3).
// Everything here asserts an outcome a reader would notice if it broke: the age a row prints, the
// dash a null price must print instead of a zero, the pixel geometry of a stacked bar, what the
// counters read when the cursor has passed three hours, and that a flooded queue drops the oldest
// signatures and says how many. Each test goes red when its rule is removed, not merely when the
// function disappears. The swap decode itself is not tested here: the page imports the collector's
// `stocks/lib/trades.mjs`, which owns that rule and is covered by stocks/trades.test.js.

const L = require('./live.js');

/** A capture shaped like stocks-trades.json, small enough to assert by hand. */
function fixture() {
    const hour = 3600 * 1000;
    const base = Date.UTC(2026, 8, 16, 0, 0, 0); // 16 Sep 2026 00:00 UTC
    return {
        generatedAt: new Date(base + 4 * hour).toISOString(),
        collectingSince: new Date(base + 1 * hour).toISOString(),
        pools: [
            {
                pair: 'PAIR_RAY', mint: 'MINT_A', symbol: 'AAPLx', dex: 'raydium',
                quoteMint: 'MINT_USDC', quoteSymbol: 'USDC', quoteUsdRate: 1,
                signaturesSeen: 50, failedTx: 30, decoded: 18, undecodable: 2
            },
            {
                pair: 'PAIR_ORCA', mint: 'MINT_B', symbol: 'TSLAx', dex: 'orca',
                quoteMint: 'MINT_SOL', quoteSymbol: 'SOL', quoteUsdRate: 210,
                signaturesSeen: 20, failedTx: 2, decoded: 8, undecodable: 0
            },
            {
                pair: 'PAIR_NEW', mint: 'MINT_C', symbol: 'NVDAx', dex: 'meteoradbc',
                quoteMint: 'MINT_USDC', quoteSymbol: 'USDC', quoteUsdRate: 1,
                signaturesSeen: 0, failedTx: 0, decoded: 0, undecodable: 0
            }
        ],
        trades: [
            { sig: 's4', time: new Date(base + 3 * hour + 60000).toISOString(), mint: 'MINT_A', symbol: 'AAPLx', dex: 'raydium', pair: 'PAIR_RAY', side: 'buy', size: 3, quoteAmount: 750, quoteSymbol: 'USDC', priceQuote: 250, priceUsd: 250, feePayer: 'WALLET_1', routed: false, programs: ['P1'] },
            { sig: 's3', time: new Date(base + 2 * hour + 60000).toISOString(), mint: 'MINT_B', symbol: 'TSLAx', dex: 'orca', pair: 'PAIR_ORCA', side: 'sell', size: 1.5, quoteAmount: 3, quoteSymbol: 'SOL', priceQuote: 2, priceUsd: 420, feePayer: 'WALLET_2', routed: true, programs: ['P1', 'P2'] },
            { sig: 's2', time: new Date(base + 1 * hour + 60000).toISOString(), mint: 'MINT_A', symbol: 'AAPLx', dex: 'raydium', pair: 'PAIR_RAY', side: 'sell', size: 2, quoteAmount: 480, quoteSymbol: 'USDC', priceQuote: 240, priceUsd: 240, feePayer: 'WALLET_1', routed: false, programs: ['P1'] },
            { sig: 's1', time: new Date(base + 1 * hour + 30000).toISOString(), mint: 'MINT_A', symbol: 'AAPLx', dex: 'raydium', pair: 'PAIR_RAY', side: 'buy', size: 1, quoteAmount: 239, quoteSymbol: 'USDC', priceQuote: 239, priceUsd: 239, feePayer: 'WALLET_3', routed: false, programs: ['P1'] }
        ],
        hourly: [
            { hourStart: new Date(base + 0 * hour).toISOString(), byDex: {} },
            { hourStart: new Date(base + 1 * hour).toISOString(), byDex: { raydium: { trades: 2, volumeUsd: 719, buys: 1, sells: 1, traders: 2 } } },
            { hourStart: new Date(base + 2 * hour).toISOString(), byDex: { orca: { trades: 1, volumeUsd: 630, buys: 0, sells: 1, traders: 1 } } },
            { hourStart: new Date(base + 3 * hour).toISOString(), byDex: { raydium: { trades: 1, volumeUsd: 750, buys: 1, sells: 0, traders: 1 }, orca: { trades: 3, volumeUsd: 300, buys: 2, sells: 1, traders: 2 } } }
        ],
        totals: { trades: 4, volumeUsd: 2099, traders: 3, failedShare: 0.32 }
    };
}

const HOUR = 3600 * 1000;
const BASE = Date.UTC(2026, 8, 16, 0, 0, 0);

// ---------------------------------------------------------------- relative time

describe('fmtAgo', () => {
    const now = BASE + 10 * HOUR;

    test('seconds, minutes, hours and days, each floored so it never rounds up into the future', () => {
        expect(L.fmtAgo(now - 12000, now)).toBe('12 s ago');
        expect(L.fmtAgo(now - 59999, now)).toBe('59 s ago');
        expect(L.fmtAgo(now - 4 * 60000 - 59000, now)).toBe('4 min ago');
        expect(L.fmtAgo(now - 3 * HOUR - 59 * 60000, now)).toBe('3 h ago');
        expect(L.fmtAgo(now - 2 * 24 * HOUR, now)).toBe('2 d ago');
    });

    test('under a second is "now", not "0 s ago"', () => {
        expect(L.fmtAgo(now - 300, now)).toBe('now');
        expect(L.fmtAgo(now, now)).toBe('now');
    });

    test('a timestamp ahead of our clock reads "in", never as a trade that already happened', () => {
        expect(L.fmtAgo(now + 20000, now)).toBe('in 20 s');
        expect(L.fmtAgo(now + 2 * HOUR, now)).toBe('in 2 h');
    });

    test('no timestamp is a dash, never "now"', () => {
        expect(L.fmtAgo(null, now)).toBe(L.DASH);
        expect(L.fmtAgo(undefined, now)).toBe(L.DASH);
        expect(L.fmtAgo('not a date', now)).toBe(L.DASH);
        expect(L.fmtAgo(now, null)).toBe(L.DASH);
    });

    test('accepts an ISO string, epoch seconds and epoch milliseconds alike', () => {
        const iso = new Date(now - 5 * 60000).toISOString();
        expect(L.fmtAgo(iso, now)).toBe('5 min ago');
        expect(L.fmtAgo((now - 5 * 60000) / 1000, now)).toBe('5 min ago');
        expect(L.fmtAgo(now - 5 * 60000, now)).toBe('5 min ago');
    });

    test('tradeTimeMs never invents an instant for a missing one', () => {
        expect(L.tradeTimeMs(null)).toBeNull();
        expect(L.tradeTimeMs('')).toBeNull();
        expect(L.tradeTimeMs('2026-13-45')).toBeNull();
        expect(L.tradeTimeMs(1758000000)).toBe(1758000000000);
        expect(L.tradeTimeMs(1758000000000)).toBe(1758000000000);
    });
});

// ---------------------------------------------------------------- dex names

describe('humanizeDex', () => {
    test('the hand-kept names', () => {
        expect(L.humanizeDex('raydium')).toBe('Raydium');
        expect(L.humanizeDex('raydium-clmm')).toBe('Raydium CLMM');
        expect(L.humanizeDex('orca')).toBe('Orca');
        expect(L.humanizeDex('meteora')).toBe('Meteora');
        expect(L.humanizeDex('meteoradbc')).toBe('Meteora DBC');
        expect(L.humanizeDex('openbook')).toBe('OpenBook');
    });

    test('case and stray whitespace do not produce a second venue', () => {
        expect(L.humanizeDex('Raydium')).toBe('Raydium');
        expect(L.humanizeDex('  ORCA ')).toBe('Orca');
    });

    test('an unknown venue is title-cased from its own slug, never given an invented name', () => {
        expect(L.humanizeDex('some-new-amm')).toBe('Some New Amm');
        expect(L.humanizeDex('solfi')).toBe('SolFi');
        expect(L.humanizeDex('zeta_dex')).toBe('Zeta Dex');
    });

    test('no venue is a dash', () => {
        expect(L.humanizeDex(null)).toBe(L.DASH);
        expect(L.humanizeDex('')).toBe(L.DASH);
        expect(L.humanizeDex('   ')).toBe(L.DASH);
    });
});

// ---------------------------------------------------------------- tape rows

describe('tapeRow', () => {
    const now = BASE + 4 * HOUR;

    test('a complete trade shapes into the row the tape prints', () => {
        const row = L.tapeRow(fixture().trades[0], now);
        expect(row.symbol).toBe('AAPLx');
        expect(row.venueLabel).toBe('Raydium');
        expect(row.side).toBe('buy');
        expect(row.sideGlyph).toBe('▲');
        expect(row.size).toBe('3');
        expect(row.price).toBe('$250.00');
        expect(row.priceSource).toBe('usd');
        expect(row.age).toBe('59 min ago');
        expect(row.solscanUrl).toBe('https://solscan.io/tx/s4');
        expect(row.routed).toBe(false);
    });

    test('a sell carries the down glyph, and a routed trade says so', () => {
        const row = L.tapeRow(fixture().trades[1], now);
        expect(row.side).toBe('sell');
        expect(row.sideGlyph).toBe('▼');
        expect(row.routed).toBe(true);
    });

    test('no USD rate falls back to the quote price, and says which it is', () => {
        const row = L.tapeRow({ sig: 'x', symbol: 'AAPLx', dex: 'orca', side: 'buy', size: 2, priceQuote: 1.0042, quoteSymbol: 'SOL', priceUsd: null }, now);
        expect(row.price).toBe('1.0042 SOL');
        expect(row.priceSource).toBe('quote');
    });

    test('every missing number is a dash and never a zero', () => {
        const row = L.tapeRow({
            sig: null, time: null, mint: null, symbol: null, dex: null, side: null,
            size: null, quoteAmount: null, priceQuote: null, priceUsd: null, routed: null, programs: null
        }, now);
        expect(row.size).toBe(L.DASH);
        expect(row.price).toBe(L.DASH);
        expect(row.priceSource).toBe('none');
        expect(row.age).toBe(L.DASH);
        expect(row.absoluteTime).toBe(L.DASH);
        expect(row.symbol).toBe(L.DASH);
        expect(row.venueLabel).toBe(L.DASH);
        expect(row.sideLabel).toBe(L.DASH);
        expect(row.sideGlyph).toBe('·');
        expect(row.solscanUrl).toBeNull();
        expect(row.routed).toBe(false);
    });

    test('a trade with no symbol falls back to a stub of its mint, not to an empty cell', () => {
        const row = L.tapeRow({ sig: 'x', mint: 'So11111111111111111111111111111111111111112', symbol: null }, now);
        expect(row.symbol).toBe('So11…');
    });

    test('a real zero size stays a zero: only absence is a dash', () => {
        expect(L.tapeRow({ size: 0 }, now).size).toBe('0');
    });

    test('shaping nothing at all does not throw', () => {
        expect(() => L.tapeRow(null, now)).not.toThrow();
        expect(L.tapeRow(null, now).price).toBe(L.DASH);
    });
});

// ---------------------------------------------------------------- pool chips and header

describe('poolChip and collectionLine', () => {
    test('a chip carries the failed share of the signatures actually seen', () => {
        const chip = L.poolChip(fixture().pools[0]);
        expect(chip.symbol).toBe('AAPLx');
        expect(chip.venueLabel).toBe('Raydium');
        expect(chip.decoded).toBe('18');
        expect(chip.failedPct).toBe('60%');
    });

    test('a pool with no signatures yet has no failed share, not 0%', () => {
        expect(L.poolChip(fixture().pools[2]).failedPct).toBe(L.DASH);
    });

    test('the header line names the collection start, the pool count and the bot-spam share', () => {
        const line = L.collectionLine(fixture());
        expect(line).toContain('16 Sep 2026 01:00 UTC');
        expect(line).toContain('3 pools sampled');
        expect(line).toContain('32.0% of transactions failed (bot spam)');
    });

    test('with no capture at all the line still reads, with dashes', () => {
        const line = L.collectionLine(null);
        expect(line).toContain(L.DASH);
        expect(line).not.toContain('undefined');
    });

    test('a failed share is a 0-1 fraction, and an unknown one is a dash rather than 0%', () => {
        expect(L.fmtShare(0.32)).toBe('32.0%');
        expect(L.fmtShare(0)).toBe('0.0%');
        expect(L.fmtShare(1)).toBe('100.0%');
        expect(L.fmtShare(null)).toBe(L.DASH);
    });
});

// ---------------------------------------------------------------- venue order

describe('venueOrder', () => {
    test('most traded first, and a sampled venue with no trades is still listed', () => {
        const order = L.venueOrder(fixture());
        expect(order.map((v) => v.dexId)).toEqual(['orca', 'raydium', 'meteoradbc']);
        expect(order.map((v) => v.trades)).toEqual([4, 3, 0]);
        expect(order.map((v) => v.slot)).toEqual([0, 1, 2]);
        expect(order[2].label).toBe('Meteora DBC');
    });

    test('venues past the colour slots share the last one rather than going uncoloured', () => {
        const hourly = [{ hourStart: new Date(BASE).toISOString(), byDex: {} }];
        for (let i = 0; i < 12; i++) hourly[0].byDex[`dex${String(i).padStart(2, '0')}`] = { trades: 20 - i };
        const order = L.venueOrder({ hourly, pools: [] });
        expect(order).toHaveLength(12);
        expect(order[7].slot).toBe(7);
        expect(order[11].slot).toBe(7);
    });

    test('an empty capture is an empty order, not a throw', () => {
        expect(L.venueOrder(null)).toEqual([]);
        expect(L.venueOrder({})).toEqual([]);
    });
});

// ---------------------------------------------------------------- bar geometry

describe('barGeometry', () => {
    const db = fixture();
    const venues = L.venueOrder(db);
    const opts = { width: 240, height: 100, gap: 0, venues, collectingSinceMs: Date.parse(db.collectingSince) };

    test('one band per bucket, the tallest bucket filling the height', () => {
        const geo = L.barGeometry(db.hourly, opts);
        expect(geo.bars).toHaveLength(4);
        expect(geo.bandWidth).toBe(60);
        expect(geo.max).toBe(4); // hour 3: 1 raydium + 3 orca
        const tallest = geo.bars[3];
        const stacked = tallest.segments.reduce((sum, seg) => sum + seg.height, 0);
        expect(stacked).toBeCloseTo(100, 6);
        expect(tallest.segments[tallest.segments.length - 1].y).toBeCloseTo(0, 6);
    });

    test('segments stack from the baseline upwards in venue order', () => {
        const geo = L.barGeometry(db.hourly, opts);
        const bar = geo.bars[3];
        expect(bar.segments.map((seg) => seg.dexId)).toEqual(['orca', 'raydium']);
        // orca: 3/4 of 100 = 75, sitting on the baseline; raydium: 25, stacked on top of it.
        expect(bar.segments[0].height).toBeCloseTo(75, 6);
        expect(bar.segments[0].y).toBeCloseTo(25, 6);
        expect(bar.segments[1].height).toBeCloseTo(25, 6);
        expect(bar.segments[1].y).toBeCloseTo(0, 6);
    });

    test('a bucket with nothing in it has no segments and no invented height', () => {
        const geo = L.barGeometry(db.hourly, opts);
        expect(geo.bars[0].segments).toEqual([]);
        expect(geo.bars[0].total).toBeNull();
    });

    test('an hour that began before collection started is hatched', () => {
        const geo = L.barGeometry(db.hourly, opts);
        expect(geo.bars.map((bar) => bar.hatched)).toEqual([true, false, false, false]);
    });

    test('the volume metric rescales to USD, not to trade counts', () => {
        const geo = L.barGeometry(db.hourly, { ...opts, mode: 'volume' });
        expect(geo.max).toBe(1050); // hour 3: 750 + 300
        expect(geo.bars[1].total).toBe(719);
        const hour1 = geo.bars[1].segments[0];
        expect(hour1.height).toBeCloseTo((719 / 1050) * 100, 6);
    });

    test('bars sit side by side, in bucket order, left to right', () => {
        const geo = L.barGeometry(db.hourly, opts);
        expect(geo.bars.map((bar) => bar.x)).toEqual([0, 60, 120, 180]);
        expect(geo.bars[0].width).toBe(60);
    });

    test('a gap narrows the bar without moving the band', () => {
        const geo = L.barGeometry(db.hourly, { ...opts, gap: 6 });
        expect(geo.bars[1].x).toBe(60);
        expect(geo.bars[1].width).toBe(54);
    });

    test('nothing to draw is an empty, harmless geometry', () => {
        const geo = L.barGeometry(null, opts);
        expect(geo.bars).toEqual([]);
        expect(geo.max).toBe(0);
    });

    test('all-null buckets keep max at zero, so no bar is drawn at full height', () => {
        const flat = [{ hourStart: new Date(BASE).toISOString(), byDex: { raydium: { trades: null, volumeUsd: null } } }];
        const geo = L.barGeometry(flat, opts);
        expect(geo.max).toBe(0);
        expect(geo.bars[0].segments).toEqual([]);
    });
});

// ---------------------------------------------------------------- cursor counters

describe('countersUpTo', () => {
    const db = fixture();

    test('at the first hour the counters hold only that hour', () => {
        const c = L.countersUpTo(db.hourly, db.trades, 1, { failedShare: db.totals.failedShare });
        expect(c.hours).toBe(2);
        expect(c.hourLabel).toBe('01:00');
        expect(c.trades).toBe(2);
        expect(c.volumeUsd).toBe(719);
        expect(c.buys).toBe(1);
        expect(c.sells).toBe(1);
    });

    test('the counters accumulate as the cursor passes each hour', () => {
        const at2 = L.countersUpTo(db.hourly, db.trades, 2, {});
        const at3 = L.countersUpTo(db.hourly, db.trades, 3, {});
        expect(at2.trades).toBe(3);
        expect(at2.volumeUsd).toBe(1349);
        expect(at3.trades).toBe(7);
        expect(at3.volumeUsd).toBe(2399);
        expect(at3.hourLabel).toBe('03:00');
    });

    test('distinct traders are counted from the trades, so a wallet trading twice counts once', () => {
        // WALLET_1 trades in hour 1 and hour 3; the bucket counts would total 4 by hour 3.
        const at3 = L.countersUpTo(db.hourly, db.trades, 3, {});
        expect(at3.traders).toBe(3);
        expect(at3.tradersExact).toBe(true);
        const at1 = L.countersUpTo(db.hourly, db.trades, 1, {});
        expect(at1.traders).toBe(2);
    });

    test('without the trade list the per-bucket counts are summed and flagged as inexact', () => {
        const at3 = L.countersUpTo(db.hourly, null, 3, {});
        expect(at3.traders).toBe(6);
        expect(at3.tradersExact).toBe(false);
    });

    test('a trade in a later hour is not counted early', () => {
        const at1 = L.countersUpTo(db.hourly, db.trades, 1, {});
        expect(at1.traders).toBe(2);
        expect(at1.traders).not.toBe(3);
    });

    test('before the cursor has entered the window there is nothing to report', () => {
        const c = L.countersUpTo(db.hourly, db.trades, -1, {});
        expect(c.hours).toBe(0);
        expect(c.trades).toBeNull();
        expect(c.volumeUsd).toBeNull();
        expect(c.hourLabel).toBe(L.DASH);
    });

    test('an hour index past the end clamps to the last collected hour', () => {
        const c = L.countersUpTo(db.hourly, db.trades, 99, {});
        expect(c.hourIndex).toBe(3);
        expect(c.trades).toBe(7);
    });

    test('an hour that was never collected reports no traders, not zero of them', () => {
        const c = L.countersUpTo(db.hourly, db.trades, 0, {});
        expect(c.trades).toBeNull();
        expect(c.traders).toBeNull();
        expect(c.tradersExact).toBe(false);
    });

    test('buckets with no numbers leave the counters null rather than zero', () => {
        const c = L.countersUpTo([{ hourStart: new Date(BASE).toISOString(), byDex: { raydium: { trades: null, volumeUsd: null } } }], [], 0, {});
        expect(c.trades).toBeNull();
        expect(c.volumeUsd).toBeNull();
    });

    test('the failed share is passed through, not derived from the hours', () => {
        expect(L.countersUpTo(db.hourly, db.trades, 2, { failedShare: 0.32 }).failedShare).toBe(0.32);
        expect(L.countersUpTo(db.hourly, db.trades, 2, {}).failedShare).toBeNull();
    });
});

// ---------------------------------------------------------------- the fetch queue

describe('queuePush', () => {
    test('a signature is appended once', () => {
        const first = L.queuePush([], 'a', 5);
        expect(first.queue).toEqual(['a']);
        expect(first.added).toBe(true);
        const again = L.queuePush(first.queue, 'a', 5);
        expect(again.queue).toEqual(['a']);
        expect(again.added).toBe(false);
        expect(again.dropped).toBe(0);
    });

    test('over the cap the oldest is dropped and counted, and the newest is kept', () => {
        let queue = [];
        for (const sig of ['a', 'b', 'c']) queue = L.queuePush(queue, sig, 3).queue;
        const overflow = L.queuePush(queue, 'd', 3);
        expect(overflow.queue).toEqual(['b', 'c', 'd']);
        expect(overflow.dropped).toBe(1);
    });

    test('a flood past the cap never grows the queue', () => {
        let queue = [];
        let dropped = 0;
        for (let i = 0; i < 200; i++) {
            const pushed = L.queuePush(queue, `sig${i}`, L.QUEUE_CAP);
            queue = pushed.queue;
            dropped += pushed.dropped;
        }
        expect(queue).toHaveLength(L.QUEUE_CAP);
        expect(dropped).toBe(200 - L.QUEUE_CAP);
        expect(queue[queue.length - 1]).toBe('sig199');
        expect(queue[0]).toBe(`sig${200 - L.QUEUE_CAP}`);
    });

    test('an empty or absent signature is never queued', () => {
        expect(L.queuePush(['a'], '', 5).queue).toEqual(['a']);
        expect(L.queuePush(['a'], null, 5).added).toBe(false);
    });

    test('the input queue is never mutated', () => {
        const original = ['a', 'b'];
        L.queuePush(original, 'c', 2);
        expect(original).toEqual(['a', 'b']);
    });
});

// ---------------------------------------------------------------- endpoints and paths

describe('httpFromWs and dbPathFor', () => {
    test('one field configures both the socket and the fetch', () => {
        expect(L.httpFromWs('wss://api.mainnet-beta.solana.com')).toBe('https://api.mainnet-beta.solana.com');
        expect(L.httpFromWs('ws://localhost:8899')).toBe('http://localhost:8899');
        expect(L.httpFromWs('https://rpc.example.com/x')).toBe('https://rpc.example.com/x');
        expect(L.httpFromWs('nonsense')).toBeNull();
        expect(L.httpFromWs(null)).toBeNull();
    });

    test('the page reads the published capture by default and the fixture on request', () => {
        expect(L.dbPathFor(null)).toEqual({ path: './stocks-trades.json', sample: false });
        expect(L.dbPathFor('sample')).toEqual({ path: './stocks/fixtures/stocks-trades.sample.json', sample: true });
    });

    test('an alternative capture is flagged as a fixture, and an off-origin path is refused', () => {
        expect(L.dbPathFor('stocks/data/trades-24h.json')).toEqual({ path: './stocks/data/trades-24h.json', sample: true });
        expect(L.dbPathFor('/etc/passwd.json').sample).toBe(false);
        expect(L.dbPathFor('https://evil.example.com/x.json').sample).toBe(false);
        expect(L.dbPathFor('nope.txt').sample).toBe(false);
    });
});

// ---------------------------------------------------------------- formatters

describe('formatters', () => {
    test('a size keeps small amounts visible and never rounds a real trade to nothing', () => {
        expect(L.fmtSize(1234.5678)).toBe('1,235');
        expect(L.fmtSize(12.345)).toBe('12.35');
        expect(L.fmtSize(0.0042)).toBe('0.0042');
        expect(L.fmtSize(0.00000123)).toBe('1.2e-6');
        expect(L.fmtSize(null)).toBe(L.DASH);
    });

    test('a price is full precision, an aggregate is compact', () => {
        expect(L.fmtPrice(241.3)).toBe('$241.30');
        expect(L.fmtPrice(0.1234)).toBe('$0.1234');
        expect(L.fmtMoney(1234567)).toBe('$1.23M');
        expect(L.fmtMoney(0)).toBe('$0');
        expect(L.fmtMoney(null)).toBe(L.DASH);
        expect(L.fmtCount(null)).toBe(L.DASH);
        expect(L.fmtCount(0)).toBe('0');
    });

    test('hour labels and timestamps are UTC, so they never drift by host', () => {
        expect(L.fmtHourLabel(BASE + 13 * HOUR)).toBe('13:00');
        expect(L.fmtDateTime(BASE)).toBe('16 Sep 2026 00:00 UTC');
        expect(L.fmtHourLabel(null)).toBe(L.DASH);
    });

    test('escaping covers attribute values, so a symbol can never break out of one', () => {
        expect(L.escapeHtml('<a href="x">')).toBe('&lt;a href=&quot;x&quot;&gt;');
        expect(L.escapeHtml("it's")).toBe('it&#39;s');
        expect(L.escapeHtml(null)).toBe('');
    });
});

// ---------------------------------------------------------------- polling mode

describe('pollTargets', () => {
    test('the busiest pools first, capped, and an unsampled pool sorts last rather than as a zero', () => {
        const pools = [
            { pair: 'p1', symbol: 'A', signaturesSeen: 12 },
            { pair: 'p2', symbol: 'B', signaturesSeen: 50 },
            { pair: 'p3', symbol: 'C', signaturesSeen: null },
            { pair: 'p4', symbol: 'D', signaturesSeen: 0 },
            { pair: 'p5', symbol: 'E', signaturesSeen: 31 }
        ];
        expect(L.pollTargets(pools, 3).map((p) => p.symbol)).toEqual(['B', 'E', 'A']);
        expect(L.pollTargets(pools, 99).map((p) => p.symbol)).toEqual(['B', 'E', 'A', 'D', 'C']);
    });

    test('a pool with no pair address cannot be polled and is left out', () => {
        expect(L.pollTargets([{ symbol: 'A', signaturesSeen: 99 }, { pair: 'p', symbol: 'B', signaturesSeen: 1 }], 8)
            .map((p) => p.symbol)).toEqual(['B']);
    });

    test('the default cap is the documented eight', () => {
        const many = Array.from({ length: 15 }, (_, i) => ({ pair: `p${i}`, symbol: `S${i}`, signaturesSeen: i }));
        expect(L.pollTargets(many)).toHaveLength(L.POLL_POOLS);
        expect(L.pollTargets(null)).toEqual([]);
    });
});

describe('newSignatures', () => {
    const page = [
        { signature: 's5', err: null },
        { signature: 's4', err: { InstructionError: [0, 'x'] } },
        { signature: 's3', err: null },
        { signature: 's2', err: null },
        { signature: 's1', err: null }
    ];

    test('the first round only remembers where the chain is', () => {
        const step = L.newSignatures(page, null);
        expect(step.seeded).toBe(true);
        expect(step.newest).toBe('s5');
        expect(step.fresh).toEqual([]);
        expect(step.ok).toEqual([]);
        expect(step.failed).toBe(0);
    });

    test('a later round reports only what appeared above the cursor, oldest first', () => {
        const step = L.newSignatures(page, 's2');
        expect(step.seeded).toBe(false);
        expect(step.fresh).toEqual(['s3', 's4', 's5']);
        expect(step.newest).toBe('s5');
    });

    test('failed and successful new signatures are split: only the successful ones are worth fetching', () => {
        const step = L.newSignatures(page, 's2');
        expect(step.failed).toBe(1);
        expect(step.ok).toEqual(['s3', 's5']);
        expect(step.ok).not.toContain('s4');
    });

    test('nothing new is nothing reported, and the cursor does not move backwards', () => {
        const step = L.newSignatures(page, 's5');
        expect(step.fresh).toEqual([]);
        expect(step.failed).toBe(0);
        expect(step.newest).toBe('s5');
    });

    test('a cursor no longer on the page means every signature on it is new', () => {
        const step = L.newSignatures(page, 'gone');
        expect(step.fresh).toEqual(['s1', 's2', 's3', 's4', 's5']);
        expect(step.failed).toBe(1);
    });

    test('an empty page keeps the cursor it was given', () => {
        expect(L.newSignatures([], 's5')).toEqual({ seeded: false, newest: 's5', fresh: [], ok: [], failed: 0 });
        expect(L.newSignatures(null, null).newest).toBeNull();
    });
});

describe('backoffSeconds', () => {
    test('a good round polls at the base interval', () => {
        expect(L.backoffSeconds(48, false)).toBe(L.POLL_SECONDS);
        expect(L.backoffSeconds(null, false)).toBe(L.POLL_SECONDS);
    });

    test('a 429 doubles the interval up to the ceiling, and stays there', () => {
        const ladder = [];
        let current = L.POLL_SECONDS;
        for (let i = 0; i < 5; i++) {
            current = L.backoffSeconds(current, true);
            ladder.push(current);
        }
        expect(ladder).toEqual([24, 48, 60, 60, 60]);
        expect(current).toBe(L.POLL_MAX_SECONDS);
    });

    test('one good round after a backoff returns to the base, not to the ceiling', () => {
        expect(L.backoffSeconds(L.POLL_MAX_SECONDS, false)).toBe(L.POLL_SECONDS);
    });
});

describe('versionFromError', () => {
    test('the version a -32015 refusal names is read back for the retry', () => {
        expect(L.versionFromError({ code: -32015, message: 'Transaction version (0) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": 0' })).toBe(0);
        expect(L.versionFromError({ code: -32015, message: 'please pass "maxSupportedTransactionVersion": 2' })).toBe(2);
        expect(L.versionFromError({ code: -32015, message: 'Transaction version (1) is not supported' })).toBe(1);
    });

    test('any other error names no version, so nothing is retried blindly', () => {
        expect(L.versionFromError({ code: -32602, message: 'Invalid param: "maxSupportedTransactionVersion": 0' })).toBeNull();
        expect(L.versionFromError({ code: -32015, message: 'unsupported' })).toBeNull();
        expect(L.versionFromError(null)).toBeNull();
    });
});

describe('clearRuntime', () => {
    /** The live runtime as the page holds it, mid-session. */
    function runtime() {
        return {
            on: true, mode: 'poll', status: 'polling',
            queue: ['a', 'b'],
            pendingPools: new Map([['a', {}]]),
            subscriptions: new Map([[1, {}]]),
            pendingRequests: new Map([[2, {}]]),
            cursors: new Map([['pair', 'sig']]),
            inFlight: true, polling: true,
            logs: 7, failed: 3, decoded: 4, undecodable: 1, dropped: 2,
            retryIndex: 3, retryTicks: 9, retryBase: 'closed',
            intervalSeconds: 48, nextPollSeconds: 40, error: 'something'
        };
    }

    test('a mode switch drops the queue, the cursors and the subscriptions', () => {
        const live = L.clearRuntime(runtime());
        expect(live.queue).toEqual([]);
        expect(live.cursors.size).toBe(0);
        expect(live.subscriptions.size).toBe(0);
        expect(live.pendingRequests.size).toBe(0);
        expect(live.pendingPools.size).toBe(0);
        expect(live.inFlight).toBe(false);
        expect(live.polling).toBe(false);
    });

    test('the arrival counters are zeroed, so one mode never reports the other mode\'s traffic', () => {
        const live = L.clearRuntime(runtime());
        expect([live.logs, live.failed, live.decoded, live.undecodable, live.dropped]).toEqual([0, 0, 0, 0, 0]);
        expect(live.error).toBeNull();
    });

    test('the backoff and the retry ladder reset to their base', () => {
        const live = L.clearRuntime(runtime());
        expect(live.intervalSeconds).toBe(L.POLL_SECONDS);
        expect(live.nextPollSeconds).toBe(0);
        expect(live.retryIndex).toBe(0);
        expect(live.retryTicks).toBe(0);
        expect(live.retryBase).toBeNull();
    });

    test('which mode is selected, and whether the reader asked for it, are not touched', () => {
        const live = L.clearRuntime(runtime());
        expect(live.mode).toBe('poll');
        expect(live.on).toBe(true);
    });

    test('nothing to clear does not throw', () => {
        expect(() => L.clearRuntime(null)).not.toThrow();
    });
});
