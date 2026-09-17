// GET /api/health — row counts and the freshest timestamps in each table. Enough for a smoke
// test to tell "the API is up" from "the API is up and the loader has actually run".

import { Hono } from 'hono';

import { query } from '../db.js';

const routes = new Hono();

routes.get('/health', async (c) => {
    const { rows } = await query(`SELECT
    (SELECT count(*)::int FROM sonar.stock_issuer)          AS issuers,
    (SELECT count(*)::int FROM sonar.stock_token)           AS tokens,
    (SELECT count(*)::int FROM sonar.stock_token_snapshot)  AS snapshots,
    (SELECT count(*)::int FROM sonar.stock_trade)           AS trades,
    (SELECT max(snapshot_date) FROM sonar.stock_token_snapshot) AS latest_snapshot_date,
    (SELECT max("time") FROM sonar.stock_trade)             AS latest_trade_at,
    (SELECT max(built_at) FROM sonar.stock_token)           AS latest_build_at`);
    const r = rows[0];
    return c.json({
        ok: true,
        now: new Date().toISOString(),
        counts: {
            issuers: r.issuers,
            tokens: r.tokens,
            snapshots: r.snapshots,
            trades: r.trades
        },
        latestSnapshotDate: r.latest_snapshot_date,
        latestTradeAt: r.latest_trade_at,
        latestBuildAt: r.latest_build_at
    });
});

export default routes;
