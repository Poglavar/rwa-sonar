// The CORS contract, exercised through the app itself (no port, no database — `/api` is the route
// list and answers from memory, and a preflight never reaches a handler at all). This matters
// because the pages are same-origin in production and cross-origin in development: without the
// header, monitor.html on the dev server fetches nothing and the browser reports it as a network
// failure with no status, which looks exactly like the API being down.
//
// The second half is the part worth keeping honest: only the SAFE methods may be advertised. This
// API has no route that writes, so a preflight that promised POST or DELETE would be describing an
// API that does not exist.

import { app } from '../src/app.js';

describe('CORS on the read-only surface', () => {
    test('a GET carries Access-Control-Allow-Origin: *', async () => {
        const res = await app.request('/api', { headers: { Origin: 'http://localhost:8113' } });
        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });

    test('a preflight is answered without a body, and names GET', async () => {
        const res = await app.request('/api/tokens', {
            method: 'OPTIONS',
            headers: {
                Origin: 'http://localhost:8113',
                'Access-Control-Request-Method': 'GET'
            }
        });
        expect(res.status).toBe(204);
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
        expect(res.headers.get('access-control-allow-methods')).toMatch(/\bGET\b/);
    });

    test('no write method is advertised, because no route writes', async () => {
        const res = await app.request('/api/tokens', {
            method: 'OPTIONS',
            headers: { Origin: 'http://localhost:8113', 'Access-Control-Request-Method': 'POST' }
        });
        const allowed = res.headers.get('access-control-allow-methods') ?? '';
        expect(allowed).not.toMatch(/POST|PUT|PATCH|DELETE/);
    });

    test('credentials are never allowed, so `*` cannot unlock anything a cookie would', async () => {
        const res = await app.request('/api', { headers: { Origin: 'http://localhost:8113' } });
        expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    });
});
