// GET /api/failure-modes, /api/what-if, /api/issuers/:slug/what-if and /api/issuers/:slug/chain —
// the trust-chain surface (stocks/EVIDENCE.md, "Trust chain and what-if"). The first three read
// sonar.failure_mode and sonar.what_if; the fourth reads nothing but the issuer's stored `record`
// jsonb and rebuilds the chain from it with the very same library the builder used, so the API and
// the built stocks-issuers.json can never show a differently graded chain.
//
// The catalogue itself (actor and flow LABELS, which are not in the database — the actor and flow
// lists live in stocks/data/trust-chain.json and are read by the page and the builders) comes from
// stocks/lib/trustchain.mjs, which reads the file ONCE at import. That import is also what makes
// the file a hard startup dependency: a chain built against no actors would render as "this issuer
// has no parties", so the module throws rather than serving that.

import { Hono } from 'hono';

import { query } from '../db.js';
import { clampLimit, clampOffset, notFound, parseOrder, parseSort } from '../lib/query.js';
import {
    ANSWER_STATUSES, MISSING_STATUS, WHAT_IF_SORTS,
    buildFailureModeSummarySql, buildIssuerRecordSql, buildIssuerWhatIfSql, buildWhatIfCountSql,
    buildWhatIfListSql, parseWhatIfFilters, summariseAnswerSheet
} from '../lib/whatif.js';
import { TRUST_CHAIN, buildChain } from '../../../stocks/lib/trustchain.mjs';

const routes = new Hono();
const LIST_OPTS = ['sort', 'order', 'limit', 'offset'];

/** `{actorId: label}` and `{flowId: label}` from the catalogue, so a row can name what it names. */
const ACTOR_LABELS = Object.fromEntries(TRUST_CHAIN.actors.map((a) => [a.id, a.label ?? null]));
const FLOW_LABELS = Object.fromEntries(TRUST_CHAIN.flows.map((f) => [f.id, f.label ?? null]));

/** What every response on this surface says about which catalogue it was answered against. */
const CATALOGUE = {
    version: TRUST_CHAIN.version ?? null,
    modes: TRUST_CHAIN.failureModes.length,
    actors: TRUST_CHAIN.actors.length,
    flows: TRUST_CHAIN.flows.length
};

/** The label pair a row gets for its actor and flow ids. A null means the catalogue moved on. */
function labels(row) {
    return {
        actor_label: ACTOR_LABELS[row.actor] ?? null,
        flow_label: FLOW_LABELS[row.flow] ?? null
    };
}

routes.get('/failure-modes', async (c) => {
    const summary = buildFailureModeSummarySql();
    const [modes, issuers] = await Promise.all([
        query(summary.text, summary.values),
        query('SELECT count(*)::int AS total FROM sonar.stock_issuer')
    ]);
    const total = issuers.rows[0].total;
    return c.json({
        count: modes.rows.length,
        issuers: total,
        catalogue: CATALOGUE,
        statuses: [...ANSWER_STATUSES, MISSING_STATUS],
        items: modes.rows.map((row) => ({
            ...row,
            ...labels(row),
            // `missing` is not stored — it is how many issuers have not answered this question.
            // Reported here because "which question can nobody answer" is what the route is for.
            missing: total - row.answered
        }))
    });
});

routes.get('/what-if', async (c) => {
    // c.req.queries() keeps every occurrence of a repeated parameter; c.req.query() would keep only
    // the last one, so `?status=a&status=b` would silently filter on `b` alone.
    const filters = parseWhatIfFilters(c.req.queries(), LIST_OPTS);
    const opts = {
        sort: parseSort(c.req.query('sort'), WHAT_IF_SORTS, 'mode'),
        order: parseOrder(c.req.query('order'), 'asc'),
        limit: clampLimit(c.req.query('limit'), { def: 100, max: 500 }),
        offset: clampOffset(c.req.query('offset'))
    };
    const countSql = buildWhatIfCountSql(filters);
    const listSql = buildWhatIfListSql(filters, opts);
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
        catalogue: CATALOGUE,
        filters,
        items: list.rows.map((row) => ({ ...row, ...labels(row) }))
    });
});

routes.get('/issuers/:slug/what-if', async (c) => {
    const slug = c.req.param('slug');
    const issuer = await query('SELECT slug, name FROM sonar.stock_issuer WHERE slug = $1', [slug]);
    if (issuer.rows.length === 0) throw notFound(`no issuer with slug "${slug}"`);
    const sheet = buildIssuerWhatIfSql(slug);
    const { rows } = await query(sheet.text, sheet.values);
    return c.json({
        slug,
        name: issuer.rows[0].name,
        // Always the whole catalogue, never only the answers: a question this issuer has not
        // answered comes back with `status: "missing"`, because the gap is the finding.
        count: rows.length,
        catalogue: CATALOGUE,
        summary: summariseAnswerSheet(rows),
        items: rows.map((row) => ({ ...row, ...labels(row) }))
    });
});

routes.get('/issuers/:slug/chain', async (c) => {
    const slug = c.req.param('slug');
    const sql = buildIssuerRecordSql(slug);
    const { rows } = await query(sql.text, sql.values);
    if (rows.length === 0) throw notFound(`no issuer with slug "${slug}"`);
    const { record, name, built_at: builtAt } = rows[0];
    // The record's own claims are passed in rather than re-derived. Re-deriving them from a BUILT
    // record works but counts its quote-bearing findings twice (once from the copied `claims[]`,
    // once from `findings[]` itself); the duplicates carry the same statuses so no grade would
    // move, which is exactly why it is worth being explicit instead of relying on that.
    const chain = buildChain(record, TRUST_CHAIN, { claims: record?.claims ?? null });
    return c.json({
        slug,
        name,
        catalogue: CATALOGUE,
        // When the record this chain was graded from was built — the row's own column, not a clock.
        builtAt,
        nodes: chain.nodes,
        links: chain.links
    });
});

export default routes;
