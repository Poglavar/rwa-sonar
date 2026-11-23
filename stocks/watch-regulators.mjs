#!/usr/bin/env node
// The daily regulator-notice watcher: reads the publications of the regulators relevant to the
// dossiers' jurisdictions (SEC, CFTC, FINRA, FCA, FINMA, BaFin, ESMA, the Central Bank of Ireland,
// FMA Liechtenstein, CIMA, MAS, SMV Panama, ASIC), matches every notice against the parties the
// case-law watcher derives from the dossiers, stores each match in sonar.regulator_notice_match and
// each source's check in sonar.regulator_check, and raises a sonar.change_event of kind
// `regulator-notice` for every NEW match. An event is a candidate for a human to read, never a finding.
// Every notice read, matched or not, is first stored in sonar.regulator_notice (ingest), and the
// matching reads from there (processing): a failure of the second never costs the first
// (lib/regulator-run.mjs).
//
// The decisions (names, parsers, match strength, events, SQL) are in lib/regulators.mjs and unit
// tested in regulators.test.js; this file is the IO: pacing, retries, the kept raw reads, psql, the
// per-source checkpoint and the one Telegram summary.

import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { backoffMs, retryable, reviewIndex } from './lib/caselaw.mjs';
import { wrapTransaction } from './lib/db-load.mjs';
import { readEnvFile } from './lib/env.mjs';
import { log, logError, logWarn, parseArgs, readJson, sleep, ts, writeJson } from './lib/io.mjs';
import { describeUrl, psql } from './lib/psql.mjs';
import { isKeptName, keepRaw, listKept, pruneKept, readKept } from './lib/raw-keep.mjs';
import { ingestSource, processSource } from './lib/regulator-run.mjs';
import {
    NOT_FEASIBLE, QUERY_WINDOW_DAYS, SOURCES, buildNoticeStoreSql, buildReadChecksQuery, buildReadMatchesQuery,
    buildReadUnmatchedQuery, collectNotices, deriveWatchNames, formatTelegramSummary, knownBlock,
    normaliseStoredChecks, normaliseStoredMatches, noticeRows, parseStoreCounts, runVerdict, selectSources
} from './lib/regulators.mjs';
import { stageFail, stageOk, stageSkip, stageStats, stageTally, worstStatus } from './lib/run-stages.mjs';
import { postRunNotifications, telegramConfigured } from './lib/telegram.mjs';
import { userAgentFor } from './lib/watch.mjs';

const HERE = import.meta.dirname;
const REPO = join(HERE, '..');
const ISSUERS_DIR = join(HERE, 'data', 'issuers');
const EXTRA_FILE = join(HERE, 'data', 'caselaw-extra.json');
const REVIEWED_FILE = join(HERE, 'data', 'regulators-reviewed.json');
const RAW_DIR = join(HERE, 'data', 'raw', 'regulators');
const RUN_STARTED_MS = Date.now();

const DEFAULT_PACE_MS = 1500;
const SEC_PACE_MS = 1000;
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 45_000;
/** Distinct raw reads kept per source (gzip, deduplicated), for looking at what a parser was given. */
const RAW_KEEP = 5;
/** Reads whose notices could not be stored are retried for this long, then dropped with an error. */
const PENDING_MAX_AGE_MS = 30 * 86_400_000;
const PENDING_MAX_FILES = 30;
/** A checkpoint older than this belongs to an earlier day's run and is not resumed. */
const CHECKPOINT_MAX_AGE_MS = 6 * 3600 * 1000;

/** Stats and checkpoint per selection, so an hourly --only run never overwrites the daily run's outcome. */
function runFiles(only) {
    const suffix = only ? `-${String(only).replace(/[^a-z0-9,-]/gi, '').replace(/,/g, '+')}` : '';
    return {
        stats: join(REPO, `.last-regulators-watch-stats${suffix}.json`),
        checkpoint: join(REPO, `.regulators-watch-checkpoint${suffix}.json`)
    };
}

function usage() {
    const daily = SOURCES.filter((s) => s.cadence === 'daily');
    const hourly = SOURCES.filter((s) => s.cadence !== 'daily');
    const row = (s) => `  ${s.id.padEnd(24)} ${s.regulator} (${s.jurisdiction}) — ${s.label}; ${s.format}, ${s.window}`
        + `${s.knownBlocked ? `; BLOCKED (known since ${s.knownBlocked.since}): ${s.knownBlocked.reason}` : ''}`;
    console.log(`watch-regulators.mjs — daily regulator-notice watcher: warnings, enforcement, suspensions, registers

USAGE
  node stocks/watch-regulators.mjs --run [options]

OPTIONS
  --run              Actually fetch. Without it this help is printed and nothing runs.
  --only=<ids>       Only these sources (comma list of ids below). Hourly sources run ONLY this way.
  --window-days=<n>  How far back the query sources look (EDGAR, FINRA disciplinary), default ${QUERY_WINDOW_DAYS}.
                     A longer window once is a backfill; new matches it finds are events like any other.
  --fresh            Ignore a checkpoint left by an interrupted run and start over.
  --no-db            Fetch, parse and match only: no state is read or written, so nothing is an event.
  --no-telegram      Never send the summary, whatever is in .env. It is still logged.
  --help             This text.

SOURCES (daily)
${daily.map(row).join('\n')}

SOURCES (hourly — the FCA warnings feed carries only its newest 20, ~20+ a day)
${hourly.map(row).join('\n')}

NOT POLLED (researched 2026-09-30, and why)
${NOT_FEASIBLE.map((n) => `  ${n.regulator}: ${n.reason}`).join('\n')}

WHAT A RUN DOES
  1. Derives the watched names from the dossiers with the case-law watcher's own deriveQueries
     (lib/caselaw.mjs) plus stocks/data/caselaw-extra.json — the two watchers watch the same parties.
  2. Per source (in order, checkpointed), INGEST: fetch (paced per host, retried on 429/5xx), keep the
     raw bodies gzip-compressed and once per distinct content under ${relative(REPO, RAW_DIR)}/<source>/
     (newest ${RAW_KEEP} distinct reads), parse into notices with the regulator's OWN dates, and store EVERY
     notice in sonar.regulator_notice (one row per notice version; a re-read only moves last_seen_at)
     in its own write, before any matching. A body that will not parse, or notices that cannot be
     stored, are kept in <source>/pending/ and replayed through the parser at the start of the next
     runs until they are stored (dropped with an error after ${PENDING_MAX_AGE_MS / 86_400_000} days).
     The stored matches/checks are read only to PROCESS: when that read fails, every source is still
     fetched and stored, and nothing is matched until a run can read them.
     PROCESSING: this run's notices plus any stored ones no run has matched yet (matched_at null)
     are matched against every name:
       strong = the full legal name, corporate suffix included (Ltd = Limited, Inc = Incorporated, …);
       weak   = a brand or bare name ("xStocks", "DekaBank"), or the legal name's distinctive core
                without its suffix ("Payward" for "Payward, Inc."); never a stoplisted word.
     "subject" when the name is in the notice's title / named firm, "text" when only in its body.
     Query sources look back ${QUERY_WINDOW_DAYS} days: EDGAR full-text search per legal name (only
     filings the entity itself FILED), BrokerCheck per US legal name (disclosure counts), FINRA
     disciplinary actions for the window.
  3. Each source's processing is written in one transaction as it finishes (the checkpoint): its matches
     (sonar.regulator_notice_match, idempotent on regulator + notice + entity), its check row
     (sonar.regulator_check: status, consecutive failures, newest notice date), its events and the
     notices' matched_at. A failed processing step is recorded (processingStatus in the stats, a
     failure line) and never stops the next source's fetch.
  4. A source's FIRST good read is a baseline: matches recorded, nothing raised. After that a new
     match -> one change_event per (issuer, notice), kind regulator-notice: warning (strong, in the
     subject of a warning / enforcement / suspension / sanction), caution (other strong), info (weak).
  5. Any source that failed, went stale (newest notice older than its limit) or has a gap (a
     newest-N feed that no longer reaches the last good read) fails the run: exit 1, ONE Telegram
     summary, and the stats file says which and for how many runs in a row. A source flagged
     knownBlocked (lib/regulators.mjs) whose read is refused by the host's bot wall is reported as
     "blocked (known)" in the log and the stats (knownBlocked) instead: not a failure, still tried
     every run, and a good read is recorded as usual.

RESUME
  A run killed part-way is resumed by the next run within ${CHECKPOINT_MAX_AGE_MS / 3600000} h (same detected_at, finished sources
  skipped and counted); the checkpoint file is removed when a run completes.

FILES
  .last-regulators-watch-stats.json         the outcome (…-stats-<ids>.json for an --only run)
  stocks/data/regulators-reviewed.json      optional human decisions {decisions:[{key, status, reason}]},
                                            key = "<source>|<notice id>|<entity>", status dismissed | confirmed
  stocks/data/raw/regulators/<source>/pending/  reads whose notices are not stored yet (replayed)
  sonar.regulator_notice                    every notice read, once per version (db/2026-11-23-sonar-regulator-notice.sql)
  sonar.regulator_notice_match / sonar.regulator_check / sonar.change_event   the record in Postgres

STATS
  ingestStatus / processingStatus (ok | partial | failed) with ingest / processing {attempted, ok,
  failed, skipped, failingSteps}; watchStatus is the worst of those and the sources' own verdicts.`);
}

// ---------------------------------------------------------------------------------------------
// HTTP: one paced, retrying request. Pacing is per host, from the END of the previous request.
// ---------------------------------------------------------------------------------------------

const lastRequestEnd = new Map();
const counters = { requests: 0, retries: 0 };

/**
 * `redirect: 'manual'` for hosts behind FINRA's WAF: a blocked client is sent a 307 to
 * error.waf.finra.org, and following it only surfaces as an opaque "fetch failed".
 * `transientBody(text)` names a 200 body that is really an upstream error (EDGAR's error envelope):
 * it is retried like a 5xx and, if it persists, is the request's error.
 */
async function pacedFetch(url, { method = 'GET', body = null, headers = {}, paceMs = DEFAULT_PACE_MS, redirect = 'follow', transientBody = null } = {}) {
    const host = new URL(url).host;
    // sec.gov's fair-access limit is 10 requests a second; one a second is well inside it.
    const pace = /(^|\.)sec\.gov$/.test(host) ? SEC_PACE_MS : paceMs;
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const since = Date.now() - (lastRequestEnd.get(host) ?? 0);
        if (since < pace) await sleep(pace - since);
        counters.requests += 1;
        let res = null;
        try {
            res = await fetch(url, {
                method,
                body,
                redirect,
                headers: { 'user-agent': userAgentFor(host), accept: '*/*', ...headers },
                signal: AbortSignal.timeout(TIMEOUT_MS)
            });
            if (res.status >= 300 && res.status < 400) {
                lastRequestEnd.set(host, Date.now());
                const to = res.headers.get('location') ?? '?';
                throw Object.assign(new Error(`HTTP ${res.status} redirect to ${to}${/waf/i.test(to) ? ' (blocked by the host\'s WAF from this IP)' : ''}`), { final: true });
            }
            // Lenient decoding: some pages (CIMA) mix charsets; a mangled accent never matters to a name match.
            const text = new TextDecoder('utf-8').decode(await res.arrayBuffer());
            lastRequestEnd.set(host, Date.now());
            const transient = res.ok && transientBody ? transientBody(text) : null;
            if (res.ok && !transient) return text;
            if (transient) {
                lastError = transient;
            } else {
                const challenge = res.headers.get('cf-mitigated') === 'challenge' || /Attention Required! \| Cloudflare/.test(text);
                lastError = `HTTP ${res.status}${challenge ? ' (Cloudflare challenge/block)' : ''}: ${text.replace(/\s+/g, ' ').slice(0, 140)}`;
                if (!retryable(res.status)) break;
            }
        } catch (err) {
            if (err.final) throw new Error(`${url}: ${err.message}`);
            lastRequestEnd.set(host, Date.now());
            lastError = err.name === 'TimeoutError' ? `timeout after ${TIMEOUT_MS} ms` : `${err.cause?.code ?? err.name}: ${err.message}`;
        }
        if (attempt < MAX_ATTEMPTS) {
            const wait = backoffMs(attempt, { retryAfter: res?.headers?.get('retry-after') ?? null });
            counters.retries += 1;
            logWarn(`${host}: ${lastError} — retry ${attempt}/${MAX_ATTEMPTS - 1} in ${(wait / 1000).toFixed(0)} s`);
            await sleep(wait);
        }
    }
    throw new Error(`${url}: ${lastError}`);
}

// ---------------------------------------------------------------------------------------------
// Collecting one source: fetch → raw kept → notices. The raw bodies are kept gzip-compressed and
// once per distinct content (lib/raw-keep.mjs): the newest RAW_KEEP in the source's ring, and in
// its pending/ directory whenever the notices could not be stored (the parse failed, or the
// store did) — those are replayed through the same parser at the start of the next runs until
// they are stored, so what the source sent is never lost to a failure on our side.
// ---------------------------------------------------------------------------------------------

const pendingDir = (source) => join(RAW_DIR, source.id, 'pending');

/** The kept envelope: the bodies with the context that produced their URLs. Deduped on the bodies alone. */
function rawEnvelope(source, ctx, raw) {
    const payload = `${JSON.stringify({ source: source.id, today: ctx.today, windowDays: ctx.windowDays, requests: raw })}\n`;
    return { payload, identity: JSON.stringify(raw.map((r) => [r.url, r.body])) };
}

/** Keep this read in the source's ring of recent raw reads, and drop the ring's oldest beyond RAW_KEEP. */
async function keepInRing(source, ctx, raw) {
    const dir = join(RAW_DIR, source.id);
    const { payload, identity } = rawEnvelope(source, ctx, raw);
    const kept = await keepRaw(dir, payload, { identity });
    await pruneKept(dir, { maxFiles: RAW_KEEP });
    // The ring before 2026-11-23 was one plain file per run (<stamp>.xml/.json/…); it is replaced.
    for (const name of await readdir(dir)) {
        if (!isKeptName(name) && /^\d{8}T\d{6}Z\.[a-z]+$/.test(name)) await rm(join(dir, name), { force: true });
    }
    return kept;
}

/** Keep a read whose notices are not stored yet; replayed by replayPending. */
async function keepPending(source, ctx, raw) {
    const { payload, identity } = rawEnvelope(source, ctx, raw);
    return keepRaw(pendingDir(source), payload, { identity });
}

/**
 * Fetch and parse one source. A failed request is `stage: 'fetch'`; a body that came back but
 * would not parse is `stage: 'parse'`, and carries the raw bodies so they can be kept.
 */
async function collect(source, ctx) {
    const raw = [];
    const get = async (url, opts = {}) => {
        let body;
        try {
            body = await pacedFetch(url, { paceMs: source.paceMs ?? DEFAULT_PACE_MS, transientBody: source.transientBody ?? null, ...opts });
        } catch (err) {
            throw Object.assign(err, { stage: 'fetch' });
        }
        raw.push({ url, body });
        return body;
    };
    try {
        const { notices, note } = await collectNotices(source, ctx, get);
        ctx.note = note;
        return { notices, raw, requests: raw.length };
    } catch (err) {
        if (!err.stage) Object.assign(err, { stage: 'parse' });
        err.raw = raw;
        throw err;
    }
}

/** Parse a kept envelope again: every request is answered from the recorded bodies, by URL. */
async function replayKept(source, envelope, names) {
    const bodies = new Map(envelope.requests.map((r) => [r.url, r.body]));
    const get = async (url) => {
        if (!bodies.has(url)) throw new Error(`replay: no recorded body for ${url}`);
        return bodies.get(url);
    };
    return collectNotices(source, { names, today: envelope.today, windowDays: envelope.windowDays }, get);
}

/**
 * Store the notices of every pending read of this source (oldest first), deleting each once it is
 * stored. A read that still fails stays (and keeps failing the ingest verdict, loudly) until it is
 * older than PENDING_MAX_AGE_MS. Returns { stored, failed, inserted }.
 */
async function replayPending(source, { dbUrl, names }) {
    const out = { stored: 0, failed: 0, inserted: 0, errors: [] };
    const dropped = await pruneKept(pendingDir(source), { maxFiles: PENDING_MAX_FILES, maxAgeMs: PENDING_MAX_AGE_MS });
    for (const f of dropped) logError(`${source.id}: pending raw ${relative(REPO, f.path)} dropped unstored after ${PENDING_MAX_AGE_MS / 86_400_000} days / ${PENDING_MAX_FILES} files`);
    const pending = (await listKept(pendingDir(source))).reverse();
    for (const f of pending) {
        try {
            const envelope = JSON.parse((await readKept(f.path)).toString('utf8'));
            const { notices } = await replayKept(source, envelope, names);
            const rows = noticeRows(source.id, notices);
            // When the notices were fetched: the kept file's last-seen time, never now.
            const seenAt = ts(new Date(f.mtimeMs));
            const counts = rows.length ? parseStoreCounts(await psql(dbUrl, buildNoticeStoreSql(rows, { seenAt }).sql, `store ${source.id} (pending)`, ['-t', '-A'])) : { inserted: 0 };
            await rm(f.path, { force: true });
            out.stored += 1;
            out.inserted += counts.inserted;
            log(`${source.id}: pending raw ${relative(REPO, f.path)} stored — ${rows.length} notice(s), ${counts.inserted} new version(s)`);
        } catch (err) {
            out.failed += 1;
            out.errors.push(err.message);
            logError(`${source.id}: pending raw ${relative(REPO, f.path)} still not stored — ${err.message}`);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

async function loadDossiers() {
    const files = (await readdir(ISSUERS_DIR)).filter((f) => f.endsWith('.json')).sort();
    return Promise.all(files.map(async (f) => ({
        slug: f.replace(/\.json$/, ''),
        dossier: JSON.parse(await readFile(join(ISSUERS_DIR, f), 'utf8'))
    })));
}

async function readCheckpoint(path, fresh) {
    if (fresh) return null;
    try {
        const info = await stat(path);
        const cp = JSON.parse(await readFile(path, 'utf8'));
        if (Date.now() - info.mtimeMs > CHECKPOINT_MAX_AGE_MS) {
            logWarn(`checkpoint ${relative(REPO, path)} is older than ${CHECKPOINT_MAX_AGE_MS / 3600000} h — not resumed`);
            return null;
        }
        return cp;
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
}

function progress(done, total, startedMs) {
    const pct = total === 0 ? 100 : Math.round((done / total) * 100);
    const elapsed = (Date.now() - startedMs) / 1000;
    const eta = done === 0 ? null : Math.round((elapsed / done) * (total - done));
    return `${done}/${total} ${pct}%${eta === null ? '' : ` · ETA ${eta}s`}`;
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

let statsFile = runFiles(null).stats;

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return;
    }
    const only = typeof flags.only === 'string' ? flags.only : null;
    const files = runFiles(only);
    statsFile = files.stats;
    const sources = selectSources(only);
    const windowDays = flags['window-days'] === undefined ? QUERY_WINDOW_DAYS : Number(flags['window-days']);
    if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 3650) throw new Error(`--window-days must be 1..3650, got ${flags['window-days']}`);
    const env = await readEnvFile(join(REPO, '.env'));
    const dbUrl = flags['no-db'] ? null : (process.env.DATABASE_URL || env.DATABASE_URL || null);
    if (!flags['no-db'] && !dbUrl) throw new Error(`DATABASE_URL is not set in ${join(REPO, '.env')} — pass --no-db to run without Postgres`);

    // --- names --------------------------------------------------------------------------------
    const extra = await readJson(EXTRA_FILE, { queries: [], dockets: [] });
    const names = deriveWatchNames(await loadDossiers(), { extra });
    const review = reviewIndex(await readJson(REVIEWED_FILE, { decisions: [] }));
    log(`names: ${names.length} watched (${names.filter((n) => n.legal).length} full legal names, `
        + `${names.filter((n) => !n.legal).length} brands / bare names, ${names.filter((n) => n.core).length} with a weak core); `
        + `${review.size} reviewed decision(s)`);
    log(`sources: ${sources.length} — ${sources.map((s) => s.id).join(', ')}`);

    // --- stored state -------------------------------------------------------------------------
    // Needed only to PROCESS (what is new, what is a baseline): a failed read never stops a fetch.
    // Every source is still fetched and its notices stored; they wait (matched_at null) for a run
    // that can read the state.
    const previous = new Map();
    const checks = new Map();
    let stateError = null;
    if (dbUrl) {
        log(`db: ${describeUrl(dbUrl)}`);
        try {
            for (const row of normaliseStoredMatches(JSON.parse((await psql(dbUrl, buildReadMatchesQuery(), 'read matches', ['-t', '-A'])).trim() || '[]'))) {
                previous.set(row.key, row);
            }
            for (const row of normaliseStoredChecks(JSON.parse((await psql(dbUrl, buildReadChecksQuery(), 'read checks', ['-t', '-A'])).trim() || '[]'))) {
                checks.set(row.regulator, row);
            }
            log(`db: ${previous.size} stored match(es), ${checks.size} source(s) checked before`);
        } catch (err) {
            stateError = err.message;
            logError(`db: could not read the stored matches/checks — every source is still fetched and its notices stored,`
                + ` but nothing is matched this run: ${err.message}`);
        }
    } else {
        logWarn('--no-db: no stored state — every source is a baseline and this run raises NO events');
    }

    // --- checkpoint ---------------------------------------------------------------------------
    const checkpoint = await readCheckpoint(files.checkpoint, Boolean(flags.fresh));
    const detectedAt = checkpoint?.detectedAt ?? ts(new Date(RUN_STARTED_MS));
    const done = new Set(checkpoint?.done ?? []);
    const carried = checkpoint?.results ?? {};
    if (checkpoint) log(`checkpoint: resuming the run of ${detectedAt} — ${done.size} source(s) already done will be skipped`);
    const results = { ...carried };
    const saveCheckpoint = () => writeJson(files.checkpoint, { detectedAt, done: [...done], results });

    const today = detectedAt.slice(0, 10);
    const failures = [];
    const events = [];
    let skipped = 0;
    const loopStartedMs = Date.now();
    // INGEST (fetch + store the notices) and PROCESSING (match, check row, events) are judged apart.
    const ingest = stageTally();
    const processing = stageTally();
    let noticesInserted = 0;

    for (const [i, source] of sources.entries()) {
        const label = `[${progress(i + 1, sources.length, loopStartedMs)}] ${source.id}`;
        if (done.has(source.id)) {
            skipped += 1;
            log(`${label} — done earlier in this run (checkpoint), skipped: ${results[source.id]?.summary ?? ''}`);
            continue;
        }

        // --- ingest: reads kept from earlier runs first, then this run's fetch, stored before any matching.
        const ctx = { names, today, windowDays, note: null };
        const ingested = await ingestSource({
            replayPending: dbUrl ? () => replayPending(source, { dbUrl, names }) : null,
            collect: async () => {
                const c = await collect(source, ctx);
                return { ...c, note: ctx.note };
            },
            keepRing: (raw) => keepInRing(source, ctx, raw),
            keepPending: async (raw) => {
                const kept = await keepPending(source, ctx, raw);
                return { path: relative(REPO, kept.path) };
            },
            store: dbUrl ? async (list) => parseStoreCounts(await psql(dbUrl,
                buildNoticeStoreSql(noticeRows(source.id, list), { seenAt: detectedAt }).sql, `store ${source.id}`, ['-t', '-A'])) : null
        });
        const { notices, error } = ingested;
        const ingestErrors = ingested.errors;
        noticesInserted += ingested.inserted;
        if (ingested.stored) ctx.stored = ingested.stored;
        if (knownBlock(source, error) && ingestErrors.length === 1 && ingestErrors[0].step === 'fetch') {
            // A known bot wall is reported apart (knownBlocked), not as an ingest failure every run.
            stageSkip(ingest);
        } else if (ingestErrors.length) {
            for (const e of ingestErrors) stageFail(ingest, e.step);
        } else {
            stageOk(ingest);
        }

        // --- processing: match this run's notices plus any stored ones no run has matched yet.
        const prev = checks.get(source.id) ?? null;
        const baseline = !dbUrl || !prev?.lastOkAt;
        const blockedAs = knownBlock(source, error);
        const processed = await processSource(
            { source, notices, error, stateError, prev, baseline, names, previous, detectedAt, review },
            {
                readBacklog: dbUrl ? async () => JSON.parse((await psql(dbUrl, buildReadUnmatchedQuery(source.id), `backlog ${source.id}`, ['-t', '-A'])).trim() || '[]') : null,
                write: dbUrl ? (statements) => psql(dbUrl, wrapTransaction(statements), `source ${source.id}`) : null
            }
        );
        let { verdict } = processed;
        const { rows, events: sourceEvents, backlogCount } = processed;
        const processingError = processed.error;
        if (processingError) {
            stageFail(processing, processingError.step);
            failures.push(`${source.id}: processing failed at ${processingError.step} — ${processingError.message}`
                + ' (its notices are stored and are matched by the next run that can)');
        } else {
            stageOk(processing);
        }
        // Without a processing verdict the read is still reported: failed when it failed, else ok-unprocessed.
        verdict ??= { status: error ? 'failed' : 'ok', consecutiveFailures: null, newestPublishedAt: null, lastError: error };
        events.push(...sourceEvents);
        const strong = rows.filter((r) => r.strength === 'strong').length;
        const stored = ctx.stored ? ` · ${ctx.stored.inserted} new version(s) stored` : '';
        const summary = blockedAs ? `blocked (known since ${blockedAs.since}) — ${error}`
            : error ? `FAILED — ${error}`
            : `${notices.length} notice(s)${stored}${backlogCount > 0 ? ` (+${backlogCount} unmatched from earlier runs)` : ''}`
                + ` · ${rows.length} match(es) (${strong} strong, ${rows.length - strong} weak)`
                + ` · ${sourceEvents.length} new${baseline ? ' · baseline' : ''} · ${verdict.status}`
                + `${verdict.newestPublishedAt ? ` · newest ${verdict.newestPublishedAt.slice(0, 10)}` : ''}`;
        results[source.id] = {
            status: blockedAs ? 'blocked' : verdict.status,
            knownBlocked: blockedAs,
            notices: error ? null : notices.length,
            noticesStored: ctx.stored?.inserted ?? null,
            ingest: ingestErrors.length ? ingestErrors.map((e) => e.step).join(',') : 'ok',
            processing: processingError ? processingError.step : 'ok',
            matches: rows.length,
            strongMatches: strong,
            newMatches: sourceEvents.length,
            baseline,
            consecutiveFailures: verdict.consecutiveFailures,
            newestPublishedAt: verdict.newestPublishedAt,
            lastError: verdict.lastError,
            requests: ingested.requests,
            summary
        };
        if (verdict.status === 'ok' && !ingestErrors.length) {
            log(`${label} — ${summary}${ctx.note ? ` · ${ctx.note}` : ''}`);
        } else if (blockedAs) {
            logWarn(`${label} — ${summary} (${verdict.consecutiveFailures} run(s) in a row; not counted as a failure)`);
        } else {
            logError(`${label} — ${summary}${verdict.lastError && !error ? ` — ${verdict.lastError}` : ''}`
                + `${verdict.consecutiveFailures === null ? '' : ` (${verdict.consecutiveFailures} run(s) in a row)`}`
                + `${ingestErrors.filter((e) => e.step !== 'fetch').map((e) => ` · ingest ${e.step}: ${e.message}`).join('')}`);
        }
        if (processingError) logError(`${label} — processing FAILED at ${processingError.step}: ${processingError.message}`);
        for (const r of rows.filter((x) => x.strength === 'strong').slice(0, 5)) {
            log(`    strong ${r.matchedIn}: "${r.phrase}" — ${r.noticeTitle} (${r.publishedDate ?? 'undated'}) ${r.noticeUrl ?? ''}`);
        }
        // Done (skipped by a resumed run) only when it was fetched, stored AND processed.
        if (verdict.status === 'ok' && !ingestErrors.length && !processingError) {
            done.add(source.id);
            await saveCheckpoint();
        }
        // A store failure or a pending read that will not store is an ingest failure the run must report.
        for (const e of ingestErrors.filter((x) => x.step !== 'fetch' && x.step !== 'parse')) {
            failures.push(`${source.id}: ingest ${e.step} — ${e.message}`);
        }
    }

    // --- report -------------------------------------------------------------------------------
    const run = runVerdict(results);
    failures.push(...run.failures);
    const durationMs = Date.now() - RUN_STARTED_MS;
    const all = Object.values(results);
    const sum = (k) => all.reduce((acc, r) => acc + (r[k] ?? 0), 0);
    const stages = stageStats(ingest, processing);
    const stats = {
        // The worst of the three: a source's own verdict (failed / stale / gap), ingest, processing.
        watchStatus: worstStatus(run.watchStatus, stages.ingestStatus, stages.processingStatus),
        ...stages,
        noticesStored: noticesInserted,
        generatedAt: ts(),
        lastRunStartedAt: ts(new Date(RUN_STARTED_MS)),
        lastRunEndedAt: ts(),
        detectedAt,
        durationMs,
        only,
        regulatorsChecked: all.length,
        regulatorsOk: all.filter((r) => r.status === 'ok').length,
        sourcesSkippedFromCheckpoint: skipped,
        noticesRead: sum('notices'),
        matches: sum('matches'),
        strongMatches: sum('strongMatches'),
        newMatches: sum('newMatches'),
        events: events.length,
        eventsBySeverity: events.reduce((acc, e) => ({ ...acc, [e.severity]: (acc[e.severity] ?? 0) + 1 }), {}),
        requests: counters.requests,
        retries: counters.retries,
        names: names.length,
        failures: failures.length,
        failureReasons: failures.slice(0, 30),
        sourcesBlocked: run.blocked.length,
        knownBlocked: run.blocked,
        sources: Object.fromEntries(Object.entries(results).map(([id, r]) => [id, { ...r, summary: undefined }])),
        notPolled: NOT_FEASIBLE.map((n) => n.regulator)
    };
    await writeJson(files.stats, stats);
    await rm(files.checkpoint, { force: true });
    log(`watch-regulators: ${stats.regulatorsOk}/${stats.regulatorsChecked} source(s) ok · ${stats.noticesRead} notice(s) · `
        + `${stats.matches} match(es) (${stats.strongMatches} strong) · ${stats.newMatches} new · ${counters.requests} request(s) · `
        + `${(durationMs / 1000).toFixed(0)} s${run.blocked.length ? ` · ${run.blocked.length} blocked (known)` : ''} → ${relative(REPO, files.stats)}`);
    // Every run says which sources are known-blocked, so the gap is never silently forgotten.
    for (const b of run.blocked) logWarn(`watch-regulators: ${b}`);
    for (const e of events.slice(0, 20)) log(`  [${e.severity}] ${e.subjectId}: ${e.summary}`);

    if ((events.length > 0 || failures.length > 0) && !flags['no-telegram']) {
        if (!telegramConfigured(env)) log('telegram: not configured in .env — the summary is logged instead');
        await postRunNotifications(events.length ? formatTelegramSummary({ events, failures: [], blocked: run.blocked, checks: all.length, noticesRead: stats.noticesRead, durationMs }) : null, { env, failures, label: 'RWA Sonar watch-regulators' });
    } else if (!flags['no-telegram']) {
        log('watch-regulators: no new matches and no failures — no Telegram message');
    }

    if (failures.length) {
        logError(`watch-regulators: run NOT successful — ${failures.length} source(s) not ok:`);
        for (const f of failures) logError(`    ${f}`);
        process.exitCode = 1;
    }
}

main().catch(async (err) => {
    logError(err.stack || err.message);
    try {
        await writeJson(statsFile, {
            watchStatus: 'failed',
            // A crash outside the per-source steps: which stage it hit is unknown, so both say failed.
            ingestStatus: 'failed',
            processingStatus: 'failed',
            ingest: { status: 'failed', failingSteps: [{ step: 'crash', count: 1 }] },
            processing: { status: 'failed', failingSteps: [{ step: 'crash', count: 1 }] },
            generatedAt: ts(),
            lastRunStartedAt: ts(new Date(RUN_STARTED_MS)),
            lastRunEndedAt: ts(),
            durationMs: Date.now() - RUN_STARTED_MS,
            requests: counters.requests,
            failures: 1,
            failureReasons: [err.message]
        });
    } catch (statsError) {
        logError(`watch-regulators: could not record the failed outcome: ${statsError.message}`);
    }
    process.exitCode = 1;
});
