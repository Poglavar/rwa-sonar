// Every issuer's tokens of one stock across chains (lib/cross-chain.mjs), on the real CoinMarketCap
// listing of the AAPL tokens (30 Sep 2026), and the part of a card's share line it produces.
import { crossChainFor, crossChainTotals, tickerOf } from './lib/cross-chain.mjs';
import { solanaShareHtml } from './lib/cards.mjs';

const AS_OF = '2026-09-30T13:40:00Z';
const LIVE = '2026-09-30T13:36:00.000Z';
const AAPL = [
    { id: 36994, name: 'Apple tokenized stock (xStock)', symbol: 'AAPLX', platform: { name: 'Solana' }, circulating_supply: 39463.47, last_updated: LIVE },
    { id: 1, name: 'Apple Tokenized Stock (Ondo)', symbol: 'AAPLon', platform: { name: 'Ethereum' }, circulating_supply: 26904.12, last_updated: LIVE },
    { id: 2, name: 'Apple Tokenized bStocks', symbol: 'AAPLB', platform: { name: 'BNB Smart Chain (BEP20)' }, circulating_supply: 17477.92, last_updated: LIVE },
    { id: 3, name: 'Wrapped Apple Tokenized stock (xStock)', symbol: 'WAAPLX', platform: { name: 'X Layer' }, circulating_supply: 1210.25, last_updated: LIVE },
    { id: 4, name: 'Apple Inc (Derivatives)', symbol: 'AAPL', platform: null, circulating_supply: 0, last_updated: LIVE },
    { id: 5, name: 'Apple Tokenized Stock (Hyperliquid)', symbol: 'AAPL', platform: { name: 'HyperEVM' }, circulating_supply: 0, last_updated: LIVE },
    { id: 6, name: 'Apple tokenized stock FTX', symbol: 'AAPL', platform: null, circulating_supply: 0, last_updated: '2022-11-19T18:30:00.000Z' },
    { id: 7, name: 'Mirrored Apple', symbol: 'mAAPL', platform: { name: 'Ethereum' }, circulating_supply: 8965.79, last_updated: '2022-06-15T18:28:00.000Z' },
    { id: 8, name: 'AAPL tokenized stock (Dinari)', symbol: 'AAPL.D', platform: { name: 'Arbitrum' }, circulating_supply: 0 }
];
const TICKERS = new Set(['AAPL', 'TSLA']);

describe('tokenized stocks across chains', () => {
    test('each issuer family’s symbol carries the ticker; wrapped copies, derivative prices and unknown tickers do not count', () => {
        expect(AAPL.map((c) => tickerOf(c, TICKERS))).toEqual(['AAPL', 'AAPL', 'AAPL', null, null, 'AAPL', 'AAPL', null, 'AAPL']);
        expect(tickerOf({ name: 'Zzz Tokenized Stock (Ondo)', symbol: 'ZZZon' }, TICKERS)).toBeNull();
    });

    test('the total is the live listings with a supply; a live one without a supply makes it a floor; dead ones are ignored', () => {
        const aapl = crossChainTotals(AAPL, TICKERS, AS_OF).get('AAPL');
        expect(aapl.totalUnits).toBeCloseTo(83845.51, 1);
        expect(aapl.listings.map((l) => l.symbol)).toEqual(['AAPLX', 'AAPLon', 'AAPLB']);
        expect(aapl.withoutSupply).toBe(1); // Hyperliquid; FTX and Mirrored are dead, Dinari has no update time
    });

    test('a token’s share is its own listing (matched by symbol) over the total; a token CoinMarketCap does not list gets the total only', () => {
        const totals = crossChainTotals(AAPL, TICKERS, AS_OF);
        expect(crossChainFor('AAPLx', 'AAPL', totals).sharePct).toBeCloseTo(47.07, 1);
        expect(crossChainFor('AAPL', 'AAPL', totals)).toMatchObject({ sharePct: null, units: null });
        expect(crossChainFor('TSLAx', 'TSLA', totals)).toBeNull();
    });

    test('the card line says the share across chains, "up to" when the total is a floor, or the total alone', () => {
        const solanaShare = { ticker: 'AAPL', sharePct: 98.65, tokens: 2, units: 27280, totalUnits: 27653, basis: 'float', others: [{ symbol: 'AAPLon', units: 373 }] };
        const floor = solanaShareHtml({ symbol: 'AAPLx', solanaShare, crossChain: { ticker: 'AAPL', totalUnits: 83845, listings: 3, withoutSupply: 1, units: 39463, sharePct: 47.07 } });
        expect(floor).toContain(' · <span title="');
        expect(floor).toMatch(/<b>up to 47\.1%<\/b> of all tokenized AAPL, across chains and issuers<\/span><\/p>$/);
        const exact = solanaShareHtml({ symbol: 'SPYx', solanaShare: { ...solanaShare, ticker: 'SPY' }, crossChain: { ticker: 'SPY', totalUnits: 103253, listings: 2, withoutSupply: 0, units: 84045, sharePct: 81.4 } });
        expect(exact).toMatch(/<b>81\.4%<\/b> of all tokenized SPY/);
        const unlisted = solanaShareHtml({ symbol: 'AMD', solanaShare: { ...solanaShare, ticker: 'AMD' }, crossChain: { ticker: 'AMD', totalUnits: 30421, listings: 3, withoutSupply: 1, units: null, sharePct: null } });
        expect(unlisted).toMatch(/30,421 AMD tokenized across chains<\/span><\/p>$/);
        expect(solanaShareHtml({ symbol: 'X', solanaShare, crossChain: null })).not.toContain('across chains');
    });
});
