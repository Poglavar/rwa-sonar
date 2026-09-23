#!/usr/bin/env node
// The daily case-law watcher (next-steps.md "Next engineering iteration" item 2): searches
// CourtListener (opinions and RECAP dockets) and the SEC's litigation-release and
// administrative-proceeding feeds for every issuer's legal entities and key parties, stores each
// case in sonar.litigation_case, follows the dockets that name a party in the caption for new
// entries, and raises a sonar.change_event of kind `litigation` for every NEW case or entry.
//
// It feeds the what-if layer's `litigated` status and never sets it: an event is a candidate for a
// human to read, and a dossier answer only becomes `litigated` when someone cites the decision.
//
// The decisions (query derivation, parsing, match levels, what is an event, the SQL) are in
// lib/caselaw.mjs and unit tested in caselaw.test.js; this file is the IO: pacing, retries, psql,
// the per-task checkpoint and the one Telegram summary.

import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

import {
    COURTLISTENER_SEARCH, SEC_FEEDS, backoffMs, buildCaseUpsertSql, buildQueryRunSql,
    buildReadCasesQuery, buildReadQueriesQuery, courtListenerUrl, deriveQueries, entryEvent, foldHits,
    formatTelegramSummary, latestEntryFromDocuments, matchSecItems, normaliseStoredRows, parseCourtListenerResults,
    parseSecFeed, rankRows, retryable, reviewIndex, secFeedGap, selectEntryChecks, validateExtra
} from './lib/caselaw.mjs';
import { wrapTransaction } from './lib/db-load.mjs';
import { readEnvFile } from './lib/env.mjs';
import { log, logError, logWarn, parseArgs, readJson, sleep, ts, writeJson } from './lib/io.mjs';
import { describeUrl, psql } from './lib/psql.mjs';
import { postTelegram, telegramConfigured } from './lib/telegram.mjs';
import { buildChangeEventSql, userAgentFor } from './lib/watch.mjs';

const HERE = import.meta.dirname;
const REPO = join(HERE, '..');
const ISSUERS_DIR = join(HERE, 'data', 'issuers');
const QUERIES_FILE = join(HERE, 'data', 'caselaw-queries.json');
const EXTRA_FILE = join(HERE, 'data', 'caselaw-extra.json');
const REVIEWED_FILE = join(HERE, 'data', 'caselaw-reviewed.json');
const DDL_FILE = join(REPO, 'db', '2026-09-23-sonar-caselaw.sql');
const STATS_FILE = join(REPO, '.last-caselaw-watch-stats.json');
const CHECKPOINT_FILE = join(REPO, '.caselaw-watch-checkpoint.json');
const RUN_STARTED_MS = Date.now();

const DEFAULT_PACE_MS = 1500;
/** CourtListener's documented limit for AUTHENTICATED users is 5 requests a minute. */
const TOKEN_PACE_MS = 12_500;
const MAX_ATTEMPTS = 4;
const TIMEOUT_MS = 30_000;
const DEFAULT_ENTRY_CHECKS = 30;
/** A checkpoint older than this belongs to an earlier day's run and is not resumed. */
const CHECKPOINT_MAX_AGE_MS = 6 * 3600 * 1000;
const CL_USER_AGENT = 'rwa-sonar caselaw-watch (contact@rwasonar.com)';

function usage() {
    console.log(`watch-caselaw.mjs — daily case-law watcher: CourtListener + SEC releases per issuer party

USAGE
  node stocks/watch-caselaw.mjs --run [options]

OPTIONS
  --run              Actually search. Without it this help is printed and nothing runs.
  --ddl              Apply db/${DDL_FILE.split('/').pop()} first (tables + the \`litigation\` event kind). Idempotent.
  --write-queries    Rewrite stocks/data/caselaw-queries.json from the dossiers (review, then commit it).
                     Without it the file is only compared, and a stale file is a warning.
  --only=<issuer>    Only the queries watched for this issuer slug.
  --limit=<n>        Only the first n queries (smoke test).
  --entries=<n>      Dockets checked for new entries per run, default ${DEFAULT_ENTRY_CHECKS} (0 skips the pass).
  --pace=<ms>        Minimum gap between requests to one host, default ${DEFAULT_PACE_MS} ms (${TOKEN_PACE_MS} ms with a token).
  --no-sec           Skip the two SEC feeds.
  --fresh            Ignore a checkpoint left by an interrupted run and start over.
  --no-db            Search and print only: no state is read or written, so nothing is an event.
  --no-telegram      Never send the summary, whatever is in .env. It is still logged.
  --help             This text.

WHAT A RUN DOES
  1. Derives the query set from the dossiers (lib/caselaw.mjs deriveQueries): every legal entity in
     each issuingEntity, the issuer's brand, and every token issuer, tokenization provider, transfer
     agent, custodian, parent and security agent, expanded to the legal names the dossier spells out
     ("Kraken" -> "Payward, Inc."), with a stoplist for over-broad bare names; plus the manual
     additions in stocks/data/caselaw-extra.json (the two known D. Del. dockets).
  2. Per phrase: CourtListener v4 search, type=o (opinions) and type=r (RECAP dockets), exact phrase,
     newest filing first, first page (20). Per known docket: a docketNumber search in its court.
  3. The SEC litigation-release and administrative-proceeding RSS feeds (25 newest items each),
     matched locally against every phrase; a warning when the feed no longer reaches back to the
     previous poll.
  4. Up to --entries dockets (caption matches, known dockets, confirmed) get their newest RECAP entry
     read (type=rd, newest first).
  5. Each task is written to Postgres in one transaction as it finishes (the checkpoint): the cases
     (sonar.litigation_case), the search run (sonar.litigation_query) and its events.
  6. A query's FIRST run is a baseline: everything is recorded and nothing is raised. After that a new
     case -> one change_event per issuer (kind litigation, severity caution when the name is in the
     caption or among the parties, info when only in the text), and a newer docket entry -> caution.
     Cases marked \`dismissed\` in stocks/data/caselaw-reviewed.json are recorded but raise nothing.
  7. ONE Telegram summary when there are events or failures; ${relative(REPO, STATS_FILE)}; exit 1 if
     any request failed.

RESUME
  Every finished task is in the DB and in ${relative(REPO, CHECKPOINT_FILE)}. A run killed part-way
  is resumed by the next run within ${CHECKPOINT_MAX_AGE_MS / 3600000} h (same detected_at, finished tasks skipped and counted);
  the file is removed when a run completes.

LIMITS AND KEYS
  CourtListener's search API answers without a key (verified 2026-09-23). Its documented limits for
  AUTHENTICATED users are 5/min, 50/hour, 125/day — below one full run — so the job runs keyless by
  default and paces at ${DEFAULT_PACE_MS} ms. COURTLISTENER_API_TOKEN in .env is used when present (never logged),
  and then the pace is raised to ${TOKEN_PACE_MS} ms. 429 and 5xx are retried with backoff (Retry-After obeyed).
  sec.gov is sent the declared User-Agent from lib/watch.mjs.

PM2
  ecosystem.config.cjs app \`rwa-watch-caselaw\`: daily at 04:23 UTC, --run --ddl, autorestart off.

FILES
  stocks/data/caselaw-queries.json    the derived query set, generated (--write-queries), reviewed, committed
  stocks/data/caselaw-extra.json      manual phrases and known dockets
  stocks/data/caselaw-reviewed.json   human decisions: dismissed | confirmed, with a reason
  sonar.litigation_case / sonar.litigation_query / sonar.change_event   the record in Postgres`);
}

// ---------------------------------------------------------------------------------------------
// HTTP: one paced, retrying GET. Pacing is per host, from the END of the previous request.
// ---------------------------------------------------------------------------------------------

const lastRequestEnd = new Map();
const counters = { requests: 0, retries: 0 };

async function pacedGet(url, { headers, paceMs, accept }) {
    const host = new URL(url).host;
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const since = Date.now() - (lastRequestEnd.get(host) ?? 0);
        if (since < paceMs) await sleep(paceMs - since);
        counters.requests += 1;
        let res = null;
        try {
            res = await fetch(url, { headers: { accept, ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
            const body = await res.text();
            lastRequestEnd.set(host, Date.now());
            if (res.ok) return body;
            lastError = `HTTP ${res.status}: ${body.replace(/\s+/g, ' ').slice(0, 160)}`;
            if (!retryable(res.status)) break;
        } catch (err) {
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
    throw new Error(`${url.replace(/([?&])(token|key)=[^&]*/gi, '$1$2=…')}: ${lastError}`);
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

/** The generated file's content: stable (no timestamp), so a rewrite is a diff only when it changed. */
function queriesDocument({ queries, dropped, priorNotWatched }) {
    return {
        note: 'GENERATED by `node stocks/watch-caselaw.mjs --run --write-queries` from the dossiers\''
            + ' issuingEntity, issuer and parties (lib/caselaw.mjs deriveQueries), plus caselaw-extra.json.'
            + ' Review, then commit. Each phrase is searched as an exact phrase on CourtListener (opinions'
            + ' and RECAP dockets) and matched against the SEC litigation feeds. `dropped` are names not'
            + ' searched and why; `priorNotWatched` are the CourtListener phrases the dossiers\''
            + ' whatIf[].searched record that this set does not cover — promote good ones to caselaw-extra.json.',
        counts: {
            queries: queries.length,
            phrases: queries.filter((q) => q.kind === 'phrase').length,
            dockets: queries.filter((q) => q.kind === 'docket').length,
            dropped: dropped.length,
            priorNotWatched: priorNotWatched.length
        },
        queries,
        dropped,
        priorNotWatched
    };
}

async function readCheckpoint(fresh) {
    if (fresh) return null;
    try {
        const info = await stat(CHECKPOINT_FILE);
        const cp = JSON.parse(await readFile(CHECKPOINT_FILE, 'utf8'));
        if (Date.now() - info.mtimeMs > CHECKPOINT_MAX_AGE_MS) {
            logWarn(`checkpoint ${relative(REPO, CHECKPOINT_FILE)} is older than ${CHECKPOINT_MAX_AGE_MS / 3600000} h — not resumed`);
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

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return;
    }
    const env = await readEnvFile(join(REPO, '.env'));
    const token = env.COURTLISTENER_API_TOKEN || process.env.COURTLISTENER_API_TOKEN || null;
    const dbUrl = flags['no-db'] ? null : (process.env.DATABASE_URL || env.DATABASE_URL || null);
    if (!flags['no-db'] && !dbUrl) throw new Error(`DATABASE_URL is not set in ${join(REPO, '.env')} — pass --no-db to search without Postgres`);
    let paceMs = flags.pace === undefined ? DEFAULT_PACE_MS : Number(flags.pace);
    if (!Number.isFinite(paceMs) || paceMs < 1000) throw new Error(`--pace must be >= 1000 ms, got ${flags.pace}`);
    if (token) {
        paceMs = Math.max(paceMs, TOKEN_PACE_MS);
        log(`courtlistener: COURTLISTENER_API_TOKEN present — authenticated, paced at ${paceMs} ms`
            + ' (documented limit 5/min, 50/hour, 125/day; a full run may not fit one day)');
    } else {
        log(`courtlistener: no COURTLISTENER_API_TOKEN in .env — running keyless, paced at ${paceMs} ms`);
    }
    const entryLimit = flags.entries === undefined ? DEFAULT_ENTRY_CHECKS : Number(flags.entries);
    if (!Number.isFinite(entryLimit) || entryLimit < 0) throw new Error(`--entries must be >= 0, got ${flags.entries}`);
    const clHeaders = { 'user-agent': CL_USER_AGENT, ...(token ? { authorization: `Token ${token}` } : {}) };
    const secHeaders = { 'user-agent': userAgentFor('www.sec.gov') };

    // --- the query set ------------------------------------------------------------------------
    const extra = validateExtra(await readJson(EXTRA_FILE, { queries: [], dockets: [] }));
    const review = reviewIndex(await readJson(REVIEWED_FILE, { decisions: [] }));
    const derived = deriveQueries(await loadDossiers(), { extra });
    const doc = queriesDocument(derived);
    const committed = await readJson(QUERIES_FILE, null);
    if (flags['write-queries']) {
        await writeJson(QUERIES_FILE, doc);
        log(`queries: wrote ${relative(REPO, QUERIES_FILE)} — ${doc.counts.phrases} phrase(s), ${doc.counts.dockets} docket(s),`
            + ` ${doc.counts.dropped} dropped, ${doc.counts.priorNotWatched} prior search(es) not watched`);
    } else if (JSON.stringify(committed) !== JSON.stringify(JSON.parse(JSON.stringify(doc)))) {
        logWarn(`queries: ${relative(REPO, QUERIES_FILE)} is ${committed ? 'stale' : 'missing'} — the dossiers now derive a`
            + ' different set; this run uses the derived set. Run with --write-queries, review and commit.');
    }
    let queries = derived.queries;
    if (typeof flags.only === 'string') queries = queries.filter((q) => q.issuers.includes(flags.only));
    if (flags.limit) queries = queries.slice(0, Number(flags.limit));
    if (queries.length === 0) throw new Error('no queries to run');
    log(`queries: ${queries.length} (${queries.filter((q) => q.kind === 'phrase').length} phrases × opinions + dockets,`
        + ` ${queries.filter((q) => q.kind === 'docket').length} known dockets); ${review.size} reviewed decision(s)`);

    // --- stored state -------------------------------------------------------------------------
    const previous = new Map();
    const runs = new Map();
    if (dbUrl) {
        log(`db: ${describeUrl(dbUrl)}`);
        if (flags.ddl) {
            const ddl = await readFile(DDL_FILE, 'utf8');
            log(`db: applying ${relative(REPO, DDL_FILE)} (${ddl.length} bytes, idempotent)`);
            await psql(dbUrl, ddl, 'ddl');
        }
        const cases = normaliseStoredRows(JSON.parse((await psql(dbUrl, buildReadCasesQuery(), 'read cases', ['-t', '-A'])).trim() || '[]'));
        for (const row of cases) {
            // A decision made since the last run applies now, not when the case next turns up.
            const decision = review.get(row.key);
            previous.set(row.key, { ...row, reviewStatus: decision?.status ?? 'candidate', reviewNote: decision?.reason ?? null });
        }
        const stored = normaliseStoredRows(JSON.parse((await psql(dbUrl, buildReadQueriesQuery(), 'read queries', ['-t', '-A'])).trim() || '[]'));
        for (const r of stored) runs.set(`${r.source}|${r.query}`, r);
        log(`db: ${previous.size} stored case(s), ${runs.size} stored search run(s)`);
    } else {
        logWarn('--no-db: no stored state — every query is a baseline and this run raises NO events');
    }
    const firstRunEver = runs.size === 0;
    if (firstRunEver && dbUrl) log('db: no search has ever run — this run is the BASELINE: everything is recorded, nothing is raised');

    // --- checkpoint ---------------------------------------------------------------------------
    const checkpoint = await readCheckpoint(Boolean(flags.fresh));
    const detectedAt = checkpoint?.detectedAt ?? ts(new Date(RUN_STARTED_MS));
    const done = new Set(checkpoint?.done ?? []);
    if (checkpoint) log(`checkpoint: resuming the run of ${detectedAt} — ${done.size} task(s) already done will be skipped`);
    const saveCheckpoint = () => writeJson(CHECKPOINT_FILE, { startedAt: checkpoint?.startedAt ?? detectedAt, detectedAt, done: [...done] });

    // --- the tasks ----------------------------------------------------------------------------
    const tasks = [];
    for (const q of queries) {
        if (q.kind === 'docket') tasks.push({ id: `docket:${q.courtId}:${q.docketNumber}`, kind: 'docket', query: q });
        else for (const type of ['r', 'o']) tasks.push({ id: `${type}:${q.id}`, kind: 'search', type, query: q });
    }
    if (!flags['no-sec']) for (const feed of SEC_FEEDS) tasks.push({ id: `feed:${feed.id}`, kind: 'feed', feed });

    const failures = [];
    const events = [];
    const touched = new Set();
    const hitsBySource = {};
    let skipped = 0;
    let completed = 0;
    let baselineRecords = 0;
    const loopStartedMs = Date.now();

    /** One task's results into Postgres, in one transaction — this is the checkpoint. */
    const persist = async ({ rows = [], run = null, taskEvents = [] }) => {
        for (const row of rows) touched.add(row.key);
        events.push(...taskEvents);
        if (!dbUrl) return;
        const statements = [];
        if (rows.length) statements.push(buildCaseUpsertSql(rows).sql);
        if (run) statements.push(buildQueryRunSql([run]).sql);
        if (taskEvents.length) statements.push(buildChangeEventSql(taskEvents).sql);
        if (statements.length) await psql(dbUrl, wrapTransaction(statements), 'task');
        if (run) runs.set(`${run.source}|${run.query}`, { ...run, firstRunAt: runs.get(`${run.source}|${run.query}`)?.firstRunAt ?? run.runAt });
    };

    const runTask = async (task) => {
        if (task.kind === 'search' || task.kind === 'docket') {
            const q = task.query;
            const source = task.kind === 'docket' ? 'courtlistener-docket' : `courtlistener-${task.type}`;
            const runKey = task.kind === 'docket' ? `${q.courtId}:${q.docketNumber}` : q.phrase;
            const baseline = !dbUrl || !runs.has(`${source}|${runKey}`);
            const url = courtListenerUrl(task.kind === 'docket' ? { kind: 'docket', courtId: q.courtId, docketNumber: q.docketNumber }
                : { kind: 'search', type: task.type, phrase: q.phrase });
            const json = JSON.parse(await pacedGet(url, { headers: clHeaders, paceMs, accept: 'application/json' }));
            const parsed = parseCourtListenerResults(json, { type: task.kind === 'docket' ? 'r' : task.type, phrase: q.phrase });
            if (task.kind === 'docket' && parsed.records.length === 0) {
                throw new Error(`known docket ${q.courtId} ${q.docketNumber} (${q.name}) was not found on CourtListener`);
            }
            const label = q.phrase ?? `docket ${q.courtId} ${q.docketNumber}`;
            const { rows, events: taskEvents } = foldHits(parsed.records, { previous, query: { ...q, phrase: label }, baseline, detectedAt, review });
            hitsBySource[source] = (hitsBySource[source] ?? 0) + parsed.records.length;
            if (baseline) baselineRecords += rows.length;
            await persist({
                rows,
                taskEvents,
                run: { source, query: runKey, issuers: q.issuers, origins: q.origins, runAt: detectedAt, total: parsed.total }
            });
            return `${parsed.records.length}/${parsed.total ?? '?'} hit(s)${parsed.more ? ' (first page)' : ''}${baseline ? ' · baseline' : ''}`
                + `${taskEvents.length ? ` · ${taskEvents.length} event(s)` : ''}`;
        }
        if (task.kind === 'feed') {
            const { feed } = task;
            const prevRun = runs.get(`${feed.id}|(feed)`) ?? null;
            const baseline = !dbUrl || prevRun === null;
            const xml = await pacedGet(feed.url, { headers: secHeaders, paceMs, accept: 'application/rss+xml,application/xml' });
            const items = parseSecFeed(xml, feed);
            if (items.length === 0) throw new Error(`${feed.url}: no <item> parsed — the feed format changed`);
            if (secFeedGap(items, prevRun?.lastRunAt ?? null)) {
                failures.push(`${feed.label}: the feed's oldest item is newer than our last poll (${prevRun.lastRunAt}) — releases in between may have been missed`);
            }
            // One record per item, attributed to every phrase it names.
            const byKey = new Map();
            for (const { record, query } of matchSecItems(items, queries)) {
                const entry = byKey.get(record.key) ?? { record, phrases: [], issuers: new Set(), origins: [] };
                entry.phrases.push(query.phrase);
                query.issuers.forEach((i) => entry.issuers.add(i));
                entry.origins.push(...query.origins);
                if (record.matchLevel === 'caption') entry.record = record;
                byKey.set(record.key, entry);
            }
            const rows = [];
            const taskEvents = [];
            for (const { record, phrases, issuers } of byKey.values()) {
                const folded = foldHits([record], {
                    previous, query: { phrase: phrases.join(' | '), issuers: [...issuers].sort() }, baseline, detectedAt, review
                });
                rows.push(...folded.rows);
                taskEvents.push(...folded.events);
            }
            hitsBySource[feed.id] = (hitsBySource[feed.id] ?? 0) + rows.length;
            if (baseline) baselineRecords += rows.length;
            await persist({ rows, taskEvents, run: { source: feed.id, query: '(feed)', issuers: [], origins: [], runAt: detectedAt, total: items.length } });
            return `${items.length} item(s) since ${items.map((i) => i.dateFiled).filter(Boolean).sort()[0] ?? '?'}, ${rows.length} naming a watched party`
                + `${baseline ? ' · baseline' : ''}${taskEvents.length ? ` · ${taskEvents.length} event(s)` : ''}`;
        }
        if (task.kind === 'entries') {
            const row = previous.get(task.key);
            const json = JSON.parse(await pacedGet(courtListenerUrl({ kind: 'entries', docketId: row.docketId }),
                { headers: clHeaders, paceMs, accept: 'application/json' }));
            const latest = latestEntryFromDocuments(json.results);
            const { row: next, events: taskEvents } = entryEvent(row, latest, { detectedAt });
            previous.set(next.key, next);
            await persist({ rows: [next], taskEvents });
            return `${row.caseName} — newest entry ${latest ? `#${latest.number ?? '?'} of ${latest.date ?? '?'}` : 'none in RECAP'}`
                + `${taskEvents.length ? ` · ${taskEvents.length} event(s)` : ''}`;
        }
        throw new Error(`unknown task kind ${task.kind}`);
    };

    const execute = async (list, label) => {
        const startedMs = Date.now();
        for (let i = 0; i < list.length; i += 1) {
            const task = list[i];
            if (done.has(task.id)) {
                skipped += 1;
                continue;
            }
            try {
                const outcome = await runTask(task);
                done.add(task.id);
                completed += 1;
                await saveCheckpoint();
                log(`${label} [${progress(i + 1, list.length, startedMs)}] ${task.id.slice(0, 70)} — ${outcome}`);
            } catch (err) {
                failures.push(`${task.id}: ${err.message}`);
                logError(`${label} [${progress(i + 1, list.length, startedMs)}] ${task.id} FAILED — ${err.message}`);
            }
        }
    };

    await execute(tasks, 'search');

    // --- docket entries -----------------------------------------------------------------------
    if (entryLimit > 0) {
        const pinned = new Set([...previous.values()].filter((r) => (r.queries ?? []).some((q) => q.startsWith('docket '))).map((r) => r.key));
        const checks = selectEntryChecks([...previous.values()], { limit: entryLimit, pinned });
        const eligible = selectEntryChecks([...previous.values()], { limit: Number.MAX_SAFE_INTEGER, pinned }).length;
        log(`entries: ${checks.length} docket(s) to check of ${eligible} followed (cap ${entryLimit}, least recently checked first)`);
        await execute(checks.map((r) => ({ id: `entries:${r.key}`, kind: 'entries', key: r.key })), 'entries');
    }

    // --- report -------------------------------------------------------------------------------
    const durationMs = Date.now() - RUN_STARTED_MS;
    const recorded = [...touched].map((k) => previous.get(k)).filter(Boolean);
    const ranked = rankRows(recorded.filter((r) => r.reviewStatus !== 'dismissed'));
    const byLevel = { caption: 0, party: 0, text: 0 };
    for (const r of recorded) byLevel[r.matchLevel] = (byLevel[r.matchLevel] ?? 0) + 1;
    log(`watch-caselaw: ${completed} task(s) done, ${skipped} skipped from the checkpoint, ${failures.length} failed`
        + ` · ${counters.requests} request(s) (${counters.retries} retries) · ${(durationMs / 1000).toFixed(0)} s`);
    log(`watch-caselaw: hits per source — ${Object.entries(hitsBySource).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
    log(`watch-caselaw: ${recorded.length} distinct record(s) seen — caption ${byLevel.caption}, party ${byLevel.party}, text ${byLevel.text};`
        + ` ${recorded.filter((r) => r.reviewStatus === 'dismissed').length} dismissed`);
    for (const r of ranked.filter((x) => x.matchLevel === 'caption').slice(0, 10)) {
        log(`  caption: ${r.caseName} · ${r.court ?? '?'} · ${r.dateFiled ?? '?'} · ${r.url ?? ''} · ${r.issuers.join(',')}`);
    }
    if (baselineRecords && events.length === 0) {
        log(`watch-caselaw: baseline — ${baselineRecords} record(s) from first-time searches recorded, no events raised`);
    }
    log(`watch-caselaw: ${events.length} event(s)`);
    for (const e of events.slice(0, 20)) log(`  [${e.severity}] ${e.subjectId}: ${e.summary}`);

    const stats = {
        watchStatus: failures.length ? 'partial' : 'ok',
        generatedAt: ts(),
        lastRunStartedAt: ts(new Date(RUN_STARTED_MS)),
        detectedAt,
        durationMs,
        keyless: !token,
        queries: queries.length,
        tasks: tasks.length,
        tasksCompleted: completed,
        tasksSkipped: skipped,
        requests: counters.requests,
        retries: counters.retries,
        hitsBySource,
        records: recorded.length,
        recordsByMatch: byLevel,
        baseline: firstRunEver,
        events: events.length,
        eventsBySeverity: events.reduce((acc, e) => ({ ...acc, [e.severity]: (acc[e.severity] ?? 0) + 1 }), {}),
        failures: failures.length,
        failureReasons: failures.slice(0, 20)
    };
    await writeJson(STATS_FILE, stats);
    await rm(CHECKPOINT_FILE, { force: true });

    if ((events.length > 0 || failures.length > 0) && !flags['no-telegram']) {
        if (!telegramConfigured(env)) log('telegram: not configured in .env — the summary is logged instead');
        await postTelegram(formatTelegramSummary({
            events, failures, queries: queries.length, requests: counters.requests, durationMs, recorded: recorded.length
        }), { env });
    } else if (!flags['no-telegram']) {
        log('watch-caselaw: no events and no failures — no Telegram message');
    }

    if (failures.length) {
        logError(`watch-caselaw: run NOT successful — ${failures.length} failure(s):`);
        for (const f of failures.slice(0, 20)) logError(`    ${f}`);
        process.exitCode = 1;
        return;
    }
    log(`watch-caselaw: done (${COURTLISTENER_SEARCH} + ${SEC_FEEDS.length} SEC feeds)`);
}

main().catch(async (err) => {
    logError(err.stack || err.message);
    try {
        await writeJson(STATS_FILE, {
            watchStatus: 'failed',
            generatedAt: ts(),
            lastRunStartedAt: ts(new Date(RUN_STARTED_MS)),
            durationMs: Date.now() - RUN_STARTED_MS,
            requests: counters.requests,
            failures: 1,
            failureReasons: [err.message]
        });
    } catch (statsError) {
        logError(`watch-caselaw: could not record the failed outcome: ${statsError.message}`);
    }
    process.exitCode = 1;
});
