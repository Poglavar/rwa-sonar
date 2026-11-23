#!/usr/bin/env node
// One-off cleanup of the per-day run caches the watchers left behind before 2026-11-23, when they
// stopped writing a new near-copy every day: the document watcher's stocks/data/raw/sources-<date>.json
// checkpoints and the corporate-action watcher's stocks/data/raw/corporate-actions/<date>/
// response directories. Today's are kept. Dry run by default (prints what it would remove and how
// much space that frees); --apply deletes. Idempotent: a second run finds nothing.
// The daily checkpoints are the only record of each source's per-day status, so before any of them
// is deleted their kept fields are extracted into stocks/data/source-check-history.json
// (lib/check-history.mjs), the file is read back from disk, and every checkpoint is checked to be
// reproduced exactly by it; if one is not (or cannot be read), nothing at all is deleted.

import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { appendDaysVerified, checkpointDocRows, expandHistory, HISTORY_ABOUT, mergeDays, readHistory, serializeHistory, uncoveredRows } from './lib/check-history.mjs';
import { isoDate, log, logError, parseArgs } from './lib/io.mjs';
import { planDatedCachePrune } from './lib/raw-keep.mjs';

const REPO = join(import.meta.dirname, '..');
const RAW_DIR = join(REPO, 'stocks', 'data', 'raw');
const HISTORY_FILE = join(REPO, 'stocks', 'data', 'source-check-history.json');

function usage() {
    console.log(`prune-run-caches.mjs — remove the per-day run caches older than today (layout before 2026-11-23)

USAGE
  node stocks/prune-run-caches.mjs [--apply]

  Without --apply: lists what would be removed, with counts and sizes, and removes nothing.
  --apply           Delete them.
  --help            This text.

REMOVES
  ${relative(REPO, RAW_DIR)}/sources-<date>.json            the document watcher's old daily checkpoints
  ${relative(REPO, join(RAW_DIR, 'corporate-actions'))}/<date>/   the corporate-action watcher's old daily responses
  Everything dated today is kept. Nothing else is touched.

KEEPS FIRST
  ${relative(REPO, HISTORY_FILE)}   each checkpoint's per-day status, hash, HTTP status, error,
                    reader and lost quotes per source, as runs of equal days. With --apply it is
                    written and read back before anything is deleted; a checkpoint it does not
                    reproduce exactly (or one that cannot be read) stops the run: nothing is deleted.`);
}

async function sizeOf(path) {
    const info = await stat(path);
    if (!info.isDirectory()) return info.size;
    let total = 0;
    for (const name of await readdir(path)) total += await sizeOf(join(path, name));
    return total;
}

const checkpointDate = (name) => /^sources-(\d{4}-\d{2}-\d{2})\.json$/.exec(name)[1];

/** Each checkpoint's rows; a checkpoint that cannot be read or parsed is a failure, not an empty day. */
async function readCheckpoints(checkpoints) {
    const days = new Map();
    const failures = [];
    for (const e of checkpoints) {
        try {
            days.set(checkpointDate(e.name), checkpointDocRows(JSON.parse(await readFile(e.path, 'utf8'))));
        } catch (err) {
            failures.push({ name: e.name, problem: err.message });
        }
    }
    return { days, failures };
}

/**
 * The whole job over `rawDir`. Returns { doomed, removed, historyBytes, refused, failures }.
 * Dry run (apply false) writes nothing; apply writes the history, verifies it from disk, and only
 * then deletes — or, on any failure, deletes nothing and returns `refused: true`.
 */
export async function pruneRunCaches({ rawDir = RAW_DIR, historyFile = HISTORY_FILE, today = isoDate(), apply = false } = {}) {
    const areas = { raw: rawDir, 'corporate-actions': join(rawDir, 'corporate-actions') };
    const entries = [];
    for (const [area, dir] of Object.entries(areas)) {
        let names = [];
        try {
            names = await readdir(dir);
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
        }
        for (const name of names) entries.push({ area, name, path: join(dir, name) });
    }
    const doomed = planDatedCachePrune(entries, { today });
    for (const e of doomed) e.bytes = await sizeOf(e.path);
    const checkpoints = doomed.filter((e) => e.area === 'raw');

    const existing = await readHistory(historyFile);
    const { days, failures } = await readCheckpoints(checkpoints);
    const history = days.size ? mergeDays(existing, days) : existing;
    const text = serializeHistory(history, HISTORY_ABOUT);
    const historyBytes = Buffer.byteLength(text);
    if (!apply) {
        // The same check the apply makes, on the history in memory.
        const expanded = expandHistory(history);
        for (const [date, rows] of days) {
            const problems = uncoveredRows(expanded, date, rows);
            if (problems.length) failures.push({ name: `sources-${date}.json`, problem: `${problems.length} source(s) not reproduced` });
        }
        return { doomed, removed: [], historyBytes, history, refused: failures.length > 0, failures };
    }
    if (failures.length) return { doomed, removed: [], historyBytes, history, refused: true, failures };
    // Written, read back from disk, and every checkpoint about to go held against it.
    const { problems } = await appendDaysVerified(historyFile, days);
    if (problems.length) {
        return { doomed, removed: [], historyBytes, history, refused: true, failures: problems.map((p) => ({ name: `sources-${p.date}.json`, problem: p.problem })) };
    }
    for (const e of doomed) await rm(e.path, { recursive: true, force: true });
    return { doomed, removed: doomed, historyBytes, history, refused: false, failures: [] };
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help) {
        usage();
        return;
    }
    const apply = Boolean(flags.apply);
    const { doomed, removed, historyBytes, history, refused, failures } = await pruneRunCaches({ apply });
    const mb = (b) => (b / 1048576).toFixed(1);
    const byArea = {};
    for (const e of doomed) {
        byArea[e.area] = byArea[e.area] ?? { count: 0, bytes: 0 };
        byArea[e.area].count += 1;
        byArea[e.area].bytes += e.bytes;
    }
    for (const [area, { count, bytes }] of Object.entries(byArea)) log(`${area}: ${count} dated cache(s), ${mb(bytes)} MB`);
    const runs = Object.values(history.sources).reduce((a, r) => a + r.length, 0);
    log(`history ${relative(REPO, HISTORY_FILE)}: ${history.dates.length} day(s), ${Object.keys(history.sources).length} source(s),`
        + ` ${runs} run(s), ${(historyBytes / 1024).toFixed(0)} KB`);
    const total = doomed.reduce((a, e) => a + e.bytes, 0);
    if (refused) {
        for (const f of failures) logError(`${f.name}: ${f.problem}`);
        logError(`REFUSED: ${failures.length} checkpoint(s) not covered by the history — nothing ${apply ? 'was' : 'would be'} deleted`);
        process.exitCode = 1;
        return;
    }
    if (!apply) {
        log(`dry run: ${doomed.length} dated cache(s), ${mb(total)} MB would be removed after the history is written and verified — pass --apply`);
        return;
    }
    log(`removed ${removed.length} dated cache(s), ${mb(total)} MB; every removed checkpoint is reproduced by the history`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((err) => {
        console.error(err.stack || err.message);
        process.exitCode = 1;
    });
}
