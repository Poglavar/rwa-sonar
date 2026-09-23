// Unit tests for stocks/lib/sort-values.js: the column comparator: missing values last in both
// directions. Moved with the code out of stocks-page.test.js (next-steps.md F11), which still tests
// the page wiring that calls it.

const {
    isMissing,
    compareValues,
    makeComparator
} = require('./lib/sort-values.js');

describe('sorting', () => {
    it('treats null, empty and non-finite values as missing', () => {
        expect(isMissing(null)).toBe(true);
        expect(isMissing(undefined)).toBe(true);
        expect(isMissing('')).toBe(true);
        expect(isMissing(NaN)).toBe(true);
        expect(isMissing(Infinity)).toBe(true);
        expect(isMissing(0)).toBe(false);
        expect(isMissing('0')).toBe(false);
    });

    it('puts missing values last in both directions', () => {
        expect(compareValues(null, 5, true)).toBeGreaterThan(0);
        expect(compareValues(null, 5, false)).toBeGreaterThan(0);
        expect(compareValues(5, null, true)).toBeLessThan(0);
        expect(compareValues(5, null, false)).toBeLessThan(0);
        expect(compareValues(null, undefined, true)).toBe(0);
    });

    it('compares numbers numerically and respects the direction', () => {
        expect(compareValues(2, 10, true)).toBeLessThan(0);
        expect(compareValues(2, 10, false)).toBeGreaterThan(0);
        expect(compareValues(0, -1, true)).toBeGreaterThan(0);
    });

    it('compares strings case-insensitively', () => {
        expect(compareValues('aaplx', 'TSLAx', true)).toBeLessThan(0);
        expect(compareValues('aaplx', 'TSLAx', false)).toBeGreaterThan(0);
    });

    it('sorts a token list descending with the nulls at the end', () => {
        const tokens = [
            { symbol: 'A', market: { liquidity: 500 } },
            { symbol: 'B', market: { liquidity: null } },
            { symbol: 'C', market: { liquidity: 1_200_000 } },
            { symbol: 'D', market: { liquidity: 0 } },
            { symbol: 'E', market: {} }
        ];
        const sorted = tokens.slice().sort(makeComparator((t) => t.market.liquidity, false));
        expect(sorted.map((t) => t.symbol)).toEqual(['C', 'A', 'D', 'B', 'E']);
    });

    it('keeps the nulls last when the same column is sorted ascending', () => {
        const tokens = [
            { symbol: 'A', reference: { premiumPct: 0.45 } },
            { symbol: 'B', reference: { premiumPct: null } },
            { symbol: 'C', reference: { premiumPct: -1.8 } }
        ];
        const sorted = tokens.slice().sort(makeComparator((t) => t.reference.premiumPct, true));
        expect(sorted.map((t) => t.symbol)).toEqual(['C', 'A', 'B']);
    });
});
