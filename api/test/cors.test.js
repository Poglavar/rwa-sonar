// The CORS contract, exercised through the app itself (no port, no database — `/api` is the route
// list and answers from memory, and a preflight never reaches a handler at all). This matters
// because the pages are same-origin in production and cross-origin in development: without the
// header, monitor.html on the dev server fetches nothing and the browser reports it as a network
// failure with no status, which looks exactly like the API being down.
//
// Watchlist writes use an explicit owner-key header and never cookies; the preflight must advertise
// that narrow capability so a local preview can exercise the production API.

import { app } from '../src/app.js';

describe('CORS on the public API surface', () => {
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

    test('watchlist writes and their owner-key header are advertised', async () => {
        const res = await app.request('/api/watchlists', {
            method: 'OPTIONS',
            headers: { Origin: 'http://localhost:8113', 'Access-Control-Request-Method': 'POST' }
        });
        const allowed = res.headers.get('access-control-allow-methods') ?? '';
        expect(allowed).toMatch(/POST/);
        expect(res.headers.get('access-control-allow-headers')).toMatch(/X-Watch-Key/i);
    });

    test('analytics routes do not advertise write methods', async () => {
        const res = await app.request('/api/tokens', {
            method: 'OPTIONS',
            headers: { Origin: 'http://localhost:8113', 'Access-Control-Request-Method': 'POST' }
        });
        expect(res.headers.get('access-control-allow-methods') ?? '').not.toMatch(/POST|PUT|DELETE/);
    });

    test('review writes advertise only the explicit bearer header', async () => {
        const res = await app.request('/api/review/resolutions', {
            method: 'OPTIONS',
            headers: { Origin: 'http://localhost:8113', 'Access-Control-Request-Method': 'POST' }
        });
        expect(res.headers.get('access-control-allow-methods') ?? '').toMatch(/POST/);
        expect(res.headers.get('access-control-allow-headers') ?? '').toMatch(/Authorization/i);
        expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    });

    test('credentials are never allowed, so `*` cannot unlock anything a cookie would', async () => {
        const res = await app.request('/api', { headers: { Origin: 'http://localhost:8113' } });
        expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    });
});
