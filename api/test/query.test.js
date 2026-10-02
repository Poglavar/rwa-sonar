// Unit tests for api/src/lib/query.js — the pure builders and validators behind every route.
// No database and no server: each test asserts something that would cost real damage if it
// broke. The properties under test are (a) user input reaching the SQL text instead of the
// parameter array, (b) a whitelist quietly falling back to a default instead of rejecting,
// (c) limit/offset clamping, (d) the column lists drifting away from the DDL, and (e) the trade
// keyset predicate, which is the only thing keeping a growing tape from repeating rows.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    ApiError, DEFAULT_SORT, FILTERS, FILTER_NAMES, ISSUER_JOINED_COLUMNS,
    ISSUER_SUMMARY_COLUMNS, SLIM_TOKEN_COLUMNS, TOKEN_SORTS, buildDailyTradesSql,
    buildTokenCountSql, buildTokenDetailSql, buildTokenHistorySql, buildTokenListSql,
    buildTradesSql, clampLimit, clampOffset, coerceValue, filterCondition, createParams,
    likePattern, parseBefore, parseDays, parseFilters, parseOrder, parseSort, splitList
} from '../src/lib/query.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DDL = readFileSync(join(REPO, 'db', '2026-09-17-sonar-stocks.sql'), 'utf8');

/** Assert a thrown ApiError's status and code, so a 500 can never pass as a 400. */
function expectApiError(fn, status, code) {
    let thrown = null;
    try {
        fn();
    } catch (err) {
        thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect(thrown.status).toBe(status);
    expect(thrown.code).toBe(code);
}

describe('splitList', () => {
    test('trims and drops empties, so `a,,b` is two values', () => {
        expect(splitList('a, b ,,c')).toEqual(['a', 'b', 'c']);
        expect(splitList(undefined)).toEqual([]);
        expect(splitList('')).toEqual([]);
    });
});

describe('parseFilters', () => {
    test('accepts the known filters and keeps comma lists as arrays', () => {
        expect(parseFilters({ issuer: 'prestocks,shift', health: 'warning' }))
            .toEqual({ issuer: ['prestocks', 'shift'], health: ['warning'] });
    });

    test('rejects an unknown parameter rather than ignoring it', () => {
        // A silently dropped filter returns a WRONG answer that looks right; this must be a 400.
        expectApiError(() => parseFilters({ issuerr: 'prestocks' }), 400, 'unknown_filter');
    });

    test('skips the non-filter parameters a route declares', () => {
        expect(parseFilters({ q: 'nvda', sort: 'symbol', issuer: 'shift' }, ['q', 'sort']))
            .toEqual({ issuer: ['shift'] });
    });
});

describe('coerceValue', () => {
    test('bool words both ways', () => {
        for (const yes of ['true', 'T', '1', 'yes', 'y']) {
            expect(coerceValue('paused', 'bool', yes)).toBe(true);
        }
        for (const no of ['false', 'F', '0', 'no', 'n']) {
            expect(coerceValue('paused', 'bool', no)).toBe(false);
        }
    });

    test('a non-boolean bool, a non-integer int and a non-date date are all 400s', () => {
        expectApiError(() => coerceValue('paused', 'bool', 'maybe'), 400, 'bad_filter_value');
        expectApiError(() => coerceValue('claim_rung', 'int', '2.5'), 400, 'bad_filter_value');
        expectApiError(() => coerceValue('first_seen_day', 'date', 'today'), 400,
            'bad_filter_value');
    });

    test('an integer filter arrives as a number, not the string', () => {
        expect(coerceValue('claim_rung', 'int', '4')).toBe(4);
    });
});

describe('clamping', () => {
    test('limit: default when absent or unparseable, floor 1, ceiling 500', () => {
        expect(clampLimit(undefined)).toBe(50);
        expect(clampLimit('banana')).toBe(50);
        expect(clampLimit('0')).toBe(1);
        expect(clampLimit('-20')).toBe(1);
        expect(clampLimit('900')).toBe(500);
        expect(clampLimit('120')).toBe(120);
        expect(clampLimit('900', { max: 20 })).toBe(20);
    });

    test('offset: non-negative integer, never NaN', () => {
        expect(clampOffset(undefined)).toBe(0);
        expect(clampOffset('-5')).toBe(0);
        expect(clampOffset('nope')).toBe(0);
        expect(clampOffset('120')).toBe(120);
    });
});

describe('sort and order whitelists', () => {
    test('a known sort passes, an unknown one is a 400 and not a silent default', () => {
        expect(parseSort('premium_pct')).toBe('premium_pct');
        expect(parseSort(undefined)).toBe(DEFAULT_SORT);
        expectApiError(() => parseSort('supply_raw; DROP TABLE'), 400, 'unknown_sort');
        expectApiError(() => parseSort('record'), 400, 'unknown_sort');
    });

    test('order is asc or desc only', () => {
        expect(parseOrder('ASC')).toBe('asc');
        expect(parseOrder(undefined)).toBe('desc');
        expectApiError(() => parseOrder('sideways'), 400, 'unknown_order');
    });

    test('the sort whitelist is exactly the documented set', () => {
        // 2026-09-18: worst_rule, venue_spread_pct and top1_share_pct added — the monitor table
        // shows those three columns and could not sort them. health_status is now a severity CASE
        // rather than the bare column; see api/test/evidence.test.js for the ordering itself.
        // 2026-09-25: programme_health and token_health added — the monitor's headline columns.
        expect(Object.keys(TOKEN_SORTS).sort()).toEqual([
            'composability_health', 'control_health', 'first_seen_at', 'health_status', 'holder_count', 'last_traded_at',
            'legal_health', 'liquidity_usd', 'market_health', 'premium_pct', 'programme_health', 'symbol',
            'token_health', 'top1_share_pct', 'traders24', 'trades24', 'usd_price', 'venue_spread_pct',
            'volume24_usd', 'worst_rule'
        ]);
    });

    test('this-token health sorts by the rank stocks/lib/health.mjs computed, not by the band word', () => {
        // The rank orders band, then failing checks, then passing checks (health.test.js pins it);
        // re-deriving it here in SQL would be a second copy of the rule that could drift.
        expect(TOKEN_SORTS.token_health).toBe('t.token_health_rank');
        expect(TOKEN_SORTS.programme_health).toMatch(/^CASE t\.programme_health\b/);
        expect(TOKEN_SORTS.programme_health).toMatch(/'good' THEN 0 WHEN 'caution' THEN 1 WHEN 'warning' THEN 2 END$/);
    });

    test('the slim token row carries both health levels and the pass count the monitor shows', () => {
        for (const column of ['programme_health', 'programme_worst_rule', 'token_health', 'token_worst_rule',
            'token_checks_passed', 'token_checks_judged']) {
            expect(SLIM_TOKEN_COLUMNS).toMatch(new RegExp(`\\bt\\.${column}\\b`));
        }
    });
});

describe('likePattern', () => {
    test('LIKE metacharacters in user text are escaped, so `%` matches a literal percent', () => {
        expect(likePattern('50%_x')).toBe('%50\\%\\_x%');
        expect(likePattern('nvda')).toBe('%nvda%');
    });
});

describe('filterCondition', () => {
    test('a comma list becomes one ANY() parameter, never inlined text', () => {
        const params = createParams();
        const cond = filterCondition('issuer', ['prestocks', 'shift'], params);
        expect(cond).toBe('(t.issuer_slug = ANY($1::text[]))');
        expect(params.values).toEqual([['prestocks', 'shift']]);
        expect(cond).not.toContain('prestocks');
    });

    test('the literal value `null` becomes IS NULL, so a null facet bucket is clickable', () => {
        const params = createParams();
        expect(filterCondition('reference', ['null'], params))
            .toBe('(t.reference_source IS NULL)');
        expect(params.values).toEqual([]);
    });

    test('null mixed with real values is an OR of both', () => {
        const params = createParams();
        expect(filterCondition('worst_rule', ['liquidity', 'null'], params))
            .toBe('(t.worst_rule = ANY($1::text[]) OR t.worst_rule IS NULL)');
        expect(params.values).toEqual([['liquidity']]);
    });

    test('transfer_fee means installed capability, so a zero current rate remains true', () => {
        const params = createParams();
        expect(filterCondition('transfer_fee', ['true'], params))
            .toContain("t.transfer_fee_bps IS NOT NULL");
        expect(filterCondition('transfer_fee', ['true'], createParams()))
            .toContain("transferFeeConfigAuthority");
        expect(params.values).toEqual([[true]]);
    });
});

describe('buildTokenCountSql', () => {
    test('no filters means no WHERE clause at all', () => {
        const { text, values } = buildTokenCountSql({});
        expect(text).toContain('SELECT count(*)::int AS total');
        expect(text).not.toContain('WHERE');
        expect(values).toEqual([]);
    });

    test('q searches symbol, name, mint and ticker off one parameter', () => {
        const { text, values } = buildTokenCountSql({}, { q: 'nvda' });
        expect(text).toContain('t.symbol ILIKE $1');
        expect(text).toContain('t.underlying_ticker ILIKE $1');
        expect(values).toEqual(['%nvda%']);
    });
});

describe('buildTokenListSql', () => {
    test('sort, order, nulls-last and the mint tiebreaker are all in the ORDER BY', () => {
        const { text, values } = buildTokenListSql({ issuer: ['prestocks'] }, {
            sort: 'volume24_usd', order: 'asc', limit: 25, offset: 50
        });
        expect(text).toContain('ORDER BY t.volume24_usd ASC NULLS LAST, t.mint ASC');
        expect(text).toContain('LIMIT $2 OFFSET $3');
        expect(values).toEqual([['prestocks'], 25, 50]);
        // The filter value must never appear in the statement text.
        expect(text).not.toContain('prestocks');
    });

    test('an unwhitelisted sort cannot reach the ORDER BY even by calling the builder', () => {
        expectApiError(
            () => buildTokenListSql({}, { sort: 't.record' }),
            400,
            'unknown_sort'
        );
    });

    test('the slim row carries the issuer name under its own alias', () => {
        const { text } = buildTokenListSql({});
        expect(text).toContain('i.name AS issuer_name');
        for (const column of ['t.mint', 't.symbol', 't.liquidity_usd', 't.paused']) {
            expect(text).toContain(column);
        }
    });
});

describe('buildTokenDetailSql', () => {
    test('every issuer column is aliased, because i.name would shadow t.name otherwise', () => {
        const { text, values } = buildTokenDetailSql('So111');
        expect(values).toEqual(['So111']);
        expect(text).toContain('i.record AS issuer_record');
        expect(text).toContain('i.name AS issuer_name');
        expect(text).toContain('AS snapshot_dates');
        expect(text).toContain('AS trades_in_db');
        // `i.name` unaliased would arrive as `name` and node-postgres keeps the last column of a
        // duplicated name, silently reporting the issuer's name as the token's.
        expect(ISSUER_JOINED_COLUMNS).not.toMatch(/i\.name(?!\s+AS)/);
    });
});

describe('buildTokenHistorySql', () => {
    test('days becomes a parameter; absent days means the whole series', () => {
        const windowed = buildTokenHistorySql('So111', { days: 30 });
        expect(windowed.text).toContain('s.snapshot_date >= (current_date - $2::int)');
        expect(windowed.values).toEqual(['So111', 30]);

        const all = buildTokenHistorySql('So111');
        expect(all.text).not.toContain('current_date');
        expect(all.values).toEqual(['So111']);
    });

    test('reads the typed columns, never the `row` jsonb', () => {
        const { text } = buildTokenHistorySql('So111');
        expect(text).toContain('s.snapshot_date');
        expect(text).toContain('ORDER BY s.snapshot_date ASC');
        expect(text).not.toContain('"row"');
    });
});

describe('buildTradesSql', () => {
    test('keyset on (time, sig): the pair, in the index order, newest first', () => {
        const { text, values } = buildTradesSql({
            mint: 'So111', limit: 100, before: { time: '2026-09-17T10:00:00Z', sig: 'abc' }
        });
        expect(text).toContain('(tr."time", tr.sig) < ($2::timestamptz, $3)');
        expect(text).toContain('ORDER BY tr."time" DESC, tr.sig DESC');
        expect(values).toEqual(['So111', '2026-09-17T10:00:00Z', 'abc', 100]);
    });

    test('a cursor without a signature falls back to a plain time comparison', () => {
        const { text, values } = buildTradesSql({ before: { time: '2026-09-17T10:00:00Z' } });
        expect(text).toContain('tr."time" < $1::timestamptz');
        expect(text).not.toContain('tr.sig) <');
        expect(values).toEqual(['2026-09-17T10:00:00Z', 50]);
    });

    test('parseBefore accepts iso and iso,sig and rejects anything else', () => {
        expect(parseBefore('2026-09-17T10:00:00Z')).toEqual({
            time: '2026-09-17T10:00:00Z', sig: null
        });
        expect(parseBefore('2026-09-17T10:00:00Z,abc')).toEqual({
            time: '2026-09-17T10:00:00Z', sig: 'abc'
        });
        expect(parseBefore(undefined)).toBeNull();
        expectApiError(() => parseBefore('yesterday'), 400, 'bad_before');
    });
});

describe('buildDailyTradesSql', () => {
    test('groups by UTC day and dex and reports the priceless trades beside the volume', () => {
        const { text, values } = buildDailyTradesSql({ days: 7 });
        expect(text).toContain("(tr.\"time\" AT TIME ZONE 'UTC')::date AS day");
        expect(text).toContain('sum(tr.size * tr.price_usd) AS volume_usd');
        expect(text).toContain('AS trades_without_price');
        expect(text).toContain('count(DISTINCT tr.fee_payer)::int AS traders');
        expect(text).toContain('GROUP BY 1, 2');
        expect(values).toEqual([7]);
    });
});

describe('parseDays', () => {
    test('absent means all of it, not zero', () => {
        expect(parseDays(undefined)).toBeNull();
        expect(parseDays('')).toBeNull();
        expect(parseDays('14')).toBe(14);
        expect(parseDays('99999')).toBe(3650);
        expectApiError(() => parseDays('-1'), 400, 'bad_days');
    });
});

describe('column lists have not drifted from the DDL', () => {
    /** Every `t.<col>` / `i.<col>` / `s.<col>` mentioned in a builder, deduplicated. */
    function columnsIn(...fragments) {
        const found = new Set();
        for (const fragment of fragments) {
            for (const m of fragment.matchAll(/\b[tis]\.([a-z_][a-z0-9_]*)/g)) found.add(m[1]);
        }
        return [...found];
    }

    test('every column the API reads exists in db/2026-09-17-sonar-stocks.sql', () => {
        const fragments = [
            SLIM_TOKEN_COLUMNS, ISSUER_SUMMARY_COLUMNS, ISSUER_JOINED_COLUMNS,
            ...Object.values(FILTERS).map((f) => f.sql),
            ...Object.values(TOKEN_SORTS),
            buildTokenHistorySql('x').text,
            buildTradesSql({}).text
        ];
        const missing = columnsIn(...fragments).filter((col) => {
            const declared = new RegExp(`^\\s+(?:"${col}"|${col})\\s`, 'm');
            return !declared.test(DDL);
        });
        expect(missing).toEqual([]);
    });

    test('the filter set is exactly the 29 documented facets', () => {
        expect(FILTER_NAMES.length).toBe(29);
        expect([...FILTER_NAMES].sort()).toEqual([
            'allowlist', 'claim_rung', 'clawback', 'composability_health', 'control_health', 'first_seen_day', 'health',
            'hook_active', 'instrument', 'issuer', 'jurisdiction', 'key_governance_freeze',
            'key_governance_mint', 'legal_form', 'legal_health', 'market_health', 'maturity_stage',
            'pausable', 'paused', 'program', 'programme_health', 'recipe', 'reference', 'seen_in_search',
            'token_health', 'token_worst_rule', 'transfer_fee', 'verification_type', 'worst_rule'
        ]);
    });
});
