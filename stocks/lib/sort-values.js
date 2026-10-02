/*
 * How the stocks page orders a column: a missing value (null, "", undefined, a non-finite number)
 * always sorts last in both directions, numbers compare as numbers and everything else as
 * case-insensitive text. Shared by the token table, the activity table and the venue rows.
 *
 * Moved verbatim out of stocks.js (next-steps.md F11). Pure: no DOM, no fetch, no clock. UMD like the
 * other stocks/lib/*.js files: the browser loads it as a classic script before stocks.js and reads
 * window.__rwaSortValues; jest requires it. Tested in stocks/sort-values.test.js.
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./fmt.js'));
    else root.__rwaSortValues = factory(root.__rwaFmt);
})(this, function (fmt) {
    const { isNum } = fmt;

    /** Treats null, "", undefined and non-finite numbers alike: they sort last, both directions. */
    function isMissing(value) {
        if (value === null || value === undefined || value === '') return true;
        return typeof value === 'number' && !Number.isFinite(value);
    }

    /** Compares two cell values, missing ones always last whatever the direction. */
    function compareValues(a, b, ascending) {
        const aMissing = isMissing(a);
        const bMissing = isMissing(b);
        if (aMissing && bMissing) return 0;
        if (aMissing) return 1;
        if (bMissing) return -1;
        if (isNum(a) && isNum(b)) return ascending ? a - b : b - a;
        const cmp = String(a).toLowerCase().localeCompare(String(b).toLowerCase());
        return ascending ? cmp : -cmp;
    }

    /** Builds an Array#sort comparator from a value getter. */
    function makeComparator(getValue, ascending) {
        return (a, b) => compareValues(getValue(a), getValue(b), ascending);
    }

    return {
        isMissing,
        compareValues,
        makeComparator
    };
});
