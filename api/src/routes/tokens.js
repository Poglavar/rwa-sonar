// GET /api/tokens, /api/tokens/:mint, /api/tokens/:mint/history, /api/tokens/:mint/trades —
// the token list with the same filters the facets use, one token's full researched record, its
// daily snapshot series and its slice of the trade tape.

import { Hono } from 'hono';

import { query } from '../db.js';
import { PUBLIC_CHANGE_CONDITION } from '../lib/evidence.js';
import { shapeRedemptionUsability } from '../../../stocks/lib/redemption-usability.mjs';
import { shapeAuthorityAttribution, summarizeAuthorityAttribution } from '../../../stocks/lib/authority-attribution.mjs';
import {
    buildTokenCountSql, buildTokenDetailSql, buildTokenHistorySql, buildTokenListSql,
    buildTradesSql, clampLimit, clampOffset, notFound, parseBefore, parseDays, parseFilters,
    parseOrder, parseSort
} from '../lib/query.js';

const routes = new Hono();
const LIST_OPTS = ['q', 'sort', 'order', 'limit', 'offset'];

function successfulRedemptionObserved(issuer) {
    return (Array.isArray(issuer?.claims) ? issuer.claims : []).some((claim) =>
        String(claim?.field ?? '').startsWith('redemption.')
        && (/transaction/.test(String(claim?.method ?? '').toLowerCase())
            || /observed (redemption|redeem)|transaction hash/.test(String(claim?.note ?? '').toLowerCase())));
}

function secondaryMarketAvailable(token) {
    const values = [token?.activity?.dexPairs, token?.activity?.cexMarkets, token?.market?.liquidity];
    const measured = values.some((value) => typeof value === 'number' && Number.isFinite(value));
    return values.some((value) => typeof value === 'number' && Number.isFinite(value) && value > 0)
        ? true : measured ? false : null;
}

routes.get('/tokens', async (c) => {
    const params = c.req.query();
    // queries(), not query(): every occurrence of a repeated parameter is a value (OR), and
    // query() would keep only the last one — silently filtering on one of the values asked for.
    const filters = parseFilters(c.req.queries(), LIST_OPTS);
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
    const issuerRecord = r.issuer_record && typeof r.issuer_record === 'object' ? r.issuer_record : null;
    const redemptionUsability = shapeRedemptionUsability({
        redemption: issuerRecord?.redemption,
        productSymbol: r.symbol,
        answerScope: 'product',
        operationalRouteAvailable: issuerRecord?.redemption?.operationalRouteAvailable,
        operationalRouteEvidence: issuerRecord?.redemption?.operationalEvidence,
        successfulRedemptionObserved: successfulRedemptionObserved(issuerRecord) ? true
            : typeof issuerRecord?.redemption?.successfulRedemptionObserved === 'boolean'
                ? issuerRecord.redemption.successfulRedemptionObserved : null,
        secondaryMarketAvailable: secondaryMarketAvailable(r.record),
        reviewStatus: { reviewedAt: issuerRecord?.evidence?.lastCheckedAt ?? null,
            pending: issuerRecord?.legalReview?.pending ?? null }
    });
    const authorityControl = summarizeAuthorityAttribution(shapeAuthorityAttribution({
        token: r.record,
        issuer: issuerRecord
    }));
    return c.json({
        mint: r.mint,
        symbol: r.symbol,
        name: r.name,
        healthStatus: r.health_status,
        worstRule: r.worst_rule,
        healthDimensions: {
            market: r.market_health,
            control: r.control_health,
            legal: r.legal_health,
            composability: r.composability_health
        },
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
        redemptionUsability,
        authorityControl,
        recordContext: {
            kind: 'raw-research-record',
            scope: 'exact-token',
            guidance: 'Use redemptionUsability for scoped holder answers; record preserves the underlying research data.'
        },
        record: r.record
    });
});

routes.get('/tokens/:mint/history', async (c) => {
    const mint = c.req.param('mint');
    const days = parseDays(c.req.query('days'));
    const sql = buildTokenHistorySql(mint, { days });
    const [history, events] = await Promise.all([
        query(sql.text, sql.values),
        query(`SELECT DISTINCT e.id, e.detected_at, e.kind, e.severity, e.subject_type,
                      e.subject_id, e.field, e.summary
                 FROM sonar.change_event e
                 LEFT JOIN sonar.stock_token t ON t.mint = $1
                WHERE ((e.subject_type = 'token' AND e.subject_id = $1)
                   OR (e.subject_type = 'issuer' AND e.subject_id = t.issuer_slug))
                  AND ${PUBLIC_CHANGE_CONDITION}
                ORDER BY e.detected_at ASC`, [mint])
    ]);
    return c.json({
        mint,
        days,
        count: history.rows.length,
        items: history.rows,
        events: events.rows
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
