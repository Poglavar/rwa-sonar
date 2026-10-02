// Tests the landing page's search-as-you-type (stocks/lib/quick-search.js): one /api/search answer
// shaped into underlying stocks, exact tokens and issuers, each with the link it opens.
const { quickSearchGroups } = require('./lib/quick-search.js');

const RESPONSE = {
    q: 'aapl',
    tokens: [
        { mint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', symbol: 'AAPLx', name: 'Apple xStock', card_slug: 'AAPLx', issuer_slug: 'xstocks-backed', issuer_name: 'Kraken xStocks', underlying_ticker: 'AAPL' },
        { mint: '123Apple0nd0Mint11111111111111111111111111', symbol: 'AAPLon', name: 'Apple (Ondo)', card_slug: null, issuer_slug: 'ondo-global-markets', issuer_name: 'Ondo Global Markets', underlying_ticker: 'AAPL' },
        { mint: 'AAPLLeveraged11111111111111111111111111111', symbol: 'AAPL2L', name: 'Apple 2x', card_slug: 'AAPL2L', issuer_slug: 'shift', issuer_name: null, underlying_ticker: 'AAPLL' },
        { mint: null, symbol: 'BROKEN' }
    ],
    issuers: [{ slug: 'ondo-global-markets', name: 'Ondo Global Markets', legal_form: 'structured-note' }, { slug: '' }]
};

describe('quickSearchGroups', () => {
    const groups = quickSearchGroups(RESPONSE, ' AAPL ');

    it('groups tokens by the stock they track, the exact ticker first, and opens the comparison when several issuers wrap it', () => {
        expect(groups.stocks.map((s) => s.label)).toEqual(['AAPL', 'AAPLL']);
        expect(groups.stocks[0]).toEqual({ label: 'AAPL', detail: '2 wrappers · 2 tokens found', href: './stocks.html?view=compare&compare=AAPL' });
        // One wrapper: straight to that token's card.
        expect(groups.stocks[1].href).toBe('./cards/AAPL2L.html');
        expect(groups.stocks[1].detail).toBe('1 wrapper · 1 token found');
    });

    it('lists exact tokens in the API order with the stock and issuer, linking the card', () => {
        expect(groups.tokens.map((t) => t.label)).toEqual(['AAPLx', 'AAPLon', 'AAPL2L']);
        expect(groups.tokens[0]).toEqual({ label: 'AAPLx', detail: 'AAPL · Kraken xStocks', href: './cards/AAPLx.html' });
        // No card slug in the row: the site's slug rule decides it; no issuer name: its slug.
        expect(groups.tokens[1].href).toBe('./cards/AAPLon.html');
        expect(groups.tokens[2].detail).toBe('AAPLL · shift');
    });

    it('links issuers to their dossiers and skips rows without an identity', () => {
        expect(groups.issuers).toEqual([{ label: 'Ondo Global Markets', detail: 'structured note', href: './issuers/ondo-global-markets.html' }]);
        expect(groups.tokens.some((t) => t.label === 'BROKEN')).toBe(false);
    });

    it('offers a stock only when its own ticker matches, not a token found by its name', () => {
        const ondo = quickSearchGroups({
            tokens: [{ mint: 'SLVonMint1111111111111111111111111111111111', symbol: 'SLVon', name: 'iShares Silver Trust (Ondo Tokenized)', issuer_slug: 'ondo-global-markets', underlying_ticker: 'SLV' }],
            issuers: [{ slug: 'ondo-global-markets', name: 'Ondo Global Markets' }]
        }, 'ondo');
        expect(ondo.stocks).toEqual([]);
        expect(ondo.tokens.map((t) => t.label)).toEqual(['SLVon']);
    });

    it('shows issuers first when an issuer is what was typed, else stocks first', () => {
        expect(quickSearchGroups({ issuers: [{ slug: 'ondo-global-markets', name: 'Ondo Global Markets' }] }, 'Ondo').order).toEqual(['issuers', 'stocks', 'tokens']);
        expect(groups.order).toEqual(['stocks', 'tokens', 'issuers']);
    });

    it('points "every result" at the catalogue search for the trimmed query', () => {
        expect(groups.allHref).toBe('./stocks.html?view=assets&search=AAPL');
    });

    it('keeps to the limits and survives an empty or malformed answer', () => {
        const limited = quickSearchGroups(RESPONSE, 'aapl', { stocks: 1, tokens: 2, issuers: 0 });
        expect([limited.stocks.length, limited.tokens.length, limited.issuers.length]).toEqual([1, 2, 0]);
        expect(quickSearchGroups(null, 'x')).toEqual({ order: ['stocks', 'tokens', 'issuers'], stocks: [], tokens: [], issuers: [], allHref: './stocks.html?view=assets&search=x' });
    });
});
