import {
    WATCH_FILTERS, WATCH_TYPES, createWatchCredentials, hashWatchKey, parseWatchPayload
} from '../src/lib/watchlists.js';

describe('watchlist ownership and validation', () => {
    test('credentials are unguessable and only a stable hash needs storing', () => {
        const first = createWatchCredentials();
        const second = createWatchCredentials();
        expect(first.watchId).toMatch(/^[0-9a-f-]{36}$/);
        expect(first.watchKey.length).toBeGreaterThanOrEqual(32);
        expect(first.readKey.length).toBeGreaterThanOrEqual(32);
        expect(first.readKey).not.toBe(first.watchKey);
        expect(first).not.toEqual(second);
        expect(hashWatchKey(first.watchKey)).toMatch(/^[0-9a-f]{64}$/);
        expect(hashWatchKey(first.watchKey)).toBe(hashWatchKey(first.watchKey));
    });

    test('normalises a bounded comparison and rejects invented decision filters', () => {
        expect(parseWatchPayload({
            ticker: ' nvda ', issuers: ['xstocks-backed', 'ondo-global-markets', 'xstocks-backed'],
            filters: ['confirmedCollateral'], title: ' My NVDA watch '
        })).toEqual({
            type: 'comparison', target: { ticker: 'NVDA', issuers: ['ondo-global-markets', 'xstocks-backed'] },
            ticker: 'NVDA', issuers: ['ondo-global-markets', 'xstocks-backed'], filters: ['confirmedCollateral'],
            title: 'My NVDA watch', digest: { enabled: false, hour: 6, timezone: 'UTC' }
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

    test('normalises focused targets and keeps personal delivery disabled until it is privately bound', () => {
        const mint = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
        expect(WATCH_TYPES).toEqual(new Set(['comparison', 'token', 'issuer', 'protocol-market']));
        expect(parseWatchPayload({ type: 'token', target: { mint }, digest: {
            enabled: false, hour: 7, timezone: 'Europe/Paris'
        } })).toMatchObject({ type: 'token', target: { mint }, ticker: null, issuers: [],
            digest: { enabled: false, hour: 7, timezone: 'Europe/Paris' } });
        expect(() => parseWatchPayload({ type: 'token', target: { mint }, digest: {
            enabled: true, hour: 7, timezone: 'Europe/Paris'
        } })).toThrow('verified private delivery channel');
        expect(parseWatchPayload({ type: 'issuer', target: { issuerSlug: 'xstocks-backed' } }))
            .toMatchObject({ type: 'issuer', target: { issuerSlug: 'xstocks-backed' } });
        expect(parseWatchPayload({ type: 'protocol-market', target: {
            mint, integrationId: 'kamino:collateral', marketKey: '5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua'
        } })).toMatchObject({ type: 'protocol-market', target: {
            mint, integrationId: 'kamino:collateral', marketKey: '5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua'
        } });
        expect(() => parseWatchPayload({ type: 'token', target: { mint: 'not-a-mint' } })).toThrow('exact Solana mint');
        expect(() => parseWatchPayload({ type: 'issuer', target: { issuerSlug: 'Bad Slug' } })).toThrow('issuer slug');
        expect(() => parseWatchPayload({ type: 'token', target: { mint }, digest: {
            enabled: false, hour: 24, timezone: 'UTC'
        } })).toThrow('integer from 0 to 23');
    });
});
