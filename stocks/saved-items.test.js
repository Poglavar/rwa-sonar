// Unit tests for stocks/lib/saved-items.js: saved stocks and issuers, the saved comparison snapshot
// and the since-last-visit summary. Moved with the code out of stocks-page.test.js (next-steps.md
// F11), which still tests the page wiring that calls it.

const {
    comparisonSnapshot,
    comparisonSnapshotChanges,
    normalizeSavedItems,
    toggleSavedItem,
    personalJournalSummary
} = require('./lib/saved-items.js');

describe('decision comparison and saved-watch helpers', () => {
    const issuer = {
        redemption: { available: true, eligibility: 'Available to non-US investors', rails: 'Cash settlement in USDC' },
        transferRestrictions: { usPersonsExcluded: true },
        bankruptcyRemote: true,
        grades: { claimRung: 3 },
        control: { freezeAuthority: 'none', pausable: 'none', clawback: 'none' },
        evidence: { lastCheckedAt: '2026-09-18T12:00:00Z' }
    };

    it('detects the material changes a saved comparison promises to watch', () => {
        const beforeModels = [{
            issuerSlug: 'a', decision: { cashRedemption: true, confirmedCollateral: true, autonomousLiquidation: false },
            outcome: { exitQuality: { rating: 'conditional' } }, protocols: ['Lend'], liquidityUsd: 100_000,
            review: { pending: false }
        }];
        const afterModels = [{
            ...beforeModels[0], decision: { ...beforeModels[0].decision, confirmedCollateral: false },
            protocols: [], liquidityUsd: 30_000
        }];
        const changes = comparisonSnapshotChanges(
            comparisonSnapshot('NVDA', beforeModels), comparisonSnapshot('NVDA', afterModels));
        expect(changes).toEqual(expect.arrayContaining([
            expect.stringContaining('source-listed collateral support disappeared'),
            expect.stringContaining('source-listed protocol set changed'),
            expect.stringContaining('liquidity fell more than 40%')
        ]));
    });

    it('normalizes and toggles local saved stocks and issuers without retaining invalid values', () => {
        const saved = normalizeSavedItems({ tickers: [' nvda ', 'NVDA', null], issuers: ['xstocks-backed', '', 4] });
        expect(saved).toEqual({ tickers: ['NVDA'], issuers: ['xstocks-backed'] });
        expect(toggleSavedItem(saved, 'ticker', 'aapl')).toEqual({ tickers: ['NVDA', 'AAPL'], issuers: ['xstocks-backed'] });
        expect(toggleSavedItem(saved, 'issuer', 'xstocks-backed')).toEqual({ tickers: ['NVDA'], issuers: [] });
        expect(saved).toEqual({ tickers: ['NVDA'], issuers: ['xstocks-backed'] });
    });

    it('builds an anonymous since-last-visit baseline and separates additions from protocol changes', () => {
        const rows = [
            { id: 'asset', date: '2026-09-22', kind: 'asset-added', title: 'Asset added', assets: [{}] },
            { id: 'defi', date: '2026-09-22', category: 'defi', kind: 'protocol-added', title: 'Protocol added' }
        ];
        const first = personalJournalSummary(rows, null);
        expect(first).toMatchObject({ firstVisit: true, unseen: [], newAssets: [rows[0]], protocolChanges: [rows[1]] });
        const next = personalJournalSummary(rows, { visitedAt: '2026-09-21T00:00:00Z', identities: ['asset'] });
        expect(next.firstVisit).toBe(false);
        expect(next.unseen).toEqual([rows[1]]);
        expect(next.previousVisitedAt).toBe('2026-09-21T00:00:00Z');
    });
});
