#!/usr/bin/env node
// One-off cleanup of the per-day run caches the watchers left behind before 2026-11-23, when they
// stopped writing a new near-copy every day: the document watcher's stocks/data/raw/sources-<date>.json
// checkpoints and the corporate-action watcher's stocks/data/raw/corporate-actions/<date>/
// response directories. Today's are kept. Dry run by default (prints what it would remove and how
// much space that frees); --apply deletes. Idempotent: a second run finds nothing.

import { readdir, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { isoDate, log, parseArgs } from './lib/io.mjs';
import { planDatedCachePrune } from './lib/raw-keep.mjs';

const REPO = join(import.meta.dirname, '..');
const RAW_DIR = join(REPO, 'stocks', 'data', 'raw');
const AREAS = { raw: RAW_DIR, 'corporate-actions': join(RAW_DIR, 'corporate-actions') };

function usage() {
    console.log(`prune-run-caches.mjs — remove the per-day run caches older than today (layout before 2026-11-23)

USAGE
  node stocks/prune-run-caches.mjs [--apply]

  Without --apply: lists what would be removed, with counts and sizes, and removes nothing.
  --apply           Delete them.
  --help            This text.

REMOVES
  ${relative(REPO, RAW_DIR)}/sources-<date>.json            the document watcher's old daily checkpoints
  ${relative(REPO, AREAS['corporate-actions'])}/<date>/   the corporate-action watcher's old daily responses
  Everything dated today is kept. Nothing else is touched.`);
}

async function sizeOf(path) {
    const info = await stat(path);
    if (!info.isDirectory()) return info.size;
    let total = 0;
    for (const name of await readdir(path)) total += await sizeOf(join(path, name));
    return total;
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help) {
        usage();
        return;
    }
    const entries = [];
    for (const [area, dir] of Object.entries(AREAS)) {
        let names = [];
        try {
            names = await readdir(dir);
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
        }
        for (const name of names) entries.push({ area, name, path: join(dir, name) });
    }
    const doomed = planDatedCachePrune(entries, { today: isoDate() });
    const byArea = {};
    for (const e of doomed) {
        e.bytes = await sizeOf(e.path);
        byArea[e.area] = byArea[e.area] ?? { count: 0, bytes: 0 };
        byArea[e.area].count += 1;
        byArea[e.area].bytes += e.bytes;
    }
    const mb = (b) => (b / 1048576).toFixed(1);
    for (const [area, { count, bytes }] of Object.entries(byArea)) log(`${area}: ${count} dated cache(s), ${mb(bytes)} MB`);
    const total = doomed.reduce((a, e) => a + e.bytes, 0);
    if (!flags.apply) {
        log(`dry run: ${doomed.length} dated cache(s), ${mb(total)} MB would be removed — pass --apply to delete`);
        return;
    }
    for (const e of doomed) await rm(e.path, { recursive: true, force: true });
    log(`removed ${doomed.length} dated cache(s), ${mb(total)} MB`);
}

main().catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
});
