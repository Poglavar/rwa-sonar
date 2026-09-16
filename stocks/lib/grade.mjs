// Pure grading rules for the tokenized-stocks section, per stocks/MODEL.md §3: the two
// ledger-maturity numbers (which must equal what index.html computes), the claim-depth rung,
// verification strength, the per-issuer control surface and market reality, the per-token
// instrument type and the scaled UI supply, plus the per-token and per-issuer trading activity of
// §11.2/§11.3. No I/O and no network, so every rule is unit-tested headlessly (see
// ../grade.test.js). A missing number stays null here and is never coerced to 0.

import { aggregateVenues, topVenues } from './venues.mjs';

/** The TEN booleans the site table stores and sums. Nothing else is ever scored or written. */
export const SITE_BOOLEANS = [
    'blockchainIsMainLedger',
    'unconditionalTransfers',
    'bearerRedemption',
    'forcedTransfers',
    'titleDeed',
    'tokenSelfCustody',
    'issuerIndependent',
    'presetJurisdiction',
    'thirdPartyAttestations',
    'aiReady'
];

/**
 * Dossier booleans that are deliberately NOT part of the site vocabulary. index.html sums every
 * non-general field of a record, so writing one of these into rwa-assets-db.json would silently
 * shift that record's Maturity Score (MODEL.md §3.1).
 */
export const NON_SITE_BOOLEANS = ['reflectLegalDecisions', 'meetingOfMinds', 'assetSelfCustody'];

/** Byte-identical to index.html's isYes/isNo, so stage and score cannot drift from the page. */
export function isYes(value) {
    return ['yes', 'y', '1', 'true'].includes(String(value ?? '').trim().toLowerCase());
}

export function isNo(value) {
    const v = String(value ?? '').trim().toLowerCase();
    return ['no', 'n', '0', 'false'].includes(v);
}

/** Reads one vocabulary entry, accepting both `{key: {value, reason}}` and flat `{key: "yes"}`. */
export function vocabularyValue(vocabulary, key) {
    if (!vocabulary || typeof vocabulary !== 'object') return null;
    const entry = vocabulary[key];
    if (entry === null || entry === undefined) return null;
    if (typeof entry === 'object') return entry.value ?? null;
    return entry;
}

/** MODEL.md §3.1 — the ladder, keyed on the four pillars in order. */
export function maturityStageNum(vocabulary) {
    if (!isYes(vocabularyValue(vocabulary, 'blockchainIsMainLedger'))) return 0;
    if (!isYes(vocabularyValue(vocabulary, 'unconditionalTransfers'))) return 1;
    if (!isYes(vocabularyValue(vocabulary, 'bearerRedemption'))) return 2;
    if (!isYes(vocabularyValue(vocabulary, 'forcedTransfers'))) return 3;
    return 4;
}

export function maturityStage(vocabulary) {
    return `Level ${maturityStageNum(vocabulary)}`;
}

/** MODEL.md §3.1 — +1 per "yes", −1 per "no", 0 otherwise, over the TEN site booleans only. */
export function maturityScore(vocabulary) {
    let score = 0;
    for (const key of SITE_BOOLEANS) {
        const value = vocabularyValue(vocabulary, key);
        if (isYes(value)) score += 1;
        else if (isNo(value)) score -= 1;
    }
    return score;
}

/** MODEL.md §3.2 — what the holder legally owns. */
export const CLAIM_LABELS = [
    'synthetic exposure',
    'unsecured claim on the issuer',
    'secured claim on collateral',
    'beneficial interest in the security',
    'registered share'
];

const SYNTHETIC_FORMS = ['derivative', 'spv-synthetic'];
const NOTE_FORMS = ['structured-note', 'tracker-certificate', 'debt-note'];

/** Accepts a whole issuer dossier or just `{legalForm, securityInterest}`. */
export function claimRung(issuer) {
    const legalForm = typeof issuer?.legalForm === 'string' ? issuer.legalForm.trim() : '';
    const rung = (n) => ({ rung: n, label: CLAIM_LABELS[n] });

    if (SYNTHETIC_FORMS.includes(legalForm)) return rung(0);
    if (NOTE_FORMS.includes(legalForm)) {
        return issuer?.securityInterest?.exists === true ? rung(2) : rung(1);
    }
    if (legalForm === 'spv-claim-redeemable') return rung(3);
    if (legalForm === 'registered-share') return rung(4);
    return { rung: null, label: null };
}

/** MODEL.md §3.4 — how the backing is actually verified. */
export const VERIFICATION_STRENGTH = {
    none: 0,
    unknown: 0,
    'issuer-statement': 1,
    'auditor-attestation': 2,
    'daily-verification-agent': 3,
    'chainlink-por': 4,
    'transfer-agent-register': 5
};

export const VERIFICATION_LABELS = ['none', 'issuer', 'auditor', 'daily agent', 'on-chain PoR', 'register'];

/**
 * Accepts a whole issuer dossier or just `{custodyVerification}`. An absent block means nothing is
 * verified, which is strength 0; an unrecognised `type` returns a null strength (never a silent 0)
 * so the caller can warn about the typo instead of publishing a score nobody can justify.
 */
export function verificationStrength(issuer) {
    const verification = issuer?.custodyVerification ?? null;
    const machineReadable = verification?.machineReadable === true;
    const raw = typeof verification?.type === 'string' ? verification.type.trim() : '';
    const type = raw === '' ? 'unknown' : raw;

    if (!Object.hasOwn(VERIFICATION_STRENGTH, type)) {
        return { strength: null, label: null, machineReadable, type };
    }
    const strength = VERIFICATION_STRENGTH[type];
    return { strength, label: VERIFICATION_LABELS[strength], machineReadable, type };
}

/**
 * MODEL.md §3.3 — the control surface an issuer's mints actually expose, aggregated over
 * onchain.json-shaped records. "all"/"some"/"none" over the issuer's tokens; null when the issuer
 * has no mints at all, because "none of zero mints can be clawed back" is not a fact about the
 * issuer. `keyGovernance` and `freezeExercised` are dossier facts and are merged in by the caller.
 */
export function controlSurface(tokens) {
    const list = Array.isArray(tokens) ? tokens.filter((t) => t && typeof t === 'object') : [];

    const share = (predicate) => {
        if (list.length === 0) return null;
        const hits = list.filter(predicate).length;
        if (hits === 0) return 'none';
        return hits === list.length ? 'all' : 'some';
    };
    const isAddress = (value) => typeof value === 'string' && value.trim().length > 0;

    return {
        clawback: share((t) => t.permanentDelegate === true),
        freezeAuthority: share((t) => isAddress(t.freezeAuthority)),
        pausable: share((t) => t.pausable === true),
        allowlist: share((t) => t.defaultAccountStateFrozen === true),
        hookActive: share((t) => isAddress(t.transferHookProgram)),
        transferFeeBps: [...new Set(list.map((t) => t.transferFeeBps).filter((v) => Number.isFinite(v)))]
            .sort((a, b) => a - b),
        pausedNow: list.filter((t) => t.paused === true).length
    };
}

/** A premium is only meaningful where there is enough liquidity to arbitrage it (MODEL.md §3.5). */
export const PREMIUM_MIN_LIQUIDITY_USD = 50000;

/** Median of the finite values only; even counts average the two middle values. */
export function median(values) {
    const finite = (Array.isArray(values) ? values : []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (finite.length === 0) return null;
    const mid = finite.length >> 1;
    return finite.length % 2 === 1 ? finite[mid] : (finite[mid - 1] + finite[mid]) / 2;
}

/** Σ of the finite values, or null when not one value was finite — so nothing missing reads as 0. */
function sumFinite(values) {
    let total = null;
    for (const value of values) {
        if (Number.isFinite(value)) total = (total ?? 0) + value;
    }
    return total;
}

function finiteOrNull(value) {
    return Number.isFinite(value) ? value : null;
}

function pricesIndex(prices) {
    if (prices instanceof Map) return prices;
    const index = new Map();
    if (Array.isArray(prices)) {
        for (const row of prices) {
            if (row && typeof row.mint === 'string') index.set(row.mint, row);
        }
    }
    return index;
}

/**
 * Market facts of one token, read from either a universe.json item (`stats24h`, `audit`) or an
 * already-built stocks-issuers.json / stocks-tokens.json token record (`market`), so the aggregate can be computed from
 * whichever shape the caller holds.
 */
function tokenMarketFacts(token) {
    const built = token?.market ?? null;
    const stats = token?.stats24h ?? null;
    return {
        liquidity: finiteOrNull(built ? built.liquidity : token?.liquidity),
        holderCount: finiteOrNull(built ? built.holderCount : token?.holderCount),
        vol24: built ? finiteOrNull(built.vol24) : sumFinite([stats?.buyVolume, stats?.sellVolume]),
        organicVol24: built
            ? finiteOrNull(built.organicVol24)
            : sumFinite([stats?.buyOrganicVolume, stats?.sellOrganicVolume]),
        top10HolderPct: finiteOrNull(built ? built.top10HolderPct : token?.audit?.topHoldersPercentage)
    };
}

/**
 * MODEL.md §3.5 — per-issuer market reality over the issuer's (live) tokens. `prices` is
 * reference-prices.json's `items` (array or a mint-keyed Map); a token that already carries a
 * `reference` block is read from that. Tokens whose 24 h volume is unknown are excluded from
 * `zeroVolumeShare` entirely rather than counted as zero-volume.
 */
export function marketReality(tokens, prices) {
    const list = Array.isArray(tokens) ? tokens.filter((t) => t && typeof t === 'object') : [];
    const index = pricesIndex(prices);

    const facts = list.map((token) => {
        const priceRow = index.get(token.mint) ?? null;
        const premiumPct = finiteOrNull(priceRow?.premiumPct ?? token?.reference?.premiumPct);
        const paused = token?.control ? token.control.paused : token?.paused;
        return { ...tokenMarketFacts(token), premiumPct, paused, listed: token.listedOnJupiter === true };
    });

    const vol24Usd = sumFinite(facts.map((f) => f.vol24));
    const organicVol24 = sumFinite(facts.map((f) => f.organicVol24));
    const premiumSample = facts.filter(
        (f) => Number.isFinite(f.liquidity) && f.liquidity > PREMIUM_MIN_LIQUIDITY_USD && Number.isFinite(f.premiumPct)
    );
    const withVolume = facts.filter((f) => Number.isFinite(f.vol24));

    return {
        tokens: list.length,
        tokensListedOnJupiter: facts.filter((f) => f.listed).length,
        dexLiquidityUsd: sumFinite(facts.map((f) => f.liquidity)),
        vol24Usd,
        organicSharePct:
            Number.isFinite(organicVol24) && Number.isFinite(vol24Usd) && vol24Usd > 0
                ? (organicVol24 / vol24Usd) * 100
                : null,
        holdersSum: sumFinite(facts.map((f) => f.holderCount)),
        medianTop10Pct: median(facts.map((f) => f.top10HolderPct)),
        premiumMedianPct: median(premiumSample.map((f) => f.premiumPct)),
        premiumSampleSize: premiumSample.length,
        zeroVolumeShare: withVolume.length
            ? withVolume.filter((f) => f.vol24 === 0).length / withVolume.length
            : null,
        pausedTokens: facts.filter((f) => f.paused === true).length
    };
}

/**
 * The documented ETF underlyings among the xStocks/Backpack listed-equity lines (MODEL.md §3.6).
 * Deliberately short: it is a hand-checked list, not an attempt at a security master.
 */
export const ETF_UNDERLYING_TICKERS = [
    'SPY', 'QQQ', 'VOO', 'GLD', 'SLV', 'IWM', 'DIA', 'TLT', 'XLF', 'XLK', 'XLE', 'VTI', 'ITOT', 'BND',
    'ARKK', 'IBIT', 'ETHA'
];

/**
 * Word-bounded on purpose: a plain "contains ETF" also matches "Netflix xStock", which would file
 * NFLXx as a fund.
 */
const ETF_IN_NAME = /\bETFs?\b/i;

function listedEquityType(token) {
    const name = typeof token?.name === 'string' ? token.name : '';
    if (ETF_IN_NAME.test(name)) return 'etf';
    const ticker = typeof token?.underlyingTicker === 'string' ? token.underlyingTicker.toUpperCase() : null;
    return ticker && ETF_UNDERLYING_TICKERS.includes(ticker) ? 'etf' : 'stock';
}

/** Ondo publishes both an instrument type and an asset class as tags; the asset class is finer. */
function ondoInstrumentType(ondoItem) {
    const tags = Array.isArray(ondoItem?.tagSlugs) ? ondoItem.tagSlugs : null;
    if (!tags) return 'unknown';
    if (tags.includes('fixed-income')) return 'fixed-income';
    if (tags.includes('commodities')) return 'commodity';
    if (tags.includes('crypto-native-assets')) return 'crypto-etp';
    if (tags.includes('etf') || tags.includes('closed-end-fund-cef')) return 'etf';
    if (tags.includes('stock')) return 'stock';
    return 'unknown';
}

/**
 * MODEL.md §3.6 — what the token tracks, from its issuer's own convention. `ondoItem` is the
 * matching sponsor-apis Ondo record (joined on ticker) and is ignored for every other issuer.
 * Backpack's line is listed US equities, graded by the same rule as xStocks; its one private-company
 * mint (SPCX) is therefore filed as a stock, which the issuer dossier documents.
 */
export function instrumentType(token, ondoItem) {
    switch (token?.issuer ?? null) {
        case 'prestocks':
        case 'tessera':
            return 'private-company';
        case 'shift':
            return 'leveraged';
        case 'superstate-opening-bell':
        case 'bullish':
        case 'securitize':
            return 'stock';
        case 'ondo-global-markets':
            return ondoInstrumentType(ondoItem);
        case 'xstocks-backed':
        case 'backpack-securities':
            return listedEquityType(token);
        default:
            return 'unknown';
    }
}

/** Parses a number that may arrive as a string. Absent or unparseable stays null, never 0. */
export function toFiniteNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

/**
 * MODEL.md §7 — `supplyRaw / 10^decimals × uiMultiplier`, where the multiplier is the Token-2022
 * scaled-UI-amount config. An absent multiplier means the mint carries no such config, which is a
 * multiplier of exactly 1; a present but unparseable one is missing data and yields null.
 * Jupiter's usdPrice is already multiplier-adjusted, so prices must never be multiplied by it.
 */
export function supplyUi(raw, decimals, multiplier) {
    const rawAmount = toFiniteNumber(raw);
    if (rawAmount === null) return null;
    if (!Number.isInteger(decimals) || decimals < 0) return null;

    let scale = 1;
    if (multiplier !== null && multiplier !== undefined) {
        scale = toFiniteNumber(multiplier);
        if (scale === null || scale <= 0) return null;
    }
    return (rawAmount / 10 ** decimals) * scale;
}

// ------------------------------------------------------------------ §11 trading activity

/** How many tokens a per-issuer `traders24` may double-count; the figure is a Σ, not a distinct set. */
export const TRADERS_NOTE = 'wallets may overlap across tokens';

/** `trades24 / traders24`, and null unless both are known and at least one wallet traded. */
export function tradesPerTrader(trades24, traders24) {
    if (!Number.isFinite(trades24) || !Number.isFinite(traders24) || traders24 <= 0) return null;
    return trades24 / traders24;
}

/**
 * The latest of `[{at, venue}]` by parsed instant, returning the ORIGINAL string (so the offset the
 * source published survives) and the venue it belongs to. An unparseable or absent timestamp is
 * skipped rather than sorted as a string, which would rank "2026-09-16T07:00:00+02:00" after
 * "2026-09-16T06:00:00+00:00" — the same instant an hour apart.
 */
function latestTrade(entries) {
    let best = null;
    let bestMs = null;
    for (const entry of entries) {
        const at = typeof entry?.at === 'string' && entry.at.trim() !== '' ? entry.at : null;
        if (at === null) continue;
        const ms = Date.parse(at);
        if (!Number.isFinite(ms)) continue;
        if (bestMs === null || ms > bestMs) {
            bestMs = ms;
            best = { at, venue: typeof entry.venue === 'string' && entry.venue.trim() !== '' ? entry.venue : null };
        }
    }
    return best ?? { at: null, venue: null };
}

/**
 * Thresholds for the cross-venue price spread. A spread is only evidence of a real arbitrage gap
 * when both sides are prices somebody could actually have traded at, so a venue qualifies only
 * with real depth behind it (a DEX pool) or real turnover and a recent print (a CEX market). A
 * $200 pool quoting a stale price would otherwise manufacture a 17 % "spread" out of nothing.
 */
export const SPREAD_MIN_DEX_LIQUIDITY_USD = 10000;
export const SPREAD_MIN_CEX_VOLUME_USD = 5000;
export const SPREAD_MAX_STALENESS_MS = 2 * 60 * 60 * 1000;

/**
 * A CoinGecko market name reduced to a venue identity comparable with a DexScreener `dexId`:
 * lowercased, anything parenthesised removed, then everything that is not a letter. So
 * "Raydium (CLMM)" → "raydium" and "Meteora" → "meteora".
 */
function venueKey(name) {
    return typeof name === 'string' ? name.replace(/\([^)]*\)/g, '').toLowerCase().replace(/[^a-z]/g, '') : '';
}

/**
 * The venues whose price may enter the spread: `[{venue, priceUsd}]`, DEX pools first in the order
 * venues.json holds them (so a tie is resolved deterministically by that order).
 *
 * CoinGecko lists DEX markets among its tickers, so the same venue can arrive twice — a DexScreener
 * pool and a CoinGecko market for it. Two prints of ONE venue taken at different moments are not an
 * arbitrage gap, so the CoinGecko copy is dropped and the DexScreener side kept: it is the one that
 * carries liquidity, which is what the floor below is judged on. Two different pools of the same dex
 * ARE two venues for this purpose — a trader can arbitrage between them — so `dex` is never
 * deduplicated against itself.
 *
 * A CEX ticker carries the only timestamp either source publishes, so it is the only side that can
 * be checked for staleness — and it is checked against `asOf`, the moment the venues file was
 * FETCHED, never the clock, so a rebuild months later grades the same data the same way. With no
 * `asOf` no ticker can be shown to be fresh and none qualifies: a spread against a price of unknown
 * age is exactly the fiction the thresholds exist to prevent.
 */
function spreadCandidates(dex, cex, asOf) {
    const asOfMs = typeof asOf === 'string' && asOf.trim() !== '' ? Date.parse(asOf) : null;
    const out = [];
    for (const pair of dex) {
        const priceUsd = toFiniteNumber(pair?.priceUsd);
        const liquidityUsd = toFiniteNumber(pair?.liquidityUsd);
        if (priceUsd === null || priceUsd <= 0) continue;
        if (liquidityUsd === null || liquidityUsd < SPREAD_MIN_DEX_LIQUIDITY_USD) continue;
        const venue = typeof pair.dexId === 'string' && pair.dexId !== '' ? pair.dexId : null;
        if (venue === null) continue;
        out.push({ venue, priceUsd });
    }
    const dexVenues = new Set(out.map((c) => venueKey(c.venue)));
    for (const ticker of cex) {
        const priceUsd = toFiniteNumber(ticker?.priceUsd);
        const volume24Usd = toFiniteNumber(ticker?.volume24Usd);
        if (priceUsd === null || priceUsd <= 0) continue;
        if (volume24Usd === null || volume24Usd < SPREAD_MIN_CEX_VOLUME_USD) continue;
        const tradedMs = typeof ticker.lastTradedAt === 'string' ? Date.parse(ticker.lastTradedAt) : Number.NaN;
        if (!Number.isFinite(asOfMs) || !Number.isFinite(tradedMs)) continue;
        if (Math.abs(asOfMs - tradedMs) > SPREAD_MAX_STALENESS_MS) continue;
        const venue = typeof ticker.market === 'string' && ticker.market !== '' ? ticker.market : null;
        if (venue === null) continue;
        const key = venueKey(venue);
        if (key !== '' && dexVenues.has(key)) continue;
        if (key !== '') dexVenues.add(key);
        out.push({ venue, priceUsd });
    }
    return out;
}

/**
 * `(highest / lowest − 1) × 100` over the qualifying venues, plus which venues those were. Fewer
 * than two qualifying venues is not a narrow spread, it is no measurement: everything stays null.
 */
function venueSpread(candidates) {
    if (candidates.length < 2) {
        return { venuesPriced: candidates.length, venueSpreadPct: null, venueSpreadLow: null, venueSpreadHigh: null };
    }
    let low = candidates[0];
    let high = candidates[0];
    for (const candidate of candidates) {
        if (candidate.priceUsd < low.priceUsd) low = candidate;
        // `>=`, so two venues quoting the SAME price name both sides of a 0 % spread instead of
        // printing one venue twice ("KCEX → KCEX", seen on STRCon).
        if (candidate.priceUsd >= high.priceUsd) high = candidate;
    }
    return {
        venuesPriced: candidates.length,
        venueSpreadPct: (high.priceUsd / low.priceUsd - 1) * 100,
        venueSpreadLow: low.venue,
        venueSpreadHigh: high.venue
    };
}

/**
 * MODEL.md §11.2 — the trading activity of ONE token: the Jupiter 24 h trade counts
 * (`universeItem.stats24h`) joined with the venue facts collected by fetch-venues.mjs
 * (`venuesItem`, one item of stocks/data/venues.json).
 *
 * Counts and trade figures come from different sources on purpose and are never summed together:
 * `trades24` is Jupiter's, over every route it sees; `dexTxns24` is DexScreener's, over the pools it
 * indexes. Every field is null when unknown. The three count-shaped fields (`dexPairs`,
 * `cexMarkets`, `venueCount`) are the one place a 0 is meaningful — but only once the token HAS a
 * venues record: without one nothing was looked up, so they stay null rather than claiming the
 * token trades nowhere.
 *
 * `asOf` is the venues file's own `fetchedAt`; it only ever gates the price-spread staleness check
 * (see `spreadCandidates`), so the function stays pure and a rebuild of old data is reproducible.
 */
export function tokenActivity(universeItem, venuesItem, { asOf = null } = {}) {
    const stats = universeItem?.stats24h ?? null;
    const buys24 = toFiniteNumber(stats?.numBuys);
    const sells24 = toFiniteNumber(stats?.numSells);
    const trades24 = sumFinite([buys24, sells24]);
    const traders24 = toFiniteNumber(stats?.numTraders);

    const hasVenues = venuesItem !== null && venuesItem !== undefined && typeof venuesItem === 'object';
    const dex = hasVenues && Array.isArray(venuesItem.dex) ? venuesItem.dex : [];
    const cex = hasVenues && Array.isArray(venuesItem.cex) ? venuesItem.cex : [];
    const dexIds = new Set(dex.map((p) => p?.dexId).filter((v) => typeof v === 'string' && v !== ''));
    const markets = new Set(cex.map((t) => t?.market).filter((v) => typeof v === 'string' && v !== ''));
    const last = latestTrade(cex.map((t) => ({ at: t?.lastTradedAt, venue: t?.market })));
    const spread = hasVenues
        ? venueSpread(spreadCandidates(dex, cex, asOf ?? venuesItem.fetchedAt ?? null))
        : { venuesPriced: null, venueSpreadPct: null, venueSpreadLow: null, venueSpreadHigh: null };

    return {
        buys24,
        sells24,
        trades24,
        traders24,
        organicBuyers24: toFiniteNumber(stats?.numOrganicBuyers),
        tradesPerTrader: tradesPerTrader(trades24, traders24),
        dexPairs: hasVenues ? dex.length : null,
        dexTxns24: sumFinite(dex.map((p) => toFiniteNumber(p?.txns24))),
        cexMarkets: hasVenues ? cex.length : null,
        venueCount: hasVenues ? dexIds.size + markets.size : null,
        venuesPriced: spread.venuesPriced,
        venueSpreadPct: spread.venueSpreadPct,
        venueSpreadLow: spread.venueSpreadLow,
        venueSpreadHigh: spread.venueSpreadHigh,
        lastTradedAt: last.at,
        lastTradedVenue: last.venue
    };
}

/** The `activity` a built token carries, or one computed on the spot from a raw universe item. */
function activityOf(token) {
    const own = token?.activity ?? null;
    return own !== null && typeof own === 'object' ? own : tokenActivity(token, null);
}

/**
 * MODEL.md §11.3 — the issuer's trading activity over its tokens (`tokens`, either built records
 * carrying `activity` or raw universe items) and their venue records (`venuesItems`, the
 * venues.json items belonging to those tokens).
 *
 * `traders24` is a Σ of per-token distinct-wallet counts, so a wallet trading two of the issuer's
 * tokens is counted twice; `tradersNote` ships beside it so the page cannot present it as a
 * distinct-wallet total. `venueCount` and `venuesTop`, by contrast, ARE distinct: they come from
 * aggregating the venue records by name, so a dex or market serving five of the issuer's tokens is
 * one venue. `venuesTop` ranks by Σ 24 h volume — the one figure a DEX pair and a CoinGecko ticker
 * both report — and carries `liquidityUsd` only where the venue is a DEX pair that reported it (a
 * CEX ticker never does, MODEL.md §11.1). `venueSpreadMedianPct` is the median over the issuer's
 * tokens that HAVE a spread — a median, not a Σ, because a spread is a property of one token's
 * venues and tokens priced on one venue must not drag it toward zero.
 */
export function issuerActivity(tokens, venuesItems) {
    const list = Array.isArray(tokens) ? tokens.filter((t) => t && typeof t === 'object') : [];
    const activities = list.map(activityOf);

    const trades24 = sumFinite(activities.map((a) => toFiniteNumber(a.trades24)));
    const traders24 = sumFinite(activities.map((a) => toFiniteNumber(a.traders24)));

    const facts = list.map(tokenMarketFacts);
    const vol24 = sumFinite(facts.map((f) => f.vol24));
    const organicVol24 = sumFinite(facts.map((f) => f.organicVol24));

    const items = Array.isArray(venuesItems) ? venuesItems.filter((i) => i && typeof i === 'object') : [];
    const venues = aggregateVenues(items);
    const allVenues = [...venues.dex, ...venues.cex];
    const last = latestTrade([
        ...activities.map((a) => ({ at: a.lastTradedAt, venue: a.lastTradedVenue })),
        ...items.flatMap((i) => (Array.isArray(i.cex) ? i.cex : []).map((t) => ({ at: t?.lastTradedAt, venue: t?.market })))
    ]);

    return {
        tokens: list.length,
        tokensTraded24: activities.filter((a) => Number.isFinite(a.trades24) && a.trades24 > 0).length,
        trades24,
        traders24,
        tradersNote: TRADERS_NOTE,
        tradesPerTrader: tradesPerTrader(trades24, traders24),
        organicSharePct:
            Number.isFinite(organicVol24) && Number.isFinite(vol24) && vol24 > 0
                ? (organicVol24 / vol24) * 100
                : null,
        venueCount: items.length === 0 ? null : allVenues.length,
        venueSpreadMedianPct: median(activities.map((a) => toFiniteNumber(a.venueSpreadPct))),
        venuesTop: topVenues(allVenues, 6, 'volume24Usd').map((v) => ({
            name: v.venue,
            kind: v.kind,
            volume24Usd: v.volume24Usd,
            liquidityUsd: v.liquidityUsd
        })),
        lastTradedAt: last.at,
        lastTradedVenue: last.venue
    };
}
