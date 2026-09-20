// GET /api/history/overview — one compact row per daily universe snapshot for the landing page.
// Counts describe what RWA Sonar observed, not issuance: a mint can first appear because an issuer
// added it, because a collector learned a new catalogue, or because an earlier fetch was incomplete.

import { Hono } from 'hono';

import { query } from '../db.js';
import { badRequest, parseDays } from '../lib/query.js';

const routes = new Hono();

function number(value) {
    return value === null || value === undefined ? null : Number(value);
}

function healthCounts(row, prefix) {
    return {
        good: number(row[`${prefix}_good`]),
        caution: number(row[`${prefix}_caution`]),
        warning: number(row[`${prefix}_warning`]),
        unknown: number(row[`${prefix}_unknown`])
    };
}

export function overviewRows(totals, issuers) {
    return totals.map((row) => ({
        date: row.snapshot_date,
        tokenCount: number(row.token_count),
        activeTokenCount: number(row.active_coverage) === 0 ? null : number(row.active_token_count),
        activeCoverage: number(row.active_coverage),
        underlyingCount: number(row.underlying_coverage) === 0 ? null : number(row.underlying_count),
        underlyingCoverage: number(row.underlying_coverage),
        supplyUi: number(row.supply_ui),
        supplyCoverage: number(row.supply_coverage),
        holderAccounts: number(row.holder_accounts),
        holderCoverage: number(row.holder_coverage),
        volume24Usd: number(row.volume24_usd),
        volumeCoverage: number(row.volume_coverage),
        liquidityUsd: number(row.liquidity_usd),
        marketValueUsd: number(row.market_value_usd),
        marketValueCoverage: number(row.market_value_coverage),
        defiSupportedTokens: number(row.defi_coverage) === 0 ? null : number(row.defi_supported_tokens),
        defiIntegrations: number(row.defi_coverage) === 0 ? null : number(row.defi_integrations),
        defiCoverage: number(row.defi_coverage),
        health: {
            overall: healthCounts(row, 'overall'),
            market: healthCounts(row, 'market'),
            control: healthCounts(row, 'control'),
            legal: healthCounts(row, 'legal'),
            composability: healthCounts(row, 'composability')
        },
        issuerCounts: issuers
            .filter((issuer) => issuer.snapshot_date === row.snapshot_date)
            .map((issuer) => ({ issuer: issuer.issuer, tokenCount: number(issuer.token_count) }))
    }));
}

export function annotationRows(rows) {
    return rows.map((row) => ({
        date: row.snapshot_date,
        previousDate: row.previous_date,
        added: number(row.added),
        removed: number(row.removed)
    }));
}

routes.get('/history/overview', async (c) => {
    const [totals, issuers, annotations] = await Promise.all([
        query(`SELECT snapshot_date,
    count(*)::int AS token_count,
    count(*) FILTER (WHERE active IS TRUE)::int AS active_token_count,
    count(active)::int AS active_coverage,
    count(DISTINCT underlying_ticker) FILTER (WHERE underlying_ticker IS NOT NULL)::int AS underlying_count,
    count(underlying_ticker)::int AS underlying_coverage,
    sum(supply_ui)::double precision AS supply_ui,
    count(supply_ui)::int AS supply_coverage,
    sum(holder_count)::bigint AS holder_accounts,
    count(holder_count)::int AS holder_coverage,
    sum(vol24)::double precision AS volume24_usd,
    count(vol24)::int AS volume_coverage,
    sum(liquidity)::double precision AS liquidity_usd,
    sum(market_value_usd)::double precision AS market_value_usd,
    count(market_value_usd)::int AS market_value_coverage,
    count(*) FILTER (WHERE defi_integration_count > 0)::int AS defi_supported_tokens,
    sum(defi_integration_count)::int AS defi_integrations,
    count(defi_integration_count)::int AS defi_coverage,
    count(*) FILTER (WHERE health = 'good')::int AS overall_good,
    count(*) FILTER (WHERE health = 'caution')::int AS overall_caution,
    count(*) FILTER (WHERE health = 'warning')::int AS overall_warning,
    count(*) FILTER (WHERE health IS NULL OR health = 'unknown')::int AS overall_unknown,
    count(*) FILTER (WHERE market_health = 'good')::int AS market_good,
    count(*) FILTER (WHERE market_health = 'caution')::int AS market_caution,
    count(*) FILTER (WHERE market_health = 'warning')::int AS market_warning,
    count(*) FILTER (WHERE market_health IS NULL OR market_health = 'unknown')::int AS market_unknown,
    count(*) FILTER (WHERE control_health = 'good')::int AS control_good,
    count(*) FILTER (WHERE control_health = 'caution')::int AS control_caution,
    count(*) FILTER (WHERE control_health = 'warning')::int AS control_warning,
    count(*) FILTER (WHERE control_health IS NULL OR control_health = 'unknown')::int AS control_unknown,
    count(*) FILTER (WHERE legal_health = 'good')::int AS legal_good,
    count(*) FILTER (WHERE legal_health = 'caution')::int AS legal_caution,
    count(*) FILTER (WHERE legal_health = 'warning')::int AS legal_warning,
    count(*) FILTER (WHERE legal_health IS NULL OR legal_health = 'unknown')::int AS legal_unknown,
    count(*) FILTER (WHERE composability_health = 'good')::int AS composability_good,
    count(*) FILTER (WHERE composability_health = 'caution')::int AS composability_caution,
    count(*) FILTER (WHERE composability_health = 'warning')::int AS composability_warning,
    count(*) FILTER (WHERE composability_health IS NULL OR composability_health = 'unknown')::int AS composability_unknown
  FROM sonar.stock_token_snapshot
 GROUP BY snapshot_date
 ORDER BY snapshot_date ASC`),
        query(`SELECT snapshot_date, issuer, count(*)::int AS token_count
  FROM sonar.stock_token_snapshot
 GROUP BY snapshot_date, issuer
 ORDER BY snapshot_date ASC, issuer ASC`),
        query(`WITH dates AS (
    SELECT snapshot_date,
           lag(snapshot_date) OVER (ORDER BY snapshot_date) AS previous_date
      FROM (SELECT DISTINCT snapshot_date FROM sonar.stock_token_snapshot) d
)
SELECT d.snapshot_date, d.previous_date,
       (SELECT count(*)::int
          FROM sonar.stock_token_snapshot current_row
          LEFT JOIN sonar.stock_token_snapshot previous_row
            ON previous_row.snapshot_date = d.previous_date
           AND previous_row.mint = current_row.mint
         WHERE current_row.snapshot_date = d.snapshot_date
           AND previous_row.mint IS NULL) AS added,
       (SELECT count(*)::int
          FROM sonar.stock_token_snapshot previous_row
          LEFT JOIN sonar.stock_token_snapshot current_row
            ON current_row.snapshot_date = d.snapshot_date
           AND current_row.mint = previous_row.mint
         WHERE previous_row.snapshot_date = d.previous_date
           AND current_row.mint IS NULL) AS removed
  FROM dates d
 WHERE d.previous_date IS NOT NULL
 ORDER BY d.snapshot_date ASC`)
    ]);
    return c.json({
        methodology: {
            tokenCount: 'Exact Solana token addresses catalogued by RWA Sonar on that observation date; growth is discovery, not proof of same-day issuance.',
            activeTokenCount: 'Addresses whose issuer dossier was live and which were measured as unpaused or not pausable. Missing control data is not proof of activity.',
            supplyUi: 'Sum of displayed token units only where measured; unlike shares in one company, units across different products are not economically comparable.',
            holderAccounts: 'Sum of non-zero token accounts reported per mint; one wallet holding several tokens is counted several times and accounts are not people.',
            volume24Usd: 'Sum of each mint’s reported rolling 24-hour volume at snapshot time; coverage varies by date and source.',
            liquidityUsd: 'Sum of reported on-chain pool liquidity per mint at snapshot time; missing measurements are omitted, never treated as measured zero.',
            marketValueUsd: 'Sum of reported per-token market value where available; it is a source snapshot, not an audited amount of backing.',
            defiSupportedTokens: 'Tokens with at least one confirmed exact-address integration in a checked protocol registry on that day.'
        },
        items: overviewRows(totals.rows, issuers.rows),
        annotations: annotationRows(annotations.rows)
    });
});

routes.get('/history/underlyings/:ticker', async (c) => {
    const ticker = c.req.param('ticker').trim().toUpperCase();
    if (!/^[A-Z0-9.-]{1,16}$/.test(ticker)) throw badRequest('bad_ticker', 'ticker must contain 1–16 letters, digits, dots or hyphens');
    const days = parseDays(c.req.query('days'));
    const values = days === null ? [ticker] : [ticker, days];
    const since = days === null ? '' : 'AND s.snapshot_date >= (current_date - $2::int)';
    const [history, events] = await Promise.all([
        query(`SELECT s.snapshot_date, s.mint, COALESCE(s.symbol, t.symbol) AS symbol,
                      COALESCE(s.issuer, t.issuer_slug) AS issuer, s.supply_ui, s.market_value_usd,
                      s.liquidity, s.vol24, s.holder_count, s.premium_pct, s.health,
                      s.market_health, s.control_health, s.legal_health, s.composability_health
                 FROM sonar.stock_token_snapshot s
                 JOIN sonar.stock_token t ON t.mint = s.mint
                WHERE upper(COALESCE(s.underlying_ticker, t.underlying_ticker)) = $1 ${since}
                ORDER BY s.snapshot_date ASC, s.issuer ASC, s.mint ASC`, values),
        query(`WITH scope AS (
                    SELECT DISTINCT mint, issuer_slug FROM sonar.stock_token WHERE upper(underlying_ticker) = $1
                )
                SELECT DISTINCT e.id, e.detected_at, e.kind, e.severity, e.subject_type,
                       e.subject_id, e.field, e.summary
                  FROM sonar.change_event e
                 WHERE (e.subject_type = 'token' AND e.subject_id IN (SELECT mint FROM scope))
                    OR (e.subject_type = 'issuer' AND e.subject_id IN (SELECT issuer_slug FROM scope))
                 ORDER BY e.detected_at ASC`, [ticker])
    ]);
    return c.json({ ticker, days, count: history.rows.length, items: history.rows, events: events.rows });
});

export default routes;
