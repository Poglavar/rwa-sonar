// PURE model and markup for "This week in tokenized stocks" (weekly/<YYYY-Www>.html): ISO-week
// arithmetic (weeks start Monday 00:00 UTC), the per-week digest assembled from already-built data
// (daily snapshots and their diffs, stocks-tokens.json firstSeenAt, the public change journal, issuer
// discrepancies and redemption feeds, and the database's model assessments, watcher events and trade
// counts), and the static HTML. No fs, no network, no clock: the build instant is always the data's
// own newest timestamp, so the same inputs render byte-identical pages. Tested in ../weekly.test.js.

import fmt from './fmt.js';
import siteNav from './site-nav.js';
import {
    SITE_IMAGE, breadcrumbLd, contactFooterHtml, contactStylesheet, ldGraph, organizationLd, reportLd, seoHeadTags, webPageLd
} from './site-seo.mjs';
import { foldAnchor, foldListHtml, foldWhen } from './fold-rows.mjs';

const { escapeHtml, fmtDate, fmtDateTime, fmtNumber, cardSlug, humanizeSlug } = fmt;

const DAY_MS = 86400000;
export const WEEK_MS = 7 * DAY_MS;
const ISO_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))?$/;
const WEEK_ID_RE = /^(\d{4})-W(\d{2})$/;

/** The site-wide 1200×630 link-preview image, used when a week's own image was not rendered. */
export const WEEKLY_OG_IMAGE = SITE_IMAGE.url;
/** How many rows one expandable list shows before it says how many more there are. */
export const LIST_LIMIT = 40;

function ms(value) {
    if (typeof value !== 'string' || !ISO_RE.test(value.trim())) return null;
    const t = Date.parse(value.trim());
    return Number.isFinite(t) ? t : null;
}

function str(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isoDay(t) {
    return new Date(t).toISOString().slice(0, 10);
}

function byText(a, b) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
}

/**
 * The ISO week an instant falls in: `{id: '2026-W39', year, week, start, end}` with `start` the
 * Monday 00:00 UTC that opens it and `end` the next Monday (exclusive). Null for anything that is
 * not an ISO date/time — a missing date must never land in some week by accident.
 */
export function isoWeekOf(value) {
    const t = typeof value === 'number' ? (Number.isFinite(value) ? value : null) : ms(value);
    if (t === null) return null;
    const day = Math.floor(t / DAY_MS) * DAY_MS;
    const weekday = (new Date(day).getUTCDay() + 6) % 7; // Monday = 0
    const monday = day - weekday * DAY_MS;
    const year = new Date(monday + 3 * DAY_MS).getUTCFullYear(); // the Thursday decides the year
    const jan4 = Date.UTC(year, 0, 4);
    const week1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
    const week = 1 + Math.round((monday - week1) / WEEK_MS);
    return {
        id: `${year}-W${String(week).padStart(2, '0')}`,
        year,
        week,
        start: `${isoDay(monday)}T00:00:00Z`,
        end: `${isoDay(monday + WEEK_MS)}T00:00:00Z`
    };
}

/** `2026-W39` back to its week object, or null when the id is malformed or names no real week. */
export function weekFromId(id) {
    const match = WEEK_ID_RE.exec(typeof id === 'string' ? id : '');
    if (match === null) return null;
    const year = Number(match[1]);
    const week = Number(match[2]);
    const jan4 = Date.UTC(year, 0, 4);
    const week1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
    const found = isoWeekOf(week1 + (week - 1) * WEEK_MS);
    return found !== null && found.id === id ? found : null;
}

/** Every week from the one containing `from` to the one containing `to`, oldest first. */
export function weeksBetween(from, to) {
    const first = isoWeekOf(from);
    const last = isoWeekOf(to);
    if (first === null || last === null || ms(first.start) > ms(last.start)) return [];
    const out = [];
    for (let t = ms(first.start); t <= ms(last.start); t += WEEK_MS) out.push(isoWeekOf(t));
    return out;
}

/** True when an ISO date/time lies in [week.start, week.end). A date-only value is its midnight UTC. */
export function inWeek(value, week) {
    const t = ms(value);
    return t !== null && week !== null && t >= ms(week.start) && t < ms(week.end);
}

/** "week 39, 2026". */
export function weekLabel(week) {
    return `week ${week.week}, ${week.year}`;
}

/** "21–27 Sep 2026" (or across a month/year boundary, both ends in full). */
export function weekRange(week) {
    const first = fmtDate(week.start.slice(0, 10));
    const last = fmtDate(isoDay(ms(week.end) - DAY_MS));
    const [d1, m1, y1] = first.split(' ');
    const [, m2, y2] = last.split(' ');
    if (y1 === y2 && m1 === m2) return `${d1}–${last}`;
    if (y1 === y2) return `${d1} ${m1} – ${last}`;
    return `${first} – ${last}`;
}

/**
 * The build instant: the newest of the inputs' own timestamps. Never the clock, so a rebuild from
 * the same files is byte-identical; null when no input carries a usable timestamp.
 */
export function dataAsOf(timestamps) {
    let best = null;
    for (const value of Array.isArray(timestamps) ? timestamps : []) {
        const t = ms(value);
        if (t !== null && (best === null || t > best.t)) best = { t, value: new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z') };
    }
    return best === null ? null : best.value;
}

/**
 * One daily snapshot reduced to the numbers-of-the-week measures. A measure nobody recorded stays
 * null: `defiIntegrations` is null unless at least one row carried a count.
 */
export function summariseSnapshot(tokensSnap, issuersSnap) {
    const rows = Array.isArray(tokensSnap?.items) ? tokensSnap.items : [];
    const issuers = Array.isArray(issuersSnap?.items) ? issuersSnap.items : null;
    const counted = rows.filter((row) => num(row?.defiIntegrationCount) !== null);
    return {
        date: str(tokensSnap?.date),
        builtAt: str(tokensSnap?.builtAt),
        tokens: rows.length,
        // Same definition as the home page: programmes not defunct with at least one live token.
        issuersLive: issuers === null ? null : issuers.filter((row) => row?.status !== 'defunct' && typeof row?.tokenCount === 'number' && row.tokenCount > 0).length,
        defiIntegrations: counted.length === 0 ? null
            : counted.reduce((sum, row) => sum + row.defiIntegrationCount, 0)
    };
}

function lastSnapshotIn(snapshots, week) {
    if (week === null) return null;
    const inside = (snapshots ?? []).filter((snap) => inWeek(snap?.date, week));
    inside.sort((a, b) => byText(a.date, b.date));
    return inside.at(-1) ?? null;
}

/**
 * A level measure read from the last snapshot of the week, with a week-over-week delta only when
 * the previous week ALSO has a snapshot carrying the measure — "not observed last week" is never 0.
 */
function levelMetric(key, snap, prevSnap) {
    const value = snap === null ? null : num(snap[key]);
    const previous = prevSnap === null ? null : num(prevSnap[key]);
    return {
        value,
        observedAt: snap?.date ?? null,
        delta: value !== null && previous !== null ? value - previous : null,
        comparedWith: value !== null && previous !== null ? prevSnap.date : null,
        noDelta: prevSnap === null ? 'no comparison: no snapshot last week' : 'no comparison: not recorded last week',
        missing: value !== null ? null
            : snap === null ? 'no daily snapshot recorded in this week' : 'not recorded in this week\'s snapshot'
    };
}

/**
 * Trades are a FLOW over the week, read from the accumulating sonar.stock_trade table. The count is
 * only complete when collection covered the whole week, so a week that started before the first
 * stored trade is `partial`, and a delta needs two complete, finished weeks.
 */
function tradeMetric(week, prevWeek, trades, asOf) {
    if (trades === null || trades === undefined) {
        return { value: null, observedAt: null, delta: null, comparedWith: null, partial: false,
            missing: 'trade database not read in this build' };
    }
    const firstMs = ms(trades.firstTradeAt);
    const lastMs = ms(trades.lastTradeAt);
    // A week is only complete when stored trades reach within a day of its end: an empty tail
    // means the table was not loaded, not that nobody traded.
    const read = (w) => {
        if (w === null) return null;
        if (firstMs === null || lastMs === null || firstMs >= ms(w.end) || lastMs < ms(w.start)) return null;
        const row = (trades.weeks ?? []).find((entry) => entry?.week === w.start.slice(0, 10)) ?? null;
        return {
            count: num(row?.trades) ?? 0,
            suspect: num(row?.suspect) ?? 0,
            partial: firstMs > ms(w.start) || ms(asOf) < ms(w.end) || lastMs < ms(w.end) - DAY_MS
        };
    };
    const current = read(week);
    const previous = read(prevWeek);
    if (current === null) {
        return { value: null, observedAt: null, delta: null, comparedWith: null, partial: false,
            missing: firstMs !== null && firstMs >= ms(week.end) ? 'trade collection had not started'
                : `no trades stored for this week (newest stored trade ${trades.lastTradeAt ?? 'none'})` };
    }
    const comparable = previous !== null && !current.partial && !previous.partial;
    return {
        value: current.count,
        suspect: current.suspect,
        observedAt: ms(asOf) < ms(week.end) ? asOf : week.end,
        delta: comparable ? current.count - previous.count : null,
        comparedWith: comparable ? prevWeek.id : null,
        noDelta: current.partial ? 'no comparison: partial week' : 'no comparison: last week not fully collected',
        partial: current.partial,
        coverageFrom: trades.firstTradeAt,
        missing: null
    };
}

/**
 * The model's MATERIAL readings detected in this week, one per judged change (a judgment covering
 * several events is represented by the event it read, else the earliest), newest first. `rows` is
 * null when the verdicts could not be read, which the page shows as unavailable — never as "none".
 */
export function weekMaterialChanges(rows, week) {
    if (rows === null || rows === undefined) return null;
    const byChange = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
        if (row?.material !== true || str(row.assessmentSummary) === null) continue;
        if (!inWeek(row.detectedAt, week)) continue;
        const at = ms(row.detectedAt);
        const key = str(row.judgmentId) ?? `event:${row.id}`;
        const held = byChange.get(key);
        let better;
        if (held === undefined) better = true;
        else if ((row.representative === true) !== (held.row.representative === true)) better = row.representative === true;
        else better = at < held.at || (at === held.at && Number(row.id) < Number(held.row.id));
        if (better) byChange.set(key, { at, row });
    }
    return [...byChange.values()]
        .sort((a, b) => b.at - a.at || Number(b.row.id) - Number(a.row.id))
        .map(({ row }) => ({
            id: String(row.id),
            detectedAt: row.detectedAt,
            kind: str(row.kind),
            issuerSlug: str(row.issuerSlug),
            change: str(row.summary),
            assessmentSeverity: str(row.assessmentSeverity),
            assessment: str(row.assessmentSummary)
        }));
}

/**
 * Tokens first seen in this week, grouped per issuer, largest group first. The founding cohort
 * (first seen on or before the first recorded snapshot day) is excluded: for those `firstSeenAt`
 * is when records began, not when the token arrived.
 */
export function weekNewTokens(tokens, week, { recordsBeginOn = null, issuerNames = {} } = {}) {
    const groups = new Map();
    for (const token of Array.isArray(tokens) ? tokens : []) {
        const firstSeenAt = str(token?.firstSeenAt);
        if (firstSeenAt === null || !inWeek(firstSeenAt, week)) continue;
        if (recordsBeginOn !== null && firstSeenAt.slice(0, 10) <= recordsBeginOn) continue;
        const issuer = str(token.issuer) ?? 'unknown';
        if (!groups.has(issuer)) groups.set(issuer, []);
        groups.get(issuer).push({
            symbol: str(token.symbol),
            name: str(token.name),
            mint: str(token.mint),
            cardSlug: str(token.cardSlug) ?? str(cardSlug(token.symbol, token.mint)),
            firstSeenAt
        });
    }
    return [...groups.entries()]
        .map(([issuer, list]) => ({
            issuer,
            issuerName: str(issuerNames[issuer]) ?? issuer,
            count: list.length,
            tokens: list.sort((a, b) => byText(a.firstSeenAt, b.firstSeenAt) || byText(a.mint ?? '', b.mint ?? ''))
        }))
        .sort((a, b) => b.count - a.count || byText(a.issuer, b.issuer));
}

/**
 * The daily snapshot diffs whose later day falls in this week, split into removed tokens and every
 * other move (health, pause, multiplier, liquidity, spread, frozen accounts, control flags).
 */
export function weekSnapshotMoves(diffs, week, { slugs = {} } = {}) {
    const pairs = [];
    const removed = [];
    const moves = new Map();
    for (const diff of Array.isArray(diffs) ? diffs : []) {
        if (!inWeek(diff?.to, week)) continue;
        pairs.push({ from: diff.from, to: diff.to });
        for (const change of Array.isArray(diff.changes) ? diff.changes : []) {
            if (change?.kind === 'new-mint') continue; // firstSeenAt answers "new" (weekNewTokens)
            const row = {
                kind: change.kind,
                symbol: str(change.symbol),
                mint: str(change.mint),
                issuer: str(change.issuer),
                cardSlug: str(slugs[change.mint]) ?? str(cardSlug(change.symbol, change.mint)),
                note: str(change.note),
                field: str(change.field),
                before: change.before ?? null,
                after: change.after ?? null,
                date: diff.to,
                previousDate: diff.from
            };
            if (change.kind === 'removed-mint') removed.push(row);
            else {
                if (!moves.has(change.kind)) moves.set(change.kind, []);
                moves.get(change.kind).push(row);
            }
        }
    }
    pairs.sort((a, b) => byText(a.to, b.to));
    return { pairs, removed, moves };
}

/** Change-journal items first observed in this week, newest first (the journal's own order kept). */
export function weekJournal(items, week) {
    return (Array.isArray(items) ? items : [])
        .filter((item) => inWeek(item?.date, week))
        .sort((a, b) => byText(b.date, a.date) || byText(a.id ?? '', b.id ?? ''));
}

/** Issuer claim-versus-reality discrepancies whose `observedAt` falls in this week. */
export function weekDiscrepancies(issuers, week) {
    const out = [];
    for (const issuer of Array.isArray(issuers) ? issuers : []) {
        for (const row of Array.isArray(issuer?.discrepancies) ? issuer.discrepancies : []) {
            if (!inWeek(row?.observedAt, week)) continue;
            out.push({ issuer: issuer.slug, issuerName: str(issuer.name) ?? issuer.slug, id: str(row.id),
                title: str(row.title), severity: str(row.severity), observedAt: row.observedAt, impact: str(row.impact) });
        }
    }
    return out.sort((a, b) => byText(b.observedAt, a.observedAt) || byText(a.issuer, b.issuer));
}

/**
 * Per issuer with a redemption observation feed: accepted redemptions counted on the days of this
 * week and the hours of the week the scan actually covered. Zero covered hours is "not covered",
 * never "none observed". Issuers without a feed are listed by name so the absence is visible.
 */
export function weekRedemptions(issuers, week) {
    const observed = [];
    const withoutFeed = [];
    for (const issuer of Array.isArray(issuers) ? issuers : []) {
        const feed = issuer?.redemption?.observationFeed ?? null;
        const name = str(issuer?.name) ?? issuer?.slug;
        if (issuer?.status !== 'live') continue;
        if (feed === null || typeof feed !== 'object') {
            withoutFeed.push({ issuer: issuer.slug, issuerName: name });
            continue;
        }
        if (feed.observable === false) {
            observed.push({ issuer: issuer.slug, issuerName: name, observable: false,
                why: str(feed.whyNotObservable) ?? str(feed.mechanism), redemptions: null, coveredHours: null });
            continue;
        }
        let redemptions = 0;
        let coveredHours = 0;
        for (const [day, counts] of Object.entries(feed.daily ?? {})) {
            if (!inWeek(day, week)) continue;
            redemptions += num(counts?.redemptions) ?? 0;
            coveredHours += num(counts?.coveredHours) ?? 0;
        }
        coveredHours = Math.round(coveredHours * 10) / 10;
        observed.push({
            issuer: issuer.slug,
            issuerName: name,
            observable: true,
            redemptions: coveredHours > 0 ? redemptions : null,
            coveredHours,
            state: str(feed.state),
            lastScanAt: str(feed.lastScanAt),
            completionObservable: feed.completionObservable !== false
        });
    }
    observed.sort((a, b) => byText(a.issuer, b.issuer));
    withoutFeed.sort((a, b) => byText(a.issuer, b.issuer));
    return { observed, withoutFeed };
}

/** Watcher change events (sonar.change_event) detected this week, by kind; null when not read. */
export function weekEvents(eventRows, week) {
    if (eventRows === null || eventRows === undefined) return null;
    const byKind = {};
    let total = 0;
    for (const row of Array.isArray(eventRows) ? eventRows : []) {
        if (row?.week !== week.start.slice(0, 10)) continue;
        const n = num(row.events) ?? 0;
        byKind[row.kind] = (byKind[row.kind] ?? 0) + n;
        total += n;
    }
    return { total, byKind: Object.fromEntries(Object.entries(byKind).sort(([a], [b]) => byText(a, b))) };
}

/**
 * The whole digest for one week. `inputs` is what the builder read:
 * {snapshots (summariseSnapshot rows), diffs, tokens, issuers, journal, material, events, trades,
 *  sources, recordsBeginOn, slugs, protocolPages}.
 */
export function buildWeek(week, prevWeek, asOf, inputs) {
    const issuerNames = Object.fromEntries((inputs.issuers ?? []).map((issuer) => [issuer.slug, issuer.name]));
    const snap = lastSnapshotIn(inputs.snapshots, week);
    const prevSnap = lastSnapshotIn(inputs.snapshots, prevWeek);
    const moves = weekSnapshotMoves(inputs.diffs, week, { slugs: inputs.slugs ?? {} });
    return {
        week,
        prevWeek,
        asOf,
        inProgress: ms(asOf) < ms(week.end),
        numbers: {
            tokens: levelMetric('tokens', snap, prevSnap),
            issuersLive: levelMetric('issuersLive', snap, prevSnap),
            defiIntegrations: levelMetric('defiIntegrations', snap, prevSnap),
            trades: tradeMetric(week, prevWeek, inputs.trades, asOf)
        },
        material: weekMaterialChanges(inputs.material, week),
        newTokens: weekNewTokens(inputs.tokens, week, { recordsBeginOn: inputs.recordsBeginOn ?? null, issuerNames }),
        removed: moves.removed,
        moves: moves.moves,
        pairs: moves.pairs,
        journal: weekJournal(inputs.journal, week),
        discrepancies: weekDiscrepancies(inputs.issuers, week),
        redemptions: weekRedemptions(inputs.issuers, week),
        events: weekEvents(inputs.events, week),
        sources: inputs.sources ?? {},
        protocolPages: inputs.protocolPages ?? {},
        issuerNames
    };
}

// ---------------------------------------------------------------------------------------------
// Database read (one psql call, one JSON document out)
// ---------------------------------------------------------------------------------------------

/**
 * First observation records prove a watcher started, not that anything changed, and an event
 * dismissed as a false alarm (a read that was not the document) is no change either — the same
 * condition as api/src/lib/evidence.js.
 */
const PUBLIC_CHANGE_CONDITION = `(NOT (e.kind = 'status' AND e.field = 'chain-watch'
             AND COALESCE(e.summary, '') ~* '^baseline recorded:')
             AND NOT EXISTS (SELECT 1 FROM sonar.review_resolution rr
                              WHERE rr.event_id = e.id AND rr.resolution = 'false-alarm'))`;

function timestampLiteral(iso, label) {
    if (ms(iso) === null) throw new Error(`${label} must be an ISO timestamp, got ${JSON.stringify(iso)}`);
    return `'${iso}'::timestamptz`;
}

/**
 * The one query the weekly build runs: `{material, events, trades}` as a single JSON document, each
 * part bounded to [since, asOf] so a later collector pass cannot change a rebuilt page. `tables` says
 * which tables exist (`{judgment, event, trade}`); a missing table yields `null` for its part, which
 * the page renders as "not read" rather than as zero. Timestamps are formatted in SQL so the session
 * time zone cannot change a byte; `date_trunc('week', …)` is the ISO Monday.
 */
export function weeklyDbSql({ since, asOf, tables = {} }) {
    const from = timestampLiteral(since, 'since');
    const to = timestampLiteral(asOf, 'asOf');
    const material = tables.judgment && tables.event ? `(
        SELECT COALESCE(json_agg(row_to_json(r) ORDER BY r."detectedAt" DESC, r.id DESC), '[]'::json)
        FROM (
            SELECT e.id::text AS id,
                   to_char(e.detected_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "detectedAt",
                   e.kind, e.summary, e.subject_type AS "subjectType", e.subject_id AS "subjectId",
                   COALESCE(t.issuer_slug, s.issuer_slug,
                            CASE WHEN e.subject_type = 'issuer' THEN e.subject_id END,
                            e.evidence->>'issuer') AS "issuerSlug",
                   mj.id::text AS "judgmentId", (mj.change_event_id = e.id) AS representative,
                   mj.material, mj.severity AS "assessmentSeverity", mj.summary AS "assessmentSummary"
            FROM sonar.change_event e
            LEFT JOIN sonar.stock_token t ON e.subject_type = 'token' AND t.mint = e.subject_id
            LEFT JOIN sonar.source s ON e.subject_type = 'source' AND s.id = e.subject_id
            JOIN LATERAL (
                SELECT j.id, j.change_event_id, j.material, j.severity, j.summary
                FROM sonar.change_judgment j
                WHERE j.status = 'valid'
                  AND (j.change_event_id = e.id
                       OR j.covers_event_ids @> jsonb_build_array(e.id)
                       OR j.covers_event_ids @> jsonb_build_array(e.id::text))
                ORDER BY j.updated_at DESC, j.id DESC
                LIMIT 1
            ) mj ON true
            WHERE mj.material AND e.detected_at >= ${from} AND e.detected_at <= ${to}
              AND ${PUBLIC_CHANGE_CONDITION}
        ) r)` : 'NULL::json';
    const events = tables.event ? `(
        SELECT COALESCE(json_agg(row_to_json(r) ORDER BY r.week, r.kind), '[]'::json)
        FROM (
            SELECT to_char(date_trunc('week', e.detected_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS week,
                   e.kind, count(*)::int AS events
            FROM sonar.change_event e
            WHERE e.detected_at >= ${from} AND e.detected_at <= ${to} AND ${PUBLIC_CHANGE_CONDITION}
            GROUP BY 1, 2
        ) r)` : 'NULL::json';
    const trades = tables.trade ? `json_build_object(
        'firstTradeAt', (SELECT to_char(min("time") AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM sonar.stock_trade),
        'lastTradeAt', (SELECT to_char(max("time") AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM sonar.stock_trade WHERE "time" <= ${to}),
        'weeks', (SELECT COALESCE(json_agg(row_to_json(r) ORDER BY r.week), '[]'::json)
                  FROM (
                      SELECT to_char(date_trunc('week', "time" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS week,
                             count(*)::int AS trades,
                             (count(*) FILTER (WHERE COALESCE(suspect, '') <> ''))::int AS suspect
                      FROM sonar.stock_trade
                      WHERE "time" <= ${to}
                      GROUP BY 1
                  ) r))` : 'NULL::json';
    return `SELECT json_build_object('material', ${material}, 'events', ${events}, 'trades', ${trades})::text;`;
}

/** The probe run first: which of the three tables exist, as `judgment|event|trade` t/f flags. */
export const WEEKLY_TABLE_PROBE = "SELECT concat_ws('|', to_regclass('sonar.change_judgment') IS NOT NULL, "
    + "to_regclass('sonar.change_event') IS NOT NULL, to_regclass('sonar.stock_trade') IS NOT NULL);";

/** `t|f|t` → `{judgment: true, event: false, trade: true}`. */
export function parseTableProbe(text) {
    const [judgment, event, trade] = String(text ?? '').trim().split('|').map((flag) => flag === 't' || flag === 'true');
    return { judgment: judgment === true, event: event === true, trade: trade === true };
}

// ---------------------------------------------------------------------------------------------
// Headlines and markup
// ---------------------------------------------------------------------------------------------

const MOVE_LABELS = {
    'health-worse': 'Health got worse',
    'health-better': 'Health got better',
    paused: 'Trading paused',
    unpaused: 'Trading resumed',
    rebase: 'Rebase (balances scaled up)',
    'reverse-split': 'Reverse split (balances scaled down)',
    'multiplier-change': 'Scaled-UI multiplier moved',
    'liquidity-drop': 'Pool liquidity halved or worse',
    'liquidity-rise': 'Pool liquidity more than doubled',
    'spread-wide': 'Venue spread crossed 5 %',
    'frozen-appeared': 'Frozen accounts appeared in the top 20',
    'control-change': 'Issuer control flags flipped'
};
const MOVE_ORDER = Object.keys(MOVE_LABELS);

function plural(n, one, many = `${one}s`) {
    return `${fmtNumber(n, 0)} ${n === 1 ? one : many}`;
}

function sum(list, key) {
    return list.reduce((total, row) => total + (num(row[key]) ?? 0), 0);
}

/** Severity words used by the journal, discrepancies and the change judge, worst highest. */
const SEVERITY_RANK = { critical: 4, high: 3, warning: 3, caution: 2, medium: 2, low: 1, info: 1 };

function severityRank(value) {
    return SEVERITY_RANK[str(value)?.toLowerCase() ?? ''] ?? 0;
}

/** How many named items one headline carries before the rest become "and N more". */
const HEADLINE_ITEMS = 2;
/** Characters one quoted item may take: two of them plus the frame stay readable on a phone. */
const ITEM_CHARS = 80;

/**
 * The first sentence of a longer text, cut at a word boundary to `max` characters. Headlines name
 * the thing; the section below carries the full reading.
 */
export function briefText(text, max = 100) {
    // A long on-chain address is shortened the way wallets show it, so it cannot eat the line.
    const clean = str(text)?.replace(/\s+/g, ' ').trim()
        .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,}\b|\b[a-z]{2,10}1[02-9ac-hj-np-z]{30,}\b/g, (addr) => `${addr.slice(0, 6)}…${addr.slice(-4)}`) ?? null;
    if (clean === null) return null;
    const sentence = (clean.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? clean).replace(/[.!?]$/, '');
    if (sentence.length <= max) return sentence;
    const cut = sentence.slice(0, max - 1);
    const whole = /\s/.test(sentence[max - 1]) ? cut : cut.replace(/\s+\S*$/, '');
    return `${whole.replace(/[\s,;:—–-]+$/, '')}…`;
}

/** " — and 3 more material changes", or '' when nothing is left over. */
function andMore(n, one, many = `${one}s`) {
    return n > 0 ? ` — and ${fmtNumber(n, 0)} more ${n === 1 ? one : many}` : '';
}

/** "a", "a and b", "a, b and c". */
function listJoin(items) {
    if (items.length <= 1) return items[0] ?? '';
    return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** "25 %" from a ratio 0.25; one decimal below 10 %. Null for a missing ratio. */
function pctText(ratio) {
    if (num(ratio) === null) return null;
    const p = Math.abs(ratio) * 100;
    return `${p >= 10 ? Math.round(p) : Math.round(p * 10) / 10} %`;
}

/** "$188.2k" / "$450"; null for a missing amount (never "$0"). */
function usdText(value) {
    if (num(value) === null) return null;
    if (Math.abs(value) >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
    if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(1)}k`;
    return `$${Math.round(value)}`;
}

/** A stored number that may be a numeric string (`uiMultiplier`), or null. */
function numeric(value) {
    if (typeof value === 'string' && value.trim() !== '') return num(Number(value));
    return num(value);
}

/**
 * The status moves of the week as ranked stories, most significant first: pauses, frozen holders,
 * control flips and balance restatements first; health slides grouped per level they fell to;
 * liquidity by dollars moved; routine multiplier drift last. Each story says which moves it covers.
 */
export function rankStatusMoves(moves) {
    const stories = [];
    const rows = (kind) => moves?.get?.(kind) ?? [];
    const sym = (row) => row.symbol ?? row.mint ?? 'a token';
    for (const row of rows('paused')) stories.push({ score: 100, covers: 1, text: `${sym(row)} transfers or trading paused` });
    for (const row of rows('frozen-appeared')) {
        const frozen = numeric(row.after);
        stories.push({ score: 90, covers: 1, text: frozen === null ? `${sym(row)}: frozen accounts appeared in the top 20 holders`
            : `${sym(row)}: ${fmtNumber(frozen, 0)} of the top 20 holder accounts frozen` });
    }
    for (const row of rows('control-change')) {
        const flag = row.field ?? 'a control';
        const to = row.after === true ? 'switched on' : row.after === false ? 'switched off' : 'flipped';
        stories.push({ score: 80, covers: 1, text: `${sym(row)}: issuer ${flag} control ${to}` });
    }
    for (const kind of ['rebase', 'reverse-split']) {
        for (const row of rows(kind)) {
            const before = numeric(row.before);
            const after = numeric(row.after);
            const ratio = before !== null && after !== null && before !== 0 ? after / before : null;
            const move = ratio === null ? null : pctText(ratio - 1);
            stories.push({ score: 70 + (ratio === null ? 0 : Math.min(Math.abs(ratio - 1), 9)), covers: 1,
                text: `${sym(row)} holder balances restated ${kind === 'rebase' ? 'up' : 'down'}${move === null ? '' : ` ${move}`} without a transfer` });
        }
    }
    for (const row of rows('unpaused')) stories.push({ score: 60, covers: 1, text: `${sym(row)} transfers or trading resumed` });
    const health = new Map();
    for (const row of rows('health-worse')) {
        const level = str(row.after) ?? 'a worse level';
        if (!health.has(level)) health.set(level, []);
        health.get(level).push(row);
    }
    for (const [level, list] of health) {
        const named = list.slice(0, 2).map(sym);
        const text = list.length <= 2 ? `health fell to ${level} on ${listJoin(named)}`
            : `health fell to ${level} on ${named.join(', ')} and ${plural(list.length - 2, 'other token')}`;
        stories.push({ score: (level === 'warning' ? 55 : 35) + Math.min(list.length, 999) / 1000, covers: list.length, text });
    }
    for (const kind of ['liquidity-drop', 'liquidity-rise']) {
        for (const row of rows(kind)) {
            const before = numeric(row.before);
            const after = numeric(row.after);
            const moved = before !== null && after !== null ? Math.abs(after - before) : null;
            const share = moved !== null && before > 0 ? pctText(moved / before) : null;
            const verb = kind === 'liquidity-drop' ? 'fell' : 'rose';
            const range = moved === null ? '' : ` (${usdText(before)} → ${usdText(after)})`;
            stories.push({ score: (kind === 'liquidity-drop' ? 45 : 20) + (moved === null ? 0 : 9 * moved / (moved + 1e5)), covers: 1,
                text: `${sym(row)} pool liquidity ${verb}${share === null ? '' : ` ${share}`}${range}` });
        }
    }
    for (const row of rows('spread-wide')) {
        const after = numeric(row.after);
        stories.push({ score: 30 + (after === null ? 0 : Math.min(after, 100) / 100), covers: 1,
            text: `${sym(row)} price gap between venues widened${after === null ? ' past 5 %' : ` to ${after.toFixed(1)} %`}` });
    }
    const better = rows('health-better');
    if (better.length > 0) {
        const named = better.slice(0, 2).map(sym);
        stories.push({ score: 10, covers: better.length, text: better.length <= 2 ? `health improved on ${listJoin(named)}`
            : `health improved on ${named.join(', ')} and ${plural(better.length - 2, 'other token')}` });
    }
    const drift = rows('multiplier-change');
    if (drift.length > 0) {
        const named = drift.slice(0, 2).map(sym);
        stories.push({ score: 5, covers: drift.length, text: `displayed balances drifted (scaled-UI multiplier) on ${drift.length <= 2 ? listJoin(named)
            : `${named.join(', ')} and ${plural(drift.length - 2, 'other token')}`}` });
    }
    // Stable: equal scores keep the snapshot diff's own (mint) order.
    return stories.map((story, i) => ({ ...story, i })).sort((a, b) => b.score - a.score || a.i - b.i)
        .map(({ i, ...story }) => story);
}

/** Watcher event kinds in plain English, most telling first; kinds not listed come after these. */
const EVENT_KINDS = [
    ['litigation', 'litigation filing'], ['insolvency', 'insolvency notice'], ['regulator-notice', 'regulator notice'],
    ['entity-status', 'company-register status change'], ['authority-key', 'token key change'],
    ['extension-toggle', 'token feature toggle'], ['document-gone', 'source document taken down', 'source documents taken down'],
    ['quote-lost', 'quoted claim no longer found', 'quoted claims no longer found'], ['legal-term', 'legal-wording change'],
    ['rebase', 'multiplier update'], ['treasury', 'treasury movement'], ['supply', 'token supply change']
];

function eventsPhrase(events) {
    const order = new Map(EVENT_KINDS.map(([kind], i) => [kind, i]));
    const kinds = Object.entries(events.byKind).filter(([, n]) => num(n) !== null && n > 0)
        .sort(([a], [b]) => (order.get(a) ?? 99) - (order.get(b) ?? 99) || byText(a, b));
    const shown = kinds.slice(0, HEADLINE_ITEMS).map(([kind, n]) => {
        const entry = EVENT_KINDS.find(([k]) => k === kind);
        const one = entry?.[1] ?? `${humanizeSlug(kind).toLowerCase()} event`;
        return plural(n, one, entry?.[2] ?? `${one}s`);
    });
    const rest = kinds.slice(HEADLINE_ITEMS).reduce((total, [, n]) => total + n, 0);
    return `watchers logged ${listJoin(rest > 0 ? [...shown, `${fmtNumber(rest, 0)} other changes`] : shown)}`;
}

function materialHeadline(digest) {
    const rows = digest.material;
    if (rows === null) return { text: 'Material changes: model assessments not available in this build', empty: true };
    if (rows.length === 0) return { text: 'No change this week was read as material (model assessment)', empty: true };
    // Worst first, newest first within a severity (rows arrive newest first); one story per issuer.
    const ranked = rows.map((row, i) => ({ row, i })).sort((a, b) => severityRank(b.row.assessmentSeverity) - severityRank(a.row.assessmentSeverity) || a.i - b.i);
    const seen = new Set();
    const picked = [];
    for (const { row } of ranked) {
        const who = issuerName(row.issuerSlug, digest.issuerNames);
        const key = who ?? `row:${row.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const what = briefText(row.assessment, ITEM_CHARS) ?? briefText(row.change, ITEM_CHARS) ?? row.kind ?? 'a change';
        picked.push(`${who ? `${who}: ` : ''}${what}${row.assessmentSeverity ? ` (${row.assessmentSeverity})` : ''}`);
        if (picked.length === HEADLINE_ITEMS) break;
    }
    return { text: `Material (model assessment): ${picked.join('; ')}${andMore(rows.length - picked.length, 'material change')}`, empty: false };
}

const JOURNAL_WEIGHT = { 'actor-change': 3, 'protocol-change': 2, catalogue: 0 };

function journalHeadline(digest) {
    const rows = digest.journal;
    if (rows.length === 0) return { text: 'The change journal recorded no issuer, venue or protocol change', empty: true };
    const ranked = rows.map((item, i) => ({ item, i })).sort((a, b) => severityRank(b.item.severity) - severityRank(a.item.severity)
        || (JOURNAL_WEIGHT[b.item.category] ?? 1) - (JOURNAL_WEIGHT[a.item.category] ?? 1)
        || (Array.isArray(b.item.assets) ? b.item.assets.length : 0) - (Array.isArray(a.item.assets) ? a.item.assets.length : 0)
        || a.i - b.i);
    const picked = ranked.map(({ item }) => briefText(item.title, ITEM_CHARS) ?? briefText(item.summary, ITEM_CHARS)).filter((text) => text !== null).slice(0, HEADLINE_ITEMS);
    return { text: `${picked.join('; ')}${andMore(rows.length - picked.length, 'issuer, venue or protocol change')}`, empty: false };
}

function tokensHeadline(digest) {
    const groups = digest.newTokens;
    const removed = digest.removed;
    const addedParts = groups.slice(0, 3).map((group) => {
        const symbols = group.tokens.map((row) => row.symbol).filter((symbol) => symbol !== null);
        return group.count <= 3 && symbols.length === group.count ? `${listJoin(symbols)} (${group.issuerName})`
            : `${plural(group.count, `${group.issuerName} token`)}`;
    });
    const moreIssuers = groups.slice(3).reduce((total, group) => total + group.count, 0);
    if (moreIssuers > 0) addedParts.push(`${plural(moreIssuers, 'token')} from ${plural(groups.length - 3, 'other issuer')}`);
    const gone = removed.map((row) => row.symbol ?? row.mint).filter((name) => name !== null);
    const removedText = removed.length === 0 ? 'none removed'
        : `removed: ${gone.slice(0, 3).join(', ')}${removed.length > 3 ? ` and ${fmtNumber(removed.length - 3, 0)} more` : ''}`;
    if (groups.length === 0) {
        return { text: removed.length === 0 ? 'No token joined or left the universe' : `No token joined the universe; ${removedText}`, empty: removed.length === 0 };
    }
    return { text: `New in the universe: ${listJoin(addedParts)}; ${removedText}`, empty: false };
}

function redemptionHeadline(digest) {
    const covered = digest.redemptions.observed.filter((row) => num(row.redemptions) !== null && num(row.coveredHours) !== null && row.coveredHours > 0);
    if (covered.length === 0) return { text: 'Redemptions: no observation feed covered this week', empty: true };
    const ranked = [...covered].sort((a, b) => b.redemptions - a.redemptions || byText(a.issuer, b.issuer));
    const parts = ranked.slice(0, 3).map((row) => `${fmtNumber(row.redemptions, 0)} for ${row.issuerName} (${fmtNumber(row.coveredHours, 1)} of 168 h scanned)`);
    return { text: `Redemptions observed on-chain: ${listJoin(parts)}${andMore(ranked.length - parts.length, 'watched issuer')}`, empty: false };
}

function statusHeadline(digest) {
    if (digest.pairs.length === 0) return { text: 'Health moves: no snapshot comparison in this week', empty: true };
    const stories = rankStatusMoves(digest.moves);
    if (stories.length === 0) return { text: 'No health or status move between this week\'s snapshots', empty: true };
    const shown = stories.slice(0, HEADLINE_ITEMS);
    const rest = stories.slice(HEADLINE_ITEMS).reduce((total, story) => total + story.covers, 0);
    const text = shown.map((story) => story.text).join('; ');
    return { text: `${text.charAt(0).toUpperCase()}${text.slice(1)}${andMore(rest, 'status move')}`, empty: false };
}

function evidenceHeadline(digest) {
    const rows = digest.discrepancies;
    const events = digest.events;
    const ranked = rows.map((row, i) => ({ row, i })).sort((a, b) => severityRank(b.row.severity) - severityRank(a.row.severity) || a.i - b.i);
    const top = ranked[0]?.row ?? null;
    const disc = top === null ? 'No new claim-versus-reality discrepancy'
        : `${top.issuerName ?? top.issuer}: ${briefText(top.title, ITEM_CHARS) ?? 'a claim differs from the record'}`
            + ` (new discrepancy${rows.length > 1 ? `, ${fmtNumber(rows.length - 1, 0)} more this week` : ''})`;
    const watched = events === null || events.total === 0 ? '' : `; ${eventsPhrase(events)}`;
    return { text: `${disc}${watched}`, empty: rows.length === 0 && (events === null || events.total === 0) };
}

/**
 * The headline lines, in reading order, each `{anchor, text, empty}`. Each names the week's most
 * significant items — the token, issuer, what changed and by how much — with the rest of the section
 * as a trailing "and N more". Used by the page, the weekly index and og:description.
 */
export function weekHeadlines(digest) {
    return [
        { anchor: 'material', ...materialHeadline(digest) },
        { anchor: 'journal', ...journalHeadline(digest) },
        { anchor: 'tokens', ...tokensHeadline(digest) },
        { anchor: 'redemptions', ...redemptionHeadline(digest) },
        { anchor: 'status', ...statusHeadline(digest) },
        { anchor: 'evidence', ...evidenceHeadline(digest) }
    ];
}

export function ogTitle(digest) {
    return `This week in tokenized stocks — ${weekLabel(digest.week)}`;
}

/** One line: status of the week plus the non-empty headlines, trimmed to a tweetable length. */
export function ogDescription(digest, max = 200) {
    const status = digest.inProgress ? `${weekRange(digest.week)}, in progress` : weekRange(digest.week);
    const parts = weekHeadlines(digest).filter((line) => !line.empty).map((line) => line.text);
    const tokens = digest.numbers.tokens.value;
    if (tokens !== null) parts.push(`${fmtNumber(tokens, 0)} Solana tokens tracked`);
    const text = `${status}: ${parts.length ? parts.join('; ') : 'no recorded changes'}.`;
    return text.length <= max ? text : `${text.slice(0, max - 1).replace(/[\s;,:]+\S*$/, '')}…`;
}

function time(iso) {
    if (str(iso) === null) return '<span class="unknown">not recorded</span>';
    return `<time datetime="${escapeHtml(iso)}">${escapeHtml(/T/.test(iso) ? fmtDateTime(iso) : fmtDate(iso))}</time>`;
}

function signed(n) {
    if (n === 0) return '±0';
    return `${n > 0 ? '+' : '−'}${fmtNumber(Math.abs(n), 0)}`;
}

function metricTile(label, metric, basis) {
    const value = metric.value === null
        ? '<strong class="wk-missing">—</strong>'
        : `<strong>${escapeHtml(fmtNumber(metric.value, 0))}</strong>`;
    let delta;
    if (metric.value === null) delta = `<small class="unknown">${escapeHtml(metric.missing ?? 'not observed')}</small>`;
    else if (metric.delta !== null) delta = `<small>${escapeHtml(signed(metric.delta))} vs ${escapeHtml(metric.comparedWith)}</small>`;
    else delta = `<small class="unknown">${escapeHtml(metric.noDelta ?? 'no comparison')}</small>`;
    return `<li><span>${escapeHtml(label)}</span>${value}${delta}${basis ? `<small class="wk-basis">${basis}</small>` : ''}</li>`;
}

function numbersStrip(digest) {
    const n = digest.numbers;
    const snapBasis = (metric) => metric.observedAt === null ? '' : `snapshot ${time(metric.observedAt)}`;
    const trades = n.trades;
    let tradeBasis = '';
    if (trades.value !== null) {
        tradeBasis = 'sampled by the trade collector'
            + (trades.suspect ? ` · ${escapeHtml(fmtNumber(trades.suspect, 0))} flagged suspect` : '');
    }
    return `<ul class="wk-numbers" aria-label="Numbers of the week">${[
        metricTile('Tokens tracked', n.tokens, snapBasis(n.tokens)),
        metricTile('Issuer programmes with live tokens', n.issuersLive, snapBasis(n.issuersLive)),
        metricTile('Trades observed', trades, tradeBasis),
        metricTile('DeFi integrations', n.defiIntegrations, snapBasis(n.defiIntegrations))
    ].join('')}</ul>`;
}

function listCap(rows, render, moreText) {
    const shown = rows.slice(0, LIST_LIMIT).map(render).join('');
    const more = rows.length > LIST_LIMIT ? `<li class="muted">…and ${escapeHtml(fmtNumber(rows.length - LIST_LIMIT, 0))} more${moreText ? ` — ${moreText}` : ''}</li>` : '';
    return `${shown}${more}`;
}

function cardLink(row) {
    const label = escapeHtml(row.symbol ?? row.mint ?? 'token');
    return row.cardSlug ? `<a href="../cards/${encodeURIComponent(row.cardSlug)}.html">${label}</a>` : label;
}

/**
 * Issuer pages are named by issuer slug (`securitize`), while dossier-sourced rows can carry the
 * programme slug (`securitize-secz`). Resolve to the longest known issuer slug the value starts with;
 * an unknown issuer is shown as text, never linked to a page that does not exist.
 */
export function issuerPageSlug(slug, issuerNames) {
    const raw = str(slug);
    if (raw === null) return null;
    let best = null;
    for (const known of Object.keys(issuerNames ?? {})) {
        if ((raw === known || raw.startsWith(`${known}-`)) && (best === null || known.length > best.length)) best = known;
    }
    return best;
}

function issuerLink(slug, issuerNames, displayName = null) {
    const page = issuerPageSlug(slug, issuerNames);
    const name = str(displayName) ?? str(issuerNames?.[page ?? '']) ?? str(slug) ?? 'unknown issuer';
    if (page === null) return escapeHtml(name);
    return `<a href="../issuers/${encodeURIComponent(page)}.html">${escapeHtml(name)}</a>`;
}

/** The issuer's display name as plain text, for a fold row's closed line (links live in its body). */
function issuerName(slug, issuerNames, displayName = null) {
    return str(displayName) ?? str(issuerNames?.[issuerPageSlug(slug, issuerNames) ?? '']) ?? str(slug);
}

/** A journal href is written relative to the site root (`./issuers/x.html`); these pages sit one level down. */
function rootHref(href) {
    const value = str(href);
    if (value === null || /^[a-z]+:/i.test(value) || value.startsWith('//')) return value;
    return `../${value.replace(/^\.\//, '').replace(/^\//, '')}`;
}

function section(anchor, title, body, count) {
    return `<details class="dossier-section wk-detail" id="${anchor}"><summary>${escapeHtml(title)}`
        + `${count === null ? '' : ` <span class="wk-count">${escapeHtml(count)}</span>`}</summary>${body}</details>`;
}

function materialSection(digest) {
    const rows = digest.material;
    let body;
    if (rows === null) {
        body = '<p class="unknown">The change judge\'s verdicts (sonar.change_judgment) could not be read for this build, so this page cannot say whether any change was material.</p>';
    } else if (rows.length === 0) {
        body = '<p>No change detected this week was read as material by the change judge.</p>';
    } else {
        // One row per change: date, severity and what changed closed, the model's reading on line
        // two; the full reading and the links (issuer, diff) open.
        body = foldListHtml(rows.map((row) => ({
            id: foldAnchor('material', row.id),
            tone: row.assessmentSeverity,
            when: foldWhen(row.detectedAt),
            chip: row.assessmentSeverity ?? 'model assessment',
            title: row.change ?? row.kind ?? '',
            meta: row.issuerSlug ? issuerName(row.issuerSlug, digest.issuerNames) : null,
            line2: row.assessment,
            body: `<p><span class="claim-kind">model assessment${row.assessmentSeverity ? ` · ${escapeHtml(row.assessmentSeverity)}` : ''}</span> `
                + `${time(row.detectedAt)}${row.issuerSlug ? ` · ${issuerLink(row.issuerSlug, digest.issuerNames)}` : ''}</p>`
                + `<p>${escapeHtml(row.change ?? row.kind ?? '')}</p><q>${escapeHtml(row.assessment)}</q> `
                + `<a href="../watch.html?material=true#change-${encodeURIComponent(row.id)}">The diff and the reading →</a>`
        })), { className: 'wk-fold' });
    }
    const note = '<p class="muted">A language model\'s reading of each detected document or on-chain diff. It is not a legal conclusion. The diff it read is on the change feed.</p>';
    return section('material', 'Material changes (model assessment)', note + body, rows === null ? 'n/a' : String(rows.length));
}

function journalSection(digest) {
    const rows = digest.journal;
    const body = rows.length === 0 ? '<p>The public change journal recorded nothing first observed this week.</p>'
        : foldListHtml(rows.map((item) => {
            const assets = Array.isArray(item.assets) ? item.assets : [];
            const protocol = item.category === 'protocol-change' ? str(item.actor) : null;
            const assetLinks = assets.length === 0 ? '' : `<details><summary>${escapeHtml(plural(assets.length, 'token'))}</summary><ul class="asset-chips">${listCap(assets, (asset) => {
                const page = protocol === null ? null : digest.protocolPages[`${asset.mint}|${protocol.toLowerCase()}`] ?? null;
                const slug = str(asset.href)?.match(/cards\/([^/]+)\.html$/)?.[1] ?? cardSlug(asset.symbol, asset.mint);
                const card = `<a href="../cards/${encodeURIComponent(decodeURIComponent(slug))}.html">${escapeHtml(asset.symbol ?? asset.mint)}</a>`;
                return `<li>${card}${page ? ` <a href="../protocols/${encodeURIComponent(page)}.html">${escapeHtml(protocol)} dossier</a>` : ''}</li>`;
            }, item.issuer ? `see ${issuerLink(item.issuer, digest.issuerNames)}` : '')}</ul></details>`;
            const href = rootHref(item.href);
            // One row per change; the linked title, why it matters and the tokens open.
            return {
                id: foldAnchor('journal', item.id),
                tone: item.severity,
                when: foldWhen(item.date),
                chip: item.severity,
                title: item.title ?? item.id ?? '',
                meta: str(item.category) === null ? null : humanizeSlug(item.category),
                line2: item.whyItMatters,
                body: `<p><span class="claim-kind">${escapeHtml(item.category ?? '')} · ${escapeHtml(item.severity ?? '')}</span> ${time(item.date)}</p>`
                    + `<p><strong>${href ? `<a href="${escapeHtml(href)}">${escapeHtml(item.title ?? item.id)}</a>` : escapeHtml(item.title ?? item.id)}</strong></p>`
                    + `${str(item.whyItMatters) ? `<p class="muted">${escapeHtml(item.whyItMatters)}</p>` : ''}${assetLinks}`
            };
        }), { className: 'wk-fold' });
    return section('journal', 'Issuer, venue and protocol changes', body
        + '<p class="muted">From the public change journal: changes by issuers, venues, protocols and sources, and tokens joining or leaving the universe. RWA Sonar\'s own editorial corrections are excluded.</p>', String(rows.length));
}

function tokensSection(digest) {
    const groups = digest.newTokens;
    const added = sum(groups, 'count');
    const addedBody = groups.length === 0 ? '<p>No token joined the universe this week.</p>'
        : groups.map((group) => `<h3>${issuerLink(group.issuer, digest.issuerNames, group.issuerName)} <span class="wk-count">${escapeHtml(fmtNumber(group.count, 0))}</span></h3>`
            + `<ul class="asset-chips">${listCap(group.tokens, (row) => `<li>${cardLink(row)} <span>${escapeHtml((row.firstSeenAt ?? '').slice(0, 10))}</span></li>`,
                `all on ${issuerLink(group.issuer, digest.issuerNames, group.issuerName)}`)}</ul>`).join('');
    const removedBody = digest.removed.length === 0 ? '<p>No token left the universe this week.</p>'
        : `<ul class="asset-chips">${listCap(digest.removed, (row) => `<li>${cardLink(row)} <span>gone by ${escapeHtml(row.date)}</span></li>`)}</ul>`;
    const note = '<p class="muted">"Joined the universe" is when RWA Sonar first confirmed the exact token address (stocks-tokens.json <code>firstSeenAt</code>). The issuer may have minted it earlier. Tokens known when records began are not counted as new.</p>';
    return section('tokens', 'New and removed tokens', `${note}<h3>Joined the universe (${escapeHtml(fmtNumber(added, 0))})</h3>${addedBody}<h3>Removed (${escapeHtml(fmtNumber(digest.removed.length, 0))})</h3>${removedBody}`,
        `+${fmtNumber(added, 0)} / −${fmtNumber(digest.removed.length, 0)}`);
}

function redemptionSection(digest) {
    const { observed, withoutFeed } = digest.redemptions;
    const rows = observed.map((row) => {
        if (!row.observable) {
            // The reason is a paragraph; folded, so it does not set the table's column widths.
            return `<tr><td>${issuerLink(row.issuer, digest.issuerNames, row.issuerName)}</td><td colspan="2" class="unknown">not observable on-chain`
                + `${row.why ? `<details class="wk-why"><summary>Why</summary><p>${escapeHtml(row.why)}</p></details>` : ''}</td><td>—</td></tr>`;
        }
        const count = row.redemptions === null ? '<span class="unknown">not covered</span>' : escapeHtml(fmtNumber(row.redemptions, 0));
        return `<tr><td>${issuerLink(row.issuer, digest.issuerNames, row.issuerName)}</td><td>${count}${row.completionObservable ? '' : ' <small>on-chain leg only</small>'}</td>`
            + `<td>${escapeHtml(fmtNumber(row.coveredHours, 1))} of 168 h</td><td>${time(row.lastScanAt)}</td></tr>`;
    }).join('');
    const table = observed.length === 0 ? '<p class="unknown">No issuer carried a redemption observation feed in this build.</p>'
        : `<div class="table-wrap"><table class="wk-redemptions"><colgroup><col class="wk-col-issuer" /><col class="wk-col-count" /><col class="wk-col-coverage" /><col class="wk-col-scan" /></colgroup>`
            + `<thead><tr><th>Issuer</th><th>Redemptions observed</th><th>Scan coverage this week</th><th>Last scan</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    const missing = withoutFeed.length === 0 ? ''
        : `<p class="muted">No on-chain redemption feed for: ${withoutFeed.map((row) => issuerLink(row.issuer, digest.issuerNames, row.issuerName)).join(', ')}. Their redemptions are documented or unknown; none are observed on-chain.</p>`;
    const covered = observed.filter((row) => row.redemptions !== null);
    return section('redemptions', 'Redemptions observed', `${table}${missing}<p class="muted">Counted from the recurring on-chain scan (stocks/observe-redemptions.mjs). Hours not covered by a scan say nothing either way.</p>`,
        covered.length === 0 ? 'n/a' : fmtNumber(sum(covered, 'redemptions'), 0));
}

function statusSection(digest) {
    if (digest.pairs.length === 0) {
        return section('status', 'Health and status moves', '<p class="unknown">No two consecutive daily snapshots end in this week, so no moves can be stated.</p>', 'n/a');
    }
    const compared = digest.pairs.map((pair) => `${escapeHtml(pair.from ?? '?')} → ${escapeHtml(pair.to)}`).join(', ');
    const kinds = MOVE_ORDER.filter((kind) => digest.moves.has(kind));
    const body = kinds.length === 0 ? '<p>No health or status move between the compared snapshots.</p>'
        : kinds.map((kind) => {
            const rows = digest.moves.get(kind);
            return `<details><summary>${escapeHtml(MOVE_LABELS[kind])} <span class="wk-count">${escapeHtml(fmtNumber(rows.length, 0))}</span></summary>`
                + `<ul class="wk-list wk-compact">${listCap(rows, (row) => `<li>${cardLink(row)}${row.issuer ? ` · ${issuerLink(row.issuer, digest.issuerNames)}` : ''} — ${escapeHtml(row.note ?? '')}</li>`,
                    '<a href="../monitor.html">the monitor</a> has the full list')}</ul></details>`;
        }).join('');
    const total = kinds.reduce((n, kind) => n + digest.moves.get(kind).length, 0);
    return section('status', 'Health and status moves', `<p class="muted">Daily snapshots compared: ${compared}.</p>${body}`, fmtNumber(total, 0));
}

function evidenceSection(digest) {
    const disc = digest.discrepancies.length === 0 ? '<p>No new claim-versus-reality discrepancy was recorded this week.</p>'
        : foldListHtml(digest.discrepancies.map((row) => ({
            id: foldAnchor('discrepancy', row.id),
            tone: row.severity,
            when: foldWhen(row.observedAt),
            chip: row.severity,
            title: row.title ?? row.id ?? '',
            meta: issuerName(row.issuer, digest.issuerNames, row.issuerName),
            line2: row.impact,
            body: `<p><span class="claim-kind">${escapeHtml(row.severity ?? '')}</span> ${time(row.observedAt)} · `
                + `${issuerLink(row.issuer, digest.issuerNames, row.issuerName)}</p><p>${escapeHtml(row.title ?? row.id ?? '')}</p>`
                + `${row.impact ? `<p class="muted">${escapeHtml(row.impact)}</p>` : ''}`
        })), { className: 'wk-fold' });
    const events = digest.events;
    const eventBody = events === null ? '<p class="unknown">Watcher change events (sonar.change_event) could not be read for this build.</p>'
        : events.total === 0 ? '<p>The source and chain watchers raised no change event this week.</p>'
            : `<ul class="whatif-counts">${Object.entries(events.byKind).map(([kind, n]) => `<li>${escapeHtml(kind)} <strong>${escapeHtml(fmtNumber(n, 0))}</strong></li>`).join('')}</ul>`
                + '<p><a href="../watch.html">Every event with its diff on the change feed →</a></p>';
    const whatIf = '<p class="muted">What-if answers and individual claims carry no change date in the built data, so this page cannot say which of them are new this week. Current answers: <a href="../whatif.html">what-if list</a>; open evidence gaps: <a href="../review.html">review queue</a>.</p>';
    const count = digest.discrepancies.length + (events?.total ?? 0);
    return section('evidence', 'Discrepancies and evidence changes',
        `<h3>New discrepancies</h3>${disc}<h3>Watcher change events</h3>${eventBody}${whatIf}`, String(count));
}

function sourcesFooter(digest) {
    const rows = Object.entries(digest.sources).map(([label, value]) => {
        const at = value === null || value === undefined ? '<span class="unknown">not read in this build</span>' : time(value);
        return `<li>${escapeHtml(label)} · ${at}</li>`;
    }).join('');
    return `<footer><h2>Data</h2><ul class="wk-sources">${rows}</ul>`
        + `<p class="muted">Built from the data's own timestamps (newest input ${time(digest.asOf)}); all text on this page is generated from that data. Missing values are shown as missing, never as zero.</p>`
        + `<p><a href="index.html">All weeks</a></p>${contactFooterHtml('../', { inner: true })}</footer>`;
}

/** The page head; `image` is the page's own absolute preview `{url, alt, width, height}`, null for the site image. */
function head({ title, description, pageUrl, version, ogTitleText, image = null, jsonLd = null }) {
    const v = version ? `?v=${encodeURIComponent(version)}` : '';
    return '<!doctype html>\n<!-- Generated by stocks/build-weekly.mjs. Do not edit: rebuilt from the built data on every refresh. -->\n'
        + '<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />\n'
        + siteNav.themeScriptHtml('../') + '\n'
        + seoHeadTags({ title, description, socialTitle: ogTitleText, url: pageUrl, type: 'article', image, jsonLd, sep: '\n' }) + '\n'
        + '<link rel="icon" type="image/svg+xml" href="../images/variant3.svg" />\n'
        + `<link rel="stylesheet" href="../app-shell.css${v}" /><link rel="stylesheet" href="../templates.css${v}" /><link rel="stylesheet" href="../weekly.css${v}" />${contactStylesheet('../')}</head><body>\n`
        + siteNav.siteHeaderHtml('../', 'weekly/latest.html') + '\n';
}

function origin(baseUrl) {
    return typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim().replace(/\/+$/, '') : null;
}

/**
 * One week's page. `baseUrl` is required for og:url and the canonical link; without it both are
 * left out rather than guessed. `hasNext` says whether a later week page exists.
 */
export function renderWeekPage(digest, { baseUrl = null, version = '', hasNext = false, ogImage = null } = {}) {
    const site = origin(baseUrl);
    const pageUrl = site === null ? null : `${site}/weekly/${digest.week.id}.html`;
    const title = `${ogTitle(digest)} — RWA Sonar`;
    const description = ogDescription(digest);
    const status = digest.inProgress
        ? `<span class="wk-status wk-live">In progress, as of ${time(digest.asOf)}</span>`
        : '<span class="wk-status">Complete week</span>';
    const nav = `<nav class="wk-nav" aria-label="Other weeks">${digest.prevWeek ? `<a href="${digest.prevWeek.id}.html">← ${escapeHtml(weekLabel(digest.prevWeek))}</a>` : '<span></span>'}`
        + `<a href="index.html">All weeks</a>${hasNext ? `<a href="${nextWeekId(digest.week)}.html">${escapeHtml(weekLabel(weekFromId(nextWeekId(digest.week))))} →</a>` : '<span></span>'}</nav>`;
    const headlines = `<ol class="wk-headlines">${weekHeadlines(digest).map((line) => `<li class="${line.empty ? 'wk-empty' : ''}"><a href="#${line.anchor}">${escapeHtml(line.text)}</a></li>`).join('')}</ol>`;
    const jsonLd = site === null ? null : ldGraph([
        organizationLd(site),
        reportLd({ origin: site, url: pageUrl, headline: ogTitle(digest), description, dateModified: digest.asOf, image: ogImage?.url ?? null }),
        breadcrumbLd([{ name: 'RWA Sonar', url: `${site}/` }, { name: 'Weekly', url: `${site}/weekly/` }, { name: weekLabel(digest.week), url: pageUrl }])
    ]);
    return head({ title, description, pageUrl, version, ogTitleText: ogTitle(digest), image: ogImage, jsonLd })
        + `<main class="wk-page"><p class="eyebrow">This week in tokenized stocks</p><h1>${escapeHtml(weekLabel(digest.week).replace(/^w/, 'W'))}</h1>`
        + `<p class="lede">${escapeHtml(weekRange(digest.week))} (Monday 00:00 UTC to Sunday 24:00 UTC) ${status}</p>${nav}`
        + `<section class="wk-top"><h2>Numbers of the week</h2>${numbersStrip(digest)}<h2>Headlines</h2>${headlines}</section>`
        + materialSection(digest) + journalSection(digest) + tokensSection(digest) + redemptionSection(digest)
        + statusSection(digest) + evidenceSection(digest)
        + sourcesFooter(digest) + `</main></body></html>\n`;
}

/** The id of the week after `week`. */
export function nextWeekId(week) {
    return isoWeekOf(ms(week.start) + WEEK_MS).id;
}

/** weekly/index.html: every week, newest first, with its headlines as one line each. */
export function renderWeeklyIndex(digests, { baseUrl = null, version = '', ogImage = null } = {}) {
    const site = origin(baseUrl);
    const latest = digests.at(-1) ?? null;
    const description = 'A weekly, sourced digest of tokenized stocks on Solana: material changes, new and removed tokens, redemptions, health moves and evidence changes.';
    const rows = [...digests].reverse().map((digest) => `<article class="template-card"><h2><a href="${digest.week.id}.html">${escapeHtml(weekLabel(digest.week).replace(/^w/, 'W'))}</a></h2>`
        + `<p class="muted">${escapeHtml(weekRange(digest.week))}${digest.inProgress ? ` · in progress, as of ${time(digest.asOf)}` : ''}</p>`
        + `<ul class="wk-list wk-compact">${weekHeadlines(digest).map((line) => `<li class="${line.empty ? 'wk-empty' : ''}">${escapeHtml(line.text)}</li>`).join('')}</ul></article>`).join('');
    const indexUrl = site === null ? null : `${site}/weekly/`;
    const jsonLd = site === null ? null : ldGraph([
        organizationLd(site),
        webPageLd({ origin: site, url: indexUrl, name: 'This week in tokenized stocks — RWA Sonar', description, type: 'CollectionPage', dateModified: latest?.asOf ?? null }),
        breadcrumbLd([{ name: 'RWA Sonar', url: `${site}/` }, { name: 'Weekly', url: indexUrl }])
    ]);
    return head({ title: 'This week in tokenized stocks — RWA Sonar', description,
        pageUrl: indexUrl, version, ogTitleText: 'This week in tokenized stocks', image: ogImage, jsonLd })
        + '<main class="wk-page"><p class="eyebrow">Weekly digest</p><h1>This week in tokenized stocks</h1>'
        + `<p class="lede">${escapeHtml(description)} Every figure comes from the built data and says when it was observed.</p>`
        + (latest ? `<p><a class="open-template" href="latest.html">Latest: ${escapeHtml(weekLabel(latest.week))} →</a></p>` : '<p class="unknown">No week has recorded data yet.</p>')
        + `<div class="template-grid">${rows}</div>`
        + `</main>${contactFooterHtml('../')}</body></html>\n`;
}
