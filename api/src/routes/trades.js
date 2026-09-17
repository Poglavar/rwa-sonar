// GET /api/trades/recent and /api/trades/daily — the trade tape from sonar.stock_trade, which
// unlike stocks-trades.json keeps accumulating past the rolling 24 h window, so "yesterday" is a
// question this route can answer and the file cannot.

import { Hono } from 'hono';

import { query } from '../db.js';
import { buildDailyTradesSql, buildTradesSql, clampLimit, parseBefore, parseDays } from '../lib/query.js';

const routes = new Hono();

routes.get('/trades/recent', async (c) => {
    const limit = clampLimit(c.req.query('limit'), { def: 50, max: 500 });
    const before = parseBefore(c.req.query('before'));
    const sql = buildTradesSql({ limit, before });
    const { rows } = await query(sql.text, sql.values);
    const last = rows[rows.length - 1];
    return c.json({
        limit,
        count: rows.length,
        nextBefore: rows.length === limit && last
            ? `${new Date(last.time).toISOString()},${last.sig}`
            : null,
        items: rows
    });
});

routes.get('/trades/daily', async (c) => {
    const days = parseDays(c.req.query('days')) ?? 30;
    const sql = buildDailyTradesSql({ days });
    const { rows } = await query(sql.text, sql.values);
    return c.json({
        days,
        count: rows.length,
        items: rows
    });
});

export default routes;
