// Tests for the trust-chain surface: the pure SQL builders in api/src/lib/whatif.js, and the four
// routes in api/src/routes/whatif.js against the real database. The builder suite needs nothing;
// the route suite is skipped with a loud message when DATABASE_URL is absent, exactly like
// routes.integration.test.js, so a checkout without .env still gets a green suite.
//
// What is under test is what would cost real damage: a user value reaching the SQL text instead of
// the parameter array, an unanswered failure mode being dropped from an answer sheet (which would
// turn "the gap is the finding" into "there is no gap"), a `missing` status being stored rather
// than derived, and the API serving a differently graded chain from the built file.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import app from '../src/app.js';
import { closePool } from '../src/db.js';
import { ApiError, parseSort } from '../src/lib/query.js';
import {
    ANSWER_STATUSES, MISSING_STATUS, WHAT_IF_FILTERS, WHAT_IF_SORTS, WHAT_IF_STATUS_ORDER,
    buildFailureModeSummarySql, buildIssuerRecordSql, buildIssuerWhatIfSql, buildWhatIfCountSql,
    buildWhatIfListSql, parseWhatIfFilters, summariseAnswerSheet
} from '../src/lib/whatif.js';
import { buildChain } from '../../stocks/lib/trustchain.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WHATIF_DDL = readFileSync(join(REPO, 'db', '2026-09-18-sonar-whatif.sql'), 'utf8');
const CATALOGUE = JSON.parse(readFileSync(join(REPO, 'stocks', 'data', 'trust-chain.json'), 'utf8'));

/** Every `<alias>.<column>` a SQL fragment mentions. */
function columnsIn(...fragments) {
    const found = new Set();
    for (const fragment of fragments) {
        for (const m of String(fragment).matchAll(/\b(?:w|m|s|i)\.([a-z_][a-z0-9_]*)/g)) found.add(m[1]);
    }
    return [...found];
}

/** Column names declared by each CREATE TABLE in the what-if DDL. */
function ddlColumns(text) {
    const out = {};
    for (const m of text.matchAll(/CREATE TABLE IF NOT EXISTS (sonar\.\w+) \(([\s\S]*?)\n\);/g)) {
        out[m[1]] = m[2].split('\n')
            .map((line) => line.trim())
            .filter((line) => line && !/^(PRIMARY KEY|UNIQUE|CONSTRAINT|CHECK|FOREIGN)/i.test(line))
            .map((line) => line.split(/\s+/)[0]);
    }
    return out;
}

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

describe('parseWhatIfFilters', () => {
    test('the five documented filters are accepted, and repeated values are OR', () => {
        expect(parseWhatIfFilters({ mode: ['keys-stolen', 'court-order'] }))
            .toEqual({ mode: ['keys-stolen', 'court-order'] });
        expect(parseWhatIfFilters({ status: 'documented,litigated' }))
            .toEqual({ status: ['documented', 'litigated'] });
        expect(Object.keys(WHAT_IF_FILTERS).sort())
            .toEqual(['actor', 'flow', 'issuer', 'mode', 'status']);
    });

    test('an unknown filter is a 400, never silently ignored', () => {
        // A dropped filter returns a WRONG answer that looks right.
        expectApiError(() => parseWhatIfFilters({ nonsense: 'x' }), 400, 'unknown_filter');
    });

    test('the list options are ignored rather than rejected as filters', () => {
        expect(parseWhatIfFilters({ limit: '10', sort: 'issuer' }, ['limit', 'sort'])).toEqual({});
    });
});

describe('buildWhatIfListSql / buildWhatIfCountSql', () => {
    test('filter values travel as $n parameters — never in the SQL text', () => {
        const nasty = "x'; DROP TABLE sonar.what_if; --";
        const built = buildWhatIfListSql({ issuer: [nasty] });
        expect(built.text).not.toContain('DROP TABLE');
        // The whole comma list is ONE parameter — an array Postgres compares with = ANY().
        expect(built.values[0]).toEqual([nasty]);
        expect(built.text).toContain('w.issuer_slug = ANY($1::text[])');
    });

    test('count and list apply the SAME conditions, so the total matches the page', () => {
        const filters = { status: ['documented'], actor: ['holder'] };
        const count = buildWhatIfCountSql(filters);
        const list = buildWhatIfListSql(filters);
        expect(count.values).toEqual(list.values.slice(0, count.values.length));
        for (const expr of ['w.status = ANY', 'm.actor = ANY']) {
            expect(count.text).toContain(expr);
            expect(list.text).toContain(expr);
        }
    });

    test('paging is the last two parameters, and the sort is whitelisted', () => {
        const built = buildWhatIfListSql({}, { limit: 25, offset: 50 });
        expect(built.values).toEqual([25, 50]);
        expect(() => buildWhatIfListSql({}, { sort: 'anything' })).toThrow(ApiError);
        expectApiError(() => parseSort('anything', WHAT_IF_SORTS, 'mode'), 400, 'unknown_sort');
        expect(parseSort(undefined, WHAT_IF_SORTS, 'mode')).toBe('mode');
    });

    test('sort=mode is the CATALOGUE order, not an id sort', () => {
        // The catalogue groups the modes by actor; sorting by id would scatter that grouping.
        expect(buildWhatIfListSql({}, { sort: 'mode' }).text).toContain('ORDER BY m.ord ASC');
        expect(buildWhatIfListSql({}, { sort: 'mode' }).text).not.toContain('ORDER BY w.mode_id');
    });

    test('sort=status is EVIDENCE order, not alphabetical', () => {
        // Alphabetically `documented` would come first by luck and `litigated` before `inferred`
        // by accident; `unknown` would land between them. The CASE is the only way to mean it.
        expect(WHAT_IF_STATUS_ORDER).toContain("WHEN 'documented' THEN 0");
        expect(WHAT_IF_STATUS_ORDER).toContain("WHEN 'litigated' THEN 1");
        expect(WHAT_IF_STATUS_ORDER).toContain("WHEN 'inferred' THEN 2");
        expect(WHAT_IF_STATUS_ORDER).toContain('ELSE 9');
        expect(buildWhatIfListSql({}, { sort: 'status' }).text).toContain('CASE w.status');
    });

    test('every column the list selects or filters on exists in the DDL', () => {
        const declared = ddlColumns(WHATIF_DDL);
        const known = new Set([
            ...declared['sonar.what_if'], ...declared['sonar.failure_mode'],
            // the source join, whose columns are declared in the evidence DDL
            'title', 'kind', 'archive_url', 'last_checked_at', 'url', 'status', 'id'
        ]);
        const used = columnsIn(buildWhatIfListSql({ mode: ['x'], actor: ['y'] }).text);
        expect(used.filter((col) => !known.has(col))).toEqual([]);
    });
});

describe('buildFailureModeSummarySql', () => {
    const built = buildFailureModeSummarySql();

    test('LEFT JOINs the answers, so a mode NOBODY answered still comes back', () => {
        // An inner join here would hide exactly the finding the route exists for.
        expect(built.text).toContain('LEFT JOIN sonar.what_if w ON w.mode_id = m.id');
        expect(built.text).not.toMatch(/\n\s+JOIN sonar\.what_if/);
    });

    test('counts answers with count(w.id), which is 0 for an unanswered mode', () => {
        // count(*) over a LEFT JOIN with no match reports 1 — the null row.
        expect(built.text).toContain('count(w.id)::int AS answered');
        expect(built.text).not.toContain('count(*)::int AS answered');
    });

    test('one count column per answer status, none of them `missing`', () => {
        for (const status of ANSWER_STATUSES) {
            expect(built.text).toContain(`FILTER (WHERE w.status = '${status}')`);
        }
        // `missing` is derived in the route from the issuer count; it is never a stored status.
        expect(built.text).not.toContain("w.status = 'missing'");
    });

    test('ordered by the catalogue position and grouped by everything it selects', () => {
        expect(built.text).toContain('ORDER BY m.ord ASC');
        expect(built.text).toContain('GROUP BY m.id, m.actor, m.flow, m.question, m.look_for, m.ord');
    });
});

describe('buildIssuerWhatIfSql', () => {
    const built = buildIssuerWhatIfSql('xstocks-backed');

    test('the slug is a parameter and rides in the JOIN, not the WHERE', () => {
        expect(built.values).toEqual(['xstocks-backed']);
        expect(built.text).toContain('LEFT JOIN sonar.what_if w ON w.mode_id = m.id AND w.issuer_slug = $1');
        // A WHERE on w.issuer_slug would drop every unanswered mode and turn the answer sheet
        // back into a list of answers — the one thing this route exists not to be.
        expect(built.text).not.toMatch(/WHERE[\s\S]*w\.issuer_slug/);
    });

    test('drives off the catalogue, so all 38 rows come back whatever was answered', () => {
        expect(built.text).toContain('FROM sonar.failure_mode m');
        expect(built.text).toContain('ORDER BY m.ord ASC');
    });

    test('an unanswered mode reports status `missing`, which is DERIVED not stored', () => {
        expect(built.text).toContain("coalesce(w.status, 'missing') AS status");
        // The table's CHECK constraint would reject a stored 'missing'.
        const check = WHATIF_DDL.match(/CONSTRAINT what_if_status_check CHECK \(status IN \(\n?([^)]*)\)/);
        expect(check).toBeTruthy();
        for (const status of ANSWER_STATUSES) expect(check[1]).toContain(`'${status}'`);
        expect(check[1]).not.toContain("'missing'");
    });
});

describe('summariseAnswerSheet', () => {
    test('every status key is present even at zero, `missing` included', () => {
        const counts = summariseAnswerSheet([]);
        expect(Object.keys(counts).sort()).toEqual([...ANSWER_STATUSES, MISSING_STATUS].sort());
        for (const value of Object.values(counts)) expect(value).toBe(0);
    });

    test('counts what it is given and never drops an unrecognised status', () => {
        const counts = summariseAnswerSheet([
            { status: 'documented' }, { status: 'documented' }, { status: 'missing' },
            { status: 'not-applicable' }, { status: 'impossible' }
        ]);
        expect(counts.documented).toBe(2);
        expect(counts.missing).toBe(1);
        expect(counts['not-applicable']).toBe(1);
        // A broken load must be visible, not silently swallowed.
        expect(counts.impossible).toBe(1);
        expect(summariseAnswerSheet(null).documented).toBe(0);
    });
});

describe('buildIssuerRecordSql', () => {
    test('selects the record jsonb the chain is rebuilt from, slug as a parameter', () => {
        const built = buildIssuerRecordSql('prestocks');
        expect(built.values).toEqual(['prestocks']);
        expect(built.text).toContain('i.record');
        expect(built.text).toContain('i.built_at');
        expect(built.text).toContain('WHERE i.slug = $1');
    });
});

// --- against the real database -----------------------------------------------------------------

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;

if (!HAS_DB) {
    // Not a silent skip: a skipped integration suite that nobody notices is how "all green" ends
    // up meaning "nothing was checked".
    console.log(
        '[api] whatif.test.js route suite SKIPPED: DATABASE_URL is not set. '
        + 'Run with `node --env-file=.env` or `set -a; . ./.env; set +a` to exercise it.'
    );
}

async function get(path) {
    const res = await app.request(path);
    const text = await res.text();
    let body = null;
    try {
        body = JSON.parse(text);
    } catch {
        throw new Error(`${path} did not return JSON: ${text.slice(0, 200)}`);
    }
    return { status: res.status, headers: res.headers, body };
}

describeDb('the trust-chain routes against the real sonar schema', () => {
    afterAll(async () => {
        await closePool();
    });

    test('/api/failure-modes serves the whole catalogue in catalogue order', async () => {
        const { status, body, headers } = await get('/api/failure-modes');
        expect(status).toBe(200);
        expect(headers.get('cache-control')).toBe('public, max-age=60');
        expect(body.count).toBe(CATALOGUE.failureModes.length);
        expect(body.items.map((m) => m.id)).toEqual(CATALOGUE.failureModes.map((m) => m.id));
        expect(body.items.map((m) => m.ord)).toEqual(body.items.map((_, i) => i));
    });

    test('/api/failure-modes labels each mode\'s actor and flow from the catalogue', async () => {
        const { body } = await get('/api/failure-modes');
        const first = body.items[0];
        expect(first.actor_label).toBe(
            CATALOGUE.actors.find((a) => a.id === first.actor).label);
        expect(first.flow_label).toBe(
            CATALOGUE.flows.find((f) => f.id === first.flow).label);
        for (const item of body.items) {
            expect(item.actor_label).toBeTruthy();
            expect(item.flow_label).toBeTruthy();
        }
    });

    test('/api/failure-modes counts per mode add up to the issuer count', async () => {
        const { body } = await get('/api/failure-modes');
        expect(body.issuers).toBeGreaterThan(0);
        for (const item of body.items) {
            const answered = ANSWER_STATUSES
                .reduce((sum, s) => sum + item[s.replace(/-/g, '_')], 0);
            expect(answered).toBe(item.answered);
            expect(item.answered + item.missing).toBe(body.issuers);
        }
    });

    test('/api/what-if pages, filters and rejects an unknown parameter', async () => {
        const all = await get('/api/what-if?limit=5');
        expect(all.status).toBe(200);
        expect(all.body.items.length).toBeLessThanOrEqual(5);
        expect(all.body.items.length).toBeLessThanOrEqual(all.body.total);
        expect(all.body.sort).toBe('mode');

        const filtered = await get('/api/what-if?status=documented&status=litigated&limit=5');
        expect(filtered.status).toBe(200);
        expect(filtered.body.filters.status).toEqual(['documented', 'litigated']);
        expect(filtered.body.total).toBeLessThanOrEqual(all.body.total);
        for (const item of filtered.body.items) {
            expect(['documented', 'litigated']).toContain(item.status);
        }

        expect((await get('/api/what-if?nonsense=1')).status).toBe(400);
        expect((await get('/api/what-if?sort=nonsense')).body.error.code).toBe('unknown_sort');
    });

    test('/api/what-if joins each answer to its mode question and actor', async () => {
        const { body } = await get('/api/what-if?limit=20');
        for (const item of body.items) {
            expect(typeof item.question).toBe('string');
            expect(typeof item.actor).toBe('string');
            expect(item.actor_label).toBeTruthy();
            expect(ANSWER_STATUSES).toContain(item.status);
        }
    });

    test('/api/issuers/:slug/what-if returns EVERY mode, gaps included', async () => {
        // Two issuers on purpose: one the research pass has answered and one it has not. With only
        // a fully answered issuer the `missing` half of this route is never exercised, and with
        // only an unanswered one the join is never exercised — so the test needs both, whichever
        // way round the research happens to stand.
        const sheets = await Promise.all(['xstocks-backed', 'prestocks']
            .map((slug) => get(`/api/issuers/${slug}/what-if`).then((r) => [slug, r])));
        let sawAnswer = false;
        let sawGap = false;
        for (const [slug, { status, body }] of sheets) {
            expect(status).toBe(200);
            expect(body.count).toBe(CATALOGUE.failureModes.length);
            expect(body.items.map((i) => i.mode_id)).toEqual(CATALOGUE.failureModes.map((m) => m.id));
            // The summary partitions the catalogue: every mode is either answered or missing.
            const total = Object.values(body.summary).reduce((a, b) => a + b, 0);
            expect(total).toBe(CATALOGUE.failureModes.length);
            for (const item of body.items) {
                expect([...ANSWER_STATUSES, MISSING_STATUS]).toContain(item.status);
                expect(typeof item.question).toBe('string');
                if (item.status === MISSING_STATUS) {
                    sawGap = true;
                    // A gap carries no answer at all, and says so — it is not an empty answer.
                    expect(item.id).toBeNull();
                    expect(item.outcome).toBeNull();
                    expect(item.issuer_slug).toBeNull();
                } else {
                    sawAnswer = true;
                    expect(item.id).toBe(`${slug}:${item.mode_id}`);
                    expect(item.issuer_slug).toBe(slug);
                }
            }
        }
        // If neither branch was reached the loop above asserted nothing worth having.
        expect(sawAnswer).toBe(true);
        expect(sawGap).toBe(true);
    });

    test('/api/issuers/:slug/what-if and /chain 404 on an unknown slug', async () => {
        for (const path of ['/api/issuers/nope/what-if', '/api/issuers/nope/chain']) {
            const { status, body } = await get(path);
            expect(status).toBe(404);
            expect(body.error.code).toBe('not_found');
        }
    });

    test('/api/issuers/:slug/chain serves a node per actor and a graded link per flow', async () => {
        const { status, body } = await get('/api/issuers/xstocks-backed/chain');
        expect(status).toBe(200);
        expect(body.slug).toBe('xstocks-backed');
        expect(body.nodes.map((n) => n.actor)).toEqual(CATALOGUE.actors.map((a) => a.id));
        expect(body.links.map((l) => l.flow)).toEqual(CATALOGUE.flows.map((f) => f.id));
        for (const link of body.links) {
            expect(['documented', 'inferred', 'asserted', 'unknown']).toContain(link.evidence);
            expect(['onchain', 'attested', 'self-reported', 'none']).toContain(link.verification);
            expect(link.fields.length).toBeGreaterThan(0);
            expect(link.summary).not.toContain('\n');
        }
        // A registered-share issuer's token-issuer seat is the company itself.
        const bullish = await get('/api/issuers/bullish/chain');
        const seat = bullish.body.nodes.find((n) => n.actor === 'token-issuer');
        expect(seat.parties.length).toBeGreaterThan(0);
    });

    test('the chain the API serves is the chain the BUILDER built — same library, same grades', async () => {
        const built = JSON.parse(readFileSync(join(REPO, 'stocks-issuers.json'), 'utf8'));
        for (const slug of ['xstocks-backed', 'prestocks', 'superstate-opening-bell']) {
            const { body } = await get(`/api/issuers/${slug}/chain`);
            const record = built.issuers.find((i) => i.slug === slug);
            expect(record).toBeTruthy();
            expect({ nodes: body.nodes, links: body.links }).toEqual(record.chain);
            // ... and rebuilding it here from the same record gives the same thing again.
            expect(buildChain(record, CATALOGUE, { claims: record.claims }))
                .toEqual({ nodes: body.nodes, links: body.links });
        }
    });

    test('/api lists the four new routes', async () => {
        const { body } = await get('/api');
        expect(body.routes).toContain('GET /api/failure-modes');
        expect(body.routes).toContain('GET /api/issuers/:slug/what-if');
        expect(body.routes).toContain('GET /api/issuers/:slug/chain');
        expect(body.routes.some((r) => r.startsWith('GET /api/what-if'))).toBe(true);
    });

    test('/api/issuers/:slug is NOT shadowed by the two new sub-routes', async () => {
        const { status, body } = await get('/api/issuers/xstocks-backed');
        expect(status).toBe(200);
        expect(body.slug).toBe('xstocks-backed');
        expect(body.record).toBeTruthy();
    });
});
