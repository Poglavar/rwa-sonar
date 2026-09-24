// The "latest events" feed: one newest-first list of the noteworthy things that happened to the
// tokenized stocks we track, merged from the hourly watchers (sonar.change_event rows), the public
// change journal, the catalogue's first-seen dates, the DeFi scanner, the daily snapshot diffs and
// the lending-market watcher (sonar.lending_liquidation / lending_price_freeze).
// PURE: no fs, no network, no clock. The builder (stocks/build-events.mjs → stocks-events.json) and
// GET /api/events (api/src/routes/events.js) feed it the same kinds of input and get the same
// events, so the static fallback and the live feed cannot disagree. Tested in ../events.test.js.
//
// Every rule below decides one thing: is this a fact a first-time visitor would care about, and if
// so, how is it said in plain words. What is left out is counted per reason (`tally`), so a build
// can say what it excluded rather than silently dropping it.

import { CHANGE_JUDGMENT_JOIN, PUBLIC_CHANGE_CONDITION } from '../../api/src/lib/evidence.js';
import { CHANGE_KIND_LABELS } from './changes.mjs';
import { canonicalIssuer } from './change-journal.mjs';
import { resolutionForEvent } from './event-resolutions.mjs';
import fmt from './fmt.js';

const { DAY_MS, HOUR_MS, MINUTE_MS, MONTHS, mintSuffix } = fmt;

/** How far back the feed reaches, and how many events it keeps at most. */
export const WINDOW_DAYS = 30;
export const MAX_EVENTS = 200;
/** Titles are one line on a phone-width ticker row. */
export const TITLE_MAX = 90;
/** A pool-liquidity collapse is only news on a token that had real liquidity to lose (USD). */
export const LIQUIDITY_COLLAPSE_FLOOR_USD = 100000;
/** A mint created this long before we first saw it was not new when we saw it. */
export const PREDATES_MS = 2 * DAY_MS;

export const CATEGORIES = ['catalogue', 'terms', 'keys', 'defi', 'lending', 'market', 'legal'];
export const SOURCES = {
    documents: 'document watcher',
    chain: 'chain watcher',
    catalogue: 'catalogue',
    defi: 'DeFi scanner',
    court: 'court watcher',
    journal: 'change journal',
    lending: 'lending watcher'
};
/** A token's liquidations in one market on one day are news from this much collateral (USD)… */
export const LIQUIDATION_FLOOR_USD = 1000;
/** …or from this many liquidations, when no price is known for them. */
export const LIQUIDATION_FLOOR_COUNT = 3;
/** This many liquidations at one protocol within LIQUIDATION_WAVE_MS is a wave, told as one event. */
export const LIQUIDATION_WAVE_MIN = 5;
export const LIQUIDATION_WAVE_MS = HOUR_MS;
/** A collateral price freeze is news from this length; shorter ones are keeper hiccups. */
export const FREEZE_FLOOR_MS = 20 * MINUTE_MS;
/** Freezes that start this close together (any market, any token) are one event. */
export const FREEZE_CLUSTER_MS = 15 * MINUTE_MS;

/** Which source's wording wins when two report the same fact: curated first, then the watchers. */
const SOURCE_PRIORITY = {
    [SOURCES.journal]: 5, [SOURCES.chain]: 4, [SOURCES.documents]: 3, [SOURCES.court]: 3, [SOURCES.lending]: 3,
    [SOURCES.defi]: 2, [SOURCES.catalogue]: 1
};
const SEVERITY_RANK = { info: 0, caution: 1, warning: 2, critical: 3 };
/** Two reports of one document change can be days apart (a curated entry is reviewed later). */
const SAME_FACT_MS = { doc: 7 * DAY_MS, other: 36 * HOUR_MS };

/** The change_event kinds the feed can use; everything else (supply, treasury, metadata) is routine. */
export const CHANGE_ROW_KINDS = ['authority-key', 'extension-toggle', 'rebase', 'litigation', 'quote-lost', 'document-gone', 'legal-term'];
const DOC_KINDS = new Set(['quote-lost', 'document-gone', 'legal-term']);

/** DeFi uses that change what a holder can do with the token; DEX pool listings churn daily. */
const DEFI_USES = {
    lending: 'lending', 'yield-vault': 'vaults', 'vault-strategy': 'vaults', structured: 'yield markets', perps: 'perps collateral'
};

/** Public journal kinds → feed category; anything unlisted is an issuer document or disclosure (terms). */
const JOURNAL_CATEGORY = {
    'fee-change': 'keys', governance: 'keys', pause: 'keys', 'authority-change': 'keys',
    rebase: 'market', split: 'market', shortfall: 'market', sector: 'market',
    'wind-down': 'legal', litigation: 'legal'
};

const AUTHORITY_LABELS = {
    mint_authority: 'mint authority',
    freeze_authority: 'freeze authority',
    permanent_delegate: 'permanent delegate',
    fee_config_authority: 'transfer-fee authority',
    withdraw_withheld_authority: 'fee-withdrawal authority',
    hook_authority: 'transfer-hook authority',
    ui_multiplier_authority: 'balance-multiplier authority',
    metadata_update_authority: 'metadata authority',
    hook_program: 'transfer-hook program'
};

/** Snapshot control flags (lib/changes.mjs CONTROL_FLAGS) in words, with their article. */
const CONTROL_FLAG_WORDS = {
    pausable: ['a', 'pause switch'],
    clawback: ['a', 'clawback power'],
    allowlist: ['an', 'allowlist'],
    hookActive: ['a', 'transfer hook']
};

// --- small helpers ---------------------------------------------------------------------------

function text(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function num(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string' || !value.trim()) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function note(tally, reason, n = 1) {
    if (tally && n > 0) tally[reason] = (tally[reason] ?? 0) + n;
}

function slugPart(value) {
    return String(value ?? 'none').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'none';
}

function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function maxSeverity(values) {
    let best = 'info';
    for (const value of values) if ((SEVERITY_RANK[value] ?? -1) > SEVERITY_RANK[best]) best = value;
    return best;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A source's own time as ISO UTC: an instant to the second (`…Z`), or a bare `YYYY-MM-DD` kept as a
 * date — a day-precision source is never given an invented time of day. Null for anything else.
 */
export function eventTime(value) {
    if (value instanceof Date) {
        return Number.isFinite(value.getTime()) ? value.toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
    }
    const raw = text(value);
    if (raw === null) return null;
    if (DATE_ONLY.test(raw)) return Number.isFinite(Date.parse(`${raw}T00:00:00Z`)) ? raw : null;
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(raw)) return null;
    // psql prints a timestamptz as `2026-09-24 14:07:04+00`, which Date.parse does not take.
    const ms = Date.parse(raw.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
    return Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
}

/** Epoch ms of an event time; a bare date counts as its midnight UTC (the earliest it can be). */
export function timeMs(at) {
    const value = eventTime(at);
    if (value === null) return null;
    return Date.parse(DATE_ONLY.test(value) ? `${value}T00:00:00Z` : value);
}

export function isDateOnly(at) {
    return typeof at === 'string' && DATE_ONLY.test(at);
}

function newest(times) {
    let best = null;
    for (const at of times) {
        const t = timeMs(at);
        if (t !== null && (best === null || t > best.t)) best = { t, at: eventTime(at) };
    }
    return best?.at ?? null;
}

/** One line, at most `max` characters, cut at a word with an ellipsis. */
export function clipTitle(value, max = TITLE_MAX) {
    const line = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (line.length <= max) return line;
    const cut = line.slice(0, max - 1);
    const space = cut.lastIndexOf(' ');
    return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:·—–-]+$/, '')}…`;
}

/** `head (A, B, …)` with as many names as fit in a title. */
function withNames(head, names, max = TITLE_MAX) {
    const list = names.filter(Boolean);
    for (let n = list.length; n >= 1; n -= 1) {
        const candidate = `${head} (${list.slice(0, n).join(', ')}${n < list.length ? ', …' : ''})`;
        if (candidate.length <= max) return candidate;
    }
    return clipTitle(head, max);
}

function usd(value) {
    if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
    if (value >= 1e3) return `$${Math.round(value / 1e3)}k`;
    return `$${Math.round(value)}`;
}

function bpsText(bps) {
    const pct = bps / 100;
    return `${Number.isInteger(pct) ? pct : pct.toFixed(2).replace(/0$/, '')} %`;
}

// --- context -----------------------------------------------------------------------------------

function asObject(value) {
    if (value instanceof Map) return Object.fromEntries(value);
    return value && typeof value === 'object' ? { ...value } : {};
}

/**
 * What the rules need to name and link things: issuer slug → display name, mint → card slug,
 * `mint|protocol` → protocol dossier slug, mint → creation-time record (stocks/data/mint-created.json),
 * the first day the catalogue was recorded (left-censoring: on that day everything was "new") and the
 * editorial resolutions of watcher events (stocks/data/event-resolutions.json `items`).
 */
export function eventContext({ issuerNames = {}, cardSlugs = {}, protocolPages = {}, mintCreated = {}, recordsBeginOn = null, resolutions = [] } = {}) {
    return {
        issuerNames: asObject(issuerNames),
        cardSlugs: asObject(cardSlugs),
        protocolPages: asObject(protocolPages),
        mintCreated: asObject(mintCreated),
        recordsBeginOn: text(recordsBeginOn),
        resolutions: Array.isArray(resolutions) ? resolutions : []
    };
}

/** The canonical issuer (a programme slug like backpack-securities-spcx maps to its dossier) and its name. */
function issuerOf(slug, ctx) {
    const canonical = canonicalIssuer(slug, ctx.issuerNames);
    return { slug: canonical ?? text(slug), name: canonical === null ? null : text(ctx.issuerNames[canonical]), known: canonical !== null };
}

function issuerHref(issuer) {
    return issuer.known && /^[a-z0-9-]+$/.test(issuer.slug) ? `./issuers/${issuer.slug}.html` : null;
}

/** A card link only from a known builder slug — a symbol alone can collide with another token's card. */
function cardHref(mint, ctx, explicit = null) {
    const slug = text(explicit) ?? text(ctx.cardSlugs[mint]);
    return slug && fmt.SLUG_SAFE.test(slug) ? `./cards/${encodeURIComponent(slug)}.html` : null;
}

function symbolOf(symbol, mint) {
    return text(symbol) ?? (text(mint) ? `token …${mintSuffix(mint)}` : 'a token');
}

function makeEvent({ id, at, kind, category, title, subject, severity, href, source, keys = [], origin, assessment = null, ongoing = false }) {
    const event = {
        id, at, kind, category, title: clipTitle(title), subject,
        severity: SEVERITY_RANK[severity] === undefined ? 'info' : severity,
        href: href ?? './watch.html',
        source
    };
    if (assessment) event.assessment = assessment;
    if (ongoing) event.ongoing = true;
    event.keys = [...new Set(keys.filter(Boolean))];
    event.origin = origin;
    return event;
}

/** Who acted and on what, for a group of token-level changes by one issuer. */
function actorAndTarget(issuer, symbols) {
    const n = symbols.length;
    return {
        who: issuer.name ?? (n === 1 ? symbols[0] : 'The issuer'),
        target: n === 1 ? symbols[0] : plural(n, 'token'),
        on: n === 1 ? ` of ${symbols[0]}` : ` on ${plural(n, 'token')}`
    };
}

// --- catalogue: tokens first seen --------------------------------------------------------------

/**
 * What the creation-time record says about a mint first seen at `firstSeenAt`: `created` (it was
 * made within PREDATES_MS before we saw it), `predates` (it existed well before), or null (unknown).
 */
export function creationVerdict(record, firstSeenAt) {
    const seen = timeMs(firstSeenAt);
    if (!record || seen === null) return null;
    const created = timeMs(record.createdAt);
    if (created !== null) return created < seen - PREDATES_MS ? { verdict: 'predates' } : { verdict: 'created', at: eventTime(record.createdAt) };
    const before = timeMs(record.createdBefore);
    if (before !== null && before < seen - PREDATES_MS) return { verdict: 'predates' };
    return null;
}

/**
 * New tokens, one event per issuer per UTC day of first sight. The founding cohort (first seen on or
 * before the first recorded day) is left out: for those, "first seen" is when records began. The
 * creation record decides the words and whether it is news at all: mints whose own oldest
 * transaction falls just before first sight were "created"; a batch in which a checked mint existed
 * long before we saw it is the catalogue catching up with old tokens (left out, with the unchecked
 * rest of that batch); a batch nobody has checked yet stays "first seen".
 */
export function catalogueEvents(tokens, ctx, tally = null) {
    const groups = new Map();
    for (const token of Array.isArray(tokens) ? tokens : []) {
        const mint = text(token?.mint);
        const seen = eventTime(token?.firstSeenAt);
        if (mint === null) continue;
        if (seen === null || isDateOnly(seen)) {
            note(tally, 'catalogue: token without a first-seen time');
            continue;
        }
        if (ctx.recordsBeginOn !== null && seen.slice(0, 10) <= ctx.recordsBeginOn) {
            note(tally, 'catalogue: founding cohort (first seen the day records began)');
            continue;
        }
        const issuer = issuerOf(token.issuer, ctx);
        const key = `${issuer.slug ?? 'unknown'}|${seen.slice(0, 10)}`;
        if (!groups.has(key)) groups.set(key, { issuer, day: seen.slice(0, 10), members: [] });
        const verdict = creationVerdict(ctx.mintCreated[mint], seen);
        groups.get(key).members.push({ mint, symbol: symbolOf(token.symbol, mint), seen, cardSlug: text(token.cardSlug), verdict });
    }
    const out = [];
    for (const { issuer, day, members } of groups.values()) {
        const older = members.filter((m) => m.verdict?.verdict === 'predates');
        const created = members.filter((m) => m.verdict?.verdict === 'created');
        let shown = members;
        let kind = 'tokens-first-seen';
        if (older.length > 0) {
            note(tally, 'catalogue: existing tokens newly catalogued (created long before first sight)', older.length);
            note(tally, 'catalogue: unchecked tokens catalogued in the same batch as an older one', members.length - older.length - created.length);
            if (created.length === 0) continue;
            shown = created;
            kind = 'tokens-created';
        } else if (created.length === members.length) {
            kind = 'tokens-created';
        }
        shown.sort((a, b) => timeMs(b.seen) - timeMs(a.seen) || (a.mint < b.mint ? -1 : 1));
        const n = shown.length;
        const symbols = shown.map((m) => m.symbol);
        const name = issuer.name ?? 'An unlisted issuer';
        const title = kind === 'tokens-created'
            ? (n === 1 ? `${name} created a new token, ${symbols[0]}` : withNames(`${name} created ${n} new tokens`, symbols))
            : (n === 1 ? `${name}: new token ${symbols[0]} first seen` : withNames(`${name}: ${n} new tokens first seen`, symbols));
        const single = n === 1 ? shown[0] : null;
        out.push(makeEvent({
            id: `catalogue-${slugPart(issuer.slug)}-${day}`,
            at: newest(shown.map((m) => (kind === 'tokens-created' ? m.verdict.at : m.seen))),
            kind, category: 'catalogue', title,
            subject: single ? { type: 'token', id: single.mint, name: single.symbol } : { type: 'issuer', id: issuer.slug, name },
            severity: 'info',
            href: (single ? cardHref(single.mint, ctx, single.cardSlug) : null) ?? issuerHref(issuer) ?? './stocks.html',
            source: SOURCES.catalogue,
            keys: [`catalogue|${issuer.slug}|${day}`],
            origin: 'file'
        }));
    }
    return out;
}

// --- the public change journal -----------------------------------------------------------------

/** A journal title, unless it is the generic "Issuer: kind" form, which says nothing a row can use. */
function journalTitle(item) {
    const title = text(item.title);
    const generic = title !== null && /^[^:]{1,60}: [a-z][a-z -]*$/.test(title);
    if (title !== null && !generic) return clipTitle(title);
    const summary = text(item.summary);
    if (summary !== null) return clipTitle(summary.split(/(?<=[.;])\s/)[0].replace(/[.;]$/, ''));
    return clipTitle(title ?? 'Recorded change');
}

/** The same URL, however it was cited: no scheme, no www, no fragment, no trailing slash, no Wayback wrapper. */
export function docKey(url) {
    const raw = text(url);
    if (raw === null) return null;
    try {
        const u = new URL(raw.replace(/^https?:\/\/web\.archive\.org\/web\/[^/]+\//, ''));
        const path = u.pathname.replace(/\/+$/, '');
        return `doc|${u.hostname.toLowerCase().replace(/^www\./, '')}${path}${u.search}`;
    } catch {
        return null;
    }
}

function journalKeys(item, issuerSlug) {
    const keys = [];
    const kind = item.kind;
    if (kind === 'fee-change') keys.push(`fee|${issuerSlug}`);
    if (kind === 'governance' || kind === 'authority-change') keys.push(`authority|${issuerSlug}`);
    if (kind === 'pause') keys.push(`pause|${issuerSlug}|true`);
    if (kind === 'rebase' || kind === 'split') {
        for (const asset of Array.isArray(item.assets) ? item.assets : []) if (text(asset?.mint)) keys.push(`split|${asset.mint}`);
    }
    for (const source of Array.isArray(item.sources) ? item.sources : []) keys.push(docKey(source?.url));
    return keys;
}

/**
 * The curated journal's external changes. Left out: catalogue additions (the token first-seen
 * rule says them with times), DEX/protocol listing rows (the DeFi scanner rule), the first day of
 * records (baseline research, not change), and a document that only moved with its content intact.
 * Docs-versus-chain findings are grouped per protocol per day. `observations` maps a journal id to
 * the earliest detection time of the watcher events its resolution covers (resolvedObservations).
 */
export function journalEvents(items, ctx, tally = null, observations = new Map()) {
    const out = [];
    const findings = new Map();
    for (const item of Array.isArray(items) ? items : []) {
        const id = text(item?.id);
        if (id === null) continue;
        const dated = eventTime(item.effectiveAt) ?? eventTime(item.eventAt) ?? eventTime(item.firstObservedAt) ?? eventTime(item.date);
        // An entry dated only to the day takes the watcher's own detection time of the event it resolves.
        const observed = observations.get(id) ?? null;
        const at = dated !== null && isDateOnly(dated) && observed !== null && observed.slice(0, 10) <= dated ? observed : dated;
        if (at === null) {
            note(tally, 'journal: undated entry');
            continue;
        }
        if (item.category === 'catalogue') {
            note(tally, 'journal: catalogue additions (shown from token first-seen times)');
            continue;
        }
        if (item.category === 'protocol-change' && item.kind !== 'docs-vs-chain') {
            note(tally, 'journal: protocol listing changes (shown from the DeFi scanner)');
            continue;
        }
        if (ctx.recordsBeginOn !== null && at.slice(0, 10) <= ctx.recordsBeginOn) {
            note(tally, 'journal: baseline research from the day records began');
            continue;
        }
        if (item.kind === 'document-moved' && (text(item.severity) ?? 'info') === 'info') {
            note(tally, 'journal: document moved with its content intact');
            continue;
        }
        if (item.kind === 'docs-vs-chain') {
            const actor = text(item.actor) ?? 'A protocol';
            const key = `${actor}|${at.slice(0, 10)}`;
            if (!findings.has(key)) findings.set(key, { actor, day: at.slice(0, 10), items: [] });
            findings.get(key).items.push({ ...item, at });
            continue;
        }
        const issuer = issuerOf(item.issuer, ctx);
        const href = text(item.href);
        out.push(makeEvent({
            id: `journal-${slugPart(id)}`,
            at,
            kind: text(item.kind) ?? 'change',
            category: JOURNAL_CATEGORY[item.kind] ?? 'terms',
            title: journalTitle(item),
            subject: issuer.slug ? { type: 'issuer', id: issuer.slug, name: issuer.name ?? text(item.actor) } : { type: 'other', id, name: text(item.actor) },
            severity: text(item.severity) ?? 'info',
            href: (href && href.startsWith('./') ? href : null) ?? issuerHref(issuer),
            source: SOURCES.journal,
            keys: journalKeys(item, issuer.slug),
            origin: 'file'
        }));
    }
    for (const { actor, day, items: group } of findings.values()) {
        const n = group.length;
        const href = group.map((row) => text(row.href)).find((h) => h && h.startsWith('./')) ?? './watch.html';
        out.push(makeEvent({
            id: `journal-docs-vs-chain-${slugPart(actor)}-${day}`,
            at: newest(group.map((row) => row.at)),
            kind: 'docs-vs-chain',
            category: group[0].category === 'protocol-change' ? 'defi' : 'terms',
            title: n === 1 ? `${actor}: its docs and its on-chain setup disagree` : `${actor}: its docs and its on-chain setup disagree on ${n} points`,
            subject: { type: 'protocol', id: slugPart(actor), name: actor },
            severity: maxSeverity(group.map((row) => row.severity)),
            href,
            source: SOURCES.journal,
            keys: group.flatMap((row) => (Array.isArray(row.sources) ? row.sources : []).map((s) => docKey(s?.url))),
            origin: 'file'
        }));
    }
    return out;
}

// --- watcher rows (sonar.change_event) ---------------------------------------------------------

function parseJson(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string') return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

/**
 * One change_event row in either shape it arrives in: the SQL below (snake_case plus judgment_*),
 * or an /api/changes item (with a nested `modelAssessment`). Unknown fields stay null.
 */
export function normaliseChangeRow(row) {
    const evidence = parseJson(row?.evidence) ?? {};
    const nested = row?.modelAssessment && typeof row.modelAssessment === 'object' ? row.modelAssessment : null;
    const status = text(row?.judgment_status) ?? text(nested?.status);
    const material = typeof row?.judgment_material === 'boolean' ? row.judgment_material
        : typeof nested?.material === 'boolean' ? nested.material : null;
    return {
        id: row?.id === null || row?.id === undefined ? null : String(row.id),
        at: eventTime(row?.detected_at),
        kind: text(row?.kind),
        subjectType: text(row?.subject_type),
        subjectId: text(row?.subject_id),
        issuer: text(row?.issuer_slug) ?? text(evidence.issuer),
        field: text(row?.field),
        before: row?.before === null || row?.before === undefined ? null : String(row.before),
        after: row?.after === null || row?.after === undefined ? null : String(row.after),
        severity: text(row?.severity) ?? 'info',
        evidence,
        symbol: text(row?.token_symbol) ?? text(evidence.symbol),
        cardSlug: text(row?.token_card_slug),
        // The mint's transfer-fee cap at the reading (changeRowsSelect joins it for fee rows only).
        feeMax: text(row?.transfer_fee_max) ?? (num(row?.transfer_fee_max) === null ? null : String(row.transfer_fee_max)),
        sourceUrl: text(row?.source_url) ?? text(evidence.url),
        sourceTitle: text(row?.source_title),
        sourceKind: text(row?.source_kind),
        judgment: status === null ? null : {
            status,
            material,
            severity: text(row?.judgment_severity) ?? text(nested?.severity)
        }
    };
}

function splitPhrase(ratio) {
    if (!(ratio > 0)) return null;
    if (ratio >= 1) {
        const k = Math.round(ratio);
        return k >= 2 && Math.abs(ratio - k) < 0.001 ? `${k}-for-1 split` : null;
    }
    const k = Math.round(1 / ratio);
    return k >= 2 && Math.abs(1 / ratio - k) < 0.001 ? `1-for-${k} reverse split` : null;
}

function restatementTitle(symbol, before, after) {
    const a = num(before);
    const b = num(after);
    const ratio = a !== null && b !== null && a !== 0 ? b / a : null;
    const phrase = splitPhrase(ratio);
    if (phrase !== null) return { kind: ratio >= 1 ? 'split' : 'reverse-split', title: `${symbol}: ${phrase} applied to every balance` };
    const shown = ratio === null ? '' : ` ×${Number(ratio.toPrecision(3))}`;
    return { kind: 'restatement', title: `${symbol}: every balance restated${shown} without a transfer` };
}

/** A rebase row is news only when the chain watcher graded it warning or worse (≥ ×1.05 or ≤ ×0.5). */
function rebaseEvent(row, ctx, tally) {
    if (row.severity !== 'warning' && row.severity !== 'critical') {
        note(tally, 'chain watcher: routine balance-multiplier updates');
        return null;
    }
    if (row.field !== 'ui_multiplier' && row.field !== 'ui_multiplier_next' && row.field !== 'decimals') {
        note(tally, 'chain watcher: multiplier schedule dates');
        return null;
    }
    const mint = row.subjectId;
    const symbol = symbolOf(row.symbol, mint);
    const issuer = issuerOf(row.issuer, ctx);
    let kind;
    let title;
    if (row.field === 'decimals') {
        kind = 'redenomination';
        title = `${symbol}: decimals changed from ${row.before} to ${row.after}, every balance re-denominated`;
    } else if (row.field === 'ui_multiplier') {
        ({ kind, title } = restatementTitle(symbol, row.before, row.after));
    } else {
        const a = num(row.before);
        const b = num(row.after);
        const phrase = splitPhrase(a !== null && b !== null && a !== 0 ? b / a : null);
        kind = 'split-scheduled';
        title = `${symbol}: ${phrase ?? 'a balance restatement'} scheduled by the issuer`;
    }
    return makeEvent({
        id: `chain-${slugPart(kind)}-${slugPart(mint)}-${row.id}`,
        at: row.at, kind, category: 'market', title,
        subject: { type: 'token', id: mint, name: symbol },
        severity: row.severity,
        href: cardHref(mint, ctx, row.cardSlug) ?? issuerHref(issuer),
        source: SOURCES.chain,
        keys: [`split|${mint}`],
        origin: 'db'
    });
}

// --- transfer fees: scheduled or in force ------------------------------------------------------

/** Solana mainnet epochs are 432 000 slots with no warm-up, so a slot's epoch is exact. */
const SLOTS_PER_EPOCH = 432000;
/** Nominal slot time, used only for the "about <day>" a future epoch starts on. */
const SLOT_MS = 400;
/** Token-2022 puts a newly set transfer fee in force two epochs after the epoch it was set in. */
const FEE_DELAY_EPOCHS = 2;
/** A maximum fee at u64::MAX (stored as 2^64 after a float round-trip) is no cap at all. */
const UNCAPPED_FEE = 1.8e19;

/**
 * When the fee a transfer_fee_bps row reports takes effect, relative to the reading. The chain
 * watcher records Token-2022's NEWER fee, which a fee authority sets two epochs ahead, so a change
 * it sees is usually scheduled, not yet charged. The new fee's epoch is the one the watcher
 * recorded (evidence.transferFee.newerEpoch, from 2026-09-25) or, for an older row, inferred: when
 * the two readings sit in one epoch the fee was set in it, so it starts two epochs later. Readings
 * in different epochs still prove "scheduled" while the reading is before the earliest possible
 * start. `unknown` when the row carries no slot.
 */
function feeSchedule(row) {
    const ev = row.evidence ?? {};
    const slot = num(ev.slot);
    if (slot === null) return { state: 'unknown' };
    const epoch = Math.floor(slot / SLOTS_PER_EPOCH);
    const previous = num(ev.previousSlot);
    const previousEpoch = previous === null ? null : Math.floor(previous / SLOTS_PER_EPOCH);
    const newer = num(ev.transferFee?.newerEpoch) ?? (previousEpoch === epoch ? epoch + FEE_DELAY_EPOCHS : null);
    if (newer !== null && newer <= epoch) return { state: 'in-effect', epoch: newer };
    if (newer !== null) {
        const observed = timeMs(text(ev.observedAt) ?? row.at);
        return { state: 'scheduled', epoch: newer, startsMs: observed === null ? null : observed + (newer * SLOTS_PER_EPOCH - slot) * SLOT_MS };
    }
    if (previousEpoch !== null && epoch < previousEpoch + FEE_DELAY_EPOCHS) return { state: 'scheduled', epoch: null, startsMs: null };
    return { state: 'unknown' };
}

/** The group's shared schedule: one state for every member, the epoch only when they all agree. */
function groupFeeSchedule(members) {
    const all = members.map(feeSchedule);
    const state = all.every((s) => s.state === all[0].state) ? all[0].state : 'unknown';
    const epochs = new Set(all.map((s) => s.epoch ?? null));
    const epoch = state === 'scheduled' && epochs.size === 1 ? all[0].epoch : null;
    return { state, epoch, startsMs: epoch === null ? null : all.find((s) => s.startsMs !== null)?.startsMs ?? null };
}

/** " (no cap)" when every member's maximum fee is u64::MAX; nothing when the cap is unknown or real. */
function feeCapText(members) {
    const caps = members.map((m) => num(m.evidence?.transferFee?.maximumFee) ?? num(m.feeMax));
    return caps.length > 0 && caps.every((c) => c !== null && c >= UNCAPPED_FEE) ? ' (no cap)' : '';
}

/**
 * The title of a transfer-fee change: "scheduled" while the new fee is still ahead of the reading
 * (with its epoch and approximate day when known), "raised/lowered" once it applies, and "set …"
 * when the rows cannot tell. The longest wording that fits TITLE_MAX wins.
 */
function transferFeeTitle(members, { who, symbols, on }) {
    const first = members[0];
    const a = num(first.before);
    const b = num(first.after);
    if (a === null && b !== null) return `${who} set a ${bpsText(b)} transfer fee${on}`;
    if (b === null) return `${who} removed the transfer fee${on}`;
    const schedule = groupFeeSchedule(members);
    const cap = feeCapText(members);
    const target = symbols.length === 1 ? ` on ${symbols[0]}` : ` on ${plural(symbols.length, 'token')}`;
    if (schedule.state === 'scheduled') {
        const day = schedule.startsMs === null ? null : dayText(new Date(schedule.startsMs).toISOString());
        const when = schedule.epoch === null ? '' : ` from epoch ${schedule.epoch}${day ? `, about ${day}` : ''}`;
        const candidates = [
            `${who} scheduled its transfer fee to ${b > a ? 'rise' : 'fall'} from ${bpsText(a)} to ${bpsText(b)}${cap}${target}${when}`,
            `${who} scheduled a ${bpsText(a)} → ${bpsText(b)} transfer fee${cap}${target}${when}`,
            ...(day ? [`${who} scheduled a ${bpsText(a)} → ${bpsText(b)} transfer fee${cap}${target} from about ${day}`] : [])
        ];
        return candidates.find((c) => c.length <= TITLE_MAX) ?? candidates.at(-1);
    }
    if (schedule.state === 'in-effect') return `${who} ${b > a ? 'raised' : 'lowered'} the transfer fee${on} from ${bpsText(a)} to ${bpsText(b)}${cap}`;
    return `${who} set a ${bpsText(b)} transfer fee${target}, ${b > a ? 'up' : 'down'} from ${bpsText(a)}`;
}

/** Authority and extension changes, grouped per issuer, day, field and before→after. */
function chainGroupEvent(members, ctx) {
    const first = members[0];
    const issuer = issuerOf(first.issuer, ctx);
    const symbols = [...new Set(members.map((m) => symbolOf(m.symbol, m.subjectId)))].sort();
    const n = symbols.length;
    const { who, target, on } = actorAndTarget(issuer, symbols);
    const field = first.field;
    let kind = 'extension-change';
    let title;
    let severity = maxSeverity(members.map((m) => m.severity));
    let keys = [];
    if (first.kind === 'authority-key') {
        kind = 'authority-change';
        const label = AUTHORITY_LABELS[field] ?? field.replaceAll('_', ' ');
        const verb = first.after === null ? 'removed the' : first.before === null ? 'set a' : 'changed the';
        title = `${who} ${verb} ${label}${on}`;
        keys = [`authority|${issuer.slug}`];
    } else if (field === 'paused') {
        const paused = first.after === 'true';
        kind = paused ? 'pause' : 'unpause';
        title = `${who} ${paused ? 'paused' : 'unpaused'} ${target}`;
        if (!paused) severity = 'info';
        keys = [`pause|${issuer.slug}|${paused}`];
    } else if (field === 'transfer_fee_bps') {
        kind = 'transfer-fee';
        title = transferFeeTitle(members, { who, symbols, on });
        keys = [`fee|${issuer.slug}`];
    } else if (field === 'default_frozen') {
        title = first.after === 'true' ? `${who} made new accounts start frozen${on}` : `${who} stopped freezing new accounts${on}`;
    } else if (field === 'pausable') {
        title = first.after === 'true' ? `${who} added a pause switch to ${target}` : `${who} removed the pause switch from ${target}`;
        keys = [`ctl|${issuer.slug}|pausable|${first.after === 'true'}`];
    } else if (field === 'hook_program') {
        const on2 = first.after !== null;
        title = `${who} switched ${on2 ? 'on' : 'off'} a transfer hook${on}`;
        keys = [`ctl|${issuer.slug}|hookActive|${on2}`];
    } else {
        title = `${who} changed the ${field.replaceAll('_', ' ')} setting${on}`;
    }
    const day = first.at.slice(0, 10);
    return makeEvent({
        id: `chain-${slugPart(field)}-${slugPart(issuer.slug ?? first.subjectId)}-${day}-${slugPart(first.before).slice(0, 12)}-${slugPart(first.after).slice(0, 12)}`,
        at: newest(members.map((m) => m.at)),
        kind, category: 'keys',
        title: n > 1 && !title.includes('(') ? withNames(title, symbols) : title,
        subject: n === 1 ? { type: 'token', id: first.subjectId, name: symbols[0] } : { type: 'issuer', id: issuer.slug, name: issuer.name },
        severity,
        href: (n === 1 ? cardHref(first.subjectId, ctx, first.cardSlug) : null) ?? issuerHref(issuer),
        source: SOURCES.chain,
        keys,
        origin: 'db'
    });
}

function courtEvent(row, ctx) {
    const issuer = issuerOf(row.subjectType === 'issuer' ? row.subjectId : row.issuer, ctx);
    const party = text(row.evidence.query);
    const verb = row.evidence.matchLevel === 'text' ? 'mentions' : 'names';
    const who = party === null ? (issuer.name ?? 'a tracked issuer')
        : `${party}${issuer.name && !party.toLowerCase().includes(issuer.name.toLowerCase()) ? ` (${issuer.name})` : ''}`;
    const tail = ` ${verb} ${who}`;
    const caseName = clipTitle(text(row.after) ?? 'A new court case', Math.max(30, TITLE_MAX - tail.length));
    return makeEvent({
        id: `court-${row.id}`,
        at: row.at, kind: 'court-case', category: 'legal',
        title: `${caseName}${tail}`,
        subject: { type: 'issuer', id: issuer.slug, name: issuer.name },
        severity: row.severity,
        href: issuerHref(issuer) ?? './watch.html',
        source: SOURCES.court,
        keys: [`court|${row.field}|${issuer.slug}`],
        origin: 'db'
    });
}

function reviewedResolution(raw, ctx) {
    if (ctx.resolutions.length === 0) return null;
    const evidence = parseJson(raw?.evidence) ?? {};
    return resolutionForEvent({ ...raw, evidence, issuer_slug: text(raw?.issuer_slug) ?? text(evidence.issuer) }, ctx.resolutions);
}

/**
 * Journal id → the earliest detection time of the watcher rows its public resolution covers, so a
 * journal entry dated only to the day can carry the watcher's own time of the same observation.
 */
export function resolvedObservations(rows, ctx) {
    const out = new Map();
    for (const raw of Array.isArray(rows) ? rows : []) {
        const resolution = reviewedResolution(raw, ctx);
        const at = eventTime(raw?.detected_at);
        if (resolution?.public !== true || !text(resolution.id) || at === null || isDateOnly(at)) continue;
        const held = out.get(resolution.id);
        if (held === undefined || timeMs(at) < timeMs(held)) out.set(resolution.id, at);
    }
    return out;
}

/**
 * Watcher rows → events. A row the editorial review already decided is never shown on its own: a
 * public resolution is the journal entry that says it better, anything else was a false alarm or
 * our own re-read. Chain: key and extension changes (grouped), and balance restatements the chain
 * watcher graded warning or worse; supply, treasury and metadata moves are routine. Court: every new
 * docket. Documents: only through their reviewed change-journal entry.
 */
export function changeRowEvents(rows, ctx, tally = null) {
    const out = [];
    const chainGroups = new Map();
    for (const raw of Array.isArray(rows) ? rows : []) {
        const row = normaliseChangeRow(raw);
        if (row.id === null || row.at === null || isDateOnly(row.at)) {
            note(tally, 'watcher: row without an id or a detection time');
            continue;
        }
        const resolution = reviewedResolution(raw, ctx);
        if (resolution !== null) {
            note(tally, resolution.public === true ? 'review: reported by its change journal entry'
                : 'review: resolved as a false alarm or our own re-read, not an external change');
            continue;
        }
        if (row.kind === 'authority-key' || row.kind === 'extension-toggle') {
            const issuerSlug = issuerOf(row.issuer, ctx).slug ?? row.subjectId;
            const key = [row.kind, issuerSlug, row.at.slice(0, 10), row.field, row.before, row.after].join('|');
            if (!chainGroups.has(key)) chainGroups.set(key, []);
            chainGroups.get(key).push(row);
        } else if (row.kind === 'rebase') {
            const event = rebaseEvent(row, ctx, tally);
            if (event) out.push(event);
        } else if (row.kind === 'litigation') {
            out.push(courtEvent(row, ctx));
        } else if (DOC_KINDS.has(row.kind)) {
            // A document row reaches the public feed only through its reviewed change-journal entry
            // (handled above). An unreviewed row stays on the changes page: a lost quote is as often
            // our reader failing (a geoblock page, a binary body, a script-only shell) as the issuer
            // changing a word, and a model's rating cannot tell the two apart reliably.
            note(tally, 'document watcher: not reviewed yet (on the changes page, not in the feed)');
        } else {
            note(tally, `chain watcher: ${row.kind ?? 'unknown'} (routine)`);
        }
    }
    for (const members of chainGroups.values()) out.push(chainGroupEvent(members, ctx));
    return out;
}

// --- DeFi scanner (stocks-defi-new.json) -------------------------------------------------------

function protocolPage(mint, item, ctx) {
    for (const name of [item.protocolName, item.protocolId]) {
        const slug = text(ctx.protocolPages[`${mint}|${String(name ?? '').toLowerCase()}`]);
        if (slug && /^[a-z0-9-]+$/.test(slug)) return `./protocols/${slug}.html`;
    }
    return null;
}

/**
 * Protocol support added or removed for a use that changes what a holder can do (lending, vaults,
 * structured yield, perps collateral), grouped per protocol, direction and day. DEX pool listings
 * churn daily and unconfirmed on-chain holdings are review candidates, so neither is an event.
 */
export function defiEvents(feed, ctx, tally = null) {
    const groups = new Map();
    for (const item of Array.isArray(feed?.items) ? feed.items : []) {
        const change = item?.change;
        const at = eventTime(item?.date);
        const mint = text(item?.mint);
        if ((change !== 'added' && change !== 'removed') || at === null || mint === null) {
            note(tally, 'DeFi scanner: row without a dated addition or removal');
            continue;
        }
        const use = DEFI_USES[item.category];
        if (!use) {
            note(tally, item.category === 'dex' ? 'DeFi scanner: DEX pool listing churn' : `DeFi scanner: ${item.category ?? 'uncategorised'} listings`);
            continue;
        }
        const protocol = text(item.protocolName) ?? text(item.protocolId) ?? 'A protocol';
        const observed = item.basis === 'onchain-position';
        const key = `${protocol}|${change}|${use}|${at}|${observed}`;
        if (!groups.has(key)) groups.set(key, { protocol, change, use, at, observed, category: item.category, items: [] });
        groups.get(key).items.push({ ...item, mint });
    }
    note(tally, 'DeFi scanner: unconfirmed holdings under review', Array.isArray(feed?.candidates) ? feed.candidates.length : 0);
    const out = [];
    for (const group of groups.values()) {
        const symbols = group.items.map((item) => symbolOf(item.symbol, item.mint)).sort();
        const n = symbols.length;
        const added = group.change === 'added';
        const single = n === 1 ? group.items[0] : null;
        // Loans read on-chain are observations: a loan opened or closed, never a listing added or dropped.
        const title = group.observed
            ? (n === 1
                ? (added ? `First ${group.protocol} loan against ${symbols[0]} observed` : `No open ${group.protocol} loan against ${symbols[0]} any more`)
                : withNames(added ? `First ${group.protocol} loans against ${n} tokens observed` : `No open ${group.protocol} loans against ${n} tokens any more`, symbols))
            : n === 1
                ? (added ? `${group.protocol} now lists ${symbols[0]} for ${group.use}` : `${group.protocol} dropped ${symbols[0]} from ${group.use}`)
                : withNames(added ? `${group.protocol} now lists ${n} tokens for ${group.use}` : `${group.protocol} dropped ${n} tokens from ${group.use}`, symbols);
        out.push(makeEvent({
            id: `defi-${slugPart(group.protocol)}-${group.change}-${slugPart(group.category)}${group.observed ? '-loans' : ''}-${group.at}`,
            at: group.at,
            kind: added ? 'defi-added' : 'defi-removed',
            category: 'defi', title,
            subject: single ? { type: 'token', id: single.mint, name: symbols[0] } : { type: 'protocol', id: slugPart(group.protocol), name: group.protocol },
            severity: maxSeverity(group.items.map((item) => item.severity ?? (added ? 'info' : 'warning'))),
            href: single ? (protocolPage(single.mint, single, ctx) ?? cardHref(single.mint, ctx, single.cardSlug) ?? './monitor.html#defiChangesSection')
                : './monitor.html#defiChangesSection',
            source: SOURCES.defi,
            keys: [`defi|${slugPart(group.protocol)}|${group.change}|${group.items.map((item) => item.mint).sort().join(',')}`],
            origin: 'file'
        }));
    }
    return out;
}

// --- lending markets (sonar.lending_liquidation / lending_price_freeze) -------------------------

const PROTOCOL_LABELS = { kamino: 'Kamino', 'jupiter-lend': 'Jupiter Lend', nest: 'Nest', loopscale: 'Loopscale' };
/** A market other than the protocol's main stock market is named, so two same-day groups read apart. */
const MARKET_LABELS = { 'kamino:sentora-xstocks-market': 'Kamino (Sentora market)' };

function protocolLabel(protocol) {
    return PROTOCOL_LABELS[protocol] ?? text(protocol) ?? 'A lending market';
}

function lendingPage(mint, protocol, ctx) {
    const slug = text(ctx.protocolPages[`${mint}|${protocolLabel(protocol).toLowerCase()}`]);
    return slug && /^[a-z0-9-]+$/.test(slug) ? `./protocols/${slug}.html` : null;
}

/**
 * Where a lending event links: the token card's "When the market is closed" section, which names
 * each lending market with its liquidation LTV and recent freezes. The protocol dossier (the
 * fallback when no card is known) describes the market but mentions neither freezes nor liquidations.
 */
function lendingHref(member, protocol, ctx) {
    const card = cardHref(member.mint, ctx, member.cardSlug);
    return (card ? `${card}#closed-market` : null) ?? lendingPage(member.mint, protocol, ctx) ?? './stocks.html';
}

function joinWords(words) {
    if (words.length <= 1) return words[0] ?? '';
    return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

function oneLength(ms) {
    return ms < 90 * MINUTE_MS ? `${Math.max(1, Math.round(ms / MINUTE_MS))} min`
        : ms < 100 * HOUR_MS ? `${Math.round(ms / HOUR_MS)} h` : `${Math.round(ms / DAY_MS)} d`;
}

/** "44 h", "30 min", "3 d"; "24–58 min" when the two ends round apart (and `spread` allows it). */
function lengthText(minMs, maxMs, { spread = 0 } = {}) {
    const lo = oneLength(minMs);
    const hi = oneLength(maxMs);
    if (lo === hi || maxMs - minMs <= spread) return hi;
    const [a, unitA] = lo.split(' ');
    const [b, unitB] = hi.split(' ');
    return unitA === unitB ? `${a}–${b} ${unitB}` : `${lo} to ${hi}`;
}

function dayText(at) {
    const d = new Date(timeMs(at));
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** One liquidation row as the SQL below (or a JSON dump of it) returns it. */
function normaliseLiquidation(row) {
    return {
        signature: text(row?.signature), at: eventTime(row?.block_time), protocol: text(row?.protocol), marketId: text(row?.market_id),
        mint: text(row?.mint), symbol: symbolOf(row?.symbol, row?.mint), cardSlug: text(row?.card_slug),
        amount: num(row?.collateral_amount), usd: num(row?.collateral_usd)
    };
}

function liquidationSum(members) {
    const known = members.filter((m) => m.usd !== null);
    return { usd: known.reduce((sum, m) => sum + m.usd, 0), known: known.length, all: members.length };
}

function collateralText(members) {
    const sum = liquidationSum(members);
    if (sum.known === sum.all && sum.all > 0) return `${usd(sum.usd)} collateral`;
    if (sum.known > 0) return `at least ${usd(sum.usd)} collateral`;
    const symbols = [...new Set(members.map((m) => m.symbol))];
    const amounts = members.map((m) => m.amount).filter((a) => a !== null);
    return symbols.length === 1 && amounts.length === members.length
        ? `${Number(amounts.reduce((a, b) => a + b, 0).toPrecision(3))} ${symbols[0]} collateral` : 'collateral value unknown';
}

/** The densest LIQUIDATION_WAVE_MS window of one protocol's liquidations (time-sorted): [start, end) indexes. */
function densestWindow(list) {
    let best = [0, 0];
    let j = 0;
    for (let i = 0; i < list.length; i += 1) {
        if (j < i) j = i;
        while (j < list.length && timeMs(list[j].at) - timeMs(list[i].at) < LIQUIDATION_WAVE_MS) j += 1;
        if (j - i > best[1] - best[0]) best = [i, j];
    }
    return best;
}

/**
 * Liquidations of stock collateral. A wave (LIQUIDATION_WAVE_MIN or more at one protocol within
 * an hour, any tokens) is one event; the rest are grouped per market, token and UTC day, and a
 * group is news from LIQUIDATION_FLOOR_USD of collateral, or LIQUIDATION_FLOOR_COUNT liquidations
 * when no price is known — a single dust liquidation is not.
 */
export function liquidationEvents(rows, ctx, tally = null) {
    const byProtocol = new Map();
    for (const raw of Array.isArray(rows) ? rows : []) {
        const row = normaliseLiquidation(raw);
        if (row.at === null || isDateOnly(row.at) || row.mint === null || row.protocol === null) {
            note(tally, 'lending watcher: liquidation without a time or a token');
            continue;
        }
        if (!byProtocol.has(row.protocol)) byProtocol.set(row.protocol, []);
        byProtocol.get(row.protocol).push(row);
    }
    const out = [];
    for (const [protocol, all] of byProtocol) {
        let rest = all.slice().sort((a, b) => timeMs(a.at) - timeMs(b.at) || (a.signature < b.signature ? -1 : 1));
        const who = protocolLabel(protocol);
        for (;;) {
            const [i, j] = densestWindow(rest);
            if (j - i < LIQUIDATION_WAVE_MIN) break;
            const members = rest.slice(i, j);
            rest = [...rest.slice(0, i), ...rest.slice(j)];
            const counts = new Map();
            for (const m of members) counts.set(m.symbol, (counts.get(m.symbol) ?? 0) + 1);
            const symbols = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || (a < b ? -1 : 1));
            const top = members.find((m) => m.symbol === symbols[0]);
            const sum = liquidationSum(members);
            out.push(makeEvent({
                id: `lending-wave-${slugPart(protocol)}-${members[0].at.replace(/[^0-9]/g, '').slice(0, 12)}`,
                at: members[0].at, kind: 'liquidation-wave', category: 'lending',
                title: symbols.length === 1
                    ? `${who} liquidation wave: ${members.length} ${symbols[0]} positions in an hour (${collateralText(members)})`
                    : withNames(`${who} liquidation wave: ${members.length} positions in an hour (${collateralText(members)})`, symbols),
                subject: symbols.length === 1 ? { type: 'token', id: top.mint, name: top.symbol } : { type: 'protocol', id: slugPart(protocol), name: who },
                severity: sum.usd >= 100000 || members.length >= 2 * LIQUIDATION_WAVE_MIN ? 'critical' : 'warning',
                href: lendingHref(top, protocol, ctx),
                source: SOURCES.lending, keys: [`liquidation|${protocol}|${members[0].at}`], origin: 'lending'
            }));
        }
        const groups = new Map();
        for (const m of rest) {
            const key = `${m.marketId}|${m.mint}|${m.at.slice(0, 10)}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(m);
        }
        for (const members of groups.values()) {
            const first = members[0];
            const sum = liquidationSum(members);
            if (sum.usd < LIQUIDATION_FLOOR_USD && members.length < LIQUIDATION_FLOOR_COUNT) {
                note(tally, `lending watcher: liquidations under $${LIQUIDATION_FLOOR_USD.toLocaleString('en-US')} of collateral in a day`, members.length);
                continue;
            }
            const market = MARKET_LABELS[first.marketId] ?? who;
            const n = members.length;
            out.push(makeEvent({
                id: `lending-liq-${slugPart(first.marketId)}-${slugPart(first.mint)}-${first.at.slice(0, 10)}`,
                at: newest(members.map((m) => m.at)), kind: 'liquidations', category: 'lending',
                title: `${market} liquidated ${n} ${first.symbol} position${n === 1 ? '' : 's'} (${collateralText(members)})`,
                subject: { type: 'token', id: first.mint, name: first.symbol },
                severity: sum.usd >= 100000 ? 'warning' : sum.usd >= 10000 ? 'caution' : 'info',
                href: lendingHref(first, protocol, ctx),
                source: SOURCES.lending, keys: [`liquidation|${protocol}|${first.mint}|${first.at.slice(0, 10)}`], origin: 'lending'
            }));
        }
    }
    return out;
}

/**
 * Ends the watcher dates exactly: the next refresh of a Jupiter Lend cache, a Scope resume, a newer
 * KLend price update, a Pyth account's first update. A KLend "first fresh observation" is only the
 * first transaction that saw the price back, so that episode's length is known between the last
 * stale sighting and it.
 */
const EXACT_FREEZE_ENDS = new Set(['next-refresh', 'scope-resume', 'next-update', 'first-update']);

/**
 * One freeze row as the SQL below returns it, with its length as a range: `lowMs` the length it
 * certainly had (to its exact end, or to the last stale sighting), `highMs` the length it may have
 * had (to its recorded end, or for an ongoing one to the last stale sighting).
 */
export function normaliseFreeze(row) {
    const startedAt = eventTime(row?.started_at);
    const endedAt = eventTime(row?.ended_at);
    const seenAt = eventTime(row?.last_seen_stale_at);
    const start = timeMs(startedAt);
    const end = timeMs(endedAt ?? seenAt);
    const seen = timeMs(seenAt);
    const exact = endedAt !== null && EXACT_FREEZE_ENDS.has(text(row?.end_basis));
    const highMs = start !== null && end !== null ? end - start : null;
    const lowMs = highMs === null ? null : exact || endedAt === null ? highMs : seen !== null ? Math.min(highMs, seen - start) : 0;
    return {
        protocol: text(row?.protocol), marketId: text(row?.market_id), mint: text(row?.mint), symbol: symbolOf(row?.symbol, row?.mint),
        cardSlug: text(row?.card_slug), startedAt, endedAt, ongoing: endedAt === null, cause: text(row?.cause), exact, lowMs, highMs
    };
}

/** How long a cluster of ended episodes lasted: the exactly dated ones decide; otherwise the range the sightings allow. */
function clusterLength(members) {
    const exact = members.filter((m) => m.exact).map((m) => m.highMs);
    if (exact.length) return lengthText(Math.min(...exact), Math.max(...exact), { spread: Math.max(HOUR_MS, Math.max(...exact) * 0.1) });
    return lengthText(Math.max(...members.map((m) => m.lowMs)), Math.max(...members.map((m) => m.highMs)));
}

/**
 * Collateral price freezes, clustered by start (within FREEZE_CLUSTER_MS, any market, any token) so
 * one upstream outage or one corporate action reads as one event: "Kamino and Jupiter Lend froze
 * the QQQx collateral price for 44 h". A cluster is news when one of its episodes certainly lasted
 * FREEZE_FLOOR_MS; shorter ones are keeper hiccups. Dated at the freeze start; an ongoing freeze
 * says "since" and stays in the feed while it lasts.
 */
export function freezeEvents(rows, ctx, tally = null) {
    const episodes = [];
    for (const raw of Array.isArray(rows) ? rows : []) {
        const ep = normaliseFreeze(raw);
        if (ep.startedAt === null || ep.mint === null || ep.highMs === null) {
            note(tally, 'lending watcher: freeze without a start or a length');
            continue;
        }
        episodes.push(ep);
    }
    episodes.sort((a, b) => timeMs(a.startedAt) - timeMs(b.startedAt) || (a.marketId < b.marketId ? -1 : 1));
    const clusters = [];
    for (const ep of episodes) {
        const last = clusters.at(-1);
        if (last && timeMs(ep.startedAt) - timeMs(last[0].startedAt) <= FREEZE_CLUSTER_MS) last.push(ep);
        else clusters.push([ep]);
    }
    const out = [];
    for (const members of clusters) {
        if (Math.max(...members.map((m) => m.lowMs)) < FREEZE_FLOOR_MS) {
            note(tally, `lending watcher: price freezes shorter than ${FREEZE_FLOOR_MS / MINUTE_MS} min`, members.length);
            continue;
        }
        const first = members[0];
        const order = Object.keys(PROTOCOL_LABELS);
        const protocols = [...new Set(members.map((m) => m.protocol))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
        const who = joinWords(protocols.map(protocolLabel));
        const symbols = [...new Set(members.map((m) => m.symbol))].sort();
        // The link: the first token the title names, at the first-named protocol where it has one.
        const lead = members.filter((m) => m.symbol === symbols[0])
            .sort((a, b) => order.indexOf(a.protocol) - order.indexOf(b.protocol))[0];
        const ongoing = members.some((m) => m.ongoing);
        const longest = Math.max(...members.map((m) => m.lowMs));
        let title;
        if (ongoing) {
            title = symbols.length === 1
                ? `${who}: the ${symbols[0]} collateral price has been frozen since ${dayText(first.startedAt)}`
                : withNames(`${who}: ${symbols.length} collateral prices frozen since ${dayText(first.startedAt)}`, symbols);
        } else {
            const length = clusterLength(members);
            title = symbols.length === 1
                ? `${who} froze the ${symbols[0]} collateral price for ${length}`
                : withNames(`${who} froze ${symbols.length} collateral prices for ${length}`, symbols);
        }
        out.push(makeEvent({
            id: `lending-freeze-${first.startedAt.replace(/[^0-9]/g, '').slice(0, 12)}-${slugPart(symbols.join('-')).slice(0, 32)}`,
            at: first.startedAt, kind: ongoing ? 'price-freeze-ongoing' : 'price-freeze', category: 'lending', title,
            subject: symbols.length === 1 ? { type: 'token', id: first.mint, name: first.symbol } : { type: 'protocol', id: slugPart(who), name: who },
            severity: ongoing || longest >= 6 * HOUR_MS ? 'warning' : 'caution',
            href: lendingHref(lead, lead.protocol, ctx),
            // No merge keys: no other source reports freezes, and a shared key would let two
            // separate episodes within 36 h swallow each other (lib mergeEvents sameFact).
            source: SOURCES.lending, keys: [], origin: 'lending', ongoing
        }));
    }
    return out;
}

/** Both lending rules over the rows lendingRowsSelect returns ({liquidations, freezes}). */
export function lendingEvents(lending, ctx, tally = null) {
    return [...liquidationEvents(lending?.liquidations, ctx, tally), ...freezeEvents(lending?.freezes, ctx, tally)];
}

/** The newest source time among the lending rows (a liquidation, a freeze start or end, a stale sighting). */
export function lendingTimes(lending) {
    return [
        ...(Array.isArray(lending?.liquidations) ? lending.liquidations : []).map((r) => r?.block_time),
        ...(Array.isArray(lending?.freezes) ? lending.freezes : []).flatMap((r) => [r?.started_at, r?.ended_at, r?.last_seen_stale_at])
    ];
}

// --- daily snapshot diffs (lib/changes.mjs diffSnapshots) ---------------------------------------

/** Issuer programme status moves between two daily issuer snapshots (e.g. live → defunct). */
export function issuerStatusChanges(prev, next) {
    const before = new Map((Array.isArray(prev?.items) ? prev.items : []).map((row) => [row?.slug, text(row?.status)]));
    const out = [];
    for (const row of Array.isArray(next?.items) ? next.items : []) {
        const slug = text(row?.slug);
        const was = before.get(slug) ?? null;
        const now = text(row?.status);
        if (slug === null || was === null || now === null || was === now) continue;
        out.push({ slug, before: was, after: now });
    }
    return out;
}

/** The snapshot change kinds that become events (snapshotEvents); only these enter the ledger. */
const FIRST_SEEN_KINDS = new Set(['liquidity-drop', 'rebase', 'reverse-split', 'frozen-appeared', 'paused', 'unpaused', 'control-change', 'issuer-status']);

/** The ledger key of one snapshot change: its day, kind, subject and (for a flag) direction. */
function firstSeenKey(day, change) {
    const direction = change?.kind === 'control-change' ? String(change?.after === true) : '';
    return [day, change?.kind, change?.mint ?? change?.slug ?? '', change?.field ?? '', direction].join('|');
}

/**
 * A day's snapshot is rewritten on every refresh, so the newer snapshot's build time moves forward
 * and a same-day event would float back to the top as new. `ledger` ({key: at}) remembers when a
 * build first saw each change; this stamps that time on each change as `firstObservedAt` and
 * returns the diffs with the ledger to keep (only days from `sinceDay`, so it stays small).
 */
export function stampFirstSeen(diffs, ledger = {}, sinceDay = null) {
    const kept = {};
    for (const [key, at] of Object.entries(ledger ?? {})) {
        if (eventTime(at) !== null && (sinceDay === null || key.slice(0, 10) >= sinceDay)) kept[key] = at;
    }
    const stamp = (day, observedAt, change) => {
        if (!FIRST_SEEN_KINDS.has(change?.kind)) return change;
        const key = firstSeenKey(day, change);
        if (!(key in kept) && observedAt !== null) kept[key] = observedAt;
        return { ...change, firstObservedAt: kept[key] ?? null };
    };
    const out = (Array.isArray(diffs) ? diffs : []).map((diff) => {
        const observedAt = eventTime(diff?.toObservedAt) ?? eventTime(diff?.to);
        const day = typeof diff?.to === 'string' ? diff.to : null;
        if (day === null) return diff;
        return {
            ...diff,
            changes: (Array.isArray(diff.changes) ? diff.changes : []).map((change) => stamp(day, observedAt, change)),
            issuerChanges: (Array.isArray(diff.issuerChanges) ? diff.issuerChanges : [])
                .map((status) => stamp(day, observedAt, { ...status, kind: 'issuer-status' }))
        };
    });
    return { diffs: out, ledger: kept };
}

/**
 * Market and control moves from consecutive daily snapshots, dated by the first build that saw each
 * one (`firstObservedAt`, stampFirstSeen), else by the newer snapshot's own build time. Kept: pool liquidity halving on a token that had ≥ $100k, pauses, splits and reverse
 * splits, frozen top holders, control flags switched, and an issuer programme's status changing.
 * Health re-grades, multiplier drift, spreads and liquidity rises are daily noise.
 */
export function snapshotEvents(diffs, ctx, tally = null) {
    const out = [];
    const groups = new Map();
    for (const diff of Array.isArray(diffs) ? diffs : []) {
        const diffAt = eventTime(diff?.toObservedAt) ?? eventTime(diff?.to);
        if (diffAt === null) continue;
        const day = diffAt.slice(0, 10);
        for (const change of Array.isArray(diff.changes) ? diff.changes : []) {
            const at = eventTime(change?.firstObservedAt) ?? diffAt;
            const mint = text(change?.mint);
            const symbol = symbolOf(change?.symbol, mint);
            const issuer = issuerOf(change?.issuer, ctx);
            const href = cardHref(mint, ctx) ?? issuerHref(issuer);
            const base = { at, subject: { type: 'token', id: mint, name: symbol }, href, source: SOURCES.catalogue, origin: 'file' };
            switch (change?.kind) {
                case 'liquidity-drop': {
                    const before = num(change.before);
                    const after = num(change.after);
                    if (before === null || after === null || before < LIQUIDITY_COLLAPSE_FLOOR_USD) {
                        note(tally, 'catalogue: liquidity drops on pools under $100k');
                        break;
                    }
                    out.push(makeEvent({
                        ...base, id: `market-liquidity-${slugPart(mint)}-${diff.to}`, kind: 'liquidity-collapse', category: 'market',
                        title: `${symbol}: pool liquidity fell ${Math.round((1 - after / before) * 100)} % in a day (${usd(before)} → ${usd(after)})`,
                        severity: 'warning', keys: [`liq|${mint}`]
                    }));
                    break;
                }
                case 'rebase':
                case 'reverse-split': {
                    const { kind, title } = restatementTitle(symbol, change.before, change.after);
                    out.push(makeEvent({ ...base, id: `market-split-${slugPart(mint)}-${diff.to}`, kind, category: 'market', title, severity: 'warning', keys: [`split|${mint}`] }));
                    break;
                }
                case 'frozen-appeared':
                    out.push(makeEvent({
                        ...base, id: `keys-frozen-${slugPart(mint)}-${diff.to}`, kind: 'frozen-holders', category: 'keys',
                        title: `${symbol}: ${change.after} of the top 20 holder accounts are now frozen`,
                        severity: 'caution', keys: [`frozen|${mint}`]
                    }));
                    break;
                case 'paused':
                case 'unpaused':
                case 'control-change': {
                    const field = change.kind === 'control-change' ? change.field : 'paused';
                    const after = change.kind === 'control-change' ? change.after === true : change.kind === 'paused';
                    if (change.kind === 'control-change' && !CONTROL_FLAG_WORDS[field]) {
                        note(tally, `catalogue: control flag ${field}`);
                        break;
                    }
                    const key = `${issuer.slug}|${day}|${field}|${after}`;
                    if (!groups.has(key)) groups.set(key, { issuer, day, at, field, after, diffTo: diff.to, members: [] });
                    const group = groups.get(key);
                    if (at < group.at) group.at = at;
                    group.members.push({ mint, symbol });
                    break;
                }
                case 'new-mint':
                    note(tally, 'catalogue: snapshot additions (shown from first-seen times)');
                    break;
                default:
                    note(tally, `catalogue: ${(CHANGE_KIND_LABELS[change?.kind] ?? change?.kind ?? 'unknown').toLowerCase()}`);
            }
        }
        for (const status of Array.isArray(diff.issuerChanges) ? diff.issuerChanges : []) {
            const issuer = issuerOf(status.slug, ctx);
            const name = issuer.name ?? 'An issuer';
            out.push(makeEvent({
                id: `legal-status-${slugPart(issuer.slug)}-${diff.to}`, at: eventTime(status.firstObservedAt) ?? diffAt, kind: 'issuer-status', category: 'legal',
                title: status.after === 'defunct' ? `${name}: programme now listed as defunct` : `${name}: programme status changed from ${status.before} to ${status.after}`,
                subject: { type: 'issuer', id: issuer.slug, name },
                severity: status.after === 'defunct' ? 'warning' : 'caution',
                href: issuerHref(issuer), source: SOURCES.catalogue, keys: [`status|${issuer.slug}`], origin: 'file'
            }));
        }
    }
    for (const group of groups.values()) {
        const symbols = group.members.map((m) => m.symbol).sort();
        const { who, target } = actorAndTarget(group.issuer, symbols);
        let title;
        let kind;
        let keys;
        if (group.field === 'paused') {
            kind = group.after ? 'pause' : 'unpause';
            title = `${who} ${group.after ? 'paused' : 'unpaused'} ${target}`;
            keys = [`pause|${group.issuer.slug}|${group.after}`];
        } else {
            const [article, words] = CONTROL_FLAG_WORDS[group.field];
            kind = 'control-flag';
            title = group.after ? `${who} added ${article} ${words} to ${target}` : `${who} removed the ${words} from ${target}`;
            keys = [`ctl|${group.issuer.slug}|${group.field}|${group.after}`];
        }
        const single = group.members.length === 1 ? group.members[0] : null;
        out.push(makeEvent({
            id: `keys-${slugPart(group.field)}-${slugPart(group.issuer.slug)}-${group.diffTo}-${group.after}`,
            at: group.at, kind, category: 'keys',
            title: symbols.length > 1 ? withNames(title, symbols) : title,
            subject: single ? { type: 'token', id: single.mint, name: single.symbol } : { type: 'issuer', id: group.issuer.slug, name: group.issuer.name },
            severity: group.after || group.field !== 'paused' ? 'warning' : 'info',
            href: (single ? cardHref(single.mint, ctx) : null) ?? issuerHref(group.issuer),
            source: SOURCES.catalogue, keys, origin: 'file'
        }));
    }
    return out;
}

// --- merging, windowing ------------------------------------------------------------------------

/**
 * Whether `event` reports a fact `kept` already reports: a shared chain/market key within 36 h, or —
 * when only documents are shared — `kept` covering every document `event` names, within 7 days (a
 * curated entry is often dated days after the watcher saw the change). A journal entry about one
 * page never swallows a watcher row that also reports three other pages.
 */
function sameFact(kept, event) {
    const ta = timeMs(kept.at);
    const tb = timeMs(event.at);
    if (ta === null || tb === null) return false;
    const shared = (event.keys ?? []).filter((key) => (kept.keys ?? []).includes(key));
    if (shared.length === 0) return false;
    if (shared.some((key) => !key.startsWith('doc|'))) return Math.abs(ta - tb) <= SAME_FACT_MS.other;
    const docs = event.keys.filter((key) => key.startsWith('doc|'));
    return docs.every((key) => kept.keys.includes(key)) && Math.abs(ta - tb) <= SAME_FACT_MS.doc;
}

function winnerOrder(a, b) {
    return (SOURCE_PRIORITY[b.source] ?? 0) - (SOURCE_PRIORITY[a.source] ?? 0)
        || (timeMs(b.at) ?? 0) - (timeMs(a.at) ?? 0)
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * One event per fact. Events with the same id are one event (a later entry replaces an earlier,
 * which is how the live API's fresh watcher rows replace the file's copies). Events from different
 * sources that share a fact key close in time are the same fact reported twice: the curated journal's
 * words win over a watcher's, a watcher's over a catalogue diff's, and a winner dated only to the day
 * takes the earliest precise observation of the same fact from that day or before.
 */
export function mergeEvents(events, tally = null) {
    const byId = new Map();
    for (const event of Array.isArray(events) ? events : []) if (text(event?.id)) byId.set(event.id, event);
    const ordered = [...byId.values()].sort(winnerOrder);
    const kept = [];
    for (const event of ordered) {
        const twin = kept.find((candidate) => sameFact(candidate, event));
        if (!twin) {
            kept.push({ ...event, keys: [...(event.keys ?? [])] });
            continue;
        }
        note(tally, `merged: same fact from the ${event.source} and the ${twin.source}`);
        for (const key of event.keys ?? []) if (!twin.keys.includes(key)) twin.keys.push(key);
        if (isDateOnly(twin.at) && !isDateOnly(event.at) && event.at.slice(0, 10) <= twin.at
            && (twin.preciseAt === undefined || timeMs(event.at) < timeMs(twin.preciseAt))) twin.preciseAt = event.at;
    }
    return kept.map(({ preciseAt, ...event }) => (preciseAt ? { ...event, at: preciseAt } : event));
}

/** Newest first within `windowDays` of `asOf` (ongoing freezes whatever their start), capped at `limit`. A missing asOf keeps nothing. */
export function finaliseEvents(events, { asOf, windowDays = WINDOW_DAYS, limit = MAX_EVENTS, tally = null } = {}) {
    const end = timeMs(asOf);
    if (end === null) return [];
    const cutoffDay = new Date(end - windowDays * DAY_MS).toISOString().slice(0, 10);
    const inWindow = [];
    for (const event of Array.isArray(events) ? events : []) {
        const day = eventTime(event?.at)?.slice(0, 10);
        // An ongoing freeze is current however long ago it began.
        if (!day || (day < cutoffDay && event.ongoing !== true)) {
            note(tally, `older than ${windowDays} days`);
            continue;
        }
        inWindow.push(event);
    }
    inWindow.sort((a, b) => timeMs(b.at) - timeMs(a.at)
        || (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0)
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    note(tally, `over the ${limit}-event cap`, inWindow.length - limit);
    return inWindow.slice(0, limit);
}

function countBy(events, field) {
    const counts = {};
    for (const event of events) counts[event[field]] = (counts[event[field]] ?? 0) + 1;
    return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export const METHODOLOGY = 'Noteworthy changes to the tokenized stocks RWA Sonar tracks, newest first, over the last 30 days: '
    + 'new tokens, key, pause and fee changes, splits, reviewed changes to issuer documents, '
    + 'lending and vault support added or removed, court filings, and market moves large enough to matter. '
    + `Lending markets: liquidations of stock collateral per market, token and day from $${LIQUIDATION_FLOOR_USD.toLocaleString('en-US')} of collateral `
    + `(or ${LIQUIDATION_FLOOR_COUNT} liquidations when no price is known), ${LIQUIDATION_WAVE_MIN} or more within an hour told as a wave, `
    + `and collateral price freezes of ${FREEZE_FLOOR_MS / MINUTE_MS} minutes or more, dated at the last price update before the freeze. `
    + 'Routine supply moves, daily multiplier updates, DEX pool churn and our own research maintenance are left out. '
    + 'Every time is the source\'s own event or observation time; a date without a time means the source records only the day.';

function feedEnvelope(events, { asOf, windowDays, tally }) {
    return {
        asOf,
        windowDays,
        newestEventAt: events[0]?.at ?? null,
        methodology: METHODOLOGY,
        counts: { total: events.length, byCategory: countBy(events, 'category'), bySource: countBy(events, 'source') },
        excluded: Object.fromEntries(Object.entries(tally).sort(([a], [b]) => (a < b ? -1 : 1))),
        events
    };
}

/**
 * The whole feed from what the builder read. `asOf` is the newest of the inputs' own timestamps
 * (never the clock), and the window is counted back from it.
 */
export function buildEventsFeed({ tokens = [], journal = [], changeRows = [], defiNew = null, diffs = [], lending = null, ctx, asOf, windowDays = WINDOW_DAYS, limit = MAX_EVENTS }) {
    const tally = {};
    const merged = mergeEvents([
        ...catalogueEvents(tokens, ctx, tally),
        ...journalEvents(journal, ctx, tally, resolvedObservations(changeRows, ctx)),
        ...changeRowEvents(changeRows, ctx, tally),
        ...defiEvents(defiNew, ctx, tally),
        ...lendingEvents(lending, ctx, tally),
        ...snapshotEvents(diffs, ctx, tally)
    ], tally);
    return feedEnvelope(finaliseEvents(merged, { asOf, windowDays, limit, tally }), { asOf, windowDays, tally });
}

/**
 * The live feed (GET /api/events): the static file's own events plus events derived from fresh
 * watcher rows (and fresh lending rows, when given). The file's watcher-derived events are dropped
 * first — the fresh rows say the same things, newer — so a fact the file merged away is merged the
 * same way again.
 */
export function mergeLiveFeed(feed, rows, ctx, { windowDays = WINDOW_DAYS, limit = MAX_EVENTS, lending = null } = {}) {
    const tally = {};
    // Lending rows, when the route could read them, replace the file's lending events the same way.
    const live = [...changeRowEvents(rows, ctx, tally), ...(lending === null ? [] : lendingEvents(lending, ctx, tally))];
    const fileEvents = (Array.isArray(feed?.events) ? feed.events : [])
        .filter((event) => event?.origin !== 'db' && (lending === null || event?.origin !== 'lending'));
    // The data's own newest time: a fresh watcher row counts even when no rule turned it into an event.
    const asOf = newest([feed?.asOf, ...(Array.isArray(rows) ? rows : []).map((row) => row?.detected_at), ...lendingTimes(lending)]);
    const merged = mergeEvents([...fileEvents, ...live], tally);
    return feedEnvelope(finaliseEvents(merged, { asOf, windowDays, limit, tally }), { asOf, windowDays, tally });
}

// --- the watcher rows query (shared by the builder's psql read and the API's pg read) ----------

/**
 * The SELECT behind both readers. `sinceExpr` is `$1::timestamptz` for node-postgres or a checked
 * literal for psql. Rows carry what the rules need to name and link a change without another query:
 * the token's symbol and card slug, the watched source's URL, title and kind, and the change judge's
 * latest valid reading (when its table exists — `judgments: false` leaves it out).
 */
export function changeRowsSelect({ sinceExpr, judgments }) {
    const judgmentColumns = judgments
        ? 'mj.id::text AS judgment_id, mj.status AS judgment_status, mj.material AS judgment_material, mj.severity AS judgment_severity'
        : 'NULL::text AS judgment_id, NULL::text AS judgment_status, NULL::boolean AS judgment_material, NULL::text AS judgment_severity';
    return `SELECT e.id::text AS id,
       to_char(e.detected_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS detected_at,
       e.kind, e.subject_type, e.subject_id,
       COALESCE(CASE e.subject_type WHEN 'issuer' THEN e.subject_id WHEN 'token' THEN t.issuer_slug END,
                e.evidence->>'issuer', ds.issuer_slug) AS issuer_slug,
       e.field, e.before, e.after, e.severity, e.evidence,
       t.symbol AS token_symbol, t.record->>'cardSlug' AS token_card_slug,
       CASE WHEN e.field = 'transfer_fee_bps' THEN (
         SELECT ms.transfer_fee_max::text FROM sonar.mint_state ms
          WHERE ms.mint = e.subject_id AND ms.observed_at <= e.detected_at
          ORDER BY ms.observed_at DESC LIMIT 1) END AS transfer_fee_max,
       ds.url AS source_url, ds.title AS source_title, ds.kind AS source_kind,
       ${judgmentColumns}
  FROM sonar.change_event e
  LEFT JOIN sonar.stock_token t ON e.subject_type = 'token' AND t.mint = e.subject_id
  LEFT JOIN LATERAL (
    SELECT s.url, s.title, s.kind, s.issuer_slug
      FROM sonar.source s
     WHERE (e.subject_type = 'source' AND s.id = e.subject_id)
        OR (e.subject_type <> 'source' AND s.url = e.evidence->>'url')
     ORDER BY (s.id = e.subject_id) DESC
     LIMIT 1
  ) ds ON true${judgments ? `\n  ${CHANGE_JUDGMENT_JOIN}` : ''}
 WHERE e.detected_at >= ${sinceExpr}
   AND e.kind IN (${CHANGE_ROW_KINDS.map((kind) => `'${kind}'`).join(', ')})
   AND (e.kind <> 'rebase' OR e.severity IN ('warning', 'critical'))
   AND ${PUBLIC_CHANGE_CONDITION}
 ORDER BY e.detected_at DESC, e.id DESC
 LIMIT 5000`;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** The psql form: one JSON array on stdout. `since` must be an ISO UTC instant (it is inlined). */
export function changeRowsPsql({ since, judgments }) {
    if (!ISO_INSTANT.test(String(since))) throw new Error(`changeRowsPsql: since must be an ISO UTC instant, got ${since}`);
    return `SELECT COALESCE(json_agg(row_to_json(r)), '[]'::json)::text FROM (\n${changeRowsSelect({ sinceExpr: `'${since}'::timestamptz`, judgments })}\n) r;`;
}

/** Whether the change judge's table exists here, as the psql probe prints it (`t`/`f`). */
export const JUDGMENT_TABLE_PROBE = "SELECT to_regclass('sonar.change_judgment') IS NOT NULL;";

// --- the lending rows query (shared by the builder's psql read and the API's pg read) ------------

const UTC_SECOND = (column) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

/**
 * One JSON document {liquidations, freezes} with what the lending rules need: liquidations since
 * `sinceExpr`, and freezes that were ongoing, ended or began since then, each with the token's card
 * slug. `sinceExpr` is `$1::timestamptz` for node-postgres or a checked literal for psql.
 */
export function lendingRowsSelect({ sinceExpr }) {
    return `SELECT json_build_object(
  'liquidations', COALESCE((SELECT json_agg(row_to_json(l)) FROM (
      SELECT l.signature, l.ix_index, ${UTC_SECOND('l.block_time')} AS block_time, l.protocol, l.market_id, l.mint,
             COALESCE(l.symbol, t.symbol) AS symbol, l.collateral_amount::float8 AS collateral_amount,
             l.collateral_usd::float8 AS collateral_usd, t.record->>'cardSlug' AS card_slug
        FROM sonar.lending_liquidation l
        LEFT JOIN sonar.stock_token t ON t.mint = l.mint
       WHERE l.block_time >= ${sinceExpr}
       ORDER BY l.block_time DESC
       LIMIT 5000) l), '[]'::json),
  'freezes', COALESCE((SELECT json_agg(row_to_json(f)) FROM (
      SELECT f.protocol, f.market_id, f.mint, COALESCE(f.symbol, t.symbol) AS symbol,
             ${UTC_SECOND('f.started_at')} AS started_at, ${UTC_SECOND('f.ended_at')} AS ended_at,
             ${UTC_SECOND('f.last_seen_stale_at')} AS last_seen_stale_at, f.cause, f.evidence->>'endBasis' AS end_basis,
             t.record->>'cardSlug' AS card_slug
        FROM sonar.lending_price_freeze f
        LEFT JOIN sonar.stock_token t ON t.mint = f.mint
       WHERE f.ended_at IS NULL OR f.ended_at >= ${sinceExpr} OR f.started_at >= ${sinceExpr}
       ORDER BY f.started_at DESC
       LIMIT 2000) f), '[]'::json)) AS lending`;
}

/** The psql form: the one JSON document on stdout. `since` must be an ISO UTC instant (it is inlined). */
export function lendingRowsPsql({ since }) {
    if (!ISO_INSTANT.test(String(since))) throw new Error(`lendingRowsPsql: since must be an ISO UTC instant, got ${since}`);
    return `SELECT (${lendingRowsSelect({ sinceExpr: `'${since}'::timestamptz` })})::text;`;
}

/** Whether the lending watcher's tables exist here, as the psql probe prints it (`t`/`f`). */
export const LENDING_TABLE_PROBE = "SELECT to_regclass('sonar.lending_liquidation') IS NOT NULL AND to_regclass('sonar.lending_price_freeze') IS NOT NULL;";
