// Keeping raw payloads on disk once per distinct content: each payload is gzip-compressed and named
// by its sha256, so a fetch that returns what is already kept writes nothing new (only the file's
// mtime moves, as its last-seen time), and a bounded retention (newest N, at most D days since last
// seen) keeps the directory from growing. Used by the watchers for the raw bodies they must be able
// to reprocess (a parse or store that failed) and for their small recent-raw rings.
// planPrune is pure and unit tested in raw-keep.test.js with the IO helpers on a temp directory.

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

export function sha256Hex(payload) {
    return createHash('sha256').update(payload).digest('hex');
}

const NAME_RE = /^([0-9a-f]{32})\.([a-z0-9]+)\.gz$/;

/** True for a file name keepRaw writes. */
export function isKeptName(name) {
    return NAME_RE.test(name);
}

/** The kept file's name for a payload hash: the first 128 bits of the sha256 are plenty to dedupe. */
export function keptName(hash, ext = 'json') {
    return `${hash.slice(0, 32)}.${ext}.gz`;
}

/**
 * Keep `payload` (string or Buffer) in `dir` once. Returns { path, hash, written, bytes }:
 * `written` is false when the same content was already kept (its mtime is moved to `now`).
 * `identity` (optional) is what the dedupe hash is taken over, when the payload wraps the source's
 * bytes with context that differs per run (a date): the same bytes are then one file, and the
 * file keeps the context of the first time they were kept.
 */
export async function keepRaw(dir, payload, { ext = 'json', now = Date.now(), identity = null } = {}) {
    const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const hash = sha256Hex(identity ?? buffer);
    await mkdir(dir, { recursive: true });
    const path = join(dir, keptName(hash, ext));
    try {
        await stat(path);
        const when = new Date(now);
        await utimes(path, when, when);
        return { path, hash, written: false, bytes: 0 };
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
    const gz = gzipSync(buffer);
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, gz);
    await rename(tmp, path);
    const when = new Date(now);
    await utimes(path, when, when);
    return { path, hash, written: true, bytes: gz.length };
}

/** The payload of a kept file, decompressed. */
export async function readKept(path) {
    return gunzipSync(await readFile(path));
}

/** Kept files in `dir`, newest (last seen) first; an absent directory is empty. */
export async function listKept(dir) {
    let names;
    try {
        names = await readdir(dir);
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
    const out = [];
    for (const name of names) {
        if (!NAME_RE.test(name)) continue;
        const path = join(dir, name);
        const info = await stat(path);
        out.push({ name, path, mtimeMs: info.mtimeMs, size: info.size });
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
}

/**
 * Which kept files to delete: everything beyond the newest `maxFiles`, and everything last seen
 * more than `maxAgeMs` ago. Either bound may be omitted. Pure.
 */
export function planPrune(files, { maxFiles = Infinity, maxAgeMs = Infinity, now = Date.now() } = {}) {
    const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
    return sorted.filter((f, i) => i >= maxFiles || now - f.mtimeMs > maxAgeMs);
}

/** Apply planPrune to `dir`; returns the deleted entries. */
export async function pruneKept(dir, bounds = {}) {
    const doomed = planPrune(await listKept(dir), bounds);
    for (const f of doomed) await rm(f.path, { force: true });
    return doomed;
}
