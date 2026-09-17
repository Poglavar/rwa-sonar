// GET /api/tokens, /api/tokens/:mint, /api/tokens/:mint/history, /api/tokens/:mint/trades —
// the token list with the same filters the facets use, one token's full researched record, its
// daily snapshot series and its slice of the trade tape.

import { Hono } from 'hono';

import { query } from '../db.js';
import {
    buildTokenCountSql, buildTokenDetailSql, buildTokenHistorySql, buildTokenListSql,
    buildTradesSql, clampLimit, clampOffset, notFound, parseBefore, parseDays, parseFilters,
    parseOrder, parseSort
} from '../lib/query.js';

const routes = new Hono();
const LIST_OPTS = ['q', 'sort', 'order', 'limit', 'offset'];

routes.get('/tokens', async (c) => {
    const params = c.req.query();
    const filters = parseFilters(params, LIST_OPTS);
    const q = params.q || null;
    const opts = {
        q,
        sort: parseSort(params.sort),
        order: parseOrder(params.order),
        limit: clampLimit(params.limit),
        offset: clampOffset(params.offset)
    };
    const countSql = buildTokenCountSql(filters, { q });
    const listSql = buildTokenListSql(filters, opts);
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
        q,
        items: list.rows
    });
});

routes.get('/tokens/:mint', async (c) => {
    const mint = c.req.param('mint');
    const sql = buildTokenDetailSql(mint);
    const { rows } = await query(sql.text, sql.values);
    if (rows.length === 0) throw notFound(`no token with mint "${mint}"`);
    const r = rows[0];
    return c.json({
        mint: r.mint,
        symbol: r.symbol,
        name: r.name,
        healthStatus: r.health_status,
        worstRule: r.worst_rule,
        builtAt: r.built_at,
        firstSeenAt: r.first_seen_at,
        lastSeenAt: r.last_seen_at,
        // The issuer's slim summary; `slug` is null when a mint's issuer row is missing, which
        // the LEFT JOIN keeps visible instead of hiding the token.
        issuer: r.issuer_slug === null ? null : {
            slug: r.issuer_slug,
            name: r.issuer_name,
            status: r.issuer_status,
            legalForm: r.legal_form,
            claimRung: r.claim_rung,
            claimLabel: r.claim_label,
            holderClaim: r.holder_claim,
            maturityStage: r.maturity_stage,
            maturityScore: r.maturity_score,
            verificationStrength: r.verification_strength,
            verificationType: r.verification_type
        },
        snapshotDates: r.snapshot_dates,
        tradesInDb: r.trades_in_db,
        record: r.record
    });
});

routes.get('/tokens/:mint/history', async (c) => {
    const mint = c.req.param('mint');
    const days = parseDays(c.req.query('days'));
    const sql = buildTokenHistorySql(mint, { days });
    const { rows } = await query(sql.text, sql.values);
    return c.json({
        mint,
        days,
        count: rows.length,
        items: rows
    });
});

routes.get('/tokens/:mint/trades', async (c) => {
    const mint = c.req.param('mint');
    const limit = clampLimit(c.req.query('limit'), { def: 50, max: 500 });
    const before = parseBefore(c.req.query('before'));
    const sql = buildTradesSql({ mint, limit, before });
    const { rows } = await query(sql.text, sql.values);
    const last = rows[rows.length - 1];
    return c.json({
        mint,
        limit,
        count: rows.length,
        // Hand back the cursor for the next page rather than making the client assemble it.
        nextBefore: rows.length === limit && last
            ? `${new Date(last.time).toISOString()},${last.sig}`
            : null,
        items: rows
    });
});

export default routes;
