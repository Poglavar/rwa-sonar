/**
 * Renders live.html (stocks/MODEL.md §12.3): the tape of the newest decoded swaps on the sampled
 * Solana DEX pools, an optional "Go live" RPC log subscription that decodes swaps as they confirm,
 * and a replay of the 24 collected hourly buckets as stacked bars with a sweeping cursor. Every
 * piece of shaping and maths lives in the pure section at the top — no DOM, no fetch, no clock —
 * and is exported for jest; the page below only builds DOM and wires events. The swap decode is not
 * reimplemented here: the page imports the collector's own `decodeTrade` from stocks/lib/trades.mjs,
 * so a live trade and a stored one are read by one rule. Wrapped in an IIFE so it declares no
 * globals and cannot shadow a top-level name in another classic script.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.__live = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // -----------------------------------------------------------------------
    // Pure section — no DOM, no fetch, no Date.now(). Exported for jest.
    // -----------------------------------------------------------------------

    /** What a missing value renders as. Never 0, never "null". */
    const DASH = '—';

    const SOLSCAN_TX = 'https://solscan.io/tx/';
    const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const SECOND_MS = 1000;
    const MINUTE_MS = 60 * SECOND_MS;
    const HOUR_MS = 60 * MINUTE_MS;
    const DAY_MS = 24 * HOUR_MS;

    /** The tape never shows more than this many rows, live arrivals included. */
    const TAPE_LIMIT = 20;
    /** Signatures waiting to be fetched; over this the oldest are dropped and counted. */
    const QUEUE_CAP = 50;
    /** How many hourly buckets the replay covers. */
    const REPLAY_HOURS = 24;
    /** Cursor steps per hour and the tick between them: 24 h × 10 steps × 125 ms ≈ 30 s a lap. */
    const REPLAY_STEPS_PER_HOUR = 10;
    const REPLAY_TICK_MS = 125;
    /** Polling mode: how many pools a round covers, how many signatures it asks each for. */
    const POLL_POOLS = 8;
    const POLL_LIMIT = 20;
    /** Seconds between polling rounds, and the ceiling the 429 backoff doubles towards. */
    const POLL_SECONDS = 12;
    const POLL_MAX_SECONDS = 60;
    /** Colour slots in live.css (.venue-0 … .venue-7); venue 8+ shares the last, neutral slot. */
    const VENUE_SLOTS = 8;

    /**
     * Hand-kept venue names, so "raydium" renders as "Raydium" and "meteoradbc" as "Meteora DBC".
     * A dexId absent from here is title-cased from its own slug rather than given an invented name.
     */
    const DEX_LABELS = {
        raydium: 'Raydium',
        'raydium-clmm': 'Raydium CLMM',
        'raydium-cpmm': 'Raydium CPMM',
        raydiumclmm: 'Raydium CLMM',
        orca: 'Orca',
        whirlpool: 'Orca Whirlpool',
        meteora: 'Meteora',
        meteoradbc: 'Meteora DBC',
        'meteora-dlmm': 'Meteora DLMM',
        jupiter: 'Jupiter',
        lifinity: 'Lifinity',
        phoenix: 'Phoenix',
        openbook: 'OpenBook',
        pumpswap: 'PumpSwap',
        fluxbeam: 'FluxBeam',
        solfi: 'SolFi',
        obric: 'Obric',
        saber: 'Saber',
        invariant: 'Invariant',
        stabble: 'Stabble',
        sanctum: 'Sanctum'
    };

    /** True only for a real, finite number — so a null never becomes 0 downstream. */
    function isNum(value) {
        return typeof value === 'number' && Number.isFinite(value);
    }

    /** Escapes text for interpolation into HTML, attribute values included. */
    function escapeHtml(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
    }

    /** "raydium" -> "Raydium"; "some-new-amm" -> "Some New Amm"; null -> "—". */
    function humanizeDex(dexId) {
        if (typeof dexId !== 'string' || !dexId.trim()) return DASH;
        const slug = dexId.trim().toLowerCase();
        if (DEX_LABELS[slug]) return DEX_LABELS[slug];
        return slug
            .split(/[-_\s]+/)
            .filter(Boolean)
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }

    /**
     * A trade's instant in epoch milliseconds, whatever the collector wrote: an ISO string, epoch
     * seconds or epoch milliseconds. Never invents one — an absent or unparseable time is null, so
     * the tape prints a dash instead of pretending the trade just happened.
     */
    function tradeTimeMs(time) {
        if (isNum(time)) {
            // A Solana blockTime is seconds; anything past year 2286 in seconds is already ms.
            return time > 1e12 ? time : time * SECOND_MS;
        }
        if (typeof time === 'string' && time.trim()) {
            const ms = new Date(time).getTime();
            return Number.isFinite(ms) ? ms : null;
        }
        return null;
    }

    /**
     * The tape's age string, ticking by the second: "now", "12 s ago", "4 min ago", "3 h ago",
     * "2 d ago". A timestamp ahead of our clock prints "in 12 s" rather than a trade that has not
     * happened yet. `nowMs` is injected so tests do not depend on the wall clock.
     */
    function fmtAgo(timeMs, nowMs) {
        const then = tradeTimeMs(timeMs);
        if (then === null || !isNum(nowMs)) return DASH;
        const diff = nowMs - then;
        const abs = Math.abs(diff);
        if (abs < SECOND_MS) return 'now';
        let magnitude;
        if (abs < MINUTE_MS) magnitude = `${Math.floor(abs / SECOND_MS)} s`;
        else if (abs < HOUR_MS) magnitude = `${Math.floor(abs / MINUTE_MS)} min`;
        else if (abs < DAY_MS) magnitude = `${Math.floor(abs / HOUR_MS)} h`;
        else magnitude = `${Math.floor(abs / DAY_MS)} d`;
        return diff < 0 ? `in ${magnitude}` : `${magnitude} ago`;
    }

    /** "2026-09-16T22:14:00Z" -> "16 Sep 2026 22:14 UTC"; always UTC, so it never drifts by host. */
    function fmtDateTime(value) {
        const ms = tradeTimeMs(value);
        if (ms === null) return DASH;
        const d = new Date(ms);
        const hh = String(d.getUTCHours()).padStart(2, '0');
        const mm = String(d.getUTCMinutes()).padStart(2, '0');
        return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${hh}:${mm} UTC`;
    }

    /** "22:00" in UTC for an hour bucket label; a missing hour is a dash. */
    function fmtHourLabel(value) {
        const ms = tradeTimeMs(value);
        if (ms === null) return DASH;
        const d = new Date(ms);
        return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    }

    /** A token amount: "1,234.5" / "0.0042" / "—". Never rounds a real amount down to 0. */
    function fmtSize(value) {
        if (!isNum(value)) return DASH;
        const abs = Math.abs(value);
        if (abs === 0) return '0';
        if (abs >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
        if (abs >= 1) return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
        if (abs < 0.0001) return value.toExponential(1);
        return value.toFixed(4);
    }

    /** Full-precision USD for one price: "$241.35" / "$0.0042" / "—". */
    function fmtPrice(value) {
        if (!isNum(value)) return DASH;
        const abs = Math.abs(value);
        const digits = abs > 0 && abs < 1 ? 4 : 2;
        return '$' + value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    }

    /**
     * A price in the quote token, for a pool with no USD rate: "240" / "1.0042" / "0.000512". Keeps
     * more decimals than a size would, because the decimals of a price are the price — rendering
     * 1.0042 SOL as "1 SOL" would report a premium of nothing.
     */
    function fmtQuotePrice(value) {
        if (!isNum(value)) return DASH;
        const abs = Math.abs(value);
        let digits = 6;
        if (abs >= 1000) digits = 2;
        else if (abs >= 1) digits = 4;
        return value.toLocaleString('en-US', { maximumFractionDigits: digits });
    }

    /** Compact USD for an aggregate: "$1.23B" / "$4.56M" / "$78.9k" / "$12.34" / "$0" / "—". */
    function fmtMoney(value) {
        if (!isNum(value)) return DASH;
        const abs = Math.abs(value);
        if (abs >= 1e9) return '$' + (value / 1e9).toFixed(2) + 'B';
        if (abs >= 1e6) return '$' + (value / 1e6).toFixed(2) + 'M';
        if (abs >= 1e3) return '$' + (value / 1e3).toFixed(1) + 'k';
        if (abs >= 1) return '$' + value.toFixed(2);
        if (value === 0) return '$0';
        if (abs < 0.01) return '<$0.01';
        return '$' + value.toFixed(2);
    }

    /** 1234567 -> "1,234,567"; null -> "—". */
    function fmtCount(value) {
        if (!isNum(value)) return DASH;
        return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
    }

    /**
     * A 0–1 share as a percentage: `totals.failedShare` is Σ failedTx / Σ signaturesSeen (see
     * `stocks/lib/trades.mjs`), and null — never 0 — when no signatures were seen at all.
     */
    function fmtShare(value) {
        if (!isNum(value)) return DASH;
        return (value * 100).toFixed(1) + '%';
    }

    /** ▲ for a buy, ▼ for a sell, · when the decode could not tell. */
    function sideGlyph(side) {
        if (side === 'buy') return '▲';
        if (side === 'sell') return '▼';
        return '·';
    }

    /** Which data file the page reads, and whether that is the bundled fixture. */
    function dbPathFor(param) {
        const TRADES_PATH = './stocks-trades.json';
        const SAMPLE_PATH = './stocks/fixtures/stocks-trades.sample.json';
        if (param === 'sample') return { path: SAMPLE_PATH, sample: true };
        // A dev affordance: any same-origin relative .json path, so an alternative capture can be
        // loaded without a rebuild. Absolute and protocol-relative paths are refused.
        if (typeof param === 'string' && /^[\w./-]+\.json$/.test(param) && !param.startsWith('/')) {
            return { path: './' + param.replace(/^\.\//, ''), sample: true };
        }
        return { path: TRADES_PATH, sample: false };
    }

    /**
     * One tape row's display fields. Every number may be absent, and an absent one stays absent:
     * no size becomes a dash, not 0, and a trade with no USD price falls back to the quote price
     * ("1.0042 USDC") so the row still says what it traded at, with `priceSource` naming which.
     */
    function tapeRow(trade, nowMs) {
        const t = trade && typeof trade === 'object' ? trade : {};
        const timeMs = tradeTimeMs(t.time);
        const side = t.side === 'buy' || t.side === 'sell' ? t.side : null;
        const hasUsd = isNum(t.priceUsd);
        const hasQuote = isNum(t.priceQuote);
        let price = DASH;
        let priceSource = 'none';
        if (hasUsd) {
            price = fmtPrice(t.priceUsd);
            priceSource = 'usd';
        } else if (hasQuote) {
            price = fmtQuotePrice(t.priceQuote) + (t.quoteSymbol ? ' ' + t.quoteSymbol : '');
            priceSource = 'quote';
        }
        return {
            sig: typeof t.sig === 'string' && t.sig.trim() ? t.sig : null,
            solscanUrl: typeof t.sig === 'string' && t.sig.trim() ? SOLSCAN_TX + t.sig : null,
            symbol: typeof t.symbol === 'string' && t.symbol.trim() ? t.symbol : (typeof t.mint === 'string' && t.mint ? t.mint.slice(0, 4) + '…' : DASH),
            mint: typeof t.mint === 'string' && t.mint ? t.mint : null,
            venue: typeof t.dex === 'string' && t.dex ? t.dex.toLowerCase() : null,
            venueLabel: humanizeDex(t.dex),
            side,
            sideLabel: side || DASH,
            sideGlyph: sideGlyph(side),
            size: fmtSize(t.size),
            price,
            priceSource,
            quoteAmount: fmtMoney(isNum(t.quoteAmount) && isNum(t.priceUsd) && isNum(t.priceQuote) && t.priceQuote !== 0
                ? t.quoteAmount * (t.priceUsd / t.priceQuote)
                : null),
            timeMs,
            age: fmtAgo(timeMs, nowMs),
            absoluteTime: fmtDateTime(timeMs),
            routed: t.routed === true,
            feePayer: typeof t.feePayer === 'string' && t.feePayer ? t.feePayer : null,
            programCount: Array.isArray(t.programs) ? t.programs.length : null
        };
    }

    /** One pool chip: symbol · venue · decoded · failed %, with the raw counts for the tooltip. */
    function poolChip(pool) {
        const p = pool && typeof pool === 'object' ? pool : {};
        const seen = isNum(p.signaturesSeen) ? p.signaturesSeen : null;
        const failed = isNum(p.failedTx) ? p.failedTx : null;
        const failedPct = seen !== null && failed !== null && seen > 0 ? (failed / seen) * 100 : null;
        return {
            pair: typeof p.pair === 'string' && p.pair ? p.pair : null,
            symbol: typeof p.symbol === 'string' && p.symbol.trim() ? p.symbol : DASH,
            venue: typeof p.dex === 'string' && p.dex ? p.dex.toLowerCase() : null,
            venueLabel: humanizeDex(p.dex),
            decoded: fmtCount(isNum(p.decoded) ? p.decoded : null),
            undecodable: fmtCount(isNum(p.undecodable) ? p.undecodable : null),
            signaturesSeen: fmtCount(seen),
            failedTx: fmtCount(failed),
            failedPct: failedPct === null ? DASH : failedPct.toFixed(0) + '%',
            quoteSymbol: typeof p.quoteSymbol === 'string' && p.quoteSymbol ? p.quoteSymbol : null
        };
    }

    /**
     * Venue stacking and legend order: most traded first over the whole window, alphabetical on a
     * tie, and every sampled pool's venue included even when it produced no decoded trade — a
     * sampled venue with nothing to show is a finding, not an absence.
     */
    function venueOrder(db) {
        const totals = new Map();
        const buckets = db && Array.isArray(db.hourly) ? db.hourly : [];
        for (const bucket of buckets) {
            const byDex = bucket && bucket.byDex && typeof bucket.byDex === 'object' ? bucket.byDex : {};
            for (const dexId of Object.keys(byDex)) {
                const entry = byDex[dexId] || {};
                const trades = isNum(entry.trades) ? entry.trades : 0;
                totals.set(dexId, (totals.get(dexId) || 0) + trades);
            }
        }
        for (const pool of (db && Array.isArray(db.pools) ? db.pools : [])) {
            const dexId = pool && typeof pool.dex === 'string' ? pool.dex.toLowerCase() : null;
            if (dexId && !totals.has(dexId)) totals.set(dexId, 0);
        }
        return [...totals.entries()]
            .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
            .map(([dexId], index) => ({
                dexId,
                label: humanizeDex(dexId),
                trades: totals.get(dexId),
                slot: Math.min(index, VENUE_SLOTS - 1)
            }));
    }

    /** One bucket's value for the chosen metric, summed over venues; null when nothing is known. */
    function bucketValue(bucket, dexId, mode) {
        const byDex = bucket && bucket.byDex && typeof bucket.byDex === 'object' ? bucket.byDex : null;
        if (!byDex) return null;
        const key = mode === 'volume' ? 'volumeUsd' : 'trades';
        if (dexId !== null && dexId !== undefined) {
            const entry = byDex[dexId];
            return entry && isNum(entry[key]) ? entry[key] : null;
        }
        let sum = null;
        for (const id of Object.keys(byDex)) {
            const entry = byDex[id];
            if (entry && isNum(entry[key])) sum = (sum === null ? 0 : sum) + entry[key];
        }
        return sum;
    }

    /**
     * Bar geometry for the replay timeline: one band per hourly bucket, stacked by venue in
     * `venues` order, scaled to the tallest bucket. A bucket whose hour began before
     * `collectingSinceMs` is marked `hatched` — it was never fully sampled, so its height is not
     * comparable with a complete hour and must not look like one.
     */
    function barGeometry(hourly, options) {
        const opts = options || {};
        const width = isNum(opts.width) ? opts.width : 960;
        const height = isNum(opts.height) ? opts.height : 160;
        const gap = isNum(opts.gap) ? opts.gap : 3;
        const mode = opts.mode === 'volume' ? 'volume' : 'trades';
        const venues = Array.isArray(opts.venues) ? opts.venues : [];
        const collectingSinceMs = isNum(opts.collectingSinceMs) ? opts.collectingSinceMs : null;
        const buckets = Array.isArray(hourly) ? hourly : [];
        const bandWidth = buckets.length > 0 ? width / buckets.length : 0;
        const barWidth = Math.max(1, bandWidth - gap);

        let max = 0;
        for (const bucket of buckets) {
            const total = bucketValue(bucket, null, mode);
            if (isNum(total) && total > max) max = total;
        }

        const bars = buckets.map((bucket, index) => {
            const hourStartMs = tradeTimeMs(bucket && bucket.hourStart);
            const total = bucketValue(bucket, null, mode);
            const segments = [];
            let stacked = 0;
            for (const venue of venues) {
                const value = bucketValue(bucket, venue.dexId, mode);
                if (!isNum(value) || value <= 0) continue;
                const segHeight = max > 0 ? (value / max) * height : 0;
                stacked += segHeight;
                segments.push({
                    dexId: venue.dexId,
                    label: venue.label,
                    slot: venue.slot,
                    value,
                    y: height - stacked,
                    height: segHeight
                });
            }
            return {
                index,
                hourStart: bucket && bucket.hourStart !== undefined ? bucket.hourStart : null,
                hourStartMs,
                hourLabel: fmtHourLabel(hourStartMs),
                x: index * bandWidth,
                width: barWidth,
                total,
                segments,
                hatched: collectingSinceMs !== null && hourStartMs !== null && hourStartMs < collectingSinceMs
            };
        });

        return { bars, max, bandWidth, barWidth, width, height, mode };
    }

    /**
     * What the counters above the cursor read at hour `hourIndex` (inclusive): the hours the cursor
     * has passed, summed. Distinct traders are counted from the trades themselves — the hourly
     * buckets count traders per hour and per venue, and those sets overlap, so summing them would
     * overstate the number. When the trade list is absent the per-bucket counts are summed instead
     * and `tradersExact` says false, so the page can label it honestly.
     */
    function countersUpTo(hourly, trades, hourIndex, options) {
        const opts = options || {};
        const buckets = Array.isArray(hourly) ? hourly : [];
        const last = Math.min(isNum(hourIndex) ? Math.floor(hourIndex) : -1, buckets.length - 1);
        let tradeCount = null;
        let volumeUsd = null;
        let buys = null;
        let sells = null;
        let bucketTraders = null;

        for (let i = 0; i <= last; i++) {
            const byDex = buckets[i] && buckets[i].byDex && typeof buckets[i].byDex === 'object' ? buckets[i].byDex : {};
            for (const dexId of Object.keys(byDex)) {
                const entry = byDex[dexId] || {};
                if (isNum(entry.trades)) tradeCount = (tradeCount === null ? 0 : tradeCount) + entry.trades;
                if (isNum(entry.volumeUsd)) volumeUsd = (volumeUsd === null ? 0 : volumeUsd) + entry.volumeUsd;
                if (isNum(entry.buys)) buys = (buys === null ? 0 : buys) + entry.buys;
                if (isNum(entry.sells)) sells = (sells === null ? 0 : sells) + entry.sells;
                if (isNum(entry.traders)) bucketTraders = (bucketTraders === null ? 0 : bucketTraders) + entry.traders;
            }
        }

        const hourStartMs = last >= 0 ? tradeTimeMs(buckets[last].hourStart) : null;
        const windowStartMs = buckets.length > 0 ? tradeTimeMs(buckets[0].hourStart) : null;
        const windowEndMs = hourStartMs !== null ? hourStartMs + HOUR_MS : null;

        let traders = bucketTraders;
        let tradersExact = false;
        // An hour that was never collected has no trade count, so it can have no trader count
        // either: counting an empty set would print a confident 0 next to a dash.
        if (tradeCount === null) {
            traders = null;
        } else if (Array.isArray(trades) && windowEndMs !== null) {
            const wallets = new Set();
            for (const trade of trades) {
                const t = tradeTimeMs(trade && trade.time);
                if (t === null || t >= windowEndMs) continue;
                if (windowStartMs !== null && t < windowStartMs) continue;
                if (trade && typeof trade.feePayer === 'string' && trade.feePayer) wallets.add(trade.feePayer);
            }
            traders = wallets.size;
            tradersExact = true;
        }

        return {
            hourIndex: last,
            hours: last + 1,
            hourLabel: last >= 0 ? fmtHourLabel(hourStartMs) : DASH,
            hourStartMs,
            trades: tradeCount,
            volumeUsd,
            buys,
            sells,
            traders,
            tradersExact,
            failedShare: isNum(opts.failedShare) ? opts.failedShare : null
        };
    }

    /**
     * The fetch queue: at most `cap` signatures waiting, newest kept. A signature already queued
     * or already seen is not queued twice, and every signature pushed out by the cap is counted as
     * dropped so the page can show "throttled n" instead of quietly losing trades.
     */
    function queuePush(queue, sig, cap) {
        const limit = isNum(cap) && cap > 0 ? Math.floor(cap) : QUEUE_CAP;
        const next = Array.isArray(queue) ? queue.slice() : [];
        if (typeof sig !== 'string' || !sig.trim()) return { queue: next, dropped: 0, added: false };
        if (next.includes(sig)) return { queue: next, dropped: 0, added: false };
        next.push(sig);
        let dropped = 0;
        while (next.length > limit) {
            next.shift();
            dropped += 1;
        }
        return { queue: next, dropped, added: true };
    }

    /** wss://host/path -> https://host/path, so one field configures both the socket and the fetch. */
    function httpFromWs(url) {
        if (typeof url !== 'string' || !url.trim()) return null;
        const trimmed = url.trim();
        if (/^wss:\/\//i.test(trimmed)) return 'https://' + trimmed.slice(6);
        if (/^ws:\/\//i.test(trimmed)) return 'http://' + trimmed.slice(5);
        if (/^https?:\/\//i.test(trimmed)) return trimmed;
        return null;
    }

    /** The header sentence: what was collected, over how many pools, and how much was bot spam. */
    function collectionLine(db) {
        const d = db && typeof db === 'object' ? db : {};
        const pools = Array.isArray(d.pools) ? d.pools.length : null;
        const totals = d.totals && typeof d.totals === 'object' ? d.totals : {};
        const since = fmtDateTime(d.collectingSince);
        const poolPhrase = pools === null ? `${DASH} pools sampled` : `${pools} pool${pools === 1 ? '' : 's'} sampled`;
        return `Collected since ${since}, ${poolPhrase}, ${fmtShare(totals.failedShare)} of transactions failed (bot spam).`;
    }

    /**
     * The pools a polling round asks about: the busiest by `signaturesSeen`, because a round costs
     * one request per pool and the quiet pools would spend the budget on nothing. A pool with no
     * signature count sorts last rather than being treated as a zero.
     */
    function pollTargets(pools, limit) {
        const max = isNum(limit) && limit > 0 ? Math.floor(limit) : POLL_POOLS;
        const list = (Array.isArray(pools) ? pools : []).filter((pool) => pool && typeof pool.pair === 'string' && pool.pair);
        const ranked = list.slice().sort((a, b) => {
            const av = isNum(a.signaturesSeen) ? a.signaturesSeen : -1;
            const bv = isNum(b.signaturesSeen) ? b.signaturesSeen : -1;
            if (av !== bv) return bv - av;
            return String(a.symbol || a.pair).localeCompare(String(b.symbol || b.pair));
        });
        return ranked.slice(0, max);
    }

    /**
     * What one `getSignaturesForAddress` page adds since the last round. `entries` are newest first;
     * everything above the remembered `cursor` is new, split into the ones that reverted (counted,
     * never fetched — they changed no balance) and the ones worth a `getTransaction`. Returned
     * oldest first, so the tape fills in the order the chain produced.
     *
     * A first round (`cursor === null`) only seeds the cursor: it reports nothing new, because every
     * signature already on the pool is history the collector's capture already covers, and queueing
     * twenty per pool would blow the queue on arrival.
     */
    function newSignatures(entries, cursor) {
        const list = (Array.isArray(entries) ? entries : []).filter((e) => e && typeof e.signature === 'string' && e.signature);
        const newest = list.length > 0 ? list[0].signature : null;
        if (typeof cursor !== 'string' || !cursor) {
            return { seeded: true, newest, fresh: [], ok: [], failed: 0 };
        }
        const fresh = [];
        for (const entry of list) {
            if (entry.signature === cursor) break;
            fresh.push(entry);
        }
        fresh.reverse();
        return {
            seeded: false,
            newest: newest === null ? cursor : newest,
            fresh: fresh.map((entry) => entry.signature),
            ok: fresh.filter((entry) => !entry.err).map((entry) => entry.signature),
            failed: fresh.filter((entry) => Boolean(entry.err)).length
        };
    }

    /**
     * The seconds until the next polling round: the base interval normally, doubled on every 429 up
     * to the ceiling. A rate limit is the endpoint asking for less traffic, so the answer is to ask
     * less often — and one good round returns to the base, rather than staying punished.
     */
    function backoffSeconds(current, rateLimited, options) {
        const opts = options || {};
        const base = isNum(opts.base) ? opts.base : POLL_SECONDS;
        const max = isNum(opts.max) ? opts.max : POLL_MAX_SECONDS;
        if (!rateLimited) return base;
        const from = isNum(current) && current > 0 ? current : base;
        return Math.min(max, from * 2);
    }

    /**
     * The transaction version an RPC error demands. A versioned transaction fetched with a lower
     * `maxSupportedTransactionVersion` comes back as error -32015 naming the parameter to use, and
     * the request succeeds on a second attempt — so the version is read from the message rather
     * than the transaction being written off as undecodable.
     */
    function versionFromError(error) {
        if (!error || error.code !== -32015) return null;
        const message = typeof error.message === 'string' ? error.message : '';
        const named = message.match(/maxSupportedTransactionVersion"?\s*:?\s*(\d+)/i);
        if (named) return Number(named[1]);
        const version = message.match(/version\s*\((\d+)\)/i);
        return version ? Number(version[1]) : null;
    }

    /**
     * Tears down whatever the previous live mode left behind: queued signatures, poll cursors,
     * subscriptions and the arrival counters. Switching mode starts a fresh attempt, and carrying a
     * WebSocket's counters into a polling run would report arrivals the new mode never saw. `on` and
     * `mode` belong to the caller and are deliberately untouched.
     */
    function clearRuntime(live) {
        if (!live || typeof live !== 'object') return live;
        live.queue = [];
        if (live.pendingPools && typeof live.pendingPools.clear === 'function') live.pendingPools.clear();
        if (live.subscriptions && typeof live.subscriptions.clear === 'function') live.subscriptions.clear();
        if (live.pendingRequests && typeof live.pendingRequests.clear === 'function') live.pendingRequests.clear();
        if (live.cursors && typeof live.cursors.clear === 'function') live.cursors.clear();
        live.inFlight = false;
        live.polling = false;
        live.logs = 0;
        live.failed = 0;
        live.decoded = 0;
        live.undecodable = 0;
        live.dropped = 0;
        live.retryIndex = 0;
        live.retryTicks = 0;
        live.retryBase = null;
        live.intervalSeconds = POLL_SECONDS;
        live.nextPollSeconds = 0;
        live.error = null;
        return live;
    }

    const api = {
        DASH,
        SOLSCAN_TX,
        TAPE_LIMIT,
        QUEUE_CAP,
        POLL_POOLS,
        POLL_LIMIT,
        POLL_SECONDS,
        POLL_MAX_SECONDS,
        REPLAY_HOURS,
        REPLAY_STEPS_PER_HOUR,
        REPLAY_TICK_MS,
        VENUE_SLOTS,
        DEX_LABELS,
        isNum,
        escapeHtml,
        humanizeDex,
        tradeTimeMs,
        fmtAgo,
        fmtDateTime,
        fmtHourLabel,
        fmtSize,
        fmtPrice,
        fmtQuotePrice,
        fmtMoney,
        fmtCount,
        fmtShare,
        sideGlyph,
        dbPathFor,
        tapeRow,
        poolChip,
        venueOrder,
        bucketValue,
        barGeometry,
        countersUpTo,
        queuePush,
        httpFromWs,
        collectionLine,
        pollTargets,
        newSignatures,
        backoffSeconds,
        versionFromError,
        clearRuntime
    };

    if (typeof document === 'undefined') return api;

    // -----------------------------------------------------------------------
    // Page — DOM and events only. Timers: the 1 s age tick (which also paces the
    // live fetch queue and retries the socket), the 60 s re-read, the replay cursor.
    // -----------------------------------------------------------------------

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const TICK_MS = 1000;
    const RELOAD_MS = 60000;
    /**
     * Polling is the default because, measured from a real browser page on 2026-09-16:
     * `wss://api.mainnet-beta.solana.com` closes with 1006 and its HTTPS side answers 403 "Access
     * forbidden" to a browser origin; `wss://solana-rpc.publicnode.com` accepts logsSubscribe and
     * then pushes nothing at all (also from node); `https://solana-rpc.publicnode.com` answers
     * getSignaturesForAddress cross-origin in ~140 ms. So the working path is asking, not listening.
     */
    const DEFAULT_HTTP = 'https://solana-rpc.publicnode.com';
    const DEFAULT_WS = 'wss://api.mainnet-beta.solana.com';
    const BUILD_HINT = 'Build it with "node stocks/fetch-recent-trades.mjs --run"';
    /** The tape geometry the SVG is drawn in; CSS scales it, so these are not screen pixels. */
    const CHART = { width: 960, height: 170, gap: 3, axisHeight: 26 };
    /** Reconnect backoff, in one-second ticks: 2 s, 4 s, 8 s, 16 s, then every 30 s. */
    const RETRY_TICKS = [2, 4, 8, 16, 30];

    document.addEventListener('DOMContentLoaded', () => {
        const els = {
            status: document.getElementById('status'),
            sampleBanner: document.getElementById('sampleBanner'),
            sampleBannerPath: document.getElementById('sampleBannerPath'),
            dataAsOf: document.getElementById('dataAsOf'),
            collectionLine: document.getElementById('collectionLine'),
            poolChips: document.getElementById('poolChips'),
            tape: document.getElementById('tape'),
            tapeNote: document.getElementById('tapeNote'),
            goLive: document.getElementById('goLive'),
            rpcUrl: document.getElementById('rpcUrl'),
            modePoll: document.getElementById('modePoll'),
            modeWs: document.getElementById('modeWs'),
            liveState: document.getElementById('liveState'),
            liveCounters: document.getElementById('liveCounters'),
            liveError: document.getElementById('liveError'),
            replayMetric: document.getElementById('replayMetric'),
            replayPlay: document.getElementById('replayPlay'),
            replayRestart: document.getElementById('replayRestart'),
            replayStepBack: document.getElementById('replayStepBack'),
            replayStepFwd: document.getElementById('replayStepFwd'),
            replayCounters: document.getElementById('replayCounters'),
            replaySvg: document.getElementById('replaySvg'),
            replayBars: document.getElementById('replayBars'),
            replayAxis: document.getElementById('replayAxis'),
            replayCursor: document.getElementById('replayCursor'),
            replayCaption: document.getElementById('replayCaption'),
            venueLegend: document.getElementById('venueLegend')
        };

        const reduceMotion = typeof window.matchMedia === 'function' &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        const state = {
            path: './stocks-trades.json',
            sample: false,
            generatedAt: null,
            db: null,
            venues: [],
            /** Tape rows: collected trades plus anything the live socket has decoded, newest first. */
            trades: [],
            liveTrades: [],
            seen: new Set(),
            metric: 'trades',
            /** Cursor position in tenths of an hour, 0 … REPLAY_HOURS × REPLAY_STEPS_PER_HOUR. */
            cursorStep: 0,
            playing: false,
            replayTimer: null,
            live: {
                on: false,
                /** 'poll' asks over HTTPS; 'ws' listens, when the reader has a provider endpoint. */
                mode: 'poll',
                /** The endpoint per mode, so switching back does not lose an edited URL. */
                urls: { poll: DEFAULT_HTTP, ws: DEFAULT_WS },
                socket: null,
                status: 'off',
                subscriptions: new Map(),
                pendingRequests: new Map(),
                /** signature -> the pool whose log mentioned it, so the decode knows the mints. */
                pendingPools: new Map(),
                /** pair -> newest signature already accounted for, so a round only reports new ones. */
                cursors: new Map(),
                queue: [],
                inFlight: false,
                polling: false,
                requestId: 0,
                intervalSeconds: POLL_SECONDS,
                nextPollSeconds: 0,
                logs: 0,
                failed: 0,
                decoded: 0,
                undecodable: 0,
                dropped: 0,
                retryIndex: 0,
                retryTicks: 0,
                retryBase: null,
                error: null,
                /** The collector's own decode, imported on demand; see ensureDecode(). */
                decode: null,
                decodePromise: null
            }
        };

        wireEvents();
        loadPage();
        window.setInterval(onTick, TICK_MS);
        window.setInterval(reload, RELOAD_MS);

        // --- data ----------------------------------------------------------

        async function loadPage() {
            const chosen = dbPathFor(new URLSearchParams(window.location.search).get('db'));
            state.path = chosen.path;
            state.sample = chosen.sample;
            els.rpcUrl.value = state.live.urls.poll;
            els.modePoll.checked = true;
            if (chosen.sample) {
                els.sampleBannerPath.textContent = chosen.path;
                els.sampleBanner.hidden = false;
            }
            await reload(true);
        }

        async function reload(first) {
            const db = await fetchJson(state.path);
            if (!db || !Array.isArray(db.trades)) {
                if (first) {
                    els.status.textContent = `No data: ${state.path} could not be loaded or has no trades. ` +
                        `${BUILD_HINT}, or append ?db=sample to this URL to view the bundled sample fixture.`;
                    els.status.classList.add('status-error');
                    els.collectionLine.textContent = collectionLine(null);
                    renderTape();
                    renderReplay();
                }
                return;
            }
            // The collector rewrites the file on every run; re-rendering an unchanged capture would
            // flash the whole tape for nothing, so the generation stamp gates the render.
            if (!first && db.generatedAt && db.generatedAt === state.generatedAt) return;

            state.db = db;
            state.generatedAt = db.generatedAt || null;
            state.venues = venueOrder(db);
            state.trades = db.trades.slice();
            els.status.classList.remove('status-error');
            // The collector-run time is already on the data line above, so it is not repeated here.
            els.status.textContent = `${fmtCount(db.totals && db.totals.trades)} trades decoded over ` +
                `${db.pools.length} pools, ${fmtCount(db.totals && db.totals.traders)} distinct wallets, ` +
                `${fmtMoney(db.totals && db.totals.volumeUsd)} traded.`;
            els.dataAsOf.textContent = fmtDateTime(db.generatedAt);
            els.dataAsOf.setAttribute('datetime', typeof db.generatedAt === 'string' ? db.generatedAt : '');
            els.collectionLine.textContent = collectionLine(db);
            renderPoolChips();
            renderVenueLegend();
            renderTape();
            renderReplay();
            renderLiveState();
            // Auto-play only once, and only when motion is allowed: a later re-read must not
            // restart a replay the reader paused.
            if (first && !reduceMotion && Array.isArray(db.hourly) && db.hourly.length > 0) setPlaying(true);
        }

        async function fetchJson(path) {
            try {
                const res = await fetch(path, { cache: 'no-store' });
                if (!res.ok) return null;
                return await res.json();
            } catch (err) {
                return null;
            }
        }

        /** Collected trades and live arrivals in one list, newest first, deduplicated by signature. */
        function tapeTrades() {
            const merged = [];
            const seen = new Set();
            for (const trade of [...state.liveTrades, ...state.trades]) {
                const sig = trade && typeof trade.sig === 'string' ? trade.sig : null;
                if (sig) {
                    if (seen.has(sig)) continue;
                    seen.add(sig);
                }
                merged.push(trade);
            }
            merged.sort((a, b) => (tradeTimeMs(b && b.time) || 0) - (tradeTimeMs(a && a.time) || 0));
            return merged.slice(0, TAPE_LIMIT);
        }

        // --- the tape ------------------------------------------------------

        function renderTape() {
            const rows = tapeTrades().map((trade) => tapeRow(trade, Date.now()));
            if (rows.length === 0) {
                els.tape.innerHTML = '';
                els.tapeNote.hidden = false;
                return;
            }
            els.tapeNote.hidden = true;
            // The first render seeds the seen set, so the whole tape does not flash on arrival;
            // after that, a signature the page has not shown before is a new row.
            const firstRender = state.seen.size === 0;
            const fresh = [];
            els.tape.innerHTML = rows.map((row) => {
                const isNew = !firstRender && row.sig !== null && !state.seen.has(row.sig);
                if (row.sig) fresh.push(row.sig);
                return tapeRowHtml(row, isNew);
            }).join('');
            for (const sig of fresh) state.seen.add(sig);
            // The highlight is a CSS animation removed on animationend, so no timer decides when a
            // row stops being new — with reduced motion the animation is instant and it never flashes.
            for (const el of els.tape.querySelectorAll('.tape-row-new')) {
                el.addEventListener('animationend', () => el.classList.remove('tape-row-new'), { once: true });
            }
        }

        function tapeRowHtml(row, isNew) {
            const slot = venueSlot(row.venue);
            const sideClass = row.side ? `side-${row.side}` : 'side-unknown';
            const link = row.solscanUrl
                ? `<a class="tape-link" href="${escapeHtml(row.solscanUrl)}" target="_blank" rel="noopener" ` +
                  `title="Open this transaction on Solscan">tx&nbsp;&#8599;</a>`
                : `<span class="tape-link tape-link-missing" title="No signature in the record">${DASH}</span>`;
            return `<li class="tape-row${isNew ? ' tape-row-new' : ''}">` +
                `<span class="tape-time" data-time="${row.timeMs === null ? '' : row.timeMs}" ` +
                `title="${escapeHtml(row.absoluteTime)}">${escapeHtml(row.age)}</span>` +
                `<span class="tape-token"><span class="venue-dot venue-${slot}" aria-hidden="true"></span>` +
                `${escapeHtml(row.symbol)}</span>` +
                `<span class="tape-venue">${escapeHtml(row.venueLabel)}</span>` +
                `<span class="tape-side ${sideClass}"><span class="side-glyph" aria-hidden="true">${row.sideGlyph}</span> ` +
                `${escapeHtml(row.sideLabel)}</span>` +
                `<span class="tape-size num" title="Tokens moved">${escapeHtml(row.size)}</span>` +
                `<span class="tape-price num${row.priceSource === 'quote' ? ' tape-price-quote' : ''}" ` +
                `title="${row.priceSource === 'quote' ? 'No USD rate for this pool: the price is in the quote token' : 'Price in USD'}">` +
                `${escapeHtml(row.price)}</span>` +
                `<span class="tape-tags">${row.routed ? '<span class="tape-tag" title="The transaction moved more than two mints: an aggregator or arbitrage route, not a plain swap">routed</span>' : ''}</span>` +
                link +
                '</li>';
        }

        /** The colour slot of a venue, so the tape dot matches the replay bar and the legend. */
        function venueSlot(dexId) {
            const found = state.venues.find((venue) => venue.dexId === dexId);
            return found ? found.slot : VENUE_SLOTS - 1;
        }

        function renderPoolChips() {
            const pools = state.db && Array.isArray(state.db.pools) ? state.db.pools : [];
            if (pools.length === 0) {
                els.poolChips.innerHTML = `<p class="chips-empty">No pools in this capture.</p>`;
                return;
            }
            els.poolChips.innerHTML = pools.map((pool) => {
                const chip = poolChip(pool);
                const title = `${chip.signaturesSeen} signatures seen · ${chip.decoded} decoded · ` +
                    `${chip.undecodable} undecodable · ${chip.failedTx} failed` +
                    (chip.quoteSymbol ? ` · quoted in ${chip.quoteSymbol}` : '');
                return `<span class="chip venue-${venueSlot(chip.venue)}" title="${escapeHtml(title)}">` +
                    `<span class="venue-dot" aria-hidden="true"></span>` +
                    `<strong>${escapeHtml(chip.symbol)}</strong>` +
                    `<span class="chip-venue">${escapeHtml(chip.venueLabel)}</span>` +
                    `<span class="chip-count">${escapeHtml(chip.decoded)} decoded</span>` +
                    `<span class="chip-failed">${chip.failedPct === DASH ? 'no signatures yet' : escapeHtml(chip.failedPct) + ' failed'}</span>` +
                    '</span>';
            }).join('');
        }

        // --- the once-a-second tick: ages, the fetch queue, the socket retry ---

        function onTick() {
            const now = Date.now();
            for (const el of els.tape.querySelectorAll('.tape-time')) {
                const raw = el.getAttribute('data-time');
                const ms = raw ? Number(raw) : null;
                el.textContent = ms === null || !Number.isFinite(ms) ? DASH : fmtAgo(ms, now);
            }
            if (!state.live.on) return;
            // One transaction fetch per tick: comfortably above the ≥ 400 ms floor §12.3 asks for,
            // kept on the tick the page already runs so no extra timer decides when data arrives.
            drainQueue();
            if (state.live.mode === 'poll') tickPoll();
            else retryIfNeeded();
        }

        // --- go live -------------------------------------------------------

        /**
         * The live tape decodes swaps with the collector's own `decodeTrade` — the same function
         * that produced every stored trade in the capture, so the two can never disagree about what
         * a swap was. `stocks/lib/trades.mjs` imports nothing, which is what makes it loadable here
         * as a browser module; this page stays a classic script (its pure section is required by
         * live-page.test.js under plain CommonJS jest), so the module is pulled in with a dynamic
         * import the first time Go live is switched on rather than at the top of the file.
         */
        function ensureDecode() {
            const live = state.live;
            if (live.decodePromise) return live.decodePromise;
            live.decodePromise = import('./stocks/lib/trades.mjs')
                .then((mod) => {
                    if (typeof mod.decodeTrade !== 'function') {
                        throw new Error('stocks/lib/trades.mjs exports no decodeTrade');
                    }
                    live.decode = mod.decodeTrade;
                    return live.decode;
                })
                .catch((err) => {
                    setLiveStatus(live.status, `Live decoding is unavailable: ${err.message}. ` +
                        'The tape still shows the collected capture.');
                    return null;
                });
            return live.decodePromise;
        }

        function setLiveStatus(status, error) {
            state.live.status = status;
            state.live.error = error === undefined ? state.live.error : error;
            renderLiveState();
        }

        function renderLiveState() {
            const live = state.live;
            const labels = {
                off: 'off',
                connecting: 'connecting…',
                live: 'live',
                reconnecting: 'reconnecting…',
                hidden: 'paused (tab hidden)'
            };
            els.liveState.textContent = live.status === 'polling'
                ? (live.polling ? 'polling · sampling now' : `polling · next in ${Math.max(0, live.nextPollSeconds)} s`)
                : (labels[live.status] || live.status);
            els.liveState.className = `live-state live-state-${live.status}`;
            els.liveCounters.textContent = live.mode === 'poll' ? pollCountersText() : socketCountersText();
            els.liveError.hidden = !live.error;
            els.liveError.textContent = live.error || '';
        }

        function pollCountersText() {
            const live = state.live;
            const targets = pollTargets(state.db && state.db.pools, POLL_POOLS).length;
            if (live.status === 'off' && live.logs === 0) {
                return `${targets} busiest pools would be polled every ${POLL_SECONDS} s.`;
            }
            return `${live.cursors.size}/${targets} pools polled · ${live.logs} new signatures · ` +
                `${live.decoded} decoded · ${live.failed} failed (bot spam) · ${live.undecodable} undecodable · ` +
                `${live.queue.length} queued` + (live.dropped > 0 ? ` · throttled ${live.dropped}` : '') +
                (live.intervalSeconds > POLL_SECONDS ? ` · backed off to ${live.intervalSeconds} s` : '');
        }

        function socketCountersText() {
            const live = state.live;
            const pools = state.db && Array.isArray(state.db.pools) ? state.db.pools.length : 0;
            if (live.status === 'off' && live.logs === 0) return `${pools} pools would be subscribed.`;
            return `${live.subscriptions.size}/${pools} pools subscribed · ${live.logs} logs · ` +
                `${live.decoded} decoded · ${live.failed} failed (bot spam) · ${live.undecodable} undecodable · ` +
                `${live.queue.length} queued` + (live.dropped > 0 ? ` · throttled ${live.dropped}` : '');
        }

        // --- polling mode ---------------------------------------------------

        /** The endpoint to send JSON-RPC to, whichever mode's URL is in the field. */
        function rpcEndpoint() {
            return httpFromWs(els.rpcUrl.value.trim() || state.live.urls[state.live.mode] || DEFAULT_HTTP);
        }

        /**
         * One JSON-RPC request. Returns `{json}` on an answer, `{rateLimited: true}` on a 429 — the
         * endpoint asking for less traffic — and `{error}` on anything else, so a caller can tell a
         * rate limit from a refusal instead of treating both as "no data".
         */
        async function rpcCall(method, params) {
            const url = rpcEndpoint();
            if (!url) return { error: 'The RPC URL is not an http(s) or ws(s) URL, so nothing can be fetched.' };
            const live = state.live;
            live.requestId += 1;
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ jsonrpc: '2.0', id: live.requestId, method, params })
                });
                if (res.status === 429) return { rateLimited: true };
                if (!res.ok) return { error: `${method} returned HTTP ${res.status} from ${url}.` };
                return { json: await res.json() };
            } catch (err) {
                return { error: `${method} could not reach ${url}: ${err.message}` };
            }
        }

        /** Counts the second down and starts a round when it reaches zero. */
        function tickPoll() {
            const live = state.live;
            if (live.polling || document.hidden) {
                renderLiveState();
                return;
            }
            live.nextPollSeconds -= 1;
            if (live.nextPollSeconds <= 0) pollRound();
            else renderLiveState();
        }

        /**
         * One polling round: the newest signatures of the busiest sampled pools. The first round per
         * pool only remembers where the chain is — everything already on the pool is history the
         * capture covers — and every round after it reports only what appeared since.
         */
        async function pollRound() {
            const live = state.live;
            if (live.polling || !live.on || live.mode !== 'poll' || document.hidden) return;
            const targets = pollTargets(state.db && state.db.pools, POLL_POOLS);
            live.polling = true;
            setLiveStatus('polling', targets.length === 0
                ? 'No sampled pools in this capture, so there is nothing to poll.'
                : null);
            let rateLimited = false;
            let lastError = null;
            try {
                for (const pool of targets) {
                    if (!live.on || live.mode !== 'poll') break;
                    const call = await rpcCall('getSignaturesForAddress', [pool.pair, { limit: POLL_LIMIT }]);
                    if (call.rateLimited) {
                        rateLimited = true;
                        break;
                    }
                    if (call.error) {
                        lastError = call.error;
                        continue;
                    }
                    if (call.json && call.json.error) {
                        lastError = `getSignaturesForAddress: ${call.json.error.message || 'unknown error'}`;
                        continue;
                    }
                    const step = newSignatures(call.json && call.json.result, live.cursors.get(pool.pair) || null);
                    if (step.newest !== null) live.cursors.set(pool.pair, step.newest);
                    else if (!live.cursors.has(pool.pair)) live.cursors.set(pool.pair, '');
                    if (step.seeded) continue;
                    live.logs += step.fresh.length;
                    live.failed += step.failed;
                    for (const sig of step.ok) {
                        const pushed = queuePush(live.queue, sig, QUEUE_CAP);
                        live.queue = pushed.queue;
                        live.dropped += pushed.dropped;
                        if (pushed.added) live.pendingPools.set(sig, pool);
                    }
                }
            } finally {
                live.polling = false;
                live.intervalSeconds = backoffSeconds(live.intervalSeconds, rateLimited);
                live.nextPollSeconds = live.intervalSeconds;
                if (rateLimited) {
                    setLiveStatus('polling', `The endpoint rate-limited the round (HTTP 429), so the next one is in ${live.intervalSeconds} s.`);
                } else {
                    setLiveStatus('polling', lastError);
                }
            }
        }

        function openSocket() {
            const url = els.rpcUrl.value.trim() || DEFAULT_WS;
            const live = state.live;
            live.subscriptions.clear();
            live.pendingRequests.clear();
            setLiveStatus('connecting', null);
            let socket;
            try {
                socket = new WebSocket(url);
            } catch (err) {
                setLiveStatus('reconnecting', `Could not open ${url}: ${err.message}`);
                return;
            }
            live.socket = socket;

            socket.addEventListener('open', () => {
                if (live.socket !== socket) return;
                live.retryIndex = 0;
                setLiveStatus('live', null);
                subscribePools(socket);
            });
            socket.addEventListener('message', (event) => {
                if (live.socket !== socket) return;
                handleSocketMessage(event.data);
            });
            socket.addEventListener('error', () => {
                if (live.socket !== socket) return;
                setLiveStatus(live.on ? 'reconnecting' : 'off', `WebSocket error on ${url}. Public RPC endpoints rate-limit and often refuse log subscriptions.`);
            });
            socket.addEventListener('close', (event) => {
                if (live.socket !== socket) return;
                live.socket = null;
                live.subscriptions.clear();
                if (!live.on) {
                    setLiveStatus('off', null);
                    return;
                }
                live.retryTicks = RETRY_TICKS[Math.min(live.retryIndex, RETRY_TICKS.length - 1)];
                live.retryIndex += 1;
                live.retryBase = `Socket closed (code ${event.code}).`;
                setLiveStatus('reconnecting', `${live.retryBase} Retrying in ${live.retryTicks} s.`);
            });
        }

        function subscribePools(socket) {
            const pools = state.db && Array.isArray(state.db.pools) ? state.db.pools : [];
            let id = 1;
            for (const pool of pools) {
                if (!pool || typeof pool.pair !== 'string' || !pool.pair) continue;
                const requestId = id++;
                state.live.pendingRequests.set(requestId, pool);
                socket.send(JSON.stringify({
                    jsonrpc: '2.0',
                    id: requestId,
                    method: 'logsSubscribe',
                    params: [{ mentions: [pool.pair] }, { commitment: 'confirmed' }]
                }));
            }
            if (pools.length === 0) setLiveStatus('live', 'No sampled pools in this capture, so there is nothing to subscribe to.');
        }

        function handleSocketMessage(data) {
            let msg;
            try {
                msg = JSON.parse(data);
            } catch (err) {
                return;
            }
            const live = state.live;
            if (msg.id !== undefined && live.pendingRequests.has(msg.id)) {
                const pool = live.pendingRequests.get(msg.id);
                live.pendingRequests.delete(msg.id);
                if (isNum(msg.result)) live.subscriptions.set(msg.result, pool);
                else if (msg.error) setLiveStatus(live.status, `Subscription refused for ${pool.symbol || pool.pair}: ${msg.error.message || 'unknown error'}`);
                renderLiveState();
                return;
            }
            if (msg.method !== 'logsNotification' || !msg.params) return;
            const subscription = msg.params.subscription;
            const value = msg.params.result && msg.params.result.value ? msg.params.result.value : null;
            if (!value) return;
            const pool = live.subscriptions.get(subscription) || null;
            live.logs += 1;
            if (value.err) {
                live.failed += 1;
                renderLiveState();
                return;
            }
            if (!pool || typeof value.signature !== 'string') {
                renderLiveState();
                return;
            }
            const pushed = queuePush(live.queue, value.signature, QUEUE_CAP);
            live.queue = pushed.queue;
            live.dropped += pushed.dropped;
            live.pendingPools.set(value.signature, pool);
            renderLiveState();
        }

        /**
         * The newest queued signature, fetched and decoded. Newest first on purpose: when a burst
         * has filled the queue, the tape is more useful showing what just happened than working
         * through a backlog in order.
         *
         * A versioned transaction refused with -32015 is retried once at the version the error
         * names, so a v0 transaction is decoded rather than written off as undecodable.
         */
        async function drainQueue() {
            const live = state.live;
            if (live.inFlight || live.queue.length === 0) return;
            const decode = live.decode || await ensureDecode();
            if (!decode) return;
            const sig = live.queue[live.queue.length - 1];
            live.queue = live.queue.slice(0, -1);
            const pool = live.pendingPools.get(sig) || null;
            live.pendingPools.delete(sig);
            live.inFlight = true;
            try {
                let call = await rpcCall('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
                if (call.rateLimited) {
                    live.intervalSeconds = backoffSeconds(live.intervalSeconds, true);
                    setLiveStatus(live.status, `getTransaction was rate-limited (HTTP 429); polling backed off to ${live.intervalSeconds} s.`);
                    return;
                }
                if (call.error) {
                    setLiveStatus(live.status, call.error);
                    return;
                }
                let body = call.json;
                const version = body && body.error ? versionFromError(body.error) : null;
                if (version !== null) {
                    const retry = await rpcCall('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: version }]);
                    if (retry.json) body = retry.json;
                }
                if (!body) return;
                if (body.error) {
                    setLiveStatus(live.status, `getTransaction error: ${body.error.message || 'unknown'}`);
                    return;
                }
                if (!body.result) {
                    // Confirmed in the signature list but not yet retrievable: queue it again rather
                    // than counting a transaction that exists as undecodable.
                    const requeue = queuePush(live.queue, sig, QUEUE_CAP);
                    live.queue = requeue.queue;
                    live.dropped += requeue.dropped;
                    if (requeue.added && pool) live.pendingPools.set(sig, pool);
                    return;
                }
                const decoded = decode(body.result, pool, { signature: sig });
                if (!decoded) {
                    live.undecodable += 1;
                    renderLiveState();
                    return;
                }
                live.decoded += 1;
                state.liveTrades = [decoded, ...state.liveTrades].slice(0, TAPE_LIMIT);
                renderTape();
                renderLiveState();
            } finally {
                live.inFlight = false;
            }
        }

        /** Brings up whichever live mode is selected. */
        function startLive() {
            const live = state.live;
            clearRuntime(live);
            if (live.mode === 'ws') {
                openSocket();
                return;
            }
            live.nextPollSeconds = 0;
            setLiveStatus('polling', null);
            pollRound();
        }

        /** Takes the current mode down: socket closed, queue and cursors dropped, counters zeroed. */
        function stopLive(reason) {
            const live = state.live;
            const socket = live.socket;
            live.socket = null;
            clearRuntime(live);
            if (socket) {
                try {
                    socket.close();
                } catch (err) {
                    // A socket already closing throws nothing useful; the state below is what matters.
                }
            }
            setLiveStatus(reason, null);
        }

        function retryIfNeeded() {
            const live = state.live;
            if (live.socket || live.status !== 'reconnecting') return;
            live.retryTicks -= 1;
            if (live.retryTicks > 0) {
                setLiveStatus('reconnecting', `${live.retryBase || 'Disconnected.'} Retrying in ${live.retryTicks} s.`);
                return;
            }
            openSocket();
        }

        function closeSocket(reason) {
            const live = state.live;
            const socket = live.socket;
            live.socket = null;
            live.subscriptions.clear();
            live.pendingRequests.clear();
            live.pendingPools.clear();
            live.queue = [];
            if (socket) {
                try {
                    socket.close();
                } catch (err) {
                    // A socket already closing throws nothing useful; the state below is what matters.
                }
            }
            setLiveStatus(reason, null);
        }

        // --- the replay ----------------------------------------------------

        function replaySteps() {
            const buckets = state.db && Array.isArray(state.db.hourly) ? state.db.hourly : [];
            return Math.max(1, buckets.length) * REPLAY_STEPS_PER_HOUR;
        }

        function renderReplay() {
            const buckets = state.db && Array.isArray(state.db.hourly) ? state.db.hourly : [];
            const geometry = barGeometry(buckets, {
                width: CHART.width,
                height: CHART.height,
                gap: CHART.gap,
                mode: state.metric,
                venues: state.venues,
                collectingSinceMs: tradeTimeMs(state.db && state.db.collectingSince)
            });

            const bars = document.createDocumentFragment();
            const axis = document.createDocumentFragment();
            for (const bar of geometry.bars) {
                if (bar.hatched) {
                    const shade = svgEl('rect', {
                        x: bar.x, y: 0, width: bar.width, height: CHART.height, class: 'bar-hatched'
                    });
                    shade.appendChild(svgEl('title', {}, `${bar.hourLabel} — before collection began, never sampled`));
                    bars.appendChild(shade);
                }
                if (isNum(bar.total) && bar.total > 0) {
                    for (const segment of bar.segments) {
                        const rect = svgEl('rect', {
                            x: bar.x, y: segment.y, width: bar.width, height: Math.max(0.5, segment.height),
                            class: `bar-segment venue-fill-${segment.slot}`
                        });
                        rect.appendChild(svgEl('title', {}, `${bar.hourLabel} · ${segment.label}: ` +
                            (state.metric === 'volume' ? fmtMoney(segment.value) : `${fmtCount(segment.value)} trades`)));
                        bars.appendChild(rect);
                    }
                } else {
                    bars.appendChild(svgEl('rect', {
                        x: bar.x, y: CHART.height - 1, width: bar.width, height: 1,
                        class: 'bar-empty'
                    }));
                }
                // Every third hour is labelled: 24 labels do not fit at 300 px and a crowded axis
                // is less readable than a sparse one.
                if (bar.index % 3 === 0) {
                    axis.appendChild(svgEl('text', {
                        x: bar.x + bar.width / 2, y: CHART.height + 16, class: 'axis-label'
                    }, bar.hourLabel));
                }
            }
            els.replayBars.replaceChildren(bars);
            els.replayAxis.replaceChildren(axis);

            const caption = [];
            caption.push(state.metric === 'volume'
                ? 'Bar height is USD traded in that hour, stacked by venue.'
                : 'Bar height is the number of decoded trades in that hour, stacked by venue.');
            if (geometry.max === 0) caption.push('No hour in this capture has a value for that metric yet.');
            const since = state.db && state.db.collectingSince ? fmtDateTime(state.db.collectingSince) : null;
            if (since && geometry.bars.some((bar) => bar.hatched)) {
                caption.push(`Hatched hours are before collection began — collecting since ${since}, so they were never sampled and their bars are not comparable.`);
            } else if (since) {
                caption.push(`Collecting since ${since}.`);
            }
            els.replayCaption.textContent = caption.join(' ');

            renderCursor();
        }

        function renderCursor() {
            const buckets = state.db && Array.isArray(state.db.hourly) ? state.db.hourly : [];
            const steps = replaySteps();
            const fraction = state.cursorStep / steps;
            const x = fraction * CHART.width;
            els.replayCursor.setAttribute('x1', x);
            els.replayCursor.setAttribute('x2', x);
            els.replaySvg.setAttribute('aria-label',
                `Replay of ${buckets.length} collected hours, cursor at hour ${Math.floor(state.cursorStep / REPLAY_STEPS_PER_HOUR) + 1} of ${buckets.length}`);

            const hourIndex = Math.min(buckets.length - 1, Math.floor(state.cursorStep / REPLAY_STEPS_PER_HOUR));
            const counters = countersUpTo(buckets, state.trades, hourIndex, {
                failedShare: state.db && state.db.totals ? state.db.totals.failedShare : null
            });
            els.replayCounters.innerHTML =
                counterHtml('Hour (UTC)', counters.hourLabel, `Hour ${counters.hours} of ${buckets.length} in the collected window`) +
                counterHtml('Trades', fmtCount(counters.trades), 'Decoded swaps in the hours the cursor has passed') +
                counterHtml('Volume', fmtMoney(counters.volumeUsd), 'USD value of those swaps, priced with each pool\'s quote rate') +
                counterHtml('Traders', fmtCount(counters.traders),
                    counters.tradersExact
                        ? 'Distinct fee-payer wallets in those hours, counted from the trades themselves'
                        : 'Sum of the per-hour, per-venue trader counts: wallets can repeat, so this is an upper bound') +
                counterHtml('Failed', fmtShare(counters.failedShare),
                    'Share of signatures on the sampled pools that failed. Failures are not bucketed per hour, so this is the whole window');
        }

        function counterHtml(label, value, title) {
            return `<div class="counter" title="${escapeHtml(title)}">` +
                `<span class="counter-label">${escapeHtml(label)}</span>` +
                `<span class="counter-value">${escapeHtml(value)}</span></div>`;
        }

        function svgEl(name, attrs, text) {
            const el = document.createElementNS(SVG_NS, name);
            for (const key of Object.keys(attrs || {})) el.setAttribute(key, attrs[key]);
            if (text !== undefined) el.textContent = text;
            return el;
        }

        function renderVenueLegend() {
            if (state.venues.length === 0) {
                els.venueLegend.innerHTML = '';
                return;
            }
            els.venueLegend.innerHTML = state.venues.map((venue) =>
                `<span class="legend-item venue-${venue.slot}">` +
                `<span class="venue-dot" aria-hidden="true"></span>${escapeHtml(venue.label)}` +
                `<span class="chip-count">${fmtCount(venue.trades)}</span></span>`
            ).join('');
        }

        function setPlaying(playing) {
            state.playing = playing;
            if (state.replayTimer !== null) {
                window.clearInterval(state.replayTimer);
                state.replayTimer = null;
            }
            if (playing) state.replayTimer = window.setInterval(advanceCursor, REPLAY_TICK_MS);
            els.replayPlay.textContent = playing ? 'Pause' : 'Play';
            els.replayPlay.setAttribute('aria-pressed', playing ? 'true' : 'false');
        }

        function advanceCursor() {
            const steps = replaySteps();
            state.cursorStep += 1;
            if (state.cursorStep >= steps) state.cursorStep = 0;
            renderCursor();
        }

        function stepHours(delta) {
            const steps = replaySteps();
            const hours = Math.max(1, steps / REPLAY_STEPS_PER_HOUR);
            let hour = Math.floor(state.cursorStep / REPLAY_STEPS_PER_HOUR) + delta;
            if (hour < 0) hour = hours - 1;
            if (hour > hours - 1) hour = 0;
            state.cursorStep = hour * REPLAY_STEPS_PER_HOUR;
            renderCursor();
        }

        // --- events --------------------------------------------------------

        function wireEvents() {
            els.goLive.addEventListener('change', () => {
                state.live.on = els.goLive.checked;
                if (state.live.on) {
                    ensureDecode();
                    startLive();
                } else {
                    stopLive('off');
                }
            });

            for (const radio of [els.modePoll, els.modeWs]) {
                radio.addEventListener('change', () => {
                    if (!radio.checked) return;
                    const next = radio.value === 'ws' ? 'ws' : 'poll';
                    if (next === state.live.mode) return;
                    // Remember the endpoint the reader typed for the mode being left, tear the old
                    // mode down completely, then bring the new one up if the toggle is on.
                    state.live.urls[state.live.mode] = els.rpcUrl.value.trim() || state.live.urls[state.live.mode];
                    stopLive('off');
                    state.live.mode = next;
                    els.rpcUrl.value = state.live.urls[next];
                    if (els.goLive.checked) {
                        state.live.on = true;
                        startLive();
                    } else {
                        renderLiveState();
                    }
                });
            }

            els.rpcUrl.addEventListener('change', () => {
                state.live.urls[state.live.mode] = els.rpcUrl.value.trim() || state.live.urls[state.live.mode];
                if (!state.live.on) return;
                stopLive('off');
                state.live.on = true;
                startLive();
            });

            document.addEventListener('visibilitychange', () => {
                if (!state.live.on) return;
                if (document.hidden) {
                    // Polling has nothing to close; it simply stops asking while nobody is looking.
                    if (state.live.mode === 'ws') closeSocket('hidden');
                    else setLiveStatus('hidden', null);
                    return;
                }
                if (state.live.mode === 'ws') {
                    if (!state.live.socket) openSocket();
                } else {
                    state.live.nextPollSeconds = 0;
                    pollRound();
                }
            });

            els.replayMetric.addEventListener('change', () => {
                state.metric = els.replayMetric.value === 'volume' ? 'volume' : 'trades';
                renderReplay();
            });
            els.replayPlay.addEventListener('click', () => setPlaying(!state.playing));
            els.replayRestart.addEventListener('click', () => {
                state.cursorStep = 0;
                renderCursor();
            });
            els.replayStepBack.addEventListener('click', () => {
                setPlaying(false);
                stepHours(-1);
            });
            els.replayStepFwd.addEventListener('click', () => {
                setPlaying(false);
                stepHours(1);
            });

            // Reduced motion: nothing sweeps on its own, and the step buttons are the way through
            // the window. Auto-play, when it is allowed, starts once the first capture has landed.
            if (reduceMotion) document.body.classList.add('reduce-motion');
        }
    });

    return api;
}));
