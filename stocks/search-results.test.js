// Unit tests for stocks/lib/search-results.js: grouped global search results and the
// underlying-stock directory. Moved with the code out of stocks-page.test.js (next-steps.md F11),
// which still tests the page wiring that calls it.

const {
    underlyingGroups
} = require('./lib/discovery.js');
const {
    underlyingDirectoryHtml,
    groupedSearchResults
} = require('./lib/search-results.js');

describe('layperson discovery helpers', () => {
    it('groups search results by stock, exact token, issuer and protocol and explains every match', () => {
        const issuers = [{ slug: 'backed', name: 'Backed Finance', legalForm: 'SPV' }];
        const tokens = [{ symbol: 'NVDAx', name: 'NVIDIA xStock', underlyingTicker: 'NVDA', issuer: 'backed', mint: 'MintABC123' }];
        const protocols = [{ id: 'kamino', name: 'Kamino', actions: ['collateral', 'borrow'], categories: ['lending'], tokenCount: 1,
            assets: [{ symbol: 'NVDAx', mint: 'MintABC123', issuer: 'backed' }] }];
        const byAddress = groupedSearchResults(tokens, issuers, protocols, 'MintABC123');
        expect(byAddress.tokens[0].reason).toBe('Exact Solana token address');
        expect(byAddress.stocks[0].reason).toBe('Contains a matching token');
        const byProtocol = groupedSearchResults(tokens, issuers, protocols, 'Kamino collateral');
        expect(byProtocol.protocols).toHaveLength(1);
        expect(byProtocol.protocols[0].record.name).toBe('Kamino');
        expect(byProtocol.protocols[0].reason).toBe('Confirmed action: Collateral');
    });

    it('groups the whole catalogue by underlying before exposing exact token addresses', () => {
        const tokens = [
            { symbol: 'AAPLx', name: 'Apple xStock', underlyingTicker: 'AAPL', issuer: 'a', mint: 'one', market: { liquidity: 20 } },
            { symbol: 'AAPLon', name: 'Apple (Ondo Tokenized)', underlyingTicker: 'aapl', issuer: 'b', mint: 'two', market: { liquidity: 30 } },
            { symbol: 'TSLAx', name: 'Tesla xStock', underlyingTicker: 'TSLA', issuer: 'a', mint: 'three', market: { liquidity: 5 } }
        ];
        const groups = underlyingGroups(tokens);
        expect(groups.map((group) => group.ticker)).toEqual(['AAPL', 'TSLA']);
        expect(groups[0]).toMatchObject({ issuerCount: 2, tokenCount: 2, liquidityUsd: 50 });
        const html = underlyingDirectoryHtml(groups, new Map([['a', { name: 'Issuer A' }], ['b', { name: 'Issuer B' }]]));
        expect(html).toContain('Compare wrappers');
        expect(html).toContain('Open token');
        expect(html).toContain('view=compare&amp;compare=AAPL');
        expect(html).toContain('data-save-ticker="AAPL"');
        expect(underlyingDirectoryHtml(groups, new Map(), 48, new Set(['AAPL']))).toContain('Saved stock');
    });
});
