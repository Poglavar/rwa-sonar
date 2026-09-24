// Unit tests for api/src/lib/evidence.js and the three gaps closed in api/src/lib/query.js.
// No database and no server. What is under test is what would cost real damage: a user value
// reaching the SQL text instead of the parameter array, a whitelist quietly defaulting instead of
// rejecting, a filter value containing a comma being silently split into two wrong values, and a
// severity sort that orders alphabetically — which is what made `health_status` unusable as a sort
// and `worst_rule`, `venue_spread_pct` and `top1_share_pct` unsortable at all.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    ApiError, HEALTH_SEVERITY_ORDER, TOKEN_SORTS, buildTokenListSql, parseFilterEntries,
    parseFilters, parseSort, readParamValues, splitList
} from '../src/lib/query.js';
import {
    CHANGE_FILTERS, CHANGE_SORTS, CLAIM_FILTERS, CLAIM_SORTS, PUBLIC_CHANGE_CONDITION,
    SOURCE_FILTERS, SOURCE_SORTS,
    buildChangeCountSql, buildChangeListSql, buildClaimCountSql, buildClaimListSql,
    buildClaimSummarySql, buildSourceCountSql, buildSourceListSql, CHANGE_JUDGMENT_JOIN,
    MODEL_ASSESSMENT_COLUMN, parseChangeFilters, parseClaimFilters, parseMaterial, parseSince,
    parseSourceFilters
} from '../src/lib/evidence.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVIDENCE_DDL = readFileSync(join(REPO, 'db', '2026-09-18-sonar-evidence.sql'), 'utf8');
const CLAIM_DDL = readFileSync(join(REPO, 'db', '2026-09-18-sonar-claims.sql'), 'utf8');
const JUDGMENT_DDL = readFileSync(join(REPO, 'db', '2026-09-23-sonar-change-judgment.sql'), 'utf8');
const PROVENANCE_DDL = readFileSync(join(REPO, 'db', '2026-09-23-sonar-source-provenance.sql'), 'utf8');

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

/** Every `<alias>.<column>` a SQL fragment mentions. */
function columnsIn(...fragments) {
    const found = new Set();
    for (const fragment of fragments) {
        for (const m of String(fragment).matchAll(/\b(?:c|s|src|e|es|t)\.([a-z_][a-z0-9_]*)/g)) {
            found.add(m[1]);
        }
    }
    return [...found];
}

describe('repeated query parameters (gap 1: a filter value containing a comma)', () => {
    test('one occurrence is still a comma list — the documented behaviour does not change', () => {
        expect(readParamValues('a,b')).toEqual(['a', 'b']);
        expect(readParamValues(['a, b ,,c'])).toEqual(['a', 'b', 'c']);
    });

    test('a REPEATED parameter is one value per occurrence, and never split', () => {
        expect(readParamValues(['a', 'b'])).toEqual(['a', 'b']);
        // ?x=Cayman, BVI&x=Delaware — two values, the first containing a comma.
        expect(readParamValues(['Cayman, BVI', 'Delaware'])).toEqual(['Cayman, BVI', 'Delaware']);
    });

    test('the name[] form is ALWAYS literal, which is how a single comma value gets through', () => {
        expect(readParamValues(['Cayman, BVI'], { literal: true })).toEqual(['Cayman, BVI']);
    });

    test('splitList treats an array the same way, so the facet route agrees with the filters', () => {
        expect(splitList(['a', 'b'])).toEqual(['a', 'b']);
        expect(splitList(['a,b'])).toEqual(['a', 'b']);
        expect(splitList(undefined)).toEqual([]);
    });

    test('parseFilters reads both forms and merges them', () => {
        expect(parseFilters({ issuer: ['shift', 'prestocks'] })).toEqual({
            issuer: ['shift', 'prestocks']
        });
        expect(parseFilters({ 'jurisdiction[]': ['Cayman Islands, with a Swiss arm'] })).toEqual({
            jurisdiction: ['Cayman Islands, with a Swiss arm']
        });
        expect(parseFilters({ issuer: ['a,b'], 'issuer[]': ['c,d'] }).issuer)
            .toEqual(['a', 'b', 'c,d']);
    });

    test('a comma value survives into the parameter array, never into the SQL text', () => {
        const value = 'Cayman Islands, with a Swiss distribution arm';
        const filters = parseFilters({ 'jurisdiction[]': [value] });
        const { text, values } = buildTokenListSql(filters);
        expect(values).toContainEqual([value]);
        expect(values[0]).toEqual([value]);
        expect(text).not.toContain('Cayman');
        expect(text).toContain('i.entity_jurisdiction = ANY($1::text[])');
    });

    test('an unknown name is still a 400, bracket form included', () => {
        expectApiError(() => parseFilters({ 'issuerr[]': ['x'] }), 400, 'unknown_filter');
        expectApiError(() => parseFilters({ nonesuch: 'x' }), 400, 'unknown_filter');
    });

    test('duplicate values are deduplicated before they reach the ANY() array', () => {
        const { values } = buildTokenListSql(parseFilters({ issuer: ['a', 'a', 'b'] }));
        expect(values[0]).toEqual(['a', 'b']);
    });

    test('an ignored option name is not mistaken for a filter', () => {
        expect(parseFilters({ sort: ['symbol'], limit: ['5'] }, ['sort', 'limit'])).toEqual({});
    });
});

describe('sorts (gaps 2 and 3)', () => {
    test('the whitelist now covers the three columns the monitor table shows', () => {
        expect(Object.keys(TOKEN_SORTS).sort()).toEqual([
            'composability_health', 'control_health', 'first_seen_at', 'health_status', 'holder_count', 'last_traded_at',
            'legal_health', 'liquidity_usd', 'market_health', 'premium_pct', 'symbol',
            'top1_share_pct', 'traders24', 'trades24', 'usd_price', 'venue_spread_pct',
            'volume24_usd', 'worst_rule'
        ]);
    });

    test('health_status sorts by SEVERITY, not alphabetically', () => {
        // Alphabetically: caution, good, unknown, warning — the two ends of the scale in the
        // middle. By severity: good, caution, warning, then everything unmeasured.
        expect(TOKEN_SORTS.health_status).toBe(HEALTH_SEVERITY_ORDER);
        const order = ['good', 'caution', 'warning'].map((status) => {
            const m = new RegExp(`WHEN '${status}' THEN (\\d)`).exec(HEALTH_SEVERITY_ORDER);
            return Number(m[1]);
        });
        expect(order).toEqual([0, 1, 2]);
        expect(HEALTH_SEVERITY_ORDER).not.toContain('ELSE 9');
        expect(HEALTH_SEVERITY_ORDER).toMatch(/warning' THEN 2 END$/);
    });

    test('the severity CASE reaches the statement, so the order is the database\'s', () => {
        const { text } = buildTokenListSql({}, { sort: 'health_status', order: 'asc' });
        expect(text).toContain("WHEN 'good' THEN 0");
        expect(text).toContain('ASC NULLS LAST');
    });

    test('an unknown sort is still a 400, never a silent default', () => {
        expectApiError(() => parseSort('health_status; DROP TABLE'), 400, 'unknown_sort');
        expectApiError(() => parseSort('record'), 400, 'unknown_sort');
        expect(parseSort('worst_rule')).toBe('worst_rule');
        expect(parseSort('top1_share_pct')).toBe('top1_share_pct');
    });
});

describe('claim filters and statements', () => {
    test('the filter set is the documented one', () => {
        expect(Object.keys(CLAIM_FILTERS).sort())
            .toEqual(['field', 'issuer', 'method', 'status', 'subject', 'subject_type']);
        expect(Object.keys(CLAIM_SORTS).sort())
            .toEqual(['accessed_at', 'field', 'issuer', 'last_checked_at', 'recorded_at', 'status']);
    });

    test('an unknown claim filter is a 400 with the known names listed', () => {
        expectApiError(() => parseClaimFilters({ issuers: 'x' }), 400, 'unknown_filter');
    });

    test('every value travels as a parameter, and a field path with a dot is one value', () => {
        const filters = parseClaimFilters({ issuer: 'prestocks', field: 'redemption.rails' });
        const { text, values } = buildClaimListSql(filters);
        // Conditions are emitted in sorted filter-name order (field before issuer), so the $n
        // numbering is stable whatever order the query string happened to carry them in.
        expect(values).toEqual([['redemption.rails'], ['prestocks'], 100, 0]);
        expect(text).not.toContain('prestocks');
        expect(text).toContain('c.field = ANY($1::text[])');
        expect(text).toContain('c.issuer_slug = ANY($2::text[])');
    });

    test('public claim queries exclude superseded internal audit rows', () => {
        expect(buildClaimListSql({}).text).toContain('c.active IS TRUE');
        expect(buildClaimCountSql({}).text).toContain('c.active IS TRUE');
        expect(buildClaimSummarySql('prestocks').text).toContain('c.active IS TRUE');
        expect(buildSourceListSql({}).text).toContain('c.active IS TRUE');
    });

    test('the default order is trust order over the public status', () => {
        const { text } = buildClaimListSql({});
        expect(text).toContain("WHEN 'confirmed' THEN 0");
        expect(text).toContain("WHEN 'source-gone' THEN 4");
        expect(text).toContain('ASC NULLS LAST');
    });

    test('normalizes internal editorial corrections out of the public claim projection', () => {
        const { text } = buildClaimListSql({});
        expect(text).toContain("WHEN c.status = 'contradicted-corrected'");
        expect(text).toContain("THEN 'confirmed' ELSE c.status END AS status");
        expect(text).toContain("THEN NULL ELSE c.note END AS note");
        expect(text).toContain("!~* '\\mSUPERSEDED\\M'");
    });

    test('the claim list joins its source so a row carries the archive copy and last check', () => {
        const { text } = buildClaimListSql({});
        expect(text).toContain('LEFT JOIN sonar.source s ON s.id = c.source_id');
        expect(text).toContain('s.archive_url AS source_archive_url');
        expect(text).toContain('s.last_checked_at AS source_last_checked_at');
    });

    test('count and list apply the same filters, so a total cannot disagree with its page', () => {
        const filters = parseClaimFilters({ status: 'confirmed,unverified' });
        expect(buildClaimCountSql(filters).values).toEqual([['confirmed', 'unverified']]);
        expect(buildClaimListSql(filters).values[0]).toEqual(['confirmed', 'unverified']);
    });

    test('`null` as a value means IS NULL, so an unmatched source is clickable', () => {
        const { text } = buildClaimListSql(parseClaimFilters({ subject: 'null' }));
        expect(text).toContain('c.subject_id IS NULL');
    });

    test('the public summary folds corrected research into current confirmed evidence', () => {
        const { text, values } = buildClaimSummarySql('prestocks');
        expect(values).toEqual(['prestocks']);
        for (const status of ['unverified', 'inference', 'changed', 'source-gone']) {
            expect(text).toContain(`WHERE c.status = '${status}'`);
        }
        expect(text).toContain("c.status IN ('confirmed', 'contradicted-corrected')");
        expect(text).not.toContain('AS corrected');
    });

    test('an unknown claim sort is a 400', () => {
        expect(() => buildClaimListSql({}, { sort: 'quote' })).toThrow(ApiError);
    });

    test('every column the claim statements read exists in the claim DDL', () => {
        const declared = new Set([
            ...CLAIM_DDL.matchAll(/^\s{4}([a-z_]+)\s+\S/gm)
        ].map((m) => m[1]));
        const sourceDeclared = new Set([
            ...EVIDENCE_DDL.matchAll(/^\s{4}([a-z_]+)\s+\S/gm)
        ].map((m) => m[1]));
        const missing = columnsIn(buildClaimListSql({}).text, buildClaimSummarySql('x').text)
            .filter((col) => !declared.has(col) && !sourceDeclared.has(col));
        expect(missing).toEqual([]);
    });
});

describe('source filters and statements', () => {
    test('the filter and sort sets are the documented ones', () => {
        expect(Object.keys(SOURCE_FILTERS).sort()).toEqual(['issuer', 'kind', 'status']);
        expect(Object.keys(SOURCE_SORTS)).toContain('last_checked_at');
    });

    test('a source row carries last_checked_at and archive_url, which is the point', () => {
        const { text } = buildSourceListSql({});
        expect(text).toContain('src.last_checked_at');
        expect(text).toContain('src.archive_url');
        expect(text).toContain('FROM sonar.claim c WHERE c.source_id = src.id');
        expect(text).toContain('FROM sonar.source_version v WHERE v.source_id = src.id');
    });

    test('a source row says which reader produced its text and, for an archive, the capture time', () => {
        const { text } = buildSourceListSql({});
        expect(text).toContain('src.read_via');
        expect(text).toContain('src.capture_at');
        // Both are real columns, added by the provenance DDL, not guessed names.
        for (const col of ['read_via', 'capture_at']) {
            expect(PROVENANCE_DDL).toContain(`ALTER TABLE sonar.source         ADD COLUMN IF NOT EXISTS ${col}`);
        }
    });

    test('values are parameters; kind and status are not concatenated', () => {
        const filters = parseSourceFilters({ kind: 'pdf,html', status: 'gone' });
        const { text, values } = buildSourceListSql(filters);
        expect(values).toEqual([['pdf', 'html'], ['gone'], 200, 0]);
        expect(text).not.toContain('pdf');
        expect(buildSourceCountSql(filters).values).toEqual([['pdf', 'html'], ['gone']]);
    });

    test('the kinds and statuses the DDL allows are what a caller can ask for', () => {
        const kinds = EVIDENCE_DDL.match(/source_kind_check CHECK \(kind IN \(([^)]*)\)/)[1];
        expect(kinds).toContain("'pdf'");
        // The filter is free text against the column, so the DDL's CHECK is the only whitelist —
        // an impossible value simply returns nothing rather than erroring, which is correct.
        const { values } = buildSourceListSql(parseSourceFilters({ kind: 'nonesuch' }));
        expect(values[0]).toEqual(['nonesuch']);
    });
});

describe('change-event filters and statements', () => {
    test('the filter and sort sets are the documented ones', () => {
        expect(Object.keys(CHANGE_FILTERS).sort())
            .toEqual(['issuer', 'kind', 'severity', 'subject', 'subject_type']);
        expect(Object.keys(CHANGE_SORTS).sort()).toEqual(['detected_at', 'kind', 'severity']);
    });

    test('the issuer behind an event is derived by join, and the filter uses that same expression', () => {
        const { text } = buildChangeListSql(parseChangeFilters({ issuer: 'shift' }));
        expect(text).toContain("LEFT JOIN sonar.stock_token t ON e.subject_type = 'token'");
        expect(text).toContain("LEFT JOIN sonar.source es ON e.subject_type = 'source'");
        // Reported and filtered by one expression, so they cannot mean different things.
        expect(text.match(/WHEN 'token' THEN t\.issuer_slug/g).length).toBe(2);
    });

    test('since is an ISO bound as a parameter, and rubbish is rejected', () => {
        const filters = parseChangeFilters({ kind: 'legal-term' });
        const { text, values } = buildChangeListSql(filters, { since: '2026-09-01T00:00:00Z' });
        expect(values).toEqual([['legal-term'], '2026-09-01T00:00:00Z', 100, 0]);
        expect(text).toContain('e.detected_at >= $2::timestamptz');
        expectApiError(() => parseSince('last tuesday'), 400, 'bad_since');
        expect(parseSince('')).toBeNull();
        expect(parseSince(undefined)).toBeNull();
    });

    test('count and list apply the same since bound', () => {
        expect(buildChangeCountSql({}, { since: '2026-09-01T00:00:00Z' }).values)
            .toEqual(['2026-09-01T00:00:00Z']);
    });

    test('public change lists and totals exclude watcher baselines', () => {
        expect(PUBLIC_CHANGE_CONDITION).toContain("e.field = 'chain-watch'");
        expect(PUBLIC_CHANGE_CONDITION).toContain("^baseline recorded:");
        expect(buildChangeListSql({}).text).toContain(PUBLIC_CHANGE_CONDITION);
        expect(buildChangeCountSql({}).text).toContain(PUBLIC_CHANGE_CONDITION);
    });

    test('public change lists exclude events dismissed as false alarms (a read that was not the document)', () => {
        expect(PUBLIC_CHANGE_CONDITION).toMatch(/NOT EXISTS \(SELECT 1 FROM sonar\.review_resolution rr\s+WHERE rr\.event_id = e\.id AND rr\.resolution = 'false-alarm'\)/);
        // One parenthesised condition, so an `AND ${PUBLIC_CHANGE_CONDITION}` cannot be split by precedence.
        expect(PUBLIC_CHANGE_CONDITION.startsWith('(')).toBe(true);
        expect(PUBLIC_CHANGE_CONDITION.endsWith(')')).toBe(true);
        expect(buildChangeListSql({ kind: ['quote-lost'] }).text).toContain(PUBLIC_CHANGE_CONDITION);
    });

    test('severity sorts worst-first, not alphabetically', () => {
        const { text } = buildChangeListSql({}, { sort: 'severity' });
        expect(text).toContain("WHEN 'critical' THEN 0");
        expect(text).toContain("WHEN 'info' THEN 3");
    });

    test('the kinds the DDL allows are EVIDENCE.md §3\'s list', () => {
        const kinds = EVIDENCE_DDL.match(/change_event_kind_check CHECK \(kind IN \(([\s\S]*?)\)\)/)[1]
            .split(',').map((v) => v.trim().replace(/^'|'$/g, '')).filter(Boolean);
        expect(kinds).toContain('legal-term');
        expect(kinds).toContain('authority-key');
        expect(kinds).toContain('document-gone');
        expect(kinds.length).toBe(13);
    });
});

describe('parseFilterEntries is one implementation for every surface', () => {
    test('the same function drives the token, claim, source and change filters', () => {
        const definitions = { only: { sql: 'x.only', kind: 'text' } };
        expect(parseFilterEntries({ only: 'a,b' }, definitions)).toEqual({ only: ['a', 'b'] });
        expectApiError(() => parseFilterEntries({ other: 'a' }, definitions), 400, 'unknown_filter');
        expect(parseFilterEntries(null, definitions)).toEqual({});
        expect(parseFilterEntries({}, definitions)).toEqual({});
    });
});

describe('model assessments on the change feed (sonar.change_judgment)', () => {
    test('with the table, each event joins its latest judgment, valid preferred, error rows ignored', () => {
        const { text } = buildChangeListSql({}, { judgments: true });
        expect(text).toContain(CHANGE_JUDGMENT_JOIN);
        expect(text).toContain('AS "modelAssessment"');
        expect(CHANGE_JUDGMENT_JOIN).toContain("j.status IN ('valid', 'invalid')");
        expect(CHANGE_JUDGMENT_JOIN).toContain("ORDER BY (j.status = 'valid') DESC, j.updated_at DESC");
        // A judgment covers every event of its change, not only the representative one.
        expect(CHANGE_JUDGMENT_JOIN).toContain('j.covers_event_ids @> jsonb_build_array(e.id)');
    });

    test('an invalid judgment is exposed as its status only, never with its text', () => {
        const invalidBranch = MODEL_ASSESSMENT_COLUMN.match(/WHEN mj\.status = 'invalid' THEN ([^\n]*)/)[1];
        expect(invalidBranch).toBe("jsonb_build_object('status', 'invalid')");
        for (const key of ['model', 'promptVersion', 'material', 'severity', 'affects', 'summary',
            'quotedChange', 'confidence', 'costUsd', 'judgedAt']) {
            expect(MODEL_ASSESSMENT_COLUMN).toContain(`'${key}'`);
        }
        expect(MODEL_ASSESSMENT_COLUMN).not.toContain('rejected_quotes');
    });

    test('every judgment column the join reads exists in the DDL', () => {
        const cols = CHANGE_JUDGMENT_JOIN.match(/SELECT ([\s\S]*?)\n\s+FROM/)[1]
            .split(',').map((c) => c.trim().replace(/^j\./, ''));
        for (const col of cols) expect(JUDGMENT_DDL).toMatch(new RegExp(`\\n\\s+${col}\\s`));
    });

    test('material is a parameter on list and count, and parses only true/false', () => {
        const list = buildChangeListSql({}, { judgments: true, material: true });
        expect(list.text).toContain("(mj.status = 'valid' AND mj.material = $1)");
        expect(list.values).toEqual([true, 100, 0]);
        const count = buildChangeCountSql({}, { judgments: true, material: false });
        expect(count.text).toContain(CHANGE_JUDGMENT_JOIN);
        expect(count.values).toEqual([false]);
        // A count without the material filter has no reason to join the judgments.
        expect(buildChangeCountSql({}, { judgments: true }).text).not.toContain('change_judgment');
        expect(parseMaterial('true')).toBe(true);
        expect(parseMaterial('FALSE')).toBe(false);
        expect(parseMaterial(undefined)).toBeNull();
        expectApiError(() => parseMaterial('yes'), 400, 'bad_material');
    });

    test('without the table, the SQL never names it; material then matches nothing', () => {
        const list = buildChangeListSql({}, { judgments: false });
        expect(list.text).not.toContain('change_judgment');
        expect(list.text).toContain('NULL::jsonb AS "modelAssessment"');
        const filtered = buildChangeCountSql({}, { judgments: false, material: true });
        expect(filtered.text).not.toContain('change_judgment');
        expect(filtered.text).toMatch(/AND FALSE$/);
    });
});
