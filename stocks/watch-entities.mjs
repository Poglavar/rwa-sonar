#!/usr/bin/env node
// The daily legal-entity watcher: whether the SPVs, custodians, transfer agents, parents and
// security agents in every tokenized stock's trust chain still exist, changed name or status, were
// struck off, or entered insolvency. Reads GLEIF (LEI records), Zefix (Swiss commercial register),
// Companies House (UK, behind a free key) and The Gazette (UK insolvency notices), stores each
// change of state in sonar.entity_observation and raises sonar.change_event rows of kind
// `entity-status` / `insolvency`.
//
// The decisions (which entities, how a name is matched to an LEI, parsing, what is a change and how
// severe) are in lib/entities.mjs and unit tested in entities.test.js; this file is the IO: pacing,
// retries, psql, the checkpoint, the registry-id file and the one Telegram summary.

import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { backoffMs, retryable } from './lib/caselaw.mjs';
import { wrapTransaction } from './lib/db-load.mjs';
import {
    ZEFIX_SEARCH_URL, buildObservationSql, buildReadLatestQuery, companiesHouseOfficersUrl,
    companiesHouseProfileUrl, companiesHouseState, deriveEntities, foldObservation, formatTelegramSummary,
    gazetteNoticeDataUrl, gazetteSearchUrl, gazetteState, gleifParentExceptionUrl, gleifParentUrl, gleifRecordUrl, gleifSearchNames, gleifSearchUrl,
    gleifState, matchGleif, matchZefix, parseCompaniesHouseOfficers, parseCompaniesHouseProfile,
    parseGazetteNoticeData, parseGazetteSearch, parseGleifRecord, parseGleifReportingException, parseGleifSearch, parseZefixFirm,
    resolutionEntry, sourceUrl, watchTasks, zefixFirmUrl, zefixSearchBody, zefixState
} from './lib/entities.mjs';
import { readEnvFile } from './lib/env.mjs';
import { log, logError, logWarn, parseArgs, readJson, sleep, ts, writeJson } from './lib/io.mjs';
import { describeUrl, psql } from './lib/psql.mjs';
import { postTelegram, telegramConfigured } from './lib/telegram.mjs';
import { buildChangeEventSql } from './lib/watch.mjs';

const HERE = import.meta.dirname;
const REPO = join(HERE, '..');
const ISSUERS_DIR = join(HERE, 'data', 'issuers');
const CANONICAL_FILE = join(HERE, 'data', 'canonical-parties.json');
const REGISTRY_FILE = join(HERE, 'data', 'entity-registry-ids.json');
const STATS_FILE = join(REPO, '.last-entities-watch-stats.json');
const CHECKPOINT_FILE = join(REPO, '.entities-watch-checkpoint.json');
const RUN_STARTED_MS = Date.now();

/** GLEIF documents 60 requests a minute; Zefix and the Gazette publish no limit, so the same polite pace. */
const DEFAULT_PACE_MS = 1100;
const MAX_ATTEMPTS = 4;
const TIMEOUT_MS = 30_000;
/** A checkpoint (or a resolve pass) older than this belongs to an earlier run and is not resumed. */
const RESUME_MAX_AGE_MS = 6 * 3600 * 1000;
/** Gazette notices confirmed per entity per run; each costs one linked-data request. */
const MAX_GAZETTE_NOTICES = 25;
const USER_AGENT = 'rwa-sonar entity-watch (contact@rwasonar.com)';

function usage() {
    console.log(`watch-entities.mjs — daily legal-entity status and insolvency watch for every trust-chain party

USAGE
  node stocks/watch-entities.mjs --resolve [options]   propose registry ids for review (one-off, then after dossier changes)
  node stocks/watch-entities.mjs --run [options]       the daily watch

OPTIONS
  --run              Watch every entity with an accepted id in ${relative(REPO, REGISTRY_FILE)}.
  --resolve          Derive the entities from the dossiers and match each to GLEIF (and Zefix for Swiss
                     entities); rewrite ${relative(REPO, REGISTRY_FILE)}. Entries marked "reviewed": true are kept
                     as a person left them. Needs no database.
  --only=<issuer>    Only the entities in this issuer's chain.
  --fresh            Ignore a checkpoint (or, with --resolve, entries resolved in the last ${RESUME_MAX_AGE_MS / 3600000} h) and start over.
  --pace=<ms>        Minimum gap between requests to one host, default ${DEFAULT_PACE_MS} ms.
  --no-db            Fetch and print only: no state is read or written, so nothing is a change.
  --no-telegram      Never send the summary, whatever is in .env. It is still logged.
  --help             This text.

WHICH ENTITIES
  lib/entities.mjs deriveEntities: the case-law watcher's derivation (lib/caselaw.mjs deriveQueries —
  issuingEntity's legal entities, token issuers, tokenization providers, transfer agents, custodians,
  parents and security agents expanded to their legal names, with its stoplist), plus the legal
  entities in underlyingCustodian and securityInterest. Issuer brands with no corporate suffix are dropped.

RESOLUTION (--resolve)
  GLEIF: filter[entity.legalName] search; accepted ONLY on an exact legal-name match (Limited = Ltd,
  L.L.C. = LLC …) that is unique or made unique by the dossier's jurisdiction, and whose jurisdiction does
  not contradict the dossier. Anything else is listed as ambiguous/unmatched with its candidates, never
  accepted. National ids come from the accepted LEI record's own registeredAs (Companies House number,
  Swiss CHE UID, Jersey number); Swiss entities without an LEI are matched on Zefix by exact name.
  To accept a candidate by hand: copy its id into "lei" / "registries", set "reviewed": true.

WHAT A RUN DOES (--run)
  Per accepted id: GLEIF lei-record (+ its direct parent when GLEIF has one); Zefix firm detail (status,
  name, seat, takeover, SOGC publications); Companies House profile + officers (only with
  COMPANIES_HOUSE_API_KEY in .env); Gazette insolvency notices searched by the exact legal name and
  confirmed by the company number in each notice's linked data. The first observation is a baseline:
  recorded, and a finding only when the state is already adverse (LEI lapsed, entity INACTIVE, firm not
  EXISTIEREND, company not active, any insolvency notice). After that every difference is a finding
  with a severity; one sonar.change_event per finding per issuer whose chain includes the entity.
  ONE Telegram summary when there are findings or failures; ${relative(REPO, STATS_FILE)}; exit 1 on any failure.

RESUME
  Each task is written to Postgres in its own transaction and listed in ${relative(REPO, CHECKPOINT_FILE)};
  a killed run is resumed by the next within ${RESUME_MAX_AGE_MS / 3600000} h (same detected_at). The insert is itself
  idempotent (a row is written only when the latest stored state differs).

PM2 (proposed)
  rwa-watch-entities: daily at 03:29 UTC, --run, autorestart off. Schema: stocks/apply-schema.mjs at deploy.

FILES
  ${relative(REPO, REGISTRY_FILE)}   entity -> LEI / national ids, how matched, confidence; reviewed, committed
  sonar.entity_observation / sonar.entity_status_current / sonar.change_event`);
}

// ---------------------------------------------------------------------------------------------
// HTTP: one paced, retrying request. Pacing is per host, from the END of the previous request.
// ---------------------------------------------------------------------------------------------

const lastRequestEnd = new Map();
const counters = { requests: 0, retries: 0 };
let paceMs = DEFAULT_PACE_MS;

/** Returns {status, body}. 404 is an answer, not a failure: the caller decides what it means. */
async function request(url, { method = 'GET', headers = {}, body = null, accept = 'application/json', allow404 = false } = {}) {
    const host = new URL(url).host;
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const since = Date.now() - (lastRequestEnd.get(host) ?? 0);
        if (since < paceMs) await sleep(paceMs - since);
        counters.requests += 1;
        let res = null;
        try {
            res = await fetch(url, {
                method, body,
                headers: { accept, 'user-agent': USER_AGENT, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
                signal: AbortSignal.timeout(TIMEOUT_MS)
            });
            const text = await res.text();
            lastRequestEnd.set(host, Date.now());
            if (res.ok || (allow404 && res.status === 404)) return { status: res.status, body: text };
            lastError = `HTTP ${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 160)}`;
            if (!retryable(res.status)) break;
        } catch (err) {
            lastRequestEnd.set(host, Date.now());
            lastError = err.name === 'TimeoutError' ? `timeout after ${TIMEOUT_MS} ms` : `${err.cause?.code ?? err.name}: ${err.message}`;
        }
        if (attempt < MAX_ATTEMPTS) {
            const wait = backoffMs(attempt, { retryAfter: res?.headers?.get('retry-after') ?? null, baseMs: 3000 });
            counters.retries += 1;
            logWarn(`${host}: ${lastError} — retry ${attempt}/${MAX_ATTEMPTS - 1} in ${(wait / 1000).toFixed(0)} s`);
            await sleep(wait);
        }
    }
    throw new Error(`${method} ${url}: ${lastError}`);
}

async function getJson(url, opts = {}) {
    const { status, body } = await request(url, opts);
    if (status === 404) return null;
    try {
        return JSON.parse(body);
    } catch {
        throw new Error(`${url}: not JSON — ${body.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
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

async function readCheckpoint(fresh) {
    if (fresh) return null;
    try {
        const info = await stat(CHECKPOINT_FILE);
        if (Date.now() - info.mtimeMs > RESUME_MAX_AGE_MS) {
            logWarn(`checkpoint ${relative(REPO, CHECKPOINT_FILE)} is older than ${RESUME_MAX_AGE_MS / 3600000} h — not resumed`);
            return null;
        }
        return JSON.parse(await readFile(CHECKPOINT_FILE, 'utf8'));
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

function registryDocument(entries, dropped) {
    const counts = { entities: entries.length };
    for (const e of entries) counts[e.status] = (counts[e.status] ?? 0) + 1;
    counts.reviewed = entries.filter((e) => e.reviewed === true).length;
    return {
        note: 'Entity -> registry identifiers for stocks/watch-entities.mjs. GENERATED by `--resolve` (lib/entities.mjs'
            + ' matchGleif / matchZefix / registriesFromGleif), then REVIEWED and committed. Only `status: resolved`'
            + ' (an exact, unique legal-name match) or `reviewed: true` entries are watched; `candidates` are proposals'
            + ' and are never used. To accept one, copy its id into `lei` / `registries` and set `reviewed: true` —'
            + ' --resolve never overwrites a reviewed entry. `resolvedAt` is when the match was made (our clock).',
        counts,
        entities: entries,
        droppedBrands: dropped
    };
}

// ---------------------------------------------------------------------------------------------
// --resolve
// ---------------------------------------------------------------------------------------------

async function zefixSearch(nameOrUid) {
    const json = await getJson(ZEFIX_SEARCH_URL, { method: 'POST', body: zefixSearchBody(nameOrUid) });
    return (json?.list ?? []).map(parseZefixFirm);
}

async function resolve(flags) {
    const canonical = await readJson(CANONICAL_FILE, []);
    const { entities, dropped } = deriveEntities(await loadDossiers(), { canonical });
    const existing = await readJson(REGISTRY_FILE, { entities: [] });
    const byKey = new Map((existing.entities ?? []).map((e) => [e.key, e]));
    const scope = typeof flags.only === 'string' ? entities.filter((e) => e.issuers.includes(flags.only)) : entities;
    log(`resolve: ${entities.length} entities derived from the dossiers, ${scope.length} in scope; ${byKey.size} in ${relative(REPO, REGISTRY_FILE)}`);
    const failures = [];
    const startedMs = Date.now();
    let skipped = 0;
    for (const [i, entity] of scope.entries()) {
        const previous = byKey.get(entity.key) ?? null;
        const label = `resolve [${progress(i + 1, scope.length, startedMs)}] ${entity.name}`;
        if (previous?.reviewed === true) {
            byKey.set(entity.key, resolutionEntry(entity, { previous, resolvedAt: previous.resolvedAt ?? null }));
            log(`${label} — reviewed by a person, kept`);
            continue;
        }
        const recent = previous?.resolvedAt && Date.now() - Date.parse(previous.resolvedAt) < RESUME_MAX_AGE_MS;
        if (recent && !flags.fresh) {
            skipped += 1;
            continue;
        }
        try {
            // Swiss entities: Zefix first, so its UID can pick between GLEIF records sharing a name.
            let zefix = entity.jurisdiction === 'CH' ? matchZefix(entity, await zefixSearch(entity.name)) : null;
            const nationalIds = zefix?.accepted ? [zefix.zefix.uid] : [];
            let gleif = null;
            for (const name of gleifSearchNames(entity.name)) {
                gleif = matchGleif(entity, parseGleifSearch(await getJson(gleifSearchUrl(name))), { nationalIds });
                if (gleif.accepted || gleif.status === 'ambiguous') break;
            }
            // An LEI record whose registeredAs is a Swiss UID that Zefix did not match by name (a firm
            // GLEIF spells differently) is still found on Zefix by that UID.
            const uid = gleif.accepted && gleif.record.jurisdiction === 'CH' ? gleif.record.registeredAs?.replace(/[.-]/g, '') : null;
            if (uid && !(zefix?.accepted && zefix.zefix.uid === uid)) {
                const firms = (await zefixSearch(uid)).filter((f) => f.uid === uid);
                if (firms.length === 1) zefix = { status: 'resolved', accepted: true, zefix: { uid, ehraid: firms[0].ehraid, name: firms[0].name, matchedBy: 'gleif-registeredAs', confidence: 'high' } };
            }
            const entry = resolutionEntry(entity, { gleif, zefix, previous, resolvedAt: ts() });
            byKey.set(entity.key, entry);
            log(`${label} — ${entry.status}${entry.lei ? ` LEI ${entry.lei.id} (${entry.lei.matchedBy})` : ''}`
                + `${Object.keys(entry.registries).length ? ` · ${Object.entries(entry.registries).map(([k, v]) => `${k} ${v.id ?? v.uid}`).join(', ')}` : ''}`
                + `${entry.note ? ` · ${entry.note}` : ''}`);
        } catch (err) {
            failures.push(`${entity.name}: ${err.message}`);
            logError(`${label} FAILED — ${err.message}`);
        }
        // The file is the checkpoint: every resolved entity is on disk before the next request.
        await writeJson(REGISTRY_FILE, registryDocument(orderedEntries(byKey, entities), dropped));
    }
    const entries = orderedEntries(byKey, entities);
    await writeJson(REGISTRY_FILE, registryDocument(entries, dropped));
    if (skipped) log(`resolve: ${skipped} entit(ies) resolved within the last ${RESUME_MAX_AGE_MS / 3600000} h were skipped (resume; --fresh redoes them)`);
    log(`resolve: wrote ${relative(REPO, REGISTRY_FILE)} — review it, then commit`);
    console.log('\nENTITY | JURISDICTION | STATUS | LEI | NATIONAL IDS | CONFIDENCE | ISSUERS');
    for (const e of entries.filter((x) => scope.some((s) => s.key === x.key))) {
        const national = Object.entries(e.registries ?? {}).map(([k, v]) => `${k}:${v.id ?? v.uid}`).join(' ') || '-';
        const cands = e.candidates?.gleif?.length ? ` [${e.candidates.gleif.length} GLEIF candidate(s): ${e.candidates.gleif.slice(0, 2).map((c) => `${c.name} ${c.lei}`).join('; ')}]` : '';
        console.log(`${e.name} | ${e.jurisdiction ?? '?'} | ${e.status}${e.reviewed ? ' (reviewed)' : ''} | ${e.lei?.id ?? '-'} | ${national} | ${e.lei?.confidence ?? '-'} | ${e.issuers.join(',')}${cands}`);
    }
    if (failures.length) {
        logError(`resolve: ${failures.length} failure(s)`);
        process.exitCode = 1;
    }
}

/** Registry entries in entity order; entries for entities no longer derived are kept (a person may have added them). */
function orderedEntries(byKey, entities) {
    const derived = new Set(entities.map((e) => e.key));
    return [...byKey.values()].map((e) => (derived.has(e.key) ? e : { ...e, derived: false }))
        .sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------------------------
// --run
// ---------------------------------------------------------------------------------------------

/** One task's fetch → {state, sourceUpdatedAt, url}. */
async function observe(task, { chKey }) {
    if (task.source === 'gleif') {
        const json = await getJson(gleifRecordUrl(task.identifier), { allow404: true });
        if (!json) throw new Error(`GLEIF has no record ${task.identifier} (404) — the LEI in the registry file is wrong or was removed`);
        const record = parseGleifRecord(json.data);
        let parent = null;
        let exception = null;
        if (record.hasDirectParent) {
            const p = await getJson(gleifParentUrl(task.identifier), { allow404: true });
            if (p?.data) parent = parseGleifRecord(p.data);
        } else if (record.parentException) {
            const x = await getJson(gleifParentExceptionUrl(task.identifier), { allow404: true });
            if (x) exception = parseGleifReportingException(x);
        }
        return { ...gleifState(record, parent, exception), url: sourceUrl('gleif', task.identifier) };
    }
    if (task.source === 'zefix') {
        let ehraid = task.ehraid;
        if (!ehraid) {
            const firms = await zefixSearch(task.identifier);
            ehraid = firms.find((f) => f.uid === task.identifier)?.ehraid ?? null;
            if (!ehraid) throw new Error(`Zefix has no firm with UID ${task.identifier}`);
        }
        const firm = parseZefixFirm(await getJson(zefixFirmUrl(ehraid)));
        if (firm.uid !== task.identifier) throw new Error(`Zefix firm ${ehraid} is ${firm.uid}, not ${task.identifier}`);
        return { ...zefixState(firm), url: sourceUrl('zefix', task.identifier, { excerptUrl: firm.excerptUrl }) };
    }
    if (task.source === 'companies-house') {
        const auth = { authorization: `Basic ${Buffer.from(`${chKey}:`).toString('base64')}` };
        const profileJson = await getJson(companiesHouseProfileUrl(task.identifier), { headers: auth, allow404: true });
        if (!profileJson) throw new Error(`Companies House has no company ${task.identifier} (404)`);
        const officers = parseCompaniesHouseOfficers(await getJson(companiesHouseOfficersUrl(task.identifier), { headers: auth }));
        return { ...companiesHouseState(parseCompaniesHouseProfile(profileJson), officers), url: sourceUrl('companies-house', task.identifier) };
    }
    if (task.source === 'gazette') {
        const notices = parseGazetteSearch(await getJson(gazetteSearchUrl(task.legalName)));
        if (notices.length > MAX_GAZETTE_NOTICES) {
            throw new Error(`Gazette: ${notices.length} insolvency notices for "${task.legalName}" — more than the ${MAX_GAZETTE_NOTICES} this run confirms; read them by hand`);
        }
        const noticeData = {};
        // The linked data answers HTTP 500 to `accept: application/json` (measured 2026-09-30).
        for (const n of notices) noticeData[n.id] = parseGazetteNoticeData(await getJson(gazetteNoticeDataUrl(n.id), { accept: 'application/ld+json' }));
        return {
            ...gazetteState({ companyNumber: task.identifier, legalName: task.legalName, notices, noticeData }),
            url: sourceUrl('gazette', task.identifier, { legalName: task.legalName })
        };
    }
    throw new Error(`unknown source ${task.source}`);
}

async function run(flags, env) {
    const dbUrl = flags['no-db'] ? null : (process.env.DATABASE_URL || env.DATABASE_URL || null);
    if (!flags['no-db'] && !dbUrl) throw new Error(`DATABASE_URL is not set in ${join(REPO, '.env')} — pass --no-db to fetch without Postgres`);
    const chKey = env.COMPANIES_HOUSE_API_KEY || process.env.COMPANIES_HOUSE_API_KEY || null;
    const sourcesSkipped = {};
    if (!chKey) {
        sourcesSkipped['companies-house'] = 'no COMPANIES_HOUSE_API_KEY in .env (free key: developer.company-information.service.gov.uk)';
        log('companies-house: no COMPANIES_HOUSE_API_KEY in .env — skipped (UK entities are still watched through GLEIF and the Gazette)');
    }

    const canonical = await readJson(CANONICAL_FILE, []);
    const { entities } = deriveEntities(await loadDossiers(), { canonical });
    const registry = await readJson(REGISTRY_FILE, null);
    if (!registry) throw new Error(`${relative(REPO, REGISTRY_FILE)} is missing — run with --resolve first, review it, commit it`);
    const byKey = new Map(registry.entities.map((e) => [e.key, e]));
    let scope = entities;
    if (typeof flags.only === 'string') scope = scope.filter((e) => e.issuers.includes(flags.only));
    if (scope.length === 0) throw new Error('no entities in scope');

    const tasks = [];
    const unresolved = [];
    const missing = [];
    for (const entity of scope) {
        const entry = byKey.get(entity.key);
        if (!entry) {
            missing.push(entity.name);
            unresolved.push(entity.name);
            continue;
        }
        // Issuers follow the dossiers, not the file: a new issuer using a known entity is watched at once.
        const t = watchTasks({ ...entry, issuers: entity.issuers, name: entry.name ?? entity.name }, { companiesHouseKey: Boolean(chKey) });
        if (t.length === 0) unresolved.push(entity.name);
        tasks.push(...t);
    }
    const watchedEntities = new Set(tasks.map((t) => t.entityKey));
    if (missing.length) logWarn(`registry: ${missing.length} derived entit(ies) not in ${relative(REPO, REGISTRY_FILE)} — run --resolve: ${missing.join('; ')}`);
    log(`entities: ${scope.length} derived · ${watchedEntities.size} with an accepted id · ${unresolved.length} unresolved · ${tasks.length} task(s)`
        + ` (${['gleif', 'zefix', 'companies-house', 'gazette'].map((s) => `${s} ${tasks.filter((t) => t.source === s).length}`).join(', ')})`);

    const previous = new Map();
    if (dbUrl) {
        log(`db: ${describeUrl(dbUrl)}`);
        const rows = JSON.parse((await psql(dbUrl, buildReadLatestQuery(), 'read latest', ['-t', '-A'])).trim() || '[]');
        for (const r of rows) previous.set(`${r.entityKey}|${r.source}|${r.identifier}`, r);
        log(`db: ${previous.size} stored state(s)`);
    } else {
        logWarn('--no-db: no stored state — every observation is a baseline and nothing is written');
    }

    const checkpoint = await readCheckpoint(Boolean(flags.fresh));
    const detectedAt = checkpoint?.detectedAt ?? ts(new Date(RUN_STARTED_MS));
    const done = new Set(checkpoint?.done ?? []);
    if (checkpoint) log(`checkpoint: resuming the run of ${detectedAt} — ${done.size} task(s) already done will be skipped`);
    const saveCheckpoint = () => writeJson(CHECKPOINT_FILE, { detectedAt, done: [...done] });

    const failures = [];
    const findings = [];
    let eventCount = 0;
    let rowsWritten = 0;
    let baselineRows = 0;
    let confirmed = 0;
    let skipped = 0;
    let completed = 0;
    const startedMs = Date.now();
    for (const [i, task] of tasks.entries()) {
        const label = `watch [${progress(i + 1, tasks.length, startedMs)}] ${task.entityName} · ${task.source} ${task.identifier}`;
        if (done.has(`${task.id}|${task.entityKey}`)) {
            skipped += 1;
            continue;
        }
        try {
            const observation = await observe(task, { chKey });
            const prev = previous.get(`${task.entityKey}|${task.source}|${task.identifier}`) ?? null;
            const folded = foldObservation(task, observation, { previous: prev, detectedAt });
            if (dbUrl) {
                const statements = [];
                const obs = buildObservationSql({ rows: folded.row ? [folded.row] : [], confirms: folded.confirm ? [folded.confirm] : [] });
                if (obs.sql) statements.push(obs.sql);
                if (folded.events.length) statements.push(buildChangeEventSql(folded.events).sql);
                await psql(dbUrl, wrapTransaction(statements), `task ${task.id}`);
            }
            if (folded.row) {
                rowsWritten += 1;
                if (folded.row.changeKind === 'baseline') baselineRows += 1;
                previous.set(`${task.entityKey}|${task.source}|${task.identifier}`, { state: folded.row.state, stateHash: folded.row.stateHash });
            } else {
                confirmed += 1;
            }
            findings.push(...folded.findings.map((f) => ({ ...f, entityName: task.entityName, source: task.source, identifier: task.identifier })));
            eventCount += folded.events.length;
            done.add(`${task.id}|${task.entityKey}`);
            completed += 1;
            await saveCheckpoint();
            const s = observation.state;
            const summary = task.source === 'gleif' ? `${s.entityStatus}/${s.registrationStatus} "${s.legalName}" ${s.jurisdiction}${s.directParent ? ` parent ${s.directParent.name}` : ''}`
                : task.source === 'zefix' ? `${s.status} "${s.name}" ${s.legalSeat}`
                    : task.source === 'companies-house' ? `${s.status} "${s.name}"${s.hasInsolvencyHistory ? ' INSOLVENCY HISTORY' : ''}`
                        : `${s.confirmed.length} confirmed / ${s.nameOnly.length} name-only insolvency notice(s)`;
            log(`${label} — ${summary} · ${folded.row ? folded.row.changeKind : 'unchanged'}`
                + `${folded.findings.length ? ` · ${folded.findings.map((f) => `[${f.severity}] ${f.field}`).join(', ')}` : ''}`);
        } catch (err) {
            failures.push(`${task.entityName} ${task.source} ${task.identifier}: ${err.message}`);
            logError(`${label} FAILED — ${err.message}`);
        }
    }

    const durationMs = Date.now() - RUN_STARTED_MS;
    const bySeverity = findings.reduce((acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] ?? 0) + 1 }), {});
    log(`watch-entities: ${completed} task(s) done, ${skipped} skipped from the checkpoint, ${failures.length} failed`
        + ` · ${counters.requests} request(s) (${counters.retries} retries) · ${(durationMs / 1000).toFixed(0)} s`);
    log(`watch-entities: ${rowsWritten} state row(s) written (${baselineRows} baseline), ${confirmed} unchanged; ${findings.length} finding(s)`
        + ` ${JSON.stringify(bySeverity)}; ${eventCount} change event(s)`);
    for (const f of findings.slice(0, 30)) log(`  [${f.severity}] ${f.entityName} (${f.source} ${f.identifier}): ${f.field} ${f.before ?? ''} → ${f.after ?? '(none)'}`);
    if (unresolved.length) log(`watch-entities: unresolved (no accepted id, not watched): ${unresolved.join('; ')}`);

    const stats = {
        watchStatus: failures.length ? 'partial' : 'ok',
        lastRunStartedAt: ts(new Date(RUN_STARTED_MS)),
        lastRunEndedAt: ts(),
        detectedAt,
        durationMs,
        entitiesDerived: scope.length,
        entitiesWatched: watchedEntities.size,
        resolved: watchedEntities.size,
        unresolved: unresolved.length,
        unresolvedNames: unresolved,
        tasks: tasks.length,
        tasksCompleted: completed,
        tasksSkipped: skipped,
        requests: counters.requests,
        retries: counters.retries,
        rowsWritten,
        baselineRows,
        changes: findings.length,
        changesBySeverity: bySeverity,
        events: eventCount,
        sourcesSkipped,
        failures: failures.length,
        failureReasons: failures.slice(0, 20)
    };
    if (dbUrl) await writeJson(STATS_FILE, stats);
    else log('--no-db: stats file not written (a dry run is not a run the alert should see)');
    await rm(CHECKPOINT_FILE, { force: true });

    if ((findings.length > 0 || failures.length > 0) && !flags['no-telegram']) {
        if (!telegramConfigured(env)) log('telegram: not configured in .env — the summary is logged instead');
        await postTelegram(formatTelegramSummary({
            findings, events: eventCount, failures, entitiesWatched: watchedEntities.size, resolved: watchedEntities.size,
            unresolved: unresolved.length, requests: counters.requests, durationMs
        }), { env });
    } else if (!flags['no-telegram']) {
        log('watch-entities: no findings and no failures — no Telegram message');
    }
    if (failures.length) {
        logError(`watch-entities: run NOT successful — ${failures.length} failure(s):`);
        for (const f of failures.slice(0, 20)) logError(`    ${f}`);
        process.exitCode = 1;
        return;
    }
    log('watch-entities: done');
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || (!flags.run && !flags.resolve)) {
        usage();
        return;
    }
    if (flags.pace !== undefined) {
        paceMs = Number(flags.pace);
        if (!Number.isFinite(paceMs) || paceMs < 500) throw new Error(`--pace must be >= 500 ms, got ${flags.pace}`);
    }
    const env = await readEnvFile(join(REPO, '.env'));
    if (flags.resolve) await resolve(flags);
    if (flags.run) await run(flags, env);
}

main().catch(async (err) => {
    logError(err.stack || err.message);
    try {
        await writeJson(STATS_FILE, {
            watchStatus: 'failed',
            lastRunStartedAt: ts(new Date(RUN_STARTED_MS)),
            lastRunEndedAt: ts(),
            durationMs: Date.now() - RUN_STARTED_MS,
            requests: counters.requests,
            changes: 0,
            failures: 1,
            failureReasons: [err.message]
        });
    } catch (statsError) {
        logError(`watch-entities: could not record the failed outcome: ${statsError.message}`);
    }
    process.exitCode = 1;
});
