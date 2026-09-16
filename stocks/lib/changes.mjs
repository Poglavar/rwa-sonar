// PURE snapshot shaping and snapshot diffing for the daily change log (no fs, no network, no clock,
// no DOM): turns one `stocks-tokens.json` / `stocks-issuers.json` / `stocks-health.json` record into
// the slim, diffable row that `stocks/data/history/<date>/` stores, and turns two of those daily
// files into the list of things that actually changed. A field missing on either side can never fire
// a numeric change kind — "we did not measure this yesterday" must not read as a move today — so a
// null stays null and is skipped rather than coerced to 0. Unit-tested in ../changes.test.js.

import fmt from './fmt.js';
import { toFiniteNumber } from './grade.mjs';

/**
 * Significant figures every recorded number is cut to. A snapshot is committed once a day, so it
 * must be byte-identical when rebuilt from the same inputs — full double precision makes the 16th
 * digit of every liquidity figure a git diff. Six figures is far finer than the smallest threshold
 * any change kind uses (0.1 %), and matches what stocks-health.json records.
 */
const SNAPSHOT_DIGITS = 6;

/** `roundSignificant`, but an integer (a holder count, a bps fee) is left exactly as it is. */
function record(value) {
    const number = toFiniteNumber(value);
    if (number === null || Number.isInteger(number)) return number;
    return fmt.roundSignificant(number, SNAPSHOT_DIGITS);
}

/** The change kinds this module can emit, in the order a reader should scan them. */
export const CHANGE_KINDS = [
    'new-mint',
    'removed-mint',
    'paused',
    'unpaused',
    'rebase',
    'reverse-split',
    'multiplier-change',
    'health-worse',
    'health-better',
    'liquidity-drop',
    'liquidity-rise',
    'spread-wide',
    'frozen-appeared',
    'control-change'
];

/** Human labels for the change log's section headings. */
export const CHANGE_KIND_LABELS = {
    'new-mint': 'New mints',
    'removed-mint': 'Mints gone from the universe',
    paused: 'Trading paused',
    unpaused: 'Trading resumed',
    rebase: 'Rebase (balances scaled up)',
    'reverse-split': 'Reverse split (balances scaled down)',
    'multiplier-change': 'Scaled-UI multiplier moved',
    'health-worse': 'Health got worse',
    'health-better': 'Health got better',
    'liquidity-drop': 'Pool liquidity halved or worse',
    'liquidity-rise': 'Pool liquidity more than doubled',
    'spread-wide': 'Venue spread crossed 5 %',
    'frozen-appeared': 'Frozen accounts appeared in the top 20',
    'control-change': 'Issuer control flags flipped'
};

/** The control booleans a `control-change` watches. `paused` is excluded: it has its own two kinds. */
export const CONTROL_FLAGS = ['pausable', 'clawback', 'allowlist', 'hookActive'];

/** Judged health statuses, worst last. `unknown` is deliberately absent — it has no severity. */
const HEALTH_SEVERITY = { good: 1, caution: 2, warning: 3 };

/** A liquidity move is only reported when there was real liquidity to move, in USD. */
const LIQUIDITY_FLOOR_USD = 1000;
/** A fall steeper than this share of the previous liquidity is a `liquidity-drop`. */
const LIQUIDITY_DROP_SHARE = 0.5;
/** A rise larger than this multiple of the previous liquidity is a `liquidity-rise`. */
const LIQUIDITY_RISE_SHARE = 1;
/** Venue spread, in per cent, that `spread-wide` fires on crossing above. */
const SPREAD_WIDE_PCT = 5;
/** Multiplier ratios: ≥ this is a rebase, ≤ its counterpart a reverse split. */
const REBASE_RATIO = 1.05;
const REVERSE_SPLIT_RATIO = 0.5;
/** Any other multiplier move at least this far from 1 is a `multiplier-change` (0.1 %). */
const MULTIPLIER_EPSILON = 0.001;

/** A real boolean or null — a missing flag never reads as `false`. */
function boolOrNull(value) {
    return typeof value === 'boolean' ? value : null;
}

/** A non-empty string, or null. Used for the two fields that must stay strings (supply, multiplier). */
function stringOrNull(value) {
    if (typeof value === 'string') return value.trim() === '' ? null : value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return null;
}

/**
 * The slim, diffable row one token contributes to a day's snapshot: identity, the four control
 * booleans plus the fee, the market numbers worth watching day to day, the holder concentration and
 * the health verdict. Deliberately NOT the whole token record — a snapshot is committed every day,
 * so it carries only fields whose change is worth a line in the change log.
 *
 * `supplyRaw` and `uiMultiplier` stay STRINGS: both can exceed what a double represents exactly, and
 * the multiplier is compared as a Number only at diff time.
 *
 * @param {object|null} token one `stocks-tokens.json` `.tokens[]` record
 * @param {object|null} health that mint's `stocks-health.json` `.items[]` record, when there is one
 */
export function snapshotTokenRow(token, health = null) {
    const control = token?.control ?? {};
    const market = token?.market ?? {};
    const activity = token?.activity ?? {};
    const reference = token?.reference ?? {};
    const holders = token?.holders ?? {};
    return {
        mint: stringOrNull(token?.mint),
        symbol: stringOrNull(token?.symbol),
        issuer: stringOrNull(token?.issuer),
        supplyRaw: stringOrNull(token?.supplyRaw),
        uiMultiplier: stringOrNull(token?.uiMultiplier),
        paused: boolOrNull(control.paused),
        pausable: boolOrNull(control.pausable),
        clawback: boolOrNull(control.clawback),
        allowlist: boolOrNull(control.allowlist),
        transferFeeBps: record(control.transferFeeBps),
        hookActive: boolOrNull(control.hookActive),
        liquidity: record(market.liquidity),
        vol24: record(market.vol24),
        holderCount: record(market.holderCount),
        premiumPct: record(reference.premiumPct),
        venueSpreadPct: record(activity.venueSpreadPct),
        top1SharePct: record(holders.top1SharePct),
        top20SharePct: record(holders.top20SharePct),
        frozenAccountsTop20: record(holders.frozenAccountsTop20),
        health: stringOrNull(health?.status),
        worstRuleId: stringOrNull(health?.worstRuleId)
    };
}

/**
 * The slim row one issuer contributes: its status and the three graded numbers, plus how many tokens
 * and how much pool liquidity sat behind it that day. `tokenCount` prefers the built aggregate and
 * falls back to counting the mint list, so a dossier built before the aggregate existed still counts.
 *
 * @param {object|null} issuer one `stocks-issuers.json` `.issuers[]` record
 */
export function snapshotIssuerRow(issuer) {
    const grades = issuer?.grades ?? {};
    const market = issuer?.market ?? {};
    const mints = Array.isArray(issuer?.tokenMints) ? issuer.tokenMints.length : null;
    return {
        slug: stringOrNull(issuer?.slug),
        status: stringOrNull(issuer?.status),
        maturityStageNum: record(grades.maturityStageNum),
        claimRung: record(grades.claimRung),
        verificationStrength: record(grades.verificationStrength),
        tokenCount: record(market.tokens) ?? mints,
        liquidity: record(market.dexLiquidityUsd)
    };
}

/** `{mint: row}` for one snapshot file, skipping rows with no mint at all. */
function indexByMint(snapshot) {
    const out = new Map();
    for (const row of Array.isArray(snapshot?.items) ? snapshot.items : []) {
        const mint = stringOrNull(row?.mint);
        if (mint === null || out.has(mint)) continue;
        out.set(mint, row);
    }
    return out;
}

/** One change record. `note` is the sentence the page prints; `field`/`before`/`after` are the facts. */
function change(kind, row, field, before, after, note) {
    return {
        kind,
        mint: stringOrNull(row?.mint),
        symbol: stringOrNull(row?.symbol),
        issuer: stringOrNull(row?.issuer),
        field,
        before,
        after,
        note
    };
}

/** A percentage with one decimal, for notes only — never for a threshold decision. */
function pct(value) {
    return `${(value * 100).toFixed(1)} %`;
}

/** Compact USD for a note: "$4.5k" / "$1,234". Callers only pass finite numbers. */
function usd(value) {
    if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(1)}k`;
    return `$${value.toFixed(0)}`;
}

/** Both sides finite, or null — the guard that keeps a missing measurement out of every numeric kind. */
function pair(before, after) {
    const a = toFiniteNumber(before);
    const b = toFiniteNumber(after);
    if (a === null || b === null) return null;
    return { a, b };
}

/** The pause kinds. A flag missing on either side fires nothing. */
function pauseChanges(prev, next) {
    const before = boolOrNull(prev.paused);
    const after = boolOrNull(next.paused);
    if (before === null || after === null || before === after) return [];
    const kind = after ? 'paused' : 'unpaused';
    const note = after
        ? 'Transfers or issuer trading are paused now; they were not yesterday.'
        : 'The pause is gone; transfers or issuer trading are live again.';
    return [change(kind, next, 'paused', before, after, note)];
}

/**
 * The multiplier kinds, compared as Numbers because `uiMultiplier` is stored as a string. A ratio of
 * exactly 1.05 is a rebase and exactly 0.5 a reverse split; anything else at least 0.1 % away from 1
 * is a plain `multiplier-change`, which is how the slow daily drift of an interest-bearing mint reads.
 */
function multiplierChanges(prev, next) {
    const sides = pair(prev.uiMultiplier, next.uiMultiplier);
    if (sides === null || sides.a === 0) return [];
    const ratio = sides.b / sides.a;
    let kind = null;
    if (ratio >= REBASE_RATIO) kind = 'rebase';
    else if (ratio <= REVERSE_SPLIT_RATIO) kind = 'reverse-split';
    else if (Math.abs(ratio - 1) >= MULTIPLIER_EPSILON) kind = 'multiplier-change';
    if (kind === null) return [];
    const direction = ratio >= 1 ? 'up' : 'down';
    const note = `Every holder's displayed balance was restated ${direction} by ${pct(Math.abs(ratio - 1))} `
        + 'without a transfer (Token-2022 scaled-UI multiplier).';
    return [change(kind, next, 'uiMultiplier', prev.uiMultiplier, next.uiMultiplier, note)];
}

/** The two liquidity kinds. Both need real liquidity yesterday, so a $3 pool doubling is not news. */
function liquidityChanges(prev, next) {
    const sides = pair(prev.liquidity, next.liquidity);
    if (sides === null || sides.a < LIQUIDITY_FLOOR_USD) return [];
    const move = (sides.b - sides.a) / sides.a;
    if (-move > LIQUIDITY_DROP_SHARE) {
        return [change('liquidity-drop', next, 'liquidity', sides.a, sides.b,
            `Reported pool liquidity fell ${pct(-move)}, from ${usd(sides.a)} to ${usd(sides.b)}.`)];
    }
    if (move > LIQUIDITY_RISE_SHARE) {
        return [change('liquidity-rise', next, 'liquidity', sides.a, sides.b,
            `Reported pool liquidity rose ${pct(move)}, from ${usd(sides.a)} to ${usd(sides.b)}.`)];
    }
    return [];
}

/** `spread-wide` fires on the crossing only: a spread that was already over 5 % is not new news. */
function spreadChanges(prev, next) {
    const sides = pair(prev.venueSpreadPct, next.venueSpreadPct);
    if (sides === null) return [];
    if (sides.a > SPREAD_WIDE_PCT || sides.b <= SPREAD_WIDE_PCT) return [];
    return [change('spread-wide', next, 'venueSpreadPct', sides.a, sides.b,
        `The gap between the cheapest and dearest venue crossed ${SPREAD_WIDE_PCT} %, `
        + `from ${sides.a.toFixed(2)} % to ${sides.b.toFixed(2)} %.`)];
}

/** The health kinds. A transition into or out of `unknown` is measurement noise, not a health move. */
function healthChanges(prev, next) {
    const before = HEALTH_SEVERITY[prev.health];
    const after = HEALTH_SEVERITY[next.health];
    if (before === undefined || after === undefined || before === after) return [];
    const kind = after > before ? 'health-worse' : 'health-better';
    const rule = stringOrNull(next.worstRuleId);
    const note = `Worst health status went from ${prev.health} to ${next.health}`
        + (rule === null ? '.' : `, now on the ${rule} rule.`);
    return [change(kind, next, 'health', prev.health, next.health, note)];
}

/** `frozen-appeared`: none frozen in the top 20 yesterday, at least one today. */
function frozenChanges(prev, next) {
    const sides = pair(prev.frozenAccountsTop20, next.frozenAccountsTop20);
    if (sides === null || sides.a !== 0 || sides.b < 1) return [];
    return [change('frozen-appeared', next, 'frozenAccountsTop20', sides.a, sides.b,
        `${sides.b} of the top 20 holder accounts are frozen; none were yesterday.`)];
}

/** One `control-change` per flipped control boolean, in CONTROL_FLAGS order. */
function controlChanges(prev, next) {
    const out = [];
    for (const flag of CONTROL_FLAGS) {
        const before = boolOrNull(prev[flag]);
        const after = boolOrNull(next[flag]);
        if (before === null || after === null || before === after) continue;
        out.push(change('control-change', next, flag, before, after,
            `The ${flag} control flag went from ${before} to ${after}.`));
    }
    return out;
}

/**
 * Everything that changed between two daily token snapshots, as
 * `{from, to, changes:[{kind, mint, symbol, issuer, field, before, after, note}]}`.
 *
 * Records are ordered by mint, and within one mint by CHANGE_KINDS, so the same two days always
 * produce byte-identical output. A mint present on only one side yields exactly one record
 * (`new-mint` or `removed-mint`) and no field comparisons at all — an absent mint has not been
 * paused, it has gone.
 *
 * @param {object|null} prev the older `{date, items}` snapshot
 * @param {object|null} next the newer one
 */
export function diffSnapshots(prev, next) {
    const before = indexByMint(prev);
    const after = indexByMint(next);
    const mints = [...new Set([...before.keys(), ...after.keys()])].sort();
    const order = new Map(CHANGE_KINDS.map((kind, index) => [kind, index]));
    const changes = [];

    for (const mint of mints) {
        const prevRow = before.get(mint) ?? null;
        const nextRow = after.get(mint) ?? null;
        if (prevRow === null) {
            changes.push(change('new-mint', nextRow, 'mint', null, mint,
                `${nextRow?.symbol ?? mint} was not in yesterday's universe.`));
            continue;
        }
        if (nextRow === null) {
            changes.push(change('removed-mint', prevRow, 'mint', mint, null,
                `${prevRow.symbol ?? mint} is no longer in the universe; the build no longer sees this mint.`));
            continue;
        }
        const perMint = [
            ...pauseChanges(prevRow, nextRow),
            ...multiplierChanges(prevRow, nextRow),
            ...healthChanges(prevRow, nextRow),
            ...liquidityChanges(prevRow, nextRow),
            ...spreadChanges(prevRow, nextRow),
            ...frozenChanges(prevRow, nextRow),
            ...controlChanges(prevRow, nextRow)
        ];
        perMint.sort((a, b) => order.get(a.kind) - order.get(b.kind));
        changes.push(...perMint);
    }

    return {
        from: stringOrNull(prev?.date),
        to: stringOrNull(next?.date),
        changes
    };
}

/** `{kind: n}` for one change list, in CHANGE_KINDS order, kinds that did not occur left out. */
export function countByKind(changes) {
    const counts = {};
    for (const kind of CHANGE_KINDS) {
        const n = (Array.isArray(changes) ? changes : []).filter((c) => c?.kind === kind).length;
        if (n > 0) counts[kind] = n;
    }
    return counts;
}
