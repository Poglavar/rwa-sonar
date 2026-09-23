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
import { claimId, whatIfId, wrapTransaction } from './lib/db-load.mjs';
import { isoDate, log, logError, logWarn, parseArgs, readJson, sleep, ts, writeJson } from './lib/io.mjs';
import { fetchNotionPageText, isNotionSiteHost } from './lib/notion.mjs';
import { describeUrl, psql } from './lib/psql.mjs';
import { hostOf, isDocumentWatchable, kindFromContentType, normaliseUrl } from './lib/sources.mjs';
import { diffLines, summariseDiff } from './lib/textdiff.mjs';
import { refreshCollectorStatus } from './build-collector-status.mjs';
import { partitionEventResolutions } from './lib/event-resolutions.mjs';
import {
    binaryMarker, blockVendor, buildChangeEventSql, buildClaimCheckSql, buildSourceSql, buildVersionSql,
    challengeInBody, conditionalHeaders, decideOutcome, isJsOnlyRead, driveDownloadUrl, fileStamp, htmlDocumentText, isTextual, jsOnlyShell,
    looksLikePdf, normaliseByKind, normaliseLines,
    ARCHIVE_GIVE_UP_AFTER, DEFAULT_USER_AGENT, archiveRefusal, parseArchiveLocation, parseSpnStatus, rawExtension, spnBusy, spnTransient,
    quoteVerdicts, readProvenance, reusableCheckpoint, runFailed, severityForChange, sha256Hex, sourceId,
    storedReading, userAgentFor, verificationUrlForClaim, sourceWatchStatsFileName, stripPublisherChrome, publisherNormalizerVersion
} from './lib/watch.mjs';
import {
    CDX_TIMEOUT_MS, WAYBACK_FALLBACK_CAP, WAYBACK_PACE_MS, archivedProvenance, captureIso, decodeCaptureBody, captureRawUrl, captureViewUrl, cdxQueryUrl,
    parseCdxNewest, waybackNote, wantsWaybackFallback
} from './lib/wayback.mjs';

const HERE = import.meta.dirname;
const REPO = join(HERE, '..');
const SOURCES_FILE = join(HERE, 'data', 'sources.json');
const EVENT_RESOLUTIONS_FILE = join(HERE, 'data', 'event-resolutions.json');
const STATE_FILE = join(HERE, 'data', 'sources-state.json');
const ISSUERS_DIR = join(HERE, 'data', 'issuers');
const VERSIONS_DIR = join(HERE, 'data', 'sources');
const RAW_DIR = join(HERE, 'data', 'raw');
// The evidence tables, then the read-provenance columns on them (read_via, capture_at).
const DDL_FILES = [
    join(REPO, 'db', '2026-09-18-sonar-evidence.sql'),
    join(REPO, 'db', '2026-09-23-sonar-source-provenance.sql')
];
const STATS_FILE = join(REPO, '.last-source-watch-stats.json');
let runStatsFile = STATS_FILE;
const RUN_STARTED_MS = Date.now();
const RUN_STARTED_AT = ts(new Date(RUN_STARTED_MS));

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
  --ddl              Apply ${DDL_FILES.map((f) => `db/${f.split('/').pop()}`).join(' and ')} before loading. Idempotent.
  --no-db            Do everything except the Postgres load (files and checkpoint only).
  --pace=<ms>        Minimum gap between two requests to the SAME host (default ${HOST_PACE_MS}).
  --help             This text.

WHAT A RUN DOES
  Sources are ordered round-robin by host, so the per-host pacing almost never has to block.
  Each fetch sends If-None-Match / If-Modified-Since from the stored version, so an unchanged
  document usually costs a 304. The kind is taken from the response's content-type (the URL is
  only a guess), with the bytes overruling it for a PDF served as octet-stream: pdf ->
  \`pdftotext -layout\` on stdin, html -> chrome stripped and tags removed, api -> JSON with keys
  sorted. Churn lines (bare dates, counters, cookie banners) are dropped before hashing, or every
  page with a clock on it would report a change every day.

  Two hosts serve a viewer instead of the document, and the fetch is rewritten for them while the
  registered URL stays the one the dossier cites: a \`*.notion.site\` page is read through Notion's
  public loadPageChunk API (lib/notion.mjs) and kept as its recordMap, and a
  \`drive.google.com/file/d/<id>\` link is fetched as \`uc?export=download\` and comes back a PDF.

  A Next.js page rendered in the browser (an empty body, its words in \`self.__next_f\` flight
  payloads) is read from those payloads when the markup alone yields a short text.

  A host that refuses us outright (401/403 or a bot wall) is read from its newest Wayback Machine
  capture instead (CDX, then the \`id_\` raw capture; ${WAYBACK_PACE_MS / 1000} s apart, at most ${WAYBACK_FALLBACK_CAP} per run). The
  result says so: \`read_via = 'wayback'\` and \`capture_at\` (the capture's own CDX timestamp)
  on sonar.source and sonar.source_version, with http_status still the live refusal — an archived
  capture is never reported as a live read.

  Quotes are checked against the text BEFORE the churn filter (a price alone on its line is churn
  for the hash, but may be the quoted words); a stored copy is re-read from its raw file for that.
  A blocked source's quotes are "not checkable", never lost.

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

/** Rate limits, temporary outages and connection failures get two backoffs before classification. */
async function fetchWithBackoff(url, conditional, timeoutMs) {
    let response = await fetchOnce(url, conditional, timeoutMs);
    let retried = false;
    for (const wait of BACKOFF_MS) {
        const transientNetwork = ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(response.networkErrorCode);
        if (response.httpStatus !== 429 && response.httpStatus !== 503 && !transientNetwork) break;
        const retryAfter = Number(response.headers['retry-after']);
        const pause = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 60_000) : wait;
        logWarn(`${response.httpStatus ?? response.networkErrorCode} on ${url} — backing off ${pause} ms`);
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

/**
 * A fetched body -> `{kind, text, via, binary}`: PDF through pdftotext, textual payloads through
 * the kind's normaliser (HTML with the Next.js flight reader, lib/watch.mjs `htmlDocumentText`),
 * anything else watched as bytes. Shared by the live fetch and the Wayback fallback, so a capture
 * is read exactly the way the live page would have been.
 */
async function bytesToText(buffer, contentType, url) {
    let kind = kindFromContentType(contentType, url);
    // Drive answers every download as `application/octet-stream`, so the bytes have the last
    // word about what was served (lib/watch.mjs `looksLikePdf`).
    if (kind !== 'pdf' && looksLikePdf(buffer)) kind = 'pdf';
    if (kind === 'pdf') {
        const pdfText = await pdfToText(buffer);
        return {
            kind, text: normaliseByKind('pdf', pdfText), quoteText: normaliseByKind('pdf', pdfText, { keepChurn: true }), via: 'pdf', binary: false
        };
    }
    if (isTextual(contentType) || !contentType) {
        if (kind === 'html') {
            const read = htmlDocumentText(buffer.toString('utf8'));
            return { kind, text: read.text, quoteText: read.quoteText, via: read.via, binary: false };
        }
        const body = buffer.toString('utf8');
        return {
            kind, text: normaliseByKind(kind, body), quoteText: normaliseByKind(kind, body, { keepChurn: true }), via: kind, binary: false
        };
    }
    // Not text and not a PDF (a zip of attestations, say): watched as bytes.
    const marker = binaryMarker(buffer, contentType);
    return { kind, text: marker, quoteText: marker, via: 'binary', binary: true };
}

/** Everything about one source after one look at it. Written to the checkpoint as-is. */
async function watchOne(source, prev, options) {
    const { timeoutMs } = options;
    const id = sourceId(source.url);
    const fetchedAt = ts();
    // Conditional headers always come from the stored version, `--force` included: --force means
    // "ignore today's checkpoint and look again", not "make the server send the body again". A 304
    // IS the answer we want — it is the cheapest possible "unchanged".
    const normalizerVersion = publisherNormalizerVersion(source.url, source.kind);
    const normalizerUpgrade = normalizerVersion > (prev?.normalizerVersion ?? 1);
    const conditional = conditionalHeaders(prev, { normalizerUpgrade });

    // A Google Drive file link serves its own JavaScript viewer, never the file; the bytes are at
    // `uc?export=download`. The SOURCE keeps the URL the dossier cites — only the fetch moves.
    const download = driveDownloadUrl(source.url);
    const res = await fetchWithBackoff(download ?? source.url, conditional, timeoutMs);
    // The bot-wall test reads the BODY only; a vendor header is an annotation on a status that
    // already refused us, never evidence on its own (see lib/watch.mjs).
    const bodyPreview = res.buffer.subarray(0, 4000).toString('utf8');
    const blocked = challengeInBody(bodyPreview);
    const vendor = blockVendor(res.headers);

    const result = {
        id,
        url: source.url,
        // Where the bytes actually came from, when that is not the cited URL. Never written to
        // sonar.source (the citation is the source), but it belongs in the checkpoint so a run can
        // be read back and the rewrite seen.
        resolvedUrl: download ?? null,
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
        diff: null,
        normalizerVersion,
        normalizerUpgrade,
        // Which reader produced the text: html, next-flight, pdf, api, notion, binary, or — when
        // the live host refused us — wayback (with captureTimestamp/captureUrl beside it).
        via: null
    };

    // A 2xx needs the body turned into text before the outcome is known, because the outcome is
    // "same hash" versus "new hash". `quoteText` is the same reading without the churn filter:
    // what the quote check reads (lib/watch.mjs `normaliseLines` keepChurn).
    let text = null;
    let quoteText = null;
    let hash = null;
    let raw = res.buffer;
    // A `*.notion.site` page — whether cited as one or reached by the 308 from
    // `url.prestocks.com` — is a shell whose document lives behind Notion's own public API.
    const notionPage = isNotionSiteHost(hostOf(source.url)) || isNotionSiteHost(hostOf(res.finalUrl));
    if (res.httpStatus !== null && res.httpStatus >= 200 && res.httpStatus < 300 && !blocked) {
        const contentType = res.headers['content-type'];
        result.kind = kindFromContentType(contentType, download ?? source.url);
        if (result.kind !== 'pdf' && looksLikePdf(res.buffer)) result.kind = 'pdf';
        let stage = 'normalise';
        try {
            if (notionPage) {
                // A loadPageChunk parser/timeout/5xx failure is `error`: the host served us the
                // shell but our document read failed. A 403 is classified below as `blocked`,
                // because it is an explicit upstream access wall rather than a crashed watcher.
                stage = 'notion';
                const page = await fetchNotionPageText(res.finalUrl ?? source.url, {
                    userAgent: userAgentFor(hostOf(res.finalUrl ?? source.url)),
                    timeoutMs,
                    html: res.buffer.toString('utf8')
                });
                // The kind stays `html` (it is a web page), but the raw copy kept on disk is the
                // recordMap, so any stored version can be re-rendered without re-fetching it.
                result.kind = 'html';
                result.rawKind = 'api';
                result.notionPageId = page.pageId;
                result.notionBlocks = Object.keys(page.blocks).length;
                raw = Buffer.from(`${JSON.stringify({ pageId: page.pageId, recordMap: page.recordMap })}\n`, 'utf8');
                result.bytes = raw.length;
                text = normaliseLines(page.text, { htmlWidgets: true });
                quoteText = normaliseLines(page.text, { htmlWidgets: true, keepChurn: true });
                result.via = 'notion';
            } else {
                const read = await bytesToText(res.buffer, contentType, download ?? source.url);
                result.kind = read.kind;
                result.via = read.via;
                if (read.binary) result.binary = true;
                text = read.text;
                quoteText = read.quoteText;
            }
            text = stripPublisherChrome(source.url, text);
            quoteText = stripPublisherChrome(source.url, quoteText);
            hash = sha256Hex(text);
            result.textChars = text.length;
        } catch (err) {
            // A public Notion document can start returning 403 from loadPageChunk while the
            // viewer shell still answers 200. That is an upstream access wall, not a crashed
            // watcher. Keep it visible as blocked and continue; timeouts/5xx/parser failures stay
            // errors and make the run partial.
            const notionBlocked = stage === 'notion' && /\bhttp 403\b/i.test(err.message);
            result.status = notionBlocked ? 'blocked' : 'error';
            result.reason = `${stage}: ${err.message}`;
            result.error = err.message;
            return { result, text: null, quoteText: null, raw, previousTextPath: prev?.textPath ?? null };
        }
    }

    const outcome = decideOutcome({
        host: hostOf(source.url),
        httpStatus: res.httpStatus,
        networkErrorCode: res.networkErrorCode,
        blocked,
        vendor,
        // The Notion path has already read the document, so the shell it came wrapped in is not
        // evidence of anything; only an unrewritten HTML page can still be a JavaScript shell.
        jsOnly: isJsOnlyRead({ kind: result.kind, binary: result.binary === true, notion: notionPage, text, rawHtml: res.buffer.toString('utf8') }),
        sameHash: hash !== null && prev?.contentHash === hash,
        retriedAfterBackoff: res.retriedAfterBackoff
    });
    result.status = outcome.status;
    result.reason = outcome.reason;
    if (outcome.status === 'error' || outcome.status === 'blocked' || outcome.status === 'gone') {
        result.error = outcome.reason;
    }
    if (hash !== null) result.contentHash = hash;
    if (options.wayback && wantsWaybackFallback({ status: result.status, httpStatus: res.httpStatus, botWall: blocked, url: source.url })) {
        const archived = await readFromWayback(source, prev, result, options);
        if (archived) return archived;
    }
    return { result, text, quoteText, raw, previousTextPath: prev?.textPath ?? null };
}

/**
 * The live host refused us (401/403 or a bot wall): read the newest Wayback capture instead
 * (lib/wayback.mjs). On success the result is `ok`/`changed` against the stored hash like any
 * read, but `via: 'wayback'`, `captureTimestamp` and `captureUrl` say where the words came from,
 * `httpStatus` stays the LIVE answer, and `reason` carries the live refusal plus the capture date;
 * sonar.source gets `read_via = 'wayback'` and `capture_at` (lib/watch.mjs `readProvenance`), so
 * neither the checkpoint nor the database can pass the capture off as the live page. `error` is
 * null: a successful archived read is not a fetch error. Returns
 * null (the result stays `blocked`, with the reason extended) when there is no usable capture or
 * the per-run cap is spent. Never an `error`: the archive failing us is not our watch failing.
 */
async function readFromWayback(source, prev, result, { timeoutMs, wayback }) {
    const liveReason = result.reason;
    if (wayback.used >= WAYBACK_FALLBACK_CAP) {
        if (!wayback.capLogged) {
            logWarn(`wayback fallback cap reached (${WAYBACK_FALLBACK_CAP} this run) — further refused sources stay blocked without an archive read`);
            wayback.capLogged = true;
        }
        wayback.skipped += 1;
        result.reason = `${liveReason}; wayback fallback cap reached`;
        return null;
    }
    wayback.used += 1;
    const pace = async () => {
        const gap = WAYBACK_PACE_MS - (Date.now() - wayback.lastMs);
        if (gap > 0) await sleep(gap);
        wayback.lastMs = Date.now();
    };
    const giveUp = (why) => {
        wayback.failed += 1;
        result.reason = `${liveReason}; wayback: ${why}`;
        result.error = result.reason;
        log(`wayback: no archive read for ${source.url} — ${why}`);
        return null;
    };

    // The CDX API is slow and intermittently overloaded (a 30 s timeout on thedefiant.io,
    // 2026-09-23), so a timeout or 5xx gets one more paced attempt before the source stays blocked.
    let capture;
    let cdxFailure = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        await pace();
        try {
            const cdx = await fetch(cdxQueryUrl(source.url), {
                headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
                signal: AbortSignal.timeout(CDX_TIMEOUT_MS)
            });
            if (cdx.ok) {
                capture = parseCdxNewest(await cdx.text());
                cdxFailure = null;
                break;
            }
            await cdx.body?.cancel();
            cdxFailure = `cdx http-${cdx.status}`;
            if (cdx.status < 500) break;
        } catch (err) {
            cdxFailure = `cdx ${err.name === 'TimeoutError' ? 'timeout' : (err.cause?.code || err.message)}`;
        }
    }
    if (cdxFailure) return giveUp(cdxFailure);
    if (!capture) return giveUp('no 200 capture in the archive');

    const captureUrl = captureViewUrl(capture.timestamp, capture.original);
    const mark = (status, reasonTail) => {
        result.via = 'wayback';
        result.captureTimestamp = captureIso(capture.timestamp);
        result.captureUrl = captureUrl;
        result.resolvedUrl = captureRawUrl(capture.timestamp, capture.original);
        result.liveReason = liveReason;
        result.status = status;
        result.waybackNote = waybackNote({ liveReason, captureTimestamp: capture.timestamp, captureUrl });
        result.reason = `${reasonTail} — ${result.waybackNote}`;
        result.error = null;
        if (!result.archiveUrl) result.archiveUrl = captureUrl;
        wayback.read += 1;
    };

    // The same capture we read last time: nothing new to fetch, and the stored text is still it.
    if (prev?.via === 'wayback' && prev.captureTimestamp === captureIso(capture.timestamp)
        && prev.contentHash && prev.textPath) {
        result.contentHash = prev.contentHash;
        result.kind = prev.kind ?? result.kind;
        mark('ok', 'same Wayback capture as last run');
        return { result, text: null, quoteText: null, raw: Buffer.alloc(0), previousTextPath: prev.textPath };
    }

    await pace();
    // node:https without decoding, never fetch(): see lib/wayback.mjs `decodeCaptureBody`.
    const res = await fetchWithBigHeaders(captureRawUrl(capture.timestamp, capture.original),
        { 'User-Agent': USER_AGENT, Accept: '*/*' }, timeoutMs);
    if (res.httpStatus === null || res.httpStatus < 200 || res.httpStatus >= 300) {
        return giveUp(`capture ${res.httpStatus === null ? res.networkErrorCode : `http-${res.httpStatus}`}`);
    }
    try {
        res.buffer = decodeCaptureBody(res.buffer);
    } catch (err) {
        return giveUp(`capture undecodable: ${err.code || err.message}`);
    }
    // A capture of the refusal itself (the archive crawled the same wall) is not the document.
    if (challengeInBody(res.buffer.subarray(0, 4000).toString('utf8'))) return giveUp('the capture is a bot wall too');
    let read;
    try {
        read = await bytesToText(res.buffer, res.headers['content-type'], capture.original);
    } catch (err) {
        return giveUp(`capture unreadable: ${err.message}`);
    }
    const text = stripPublisherChrome(source.url, read.text);
    const quoteText = stripPublisherChrome(source.url, read.quoteText);
    if (read.kind === 'html' && jsOnlyShell(text, res.buffer.toString('utf8'))) return giveUp('the capture is a javascript-only shell');
    const hash = sha256Hex(text);
    result.kind = read.kind;
    result.bytes = res.buffer.length;
    result.textChars = text.length;
    result.contentType = res.headers['content-type'] ?? null;
    result.contentHash = hash;
    if (read.binary) result.binary = true;
    mark(prev?.contentHash === hash ? 'ok' : 'changed', prev?.contentHash === hash ? 'same hash' : 'new hash');
    result.captureReader = read.via;
    return { result, text, quoteText, raw: res.buffer, previousTextPath: prev?.textPath ?? null };
}

/** The diff and severity of a changed source, plus the files it just wrote. */
async function recordChange(result, { text, raw, previousTextPath }) {
    // `rawKind` differs from `kind` only where the raw copy is not what the URL served: a Notion
    // page is an html source whose raw file is the recordMap JSON it was rendered from.
    const { rawPath, textPath } = await writeVersionFiles(result.id, result.fetchedAt,
        result.rawKind ?? result.kind, raw, text);
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
    const severity = severityForChange({
        kind: result.kind, changedLines: diff.changedLines, removedLines: diff.removedLines, addedLines: diff.addedLines
    });
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

/**
 * Every quote the dossiers rely on, keyed by the normalised URL it was read from: `claims[]` (id
 * as sonar.claim) and `whatIf[]` (id as sonar.what_if). Read from the dossiers rather than the
 * database so a run with --no-db still checks, and so a quote written this morning is checked
 * this morning.
 */
async function loadQuoteRegistry() {
    const byUrl = new Map();
    const add = (url, item) => {
        const key = normaliseUrl(url);
        if (!key) return;
        if (!byUrl.has(key)) byUrl.set(key, []);
        byUrl.get(key).push(item);
    };
    let files = [];
    try {
        files = (await readdir(ISSUERS_DIR)).filter((f) => f.endsWith('.json')).sort();
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
    let total = 0;
    for (const file of files) {
        const slug = file.replace(/\.json$/, '');
        const dossier = await readJson(join(ISSUERS_DIR, file), null);
        if (!dossier) continue;
        for (const claim of Array.isArray(dossier.claims) ? dossier.claims : []) {
            if (typeof claim?.quote !== 'string' || typeof claim?.url !== 'string') continue;
            add(verificationUrlForClaim(claim, dossier), {
                id: claimId(slug, claim.field, claim.url, claim.quote), kind: 'claim',
                ref: claim.field, slug, quote: claim.quote, citedUrl: claim.url
            });
            total += 1;
        }
        for (const entry of Array.isArray(dossier.whatIf) ? dossier.whatIf : []) {
            if (typeof entry?.quote !== 'string' || typeof entry?.url !== 'string') continue;
            add(entry.url, { id: whatIfId(slug, entry.mode), kind: 'what-if', ref: entry.mode, slug, quote: entry.quote });
            total += 1;
        }
    }
    return { byUrl, total };
}

/**
 * A read that produced no fresh text (a live 304, or the same Wayback capture as last run) stands on
 * the stored version. Re-read its raw copy (lib/watch.mjs `storedReading`) — trusted only when the
 * re-read reproduces the stored hash, so a binary marker or an older extraction generation falls
 * back to the stored text file — to get:
 *  - the UNFILTERED text for the quote check (the stored .txt is churn-filtered, which drops a
 *    price alone on its line), recomputed rather than stored twice on disk;
 *  - whether the stored copy is itself a JavaScript shell. app.ventuals.com/sunset answered 304 to
 *    an etag whose stored text was the 8 characters "Ventuals", so it was `ok` and its quote was
 *    checked against the stub and reported lost. Such a source is `blocked`, as its live read is.
 * PDFs cost a pdftotext each, so they are only re-read when a quote needs them.
 * Returns the text for the quote check, or null when there is none.
 */
async function reviewStoredCopy(result, prev, { needQuotes }) {
    const textPath = result.textPath ?? prev?.textPath ?? null;
    const readStoredText = async () => {
        if (!textPath) return null;
        try {
            return await readFile(join(REPO, textPath), 'utf8');
        } catch {
            return null;
        }
    };
    const rawPath = prev?.rawPath ?? null;
    const ext = typeof rawPath === 'string' ? rawPath.split('.').pop() : null;
    if (!rawPath || (ext === 'pdf' && !needQuotes)) return needQuotes ? readStoredText() : null;
    let reading = null;
    try {
        const buffer = await readFile(join(REPO, rawPath));
        const payload = ext === 'pdf' ? await pdfToText(buffer) : buffer.toString('utf8');
        reading = storedReading({ rawExt: ext, via: prev?.via ?? null, payload });
    } catch (err) {
        logWarn(`${result.url}: stored raw copy ${rawPath} unreadable (${err.code || err.message}) — quote check uses the stored text`);
    }
    if (reading !== null && sha256Hex(stripPublisherChrome(result.url, reading.text)) === result.contentHash) {
        if (reading.jsOnly) {
            result.status = 'blocked';
            result.reason = 'javascript-only page: no text without a browser (the host answered'
                + ` ${result.httpStatus === 304 ? '304' : 'with the same copy'} over a stored copy that is itself a JavaScript shell)`;
            result.error = result.reason;
            return null;
        }
        return needQuotes ? stripPublisherChrome(result.url, reading.quoteText) : null;
    }
    return needQuotes ? readStoredText() : null;
}

/** The rows for Postgres: sources always, versions and events only for what actually happened. */
function buildRows(results, previousState) {
    const sources = [];
    const versions = [];
    const events = [];
    for (const result of results) {
        const prev = previousState[result.url] ?? null;
        const changed = result.status === 'changed';
        // A read from an archived capture says so wherever it surfaces (lib/wayback.mjs).
        const { evidence: archived, prefix: archivedPrefix } = archivedProvenance(result);
        const versionRecorded = changed || result.versionRecorded === true;
        const { readVia, captureAt } = readProvenance(result, prev);
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
            error: result.error,
            readVia,
            captureAt
        });
        if (versionRecorded) {
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
                diffSummary: result.diff?.summary == null ? (archived ? archivedPrefix.trim() : null) : `${archivedPrefix}${result.diff.summary}`,
                diffSeverity: result.diff?.severity ?? null,
                diffMethod: result.diff?.method ?? 'none',
                diffAdded: result.diff?.added ?? null,
                diffRemoved: result.diff?.removed ?? null,
                readVia,
                captureAt
            });
            if (changed && result.diff?.severity === 'caution') {
                events.push({
                    detectedAt: result.fetchedAt,
                    kind: 'legal-term',
                    subjectType: 'source',
                    subjectId: result.id,
                    field: null,
                    before: prev?.contentHash ?? null,
                    after: result.contentHash,
                    severity: 'caution',
                    summary: `${archivedPrefix}${result.title ?? result.url}: ${result.diff.summary}`,
                    evidence: {
                        ...(archived ?? {}),
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
        // A quote that stops being verbatim in its source is the strongest signal the watcher has
        // (EVIDENCE.md §2.3); only the TRANSITION into lost is an event, one per claim.
        const previouslyLost = new Set(Array.isArray(prev?.quotesLost) ? prev.quotesLost : []);
        for (const item of result.quotes?.lost ?? []) {
            if (previouslyLost.has(item.id)) continue;
            events.push({
                detectedAt: result.fetchedAt,
                kind: 'quote-lost',
                subjectType: item.kind,
                subjectId: item.id,
                field: item.ref,
                before: null,
                after: result.contentHash,
                severity: 'warning',
                summary: `${archivedPrefix}${item.slug}: the quoted words for ${item.kind} ${item.ref} are no longer in ${result.title ?? result.url}`,
                evidence: {
                    ...(archived ?? {}),
                    url: result.url,
                    issuer: result.issuer,
                    quote: item.quote,
                    versionFetchedAt: result.fetchedAt,
                    contentHash: result.contentHash,
                    textPath: result.textPath ?? prev?.textPath ?? null
                }
            });
        }
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
        for (const file of DDL_FILES) {
            const ddl = await readFile(file, 'utf8');
            log(`db: applying ${relative(REPO, file)} (${ddl.length} bytes, idempotent)`);
            await psql(url, ddl, 'ddl');
        }
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
    // A targeted repair/smoke run is not evidence that the full registry is healthy. Keep its
    // outcome for diagnostics without overwriting the canonical full-run heartbeat consumed by
    // collector health and operations alerts.
    if (flags.only || flags.limit) {
        runStatsFile = join(REPO, sourceWatchStatsFileName({ only: flags.only, limit: flags.limit }));
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
    const onchainLocatorCount = sources.filter((source) => !isDocumentWatchable(source.url)).length;
    sources = sources.filter((source) => isDocumentWatchable(source.url));
    if (typeof flags.only === 'string') {
        sources = sources.filter((s) => s.issuer === flags.only);
        if (sources.length === 0) throw new Error(`no sources for issuer ${flags.only}`);
    }
    if (flags.limit) {
        const limit = Number(flags.limit);
        if (!Number.isFinite(limit) || limit < 1) throw new Error(`--limit must be a positive number, got ${flags.limit}`);
        sources = sources.slice(0, limit);
    }
    // A Google Drive file link is registered as `html` (that is what the viewer page is) but
    // downloads a PDF, so those sources need poppler too — and a missing binary must be a loud
    // failure now rather than a per-source `error` 200 fetches in.
    if (sources.some((s) => s.kind === 'pdf' || driveDownloadUrl(s.url))) await assertPdftotext();

    const previous = await readJson(STATE_FILE, {});
    const quoteRegistry = await loadQuoteRegistry();
    const checkpointFile = join(RAW_DIR, `sources-${isoDate()}.json`);
    const checkpoint = flags.force ? {} : await readJson(checkpointFile, {});
    const resumed = Object.entries(checkpoint)
        .filter(([url, result]) => reusableCheckpoint(result) && sources.some((s) => s.url === url)).length;

    log(`watch-sources: ${sources.length} source(s), registry ${registry.generatedAt}`
        + `${flags.only ? `, only ${flags.only}` : ''}${flags.archive ? ', archiving new versions' : ''}`);
    if (onchainLocatorCount) log(`watch-sources: ${onchainLocatorCount} on-chain locator(s) left to the chain watcher`);
    if (resumed) log(`watch-sources: resuming — ${resumed} source(s) already in ${relative(REPO, checkpointFile)}`);
    if (Object.keys(previous).length === 0) log('watch-sources: no stored state — every source is a first sight');

    const ordered = orderByHost(sources);
    const lastHitByHost = new Map();
    const startedMs = Date.now();
    const results = [];
    let reusedFromCheckpoint = 0;
    let done = 0;
    let archived = 0;
    let archiveFailures = 0;
    let archiveFailureStreak = 0;
    let archiveGaveUp = null;
    let lastArchiveMs = 0;
    // Wayback fallback for hosts that refuse us (lib/wayback.mjs): paced and capped per run.
    const wayback = { used: 0, read: 0, failed: 0, skipped: 0, lastMs: 0, capLogged: false };

    for (const source of ordered) {
        done += 1;
        const cached = checkpoint[source.url];
        // Successful reads and explicit findings are safe restart checkpoints. A transient error
        // is not: reusing it made a same-day manual retry reproduce the old failure without making
        // an HTTP request. Retry errors until they become a real outcome or the run ends partial.
        if (reusableCheckpoint(cached)) {
            results.push(cached);
            reusedFromCheckpoint += 1;
            continue;
        }
        const host = hostOf(source.url) ?? '';
        const wait = pace - (Date.now() - (lastHitByHost.get(host) ?? 0));
        if (wait > 0) await sleep(wait);
        lastHitByHost.set(host, Date.now());

        const prev = previous[source.url] ?? null;
        const { result, text, quoteText, raw, previousTextPath } = await watchOne(source, prev,
            { timeoutMs: TIMEOUT_MS, wayback });
        results.push(result);
        const registered = quoteRegistry.byUrl.get(normaliseUrl(source.url)) ?? [];
        // No fresh text: the read stands on the stored version, which may itself be a JS shell.
        const storedQuoteText = text === null && result.status === 'ok'
            ? await reviewStoredCopy(result, prev, { needQuotes: registered.length > 0 })
            : null;

        if (result.status === 'changed') {
            // The raw bytes only exist in memory, so the version files are written here, before
            // the checkpoint records the paths.
            await recordChange(result, { text, raw, previousTextPath });
            if (result.normalizerUpgrade) {
                result.versionRecorded = true;
                result.status = 'ok';
                // A capture read keeps saying it is one (its `error` carries the Wayback note).
                result.reason = `normalizer upgraded to v${result.normalizerVersion}; baseline refreshed without an external-change event`
                    + (result.via === 'wayback' ? ` — ${result.waybackNote}` : '');
            }
        }
        if (registered.length) {
            // Unfiltered text (quoteText) when this run read the document, the stored copy re-read
            // otherwise; a blocked source's quotes are not checkable (lib/watch.mjs quoteVerdicts).
            const checked = quoteVerdicts({
                status: result.status,
                text: typeof quoteText === 'string' ? quoteText : storedQuoteText,
                quotes: registered,
                // The page-number rule of the quote key applies to PDF text only; a stored copy
                // was read as whatever kind it was when it was stored.
                kind: typeof quoteText === 'string' ? result.kind : (prev?.kind ?? result.kind)
            });
            if (checked !== null) {
                result.quotes = {
                    checked: checked.checked,
                    found: checked.found.length,
                    foundIds: checked.found.map((q) => q.id),
                    skipped: checked.skipped,
                    notCheckable: checked.notCheckable,
                    lost: checked.lost.map((q) => ({ id: q.id, kind: q.kind, ref: q.ref, slug: q.slug, quote: q.quote }))
                };
                for (const q of checked.lost) logWarn(`quote lost in ${source.url}: ${q.slug} ${q.kind} ${q.ref}`);
                if (checked.notCheckable) log(`${checked.notCheckable} quote(s) not checkable in ${source.url}: the source is blocked (${result.reason})`);
            }
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
            versions: (prev?.versions ?? 0)
                + (result.status === 'changed' || result.versionRecorded === true ? 1 : 0),
            normalizerVersion: result.normalizerVersion ?? prev?.normalizerVersion ?? 1,
            // Provenance of the stored text: `wayback` means the live host refused us and the text
            // is from the capture dated `captureTimestamp` — never a live read. A 304 keeps the
            // reader of the text it confirmed.
            via: result.via ?? (result.httpStatus === 304 ? (prev?.via ?? null) : null),
            readVia: readProvenance(result, prev).readVia,
            captureTimestamp: result.via === 'wayback' ? result.captureTimestamp : null,
            captureUrl: result.via === 'wayback' ? result.captureUrl : null,
            quotesLost: result.quotes ? result.quotes.lost.map((q) => q.id) : (prev?.quotesLost ?? [])
        };
    }
    await writeJson(STATE_FILE, { ...previous, ...state });

    const rows = buildRows(results, previous);
    const byStatus = {};
    for (const result of results) byStatus[result.status] = (byStatus[result.status] ?? 0) + 1;
    log(`watch-sources: ${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(' ')}`
        + ` · ${rows.versions.length} new version(s) · ${rows.events.length} change event(s)`);
    const quoteTotals = results.reduce((acc, r) => {
        if (!r.quotes) return acc;
        acc.checked += r.quotes.checked;
        acc.found += r.quotes.found;
        acc.lost += r.quotes.lost.length;
        acc.notCheckable += r.quotes.notCheckable ?? 0;
        acc.sources += 1;
        return acc;
    }, { checked: 0, found: 0, lost: 0, notCheckable: 0, sources: 0 });
    if (wayback.used || wayback.skipped) {
        log(`watch-sources: wayback fallback — ${wayback.used} tried, ${wayback.read} read from a capture,`
            + ` ${wayback.failed} without a usable capture${wayback.skipped ? `, ${wayback.skipped} skipped at the cap of ${WAYBACK_FALLBACK_CAP}` : ''}`);
    }
    const viaCounts = {};
    for (const result of results) if (result.via) viaCounts[result.via] = (viaCounts[result.via] ?? 0) + 1;
    log(`watch-sources: read via ${Object.entries(viaCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    log(`watch-sources: quotes — ${quoteRegistry.total} registered, ${quoteTotals.checked} checked in ${quoteTotals.sources} source(s):`
        + ` ${quoteTotals.found} found, ${quoteTotals.lost} lost, ${quoteTotals.notCheckable} not checkable (source blocked)`);
    if (quoteTotals.lost) {
        logWarn(`${quoteTotals.lost} quote(s) no longer verbatim in their source — claims marked changed, one event each:`);
        for (const r of results) for (const q of r.quotes?.lost ?? []) logWarn(`    ${q.slug} ${q.kind} ${q.ref}: ${r.url}`);
    }
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
            const claimChecks = [];
            for (const r of results) {
                if (!r.quotes) continue;
                // Only a quote that got a verdict is written back: a not-checkable one (blocked
                // source) or one too short to check was not looked for, so it is neither found nor lost.
                const lostIds = new Set(r.quotes.lost.map((q) => q.id));
                const foundIds = new Set(r.quotes.foundIds ?? []);
                for (const q of quoteRegistry.byUrl.get(normaliseUrl(r.url)) ?? []) {
                    if (q.kind !== 'claim' || (!lostIds.has(q.id) && !foundIds.has(q.id))) continue;
                    claimChecks.push({ id: q.id, found: foundIds.has(q.id), checkedAt: r.fetchedAt });
                }
            }
            if (claimChecks.length) {
                const check = buildClaimCheckSql(claimChecks);
                await psql(dbUrl, wrapTransaction(check.sql), check.table);
                log(`db: ${check.rows} claim(s) marked checked`);
            }
        }
    }

    const endedAt = ts();
    // Editorially reviewed events remain in the audit trail, but must not page the operator again.
    // This is especially important for recurring publisher chrome and for our own evidence-text
    // corrections: those are useful provenance, not new real-world changes.
    const resolutionDb = await readJson(EVENT_RESOLUTIONS_FILE, { items: [] });
    const eventReview = partitionEventResolutions(rows.events, resolutionDb.items);
    const materialEvents = eventReview.open
        .filter((event) => event.severity === 'warning' || event.severity === 'caution');
    const noticeLines = materialEvents.length === 0 ? [] : [
        `RWA evidence watch: ${materialEvents.length} material source change(s) across ${sources.length} active URLs`,
        ...materialEvents.slice(0, 3).map((event) => `  • ${event.summary} · https://rwasonar.com/watch.html`),
        'Evidence: https://rwasonar.com/watch.html'
    ];
    const sourceStats = {
        watchStatus: failures.length ? 'partial' : 'ok',
        lastRunStartedAt: RUN_STARTED_AT,
        lastRunEndedAt: endedAt,
        durationSec: Math.round((Date.now() - RUN_STARTED_MS) / 1000),
        activeSources: sources.length,
        sourcesEvaluated: results.length,
        httpFetches: results.length - reusedFromCheckpoint,
        resumedFromCheckpoint: reusedFromCheckpoint,
        statusCounts: byStatus,
        versionsRecorded: rows.versions.length,
        changeEvents: rows.events.length,
        materialEvents: materialEvents.length,
        reviewedEventsSuppressed: eventReview.resolved.length,
        quotesRegistered: quoteRegistry.total,
        quotesChecked: quoteTotals.checked,
        quotesFound: quoteTotals.found,
        quotesLost: quoteTotals.lost,
        quotesNotCheckable: quoteTotals.notCheckable,
        archived,
        archiveFailures,
        waybackFallback: { tried: wayback.used, read: wayback.read, failed: wayback.failed, skippedAtCap: wayback.skipped },
        readVia: viaCounts,
        failures: failures.length,
        failureReasons: failures.slice(0, 20).map((result) => ({ url: result.url, reason: result.reason })),
        noticeLines
    };
    await writeJson(runStatsFile, sourceStats);
    if (runStatsFile === STATS_FILE) {
        const collectorOutputs = [join(REPO, 'stocks-collector-status.json')];
        const docroot = process.env.RWA_DOCROOT;
        if (typeof docroot === 'string' && docroot !== '') collectorOutputs.push(join(docroot, 'stocks-collector-status.json'));
        await refreshCollectorStatus({ outputs: collectorOutputs });
    }
    log(`watch-sources: wrote ${relative(REPO, runStatsFile)} — status=${sourceStats.watchStatus}, evaluated ${sourceStats.sourcesEvaluated}/${sourceStats.activeSources}, fetched ${sourceStats.httpFetches}`);

    if (runFailed(results)) {
        logError(`watch-sources: run NOT successful — ${failures.length} source(s) errored`);
        process.exitCode = 1;
        return;
    }
    log('watch-sources: done');
}

main().catch(async (err) => {
    logError(err.stack || err.message);
    try {
        await writeJson(runStatsFile, {
            watchStatus: 'failed',
            lastRunStartedAt: RUN_STARTED_AT,
            lastRunEndedAt: ts(),
            durationSec: Math.round((Date.now() - RUN_STARTED_MS) / 1000),
            activeSources: null,
            sourcesEvaluated: null,
            httpFetches: null,
            resumedFromCheckpoint: null,
            failures: 1,
            failureReasons: [{ reason: err.message }],
            noticeLines: []
        });
        if (runStatsFile === STATS_FILE) {
            const outputs = [join(REPO, 'stocks-collector-status.json')];
            if (process.env.RWA_DOCROOT) outputs.push(join(process.env.RWA_DOCROOT, 'stocks-collector-status.json'));
            await refreshCollectorStatus({ outputs });
        }
    } catch (statsError) {
        logError(`watch-sources: could not record failed outcome: ${statsError.message}`);
    }
    process.exitCode = 1;
});
