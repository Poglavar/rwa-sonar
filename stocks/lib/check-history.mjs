// The document watcher's per-day check history, kept compactly before its daily checkpoints
// (stocks/data/raw/sources-<date>.json, the layout before 2026-11-23) are deleted: each checkpoint
// is the only record of what every source looked like on that day (sonar.source holds only the
// latest look, sonar.source_version only new content). Per day and source only the fields stored
// nowhere else are kept, and consecutive days with the same values collapse into one run, so an
// unchanged source is one line, not one copy per day. Pure: unit tested in check-history.test.js;
// stocks/prune-run-caches.mjs does the IO and refuses to delete a checkpoint the history does not
// reproduce exactly.

/**
 * The kept fields, in run order after [fromDate, toDate]. Why each one:
 * status       the day's outcome (ok, changed, blocked, unreadable, reachable-unverified, gone,
 *              error, throttled); only the latest is in sonar.source.
 * httpStatus   what the host answered that day (200, 304, 403 bot wall, 429, 404 ...).
 * contentHash  the first 16 hex digits of the text hash the day's look stood on: enough to tell days
 *              apart and to find the version (sonar.source_version.content_hash LIKE 'prefix%'),
 *              which holds the full hash; the full one would be half the file (~120 sources a
 *              day read as `changed`, each run with its own hash).
 * error        why the look did not read the document: the checkpoint's `error`, else its `reason`
 *              for a status that is not a read (ok/changed reasons are boilerplate like "same hash").
 * via          which reader produced the text (html, pdf, api, notion, next-flight, wayback = the
 *              live host refused us and a capture was read); null for a 304.
 * quotesLost   ids of the dossier quotes not found that day, null when none were lost.
 * Left out, because they are stored elsewhere or are per-run noise: url/title/issuer/foundIn
 * (sonar.source by id), diff/bytes/textChars/rawPath/textPath/etag/lastModified of a new version
 * (sonar.source_version), archive URLs and history (sonar.source, sources-state.json), the fetch
 * time of day inside a run (the nightly run; a run keeps its first and last date), normaliser and
 * capture details.
 */
export const FIELDS = ['status', 'httpStatus', 'contentHash', 'error', 'via', 'quotesLost'];

const READ_STATUSES = new Set(['ok', 'changed']);
export const HASH_DIGITS = 16;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The kept row for one checkpoint result. Throws on a result that is not one (no id or status). */
export function checkRow(result) {
    if (!result || typeof result.id !== 'string' || !result.id || typeof result.status !== 'string' || !result.status) {
        throw new Error(`not a source result: ${JSON.stringify(result)?.slice(0, 120)}`);
    }
    const lost = Array.isArray(result.quotes?.lost) ? result.quotes.lost.map((q) => q.id).filter(Boolean).sort() : [];
    return {
        status: result.status,
        httpStatus: Number.isInteger(result.httpStatus) ? result.httpStatus : null,
        contentHash: typeof result.contentHash === 'string' ? result.contentHash.slice(0, HASH_DIGITS) : null,
        error: result.error ?? (READ_STATUSES.has(result.status) ? null : (result.reason ?? null)),
        via: result.via ?? null,
        quotesLost: lost.length ? lost : null
    };
}

/**
 * One day's checkpoint (an object keyed by URL, each value one source's result) as Map(id → row).
 * Throws on anything else, and on two results with the same source id, so a checkpoint the
 * extraction cannot read is never counted as extracted.
 */
export function checkpointRows(doc) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('checkpoint is not an object keyed by URL');
    const rows = new Map();
    for (const [url, result] of Object.entries(doc)) {
        const row = checkRow(result);
        if (result.url !== undefined && result.url !== url) throw new Error(`checkpoint key ${url} holds the result for ${result.url}`);
        if (rows.has(result.id)) throw new Error(`source id ${result.id} appears twice`);
        rows.set(result.id, row);
    }
    return rows;
}

/** An empty history. */
export function emptyHistory() {
    return { dates: [], sources: {} };
}

/** A history as Map(date → Map(id → row)): every day of every run, written out. */
export function expandHistory(history) {
    const days = new Map(history.dates.map((d) => [d, new Map()]));
    const index = new Map(history.dates.map((d, i) => [d, i]));
    for (const [id, runs] of Object.entries(history.sources)) {
        for (const run of runs) {
            const [from, to, ...values] = run;
            const start = index.get(from);
            const end = index.get(to);
            if (start === undefined || end === undefined || end < start) throw new Error(`run ${from}..${to} of ${id} is outside the history's dates`);
            const row = Object.fromEntries(FIELDS.map((f, i) => [f, values[i] ?? null]));
            for (let i = start; i <= end; i += 1) days.get(history.dates[i]).set(id, row);
        }
    }
    return days;
}

const sameRow = (a, b) => FIELDS.every((f) => JSON.stringify(a[f] ?? null) === JSON.stringify(b[f] ?? null));

/**
 * The compact history of Map(date → Map(id → row)): per source, runs of consecutive dates (adjacent
 * in the history's own date list) with identical rows. A day a source was not looked at breaks its
 * run, so expanding the history gives back exactly the days it was built from.
 */
export function compileHistory(days) {
    const dates = [...days.keys()].sort();
    for (const d of dates) if (!DATE_RE.test(d)) throw new Error(`not a date: ${d}`);
    const sources = {};
    const open = new Map();
    dates.forEach((date, i) => {
        for (const [id, row] of days.get(date)) {
            const current = open.get(id);
            if (current && current.lastIndex === i - 1 && sameRow(current.row, row)) {
                current.run[1] = date;
                current.lastIndex = i;
                continue;
            }
            const run = [date, date, ...FIELDS.map((f) => row[f] ?? null)];
            (sources[id] ??= []).push(run);
            open.set(id, { run, row, lastIndex: i });
        }
    });
    const sorted = {};
    for (const id of Object.keys(sources).sort()) sorted[id] = sources[id];
    return { dates, sources: sorted };
}

/** `history` with the given days added (a date already present is replaced by the new rows). */
export function mergeDays(history, newDays) {
    const days = expandHistory(history);
    for (const [date, rows] of newDays) days.set(date, new Map(rows));
    return compileHistory(days);
}

/**
 * What the history fails to reproduce of one day's checkpoint rows: a list of { id, problem }
 * (empty when the day is covered exactly — every source with identical values, and no extra one).
 * `expanded` is expandHistory(history), passed in so a run over many days expands once.
 */
export function uncoveredRows(expanded, date, rows) {
    const day = expanded.get(date);
    if (!day) return [{ id: null, problem: `date ${date} is not in the history` }];
    const problems = [];
    for (const [id, row] of rows) {
        const kept = day.get(id);
        if (!kept) problems.push({ id, problem: 'missing' });
        else if (!sameRow(kept, row)) problems.push({ id, problem: 'differs' });
    }
    for (const id of day.keys()) if (!rows.has(id)) problems.push({ id, problem: 'not in the checkpoint' });
    return problems;
}

/**
 * The history file's text: a header and one line per source, so it stays readable and diffable
 * without one line per day. `about` says what the file is.
 */
export function serializeHistory(history, about) {
    const ids = Object.keys(history.sources);
    const lines = ids.map((id, i) => `    ${JSON.stringify(id)}: ${JSON.stringify(history.sources[id])}${i < ids.length - 1 ? ',' : ''}`);
    return [
        '{',
        `  "about": ${JSON.stringify(about)},`,
        `  "fields": ${JSON.stringify(['fromDate', 'toDate', ...FIELDS])},`,
        `  "dates": ${JSON.stringify(history.dates)},`,
        '  "sources": {',
        ...lines,
        '  }',
        '}',
        ''
    ].join('\n');
}

/** A history file's parsed JSON back to { dates, sources }; checks the field layout matches. */
export function parseHistory(doc) {
    const want = JSON.stringify(['fromDate', 'toDate', ...FIELDS]);
    if (JSON.stringify(doc?.fields) !== want) throw new Error(`history fields ${JSON.stringify(doc?.fields)} are not ${want}`);
    if (!Array.isArray(doc.dates) || !doc.sources || typeof doc.sources !== 'object') throw new Error('history has no dates/sources');
    return { dates: doc.dates, sources: doc.sources };
}
