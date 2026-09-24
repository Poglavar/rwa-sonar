// Tests GET /api/events without a database: the route is built with injected inputs (the built
// feed, the watcher rows, the clock), so what it merges, how long it reuses an answer and what it
// serves when the database does not answer can all be checked in-process.
import { Hono } from 'hono';

import { createEventsRoutes } from '../src/routes/events.js';

const FEED = {
    asOf: '2026-09-24T12:00:00Z',
    windowDays: 30,
    events: [
        { id: 'defi-loopscale', at: '2026-09-24', kind: 'defi-added', category: 'defi', title: 'Loopscale now lists SECZ for lending', severity: 'info', href: './protocols/x.html', source: 'DeFi scanner', keys: [], origin: 'file' },
        { id: 'court-1', at: '2026-09-23T04:00:00Z', kind: 'court-case', category: 'legal', title: 'stale copy', severity: 'caution', href: './issuers/tessera.html', source: 'court watcher', keys: [], origin: 'db' }
    ]
};

const ROWS = [
    { id: '1', detected_at: '2026-09-24T13:00:00Z', kind: 'litigation', subject_type: 'issuer', subject_id: 'tessera', field: 'case:k', after: 'A v. B', severity: 'caution', evidence: { query: 'Tessera' } },
    { id: '2', detected_at: '2026-09-24T13:07:00Z', kind: 'supply', subject_type: 'token', subject_id: 'M', field: 'supply', before: '1', after: '2', severity: 'caution', evidence: {} },
    { id: '3', detected_at: '2026-09-24T13:10:00Z', kind: 'extension-toggle', subject_type: 'token', subject_id: 'M', issuer_slug: 'tessera', field: 'paused', before: 'false', after: 'true', severity: 'warning', evidence: { symbol: 'T-OPENAI' } }
];

function app(options) {
    const hono = new Hono();
    hono.route('/api', createEventsRoutes({ readResolutions: async () => [], ...options }));
    return hono;
}

async function get(hono, path) {
    const res = await hono.request(path);
    return { status: res.status, headers: res.headers, body: await res.json() };
}

describe('GET /api/events', () => {
    test('merges fresh watcher rows into the release file through the shared rules, newest first', async () => {
        const hono = app({ readFeed: async () => FEED, queryRows: async () => ({ rows: ROWS, issuerNames: { tessera: 'Tessera' } }) });
        const { status, headers, body } = await get(hono, '/api/events');
        expect(status).toBe(200);
        expect(headers.get('cache-control')).toBe('public, max-age=60');
        expect(body.live).toBe(true);
        expect(body.asOf).toBe('2026-09-24T13:10:00Z');
        expect(body.events.map((e) => e.title)).toEqual(['Tessera paused T-OPENAI', 'A v. B names Tessera', 'Loopscale now lists SECZ for lending']);
        expect(body.events.some((e) => e.title === 'stale copy')).toBe(false);
    });

    test('queries the window counted back from the file\'s own asOf and honours limit', async () => {
        let since = null;
        const hono = app({ readFeed: async () => FEED, queryRows: async (value) => { since = value; return { rows: ROWS, issuerNames: {} }; } });
        const { body } = await get(hono, '/api/events?limit=1');
        expect(since).toBe('2026-08-24T12:00:00.000Z');
        expect(body).toMatchObject({ limit: 1, count: 1 });
        expect(body.events).toHaveLength(1);
    });

    test('reuses one merged answer until it is a minute old', async () => {
        let calls = 0;
        let clock = 1_000_000;
        const hono = app({ readFeed: async () => FEED, queryRows: async () => { calls += 1; return { rows: [], issuerNames: {} }; }, now: () => clock });
        await get(hono, '/api/events');
        clock += 30_000;
        await get(hono, '/api/events');
        expect(calls).toBe(1);
        clock += 31_000;
        await get(hono, '/api/events');
        expect(calls).toBe(2);
    });

    test('merges the lending watcher\'s rows too, linking a token to its protocol dossier', async () => {
        const lending = {
            liquidations: [],
            freezes: [{ protocol: 'kamino', market_id: 'kamino:xstocks-pool', mint: 'QQQ', symbol: 'QQQx', started_at: '2026-09-19T17:28:45Z', ended_at: '2026-09-21T13:42:13Z', last_seen_stale_at: '2026-09-21T13:39:54Z', cause: 'scope-suspension', end_basis: 'scope-resume', card_slug: null }]
        };
        const hono = app({
            readFeed: async () => FEED, readPages: async () => ({ 'QQQ|kamino': 'qqqx-kamino' }),
            queryRows: async () => ({ rows: [], issuerNames: {}, lending })
        });
        const { body } = await get(hono, '/api/events');
        expect(body.events.find((e) => e.category === 'lending')).toMatchObject({
            title: 'Kamino froze the QQQx collateral price for 44 h', href: './protocols/qqqx-kamino.html', at: '2026-09-19T17:28:45Z'
        });
    });

    test('serves the release file, marked not live, when the database does not answer; 503 with neither', async () => {
        const down = async () => { throw new Error('connect ECONNREFUSED'); };
        const { status, body } = await get(app({ readFeed: async () => FEED, queryRows: down }), '/api/events');
        expect(status).toBe(200);
        expect(body.live).toBe(false);
        expect(body.events.map((e) => e.id)).toEqual(['defi-loopscale', 'court-1']);
        const none = await get(app({ readFeed: async () => null, queryRows: down }), '/api/events');
        expect(none.status).toBe(503);
        expect(none.body.error.code).toBe('events_unavailable');
    });
});
