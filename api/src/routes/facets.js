// GET /api/facets — value counts per facet over the tokens matching the other filters. This is
// the route the static JSON files cannot answer: every combination of issuer × recipe × health ×
// legal form is a group-by, not a file.

import { Hono } from 'hono';

import { query } from '../db.js';
import { buildFacetSql, decorateFacetRows, parseFacetNames } from '../lib/facets.js';
import { buildTokenCountSql, parseFilters, splitList } from '../lib/query.js';

const routes = new Hono();

routes.get('/facets', async (c) => {
    const params = c.req.query();
    const facets = parseFacetNames(splitList(params.by));
    const q = params.q || null;
    const filters = parseFilters(params, ['by', 'q']);

    const totalSql = buildTokenCountSql(filters, { q });
    const [totalResult, ...facetResults] = await Promise.all([
        query(totalSql.text, totalSql.values),
        ...facets.map((name) => {
            const sql = buildFacetSql(filters, name, { q });
            return query(sql.text, sql.values);
        })
    ]);

    const out = {};
    facets.forEach((name, index) => {
        out[name] = decorateFacetRows(name, facetResults[index].rows);
    });
    return c.json({ total: totalResult.rows[0].total, filters, q, facets: out });
});

export default routes;
