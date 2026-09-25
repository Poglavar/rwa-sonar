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

    it('offers the OpenAI comparison when a reader searches for the company', () => {
        const PRE = { instrumentType: 'private-company', underlyingTicker: null };
        const tokens = [
            { ...PRE, symbol: 'OPENAI', name: 'OpenAI PreStocks', issuer: 'prestocks', companyKey: 'OPENAI', companyName: 'OpenAI', mint: 'Prewe' },
            { ...PRE, symbol: 'tOpenAI', name: 'T-OpenAI', issuer: 'tessera', companyKey: 'OPENAI', companyName: 'OpenAI', mint: 'oPAiA' }
        ];
        const issuers = [{ slug: 'prestocks', name: 'PreStocks' }, { slug: 'tessera', name: 'Tessera' }];
        const results = groupedSearchResults(tokens, issuers, [], 'OpenAI');
        expect(results.stocks).toHaveLength(1);
        expect(results.stocks[0].record).toMatchObject({ ticker: 'OPENAI', name: 'OpenAI', preIpo: true, issuerCount: 2 });
        expect(results.stocks[0].reason).toBe('Pre-IPO company name');
        expect(results.tokens.map((row) => row.record.symbol)).toEqual(['OPENAI', 'tOpenAI']);
        // A company matched only through one pre-IPO wrapper is still flagged by its whole group:
        // SpaceX has listed, so a search that happens to hit tSpaceX alone must not call it pre-IPO.
        const spacex = [
            { ...PRE, symbol: 'tSpaceX', name: 'T-SpaceX', issuer: 'tessera', companyKey: 'SPCX', companyName: 'SpaceX', mint: 'TSPX' },
            { symbol: 'SPCXx', name: 'SpaceX xStock', issuer: 'xstocks-backed', underlyingTicker: 'SPCX', mint: 'Xs3o' }
        ];
        const viaWrapper = groupedSearchResults(spacex, issuers, [], 'tSpaceX').stocks[0].record;
        expect(viaWrapper).toMatchObject({ ticker: 'SPCX', name: 'SpaceX', preIpo: false });
        // The stock directory shows it under its name, marked pre-IPO, linking to the comparison.
        const html = underlyingDirectoryHtml(underlyingGroups(tokens), new Map(issuers.map((row) => [row.slug, row])));
        expect(html).toContain('<span class="underlying-card-kicker">Pre-IPO · OPENAI</span>');
        expect(html).toContain('<strong>OpenAI</strong>');
        expect(html).toContain('view=compare&amp;compare=OPENAI');
    });
});
