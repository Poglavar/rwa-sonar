// Tiny shared helpers for the stocks pipeline: timestamped logging, atomic JSON
// read/write (write a .tmp then rename, so a killed run never leaves a half file),
// polite rate pacing and a fetch wrapper that reports status instead of throwing.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** ISO timestamp trimmed to whole seconds, e.g. 2026-09-16T13:00:00Z. */
export function ts(date = new Date()) {
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Date part only, for raw-file names: 2026-09-16. */
export function isoDate(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

export function log(...args) {
    console.log(`[${ts()}]`, ...args);
}

export function logWarn(...args) {
    console.log(`[${ts()}] WARN`, ...args);
}

export function logError(...args) {
    console.error(`[${ts()}] ERROR`, ...args);
}

/** Read JSON. Returns `fallback` only when the file is absent; any other error throws. */
export async function readJson(path, fallback = undefined) {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
        throw err;
    }
}

/**
 * Write JSON atomically (tmp file + rename), creating the directory if needed. `indent` is 2 unless
 * a caller is under a byte budget (stocks-tokens.json is, MODEL.md §10.1) and trades some
 * whitespace for it; the file stays pretty-printed either way.
 */
export async function writeJson(path, value, indent = 2) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, indent)}\n`, 'utf8');
    await rename(tmp, path);
    return path;
}

/** Deliberate pacing between HTTP calls / backoff. Not used as a wait-for-condition. */
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GET/POST JSON. Never swallows: returns the real status plus the parsed body, and
 * reports a parse failure with a body preview so a HTML error page is recognisable.
 */
export async function fetchJson(url, { method = 'GET', headers = {}, body = null, timeoutMs = 120000 } = {}) {
    const res = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.text();
    let json = null;
    let parseError = null;
    try {
        json = JSON.parse(text);
    } catch (err) {
        parseError = err.message;
    }
    return { status: res.status, ok: res.ok, json, parseError, bodyPreview: text.slice(0, 300), bytes: text.length };
}

/** Byte-order comparator, so committed files sort identically on every machine. */
export function byString(a, b) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
}

/** Minimal `--flag` / `--key=value` parser shared by the three CLIs. */
export function parseArgs(argv) {
    const flags = {};
    const rest = [];
    for (const arg of argv) {
        if (!arg.startsWith('--')) {
            rest.push(arg);
            continue;
        }
        const [key, ...valueParts] = arg.slice(2).split('=');
        flags[key] = valueParts.length ? valueParts.join('=') : true;
    }
    return { flags, rest };
}
