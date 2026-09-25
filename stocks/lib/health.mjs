// PURE health-status rules for the tokenized-stocks section (no fs, no network, no clock, no DOM):
// the single source of truth for the eleven per-token checks — price tracking, pool liquidity, organic
// flow, failed swaps, holder concentration, legal-evidence review, authority-key governance, trading
// pause, frozen accounts and cross-venue spread — plus the roll-ups that the stock cards and the
// health monitor display: the conservative worst-of-everything `status`, and the two LEVELS the
// headline uses (a programme verdict shared by every token of an issuer, and a verdict for this one
// token with a count of the checks it passes). A check whose inputs are missing is reported as
// `unknown` and is NEVER counted as bad, so "we did not measure this" can never read as "this is
// fine" or as a fault. Unit-tested in ../health.test.js.

import { toFiniteNumber } from './grade.mjs';
import sharedFmt from './fmt.js';
import { dedupeOwners, stringOrNull, sumOrNull } from './holders.mjs';
import { composabilityHealthRule } from './composability.mjs';
import { resolveProgramGovernance } from './authority-attribution.mjs';

/** The only statuses a rule or a token may carry. `unknown` is a first-class answer, not a failure. */
export const STATUSES = ['good', 'caution', 'warning', 'unknown'];

/** The four independent questions hidden by a single worst-of status. */
export const HEALTH_DIMENSIONS = [
    { id: 'market', label: 'Market', description: 'Price quality, liquidity, activity, distribution and execution.' },
    { id: 'control', label: 'Control', description: 'Who can change, pause or freeze the token and its accounts.' },
    { id: 'legal', label: 'Legal / evidence', description: 'Coverage and review state of the holder-rights and backing evidence, including reserve verification.' },
    { id: 'composability', label: 'DeFi composability', description: 'Whether a protocol can custody the token and enforce a default without discretionary issuer help.' }
];

/**
 * Who a check describes. Measured on 1,412 tokens (2026-09-25): the three programme rules gave the
 * SAME verdict to every token of each of the nine issuers, and no issuer reached `good` on legal
 * evidence or DeFi enforceability — so a worst-of badge over all eleven rules read "caution" or
 * "warning" for every token and said nothing about the token itself (0 of 1,412 good). The headline
 * therefore shows the two levels side by side, and the eleven rules and their thresholds stay
 * exactly as visible as before.
 */
export const HEALTH_LEVELS = [
    {
        id: 'programme',
        label: 'Programme',
        description: 'The issuer’s legal evidence and reserve verification, how its authority keys are held, and whether its technology and legal template let a DeFi lender enforce collateral — the same answer for every token of the programme.'
    },
    {
        id: 'token',
        label: 'This token',
        description: 'This one mint: price tracking, liquidity, organic flow, failed swaps, holder concentration, venue spread, trading pause and frozen accounts.'
    }
];

/**
 * The checks that need a working market: without a price, a pool or a trade none of them can run.
 * A token is only called `good` at the token level when at least one of them was judged — "not
 * paused, not frozen, not concentrated" on a token nobody trades is not a clean bill of health, and
 * 954 of the 1,412 tokens measured on 2026-09-25 had no market to judge at all.
 */
export const TRADING_RULE_IDS = ['tracking', 'liquidity', 'organic', 'failedTx', 'spread'];

/** How bad each judged status is. `unknown` is deliberately absent — it has no severity. */
const SEVERITY = { good: 1, caution: 2, warning: 3 };

/**
 * The eleven rules, in the fixed display order. `thresholds` are human-readable strings, and a band a
 * rule can never produce is `null` (keyControl and frozen never warn; paused never cautions) so a
 * card cannot advertise a verdict the rule is incapable of reaching. `level` is who the rule
 * describes (HEALTH_LEVELS); `dimension` is what it is about (HEALTH_DIMENSIONS).
 */
export const HEALTH_RULES = [
    {
        id: 'tracking',
        level: 'token',
        dimension: 'market',
        label: 'Price tracking',
        description: 'How far the on-chain price sits from a reference price for the same underlying share.',
        thresholds: { good: '≤ 1 %', caution: '≤ 3 %', warning: '> 3 %' }
    },
    {
        id: 'liquidity',
        level: 'token',
        dimension: 'market',
        label: 'Pool liquidity',
        description: 'Dollar liquidity the venues report behind the token, i.e. how much can be traded at all.',
        thresholds: { good: '≥ $100,000', caution: '≥ $10,000', warning: '< $10,000' }
    },
    {
        id: 'organic',
        level: 'token',
        dimension: 'market',
        label: 'Organic flow',
        description: 'Whether 24 h trading comes from many traders or from a few bots. Bot-classified volume spread across many wallets is ordinary arbitrage; a few wallets making most of the trades is the concern. When only one of the two inputs is reported, that one is judged alone.',
        thresholds: { good: '≤ 25 trades/trader, whatever the organic share', caution: '> 25 trades/trader with ≥ 10 % organic', warning: '> 25 trades/trader and < 10 % organic' }
    },
    {
        id: 'failedTx',
        level: 'token',
        dimension: 'market',
        label: 'Failed swaps',
        description: 'Share of the sampled pool signatures that reverted without settling a swap.',
        thresholds: { good: '≤ 20 %', caution: '≤ 50 %', warning: '> 50 %' }
    },
    {
        id: 'concentration',
        level: 'token',
        dimension: 'market',
        label: 'Holder concentration',
        description: 'Supply share of the largest wallet we cannot identify (issuer keys and burn addresses excluded).',
        thresholds: { good: '≤ 25 %', caution: '≤ 50 %', warning: '> 50 %' }
    },
    {
        id: 'verification',
        level: 'programme',
        dimension: 'legal',
        label: 'Legal evidence review',
        description: 'Whether required legal fields are sourced and reviewed, together with the strength of reserve verification.',
        thresholds: {
            good: 'all required fields sourced and reviewed; reserve strength ≥ 3',
            caution: 'coverage or review gaps, or reserve strength 1–2',
            warning: 'reserve strength 0'
        }
    },
    {
        id: 'defiComposability',
        level: 'programme',
        dimension: 'composability',
        label: 'DeFi enforceability',
        description: 'Whether a smart-contract lender can custody the token and seize realisable value after default without discretionary issuer cooperation.',
        thresholds: {
            good: 'permissionless custody and default enforcement',
            caution: 'usable with explicit protocol support or eligibility conditions',
            warning: 'generic escrow or meaningful default enforcement is blocked'
        }
    },
    {
        id: 'keyControl',
        level: 'programme',
        dimension: 'control',
        label: 'Authority keys',
        description: 'How each installed mint, freeze, pause, delegate, transfer-fee and rebase path is ultimately governed.',
        thresholds: { good: 'every installed path is a multisig, or a program with evidenced multisig upgrade governance', caution: 'a hot key', warning: null }
    },
    {
        id: 'paused',
        level: 'token',
        dimension: 'control',
        label: 'Trading pause',
        description: 'Whether transfers or issuer trading are paused right now.',
        thresholds: { good: 'not paused', caution: null, warning: 'paused' }
    },
    {
        id: 'frozen',
        level: 'token',
        dimension: 'control',
        label: 'Frozen accounts',
        description: 'Frozen token accounts among the top 20 holders. A frozen account cannot transfer.',
        thresholds: { good: 'none in the top 20', caution: '≥ 1 in the top 20', warning: null }
    },
    {
        id: 'spread',
        level: 'token',
        dimension: 'market',
        label: 'Venue spread',
        description: 'Gap between the cheapest and the dearest venue pricing the same token.',
        thresholds: { good: '≤ 2 %', caution: '≤ 5 %', warning: '> 5 %' }
    }
];

/** `'≤ 1 % good · ≤ 3 % caution · > 3 % warning'` — bands the rule cannot reach are left out. */
function thresholdSummary(rule) {
    return ['good', 'caution', 'warning']
        .map((band) => (rule.thresholds?.[band] ? `${rule.thresholds[band]} ${band}` : null))
        .filter((part) => part !== null)
        .join(' · ');
}

/**
 * Worst of the judged statuses: warning beats caution beats good. `unknown` (and anything
 * unrecognised) is skipped rather than ranked, because an unmeasured check is not evidence of a
 * problem. Empty, or nothing but unknowns, is `'unknown'`.
 */
export function worstStatus(statuses) {
    let worst = null;
    for (const status of Array.isArray(statuses) ? statuses : []) {
        const rank = SEVERITY[status];
        if (rank === undefined) continue;
        if (worst === null || rank > SEVERITY[worst]) worst = status;
    }
    return worst === null ? 'unknown' : worst;
}

/** `value ≤ goodAtMost` is good, `≤ cautionAtMost` caution, anything above warning. Null → unknown. */
function bandLowerIsBetter(value, goodAtMost, cautionAtMost) {
    if (value === null) return 'unknown';
    if (value <= goodAtMost) return 'good';
    if (value <= cautionAtMost) return 'caution';
    return 'warning';
}

/** `value ≥ goodAtLeast` is good, `≥ cautionAtLeast` caution, anything below warning. Null → unknown. */
function bandHigherIsBetter(value, goodAtLeast, cautionAtLeast) {
    if (value === null) return 'unknown';
    if (value >= goodAtLeast) return 'good';
    if (value >= cautionAtLeast) return 'caution';
    return 'warning';
}

/** A finite boolean, or null — so "not reported" never collapses into `false`. */
function booleanOrNull(value) {
    return typeof value === 'boolean' ? value : null;
}

/** Short number for a note. Null prints as an em dash rather than as 0. */
function fmt(value, digits = 2) {
    const num = toFiniteNumber(value);
    if (num === null) return '—';
    return String(Number(num.toFixed(digits)));
}

/**
 * Σ `sharePct` of the first `n` owners this repo cannot name, owners deduped across their token
 * accounts first (`dedupeOwners` returns them biggest-first) and every labelled row — issuer
 * mint/freeze authorities, the Superstate burn address — dropped.
 *
 * The shares are percentages of TOTAL SUPPLY and excluding a labelled account does NOT renormalise
 * that denominator: the question this answers is "how much of total supply does the biggest
 * unlabelled wallet hold", not "how much of the free float". A mint whose issuer authority still
 * holds 90 % therefore reports a small number here, which is the honest reading — the unlabelled
 * wallets genuinely hold little of the supply — and `inputs.excluded` shows what was set aside.
 *
 * Null (never 0) when nothing is summable: no holder snapshot, no unlabelled row, or a supply of 0
 * that left every `sharePct` null.
 */
export function topSharePctExcludingLabels(top20, n) {
    if (!Array.isArray(top20)) return null;
    const count = Number.isInteger(n) && n > 0 ? n : 0;
    const unlabelled = dedupeOwners(top20).filter((row) => row.ownerLabel === null);
    return sumOrNull(unlabelled.slice(0, count).map((row) => row.sharePct));
}

// --- The eleven rules --------------------------------------------------------------------------
// Each returns `{status, value, inputs, note}`; evaluateHealth() adds the id, label and threshold
// string from HEALTH_RULES so the order and the wording live in exactly one place.

/**
 * The reference-price sources (stocks/fetch-reference-prices.mjs `refSource`) as a reader says them.
 * The inputs keep the key; notes, and the cards (lib/cards.mjs), use these words.
 */
export const REFERENCE_SOURCE_LABELS = {
    pyth: 'the Pyth price',
    'ondo-implied': 'Ondo’s implied price',
    'issuer-mark': 'the issuer’s own mark price'
};

/** 1. |premiumPct| against the reference price of the underlying share. */
function trackingRule(token) {
    const reference = token?.reference ?? null;
    const premium = toFiniteNumber(reference?.premiumPct);
    const value = premium === null ? null : Math.abs(premium);
    const status = bandLowerIsBetter(value, 1, 3);
    const inputs = {
        referenceSource: stringOrNull(reference?.source),
        referencePrice: toFiniteNumber(reference?.price),
        ageSeconds: toFiniteNumber(reference?.ageSeconds),
        marketOpen: booleanOrNull(reference?.marketOpen),
        usdPrice: toFiniteNumber(token?.market?.usdPrice)
    };
    const note = status === 'unknown'
        ? 'no reference price for the underlying share, so the premium cannot be measured'
        : `on-chain price is ${fmt(value)} % ${premium >= 0 ? 'above' : 'below'} `
            + `${REFERENCE_SOURCE_LABELS[inputs.referenceSource] ?? `the ${inputs.referenceSource ?? 'reference'} price`}`
            + (inputs.marketOpen === false ? ' (underlying market closed)' : '');
    return { status, value, inputs, note };
}

/** 2. Reported dollar liquidity behind the token. */
function liquidityRule(token) {
    const value = toFiniteNumber(token?.market?.liquidity);
    const status = bandHigherIsBetter(value, 100000, 10000);
    const inputs = {
        liquidityUsd: value,
        dexPairs: toFiniteNumber(token?.activity?.dexPairs)
    };
    const note = status === 'unknown'
        ? 'no venue reports liquidity'
        : `$${sharedFmt.fmtNumber(value)} of reported liquidity`
            + (inputs.dexPairs === null ? '' : ` across ${inputs.dexPairs} DEX pair${inputs.dexPairs === 1 ? '' : 's'}`);
    return { status, value, inputs, note };
}

/**
 * 3. "Many traders or a few bots". ≤ 25 trades per trader → good, whatever the organic share;
 * > 25 trades per trader → caution, and warning when the organic share is also < 10 %. When only
 * one of the two is reported the rule judges THAT one alone (pass → good, fail → caution) and the
 * note says which input was missing, rather than inventing the other. `value` is the organic share
 * when known, else the trades-per-trader figure that was judged.
 *
 * Recalibrated 2026-09-25. It used to caution whenever EITHER input failed, and the organic share
 * failed exactly where markets work: of the 57 tokens with ≥ $100k liquidity only 4 reached 10 %
 * organic (median 4 %; AAPLx 3.4 %, NVDAx 4.0 %), while most tokens with < $10k or unreported
 * liquidity passed (median 30–100 %). Arbitrage and routing bots are what keep a deep token on the
 * share price, so a low organic share across many wallets is not "a few bots"; a few wallets doing
 * most of the trading is, and a few mostly-bot wallets is the warning. Organic share is still shown.
 */
function organicRule(token) {
    const organic = toFiniteNumber(token?.market?.organicSharePct);
    const perTrader = toFiniteNumber(token?.activity?.tradesPerTrader);
    const trades24 = toFiniteNumber(token?.activity?.trades24);
    const inputs = { organicSharePct: organic, tradesPerTrader: perTrader, trades24 };
    const value = organic !== null ? organic : perTrader;

    if (trades24 === null || trades24 === 0) {
        const note = trades24 === 0
            ? 'no trades in 24 h, so there is no flow to judge'
            : 'no 24 h trade count reported, so there is no flow to judge';
        return { status: 'unknown', value, inputs, note };
    }

    const organicOk = organic === null ? null : organic >= 10;
    const perTraderOk = perTrader === null ? null : perTrader <= 25;

    if (organicOk === null && perTraderOk === null) {
        return { status: 'unknown', value, inputs, note: 'neither the organic share nor trades-per-trader is reported' };
    }
    if (organicOk === null || perTraderOk === null) {
        const judgedOrganic = organicOk !== null;
        const passed = judgedOrganic ? organicOk : perTraderOk;
        const note = judgedOrganic
            ? `judged on the ${fmt(organic)} % organic share alone; trades per trader is not reported`
            : `judged on ${fmt(perTrader)} trades per trader alone; the organic share is not reported`;
        return { status: passed ? 'good' : 'caution', value, inputs, note };
    }

    const status = perTraderOk ? 'good' : organicOk ? 'caution' : 'warning';
    const note = `${fmt(organic)} % organic share and ${fmt(perTrader)} trades per trader over ${sharedFmt.fmtNumber(trades24)} trades`
        + (perTraderOk && !organicOk ? '; most volume is bot-classified but spread across many wallets' : '');
    return { status, value, inputs, note };
}

/**
 * 4. Σ failedTx / Σ signaturesSeen over this mint's pools, as a percentage. A pool only counts when
 * it reports BOTH a positive signature count and a finite failure count — a pool with signatures and
 * no failure figure would otherwise contribute its signatures to the denominator as if it had failed
 * nothing, which is exactly the null-becomes-0 trap.
 */
function failedTxRule(pools) {
    const list = Array.isArray(pools) ? pools : [];
    const rows = [];
    let signatures = null;
    let failed = null;
    let counted = 0;

    for (const pool of list) {
        const seen = toFiniteNumber(pool?.signaturesSeen);
        const bad = toFiniteNumber(pool?.failedTx);
        rows.push({ pair: stringOrNull(pool?.pair), dex: stringOrNull(pool?.dex), signaturesSeen: seen, failedTx: bad });
        if (seen === null || seen <= 0 || bad === null) continue;
        signatures = (signatures ?? 0) + seen;
        failed = (failed ?? 0) + bad;
        counted += 1;
    }

    const value = signatures === null || signatures === 0 ? null : (failed / signatures) * 100;
    const status = bandLowerIsBetter(value, 20, 50);
    const inputs = { pools: rows, poolsCounted: counted, signaturesSeen: signatures, failedTx: failed };
    const note = status === 'unknown'
        ? (list.length === 0 ? 'no swap pool was sampled for this mint' : 'the sampled pools reported no usable signature counts')
        : `${fmt(value, 1)} % of ${signatures} sampled pool signatures failed across ${counted} pool${counted === 1 ? '' : 's'}`;
    return { status, value, inputs, note };
}

/** 5. Supply share of the biggest wallet this repo cannot name. */
function concentrationRule(holders) {
    const top20 = Array.isArray(holders?.top20) ? holders.top20 : [];
    const value = topSharePctExcludingLabels(top20, 1);
    const status = bandLowerIsBetter(value, 25, 50);
    const excluded = dedupeOwners(top20)
        .filter((row) => row.ownerLabel !== null)
        .map((row) => ({ ownerLabel: row.ownerLabel, sharePct: row.sharePct }));
    const inputs = {
        top1SharePctExcludingLabels: value,
        top5SharePctExcludingLabels: topSharePctExcludingLabels(top20, 5),
        top20SharePctExcludingLabels: topSharePctExcludingLabels(top20, 20),
        top1SharePct: toFiniteNumber(holders?.top1SharePct),
        excluded,
        distinctOwnersTop20: toFiniteNumber(holders?.distinctOwnersTop20)
    };
    const note = status === 'unknown'
        ? (top20.length === 0
            ? 'no holder snapshot for this mint'
            : 'no unlabelled holder carries a measurable share (the mint may have a supply of 0)')
        : `the largest unlabelled wallet holds ${fmt(value)} % of supply`
            + (excluded.length === 0 ? '' : `, ${excluded.length} labelled account${excluded.length === 1 ? '' : 's'} set aside`);
    return { status, value, inputs, note };
}

/**
 * 6. Legal/evidence status. Reserve strength is one input, not a proxy for the whole legal review:
 * `good` requires complete required-field coverage, no unverified or unreviewed inferential
 * conclusions, and reserve evidence of at least 3/5. Reviewed inferences remain visibly
 * inferential rather than source-confirmed, but are not a review-gap caution on their own.
 */
function verificationRule(issuer) {
    const value = toFiniteNumber(issuer?.grades?.verificationStrength);
    const evidence = issuer?.evidence && typeof issuer.evidence === 'object' ? issuer.evidence : null;
    const needed = toFiniteNumber(evidence?.coverage?.needed);
    const sourced = toFiniteNumber(evidence?.coverage?.sourced);
    const unverified = toFiniteNumber(evidence?.unverified);
    const inference = toFiniteNumber(evidence?.inference);
    // Legacy summaries only have `inference`; treating those as reviewed would silently upgrade
    // historical evidence. New summaries explicitly split reviewed from unreviewed inference.
    const reviewedInference = inference === null ? null
        : (Number.isFinite(evidence?.inferenceReviewed)
            ? Math.max(0, Math.min(inference, evidence.inferenceReviewed))
            : 0);
    const unreviewedInference = inference === null ? null
        : (Number.isFinite(evidence?.inferenceUnreviewed)
            ? Math.max(0, Math.min(inference - reviewedInference, evidence.inferenceUnreviewed))
            : inference - reviewedInference);
    const missingRequired = needed === null || sourced === null ? null : Math.max(0, needed - sourced);
    const inputs = {
        custodyType: stringOrNull(issuer?.custodyVerification?.type),
        machineReadable: booleanOrNull(issuer?.custodyVerification?.machineReadable),
        verificationLabel: stringOrNull(issuer?.grades?.verificationLabel),
        requiredFields: needed,
        sourcedFields: sourced,
        missingRequired,
        unverifiedClaims: unverified,
        inferentialConclusions: inference,
        inferenceReviewed: reviewedInference,
        inferenceUnreviewed: unreviewedInference
    };
    let status = 'unknown';
    if (needed !== null && needed > 0 && sourced !== null) {
        if (value === 0) status = 'warning';
        else if (missingRequired > 0 || (unverified ?? 0) > 0 || (unreviewedInference ?? 0) > 0 || value === null || value < 3) {
            status = 'caution';
        } else {
            status = 'good';
        }
    }
    const gaps = [];
    if (missingRequired !== null && missingRequired > 0) gaps.push(`${fmt(missingRequired, 0)} required field${missingRequired === 1 ? '' : 's'} lack evidence`);
    if (unverified !== null && unverified > 0) gaps.push(`${fmt(unverified, 0)} claim${unverified === 1 ? '' : 's'} await re-checking`);
    if (unreviewedInference !== null && unreviewedInference > 0) gaps.push(`${fmt(unreviewedInference, 0)} inferential conclusion${unreviewedInference === 1 ? '' : 's'} await review`);
    const reviewedNote = reviewedInference !== null && reviewedInference > 0
        ? `${fmt(reviewedInference, 0)} reviewed conclusion${reviewedInference === 1 ? ' remains' : 's remain'} inferential, not source-confirmed`
        : null;
    const reserve = value === null
        ? 'reserve-verification strength is unrated'
        : `reserve-verification strength ${fmt(value, 0)}/5 — ${inputs.verificationLabel ?? inputs.custodyType ?? 'unlabelled'}`
            + (inputs.machineReadable === true ? ', machine-readable' : '');
    const note = status === 'unknown'
        ? 'required-field evidence coverage is not measured, so legal/evidence health is unknown'
        : `${sourced}/${needed} required fields sourced; ${reserve}${gaps.length ? `; ${gaps.join('; ')}` : '; review complete'}${reviewedNote ? `; ${reviewedNote}` : ''}`;
    return { status, value, inputs, note };
}

/**
 * 7. The installed mint, freeze, pause, permanent-delegate, transfer-fee and rebase authorities. Any hot key is
 * a caution; a good verdict requires every installed path to be characterised as a multisig or
 * program. Unknown capability/governance paths remain unknown rather than earning a governance
 * credit. This rule never warns: a hot key is a risk, not a proven fault.
 *
 * The rebase authority is the fourth key and is judged exactly like the other three — one signature
 * from it restates every holder's displayed balance, which PreStocks' undisclosed SPACEX ×5 on
 * 2026-06-10 and OPENAI ×1.4861347 on 2026-07-17 both did. It is skipped only for a mint KNOWN to
 * carry no scaled-UI-amount extension (`control.rebase === false`): there is no such authority on
 * that mint, so an issuer-level characterisation says nothing about it. A mint whose control block
 * has not been read (`null`) leaves the issuer-level value standing, the same as the other keys.
 */
function capabilityState(value) {
    if (value === false) return 'absent';
    if (value === true || (typeof value === 'string' && value !== '')) return 'present';
    return 'unknown';
}

function transferFeeState(control) {
    if (control?.transferFee === true) return 'present';
    if (control?.transferFee === false) return 'absent';
    const values = [control?.transferFeeConfigAuthority, control?.transferFeeWithdrawAuthority, control?.transferFeeBps];
    if (values.some((value) => typeof value === 'string' && value !== '') || values.some(Number.isFinite)) return 'present';
    return 'unknown';
}

function declaredGovernance(issuer, role, fallback) {
    const fact = issuer?.authorityFacts?.[role];
    return typeof fact?.effectiveGovernance === 'string' ? fact.effectiveGovernance : fallback;
}

function effectiveGovernance(issuer, role, fallback) {
    // A program whose upgrade key is a single signer is that signer (authority-attribution.mjs).
    return resolveProgramGovernance(declaredGovernance(issuer, role, fallback), issuer?.authorityFacts?.[role]);
}

function strongGovernance(issuer, role, value) {
    if (value === 'multisig') return true;
    // A program/PDA is an implementation path, not the ultimate controller. It is only strong
    // once reviewed research traces the upgrade path to a multisig.
    return value === 'program' && issuer?.authorityFacts?.[role]?.upgradeGovernance === 'multisig';
}

function keyControlRule(issuer, token) {
    const governance = issuer?.keyGovernance ?? null;
    const control = token?.control ?? null;
    // Older/reduced callers can supply governance without a mint-control read. Keep that
    // deliberately separate from a read that contains unknown capability fields: only the latter
    // can make an otherwise-green control verdict unknown for lack of coverage.
    const hasCapabilityRead = ['mintAuthority', 'freezeAuthority', 'permanentDelegate', 'clawback', 'pausable', 'transferFeeConfigAuthority', 'transferFeeBps']
        .some((key) => Object.hasOwn(control ?? {}, key));
    const capabilityRoles = [
        ['mint', capabilityState(control?.mintAuthority)],
        ['freeze', capabilityState(control?.freezeAuthority)],
        ['pause', capabilityState(control?.pausable)],
        ['delegate', capabilityState(control?.permanentDelegate ?? control?.clawback)],
        ['transferFee', transferFeeState(control)],
        ['rebase', capabilityState(control?.rebase)]
    ];
    const roles = (hasCapabilityRead
        ? capabilityRoles
        : [
            ['mint', 'present', 'mint'], ['freeze', 'present', 'freeze'],
            ['delegate', 'present', 'delegate'], ['rebase', control?.rebase === false ? 'absent' : 'present', 'rebase']
        ]).filter(([, state]) => state !== 'absent');
    const inputs = {
        mint: effectiveGovernance(issuer, 'mint', stringOrNull(governance?.mint)),
        freeze: effectiveGovernance(issuer, 'freeze', stringOrNull(governance?.freeze)),
        pause: effectiveGovernance(issuer, 'pause', stringOrNull(governance?.pause)),
        delegate: effectiveGovernance(issuer, 'permanentDelegate', stringOrNull(governance?.delegate)),
        transferFee: effectiveGovernance(issuer, 'transferFee', stringOrNull(governance?.transferFee)),
        rebase: effectiveGovernance(issuer, 'rebase', stringOrNull(governance?.rebase))
    };
    const roleNames = roles.map(([role]) => role);
    const strong = roles.filter(([role]) => strongGovernance(issuer, role, inputs[role]));
    const unresolved = roles.filter(([role, state]) => state === 'unknown' || (!strongGovernance(issuer, role, inputs[role]) && inputs[role] !== 'hot-key'));

    const factRole = { delegate: 'permanentDelegate' };
    const viaUpgrade = roleNames.filter((role) => inputs[role] !== 'program'
        && declaredGovernance(issuer, factRole[role] ?? role, stringOrNull(governance?.[role])) === 'program');
    const hot = roleNames.filter((role) => inputs[role] === 'hot-key' && !viaUpgrade.includes(role));
    const oneSignerMultisig = roleNames.filter((role) => inputs[role] === 'single-signer-multisig' && !viaUpgrade.includes(role));
    if (hot.length > 0 || oneSignerMultisig.length > 0 || viaUpgrade.length > 0) {
        const notes = [];
        if (hot.length > 0) notes.push(`${hot.join(', ')} authority held by a hot key`);
        if (oneSignerMultisig.length > 0) notes.push(`${oneSignerMultisig.join(', ')} authority requires only one multisig signer`);
        if (viaUpgrade.length > 0) notes.push(`${viaUpgrade.join(', ')} authority held by a program whose upgrade authority is a single signer`);
        return { status: 'caution', value: null, inputs, note: notes.join('; ') };
    }
    // A known strong path does not convert an unmeasured capability or governance path into a
    // green result. A program may be the inner signer while a separate direct key controls the
    // outer role; an evidence-backed `effectiveGovernance` correction makes that path explicit.
    if (roles.length > 0 && unresolved.length === 0 && strong.length === roles.length) {
        return { status: 'good', value: null, inputs, note: `${strong.length} of ${roles.length} installed authorities held by a multisig or by a program with evidenced multisig upgrade governance, none by a hot key` };
    }
    return { status: 'unknown', value: null, inputs, note: 'how the authority keys are held has not been recorded' };
}

/**
 * 8. Transfers or issuer trading paused right now. Warning or good — never a caution.
 *
 * An issuer pause whose reason is `unavailable_in_session` is NOT a pause: Ondo returns
 * `isTradingPaused: true` with that reason for every asset it does not offer in the current session
 * (91 tokens overnight at 01:04 UTC on 2026-09-25, none in US hours). That is the issuer's trading
 * calendar, like an exchange being shut, and read as a warning it flipped ~90 tokens between good and
 * warning twice a day. Any other reason (`scheduled`, a halt) and any on-chain pause still warn.
 */
const SESSION_CLOSED_REASON = 'unavailable_in_session';

function pausedRule(token, issuerApi) {
    const control = booleanOrNull(token?.control?.paused);
    const api = booleanOrNull(issuerApi?.isTradingPaused);
    const reason = stringOrNull(issuerApi?.tradingStatus?.assetPauseReason);
    const session = stringOrNull(issuerApi?.tradingStatus?.currentSession);
    const inputs = { controlPaused: control, issuerApiPaused: api, issuerPauseReason: reason, issuerSession: session };
    const sessionClosed = api === true && reason === SESSION_CLOSED_REASON;

    if (control === true || (api === true && !sessionClosed)) {
        const who = control === true ? (api === true && !sessionClosed ? 'on-chain and at the issuer' : 'on-chain') : 'at the issuer';
        return { status: 'warning', value: null, inputs, note: `trading is paused ${who}` };
    }
    if (sessionClosed) {
        const when = session === null ? 'the current session' : `the ${session} session`;
        return {
            status: 'good',
            value: null,
            inputs,
            note: `not halted: the issuer lists this asset as not offered in ${when}, its normal trading calendar`
                + (control === false ? '; on-chain transfers are not paused' : '')
        };
    }
    if (control === false || api === false) {
        return { status: 'good', value: null, inputs, note: 'not paused' };
    }
    return { status: 'unknown', value: null, inputs, note: 'neither the mint nor an issuer API reports a pause state' };
}

/** 9. Frozen token accounts in the top 20. Caution or good — never a warning. */
function frozenRule(holders) {
    const value = toFiniteNumber(holders?.frozenAccountsTop20);
    const inputs = {
        frozenAccountsTop20: value,
        top20Count: Array.isArray(holders?.top20) ? holders.top20.length : null
    };
    if (value === null) return { status: 'unknown', value, inputs, note: 'no holder snapshot, so account states are unknown' };
    if (value >= 1) return { status: 'caution', value, inputs, note: `${fmt(value, 0)} of the top 20 accounts are frozen` };
    return { status: 'good', value, inputs, note: 'no frozen account in the top 20' };
}

/** 10. Spread between the cheapest and the dearest venue pricing the token. */
function spreadRule(token) {
    const activity = token?.activity ?? null;
    const spread = toFiniteNumber(activity?.venueSpreadPct);
    const venuesPriced = toFiniteNumber(activity?.venuesPriced);
    // A spread needs two prices to exist at all: one venue (or none) cannot disagree with anybody.
    const thin = venuesPriced !== null && venuesPriced < 2;
    const value = thin ? null : spread;
    const status = bandLowerIsBetter(value, 2, 5);
    const inputs = {
        venueSpreadPct: spread,
        venueSpreadLow: stringOrNull(activity?.venueSpreadLow),
        venueSpreadHigh: stringOrNull(activity?.venueSpreadHigh),
        venuesPriced
    };
    const note = status === 'unknown'
        ? (thin
            ? `only ${fmt(venuesPriced, 0)} venue price${venuesPriced === 1 ? '' : 's'} this token, so there is no spread to measure`
            : 'no venue spread reported')
        : `${fmt(value)} % between ${inputs.venueSpreadLow ?? 'the cheapest venue'} and ${inputs.venueSpreadHigh ?? 'the dearest'}`;
    return { status, value, inputs, note };
}

/** Band order for the token rank: healthiest first. */
const RANK_BAND = { good: 0, caution: 1, warning: 2 };

/**
 * One level's verdict: the worst judged status among its rules, the first rule carrying it when
 * that is a caution or warning (null otherwise), and how many of its rules were judged and passed. `passed` counts `good` among JUDGED rules only, so an
 * unknown is never a pass and never a fail. At the token level `requireTrading` withholds `good`
 * (→ unknown) when none of TRADING_RULE_IDS was judged; a caution or warning found without a market
 * still stands, because a fault needs no market to be one.
 *
 * The token level also carries `rank`, the one number the monitor sorts by (lower is healthier):
 * band first, then how many judged checks fail, then how many pass — `band×100 + failed×10 +
 * (total − passed)`, each term smaller than the step above it with eight token checks. Not measured
 * has no rank (null), so it sorts last in either direction rather than posing as the best or worst.
 */
function levelVerdict(memberRules, { requireTrading = false } = {}) {
    const judgedRules = memberRules.filter((rule) => rule.status !== 'unknown');
    const passed = judgedRules.filter((rule) => rule.status === 'good').length;
    const tradingJudged = judgedRules.filter((rule) => TRADING_RULE_IDS.includes(rule.id)).length;
    let status = worstStatus(judgedRules.map((rule) => rule.status));
    if (requireTrading && status === 'good' && tradingJudged === 0) status = 'unknown';
    // Only a failing rule is named: a good level has nothing dragging it down (the overall
    // worstRuleId keeps its older "first rule carrying the status" meaning for its consumers).
    const worstRuleId = status === 'caution' || status === 'warning'
        ? (memberRules.find((rule) => rule.status === status)?.id ?? null)
        : null;
    const verdict = {
        status,
        worstRuleId,
        judged: judgedRules.length,
        passed,
        unknown: memberRules.length - judgedRules.length,
        total: memberRules.length
    };
    if (!requireTrading) return verdict;
    const rank = status in RANK_BAND
        ? RANK_BAND[status] * 100 + (verdict.judged - passed) * 10 + (verdict.total - passed)
        : null;
    return { ...verdict, tradingJudged, rank };
}

/**
 * The health verdict for one token: `{status, worstRuleId, levels, dimensions, rules}` with `rules`
 * always the eleven HEALTH_RULES in their fixed order. `levels` is the headline: the programme's
 * verdict (the same for every token of the issuer) and this token's, each with `passed` of `judged`
 * checks. `dimensions` keeps market, control, legal/evidence and DeFi composability separate, while
 * the top-level status remains the conservative worst-of summary of all eleven.
 *
 * Every field of the input is optional and may be null — a token with nothing known comes back
 * `status: 'unknown'` with eleven unknown rules, and can never come back `warning`. `status` is the
 * worst JUDGED rule status (unknowns skipped) and `worstRuleId` names the first rule in display
 * order carrying it, or null when the overall status is unknown.
 *
 * @param {object} input
 * @param {object|null} input.token one `stocks-tokens.json` `.tokens[]` record
 * @param {object|null} input.issuer one `stocks-issuers.json` `.issuers[]` record
 * @param {object|null} input.holders one `stocks/data/holders.json` `.items[]` record
 * @param {Array|null} input.pools this mint's `stocks-trades.json` `.pools[]` entries
 * @param {object|null} input.composabilityTemplate reviewed issuer + control-recipe template
 * @param {object|null} input.issuerApi the issuer API payload; defaults to `token.issuerApi`
 */
export function evaluateHealth(input = {}) {
    const {
        token = null, issuer = null, holders = null, pools = null, issuerApi = null,
        composabilityTemplate = null
    } = input ?? {};
    const api = issuerApi ?? token?.issuerApi ?? null;

    const byId = {
        tracking: trackingRule(token),
        liquidity: liquidityRule(token),
        organic: organicRule(token),
        failedTx: failedTxRule(pools),
        concentration: concentrationRule(holders),
        verification: verificationRule(issuer),
        defiComposability: composabilityHealthRule(composabilityTemplate),
        keyControl: keyControlRule(issuer, token),
        paused: pausedRule(token, api),
        frozen: frozenRule(holders),
        spread: spreadRule(token)
    };

    const rules = HEALTH_RULES.map((rule) => {
        const out = byId[rule.id];
        return {
            id: rule.id,
            label: rule.label,
            level: rule.level,
            dimension: rule.dimension,
            status: out.status,
            value: out.value,
            threshold: thresholdSummary(rule),
            inputs: out.inputs,
            note: out.note
        };
    });

    const status = worstStatus(rules.map((rule) => rule.status));
    const worstRuleId = status === 'unknown' ? null : (rules.find((rule) => rule.status === status)?.id ?? null);
    const levels = {
        programme: levelVerdict(rules.filter((rule) => rule.level === 'programme')),
        token: levelVerdict(rules.filter((rule) => rule.level === 'token'), { requireTrading: true })
    };
    const dimensions = Object.fromEntries(HEALTH_DIMENSIONS.map((dimension) => {
        const memberRules = rules.filter((rule) => rule.dimension === dimension.id);
        const dimensionStatus = worstStatus(memberRules.map((rule) => rule.status));
        const dimensionWorstRuleId = dimensionStatus === 'unknown'
            ? null
            : (memberRules.find((rule) => rule.status === dimensionStatus)?.id ?? null);
        const judged = memberRules.filter((rule) => rule.status !== 'unknown').length;
        return [dimension.id, { status: dimensionStatus, worstRuleId: dimensionWorstRuleId, judged, unknown: memberRules.length - judged, total: memberRules.length }];
    }));
    return { status, worstRuleId, levels, dimensions, rules };
}
