// GET /api/claims, /api/issuers/:slug/claims, /api/sources, /api/changes, /api/rules — the
// evidence surface (stocks/EVIDENCE.md). Claims are what we assert and the words we assert it from;
// sources are the URLs the watcher re-reads, with their archive copy and last check; changes are
// what moved. /api/rules is the one route that reads a FILE rather than the database: the health
// rule ids, labels, descriptions and thresholds live in stocks-health.json, which the pages
// otherwise hard-code (monitor.js keeps a RULE_LABELS map for exactly this gap).

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Hono } from 'hono';

import { query } from '../db.js';
import { clampLimit, clampOffset, notFound, parseOrder, parseSort } from '../lib/query.js';
import {
    CLAIM_SORTS, CHANGE_SORTS, SOURCE_SORTS,
    buildChangeCountSql, buildChangeListSql, buildClaimCountSql, buildClaimListSql,
    buildClaimSummarySql, buildSourceCountSql, buildSourceListSql,
    parseChangeFilters, parseClaimFilters, parseSince, parseSourceFilters
} from '../lib/evidence.js';
import { log, logWarn } from '../lib/log.js';

const routes = new Hono();
const LIST_OPTS = ['sort', 'order', 'limit', 'offset'];

/**
 * The health rules, read ONCE at import from the repo-root stocks-health.json — `../stocks-health.json`
 * from the api/ working directory the server runs in. It is resolved against THIS FILE rather than
 * `process.cwd()` so that jest, which runs from the repo root, reads the same file the server does;
 * a cwd-relative path would have made the route's test pass or fail on where it was invoked from.
 * `RULES_FILE` overrides it. A missing file is a warning, not a crash: the rest of the API is fine
 * without it, and the route then says plainly that it has no rules rather than letting a page
 * render rule ids as if they were labels.
 */
export const RULES_PATH = process.env.RULES_FILE
    ? resolve(process.cwd(), process.env.RULES_FILE)
    : join(import.meta.dirname, '..', '..', '..', 'stocks-health.json');

function readRules() {
    try {
        const doc = JSON.parse(readFileSync(RULES_PATH, 'utf8'));
        const rules = Array.isArray(doc.rules) ? doc.rules : [];
        if (rules.length === 0) logWarn(`${RULES_PATH} has no "rules" array; /api/rules is empty`);
        else log(`health rules: ${rules.length} from ${RULES_PATH} (generated ${doc.generatedAt ?? 'unknown'})`);
        return { generatedAt: doc.generatedAt ?? null, rules };
    } catch (err) {
        logWarn(`cannot read ${RULES_PATH} (${err.code ?? err.message}); /api/rules is empty. `
            + 'Run npm run stocks:health from the repo root.');
        return { generatedAt: null, rules: [] };
    }
}

export const RULES = readRules();

routes.get('/rules', (c) => c.json({
    count: RULES.rules.length,
    generatedAt: RULES.generatedAt,
    source: 'stocks-health.json',
    items: RULES.rules
}));

routes.get('/claims', async (c) => {
    // c.req.queries() keeps every occurrence of a repeated parameter; c.req.query() would keep only
    // the last one, so `?status=a&status=b` would silently filter on `b` alone.
    const filters = parseClaimFilters(c.req.queries(), LIST_OPTS);
    const opts = {
        sort: parseSort(c.req.query('sort'), CLAIM_SORTS, 'status'),
        order: parseOrder(c.req.query('order'), 'asc'),
        limit: clampLimit(c.req.query('limit'), { def: 100, max: 500 }),
        offset: clampOffset(c.req.query('offset'))
    };
    const countSql = buildClaimCountSql(filters);
    const listSql = buildClaimListSql(filters, opts);
    const [count, list] = await Promise.all([
        query(countSql.text, countSql.values),
        query(listSql.text, listSql.values)
    ]);
    return c.json({
        total: count.rows[0].total,
        limit: opts.limit,
        offset: opts.offset,
        sort: opts.sort,
        order: opts.order,
        filters,
        items: list.rows
    });
});

routes.get('/issuers/:slug/claims', async (c) => {
    const slug = c.req.param('slug');
    const issuer = await query('SELECT slug, name FROM sonar.stock_issuer WHERE slug = $1', [slug]);
    if (issuer.rows.length === 0) throw notFound(`no issuer with slug "${slug}"`);
    const filters = parseClaimFilters(c.req.queries(), [...LIST_OPTS, 'issuer']);
    filters.issuer = [slug];
    const opts = {
        sort: parseSort(c.req.query('sort'), CLAIM_SORTS, 'status'),
        order: parseOrder(c.req.query('order'), 'asc'),
        limit: clampLimit(c.req.query('limit'), { def: 500, max: 2000 }),
        offset: clampOffset(c.req.query('offset'))
    };
    const listSql = buildClaimListSql(filters, opts);
    const summarySql = buildClaimSummarySql(slug);
    const [list, summary] = await Promise.all([
        query(listSql.text, listSql.values),
        query(summarySql.text, summarySql.values)
    ]);
    return c.json({
        slug,
        name: issuer.rows[0].name,
        count: list.rows.length,
        // Coverage's denominator ("fields that need a source") is a property of the DOSSIER, not of
        // this table, so it is not counted here: stocks-issuers.json carries it, built from
        // stocks/data/claim-fields.json. What this reports is what the claims themselves say.
        summary: summary.rows[0],
        filters,
        items: list.rows
    });
});

routes.get('/sources', async (c) => {
    const filters = parseSourceFilters(c.req.queries(), LIST_OPTS);
    const opts = {
        sort: parseSort(c.req.query('sort'), SOURCE_SORTS, 'last_checked_at'),
        order: parseOrder(c.req.query('order')),
        limit: clampLimit(c.req.query('limit'), { def: 200, max: 1000 }),
        offset: clampOffset(c.req.query('offset'))
    };
    const countSql = buildSourceCountSql(filters);
    const listSql = buildSourceListSql(filters, opts);
    const [count, list] = await Promise.all([
        query(countSql.text, countSql.values),
        query(listSql.text, listSql.values)
    ]);
    return c.json({
        total: count.rows[0].total,
        limit: opts.limit,
        offset: opts.offset,
        sort: opts.sort,
        order: opts.order,
        filters,
        items: list.rows
    });
});

routes.get('/changes', async (c) => {
    const filters = parseChangeFilters(c.req.queries(), [...LIST_OPTS, 'since']);
    const since = parseSince(c.req.query('since'));
    const opts = {
        since,
        sort: parseSort(c.req.query('sort'), CHANGE_SORTS, 'detected_at'),
        order: parseOrder(c.req.query('order')),
        limit: clampLimit(c.req.query('limit'), { def: 100, max: 500 }),
        offset: clampOffset(c.req.query('offset'))
    };
    const countSql = buildChangeCountSql(filters, { since });
    const listSql = buildChangeListSql(filters, opts);
    const [count, list] = await Promise.all([
        query(countSql.text, countSql.values),
        query(listSql.text, listSql.values)
    ]);
    return c.json({
        total: count.rows[0].total,
        limit: opts.limit,
        offset: opts.offset,
        sort: opts.sort,
        order: opts.order,
        since,
        filters,
        items: list.rows
    });
});

export default routes;
