#!/usr/bin/env node
// The daily regulator-notice watcher: reads the publications of the regulators relevant to the
// dossiers' jurisdictions (SEC, CFTC, FINRA, FCA, FINMA, BaFin, ESMA, the Central Bank of Ireland,
// FMA Liechtenstein, CIMA, MAS, SMV Panama, ASIC), matches every notice against the parties the
// case-law watcher derives from the dossiers, stores each match in sonar.regulator_notice_match and
// each source's check in sonar.regulator_check, and raises a sonar.change_event of kind
// `regulator-notice` for every NEW match. An event is a candidate for a human to read, never a finding.
//
// The decisions (names, parsers, match strength, events, SQL) are in lib/regulators.mjs and unit
// tested in regulators.test.js; this file is the IO: pacing, retries, the raw cache, psql, the
// per-source checkpoint and the one Telegram summary.

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { backoffMs, retryable, reviewIndex } from './lib/caselaw.mjs';
import { wrapTransaction } from './lib/db-load.mjs';
import { readEnvFile } from './lib/env.mjs';
import { log, logError, logWarn, parseArgs, readJson, sleep, ts, writeJson } from './lib/io.mjs';
import { describeUrl, psql } from './lib/psql.mjs';
import {
    NOT_FEASIBLE, QUERY_WINDOW_DAYS, SOURCES, brokerCheckNames, buildCheckSql, buildMatchUpsertSql,
    buildReadChecksQuery, buildReadMatchesQuery, canonicalName, checkVerdict, deriveWatchNames, foldMatches,
    formatTelegramSummary, knownBlock, matchNotices, nameCore, normaliseStoredChecks, normaliseStoredMatches,
    parseBrokerCheckFirm, parseBrokerCheckSearch, runVerdict, selectSources
} from './lib/regulators.mjs';
import { postTelegram, telegramConfigured } from './lib/telegram.mjs';
import { buildChangeEventSql, userAgentFor } from './lib/watch.mjs';

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
const RAW_KEEP = 5;
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
  2. Per source (in order, checkpointed): fetch (paced per host, retried on 429/5xx), cache the raw
     body under ${relative(REPO, RAW_DIR)}/<source>/ (newest ${RAW_KEEP} kept), parse into notices with
     the regulator's OWN dates, and match every notice against every name:
       strong = the full legal name, corporate suffix included (Ltd = Limited, Inc = Incorporated, …);
       weak   = a brand or bare name ("xStocks", "DekaBank"), or the legal name's distinctive core
                without its suffix ("Payward" for "Payward, Inc."); never a stoplisted word.
     "subject" when the name is in the notice's title / named firm, "text" when only in its body.
     Query sources look back ${QUERY_WINDOW_DAYS} days: EDGAR full-text search per legal name (only
     filings the entity itself FILED), BrokerCheck per US legal name (disclosure counts), FINRA
     disciplinary actions for the window.
  3. Each source is written in one transaction as it finishes (the checkpoint): its matches
     (sonar.regulator_notice_match, idempotent on regulator + notice + entity), its check row
     (sonar.regulator_check: status, consecutive failures, newest notice date) and its events.
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
  sonar.regulator_notice_match / sonar.regulator_check / sonar.change_event   the record in Postgres`);
}

// ---------------------------------------------------------------------------------------------
// HTTP: one paced, retrying request. Pacing is per host, from the END of the previous request.
// ---------------------------------------------------------------------------------------------

const lastRequestEnd = new Map();
const counters = { requests: 0, retries: 0 };

/**
 * `redirect: 'manual'` for hosts behind FINRA's WAF: a blocked client is sent a 307 to
 * error.waf.finra.org, and following it only surfaces as an opaque "fetch failed".
 */
async function pacedFetch(url, { method = 'GET', body = null, headers = {}, paceMs = DEFAULT_PACE_MS, redirect = 'follow' } = {}) {
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
            if (res.ok) return text;
            const challenge = res.headers.get('cf-mitigated') === 'challenge' || /Attention Required! \| Cloudflare/.test(text);
            lastError = `HTTP ${res.status}${challenge ? ' (Cloudflare challenge/block)' : ''}: ${text.replace(/\s+/g, ' ').slice(0, 140)}`;
            if (!retryable(res.status)) break;
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
// Collecting one source: fetch → raw cache → notices
// ---------------------------------------------------------------------------------------------

async function cacheRaw(source, raw, stamp) {
    const dir = join(RAW_DIR, source.id);
    await mkdir(dir, { recursive: true });
    const single = raw.length === 1;
    const ext = single ? ({ rss: 'xml', json: 'json', csv: 'csv', html: 'html' }[source.format] ?? 'txt') : 'json';
    const path = join(dir, `${stamp}.${ext}`);
    await writeFile(path, single ? raw[0].body : `${JSON.stringify(raw, null, 1)}\n`, 'utf8');
    const files = (await readdir(dir)).sort();
    for (const old of files.slice(0, Math.max(0, files.length - RAW_KEEP))) await rm(join(dir, old), { force: true });
    return path;
}

async function collect(source, ctx) {
    const raw = [];
    const get = async (url, opts = {}) => {
        const body = await pacedFetch(url, { paceMs: source.paceMs ?? DEFAULT_PACE_MS, ...opts });
        raw.push({ url, body });
        return body;
    };
    let notices = [];
    if (source.id === 'finra-brokercheck') {
        // Two stages: find each US legal name's firm, then read that firm's disclosures.
        const firms = new Map();
        for (const name of brokerCheckNames(ctx.names)) {
            const q = encodeURIComponent(nameCore(name.phrase) || name.phrase);
            const hits = parseBrokerCheckSearch(JSON.parse(await get(
                `https://api.brokercheck.finra.org/search/firm?query=${q}&hl=true&nrows=12&start=0&r=25&sort=score+desc&wt=json`,
                { headers: { accept: 'application/json' }, redirect: 'manual' })));
            for (const h of hits) {
                const same = [h.name, ...h.otherNames].some((n) => canonicalName(n) === name.canonical);
                if (same) firms.set(h.crd, h);
            }
        }
        for (const crd of firms.keys()) {
            const { notices: found } = parseBrokerCheckFirm(JSON.parse(await get(
                `https://api.brokercheck.finra.org/search/firm/${crd}?hl=true&nrows=12&start=0&r=25&wt=json`,
                { headers: { accept: 'application/json' }, redirect: 'manual' })));
            notices.push(...found);
        }
        ctx.note = `${firms.size} firm(s) found on BrokerCheck: ${[...firms.values()].map((f) => `${f.name} ${f.crd}`).join(', ') || 'none'}`;
    } else if (source.requests) {
        for (const req of source.requests(ctx)) notices.push(...source.parseEach(await get(req.url), req));
    } else if (source.pageUrl) {
        for (let page = 0; page < source.maxPages; page += 1) {
            const found = source.parsePage(await get(source.pageUrl(ctx, page)));
            notices.push(...found);
            if (found.length < source.pageSize) break;
            if (page === source.maxPages - 1 && source.window !== 'newest') {
                throw new Error(`still a full page after ${source.maxPages} pages — raise maxPages, or notices are being cut off`);
            }
        }
    } else {
        notices = source.parse(await get(source.url, { method: source.method, body: source.body, headers: source.headers }));
    }
    // One notice per id (EDGAR returns a filing once per matched name).
    const byId = new Map();
    for (const n of notices) if (!byId.has(n.id)) byId.set(n.id, n);
    const rawPath = raw.length ? await cacheRaw(source, raw, ctx.stamp) : null;
    return { notices: [...byId.values()], rawPath, requests: raw.length };
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
    const previous = new Map();
    const checks = new Map();
    if (dbUrl) {
        log(`db: ${describeUrl(dbUrl)}`);
        for (const row of normaliseStoredMatches(JSON.parse((await psql(dbUrl, buildReadMatchesQuery(), 'read matches', ['-t', '-A'])).trim() || '[]'))) {
            previous.set(row.key, row);
        }
        for (const row of normaliseStoredChecks(JSON.parse((await psql(dbUrl, buildReadChecksQuery(), 'read checks', ['-t', '-A'])).trim() || '[]'))) {
            checks.set(row.regulator, row);
        }
        log(`db: ${previous.size} stored match(es), ${checks.size} source(s) checked before`);
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
    const stamp = detectedAt.replace(/[-:]/g, '').replace(/Z$/, 'Z');
    const failures = [];
    const events = [];
    let skipped = 0;
    const loopStartedMs = Date.now();

    for (const [i, source] of sources.entries()) {
        const label = `[${progress(i + 1, sources.length, loopStartedMs)}] ${source.id}`;
        if (done.has(source.id)) {
            skipped += 1;
            log(`${label} — done earlier in this run (checkpoint), skipped: ${results[source.id]?.summary ?? ''}`);
            continue;
        }
        const prev = checks.get(source.id) ?? null;
        const baseline = !dbUrl || !prev?.lastOkAt;
        const ctx = { names, today, stamp, windowDays, note: null };
        let collected = null;
        let error = null;
        try {
            collected = await collect(source, ctx);
        } catch (err) {
            error = err.message;
        }
        const notices = collected?.notices ?? [];
        const matches = error ? [] : matchNotices(notices, names);
        const verdict = checkVerdict(source, { prev, error, notices, matches: matches.length, runAt: detectedAt });
        // The DB row stays `failed` (the read did fail); only the run's verdict excuses a known block.
        const blockedAs = knownBlock(source, error);
        const { rows, events: sourceEvents } = foldMatches(matches, { regulator: source, previous, baseline, detectedAt, review });
        if (dbUrl) {
            const statements = [buildCheckSql([verdict]).sql];
            if (rows.length) statements.push(buildMatchUpsertSql(rows).sql);
            if (sourceEvents.length) statements.push(buildChangeEventSql(sourceEvents).sql);
            await psql(dbUrl, wrapTransaction(statements), `source ${source.id}`);
        }
        events.push(...sourceEvents);
        const strong = rows.filter((r) => r.strength === 'strong').length;
        const summary = blockedAs ? `blocked (known since ${blockedAs.since}) — ${error}`
            : error ? `FAILED — ${error}`
            : `${notices.length} notice(s) · ${rows.length} match(es) (${strong} strong, ${rows.length - strong} weak)`
                + ` · ${sourceEvents.length} new${baseline ? ' · baseline' : ''} · ${verdict.status}`
                + `${verdict.newestPublishedAt ? ` · newest ${verdict.newestPublishedAt.slice(0, 10)}` : ''}`;
        results[source.id] = {
            status: blockedAs ? 'blocked' : verdict.status,
            knownBlocked: blockedAs,
            notices: error ? null : notices.length,
            matches: rows.length,
            strongMatches: strong,
            newMatches: sourceEvents.length,
            baseline,
            consecutiveFailures: verdict.consecutiveFailures,
            newestPublishedAt: verdict.newestPublishedAt,
            lastError: verdict.lastError,
            requests: collected?.requests ?? null,
            summary
        };
        if (verdict.status === 'ok') {
            log(`${label} — ${summary}${ctx.note ? ` · ${ctx.note}` : ''}`);
        } else if (blockedAs) {
            logWarn(`${label} — ${summary} (${verdict.consecutiveFailures} run(s) in a row; not counted as a failure)`);
        } else {
            logError(`${label} — ${summary}${verdict.lastError && !error ? ` — ${verdict.lastError}` : ''}`
                + ` (${verdict.consecutiveFailures} run(s) in a row)`);
        }
        for (const r of rows.filter((x) => x.strength === 'strong').slice(0, 5)) {
            log(`    strong ${r.matchedIn}: "${r.phrase}" — ${r.noticeTitle} (${r.publishedDate ?? 'undated'}) ${r.noticeUrl ?? ''}`);
        }
        if (verdict.status === 'ok') {
            done.add(source.id);
            await saveCheckpoint();
        }
    }

    // --- report -------------------------------------------------------------------------------
    const run = runVerdict(results);
    failures.push(...run.failures);
    const durationMs = Date.now() - RUN_STARTED_MS;
    const all = Object.values(results);
    const sum = (k) => all.reduce((acc, r) => acc + (r[k] ?? 0), 0);
    const stats = {
        watchStatus: run.watchStatus,
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
        await postTelegram(formatTelegramSummary({ events, failures, blocked: run.blocked, checks: all.length, noticesRead: stats.noticesRead, durationMs }), { env });
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
