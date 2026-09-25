// Unit tests for stocks/lib/private-companies.mjs: which company each pre-IPO token references and
// the comparison key it is grouped under. Fixtures are the catalogue's own names on 2026-09-23
// (PreStocks "<Company> PreStocks", Tessera "T-<Company>" with code "t<Company>").
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { PRIVATE_COMPANIES, privateCompany } = require('./lib/private-companies.mjs');

const prestocks = (symbol, company) => ({ issuer: 'prestocks', symbol, name: `${company} PreStocks` });
const tessera = (code, company) => ({ issuer: 'tessera', symbol: code, name: `T-${company}` });

describe('the company a pre-IPO token references', () => {
    test.each([
        [prestocks('OPENAI', 'OpenAI'), 'OPENAI', 'OpenAI'],
        [tessera('tOpenAI', 'OpenAI'), 'OPENAI', 'OpenAI'],
        [prestocks('KALSHI', 'Kalshi'), 'KALSHI', 'Kalshi'],
        [tessera('tKalshi', 'Kalshi'), 'KALSHI', 'Kalshi'],
        [prestocks('ANTHROPIC', 'Anthropic'), 'ANTHROPIC', 'Anthropic'],
        [prestocks('ANDURIL', 'Anduril'), 'ANDURIL', 'Anduril'],
        [prestocks('FIGUREAI', 'Figure AI'), 'FIGUREAI', 'Figure AI'],
        [prestocks('NEURALINK', 'Neuralink'), 'NEURALINK', 'Neuralink'],
        [prestocks('POLYMARKET', 'Polymarket'), 'POLYMARKET', 'Polymarket']
    ])('%o is %s', (token, key, name) => {
        expect(privateCompany(token)).toEqual({ key, name, listedTicker: null });
    });

    test('SpaceX has listed, so its pre-IPO tokens are keyed by the listed ticker they now sit beside', () => {
        for (const token of [prestocks('SPACEX', 'SpaceX'), tessera('tSpaceX', 'SpaceX')]) {
            expect(privateCompany(token)).toEqual({ key: 'SPCX', name: 'SpaceX', listedTicker: 'SPCX' });
        }
    });

    test('spelling, spacing and the wrapper words do not split a company', () => {
        expect(privateCompany({ issuer: 'other', symbol: 'X1', name: 'Open AI' })?.key).toBe('OPENAI');
        expect(privateCompany({ issuer: 'tessera', symbol: 'T-OpenAI', name: null, issuerApi: { name: 'T-OpenAI', code: 'tOpenAI' } })?.key).toBe('OPENAI');
        // The symbol alone is enough when the name is missing.
        expect(privateCompany({ issuer: 'prestocks', symbol: 'OPENAI', name: null })?.key).toBe('OPENAI');
        expect(privateCompany({ issuer: 'tessera', symbol: 'tSpaceX', name: null })?.key).toBe('SPCX');
    });

    test('an unknown company is not guessed: it stays ungrouped until the table names it', () => {
        expect(privateCompany(prestocks('XAI', 'xAI'))).toBeNull();
        expect(privateCompany({ issuer: 'prestocks', symbol: null, name: null })).toBeNull();
        expect(privateCompany(null)).toBeNull();
    });

    test('Figure AI is not Figure Technology Solutions (FIGR), whose tokens track a listed share', () => {
        expect(privateCompany({ issuer: 'ondo-global-markets', symbol: 'FIGRon', name: 'Figure Technology Solutions (Ondo Tokenized)' })).toBeNull();
        expect(privateCompany(prestocks('FIGUREAI', 'Figure AI')).key).not.toBe('FIGR');
    });

    test('a company key is either its listed ticker or collides with no listed ticker in the catalogue', () => {
        const tokens = JSON.parse(readFileSync(join(__dirname, '..', 'stocks-tokens.json'), 'utf8')).tokens;
        const listed = new Set(tokens.map((token) => token.underlyingTicker).filter(Boolean));
        for (const company of PRIVATE_COMPANIES) {
            if (company.listedTicker) {
                expect(company.key).toBe(company.listedTicker);
                expect(listed.has(company.listedTicker)).toBe(true);
            } else {
                expect(listed.has(company.key)).toBe(false);
            }
        }
        expect(new Set(PRIVATE_COMPANIES.map((company) => company.key)).size).toBe(PRIVATE_COMPANIES.length);
    });
});
