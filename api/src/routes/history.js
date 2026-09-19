// GET /api/history/overview — one compact row per daily universe snapshot for the landing page.
// Counts describe what RWA Sonar observed, not issuance: a mint can first appear because an issuer
// added it, because a collector learned a new catalogue, or because an earlier fetch was incomplete.

import { Hono } from 'hono';

import { query } from '../db.js';

const routes = new Hono();

function number(value) {
    return value === null || value === undefined ? null : Number(value);
}

export function overviewRows(totals, issuers) {
    return totals.map((row) => ({
        date: row.snapshot_date,
        tokenCount: number(row.token_count),
        holderAccounts: number(row.holder_accounts),
        holderCoverage: number(row.holder_coverage),
        volume24Usd: number(row.volume24_usd),
        volumeCoverage: number(row.volume_coverage),
        liquidityUsd: number(row.liquidity_usd),
        issuerCounts: issuers
            .filter((issuer) => issuer.snapshot_date === row.snapshot_date)
            .map((issuer) => ({ issuer: issuer.issuer, tokenCount: number(issuer.token_count) }))
    }));
}

routes.get('/history/overview', async (c) => {
    const [totals, issuers] = await Promise.all([
        query(`SELECT snapshot_date,
    count(*)::int AS token_count,
    sum(holder_count)::bigint AS holder_accounts,
    count(holder_count)::int AS holder_coverage,
    sum(vol24)::double precision AS volume24_usd,
    count(vol24)::int AS volume_coverage,
    sum(liquidity)::double precision AS liquidity_usd
  FROM sonar.stock_token_snapshot
 GROUP BY snapshot_date
 ORDER BY snapshot_date ASC`),
        query(`SELECT snapshot_date, issuer, count(*)::int AS token_count
  FROM sonar.stock_token_snapshot
 GROUP BY snapshot_date, issuer
 ORDER BY snapshot_date ASC, issuer ASC`)
    ]);
    return c.json({
        methodology: {
            tokenCount: 'Exact Solana token addresses catalogued by RWA Sonar on that observation date; growth is discovery, not proof of same-day issuance.',
            holderAccounts: 'Sum of non-zero token accounts reported per mint; one wallet holding several tokens is counted several times and accounts are not people.',
            volume24Usd: 'Sum of each mint’s reported rolling 24-hour volume at snapshot time; coverage varies by date and source.',
            liquidityUsd: 'Sum of reported on-chain pool liquidity per mint at snapshot time; missing measurements are omitted, never treated as measured zero.'
        },
        items: overviewRows(totals.rows, issuers.rows)
    });
});

export default routes;
