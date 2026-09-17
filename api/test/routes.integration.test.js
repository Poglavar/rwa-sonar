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

    test('/api/tokens?issuer=prestocks returns the eight PreStocks mints', async () => {
        const { status, body } = await get('/api/tokens?issuer=prestocks');
        expect(status).toBe(200);
        expect(body.total).toBe(8);
        expect(body.items).toHaveLength(8);
        for (const item of body.items) {
            expect(item.issuer_slug).toBe('prestocks');
            expect(item.issuer_name).toBe('PreStocks');
            expect(typeof item.mint).toBe('string');
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
        expect(prestocks.tokens_in_db).toBe(8);
        expect(prestocks.health_good + prestocks.health_caution + prestocks.health_warning)
            .toBe(8);

        const detail = await get('/api/issuers/prestocks');
        expect(detail.status).toBe(200);
        expect(detail.body.tokens).toHaveLength(8);
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
});
