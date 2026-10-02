// GET /api/litigation — the case-law watcher's record (stocks/watch-caselaw.mjs): court cases,
// RECAP dockets and SEC releases naming an issuer's legal entities or parties, caption matches
// first. With ?issuer= it also returns what was searched for that issuer and when, which is the
// evidence behind a what-if answer of `unknown`. Every item is a candidate for review; none is a
// `litigated` answer.

import { Hono } from 'hono';

import { query } from '../db.js';
import { clampLimit, clampOffset, parseOrder, parseSort } from '../lib/query.js';
import {
    LITIGATION_SORTS, buildLitigationCountSql, buildLitigationListSql, buildSearchedSql, parseLitigationFilters
} from '../lib/litigation.js';

const routes = new Hono();
const LIST_OPTS = ['sort', 'order', 'limit', 'offset'];
const NOTE = 'Candidates found by the case-law watcher, for review. None of these sets a what-if answer to'
    + ' `litigated`; that needs a dossier citing the decision.';

routes.get('/litigation', async (c) => {
    const filters = parseLitigationFilters(c.req.queries(), LIST_OPTS);
    const opts = {
        sort: parseSort(c.req.query('sort'), LITIGATION_SORTS, 'match'),
        order: parseOrder(c.req.query('order'), c.req.query('sort') && c.req.query('sort') !== 'match' ? 'desc' : 'asc'),
        limit: clampLimit(c.req.query('limit'), { def: 100, max: 500 }),
        offset: clampOffset(c.req.query('offset'))
    };
    const countSql = buildLitigationCountSql(filters);
    const listSql = buildLitigationListSql(filters, opts);
    const searchedSql = filters.issuer?.length ? buildSearchedSql(filters.issuer) : null;
    const [count, list, searched] = await Promise.all([
        query(countSql.text, countSql.values),
        query(listSql.text, listSql.values),
        searchedSql ? query(searchedSql.text, searchedSql.values) : null
    ]);
    return c.json({
        note: NOTE,
        total: count.rows[0].total,
        limit: opts.limit,
        offset: opts.offset,
        sort: opts.sort,
        order: opts.order,
        filters,
        items: list.rows,
        ...(searched ? { searched: searched.rows } : {})
    });
});

export default routes;
