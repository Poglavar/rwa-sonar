// Pure grading rules for the tokenized-stocks section, per stocks/MODEL.md §3: the two
// ledger-maturity numbers (which must equal what index.html computes), the claim-depth rung,
// verification strength, the per-issuer control surface and market reality, the per-token
// instrument type and the scaled UI supply. No I/O and no network, so every rule is unit-tested
// headlessly (see ../grade.test.js). A missing number stays null here and is never coerced to 0.

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
