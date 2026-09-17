// PURE shaping and rendering for the per-token stock cards (no fs, no network, no clock, no DOM):
// the card slug rules, the one card record that both the .json file and the inlined
// <script type="application/json"> carry, the ≤ 200-character OpenGraph description and the whole
// static HTML page. Everything a card shows is rendered here at build time, so a card is readable
// with JavaScript off; card.js only adds relative ages and a copy button on top.
// The output must be byte-identical when rebuilt from the same inputs (apart from `builtAt`), which
// is why every number is cut to six significant figures and nothing here reads a clock.
// Unit-tested in ../cards.test.js.

import fmt from './fmt.js';
import evidenceLib from './evidence.js';
import { evaluateHealth, topSharePctExcludingLabels } from './health.mjs';

const {
    DASH,
    escapeHtml,
    isSafeUrl,
    isNum,
    fmtMoney,
    fmtPrice,
    fmtPct,
    fmtSignedPct,
    fmtNumber,
    fmtDate,
    fmtDateTime,
    fmtAgeSeconds,
    fmtTradesPerTrader,
    fmtVenueSpread,
    humanizeSlug,
    roundSignificant,
    cardSlug,
    mintSuffix
} = fmt;

/** Significant figures every number in the card JSON is cut to, so a rebuild is byte-identical. */
export const VALUE_DIGITS = 6;

/** The rules table is a summary, so its numbers are shorter than the record's. */
export const TABLE_DIGITS = 3;

/**
 * How much dossier prose a card carries. A card is a summary with a link to the full dossier on
 * stocks.html, and the same text is rendered AND inlined as JSON, so every character is paid for
 * twice against the 15 kB budget. Long fields (what the holder actually owns) get the wide limit.
 */
export const PROSE_MAX = 110;
export const PROSE_MAX_SHORT = 75;

/**
 * How much of a claim a card carries (stocks/EVIDENCE.md §4). A card is size-capped and renders its
 * evidence TWICE — once as the popover, once in the inlined JSON — so it shows the ONE strongest
 * claim per field with the quote cut to QUOTE_MAX; the issuer panel on stocks.html shows every
 * claim on a field, verbatim and uncut. The cut is visible (an ellipsis), never silent.
 */
export const QUOTE_MAX = PROSE_MAX;
export const LOCATOR_MAX = 48;
export const CARD_CLAIMS_PER_FIELD = 1;

/**
 * The fields a card's three issuer-derived sections show, in the order they are rendered. Only
 * these paths' claims are carried onto the card, which is what bounds the byte cost: whatever the
 * researchers add elsewhere in a dossier cannot grow a card.
 */
export const CARD_CLAIM_FIELDS = [
    'legalForm', 'holderClaim', 'issuingEntity', 'entityJurisdiction', 'governingLaw',
    'regulatoryStatus',
    'redemption.available', 'redemption.eligibility', 'redemption.rails', 'redemption.fees',
    'transferRestrictions.allowlist', 'transferRestrictions.kycToHold',
    'transferRestrictions.usPersonsExcluded', 'transferRestrictions.mechanism',
    'dividends', 'voting',
    'keyGovernance.mint', 'keyGovernance.freeze', 'keyGovernance.delegate',
    'custodyVerification.type', 'custodyVerification.agent', 'custodyVerification.frequency'
];

/** Venue rows per side, and holder rows — the cap that keeps a card small and its wallet list short. */
export const VENUE_ROWS = 3;
export const HOLDER_ROWS = 5;

/** OpenGraph descriptions are cut off by every renderer somewhere near here. */
export const OG_DESCRIPTION_MAX = 200;

/**
 * The per-card byte ceiling the build enforces. The target was 15 kB; 20 kB is what the required
 * card actually costs, measured over all 441 on 2026-09-17 (min 13.9, median 17.0, max 18.9 kB on
 * POLYMARKET): ~13.4 kB of rendered page — the eleven sections, the ten-rule audit table with every
 * rule's thresholds, inputs and note, the holder rows, the venue tables — plus ~5.5 kB for the
 * inlined machine-readable record beside it. Trimming got the page there from 23.8 kB (prose cut to
 * a summary with the dossier one click away on stocks.html, three venue rows a side, five holder
 * rows, and the published record stripped of everything the page already renders in full). Going
 * below this would mean dropping a required section rather than tightening further, so the ceiling
 * sits just above the widest card: enough headroom for a long venue name, tight enough to catch a
 * REGRESSION, which is its job — the build FAILS on a card over it.
 *
 * 2026-09-18, raised to 22 kB by the evidence chips (EVIDENCE.md §4): the twenty-two issuer-derived
 * rows each gained a chip, which on a dossier with no claims yet is ~1.3 kB of hollow "§?" markup
 * per card, and the footer an evidence line. Re-measured over all 471 with the chips in: min 13.7,
 * median 17.9, max 20.0 kB (POLYMARKET) — 1.1 kB over the old ceiling at the widest card. The
 * inlined record carries only the fields that actually HAVE a claim, so a hollow chip costs nothing
 * there.
 *
 * 34 kB from 2026-09-18, measured not guessed, because a hollow chip is the CHEAP case: a real
 * claim replaces a 58-byte span with a popover carrying the quote, the source link, the locator and
 * the date it was read. Measured with all twelve dossiers sourced (1263 claims): nearly every one
 * of the 22 issuer-derived rows is claimed, the chips cost 12.8 kB on TSMon, and the 471 cards run
 * min 24.0, median 29.0, max 31.5 kB as the build writes them (32.1 kB with the canonical URL, the
 * figure stocks/cards.test.js prints) — so the ceiling is 34 kB, the real maximum plus ~8 %, and
 * the build still FAILS above it. Evidence is a third of a sourced card; that is the feature, not
 * a regression. Before the claims landed the same 471 cards were min 13.7, median 17.9 kB.
 *
 * What was trimmed to get there rather than paying for it out of the budget (all measured on TSMon,
 * which went 44.9 -> 31.5 kB): the summary's `title` no longer repeats the quote the popover shows
 * one tap away (-5.5 kB), the inlined record carries the evidence SUMMARY only, since the claims are
 * rendered above it and served in full by /api/issuers/:slug/claims (-9.3 kB), the source prints as
 * its host rather than its whole URL a second time, the quote is cut to QUOTE_MAX and the locator to
 * LOCATOR_MAX, the read date is a date and not a timestamp, and the note is left off except on a
 * claim with no quote (an inference), where it is the only thing the chip has to say.
 */
export const CARD_BYTE_BUDGET = 34 * 1024;

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A Solana address as `38rXq2…PMsF`; anything else is returned unchanged. */
export function shortAddress(value) {
    if (typeof value !== 'string' || !BASE58_ADDRESS.test(value)) return value;
    return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/**
 * Prose cut at a word boundary with an ellipsis, never mid-word and never longer than `max` + 1.
 * Null, undefined and blank stay null so a missing fact cannot render as an empty quotation.
 */
export function truncate(value, max = PROSE_MAX) {
    if (typeof value !== 'string') return null;
    const text = value.replace(/\s+/g, ' ').trim();
    if (!text) return null;
    if (text.length <= max) return text;
    const cut = text.slice(0, max);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:\s]+$/, '')}…`;
}

/**
 * One file name per mint, stable whatever order the tokens arrive in: the symbol when it is
 * path-safe, and `<slug>-<first 6 of mint>` for every token in a colliding group. The comparison is
 * case-insensitive on purpose — this repo is built on a case-insensitive macOS filesystem and
 * deployed to a case-sensitive Linux one, and NVDAx.html overwriting nvdax.html on only one of the
 * two would be a silently wrong card rather than an error.
 */
export function assignSlugs(tokens) {
    const rows = (Array.isArray(tokens) ? tokens : [])
        .filter((token) => typeof token?.mint === 'string' && token.mint !== '')
        .map((token) => ({ mint: token.mint, base: cardSlug(token.symbol, token.mint) }))
        .filter((row) => row.base !== '')
        .sort((a, b) => (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));

    const groups = new Map();
    for (const row of rows) {
        const key = row.base.toLowerCase();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }

    const slugs = new Map();
    for (const group of groups.values()) {
        const collides = group.length > 1;
        for (const row of group) {
            slugs.set(row.mint, collides ? `${row.base}-${mintSuffix(row.mint)}` : row.base);
        }
    }
    return slugs;
}

/** Every finite number cut to six significant figures; null stays null, never 0. */
function roundDeep(value) {
    if (typeof value === 'number') return roundSignificant(value, VALUE_DIGITS);
    if (Array.isArray(value)) return value.map(roundDeep);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, inner] of Object.entries(value)) out[key] = roundDeep(inner);
        return out;
    }
    return value === undefined ? null : value;
}

function str(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function num(value) {
    return isNum(value) ? value : null;
}

function bool(value) {
    return typeof value === 'boolean' ? value : null;
}

function safeUrl(value) {
    return isSafeUrl(value) ? value.trim() : null;
}

/** A control flag exactly as MODEL §3.3 reads it: an address counts as "on". */
function controlFlag(value) {
    if (value === true) return true;
    if (value === false) return false;
    if (typeof value === 'string' && value.trim()) return true;
    return null;
}

/**
 * The card record: one object, fixed key order, every number rounded — the .json file and the
 * inlined <script type="application/json"> are this, stringified once.
 *
 * @param {object} input
 * @param {object} input.token one stocks-tokens.json .tokens[] record
 * @param {object|null} input.issuer its stocks-issuers.json .issuers[] record
 * @param {object|null} input.holdersItem its stocks/data/holders.json .items[] record
 * @param {object|null} input.venuesItem its stocks/data/venues.json .items[] record
 * @param {object|null} input.afterhoursItem its stocks-afterhours.json .items[] record
 * @param {Map|null} input.meteoraByPair stocks/data/meteora.json .items[] keyed by pairAddress
 * @param {Array|null} input.pools its stocks-trades.json .pools[] entries
 * @param {string} input.slug the card file name (assignSlugs)
 * @param {string} input.builtAt the only value that may differ between two builds
 * @param {object} input.sources per-input fetch timestamps for the footer
 */
export function buildCard(input) {
    const {
        token,
        issuer = null,
        holdersItem = null,
        venuesItem = null,
        afterhoursItem = null,
        meteoraByPair = null,
        pools = null,
        slug = '',
        builtAt = null,
        sources = {}
    } = input ?? {};

    const market = token?.market ?? {};
    const activity = token?.activity ?? {};
    const reference = token?.reference ?? {};
    const control = token?.control ?? {};
    const grades = issuer?.grades ?? {};
    const verdict = evaluateHealth({ token, issuer, holders: holdersItem, pools });
    const top20 = Array.isArray(holdersItem?.top20) ? holdersItem.top20 : [];

    const card = {
        slug,
        builtAt: str(builtAt),
        mint: str(token?.mint),
        symbol: str(token?.symbol),
        name: str(token?.name),
        underlyingTicker: str(token?.underlyingTicker),
        instrumentType: str(token?.instrumentType),
        tokenProgram: str(token?.tokenProgram),
        issuer: {
            slug: str(token?.issuer) ?? str(issuer?.slug),
            name: str(issuer?.name),
            status: str(issuer?.status)
        },
        health: {
            status: verdict.status,
            worstRuleId: verdict.worstRuleId,
            rules: verdict.rules.map((rule) => ({
                id: rule.id,
                label: rule.label,
                status: rule.status,
                value: num(rule.value),
                threshold: str(rule.threshold),
                inputs: rule.inputs ?? null,
                note: str(rule.note)
            }))
        },
        ownership: {
            claimRung: num(grades.claimRung),
            claimLabel: str(grades.claimLabel),
            legalForm: str(issuer?.legalForm),
            holderClaim: truncate(issuer?.holderClaim, PROSE_MAX),
            issuingEntity: truncate(issuer?.issuingEntity, PROSE_MAX),
            entityJurisdiction: truncate(issuer?.entityJurisdiction, PROSE_MAX_SHORT),
            governingLaw: truncate(issuer?.governingLaw, PROSE_MAX_SHORT),
            regulatoryStatus: truncate(issuer?.regulatoryStatus, PROSE_MAX),
            redemption: {
                available: bool(issuer?.redemption?.available),
                eligibility: truncate(issuer?.redemption?.eligibility, PROSE_MAX_SHORT),
                rails: truncate(issuer?.redemption?.rails, PROSE_MAX_SHORT),
                fees: truncate(issuer?.redemption?.fees, PROSE_MAX_SHORT)
            },
            transferRestrictions: {
                allowlist: bool(issuer?.transferRestrictions?.allowlist),
                kycToHold: bool(issuer?.transferRestrictions?.kycToHold),
                usPersonsExcluded: bool(issuer?.transferRestrictions?.usPersonsExcluded),
                mechanism: str(issuer?.transferRestrictions?.mechanism)
            },
            dividends: truncate(issuer?.dividends, PROSE_MAX_SHORT),
            voting: truncate(issuer?.voting, PROSE_MAX_SHORT),
            maturityStage: str(grades.maturityStage),
            maturityStageNum: num(grades.maturityStageNum),
            maturityScore: num(grades.maturityScore)
        },
        reference: {
            source: str(reference.source),
            price: num(reference.price),
            ageSeconds: num(reference.ageSeconds),
            marketOpen: bool(reference.marketOpen),
            note: truncate(reference.note, PROSE_MAX_SHORT),
            usdPrice: num(market.usdPrice),
            premiumPct: num(reference.premiumPct)
        },
        afterHours: afterhoursItem === null ? null : {
            source: str(afterhoursItem.source),
            openPremiumPct: num(afterhoursItem.openPremiumPct),
            closedPremiumPct: num(afterhoursItem.closedPremiumPct),
            gapPct: num(afterhoursItem.gapPct),
            tradesOpen: num(afterhoursItem.tradesOpen),
            tradesClosed: num(afterhoursItem.tradesClosed),
            windowFrom: str(afterhoursItem.windowFrom),
            windowTo: str(afterhoursItem.windowTo)
        },
        depth: {
            liquidityUsd: num(market.liquidity),
            vol24Usd: num(market.vol24),
            organicVol24Usd: num(market.organicVol24),
            organicSharePct: num(market.organicSharePct),
            trades24: num(activity.trades24),
            traders24: num(activity.traders24),
            tradesPerTrader: num(activity.tradesPerTrader),
            dexPairs: num(activity.dexPairs),
            cexMarkets: num(activity.cexMarkets),
            venuesPriced: num(activity.venuesPriced),
            venueSpreadPct: num(activity.venueSpreadPct),
            venueSpreadLow: str(activity.venueSpreadLow),
            venueSpreadHigh: str(activity.venueSpreadHigh),
            lastTradedAt: str(activity.lastTradedAt),
            lastTradedVenue: str(activity.lastTradedVenue),
            holderCount: num(market.holderCount),
            mcapUsd: num(market.mcap)
        },
        holders: {
            supplyUi: num(holdersItem?.supplyUi ?? token?.supplyUi),
            top1SharePctExLabels: topSharePctExcludingLabels(top20, 1),
            top5SharePctExLabels: topSharePctExcludingLabels(top20, 5),
            top20SharePctExLabels: topSharePctExcludingLabels(top20, 20),
            top1SharePct: num(holdersItem?.top1SharePct),
            top5SharePct: num(holdersItem?.top5SharePct),
            top20SharePct: num(holdersItem?.top20SharePct),
            distinctOwnersTop20: num(holdersItem?.distinctOwnersTop20),
            frozenAccountsTop20: num(holdersItem?.frozenAccountsTop20),
            top: top20.slice(0, HOLDER_ROWS).map((row) => ({
                owner: str(row?.owner),
                sharePct: num(row?.sharePct),
                ownerLabel: str(row?.ownerLabel),
                frozen: row?.state === 'frozen'
            }))
        },
        control: {
            clawback: controlFlag(control.clawback),
            freezeAuthority: str(control.freezeAuthority),
            pausable: controlFlag(control.pausable),
            paused: bool(control.paused),
            allowlist: controlFlag(control.allowlist),
            transferFeeBps: num(control.transferFeeBps),
            hookActive: controlFlag(control.hookActive)
        },
        keyGovernance: {
            mint: str(issuer?.keyGovernance?.mint),
            freeze: str(issuer?.keyGovernance?.freeze),
            delegate: str(issuer?.keyGovernance?.delegate),
            evidence: truncate(issuer?.keyGovernance?.evidence, PROSE_MAX)
        },
        verification: {
            type: str(issuer?.custodyVerification?.type),
            agent: truncate(issuer?.custodyVerification?.agent, PROSE_MAX_SHORT),
            frequency: truncate(issuer?.custodyVerification?.frequency, PROSE_MAX_SHORT),
            link: safeUrl(issuer?.custodyVerification?.link),
            machineReadable: bool(issuer?.custodyVerification?.machineReadable),
            strength: num(grades.verificationStrength),
            label: str(grades.verificationLabel)
        },
        venues: {
            dex: venueRows(venuesItem?.dex, meteoraByPair),
            cex: cexRows(venuesItem?.cex)
        },
        // Evidence (stocks/EVIDENCE.md §4): the issuer's coverage numbers for the footer line, and
        // the strongest claim per field for the "§" chips on the three issuer-derived sections.
        evidence: cardEvidence(issuer),
        issuerApi: issuerApiFacts(token?.issuer, token?.issuerApi),
        sources: {
            tokens: str(sources.tokens),
            issuers: str(sources.issuers),
            issuerApi: str(sources.issuerApi),
            holders: str(sources.holders),
            venues: str(sources.venues),
            trades: str(sources.trades),
            afterhours: str(sources.afterhours),
            meteora: str(sources.meteora)
        }
    };

    return roundDeep(card);
}

/** The busiest DEX pools, with the Meteora pool detail merged in when meteora.json has it. */
function venueRows(dex, meteoraByPair) {
    const rows = (Array.isArray(dex) ? dex : [])
        .filter((row) => row && typeof row === 'object')
        .slice()
        .sort((a, b) => (num(b.volume24Usd) ?? -1) - (num(a.volume24Usd) ?? -1) ||
            (num(b.liquidityUsd) ?? -1) - (num(a.liquidityUsd) ?? -1) ||
            String(a.pairAddress ?? '').localeCompare(String(b.pairAddress ?? '')))
        .slice(0, VENUE_ROWS);

    return rows.map((row) => {
        const pool = meteoraByPair instanceof Map ? meteoraByPair.get(row.pairAddress) ?? null : null;
        return {
            dexId: str(row.dexId),
            pairAddress: str(row.pairAddress),
            quoteSymbol: str(row.quoteSymbol),
            priceUsd: num(row.priceUsd),
            liquidityUsd: num(row.liquidityUsd),
            volume24Usd: num(row.volume24Usd),
            txns24: num(row.txns24),
            url: safeUrl(row.url),
            meteora: pool === null ? null : {
                poolType: str(pool.poolType),
                binStep: num(pool.binStep),
                baseFeePct: num(pool.baseFeePct),
                dynamicFeePct: num(pool.dynamicFeePct),
                fees24Usd: num(pool.fees24Usd)
            }
        };
    });
}

/** The busiest exchange markets. */
function cexRows(cex) {
    return (Array.isArray(cex) ? cex : [])
        .filter((row) => row && typeof row === 'object')
        .slice()
        .sort((a, b) => (num(b.volume24Usd) ?? -1) - (num(a.volume24Usd) ?? -1) ||
            String(a.market ?? '').localeCompare(String(b.market ?? '')))
        .slice(0, VENUE_ROWS)
        .map((row) => ({
            market: str(row.market),
            target: str(row.target),
            priceUsd: num(row.priceUsd),
            volume24Usd: num(row.volume24Usd),
            url: safeUrl(row.url),
            lastTradedAt: str(row.lastTradedAt)
        }));
}

/**
 * The record the card PUBLISHES — the inlined <script type="application/json"> and the .json file
 * are both exactly this, so a machine reads a card without parsing its HTML.
 *
 * It is not the whole of buildCard's record, for one measured reason: a card has a 15 kB budget, and
 * the dossier prose the page renders above (what the holder owns, the jurisdiction, the redemption
 * terms, the authority-key evidence) costs ~1.3 kB rendered and would cost it again inlined, as
 * would the rule labels and threshold strings, which are identical on all 441 cards and already
 * ship once in stocks-health.json's `rules`. So the published record keeps everything a machine
 * cannot recover — identity, every rule's status, value and INPUTS, the numbers, the holder
 * shares, the control surface, the venues and the per-source timestamps — and leaves the prose to
 * the rendered page and the full dossier on stocks.html, which the card links to.
 */
/**
 * The card's evidence block. `coverage` and `lastCheckedAt` are the ISSUER's own numbers as the
 * build counted them (so a card, the issuer panel and stocks-issuers.json cannot disagree);
 * `fields` carries only CARD_CLAIM_FIELDS, only the strongest claim on each, and the quote cut to
 * QUOTE_MAX. A field with no claim is kept with `needed: true` so the card can draw the hollow
 * "§?" chip; a field that neither has nor needs a claim is left out entirely.
 */
export function cardEvidence(issuer) {
    const summary = issuer?.evidence ?? null;
    const byField = evidenceLib.claimsByField(Array.isArray(issuer?.claims) ? issuer.claims : []);
    const needed = new Set(Array.isArray(issuer?.evidenceFields) ? issuer.evidenceFields : []);
    const fields = {};
    for (const path of CARD_CLAIM_FIELDS) {
        const claims = (byField[path] ?? []).slice(0, CARD_CLAIMS_PER_FIELD).map((claim) => ({
            quote: truncate(claim.quote, QUOTE_MAX),
            url: safeUrl(claim.url),
            locator: truncate(claim.locator, LOCATOR_MAX),
            status: str(claim.status),
            method: str(claim.method),
            accessedAt: str(claim.accessedAt),
            // The note is OUR commentary rather than the source's words, and a card is a
            // byte-capped summary, so it is normally left to the issuer panel. The exception is a
            // claim with NO quote — an `inference` — where the note is the only thing the chip has
            // to say, and a popover with nothing in it would be worse than no chip at all.
            note: claim.quote === null ? truncate(claim.note, PROSE_MAX_SHORT) : null
        }));
        const isNeeded = needed.has(path);
        if (claims.length === 0 && !isNeeded) continue;
        fields[path] = { needed: isNeeded, claims };
        // `publicCard` drops the claim-less entries again: `coverage` already says how many fields
        // need a source, so repeating one object per hollow chip in the inlined JSON is bytes for
        // nothing on a card that has a budget.
    }
    return {
        coverage: summary?.coverage ?? { sourced: 0, needed: 0 },
        claims: summary?.claims ?? 0,
        confirmed: summary?.confirmed ?? 0,
        unverified: summary?.unverified ?? 0,
        inference: summary?.inference ?? 0,
        corrected: summary?.corrected ?? 0,
        lastCheckedAt: summary?.lastCheckedAt ?? null,
        fields
    };
}

/** The coverage numbers without the per-field claims. */
function evidenceSummaryOf(evidence) {
    if (!evidence) return null;
    const { fields: _fields, ...summary } = evidence;
    return summary;
}

export function publicCard(card) {
    return {
        slug: card.slug,
        builtAt: card.builtAt,
        mint: card.mint,
        symbol: card.symbol,
        name: card.name,
        underlyingTicker: card.underlyingTicker,
        instrumentType: card.instrumentType,
        tokenProgram: card.tokenProgram,
        issuer: card.issuer,
        health: {
            status: card.health.status,
            worstRuleId: card.health.worstRuleId,
            rules: card.health.rules.map((rule) => ({
                id: rule.id,
                status: rule.status,
                value: rule.value,
                inputs: rule.inputs
            }))
        },
        // The evidence SUMMARY only. The per-field claims are rendered on the page above, and the
        // full set — every claim on every field, uncut — is served by /api/issuers/:slug/claims and
        // carried by stocks-issuers.json. Inlining them here as well cost 9.3 kB on a fully sourced
        // card (measured 2026-09-18 on TSMon), which is a third of the card for a second copy of
        // what the reader is already looking at.
        evidence: evidenceSummaryOf(card.evidence),
        ownership: {
            claimRung: card.ownership.claimRung,
            claimLabel: card.ownership.claimLabel,
            legalForm: card.ownership.legalForm,
            redemptionAvailable: card.ownership.redemption.available,
            transferRestrictions: card.ownership.transferRestrictions,
            maturityStage: card.ownership.maturityStage,
            maturityStageNum: card.ownership.maturityStageNum,
            maturityScore: card.ownership.maturityScore
        },
        reference: {
            source: card.reference.source,
            price: card.reference.price,
            ageSeconds: card.reference.ageSeconds,
            marketOpen: card.reference.marketOpen,
            usdPrice: card.reference.usdPrice,
            premiumPct: card.reference.premiumPct
        },
        afterHours: card.afterHours,
        depth: card.depth,
        holders: card.holders,
        control: card.control,
        keyGovernance: {
            mint: card.keyGovernance.mint,
            freeze: card.keyGovernance.freeze,
            delegate: card.keyGovernance.delegate
        },
        verification: {
            type: card.verification.type,
            link: card.verification.link,
            machineReadable: card.verification.machineReadable,
            strength: card.verification.strength,
            label: card.verification.label
        },
        venues: card.venues,
        issuerApi: card.issuerApi,
        sources: card.sources
    };
}

/**
 * What each issuer's own API says, per issuer, because the four payloads share almost no fields.
 * These are the ISSUER's numbers — a self-published mark, not an independent price — and the card
 * labels them as such. An issuer with no API returns null and the section is absent.
 */
export function issuerApiFacts(issuerSlug, api) {
    if (!api || typeof api !== 'object') return null;
    if (issuerSlug === 'prestocks') {
        return {
            kind: 'prestocks',
            markPrice: num(api.markPrice),
            markValuation: num(api.markValuation),
            tokenPrice: num(api.tokenPrice),
            impliedValuation: num(api.impliedValuation),
            supply: num(api.supply),
            premiumPct: num(api.premiumPct),
            externalUrl: safeUrl(api.externalUrl)
        };
    }
    if (issuerSlug === 'tessera') {
        return {
            kind: 'tessera',
            sector: str(api.sector),
            holders: num(api.holders),
            markPrice: num(api.markPrice),
            markValuation: num(api.markValuation)
        };
    }
    if (issuerSlug === 'ondo-global-markets') {
        return {
            kind: 'ondo',
            ondoPrice: num(api.ondoPrice),
            impliedUnderlyingPrice: num(api.impliedUnderlyingPrice),
            isTradingPaused: bool(api.isTradingPaused),
            isOffhoursTradable: bool(api.isOffhoursTradable),
            isAssetTradeable: bool(api.tradingStatus?.isAssetTradeable),
            isMarketOpen: bool(api.tradingStatus?.isMarketOpen),
            currentSession: str(api.tradingStatus?.currentSession),
            nextMarketOpen: str(api.tradingStatus?.nextMarketOpen),
            assetPauseReason: truncate(api.tradingStatus?.assetPauseReason, PROSE_MAX_SHORT)
        };
    }
    if (issuerSlug === 'superstate-opening-bell') {
        return {
            kind: 'superstate',
            issuerEntityName: str(api.issuerEntityName),
            cusip: str(api.cusip),
            equityType: str(api.equityType),
            allowlistType: str(api.allowlistType),
            totalSupply: num(api.totalSupply),
            circulatingSupply: num(api.circulatingSupply),
            currentPrice: num(api.currentPrice),
            tokenEnabled: bool(api.features?.tokenEnabled),
            tradeEnabled: bool(api.features?.tradeEnabled),
            mintingEnabled: bool(api.features?.mintingEnabled)
        };
    }
    return null;
}

// --- rendering --------------------------------------------------------------------------------

const STATUS_WORDS = {
    good: 'good',
    caution: 'caution',
    warning: 'warning',
    unknown: 'not measured'
};

function text(value) {
    return value === null || value === undefined || value === '' ? DASH : escapeHtml(String(value));
}

function yesNo(value) {
    if (value === true) return 'yes';
    if (value === false) return 'no';
    return DASH;
}

/**
 * A `<dl>` of label/value rows; a row whose value is null is dropped rather than shown empty. A
 * third element names the dossier field path (or paths) behind the value, which draws the evidence
 * chip after it when `ev` is the card's evidence block.
 */
function kv(rows, ev = null) {
    const cells = rows
        .filter((row) => Array.isArray(row) && row[1] !== null && row[1] !== undefined)
        .map(([label, value, fields]) => `<dt>${escapeHtml(label)}</dt>` +
            `<dd>${value}${cardChip(fields, ev, label)}</dd>`);
    return cells.length ? `<dl class="kv">${cells.join('')}</dl>` : '<p class="no">Nothing reported.</p>';
}

/** What the hollow chip says. One copy: the tooltip here and the panel's popover both use it. */
export const NO_CLAIM_TEXT = 'no source recorded yet';

const CARD_STATUS_CLASS = {
    confirmed: 'ev-ok',
    unverified: 'ev-caution',
    'contradicted-corrected': 'ev-warn',
    inference: 'ev-muted',
    changed: 'ev-warn',
    'source-gone': 'ev-warn'
};

/**
 * The "§" chip after a value on a card (stocks/EVIDENCE.md §4). A <details> so it opens by tap and
 * by keyboard with no script — card.js only adds ages and a copy button, and a card must be
 * readable with JavaScript off. The hollow form is a plain <span> with a title rather than a
 * popover: every one of them would say the same sentence, and a card is byte-capped.
 */
function cardChip(fields, ev, label) {
    if (!ev || !fields) return '';
    const paths = Array.isArray(fields) ? fields : [fields];
    const entries = paths.map((path) => ev.fields?.[path]).filter(Boolean);
    if (entries.length === 0) return '';
    const claims = entries.flatMap((entry) => entry.claims ?? []);
    if (claims.length === 0) {
        return entries.some((entry) => entry.needed)
            ? `<span class="ev-none" title="${escapeHtml(NO_CLAIM_TEXT)}">§?</span>`
            : '';
    }
    const best = claims[0];
    const cls = CARD_STATUS_CLASS[best.status] ?? 'ev-muted';
    const body = claims.map((claim) => {
        // The HOST, not the whole URL: the href carries the path, and printing it twice was the
        // single biggest thing the chips cost when every field is sourced.
        const source = claim.url === null
            ? '<span class="t">no URL recorded</span>'
            : link(claim.url, host(claim.url));
        const stamp = claim.accessedAt === null ? '' : ` · read ${shortTime(claim.accessedAt)}`;
        return `<div class="ev-claim"><b class="${cls}">${escapeHtml(claim.status ?? 'claim')}</b>` +
            `${claim.quote === null ? '' : `<blockquote>${escapeHtml(claim.quote)}</blockquote>`}` +
            `${claim.note === null ? '' : `<div class="t">${escapeHtml(claim.note)}</div>`}` +
            `<div class="t">${source}` +
            `${claim.locator === null ? '' : ` · <code>${escapeHtml(claim.locator)}</code>`}${stamp}</div></div>`;
    }).join('');
    // The summary's title is the STATUS only. It used to repeat the quote, which put the same 110
    // characters on the page twice per field — 5.5 kB on a fully sourced card, for a tooltip that
    // duplicates the popover one tap away.
    return `<details class="ev-chip"><summary class="${cls}" title="${escapeHtml(best.status ?? 'claim')}" ` +
        `aria-label="${escapeHtml(`Evidence for ${label}`)}">§</summary>` +
        `<div class="ev-pop">${body}</div></details>`;
}

/** The host of a URL, or the URL itself when it will not parse. */
function host(url) {
    try {
        return new URL(url).host;
    } catch {
        return String(url).replace(/^https?:\/\//, '');
    }
}

/** Date only, with the full instant in the attribute — a card pays for every character twice. */
function shortTime(iso) {
    if (typeof iso !== 'string' || !iso.trim()) return DASH;
    return `<time datetime="${escapeHtml(iso)}">${escapeHtml(fmtDate(iso))}</time>`;
}

/** "Evidence: 34 of 41 fields sourced · last checked 18 Sep 2026 10:22 UTC". */
export function evidenceLine(evidence) {
    if (!evidence || !evidence.coverage) return '';
    const { sourced, needed } = evidence.coverage;
    const checked = evidence.lastCheckedAt === null
        ? ' · never checked'
        : ` · last checked ${fmtDateTime(evidence.lastCheckedAt)}`;
    return `Evidence: ${fmtNumber(sourced)} of ${fmtNumber(needed)} fields sourced${checked}`;
}

function section(id, title, body) {
    return `<section id="${id}"><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

function chip(status) {
    const key = status in STATUS_WORDS ? status : 'unknown';
    return `<b class="c-${key}">${escapeHtml(STATUS_WORDS[key])}</b>`;
}

function link(url, label) {
    return isSafeUrl(url)
        ? `<a href="${escapeHtml(url)}" rel="nofollow noopener">${escapeHtml(label)}</a>`
        : escapeHtml(label);
}

/** camelCase key -> "camel case", for the rule-input pairs. */
function labelize(key) {
    return String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
}

/** A rule input value: booleans as yes/no, numbers cut to six figures, addresses shortened. */
function inputValue(value) {
    if (value === null || value === undefined) return DASH;
    if (typeof value === 'boolean') return yesNo(value);
    if (typeof value === 'number') return String(roundSignificant(value, TABLE_DIGITS));
    if (typeof value === 'string') return shortAddress(value);
    if (Array.isArray(value)) return value.map(inputValue).join('; ') || DASH;
    if (typeof value === 'object') return Object.values(value).map(inputValue).join('/');
    return String(value);
}

function inputPairs(inputs) {
    if (!inputs || typeof inputs !== 'object') return DASH;
    const parts = Object.entries(inputs).map(([key, value]) => `${labelize(key)}: ${inputValue(value)}`);
    return parts.length ? escapeHtml(parts.join(' · ')) : DASH;
}

/** "SPACEX — caution · tokenized private-company on Solana" and the ≤ 200-character description. */
export function ogTitle(card) {
    const what = card.underlyingTicker ? `tokenized ${card.underlyingTicker}` : 'tokenized';
    return `${card.symbol ?? card.mint} — ${STATUS_WORDS[card.health.status] ?? 'not measured'} · ${what} on Solana`;
}

export function pageTitle(card) {
    const what = card.underlyingTicker
        ? `tokenized ${card.underlyingTicker}`
        : `tokenized ${humanizeSlug(card.instrumentType ?? '')}`.trim();
    return `${card.symbol ?? card.mint} — ${what} on Solana · RWA Sonar`;
}

/**
 * Text-only, no markup, never longer than OG_DESCRIPTION_MAX: the issuer, what the holder owns, the
 * premium and the depth — the four things that decide whether the token is worth opening.
 */
export function ogDescription(card) {
    const parts = [];
    const issuer = card.issuer.name ?? card.issuer.slug;
    if (issuer) parts.push(`${issuer}'s ${card.name ?? card.symbol ?? 'token'}`);
    if (card.ownership.claimLabel) parts.push(`holder claim: ${card.ownership.claimLabel}`);
    if (card.reference.premiumPct !== null) {
        parts.push(`${fmtSignedPct(card.reference.premiumPct)} vs ${card.reference.source ?? 'reference'}`);
    }
    if (card.depth.liquidityUsd !== null) parts.push(`${fmtMoney(card.depth.liquidityUsd)} liquidity`);
    if (card.health.worstRuleId) {
        const worst = card.health.rules.find((rule) => rule.id === card.health.worstRuleId);
        if (worst) parts.push(`worst check: ${worst.label.toLowerCase()} ${STATUS_WORDS[worst.status]}`);
    }
    const line = parts.join('. ').replace(/\s+/g, ' ').trim();
    if (line.length <= OG_DESCRIPTION_MAX) return line ? `${line}.`.slice(0, OG_DESCRIPTION_MAX) : '';
    return `${line.slice(0, OG_DESCRIPTION_MAX - 1).replace(/[\s.,;:]+$/, '')}…`;
}

/** `{slug, symbol, mint, issuer, status}` — the whole of cards/index.json, per card. */
export function indexEntry(card) {
    return {
        slug: card.slug,
        symbol: card.symbol,
        mint: card.mint,
        issuer: card.issuer.slug,
        status: card.health.status
    };
}

function whatYouOwnBody(card) {
    const o = card.ownership;
    const rung = o.claimRung === null ? null : `rung ${o.claimRung} of 4 — ${text(o.claimLabel)}`;
    const restrictions = [
        o.transferRestrictions.allowlist === null ? null : `allowlist ${yesNo(o.transferRestrictions.allowlist)}`,
        o.transferRestrictions.kycToHold === null ? null : `KYC to hold ${yesNo(o.transferRestrictions.kycToHold)}`,
        o.transferRestrictions.usPersonsExcluded === null ? null : `US persons excluded ${yesNo(o.transferRestrictions.usPersonsExcluded)}`,
        o.transferRestrictions.mechanism === null ? null : `mechanism ${o.transferRestrictions.mechanism}`
    ].filter((part) => part !== null);
    const maturity = o.maturityStage === null && o.maturityScore === null
        ? null
        : `${text(o.maturityStage)}${o.maturityScore === null ? '' : ` · score ${escapeHtml(String(o.maturityScore))}`}`;
    const redemptionParts = [
        o.redemption.eligibility === null ? null : escapeHtml(o.redemption.eligibility),
        o.redemption.rails === null ? null : `rails: ${escapeHtml(o.redemption.rails)}`,
        o.redemption.fees === null ? null : `fees: ${escapeHtml(o.redemption.fees)}`
    ].filter((part) => part !== null);
    const redemption = o.redemption.available === null && redemptionParts.length === 0
        ? null
        : `${yesNo(o.redemption.available)}${redemptionParts.length ? ` — ${redemptionParts.join(' · ')}` : ''}`;

    return kv([
        ['Claim depth', rung],
        ['Legal form', o.legalForm === null ? null : text(humanizeSlug(o.legalForm)), 'legalForm'],
        ['What the holder owns', o.holderClaim === null ? null : escapeHtml(o.holderClaim), 'holderClaim'],
        ['Issuing entity', o.issuingEntity === null ? null : escapeHtml(o.issuingEntity), 'issuingEntity'],
        ['Jurisdiction', o.entityJurisdiction === null ? null : escapeHtml(o.entityJurisdiction), 'entityJurisdiction'],
        ['Governing law', o.governingLaw === null ? null : escapeHtml(o.governingLaw), 'governingLaw'],
        ['Regulatory status', o.regulatoryStatus === null ? null : escapeHtml(o.regulatoryStatus), 'regulatoryStatus'],
        ['Redemption', redemption, ['redemption.available', 'redemption.eligibility', 'redemption.rails', 'redemption.fees']],
        ['Transfer restrictions', restrictions.length ? escapeHtml(restrictions.join(' · ')) : null,
            ['transferRestrictions.allowlist', 'transferRestrictions.kycToHold',
                'transferRestrictions.usPersonsExcluded', 'transferRestrictions.mechanism']],
        ['Dividends', o.dividends === null ? null : escapeHtml(o.dividends), 'dividends'],
        ['Voting', o.voting === null ? null : escapeHtml(o.voting), 'voting'],
        ['Ledger maturity', maturity]
    ], card.evidence);
}

function referenceBody(card) {
    const r = card.reference;
    return kv([
        ['Reference source', r.source === null ? null : text(r.source)],
        ['Reference price', r.price === null ? null : text(fmtPrice(r.price))],
        ['Reference age', r.ageSeconds === null ? null : text(fmtAgeSeconds(r.ageSeconds))],
        ['Underlying market', r.marketOpen === null ? null : (r.marketOpen ? 'open' : 'closed')],
        ['On-chain price (Jupiter)', r.usdPrice === null ? null : text(fmtPrice(r.usdPrice))],
        ['Premium', r.premiumPct === null ? null : text(fmtSignedPct(r.premiumPct))],
        ['How the reference is derived', r.note === null ? null : escapeHtml(r.note)]
    ]);
}

function afterHoursBody(card) {
    const a = card.afterHours;
    if (a === null) {
        return '<p class="no">No session split yet — this needs a full session of tape on both sides ' +
            'of the underlying market\'s open.</p>';
    }
    return kv([
        ['Premium while open', a.openPremiumPct === null ? null : text(fmtSignedPct(a.openPremiumPct))],
        ['Premium while closed', a.closedPremiumPct === null ? null : text(fmtSignedPct(a.closedPremiumPct))],
        ['Gap (closed − open)', a.gapPct === null ? null : text(fmtSignedPct(a.gapPct))],
        ['Trades measured', `${text(fmtNumber(a.tradesOpen))} open / ${text(fmtNumber(a.tradesClosed))} closed`],
        ['Reference used', a.source === null ? null : text(a.source)],
        ['Window', a.windowFrom === null ? null : `${time(a.windowFrom)} → ${time(a.windowTo)}`]
    ]);
}

function depthBody(card) {
    const d = card.depth;
    const organic = d.organicSharePct === null && d.organicVol24Usd === null
        ? null
        : `${text(fmtPct(d.organicSharePct))}${d.organicVol24Usd === null ? '' : ` of ${escapeHtml(fmtMoney(d.organicVol24Usd))}`}`;
    const flow = [
        d.trades24 === null ? null : `${fmtNumber(d.trades24)} trades`,
        d.traders24 === null ? null : `${fmtNumber(d.traders24)} traders`,
        d.tradesPerTrader === null ? null : `${fmtTradesPerTrader(d.tradesPerTrader)} per trader`
    ].filter((part) => part !== null);
    const spread = fmtVenueSpread({
        venueSpreadPct: d.venueSpreadPct,
        venueSpreadLow: d.venueSpreadLow,
        venueSpreadHigh: d.venueSpreadHigh,
        venuesPriced: d.venuesPriced
    });
    const lastTrade = d.lastTradedAt === null
        ? null
        : `${time(d.lastTradedAt)}${d.lastTradedVenue === null ? '' : ` on ${escapeHtml(d.lastTradedVenue)}`}`;

    return kv([
        ['Liquidity', d.liquidityUsd === null ? null : text(fmtMoney(d.liquidityUsd))],
        ['Volume 24 h', d.vol24Usd === null ? null : text(fmtMoney(d.vol24Usd))],
        ['Organic share', organic],
        ['Flow 24 h', flow.length ? escapeHtml(flow.join(' · ')) : null],
        ['Venues', `${text(fmtNumber(d.dexPairs))} DEX pair(s) · ${text(fmtNumber(d.cexMarkets))} exchange market(s)`],
        ['Cross-venue spread', spread === DASH ? null : escapeHtml(spread)],
        ['Last trade seen', lastTrade],
        ['Holders', d.holderCount === null ? null : text(fmtNumber(d.holderCount))],
        ['Market cap', d.mcapUsd === null ? null : text(fmtMoney(d.mcapUsd))]
    ]);
}

function holdersBody(card) {
    const h = card.holders;
    const rows = h.top.map((row) => {
        const label = row.ownerLabel === null ? '' : ` <span class="t">${escapeHtml(row.ownerLabel)}</span>`;
        const frozen = row.frozen ? ' <span class="t a">frozen</span>' : '';
        const owner = row.owner === null
            ? DASH
            : `<code title="${escapeHtml(row.owner)}">${escapeHtml(shortAddress(row.owner))}</code>`;
        return `<tr><td>${owner}${label}${frozen}</td><td class="n">${text(fmtPct(row.sharePct, 2))}</td></tr>`;
    }).join('');

    const table = rows
        ? `<div class="scroll"><table class="r"><thead><tr><th scope="col">Owner</th>` +
          `<th scope="col">Share</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<p class="no">No holder snapshot for this mint.</p>';

    return kv([
        ['Top 1 / 5 / 20, unlabelled owners only', `${text(fmtPct(h.top1SharePctExLabels))} / ` +
            `${text(fmtPct(h.top5SharePctExLabels))} / ${text(fmtPct(h.top20SharePctExLabels))}`],
        ['Top 1 / 5 / 20, raw', `${text(fmtPct(h.top1SharePct))} / ${text(fmtPct(h.top5SharePct))} / ` +
            `${text(fmtPct(h.top20SharePct))}`],
        ['Distinct owners in the top 20', h.distinctOwnersTop20 === null ? null : text(fmtNumber(h.distinctOwnersTop20))],
        ['Frozen accounts in the top 20', h.frozenAccountsTop20 === null ? null : text(fmtNumber(h.frozenAccountsTop20))],
        ['Supply', h.supplyUi === null ? null : text(fmtNumber(h.supplyUi, 2))]
    ]) + table;
}

function controlBody(card) {
    const c = card.control;
    const g = card.keyGovernance;
    return kv([
        ['Clawback', c.clawback === null ? null : yesNo(c.clawback)],
        ['Freeze authority', c.freezeAuthority === null
            ? null
            : `<code title="${escapeHtml(c.freezeAuthority)}">${escapeHtml(shortAddress(c.freezeAuthority))}</code>`],
        ['Pausable', c.pausable === null ? null : yesNo(c.pausable)],
        ['Paused right now', c.paused === null ? null : yesNo(c.paused)],
        ['Allowlist', c.allowlist === null ? null : yesNo(c.allowlist)],
        ['Transfer fee', c.transferFeeBps === null ? null : `${escapeHtml(String(c.transferFeeBps))} bps`],
        ['Transfer hook', c.hookActive === null ? null : yesNo(c.hookActive)],
        ['Mint authority', g.mint === null ? null : text(humanizeSlug(g.mint)), 'keyGovernance.mint'],
        ['Freeze authority held by', g.freeze === null ? null : text(humanizeSlug(g.freeze)), 'keyGovernance.freeze'],
        ['Permanent delegate', g.delegate === null ? null : text(humanizeSlug(g.delegate)), 'keyGovernance.delegate'],
        ['Evidence', g.evidence === null ? null : escapeHtml(g.evidence)]
    ], card.evidence);
}

function verificationBody(card) {
    const v = card.verification;
    const strength = v.strength === null ? null : `${escapeHtml(String(v.strength))} of 5${v.label ? ` — ${escapeHtml(v.label)}` : ''}`;
    return kv([
        ['Strength', strength],
        ['Type', v.type === null ? null : text(humanizeSlug(v.type)), 'custodyVerification.type'],
        ['Agent', v.agent === null ? null : escapeHtml(v.agent), 'custodyVerification.agent'],
        ['Frequency', v.frequency === null ? null : escapeHtml(v.frequency), 'custodyVerification.frequency'],
        ['Machine-readable', v.machineReadable === null ? null : yesNo(v.machineReadable)],
        ['Evidence', v.link === null ? null : link(v.link, v.link.replace(/^https?:\/\//, ''))]
    ], card.evidence);
}

function venuesBody(card) {
    const dexRows = card.venues.dex.map((row) => {
        const name = row.url === null ? text(row.dexId) : link(row.url, row.dexId ?? 'pool');
        const pair = row.quoteSymbol === null ? '' : ` <span class="t">${escapeHtml(row.quoteSymbol)}</span>`;
        const meteora = row.meteora === null ? '' :
            `<div class="mv">bin step ${text(row.meteora.binStep)} · base fee ${text(fmtPct(row.meteora.baseFeePct, 2))}` +
            `${row.meteora.dynamicFeePct === null ? '' : ` (dynamic ${escapeHtml(fmtPct(row.meteora.dynamicFeePct, 3))})`}` +
            ` · fees 24 h ${text(fmtMoney(row.meteora.fees24Usd))}</div>`;
        return `<tr><td>${name}${pair}${meteora}</td><td class="n">${text(fmtPrice(row.priceUsd))}</td>` +
            `<td class="n">${text(fmtMoney(row.liquidityUsd))}</td><td class="n">${text(fmtMoney(row.volume24Usd))}</td></tr>`;
    }).join('');

    const cexRowsHtml = card.venues.cex.map((row) => {
        const name = row.url === null ? text(row.market) : link(row.url, row.market ?? 'market');
        const pair = row.target === null ? '' : ` <span class="t">${escapeHtml(row.target)}</span>`;
        return `<tr><td>${name}${pair}</td><td class="n">${text(fmtPrice(row.priceUsd))}</td>` +
            `<td class="n">${text(fmtMoney(row.volume24Usd))}</td><td>${row.lastTradedAt === null ? DASH : time(row.lastTradedAt)}</td></tr>`;
    }).join('');

    const dex = dexRows
        ? `<h3>DEX pools</h3><div class="scroll"><table class="r"><thead><tr><th scope="col">Pool</th>` +
          `<th scope="col">Price</th><th scope="col">Liquidity</th><th scope="col">Vol 24 h</th></tr></thead>` +
          `<tbody>${dexRows}</tbody></table></div>`
        : '<h3>DEX pools</h3><p class="no">No DEX pool reported.</p>';
    const cex = cexRowsHtml
        ? `<h3>Exchange markets</h3><div class="scroll"><table class="r"><thead><tr><th scope="col">Market</th>` +
          `<th scope="col">Price</th><th scope="col">Vol 24 h</th><th scope="col">Last trade</th></tr></thead>` +
          `<tbody>${cexRowsHtml}</tbody></table></div>`
        : '<h3>Exchange markets</h3><p class="no">No exchange market reported.</p>';
    return dex + cex;
}

function issuerApiBody(card) {
    const a = card.issuerApi;
    if (a === null) return '';
    const caveat = '<p class="note">The issuer\'s own numbers, not an independent price, and read ' +
        'at the <em>issuerApi</em> time in the footer — which can be hours older than the rest of ' +
        'this card, so a trading status here may disagree with the reference section above.</p>';
    if (a.kind === 'prestocks') {
        return caveat + kv([
            ['Mark price', a.markPrice === null ? null : text(fmtPrice(a.markPrice))],
            ['Mark valuation', a.markValuation === null ? null : text(fmtMoney(a.markValuation))],
            ['Token price', a.tokenPrice === null ? null : text(fmtPrice(a.tokenPrice))],
            ['Implied valuation', a.impliedValuation === null ? null : text(fmtMoney(a.impliedValuation))],
            ['Supply', a.supply === null ? null : text(fmtNumber(a.supply, 2))],
            ['Premium the issuer reports', a.premiumPct === null ? null : text(fmtSignedPct(a.premiumPct))],
            ['Issuer page', a.externalUrl === null ? null : link(a.externalUrl, a.externalUrl.replace(/^https?:\/\//, ''))]
        ]);
    }
    if (a.kind === 'tessera') {
        return caveat + kv([
            ['Sector', a.sector === null ? null : text(a.sector)],
            ['Holders the issuer counts', a.holders === null ? null : text(fmtNumber(a.holders))],
            ['Mark price', a.markPrice === null ? null : text(fmtPrice(a.markPrice))],
            ['Mark valuation', a.markValuation === null ? null : text(fmtMoney(a.markValuation))]
        ]);
    }
    if (a.kind === 'ondo') {
        return caveat + kv([
            ['Ondo price', a.ondoPrice === null ? null : text(fmtPrice(a.ondoPrice))],
            ['Implied underlying price', a.impliedUnderlyingPrice === null ? null : text(fmtPrice(a.impliedUnderlyingPrice))],
            ['Trading paused', a.isTradingPaused === null ? null : yesNo(a.isTradingPaused)],
            ['Tradeable', a.isAssetTradeable === null ? null : yesNo(a.isAssetTradeable)],
            ['Market open', a.isMarketOpen === null ? null : yesNo(a.isMarketOpen)],
            ['Session', a.currentSession === null ? null : text(a.currentSession)],
            ['Off-hours tradable', a.isOffhoursTradable === null ? null : yesNo(a.isOffhoursTradable)],
            ['Next open', a.nextMarketOpen === null ? null : time(a.nextMarketOpen)],
            ['Pause reason', a.assetPauseReason === null ? null : escapeHtml(a.assetPauseReason)]
        ]);
    }
    return caveat + kv([
        ['Issuing entity the API names', a.issuerEntityName === null ? null : text(a.issuerEntityName)],
        ['CUSIP', a.cusip === null ? null : text(a.cusip)],
        ['Equity type', a.equityType === null ? null : text(a.equityType)],
        ['Allowlist type', a.allowlistType === null ? null : text(a.allowlistType)],
        ['Total supply', a.totalSupply === null ? null : text(fmtNumber(a.totalSupply, 2))],
        ['Circulating supply', a.circulatingSupply === null ? null : text(fmtNumber(a.circulatingSupply, 2))],
        ['Current price', a.currentPrice === null ? null : text(fmtPrice(a.currentPrice))],
        ['Token / trade / minting enabled', `${yesNo(a.tokenEnabled)} / ${yesNo(a.tradeEnabled)} / ${yesNo(a.mintingEnabled)}`]
    ]);
}

function rulesBody(card) {
    const rows = card.health.rules.map((rule) => `<tr><td>${escapeHtml(rule.label)}</td>` +
        `<td>${chip(rule.status)}</td>` +
        `<td class="n">${rule.value === null ? DASH : escapeHtml(String(roundSignificant(rule.value, TABLE_DIGITS)))}</td>` +
        `<td class="s">${text(rule.threshold)}</td>` +
        `<td class="s">${inputPairs(rule.inputs)}</td>` +
        `<td>${text(rule.note)}</td></tr>`).join('');
    return `<div class="scroll"><table class="rules"><thead><tr><th scope="col">Check</th>` +
        `<th scope="col">Status</th><th scope="col">Value</th><th scope="col">Thresholds</th>` +
        `<th scope="col">Inputs</th><th scope="col">What it says</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** An absolute UTC timestamp; card.js appends the relative age to every <time> it finds. */
function time(iso) {
    if (typeof iso !== 'string' || !iso.trim()) return DASH;
    return `<time datetime="${escapeHtml(iso)}">${escapeHtml(fmtDateTime(iso))}</time>`;
}

function footerBody(card) {
    const sources = Object.entries(card.sources)
        .filter(([, value]) => value !== null)
        .map(([key, value]) => `${escapeHtml(key)} ${time(value)}`)
        .join(' · ');
    const evidence = evidenceLine(card.evidence);
    return `<footer><h2>Data</h2>` +
        `${evidence ? `<p class="ev-line">${escapeHtml(evidence)}</p>` : ''}` +
        `<p class="src">${sources}</p>` +
        `<p class="mint">Mint <code id="mint">${escapeHtml(card.mint ?? '')}</code> ` +
        `<button type="button" id="copy-mint" data-mint="${escapeHtml(card.mint ?? '')}">Copy</button></p>` +
        `<p class="built">Card built ${time(card.builtAt)}.</p>` +
        '<nav class="card-nav"><a href="../stocks.html">All tokenized stocks</a> ' +
        '<a href="../graph.html">The parties behind them</a> ' +
        '<a href="../live.html">Live trades</a> ' +
        '<a href="../monitor.html">Health monitor</a></nav></footer>';
}

/**
 * The whole card page. `baseUrl` is REQUIRED for og:url and the canonical link — a builder has no
 * request to derive an origin from, so without it those two tags are simply absent rather than
 * guessed (a wrong absolute URL in a shared card is a dead link nobody sees fail).
 *
 * @param {object} card buildCard's output
 * @param {object} options
 * @param {string|null} options.baseUrl e.g. https://rwasonar.com
 * @param {string} options.version the ?v= cache-busting stamp for ../card.css and ../card.js
 */
export function renderCard(card, { baseUrl = null, version = '' } = {}) {
    const origin = typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim().replace(/\/+$/, '') : null;
    const pageUrl = origin === null ? null : `${origin}/cards/${card.slug}.html`;
    const description = ogDescription(card);
    const status = card.health.status;
    // `<` is escaped so a stray "</script>" inside the dossier prose cannot close the element
    // early. JSON.parse turns < straight back into "<", so the inlined data still parses to
    // exactly the .json file's content, and structural JSON characters never include "<".
    const json = JSON.stringify(publicCard(card)).replace(/</g, '\\u003c');
    const worst = card.health.rules.find((rule) => rule.id === card.health.worstRuleId) ?? null;
    const v = version ? `?v=${encodeURIComponent(version)}` : '';

    const head = [
        '<meta charset="UTF-8" />',
        '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
        '<meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate, max-snippet:0, max-image-preview:none, max-video-preview:0" />',
        `<title>${escapeHtml(pageTitle(card))}</title>`,
        `<meta property="og:title" content="${escapeHtml(ogTitle(card))}" />`,
        `<meta property="og:description" content="${escapeHtml(description)}" />`,
        '<meta property="og:type" content="article" />',
        pageUrl === null ? null : `<meta property="og:url" content="${escapeHtml(pageUrl)}" />`,
        pageUrl === null ? null : `<link rel="canonical" href="${escapeHtml(pageUrl)}" />`,
        '<meta name="twitter:card" content="summary" />',
        '<link rel="icon" type="image/svg+xml" href="../images/variant3.svg" />',
        `<link rel="stylesheet" href="../card.css${v}" />`
    ].filter((line) => line !== null).join('\n    ');

    const header = `<header class="card-head">` +
        `<p class="crumb"><a href="../stocks.html">Tokenized stocks</a> · ` +
        `<a href="../stocks.html#issuers">${escapeHtml(card.issuer.name ?? card.issuer.slug ?? 'issuer')}</a></p>` +
        `<h1>${escapeHtml(card.symbol ?? card.mint ?? 'token')}</h1>` +
        `<p class="sub">${escapeHtml(card.name ?? '')}${card.underlyingTicker ? ` · tracks ${escapeHtml(card.underlyingTicker)}` : ''}` +
        `${card.instrumentType ? ` · ${escapeHtml(humanizeSlug(card.instrumentType))}` : ''}</p>` +
        `<p class="banner banner-${escapeHtml(status)}">${chip(status)} ` +
        `${escapeHtml(worst === null ? 'no check could be measured for this token' : worst.note ?? '')}</p>` +
        '</header>';

    const body = [
        header,
        section('own', 'What you own', whatYouOwnBody(card)),
        section('reference', 'Reference & premium', referenceBody(card)),
        section('afterhours', 'After-hours premium', afterHoursBody(card)),
        section('depth', 'Depth, volume, activity', depthBody(card)),
        section('holders', 'Holder concentration', holdersBody(card)),
        section('control', 'Control surface & key governance', controlBody(card)),
        section('verification', 'Verification', verificationBody(card)),
        section('venues', 'Venues', venuesBody(card)),
        card.issuerApi === null ? '' : section('issuer-api', 'Issuer API', issuerApiBody(card)),
        section('rules', 'Health rules', rulesBody(card)),
        footerBody(card)
    ].join('\n');

    return `<!doctype html>
<!-- Generated by stocks/build-cards.mjs from stocks-tokens.json, stocks-issuers.json,
     stocks/data/holders.json, stocks/data/venues.json, stocks-trades.json,
     stocks-afterhours.json and stocks/data/meteora.json. Do not edit: rebuilt every refresh. -->
<html lang="en">

<head>
    ${head}
</head>

<body>
<main class="card">
${body}
</main>
<script type="application/json" id="card-data">${json}</script>
<script src="../card.js${v}"></script>
</body>

</html>
`;
}
