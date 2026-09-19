// The one test in api/ that touches the real database. It calls the Hono app in-process
// (app.request(), no listener, no port) against the local `geodata` database, so it checks the
// things a pure builder test cannot: that the SQL actually runs, that the facet counts add up to
// the total the same query reports, and that a bad parameter comes back as a 400 rather than a
// 500. Skipped with a clear message when DATABASE_URL is absent, so a checkout without .env
// still gets a green suite from the builder tests.

import app from '../src/app.js';
import { closePool } from '../src/db.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;

if (!HAS_DB) {
    // Not a silent skip: a skipped integration suite that nobody notices is how "all green" ends
    // up meaning "nothing was checked".
    console.log(
        '[api] routes.integration.test.js SKIPPED: DATABASE_URL is not set. '
        + 'Run with `node --env-file=.env` or `set -a; . ./.env; set +a` to exercise it.'
    );
}

/** GET a route and return { status, body }. */
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

describeDb('the API against the real sonar schema', () => {
    afterAll(async () => {
        await closePool();
    });

    test('/api/health reports the four counts and the freshest timestamps', async () => {
        const { status, body, headers } = await get('/api/health');
        expect(status).toBe(200);
        expect(body.ok).toBe(true);
        expect(headers.get('cache-control')).toBe('public, max-age=60');
        expect(headers.get('content-type')).toContain('application/json');
        for (const key of ['issuers', 'tokens', 'snapshots', 'trades']) {
            expect(typeof body.counts[key]).toBe('number');
            expect(body.counts[key]).toBeGreaterThan(0);
        }
        expect(body.latestSnapshotDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(Date.parse(body.latestTradeAt)).not.toBeNaN();
    });

    test('/api/history/overview distinguishes catalogue growth from holder and volume coverage', async () => {
        const { status, body } = await get('/api/history/overview');
        expect(status).toBe(200);
        expect(body.methodology.tokenCount).toContain('discovery');
        expect(body.items.length).toBeGreaterThan(1);
        const dates = body.items.map((row) => row.date);
        expect([...dates].sort()).toEqual(dates);
        for (const row of body.items) {
            expect(row.tokenCount).toBeGreaterThan(0);
            expect(row.holderCoverage).toBeLessThanOrEqual(row.tokenCount);
            expect(row.volumeCoverage).toBeLessThanOrEqual(row.tokenCount);
            expect(Array.isArray(row.issuerCounts)).toBe(true);
            expect(row.issuerCounts.reduce((sum, issuer) => sum + issuer.tokenCount, 0))
                .toBe(row.tokenCount);
        }
    });

    test('/api/facets?by=recipe sums to the total it reports', async () => {
        const { status, body } = await get('/api/facets?by=recipe,health');
        expect(status).toBe(200);
        expect(body.total).toBeGreaterThan(0);
        for (const facet of ['recipe', 'health']) {
            const sum = body.facets[facet].reduce((acc, row) => acc + row.count, 0);
            // Every token has exactly one value per facet (null included), so the buckets must
            // partition the filtered set — a sum that differs means a join fanned out.
            expect(sum).toBe(body.total);
        }
    });

    test('a facet is not narrowed by its own filter, but the others are', async () => {
        const unfiltered = await get('/api/facets?by=health');
        const filtered = await get('/api/facets?by=health,issuer&health=warning');
        expect(filtered.status).toBe(200);
        // The health facet still shows every status despite ?health=warning ...
        expect(filtered.body.facets.health).toEqual(unfiltered.body.facets.health);
        // ... while the issuer facet only counts the warning tokens.
        const issuerSum = filtered.body.facets.issuer.reduce((a, r) => a + r.count, 0);
        expect(issuerSum).toBe(filtered.body.total);
        expect(filtered.body.total).toBeLessThan(unfiltered.body.total);
    });

    test('/api/tokens?issuer=prestocks agrees with the issuer aggregate', async () => {
        const issuers = await get('/api/issuers');
        const prestocks = issuers.body.items.find((row) => row.slug === 'prestocks');
        expect(prestocks).toBeTruthy();
        const { status, body } = await get('/api/tokens?issuer=prestocks');
        expect(status).toBe(200);
        expect(body.total).toBe(Number(prestocks.tokens_in_db));
        expect(body.items).toHaveLength(body.total);
        for (const item of body.items) {
            expect(item.issuer_slug).toBe('prestocks');
            expect(item.issuer_name).toBe('PreStocks');
            expect(typeof item.mint).toBe('string');
            expect(['good', 'caution', 'warning', 'unknown']).toContain(item.market_health);
            expect(['good', 'caution', 'warning', 'unknown']).toContain(item.control_health);
            expect(['good', 'caution', 'warning', 'unknown']).toContain(item.legal_health);
            expect(['good', 'caution', 'warning', 'unknown']).toContain(item.composability_health);
        }
    });

    test('an unknown mint is a 404 with the error envelope', async () => {
        const { status, body } = await get('/api/tokens/not-a-real-mint');
        expect(status).toBe(404);
        expect(body.error.code).toBe('not_found');
        expect(body.error.message).toContain('not-a-real-mint');
    });

    test('an unwhitelisted sort is a 400, not a 500 and not a silent default', async () => {
        const { status, body, headers } = await get('/api/tokens?sort=supply_raw');
        expect(status).toBe(400);
        expect(body.error.code).toBe('unknown_sort');
        expect(headers.get('cache-control')).toBe('no-store');
    });

    test('an unknown route is a 404 JSON envelope, not HTML', async () => {
        const { status, body } = await get('/api/nope');
        expect(status).toBe(404);
        expect(body.error.code).toBe('not_found');
    });

    test('a token detail carries the record, the issuer summary and the two counts', async () => {
        const list = await get('/api/tokens?issuer=prestocks&limit=1');
        const mint = list.body.items[0].mint;
        const { status, body } = await get(`/api/tokens/${mint}`);
        expect(status).toBe(200);
        expect(body.mint).toBe(mint);
        expect(body.healthDimensions).toEqual({
            market: expect.any(String),
            control: expect.any(String),
            legal: expect.any(String),
            composability: expect.any(String)
        });
        expect(body.record.mint).toBe(mint);
        expect(body.issuer.slug).toBe('prestocks');
        // The alias fix: the token's own name must not be the issuer's name.
        expect(body.name).toBe(body.record.name);
        expect(typeof body.snapshotDates).toBe('number');
        expect(typeof body.tradesInDb).toBe('number');
    });

    test('history is ascending by date and uses the typed columns', async () => {
        const list = await get('/api/tokens?limit=1&sort=volume24_usd');
        const mint = list.body.items[0].mint;
        const { status, body } = await get(`/api/tokens/${mint}/history`);
        expect(status).toBe(200);
        expect(body.items.length).toBeGreaterThan(0);
        const dates = body.items.map((r) => r.snapshot_date);
        expect([...dates].sort()).toEqual(dates);
        expect(body.items[0]).toHaveProperty('liquidity');
        expect(body.items[0]).not.toHaveProperty('row');
    });

    test('the trade tape is newest first and pages on the (time, sig) cursor', async () => {
        const first = await get('/api/trades/recent?limit=5');
        expect(first.status).toBe(200);
        expect(first.body.items).toHaveLength(5);
        const times = first.body.items.map((r) => Date.parse(r.time));
        expect([...times].sort((a, b) => b - a)).toEqual(times);
        expect(first.body.nextBefore).toMatch(/^\S+,\S+$/);

        const second = await get(
            `/api/trades/recent?limit=5&before=${encodeURIComponent(first.body.nextBefore)}`
        );
        const seen = new Set(first.body.items.map((r) => r.sig));
        for (const row of second.body.items) expect(seen.has(row.sig)).toBe(false);
    });

    test('/api/trades/daily groups per day per dex', async () => {
        const { status, body } = await get('/api/trades/daily?days=30');
        expect(status).toBe(200);
        expect(body.items.length).toBeGreaterThan(0);
        for (const row of body.items) {
            expect(row.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(typeof row.dex).toBe('string');
            expect(row.trades).toBeGreaterThan(0);
            expect(row.traders).toBeGreaterThan(0);
        }
    });

    test('/api/issuers lists every issuer with its counts, /:slug adds the record', async () => {
        const list = await get('/api/issuers');
        expect(list.status).toBe(200);
        expect(list.body.count).toBeGreaterThanOrEqual(12);
        const prestocks = list.body.items.find((r) => r.slug === 'prestocks');
        expect(prestocks.tokens_in_db).toBeGreaterThan(0);
        expect(prestocks.health_good + prestocks.health_caution + prestocks.health_warning)
            .toBe(prestocks.tokens_in_db);

        const detail = await get('/api/issuers/prestocks');
        expect(detail.status).toBe(200);
        expect(detail.body.tokens).toHaveLength(prestocks.tokens_in_db);
        expect(detail.body.record.slug || detail.body.record.name).toBeTruthy();

        const missing = await get('/api/issuers/no-such-issuer');
        expect(missing.status).toBe(404);
    });

    test('/api/search finds a token by symbol and its issuer by name', async () => {
        const { status, body } = await get('/api/search?q=prestocks');
        expect(status).toBe(200);
        expect(body.issuers.map((r) => r.slug)).toContain('prestocks');
        expect(body.tokens.length).toBeLessThanOrEqual(20);

        const empty = await get('/api/search');
        expect(empty.status).toBe(400);
        expect(empty.body.error.code).toBe('missing_q');
    });

    test('an unknown filter name is rejected instead of being ignored', async () => {
        const { status, body } = await get('/api/tokens?issuerr=prestocks');
        expect(status).toBe(400);
        expect(body.error.code).toBe('unknown_filter');
    });

    test('limit is clamped rather than trusted', async () => {
        const { body } = await get('/api/tokens?limit=99999');
        expect(body.limit).toBe(500);
        expect(body.items.length).toBeLessThanOrEqual(500);
    });

    // --- the evidence surface (stocks/EVIDENCE.md) ---------------------------------------------
    // These run against however many claims the research pass has written, which on the day the
    // tables were created is zero. A route that answers 200 with an empty list IS the thing worth
    // checking: the statements have to run, and the shape has to be right, before the rows exist.

    test('/api/claims answers with the documented envelope, even with no claims yet', async () => {
        const { status, body } = await get('/api/claims?limit=5');
        expect(status).toBe(200);
        expect(typeof body.total).toBe('number');
        expect(body.limit).toBe(5);
        expect(body.sort).toBe('status');
        expect(Array.isArray(body.items)).toBe(true);
        for (const row of body.items) {
            expect(typeof row.id).toBe('string');
            expect(typeof row.field).toBe('string');
            expect(['issuer', 'token']).toContain(row.subject_type);
            expect(row.quote !== null || row.url !== null).toBe(true);
        }
    });

    test('/api/claims rejects an unknown filter and an unknown sort', async () => {
        expect((await get('/api/claims?issuerr=x')).body.error.code).toBe('unknown_filter');
        expect((await get('/api/claims?sort=quote')).body.error.code).toBe('unknown_sort');
    });

    test('/api/claims filters by issuer, field and status without breaking the total', async () => {
        const all = await get('/api/claims?limit=1');
        const filtered = await get('/api/claims?issuer=prestocks&status=confirmed&limit=1');
        expect(filtered.status).toBe(200);
        expect(filtered.body.total).toBeLessThanOrEqual(all.body.total);
        expect(filtered.body.filters).toEqual({ issuer: ['prestocks'], status: ['confirmed'] });
    });

    test('/api/issuers/:slug/claims summarises by status, and 404s on an unknown slug', async () => {
        const { status, body } = await get('/api/issuers/prestocks/claims');
        expect(status).toBe(200);
        expect(body.slug).toBe('prestocks');
        for (const key of ['claims', 'confirmed', 'unverified', 'inference', 'corrected',
            'fields_sourced']) {
            expect(typeof body.summary[key]).toBe('number');
        }
        expect(body.items.length).toBe(body.count);

        const missing = await get('/api/issuers/nonesuch/claims');
        expect(missing.status).toBe(404);
        expect(missing.body.error.code).toBe('not_found');
    });

    test('/api/sources reports last_checked_at and the archive copy per URL', async () => {
        const { status, body } = await get('/api/sources?limit=5');
        expect(status).toBe(200);
        expect(typeof body.total).toBe('number');
        for (const row of body.items) {
            expect(typeof row.url).toBe('string');
            expect(['pdf', 'html', 'api', 'onchain']).toContain(row.kind);
            expect(['new', 'ok', 'changed', 'gone', 'blocked', 'error']).toContain(row.status);
            expect(row).toHaveProperty('last_checked_at');
            expect(row).toHaveProperty('archive_url');
            expect(typeof row.claims).toBe('number');
        }
        expect((await get('/api/sources?kinds=pdf')).body.error.code).toBe('unknown_filter');
    });

    test('/api/changes reads the change feed newest first and takes an ISO since', async () => {
        const { status, body } = await get('/api/changes?limit=5');
        expect(status).toBe(200);
        expect(body.sort).toBe('detected_at');
        const times = body.items.map((r) => Date.parse(r.detected_at));
        expect(times).toEqual([...times].sort((a, b) => b - a));

        const since = await get('/api/changes?since=2026-01-01T00:00:00Z&severity=warning,critical');
        expect(since.status).toBe(200);
        expect(since.body.since).toBe('2026-01-01T00:00:00Z');
        expect((await get('/api/changes?since=last%20tuesday')).body.error.code).toBe('bad_since');
    });

    test('/api/rules serves the health rule ids with their labels and thresholds', async () => {
        const { status, body } = await get('/api/rules');
        expect(status).toBe(200);
        // This is the gap monitor.js papered over with a hard-coded RULE_LABELS map.
        expect(body.count).toBeGreaterThan(0);
        expect(body.items.length).toBe(body.count);
        for (const rule of body.items) {
            expect(typeof rule.id).toBe('string');
            expect(typeof rule.label).toBe('string');
            expect(typeof rule.description).toBe('string');
            expect(rule.thresholds).toBeTruthy();
        }
        expect(body.items.map((r) => r.id)).toContain('keyControl');
    });

    test('a repeated filter parameter is OR, not last-one-wins', async () => {
        const shift = await get('/api/tokens?issuer=shift&limit=1');
        const both = await get('/api/tokens?issuer=shift&issuer=prestocks&limit=1');
        const comma = await get('/api/tokens?issuer=shift,prestocks&limit=1');
        expect(both.status).toBe(200);
        expect(both.body.total).toBe(comma.body.total);
        expect(both.body.total).toBeGreaterThan(shift.body.total);
    });

    test('a jurisdiction value containing a comma can finally be filtered on', async () => {
        const facets = await get('/api/facets?by=jurisdiction');
        const withComma = facets.body.facets.jurisdiction.find((row) => row.value.includes(','));
        // Six of the nine values contain a comma; if that ever stops being true the test should
        // say so rather than silently checking nothing.
        expect(withComma).toBeTruthy();
        const q = `/api/tokens?jurisdiction[]=${encodeURIComponent(withComma.value)}&limit=1`;
        const { status, body } = await get(q);
        expect(status).toBe(200);
        expect(body.total).toBe(withComma.count);
        // The old comma-list form on the same value returns nothing, which is the gap.
        const split = await get(`/api/tokens?jurisdiction=${encodeURIComponent(withComma.value)}&limit=1`);
        expect(split.body.total).toBe(0);
    });

    test('overall and dimension health sort by severity, and the table sorts are accepted', async () => {
        const { status, body } = await get('/api/tokens?sort=health_status&order=asc&limit=500');
        expect(status).toBe(200);
        const rank = { good: 0, caution: 1, warning: 2 };
        const ranks = body.items.map((r) => (r.health_status in rank ? rank[r.health_status] : 9));
        expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
        const marketDesc = await get('/api/tokens?sort=market_health&order=desc&limit=500');
        const lastJudged = marketDesc.body.items.findLastIndex((row) => row.market_health !== 'unknown');
        const firstUnknown = marketDesc.body.items.findIndex((row) => row.market_health === 'unknown');
        expect(firstUnknown).toBeGreaterThan(lastJudged);
        for (const sort of [
            'market_health', 'control_health', 'legal_health', 'composability_health', 'usd_price', 'trades24', 'traders24',
            'worst_rule', 'venue_spread_pct', 'top1_share_pct'
        ]) {
            const res = await get(`/api/tokens?sort=${sort}&limit=1`);
            expect(res.status).toBe(200);
            expect(res.body.sort).toBe(sort);
        }
    });
});
