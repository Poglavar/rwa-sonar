// Unit tests for stocks/lib/universe.mjs — the monotonic universe merge that keeps Jupiter's
// unstable search ranking from reading as mints appearing and disappearing. Every test asserts an
// outcome a reader of stocks-changes.json would notice if it broke: that a mint the search skipped
// today is still in the file (and marked stale rather than fresh), that coming back after a gap does
// NOT reset the day we first saw it, that `lastSeenAt` is never advanced for a mint we did not see,
// and that a first run claims no knowledge it does not have.

import { mergeUniverse, provenanceCounts } from './lib/universe.mjs';

const RUN = '2026-09-17T09:00:00Z';
const YESTERDAY = '2026-09-16T20:27:15Z';

/** A universe item, defaulted so a test states only the field it is about. */
function item(overrides = {}) {
    return {
        mint: 'MINT_A',
        symbol: 'AAPLx',
        name: 'Apple xStock',
        issuer: 'xstocks-backed',
        liquidity: 4000,
        listedOnJupiter: true,
        ...overrides
    };
}

/** A previously written item, i.e. one that already carries the provenance fields. */
function known(overrides = {}) {
    return item({ firstSeenAt: YESTERDAY, lastSeenAt: YESTERDAY, seenInSearch: true, ...overrides });
}

/** `{mint: record}` for an easier assertion. */
function byMint(items) {
    return new Map(items.map((row) => [row.mint, row]));
}

describe('mergeUniverse carry-over', () => {
    test('keeps a previously known mint the search did not return, marked seenInSearch:false', () => {
        const merged = mergeUniverse(
            [known({ mint: 'MINT_A' }), known({ mint: 'MINT_B', symbol: 'CRWVx', liquidity: 9000 })],
            [item({ mint: 'MINT_A' })],
            { fetchedAt: RUN }
        );
        expect(merged.map((row) => row.mint)).toEqual(['MINT_A', 'MINT_B']);
        const rows = byMint(merged);
        expect(rows.get('MINT_A').seenInSearch).toBe(true);
        expect(rows.get('MINT_B').seenInSearch).toBe(false);
        // The carried-over record keeps its old data rather than being blanked.
        expect(rows.get('MINT_B').symbol).toBe('CRWVx');
        expect(rows.get('MINT_B').liquidity).toBe(9000);
    });

    test('a carried-over mint keeps its old lastSeenAt — it is not advanced to this run', () => {
        const merged = mergeUniverse([known({ mint: 'MINT_B' })], [], { fetchedAt: RUN });
        expect(merged[0].lastSeenAt).toBe(YESTERDAY);
        expect(merged[0].firstSeenAt).toBe(YESTERDAY);
    });

    test('a returned mint gets refreshed data and this run as lastSeenAt', () => {
        const merged = mergeUniverse(
            [known({ mint: 'MINT_A', liquidity: 10 })],
            [item({ mint: 'MINT_A', liquidity: 5000 })],
            { fetchedAt: RUN }
        );
        expect(merged[0].liquidity).toBe(5000);
        expect(merged[0].lastSeenAt).toBe(RUN);
        expect(merged[0].firstSeenAt).toBe(YESTERDAY);
    });
});

describe('firstSeenAt and lastSeenAt', () => {
    test('a mint nobody knew is first seen in this run', () => {
        const merged = mergeUniverse([known({ mint: 'MINT_A' })], [item({ mint: 'NEW_ONE' }), item({ mint: 'MINT_A' })], { fetchedAt: RUN });
        const rows = byMint(merged);
        expect(rows.get('NEW_ONE').firstSeenAt).toBe(RUN);
        expect(rows.get('NEW_ONE').lastSeenAt).toBe(RUN);
        expect(rows.get('MINT_A').firstSeenAt).toBe(YESTERDAY);
    });

    test('a mint returned again after a gap keeps its ORIGINAL firstSeenAt', () => {
        const day1 = mergeUniverse([], [item({ mint: 'MINT_B' })], { fetchedAt: '2026-09-10T00:00:00Z' });
        const day2 = mergeUniverse(day1, [], { fetchedAt: '2026-09-11T00:00:00Z' });
        const day3 = mergeUniverse(day2, [], { fetchedAt: '2026-09-12T00:00:00Z' });
        const day4 = mergeUniverse(day3, [item({ mint: 'MINT_B' })], { fetchedAt: RUN });
        expect(day3[0].seenInSearch).toBe(false);
        expect(day4[0].seenInSearch).toBe(true);
        expect(day4[0].firstSeenAt).toBe('2026-09-10T00:00:00Z');
        expect(day4[0].lastSeenAt).toBe(RUN);
    });

    test('a previous record from before these fields existed is first seen now, not backdated', () => {
        const merged = mergeUniverse([item({ mint: 'MINT_B' })], [], { fetchedAt: RUN });
        expect(merged[0].firstSeenAt).toBe(RUN);
        // Nothing proves when it was last returned, so the field stays null rather than claiming today.
        expect(merged[0].lastSeenAt).toBeNull();
    });

    test('a blank timestamp in the previous record is not treated as a real one', () => {
        const merged = mergeUniverse([item({ mint: 'MINT_B', firstSeenAt: '   ', lastSeenAt: '' })], [], { fetchedAt: RUN });
        expect(merged[0].firstSeenAt).toBe(RUN);
        expect(merged[0].lastSeenAt).toBeNull();
    });

    test('an invented fetchedAt is refused rather than guessed', () => {
        expect(() => mergeUniverse([], [item()], {})).toThrow(/fetchedAt/);
        expect(() => mergeUniverse([], [item()], { fetchedAt: '' })).toThrow(/fetchedAt/);
    });
});

describe('no duplicates, and no previous file', () => {
    test('a mint in both sides appears exactly once, with the fresh record', () => {
        const merged = mergeUniverse(
            [known({ mint: 'MINT_A', symbol: 'OLD' }), known({ mint: 'MINT_A', symbol: 'OLDER' })],
            [item({ mint: 'MINT_A', symbol: 'AAPLx' }), item({ mint: 'MINT_A', symbol: 'AAPLx' })],
            { fetchedAt: RUN }
        );
        expect(merged).toHaveLength(1);
        expect(merged[0].symbol).toBe('AAPLx');
    });

    test('with no previous file every returned mint is new, and nothing is carried over', () => {
        for (const absent of [null, undefined, []]) {
            const merged = mergeUniverse(absent, [item({ mint: 'MINT_B' }), item({ mint: 'MINT_A' })], { fetchedAt: RUN });
            expect(merged.map((row) => row.mint)).toEqual(['MINT_A', 'MINT_B']);
            expect(merged.every((row) => row.seenInSearch === true)).toBe(true);
            expect(merged.every((row) => row.firstSeenAt === RUN)).toBe(true);
        }
    });

    test('rows without a usable mint are dropped from both sides', () => {
        const merged = mergeUniverse([known({ mint: '' }), { symbol: 'NOPE' }], [item({ mint: null })], { fetchedAt: RUN });
        expect(merged).toEqual([]);
    });
});

describe('provenanceCounts', () => {
    test('counts what the run actually saw, carried over and saw for the first time', () => {
        const merged = mergeUniverse(
            [known({ mint: 'MINT_A' }), known({ mint: 'MINT_B' })],
            [item({ mint: 'MINT_A' }), item({ mint: 'NEW_ONE' })],
            { fetchedAt: RUN }
        );
        expect(provenanceCounts(merged, RUN)).toEqual({
            total: 3,
            seenInSearch: 2,
            carriedOverUnseen: 1,
            newThisRun: 1
        });
    });
});
