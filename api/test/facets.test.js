// Unit tests for api/src/lib/facets.js. The rule worth a test is the one that makes faceted
// navigation work at all: a facet's counts must NOT be narrowed by the facet's own filter, while
// every other filter must still apply. Get that backwards and every facet collapses to the one
// value already selected — a bug that looks like "the data only has one issuer".

import {
    FACET_NAMES, buildFacetSql, decorateFacetRows, facetLabel, parseFacetNames
} from '../src/lib/facets.js';
import { ApiError } from '../src/lib/query.js';

const FILTERS = { issuer: ['prestocks'], health: ['warning'], clawback: ['true'] };

describe('parseFacetNames', () => {
    test('an empty `by` means every facet', () => {
        expect(parseFacetNames([])).toEqual(FACET_NAMES);
        expect(parseFacetNames(undefined).length).toBe(26);
    });

    test('duplicates collapse', () => {
        expect(parseFacetNames(['recipe', 'health', 'recipe'])).toEqual(['recipe', 'health']);
    });

    test('an unknown facet is a 400, and the message lists what is available', () => {
        let thrown = null;
        try {
            parseFacetNames(['recipe', 'supply_raw']);
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(ApiError);
        expect(thrown.status).toBe(400);
        expect(thrown.code).toBe('unknown_facet');
        expect(thrown.message).toContain('jurisdiction');
    });
});

describe('a facet excludes its own filter and only its own', () => {
    test('the health facet drops the health filter but keeps issuer and clawback', () => {
        const { text, values } = buildFacetSql(FILTERS, 'health');
        expect(text).not.toContain('t.health_status = ANY');
        // Filters are emitted in sorted name order, so clawback numbers ahead of issuer.
        expect(text).toContain('t.clawback = ANY($1::bool[])');
        expect(text).toContain('t.issuer_slug = ANY($2::text[])');
        expect(values).toEqual([[true], ['prestocks']]);
    });

    test('the issuer facet drops the issuer filter but keeps health and clawback', () => {
        const { text, values } = buildFacetSql(FILTERS, 'issuer');
        expect(text).not.toContain('t.issuer_slug = ANY');
        expect(text).toContain('t.health_status = ANY');
        expect(text).toContain('t.clawback = ANY');
        expect(values).toEqual([[true], ['warning']]);
    });

    test('a facet nobody filtered on carries all three filters', () => {
        const { values } = buildFacetSql(FILTERS, 'recipe');
        expect(values).toEqual([[true], ['warning'], ['prestocks']]);
    });

    test('`q` applies to every facet, since it is not a facet itself', () => {
        const { text, values } = buildFacetSql(FILTERS, 'health', { q: 'nvda' });
        expect(text).toContain('t.symbol ILIKE $3');
        expect(values).toEqual([[true], ['prestocks'], '%nvda%']);
    });
});

describe('buildFacetSql shape', () => {
    test('count is always the second column, so the positional ORDER BY stays right', () => {
        for (const facet of FACET_NAMES) {
            const { text } = buildFacetSql({}, facet);
            expect(text).toMatch(/^SELECT .+ AS value, count\(\*\)::int AS count/);
            expect(text).toContain('ORDER BY 2 DESC, 1 ASC NULLS LAST');
            expect(text).toContain('GROUP BY');
        }
    });

    test('the issuer facet carries the issuer name and groups by it', () => {
        const { text } = buildFacetSql({}, 'issuer');
        expect(text).toContain('count(*)::int AS count, i.name AS name');
        expect(text).toContain('GROUP BY t.issuer_slug, i.name');
    });

    test('first_seen_day buckets in UTC, not the session timezone', () => {
        const { text } = buildFacetSql({}, 'first_seen_day');
        expect(text).toContain("(t.first_seen_at AT TIME ZONE 'UTC')::date AS value");
    });

    test('no filter value ever reaches the statement text', () => {
        const { text } = buildFacetSql({ issuer: ["x'; DROP TABLE sonar.stock_token; --"] }, 'health');
        expect(text).not.toContain('DROP TABLE');
    });

    test('an unknown facet name cannot reach the SQL even by calling the builder', () => {
        expect(() => buildFacetSql({}, 'record')).toThrow(ApiError);
    });
});

describe('facetLabel', () => {
    // `entity_jurisdiction` is researched prose, not a code: one issuer's value runs past 700
    // characters. The exact string has to stay in `value` (the filter takes it), so the short
    // form is a separate field.
    const PROSE = 'British Virgin Islands (token issuer and the recognised beneficiary); '
        + 'New Zealand (Backpack Securities Global Limited, introducing broker for non-US '
        + 'customers); United States (RQD Clearing, LLC)';

    test('a long jurisdiction is cut at a clause boundary and marked with an ellipsis', () => {
        const label = facetLabel('jurisdiction', PROSE);
        expect(label.length).toBeLessThanOrEqual(81);
        expect(label.endsWith('…')).toBe(true);
        expect(PROSE.startsWith(label.slice(0, -1))).toBe(true);
    });

    test('a short jurisdiction is returned whole, without an ellipsis', () => {
        expect(facetLabel('jurisdiction', 'Jersey (Channel Islands)'))
            .toBe('Jersey (Channel Islands)');
    });

    test('other facets are never truncated, however long', () => {
        const long = 'token-2022 · pausable + clawback + transfer-fee + allowlist + hook'.repeat(3);
        expect(facetLabel('recipe', long)).toBe(long);
    });

    test('null stays null', () => {
        expect(facetLabel('jurisdiction', null)).toBeNull();
    });
});

describe('decorateFacetRows', () => {
    test('adds a label only where it differs, and never edits `value`', () => {
        const rows = [
            { value: 'Jersey (Channel Islands)', count: 165 },
            { value: 'a'.repeat(200), count: 51 },
            { value: null, count: 3 }
        ];
        const out = decorateFacetRows('jurisdiction', rows);
        expect(out[0]).toEqual({ value: 'Jersey (Channel Islands)', count: 165 });
        expect(out[1].value).toBe('a'.repeat(200));
        expect(out[1].label).toHaveLength(81);
        expect(out[2]).toEqual({ value: null, count: 3 });
    });

    test('a non-prose facet comes back untouched', () => {
        const rows = [{ value: 'warning', count: 309 }];
        expect(decorateFacetRows('health', rows)).toEqual(rows);
    });
});
