// Pure SQL builders and parameter validation for the evidence surface: `sonar.claim` (what we
// assert and the words we assert it from), `sonar.source` (the URLs we watch) and
// `sonar.change_event` (what moved). Same contract as lib/query.js: nothing here touches the
// database or Hono, filter names come from whitelists and only VALUES travel as $n parameters, so
// the whole surface is unit-testable without a server (api/test/evidence.test.js).

import {
    ApiError, badRequest, createParams, filterSetConditions, parseFilterEntries, whereClause
} from './query.js';

export { ApiError, filterSetConditions, parseFilterEntries };

// ---------------------------------------------------------------------------------------------
// Claims.
// ---------------------------------------------------------------------------------------------

export const CLAIM_FROM = 'FROM sonar.claim c\n  LEFT JOIN sonar.source s ON s.id = c.source_id';

// `contradicted-corrected` is internal editorial history. The public API presents the corrected
// quote as confirmed evidence for the current conclusion and never exposes the old correction
// narrative. External `changed` and `source-gone` states remain public.
export const PUBLIC_CLAIM_STATUS_SQL = `CASE WHEN c.status = 'contradicted-corrected'
      THEN 'confirmed' ELSE c.status END`;
export const PUBLIC_CLAIM_CONDITION = `(c.status = 'contradicted-corrected'
      OR COALESCE(c.note, '') !~* '\\mSUPERSEDED\\M')
      AND c.active IS TRUE`;

export const CLAIM_FILTERS = {
    issuer: { sql: 'c.issuer_slug', kind: 'text' },
    field: { sql: 'c.field', kind: 'text' },
    status: { sql: PUBLIC_CLAIM_STATUS_SQL, kind: 'text' },
    method: { sql: 'c.method', kind: 'text' },
    subject_type: { sql: 'c.subject_type', kind: 'text' },
    subject: { sql: 'c.subject_id', kind: 'text' }
};

export const CLAIM_COLUMNS = `c.id, c.subject_type, c.subject_id, c.issuer_slug, c.field, c.value,
    c.quote, c.url, c.locator, ${PUBLIC_CLAIM_STATUS_SQL} AS status, c.method,
    CASE WHEN c.status = 'contradicted-corrected' OR COALESCE(c.note, '') ~* 'contradicted-corrected'
      THEN NULL ELSE c.note END AS note,
    c.source_id, c.recorded_at,
    c.accessed_at, c.last_checked_at, c.last_confirmed_at,
    s.title AS source_title, s.kind AS source_kind, s.status AS source_status,
    s.archive_url AS source_archive_url, s.last_checked_at AS source_last_checked_at`;

/**
 * Trust order, not alphabetical: `confirmed` is the source's own words found verbatim, and
 * `source-gone` is a claim with nothing left to read. The same order lib/evidence.js uses on the
 * page, written out here so the API's default ordering matches what the panel shows.
 */
export const CLAIM_STATUS_ORDER = `CASE ${PUBLIC_CLAIM_STATUS_SQL}
      WHEN 'confirmed' THEN 0
      WHEN 'changed' THEN 1
      WHEN 'unverified' THEN 2
      WHEN 'inference' THEN 3
      WHEN 'source-gone' THEN 4
      ELSE 9 END`;

export const CLAIM_SORTS = {
    status: CLAIM_STATUS_ORDER,
    field: 'c.field',
    issuer: 'c.issuer_slug',
    recorded_at: 'c.recorded_at',
    accessed_at: 'c.accessed_at',
    last_checked_at: 'c.last_checked_at'
};

// ---------------------------------------------------------------------------------------------
// Sources and change events.
// ---------------------------------------------------------------------------------------------

export const SOURCE_FILTERS = {
    issuer: { sql: 'src.issuer_slug', kind: 'text' },
    kind: { sql: 'src.kind', kind: 'text' },
    status: { sql: 'src.status', kind: 'text' }
};

// `read_via` / `capture_at` (db/2026-09-23-sonar-source-provenance.sql) say which reader produced
// the text and, for `wayback`, the capture's own timestamp: a source whose live host refused us is
// read from an archive, and the row must say so rather than pass the capture off as the live page.
export const SOURCE_COLUMNS = `src.id, src.url, src.kind, src.title, src.issuer_slug,
    src.first_seen_at, src.last_checked_at, src.last_changed_at, src.check_every, src.archive_url,
    src.status, src.content_hash, src.http_status, src.error, src.read_via, src.capture_at`;

export const SOURCE_SORTS = {
    last_checked_at: 'src.last_checked_at',
    last_changed_at: 'src.last_changed_at',
    first_seen_at: 'src.first_seen_at',
    issuer: 'src.issuer_slug',
    kind: 'src.kind',
    status: 'src.status',
    url: 'src.url'
};

/**
 * A change event names its subject by type, so the issuer behind one is only knowable by joining:
 * an `issuer` event carries the slug itself, a `token` event its mint, a `source` event a source
 * id. This expression is both what the row reports and what the `issuer` filter compares, so the
 * two can never mean different things.
 */
export const CHANGE_ISSUER_SQL = `CASE e.subject_type
      WHEN 'issuer' THEN e.subject_id
      WHEN 'token' THEN t.issuer_slug
      WHEN 'source' THEN es.issuer_slug
      ELSE NULL END`;

export const CHANGE_FROM = `FROM sonar.change_event e
  LEFT JOIN sonar.stock_token t ON e.subject_type = 'token' AND t.mint = e.subject_id
  LEFT JOIN sonar.source es ON e.subject_type = 'source' AND es.id = e.subject_id`;

// First observation records prove that a watcher has established state; they are not changes in
// an issuer, token, venue or legal document. Keep them available internally in change_event while
// excluding them from every public history/change projection.
export const PUBLIC_CHANGE_CONDITION = `NOT (e.kind = 'status'
      AND e.field = 'chain-watch'
      AND COALESCE(e.summary, '') ~* '^baseline recorded:')`;

export const CHANGE_FILTERS = {
    kind: { sql: 'e.kind', kind: 'text' },
    severity: { sql: 'e.severity', kind: 'text' },
    subject_type: { sql: 'e.subject_type', kind: 'text' },
    subject: { sql: 'e.subject_id', kind: 'text' },
    issuer: { sql: CHANGE_ISSUER_SQL, kind: 'text' }
};

/** Worst first when ordering by severity, because that is the only order worth a default. */
export const CHANGE_SEVERITY_ORDER = `CASE e.severity
      WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 WHEN 'caution' THEN 2 WHEN 'info' THEN 3
      ELSE 9 END`;

export const CHANGE_COLUMNS = `e.id, e.detected_at, e.kind, e.subject_type, e.subject_id,
    ${CHANGE_ISSUER_SQL} AS issuer_slug, e.field, e.before, e.after, e.severity, e.evidence,
    e.summary, e.acknowledged_at`;

export const CHANGE_SORTS = {
    detected_at: 'e.detected_at',
    severity: CHANGE_SEVERITY_ORDER,
    kind: 'e.kind'
};

// ---------------------------------------------------------------------------------------------
// Parameter reading. These three tables have their own small filter sets rather than the 22 token
// facets, but they share lib/query.js's machinery — the same whitelist rule (an unknown parameter
// name is a 400, never silently ignored, because a dropped filter returns a WRONG answer that
// looks right) and the same repeated-parameter forms.
// ---------------------------------------------------------------------------------------------

/** One filter set, read against this surface's own table of definitions. */
export function parseClaimFilters(queries, ignore = []) {
    return parseFilterEntries(queries, CLAIM_FILTERS, ignore);
}

export function parseSourceFilters(queries, ignore = []) {
    return parseFilterEntries(queries, SOURCE_FILTERS, ignore);
}

export function parseChangeFilters(queries, ignore = []) {
    return parseFilterEntries(queries, CHANGE_FILTERS, ignore);
}

/** `since=<ISO>` — an inclusive lower bound on a timestamp. Rejected rather than ignored. */
export function parseSince(raw, name = 'since') {
    if (raw === undefined || raw === null || raw === '') return null;
    const text = String(raw);
    if (Number.isNaN(Date.parse(text))) {
        throw badRequest('bad_since', `${name} must be an ISO timestamp, got "${text}"`);
    }
    return text;
}

// ---------------------------------------------------------------------------------------------
// Statement builders.
// ---------------------------------------------------------------------------------------------

export function buildClaimCountSql(filters) {
    const params = createParams();
    const where = whereClause([PUBLIC_CLAIM_CONDITION, ...filterSetConditions(filters, CLAIM_FILTERS, params)]);
    return {
        text: `SELECT count(*)::int AS total\n  ${CLAIM_FROM}\n  ${where}`.trimEnd(),
        values: params.values
    };
}

export function buildClaimListSql(filters, { sort = 'status', order = 'asc', limit = 100, offset = 0 } = {}) {
    const expr = CLAIM_SORTS[sort];
    if (!expr) throw badRequest('unknown_sort', `unknown sort "${sort}"`);
    const params = createParams();
    const where = whereClause([PUBLIC_CLAIM_CONDITION, ...filterSetConditions(filters, CLAIM_FILTERS, params)]);
    const text = `SELECT ${CLAIM_COLUMNS}\n  ${CLAIM_FROM}\n  ${where}\n  `
        + `ORDER BY ${expr} ${order.toUpperCase()} NULLS LAST, c.issuer_slug ASC, c.field ASC, c.id ASC\n  `
        + `LIMIT ${params.add(limit)} OFFSET ${params.add(offset)}`;
    return { text, values: params.values };
}

/** Per-status counts and the coverage figures for one issuer's claims. */
export function buildClaimSummarySql(issuerSlug) {
    const params = createParams();
    const p = params.add(issuerSlug);
    const text = `SELECT count(*)::int AS claims,
    count(*) FILTER (WHERE c.status IN ('confirmed', 'contradicted-corrected'))::int AS confirmed,
    count(*) FILTER (WHERE c.status = 'unverified')::int             AS unverified,
    count(*) FILTER (WHERE c.status = 'inference')::int              AS inference,
    count(*) FILTER (WHERE c.status = 'changed')::int                AS changed,
    count(*) FILTER (WHERE c.status = 'source-gone')::int            AS source_gone,
    count(DISTINCT c.field) FILTER (WHERE c.status IN ('confirmed', 'contradicted-corrected'))::int AS fields_sourced,
    count(DISTINCT c.field)::int AS fields_with_claims,
    max(c.accessed_at) AS last_accessed_at,
    max(c.last_checked_at) AS last_checked_at
  FROM sonar.claim c
  WHERE c.issuer_slug = ${p}
    AND ${PUBLIC_CLAIM_CONDITION}`;
    return { text, values: params.values };
}

export function buildSourceListSql(filters, { sort = 'last_checked_at', order = 'desc', limit = 200, offset = 0 } = {}) {
    const expr = SOURCE_SORTS[sort];
    if (!expr) throw badRequest('unknown_sort', `unknown sort "${sort}"`);
    const params = createParams();
    const where = whereClause(filterSetConditions(filters, SOURCE_FILTERS, params));
    const text = `SELECT ${SOURCE_COLUMNS},
    (SELECT count(*)::int FROM sonar.claim c WHERE c.source_id = src.id AND c.active IS TRUE) AS claims,
    (SELECT count(*)::int FROM sonar.source_version v WHERE v.source_id = src.id) AS versions
  FROM sonar.source src
  ${where}
  ORDER BY ${expr} ${order.toUpperCase()} NULLS LAST, src.url ASC
  LIMIT ${params.add(limit)} OFFSET ${params.add(offset)}`;
    return { text, values: params.values };
}

export function buildSourceCountSql(filters) {
    const params = createParams();
    const where = whereClause(filterSetConditions(filters, SOURCE_FILTERS, params));
    return {
        text: `SELECT count(*)::int AS total\n  FROM sonar.source src\n  ${where}`.trimEnd(),
        values: params.values
    };
}

export function buildChangeListSql(filters, { since = null, sort = 'detected_at', order = 'desc', limit = 100, offset = 0 } = {}) {
    const expr = CHANGE_SORTS[sort];
    if (!expr) throw badRequest('unknown_sort', `unknown sort "${sort}"`);
    const params = createParams();
    const conditions = filterSetConditions(filters, CHANGE_FILTERS, params);
    conditions.push(PUBLIC_CHANGE_CONDITION);
    if (since !== null) conditions.push(`e.detected_at >= ${params.add(since)}::timestamptz`);
    const text = `SELECT ${CHANGE_COLUMNS}\n  ${CHANGE_FROM}\n  ${whereClause(conditions)}\n  `
        + `ORDER BY ${expr} ${order.toUpperCase()} NULLS LAST, e.id DESC\n  `
        + `LIMIT ${params.add(limit)} OFFSET ${params.add(offset)}`;
    return { text, values: params.values };
}

export function buildChangeCountSql(filters, { since = null } = {}) {
    const params = createParams();
    const conditions = filterSetConditions(filters, CHANGE_FILTERS, params);
    conditions.push(PUBLIC_CHANGE_CONDITION);
    if (since !== null) conditions.push(`e.detected_at >= ${params.add(since)}::timestamptz`);
    return {
        text: `SELECT count(*)::int AS total\n  ${CHANGE_FROM}\n  ${whereClause(conditions)}`.trimEnd(),
        values: params.values
    };
}
