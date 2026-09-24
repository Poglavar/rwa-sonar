// The one test in api/ that touches the real database. It calls the Hono app in-process
// (app.request(), no listener, no port) against the local `geodata` database, so it checks the
// things a pure builder test cannot: that the SQL actually runs, that the facet counts add up to
// the total the same query reports, and that a bad parameter comes back as a 400 rather than a
// 500. Skipped with a clear message when DATABASE_URL is absent, so a checkout without .env
// still gets a green suite from the builder tests.

import app from '../src/app.js';
import { closePool, query } from '../src/db.js';

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

async function jsonRequest(path, { method = 'GET', body, watchKey, ip } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (watchKey) headers['X-Watch-Key'] = watchKey;
    if (ip) headers['X-Forwarded-For'] = ip;
    const res = await app.request(path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
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
        expect(Array.isArray(body.annotations)).toBe(true);
        expect(body.annotations.length).toBe(body.items.length - 1);
        const dates = body.items.map((row) => row.date);
        expect([...dates].sort()).toEqual(dates);
        for (const row of body.items) {
            expect(row.tokenCount).toBeGreaterThan(0);
            expect(row.holderCoverage).toBeLessThanOrEqual(row.tokenCount);
            expect(row.volumeCoverage).toBeLessThanOrEqual(row.tokenCount);
            expect(row).toHaveProperty('activeTokenCount');
            expect(row).toHaveProperty('defiSupportedTokens');
            expect(row.health).toHaveProperty('composability');
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
        expect(body.redemptionUsability.answerScope).toBe('product');
        expect(body.redemptionUsability.productSymbol).toBe(body.symbol);
        expect(body.redemptionUsability.fields.map((field) => field.id)).toContain('successful-redemption');
        expect(body.authorityControl).toEqual(expect.objectContaining({
            status: expect.stringMatching(/^(caution|unknown|constrained)$/),
            headline: expect.any(String),
            authorities: expect.any(Array)
        }));
        expect(body.recordContext).toEqual(expect.objectContaining({
            kind: 'raw-research-record', scope: 'exact-token'
        }));
    });

    test('an exact xStocks token does not inherit the TSLAx example fee', async () => {
        const list = await get('/api/tokens?q=FGDLx&limit=10');
        const row = list.body.items.find((item) => item.symbol === 'FGDLx');
        expect(row).toBeTruthy();
        const detail = await get(`/api/tokens/${encodeURIComponent(row.mint)}`);
        const fee = detail.body.redemptionUsability.fields.find((field) => field.id === 'fees');
        expect(fee).toMatchObject({
            summary: 'No FGDLx-specific fee is confirmed; TSLAx is a programme example only.',
            applicable: false, evidence: 'unknown'
        });
        expect(fee.completeText).toContain('0.50%');
        expect(detail.body.authorityControl).toMatchObject({ status: 'caution' });
        expect(detail.body.authorityControl.direct).toContain('rebase');
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
        expect(detail.body.redemptionUsability.answerScope).toBe('programme');
        expect(detail.body.recordContext).toEqual(expect.objectContaining({
            kind: 'raw-research-record', scope: 'issuer-programme'
        }));
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

    test('a watchlist round-trip requires its one-time owner key and is deletable', async () => {
        const created = await jsonRequest('/api/watchlists', {
            method: 'POST',
            body: {
                ticker: 'NVDA', issuers: ['ondo-global-markets', 'xstocks-backed'],
                filters: ['confirmedCollateral'], title: 'Integration test watch'
            }
        });
        expect(created.status).toBe(201);
        expect(created.headers.get('cache-control')).toBe('no-store');
        expect(created.body.watchId).toMatch(/^[0-9a-f-]{36}$/);
        expect(created.body.watchKey.length).toBeGreaterThan(24);
        expect(created.body.readKey.length).toBeGreaterThan(24);
        expect(created.body.access).toBe('owner');
        expect(created.body.baselineRecorded).toBe(false);

        const denied = await jsonRequest(`/api/watchlists/${created.body.watchId}`, { watchKey: 'wrong-key-that-is-long-enough-123' });
        expect(denied.status).toBe(404);

        const read = await jsonRequest(`/api/watchlists/${created.body.watchId}`, { watchKey: created.body.watchKey });
        expect(read.status).toBe(200);
        expect(read.body).toMatchObject({ ticker: 'NVDA', issuers: ['ondo-global-markets', 'xstocks-backed'] });
        expect(read.body.access).toBe('owner');
        expect(read.body).not.toHaveProperty('watchKey');
        expect(read.body).not.toHaveProperty('readKey');

        const shared = await jsonRequest(`/api/watchlists/${created.body.watchId}`, { watchKey: created.body.readKey });
        expect(shared.status).toBe(200);
        expect(shared.body.access).toBe('read-only');
        const sharedCannotEdit = await jsonRequest(`/api/watchlists/${created.body.watchId}`, {
            method: 'PUT', watchKey: created.body.readKey, body: {
                ticker: 'NVDA', issuers: ['xstocks-backed'], title: 'Illicit edit'
            }
        });
        expect(sharedCannotEdit.status).toBe(404);

        const rotated = await jsonRequest(`/api/watchlists/${created.body.watchId}/share`, {
            method: 'POST', watchKey: created.body.watchKey
        });
        expect(rotated.status).toBe(200);
        expect(rotated.body.readKey).not.toBe(created.body.readKey);
        const oldShare = await jsonRequest(`/api/watchlists/${created.body.watchId}`, { watchKey: created.body.readKey });
        expect(oldShare.status).toBe(404);
        const newShare = await jsonRequest(`/api/watchlists/${created.body.watchId}`, { watchKey: rotated.body.readKey });
        expect(newShare.body.access).toBe('read-only');

        const removed = await jsonRequest(`/api/watchlists/${created.body.watchId}`, {
            method: 'DELETE', watchKey: created.body.watchKey
        });
        expect(removed.status).toBe(204);
        const gone = await jsonRequest(`/api/watchlists/${created.body.watchId}`, { watchKey: created.body.watchKey });
        expect(gone.status).toBe(404);
    });

    test.each([
        ['token', { mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh' }],
        ['issuer', { issuerSlug: 'xstocks-backed' }],
        ['protocol-market', {
            mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh',
            integrationId: 'kamino:collateral',
            marketKey: '5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua'
        }]
    ])('a focused %s watch survives the API/database round-trip', async (type, target) => {
        const created = await jsonRequest('/api/watchlists', {
            method: 'POST', ip: `192.0.2.${type.length}`,
            body: { type, target, title: `${type} integration test` }
        });
        try {
            expect(created.status).toBe(201);
            expect(created.body).toMatchObject({ type, target, access: 'owner' });
            const read = await jsonRequest(`/api/watchlists/${created.body.watchId}`, { watchKey: created.body.readKey });
            expect(read.status).toBe(200);
            expect(read.body).toMatchObject({ type, target, access: 'read-only' });
        } finally {
            if (created.status === 201) {
                const removed = await jsonRequest(`/api/watchlists/${created.body.watchId}`, {
                    method: 'DELETE', watchKey: created.body.watchKey
                });
                expect(removed.status).toBe(204);
            }
        }
    });

    test.each([
        ['FGDL', ['xstocks-backed']],
        ['SPCX', ['backpack-securities', 'ondo-global-markets', 'shift', 'xstocks-backed']]
    ])('a %s watch survives the API/database round-trip without a pair-only constraint', async (ticker, issuers) => {
        const created = await jsonRequest('/api/watchlists', {
            method: 'POST', body: { ticker, issuers, title: 'Cardinality integration test' }
        });
        try {
            expect(created.status).toBe(201);
            const read = await jsonRequest(`/api/watchlists/${created.body.watchId}`, { watchKey: created.body.watchKey });
            expect(read.status).toBe(200);
            expect(read.body).toMatchObject({ ticker, issuers });
        } finally {
            if (created.status === 201) {
                const removed = await jsonRequest(`/api/watchlists/${created.body.watchId}`, {
                    method: 'DELETE', watchKey: created.body.watchKey
                });
                expect(removed.status).toBe(204);
            }
        }
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

    test('/api/claims publishes corrected research as current evidence without the correction narrative', async () => {
        const result = await get('/api/claims?issuer=xstocks-backed&field=redemption.minimum&limit=20');
        expect(result.status).toBe(200);
        expect(result.body.items.length).toBeGreaterThan(0);
        expect(result.body.items.every((row) => row.status !== 'contradicted-corrected')).toBe(true);
        expect(result.body.items.some((row) => row.status === 'confirmed' && row.note === null)).toBe(true);
        expect(result.body.items.some((row) => /^(CORRECTION|CHANGED)[.:]/.test(row.note ?? ''))).toBe(false);
    });

    test('/api/issuers/:slug/claims summarises by status, and 404s on an unknown slug', async () => {
        const { status, body } = await get('/api/issuers/prestocks/claims');
        expect(status).toBe(200);
        expect(body.slug).toBe('prestocks');
        for (const key of ['claims', 'confirmed', 'unverified', 'inference',
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
            expect(row).toHaveProperty('read_via');
            expect(row).toHaveProperty('capture_at');
            // A capture time exists only for an archived read.
            if (row.capture_at !== null) expect(row.read_via).toBe('wayback');
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

    test('/api/changes carries the latest valid model assessment and filters on material', async () => {
        const probe = await query("SELECT to_regclass('sonar.change_judgment') IS NOT NULL AS present");
        if (!probe.rows[0].present) {
            const { body } = await get('/api/changes?limit=1');
            expect(body.modelAssessmentNote).toMatch(/does not exist/);
            return;
        }
        // Two fixture judgments on the newest public event under a model name no real run uses:
        // an invalid one, and a valid one that must win over it. Removed again in `finally`.
        const { body: feed } = await get('/api/changes?limit=1');
        const eventId = Number(feed.items[0].id);
        const model = 'jest-fixture-model';
        const insert = `INSERT INTO sonar.change_judgment (change_event_id, covers_event_ids, dedupe_key, model,
                prompt_version, material, severity, affects, summary, quoted_change, confidence, status, cost_usd)
            VALUES ($1, jsonb_build_array($1::bigint), 'jest-fixture', $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, $10, 0.0012)`;
        try {
            await query(insert, [eventId, model, 'jest-invalid', null, null, '[]', 'SECRET TEXT', '[]', null, 'invalid']);
            await query(insert, [eventId, model, 'jest-valid', true, 'warning', '["redemption"]',
                'Redemption now needs issuer consent.', '["subject to issuer consent"]', 0.8, 'valid']);
            const { status, body } = await get('/api/changes?material=true&limit=500');
            expect(status).toBe(200);
            expect(body.material).toBe(true);
            const row = body.items.find((r) => Number(r.id) === eventId);
            expect(row.modelAssessment).toMatchObject({
                status: 'valid', model, promptVersion: 'jest-valid', material: true, severity: 'warning',
                affects: ['redemption'], quotedChange: ['subject to issuer consent'], confidence: 0.8,
                costUsd: 0.0012
            });
            expect(Date.parse(row.modelAssessment.judgedAt)).not.toBeNaN();
            for (const r of body.items) expect(r.modelAssessment.material).toBe(true);
            const notMaterial = await get('/api/changes?material=false&limit=500');
            expect(notMaterial.body.items.some((r) => Number(r.id) === eventId)).toBe(false);

            // With only the invalid judgment left, the event shows the status and none of its text.
            await query("DELETE FROM sonar.change_judgment WHERE model = $1 AND prompt_version = 'jest-valid'", [model]);
            const { body: after } = await get('/api/changes?limit=1');
            const invalidRow = after.items.find((r) => Number(r.id) === eventId);
            expect(invalidRow.modelAssessment).toEqual({ status: 'invalid' });
        } finally {
            await query('DELETE FROM sonar.change_judgment WHERE model = $1', [model]);
        }
    });

    test('/api/events runs the shared watcher query and answers live, newest first, within its limit', async () => {
        const { status, body } = await get('/api/events?limit=10');
        expect(status).toBe(200);
        expect(body.live).toBe(true);
        expect(body.events.length).toBeLessThanOrEqual(10);
        const times = body.events.map((e) => Date.parse(e.at.length === 10 ? `${e.at}T00:00:00Z` : e.at));
        expect(times).toEqual([...times].sort((a, b) => b - a));
        for (const event of body.events) expect(['catalogue', 'terms', 'keys', 'defi', 'market', 'legal']).toContain(event.category);
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
        const firstUnknown = marketDesc.body.items.findIndex((row) => row.market_health === 'unknown');
        const judgedMarketRanks = marketDesc.body.items
            .filter((row) => row.market_health !== 'unknown')
            .map((row) => rank[row.market_health]);
        expect(judgedMarketRanks).toEqual([...judgedMarketRanks].sort((a, b) => b - a));
        // Unknowns are NULLS LAST, but a page can now contain only judged rows because the
        // catalogue is larger than the API's 500-row page ceiling.
        if (firstUnknown !== -1) {
            expect(marketDesc.body.items.slice(firstUnknown).every((row) => row.market_health === 'unknown')).toBe(true);
        }
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
