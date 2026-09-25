// PURE shaping and rendering for the per-token stock cards (no fs, no network, no clock, no DOM):
// the card slug rules, the published companion .json record, the ≤ 200-character OpenGraph description and the whole
// static HTML page. Everything a card shows is rendered here at build time, so a card is readable
// with JavaScript off; card.js only adds relative ages and a copy button on top.
// The output must be byte-identical when rebuilt from the same inputs (apart from `builtAt`), which
// is why every number is cut to six significant figures and nothing here reads a clock.
// Unit-tested in ../cards.test.js.

import fmt from './fmt.js';
import siteNav from './site-nav.js';
import discovery from './discovery.js';
import evidenceLib from './evidence.js';
import trustChainSvg from './trustchain-svg.js';
import whatIfLib from './whatif-render.js';
import closedMarketView from './closed-market-view.js';
import holderRightsLib from './holder-rights.js';
import { HEALTH_DIMENSIONS, REFERENCE_SOURCE_LABELS, evaluateHealth, topSharePctExcludingLabels } from './health.mjs';
import { COMPOSABILITY_SCENARIOS, lenderExitQuality } from './composability.mjs';
import { DEFI_ACTION_LABELS } from './defi-usage.mjs';
import { dossierSlug as protocolDossierSlug } from './protocol-dossiers.mjs';
import { timelockFrom } from './power-map.mjs';
import { shapeRedemptionUsability, describeObservationFeed } from './redemption-usability.mjs';
import { shapeAuthorityAttribution } from './authority-attribution.mjs';
import protocolProof from './protocol-proof.js';
import activityRowsLib from './activity-rows.js';
import { parseSchedule, sessionAt } from './market-hours.mjs';
import { marketIdOf } from './closed-market.mjs';
import { equitySymbolForTicker } from './pyth.mjs';
import { PYTH_SHARDS, feedPageUrl, freshestReading, premiumOverPyth, tokenStockGap } from './pyth-onchain.mjs';
import { breadcrumbLd, contactFooterHtml, contactStylesheet, ldGraph, organizationLd, reportLd, seoHeadTags } from './site-seo.mjs';

const { protocolProofModel } = protocolProof;
const { pairLegLabel } = activityRowsLib;

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
    humanizeDuration,
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
 * stocks.html. Long fields (what the holder actually owns) get the wide limit.
 */
export const PROSE_MAX = 110;
export const PROSE_MAX_SHORT = 75;

/**
 * How much of a claim a card carries (stocks/EVIDENCE.md §4). A card is size-capped and renders its
 * evidence in a bounded popover, so it shows the ONE strongest claim per field with the quote cut
 * to QUOTE_MAX; the issuer panel on stocks.html shows every
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
    'keyGovernance.mint', 'keyGovernance.freeze', 'keyGovernance.delegate', 'keyGovernance.rebase',
    'custodyVerification.type', 'custodyVerification.agent', 'custodyVerification.frequency'
];

/** Venue rows per side, and holder rows — the cap that keeps a card small and its wallet list short. */
export const VENUE_ROWS = 3;
export const HOLDER_ROWS = 5;

/**
 * How much of a what-if answer a card carries (stocks/EVIDENCE.md §6.3). MEASURED, not guessed: the
 * two researched issuers answer all 38 modes in prose, and the full answers — outcome, verbatim
 * quote, note, cases and the `searched[]` record behind every gap — are 69 kB of text for xStocks
 * and 79 kB for Superstate. Rendered whole they took one card from 31.5 kB to 116 kB, which is not
 * a card any more.
 *
 * So a card carries the SHAPE of the answer sheet and the issuer panel carries the sheet: every one
 * of the 38 questions with its status badge, its outcome cut to OUTCOME_MAX, and the source link
 * with its locator, archived copy and read date — and a link to the panel for the quote, the note,
 * the cases and where we looked. That is 18.8 kB on the xStocks cards (measured), which is what
 * lifted the byte budget from 34 to 60 kB. A card for one of the ten issuers with no answers yet
 * pays ~1 kB: 38 gaps, said as gaps.
 */
// Keep the card's answer sheet skimmable; the uncut reasoning and qualifications live in the
// linked issuer dossier. This also preserves measured headroom below the 96 KiB card target as
// protocol and authority summaries evolve.
export const OUTCOME_MAX = 150;

/** How much of a rights flow's one-line summary a card carries; the panel prints it whole. */
export const CHAIN_SUMMARY_MAX = 160;

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
 * rows each gained a chip, which on a dossier with no claims yet is ~1.3 kB of missing-source markup
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
 *
 * 92 kB from 2026-09-18, when the trust chain and the what-if answers landed (EVIDENCE.md §6), and
 * again measured rather than guessed. Now that all twelve dossiers answer all 38 failure modes the
 * 471 cards run min 75.3, median 80.3, max 82.9 kB (TSMon) — so the ceiling is 92 kB, the real
 * maximum plus ~11 %, and the build still FAILS above it. Measured on TSMon: the trust chain is
 * 21.3 kB (10.2 kB of SVG, a 1.4 kB legend, a 9.7 kB flow list) and the answer sheet 27.9 kB
 * (6.0 kB of outcomes, 4.5 kB of questions, 4.4 kB of source lines, 1.0 kB of sources, and 12 kB of
 * the markup around 38 rows).
 *
 * What was cut rather than paid for out of the budget — the answers whole are 69–79 kB of prose PER
 * ISSUER, which is not a card any more:
 *   - every answer's `quote`, `note` and `searched[]` record is left off, and the case `holding`
 *     prose with them; the section links to the issuer panel, which serves all of it;
 *   - `outcome` is cut to OUTCOME_MAX and a flow's `summary` to CHAIN_SUMMARY_MAX;
 *   - the flow list names the fields each link rests on and their claim status but NOT their values
 *     (9.4 kB of dossier prose; /api/issuers/:slug/chain serves it);
 *   - the 38 source lines cite one numbered source list at the foot of the section instead of
 *     repeating a 150-character URL and a 90-character title on every row (-7.5 kB);
 *   - the inlined record carries the chain's SHAPE and the answer COUNTS, never the answers.
 *
 * Raised to 96 kB on 2026-09-19 after exact-mint Jupiter Lend and Nest integrations were added to
 * the visible confirmed-use section. The 471 cards then measured min 81.2, median 86.7 and max
 * 93.7 kB (SPYx); the build still fails above the measured ceiling rather than silently trimming a
 * protocol from the asset's list.
 *
 * 2026-09-23: 1183 cards at min 84.6, median 84.7, max 96.4 kB (QQQx; SPYx 96.2, NVDAx 96.0) —
 * three five-integration cards over the target. What was over was repetition, not protocols: every
 * integration repeated its proof stage's two-sentence meaning, the metrics caveat and, for three
 * of the five, the same access restriction. Those are now said once (a proof key under the section
 * note, "Access: as for Kamino above"), and an evidence link identical to the market link is not
 * printed twice. Every protocol, its stage, account check and activity basis stay on the card.
 * Re-measured: min 84.6, median 84.7, max 95.6 kB (QQQx; SPYx 95.4, NVDAx 95.3).
 */
// Size is a release signal, not a protocol limit. Stay under CARD_BYTE_TARGET in normal builds;
// warn above it, and reserve CARD_BYTE_LIMIT as the point where likely duplication/runaway markup
// should stop publication. Compressed wire size is reported separately by build-cards.mjs.
// Raised from 96 KiB on 2026-09-24: the redemption-feed row, the DeFi route rows and the diagram
// hook put the widest card (SPYx) at 100,181 B. Each addition is card content, not duplication.
// Raised again the same evening (target 104 → 112, limit 112 → 128 KiB): with the server's observed
// redemptions, the theme switch and the closed-market section, SPYx, NVDAx and QQQx built at
// 112.7–113.1 KiB (27 kB gzipped). Diffed against the local build, the growth is observed content.
// Raised on 2026-09-25 (target 112 → 128, limit 128 → 150 KiB), approved by the owner, who judged
// cards fine up to 150 kB: the "Pyth on this token" block adds each token's Pyth feeds, the
// on-chain Pyth prices with their publish times and every lender's Pyth dependency.
export const CARD_BYTE_TARGET = 128 * 1024;
export const CARD_BYTE_LIMIT = 150 * 1024;

/**
 * The change judge's material verdicts on a card (stocks/EVIDENCE.md §2.3): how many days back from
 * the verdict export's own `asOf` a card looks, how many it names, and the heading, which always
 * says "model assessment" — a card never presents a model's reading as a finding. ~0.7 kB on a card
 * that has one; nothing at all on the others.
 */
export const MATERIAL_CHANGE_DAYS = 30;
export const MATERIAL_CHANGE_ROWS = 2;
export const MATERIAL_CHANGE_TITLE = 'Recent material changes (model assessment)';

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
 * companion .json file is this, stringified once.
 *
 * @param {object} input
 * @param {object} input.token one stocks-tokens.json .tokens[] record
 * @param {object|null} input.issuer its stocks-issuers.json .issuers[] record
 * @param {object|null} input.holdersItem its stocks/data/holders.json .items[] record
 * @param {object|null} input.floatItem xStocks only: lib/xstocks-float.mjs cardFloatItem() ({floatUi, inventorySharePct, readAt})
 * @param {object|null} input.venuesItem its stocks/data/venues.json .items[] record
 * @param {object|null} input.closedMarketItem its stocks-closed-market.json .items[] record (null: no lender takes it)
 * @param {object|null} input.closedMarketMeta that file's {generatedAt, researchReviewedAt, inputs}; null when the file is absent
 * @param {Map|null} input.meteoraByPair stocks/data/meteora.json .items[] keyed by pairAddress
 * @param {Array|null} input.pools its stocks-trades.json .pools[] entries
 * @param {string} input.slug the card file name (assignSlugs)
 * @param {string} input.builtAt the only value that may differ between two builds
 * @param {object} input.sources per-input fetch timestamps for the footer
 * @param {Map|null} input.quoteSymbols UPPERCASE mint → symbol (activity-rows.js quoteSymbolIndex), so an
 *     exchange pair quoted in one of our own tokens names it instead of printing its address
 */
export function buildCard(input) {
    const {
        token,
        issuer = null,
        holdersItem = null,
        floatItem = null,
        venuesItem = null,
        closedMarketItem = null,
        closedMarketMeta = null,
        meteoraByPair = null,
        pools = null,
        slug = '',
        builtAt = null,
        sources = {},
        // The trust-chain catalogue, the issuer dossier's own `whatIf[]` and the url -> archived-copy
        // index from sources-state.json. The answers are NOT in stocks-issuers.json (they are prose
        // with quotes and case citations, which is why the API serves them), so the card builder
        // reads the dossiers itself — see build-cards.mjs.
        catalogue = null,
        whatIf = null,
        archives = null,
        composabilityTemplate = null,
        defiUsageItem = null,
        reviewItems = [],
        // The issuer's schematics entry (stocks/lib/schematics.js); the card links its first
        // redemption schematic on the issuer page (drawing it would break the byte budget).
        schematics = null,
        // Material model verdicts exported by build-cards.mjs ({asOf, items}), or null where the
        // judge's table cannot be read; see cardMaterialChanges.
        materialChanges = null,
        // Protocol-market docs-vs-chain findings (discrepancy-view.js protocolDiscrepancyRecords);
        // only those on a market for this exact mint reach the card.
        protocolDiscrepancies = [],
        quoteSymbols = null,
        // The underlying's Pyth trading schedule (stocks/data/reference-prices.json `schedule`),
        // so the card can say whether that market was open at the snapshot instant.
        referenceSchedule = null,
        // `{symbol, terms}` when the issuer's dossier was researched on ONE of its products
        // (build-cards.mjs researchProducts): on every other product's card, whatever names that
        // product is labelled as its example rather than read as a fact about this token.
        researchProduct = null,
        // "Pyth on this token": the token's stocks/data/reference-prices.json item (its stock's Pyth
        // feed and schedule), stocks/data/pyth-onchain.json (prices read from Solana), the lenders'
        // oracle research (protocol-market-research.json `oraclePricing`) and when the Jupiter price
        // on this card was read (universe fetchedAt), so a premium is only drawn between close instants.
        referenceItem = null,
        pythOnchain = null,
        oraclePricing = null,
        priceReadAt = null
    } = input ?? {};

    const market = token?.market ?? {};
    const activity = token?.activity ?? {};
    const reference = token?.reference ?? {};
    const control = token?.control ?? {};
    const grades = issuer?.grades ?? {};
    const verdict = evaluateHealth({ token, issuer, holders: holdersItem, pools, composabilityTemplate });
    const top20 = Array.isArray(holdersItem?.top20) ? holdersItem.top20 : [];
    const secondaryMarketAvailable = Boolean((venuesItem?.dex?.length ?? 0) + (venuesItem?.cex?.length ?? 0));
    const session = underlyingSession(referenceSchedule, sources.tokens);
    const example = researchExampleFor(researchProduct, token);

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
        // The product the issuer's dossier was researched on, when it is not this token; null otherwise.
        researchedOn: example === null ? null : example.symbol,
        // These are present-tense conflicts between a published representation and what another
        // authoritative source or the chain shows. They are deliberately separate from corrected
        // evidence claims, which record revisions to RWA Sonar's own research.
        discrepancies: [...cardDiscrepancies(issuer, token), ...cardProtocolDiscrepancies(protocolDiscrepancies, token)],
        underReview: (Array.isArray(reviewItems) ? reviewItems : []).filter((item) => item?.priority === 'P0'
            && item?.issuerSlug === (token?.issuer ?? issuer?.slug)).map((item) => ({
                id: str(item.id), area: str(item.area), title: str(item.title), claimImpact: str(item.claimImpact)
            })),
        materialChanges: cardMaterialChanges(materialChanges?.items, token, {
            asOf: materialChanges?.asOf ?? null, issuerName: str(issuer?.name)
        }),
        health: {
            status: verdict.status,
            worstRuleId: verdict.worstRuleId,
            dimensions: verdict.dimensions,
            rules: verdict.rules.map((rule) => ({
                id: rule.id,
                label: rule.label,
                dimension: rule.dimension,
                status: rule.status,
                value: num(rule.value),
                threshold: str(rule.threshold),
                inputs: rule.inputs ?? null,
                note: str(rule.note)
            }))
        },
        composability: composabilityTemplate,
        defiUsage: defiUsageItem === null ? null : {
            confirmedUseCount: num(defiUsageItem.confirmedUseCount) ?? 0,
            protocols: Array.isArray(defiUsageItem.protocols) ? defiUsageItem.protocols.map(str).filter(Boolean) : [],
            actions: Array.isArray(defiUsageItem.actions) ? defiUsageItem.actions.map(str).filter(Boolean) : [],
            integrations: (Array.isArray(defiUsageItem.integrations) ? defiUsageItem.integrations : []).map((entry) => ({
                id: str(entry?.id),
                protocolId: str(entry?.protocolId),
                protocolName: str(entry?.protocolName),
                category: str(entry?.category),
                status: str(entry?.status),
                actions: Array.isArray(entry?.actions) ? entry.actions.map(str).filter(Boolean) : [],
                summary: truncate(entry?.summary, PROSE_MAX * 2),
                accessNote: truncate(entry?.accessNote, PROSE_MAX * 2),
                interface: str(entry?.interface),
                curator: str(entry?.curator),
                underlyingProtocols: Array.isArray(entry?.underlyingProtocols)
                    ? entry.underlyingProtocols.map(str).filter(Boolean) : [],
                networkPath: truncate(entry?.networkPath, PROSE_MAX * 2),
                links: {
                    use: safeUrl(entry?.links?.use),
                    protocol: safeUrl(entry?.links?.protocol)
                },
                metrics: entry?.metrics ?? null,
                markets: Array.isArray(entry?.markets) ? entry.markets.slice(0, 8) : [],
                debtCategories: Array.isArray(entry?.debtCategories) ? entry.debtCategories.map(str).filter(Boolean) : [],
                evidenceTier: str(entry?.evidenceTier),
                proof: entry?.proof ? {
                    sourceStatus: str(entry.proof.sourceStatus),
                    accountExistence: str(entry.proof.accountExistence),
                    accountCount: num(entry.proof.accountCount),
                    existingAccountCount: num(entry.proof.existingAccountCount),
                    configurationDecoded: bool(entry.proof.configurationDecoded),
                    readOnlyExecutionSimulated: bool(entry.proof.readOnlyExecutionSimulated),
                    activityObserved: bool(entry.proof.activityObserved),
                    activityBasis: Array.isArray(entry.proof.activityBasis) ? entry.proof.activityBasis.map(str).filter(Boolean) : []
                } : null,
                capabilities: (Array.isArray(entry?.capabilities) ? entry.capabilities : []).map((capability) => ({
                    action: str(capability?.action), label: str(capability?.label), status: str(capability?.status),
                    custody: str(capability?.custody), enforcement: str(capability?.enforcement),
                    consequence: truncate(capability?.consequence, PROSE_MAX)
                })),
                corroboration: entry?.corroboration ? {
                    status: str(entry.corroboration.status), checkedAt: str(entry.corroboration.checkedAt),
                    accountCount: num(entry.corroboration.accountCount), verifiedCount: num(entry.corroboration.verifiedCount),
                    accounts: (Array.isArray(entry.corroboration.accounts) ? entry.corroboration.accounts : []).slice(0, 6).map((account) => ({
                        address: str(account?.address), role: str(account?.role), exists: bool(account?.exists)
                    }))
                } : null,
                evidence: (Array.isArray(entry?.evidence) ? entry.evidence : []).slice(0, 3).map((row) => ({
                    type: str(row?.type), url: safeUrl(row?.url), note: truncate(row?.note, PROSE_MAX)
                }))
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
                kyc: bool(issuer?.redemption?.kyc),
                eligibility: truncate(issuer?.redemption?.eligibility, PROSE_MAX_SHORT),
                rails: truncate(issuer?.redemption?.rails, PROSE_MAX_SHORT),
                fees: truncate(issuer?.redemption?.fees, PROSE_MAX_SHORT),
                minimum: truncate(issuer?.redemption?.minimum, PROSE_MAX_SHORT)
            },
            redemptionUsability: shapeRedemptionUsability({
                // Scope and preserve the source terms here, before card-size summary truncation.
                // The model keeps product examples from becoming exact-token claims and gives the
                // renderer complete text for an expandable qualification.
                redemption: withExampleScopes(issuer?.redemption, example),
                productSymbol: token?.symbol,
                operationalRouteAvailable: issuer?.redemption?.operationalEvidence
                    ? issuer?.redemption?.operationalRouteAvailable : null,
                operationalRouteEvidence: issuer?.redemption?.operationalEvidence,
                successfulRedemptionObserved: issuer?.redemption?.successfulRedemptionObserved === false
                    ? false
                    : issuer?.redemption?.successfulRedemptionEvidence
                        ? issuer.redemption.successfulRedemptionObserved : null,
                successfulRedemptionEvidence: issuer?.redemption?.successfulRedemptionEvidence ?? null,
                secondaryMarketAvailable,
                reviewStatus: {
                    pending: issuer?.legalReview?.pending ?? null,
                    reviewedAt: issuer?.evidence?.lastCheckedAt ?? null
                },
                // Generated cards retain the proof label without repeating the full source object.
                includeEvidenceDetail: false
            }),
            // Programme-level recurring-scan state line (observed execution only); null without a feed.
            redemptionFeed: describeObservationFeed(issuer?.redemption?.observationFeed ?? null),
            transferRestrictions: {
                allowlist: bool(issuer?.transferRestrictions?.allowlist),
                kycToHold: bool(issuer?.transferRestrictions?.kycToHold),
                usPersonsExcluded: bool(issuer?.transferRestrictions?.usPersonsExcluded),
                mechanism: str(issuer?.transferRestrictions?.mechanism)
            },
            // Which rights of the share reach the holder (stocks/data/holder-rights.json, curated per
            // programme with a source each): the strip at the top and the table in "What you own".
            holderRights: issuer?.holderRights ?? null,
            maturityStage: str(grades.maturityStage),
            maturityStageNum: num(grades.maturityStageNum),
            maturityScore: num(grades.maturityScore)
        },
        reference: {
            source: str(reference.source),
            price: num(reference.price),
            ageSeconds: num(reference.ageSeconds),
            // The underlying market's session at the snapshot instant (the catalogue's builtAt),
            // from its trading schedule. The feed's own is_open flag is true or false at the moment
            // the prices were READ; printed bare it said "open" on a card built after the close.
            // It is kept as `marketOpenAtRead`, with the read time beside it.
            session,
            sessionAt: session === null ? null : str(sources.tokens),
            marketOpen: session === null ? null : session === 'open',
            marketOpenAtRead: bool(reference.marketOpen),
            readAt: str(sources.referencePrices),
            note: truncate(reference.note, PROSE_MAX_SHORT),
            usdPrice: num(market.usdPrice),
            premiumPct: num(reference.premiumPct)
        },
        closedMarket: closedMarketCard(closedMarketItem, closedMarketMeta),
        pyth: cardPyth({ token, referenceItem, pythOnchain, oraclePricing, closedMarketItem, priceReadAt, sessionFallbackAt: str(sources.tokens) }),
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
            publicFloat: floatItem && num(floatItem.floatUi) !== null
                ? { floatUi: num(floatItem.floatUi), inventorySharePct: num(floatItem.inventorySharePct), readAt: str(floatItem.readAt) } : null,
            top: top20.slice(0, HOLDER_ROWS).map((row) => ({
                owner: str(row?.owner),
                sharePct: num(row?.sharePct),
                ownerLabel: str(row?.ownerLabel),
                frozen: row?.state === 'frozen'
            }))
        },
        control: {
            clawback: controlFlag(control.clawback),
            mintAuthority: typeof control.mintAuthority === 'string' ? control.mintAuthority : bool(control.mintAuthority),
            permanentDelegate: typeof control.permanentDelegate === 'string' ? control.permanentDelegate : bool(control.permanentDelegate),
            freezeAuthority: typeof control.freezeAuthority === 'string' ? control.freezeAuthority : bool(control.freezeAuthority),
            pausable: controlFlag(control.pausable),
            paused: bool(control.paused),
            allowlist: controlFlag(control.allowlist),
            transferFeeBps: num(control.transferFeeBps),
            // The fee's cap, any rise already scheduled on-chain, and the epoch they were read at
            // (lib/classify.mjs transferFeeAtEpoch): a scheduled fee is not today's fee.
            transferFeeCapped: bool(control.transferFeeCapped),
            transferFeeScheduled: control.transferFeeScheduled && typeof control.transferFeeScheduled === 'object'
                && Number.isInteger(control.transferFeeScheduled.bps) && Number.isInteger(control.transferFeeScheduled.epoch)
                ? { bps: control.transferFeeScheduled.bps, epoch: control.transferFeeScheduled.epoch, capped: bool(control.transferFeeScheduled.capped) }
                : null,
            transferFeeReadEpoch: Number.isInteger(control.transferFeeReadEpoch) ? control.transferFeeReadEpoch : null,
            hookActive: controlFlag(control.hookActive)
        },
        authorityAttribution: shapeAuthorityAttribution({
            token,
            issuer,
            authorityFacts: token?.authorityFacts ?? issuer?.authorityFacts ?? null
        }),
        keyGovernance: {
            mint: str(issuer?.keyGovernance?.mint),
            freeze: str(issuer?.keyGovernance?.freeze),
            delegate: str(issuer?.keyGovernance?.delegate),
            // The fourth authority (MODEL.md §2.7): the scaled-UI-amount key that restates
            // every holder's displayed balance.
            rebase: str(issuer?.keyGovernance?.rebase),
            evidence: truncate(mentionsExample(issuer?.keyGovernance?.evidence, example)
                ? `Read on ${example.symbol} (programme example): ${issuer.keyGovernance.evidence}` : issuer?.keyGovernance?.evidence, PROSE_MAX)
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
            cex: cexRows(venuesItem?.cex, quoteSymbols),
            // When CoinGecko was last read for THIS token. The exchange markets rotate through a
            // daily call budget (fetch-venues.mjs), so they can be days older than the DEX pools;
            // every exchange figure on the card is dated by this, never by the venues file time.
            cexAsOf: str(venuesItem?.cexFetchedAt)
        },
        // Evidence (stocks/EVIDENCE.md §4): the issuer's coverage numbers for the footer line, and
        // the strongest claim per field for the evidence controls on the three issuer-derived sections.
        evidence: cardEvidence(issuer),
        // The trust chain (stocks/EVIDENCE.md §6.1), copied out of the issuer record exactly as the
        // builder graded it, so the diagram a card draws and the one the issuer panel draws are the
        // same drawing. A record with no `chain` (a token whose issuer has no dossier) gets null and
        // the section says so.
        trustChain: issuer?.chain ?? null,
        redemptionSchematic: Array.isArray(schematics?.redemption) && schematics.redemption.length > 0
            ? schematics.redemption[0] : null,
        whatIf: cardWhatIf(whatIf, catalogue, archives, example),
        issuerApi: issuerApiFacts(token?.issuer, token?.issuerApi),
        sources: {
            tokens: str(sources.tokens),
            issuers: str(sources.issuers),
            issuerApi: str(sources.issuerApi),
            referencePrices: str(sources.referencePrices),
            holders: str(sources.holders),
            venues: str(sources.venues),
            trades: str(sources.trades),
            closedMarket: str(sources.closedMarket),
            meteora: str(sources.meteora),
            defiUsage: str(sources.defiUsage),
            // The chain's clock at the Pyth read (stocks/data/pyth-onchain.json readAt).
            pythOnchain: str(pythOnchain?.readAt)
        }
    };

    return roundDeep(card);
}

/**
 * `{symbol, pattern}` when `product` (the product an issuer's dossier was researched on) is not
 * this token, else null. `pattern` matches any of the product's names as whole words.
 */
function researchExampleFor(product, token) {
    const symbol = str(product?.symbol);
    if (symbol === null || String(token?.symbol ?? '').toLowerCase() === symbol.toLowerCase()) return null;
    const terms = [...new Set([symbol, ...(Array.isArray(product.terms) ? product.terms : [])].map(str).filter((term) => term !== null && term.length >= 3))];
    const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return { symbol, pattern: new RegExp(`\\b(?:${escaped.join('|')})\\b`) };
}

function mentionsExample(value, example) {
    return example !== null && example !== undefined && typeof value === 'string' && example.pattern.test(value);
}

/**
 * The issuer's redemption terms with every term that names the researched product scoped as that
 * product's example (redemption-usability.js `product-example`), unless the dossier already scopes
 * it. The complete text is kept; the card's summary then says the term is not confirmed for this token.
 */
function withExampleScopes(redemption, example) {
    if (example === null || !redemption || typeof redemption !== 'object') return redemption;
    const scopes = { ...(redemption.termScopes && typeof redemption.termScopes === 'object' ? redemption.termScopes : {}) };
    for (const field of ['eligibility', 'minimum', 'fees', 'rails']) {
        if (scopes[field] === undefined && mentionsExample(redemption[field], example)) {
            scopes[field] = { kind: 'product-example', products: [example.symbol], source: `researched on ${example.symbol}` };
        }
    }
    return { ...redemption, termScopes: scopes };
}

/**
 * The underlying market's session at `atIso` from its Pyth trading schedule string: 'open',
 * 'closed', 'holiday', or null when the schedule or the instant is missing or unreadable. Pure:
 * the instant is an input (the catalogue's builtAt), never the clock.
 */
export function underlyingSession(schedule, atIso) {
    const at = Date.parse(typeof atIso === 'string' ? atIso : '');
    if (!Number.isFinite(at)) return null;
    const session = sessionAt(parseSchedule(schedule), at);
    return session === 'unknown' ? null : session;
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

/**
 * The busiest exchange markets. `target` is the quote asset exactly as CoinGecko reports it (a DEX
 * ticker's is an UPPERCASED address); `targetLabel` is what a reader sees: a symbol, or a
 * shortened address when neither the known quote assets nor our own mints name it.
 */
function cexRows(cex, quoteSymbols = null) {
    return (Array.isArray(cex) ? cex : [])
        .filter((row) => row && typeof row === 'object')
        .slice()
        .sort((a, b) => (num(b.volume24Usd) ?? -1) - (num(a.volume24Usd) ?? -1) ||
            String(a.market ?? '').localeCompare(String(b.market ?? '')))
        .slice(0, VENUE_ROWS)
        .map((row) => ({
            market: str(row.market),
            target: str(row.target),
            targetLabel: pairLegLabel(row.target, quoteSymbols),
            priceUsd: num(row.priceUsd),
            volume24Usd: num(row.volume24Usd),
            url: safeUrl(row.url),
            lastTradedAt: str(row.lastTradedAt)
        }));
}

/**
 * The record the card PUBLISHES — its companion .json file — lets a machine read a card without
 * parsing its HTML. renderCard links that file; it does not inline it.
 *
 * It is not the whole of buildCard's record, for one measured reason: a card has a 15 kB budget, and
 * the dossier prose the page renders above (what the holder owns, the jurisdiction, the redemption
 * terms, the authority-key evidence) costs ~1.3 kB rendered and would cost it again in the
 * companion JSON, as
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
 * missing-source label; a field that neither has nor needs a claim is left out entirely.
 */
/**
 * The change judge's MATERIAL verdicts that concern this token, newest first: change events on its
 * mint or on its issuer's documents, detected in the `windowDays` before `asOf` (the export's own
 * timestamp, never a clock, so a rebuild from the same export is byte-identical). One judgment reads
 * every event of one change, so a change is counted once, represented by the event the judge read
 * (else the earliest). Rows the builder did not mark `material: true` are ignored here as well.
 * Returns null when there is nothing to show, and the card then shows nothing.
 */
/** A dossier field path in words: `vocabulary.thirdPartyAttestation` -> "third party attestation". */
function fieldWords(path) {
    const words = String(path).replace(/\[[^\]]*\]/g, '').replace(/^vocabulary\./, '').replace(/\.value$/, '')
        .split('.').filter(Boolean).map(labelize);
    return words.join(' ') || String(path);
}

/** What a watcher's record path names: `sources[15]` -> "a listed source". */
const RECORD_PATH_WORDS = {
    sources: 'a listed source', documents: 'a listed document', incidents: 'an incident’s source',
    whatIf: 'a what-if search', claims: 'a claim’s source'
};

/**
 * A change watcher's summary in words. The watchers write for the review queue: the dossier slug
 * and record path lead (`xstocks-backed:sources[15]: +9 -2 line(s) · keywords: fee`) and a lost
 * quote names its claim by field path. A card says the issuer's name, the field in words and the
 * line counts as a sentence. Text it does not recognise passes through unchanged.
 */
export function humanChangeSummary(summary, { issuerSlug = null, issuerName = null } = {}) {
    if (typeof summary !== 'string') return null;
    const ours = (slug) => issuerSlug !== null && (slug === issuerSlug || slug.startsWith(`${issuerSlug}-`));
    return summary
        .replace(/^([a-z0-9]+(?:-[a-z0-9]+)*)(?::([^\s:]+))?: /, (whole, slug, path) => {
            if (!ours(slug) && slug !== 'shared') return whole;
            const who = slug === 'shared' ? 'A shared source' : issuerName ?? humanizeSlug(slug);
            const head = path === undefined ? null : /^\[?([A-Za-z]*)/.exec(path)[1];
            const where = path === undefined ? '' : ` (${RECORD_PATH_WORDS[head] ?? fieldWords(path)})`;
            return `${who}${where}: `;
        })
        .replace(/\bthe quoted words for claim ([\w.[\]-]+)/g, (_, path) => `the words we quoted for “${fieldWords(path)}”`)
        .replace(/\bthe quoted words for what-if ([\w-]+)/g, (_, mode) => `the words we quoted for the what-if question “${humanizeSlug(mode).toLowerCase()}”`)
        .replace(/\b[a-z0-9-]+:claims\[\d+\]\.url\b/g, 'the source that claim cites')
        .replace(/\+(\d+) -(\d+) line\(s\)(?: \([\w-]+\))?/g, (_, added, removed) => `${added} line${added === '1' ? '' : 's'} added, ${removed} removed`)
        .replace(/ · keywords: /g, ' · mentions ');
}

export function cardMaterialChanges(rows, token, { asOf = null, windowDays = MATERIAL_CHANGE_DAYS, issuerName = null } = {}) {
    if (!Array.isArray(rows) || rows.length === 0 || token === null || typeof token !== 'object') return null;
    const end = Date.parse(asOf ?? '');
    if (!Number.isFinite(end)) return null;
    const start = end - windowDays * 86400000;
    const byChange = new Map();
    for (const row of rows) {
        if (row?.material !== true || str(row.assessmentSummary) === null) continue;
        const ours = (str(row.issuerSlug) !== null && row.issuerSlug === token.issuer)
            || (row.subjectType === 'token' && row.subjectId === token.mint);
        if (!ours) continue;
        const at = Date.parse(row.detectedAt ?? '');
        if (!Number.isFinite(at) || at <= start || at > end) continue;
        const key = str(row.judgmentId) ?? `event:${row.id}`;
        const held = byChange.get(key);
        let better;
        if (held === undefined) better = true;
        else if ((row.representative === true) !== (held.row.representative === true)) better = row.representative === true;
        else better = at < held.at || (at === held.at && Number(row.id) < Number(held.row.id));
        if (better) byChange.set(key, { at, row });
    }
    if (byChange.size === 0) return null;
    const changes = [...byChange.values()]
        .sort((a, b) => b.at - a.at || Number(b.row.id) - Number(a.row.id))
        .map(({ row }) => ({
            id: str(String(row.id)),
            detectedAt: str(row.detectedAt),
            // In words BEFORE the cut, so a cut can never leave half a field path behind.
            change: truncate(humanChangeSummary(row.summary, { issuerSlug: token.issuer ?? null, issuerName }), PROSE_MAX)
                ?? str(row.kind),
            assessmentSeverity: str(row.assessmentSeverity),
            assessment: truncate(row.assessmentSummary, PROSE_MAX)
        }));
    return { asOf: str(asOf), windowDays, count: changes.length, items: changes.slice(0, MATERIAL_CHANGE_ROWS) };
}

/**
 * The what-if answer sheet a card carries: all 38 questions in catalogue order, unanswered ones as
 * gaps, each cut to what OUTCOME_MAX explains — status, question, outcome, source. The quote, the
 * note and the `searched[]` record are deliberately dropped here rather than in the renderer, so
 * the card's own JSON cannot carry what the page does not show.
 *
 * `cases[]` survives (minus the holding prose) because a `litigated` answer whose citation was
 * dropped would be an assertion that a court decided something, with nothing to check.
 */
export function cardWhatIf(whatIf, catalogue, archives = null, example = null) {
    if (!catalogue || !Array.isArray(catalogue.failureModes)) return null;
    const answers = whatIfLib.answersFromDossier(whatIf, catalogue, { archives }).map((answer) => ({
        mode: answer.mode,
        actor: answer.actor,
        flow: answer.flow,
        question: answer.question,
        status: answer.status,
        // An answer that names the researched product is labelled as its example; the label is
        // inside the OUTCOME_MAX cut, so it costs outcome words rather than card bytes.
        outcome: truncate(mentionsExample(answer.outcome, example)
            ? `Researched on ${example.symbol} (programme example): ${answer.outcome}` : answer.outcome, OUTCOME_MAX),
        quote: null,
        url: answer.url,
        locator: truncate(answer.locator, LOCATOR_MAX),
        accessedAt: answer.accessedAt,
        sourceTitle: truncate(answer.sourceTitle, PROSE_MAX),
        archiveUrl: answer.archiveUrl,
        cases: answer.cases.map((entry) => ({
            name: entry.name, court: entry.court, date: entry.date, url: entry.url, holding: null
        })),
        searched: [],
        note: null
    }));
    return {
        version: str(catalogue.version),
        researchedOn: example === null ? null : example.symbol,
        counts: whatIfLib.countAnswers(answers),
        // The actor order and labels ride along, because cards.mjs is pure and cannot read the
        // catalogue file the page fetches — and the groups must be in the same order in both.
        actors: (Array.isArray(catalogue.actors) ? catalogue.actors : [])
            .map((actor) => ({ id: str(actor?.id), label: str(actor?.label) }))
            .filter((actor) => actor.id !== null),
        answers
    };
}

export function cardEvidence(issuer) {
    const summary = issuer?.evidence ?? null;
    const currentClaims = evidenceLib.publicClaims(Array.isArray(issuer?.claims) ? issuer.claims : []);
    const byField = evidenceLib.claimsByField(currentClaims);
    const needed = new Set(Array.isArray(issuer?.evidenceFields) ? issuer.evidenceFields : []);
    const titles = documentTitles(issuer);
    const fields = {};
    for (const path of CARD_CLAIM_FIELDS) {
        const claims = (byField[path] ?? []).slice(0, CARD_CLAIMS_PER_FIELD).map((claim) => ({
            quote: truncate(claim.quote, QUOTE_MAX),
            url: safeUrl(claim.url),
            // The document's own title from the dossier's register, so the link names what it opens
            // rather than the host that serves it ("cdn.prod.website-files.com").
            sourceTitle: truncate(titles.get(claim.url) ?? null, SOURCE_TITLE_MAX),
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
        inferenceReviewed: summary?.inferenceReviewed ?? 0,
        inferenceUnreviewed: summary?.inferenceUnreviewed ?? 0,
        lastCheckedAt: summary?.lastCheckedAt ?? null,
        fields
    };
}

/** Source-backed claim/reality conflicts, filtered to this exact token when the row is scoped. */
export function cardDiscrepancies(issuer, token = null) {
    return (Array.isArray(issuer?.discrepancies) ? issuer.discrepancies : [])
        .filter((row) => {
            const mints = Array.isArray(row?.affectedMints) ? row.affectedMints.filter(Boolean) : [];
            return mints.length === 0 || token === null || mints.includes(token?.mint);
        }).map(cardDiscrepancy);
}

/**
 * Docs-vs-chain findings on a protocol market that takes this exact token (records from
 * discrepancy-view.js protocolDiscrepancyRecords), in the card's discrepancy shape plus the
 * protocol name and a link to its dossier.
 */
export function cardProtocolDiscrepancies(records, token = null) {
    return (Array.isArray(records) ? records : [])
        .filter((row) => row?.tokenMint && row.tokenMint === token?.mint)
        .map((row) => ({
            ...cardDiscrepancy({ ...row, affectedMints: [row.tokenMint],
                classification: `${str(row.protocolName) ?? 'protocol'} market, docs vs chain` }),
            protocol: str(row.protocolName),
            href: typeof row.dossierSlug === 'string' && /^[a-z0-9-]+$/.test(row.dossierSlug)
                ? `../protocols/${row.dossierSlug}.html` : null
        }));
}

function cardDiscrepancy(row) {
    return {
        id: str(row?.id),
        title: truncate(row?.title, PROSE_MAX * 2),
        severity: ['info', 'caution', 'warning', 'critical'].includes(row?.severity) ? row.severity : 'info',
        observedAt: str(row?.observedAt),
        classification: str(row?.classification) ?? (Array.isArray(row?.affectedMints) && row.affectedMints.length
            ? 'asset-specific' : 'issuer-programme'),
        affectedMints: (Array.isArray(row?.affectedMints) ? row.affectedMints : []).map(str).filter(Boolean),
        resolutionCondition: truncate(row?.resolutionCondition, PROSE_MAX * 3),
        claim: {
            text: truncate(row?.claim?.text, PROSE_MAX * 4),
            sources: (Array.isArray(row?.claim?.sources) ? row.claim.sources : []).map((source) => ({
                label: truncate(source?.label, PROSE_MAX_SHORT),
                url: safeUrl(source?.url),
                locator: truncate(source?.locator, PROSE_MAX),
                accessedAt: str(source?.accessedAt)
            }))
        },
        reality: {
            text: truncate(row?.reality?.text, PROSE_MAX * 4),
            sources: (Array.isArray(row?.reality?.sources) ? row.reality.sources : []).map((source) => ({
                label: truncate(source?.label, PROSE_MAX_SHORT),
                url: safeUrl(source?.url),
                locator: truncate(source?.locator, PROSE_MAX),
                accessedAt: str(source?.accessedAt)
            }))
        },
        impact: truncate(row?.impact, PROSE_MAX * 3)
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
        researchedOn: card.researchedOn,
        // Full prose and citations are already rendered immediately above this script. Keep only
        // a machine-readable summary in the byte-capped inlined record.
        discrepancies: card.discrepancies.map((row) => ({
            id: row.id,
            severity: row.severity,
            classification: row.classification,
            affectedMints: row.affectedMints
        })),
        underReview: card.underReview,
        // The count and ids only; the readings are rendered on the page and served by /api/changes.
        materialChanges: card.materialChanges === null ? null : {
            basis: 'model assessment',
            asOf: card.materialChanges.asOf,
            windowDays: card.materialChanges.windowDays,
            count: card.materialChanges.count,
            ids: card.materialChanges.items.map((item) => item.id)
        },
        health: {
            status: card.health.status,
            worstRuleId: card.health.worstRuleId,
            dimensions: card.health.dimensions,
            rules: card.health.rules.map((rule) => ({
                id: rule.id,
                dimension: rule.dimension,
                status: rule.status,
                value: rule.value,
                inputs: rule.inputs
            }))
        },
        // The page renders the reviewed explanation in full. The inlined machine record keeps the
        // template identity and outcomes, not a second copy of that prose (about 3 kB per card).
        composability: card.composability === null ? null : {
            id: card.composability.id,
            healthStatus: card.composability.healthStatus,
            scenarios: Object.fromEntries(COMPOSABILITY_SCENARIOS.map((scenario) => [
                scenario.id,
                { outcome: card.composability.scenarios?.[scenario.id]?.outcome ?? null }
            ]))
        },
        defiUsage: card.defiUsage === null ? null : {
            confirmedUseCount: card.defiUsage.confirmedUseCount,
            protocols: card.defiUsage.protocols,
            actions: card.defiUsage.actions,
            integrations: card.defiUsage.integrations.map((entry) => ({
                protocolId: entry.protocolId,
                protocolName: entry.protocolName,
                status: entry.status,
                actions: entry.actions,
                links: entry.links,
                metrics: entry.metrics,
                evidenceTier: entry.evidenceTier,
                proof: entry.proof,
                capabilities: entry.capabilities.map((capability) => ({
                    action: capability.action, status: capability.status, custody: capability.custody,
                    enforcement: capability.enforcement
                })),
                corroboration: entry.corroboration === null ? null : {
                    status: entry.corroboration.status,
                    accountCount: entry.corroboration.accountCount,
                    verifiedCount: entry.corroboration.verifiedCount
                }
            }))
        },
        // The evidence SUMMARY only. The per-field claims are rendered on the page above, and the
        // full set — every claim on every field, uncut — is served by /api/issuers/:slug/claims and
        // carried by stocks-issuers.json. Inlining them here as well cost 9.3 kB on a fully sourced
        // card (measured 2026-09-18 on TSMon), which is a third of the card for a second copy of
        // what the reader is already looking at.
        evidence: evidenceSummaryOf(card.evidence),
        // The chain's SHAPE, not its prose: who fills each seat and how each flow is graded. The
        // field values and their claim statuses are rendered above and served whole by
        // /api/issuers/:slug/chain; a second copy of them here would be 4 kB of duplicate text.
        trustChain: card.trustChain === null ? null : {
            nodes: (card.trustChain.nodes ?? []).map((node) => ({
                actor: node.actor,
                parties: (node.parties ?? []).map((party) => party.name).filter((name) => name !== null)
            })),
            links: (card.trustChain.links ?? []).map((link) => ({
                flow: link.flow, evidence: link.evidence, verification: link.verification
            }))
        },
        // The counts only. The answers are rendered above and served whole by
        // /api/issuers/:slug/what-if, with the quotes the card does not carry.
        whatIf: card.whatIf === null ? null : { version: card.whatIf.version, counts: card.whatIf.counts },
        ownership: {
            claimRung: card.ownership.claimRung,
            claimLabel: card.ownership.claimLabel,
            legalForm: card.ownership.legalForm,
            redemptionAvailable: card.ownership.redemption.available,
            // Complete terms are already in the static card's expandable disclosure. Do not copy
            // them into its adjacent JSON record as well: that would make a full qualification
            // cost twice and pressure the measured card-size ceiling.
            redemptionUsability: card.ownership.redemptionUsability === null ? null : {
                ...card.ownership.redemptionUsability,
                fields: card.ownership.redemptionUsability.fields.map(({ completeText, ...field }) => field)
            },
            transferRestrictions: card.ownership.transferRestrictions,
            maturityStage: card.ownership.maturityStage,
            maturityStageNum: card.ownership.maturityStageNum,
            maturityScore: card.ownership.maturityScore
        },
        reference: {
            source: card.reference.source,
            price: card.reference.price,
            ageSeconds: card.reference.ageSeconds,
            session: card.reference.session,
            sessionAt: card.reference.sessionAt,
            marketOpen: card.reference.marketOpen,
            marketOpenAtRead: card.reference.marketOpenAtRead,
            readAt: card.reference.readAt,
            usdPrice: card.reference.usdPrice,
            premiumPct: card.reference.premiumPct
        },
        closedMarket: card.closedMarket,
        pyth: card.pyth,
        depth: card.depth,
        holders: card.holders,
        control: card.control,
        keyGovernance: {
            mint: card.keyGovernance.mint,
            freeze: card.keyGovernance.freeze,
            delegate: card.keyGovernance.delegate,
            rebase: card.keyGovernance.rebase
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
    inference: 'ev-muted',
    changed: 'ev-warn',
    'source-gone': 'ev-warn'
};

/**
 * The labelled evidence control after a value on a card (stocks/EVIDENCE.md §4). A <details> so it opens by tap and
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
            ? `<span class="ev-none" title="${escapeHtml(NO_CLAIM_TEXT)}">No source</span>`
            : '';
    }
    const best = claims[0];
    const cls = CARD_STATUS_CLASS[best.status] ?? 'ev-muted';
    const body = claims.map((claim) => {
        // Never the whole URL: the href carries the path, and printing it twice was the single
        // biggest thing the chips cost when every field is sourced. The document's title (cut to
        // SOURCE_TITLE_MAX) when the dossier registers one, else the host.
        const source = claim.url === null
            ? '<span class="t">no URL recorded</span>'
            : link(claim.url, sourceLabel(claim.url, claim.sourceTitle));
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
        `aria-label="${escapeHtml(`Evidence for ${label}`)}">Evidence</summary>` +
        `<div class="ev-pop">${body}</div></details>`;
}

/** How long a source document's title may run as a link label; the locator follows it. */
export const SOURCE_TITLE_MAX = 48;

/** url -> title from the dossier's document register (`documents[]`). */
function documentTitles(issuer) {
    const titles = new Map();
    for (const doc of Array.isArray(issuer?.documents) ? issuer.documents : []) {
        const url = safeUrl(doc?.url);
        const title = str(doc?.title);
        if (url !== null && title !== null && !titles.has(url)) titles.set(url, title);
    }
    return titles;
}

/** Hosts that are an interface rather than a document, named for what they are. */
const HOST_WORDS = { 'api.mainnet-beta.solana.com': 'Solana mainnet RPC' };

/** A source link's label: the document's title when the register has one, else what serves it. */
function sourceLabel(url, title = null) {
    if (typeof title === 'string' && title !== '') return title;
    const name = host(url);
    return HOST_WORDS[name] ?? name;
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

function discrepancySourcesHtml(sources) {
    const rows = (Array.isArray(sources) ? sources : []).map((source) => {
        const label = source.label ?? host(source.url) ?? 'Source';
        const citation = isSafeUrl(source.url)
            ? `<a href="${escapeHtml(source.url)}" rel="nofollow noopener">${escapeHtml(label)}</a>`
            : `<span>${escapeHtml(label)}</span>`;
        return `<li>${citation}${source.accessedAt ? ` · checked ${shortTime(source.accessedAt)}` : ''}</li>`;
    }).join('');
    return rows ? `<ul class="discrepancy-sources">${rows}</ul>` : '<p class="discrepancy-missing">No source recorded.</p>';
}

function discrepancySideHtml(label, side, kind) {
    return `<article class="discrepancy-side discrepancy-side-${kind}"><h3>${escapeHtml(label)}</h3>`
        + `<p>${text(side?.text)}</p>${discrepancySourcesHtml(side?.sources)}</article>`;
}

export function discrepanciesBody(card) {
    if (!Array.isArray(card?.discrepancies) || card.discrepancies.length === 0) {
        return '<p class="note">No current claim-versus-observed-reality discrepancy has been documented for this issuer.</p>';
    }
    return `<div class="discrepancy-list">${card.discrepancies.map((row) => `<article class="discrepancy-item discrepancy-${escapeHtml(row.severity)}">`
            + `<header><b>${escapeHtml(row.severity)}</b><h3>${text(row.title)}</h3></header>`
            + `<p class="discrepancy-observed">Scope: ${escapeHtml(row.classification ?? 'issuer programme')}</p>`
            + `<div class="discrepancy-sides">${discrepancySideHtml('Published claim', row.claim, 'claim')}`
            + `${discrepancySideHtml('Observed reality', row.reality, 'reality')}</div>`
            + `${row.impact === null ? '' : `<p class="discrepancy-impact"><strong>Why it matters</strong>${escapeHtml(row.impact)}</p>`}`
            + `${row.resolutionCondition === null ? '' : `<p class="discrepancy-impact"><strong>What resolves it</strong>${escapeHtml(row.resolutionCondition)}</p>`}`
            + `${row.observedAt === null ? '' : `<p class="discrepancy-observed">Observed ${shortTime(row.observedAt)}</p>`}`
            + `${row.href ? `<p><a href="${escapeHtml(row.href)}">Open the ${escapeHtml(row.protocol ?? 'protocol')} dossier</a></p>` : ''}`
            + '</article>').join('')}</div>`;
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
    const parts = Object.entries(inputs).map(([key, value]) => `${labelize(key)}: ${key === 'referenceSource'
        ? referenceLabel(value) ?? DASH : inputValue(value)}`);
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
        parts.push(`${fmtSignedPct(card.reference.premiumPct)} vs ${card.underlyingTicker ?? referenceLabel(card.reference.source) ?? 'reference'}`);
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
    const usability = card.ownership.redemptionUsability;
    const redemption = o.redemption.available === null && !usability.fields.some((field) => field.value !== null)
        ? null
        : `${yesNo(o.redemption.available)}. Holder, jurisdiction, route and fee conditions are below.`;

    const summary = kv([
        ['Claim depth', rung],
        ['Legal form', o.legalForm === null ? null : text(humanizeSlug(o.legalForm)), 'legalForm'],
        ['What the holder owns', o.holderClaim === null ? null : escapeHtml(o.holderClaim), 'holderClaim'],
        ['Issuing entity', o.issuingEntity === null ? null : escapeHtml(o.issuingEntity), 'issuingEntity'],
        ['Jurisdiction', o.entityJurisdiction === null ? null : escapeHtml(o.entityJurisdiction), 'entityJurisdiction'],
        ['Governing law', o.governingLaw === null ? null : escapeHtml(o.governingLaw), 'governingLaw'],
        ['Regulatory status', o.regulatoryStatus === null ? null : escapeHtml(o.regulatoryStatus), 'regulatoryStatus'],
        // Full redemption terms and their direct sources appear once in the usability disclosure
        // below. Do not repeat the same four claim popovers beside this summary line.
        ['Redemption', redemption],
        ['Transfer restrictions', restrictions.length ? escapeHtml(restrictions.join(' · ')) : null,
            ['transferRestrictions.allowlist', 'transferRestrictions.kycToHold',
                'transferRestrictions.usPersonsExcluded', 'transferRestrictions.mechanism']],
        ['Ledger maturity', maturity]
    ], card.evidence);
    const redemptionEvidenceField = {
        'eligibility-and-place': 'redemption.eligibility',
        minimum: 'redemption.minimum',
        fees: 'redemption.fees',
        'timing-and-settlement': 'redemption.rails',
        'successful-redemption': 'redemption.successfulRedemptionObserved'
    };
    const usabilityRows = usability.fields.map((field) => {
        // An observed execution carries its product scoping in `summary` ("… not for TSLAx itself"):
        // show that rather than a bare "Yes" that would read as this exact token being redeemed.
        const value = field.value === true ? (field.id === 'successful-redemption' && field.summary ? field.summary : 'Yes')
            : field.value === false ? 'No'
            : field.value === null ? 'Unknown' : String(field.summary ?? field.value);
        const claim = card.evidence?.fields?.[redemptionEvidenceField[field.id]]?.claims?.[0] ?? null;
        const source = claim?.url === null || claim?.url === undefined ? ''
            : `<small class="redemption-source">${claim.quote === null ? '' : `<q>${escapeHtml(claim.quote)}</q> `}Source: ${link(claim.url, sourceLabel(claim.url, claim.sourceTitle))}`
                + `${claim.locator === null ? '' : ` · <code>${escapeHtml(claim.locator)}</code>`}</small>`;
        const complete = typeof field.completeText === 'string' && field.completeText !== ''
            ? `<details class="redemption-term"><summary>${escapeHtml(humanDates(value))}</summary><p>${escapeHtml(humanDates(field.completeText))}</p>${source}</details>`
            : `<b>${escapeHtml(humanDates(value))}</b>`;
        return `<div><dt>${escapeHtml(field.label)}</dt><dd>${complete}`
            + `<small class="evidence-state">${escapeHtml(humanizeSlug(field.evidence))}</small></dd></div>`;
    });
    // The recurring scan is observed execution for the whole programme, so it sits right after the
    // single observed-execution row and never replaces that row's product scoping.
    const feed = card.ownership.redemptionFeed ?? null;
    if (feed !== null) {
        const at = usability.fields.findIndex((field) => field.id === 'successful-redemption');
        usabilityRows.splice(at < 0 ? usabilityRows.length : at + 1, 0, '<div class="redemption-feed"><dt>Recurring on-chain scan (programme)</dt>'
            + `<dd><b>${escapeHtml(humanDates(feed.text))}</b><small class="evidence-state">${escapeHtml(humanizeSlug(feed.state))}</small></dd></div>`);
    }
    const banner = usability.documentedButNotIndependentlyObserved
        ? '<p class="redemption-observation"><strong>Documented, but not independently observed.</strong> Contract terms do not prove that an eligible holder can complete the route today.</p>'
        : '';
    const rights = holderRightsLib.holderRightsDetailHtml(holderRightsLib.holderRightsRows(o.holderRights));
    return summary + rights + `<div class="redemption-usability"><h3>Can a holder redeem?</h3>${banner}<dl>${usabilityRows.join('')}</dl></div>`
        + redemptionSchematicHtml(card);
}

/**
 * A link to the programme's redemption schematic on the issuer page. Measured 2026-09-24: even the
 * SVG alone adds ~4.4 kB (6.2 kB with its step list) and the widest card was already past the
 * 96 kB target, so the drawing lives on the issuer page and the card only names and links it.
 */
function redemptionSchematicHtml(card) {
    const spec = card.redemptionSchematic ?? null;
    const slug = card.issuer?.slug ?? null;
    if (spec === null || slug === null) return '';
    const example = card.researchedOn ? ` (researched on ${card.researchedOn}, a programme example)` : '';
    return `<p class="redemption-schematic-link"><a href="../issuers/${encodeURIComponent(slug)}.html#how-it-works">`
        + `See it drawn step by step: ${escapeHtml(spec.title ?? 'redemption route')}${escapeHtml(example)} →</a></p>`;
}

const SESSION_WORDS = { open: 'open', closed: 'closed', holiday: 'closed for a market holiday' };

/**
 * How each reference-price source is derived, in words (the source's own name is health.mjs
 * REFERENCE_SOURCE_LABELS, shared with the tracking rule's note). The record keeps the key.
 */
const REFERENCE_DERIVATION = {
    'ondo-implied': 'Ondo’s asset registry: market capitalisation divided by shares outstanding. It carries no publish time, so the reference’s age is unknown.',
    'issuer-mark': 'Published by the issuer itself, with no independent check. It carries no publish time, so the reference’s age is unknown.'
};

function referenceLabel(source) {
    return source === null || source === undefined ? null : REFERENCE_SOURCE_LABELS[source] ?? humanizeSlug(source);
}

/**
 * "closed at 24 Sep 2026 21:27 UTC; open when the reference price was read, 24 Sep 2026 19:08 UTC".
 * The session at the snapshot instant leads; the feed's read-time flag follows only when it says
 * something different, and always with its own time, so neither reads as "now".
 */
function sessionHtml(r) {
    const atRead = r.marketOpenAtRead === null ? null
        : `${r.marketOpenAtRead ? 'open' : 'closed'} when the reference price was read${r.readAt === null ? '' : `, ${time(r.readAt)}`}`;
    if (r.session === null) return atRead;
    const atSnapshot = `${SESSION_WORDS[r.session] ?? r.session} at ${time(r.sessionAt)}`;
    return atRead !== null && r.marketOpenAtRead !== r.marketOpen ? `${atSnapshot}; ${atRead}` : atSnapshot;
}

function referenceBody(card) {
    const r = card.reference;
    const label = referenceLabel(r.source);
    const derived = (r.source === null ? null : REFERENCE_DERIVATION[r.source]) ?? r.note;
    return kv([
        ['Reference source', label === null ? null : text(label.charAt(0).toUpperCase() + label.slice(1))],
        ['Reference price', r.price === null ? null : text(fmtPrice(r.price))],
        ['Reference age', r.ageSeconds === null ? null : text(fmtAgeSeconds(r.ageSeconds))],
        ['Underlying market', sessionHtml(r)],
        ['On-chain price (Jupiter)', r.usdPrice === null ? null : text(fmtPrice(r.usdPrice))],
        ['Premium', r.premiumPct === null ? null : text(fmtSignedPct(r.premiumPct))],
        ['How the reference is derived', derived === null ? null : escapeHtml(derived)]
    ]);
}

/**
 * The card's copy of a stocks-closed-market.json item: null when that file was not built (the
 * section says so), an empty lender list when no lending market takes the token. Only what the
 * section renders and the JSON record needs; the full item stays in the dataset.
 */
function closedMarketCard(item, meta) {
    if (meta === null || meta === undefined) return null;
    const lenders = Array.isArray(item?.lenders) ? item.lenders : [];
    const sourceUrl = (source) => (isSafeUrl(source?.url) ? source.url : null);
    return {
        researchedAt: str(meta.researchReviewedAt),
        builtAt: str(meta.generatedAt),
        lenders: lenders.map((l) => ({
            protocolId: str(l.protocolId),
            protocolName: str(l.protocolName),
            marketId: str(l.marketId),
            displayName: str(l.displayName) ?? str(l.protocolName),
            labelKind: str(l.labelKind),
            label: str(l.label),
            staleSince: str(l.staleSince),
            liquidationLtvPct: num(l.liquidationLtvPct),
            maxLtvPct: num(l.maxLtvPct),
            hidden: l.hidden === true,
            sentence: str(l.sentence),
            sourceUrl: sourceUrl(l.source),
            freezes: l.freezes ?? null,
            mondayGaps: l.mondayGaps ?? null
        })),
        depth: item?.depth ?? null,
        weekendMove: item?.weekendMove ?? null,
        findings: (Array.isArray(item?.findings) ? item.findings : []).map((f) => ({
            schema: str(f.schema), name: str(f.name), severity: str(f.severity), marketId: str(f.marketId),
            short: str(f.short), statement: str(f.statement), sourceUrl: sourceUrl(f.source)
        }))
    };
}

/**
 * "When the market is closed": for each lending market that takes the token, the price it uses
 * while the US market is closed (one of five labels), its liquidation threshold and one sentence
 * for a borrower, then its freezes and Monday gap; below them the Solana depth, the weekend move
 * where a lender prices from the token itself, and the findings. Wording: closed-market-view.js.
 */
function closedMarketBody(card) {
    const c = card.closedMarket;
    if (c === null) return '<p class="no">Not built yet (stocks/build-closed-market.mjs).</p>';
    if (c.lenders.length === 0) {
        return '<p class="no">No Solana lending market we track takes this token as collateral (Kamino, Jupiter Lend, '
            + 'Nest and Loopscale checked; Project 0 and Save list no stock token).</p>';
    }
    const V = closedMarketView;
    // Byte-capped: one line per lender for the label and threshold, its sentence, and one line for
    // freezes and the Monday gap. The per-market sources are in the linked data file.
    const lenders = c.lenders.map((l) => {
        const freezes = V.freezeText(l.freezes, l.protocolId);
        const gaps = V.gapsText(l.mondayGaps, 2);
        const meta = [freezes === null ? null : `Freezes (30 d): ${freezes}`, gaps === null ? null : `Monday gap: ${gaps}`].filter(Boolean);
        return `<li><b>${escapeHtml(l.displayName ?? DASH)}</b> <span class="cm-l ${V.labelClass(l.labelKind)}">${escapeHtml(l.label ?? DASH)}</span>`
            + `${l.liquidationLtvPct === null ? '' : ` <i>liquidation at ${escapeHtml(fmtNumber(l.liquidationLtvPct))} % LTV</i>`}`
            + `${l.hidden ? ' <small>(reserve hidden in the app)</small>' : ''}`
            + `${l.sentence === null ? '' : `<p>${escapeHtml(l.sentence)}</p>`}`
            + `${meta.length ? `<small>${escapeHtml(meta.join(' · '))}</small>` : ''}</li>`;
    }).join('');
    const weekend = V.weekendMoveText(c.weekendMove);
    const rows = kv([
        ['Solana depth, sale to USDC', escapeHtml(V.depthText(c.depth))],
        // Named after the lender(s) whose price follows the token (today only Nest).
        [`Weekend move in ${[...new Set(c.lenders.filter((l) => l.labelKind === 'token-24x7' || l.labelKind === 'signed-quote').map((l) => l.protocolName))].join(' and ') || 'the lender'}'s price`,
            weekend === null ? null : escapeHtml(weekend)],
        ['Exposure at the Monday gap', 'not measured']
    ]);
    // A finding's severity is its own word (info / caution / warning / critical), not a health status.
    const severity = (sev) => `<b class="c-${['info', 'caution', 'warning', 'critical'].includes(sev) ? sev : 'unknown'}">${escapeHtml(sev ?? 'finding')}</b>`;
    const findings = c.findings.length === 0 ? '' : `<ul class="cm-f">${c.findings.map((f) => `<li>${severity(f.severity)} `
        + `${f.sourceUrl === null ? escapeHtml(f.name ?? f.schema ?? '') : link(f.sourceUrl, f.name ?? f.schema ?? '')}`
        + `${f.short === null ? '' : `: ${escapeHtml(f.short)}`}</li>`).join('')}</ul>`;
    const n = c.lenders.length;
    return `<p class="cm-lead">${n === 1 ? 'One lending market takes' : `${n} lending markets take`} it; the price each uses while the US market is closed:</p>`
        + `<ul class="cm-list">${lenders}</ul>${rows}${findings}`
        + `<p class="cm-src">Read on-chain ${escapeHtml(fmtDate(c.researchedAt))}; freezes: our lending watcher; gaps: Kamino; depth: Jupiter. `
        + '<a href="../stocks-closed-market.json">Data, sources</a> · <a href="#pyth">Which Pyth feed each lender reads</a></p>';
}

// --- Pyth on this token -------------------------------------------------------------------------

/** "49f6b6…5688": a Pyth feed id short enough to print; the record keeps it whole. */
function shortFeedId(id) {
    return typeof id === 'string' && id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

/** A Pyth schedule whose every day is `O` (open all day): the token feeds trade 24/7. */
function alwaysOpen(schedule) {
    const days = typeof schedule === 'string' ? schedule.split(';')[1] : null;
    return typeof days === 'string' && days.split(',').length === 7 && days.split(',').every((day) => day === 'O');
}

function unixOf(iso) {
    const ms = Date.parse(typeof iso === 'string' ? iso : '');
    return Number.isFinite(ms) ? ms / 1000 : null;
}

/** pyth-onchain.json indexed once per build (the same object is handed to every card). */
const PYTH_INDEX = new WeakMap();
function pythIndex(onchain) {
    if (!onchain || typeof onchain !== 'object') return null;
    let index = PYTH_INDEX.get(onchain);
    if (index === undefined) {
        const feeds = Array.isArray(onchain.feeds) ? onchain.feeds : [];
        index = {
            byId: new Map(feeds.map((feed) => [feed.id, feed])),
            bySymbol: new Map(feeds.map((feed) => [feed.symbol, feed])),
            tokens: new Map((Array.isArray(onchain.tokens) ? onchain.tokens : []).map((row) => [row.mint, row]))
        };
        PYTH_INDEX.set(onchain, index);
    }
    return index;
}

/** One account reading as the card keeps it: price, confidence, Pyth's publish time and its age at our read. */
function pythReading(reading, readAt) {
    if (!reading) return null;
    const read = unixOf(readAt);
    return {
        price: num(reading.price), conf: num(reading.conf), publishedAt: str(reading.publishedAt),
        ageSeconds: read !== null && isNum(reading.publishTime) ? Math.round(read - reading.publishTime) : null,
        shard: Number.isInteger(reading.shard) ? reading.shard : null, account: str(reading.address)
    };
}

/**
 * A feed named in the lenders' oracle research: "Crypto.QQQX/USD (Pyth Lazer 1837)",
 * "Equity.US.SPY/USD (Pyth push, PriceUpdateV2)" or "Crypto.SPCXX/USD (the xStocks SpaceX token
 * feed, used for the Backpack token)". Null for anything that is not a Pyth symbol (a Raydium pool).
 */
function researchedFeed(text, lazerId = null) {
    const value = str(text);
    const m = value === null ? null : /^((?:Crypto|Equity)\.\S+)(?:\s+\((.*)\))?$/.exec(value);
    if (m === null) return null;
    const lazer = /Pyth Lazer (\d+)/.exec(m[2] ?? '');
    return {
        symbol: m[1],
        lazerId: Number.isInteger(lazerId) ? lazerId : lazer ? Number(lazer[1]) : null,
        note: lazer || /Pyth push/.test(m[2] ?? '') ? null : str(m[2])
    };
}

/**
 * A Kamino gate's band as a percentage, or null when the research did not record one for this
 * market: "within 500 bps" / "more than 500 bps" in the xStocks Pool's gate sentences, or the
 * summary's "… at 1,000 bps" (the STRCx Pool). The Sentora market records none of its own.
 */
function gatePct(priceSource, which, words) {
    const gate = (Array.isArray(priceSource?.gates) ? priceSource.gates : []).find((g) => typeof g === 'string' && which.test(g));
    const inGate = gate ? words.exec(gate) : null;
    const inSummary = inGate ? null : new RegExp(`${which.source}[^;]*? at ([\\d,]+) bps`).exec(String(priceSource?.summary ?? ''));
    const bps = inGate?.[1] ?? inSummary?.[1] ?? null;
    return bps === null ? null : Number(bps.replace(/,/g, '')) / 100;
}

/** Where a lender that reads no Pyth feed gets its price, in words, per researched price-source kind. */
const NON_PYTH_SOURCES = {
    'chainlink-data-streams-v11-24x5-mid': 'Chainlink Data Streams',
    'protocol-signed-quote': 'a Nest-signed Jupiter quote',
    'redstone-end-of-day': 'RedStone’s end-of-day price'
};

/**
 * One lender that takes the token, and what it reads from Pyth (stocks/data/protocol-market-research.json
 * `oraclePricing`, read on-chain): `uses` is 'values' (Pyth prices the collateral), 'rate' (a Pyth
 * price times a Pyth redemption rate), 'check' (another oracle prices it; Pyth gates it), 'push'
 * (a Pyth price account on Solana, with its freshness), 'none' or 'unknown' (not researched).
 */
function pythLender(lender, mint, oraclePricing, index, readAt) {
    const market = (Array.isArray(oraclePricing?.markets) ? oraclePricing.markets : []).find((m) => marketIdOf(m.id) === lender.marketId) ?? null;
    const c = (Array.isArray(market?.collateral) ? market.collateral : []).find((row) => row?.mint === mint) ?? null;
    const kind = str(market?.priceSource?.kind);
    const base = {
        name: str(lender.displayName) ?? str(lender.protocolName), protocolId: str(lender.protocolId), marketId: str(lender.marketId),
        uses: 'unknown', feeds: [], priceFrom: null, bandPct: null, referencePct: null, note: null,
        account: null, accountShard: null, maxAgeS: null, lastPublishedAt: null, checkedAt: null, ageAtCheckS: null,
        checkedBy: null, sameFeedLive: null
    };
    if (market === null || c === null || kind === null) return base;
    if (kind === 'pyth-lazer-24x7-token-price') {
        const feed = researchedFeed(c.feed, c.pythLazerFeedId);
        return { ...base, uses: feed ? 'values' : 'unknown', feeds: feed ? [{ symbol: feed.symbol, lazerId: feed.lazerId, role: 'token' }] : [], note: feed?.note ?? null };
    }
    if (kind === 'chainlink-data-streams-v10-equity-price') {
        const band = researchedFeed(c.gateSource);
        const reference = researchedFeed(c.referenceFeed);
        const feeds = [band && { symbol: band.symbol, lazerId: band.lazerId, role: 'band' }, reference && { symbol: reference.symbol, lazerId: reference.lazerId, role: 'reference' }].filter(Boolean);
        return {
            ...base, uses: feeds.length ? 'check' : 'none', feeds, priceFrom: 'Chainlink Data Streams',
            bandPct: band ? gatePct(market.priceSource, /MostRecentOf/, /within (\d+) bps/) : null,
            referencePct: reference ? gatePct(market.priceSource, /reference check/, /more than (\d+) bps/) : null
        };
    }
    if (kind === 'pyth-lazer-equity-times-redemption-rate') {
        const symbol = String(c.symbol ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const m = symbol ? new RegExp(`\\b${symbol} = (\\S+) \\((\\d+)\\) × (\\S+) \\((\\d+)`).exec(String(market.priceSource.summary ?? '')) : null;
        return m === null ? base : { ...base, uses: 'rate', feeds: [
            { symbol: m[3], lazerId: Number(m[4]), role: 'stock' }, { symbol: m[1], lazerId: Number(m[2]), role: 'rate' }
        ] };
    }
    if (kind === 'pyth-core-equity-push') {
        const feed = researchedFeed(c.feed);
        const account = str(c.oracleAccount);
        const read = feed ? index?.bySymbol.get(feed.symbol) ?? null : null;
        const own = (Array.isArray(read?.accounts) ? read.accounts : []).find((a) => a.address === account) ?? null;
        // The lending watcher's view first (the closed-market row: the account's last publish time
        // and the chain clock at its last check); our own read of the same account otherwise.
        let lastPublishedAt = str(lender.staleSince);
        let checkedAt = lastPublishedAt === null ? null : str(lender.staleStillAt);
        let checkedBy = lastPublishedAt === null ? null : 'lending-watcher';
        if (lastPublishedAt === null && own?.publishedAt) {
            lastPublishedAt = own.publishedAt;
            checkedAt = str(readAt);
            checkedBy = 'pyth-read';
        }
        const ageAtCheckS = unixOf(checkedAt) !== null && unixOf(lastPublishedAt) !== null ? Math.round(unixOf(checkedAt) - unixOf(lastPublishedAt)) : null;
        const best = freshestReading(read?.accounts);
        const sameFeedLive = best !== null && best.address !== account && best.publishTime > (unixOf(lastPublishedAt) ?? -Infinity)
            ? pythReading(best, readAt) : null;
        return {
            ...base, uses: 'push', feeds: feed ? [{ symbol: feed.symbol, lazerId: null, role: 'stock' }] : [],
            account, accountShard: Number.isInteger(own?.shard) ? own.shard : null,
            maxAgeS: num(market.stalenessAndPause?.maxPriceAgeSeconds), lastPublishedAt, checkedAt, ageAtCheckS, checkedBy,
            sameFeedLive: sameFeedLive && { shard: sameFeedLive.shard, account: sameFeedLive.account, publishedAt: sameFeedLive.publishedAt, ageSeconds: sameFeedLive.ageSeconds }
        };
    }
    return NON_PYTH_SOURCES[kind] ? { ...base, uses: 'none', priceFrom: NON_PYTH_SOURCES[kind] } : base;
}

/**
 * "Pyth on this token": the Pyth feeds for the token and its stock, the stock's session on Pyth's
 * schedule at the instant of our Solana read, the prices read from Pyth's push-oracle accounts with
 * Pyth's own publish times, the token-vs-stock gap and the premium (each only when its instants
 * allow it), and what every lender that takes the token reads from Pyth. Pure: every instant is an
 * input (the chain clock of the read, Pyth's publish times, the universe read), never the clock.
 */
export function cardPyth({ token, referenceItem = null, pythOnchain = null, oraclePricing = null, closedMarketItem = null, priceReadAt = null, sessionFallbackAt = null }) {
    const index = pythIndex(pythOnchain);
    const readAt = str(pythOnchain?.readAt);
    const mapped = index?.tokens.get(token?.mint) ?? null;
    const stockFeedId = str(referenceItem?.pythFeedId) ?? str(mapped?.stockFeedId);
    const stockRead = stockFeedId === null ? null : index?.byId.get(stockFeedId) ?? null;
    const stockSymbol = stockRead?.symbol ?? (stockFeedId === null ? null : equitySymbolForTicker(referenceItem?.underlyingTicker));
    const tokenRead = str(mapped?.tokenFeedId) === null ? null : index?.byId.get(mapped.tokenFeedId) ?? null;
    const feed = (role, id, symbol, read) => ({
        role, symbol, id, url: feedPageUrl(symbol), read: Array.isArray(read?.accounts), alwaysOpen: alwaysOpen(read?.schedule)
    });
    const feeds = [
        stockFeedId !== null && stockSymbol !== null ? feed('stock', stockFeedId, stockSymbol, stockRead) : null,
        tokenRead !== null ? feed('token', tokenRead.id, tokenRead.symbol, tokenRead) : null
    ].filter(Boolean);

    const stockRaw = freshestReading(stockRead?.accounts);
    const tokenRaw = freshestReading(tokenRead?.accounts);
    const at = readAt ?? sessionFallbackAt;
    const schedule = str(referenceItem?.schedule);
    const session = stockFeedId !== null && schedule !== null ? underlyingSession(schedule, at) : null;

    let premium = null;
    if (referenceItem?.refSource === 'pyth' && isNum(referenceItem.refPrice)) {
        premium = {
            source: 'pyth-hermes', pythPrice: num(referenceItem.refPrice), publishedAt: isNum(referenceItem.refPublishTime)
                ? new Date(referenceItem.refPublishTime * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
            pct: num(referenceItem.premiumPct), comparable: isNum(referenceItem.premiumPct), reason: null, apartSeconds: null,
            jupiterPrice: num(referenceItem.jupiterPrice), jupiterReadAt: null
        };
    } else if (stockRaw !== null) {
        const measured = premiumOverPyth(token?.market?.usdPrice, priceReadAt, stockRaw, readAt);
        premium = measured === null ? null : {
            source: 'pyth-onchain', pythPrice: num(stockRaw.price), publishedAt: str(stockRaw.publishedAt), ...measured,
            jupiterPrice: num(token?.market?.usdPrice), jupiterReadAt: str(priceReadAt)
        };
    }

    return {
        checked: referenceItem !== null && referenceItem !== undefined,
        tokenFeedsChecked: pythOnchain !== null && pythOnchain !== undefined,
        feeds,
        readAt,
        // A string: the card's numbers are cut to six significant figures, and a slot must stay exact.
        readSlot: Number.isInteger(pythOnchain?.readSlot) ? String(pythOnchain.readSlot) : null,
        shards: Array.isArray(pythOnchain?.shards) ? pythOnchain.shards : PYTH_SHARDS,
        session,
        sessionAt: session === null ? null : at,
        stock: pythReading(stockRaw, readAt),
        token: pythReading(tokenRaw, readAt),
        gap: tokenStockGap(tokenRaw, stockRaw),
        premium,
        lenders: (Array.isArray(closedMarketItem?.lenders) ? closedMarketItem.lenders : [])
            .map((lender) => pythLender(lender, token?.mint, oraclePricing, index, readAt))
    };
}

function solscanAccount(address, label) {
    return address === null ? escapeHtml(label) : link(`https://solscan.io/account/${address}`, label);
}

/** "$335.78 ± $0.11, published 25 Sep 2026 00:00 UTC, 6 s before our read · shard 1 account". */
function pythReadingHtml(feed, reading, p) {
    if (!feed.read) return 'not read in the last Solana read';
    if (reading === null) {
        return `no Pyth price account for ${escapeHtml(feed.symbol)} on Solana (shards ${escapeHtml(p.shards.join(' and '))} read ${time(p.readAt)})`;
    }
    const age = reading.ageSeconds === null ? '' : `, ${escapeHtml(humanizeDuration(reading.ageSeconds * 1000))} before our read`;
    return `${escapeHtml(fmtPrice(reading.price))}${reading.conf === null ? '' : ` ± ${escapeHtml(fmtPrice(reading.conf))}`}, `
        + `published ${time(reading.publishedAt)}${age} · ${solscanAccount(reading.account, `shard ${reading.shard} account`)}`;
}

function pythGapHtml(p) {
    const g = p.gap;
    if (g === null) return null;
    if (!g.comparable) {
        return `not compared: the token price on Solana was published ${escapeHtml(humanizeDuration(-g.apartSeconds * 1000))} before the stock’s`;
    }
    return `${escapeHtml(fmtSignedPct(g.pct))}: the token’s 24/7 price against the stock’s latest Pyth price, `
        + 'the gap a lender that values it at the token price is exposed to while the US market is closed';
}

function pythPremiumHtml(p) {
    const m = p.premium;
    if (m === null) return null;
    if (m.source === 'pyth-hermes') {
        const symbol = p.feeds.find((f) => f.role === 'stock')?.symbol ?? 'stock feed';
        return m.comparable ? `${escapeHtml(fmtSignedPct(m.pct))} over Pyth’s ${escapeHtml(symbol)} ${escapeHtml(fmtPrice(m.pythPrice))} on Hermes, published ${time(m.publishedAt)}` : null;
    }
    if (!m.comparable) {
        return `not compared: the Jupiter price was read ${escapeHtml(humanizeDuration(Math.abs(m.apartSeconds) * 1000))} `
            + `${m.apartSeconds > 0 ? 'before' : 'after'} the Pyth read`;
    }
    return `${escapeHtml(fmtSignedPct(m.pct))} over the stock’s Pyth price (Jupiter ${escapeHtml(fmtPrice(m.jupiterPrice))}, read ${time(m.jupiterReadAt)})`;
}

function lazerName(feed) {
    return `${escapeHtml(feed.symbol)}${feed.lazerId === null ? '' : ` (feed ${escapeHtml(String(feed.lazerId))})`}`;
}

/** One sentence per lender: which Pyth feed it reads and what for; the Loopscale account's freshness. */
function pythLenderHtml(l) {
    const name = `<b>${escapeHtml(l.name ?? DASH)}</b>`;
    const byRole = (role) => l.feeds.find((f) => f.role === role) ?? null;
    if (l.uses === 'values') {
        const f = l.feeds[0];
        return `${name} values it at Pyth Lazer ${lazerName(f)}, ${escapeHtml(l.note ?? 'the token’s own 24/7 price')}, less its confidence interval.`;
    }
    if (l.uses === 'rate') {
        return `${name} values it at Pyth Lazer ${lazerName(byRole('stock'))} times ${lazerName(byRole('rate'))}: the listed share’s price times its redemption rate.`;
    }
    if (l.uses === 'check') {
        const band = byRole('band');
        const reference = byRole('reference');
        const pct = (value) => escapeHtml(fmtNumber(value));
        const clauses = [
            band && `Chainlink and ${lazerName(band)} must agree${l.bandPct === null ? '' : ` within ${pct(l.bandPct)} %`}`,
            reference && `a Chainlink report ${l.referencePct === null ? 'too far' : `more than ${pct(l.referencePct)} %`} from ${lazerName(reference)} is rejected`
        ].filter(Boolean);
        return `${name} prices it from ${escapeHtml(l.priceFrom)}; Pyth Lazer is the check: ${clauses.join(', and ')}.`;
    }
    if (l.uses === 'push') {
        const f = l.feeds[0];
        const account = l.account === null ? 'a Pyth price account' : `the Pyth price account ${solscanAccount(l.account, shortAddress(l.account))}${l.accountShard === null ? '' : ` (shard ${l.accountShard})`}`;
        let out = `${name} values it at Pyth ${f ? escapeHtml(f.symbol) : 'Core'} from ${account}${l.maxAgeS === null ? '' : `, which may be at most ${escapeHtml(fmtNumber(l.maxAgeS))} s old`}.`;
        const stale = l.ageAtCheckS !== null && l.maxAgeS !== null && l.ageAtCheckS > l.maxAgeS;
        if (l.lastPublishedAt !== null && stale) {
            const who = l.checkedBy === 'lending-watcher' ? 'at our lending watcher’s last check' : 'at our read';
            out += ` The Pyth price account Loopscale reads stopped being updated on ${time(l.lastPublishedAt)}: `
                + `${escapeHtml(humanizeDuration(l.ageAtCheckS * 1000))} old ${who}, ${time(l.checkedAt)}, against Loopscale’s ${escapeHtml(fmtNumber(l.maxAgeS))} s maximum.`;
        } else if (l.lastPublishedAt !== null) {
            out += ` Last published ${time(l.lastPublishedAt)}.`;
        }
        if (l.sameFeedLive !== null) {
            out += ` Pyth’s shard-${escapeHtml(String(l.sameFeedLive.shard))} account for the same feed (${solscanAccount(l.sameFeedLive.account, shortAddress(l.sameFeedLive.account))}) was published ${time(l.sameFeedLive.publishedAt)}.`;
        }
        return out;
    }
    if (l.uses === 'none') return `${name} prices it from ${escapeHtml(l.priceFrom)}; no Pyth feed.`;
    return `${name}: not researched yet.`;
}

function pythBody(card) {
    const p = card.pyth;
    const lenders = p.lenders.length === 0 ? ''
        : `<p class="pyth-lead">What each lender that takes it reads from Pyth:</p><ul class="pyth-lenders">${p.lenders.map((l) => `<li>${pythLenderHtml(l)}</li>`).join('')}</ul>`;
    if (p.feeds.length === 0) {
        const line = !p.checked ? 'Not checked yet: this token is newer than our last read of Pyth’s feed lists.'
            : p.tokenFeedsChecked ? 'Pyth publishes no feed for this token or its stock (Pyth’s equity and crypto feed lists checked).'
                : 'Pyth publishes no feed for its stock (Pyth’s equity feed list checked); its token feeds were not read yet.';
        return `<p class="no">${escapeHtml(line)}</p>${lenders}`;
    }
    const stockFeed = p.feeds.find((f) => f.role === 'stock') ?? null;
    const tokenFeed = p.feeds.find((f) => f.role === 'token') ?? null;
    const feedHtml = (f) => `${link(f.url, f.symbol)} <code>${escapeHtml(shortFeedId(f.id))}</code> `
        + `${f.role === 'stock' ? 'the stock' : f.alwaysOpen ? 'this token, 24/7' : 'this token'}`;
    const read = p.readAt !== null;
    const rows = kv([
        ['Pyth feeds', p.feeds.map(feedHtml).join(' · ')],
        ['US market (Pyth schedule)', p.session === null ? null : `${escapeHtml(SESSION_WORDS[p.session] ?? p.session)} at ${time(p.sessionAt)}`],
        ['Pyth prices on Solana', read ? null : 'not read yet (stocks/fetch-pyth-onchain.mjs)'],
        ['Stock on Pyth (Solana)', read && stockFeed ? pythReadingHtml(stockFeed, p.stock, p) : null],
        ['Token on Pyth (Solana)', read && tokenFeed ? pythReadingHtml(tokenFeed, p.token, p) : null],
        ['Token vs stock on Pyth', pythGapHtml(p)],
        ['Premium over Pyth', pythPremiumHtml(p)]
    ]);
    const source = read
        ? `<p class="pyth-src">Prices read from Solana${p.readSlot === null ? '' : ` at slot ${escapeHtml(p.readSlot)}`}, ${time(p.readAt)}: `
            + 'Pyth’s push-oracle price accounts, no API key; publish times are Pyth’s own. Lender feeds: our on-chain oracle research.</p>'
        : '';
    return `${rows}${lenders}${source}`;
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
    // Exchange markets, and the last trade seen on one, come from the CoinGecko read dated cexAsOf,
    // which can be days older than the rest of this section; each such row carries that date.
    const exchangeAsOf = card.venues.cexAsOf === null ? '' : ` · exchange data as of ${time(card.venues.cexAsOf)}`;
    const lastTrade = d.lastTradedAt === null
        ? null
        : `${time(d.lastTradedAt)}${d.lastTradedVenue === null ? '' : ` on ${escapeHtml(d.lastTradedVenue)}`}${exchangeAsOf}`;

    return kv([
        ['Liquidity (Jupiter, all pools)', d.liquidityUsd === null ? null : text(fmtMoney(d.liquidityUsd))],
        ['Volume 24 h', d.vol24Usd === null ? null : text(fmtMoney(d.vol24Usd))],
        ['Organic share', organic],
        ['Flow 24 h', flow.length ? escapeHtml(flow.join(' · ')) : null],
        ['Venues', `${text(fmtNumber(d.dexPairs))} DEX pair(s) · ${text(fmtNumber(d.cexMarkets))} exchange market(s)${d.cexMarkets === null ? '' : exchangeAsOf}`],
        ['Cross-venue spread', spread === DASH ? null : escapeHtml(spread)],
        ['Last exchange trade seen', lastTrade],
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
        ['Supply', h.supplyUi === null ? null : text(fmtNumber(h.supplyUi, 2))],
        // xStocks: redeemed tokens return to issuer wallets instead of burning (flows.html#float).
        ['Float, upper bound', h.publicFloat ? `${text(fmtNumber(h.publicFloat.floatUi, 0))} <span class="t">${text(fmtPct(h.publicFloat.inventorySharePct))} in issuer wallets</span> <a href="../flows.html#float">how</a>` : null]
    ]) + table;
}

/** "3.00 % (no cap)": basis points as a percentage, with the per-transfer cap when it is known. */
function feeText(bps, capped) {
    return `${(bps / 100).toFixed(2)} %${capped === false ? ' (no cap)' : ''}`;
}

/** "1.00 % (no cap) now, at epoch 1042; 3.00 % (no cap) scheduled from epoch 1043", or null with no fee read. */
function transferFeeText(c) {
    if (!isNum(c.transferFeeBps) && c.transferFeeScheduled === null) return null;
    const now = isNum(c.transferFeeBps)
        ? `${feeText(c.transferFeeBps, c.transferFeeCapped)}${c.transferFeeReadEpoch === null ? '' : ` now, at epoch ${c.transferFeeReadEpoch}`}`
        : 'fee in effect not read';
    const next = c.transferFeeScheduled;
    return next === null ? now : `${now}; ${feeText(next.bps, next.capped)} scheduled from epoch ${next.epoch}`;
}

function controlBody(card) {
    const c = card.control;
    const g = card.keyGovernance;
    const fee = transferFeeText(c);
    const authority = (value) => typeof value === 'string'
        ? `<code title="${escapeHtml(value)}">${escapeHtml(shortAddress(value))}</code>`
        : value === false ? 'None observed' : null;
    const summary = kv([
        ['Mint authority', authority(c.mintAuthority)],
        ['Freeze authority', authority(c.freezeAuthority)],
        ['Permanent delegate', authority(c.permanentDelegate)],
        ['Transfer fee', fee === null ? null : escapeHtml(fee)],
        ['Paused right now', c.paused === null ? null : yesNo(c.paused)],
        // Rebase changes the displayed economic balance, so keep it directly visible rather than
        // only in the consolidated governance line below.
        ['Rebase-authority governance', g.rebase === null ? null : text(humanizeSlug(g.rebase)), 'keyGovernance.rebase'],
        // Capability and governance states are stated once in the attribution block below. The
        // old rows repeated that same data next to the exact authority addresses.
        ['Evidence', g.evidence === null ? null : escapeHtml(g.evidence)]
    ], card.evidence);
    const authorities = card.authorityAttribution.authorities;
    const capabilityList = (state) => authorities.filter((row) => row.technicalCapability === state)
        .map((row) => row.label).join(', ') || 'None';
    const groupedAuthorityFacts = (rows, valueFor) => {
        const groups = new Map();
        for (const row of rows) {
            const value = valueFor(row);
            if (!value) continue;
            if (!groups.has(value)) groups.set(value, []);
            groups.get(value).push(row.label);
        }
        return [...groups.entries()].map(([value, labels]) => `${labels.join(', ')}: ${value}`).join(' · ') || 'Not established';
    };
    const governed = groupedAuthorityFacts(
        authorities.filter((row) => row.governance.type !== 'unknown'),
        (row) => humanizeSlug(row.governance.type)
    );
    const attributed = groupedAuthorityFacts(authorities, (row) => [row.governance.controller,
        row.governance.signerThreshold, row.governance.upgradeAuthority, row.governance.lastRotatedAt]
        .filter(Boolean).join(' · '));
    const circumstances = authorities.filter((row) => row.governance.contractualCircumstances)
        .map((row) => `${row.label}: ${row.governance.contractualCircumstances}`).join(' · ') || 'Not established';
    // One RPC observation commonly proves several capabilities (for example, a multisig vault
    // controlling both freeze and pause). Print its date and source once per observation, while
    // retaining each capability's distinct technical note.
    const technicalGroups = new Map();
    for (const row of authorities.filter((item) => item.governance.technicalNotes)) {
        const note = row.governance.technicalNotes;
        const observedAt = row.governance.observedAt ?? null;
        const source = row.governance.source ?? null;
        const key = JSON.stringify([observedAt, source]);
        if (!technicalGroups.has(key)) technicalGroups.set(key, { labels: [], notes: new Map(), observedAt, source });
        const group = technicalGroups.get(key);
        group.labels.push(row.label);
        group.notes.set(note, [...(group.notes.get(note) ?? []), row.label]);
    }
    const technicalNotes = [...technicalGroups.values()]
        .flatMap((group) => [...group.notes].map(([note, labels]) => `${labels.join(', ')}: ${note}`))
        .join(' · ') || 'Not established';
    const technicalEvidence = [...technicalGroups.values()].map((group) => {
        const label = group.labels.join(', ');
        const date = group.observedAt ? `observed ${escapeHtml(fmtDate(group.observedAt))}` : null;
        const source = group.source && safeUrl(group.source) ? link(group.source, sourceLabel(group.source))
            : group.source ? escapeHtml(group.source) : null;
        const detail = [date, source].filter(Boolean).join(' · ');
        return detail ? `${escapeHtml(label)} — ${detail}` : null;
    }).filter(Boolean).join(' · ') || 'Not established';
    return summary + '<div class="authority-attribution"><h3>Capability and permission</h3>'
        + '<p class="note">Capability, governance and legal permission are separate facts. Unknown never counts as safe.</p>'
        + kv([['Capabilities present', escapeHtml(capabilityList('present'))],
            ['Capabilities absent', escapeHtml(capabilityList('absent'))],
            ['Capabilities unknown', escapeHtml(capabilityList('unknown'))],
            ['Recorded key governance', escapeHtml(governed)],
            ['Controller / threshold / rotation', escapeHtml(attributed)],
            ['Contractual circumstances', escapeHtml(circumstances)],
            ['Technical control notes', escapeHtml(technicalNotes)],
            ['Technical observations', technicalEvidence]]) + '</div>';
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
        const pair = row.targetLabel === null ? '' : ` <span class="t">${escapeHtml(row.targetLabel)}</span>`;
        return `<tr><td>${name}${pair}</td><td class="n">${text(fmtPrice(row.priceUsd))}</td>` +
            `<td class="n">${text(fmtMoney(row.volume24Usd))}</td><td>${row.lastTradedAt === null ? DASH : time(row.lastTradedAt)}</td></tr>`;
    }).join('');

    const dex = dexRows
        ? `<h3>DEX pools (DexScreener)</h3><div class="scroll"><table class="r"><thead><tr><th scope="col">Pool</th>` +
          `<th scope="col">Price</th><th scope="col">Liquidity</th><th scope="col">Vol 24 h</th></tr></thead>` +
          `<tbody>${dexRows}</tbody></table></div>`
        : '<h3>DEX pools (DexScreener)</h3><p class="no">No DEX pool reported.</p>';
    // The CoinGecko read is rotated through a daily call budget, so the table states its own date
    // and what its 24 h volume covers.
    const asOf = card.venues.cexAsOf;
    const cex = cexRowsHtml
        ? `<h3>Exchange markets</h3>` +
          `${asOf === null ? '' : `<p class="note">Exchange data as of ${time(asOf)}, from CoinGecko. Each 24 h volume covers the 24 h before that time.</p>`}` +
          `<div class="scroll"><table class="r"><thead><tr><th scope="col">Market</th>` +
          `<th scope="col">Price</th><th scope="col">Vol 24 h</th><th scope="col">Last trade</th></tr></thead>` +
          `<tbody>${cexRowsHtml}</tbody></table></div>`
        : `<h3>Exchange markets</h3><p class="no">No exchange market reported${asOf === null ? '' : ` as of ${time(asOf)}`}.</p>`;
    return dex + cex;
}

function issuerApiBody(card) {
    const a = card.issuerApi;
    if (a === null) return '';
    const caveat = '<p class="note">These are the issuer\'s own numbers, with no independent check. They were read ' +
        'at the <em>issuer APIs</em> time in the footer, which can be hours older than the rest of ' +
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

/**
 * The trust-chain diagram (stocks/EVIDENCE.md §6.1), drawn by the same pure library the issuer
 * panel uses. The flow list under it carries the fields and their claim statuses, so the drawing is
 * readable with no pointer and no JavaScript — which a static card has to be.
 */
function trustChainBody(card) {
    if (card.trustChain === null) {
        return '<p class="tc-empty">No trust chain has been built for this token’s issuer.</p>';
    }
    const example = card.researchedOn
        ? ` The diagram was drawn from the dossier researched on ${card.researchedOn}, a programme example: a party it names for that product (such as its underlying company) is not ${card.symbol ?? 'this token'}’s.`
        : '';
    return '<p class="wi-note">Thirteen actors sit between you and the company, with nine rights '
        + 'flows between them. Colour shows how well each link is evidenced and line style shows '
        + 'how it was verified; both are derived from the data. A role nobody fills stays on the '
        + `chart, so the gap is visible.${escapeHtml(example)}</p>`
        + trustChainSvg.diagramHtml(card.trustChain, {
            id: `chain-${card.slug}`,
            title: `Trust chain — ${card.issuer.name ?? card.issuer.slug ?? 'issuer'}`,
            // A card names the fields each link rests on and whether anything is claimed about them
            // — the grade's whole derivation — but not their values: nine flows of dossier prose
            // was 9.4 kB, and /api/issuers/:slug/chain serves it whole.
            maxValue: 0,
            maxSummary: CHAIN_SUMMARY_MAX
        })
        + `<p class="tc-out"><a href="../issuers/${encodeURIComponent(card.issuer.slug)}.html">`
        + 'The issuer dossier, including the fields behind each grade</a></p>';
}

/**
 * The what-if answers (stocks/EVIDENCE.md §6.3), cut to what a byte-capped page can carry: status,
 * question, outcome and source. The quote, the note, the case holdings and the search record are on
 * the issuer panel, which this section links to — see OUTCOME_MAX for the measurement behind that.
 */
function whatIfBody(card) {
    if (card.whatIf === null) {
        return '<p class="wi-empty">The failure-mode catalogue did not load at build time, so this '
            + 'card cannot say which questions are answered.</p>';
    }
    const actors = card.whatIf.actors ?? [];
    return whatIfLib.whatIfHtml(card.whatIf.answers, {
        order: actors.map((actor) => actor.id),
        labels: Object.fromEntries(actors.map((actor) => [actor.id, actor.label])),
        intro: `Every issuer gets the same ${card.whatIf.answers.length} questions, so missing answers `
            + 'show as gaps. An outcome is never invented. The quote behind each answer, the '
            + 'cases and where we looked are on the issuer panel.'
            + (card.whatIf.researchedOn ? ` These answers were researched on ${card.whatIf.researchedOn} and describe the programme; `
                + `an answer that names ${card.whatIf.researchedOn} is marked as that example, not a fact about ${card.symbol ?? 'this token'}.` : ''),
        quote: false,
        note: false,
        cases: true,
        searched: false,
        maxOutcome: OUTCOME_MAX,
        // One numbered source list at the foot instead of the same 150-character URL and
        // 90-character title on all 38 rows.
        footnoteSources: true
    }) + `<p class="tc-out"><a href="../issuers/${encodeURIComponent(card.issuer.slug)}.html">`
        + 'Full answers, with the quotes, notes and primary-document register, in the issuer dossier</a></p>';
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

function defiActions(actions) {
    return (Array.isArray(actions) ? actions : [])
        .map((action) => DEFI_ACTION_LABELS[action] ?? humanizeSlug(action))
        .join(' · ');
}

function defiMetrics(entry) {
    const m = entry?.metrics ?? {};
    const parts = [];
    if (isNum(m.sizeUsd)) parts.push(`${fmtMoney(m.sizeUsd)} ${typeof m.sizeLabel === 'string' ? m.sizeLabel : 'market size'}`);
    if (isNum(m.maxLtvMin) || isNum(m.maxLtvMax)) {
        const low = isNum(m.maxLtvMin) ? m.maxLtvMin * 100 : m.maxLtvMax * 100;
        const high = isNum(m.maxLtvMax) ? m.maxLtvMax * 100 : low;
        parts.push(`max LTV ${low === high ? fmtPct(low) : `${fmtPct(low)}–${fmtPct(high)}`}`);
    }
    if (isNum(m.liquidityUsd)) parts.push(`${fmtMoney(m.liquidityUsd)} pool liquidity`);
    if (isNum(m.volume24Usd)) parts.push(`${fmtMoney(m.volume24Usd)} volume 24 h`);
    if (isNum(m.collateralWeightMin) || isNum(m.collateralWeightMax)) {
        const low = isNum(m.collateralWeightMin) ? m.collateralWeightMin * 100 : m.collateralWeightMax * 100;
        const high = isNum(m.collateralWeightMax) ? m.collateralWeightMax * 100 : low;
        parts.push(`collateral weight ${low === high ? fmtPct(low) : `${fmtPct(low)}–${fmtPct(high)}`}`);
    }
    if (isNum(m.liquidationLtvMin) || isNum(m.liquidationLtvMax)) {
        const low = isNum(m.liquidationLtvMin) ? m.liquidationLtvMin * 100 : m.liquidationLtvMax * 100;
        const high = isNum(m.liquidationLtvMax) ? m.liquidationLtvMax * 100 : low;
        parts.push(`liquidation LTV ${low === high ? fmtPct(low) : `${fmtPct(low)}–${fmtPct(high)}`}`);
    }
    if (isNum(m.liquidationPenaltyMin) || isNum(m.liquidationPenaltyMax)) {
        const low = isNum(m.liquidationPenaltyMin) ? m.liquidationPenaltyMin * 100 : m.liquidationPenaltyMax * 100;
        const high = isNum(m.liquidationPenaltyMax) ? m.liquidationPenaltyMax * 100 : low;
        parts.push(`liquidation penalty ${low === high ? fmtPct(low) : `${fmtPct(low)}–${fmtPct(high)}`}`);
    }
    if (Array.isArray(m.oracleProviders) && m.oracleProviders.length) parts.push(`oracle ${m.oracleProviders.join(', ')}`);
    if (isNum(m.maxOracleStalenessSeconds)) parts.push(`oracle max age ${fmtNumber(m.maxOracleStalenessSeconds)} s`);
    if (isNum(m.utilizationPct)) parts.push(`utilisation ${fmtPct(m.utilizationPct)}`);
    if (isNum(m.depositLimitUsd)) parts.push(`${fmtMoney(m.depositLimitUsd)} deposit cap`);
    if (isNum(m.borrowLimitUsd)) parts.push(`${fmtMoney(m.borrowLimitUsd)} borrow cap`);
    if (isNum(m.pools)) parts.push(`${fmtNumber(m.pools)} pool${m.pools === 1 ? '' : 's'}`);
    if (isNum(m.positions)) parts.push(`${fmtNumber(m.positions)} position${m.positions === 1 ? '' : 's'}`);
    // Only an integration that names its debt measure shows it (Loopscale: open loan principal).
    if (isNum(m.debtAgainstCollateralUsd) && typeof m.debtLabel === 'string') parts.push(`${fmtMoney(m.debtAgainstCollateralUsd)} ${m.debtLabel}`);
    if (isNum(m.loansPastEnd) && m.loansPastEnd > 0) parts.push(`${fmtNumber(m.loansPastEnd)} past end date`);
    return parts.join(' · ');
}

function defiUsageBody(card) {
    const usage = card.defiUsage;
    const integrations = Array.isArray(usage?.integrations) ? usage.integrations : [];
    if (integrations.length === 0) {
        return '<p class="no"><strong>None source-listed.</strong> No exact-mint integration was found in the protocol registries, live pools and asset-specific products checked. This is not proof that private or unindexed contracts do not use the token.</p>';
    }
    // Proof wording that is the same for every integration at one proof stage (what the stage
    // means, and the caveat on metrics with no observed activity) is printed ONCE in a key under
    // the section note instead of on every card in the grid. Each integration keeps its own stage,
    // account check and observed-activity basis. Measured 2026-09-23: this repetition was what put
    // QQQx, SPYx and NVDAx (five integrations each) over the 96 kB card target.
    const proofKey = [];
    const keyed = (sentence) => {
        if (!proofKey.includes(sentence)) proofKey.push(sentence);
    };
    // The same access restriction on several integrations is written out once and referred to.
    const accessSeen = new Map();
    const accessText = (entry) => {
        const name = entry.protocolName ?? entry.protocolId ?? 'the protocol above';
        const first = accessSeen.get(entry.accessNote);
        if (first) return `as for ${escapeHtml(first)} above.`;
        accessSeen.set(entry.accessNote, name);
        return escapeHtml(humanDates(entry.accessNote));
    };
    const rows = integrations.map((entry, index) => {
        const metrics = defiMetrics(entry);
        const markets = [...new Set((Array.isArray(entry.markets) ? entry.markets : [])
            .map((market) => market?.name).filter(Boolean))];
        // An evidence URL that IS the market link (a DexScreener pool page) is printed once.
        const evidenceRows = (Array.isArray(entry.evidence) ? entry.evidence : [])
            .filter((row) => row?.url && row.url !== entry.links?.use);
        const evidence = evidenceRows
            .map((row, index) => link(row.url, `Evidence${evidenceRows.length > 1 ? ` ${index + 1}` : ''} ↗`))
            .join(' ');
        const evidenceIsMarket = evidenceRows.length === 0
            && (Array.isArray(entry.evidence) ? entry.evidence : []).some((row) => row?.url && row.url === entry.links?.use);
        const capabilityGroups = new Map();
        for (const capability of Array.isArray(entry.capabilities) ? entry.capabilities : []) {
            const mechanism = `${capability.custody ?? 'unknown'} custody · ${capability.enforcement ?? 'unknown'} enforcement`;
            if (!capabilityGroups.has(mechanism)) capabilityGroups.set(mechanism, []);
            capabilityGroups.get(mechanism).push(capability.label ?? humanizeSlug(capability.action));
        }
        const capabilities = [...capabilityGroups.entries()].map(([mechanism, labels]) =>
            `<li><strong>${escapeHtml(labels.join(', '))}</strong><span>${escapeHtml(mechanism)}</span></li>`).join('');
        const corroboration = entry.corroboration;
        const accounts = (Array.isArray(corroboration?.accounts) ? corroboration.accounts : [])
            .filter((account) => account?.address).slice(0, 2)
            .map((account) => link(`https://solscan.io/account/${account.address}`, `${humanizeSlug(account.role)} ↗`)).join(' ');
        const proof = entry.proof ?? {};
        const proofModel = protocolProofModel({ proof, integration: entry, fetchedAt: card.sources?.defiUsage ?? null });
        const accountCheck = (proof.accountCount ?? corroboration?.accountCount) > 0
            ? `${proof.existingAccountCount ?? corroboration?.verifiedCount ?? 'unknown'}/${proof.accountCount ?? corroboration?.accountCount} published accounts existed; existence only`
            : 'No published Solana account address was available to check';
        keyed(`${proofModel.headline}: ${proofModel.detail}`);
        // An observed-activity statement keeps its own basis; its closing caveat is shared.
        let activity = '';
        if (proof.activityObserved === true) {
            const sentences = proofModel.activityStatement.split(/(?<=\.)\s+(?=[A-Z])/);
            if (sentences.length > 1) keyed(sentences.pop());
            activity = ` ${sentences.join(' ')}`;
        } else {
            keyed(proofModel.activityStatement);
        }
        const proofSteps = `${accountCheck}.${activity}`;
        const status = entry.status === 'live' ? (proof.sourceStatus === 'onchain-position' ? 'on-chain observed' : 'source-reported') : entry.status ?? proofModel.stage;
        return `<article class="defi-use defi-use-${escapeHtml(entry.status ?? 'available')}">` +
            `<header><h3>${escapeHtml(entry.protocolName ?? entry.protocolId ?? 'Protocol')}</h3>` +
            `<strong>${escapeHtml(status)}</strong></header>` +
            `<p class="defi-actions">${escapeHtml(defiActions(entry.actions))}</p>` +
            `<p>${escapeHtml(humanDates(entry.summary ?? ''))}</p>` +
            `${metrics ? `<p class="defi-metrics">${escapeHtml(metrics)}</p>` : ''}` +
            `${markets.length ? `<p class="defi-metrics">Markets: ${escapeHtml(markets.join(', '))}</p>` : ''}` +
            `${capabilities ? `<ul class="defi-capabilities">${capabilities}</ul>` : ''}` +
            `<p class="defi-proof"><strong>${escapeHtml(proofModel.headline)}.</strong> ${escapeHtml(proofSteps)}${accounts ? ` · ${accounts}` : ''}</p>` +
            `${entry.accessNote ? `<p class="defi-access"><strong>Access:</strong> ${accessText(entry)}</p>` : ''}` +
            `<p class="defi-links"><a href="../protocols/${encodeURIComponent(protocolDossierSlug(card, entry, index))}.html">Open RWA Sonar dossier →</a>${entry.links?.use ? link(entry.links.use, `Open market / product${evidenceIsMarket ? ' (evidence)' : ''} ↗`) : ''}${evidence}</p>` +
            '</article>';
    }).join('');
    return '<p class="note">Each exact-token integration states whether it is source-listed, market-observed, decoded or simulated. Structural compatibility is assessed separately below.</p>' +
        `<ul class="note defi-proof-key">${proofKey.map((sentence) => `<li>${escapeHtml(sentence)}</li>`).join('')}</ul>` +
        `<div class="defi-use-grid">${rows}</div>`;
}

function composabilityBody(card) {
    const template = card.composability;
    if (template === null) {
        return '<p class="no">This issuer and control-recipe combination has not yet had a DeFi composability review.</p>';
    }
    const scenarios = COMPOSABILITY_SCENARIOS.map((scenario) => {
        const result = template.scenarios?.[scenario.id] ?? null;
        if (result === null) return '';
        return `<article class="comp-scenario"><header><span>${escapeHtml(scenario.label)}</span>`
            + `<strong>${escapeHtml(result.outcome ?? 'unknown')}</strong></header>`
            + `<p class="comp-question">${escapeHtml(scenario.question)}</p>`
            + `<h3>${escapeHtml(result.headline ?? '')}</h3><p>${escapeHtml(result.explanation ?? '')}</p></article>`;
    }).join('');
    const integrations = Array.isArray(card.defiUsage?.integrations) ? card.defiUsage.integrations : [];
    const exit = lenderExitQuality(template, integrations, card.ownership.redemption);
    const collateral = [...new Set(integrations
        .filter((entry) => entry?.category === 'lending' && entry.actions?.includes('collateral'))
        .map((entry) => entry.protocolName ?? entry.protocolId).filter(Boolean))];
    const dex = [...new Set(integrations.filter((entry) => entry?.category === 'dex')
        .map((entry) => entry.protocolName ?? entry.protocolId).filter(Boolean))];
    const lending = collateral.length
        ? `Source-listed for this exact token: ${collateral.join(', ')}. No successful borrow is independently evidenced.`
        : 'No checked protocol currently lists this exact token as programmatic collateral.';
    const cashExit = card.ownership.redemption.available === true && card.ownership.redemption.kyc === true
        ? 'Conditional: issuer redemption requires KYC/AML, so a smart contract cannot redeem on its own.'
        : card.ownership.redemption.available === true
            ? 'Recorded: eligible holders have an issuer redemption route, subject to its contractual terms.'
            : card.ownership.redemption.available === false
                ? 'No holder redemption right is recorded; liquidation depends on finding a buyer.'
                : 'Unknown: the evidence does not establish an issuer redemption route.';
    const marketExit = dex.length
        ? `Observed exact-token pools: ${dex.join(', ')}. Pool presence does not guarantee executable liquidation size.`
        : 'No exact-token DEX pool is confirmed; an autonomous market exit is not established.';
    return `<div class="exit-verdict exit-verdict-${escapeHtml(exit.rating)}"><strong>${escapeHtml(exit.label)}</strong><p>${escapeHtml(exit.reason)}</p></div>`
        + `<p class="comp-summary">${escapeHtml(template.summary)}</p>`
        + '<div class="lender-bottom"><article><strong>Technical custody</strong>'
        + `<p>${escapeHtml(exit.custody.meaning)}</p></article><article><strong>Economic control after default</strong>`
        + `<p>${escapeHtml(exit.economicControl.meaning)}</p></article><article><strong>Programmatic collateral listing</strong>`
        + `<p>${escapeHtml(lending)}</p></article><article><strong>Can seizure become cash?</strong>`
        + `<p>${escapeHtml(cashExit)}</p></article><article><strong>Autonomous market exit</strong>`
        + `<p>${escapeHtml(marketExit)}</p></article></div>`
        + `<p class="note">Template: ${escapeHtml(template.legalTemplate)} · ${escapeHtml(template.recipe)}. `
        + '“Can recover” means the issuer is able to act, with no duty to act.</p>'
        + `<p class="tc-out"><a href="../templates/${encodeURIComponent(template.id)}.html">Open the complete technology + legal template →</a></p>`
        + `<div class="comp-grid">${scenarios}</div>`;
}

function healthDimensionsHtml(card) {
    return `<div class="health-dimensions" aria-label="Health by dimension">${HEALTH_DIMENSIONS.map((dimension) => {
        const result = card.health.dimensions?.[dimension.id] ?? { status: 'unknown', worstRuleId: null };
        const rules = card.health.rules.filter((rule) => rule.dimension === dimension.id);
        const total = Number.isInteger(result.total) ? result.total : rules.length;
        const unknown = Number.isInteger(result.unknown) ? result.unknown : rules.filter((rule) => rule.status === 'unknown').length;
        const judged = Number.isInteger(result.judged) ? result.judged : total - unknown;
        const worst = card.health.rules.find((rule) => rule.id === result.worstRuleId) ?? null;
        const detail = worst === null ? 'not measured' : worst.label;
        return `<div class="health-dimension health-dimension-${escapeHtml(result.status)}">`
            + `<span>${escapeHtml(dimension.label)}</span>${chip(result.status)}`
            + `<small>${escapeHtml(detail)} · ${judged}/${total} checks judged; ${unknown} unknown</small></div>`;
    }).join('')}</div>`;
}

const RISK_RANK = { critical: 4, warning: 3, caution: 2, info: 1 };

/** An ISO instant inside generated prose ("stale at 2026-09-24T18:51:51Z") as a reader's date. */
function humanDates(value) {
    return String(value).replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z\b/g, (iso) => fmtDateTime(iso));
}

/** The holder-affecting powers the risk line looks for, most intrusive first, and where each key sits. */
const HOLDER_POWERS = [
    { ids: ['permanentDelegate', 'clawback'], words: 'move or burn any holder’s tokens', address: (control) => control?.permanentDelegate },
    { ids: ['freeze'], words: 'freeze any holder’s account', address: (control) => control?.freezeAuthority }
];

/**
 * How directly one installed power can be used: one private key, any one signer of a multisig, or
 * a multisig whose reviewed notes record NO execution delay (so holders get no warning). A multisig
 * whose delay is not recorded is not counted: an unknown delay is not the same as none.
 */
function powerExposure(row) {
    if (row?.technicalCapability !== 'present') return null;
    const type = row.governance?.type;
    if (type === 'hot-key') return { kind: 'key', rank: 2, threshold: null };
    if (type === 'single-signer-multisig') return { kind: 'one-signer', rank: 2, threshold: null };
    if (type === 'multisig' && timelockFrom(row.governance?.technicalNotes)?.seconds === 0) {
        return { kind: 'no-timelock', rank: 1, threshold: /^(\d+)\s*of\s*(\d+)/i.exec(row.governance?.signerThreshold ?? '') };
    }
    return null;
}

function exposureSentence(exposure, what, first) {
    if (exposure.kind === 'key') {
        return first ? `One private key can ${what}, with no second signature needed.` : `Another single private key can ${what}.`;
    }
    if (exposure.kind === 'one-signer') {
        return first ? `Any one signer of a multisig can ${what}, with no second signature needed.` : `Any one signer of another multisig can ${what}.`;
    }
    const who = exposure.threshold ? `${exposure.threshold[1]} of ${exposure.threshold[2]} signers of ${first ? 'one' : 'another'} multisig`
        : `${first ? 'A' : 'Another'} multisig`;
    return first ? `${who} can ${what} at once: there is no time lock, so holders get no warning.` : `${who} can ${what}, with no time lock.`;
}

/**
 * "One private key can move or burn any holder’s tokens …": the powers over holders' tokens that one
 * key, one signer, or a multisig with no time lock can use. Powers held at the SAME address with the
 * same exposure are named together; a second holder gets a second, shorter sentence.
 */
function powerRisk(card) {
    const authorities = Array.isArray(card?.authorityAttribution?.authorities) ? card.authorityAttribution.authorities : [];
    const found = [];
    for (const power of HOLDER_POWERS) {
        const best = power.ids.map((id) => powerExposure(authorities.find((row) => row.id === id)))
            .filter(Boolean).sort((a, b) => b.rank - a.rank)[0];
        if (!best) continue;
        const address = power.address(card?.control);
        found.push({ power, exposure: best, address: typeof address === 'string' ? address : null });
    }
    if (found.length === 0) return null;
    const groups = [];
    for (const entry of found.slice().sort((a, b) => b.exposure.rank - a.exposure.rank)) {
        const same = groups.find((group) => group.exposure.kind === entry.exposure.kind && entry.address !== null
            && group.address === entry.address && (group.exposure.threshold?.[0] ?? null) === (entry.exposure.threshold?.[0] ?? null));
        if (same) same.words.push(entry.power.words);
        else groups.push({ exposure: entry.exposure, address: entry.address, words: [entry.power.words] });
    }
    return groups.slice(0, 2).map((group, index) => exposureSentence(group.exposure, group.words.join(' and '), index === 0)).join(' ');
}

/** A lending market's stale, suspended or 24/7 collateral price, worst finding first. */
function closedMarketRisk(card) {
    const findings = Array.isArray(card?.closedMarket?.findings) ? card.closedMarket.findings : [];
    const finding = ['critical', 'warning', 'caution'].map((severity) => findings.find((row) => row?.severity === severity
        && typeof row.statement === 'string' && row.statement !== '')).find(Boolean);
    return finding ? `If you borrow against it: ${humanDates(finding.statement)}` : null;
}

function redemptionRisk(card) {
    const redemption = card?.ownership?.redemption ?? {};
    if (redemption.available === false) return 'The issuer offers holders no redemption: the only way out is selling to another buyer.';
    if (redemption.available === true && redemption.kyc === true) {
        return 'Only holders who pass the issuer’s KYC checks can redeem; anyone else can only sell to another buyer.';
    }
    return null;
}

/** Which failing check a holder should hear about first when nothing above it applies. */
const RISK_RULE_ORDER = ['paused', 'frozen', 'liquidity', 'tracking', 'concentration', 'spread', 'organic', 'failedTx',
    'keyControl', 'verification', 'defiComposability'];

const KEY_ROLE_WORDS = { mint: 'mint', freeze: 'freeze', pause: 'pause', delegate: 'move-or-burn', transferFee: 'transfer-fee', rebase: 'rebase' };

function aboutPct(value) {
    return value < 1 ? 'under 1 %' : `about ${Math.round(value)} %`;
}

function joinAnd(words) {
    return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/**
 * A failing health check in a holder's words. Organic share is the part of 24 h VOLUME that
 * Jupiter classes as non-bot flow (stocks/MODEL.md §11.1), not a share of traders, and is said so.
 * A rule with no wording here keeps its own note.
 */
function ruleInWords(rule) {
    const inputs = rule.inputs ?? {};
    const value = rule.value;
    if (rule.id === 'organic') {
        const organicLow = isNum(inputs.organicSharePct) && inputs.organicSharePct < 10;
        const perTraderHigh = isNum(inputs.tradesPerTrader) && inputs.tradesPerTrader > 25;
        const perTrader = perTraderHigh ? `${fmtNumber(Math.round(inputs.tradesPerTrader))} trades per trading wallet over the last day` : null;
        if (organicLow) {
            return `Most trading looks automated: Jupiter counts only ${aboutPct(inputs.organicSharePct)} of the last day’s volume as organic (non-bot) trading.`
                + (perTrader ? ` A few wallets make most trades (${perTrader}).` : '');
        }
        if (perTrader) return `A few wallets make most of the trades: ${perTrader}.`;
    }
    if (rule.id === 'liquidity' && isNum(value)) {
        return `Thin market: only ${fmtMoney(value)} of reported DEX liquidity, so a large sale could move the price a long way.`;
    }
    if (rule.id === 'tracking' && isNum(value) && isNum(inputs.usdPrice) && isNum(inputs.referencePrice)) {
        return `The token trades ${fmtPct(value, 1)} ${inputs.usdPrice >= inputs.referencePrice ? 'above' : 'below'} the price of the share it tracks.`;
    }
    if (rule.id === 'concentration' && isNum(value)) return `One unidentified wallet holds ${aboutPct(value)} of the supply.`;
    if (rule.id === 'spread' && isNum(value)) return `Trading venues price it up to ${fmtPct(value, 1)} apart.`;
    if (rule.id === 'failedTx' && isNum(value)) return `${aboutPct(value).replace(/^a/, 'A')} of the sampled swaps in its pools failed.`;
    if (rule.id === 'paused') return 'Transfers are paused right now.';
    if (rule.id === 'frozen' && isNum(value)) return `${fmtNumber(value)} of the 20 largest holder accounts ${value === 1 ? 'is' : 'are'} frozen.`;
    if (rule.id === 'keyControl') {
        const single = Object.entries(inputs).filter(([, type]) => type === 'hot-key' || type === 'single-signer-multisig')
            .map(([role]) => KEY_ROLE_WORDS[role] ?? labelize(role));
        if (single.length) return `A single private key holds the ${joinAnd(single)} power${single.length === 1 ? '' : 's'}.`;
    }
    if (rule.id === 'verification') {
        if (value === 0) return 'No one independently verifies that reserves back the token.';
        const gaps = [];
        const plural = (n, one, many) => `${fmtNumber(n)} ${n === 1 ? one : many}`;
        if (isNum(inputs.missingRequired) && inputs.missingRequired > 0) gaps.push(plural(inputs.missingRequired, 'required legal fact has no source', 'required legal facts have no source'));
        if (isNum(inputs.unverifiedClaims) && inputs.unverifiedClaims > 0) gaps.push(plural(inputs.unverifiedClaims, 'claim awaits re-checking', 'claims await re-checking'));
        if (isNum(inputs.inferenceUnreviewed) && inputs.inferenceUnreviewed > 0) gaps.push(plural(inputs.inferenceUnreviewed, 'inferred conclusion awaits review', 'inferred conclusions await review'));
        if (isNum(value) && value < 3) gaps.push(`reserve verification is weak (${value} of 5)`);
        if (gaps.length) return `The legal evidence has gaps: ${joinAnd(gaps)}.`;
    }
    return rule.note;
}

function healthRisk(card) {
    const rules = Array.isArray(card?.health?.rules) ? card.health.rules : [];
    for (const status of ['warning', 'caution']) {
        const rule = RISK_RULE_ORDER.map((id) => rules.find((row) => row.id === id && row.status === status)).find(Boolean);
        if (rule) {
            const words = ruleInWords(rule);
            if (typeof words === 'string' && words !== '') return words;
        }
    }
    return null;
}

/**
 * "Largest unresolved risk", one sentence a buyer can act on, first match wins: a source-backed
 * claim-vs-reality conflict; a priority-zero evidence review; a power over holders' tokens that one
 * key (or a multisig with no time lock) can use; a lending market's stale or 24/7 collateral price;
 * a redemption this holder cannot use; and only then the worst failing health check, in words.
 */
export function largestRisk(card) {
    const discrepancy = (Array.isArray(card?.discrepancies) ? card.discrepancies : []).slice()
        .sort((a, b) => (RISK_RANK[b?.severity] ?? 0) - (RISK_RANK[a?.severity] ?? 0))[0] ?? null;
    if (discrepancy !== null && typeof discrepancy.title === 'string' && discrepancy.title !== '') {
        return { value: discrepancy.title, href: '#discrepancies', link: 'Inspect claim vs reality' };
    }
    const review = Array.isArray(card?.underReview) ? card.underReview.length : 0;
    if (review > 0) {
        return {
            value: `${review} priority-zero evidence change${review === 1 ? '' : 's'} may affect the inherited legal analysis.`,
            href: `../review.html?priority=P0&issuer=${encodeURIComponent(card.issuer?.slug ?? '')}`,
            link: 'Open review queue'
        };
    }
    const power = powerRisk(card);
    if (power !== null) return { value: power, href: '#control', link: 'Inspect issuer powers' };
    const lending = closedMarketRisk(card);
    if (lending !== null) return { value: lending, href: '#closed-market', link: 'Inspect lending while the market is closed' };
    const redemption = redemptionRisk(card);
    if (redemption !== null) return { value: redemption, href: '#own', link: 'Inspect redemption terms' };
    const health = healthRisk(card);
    if (health !== null) return { value: health, href: '#rules', link: 'Inspect the health checks' };
    return { value: 'The current checks measured no material risk; what they could not measure is unknown.', href: '#rules', link: 'Inspect the health checks' };
}

/** The five facts a holder should be able to read before opening any technical detail. */
export function assetDecisionFacts(card) {
    const verdict = discovery.laypersonVerdict({
        claimRung: card?.ownership?.claimRung,
        redemptionAvailable: card?.ownership?.redemption?.available,
        control: card?.control ?? {}
    });
    const integrations = Array.isArray(card?.defiUsage?.integrations) ? card.defiUsage.integrations : [];
    const protocols = [...new Set(integrations.map((entry) => entry.protocolName ?? entry.protocolId).filter(Boolean))];
    const actions = [...new Set(integrations.flatMap((entry) => Array.isArray(entry.actions) ? entry.actions : []))];
    const proofModels = integrations.map((entry) => protocolProofModel({
        proof: entry?.proof ?? {}, integration: entry, fetchedAt: card?.sources?.defiUsage ?? null
    }));
    const proofStages = new Set(proofModels.map((model) => model.stage));
    const proofScope = proofStages.has('simulated') ? 'includes a read-only simulation'
        : proofStages.has('decoded') ? 'includes configuration decoding'
            : proofStages.has('observed-market') ? 'includes an observed exact-token market'
                : proofStages.has('account-observed') ? 'includes an on-chain protocol account holding the token'
                : proofStages.has('source-listed') ? 'is source-listed'
                    : 'has no established proof stage';
    const proofAsOf = proofModels.map((model) => model.asOf).filter(Boolean).sort().at(-1) ?? null;
    const proofDate = proofAsOf ? ` Evidence checked ${fmtDateTime(proofAsOf)}.` : ' Evidence-check time is not recorded.';
    const defi = protocols.length
        ? `Exact-token support: ${protocols.slice(0, 3).join(', ')}${protocols.length > 3 ? ` and ${protocols.length - 3} more` : ''}${actions.length ? ` · source-described ${defiActions(actions).toLowerCase()}` : ''}. Proof ${proofScope}.${proofDate} Execution is not independently evidenced.`
        : 'No exact-token protocol support is source-listed in the checked sources.';
    const dexPairs = Number.isFinite(card?.depth?.dexPairs) ? card.depth.dexPairs : null;
    const cexMarkets = Number.isFinite(card?.depth?.cexMarkets) ? card.depth.cexMarkets : null;
    const liquidity = Number.isFinite(card?.depth?.liquidityUsd) ? card.depth.liquidityUsd : null;
    const venueCheck = card?.sources?.venues ? ` DEX pools checked ${fmtDateTime(card.sources.venues)}.` : '';
    const exchangeAsOf = card?.venues?.cexAsOf ? ` Exchange data as of ${fmtDateTime(card.venues.cexAsOf)}.` : '';
    const marketExit = (dexPairs ?? 0) > 0 || (liquidity ?? 0) > 0
        ? `Secondary market: ${dexPairs ?? 'an uncounted number of'} confirmed DEX pair${dexPairs === 1 ? '' : 's'}${liquidity === null ? '' : ` with ${fmtMoney(liquidity)} reported liquidity`}. Pool presence does not guarantee executable size.`
        : (cexMarkets ?? 0) > 0
            ? `No exact-token DEX exit is confirmed, but ${cexMarkets} centralised venue market${cexMarkets === 1 ? ' is' : 's are'} observed. Selling there goes through a custodial venue, with no on-chain pool.${venueCheck}${exchangeAsOf}`
            : `No confirmed secondary-market exit: no exact-token DEX pair or centralised venue market was found.${venueCheck}${exchangeAsOf} Legal rights, issuer redemption and DeFi support are still assessed independently.`;
    const risk = largestRisk(card);
    return [
        { id: 'ownership', label: 'What do you own?', value: verdict.headline,
            href: '#own', link: 'Inspect ownership and redemption' },
        { id: 'control', label: 'Who can intervene?', value: verdict.controlNote,
            href: '#control', link: 'Inspect issuer powers' },
        { id: 'exit', label: 'How can you exit?', value: `${verdict.redemption} ${marketExit}`,
            href: '#own', link: 'Inspect this token’s redemption terms' },
        { id: 'defi', label: 'What works in DeFi now?', value: defi,
            href: '#defi-usage', link: 'Inspect source-listed protocols' },
        { id: 'risk', label: 'Largest unresolved risk', value: risk.value.charAt(0).toUpperCase() + risk.value.slice(1),
            href: risk.href, link: risk.link }
    ];
}

function assetDecisionHtml(card) {
    const rows = assetDecisionFacts(card);
    return '<section class="asset-decision" aria-label="Holder decision summary">'
        + '<p class="asset-decision-kicker">The five things to know first</p>'
        + `<div class="asset-decision-grid">${rows.map((row) => `<article class="asset-decision-${escapeHtml(row.id)}">`
            + `<small>${escapeHtml(row.label)}</small><strong>${escapeHtml(row.value)}</strong>`
            + `<a href="${escapeHtml(row.href)}">${escapeHtml(row.link)} →</a></article>`).join('')}</div>`
        + `<div class="asset-rights"><small>Shareholder rights you get</small>`
        + `${holderRightsLib.holderRightsStripHtml(holderRightsLib.holderRightsRows(card?.ownership?.holderRights), { href: '#holder-rights', legend: true })}</div>`
        + '</section>';
}

/**
 * "$336.43 on Jupiter · -0.27% vs AAPL · $652.0k DEX liquidity (Jupiter, all pools)": the three
 * numbers a buyer looks for first, each saying where it comes from. The liquidity is Jupiter's
 * aggregate over every DEX pool; the pool table below and the exits page read DexScreener, which
 * lists fewer pools and so a different total, and each is labelled with its source.
 */
export function priceLineHtml(card) {
    const r = card.reference ?? {};
    const parts = [];
    if (isNum(r.usdPrice)) parts.push(`<b>${escapeHtml(fmtPrice(r.usdPrice))}</b> on Jupiter`);
    if (isNum(r.premiumPct)) {
        const against = card.underlyingTicker ?? referenceLabel(r.source) ?? 'the reference price';
        parts.push(`<a href="#reference">${escapeHtml(fmtSignedPct(r.premiumPct))} vs ${escapeHtml(against)}</a>`);
    }
    if (isNum(card.depth?.liquidityUsd)) {
        parts.push(`<a href="#depth">${escapeHtml(fmtMoney(card.depth.liquidityUsd))} DEX liquidity</a> (Jupiter, all pools)`);
    }
    return parts.length ? `<p class="price-line">${parts.join(' · ')}</p>` : '';
}

/** An absolute UTC timestamp; card.js appends the relative age to every <time> it finds. */
function time(iso) {
    if (typeof iso !== 'string' || !iso.trim()) return DASH;
    return `<time datetime="${escapeHtml(iso)}">${escapeHtml(fmtDateTime(iso))}</time>`;
}

/**
 * The change judge's material verdicts for this token, or '' when there are none. Always headed and
 * captioned as a model assessment, and it links to the change feed, where each reading sits beside
 * the diff it was made from.
 */
export function materialChangesHtml(card) {
    const block = card.materialChanges;
    if (block === null || block === undefined || block.items.length === 0) return '';
    const href = `../watch.html?type=issuer&amp;issuerSlug=${encodeURIComponent(card.issuer?.slug ?? '')}&amp;material=true`;
    const items = block.items.map((item) => `<li><span>${escapeHtml(fmtDate(item.detectedAt))}`
        + `${item.assessmentSeverity ? ` · ${escapeHtml(item.assessmentSeverity)}` : ''} · ${escapeHtml(item.change ?? '')}</span>`
        + `<q>${escapeHtml(item.assessment ?? '')}</q></li>`).join('');
    return `<div class="model-changes"><strong>${escapeHtml(MATERIAL_CHANGE_TITLE)}</strong><ul>${items}</ul>`
        + `<p>A model's reading of each document diff. It is not a legal conclusion. <a href="${href}">`
        + `${block.count} in the last ${block.windowDays} days, with the diffs →</a></p></div>`;
}

/** The footer's per-input timestamps, named for a reader rather than by their record keys. */
const SOURCE_WORDS = {
    tokens: 'catalogue', issuers: 'issuer dossiers', issuerApi: 'issuer APIs', referencePrices: 'reference prices',
    holders: 'holders', venues: 'DEX pools', trades: 'trades', closedMarket: 'closed-market data',
    meteora: 'Meteora pools', defiUsage: 'DeFi usage', pythOnchain: 'Pyth on Solana'
};

function footerBody(card) {
    const sources = Object.entries(card.sources)
        .filter(([, value]) => value !== null)
        .map(([key, value]) => `${escapeHtml(SOURCE_WORDS[key] ?? labelize(key))} ${time(value)}`)
        .join(' · ');
    const evidence = evidenceLine(card.evidence);
    return `<footer><h2>Data</h2>` +
        `${evidence ? `<p class="ev-line">${escapeHtml(evidence)}</p>` : ''}` +
        `<p class="src">${sources}</p>` +
        `<p class="mint">Mint <code id="mint">${escapeHtml(card.mint ?? '')}</code> ` +
        `<button type="button" id="copy-mint" data-mint="${escapeHtml(card.mint ?? '')}">Copy</button> · ` +
        `<a href="../watch.html?type=token&amp;mint=${encodeURIComponent(card.mint ?? '')}">Watch this exact token</a></p>` +
        `<p class="built">Card built ${time(card.builtAt)}.</p>${contactFooterHtml('../', { inner: true })}</footer>`;
}

/** The site-wide 1200×630 link-preview image (rendered from design/og/og.html). */
export const OG_IMAGE_PATH = 'images/og-rwasonar.png?v=20260923';
export const OG_IMAGE_ALT = 'RWA Sonar: tokenized stocks on Solana, compared by what you actually own';

/**
 * The whole card page. `baseUrl` is REQUIRED for og:url and the canonical link — a builder has no
 * request to derive an origin from, so without it those two tags are simply absent rather than
 * guessed (a wrong absolute URL in a shared card is a dead link nobody sees fail).
 *
 * @param {object} card buildCard's output
 * @param {object} options
 * @param {string|null} options.baseUrl e.g. https://rwasonar.com
 * @param {string} options.version the ?v= cache-busting stamp for ../card.css, ../trustchain.css and ../card.js
 * @param {{path: string, alt: string}|null} options.ogImage this token's own 1200×630 preview
 *     (repo-relative, e.g. cards/og/NVDAx.<hash>.png, from stocks/lib/og-image.mjs); null keeps the site image
 */
export function renderCard(card, { baseUrl = null, version = '', ogImage = null } = {}) {
    const origin = typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim().replace(/\/+$/, '') : null;
    const pageUrl = origin === null ? null : `${origin}/cards/${card.slug}.html`;
    const description = ogDescription(card);
    const status = card.health.status;
    const worst = card.health.rules.find((rule) => rule.id === card.health.worstRuleId) ?? null;
    const v = version ? `?v=${encodeURIComponent(version)}` : '';
    const ownImage = typeof ogImage?.path === 'string' && ogImage.path !== '';
    const imageUrl = `${origin}/${ownImage ? ogImage.path.split('/').map(encodeURIComponent).join('/') : OG_IMAGE_PATH}`;
    const imageAlt = ownImage && typeof ogImage.alt === 'string' && ogImage.alt.trim() ? ogImage.alt : OG_IMAGE_ALT;

    // The newest of the card's own source timestamps: when its data last changed, not the build clock.
    const dataModified = Object.values(card.sources ?? {}).filter((value) => typeof value === 'string').sort().at(-1) ?? null;
    const head = [
        '<meta charset="UTF-8" />',
        '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
        // Sets <html data-theme> before the stylesheets below, so the chosen theme paints first.
        siteNav.themeScriptHtml('../'),
        // The preview image is absolute, so like og:url it exists only with a stated origin. The
        // token's own image when one was rendered, else the site-wide one; both are 1200×630.
        seoHeadTags({
            title: pageTitle(card),
            description,
            socialTitle: ogTitle(card),
            url: pageUrl,
            type: 'article',
            image: origin === null ? null : { url: imageUrl, alt: imageAlt, width: 1200, height: 630 },
            jsonLd: pageUrl === null ? null : ldGraph([
                organizationLd(origin),
                reportLd({ origin, url: pageUrl, headline: ogTitle(card), description, dateModified: dataModified, image: imageUrl,
                    about: { '@type': 'Thing', name: card.name ?? card.symbol ?? card.mint, identifier: card.mint } }),
                breadcrumbLd([{ name: 'RWA Sonar', url: `${origin}/` }, { name: 'Tokenized stocks', url: `${origin}/stocks.html` },
                    { name: card.symbol ?? card.mint, url: pageUrl }])
            ])
        }),
        '<link rel="icon" type="image/svg+xml" href="../images/variant3.svg" />',
        `<link rel="alternate" type="application/json" href="./${escapeHtml(card.slug)}.json" />`,
        `<link rel="stylesheet" href="../card.css${v}" />`,
        `<link rel="stylesheet" href="../trustchain.css${v}" />`,
        `<link rel="stylesheet" href="../app-shell.css${v}" />`,
        contactStylesheet('../')
    // Whitespace between head elements is not user-facing content. Keep the rendered document
    // compact rather than spending the card budget on indentation repeated in every card.
    ].filter((line) => line !== null).join('');

    const header = `<header class="card-head"><h1>${escapeHtml(card.symbol ?? card.mint ?? 'token')}</h1>` +
        `<p class="sub">${escapeHtml(card.name ?? '')}${card.underlyingTicker ? ` · tracks ${escapeHtml(card.underlyingTicker)}` : ''}` +
        `${card.instrumentType ? ` · ${escapeHtml(humanizeSlug(card.instrumentType))}` : ''}</p>` +
        priceLineHtml(card) +
        assetDecisionHtml(card) +
        `${card.discrepancies.length ? `<a class="discrepancy-banner" href="#discrepancies"><strong>Claim ≠ observed reality</strong><span>${card.discrepancies.length} source-backed discrepanc${card.discrepancies.length === 1 ? 'y' : 'ies'}.</span><b>Review ↓</b></a>` : ''}` +
        `${card.underReview.length ? `<div class="under-review-banner"><strong>Legal conclusions under review</strong><span>${card.underReview.length} priority-zero evidence change${card.underReview.length === 1 ? '' : 's'} may affect this token’s inherited analysis.</span><a href="../review.html?priority=P0&issuer=${encodeURIComponent(card.issuer.slug)}">See review queue →</a></div>` : ''}` +
        materialChangesHtml(card) +
        `<details class="decision-health"><summary>Why the health checks say ${escapeHtml(status)}</summary>` +
        healthDimensionsHtml(card) + `<p class="banner banner-${escapeHtml(status)}">${chip(status)} ` +
        `${escapeHtml(worst === null ? 'no check could be measured for this token' : worst.note ?? '')}</p></details>` +
        '</header>';

    const siteHeader = siteNav.siteHeaderHtml('../');

    const localNav = `<nav class="card-local-nav" aria-label="On this token"><a href="#own">Rights</a>` +
        `<a href="#control">Control</a><a href="#defi-usage">DeFi</a><a href="#market-detail">Markets</a>` +
        `<a href="#evidence-detail">Evidence</a></nav>`;

    const markets = `<details id="market-detail" class="card-disclosure"><summary><span>Markets, premium & holders</span></summary><div>` +
        section('reference', 'Reference & premium', referenceBody(card)) +
        `<section id="history" class="card-section history-panel" data-mint="${escapeHtml(card.mint)}"><header><h2>History</h2><label>Metric <select class="history-metric"></select></label></header><p class="history-method">Daily observations from RWA Sonar’s snapshots. A gap is a missing measurement, not a zero. Vertical markers are recorded evidence or control changes.</p><div class="history-chart" role="status">Loading daily history…</div></section>` +
        section('closed-market', 'When the market is closed', closedMarketBody(card)) +
        section('pyth', 'Pyth on this token', pythBody(card)) +
        section('depth', 'Depth, volume, activity', depthBody(card)) +
        section('holders', 'Holder concentration', holdersBody(card)) + `</div></details>`;

    const evidenceAndTechnical = `<details id="evidence-detail" class="card-disclosure"><summary><span>Evidence, scenarios & technical detail</span></summary><div>` +
        section('verification', 'Verification', verificationBody(card)) +
        section('venues', 'Venues', venuesBody(card)) +
        (card.issuerApi === null ? '' : section('issuer-api', 'Issuer API', issuerApiBody(card))) +
        section('trust-chain', 'Trust chain', trustChainBody(card)) +
        section('what-if', 'What if…', whatIfBody(card)) +
        section('rules', 'Health rules', rulesBody(card)) + `</div></details>`;

    const body = [
        header,
        localNav,
        card.discrepancies.length ? section('discrepancies', 'Claim vs observed reality', discrepanciesBody(card)) : '',
        section('own', 'What you own', whatYouOwnBody(card) + '<nav class="concept-links" aria-label="Learn about holder rights"><a href="../learn/beneficial-ownership.html">Beneficial ownership</a><a href="../learn/bankruptcy-remoteness.html">Bankruptcy remoteness</a><a href="../learn/redemption.html">Redemption rights</a></nav>'),
        markets,
        `<details class="card-disclosure"><summary><span>Control surface &amp; key governance</span><small>Freeze, pause, forced transfer and authority keys</small></summary><div>${section('control', 'Observed issuer powers', controlBody(card))}<nav class="concept-links"><a href="../learn/issuer-control.html">What issuer intervention means →</a></nav></div></details>`,
        `<details class="card-disclosure"><summary><span>Exact-token protocol support</span><small>Source listings, observed markets and proof limits</small></summary><div>${section('defi-usage', 'Evidence available now', defiUsageBody(card))}<nav class="concept-links"><a href="../learn/defi-custody.html">Why custody may not mean enforceable collateral →</a></nav></div></details>`,
        `<details class="card-disclosure"><summary><span>What could work in DeFi?</span></summary><div>${section('composability', 'DeFi composability', composabilityBody(card))}</div></details>`,
        evidenceAndTechnical,
        footerBody(card)
    ].join('');

    return `<!doctype html><html lang="en"><head>${head}</head><body class="card-page">${siteHeader}<main class="card">${body}</main><script src="../stocks/lib/api-base.js${v}"></script><script src="../stocks/lib/history-charts.js${v}"></script><script src="../card.js${v}"></script><script src="../nav-menus.js${v}"></script></body></html>`;
}
