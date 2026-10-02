import { annotationRows, overviewRows } from '../src/routes/history.js';
import { app } from '../src/app.js';

describe('overviewRows', () => {
    test('converts Postgres bigint strings and nests only the matching issuer counts', () => {
        const rows = overviewRows([{
            snapshot_date: '2026-09-19', token_count: 517, holder_accounts: '12000',
            holder_coverage: 500, volume24_usd: 123.5, volume_coverage: 480,
            liquidity_usd: 456.7, active_token_count: 500, active_coverage: 517,
            underlying_count: 190, underlying_coverage: 510, supply_ui: 1234,
            supply_coverage: 500, market_value_usd: 999, market_value_coverage: 450,
            defi_supported_tokens: 118, defi_integrations: 155, defi_coverage: 517,
            overall_good: 1, overall_caution: 2, overall_warning: 3, overall_unknown: 4
        }], [
            { snapshot_date: '2026-09-18', issuer: 'old', token_count: 1 },
            { snapshot_date: '2026-09-19', issuer: 'ondo', token_count: 262 },
            { snapshot_date: '2026-09-19', issuer: 'xstocks', token_count: 176 }
        ]);
        expect(rows).toEqual([expect.objectContaining({
            date: '2026-09-19', tokenCount: 517, holderAccounts: 12000,
            activeTokenCount: 500, underlyingCount: 190, defiSupportedTokens: 118,
            health: expect.objectContaining({
                overall: { good: 1, caution: 2, warning: 3, unknown: 4 }
            }),
            issuerCounts: [
                { issuer: 'ondo', tokenCount: 262 },
                { issuer: 'xstocks', tokenCount: 176 }
            ]
        })]);
    });

    test('keeps an entirely unmeasured aggregate missing instead of turning it into zero', () => {
        const [row] = overviewRows([{
            snapshot_date: '2026-09-19', token_count: 517, holder_accounts: null,
            holder_coverage: 0, volume24_usd: null, volume_coverage: 0,
            liquidity_usd: null, active_token_count: 0, active_coverage: 0,
            underlying_count: 0, underlying_coverage: 0, supply_ui: null, supply_coverage: 0,
            market_value_usd: null, market_value_coverage: 0, defi_supported_tokens: 0,
            defi_integrations: null, defi_coverage: 0
        }], []);
        expect(row).toMatchObject({
            holderAccounts: null,
            holderCoverage: 0,
            volume24Usd: null,
            volumeCoverage: 0,
            liquidityUsd: null
        });
        expect(row.activeTokenCount).toBeNull();
        expect(row.defiSupportedTokens).toBeNull();
    });

    test('shapes consecutive-day catalogue annotations without inventing dates', () => {
        expect(annotationRows([{
            snapshot_date: '2026-09-19', previous_date: '2026-09-18', added: '37', removed: 1
        }])).toEqual([{ date: '2026-09-19', previousDate: '2026-09-18', added: 37, removed: 1 }]);
    });
});

describe('underlying history input', () => {
    test('rejects an unbounded or malformed ticker before querying the database', async () => {
        const response = await app.request('/api/history/underlyings/NOT_A_VALID_TICKER_NAME');
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: 'bad_ticker' } });
    });
});
