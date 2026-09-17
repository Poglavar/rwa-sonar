// Unit tests for stocks/lib/changes.mjs — the slim snapshot rows and the day-over-day diff behind
// stocks-changes.json and the health monitor's change log. Every test asserts an outcome a reader
// would notice if it broke: the boundary at which a halved pool is reported (50.0 % must NOT fire,
// 50.1 % must), that a mint gone from the universe is `removed-mint` and never `paused`, that a
// multiplier stored as a STRING is still compared as a number, and that a field which was null
// yesterday can never manufacture a change today. Each one goes red when its rule is removed, not
// merely when the function disappears.

import {
    CHANGE_KINDS,
    CONTROL_FLAGS,
    NEW_MINT_WINDOW_DAYS,
    countByKind,
    diffSnapshots,
    selectNewMints,
    snapshotIssuerRow,
    snapshotTokenRow
} from './lib/changes.mjs';

/** A full token record shaped like stocks-tokens.json `.tokens[]`, with overridable blocks. */
function token(overrides = {}) {
    const { control = {}, market = {}, activity = {}, reference = {}, holders = {}, ...rest } = overrides;
    return {
        mint: 'MINT_A',
        symbol: 'AAPLx',
        name: 'Apple xStock',
        issuer: 'xstocks-backed',
        supplyRaw: '367022839632',
        uiMultiplier: '1.0033760737402210',
        decimals: 9,
        control: { paused: false, pausable: true, clawback: false, allowlist: false, transferFeeBps: null, hookActive: false, ...control },
        market: { liquidity: 4000, vol24: 12000, holderCount: 1851, usdPrice: 240, ...market },
        activity: { venueSpreadPct: 0.52, trades24: 42, ...activity },
        reference: { premiumPct: -0.28, price: 241, ...reference },
        holders: { top1SharePct: 48.7, top20SharePct: 82.9, frozenAccountsTop20: 0, ...holders },
        ...rest
    };
}

/** A snapshot file `{date, items}` from a list of already-slim rows. */
function snap(date, rows) {
    return { date, builtAt: `${date}T22:00:00Z`, healthGeneratedAt: `${date}T22:05:00Z`, items: rows };
}

/** One slim row, defaulted so a test only states the field it is about. */
function row(overrides = {}) {
    return { ...snapshotTokenRow(token(), null), ...overrides };
}

/** The kinds a diff of these two one-row snapshots produced. */
function kindsOf(prevRow, nextRow) {
    const diff = diffSnapshots(snap('2026-09-16', [prevRow]), snap('2026-09-17', [nextRow]));
    return diff.changes.map((change) => change.kind);
}

// ------------------------------------------------------------------ row shaping

describe('snapshotTokenRow', () => {
    test('keeps exactly the diffable fields, and keeps supply and the multiplier as strings', () => {
        const out = snapshotTokenRow(token(), { mint: 'MINT_A', status: 'caution', worstRuleId: 'liquidity' });
        expect(Object.keys(out)).toEqual([
            'mint', 'symbol', 'issuer', 'firstSeenAt', 'seenInSearch', 'supplyRaw', 'uiMultiplier',
            'paused', 'pausable', 'clawback', 'allowlist', 'transferFeeBps', 'hookActive',
            'liquidity', 'vol24', 'holderCount', 'premiumPct', 'venueSpreadPct',
            'top1SharePct', 'top20SharePct', 'frozenAccountsTop20', 'health', 'worstRuleId'
        ]);
        // A 20-digit supply and a 17-significant-digit multiplier both lose precision as doubles.
        expect(out.supplyRaw).toBe('367022839632');
        expect(typeof out.supplyRaw).toBe('string');
        expect(out.uiMultiplier).toBe('1.0033760737402210');
        expect(typeof out.uiMultiplier).toBe('string');
        expect(out.health).toBe('caution');
        expect(out.worstRuleId).toBe('liquidity');
    });

    test('a build with no holders block and no health verdict leaves those fields null, never 0', () => {
        const older = token();
        delete older.holders;
        const out = snapshotTokenRow(older, null);
        expect(out.top1SharePct).toBeNull();
        expect(out.top20SharePct).toBeNull();
        expect(out.frozenAccountsTop20).toBeNull();
        expect(out.health).toBeNull();
        expect(out.worstRuleId).toBeNull();
        // The measured fields of the same build are still there.
        expect(out.liquidity).toBe(4000);
    });

    test('a missing control flag stays null rather than reading as false', () => {
        const out = snapshotTokenRow(token({ control: { pausable: undefined, clawback: null } }), null);
        expect(out.pausable).toBeNull();
        expect(out.clawback).toBeNull();
        expect(out.paused).toBe(false);
    });

    test('every recorded number is cut to six significant figures, so a rebuild is byte-identical', () => {
        const out = snapshotTokenRow(token({
            market: { liquidity: 892.0574669761927, vol24: 410.7260711494404, holderCount: 1851 },
            reference: { premiumPct: -0.28762001434016193 },
            activity: { venueSpreadPct: 0.5234814525105991 },
            holders: { top1SharePct: 48.73144088308422, top20SharePct: 82.90128358753567, frozenAccountsTop20: 0 }
        }), null);
        expect(out.liquidity).toBe(892.057);
        expect(out.vol24).toBe(410.726);
        expect(out.premiumPct).toBe(-0.28762);
        expect(out.venueSpreadPct).toBe(0.523481);
        expect(out.top1SharePct).toBe(48.7314);
        // Counts are integers and are left exactly as they are, rather than losing digits.
        expect(out.holderCount).toBe(1851);
        expect(out.frozenAccountsTop20).toBe(0);
        // Six figures is far finer than the 0.1 % the smallest change kind reacts to.
        expect(String(out.liquidity)).not.toMatch(/\d{8}/);
    });

    test('an entirely empty token yields a row of nulls and throws nothing', () => {
        const out = snapshotTokenRow(null, null);
        expect(out.mint).toBeNull();
        expect(out.liquidity).toBeNull();
        expect(Object.values(out).every((value) => value === null)).toBe(true);
    });
});

describe('snapshotIssuerRow', () => {
    test('lifts the three graded numbers out of grades and the two aggregates out of market', () => {
        const out = snapshotIssuerRow({
            slug: 'ondo-global-markets',
            status: 'live',
            grades: { maturityStageNum: 2, claimRung: 2, verificationStrength: 3, maturityStage: 'Level 2' },
            market: { tokens: 212, dexLiquidityUsd: 72201.2 },
            tokenMints: ['a', 'b']
        });
        expect(out).toEqual({
            slug: 'ondo-global-markets',
            status: 'live',
            maturityStageNum: 2,
            claimRung: 2,
            verificationStrength: 3,
            tokenCount: 212,
            liquidity: 72201.2
        });
    });

    test('falls back to counting the mint list when the build has no token aggregate', () => {
        const out = snapshotIssuerRow({ slug: 's', status: 'live', tokenMints: ['a', 'b', 'c'] });
        expect(out.tokenCount).toBe(3);
        expect(out.liquidity).toBeNull();
        expect(out.verificationStrength).toBeNull();
    });
});

// -------------------------------------------------------- appearing and leaving

describe('mints appearing and leaving', () => {
    test('a mint only in the newer day is new-mint, with the mint as the "after"', () => {
        const diff = diffSnapshots(snap('2026-09-16', []), snap('2026-09-17', [row({ mint: 'MINT_NEW', symbol: 'NVDAx' })]));
        expect(diff.changes).toHaveLength(1);
        expect(diff.changes[0]).toMatchObject({ kind: 'new-mint', mint: 'MINT_NEW', symbol: 'NVDAx', before: null, after: 'MINT_NEW' });
        expect(diff.from).toBe('2026-09-16');
        expect(diff.to).toBe('2026-09-17');
    });

    test('a mint gone from the newer day is removed-mint ONLY — never paused, however different its row was', () => {
        // The departing row is paused:false and liquid; if the diff fell through to the field
        // comparisons it would read the absent side as paused/zero and fire extra kinds.
        const gone = row({ mint: 'MINT_GONE', symbol: 'REMORA', paused: false, liquidity: 50000, frozenAccountsTop20: 0 });
        const diff = diffSnapshots(snap('2026-09-16', [gone]), snap('2026-09-17', []));
        expect(diff.changes.map((c) => c.kind)).toEqual(['removed-mint']);
        expect(diff.changes[0]).toMatchObject({ mint: 'MINT_GONE', symbol: 'REMORA', before: 'MINT_GONE', after: null });
    });

    test('a new-mint record carries the day the universe first saw the mint', () => {
        const fresh = row({ mint: 'MINT_NEW', symbol: 'NVDAx', firstSeenAt: '2026-09-17T09:00:00Z', seenInSearch: true });
        const diff = diffSnapshots(snap('2026-09-16', []), snap('2026-09-17', [fresh]));
        expect(diff.changes[0].firstSeenAt).toBe('2026-09-17T09:00:00Z');
    });

    test('a mint carried over with seenInSearch:false is NOT a removal', () => {
        // Jupiter's search is a ranking, not a listing: on 2026-09-17 a fresh run skipped 24 of the
        // 441 known mints, all of which a direct query still returned. Those are carried over by
        // stocks/lib/universe.mjs, so they are present on BOTH days and must produce no change at
        // all — neither a removal nor a numeric move off yesterday's figures.
        const yesterday = row({ mint: 'MINT_SKIPPED', symbol: 'CRWVx', firstSeenAt: '2026-09-16T20:27:15Z', seenInSearch: true });
        const today = { ...yesterday, seenInSearch: false };
        const diff = diffSnapshots(snap('2026-09-16', [yesterday]), snap('2026-09-17', [today]));
        expect(diff.changes).toEqual([]);
    });

    test('rows are ordered by mint, so the same two days always produce the same file', () => {
        const prev = snap('2026-09-16', [row({ mint: 'ZZZ' }), row({ mint: 'AAA' })]);
        const next = snap('2026-09-17', []);
        expect(diffSnapshots(prev, next).changes.map((c) => c.mint)).toEqual(['AAA', 'ZZZ']);
    });
});

// ------------------------------------------------------------------ pause kinds

describe('paused and unpaused', () => {
    test('false to true is paused, true to false is unpaused, and no move fires nothing', () => {
        expect(kindsOf(row({ paused: false }), row({ paused: true }))).toEqual(['paused']);
        expect(kindsOf(row({ paused: true }), row({ paused: false }))).toEqual(['unpaused']);
        expect(kindsOf(row({ paused: true }), row({ paused: true }))).toEqual([]);
    });

    test('a null on either side fires neither kind', () => {
        expect(kindsOf(row({ paused: null }), row({ paused: true }))).toEqual([]);
        expect(kindsOf(row({ paused: false }), row({ paused: null }))).toEqual([]);
    });
});

// ------------------------------------------------------------- liquidity kinds

describe('liquidity-drop and liquidity-rise', () => {
    test('a 50.0 % fall does NOT fire and a 50.1 % fall does', () => {
        expect(kindsOf(row({ liquidity: 10000 }), row({ liquidity: 5000 }))).toEqual([]);
        expect(kindsOf(row({ liquidity: 10000 }), row({ liquidity: 4990 }))).toEqual(['liquidity-drop']);
    });

    test('a 100 % rise does NOT fire and a 100.1 % rise does', () => {
        expect(kindsOf(row({ liquidity: 10000 }), row({ liquidity: 20000 }))).toEqual([]);
        expect(kindsOf(row({ liquidity: 10000 }), row({ liquidity: 20010 }))).toEqual(['liquidity-rise']);
    });

    test('a pool under $1,000 yesterday is not news however violently it moved', () => {
        expect(kindsOf(row({ liquidity: 999.99 }), row({ liquidity: 0.01 }))).toEqual([]);
        expect(kindsOf(row({ liquidity: 999.99 }), row({ liquidity: 90000 }))).toEqual([]);
        // Exactly at the floor it does fire — the floor is inclusive.
        expect(kindsOf(row({ liquidity: 1000 }), row({ liquidity: 1 }))).toEqual(['liquidity-drop']);
    });

    test('an unmeasured liquidity on either side never fires, even against a big number', () => {
        expect(kindsOf(row({ liquidity: null }), row({ liquidity: 90000 }))).toEqual([]);
        expect(kindsOf(row({ liquidity: 90000 }), row({ liquidity: null }))).toEqual([]);
    });

    test('the record carries the two dollar figures and a note naming the direction', () => {
        const diff = diffSnapshots(snap('2026-09-16', [row({ liquidity: 8000 })]), snap('2026-09-17', [row({ liquidity: 1200 })]));
        expect(diff.changes[0]).toMatchObject({ kind: 'liquidity-drop', field: 'liquidity', before: 8000, after: 1200 });
        expect(diff.changes[0].note).toMatch(/fell 85\.0 %/);
    });
});

// ---------------------------------------------------------------- venue spread

describe('spread-wide', () => {
    test('fires only on the crossing above 5 %', () => {
        expect(kindsOf(row({ venueSpreadPct: 4.9 }), row({ venueSpreadPct: 5.1 }))).toEqual(['spread-wide']);
        // Already wide yesterday: widening further is not a new crossing.
        expect(kindsOf(row({ venueSpreadPct: 6 }), row({ venueSpreadPct: 9 }))).toEqual([]);
        // Landing exactly on 5 is not above it.
        expect(kindsOf(row({ venueSpreadPct: 1 }), row({ venueSpreadPct: 5 }))).toEqual([]);
        // Narrowing back below fires nothing.
        expect(kindsOf(row({ venueSpreadPct: 7 }), row({ venueSpreadPct: 1 }))).toEqual([]);
    });

    test('a null spread on either side fires nothing', () => {
        expect(kindsOf(row({ venueSpreadPct: null }), row({ venueSpreadPct: 40 }))).toEqual([]);
        expect(kindsOf(row({ venueSpreadPct: 1 }), row({ venueSpreadPct: null }))).toEqual([]);
    });
});

// -------------------------------------------------------- multiplier kinds

describe('rebase, reverse-split and multiplier-change', () => {
    test('the multiplier is a STRING in the snapshot and is still compared as a number', () => {
        const prev = row({ uiMultiplier: '1' });
        const next = row({ uiMultiplier: '1.4861347' });
        expect(typeof prev.uiMultiplier).toBe('string');
        const diff = diffSnapshots(snap('2026-09-16', [prev]), snap('2026-09-17', [next]));
        expect(diff.changes.map((c) => c.kind)).toEqual(['rebase']);
        // The record keeps the exact strings, so the page shows what the mint actually says.
        expect(diff.changes[0]).toMatchObject({ field: 'uiMultiplier', before: '1', after: '1.4861347' });
        expect(diff.changes[0].note).toMatch(/up by 48\.6 %/);
    });

    test('exactly 1.05 is a rebase, just under it is a plain multiplier-change', () => {
        expect(kindsOf(row({ uiMultiplier: '1' }), row({ uiMultiplier: '1.05' }))).toEqual(['rebase']);
        expect(kindsOf(row({ uiMultiplier: '1' }), row({ uiMultiplier: '1.0499' }))).toEqual(['multiplier-change']);
    });

    test('exactly 0.5 is a reverse split, just over it is a plain multiplier-change', () => {
        expect(kindsOf(row({ uiMultiplier: '2' }), row({ uiMultiplier: '1' }))).toEqual(['reverse-split']);
        expect(kindsOf(row({ uiMultiplier: '1' }), row({ uiMultiplier: '0.5001' }))).toEqual(['multiplier-change']);
    });

    test('a move under 0.1 % is the ordinary accrual drift and is not reported', () => {
        // ~0.0001 % — the hourly drift of an interest-bearing mint. Reporting it every day would
        // bury the change log under 441 lines of nothing.
        expect(kindsOf(row({ uiMultiplier: '1.0033760737' }), row({ uiMultiplier: '1.0033770737' }))).toEqual([]);
        expect(kindsOf(row({ uiMultiplier: '1' }), row({ uiMultiplier: '1.0005' }))).toEqual([]);
        // Just over 0.1 % is reported. The literal '1.001' is deliberately NOT used as the boundary
        // case: as a double it is 1.00099999999999989, genuinely a hair under 0.1 %, so the
        // threshold is asserted where a double can represent which side of it a value falls.
        expect(kindsOf(row({ uiMultiplier: '1' }), row({ uiMultiplier: '1.0011' }))).toEqual(['multiplier-change']);
        expect(kindsOf(row({ uiMultiplier: '1' }), row({ uiMultiplier: '0.9989' }))).toEqual(['multiplier-change']);
    });

    test('a mint with no multiplier on one side fires nothing', () => {
        expect(kindsOf(row({ uiMultiplier: null }), row({ uiMultiplier: '1.5' }))).toEqual([]);
        expect(kindsOf(row({ uiMultiplier: '1' }), row({ uiMultiplier: null }))).toEqual([]);
        // A zero yesterday cannot produce a ratio at all.
        expect(kindsOf(row({ uiMultiplier: '0' }), row({ uiMultiplier: '1' }))).toEqual([]);
    });
});

// -------------------------------------------------------------------- health

describe('health-worse and health-better', () => {
    test('the ordering is good < caution < warning in both directions', () => {
        expect(kindsOf(row({ health: 'good' }), row({ health: 'caution' }))).toEqual(['health-worse']);
        expect(kindsOf(row({ health: 'caution' }), row({ health: 'warning' }))).toEqual(['health-worse']);
        expect(kindsOf(row({ health: 'warning' }), row({ health: 'good' }))).toEqual(['health-better']);
        expect(kindsOf(row({ health: 'good' }), row({ health: 'good' }))).toEqual([]);
    });

    test('a transition into or out of unknown is ignored — not measuring is not a health move', () => {
        expect(kindsOf(row({ health: 'unknown' }), row({ health: 'warning' }))).toEqual([]);
        expect(kindsOf(row({ health: 'good' }), row({ health: 'unknown' }))).toEqual([]);
        expect(kindsOf(row({ health: null }), row({ health: 'warning' }))).toEqual([]);
    });

    test('the note names the rule the new status sits on', () => {
        const diff = diffSnapshots(
            snap('2026-09-16', [row({ health: 'good', worstRuleId: null })]),
            snap('2026-09-17', [row({ health: 'warning', worstRuleId: 'spread' })])
        );
        expect(diff.changes[0]).toMatchObject({ kind: 'health-worse', field: 'health', before: 'good', after: 'warning' });
        expect(diff.changes[0].note).toMatch(/spread rule/);
    });
});

// ------------------------------------------------------------ frozen accounts

describe('frozen-appeared', () => {
    test('0 to 1 or more fires; anything else does not', () => {
        expect(kindsOf(row({ frozenAccountsTop20: 0 }), row({ frozenAccountsTop20: 1 }))).toEqual(['frozen-appeared']);
        expect(kindsOf(row({ frozenAccountsTop20: 0 }), row({ frozenAccountsTop20: 7 }))).toEqual(['frozen-appeared']);
        // Already had some: growing is not an appearance.
        expect(kindsOf(row({ frozenAccountsTop20: 1 }), row({ frozenAccountsTop20: 4 }))).toEqual([]);
        // Unfreezing is not an appearance either.
        expect(kindsOf(row({ frozenAccountsTop20: 3 }), row({ frozenAccountsTop20: 0 }))).toEqual([]);
    });

    test('a day with no holder fetch cannot make frozen accounts appear', () => {
        expect(kindsOf(row({ frozenAccountsTop20: null }), row({ frozenAccountsTop20: 5 }))).toEqual([]);
        expect(kindsOf(row({ frozenAccountsTop20: 0 }), row({ frozenAccountsTop20: null }))).toEqual([]);
    });
});

// ------------------------------------------------------------- control flags

describe('control-change', () => {
    test('every control boolean is watched, one record per flip, in a fixed order', () => {
        expect(CONTROL_FLAGS).toEqual(['pausable', 'clawback', 'allowlist', 'hookActive']);
        for (const flag of CONTROL_FLAGS) {
            const diff = diffSnapshots(
                snap('2026-09-16', [row({ [flag]: false })]),
                snap('2026-09-17', [row({ [flag]: true })])
            );
            expect(diff.changes).toHaveLength(1);
            expect(diff.changes[0]).toMatchObject({ kind: 'control-change', field: flag, before: false, after: true });
        }
    });

    test('two flags flipping at once yield two records in CONTROL_FLAGS order', () => {
        const diff = diffSnapshots(
            snap('2026-09-16', [row({ hookActive: false, clawback: false })]),
            snap('2026-09-17', [row({ hookActive: true, clawback: true })])
        );
        expect(diff.changes.map((c) => c.field)).toEqual(['clawback', 'hookActive']);
    });

    test('paused is NOT reported as a control-change — it has its own two kinds', () => {
        const diff = diffSnapshots(snap('2026-09-16', [row({ paused: false })]), snap('2026-09-17', [row({ paused: true })]));
        expect(diff.changes.map((c) => c.kind)).toEqual(['paused']);
    });

    test('a flag unknown on one side is not a flip', () => {
        expect(kindsOf(row({ allowlist: null }), row({ allowlist: true }))).toEqual([]);
    });
});

// ------------------------------------------------------------- ordering, counts

describe('ordering and counts', () => {
    test('several kinds on one mint come out in CHANGE_KINDS order', () => {
        const prev = row({ paused: false, uiMultiplier: '1', health: 'good', liquidity: 10000, venueSpreadPct: 1, frozenAccountsTop20: 0, clawback: false });
        const next = row({ paused: true, uiMultiplier: '1.2', health: 'warning', liquidity: 100, venueSpreadPct: 9, frozenAccountsTop20: 2, clawback: true });
        const kinds = kindsOf(prev, next);
        expect(kinds).toEqual(['paused', 'rebase', 'health-worse', 'liquidity-drop', 'spread-wide', 'frozen-appeared', 'control-change']);
        // And that order is exactly the declared one, not an accident of the call sequence.
        const declared = kinds.map((kind) => CHANGE_KINDS.indexOf(kind));
        expect(declared).toEqual([...declared].sort((a, b) => a - b));
    });

    test('two identical days produce no changes at all', () => {
        const rows = [row({ mint: 'A' }), row({ mint: 'B' })];
        expect(diffSnapshots(snap('2026-09-16', rows), snap('2026-09-17', rows)).changes).toEqual([]);
    });

    test('countByKind counts only kinds that occurred, in CHANGE_KINDS order', () => {
        const counts = countByKind([
            { kind: 'liquidity-drop' }, { kind: 'paused' }, { kind: 'liquidity-drop' }, { kind: 'new-mint' }
        ]);
        expect(counts).toEqual({ 'new-mint': 1, paused: 1, 'liquidity-drop': 2 });
        expect(Object.keys(counts)).toEqual(['new-mint', 'paused', 'liquidity-drop']);
        expect(countByKind([])).toEqual({});
        expect(countByKind(null)).toEqual({});
    });

    test('a missing snapshot on either side is an empty universe, not a crash', () => {
        expect(diffSnapshots(null, null)).toEqual({ from: null, to: null, changes: [] });
        const diff = diffSnapshots(null, snap('2026-09-17', [row({ mint: 'A' })]));
        expect(diff.changes.map((c) => c.kind)).toEqual(['new-mint']);
    });
});

// ----------------------------------------------------------- the new-mints feed

describe('selectNewMints', () => {
    const NOW = '2026-09-17T12:00:00Z';

    /** A stocks-tokens.json `.tokens[]` record, cut to what the feed reads. */
    function tok(mint, firstSeenAt, overrides = {}) {
        return { mint, symbol: `${mint}x`, name: `${mint} tokenized share`, issuer: 'xstocks-backed', firstSeenAt, ...overrides };
    }

    test('keeps only tokens first seen inside the window, newest first', () => {
        const rows = selectNewMints([
            tok('OLD', '2026-08-01T00:00:00Z'),
            tok('MID', '2026-09-10T00:00:00Z'),
            tok('NEWEST', '2026-09-17T09:00:00Z'),
            tok('YESTERDAY', '2026-09-16T20:27:15Z')
        ], { now: NOW });
        expect(rows.map((row) => row.mint)).toEqual(['NEWEST', 'YESTERDAY', 'MID']);
    });

    test('the window edge is inclusive, and a millisecond older is out', () => {
        const nowMs = Date.parse(NOW);
        const edge = new Date(nowMs - NEW_MINT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
        const justOutside = new Date(nowMs - NEW_MINT_WINDOW_DAYS * 24 * 60 * 60 * 1000 - 1).toISOString();
        const rows = selectNewMints([tok('EDGE', edge), tok('OUT', justOutside)], { now: NOW });
        expect(rows.map((row) => row.mint)).toEqual(['EDGE']);
    });

    test('a shorter window is honoured', () => {
        const rows = selectNewMints([tok('MID', '2026-09-10T00:00:00Z'), tok('NEW', '2026-09-17T09:00:00Z')], { now: NOW, windowDays: 3 });
        expect(rows.map((row) => row.mint)).toEqual(['NEW']);
    });

    test('a token with no firstSeenAt is excluded, never dated today', () => {
        const rows = selectNewMints([
            tok('NULLED', null),
            tok('BLANK', '   '),
            tok('UNPARSEABLE', 'not a date'),
            tok('REAL', '2026-09-17T09:00:00Z')
        ], { now: NOW });
        expect(rows.map((row) => row.mint)).toEqual(['REAL']);
    });

    test('carries the fields the strip renders, with the builder slug when one is given', () => {
        const rows = selectNewMints([tok('MINT_A', '2026-09-17T09:00:00Z', { symbol: 'AMD', issuer: 'backpack-securities' })], {
            now: NOW,
            slugs: new Map([['MINT_A', 'AMD-MINT_A']]),
            issuerNames: { 'backpack-securities': 'Backpack Securities' }
        });
        expect(rows).toEqual([{
            mint: 'MINT_A',
            symbol: 'AMD',
            name: 'MINT_A tokenized share',
            issuer: 'backpack-securities',
            issuerName: 'Backpack Securities',
            firstSeenAt: '2026-09-17T09:00:00Z',
            cardSlug: 'AMD-MINT_A'
        }]);
    });

    test('without a slug map the per-token card slug is used, and an unknown issuer name stays null', () => {
        const rows = selectNewMints([tok('MINT_B', '2026-09-17T09:00:00Z', { symbol: 'LUV', issuer: 'nobody' })], { now: NOW });
        expect(rows[0].cardSlug).toBe('LUV');
        expect(rows[0].issuerName).toBeNull();
    });

    test('same instant, two mints: ordered by mint so the file is stable', () => {
        const rows = selectNewMints([tok('ZZZ', '2026-09-17T09:00:00Z'), tok('AAA', '2026-09-17T09:00:00Z')], { now: NOW });
        expect(rows.map((row) => row.mint)).toEqual(['AAA', 'ZZZ']);
    });

    test('the founding cohort is excluded: first seen on the first recorded day proves nothing', () => {
        // On 2026-09-16 the pipeline recorded a universe for the first time, so all 441 mints then in
        // existence carry that day as firstSeenAt — a lower bound, not an arrival we watched. Without
        // this guard the strip would claim the whole universe was new.
        const rows = selectNewMints([
            tok('FOUNDING', '2026-09-16T20:27:15Z'),
            tok('EARLIER', '2026-09-15T00:00:00Z'),
            tok('AFTER', '2026-09-17T09:50:27Z')
        ], { now: NOW, recordsBeginOn: '2026-09-16' });
        expect(rows.map((row) => row.mint)).toEqual(['AFTER']);
        // Without the guard the same three are all inside the 14-day window.
        expect(selectNewMints([
            tok('FOUNDING', '2026-09-16T20:27:15Z'),
            tok('EARLIER', '2026-09-15T00:00:00Z'),
            tok('AFTER', '2026-09-17T09:50:27Z')
        ], { now: NOW }).map((row) => row.mint)).toEqual(['AFTER', 'FOUNDING', 'EARLIER']);
    });

    test('with no reference instant nothing is selected rather than a clock being invented', () => {
        expect(selectNewMints([tok('NEW', '2026-09-17T09:00:00Z')], {})).toEqual([]);
        expect(selectNewMints([tok('NEW', '2026-09-17T09:00:00Z')], { now: null })).toEqual([]);
        expect(selectNewMints(null, { now: NOW })).toEqual([]);
    });
});
