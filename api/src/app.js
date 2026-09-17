// The Hono application: middleware, route mounting and the two error renderers. Exported without
// a listener so a test can call `app.request('/api/health')` in-process — there is no way to hit
// a route in this file that a test cannot reach.

import { Hono } from 'hono';

import { ApiError } from './lib/query.js';
import { log, logError } from './lib/log.js';
import facetRoutes from './routes/facets.js';
import healthRoutes from './routes/health.js';
import issuerRoutes from './routes/issuers.js';
import searchRoutes from './routes/search.js';
import tokenRoutes from './routes/tokens.js';
import tradeRoutes from './routes/trades.js';

export const ROUTES = [
    'GET /api/health',
    'GET /api/facets?by=<facets>&<filters>',
    'GET /api/tokens?<filters>&q=&sort=&order=&limit=&offset=',
    'GET /api/tokens/:mint',
    'GET /api/tokens/:mint/history?days=',
    'GET /api/tokens/:mint/trades?limit=&before=',
    'GET /api/issuers',
    'GET /api/issuers/:slug',
    'GET /api/search?q=',
    'GET /api/trades/recent?limit=&before=',
    'GET /api/trades/daily?days='
];

/** Everything here is a read: a minute of shared caching is safe and takes the repeat load off. */
const CACHE_OK = 'public, max-age=60';
/** Errors are the exception — caching a 400 for a minute hides the fix from the next request. */
const CACHE_ERROR = 'no-store';

/** The request's query string, `?` included, or '' when there is none. */
function queryString(url) {
    return new URL(url).search || '';
}

export const app = new Hono();

// One log line per request: id, method, path, status, ms. The id is short on purpose — it exists
// to tie a slow-query warning to the request that caused it, not to be globally unique.
app.use('*', async (c, next) => {
    const id = Math.random().toString(36).slice(2, 8);
    const started = process.hrtime.bigint();
    c.set('requestId', id);
    await next();
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const status = c.res.status;
    c.res.headers.set('X-Request-Id', id);
    c.res.headers.set('Cache-Control', status >= 400 ? CACHE_ERROR : CACHE_OK);
    log(`${id} ${c.req.method} ${c.req.path}${queryString(c.req.url)} ${status} ${ms.toFixed(1)}ms`);
});

app.get('/api', (c) => c.json({ name: 'rwa-sonar-api', routes: ROUTES }));

app.route('/api', healthRoutes);
app.route('/api', facetRoutes);
app.route('/api', tokenRoutes);
app.route('/api', issuerRoutes);
app.route('/api', searchRoutes);
app.route('/api', tradeRoutes);

app.notFound((c) => c.json({
    error: { code: 'not_found', message: `no route for ${c.req.method} ${c.req.path}` }
}, 404));

app.onError((err, c) => {
    if (err instanceof ApiError) {
        // A 4xx is the caller's parameter being wrong; log it as one line, without a stack.
        log(`${c.get('requestId') || '-'} ${err.status} ${err.code}: ${err.message}`);
        return c.json({ error: { code: err.code, message: err.message } }, err.status);
    }
    logError(`${c.get('requestId') || '-'} unhandled on ${c.req.path}:`, err.stack || err.message);
    return c.json({
        error: { code: 'internal', message: 'internal error; see the server log' }
    }, 500);
});

export default app;
