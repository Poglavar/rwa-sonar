// PURE reader for the Pyth "market schedule" string that every equity feed in the KEYLESS Hermes
// feed list carries at `attributes.schedule`, e.g.
//   America/New_York;0930-1600,0930-1600,0930-1600,0930-1600,0930-1600,C,C;0907/C,1127/0930-1300
// i.e. `<IANA timezone>;<7 weekly entries Mon..Sun>;<holiday overrides MMDD/...>`, where an entry
// is `C` (closed all day), `HHMM-HHMM`, or several such ranges joined by `&` (a lunch break).
// That lets a trade timestamp be placed in the underlying market's open / closed / holiday session
// with no Pyth key, no dependency and no clock: every function takes the instant to judge as a
// parameter. Unparseable text yields null rather than throwing. Tested in ../market-hours.test.js.

const MINUTES_PER_DAY = 24 * 60;

// Intl weekday:'short' in en-US. The schedule lists Monday first, JS counts Sunday first, so the
// mapping is written out rather than derived from getDay() — which would be the wrong day anyway,
// since the day that matters is the one in the schedule's own timezone.
const WEEKDAY_INDEX = new Map([['Mon', 0], ['Tue', 1], ['Wed', 2], ['Thu', 3], ['Fri', 4], ['Sat', 5], ['Sun', 6]]);

const SESSION_LABELS = {
    open: 'underlying market open',
    closed: 'underlying market closed',
    holiday: 'market holiday',
    unknown: 'schedule unknown'
};

/** `HHMM` → minutes since local midnight, or null when it is not a real time of day. */
function parseHhmm(text) {
    if (typeof text !== 'string' || !/^\d{4}$/.test(text)) return null;
    const hours = Number(text.slice(0, 2));
    const minutes = Number(text.slice(2));
    if (minutes > 59) return null;
    // 2400 appears as a close time ("open until end of day") and is the only legal hour 24.
    if (hours > 24 || (hours === 24 && minutes !== 0)) return null;
    return hours * 60 + minutes;
}

/**
 * One day entry: `null` for `C` (closed all day), an array of `{open, close}` HHMM strings
 * otherwise. Returns `undefined` — distinct from the `null` that MEANS closed — when the text is
 * not a valid entry, so a caller can reject the whole schedule instead of silently reading a
 * malformed day as a closed one.
 */
function parseDayEntry(text) {
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (trimmed === '') return undefined;
    if (trimmed.toUpperCase() === 'C') return null;
    const ranges = [];
    for (const part of trimmed.split('&')) {
        const halves = part.trim().split('-');
        if (halves.length !== 2) return undefined;
        const open = halves[0].trim();
        const close = halves[1].trim();
        if (parseHhmm(open) === null || parseHhmm(close) === null) return undefined;
        ranges.push({ open, close });
    }
    return ranges;
}

function isValidTimeZone(timezone) {
    if (typeof timezone !== 'string' || timezone === '') return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone });
        return true;
    } catch {
        return false;
    }
}

/**
 * Parse a schedule string into `{ timezone, weekly: [7 entries Mon..Sun], holidays: Map }`, or
 * null when anything about it is unparseable — an unknown timezone, a day count other than 7, a
 * bad HHMM. Null means "we do not know this market's hours", which every caller must treat as
 * unknown rather than as closed.
 */
export function parseSchedule(text) {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (trimmed === '') return null;

    const parts = trimmed.split(';');
    // The holiday section is optional; anything beyond it is a format we do not recognise.
    if (parts.length < 2 || parts.length > 3) return null;

    const timezone = parts[0].trim();
    if (!isValidTimeZone(timezone)) return null;

    const weeklyText = parts[1].split(',');
    if (weeklyText.length !== 7) return null;
    const weekly = [];
    for (const dayText of weeklyText) {
        const entry = parseDayEntry(dayText);
        if (entry === undefined) return null;
        weekly.push(entry);
    }

    const holidays = new Map();
    const holidayText = (parts[2] ?? '').trim();
    if (holidayText !== '') {
        for (const item of holidayText.split(',')) {
            const override = item.trim();
            if (override === '') continue;
            const slash = override.indexOf('/');
            if (slash === -1) return null;
            const mmdd = override.slice(0, slash).trim();
            if (!/^\d{4}$/.test(mmdd)) return null;
            const month = Number(mmdd.slice(0, 2));
            const day = Number(mmdd.slice(2));
            if (month < 1 || month > 12 || day < 1 || day > 31) return null;
            const entry = parseDayEntry(override.slice(slash + 1));
            if (entry === undefined) return null;
            holidays.set(mmdd, entry);
        }
    }

    return { timezone, weekly, holidays };
}

/** Open is INCLUSIVE, close EXCLUSIVE: 09:30:00 is open, 16:00:00 is already closed. */
function withinRanges(ranges, minuteOfDay) {
    if (!Array.isArray(ranges)) return false;
    for (const range of ranges) {
        const open = parseHhmm(range?.open);
        let close = parseHhmm(range?.close);
        if (open === null || close === null) continue;
        // `1700-0000` — a Sunday evening session that runs to midnight — closes at end of day.
        if (close <= open) close += MINUTES_PER_DAY;
        if (minuteOfDay >= open && minuteOfDay < close) return true;
    }
    return false;
}

// One Intl formatter per timezone: building one costs far more than formatting with it, and 2465
// trades against a dozen feeds would otherwise build it 2465 times. Memoisation only — the same
// instant always yields the same answer.
const formatterCache = new Map();

function localPartsAt(timezone, atMs) {
    let formatter = formatterCache.get(timezone);
    if (formatter === undefined) {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            weekday: 'short',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23'
        });
        formatterCache.set(timezone, formatter);
    }
    const out = {};
    for (const part of formatter.formatToParts(new Date(atMs))) out[part.type] = part.value;
    return out;
}

/**
 * Which session the instant `atMs` (unix ms) falls in for a parsed schedule:
 * `'open'`, `'closed'`, `'holiday'`, or `'unknown'` when the schedule is null/unusable. A holiday
 * override of `C` is reported as `'holiday'` in its own right; one carrying a range (an early
 * close) is `'open'` inside that range and `'closed'` outside it, because a half day IS a trading
 * day. The instant is converted into the schedule's own timezone, so DST is handled by Intl.
 */
export function sessionAt(schedule, atMs) {
    if (!schedule || typeof schedule !== 'object' || !Array.isArray(schedule.weekly) || schedule.weekly.length !== 7) return 'unknown';
    if (typeof atMs !== 'number' || !Number.isFinite(atMs)) return 'unknown';

    let parts = null;
    try {
        parts = localPartsAt(schedule.timezone, atMs);
    } catch {
        return 'unknown';
    }
    const weekdayIndex = WEEKDAY_INDEX.get(parts.weekday);
    const hour = Number(parts.hour);
    const minute = Number(parts.minute);
    if (weekdayIndex === undefined || !Number.isFinite(hour) || !Number.isFinite(minute)) return 'unknown';
    const minuteOfDay = (hour % 24) * 60 + minute;

    const holidays = schedule.holidays instanceof Map ? schedule.holidays : new Map();
    const mmdd = `${parts.month}${parts.day}`;
    if (holidays.has(mmdd)) {
        const entry = holidays.get(mmdd);
        if (entry === null) return 'holiday';
        return withinRanges(entry, minuteOfDay) ? 'open' : 'closed';
    }

    const weekdayEntry = schedule.weekly[weekdayIndex] ?? null;
    if (weekdayEntry === null) return 'closed';
    return withinRanges(weekdayEntry, minuteOfDay) ? 'open' : 'closed';
}

/** Short human text for a session, for logs and the UI. */
export function sessionLabel(session) {
    return SESSION_LABELS[session] ?? SESSION_LABELS.unknown;
}
