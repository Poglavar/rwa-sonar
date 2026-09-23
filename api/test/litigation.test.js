// Tests for the litigation surface: the pure SQL builders in api/src/lib/litigation.js, and
// GET /api/litigation against the real database (skipped loudly without DATABASE_URL, like
// whatif.test.js). What would cost real damage here: a user value in the SQL text, an unknown
// filter silently ignored, an issuer filter that compares an array with `=` (and so matches only
// single-issuer rows), caption matches not coming first, and a column the DDL does not declare.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import app from '../src/app.js';
import { closePool } from '../src/db.js';
import { ApiError } from '../src/lib/query.js';
import {
    LITIGATION_FILTER_NAMES, LITIGATION_SORTS, buildLitigationCountSql, buildLitigationListSql, buildSearchedSql,
    parseLitigationFilters
} from '../src/lib/litigation.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DDL = readFileSync(join(REPO, 'db', '2026-09-23-sonar-caselaw.sql'), 'utf8');

function ddlColumns(table) {
    const body = DDL.match(new RegExp(`CREATE TABLE IF NOT EXISTS sonar\\.${table} \\(([\\s\\S]*?)\\n\\);`))[1];
    return body.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((c) => /^[a-z_]+$/.test(c));
}

function aliasColumns(text, alias) {
    return [...new Set([...text.matchAll(new RegExp(`\\b${alias}\\.([a-z_]+)`, 'g'))].map((m) => m[1]))];
}

describe('parseLitigationFilters', () => {
    test('the four documented filters, repeated values OR', () => {
        expect(LITIGATION_FILTER_NAMES.sort()).toEqual(['issuer', 'match', 'review', 'source']);
        expect(parseLitigationFilters({ issuer: ['a', 'b'], match: 'caption,party' }))
            .toEqual({ issuer: ['a', 'b'], match: ['caption', 'party'] });
    });

    test('an unknown filter is a 400', () => {
        let thrown = null;
        try {
            parseLitigationFilters({ nonsense: 'x' });
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(ApiError);
        expect(thrown.code).toBe('unknown_filter');
    });
});

describe('buildLitigationListSql / buildLitigationCountSql', () => {
    test('values are parameters, and the issuer filter is array overlap', () => {
        const nasty = "x'; DROP TABLE sonar.litigation_case; --";
        const built = buildLitigationListSql({ issuer: [nasty] });
        expect(built.text).not.toContain('DROP TABLE');
        expect(built.values[0]).toEqual([nasty]);
        expect(built.text).toContain('c.issuers && $1::text[]');
        expect(built.text).not.toMatch(/c\.issuers = ANY/);
    });

    test('count and list apply the same conditions', () => {
        const filters = { issuer: ['securitize-secz'], match: ['caption'], review: ['candidate'] };
        const count = buildLitigationCountSql(filters);
        const list = buildLitigationListSql(filters);
        expect(count.values).toEqual(list.values.slice(0, count.values.length));
        for (const expr of ['c.match_level = ANY', 'c.review_status = ANY', 'c.issuers &&']) {
            expect(count.text).toContain(expr);
            expect(list.text).toContain(expr);
        }
    });

    test('default order is caption, party, text — newest filing first within', () => {
        const { text } = buildLitigationListSql({});
        expect(text).toContain("ORDER BY CASE c.match_level WHEN 'caption' THEN 0 WHEN 'party' THEN 1 WHEN 'text' THEN 2");
        expect(text).toContain('c.date_filed DESC NULLS LAST');
        expect(() => buildLitigationListSql({}, { sort: 'nope' })).toThrow(ApiError);
        expect(Object.keys(LITIGATION_SORTS).sort()).toEqual(['filed', 'first_seen', 'latest_entry', 'match']);
    });

    test('every column read exists in the DDL', () => {
        const cases = ddlColumns('litigation_case');
        const queries = ddlColumns('litigation_query');
        const list = buildLitigationListSql({ issuer: ['x'], source: ['sec-lr'] }, { sort: 'latest_entry' });
        expect(aliasColumns(list.text, 'c').filter((col) => !cases.includes(col))).toEqual([]);
        expect(aliasColumns(buildSearchedSql(['x']).text, 'q').filter((col) => !queries.includes(col))).toEqual([]);
    });
});

// --- against the real database -----------------------------------------------------------------

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;
if (!HAS_DB) {
    console.log('[api] litigation.test.js route suite SKIPPED: DATABASE_URL is not set.'
        + ' Run with `node --env-file=.env` to exercise it.');
}

async function get(path) {
    const res = await app.request(path);
    const text = await res.text();
    try {
        return { status: res.status, body: JSON.parse(text) };
    } catch {
        throw new Error(`${path} did not return JSON: ${text.slice(0, 200)}`);
    }
}

describeDb('GET /api/litigation against the real sonar schema', () => {
    let tableExists = false;
    beforeAll(async () => {
        const { query } = await import('../src/db.js');
        const { rows } = await query("SELECT to_regclass('sonar.litigation_case') IS NOT NULL AS ok");
        tableExists = rows[0].ok;
        if (!tableExists) {
            console.log('[api] sonar.litigation_case does not exist yet — run `node stocks/watch-caselaw.mjs --run --ddl` first');
        }
    });
    afterAll(async () => {
        await closePool();
    });

    test('lists candidates caption-first, with the review note', async () => {
        if (!tableExists) return;
        const { status, body } = await get('/api/litigation?limit=50');
        expect(status).toBe(200);
        expect(body.note).toContain('litigated');
        expect(body.items.length).toBeLessThanOrEqual(Math.min(50, body.total));
        const rank = { caption: 0, party: 1, text: 2 };
        const ranks = body.items.map((i) => rank[i.match_level]);
        expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
        expect(body.searched).toBeUndefined();
    });

    test('?issuer= narrows by array overlap and returns what was searched for it', async () => {
        if (!tableExists) return;
        const { status, body } = await get('/api/litigation?issuer=securitize-secz&match=caption');
        expect(status).toBe(200);
        for (const item of body.items) {
            expect(item.issuers).toContain('securitize-secz');
            expect(item.match_level).toBe('caption');
        }
        expect(Array.isArray(body.searched)).toBe(true);
        for (const s of body.searched) expect(s.issuers).toContain('securitize-secz');
        // The two known D. Del. dockets are in caselaw-extra.json; once the watcher has run they are here.
        if (body.searched.length) {
            expect(body.items.map((i) => i.docket_number)).toEqual(expect.arrayContaining(['1:26-cv-00722', '1:26-cv-00698']));
        }
    });

    test('an unknown filter or sort is a 400', async () => {
        expect((await get('/api/litigation?nonsense=1')).status).toBe(400);
        expect((await get('/api/litigation?sort=nope')).body.error.code).toBe('unknown_sort');
    });

    test('/api lists the route', async () => {
        const { body } = await get('/api');
        expect(body.routes.some((r) => r.startsWith('GET /api/litigation'))).toBe(true);
    });
});
