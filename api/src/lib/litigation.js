// Pure SQL builders and parameter validation for the litigation surface: `sonar.litigation_case`
// (every court case, RECAP docket and SEC release the case-law watcher found naming a watched
// party) and `sonar.litigation_query` (every search it ran). Same contract as lib/whatif.js:
// nothing here touches the database or Hono, filter names come from a whitelist and only VALUES
// travel as $n parameters (api/test/litigation.test.js).
//
// Every row is a CANDIDATE. Nothing on this surface is a `litigated` what-if answer; that status
// is only ever set in a dossier by someone who read the decision.

import { badRequest, createParams, filterSetConditions, parseFilterEntries, whereClause } from './query.js';

export const LITIGATION_FILTERS = {
    source: { sql: 'c.source', kind: 'text' },
    match: { sql: 'c.match_level', kind: 'text' },
    review: { sql: 'c.review_status', kind: 'text' }
};

/** `issuer` is its own filter: the column is an array, so the test is overlap, not equality. */
export const LITIGATION_FILTER_NAMES = ['issuer', ...Object.keys(LITIGATION_FILTERS)];

export const LITIGATION_COLUMNS = `c.id, c.source, c.external_id, c.case_name, c.court, c.court_id,
    c.date_filed, c.date_terminated, c.docket_number, c.url, c.match_level, c.issuers, c.queries,
    c.first_seen_at, c.last_seen_at, c.latest_entry, c.latest_entry_date, c.review_status,
    c.review_note`;

/** Caption before party before text: how firmly the case is tied to the name. */
export const MATCH_ORDER = `CASE c.match_level WHEN 'caption' THEN 0 WHEN 'party' THEN 1 WHEN 'text' THEN 2 ELSE 9 END`;

export const LITIGATION_SORTS = {
    match: MATCH_ORDER,
    filed: 'c.date_filed',
    first_seen: 'c.first_seen_at',
    latest_entry: 'c.latest_entry_date'
};

/** Read the filters; an unknown name is a 400 (a dropped filter is a wrong answer that looks right). */
export function parseLitigationFilters(queries, ignore = []) {
    return parseFilterEntries(queries, { ...LITIGATION_FILTERS, issuer: { sql: 'c.issuers', kind: 'text' } }, ignore);
}

function conditions(filters, params) {
    const { issuer, ...rest } = filters;
    const out = filterSetConditions(rest, LITIGATION_FILTERS, params);
    if (issuer?.length) out.push(`(c.issuers && ${params.add([...new Set(issuer)])}::text[])`);
    return out;
}

export function buildLitigationCountSql(filters) {
    const params = createParams();
    const where = whereClause(conditions(filters, params));
    return { text: `SELECT count(*)::int AS total\n  FROM sonar.litigation_case c\n  ${where}`.trimEnd(), values: params.values };
}

/**
 * The list. Default order is `match`: caption matches first, newest filing first within each
 * level — the reading order for a reviewer. Any other sort still breaks ties by match then id.
 */
export function buildLitigationListSql(filters, { sort = 'match', order = 'asc', limit = 100, offset = 0 } = {}) {
    const expr = LITIGATION_SORTS[sort];
    if (!expr) throw badRequest('unknown_sort', `unknown sort "${sort}"`);
    const params = createParams();
    const where = whereClause(conditions(filters, params));
    const then = sort === 'match' ? 'c.date_filed DESC NULLS LAST, c.id ASC' : `${MATCH_ORDER} ASC, c.id ASC`;
    const text = `SELECT ${LITIGATION_COLUMNS}\n  FROM sonar.litigation_case c\n  ${where}\n  `
        + `ORDER BY ${expr} ${order.toUpperCase()} NULLS LAST, ${then}\n  `
        + `LIMIT ${params.add(limit)} OFFSET ${params.add(offset)}`;
    return { text, values: params.values };
}

/**
 * What was searched for these issuers and when — the `searched[]` evidence behind an `unknown`
 * answer ("we looked, on this date, and found N").
 */
export function buildSearchedSql(issuers) {
    const params = createParams();
    const p = params.add([...new Set(issuers)]);
    return {
        text: `SELECT q.source, q.query, q.issuers, q.first_run_at, q.last_run_at, q.last_total
  FROM sonar.litigation_query q
  WHERE q.issuers && ${p}::text[]
  ORDER BY q.query ASC, q.source ASC`,
        values: params.values
    };
}
