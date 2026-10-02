// GET /api and /api/ — the route index. Runs in-process (the index answers from memory), and checks
// the hand-written ROUTES list against the routes Hono actually registered so the two cannot drift.

import { app, ROUTES } from '../src/app.js';

describe('the API index', () => {
    test.each(['/api', '/api/'])('%s answers with the route list', async (path) => {
        const res = await app.request(path);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.name).toBe('rwa-sonar-api');
        expect(body.routes).toEqual(ROUTES);
        expect(body.routes).toContain('GET /api/health');
    });

    test('every registered route is listed, and nothing listed is unregistered', () => {
        // "GET|PUT /api/x/:id?a= (note)" → ["GET /api/x/:id", "PUT /api/x/:id"]
        const listed = new Set(ROUTES.flatMap((entry) => {
            const [methods, path] = entry.split(' ');
            return methods.split('|').map((m) => `${m} ${path.split('?')[0]}`);
        }));
        const registered = new Set(app.routes
            .filter((r) => r.method !== 'ALL' && r.path !== '/api' && r.path !== '/api/')
            .map((r) => `${r.method} ${r.path}`));
        expect([...registered].filter((r) => !listed.has(r))).toEqual([]);
        expect([...listed].filter((r) => !registered.has(r))).toEqual([]);
    });
});
