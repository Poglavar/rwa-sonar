// PURE health-status rules for the tokenized-stocks section (no fs, no network, no clock, no DOM):
// the single source of truth for the eleven per-token checks — price tracking, pool liquidity, organic
// flow, failed swaps, holder concentration, reserve verification, authority-key governance, trading
// pause, frozen accounts and cross-venue spread — plus the worst-of roll-up that the stock cards and
// the health monitor both display. A check whose inputs are missing is reported as `unknown` and is
// NEVER counted as bad, so "we did not measure this" can never read as "this is fine" or as a fault.
// Unit-tested in ../health.test.js.

import { toFiniteNumber } from './grade.mjs';
import { dedupeOwners, stringOrNull, sumOrNull } from './holders.mjs';
import { composabilityHealthRule } from './composability.mjs';

/** The only statuses a rule or a token may carry. `unknown` is a first-class answer, not a failure. */
export const STATUSES = ['good', 'caution', 'warning', 'unknown'];

/** The four independent questions hidden by a single worst-of status. */
export const HEALTH_DIMENSIONS = [
    { id: 'market', label: 'Market', description: 'Price quality, liquidity, activity, distribution and execution.' },
    { id: 'control', label: 'Control', description: 'Who can change, pause or freeze the token and its accounts.' },
    { id: 'legal', label: 'Legal / evidence', description: 'Evidence that the off-chain shares and reserve claim exist.' },
    { id: 'composability', label: 'DeFi composability', description: 'Whether a protocol can custody the token and enforce a default without discretionary issuer help.' }
];

/** How bad each judged status is. `unknown` is deliberately absent — it has no severity. */
const SEVERITY = { good: 1, caution: 2, warning: 3 };

/**
 * The eleven rules, in the fixed display order. `thresholds` are human-readable strings, and a band a
 * rule can never produce is `null` (keyControl and frozen never warn; paused never cautions) so a
 * card cannot advertise a verdict the rule is incapable of reaching.
 */
export const HEALTH_RULES = [
    {
        id: 'tracking',
        dimension: 'market',
        label: 'Price tracking',
        description: 'How far the on-chain price sits from a reference price for the same underlying share.',
        thresholds: { good: '≤ 1 %', caution: '≤ 3 %', warning: '> 3 %' }
    },
    {
        id: 'liquidity',
        dimension: 'market',
        label: 'Pool liquidity',
        description: 'Dollar liquidity the venues report behind the token, i.e. how much can be traded at all.',
        thresholds: { good: '≥ $100,000', caution: '≥ $10,000', warning: '< $10,000' }
    },
    {
        id: 'organic',
        dimension: 'market',
        label: 'Organic flow',
        description: 'Whether the 24 h trading looks like many real traders rather than a handful of bots.',
        thresholds: { good: '≥ 10 % organic and ≤ 25 trades/trader', caution: 'one of the two fails', warning: 'both fail' }
    },
    {
        id: 'failedTx',
        dimension: 'market',
        label: 'Failed swaps',
        description: 'Share of the sampled pool signatures that reverted instead of settling a swap.',
        thresholds: { good: '≤ 20 %', caution: '≤ 50 %', warning: '> 50 %' }
    },
    {
        id: 'concentration',
        dimension: 'market',
        label: 'Holder concentration',
        description: 'Supply share of the largest wallet this repo cannot name (issuer keys and burn addresses excluded).',
        thresholds: { good: '≤ 25 %', caution: '≤ 50 %', warning: '> 50 %' }
    },
    {
        id: 'verification',
        dimension: 'legal',
        label: 'Reserve verification',
        description: 'Strength of the issuer evidence that the shares behind the token exist (0–5).',
        thresholds: { good: 'strength ≥ 3', caution: 'strength 1–2', warning: 'strength 0' }
    },
    {
        id: 'defiComposability',
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
        dimension: 'control',
        label: 'Authority keys',
        description: 'How the mint, freeze, permanent-delegate and rebase authorities are held.',
        thresholds: { good: 'a multisig or a program', caution: 'a hot key', warning: null }
    },
    {
        id: 'paused',
        dimension: 'control',
        label: 'Trading pause',
        description: 'Whether transfers or issuer trading are paused right now.',
        thresholds: { good: 'not paused', caution: null, warning: 'paused' }
    },
    {
        id: 'frozen',
        dimension: 'control',
        label: 'Frozen accounts',
        description: 'Frozen token accounts among the top 20 holders — transfers there are blocked.',
        thresholds: { good: 'none in the top 20', caution: '≥ 1 in the top 20', warning: null }
    },
    {
        id: 'spread',
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
        : `on-chain price is ${fmt(value)} % ${premium >= 0 ? 'above' : 'below'} the ${inputs.referenceSource ?? 'reference'} price`
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
        : `$${fmt(value, 0)} of reported liquidity`
            + (inputs.dexPairs === null ? '' : ` across ${inputs.dexPairs} DEX pair${inputs.dexPairs === 1 ? '' : 's'}`);
    return { status, value, inputs, note };
}

/**
 * 3. Organic share ≥ 10 % AND ≤ 25 trades per trader. Both pass → good, one fails → caution, both
 * fail → warning. When only one of the two is reported the rule judges THAT one alone (pass → good,
 * fail → caution) and the note says which input was missing, rather than inventing the other.
 * `value` is the organic share when known, else the trades-per-trader figure that was judged.
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
            ? `judged on the ${fmt(organic)} % organic share alone — trades per trader is not reported`
            : `judged on ${fmt(perTrader)} trades per trader alone — the organic share is not reported`;
        return { status: passed ? 'good' : 'caution', value, inputs, note };
    }

    const failures = (organicOk ? 0 : 1) + (perTraderOk ? 0 : 1);
    const status = failures === 0 ? 'good' : failures === 1 ? 'caution' : 'warning';
    const note = `${fmt(organic)} % organic share and ${fmt(perTrader)} trades per trader over ${trades24} trades`;
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

/** 6. Issuer verification strength, 0–5. */
function verificationRule(issuer) {
    const value = toFiniteNumber(issuer?.grades?.verificationStrength);
    const status = bandHigherIsBetter(value, 3, 1);
    const inputs = {
        custodyType: stringOrNull(issuer?.custodyVerification?.type),
        machineReadable: booleanOrNull(issuer?.custodyVerification?.machineReadable),
        verificationLabel: stringOrNull(issuer?.grades?.verificationLabel)
    };
    const note = status === 'unknown'
        ? 'no issuer record, so reserve verification is unrated'
        : `verification strength ${fmt(value, 0)}/5 — ${inputs.verificationLabel ?? inputs.custodyType ?? 'unlabelled'}`
            + (inputs.machineReadable === true ? ', machine-readable' : '');
    return { status, value, inputs, note };
}

/**
 * 7. The mint, freeze, permanent-delegate and rebase (scaled-UI-amount) authorities. Any hot key is
 * a caution; failing that, a multisig or a program is good. `'none'`, `'unknown'` and null say
 * nothing either way and are ignored, so a mint with no authorities at all is not credited for
 * governance it does not have. This rule never warns: a hot key is a risk, not a proven fault.
 *
 * The rebase authority is the fourth key and is judged exactly like the other three — one signature
 * from it restates every holder's displayed balance, which PreStocks' undisclosed SPACEX ×5 on
 * 2026-06-10 and OPENAI ×1.4861347 on 2026-07-17 both did. It is skipped only for a mint KNOWN to
 * carry no scaled-UI-amount extension (`control.rebase === false`): there is no such authority on
 * that mint, so an issuer-level characterisation says nothing about it. A mint whose control block
 * has not been read (`null`) leaves the issuer-level value standing, the same as the other keys.
 */
function keyControlRule(issuer, token) {
    const governance = issuer?.keyGovernance ?? null;
    const rebaseOnThisMint = booleanOrNull(token?.control?.rebase) !== false;
    const roles = rebaseOnThisMint ? ['mint', 'freeze', 'delegate', 'rebase'] : ['mint', 'freeze', 'delegate'];
    const inputs = {
        mint: stringOrNull(governance?.mint),
        freeze: stringOrNull(governance?.freeze),
        delegate: stringOrNull(governance?.delegate),
        rebase: stringOrNull(governance?.rebase)
    };
    const values = roles.map((role) => inputs[role]);
    const strong = values.filter((value) => value === 'multisig' || value === 'program');

    if (values.includes('hot-key')) {
        const hot = roles.filter((role) => inputs[role] === 'hot-key');
        return { status: 'caution', value: null, inputs, note: `${hot.join(', ')} authority held by a hot key` };
    }
    if (strong.length > 0) {
        return { status: 'good', value: null, inputs, note: `${strong.length} of ${roles.length} authorities held by a multisig or a program, none by a hot key` };
    }
    return { status: 'unknown', value: null, inputs, note: 'how the authority keys are held was never characterised' };
}

/** 8. Transfers or issuer trading paused right now. Warning or good — never a caution. */
function pausedRule(token, issuerApi) {
    const control = booleanOrNull(token?.control?.paused);
    const api = booleanOrNull(issuerApi?.isTradingPaused);
    const inputs = { controlPaused: control, issuerApiPaused: api };

    if (control === true || api === true) {
        const who = control === true ? (api === true ? 'on-chain and at the issuer' : 'on-chain') : 'at the issuer';
        return { status: 'warning', value: null, inputs, note: `trading is paused ${who}` };
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

/**
 * The health verdict for one token: `{status, worstRuleId, dimensions, rules}` with `rules` always
 * the eleven HEALTH_RULES in their fixed order. `dimensions` keeps market, control, legal/evidence
 * and DeFi composability
 * separate, while the top-level status remains the conservative worst-of summary.
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
    const dimensions = Object.fromEntries(HEALTH_DIMENSIONS.map((dimension) => {
        const memberRules = rules.filter((rule) => rule.dimension === dimension.id);
        const dimensionStatus = worstStatus(memberRules.map((rule) => rule.status));
        const dimensionWorstRuleId = dimensionStatus === 'unknown'
            ? null
            : (memberRules.find((rule) => rule.status === dimensionStatus)?.id ?? null);
        return [dimension.id, { status: dimensionStatus, worstRuleId: dimensionWorstRuleId }];
    }));
    return { status, worstRuleId, dimensions, rules };
}
