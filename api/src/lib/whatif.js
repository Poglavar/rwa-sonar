// Pure SQL builders and parameter validation for the what-if surface: `sonar.failure_mode` (the
// 38 shared questions every issuer is asked) and `sonar.what_if` (each issuer's answer to each of
// them). Same contract as lib/query.js and lib/evidence.js: nothing here touches the database or
// Hono, filter names come from whitelists and only VALUES travel as $n parameters, so the whole
// surface is unit-testable without a server (api/test/whatif.test.js).
//
// One thing to know about `status` here: the five stored statuses are documented | inferred |
// litigated | unknown | not-applicable, and `missing` is NOT one of them. A mode an issuer has not
// answered has NO ROW — the absence is the finding — so `missing` is the name this API gives to
// that absence, produced by coalesce() over a LEFT JOIN. It can be filtered on and counted like a
// status, but nothing ever stores it (the table's CHECK constraint would reject it).

import { badRequest, createParams, filterSetConditions, parseFilterEntries, whereClause } from './query.js';

/** The five statuses a stored answer may carry, in the order the catalogue lists them. */
export const ANSWER_STATUSES = ['documented', 'inferred', 'litigated', 'unknown', 'not-applicable'];

/** What this API calls a mode with no answer row. Never stored; see the file header. */
export const MISSING_STATUS = 'missing';

export const WHAT_IF_FROM = `FROM sonar.what_if w
  JOIN sonar.failure_mode m ON m.id = w.mode_id
  LEFT JOIN sonar.source s ON s.id = w.source_id`;

export const WHAT_IF_FILTERS = {
    mode: { sql: 'w.mode_id', kind: 'text' },
    issuer: { sql: 'w.issuer_slug', kind: 'text' },
    status: { sql: 'w.status', kind: 'text' },
    actor: { sql: 'm.actor', kind: 'text' },
    flow: { sql: 'm.flow', kind: 'text' }
};

export const WHAT_IF_COLUMNS = `w.id, w.issuer_slug, w.mode_id, w.status, w.outcome, w.quote,
    w.url, w.locator, w.accessed_at, w.cases, w.searched, w.note, w.source_id,
    m.actor, m.flow, m.question, m.ord,
    s.title AS source_title, s.kind AS source_kind, s.status AS source_status,
    s.archive_url AS source_archive_url, s.last_checked_at AS source_last_checked_at`;

/**
 * Evidence order, not alphabetical: `documented` and `litigated` rest on somebody else's words,
 * `inferred` is our own reading, `unknown` is a researched gap and `not-applicable` is the case
 * not arising. An unrecognised value sorts last rather than in the middle.
 */
export const WHAT_IF_STATUS_ORDER = `CASE w.status
      WHEN 'documented' THEN 0
      WHEN 'litigated' THEN 1
      WHEN 'inferred' THEN 2
      WHEN 'unknown' THEN 3
      WHEN 'not-applicable' THEN 4
      ELSE 9 END`;

/** `mode` sorts by the catalogue's own order, never by id — see failure_mode.ord. */
export const WHAT_IF_SORTS = {
    mode: 'm.ord',
    issuer: 'w.issuer_slug',
    status: WHAT_IF_STATUS_ORDER,
    actor: 'm.actor',
    accessed_at: 'w.accessed_at',
    updated_at: 'w.updated_at'
};

/** One filter set, read against this surface's own table of definitions. */
export function parseWhatIfFilters(queries, ignore = []) {
    return parseFilterEntries(queries, WHAT_IF_FILTERS, ignore);
}

export function buildWhatIfCountSql(filters) {
    const params = createParams();
    const where = whereClause(filterSetConditions(filters, WHAT_IF_FILTERS, params));
    return {
        text: `SELECT count(*)::int AS total\n  ${WHAT_IF_FROM}\n  ${where}`.trimEnd(),
        values: params.values
    };
}

export function buildWhatIfListSql(filters, { sort = 'mode', order = 'asc', limit = 100, offset = 0 } = {}) {
    const expr = WHAT_IF_SORTS[sort];
    if (!expr) throw badRequest('unknown_sort', `unknown sort "${sort}"`);
    const params = createParams();
    const where = whereClause(filterSetConditions(filters, WHAT_IF_FILTERS, params));
    const text = `SELECT ${WHAT_IF_COLUMNS}\n  ${WHAT_IF_FROM}\n  ${where}\n  `
        + `ORDER BY ${expr} ${order.toUpperCase()} NULLS LAST, w.issuer_slug ASC, m.ord ASC\n  `
        + `LIMIT ${params.add(limit)} OFFSET ${params.add(offset)}`;
    return { text, values: params.values };
}

/**
 * The catalogue with, per mode, how many issuers answered it and how each of them answered.
 * A LEFT JOIN, so a mode nobody has answered still comes back — with zeros, which is the whole
 * point of the route: the questions nobody can answer are the finding.
 *
 * `count(w.id)` rather than `count(*)`: over a LEFT JOIN with no match, `count(*)` would report 1.
 */
export function buildFailureModeSummarySql() {
    const filters = ANSWER_STATUSES
        .map((status) => `    count(*) FILTER (WHERE w.status = '${status}')::int`
            + `${' '.repeat(Math.max(1, 16 - status.length))}AS ${status.replace(/-/g, '_')}`)
        .join(',\n');
    return {
        text: `SELECT m.id, m.actor, m.flow, m.question, m.look_for, m.ord,
    count(w.id)::int AS answered,
${filters}
  FROM sonar.failure_mode m
  LEFT JOIN sonar.what_if w ON w.mode_id = m.id
  GROUP BY m.id, m.actor, m.flow, m.question, m.look_for, m.ord
  ORDER BY m.ord ASC`,
        values: []
    };
}

/**
 * One issuer's whole answer sheet: every catalogue mode in catalogue order, its answer when there
 * is one, and `status = 'missing'` when there is not. The LEFT JOIN carries the issuer slug in its
 * ON clause rather than in a WHERE, because a WHERE on `w.issuer_slug` would drop the unanswered
 * modes and turn the answer sheet back into a list of answers — which is the one thing this route
 * exists not to be.
 */
export function buildIssuerWhatIfSql(issuerSlug) {
    const params = createParams();
    const p = params.add(issuerSlug);
    const text = `SELECT m.id AS mode_id, m.actor, m.flow, m.question, m.look_for, m.ord,
    coalesce(w.status, '${MISSING_STATUS}') AS status,
    w.id, w.issuer_slug, w.outcome, w.quote, w.url, w.locator, w.accessed_at,
    w.cases, w.searched, w.note, w.source_id,
    s.title AS source_title, s.kind AS source_kind, s.status AS source_status,
    s.archive_url AS source_archive_url, s.last_checked_at AS source_last_checked_at
  FROM sonar.failure_mode m
  LEFT JOIN sonar.what_if w ON w.mode_id = m.id AND w.issuer_slug = ${p}
  LEFT JOIN sonar.source s ON s.id = w.source_id
  ORDER BY m.ord ASC`;
    return { text, values: params.values };
}

/** Per-status counts over an answer-sheet result, `missing` included. Every key always present. */
export function summariseAnswerSheet(rows) {
    const counts = {};
    for (const status of ANSWER_STATUSES) counts[status] = 0;
    counts[MISSING_STATUS] = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
        const status = row?.status;
        // An unrecognised status is counted under its own key rather than dropped: the CHECK
        // constraint makes it impossible, and silently discarding one would hide a broken load.
        counts[status] = (counts[status] ?? 0) + 1;
    }
    return counts;
}

/** One issuer's stored `record` jsonb, plus the columns the chain response names it by. */
export function buildIssuerRecordSql(issuerSlug) {
    const params = createParams();
    const p = params.add(issuerSlug);
    return {
        text: `SELECT i.slug, i.name, i.built_at, i.record\n  FROM sonar.stock_issuer i\n`
            + `  WHERE i.slug = ${p}`,
        values: params.values
    };
}
