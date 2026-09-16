// PURE after-hours premium analytic: bucket every stored trade into the underlying market's open
// or closed session (via the Pyth schedule carried on each reference-price record) and compare the
// premium the token traded at on each side. The interesting number is the GAP — how much wider the
// premium gets once the listed market is shut and the token is the only venue still quoting. No
// I/O, no clock: the instants come from the trades and every threshold is explicit, so the
// arithmetic is unit-tested headlessly (see ../afterhours.test.js).

import { median } from './grade.mjs';
import { parseSchedule, sessionAt } from './market-hours.mjs';
import { premiumPct } from './pyth.mjs';

/**
 * Fewer than this many trades on a side and that side stays null. A median of two trades is not a
 * session's premium, and reporting one as if it were is how a 3-trade fluke becomes a headline.
 */
export const MIN_SIDE_TRADES = 5;

/**
 * The honest caveat, written into the output file: the reference is the LAST reference price at
 * build time, not the one that stood when each trade printed. Over a window of a few hours with a
 * closed underlying that is nearly the same thing — the reference does not move while the market
 * is shut — but it is not a historical per-trade comparison and must not be read as one.
 */
export const NOTE = 'premium per trade is priceUsd / refPrice - 1, where refPrice is the LAST reference price at build time (not a historical per-trade reference). While the underlying market is closed that price does not move, so the closed-session figure is sound; the open-session figure is measured against a reference that has since moved. Sessions come from the Pyth feed schedule (keyless), holiday and half-day overrides included; holiday trades count as closed.';

/** A finite, strictly positive number or null — a price of 0 or null is missing, never cheap. */
function positiveOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** Why a traded mint cannot be measured, or null when it can. */
export function unusableReason(reference) {
    if (reference === null || reference === undefined) return 'no reference-price record';
    if (parseSchedule(reference.schedule) === null) return 'no Pyth feed schedule';
    if (positiveOrNull(reference.refPrice) === null) return 'no reference price';
    return null;
}

/**
 * Index the reference-price items that can actually carry the analytic — a parsed schedule AND a
 * usable reference price — by mint. Everything else is returned in `unusable` so a caller can log
 * what it dropped instead of silently shrinking the output.
 */
export function indexReferences(items) {
    const usable = new Map();
    const unusable = new Map();
    for (const item of Array.isArray(items) ? items : []) {
        const mint = typeof item?.mint === 'string' && item.mint !== '' ? item.mint : null;
        if (mint === null || usable.has(mint) || unusable.has(mint)) continue;
        const reason = unusableReason(item);
        if (reason !== null) {
            unusable.set(mint, { mint, symbol: item.symbol ?? null, reason });
            continue;
        }
        usable.set(mint, {
            mint,
            symbol: item.symbol ?? null,
            issuer: item.issuer ?? null,
            underlyingTicker: item.underlyingTicker ?? null,
            source: item.refSource ?? null,
            refPrice: positiveOrNull(item.refPrice),
            refPublishTime: typeof item.refPublishTime === 'number' && Number.isFinite(item.refPublishTime) ? item.refPublishTime : null,
            scheduleText: item.schedule,
            schedule: parseSchedule(item.schedule)
        });
    }
    return { usable, unusable };
}

/** `'open'` on its own side; a holiday trade is a closed-market trade. */
function sideFor(session) {
    if (session === 'open') return 'open';
    if (session === 'closed' || session === 'holiday') return 'closed';
    return null;
}

/**
 * One item per measurable mint, sorted by mint, plus what was left out. A mint with no schedule or
 * no reference price is OMITTED rather than emitted with null numbers: PreStocks' private
 * companies and Tessera have no listed market to be open or closed at all, so a row claiming
 * "closed premium: null" about them says nothing true.
 */
export function buildAfterhoursItems(trades, referenceItems) {
    const { usable, unusable } = indexReferences(referenceItems);
    const buckets = new Map();
    const omitted = new Map();
    const skipped = { suspect: 0, noPriceUsd: 0, noPremium: 0, unknownSession: 0, badTime: 0 };

    for (const trade of Array.isArray(trades) ? trades : []) {
        const mint = typeof trade?.mint === 'string' && trade.mint !== '' ? trade.mint : null;
        if (mint === null) continue;

        const reference = usable.get(mint) ?? null;
        if (reference === null) {
            const known = unusable.get(mint) ?? null;
            if (!omitted.has(mint)) {
                omitted.set(mint, {
                    mint,
                    symbol: known?.symbol ?? trade.symbol ?? null,
                    reason: known?.reason ?? 'no reference-price record',
                    trades: 0
                });
            }
            omitted.get(mint).trades += 1;
            continue;
        }

        // A round-trip-suspect trade has an arithmetically real but economically meaningless
        // price (see README), so it must not reach a premium median either.
        if (trade.suspect) {
            skipped.suspect += 1;
            continue;
        }
        const priceUsd = positiveOrNull(trade.priceUsd);
        if (priceUsd === null) {
            skipped.noPriceUsd += 1;
            continue;
        }
        const atMs = Date.parse(trade.time);
        if (!Number.isFinite(atMs)) {
            skipped.badTime += 1;
            continue;
        }
        const side = sideFor(sessionAt(reference.schedule, atMs));
        if (side === null) {
            skipped.unknownSession += 1;
            continue;
        }
        const premium = premiumPct(priceUsd, reference.refPrice);
        if (premium === null) {
            skipped.noPremium += 1;
            continue;
        }

        let bucket = buckets.get(mint);
        if (bucket === undefined) {
            bucket = { reference, open: [], closed: [], fromMs: atMs, toMs: atMs, from: trade.time, to: trade.time };
            buckets.set(mint, bucket);
        }
        bucket[side].push(premium);
        if (atMs < bucket.fromMs) {
            bucket.fromMs = atMs;
            bucket.from = trade.time;
        }
        if (atMs > bucket.toMs) {
            bucket.toMs = atMs;
            bucket.to = trade.time;
        }
    }

    const items = [...buckets.values()].map((bucket) => {
        const openPremiumPct = bucket.open.length >= MIN_SIDE_TRADES ? median(bucket.open) : null;
        const closedPremiumPct = bucket.closed.length >= MIN_SIDE_TRADES ? median(bucket.closed) : null;
        return {
            mint: bucket.reference.mint,
            symbol: bucket.reference.symbol,
            issuer: bucket.reference.issuer,
            underlyingTicker: bucket.reference.underlyingTicker,
            source: bucket.reference.source,
            refPrice: bucket.reference.refPrice,
            refPublishTime: bucket.reference.refPublishTime,
            tradesOpen: bucket.open.length,
            tradesClosed: bucket.closed.length,
            openPremiumPct,
            closedPremiumPct,
            // Null when either side is missing: a gap against an unknown is not a gap of zero.
            gapPct: openPremiumPct === null || closedPremiumPct === null ? null : closedPremiumPct - openPremiumPct,
            windowFrom: bucket.from,
            windowTo: bucket.to
        };
    }).sort((a, b) => (a.mint === b.mint ? 0 : a.mint < b.mint ? -1 : 1));

    const omittedMints = [...omitted.values()].sort((a, b) => (a.mint === b.mint ? 0 : a.mint < b.mint ? -1 : 1));
    return { items, omittedMints, skipped };
}

/** Counts and the widest |gap| for the one-line run summary. Null gaps do not compete. */
export function summarize(items) {
    const list = Array.isArray(items) ? items : [];
    const withGap = list.filter((item) => Number.isFinite(item?.gapPct));
    let largestGap = null;
    for (const item of withGap) {
        if (largestGap === null || Math.abs(item.gapPct) > Math.abs(largestGap.gapPct)) largestGap = item;
    }
    return {
        items: list.length,
        bothSides: withGap.length,
        openOnly: list.filter((item) => item?.openPremiumPct !== null && item?.closedPremiumPct === null).length,
        closedOnly: list.filter((item) => item?.closedPremiumPct !== null && item?.openPremiumPct === null).length,
        largestGap
    };
}

/** The whole output file. `items` is already sorted by mint. */
export function buildPayload({ generatedAt, tradesGeneratedAt, referenceFetchedAt, items, omittedMints, skipped, minSideTrades = MIN_SIDE_TRADES }) {
    return {
        generatedAt,
        tradesGeneratedAt: tradesGeneratedAt ?? null,
        referenceFetchedAt: referenceFetchedAt ?? null,
        note: NOTE,
        minSideTrades,
        skipped,
        omittedMints,
        items
    };
}
