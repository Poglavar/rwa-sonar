import {
    WATCH_FILTERS, createWatchCredentials, hashWatchKey, parseWatchPayload
} from '../src/lib/watchlists.js';

describe('watchlist ownership and validation', () => {
    test('credentials are unguessable and only a stable hash needs storing', () => {
        const first = createWatchCredentials();
        const second = createWatchCredentials();
        expect(first.watchId).toMatch(/^[0-9a-f-]{36}$/);
        expect(first.watchKey.length).toBeGreaterThanOrEqual(32);
        expect(first).not.toEqual(second);
        expect(hashWatchKey(first.watchKey)).toMatch(/^[0-9a-f]{64}$/);
        expect(hashWatchKey(first.watchKey)).toBe(hashWatchKey(first.watchKey));
    });

    test('normalises a bounded comparison and rejects invented decision filters', () => {
        expect(parseWatchPayload({
            ticker: ' nvda ', issuers: ['xstocks-backed', 'ondo-global-markets', 'xstocks-backed'],
            filters: ['confirmedCollateral'], title: ' My NVDA watch '
        })).toEqual({
            ticker: 'NVDA', issuers: ['ondo-global-markets', 'xstocks-backed'],
            filters: ['confirmedCollateral'], title: 'My NVDA watch'
        });
        expect(WATCH_FILTERS.has('confirmedCollateral')).toBe(true);
        expect(() => parseWatchPayload({
            ticker: 'NVDA', issuers: ['a', 'b'], filters: ['guaranteedProfit']
        })).toThrow('unknown watch filter');
    });

    test('supports a standalone watch and many wrappers, while rejecting no selection', () => {
        expect(parseWatchPayload({ ticker: 'NVDA', issuers: ['xstocks-backed'] }).issuers).toEqual(['xstocks-backed']);
        const issuers = Array.from({ length: 20 }, (_, index) => `issuer-${index}`);
        expect(parseWatchPayload({ ticker: 'AAPL', issuers }).issuers).toHaveLength(20);
        expect(() => parseWatchPayload({ ticker: 'NVDA', issuers: [] })).toThrow('1–100 issuer slugs');
    });
});
