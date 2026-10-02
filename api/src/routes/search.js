// GET /api/search?q= — one box over both tables: up to 20 slim token rows (symbol, name, mint or
// underlying ticker) and up to 5 issuers (slug or name). Deliberately small; /api/tokens?q= is
// the paginated version.

import { Hono } from 'hono';

import { query } from '../db.js';
import {
    ISSUER_SUMMARY_COLUMNS, SLIM_TOKEN_COLUMNS, TOKEN_FROM, badRequest, createParams,
    likePattern
} from '../lib/query.js';

const TOKEN_LIMIT = 20;
const ISSUER_LIMIT = 5;

const routes = new Hono();

routes.get('/search', async (c) => {
    const q = (c.req.query('q') || '').trim();
    if (q.length === 0) throw badRequest('missing_q', 'q is required and must not be empty');

    const tokenParams = createParams();
    const tp = tokenParams.add(likePattern(q));
    const issuerParams = createParams();
    const ip = issuerParams.add(likePattern(q));

    const [tokens, issuers] = await Promise.all([
        query(
            `SELECT ${SLIM_TOKEN_COLUMNS}
  ${TOKEN_FROM}
  WHERE t.symbol ILIKE ${tp} OR t.name ILIKE ${tp} OR t.mint ILIKE ${tp}
     OR t.underlying_ticker ILIKE ${tp}
  ORDER BY (lower(t.symbol) = lower(${tokenParams.add(q)})) DESC,
           t.liquidity_usd DESC NULLS LAST, t.mint ASC
  LIMIT ${TOKEN_LIMIT}`,
            tokenParams.values
        ),
        query(
            `SELECT ${ISSUER_SUMMARY_COLUMNS}
  FROM sonar.stock_issuer i
  WHERE i.slug ILIKE ${ip} OR i.name ILIKE ${ip}
  ORDER BY i.mint_count DESC NULLS LAST, i.slug ASC
  LIMIT ${ISSUER_LIMIT}`,
            issuerParams.values
        )
    ]);

    return c.json({ q, tokens: tokens.rows, issuers: issuers.rows });
});

export default routes;
