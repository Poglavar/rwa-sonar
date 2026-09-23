// Unit tests for stocks/lib/token-view.js: token filtering, the token view state in the URL, paging
// and the list API's parameters and rows, and the data-state block. Moved with the code out of
// stocks-page.test.js (next-steps.md F11), which still tests the page wiring that calls it.

const {
    tokenMatchesQuery,
    filterTokens,
    TOKEN_PAGE_SIZE,
    TOKEN_COLUMN_PRESETS,
    tokenPageMath,
    tokenApiParams,
    tokenViewStateFromUrl,
    tokenViewStateParams,
    dataStateHtml,
    tokenFromApiRow
} = require('./lib/token-view.js');

describe('token filtering', () => {
    const tokens = [
        { symbol: 'TSLAx', name: 'Tesla xStock', issuer: 'xstocks-backed', underlyingTicker: 'TSLA', instrumentType: 'stock' },
        { symbol: 'SPYx', name: 'SP500 xStock', issuer: 'xstocks-backed', underlyingTicker: 'SPY', instrumentType: 'etf' },
        { symbol: 'GLXY', name: 'Galaxy Digital Class A', issuer: 'superstate-opening-bell', underlyingTicker: 'GLXY', instrumentType: 'stock' },
        { symbol: 'tOpenAI', name: 'Tessera OpenAI', issuer: 'tessera', underlyingTicker: null, instrumentType: 'private-company' }
    ];

    it('matches a query against symbol, name and underlying ticker', () => {
        expect(tokenMatchesQuery(tokens[0], 'tsla')).toBe(true);
        expect(tokenMatchesQuery(tokens[0], 'xstock')).toBe(true);
        expect(tokenMatchesQuery(tokens[0], 'SPY')).toBe(false);
        expect(tokenMatchesQuery(tokens[3], 'openai')).toBe(true);
    });

    it('matches everything on an empty query and survives a null ticker', () => {
        expect(tokenMatchesQuery(tokens[3], '')).toBe(true);
        expect(tokenMatchesQuery(tokens[3], '   ')).toBe(true);
        expect(tokenMatchesQuery(tokens[3], null)).toBe(true);
    });

    it('combines the issuer, instrument and search filters', () => {
        expect(filterTokens(tokens, { issuer: 'xstocks-backed' }).map((t) => t.symbol))
            .toEqual(['TSLAx', 'SPYx']);
        expect(filterTokens(tokens, { instrumentType: 'stock' }).map((t) => t.symbol))
            .toEqual(['TSLAx', 'GLXY']);
        expect(filterTokens(tokens, { issuer: 'xstocks-backed', instrumentType: 'etf' }).map((t) => t.symbol))
            .toEqual(['SPYx']);
        expect(filterTokens(tokens, { query: 'galaxy' }).map((t) => t.symbol)).toEqual(['GLXY']);
        expect(filterTokens(tokens, {})).toHaveLength(4);
        expect(filterTokens(null, {})).toEqual([]);
    });
});

describe('API-backed token paging', () => {
    it('turns a page into a bounded API request with the selected filters and sort', () => {
        expect(tokenApiParams(
            { issuer: 'xstocks-backed', instrumentType: 'stock', query: ' nvda ' },
            { key: 'trades24', ascending: false },
            3
        )).toEqual({
            issuer: 'xstocks-backed', instrument: 'stock', q: 'nvda', sort: 'trades24',
            order: 'desc', limit: TOKEN_PAGE_SIZE, offset: TOKEN_PAGE_SIZE * 2
        });
    });

    it('clamps the last page and reports its visible range', () => {
        expect(tokenPageMath(121, 9)).toEqual({
            page: 3, pages: 3, offset: 100, from: 101, to: 121, total: 121,
            hasPrev: true, hasNext: false
        });
    });

    it('adapts the API row without turning absent values into zero', () => {
        const token = tokenFromApiRow({
            mint: 'M', issuer_slug: 'issuer', usd_price: 12.5, trades24: 4,
            reference_source: 'pyth', clawback: true, top10_holder_pct: null
        });
        expect(token).toMatchObject({
            mint: 'M', issuer: 'issuer', market: { usdPrice: 12.5, top10HolderPct: null },
            activity: { trades24: 4 }, reference: { source: 'pyth' }, control: { clawback: true }
        });
        expect(token.market.liquidity).toBeNull();
    });

    it('round-trips filters, sort, page and a column preset through a shareable URL', () => {
        const state = tokenViewStateFromUrl('https://rwasonar.com/stocks.html?tokenIssuer=xstocks-backed&tokenInstrument=stock&tokenQuery=nvda&columns=defi&tokenSort=holders&tokenOrder=asc&tokenPage=3');
        expect(state).toEqual({
            filters: { issuer: 'xstocks-backed', instrumentType: 'stock', query: 'nvda' },
            searchQuery: 'nvda',
            preset: 'defi', sort: { key: 'holders', ascending: true }, page: 3
        });
        expect(tokenViewStateParams(state).toString()).toBe('tokenIssuer=xstocks-backed&tokenInstrument=stock&tokenQuery=nvda&columns=defi&tokenSort=holders&tokenOrder=asc&tokenPage=3');
        expect(TOKEN_COLUMN_PRESETS.overview).toHaveLength(6);
        expect(TOKEN_COLUMN_PRESETS).toMatchObject({ legal: expect.any(Array), market: expect.any(Array), control: expect.any(Array), defi: expect.any(Array) });
    });

    it('falls back to the decision overview when URL state is invalid', () => {
        expect(tokenViewStateFromUrl('?columns=surprise&tokenSort=nope&tokenPage=-2')).toMatchObject({
            preset: 'overview', sort: { key: 'liquidity', ascending: false }, page: 1
        });
    });

    it('preserves a natural-language capability query separately from the API identity terms', () => {
        const params = tokenViewStateParams({
            filters: { issuer: '', instrumentType: '', query: 'nvidia' },
            searchQuery: 'tokenized NVIDIA usable as collateral',
            preset: 'overview', sort: { key: 'liquidity', ascending: false }, page: 1
        });
        const restored = tokenViewStateFromUrl(`?${params}`);
        expect(restored.filters.query).toBe('nvidia');
        expect(restored.searchQuery).toBe('tokenized NVIDIA usable as collateral');
    });
});

describe('layperson discovery helpers', () => {
    it('renders failures, empty results and absent confirmations as distinct actionable states', () => {
        expect(dataStateHtml('failed', 'API failed', 'Not a zero', [{ label: 'Retry', action: 'retry-token-table' }]))
            .toContain('data-state-failed');
        expect(dataStateHtml('none-confirmed', 'No support', 'Coverage checked')).toContain('data-state-none-confirmed');
        expect(dataStateHtml('filtered-empty', 'No match', 'Clear it', [{ label: 'Clear', action: 'clear-search' }]))
            .toContain('data-state-action="clear-search"');
        expect(dataStateHtml('unknown-kind', '<unsafe>', '<script>')).not.toContain('<script>');
    });
});

describe('workspaceViewFromUrl', () => {
    const { workspaceViewFromUrl, WORKSPACE_VIEWS } = require('./lib/token-view.js');
    const at = (query) => workspaceViewFromUrl(`https://rwasonar.com/stocks.html${query}`);

    it('opens the view the URL names, and the overview for anything else', () => {
        for (const view of WORKSPACE_VIEWS) expect(at(`?view=${view}`)).toBe(view);
        expect(at('')).toBe('overview');
        expect(at('?view=nonsense')).toBe('overview');
    });

    it('still honours the old section anchors and a bare comparison link', () => {
        expect(at('#tokensSection')).toBe('assets');
        expect(at('#composabilitySection')).toBe('defi');
        expect(at('?compare=NVDA')).toBe('compare');
        // An explicit view wins over both.
        expect(at('?view=issuers&compare=NVDA#tokensSection')).toBe('issuers');
    });
});
