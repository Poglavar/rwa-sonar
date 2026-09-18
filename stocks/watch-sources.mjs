#!/usr/bin/env node
// The document watcher (EVIDENCE.md §2.1-§2.3): fetch every URL in stocks/data/sources.json with a
// browser-like UA and conditional headers, normalise it to text (PDF through `pdftotext -layout`,
// HTML stripped of chrome, JSON with sorted keys), hash it, and compare with the hash we stored
// last time. An unchanged source only moves `last_checked_at`; a changed one gets its raw bytes and
// text kept on disk, a line diff, a keyword severity, and a `sonar.change_event` when the change
// touches one of the §2.3 legal keywords. A 404/410 or a host that stopped resolving is a
// `document-gone` event — a dead citation is a finding about our own dossiers, not a crash.
//
// Everything that decides anything lives in lib/watch.mjs and lib/textdiff.mjs and is unit tested;
// this file is the IO, the pacing, the checkpointing and the run verdict.

import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { readEnvFile } from './lib/env.mjs';
import { wrapTransaction } from './lib/db-load.mjs';
import { isoDate, log, logError, logWarn, parseArgs, readJson, sleep, ts, writeJson } from './lib/io.mjs';
import { describeUrl, psql } from './lib/psql.mjs';
import { hostOf, kindFromContentType } from './lib/sources.mjs';
import { diffLines, summariseDiff } from './lib/textdiff.mjs';
import {
    binaryMarker, blockVendor, buildChangeEventSql, buildSourceSql, buildVersionSql,
    challengeInBody, decideOutcome, fileStamp, isTextual, jsOnlyShell, normaliseByKind,
    ARCHIVE_GIVE_UP_AFTER, DEFAULT_USER_AGENT, archiveRefusal, parseArchiveLocation, parseSpnStatus, rawExtension, spnBusy, spnTransient,
    runFailed, severityForChange, sha256Hex, sourceId, userAgentFor
} from './lib/watch.mjs';

const HERE = import.meta.dirname;
const REPO = join(HERE, '..');
const SOURCES_FILE = join(HERE, 'data', 'sources.json');
const STATE_FILE = join(HERE, 'data', 'sources-state.json');
const VERSIONS_DIR = join(HERE, 'data', 'sources');
const RAW_DIR = join(HERE, 'data', 'raw');
const DDL_FILE = join(REPO, 'db', '2026-09-18-sonar-evidence.sql');

// A real browser string by default, because several of these hosts answer a scripted UA with a bot
// wall — but per-host overrides win (lib/watch.mjs `userAgentFor`): the SEC requires a UA that
// declares who is asking, and answers a browser string with 403.
const USER_AGENT = DEFAULT_USER_AGENT;
const TIMEOUT_MS = 30_000;
const HOST_PACE_MS = 1500;
/**
 * Save Page Now pacing. 5 s between submits hit the account's active-session cap within four
 * saves and then archive.org refused connections outright (2026-09-17, twice); 15 s keeps one
 * capture in flight at a time, and `if_not_archived_within` lets Wayback answer with a capture
 * someone else made in the last day instead of crawling the page again.
 */
const ARCHIVE_PACE_MS = 15_000;
const ARCHIVE_REUSE_WITHIN = '1d';
const BACKOFF_MS = [5000, 15_000];
const KEEP_VERSIONS = 5;
const CHECK_EVERY = '1 day';

function usage() {
    console.log(`watch-sources.mjs — fetch, normalise, hash and diff every source we rely on

USAGE
  node stocks/watch-sources.mjs --run [options]

OPTIONS
  --run              Actually fetch. Without it this help is printed and nothing runs.
  --only=<issuer>    Only sources attributed to this issuer slug (e.g. --only=prestocks).
  --limit=<n>        Only the first n sources after filtering (smoke test).
  --force            Ignore today's checkpoint and look at every source again. Conditional
                     headers are still sent, so an unchanged document still answers 304.
  --archive          Push every NEW version — and any source with no archive yet — to the
                     Wayback Machine (1 request / ${ARCHIVE_PACE_MS / 1000}s, reusing a capture under ${ARCHIVE_REUSE_WITHIN} old). Failures are logged
                     and never fatal. Measure a run without it first.
  --ddl              Apply db/${DDL_FILE.split('/').pop()} before loading. Idempotent.
  --no-db            Do everything except the Postgres load (files and checkpoint only).
  --pace=<ms>        Minimum gap between two requests to the SAME host (default ${HOST_PACE_MS}).
  --help             This text.

WHAT A RUN DOES
  Sources are ordered round-robin by host, so the per-host pacing almost never has to block.
  Each fetch sends If-None-Match / If-Modified-Since from the stored version, so an unchanged
  document usually costs a 304. The kind is taken from the response's content-type (the URL is
  only a guess): pdf -> \`pdftotext -layout\` on stdin, html -> chrome stripped and tags removed,
  api -> JSON with keys sorted. Churn lines (bare dates, counters, cookie banners) are dropped
  before hashing, or every page with a clock on it would report a change every day.

  Outcomes: ok (same hash, or 304) · changed (new hash -> new version + diff) · gone (404/410 or
  the host stopped resolving -> \`document-gone\` event) · blocked (401/403/405/406/451, a bot wall,
  or 429 after backoff — recorded with the reason and not retried forever) · error (5xx, timeout,
  reset). A run with ANY error does not report success and exits non-zero; gone and blocked are
  recorded findings, not failures.

FILES
  stocks/data/sources.json                          input registry (extract-sources.mjs)
  stocks/data/sources/<id>/<fetched_at>.{pdf,html,json,txt}   raw + normalised copies (gitignored)
  stocks/data/sources-state.json                    last hash/etag per URL (gitignored)
  stocks/data/raw/sources-<date>.json               per-source checkpoint, resumable (gitignored)
  sonar.source / sonar.source_version / sonar.change_event   the mirror in Postgres

REQUIREMENTS
  \`pdftotext\` (poppler) on PATH for pdf sources — on macOS \`brew install poppler\`, on the server
  \`apt install poppler-utils\`. DATABASE_URL in ${join(REPO, '.env')} unless --no-db.`);
}

// --- pdftotext -------------------------------------------------------------------------------

/** Loud, early failure: a missing binary must not be discovered 200 fetches into a run. */
async function assertPdftotext() {
    await new Promise((resolvePromise, rejectPromise) => {
        const child = spawn('pdftotext', ['-v'], { stdio: ['ignore', 'ignore', 'pipe'] });
        child.on('error', (err) => {
            rejectPromise(new Error(
                `pdftotext is not on PATH (${err.code || err.message}) and this run has PDF sources.`
                + ' Install poppler: macOS `brew install poppler`, Debian/Ubuntu server'
                + ' `apt install poppler-utils`. Or run with --only=<issuer> over html-only sources.'
            ));
        });
        // `pdftotext -v` exits 0 on some builds and 99 on others; either proves it is installed.
        child.on('close', () => resolvePromise());
    });
}

/** PDF bytes -> layout-preserving text. stdin/stdout only: no temp file is ever written. */
function pdfToText(buffer) {
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn('pdftotext', ['-layout', '-', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
        const chunks = [];
        let err = '';
        child.stdout.on('data', (d) => chunks.push(d));
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', (e) => rejectPromise(new Error(`pdftotext: ${e.message}`)));
        child.on('close', (code) => {
            const text = Buffer.concat(chunks).toString('utf8');
            // pdftotext exits non-zero on a damaged file but may still have produced pages.
            if (code !== 0 && text.trim() === '') {
                rejectPromise(new Error(`pdftotext exited ${code}: ${err.trim().slice(0, 200)}`));
                return;
            }
            if (code !== 0) logWarn(`pdftotext exited ${code} but produced ${text.length} chars: ${err.trim().slice(0, 120)}`);
            resolvePromise(text);
        });
        child.stdin.on('error', (e) => rejectPromise(new Error(`pdftotext stdin: ${e.message}`)));
        child.stdin.end(buffer);
    });
}

// --- fetching --------------------------------------------------------------------------------

/**
 * Fallback for a server whose response headers do not fit undici's 16 KB cap, which `fetch` reports
 * as UND_ERR_HEADERS_OVERFLOW with no body at all. Measured on `https://superstate.com/assets/fwdi`:
 * one `link:` preload header of 14,990 bytes takes the response to 17,456 bytes of headers. That is
 * our client's limit, not the site's fault, so the document is fetched again through node:https with
 * a 256 KB `maxHeaderSize` instead of being written off. Redirects are followed by hand (fetch is
 * not doing it for us here) and `Accept-Encoding` is dropped, because unlike undici this path does
 * not decompress.
 */
function fetchWithBigHeaders(url, headers, timeoutMs, redirectsLeft = 5) {
    const plain = { ...headers };
    delete plain['Accept-Encoding'];
    return new Promise((resolvePromise) => {
        const fail = (code) => resolvePromise({
            httpStatus: null, headers: {}, buffer: Buffer.alloc(0), finalUrl: url, networkErrorCode: code
        });
        let target;
        try {
            target = new URL(url);
        } catch {
            fail('ERR_INVALID_URL');
            return;
        }
        const request = target.protocol === 'http:' ? httpRequest : httpsRequest;
        const req = request(url, { method: 'GET', headers: plain, maxHeaderSize: 262_144 }, (res) => {
            const redirect = [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location;
            if (redirect && redirectsLeft > 0) {
                res.resume();
                resolvePromise(fetchWithBigHeaders(new URL(res.headers.location, url).toString(),
                    headers, timeoutMs, redirectsLeft - 1));
                return;
            }
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolvePromise({
                httpStatus: res.statusCode,
                headers: res.headers,
                buffer: Buffer.concat(chunks),
                finalUrl: url,
                networkErrorCode: null
            }));
            res.on('error', (err) => fail(err.code || err.name));
        });
        req.setTimeout(timeoutMs, () => {
            req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
        });
        req.on('error', (err) => fail(err.code || err.name));
        req.end();
    });
}

/** One GET, with the conditional headers the stored version allows. Never throws. */
async function fetchOnce(url, { etag, lastModified }, timeoutMs) {
    const headers = {
        'User-Agent': userAgentFor(hostOf(url)),
        Accept: 'text/html,application/xhtml+xml,application/pdf,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br'
    };
    if (etag) headers['If-None-Match'] = etag;
    if (lastModified) headers['If-Modified-Since'] = lastModified;
    try {
        const res = await fetch(url, {
            method: 'GET',
            headers,
            redirect: 'follow',
            signal: AbortSignal.timeout(timeoutMs)
        });
        const buffer = res.status === 304 ? Buffer.alloc(0) : Buffer.from(await res.arrayBuffer());
        const headerObject = Object.fromEntries([...res.headers.entries()]);
        return { httpStatus: res.status, headers: headerObject, buffer, finalUrl: res.url, networkErrorCode: null };
    } catch (err) {
        const code = err.name === 'TimeoutError' ? 'ETIMEDOUT' : (err.cause?.code || err.code || err.name);
        if (code === 'UND_ERR_HEADERS_OVERFLOW') {
            logWarn(`${url}: response headers exceed undici's 16 KB cap — refetching with a 256 KB limit`);
            return fetchWithBigHeaders(url, headers, timeoutMs);
        }
        return { httpStatus: null, headers: {}, buffer: Buffer.alloc(0), finalUrl: url, networkErrorCode: code };
    }
}

/** 429 and 503 get two backoffs before the source is written off as blocked or broken. */
async function fetchWithBackoff(url, conditional, timeoutMs) {
    let response = await fetchOnce(url, conditional, timeoutMs);
    let retried = false;
    for (const wait of BACKOFF_MS) {
        if (response.httpStatus !== 429 && response.httpStatus !== 503) break;
        const retryAfter = Number(response.headers['retry-after']);
        const pause = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 60_000) : wait;
        logWarn(`${response.httpStatus} on ${url} — backing off ${pause} ms`);
        await sleep(pause);
        response = await fetchOnce(url, conditional, timeoutMs);
        retried = true;
    }
    return { ...response, retriedAfterBackoff: retried };
}

/**
 * Interleave hosts so consecutive requests hit different servers: with ~120 hosts the 1.5 s
 * per-host floor then almost never costs any wall-clock time, while no host sees a burst.
 */
export function orderByHost(items) {
    const buckets = new Map();
    for (const item of items) {
        const host = hostOf(item.url) ?? '';
        if (!buckets.has(host)) buckets.set(host, []);
        buckets.get(host).push(item);
    }
    const queues = [...buckets.values()];
    const out = [];
    for (let round = 0; out.length < items.length; round += 1) {
        for (const queue of queues) if (queue[round]) out.push(queue[round]);
    }
    return out;
}

// --- version files ---------------------------------------------------------------------------

/** Write the raw bytes and the normalised text of a new version; return their repo-relative paths. */
async function writeVersionFiles(id, fetchedAt, kind, buffer, text) {
    const dir = join(VERSIONS_DIR, id);
    await mkdir(dir, { recursive: true });
    const stamp = fileStamp(fetchedAt);
    const rawPath = join(dir, `${stamp}.${rawExtension(kind)}`);
    const textPath = join(dir, `${stamp}.txt`);
    await writeFile(rawPath, buffer);
    await writeFile(textPath, text, 'utf8');
    return { rawPath: relative(REPO, rawPath), textPath: relative(REPO, textPath) };
}

/** Keep the last `KEEP_VERSIONS` versions per source (EVIDENCE.md §2.2), delete what is older. */
async function pruneVersions(id) {
    const dir = join(VERSIONS_DIR, id);
    let names;
    try {
        names = await readdir(dir);
    } catch {
        return 0;
    }
    const stamps = [...new Set(names.map((n) => n.replace(/\.(txt|pdf|html|json)$/, '')))].sort();
    const doomed = stamps.slice(0, Math.max(0, stamps.length - KEEP_VERSIONS));
    let removed = 0;
    for (const stamp of doomed) {
        for (const name of names.filter((n) => n.startsWith(stamp))) {
            await rm(join(dir, name), { force: true });
            removed += 1;
        }
    }
    return removed;
}

// --- Wayback ---------------------------------------------------------------------------------

/**
 * Save Page Now. `Content-Location` carries `/web/<ts>/<url>` on success; some responses only
 * redirect, in which case the final URL is the archived one. Never fatal: an archive we failed to
 * make is a missing nicety, not a failed watch.
 */
/** archive.org S3-style keys from .env (ARCHIVE_ORG_ACCESS_KEY / ARCHIVE_ORG_SECRET_KEY); set in main(). */
let archiveAuth = null;
const SPN_POLL_MS = 5000;
const SPN_WAIT_MS = 90_000;
/** SPN says "wait for a minute" when the account's active-session cap is hit; do that, a few times. */
const SPN_BUSY_WAIT_MS = 60_000;
const SPN_BUSY_RETRIES = 3;

/**
 * Save Page Now 2 with an account key: submit, then poll the job until it settles or SPN_WAIT_MS
 * passes (a capture that is still pending is reported as such and retried on a later pass,
 * because `archive_url` stays null). The key never appears in a log line.
 */
async function archiveUrlAuthenticated(url) {
    const headers = {
        Accept: 'application/json',
        Authorization: `LOW ${archiveAuth.access}:${archiveAuth.secret}`,
        'User-Agent': USER_AGENT
    };
    try {
        let submit = null;
        let submitted = null;
        for (let attempt = 0; ; attempt += 1) {
            submit = await fetch('https://web.archive.org/save', {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ url, capture_all: '1', if_not_archived_within: ARCHIVE_REUSE_WITHIN }).toString(),
                signal: AbortSignal.timeout(60_000)
            });
            submitted = await submit.json().catch(() => null);
            if (submitted?.job_id) break;
            const msg = submitted?.message || submitted?.status_ext || `http ${submit.status}`;
            if (spnBusy(msg) && attempt < SPN_BUSY_RETRIES) {
                log(`archive busy (active-session cap), waiting ${SPN_BUSY_WAIT_MS / 1000}s before retrying ${url}`);
                await sleep(SPN_BUSY_WAIT_MS);
                continue;
            }
            return { archiveUrl: null, httpStatus: submit.status, error: `save-page-now submit: ${msg}` };
        }
        const started = Date.now();
        while (Date.now() - started < SPN_WAIT_MS) {
            await sleep(SPN_POLL_MS);
            const poll = await fetch(`https://web.archive.org/save/status/${submitted.job_id}`, { headers, signal: AbortSignal.timeout(30_000) });
            const parsed = parseSpnStatus(await poll.json().catch(() => null));
            if (parsed.done) return { archiveUrl: parsed.archiveUrl, httpStatus: poll.status, error: parsed.error };
        }
        return { archiveUrl: null, httpStatus: 202, error: `save-page-now still pending after ${SPN_WAIT_MS / 1000}s (job ${submitted.job_id})` };
    } catch (err) {
        return { archiveUrl: null, httpStatus: null, error: err.name === 'TimeoutError' ? 'timeout' : (err.cause?.code || err.message) };
    }
}

/**
 * A refused or dropped connection to web.archive.org is the archive pushing back, not a verdict on
 * the source; wait the same minute the session cap asks for and try again before calling it a
 * failure (which would count towards giving up for the run).
 */
async function archiveUrlWithRetry(url) {
    for (let attempt = 0; ; attempt += 1) {
        const saved = await archiveUrlAuthenticated(url);
        if (saved.archiveUrl || !spnTransient(saved.error) || attempt >= SPN_BUSY_RETRIES) return saved;
        log(`archive unreachable (${saved.error}), waiting ${SPN_BUSY_WAIT_MS / 1000}s before retrying ${url}`);
        await sleep(SPN_BUSY_WAIT_MS);
    }
}

async function archiveUrl(url) {
    if (archiveAuth) return archiveUrlWithRetry(url);
    try {
        const res = await fetch(`https://web.archive.org/save/${url}`, {
            method: 'GET',
            headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' },
            redirect: 'follow',
            signal: AbortSignal.timeout(60_000)
        });
        const parsed = parseArchiveLocation(res.headers.get('content-location'), res.url);
        if (parsed) return { archiveUrl: parsed, httpStatus: res.status, error: null };
        return { archiveUrl: null, httpStatus: res.status, error: archiveRefusal(res.status) };
    } catch (err) {
        return { archiveUrl: null, httpStatus: null, error: err.name === 'TimeoutError' ? 'timeout' : (err.cause?.code || err.message) };
    }
}

// --- the run ---------------------------------------------------------------------------------

/** k/N with an ETA from the rate so far — a long run must be distinguishable from a hung one. */
function progress(done, total, startedMs) {
    const elapsed = Date.now() - startedMs;
    const remaining = total - done;
    const etaMs = done > 0 ? Math.round((elapsed / done) * remaining) : null;
    const mm = etaMs === null ? '??:??' : `${String(Math.floor(etaMs / 60000)).padStart(2, '0')}:${String(Math.floor((etaMs % 60000) / 1000)).padStart(2, '0')}`;
    return `${done}/${total} · ${Math.round((done / total) * 100)}% · ETA ${mm}`;
}

/** Everything about one source after one look at it. Written to the checkpoint as-is. */
async function watchOne(source, prev, options) {
    const { timeoutMs } = options;
    const id = sourceId(source.url);
    const fetchedAt = ts();
    // Conditional headers always come from the stored version, `--force` included: --force means
    // "ignore today's checkpoint and look again", not "make the server send the body again". A 304
    // IS the answer we want — it is the cheapest possible "unchanged".
    const conditional = prev
        ? { etag: prev.etag ?? null, lastModified: prev.lastModified ?? null }
        : { etag: null, lastModified: null };

    const res = await fetchWithBackoff(source.url, conditional, timeoutMs);
    // The bot-wall test reads the BODY only; a vendor header is an annotation on a status that
    // already refused us, never evidence on its own (see lib/watch.mjs).
    const bodyPreview = res.buffer.subarray(0, 4000).toString('utf8');
    const blocked = challengeInBody(bodyPreview);
    const vendor = blockVendor(res.headers);

    const result = {
        id,
        url: source.url,
        issuer: source.issuer ?? null,
        title: source.title ?? null,
        foundIn: source.foundIn ?? [],
        registryKind: source.kind,
        kind: source.kind,
        fetchedAt,
        httpStatus: res.httpStatus,
        contentType: res.headers['content-type'] ?? null,
        bytes: res.buffer.length || null,
        textChars: null,
        contentHash: prev?.contentHash ?? null,
        etag: res.headers.etag ?? prev?.etag ?? null,
        lastModified: res.headers['last-modified'] ?? prev?.lastModified ?? null,
        rawPath: null,
        textPath: null,
        archiveUrl: prev?.archiveUrl ?? null,
        status: null,
        reason: null,
        error: null,
        diff: null
    };

    // A 2xx needs the body turned into text before the outcome is known, because the outcome is
    // "same hash" versus "new hash".
    let text = null;
    let hash = null;
    if (res.httpStatus !== null && res.httpStatus >= 200 && res.httpStatus < 300 && !blocked) {
        const contentType = res.headers['content-type'];
        result.kind = kindFromContentType(contentType, source.url);
        try {
            if (result.kind === 'pdf') {
                text = normaliseByKind('pdf', await pdfToText(res.buffer));
            } else if (isTextual(contentType) || !contentType) {
                text = normaliseByKind(result.kind, res.buffer.toString('utf8'));
            } else {
                // Not text and not a PDF (a zip of attestations, say): watched as bytes.
                result.binary = true;
                text = binaryMarker(res.buffer, contentType);
            }
            hash = sha256Hex(text);
            result.textChars = text.length;
        } catch (err) {
            result.status = 'error';
            result.reason = `normalise: ${err.message}`;
            result.error = err.message;
            return { result, text: null, raw: res.buffer, previousTextPath: prev?.textPath ?? null };
        }
    }

    const outcome = decideOutcome({
        host: hostOf(source.url),
        httpStatus: res.httpStatus,
        networkErrorCode: res.networkErrorCode,
        blocked,
        vendor,
        jsOnly: result.kind === 'html' && jsOnlyShell(text, res.buffer.toString('utf8')),
        sameHash: hash !== null && prev?.contentHash === hash,
        retriedAfterBackoff: res.retriedAfterBackoff
    });
    result.status = outcome.status;
    result.reason = outcome.reason;
    if (outcome.status === 'error' || outcome.status === 'blocked' || outcome.status === 'gone') {
        result.error = outcome.reason;
    }
    if (hash !== null) result.contentHash = hash;
    return { result, text, raw: res.buffer, previousTextPath: prev?.textPath ?? null };
}

/** The diff and severity of a changed source, plus the files it just wrote. */
async function recordChange(result, { text, raw, previousTextPath }) {
    const { rawPath, textPath } = await writeVersionFiles(result.id, result.fetchedAt, result.kind,
        raw, text);
    result.rawPath = rawPath;
    result.textPath = textPath;

    let previousText = null;
    if (previousTextPath) {
        try {
            previousText = await readFile(join(REPO, previousTextPath), 'utf8');
        } catch (err) {
            logWarn(`${result.url}: previous text ${previousTextPath} unreadable (${err.code}) — diff skipped`);
        }
    }
    if (previousText === null) {
        result.diff = {
            added: null, removed: null, method: 'none', severity: null, keywords: [],
            summary: previousTextPath ? 'previous text missing on disk — no diff' : 'first version (nothing to diff against)',
            unified: null
        };
        return;
    }
    const diff = diffLines(previousText, text);
    const severity = severityForChange({ kind: result.kind, changedLines: diff.changedLines });
    result.diff = {
        added: diff.added,
        removed: diff.removed,
        method: severity.method,
        diffMethod: diff.method,
        severity: severity.severity,
        keywords: severity.keywords,
        capped: severity.capped === true,
        summary: `${summariseDiff(diff)}${severity.keywords.length ? ` · keywords: ${severity.keywords.join(', ')}` : ''}`,
        unified: diff.unified
    };
    await pruneVersions(result.id);
}

/** The rows for Postgres: sources always, versions and events only for what actually happened. */
function buildRows(results, previousState) {
    const sources = [];
    const versions = [];
    const events = [];
    for (const result of results) {
        const prev = previousState[result.url] ?? null;
        const changed = result.status === 'changed';
        sources.push({
            id: result.id,
            url: result.url,
            kind: result.kind,
            title: result.title,
            issuer: result.issuer,
            foundIn: result.foundIn,
            firstSeenAt: prev?.firstSeenAt ?? result.fetchedAt,
            lastCheckedAt: result.fetchedAt,
            lastChangedAt: changed ? result.fetchedAt : (prev?.lastChangedAt ?? null),
            checkEvery: CHECK_EVERY,
            archiveUrl: result.archiveUrl,
            status: result.status,
            contentHash: result.contentHash,
            httpStatus: result.httpStatus,
            error: result.error
        });
        if (changed) {
            versions.push({
                sourceId: result.id,
                fetchedAt: result.fetchedAt,
                contentHash: result.contentHash,
                bytes: result.bytes,
                textChars: result.textChars,
                textPath: result.textPath,
                rawPath: result.rawPath,
                archiveUrl: result.archiveUrl,
                etag: result.etag,
                lastModified: result.lastModified,
                diffSummary: result.diff?.summary ?? null,
                diffSeverity: result.diff?.severity ?? null,
                diffMethod: result.diff?.method ?? 'none',
                diffAdded: result.diff?.added ?? null,
                diffRemoved: result.diff?.removed ?? null
            });
            if (result.diff?.severity === 'caution') {
                events.push({
                    detectedAt: result.fetchedAt,
                    kind: 'legal-term',
                    subjectType: 'source',
                    subjectId: result.id,
                    field: null,
                    before: prev?.contentHash ?? null,
                    after: result.contentHash,
                    severity: 'caution',
                    summary: `${result.title ?? result.url}: ${result.diff.summary}`,
                    evidence: {
                        url: result.url,
                        issuer: result.issuer,
                        foundIn: result.foundIn,
                        versionFetchedAt: result.fetchedAt,
                        contentHash: result.contentHash,
                        textPath: result.textPath,
                        diffExcerpt: (result.diff.unified ?? '').slice(0, 4000)
                    }
                });
            }
        }
        // Only the TRANSITION into `gone` is an event; a citation that has been dead for a month
        // must not write one event per run.
        if (result.status === 'gone' && prev?.status !== 'gone') {
            events.push({
                detectedAt: result.fetchedAt,
                kind: 'document-gone',
                subjectType: 'source',
                subjectId: result.id,
                field: null,
                before: prev?.contentHash ?? null,
                after: null,
                severity: 'warning',
                summary: `${result.title ?? result.url} is gone (${result.reason})`,
                evidence: {
                    url: result.url,
                    issuer: result.issuer,
                    foundIn: result.foundIn,
                    httpStatus: result.httpStatus,
                    reason: result.reason
                }
            });
        }
    }
    return { sources, versions, events };
}

async function loadToPostgres(rows, { url, applyDdl }) {
    if (applyDdl) {
        const ddl = await readFile(DDL_FILE, 'utf8');
        log(`db: applying ${relative(REPO, DDL_FILE)} (${ddl.length} bytes, idempotent)`);
        await psql(url, ddl, 'ddl');
    }
    const source = buildSourceSql(rows.sources);
    log(`db: ${source.rows} source rows`);
    await psql(url, wrapTransaction(source.sql), source.table);
    if (rows.versions.length) {
        const version = buildVersionSql(rows.versions);
        log(`db: ${version.rows} new source_version rows`);
        await psql(url, wrapTransaction(version.sql), version.table);
    }
    if (rows.events.length) {
        const events = buildChangeEventSql(rows.events);
        log(`db: ${events.rows} change_event row(s) offered`);
        await psql(url, wrapTransaction(events.sql), events.table);
    }
    const counts = await psql(url,
        "SELECT 'source' AS t, count(*) FROM sonar.source"
        + " UNION ALL SELECT 'source_version', count(*) FROM sonar.source_version"
        + " UNION ALL SELECT 'change_event', count(*) FROM sonar.change_event ORDER BY 1;\n",
        'counts', ['-t', '-A', '-F', '|']);
    for (const line of counts.trim().split('\n').filter(Boolean)) {
        const [table, n] = line.split('|');
        log(`  sonar.${table}: ${n} rows`);
    }
    const dist = await psql(url,
        'SELECT status, kind, count(*) FROM sonar.source GROUP BY 1, 2 ORDER BY 3 DESC;\n',
        'status distribution', ['-t', '-A', '-F', '|']);
    for (const line of dist.trim().split('\n').filter(Boolean)) {
        const [status, kind, n] = line.split('|');
        log(`  status=${status} kind=${kind}: ${n}`);
    }
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return;
    }
    const pace = flags.pace ? Number(flags.pace) : HOST_PACE_MS;
    if (!Number.isFinite(pace) || pace < 0) throw new Error(`--pace must be a number of ms, got ${flags.pace}`);

    if (flags.archive) {
        const env = await readEnvFile(join(REPO, '.env'));
        const access = process.env.ARCHIVE_ORG_ACCESS_KEY || env.ARCHIVE_ORG_ACCESS_KEY;
        const secret = process.env.ARCHIVE_ORG_SECRET_KEY || env.ARCHIVE_ORG_SECRET_KEY;
        if (access && secret) {
            archiveAuth = { access, secret };
            log('archive: Save Page Now with the archive.org account key (authenticated)');
        } else {
            logWarn('archive: no ARCHIVE_ORG_ACCESS_KEY/SECRET_KEY in .env — anonymous saves, which the archive currently refuses');
        }
    }

    const registry = await readJson(SOURCES_FILE, null);
    if (!registry?.items?.length) {
        throw new Error(`${SOURCES_FILE} is missing or empty — run \`node stocks/extract-sources.mjs --run\` first`);
    }
    let sources = registry.items;
    if (typeof flags.only === 'string') {
        sources = sources.filter((s) => s.issuer === flags.only);
        if (sources.length === 0) throw new Error(`no sources for issuer ${flags.only}`);
    }
    if (flags.limit) {
        const limit = Number(flags.limit);
        if (!Number.isFinite(limit) || limit < 1) throw new Error(`--limit must be a positive number, got ${flags.limit}`);
        sources = sources.slice(0, limit);
    }
    if (sources.some((s) => s.kind === 'pdf')) await assertPdftotext();

    const previous = await readJson(STATE_FILE, {});
    const checkpointFile = join(RAW_DIR, `sources-${isoDate()}.json`);
    const checkpoint = flags.force ? {} : await readJson(checkpointFile, {});
    const resumed = Object.keys(checkpoint).filter((url) => sources.some((s) => s.url === url)).length;

    log(`watch-sources: ${sources.length} source(s), registry ${registry.generatedAt}`
        + `${flags.only ? `, only ${flags.only}` : ''}${flags.archive ? ', archiving new versions' : ''}`);
    if (resumed) log(`watch-sources: resuming — ${resumed} source(s) already in ${relative(REPO, checkpointFile)}`);
    if (Object.keys(previous).length === 0) log('watch-sources: no stored state — every source is a first sight');

    const ordered = orderByHost(sources);
    const lastHitByHost = new Map();
    const startedMs = Date.now();
    const results = [];
    let done = 0;
    let archived = 0;
    let archiveFailures = 0;
    let archiveFailureStreak = 0;
    let archiveGaveUp = null;
    let lastArchiveMs = 0;

    for (const source of ordered) {
        done += 1;
        const cached = checkpoint[source.url];
        if (cached) {
            results.push(cached);
            continue;
        }
        const host = hostOf(source.url) ?? '';
        const wait = pace - (Date.now() - (lastHitByHost.get(host) ?? 0));
        if (wait > 0) await sleep(wait);
        lastHitByHost.set(host, Date.now());

        const prev = previous[source.url] ?? null;
        const { result, text, raw, previousTextPath } = await watchOne(source, prev,
            { timeoutMs: TIMEOUT_MS });
        results.push(result);

        if (result.status === 'changed') {
            // The raw bytes only exist in memory, so the version files are written here, before
            // the checkpoint records the paths.
            await recordChange(result, { text, raw, previousTextPath });
        }
        // EVIDENCE.md §2.2: archive on first sight and on every new version. "First sight" is
        // "no archive_url stored", not "first run", so a source that has never been archived is
        // picked up by a later --archive pass instead of being missed for good. A source that is
        // gone or errored has nothing to archive.
        const wantsArchive = flags.archive && !archiveGaveUp && result.status !== 'gone'
            && result.status !== 'error'
            && (result.status === 'changed' || !result.archiveUrl);
        if (wantsArchive) {
            const gap = ARCHIVE_PACE_MS - (Date.now() - lastArchiveMs);
            if (gap > 0) await sleep(gap);
            lastArchiveMs = Date.now();
            const saved = await archiveUrl(result.url);
            if (saved.archiveUrl) {
                result.archiveUrl = saved.archiveUrl;
                archived += 1;
                archiveFailureStreak = 0;
                log(`archived ${result.url} -> ${saved.archiveUrl}`);
            } else {
                archiveFailures += 1;
                archiveFailureStreak += 1;
                logWarn(`archive failed for ${result.url}: ${saved.error}`);
                // The archive being offline, or refusing anonymous saves, is one fact about the
                // archive — not 300 facts about our sources. Each attempt costs 5 s of pacing, so
                // say it once and stop trying for the rest of the run.
                if (archiveFailureStreak >= ARCHIVE_GIVE_UP_AFTER) {
                    archiveGaveUp = saved.error;
                    logWarn(`archive-unavailable: ${ARCHIVE_GIVE_UP_AFTER} consecutive failures`
                        + ` (${saved.error}) — no further saves attempted this run`);
                }
            }
        }

        const mark = result.status === 'changed' ? 'CHANGED' : result.status.toUpperCase();
        const detail = result.status === 'changed' ? ` ${result.diff?.summary ?? ''}` : ` ${result.reason}`;
        log(`[${progress(done, ordered.length, startedMs)}] ${mark} ${result.url}${detail}`);

        checkpoint[source.url] = result;
        await writeJson(checkpointFile, checkpoint);
    }

    // State for the next run: what we now know per URL.
    const state = {};
    for (const result of results) {
        const prev = previous[result.url] ?? null;
        state[result.url] = {
            id: result.id,
            kind: result.kind,
            status: result.status,
            httpStatus: result.httpStatus,
            contentHash: result.contentHash,
            etag: result.etag,
            lastModified: result.lastModified,
            firstSeenAt: prev?.firstSeenAt ?? result.fetchedAt,
            lastCheckedAt: result.fetchedAt,
            lastChangedAt: result.status === 'changed' ? result.fetchedAt : (prev?.lastChangedAt ?? null),
            textPath: result.textPath ?? prev?.textPath ?? null,
            rawPath: result.rawPath ?? prev?.rawPath ?? null,
            archiveUrl: result.archiveUrl ?? prev?.archiveUrl ?? null,
            versions: (prev?.versions ?? 0) + (result.status === 'changed' ? 1 : 0)
        };
    }
    await writeJson(STATE_FILE, { ...previous, ...state });

    const rows = buildRows(results, previous);
    const byStatus = {};
    for (const result of results) byStatus[result.status] = (byStatus[result.status] ?? 0) + 1;
    log(`watch-sources: ${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(' ')}`
        + ` · ${rows.versions.length} new version(s) · ${rows.events.length} change event(s)`);
    if (flags.archive) {
        log(`watch-sources: archived ${archived}, archive failures ${archiveFailures}`
            + (archiveGaveUp ? ` — gave up after ${ARCHIVE_GIVE_UP_AFTER} in a row: ${archiveGaveUp}` : ''));
    }

    const gone = results.filter((r) => r.status === 'gone');
    if (gone.length) {
        logWarn(`${gone.length} cited URL(s) are gone — a finding about our dossiers, not a run failure:`);
        for (const r of gone) logWarn(`    ${r.reason} ${r.url} (${r.issuer ?? 'shared'}; cited in ${r.foundIn.length} place(s))`);
    }
    const blocked = results.filter((r) => r.status === 'blocked');
    if (blocked.length) {
        const hosts = {};
        for (const r of blocked) {
            const host = hostOf(r.url) ?? '?';
            hosts[host] = hosts[host] ?? [];
            hosts[host].push(r.reason);
        }
        logWarn(`${blocked.length} source(s) blocked, on ${Object.keys(hosts).length} host(s):`);
        for (const [host, reasons] of Object.entries(hosts).sort((a, b) => b[1].length - a[1].length)) {
            logWarn(`    ${host}: ${reasons.length} (${[...new Set(reasons)].join(', ')})`);
        }
    }
    const failures = results.filter((r) => r.status === 'error');
    if (failures.length) {
        logError(`${failures.length} source(s) FAILED for a reason that is neither gone nor blocked:`);
        for (const r of failures) logError(`    ${r.reason} ${r.url}`);
    }

    if (!flags['no-db']) {
        const env = await readEnvFile(join(REPO, '.env'));
        const dbUrl = process.env.DATABASE_URL || env.DATABASE_URL;
        if (!dbUrl) {
            logWarn(`DATABASE_URL is not set in ${join(REPO, '.env')} — skipping the Postgres load`);
        } else {
            log(`db: ${describeUrl(dbUrl)}`);
            await loadToPostgres(rows, { url: dbUrl, applyDdl: Boolean(flags.ddl) });
        }
    }

    if (runFailed(results)) {
        logError(`watch-sources: run NOT successful — ${failures.length} source(s) errored`);
        process.exitCode = 1;
        return;
    }
    log('watch-sources: done');
}

main().catch((err) => {
    logError(err.stack || err.message);
    process.exitCode = 1;
});
