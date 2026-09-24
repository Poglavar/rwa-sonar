// PURE: Solana depth for tokenized-stock collateral — the USD sale into USDC at which Jupiter's
// keyless quote reports a 5 % and a 10 % average price impact. A ladder of sale sizes is quoted
// smallest first; the thresholds are interpolated between the two ladder steps that bracket them
// (log-linear in size), or reported as a bound when the ladder never brackets them. No I/O and no
// clock (tested in ../solana-depth.test.js); stocks/fetch-solana-depth.mjs does the quoting.

import { sessionAt } from './market-hours.mjs';

/** Sale sizes quoted, in USD, smallest first. The research used $250k–$5M; thin tokens need $1k–$25k. */
export const LADDER_USD = [1000, 5000, 25000, 100000, 250000, 1000000, 2500000];
/** The two impacts the site reports, in percent. */
export const THRESHOLDS_PCT = [5, 10];
/** Samples kept in the store. */
export const KEEP_DAYS = 45;
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';
export const PRICE_URL = 'https://lite-api.jup.ag/price/v3';

/**
 * The raw input amount (base units, as a decimal string) that sells `usd` worth of the token. The
 * quote API takes the PRE-scaled amount of a Token-2022 scaled-UI mint, so the pre-scaled price is
 * used when Jupiter reports one. Null when the price or decimals are unusable.
 */
export function rawAmountForUsd(usd, { priceUsd, decimals }) {
    if (!(typeof usd === 'number' && usd > 0)) return null;
    if (!(typeof priceUsd === 'number' && Number.isFinite(priceUsd) && priceUsd > 0)) return null;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
    const raw = Math.floor((usd / priceUsd) * 10 ** decimals);
    return raw > 0 ? String(raw) : null;
}

/** The price the ladder is sized with, from one price-v3 record: pre-scaled first. */
export function ladderPrice(record) {
    const pre = record?.scaledUiConfig?.usdPricePrescaled;
    const price = typeof pre === 'number' && Number.isFinite(pre) && pre > 0 ? pre : record?.usdPrice;
    const decimals = record?.decimals;
    if (!(typeof price === 'number' && Number.isFinite(price) && price > 0) || !Number.isInteger(decimals)) return null;
    return { priceUsd: price, decimals };
}

/**
 * One ladder step from a quote answer: impact in percent (Jupiter reports a fraction), or a
 * no-route step when the API found no route. Anything else is an error the caller logs.
 */
export function stepFromQuote(usd, quote) {
    const impact = Number(quote?.priceImpactPct);
    const out = Number(quote?.outAmount);
    if (!Number.isFinite(impact)) return null;
    return {
        usd,
        impactPct: impact * 100,
        outUsd: Number.isFinite(out) ? out / 1e6 : null,
        noRoute: false,
        contextSlot: Number.isFinite(Number(quote?.contextSlot)) ? Number(quote.contextSlot) : null
    };
}

/** Whether the ladder can stop: the last step reached the largest threshold or found no route. */
export function ladderDone(steps) {
    const last = Array.isArray(steps) ? steps.at(-1) : null;
    if (!last) return false;
    return last.noRoute || last.impactPct >= Math.max(...THRESHOLDS_PCT);
}

/**
 * The USD sale at which the ladder reaches `pct` impact:
 *   {usd, bound: 'interpolated'} between two steps that bracket it;
 *   {usd: <smallest>, bound: 'below'} when the smallest step already reaches it;
 *   {usd: <size>, bound: 'no-route'} when a size found no route before the impact reached it;
 *   {usd: <largest>, bound: 'above'} when even the largest step stayed under it;
 *   null for an empty ladder.
 */
export function saleForImpact(steps, pct) {
    const list = Array.isArray(steps) ? steps : [];
    if (list.length === 0) return null;
    let prev = null;
    for (const step of list) {
        if (step.noRoute) return { usd: step.usd, bound: 'no-route' };
        if (step.impactPct >= pct) {
            if (prev === null) return { usd: step.usd, bound: 'below' };
            const lo = Math.max(prev.impactPct, 0);
            const hi = step.impactPct;
            const f = hi > lo ? (pct - lo) / (hi - lo) : 1;
            const usd = Math.exp(Math.log(prev.usd) + f * (Math.log(step.usd) - Math.log(prev.usd)));
            return { usd: Math.round(usd), bound: 'interpolated' };
        }
        prev = step;
    }
    return { usd: list.at(-1).usd, bound: 'above' };
}

/**
 * One extra sale size inside each bracket the thresholds fell into (the geometric midpoint), so the
 * interpolation spans a factor of ~1.6–2.2 instead of 2.5–5; a bracket that ends in a size with no
 * route is split the same way. A bracket both thresholds share is
 * quoted once; a size already quoted is not quoted again. Sorted ascending.
 */
export function refinementSizes(steps) {
    const list = Array.isArray(steps) ? steps : [];
    const sizes = new Set();
    for (const pct of THRESHOLDS_PCT) {
        const hit = saleForImpact(list, pct);
        if (hit === null || (hit.bound !== 'interpolated' && hit.bound !== 'no-route')) continue;
        const at = list.findIndex((step) => step.noRoute || step.impactPct >= pct);
        if (at <= 0) continue;
        const mid = Math.round(Math.sqrt(list[at - 1].usd * list[at].usd));
        if (!list.some((step) => step.usd === mid)) sizes.add(mid);
    }
    return [...sizes].sort((a, b) => a - b);
}

/** The ladder with extra steps merged in by size. */
export function withSteps(steps, extra) {
    return [...(Array.isArray(steps) ? steps : []), ...(Array.isArray(extra) ? extra : [])].sort((a, b) => a.usd - b.usd);
}

/**
 * The coarse session a sample was taken in: `open` (US regular session), `weekend` (a closed hour
 * on a UTC Saturday or Sunday), else `closed` (a weeknight or a holiday). Unknown schedule →
 * `unknown`, never a guess.
 */
export function sessionKind(schedule, atMs) {
    const day = new Date(atMs).getUTCDay();
    const session = sessionAt(schedule, atMs);
    if (session === 'unknown') return 'unknown';
    if (session === 'open') return 'open';
    if (day === 6 || day === 0) return 'weekend';
    return 'closed';
}

/**
 * The sample stored for one token and run. A token Jupiter has no price for is stored as such
 * (`noPrice`): that is a finding about its Solana market, not a missing measurement.
 */
export function buildSample({ at, session, mint, symbol, price, steps }) {
    if (price === null || price === undefined) {
        return { at, session, mint, symbol: symbol ?? null, priceUsd: null, noPrice: true, at5Pct: null, at10Pct: null, steps: [] };
    }
    return {
        at,
        session,
        mint,
        symbol: symbol ?? null,
        priceUsd: price?.priceUsd ?? null,
        at5Pct: saleForImpact(steps, 5),
        at10Pct: saleForImpact(steps, 10),
        steps: steps.map((s) => ({ usd: s.usd, impactPct: s.noRoute ? null : Math.round(s.impactPct * 1000) / 1000, noRoute: s.noRoute }))
    };
}

/** Stored samples plus this run's, oldest dropped past KEEP_DAYS from `nowMs`, oldest first. */
export function mergeSamples(previous, next, nowMs) {
    const floor = nowMs - KEEP_DAYS * 24 * 60 * 60 * 1000;
    const byKey = new Map();
    for (const sample of [...(Array.isArray(previous) ? previous : []), ...(Array.isArray(next) ? next : [])]) {
        const t = Date.parse(sample?.at);
        if (!Number.isFinite(t) || t < floor || typeof sample?.mint !== 'string') continue;
        byKey.set(`${sample.mint}|${sample.at}`, sample);
    }
    return [...byKey.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.mint < b.mint ? -1 : 1));
}

/** Whether a mint already has a sample in the same session kind within `hours` of `nowMs` (resume). */
export function sampledRecently(samples, mint, session, nowMs, hours) {
    return (Array.isArray(samples) ? samples : []).some((s) => s?.mint === mint && s?.session === session
        && nowMs - Date.parse(s.at) < hours * 60 * 60 * 1000);
}

/** The mints to measure: every token a lending market takes as collateral, research first. */
export function lenderMints(oraclePricing, defiUsage) {
    const out = new Map();
    for (const market of Array.isArray(oraclePricing?.markets) ? oraclePricing.markets : []) {
        for (const c of Array.isArray(market?.collateral) ? market.collateral : []) {
            if (typeof c?.mint === 'string' && !out.has(c.mint)) out.set(c.mint, c.symbol ?? null);
        }
    }
    for (const item of Array.isArray(defiUsage?.items) ? defiUsage.items : []) {
        if (typeof item?.mint !== 'string' || out.has(item.mint)) continue;
        if ((item.integrations ?? []).some((i) => i?.category === 'lending')) out.set(item.mint, item.symbol ?? null);
    }
    return [...out].map(([mint, symbol]) => ({ mint, symbol }));
}
