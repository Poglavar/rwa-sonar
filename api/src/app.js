// The Hono application: middleware, route mounting and the two error renderers. Exported without
// a listener so a test can call `app.request('/api/health')` in-process — there is no way to hit
// a route in this file that a test cannot reach.

import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { ApiError } from './lib/query.js';
import { log, logError } from './lib/log.js';
import evidenceRoutes from './routes/evidence.js';
import facetRoutes from './routes/facets.js';
import healthRoutes from './routes/health.js';
import historyRoutes from './routes/history.js';
import issuerRoutes from './routes/issuers.js';
import litigationRoutes from './routes/litigation.js';
import reviewRoutes from './routes/review.js';
import searchRoutes from './routes/search.js';
import tokenRoutes from './routes/tokens.js';
import tradeRoutes from './routes/trades.js';
import watchlistRoutes from './routes/watchlists.js';
import whatIfRoutes from './routes/whatif.js';

export const ROUTES = [
    'GET /api/health',
    'GET /api/history/overview',
    'GET /api/history/underlyings/:ticker?days=',
    'GET /api/facets?by=<facets>&<filters>',
    'GET /api/tokens?<filters>&q=&sort=&order=&limit=&offset=',
    'GET /api/tokens/:mint',
    'GET /api/tokens/:mint/history?days=',
    'GET /api/tokens/:mint/trades?limit=&before=',
    'GET /api/issuers',
    'GET /api/issuers/:slug',
    'GET /api/search?q=',
    'GET /api/trades/recent?limit=&before=',
    'GET /api/trades/daily?days=',
    'GET /api/claims?issuer=&field=&status=&method=&sort=&order=&limit=&offset=',
    'GET /api/issuers/:slug/claims',
    'GET /api/sources?issuer=&kind=&status=',
    'GET /api/changes?kind=&severity=&issuer=&since=&limit=',
    'GET /api/rules',
    'GET|POST /api/review/resolutions (Bearer editor token)',
    'GET /api/failure-modes',
    'GET /api/what-if?mode=&issuer=&status=&actor=&flow=&sort=&order=&limit=&offset=',
    'GET /api/issuers/:slug/what-if',
    'GET /api/issuers/:slug/chain',
    'GET /api/litigation?issuer=&source=&match=&review=&sort=&order=&limit=&offset=',
    'POST /api/watchlists',
    'GET|PUT|DELETE /api/watchlists/:watchId (X-Watch-Key)',
    'POST /api/watchlists/:watchId/share (owner X-Watch-Key)'
];

/** Public reads can be shared briefly; mutations and errors are never cached. */
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
    c.res.headers.set('Cache-Control', status >= 400 || !['GET', 'HEAD'].includes(c.req.method) ? CACHE_ERROR : CACHE_OK);
    log(`${id} ${c.req.method} ${c.req.path}${queryString(c.req.url)} ${status} ${ms.toFixed(1)}ms`);
});

// Public research remains readable without credentials. Watchlists add bounded writes protected
// by an opaque owner key in X-Watch-Key; no cookies or ambient credentials are accepted. Put the
// specific middleware first because a CORS preflight returns immediately without calling `next`.
const watchCors = cors({
    origin: '*',
    allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-Watch-Key'],
    maxAge: 86400
});
const reviewCors = cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400
});
app.use('/api/review', reviewCors);
app.use('/api/review/*', reviewCors);
app.use('/api/watchlists', watchCors);
app.use('/api/watchlists/*', watchCors);
app.use('/api/*', cors({
    origin: '*',
    allowMethods: ['GET', 'HEAD', 'OPTIONS'],
    maxAge: 86400
}));

app.get('/api', (c) => c.json({ name: 'rwa-sonar-api', routes: ROUTES }));

app.route('/api', healthRoutes);
app.route('/api', historyRoutes);
app.route('/api', reviewRoutes);
// Before the issuer routes: /issuers/:slug/claims must not be shadowed by /issuers/:slug.
app.route('/api', evidenceRoutes);
// Same reason: /issuers/:slug/what-if and /issuers/:slug/chain go before /issuers/:slug.
app.route('/api', whatIfRoutes);
app.route('/api', litigationRoutes);
app.route('/api', facetRoutes);
app.route('/api', tokenRoutes);
app.route('/api', issuerRoutes);
app.route('/api', searchRoutes);
app.route('/api', tradeRoutes);
app.route('/api', watchlistRoutes);

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
