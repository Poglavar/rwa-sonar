// Unit tests for stocks/lib/live-tape.js: which trades the live tape hides (routed ones, by default),
// how one page is picked from a newest-first batch, the paging cursor, and the toggle's wording.
const T = require('./lib/live-tape.js');

const trade = (sig, routed, minute) => ({
    sig,
    routed,
    time: new Date(Date.UTC(2026, 8, 30, 12, 60 - minute)).toISOString()
});

describe('isRoutedTrade', () => {
    test('only an explicit true is routed', () => {
        expect(T.isRoutedTrade({ routed: true })).toBe(true);
        for (const value of [false, null, undefined, 'true', 1]) expect(T.isRoutedTrade({ routed: value })).toBe(false);
        expect(T.isRoutedTrade(null)).toBe(false);
    });
});

describe('pickTapePage', () => {
    // Newest first: d = direct, r = routed.
    const batch = [trade('r1', true, 1), trade('d1', false, 2), trade('r2', true, 3), trade('d2', false, 4),
        trade('d3', false, 5), trade('r3', true, 6), trade('d4', false, 7)];

    test('hides routed trades by default and counts them', () => {
        const pick = T.pickTapePage(batch, { limit: 20 });
        expect(pick.shown.map((t) => t.sig)).toEqual(['d1', 'd2', 'd3', 'd4']);
        expect(pick.hidden).toBe(3);
        expect(pick.scanned).toBe(7);
        expect(pick.exhausted).toBe(true);
    });

    test('shows everything when routed trades are turned on', () => {
        const pick = T.pickTapePage(batch, { showRouted: true, limit: 20 });
        expect(pick.shown).toHaveLength(7);
        expect(pick.hidden).toBe(0);
    });

    test('stops at the limit, counting only the routed rows before the cut', () => {
        const pick = T.pickTapePage(batch, { limit: 2 });
        expect(pick.shown.map((t) => t.sig)).toEqual(['d1', 'd2']);
        expect(pick.hidden).toBe(2);
        expect(pick.scanned).toBe(4);
        expect(pick.exhausted).toBe(false);
    });

    test('an empty or missing batch shows nothing', () => {
        expect(T.pickTapePage(null)).toEqual({ shown: [], hidden: 0, scanned: 0, exhausted: true });
    });
});

describe('nextApiCursor', () => {
    const batch = [trade('r1', true, 1), trade('d1', false, 2), trade('d2', false, 3), trade('r2', true, 4)];

    test('resumes right after the last row shown when the page filled early', () => {
        const pick = T.pickTapePage(batch, { limit: 1 });
        expect(T.nextApiCursor(batch, pick, 'batch-cursor')).toBe(`${batch[1].time},d1`);
    });

    test('uses the batch cursor when the whole batch was read, and null at the end of history', () => {
        const pick = T.pickTapePage(batch, { limit: 20 });
        expect(T.nextApiCursor(batch, pick, 'batch-cursor')).toBe('batch-cursor');
        expect(T.nextApiCursor(batch, pick, null)).toBeNull();
    });
});

describe('batchSize', () => {
    test('reads more rows while routed trades are hidden, within the API cap of 500', () => {
        expect(T.batchSize(20, true)).toBe(20);
        expect(T.batchSize(20, false)).toBe(20 * T.HIDDEN_BATCH_FACTOR);
        expect(T.batchSize(20, false)).toBeLessThanOrEqual(500);
    });
});

describe('wording and preference', () => {
    test('the label names the hidden count only while hiding', () => {
        expect(T.toggleLabel(14, false)).toBe('Show automated routed trades (14 hidden on this page)');
        expect(T.toggleLabel(null, false)).toBe('Show automated routed trades (0 hidden on this page)');
        expect(T.toggleLabel(14, true)).toBe('Show automated routed trades');
    });

    test('the note states the routed share of the capture, and leaves it out when there is none', () => {
        const summary = T.routedSummary([{ routed: true }, { routed: true }, { routed: false }, {}]);
        expect(summary).toEqual({ total: 4, routed: 2, share: 0.5 });
        expect(T.routedNote(summary)).toMatch(/They are 50% of the 4 trades in the last 24 h capture\.$/);
        expect(T.routedSummary([]).share).toBeNull();
        expect(T.routedNote(T.routedSummary([]))).not.toMatch(/They are/);
    });

    test('only a stored "1" turns routed trades on', () => {
        expect(T.parseShowRouted('1')).toBe(true);
        for (const value of [null, '0', 'true', '']) expect(T.parseShowRouted(value)).toBe(false);
    });
});
