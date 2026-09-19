import { overviewRows } from '../src/routes/history.js';

describe('overviewRows', () => {
    test('converts Postgres bigint strings and nests only the matching issuer counts', () => {
        const rows = overviewRows([{
            snapshot_date: '2026-09-19', token_count: 517, holder_accounts: '12000',
            holder_coverage: 500, volume24_usd: 123.5, volume_coverage: 480,
            liquidity_usd: 456.7
        }], [
            { snapshot_date: '2026-09-18', issuer: 'old', token_count: 1 },
            { snapshot_date: '2026-09-19', issuer: 'ondo', token_count: 262 },
            { snapshot_date: '2026-09-19', issuer: 'xstocks', token_count: 176 }
        ]);
        expect(rows).toEqual([expect.objectContaining({
            date: '2026-09-19', tokenCount: 517, holderAccounts: 12000,
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
            liquidity_usd: null
        }], []);
        expect(row).toMatchObject({
            holderAccounts: null,
            holderCoverage: 0,
            volume24Usd: null,
            volumeCoverage: 0,
            liquidityUsd: null
        });
    });
});
