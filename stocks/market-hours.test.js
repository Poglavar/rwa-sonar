// Unit tests for the pure Pyth market-schedule reader (lib/market-hours.mjs). All three schedule
// strings are VERBATIM `attributes.schedule` values from the public Hermes equity feed list read
// on 2026-09-16 (stocks/data/raw/pyth-feeds-2026-09-16.json): the US equity one carried by TSLA
// and every other NYSE/Nasdaq feed, the Hong Kong one whose lunch break is the `&` double-range
// case, and the CME-style America/Chicago one whose Sunday session `1700-0000` closes at midnight.
//
// Every instant is written with the explicit UTC offset that was in force on that date — EDT is
// UTC−4 in September, EST is UTC−5 in November, Hong Kong is UTC+8 all year — so the test states
// the wall-clock time it means and still pins one exact instant.

const { parseSchedule, sessionAt, sessionLabel } = require('./lib/market-hours.mjs');

// TSLA, and 1100+ other US equity feeds. 0907 = Labor Day, 1127 = the half day after
// Thanksgiving, 1224 = Christmas Eve.
const US_EQUITY = 'America/New_York;0930-1600,0930-1600,0930-1600,0930-1600,0930-1600,C,C;0907/C,1126/C,1127/0930-1300,1224/0930-1300,1225/C,0101/C,0118/C,0215/C,0326/C,0531/C,0618/C,0705/C';

// Hong Kong equities: 09:30–12:00, lunch, 13:00–16:00.
const HONG_KONG = 'Asia/Hong_Kong;0930-1200&1300-1600,0930-1200&1300-1600,0930-1200&1300-1600,0930-1200&1300-1600,0930-1200&1300-1600,C,C;0101/C,0216/0930-1200,0217/C,0218/C,0219/C,0403/C,0406/C,0407/C,0501/C,0525/C,0619/C,0701/C,1001/C,1019/C,1224/0930-1200,1225/C,1231/0930-1200';

// A futures-style schedule: an overnight break each weekday, Saturday closed, and a Sunday
// evening session that opens at 17:00 and runs to midnight (`1700-0000`).
const CHICAGO_FUTURES = 'America/Chicago;0000-1600&1700-2400,0000-1600&1700-2400,0000-1600&1700-2400,0000-1600&1700-2400,0000-1600,C,1700-0000;0403/0000-0830,0525/0000-1030&1700-2400,0526/0000-0830&1700-2400,0619/0000-1030,0703/0000-1030,0907/0000-1030&1700-2400,0908/0000-0830&1700-2400,1126/0000-1030&1700-2400,1127/0000-1215,1224/0000-1215,1225/C';

const at = (text) => Date.parse(text);

describe('parseSchedule', () => {
    test('reads the US equity schedule into a timezone, 7 weekly entries and the holiday overrides', () => {
        const schedule = parseSchedule(US_EQUITY);
        expect(schedule.timezone).toBe('America/New_York');
        expect(schedule.weekly).toHaveLength(7);
        // Mon..Fri identical, Sat and Sun closed — null, not an empty array.
        expect(schedule.weekly[0]).toEqual([{ open: '0930', close: '1600' }]);
        expect(schedule.weekly[4]).toEqual([{ open: '0930', close: '1600' }]);
        expect(schedule.weekly[5]).toBe(null);
        expect(schedule.weekly[6]).toBe(null);
        expect(schedule.holidays.size).toBe(12);
        expect(schedule.holidays.get('0907')).toBe(null);
        expect(schedule.holidays.get('1127')).toEqual([{ open: '0930', close: '1300' }]);
        expect(schedule.holidays.has('0916')).toBe(false);
    });

    test('reads an & double range as two ranges in order', () => {
        const schedule = parseSchedule(HONG_KONG);
        expect(schedule.timezone).toBe('Asia/Hong_Kong');
        expect(schedule.weekly[0]).toEqual([{ open: '0930', close: '1200' }, { open: '1300', close: '1600' }]);
        expect(schedule.holidays.get('0216')).toEqual([{ open: '0930', close: '1200' }]);
    });

    test('accepts 2400 and 0000 as close times', () => {
        const schedule = parseSchedule(CHICAGO_FUTURES);
        expect(schedule.weekly[0]).toEqual([{ open: '0000', close: '1600' }, { open: '1700', close: '2400' }]);
        expect(schedule.weekly[5]).toBe(null);
        expect(schedule.weekly[6]).toEqual([{ open: '1700', close: '0000' }]);
        expect(schedule.holidays.get('0525')).toEqual([{ open: '0000', close: '1030' }, { open: '1700', close: '2400' }]);
    });

    test('a schedule with no holiday section is still valid', () => {
        const schedule = parseSchedule('America/New_York;0930-1600,0930-1600,0930-1600,0930-1600,0930-1600,C,C');
        expect(schedule.timezone).toBe('America/New_York');
        expect(schedule.holidays.size).toBe(0);
    });

    test('returns null instead of throwing on anything unparseable', () => {
        expect(parseSchedule('not a schedule at all')).toBe(null);
        expect(parseSchedule('')).toBe(null);
        expect(parseSchedule(null)).toBe(null);
        expect(parseSchedule(undefined)).toBe(null);
        expect(parseSchedule(42)).toBe(null);
        expect(parseSchedule({ timezone: 'America/New_York' })).toBe(null);
        // unknown timezone
        expect(parseSchedule('Mars/Olympus_Mons;0930-1600,C,C,C,C,C,C;')).toBe(null);
        // six weekly entries, not seven
        expect(parseSchedule('America/New_York;0930-1600,0930-1600,0930-1600,0930-1600,0930-1600,C;')).toBe(null);
        // impossible times
        expect(parseSchedule('America/New_York;0961-1600,C,C,C,C,C,C;')).toBe(null);
        expect(parseSchedule('America/New_York;2500-2600,C,C,C,C,C,C;')).toBe(null);
        expect(parseSchedule('America/New_York;930-1600,C,C,C,C,C,C;')).toBe(null);
        // a day entry that is neither C nor a range
        expect(parseSchedule('America/New_York;open,C,C,C,C,C,C;')).toBe(null);
        // malformed holiday overrides
        expect(parseSchedule('America/New_York;0930-1600,C,C,C,C,C,C;0907')).toBe(null);
        expect(parseSchedule('America/New_York;0930-1600,C,C,C,C,C,C;1332/C')).toBe(null);
        expect(parseSchedule('America/New_York;0930-1600,C,C,C,C,C,C;0907/nope')).toBe(null);
    });
});

describe('sessionAt — US equities', () => {
    const schedule = parseSchedule(US_EQUITY);

    test('a Saturday is closed', () => {
        expect(sessionAt(schedule, at('2026-09-19T15:00:00-04:00'))).toBe('closed');
    });

    test('a Sunday is closed', () => {
        expect(sessionAt(schedule, at('2026-09-20T11:00:00-04:00'))).toBe('closed');
    });

    test('the open is inclusive and the close is exclusive on a normal Thursday', () => {
        expect(sessionAt(schedule, at('2026-09-17T09:29:00-04:00'))).toBe('closed');
        expect(sessionAt(schedule, at('2026-09-17T09:30:00-04:00'))).toBe('open');
        expect(sessionAt(schedule, at('2026-09-17T15:59:00-04:00'))).toBe('open');
        expect(sessionAt(schedule, at('2026-09-17T16:00:00-04:00'))).toBe('closed');
    });

    test('a 0907/C holiday override beats the weekday entry', () => {
        // Labor Day 2026 is Monday 7 September; the Monday a week later is an ordinary session.
        expect(sessionAt(schedule, at('2026-09-07T10:00:00-04:00'))).toBe('holiday');
        expect(sessionAt(schedule, at('2026-09-07T20:00:00-04:00'))).toBe('holiday');
        expect(sessionAt(schedule, at('2026-09-14T10:00:00-04:00'))).toBe('open');
    });

    test('a half-day override closes early and is still a trading day', () => {
        // 1127/0930-1300 — the Friday after Thanksgiving, in EST (UTC-5).
        expect(sessionAt(schedule, at('2026-11-27T09:30:00-05:00'))).toBe('open');
        expect(sessionAt(schedule, at('2026-11-27T12:59:00-05:00'))).toBe('open');
        expect(sessionAt(schedule, at('2026-11-27T13:00:00-05:00'))).toBe('closed');
        expect(sessionAt(schedule, at('2026-11-27T15:30:00-05:00'))).toBe('closed');
        // Thanksgiving itself, 1126/C.
        expect(sessionAt(schedule, at('2026-11-26T11:00:00-05:00'))).toBe('holiday');
    });

    test('the instant is judged in New York, not UTC', () => {
        // 21:00 UTC is 17:00 in New York: after the close, though still the same calendar day.
        expect(sessionAt(schedule, Date.parse('2026-09-17T21:00:00Z'))).toBe('closed');
        expect(sessionAt(schedule, Date.parse('2026-09-17T19:59:00Z'))).toBe('open');
    });
});

describe('sessionAt — & double ranges and midnight closes', () => {
    test('the Hong Kong lunch break is closed between two open sessions', () => {
        const schedule = parseSchedule(HONG_KONG);
        expect(sessionAt(schedule, at('2026-09-17T11:00:00+08:00'))).toBe('open');
        expect(sessionAt(schedule, at('2026-09-17T12:00:00+08:00'))).toBe('closed');
        expect(sessionAt(schedule, at('2026-09-17T12:30:00+08:00'))).toBe('closed');
        expect(sessionAt(schedule, at('2026-09-17T13:00:00+08:00'))).toBe('open');
        expect(sessionAt(schedule, at('2026-09-17T15:59:00+08:00'))).toBe('open');
        expect(sessionAt(schedule, at('2026-09-17T16:00:00+08:00'))).toBe('closed');
    });

    test('a 1700-0000 Sunday session runs to midnight', () => {
        const schedule = parseSchedule(CHICAGO_FUTURES);
        expect(sessionAt(schedule, at('2026-09-20T16:30:00-05:00'))).toBe('closed');
        expect(sessionAt(schedule, at('2026-09-20T17:00:00-05:00'))).toBe('open');
        expect(sessionAt(schedule, at('2026-09-20T23:59:00-05:00'))).toBe('open');
        // Saturday is C even in a schedule that trades nearly round the clock.
        expect(sessionAt(schedule, at('2026-09-19T17:30:00-05:00'))).toBe('closed');
        // Weekday overnight break: 16:00-17:00 Chicago.
        expect(sessionAt(schedule, at('2026-09-17T16:30:00-05:00'))).toBe('closed');
        expect(sessionAt(schedule, at('2026-09-17T03:00:00-05:00'))).toBe('open');
    });
});

describe('sessionAt — unknown', () => {
    test('a null or unusable schedule is unknown, never closed', () => {
        const when = at('2026-09-17T12:00:00-04:00');
        expect(sessionAt(parseSchedule('garbage'), when)).toBe('unknown');
        expect(sessionAt(null, when)).toBe('unknown');
        expect(sessionAt(undefined, when)).toBe('unknown');
        expect(sessionAt({}, when)).toBe('unknown');
        expect(sessionAt({ timezone: 'America/New_York', weekly: [null, null] }, when)).toBe('unknown');
    });

    test('a non-finite instant is unknown', () => {
        const schedule = parseSchedule(US_EQUITY);
        expect(sessionAt(schedule, Number.NaN)).toBe('unknown');
        expect(sessionAt(schedule, Date.parse('not a date'))).toBe('unknown');
        expect(sessionAt(schedule, null)).toBe('unknown');
        expect(sessionAt(schedule, '2026-09-17T12:00:00Z')).toBe('unknown');
    });
});

describe('sessionLabel', () => {
    test('names every session and falls back to unknown', () => {
        expect(sessionLabel('open')).toBe('underlying market open');
        expect(sessionLabel('closed')).toBe('underlying market closed');
        expect(sessionLabel('holiday')).toBe('market holiday');
        expect(sessionLabel('unknown')).toBe('schedule unknown');
        expect(sessionLabel('nonsense')).toBe('schedule unknown');
        expect(sessionLabel(null)).toBe('schedule unknown');
    });
});
