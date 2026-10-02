// Unit tests for stocks/lib/saved-items.js: saved stocks and issuers, the saved comparison snapshot
// and the since-last-visit summary. Moved with the code out of stocks-page.test.js (next-steps.md
// F11), which still tests the page wiring that calls it.

const {
    comparisonSnapshot,
    comparisonSnapshotChanges,
    hasSavedState,
    normalizeSavedItems,
    toggleSavedItem,
    personalJournalSummary
} = require('./lib/saved-items.js');

/**
 * Whether this browser holds anything the reader saved, which decides where stocks.html opens: a
 * returning reader continues "My briefing", a first-time visitor lands on "Find a stock".
 */
describe('hasSavedState', () => {
    const empty = { savedItems: normalizeSavedItems(null), comparisons: {}, serverWatches: {} };

    it('is false for a first-time visitor and for anything unreadable', () => {
        expect(hasSavedState(empty)).toBe(false);
        expect(hasSavedState()).toBe(false);
        expect(hasSavedState({ savedItems: null, comparisons: null, serverWatches: null })).toBe(false);
        expect(hasSavedState({ savedItems: 'AAPL', comparisons: [], serverWatches: 'x' })).toBe(false);
    });

    it('is true once the reader saved a stock, an issuer, a comparison or a cross-device watch', () => {
        expect(hasSavedState({ ...empty, savedItems: normalizeSavedItems({ tickers: ['aapl'] }) })).toBe(true);
        expect(hasSavedState({ ...empty, savedItems: normalizeSavedItems({ issuers: ['securitize'] }) })).toBe(true);
        expect(hasSavedState({ ...empty, comparisons: { AAPL: { ticker: 'AAPL', products: {} } } })).toBe(true);
        expect(hasSavedState({ ...empty, serverWatches: { AAPL: { watchId: 'w', watchKey: 'k' } } })).toBe(true);
    });
});

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
            expect.stringContaining('listing as collateral by a protocol disappeared'),
            expect.stringContaining('the protocols that list it changed'),
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
