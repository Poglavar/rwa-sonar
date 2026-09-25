// Unit tests for the grouping in stocks/lib/discovery.js that puts pre-IPO tokens beside each
// other: a token is compared under its listed ticker, else the company it references (companyKey,
// stamped by build-stocks-db.mjs from lib/private-companies.mjs).
const {
    comparisonKey, comparisonKeyAliases, globalSearch, sameUnderlyingGroups, underlyingGroups
} = require('./lib/discovery.js');
const { comparisonTickerFromParams } = require('./lib/comparison-shape.js');

// The catalogue's own identities on 2026-09-23 (market numbers trimmed to what grouping reads).
const PRE = { instrumentType: 'private-company', underlyingTicker: null };
const tokens = [
    { ...PRE, mint: 'Prewe', symbol: 'OPENAI', name: 'OpenAI PreStocks', issuer: 'prestocks', companyKey: 'OPENAI', companyName: 'OpenAI', market: { liquidity: 822306 } },
    { ...PRE, mint: 'oPAiA', symbol: 'tOpenAI', name: 'T-OpenAI', issuer: 'tessera', companyKey: 'OPENAI', companyName: 'OpenAI', market: { liquidity: 390511 } },
    { ...PRE, mint: 'PreAN', symbol: 'SPACEX', name: 'SpaceX PreStocks', issuer: 'prestocks', companyKey: 'SPCX', companyName: 'SpaceX', market: { liquidity: 113298 } },
    { ...PRE, mint: 'TSPXc', symbol: 'tSpaceX', name: 'T-SpaceX', issuer: 'tessera', companyKey: 'SPCX', companyName: 'SpaceX', market: { liquidity: 103183 } },
    { ...PRE, mint: 'Pren1', symbol: 'ANTHROPIC', name: 'Anthropic PreStocks', issuer: 'prestocks', companyKey: 'ANTHROPIC', companyName: 'Anthropic' },
    { mint: 'SPCXx', symbol: 'SPCX', name: 'SpaceX - Backpack Securities', issuer: 'backpack-securities', underlyingTicker: 'SPCX', instrumentType: 'stock', market: { liquidity: 969027 } },
    { mint: 'Xs3oZ', symbol: 'SPCXx', name: 'SpaceX xStock', issuer: 'xstocks-backed', underlyingTicker: 'SPCX', instrumentType: 'stock' },
    { mint: 'ZmHxc', symbol: 'FIGRon', name: 'Figure Technology Solutions (Ondo Tokenized)', issuer: 'ondo-global-markets', underlyingTicker: 'FIGR', instrumentType: 'stock' },
    // A pre-IPO token the company table does not name stays out of every group.
    { ...PRE, mint: 'PreXX', symbol: 'XAI', name: 'xAI PreStocks', issuer: 'prestocks', companyKey: null, companyName: null }
];

describe('pre-IPO tokens compared by company', () => {
    test('the comparison key is the listed ticker, else the company key, else nothing', () => {
        expect(comparisonKey(tokens[5])).toBe('SPCX');
        expect(comparisonKey(tokens[0])).toBe('OPENAI');
        expect(comparisonKey({ underlyingTicker: 'aapl' })).toBe('AAPL');
        expect(comparisonKey(tokens[8])).toBe('');
        expect(comparisonKey(null)).toBe('');
    });

    test('OpenAI: PreStocks OPENAI and Tessera tOpenAI side by side, marked pre-IPO and named', () => {
        const openai = sameUnderlyingGroups(tokens).find((group) => group.ticker === 'OPENAI');
        expect(openai).toMatchObject({ ticker: 'OPENAI', name: 'OpenAI', preIpo: true, issuerCount: 2, tokenCount: 2 });
        expect(openai.rows.map((row) => [row.issuer, row.tokens.map((token) => token.symbol)]))
            .toEqual([['prestocks', ['OPENAI']], ['tessera', ['tOpenAI']]]);
    });

    test('SpaceX: the pre-IPO tokens join the listed SPCX wrappers, which keep the group listed', () => {
        const spcx = sameUnderlyingGroups(tokens).find((group) => group.ticker === 'SPCX');
        expect(spcx).toMatchObject({ name: 'SpaceX', preIpo: false, issuerCount: 4, tokenCount: 4 });
        expect(spcx.rows.map((row) => row.issuer)).toEqual(['backpack-securities', 'prestocks', 'tessera', 'xstocks-backed']);
    });

    test('a lone pre-IPO wrapper is a standalone group only when singles are asked for; unnamed ones never group', () => {
        expect(sameUnderlyingGroups(tokens).map((group) => group.ticker)).toEqual(['SPCX', 'OPENAI']);
        const all = sameUnderlyingGroups(tokens, { includeSingle: true });
        expect(all.map((group) => group.ticker)).toEqual(['SPCX', 'OPENAI', 'ANTHROPIC', 'FIGR']);
        expect(all.flatMap((group) => group.rows.flatMap((row) => row.tokens.map((token) => token.symbol)))).not.toContain('XAI');
    });

    test('the stock directory lists the company under its name, flagged pre-IPO', () => {
        const directory = underlyingGroups(tokens);
        expect(directory.find((group) => group.ticker === 'OPENAI')).toMatchObject({ name: 'OpenAI', preIpo: true, issuerCount: 2 });
        expect(directory.find((group) => group.ticker === 'SPCX')).toMatchObject({ name: 'SpaceX', preIpo: false, issuerCount: 4 });
        expect(directory.find((group) => group.ticker === 'FIGR').name).toBe('Figure Technology Solutions');
    });

    test('search finds both wrappers by the company name, however it is spelled', () => {
        for (const query of ['OpenAI', 'open ai']) {
            expect(globalSearch(tokens, [], query).tokens.map((token) => token.symbol)).toEqual(['OPENAI', 'tOpenAI']);
        }
    });

    test('a compare URL may name the company, a wrapper symbol or the slug, as well as the key', () => {
        const aliases = comparisonKeyAliases(tokens);
        const keys = sameUnderlyingGroups(tokens, { includeSingle: true }).map((group) => group.ticker);
        const open = (query) => comparisonTickerFromParams(new URLSearchParams(query), keys, aliases);
        expect(open('view=compare&compare=OPENAI')).toBe('OPENAI');
        expect(open('compare=openai')).toBe('OPENAI');
        expect(open('compare=tOpenAI')).toBe('OPENAI');
        expect(open('compare=SPACEX')).toBe('SPCX');
        expect(open('compare=T-SpaceX')).toBe('SPCX');
        expect(open('view=compare&search=OpenAI')).toBe('OPENAI');
        expect(open('compare=XAI')).toBeNull();
        // Without aliases the old behaviour holds: only a key opens a group.
        expect(comparisonTickerFromParams(new URLSearchParams('compare=SPACEX'), keys)).toBeNull();
    });
});
