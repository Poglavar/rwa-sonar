// GET /api/issuers and /api/issuers/:slug — the issuer dossiers. `mint_count` is the issuer's own
// researched figure; `tokens_in_db` is what the token table actually holds, and the two are
// reported separately because a disagreement between them is a finding, not a rounding error.

import { Hono } from 'hono';

import { query } from '../db.js';
import {
    ISSUER_SUMMARY_COLUMNS, SLIM_TOKEN_COLUMNS, TOKEN_FROM, createParams, notFound
} from '../lib/query.js';

const routes = new Hono();

routes.get('/issuers', async (c) => {
    const { rows } = await query(`SELECT ${ISSUER_SUMMARY_COLUMNS},
    (SELECT count(*)::int FROM sonar.stock_token t WHERE t.issuer_slug = i.slug)
        AS tokens_in_db,
    (SELECT count(*)::int FROM sonar.stock_token t
      WHERE t.issuer_slug = i.slug AND t.health_status = 'good')    AS health_good,
    (SELECT count(*)::int FROM sonar.stock_token t
      WHERE t.issuer_slug = i.slug AND t.health_status = 'caution') AS health_caution,
    (SELECT count(*)::int FROM sonar.stock_token t
      WHERE t.issuer_slug = i.slug AND t.health_status = 'warning') AS health_warning
  FROM sonar.stock_issuer i
  ORDER BY tokens_in_db DESC, i.slug ASC`);
    return c.json({ count: rows.length, items: rows });
});

routes.get('/issuers/:slug', async (c) => {
    const slug = c.req.param('slug');
    const params = createParams();
    const p = params.add(slug);
    const issuer = await query(
        `SELECT ${ISSUER_SUMMARY_COLUMNS}, i.record
  FROM sonar.stock_issuer i
  WHERE i.slug = ${p}`,
        params.values
    );
    if (issuer.rows.length === 0) throw notFound(`no issuer with slug "${slug}"`);

    const tokenParams = createParams();
    const tp = tokenParams.add(slug);
    const tokens = await query(
        `SELECT ${SLIM_TOKEN_COLUMNS}
  ${TOKEN_FROM}
  WHERE t.issuer_slug = ${tp}
  ORDER BY t.liquidity_usd DESC NULLS LAST, t.mint ASC`,
        tokenParams.values
    );

    const health = { good: 0, caution: 0, warning: 0 };
    for (const row of tokens.rows) {
        const key = row.health_status;
        if (key in health) health[key] += 1;
        else health[key ?? 'unknown'] = (health[key ?? 'unknown'] || 0) + 1;
    }

    const { record, ...summary } = issuer.rows[0];
    return c.json({
        ...summary,
        tokensInDb: tokens.rows.length,
        health,
        tokens: tokens.rows,
        record
    });
});

export default routes;
