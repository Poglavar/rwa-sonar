// PURE model and markup for "This week in tokenized stocks" (weekly/<YYYY-Www>.html): ISO-week
// arithmetic (weeks start Monday 00:00 UTC), the per-week digest assembled from already-built data
// (daily snapshots and their diffs, stocks-tokens.json firstSeenAt, the public change journal, issuer
// discrepancies and redemption feeds, and the database's model assessments, watcher events and trade
// counts), and the static HTML. No fs, no network, no clock: the build instant is always the data's
// own newest timestamp, so the same inputs render byte-identical pages. Tested in ../weekly.test.js.

import fmt from './fmt.js';
import {
    SITE_IMAGE, breadcrumbLd, contactFooterHtml, contactStylesheet, ldGraph, organizationLd, reportLd, seoHeadTags, webPageLd
} from './site-seo.mjs';

const { escapeHtml, fmtDate, fmtDateTime, fmtNumber, cardSlug } = fmt;

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
                title: str(row.title), severity: str(row.severity), observedAt: row.observedAt });
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

/** First observation records prove a watcher started, not that anything changed (api/src/lib/evidence.js). */
const PUBLIC_CHANGE_CONDITION = `NOT (e.kind = 'status' AND e.field = 'chain-watch'
             AND COALESCE(e.summary, '') ~* '^baseline recorded:')`;

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

function moveCount(digest, kind) {
    return digest.moves.get(kind)?.length ?? 0;
}

/** The headline lines, in reading order, each `{anchor, text, empty}`. Used by the page and og:description. */
export function weekHeadlines(digest) {
    const lines = [];
    const material = digest.material;
    lines.push({
        anchor: 'material',
        text: material === null ? 'Material changes: model assessments not available in this build'
            : `${plural(material.length, 'material change')} (model assessment)`,
        empty: material === null || material.length === 0
    });
    const journal = digest.journal.length;
    lines.push({ anchor: 'journal', text: `${plural(journal, 'issuer, venue or protocol change')} in the change journal`, empty: journal === 0 });
    const added = sum(digest.newTokens, 'count');
    const removed = digest.removed.length;
    lines.push({
        anchor: 'tokens',
        text: `${plural(added, 'token')} first catalogued, ${fmtNumber(removed, 0)} removed`,
        empty: added === 0 && removed === 0
    });
    const covered = digest.redemptions.observed.filter((row) => row.redemptions !== null);
    const redeemed = sum(covered, 'redemptions');
    lines.push({
        anchor: 'redemptions',
        text: covered.length === 0 ? 'Redemptions: no observation feed covered this week'
            : `${plural(redeemed, 'redemption')} observed on-chain across ${plural(covered.length, 'watched issuer')}`,
        empty: covered.length === 0
    });
    const worse = moveCount(digest, 'health-worse');
    const better = moveCount(digest, 'health-better');
    const otherMoves = [...digest.moves.values()].reduce((total, list) => total + list.length, 0) - worse - better;
    lines.push({
        anchor: 'status',
        text: digest.pairs.length === 0 ? 'Health moves: no snapshot comparison in this week'
            : `Health: ${fmtNumber(worse, 0)} worse, ${fmtNumber(better, 0)} better · ${plural(otherMoves, 'other status move')}`,
        empty: digest.pairs.length === 0
    });
    const events = digest.events;
    lines.push({
        anchor: 'evidence',
        text: `${plural(digest.discrepancies.length, 'new discrepancy', 'new discrepancies')}`
            + (events === null ? '' : ` · ${plural(events.total, 'watcher change event')}`),
        empty: digest.discrepancies.length === 0 && (events === null || events.total === 0)
    });
    return lines;
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
        body = `<ul class="wk-list">${rows.map((row) => `<li><span class="claim-kind">model assessment${row.assessmentSeverity ? ` · ${escapeHtml(row.assessmentSeverity)}` : ''}</span> `
            + `${time(row.detectedAt)}${row.issuerSlug ? ` · ${issuerLink(row.issuerSlug, digest.issuerNames)}` : ''}`
            + `<p>${escapeHtml(row.change ?? row.kind ?? '')}</p><q>${escapeHtml(row.assessment)}</q> `
            + `<a href="../watch.html?material=true#change-${encodeURIComponent(row.id)}">The diff and the reading →</a></li>`).join('')}</ul>`;
    }
    const note = '<p class="muted">A language model\'s reading of each detected document or on-chain diff. It is not a legal conclusion. The diff it read is on the change feed.</p>';
    return section('material', 'Material changes (model assessment)', note + body, rows === null ? 'n/a' : String(rows.length));
}

function journalSection(digest) {
    const rows = digest.journal;
    const body = rows.length === 0 ? '<p>The public change journal recorded nothing first observed this week.</p>'
        : `<ul class="wk-list">${rows.map((item) => {
            const assets = Array.isArray(item.assets) ? item.assets : [];
            const protocol = item.category === 'protocol-change' ? str(item.actor) : null;
            const assetLinks = assets.length === 0 ? '' : `<details><summary>${escapeHtml(plural(assets.length, 'token'))}</summary><ul class="asset-chips">${listCap(assets, (asset) => {
                const page = protocol === null ? null : digest.protocolPages[`${asset.mint}|${protocol.toLowerCase()}`] ?? null;
                const slug = str(asset.href)?.match(/cards\/([^/]+)\.html$/)?.[1] ?? cardSlug(asset.symbol, asset.mint);
                const card = `<a href="../cards/${encodeURIComponent(decodeURIComponent(slug))}.html">${escapeHtml(asset.symbol ?? asset.mint)}</a>`;
                return `<li>${card}${page ? ` <a href="../protocols/${encodeURIComponent(page)}.html">${escapeHtml(protocol)} dossier</a>` : ''}</li>`;
            }, item.issuer ? `see ${issuerLink(item.issuer, digest.issuerNames)}` : '')}</ul></details>`;
            const href = rootHref(item.href);
            return `<li><span class="claim-kind">${escapeHtml(item.category ?? '')} · ${escapeHtml(item.severity ?? '')}</span> ${time(item.date)}`
                + `<p><strong>${href ? `<a href="${escapeHtml(href)}">${escapeHtml(item.title ?? item.id)}</a>` : escapeHtml(item.title ?? item.id)}</strong></p>`
                + `${str(item.whyItMatters) ? `<p class="muted">${escapeHtml(item.whyItMatters)}</p>` : ''}${assetLinks}</li>`;
        }).join('')}</ul>`;
    return section('journal', 'Issuer, venue and protocol changes', body
        + '<p class="muted">From the public change journal: changes by issuers, venues, protocols and sources, and catalogue membership changes. RWA Sonar\'s own editorial corrections are excluded.</p>', String(rows.length));
}

function tokensSection(digest) {
    const groups = digest.newTokens;
    const added = sum(groups, 'count');
    const addedBody = groups.length === 0 ? '<p>No token was first catalogued this week.</p>'
        : groups.map((group) => `<h3>${issuerLink(group.issuer, digest.issuerNames, group.issuerName)} <span class="wk-count">${escapeHtml(fmtNumber(group.count, 0))}</span></h3>`
            + `<ul class="asset-chips">${listCap(group.tokens, (row) => `<li>${cardLink(row)} <span>${escapeHtml((row.firstSeenAt ?? '').slice(0, 10))}</span></li>`,
                `all on ${issuerLink(group.issuer, digest.issuerNames, group.issuerName)}`)}</ul>`).join('');
    const removedBody = digest.removed.length === 0 ? '<p>No token left the catalogue this week.</p>'
        : `<ul class="asset-chips">${listCap(digest.removed, (row) => `<li>${cardLink(row)} <span>gone by ${escapeHtml(row.date)}</span></li>`)}</ul>`;
    const note = '<p class="muted">"First catalogued" is when RWA Sonar first confirmed the exact token address (stocks-tokens.json <code>firstSeenAt</code>). The issuer may have minted it earlier. Tokens known when records began are not counted as new.</p>';
    return section('tokens', 'New and removed tokens', `${note}<h3>First catalogued (${escapeHtml(fmtNumber(added, 0))})</h3>${addedBody}<h3>Removed (${escapeHtml(fmtNumber(digest.removed.length, 0))})</h3>${removedBody}`,
        `+${fmtNumber(added, 0)} / −${fmtNumber(digest.removed.length, 0)}`);
}

function redemptionSection(digest) {
    const { observed, withoutFeed } = digest.redemptions;
    const rows = observed.map((row) => {
        if (!row.observable) {
            return `<tr><td>${issuerLink(row.issuer, digest.issuerNames, row.issuerName)}</td><td colspan="2" class="unknown">not observable on-chain${row.why ? `: ${escapeHtml(row.why)}` : ''}</td><td>—</td></tr>`;
        }
        const count = row.redemptions === null ? '<span class="unknown">not covered</span>' : escapeHtml(fmtNumber(row.redemptions, 0));
        return `<tr><td>${issuerLink(row.issuer, digest.issuerNames, row.issuerName)}</td><td>${count}${row.completionObservable ? '' : ' <small>on-chain leg only</small>'}</td>`
            + `<td>${escapeHtml(fmtNumber(row.coveredHours, 1))} of 168 h</td><td>${time(row.lastScanAt)}</td></tr>`;
    }).join('');
    const table = observed.length === 0 ? '<p class="unknown">No issuer carried a redemption observation feed in this build.</p>'
        : `<div class="table-wrap"><table><thead><tr><th>Issuer</th><th>Redemptions observed</th><th>Scan coverage this week</th><th>Last scan</th></tr></thead><tbody>${rows}</tbody></table></div>`;
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
        : `<ul class="wk-list">${digest.discrepancies.map((row) => `<li><span class="claim-kind">${escapeHtml(row.severity ?? '')}</span> ${time(row.observedAt)} · `
            + `${issuerLink(row.issuer, digest.issuerNames, row.issuerName)}<p>${escapeHtml(row.title ?? row.id ?? '')}</p></li>`).join('')}</ul>`;
    const events = digest.events;
    const eventBody = events === null ? '<p class="unknown">Watcher change events (sonar.change_event) could not be read for this build.</p>'
        : events.total === 0 ? '<p>The source and chain watchers raised no change event this week.</p>'
            : `<ul class="whatif-counts">${Object.entries(events.byKind).map(([kind, n]) => `<li>${escapeHtml(kind)} <strong>${escapeHtml(fmtNumber(n, 0))}</strong></li>`).join('')}</ul>`
                + '<p><a href="../watch.html">Every event with its diff on the change feed →</a></p>';
    const whatIf = '<p class="muted">What-if answers and individual claims carry no change date in the built data, so this page cannot say which of them are new this week. Current answers: <a href="../whatif.html">what-if catalogue</a>; open evidence gaps: <a href="../review.html">review queue</a>.</p>';
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
        + seoHeadTags({ title, description, socialTitle: ogTitleText, url: pageUrl, type: 'article', image, jsonLd, sep: '\n' }) + '\n'
        + '<link rel="icon" type="image/svg+xml" href="../images/variant3.svg" />\n'
        + `<link rel="stylesheet" href="../templates.css${v}" /><link rel="stylesheet" href="../weekly.css${v}" />${contactStylesheet('../')}</head><body>\n`
        + '<header class="site-head"><a href="../">RWA Sonar</a><nav><a href="../stocks.html?view=assets">Explore</a><a href="../stocks.html?view=compare">Compare</a><a href="../watch.html">Changes</a><a href="./">Weekly</a><a href="../learn/">Learn</a></nav></header>\n';
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
