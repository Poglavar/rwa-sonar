// Faceted-navigation SQL for the token surface. Pure: (filters, facet) -> { text, values }.
// The facets are exactly the filters from query.js, so a facet can never offer a value its own
// filter would not accept. The one rule that makes faceting useful lives in filterConditions():
// a facet's own filter is excluded from its counts, so each facet shows what you could switch
// *to* rather than only the value you are already on.

import {
    FILTERS, FILTER_NAMES, TOKEN_FROM, badRequest, createParams, filterConditions, whereClause
} from './query.js';

export const FACET_NAMES = FILTER_NAMES;

/** Validate a `by=` comma list. Empty means every facet. */
export function parseFacetNames(values) {
    if (!values || values.length === 0) return [...FACET_NAMES];
    for (const name of values) {
        if (!Object.prototype.hasOwnProperty.call(FILTERS, name)) {
            throw badRequest(
                'unknown_facet',
                `unknown facet "${name}"; known facets: ${FACET_NAMES.join(', ')}`
            );
        }
    }
    return [...new Set(values)];
}

/**
 * Value counts for one facet over the tokens matching every OTHER filter. `count` is always the
 * second output column so the ORDER BY / GROUP BY can be positional and stay correct whether or
 * not the facet carries an extra label column.
 */
export function buildFacetSql(filters, facet, { q = null } = {}) {
    const def = FILTERS[facet];
    if (!def) throw badRequest('unknown_facet', `unknown facet "${facet}"`);
    const params = createParams();
    const where = whereClause(filterConditions(filters, params, { except: facet, q }));
    const extras = Object.entries(def.extra || {});
    const extraSelect = extras.map(([alias, expr]) => `, ${expr} AS ${alias}`).join('');
    const extraGroup = extras.map(([, expr]) => `, ${expr}`).join('');
    const text = `SELECT ${def.sql} AS value, count(*)::int AS count${extraSelect}
  ${TOKEN_FROM}
  ${where}
  GROUP BY ${def.sql}${extraGroup}
  ORDER BY 2 DESC, 1 ASC NULLS LAST`;
    return { text, values: params.values };
}

/**
 * A short display label for a facet value. Only `jurisdiction` needs one: the issuer column it
 * comes from (`entity_jurisdiction`) holds researched prose, not a code — one value runs past 700
 * characters — so the exact string stays in `value` (it is what the filter takes) and this is
 * what a chip should show.
 */
export function facetLabel(facet, value, { max = 80 } = {}) {
    if (value === null || value === undefined) return null;
    const text = String(value).replace(/\s+/g, ' ').trim();
    if (facet !== 'jurisdiction' || text.length <= max) return text;
    const cut = text.slice(0, max);
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '), cut.lastIndexOf(', '));
    return `${(stop > max / 3 ? cut.slice(0, stop) : cut).trimEnd()}…`;
}

/** Attach the label to a facet's rows, leaving `value` byte-exact. */
export function decorateFacetRows(facet, rows) {
    return rows.map((row) => {
        const label = facetLabel(facet, row.value);
        return label === null || label === row.value ? row : { ...row, label };
    });
}
