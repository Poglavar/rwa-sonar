// The document watcher's per-day check history (stocks/data/source-check-history.json): each day's
// checkpoint is the only record of what every source looked like that day (sonar.source holds only
// the latest look, sonar.source_version only new content), so before a checkpoint goes its days are
// kept here. Per day and source only the fields stored nowhere else are kept, and consecutive days
// with the same values collapse into one run, so an unchanged source is one line, not one copy per
// day. Two writers: stocks/prune-run-caches.mjs (the dated checkpoints of the layout before
// 2026-11-23) and stocks/watch-sources.mjs, which folds the previous day's checkpoint in when a new
// day starts (`foldCheckpoints`). Both write through `appendDaysVerified`, which reads the file back
// and reports any day it does not reproduce exactly. The functions above the IO section are pure;
// all are unit tested in check-history.test.js.

import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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

/**
 * `history` with the given days added. A date already present keeps its sources and takes the new
 * rows over them (a run that finished after its day was folded adds to that day, never replaces it).
 */
export function mergeDays(history, newDays) {
    const days = expandHistory(history);
    for (const [date, rows] of newDays) days.set(date, new Map([...(days.get(date) ?? []), ...rows]));
    return compileHistory(days);
}

/**
 * What the history fails to reproduce of one day's checkpoint rows: a list of { id, problem }
 * (empty when the day is covered — every source of the checkpoint with identical values; the day
 * may hold more sources, from another run of the same day).
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

/** One day's rows from either checkpoint layout: `{ date, results }` (since 2026-11-23) or the URL map. */
export function checkpointDocRows(doc) {
    return checkpointRows(doc && typeof doc.date === 'string' && doc.results ? doc.results : doc);
}

// ---------------------------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------------------------

export const HISTORY_ABOUT = 'Per-day document-watch outcomes, one entry per source and run of equal days, '
    + 'kept from the watcher\'s daily checkpoints (stocks/watch-sources.mjs folds each finished day in; '
    + 'stocks/prune-run-caches.mjs folded the dated sources-<date>.json files before deleting them). '
    + 'sources: source id (sonar.source.id) -> runs; fields and why they were kept: stocks/lib/check-history.mjs.';

/** The history file as { dates, sources }; an absent file is an empty history, a broken one throws. */
export async function readHistory(path) {
    try {
        return parseHistory(JSON.parse(await readFile(path, 'utf8')));
    } catch (err) {
        if (err.code === 'ENOENT') return emptyHistory();
        throw err;
    }
}

/**
 * Merge `days` (Map(date -> Map(id -> row))) into the history file, then read the file back and
 * check every one of those days is reproduced exactly. Returns { written, history, problems }:
 * `problems` lists [{ date, problem }] (empty = every day is kept); `written` is false when the
 * merged history is what the file already held (nothing is rewritten).
 */
export async function appendDaysVerified(historyFile, days) {
    let before = null;
    try {
        before = await readFile(historyFile, 'utf8');
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
    const existing = before === null ? emptyHistory() : parseHistory(JSON.parse(before));
    const merged = days.size ? mergeDays(existing, days) : existing;
    const text = serializeHistory(merged, HISTORY_ABOUT);
    const written = days.size > 0 && text !== before;
    if (written) {
        const tmp = `${historyFile}.${process.pid}.tmp`;
        await writeFile(tmp, text, 'utf8');
        await rename(tmp, historyFile);
    }
    const expanded = expandHistory(await readHistory(historyFile));
    const problems = [];
    for (const [date, rows] of days) {
        const missing = uncoveredRows(expanded, date, rows);
        if (missing.length) problems.push({ date, problem: `${missing.length} source(s) not reproduced, e.g. ${missing.slice(0, 3).map((p) => `${p.id ?? ''} ${p.problem}`.trim()).join('; ')}` });
    }
    return { written, history: merged, problems };
}

const UNFOLDED_RE = /^sources-unfolded-(\d{4}-\d{2}-\d{2})\.json$/;

/**
 * The watcher's start-of-run step: a checkpoint (`checkpointFile`, `{ date, results }`) left by an
 * earlier day is moved aside to `<rawDir>/sources-unfolded-<date>.json`, so today's run starts its
 * own checkpoint at once, and every such file is then folded into the history and deleted once the
 * history is verified to reproduce it. A file that cannot be folded stays where it is and is tried
 * again next run, so a failure here costs neither the day nor today's fetching. Never throws:
 * returns { folded: [date], failed: [{ name, problem }] }.
 */
export async function foldCheckpoints({ rawDir, checkpointFile, historyFile, today }) {
    const folded = [];
    const failed = [];
    try {
        let doc = null;
        try {
            doc = JSON.parse(await readFile(checkpointFile, 'utf8'));
        } catch (err) {
            // Absent: nothing to fold. Unreadable: moved aside below, so the fold reports it.
            if (err.code !== 'ENOENT') doc = { date: 'unreadable' };
        }
        if (doc && doc.date !== today) {
            // A checkpoint without a date cannot be folded; it is kept aside and reported every run.
            const date = /^\d{4}-\d{2}-\d{2}$/.test(doc.date ?? '') ? doc.date : `undated-${Date.now()}`;
            try {
                await rename(checkpointFile, join(rawDir, `sources-unfolded-${date}.json`));
            } catch (err) {
                // A concurrent run of the same day moved it first.
                if (err.code !== 'ENOENT') throw err;
            }
        }
        let names = [];
        try {
            names = await readdir(rawDir);
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
        }
        const pending = names.filter((n) => n.startsWith('sources-unfolded-') && n.endsWith('.json')).sort();
        const days = new Map();
        const files = new Map();
        for (const name of pending) {
            try {
                const m = UNFOLDED_RE.exec(name);
                if (!m) throw new Error('the checkpoint carried no date');
                const doc = JSON.parse(await readFile(join(rawDir, name), 'utf8'));
                days.set(m[1], checkpointDocRows(doc));
                files.set(m[1], name);
            } catch (err) {
                failed.push({ name, problem: err.message });
            }
        }
        if (days.size) {
            const { problems } = await appendDaysVerified(historyFile, days);
            const bad = new Set(problems.map((p) => p.date));
            for (const p of problems) failed.push({ name: files.get(p.date), problem: p.problem });
            for (const [date, name] of files) {
                if (bad.has(date)) continue;
                await rm(join(rawDir, name), { force: true });
                folded.push(date);
            }
        }
    } catch (err) {
        failed.push({ name: 'check-history', problem: err.message });
    }
    return { folded, failed };
}
