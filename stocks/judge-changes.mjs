#!/usr/bin/env node
// The change judge (EVIDENCE.md §2.3 "LLM judge", next-steps.md iteration item 4): asks a Claude
// model, through the Message Batches API at half price, whether each unjudged document change
// alters what a holder owns, can do, or can have done to them, and stores the answer in
// sonar.change_judgment with its per-call cost. Dry run by default: it prints the candidates, the
// first prompt and the estimated cost, and spends nothing. Everything that decides anything is in
// lib/change-judge.mjs (unit tested); this file is the IO, the batch, the checkpoint and the log.

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createAnthropicClient } from './lib/anthropic-rest.mjs';
import { wrapTransaction } from './lib/db-load.mjs';
import { readEnvFile } from './lib/env.mjs';
import { log, logError, logWarn, parseArgs, ts } from './lib/io.mjs';
import { describeUrl, psql } from './lib/psql.mjs';
import { diffLines } from './lib/textdiff.mjs';
import { sourceId } from './lib/watch.mjs';
import {
    JUDGED_KINDS, JUDGMENT_SCHEMA, PROMPT_VERSION, batchRequest, buildJudgmentSql, buildPrompt,
    changeTextFor, customIdFor, directResultItem, estimateCost, estimateTokens, judgmentRow, judgmentRows,
    previousVersion, selectCandidates
} from './lib/change-judge.mjs';

const HERE = import.meta.dirname;
const REPO = join(HERE, '..');
const DDL_FILE = join(REPO, 'db', '2026-09-23-sonar-change-judgment.sql');
const CHECKPOINT_DIR = join(HERE, 'data', 'raw', 'change-judge');
const REPO_NAME = 'rwa-sonar';
const SCRIPT = 'judge-changes';

// Claude Sonnet 5: the current-generation cost-effective model (USD 2/10 per MTok online, 1/5 in a
// batch) with structured outputs and Batch API support. A materiality read of a bounded diff is a
// classification with a short justification — the "cheaper model as LLM judge" case — and every
// verdict is shown as a model assessment beside the diff, never alone. `--model=claude-opus-5`
// is the step up if a sample shows Sonnet missing material changes.
const DEFAULT_MODEL = 'claude-sonnet-5';
const EFFORT = 'medium';
const MAX_TOKENS = 8000;
// Assumed output per item for the ESTIMATE only: ~300 tokens of JSON plus adaptive thinking at
// medium effort. The ceiling (MAX_TOKENS) is printed beside it; the stored cost is the real one.
const EST_OUTPUT_TOKENS = 1200;
const DEFAULT_LIMIT = 5;
const LARGE_LIMIT = 25;
const POLL_MS = 60_000;
// --direct is a fallback at full price, so it is kept small: it exists for a batch the API accepts
// and then never processes (msgbatch_01GQNdX9…: 0 of 5 processed after 8.5 h on 2026-09-23 while the
// same request shape answered online in 6 s).
const DIRECT_LIMIT = 10;

function usage() {
    console.log(`Usage: node stocks/judge-changes.mjs [--dry-run | --run] [--limit=N] [--model=ID] [--allow-large] [--direct]

Asks a model whether each unjudged document change (sonar.change_event kinds ${JUDGED_KINDS.join(', ')})
alters what a holder owns, can do, or can have done to them. One candidate per change: events of
the same source and content hash are judged once. Results go to sonar.change_judgment
(${DDL_FILE.replace(`${REPO}/`, '')}), one row per change with its tokens and cost_usd; every
call is also appended to the shared ledger (agents/lib/llm-cost, \`llm-cost --repo ${REPO_NAME}\`).

  --dry-run       default. Lists candidates, prints the first prompt, estimates cost per item and
                  in total. Token counts come from the count-tokens endpoint when ANTHROPIC_API_KEY
                  is in .env, otherwise chars/4 (stated as an estimate). Spends nothing.
  --run           submit ONE Message Batches batch of the newest --limit candidates, poll every
                  ${POLL_MS / 1000} s, collect, validate, store each item as it arrives.
  --limit=N       items in the batch (default ${DEFAULT_LIMIT}; more than ${LARGE_LIMIT} needs --allow-large).
  --model=ID      default ${DEFAULT_MODEL} (must be priced in agents/lib/llm-cost/rates.json).
  --allow-large   permit --limit above ${LARGE_LIMIT}. Do not use without the owner's approval.
  --direct        with --run: send the items as online calls at FULL price instead of a batch (at most
                  ${DIRECT_LIMIT}). A fallback for a batch that is accepted but never processed; each call
                  is costed and ledgered like a batch item, stored with batch_id "direct".
  --help          this text.

A submitted batch is checkpointed under stocks/data/raw/change-judge/<batch id>.json before polling,
so a killed run resumes that batch on the next --run instead of paying for a second one.

Needs DATABASE_URL and, for --run, ANTHROPIC_API_KEY in ${join(REPO, '.env')}.
Prompt version ${PROMPT_VERSION}; effort ${EFFORT}; max_tokens ${MAX_TOKENS}.`);
}

async function loadLlmCost(env) {
    const dir = env.LLM_COST_LIB || join(REPO, '..', 'agents', 'lib', 'llm-cost');
    const index = await import(pathToFileURL(join(dir, 'index.mjs')).href);
    const batch = await import(pathToFileURL(join(dir, 'batch.mjs')).href);
    return { ...index, ...batch, dir };
}

async function queryJson(url, sql, label) {
    const out = await psql(url, sql, label, ['-At']);
    return JSON.parse(out.trim() || 'null');
}

async function loadEvents(url) {
    return queryJson(url, `SELECT coalesce(json_agg(row_to_json(t) ORDER BY t."detectedAt" DESC, t.id DESC), '[]')
  FROM (SELECT id, to_char(detected_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "detectedAt",
               kind, subject_type AS "subjectType", subject_id AS "subjectId", field, severity, summary, evidence
          FROM sonar.change_event
         WHERE kind IN (${JUDGED_KINDS.map((k) => `'${k}'`).join(', ')})) t;`, 'change events');
}

async function loadJudgedKeys(url, model) {
    const exists = await queryJson(url, "SELECT to_json(to_regclass('sonar.change_judgment') IS NOT NULL);", 'judgment table');
    if (!exists) return new Set();
    const keys = await queryJson(url, `SELECT coalesce(json_agg(DISTINCT dedupe_key), '[]') FROM sonar.change_judgment
 WHERE model = '${model.replace(/'/g, "''")}' AND prompt_version = '${PROMPT_VERSION}' AND status <> 'error';`, 'judged keys');
    return new Set(keys);
}

async function loadSources(url, ids) {
    if (!ids.length) return new Map();
    const list = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
    const rows = await queryJson(url, `SELECT coalesce(json_agg(json_build_object(
    'id', s.id, 'url', s.url, 'title', s.title, 'issuerSlug', s.issuer_slug, 'foundIn', s.found_in,
    'claims', (SELECT coalesce(json_agg(json_build_object('id', c.id, 'field', c.field, 'value', c.value,
                       'quote', c.quote, 'status', c.status) ORDER BY c.field, c.id), '[]')
                 FROM sonar.claim c WHERE c.active AND (c.source_id = s.id OR c.url = s.url)),
    'versions', (SELECT coalesce(json_agg(json_build_object('fetchedAt',
                       to_char(v.fetched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                       'textPath', v.text_path) ORDER BY v.fetched_at DESC), '[]')
                 FROM sonar.source_version v WHERE v.source_id = s.id))), '[]')
  FROM sonar.source s WHERE s.id IN (${list});`, 'sources');
    return new Map(rows.map((r) => [r.id, r]));
}

async function readText(relPath) {
    if (typeof relPath !== 'string' || relPath === '') return null;
    try {
        return await readFile(join(REPO, relPath), 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return null; // pruned: the watcher keeps the last five versions
        throw err;
    }
}

/** What the model reads for one candidate, from the stored texts where they still exist. */
async function prepare(candidate, source) {
    const ev = candidate.event.evidence ?? {};
    const texts = {};
    if (candidate.kind === 'legal-term') {
        const current = await readText(ev.textPath);
        const prev = previousVersion(source?.versions, ev.versionFetchedAt ?? candidate.detectedAt);
        const before = prev ? await readText(prev.textPath) : null;
        if (current !== null && before !== null) texts.diffText = diffLines(before, current, { maxLines: 2000 }).unified;
    } else if (candidate.kind === 'quote-lost') {
        texts.currentText = await readText(ev.textPath);
    } else {
        const last = source?.versions?.[0];
        texts.lastText = last ? await readText(last.textPath) : null;
    }
    const change = changeTextFor(candidate, texts);
    const prompt = buildPrompt(candidate, { source, claims: source?.claims ?? [], change });
    return { candidate, prompt, change };
}

const usd = (v) => `$${v.toFixed(4)}`;

async function countInputTokens(client, model, prompt) {
    const res = await client.messages.countTokens({
        model, system: prompt.system, messages: [{ role: 'user', content: prompt.user }]
    });
    // The output schema is sent too but not counted here; add its chars/4.
    return res.input_tokens + estimateTokens(JSON.stringify(JUDGMENT_SCHEMA));
}

async function estimate(items, { model, rate, client }) {
    const rows = [];
    for (const item of items) {
        const inputTokens = client
            ? await countInputTokens(client, model, item.prompt)
            : estimateTokens(item.prompt.system + item.prompt.user + JSON.stringify(JUDGMENT_SCHEMA));
        rows.push({
            item,
            inputTokens,
            usd: estimateCost({ inputTokens, outputTokens: EST_OUTPUT_TOKENS }, rate),
            ceilingUsd: estimateCost({ inputTokens, outputTokens: MAX_TOKENS }, rate)
        });
    }
    return rows;
}

const sum = (rows, k) => rows.reduce((acc, r) => acc + r[k], 0);

async function readCheckpoints() {
    let names = [];
    try {
        names = await readdir(CHECKPOINT_DIR);
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
    const out = [];
    for (const name of names.filter((n) => n.endsWith('.json'))) {
        out.push(JSON.parse(await readFile(join(CHECKPOINT_DIR, name), 'utf8')));
    }
    return out;
}

async function writeCheckpoint(cp) {
    await mkdir(CHECKPOINT_DIR, { recursive: true });
    const path = join(CHECKPOINT_DIR, `${cp.batchId}.json`);
    await writeFile(`${path}.tmp`, `${JSON.stringify(cp, null, 2)}\n`, 'utf8');
    await rename(`${path}.tmp`, path);
}

async function collect({ client, llm, cp, dbUrl }) {
    log(`batch ${cp.batchId}: waiting (${Object.keys(cp.pending).length} item(s), polling every ${POLL_MS / 1000} s)`);
    const started = Date.now();
    await llm.awaitBatch({
        client, provider: 'anthropic', batchId: cp.batchId, pollMs: POLL_MS,
        onProgress: (s) => log(`batch ${cp.batchId}: ${s.status} · ${s.succeeded} succeeded · ${s.errored} errored · `
            + `${s.processing} processing · ${Math.round((Date.now() - started) / 1000)} s`)
    });
    const already = new Set(cp.collected);
    if (already.size) {
        logWarn(`resuming collection: ${already.size} item(s) were stored by an earlier run and are skipped; `
            + 'their ledger lines are appended again by the shared collector (a partial-collection resume only)');
    }
    const totals = { items: 0, valid: 0, invalid: 0, error: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
    const items = llm.collectBatch({
        client, provider: 'anthropic', batchId: cp.batchId, model: cp.model, repo: REPO_NAME, script: SCRIPT,
        meta: { promptVersion: PROMPT_VERSION }
    });
    for await (const row of judgmentRows(items, cp.pending, { model: cp.model, batchId: cp.batchId })) {
        const customId = customIdFor({ eventId: row.changeEventId });
        if (already.has(customId)) continue;
        const sql = buildJudgmentSql([row]);
        await psql(dbUrl, wrapTransaction(sql.sql), sql.table);
        cp.collected.push(customId);
        await writeCheckpoint(cp);
        totals.items += 1;
        totals[row.status] += 1;
        totals.input += row.inputTokens;
        totals.output += row.outputTokens;
        totals.cacheRead += row.cacheReadTokens;
        totals.cacheWrite += row.cacheCreationTokens;
        totals.usd += row.costUsd;
        const j = row.judgment;
        log(`  event ${row.changeEventId} [${row.status}] ${j?.severity ?? '-'}${j?.material ? ' material' : ''}`
            + ` · in ${row.inputTokens} / out ${row.outputTokens} tok · ${usd(row.costUsd)}`
            + (row.reasons.length ? ` · ${row.reasons.join('; ')}` : ''));
    }
    cp.done = true;
    cp.collectedAt = ts();
    await writeCheckpoint(cp);
    log(`run: ${totals.items} item(s) (${totals.valid} valid, ${totals.invalid} invalid, ${totals.error} error) · `
        + `input ${totals.input} tok · output ${totals.output} tok · cache read ${totals.cacheRead} / write ${totals.cacheWrite} tok · `
        + `total ${usd(totals.usd)} (batch, ${cp.model})`);
    return totals;
}

/**
 * The --direct fallback: one online call per item, costed at full price, stored and ledgered as it
 * arrives. An item already judged is not a candidate, so a rerun never pays twice.
 */
async function judgeDirect({ client, llm, dbUrl, model, items }) {
    if (items.length > DIRECT_LIMIT) {
        logError(`--direct is limited to ${DIRECT_LIMIT} item(s) at full price; got ${items.length}`);
        return 1;
    }
    const totals = { items: 0, valid: 0, invalid: 0, error: 0, usd: 0 };
    for (const p of items) {
        const request = batchRequest(p.candidate, p.prompt, { model, maxTokens: MAX_TOKENS, effort: EFFORT });
        let item;
        try {
            item = directResultItem(request.custom_id, await client.messages.create(request.params));
            item.costUsd = llm.computeCost(model, item.usage, { batch: false });
            llm.record({ repo: REPO_NAME, script: SCRIPT, model, usage: item.usage, cost_usd: item.costUsd, batch: false,
                meta: { promptVersion: PROMPT_VERSION, customId: request.custom_id, mode: 'direct' } });
        } catch (err) {
            item = { customId: request.custom_id, error: err.message };
        }
        const { event, ...candidate } = p.candidate;
        const row = judgmentRow({ candidate: { ...candidate, event: { id: event.id, kind: event.kind } },
            changeText: p.prompt.changeText, item, model, batchId: 'direct' });
        const sql = buildJudgmentSql([row]);
        await psql(dbUrl, wrapTransaction(sql.sql), sql.table);
        totals.items += 1;
        totals[row.status] += 1;
        totals.usd += row.costUsd;
        const j = row.judgment;
        log(`  event ${row.changeEventId} [${row.status}] ${j?.severity ?? '-'}${j?.material ? ' material' : ''}`
            + ` · in ${row.inputTokens} / out ${row.outputTokens} tok · ${usd(row.costUsd)}`
            + (row.reasons.length ? ` · ${row.reasons.join('; ')}` : ''));
    }
    log(`direct run: ${totals.items} item(s) (${totals.valid} valid, ${totals.invalid} invalid, ${totals.error} error) · `
        + `total ${usd(totals.usd)} (online, full price, ${model})`);
    return totals.error ? 1 : 0;
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help) {
        usage();
        return 0;
    }
    const run = Boolean(flags.run);
    const env = await readEnvFile(join(REPO, '.env'));
    const dbUrl = process.env.DATABASE_URL || env.DATABASE_URL;
    if (!dbUrl) {
        logError(`DATABASE_URL is not set in ${join(REPO, '.env')}`);
        return 1;
    }
    const apiKey = env.ANTHROPIC_API_KEY || null;
    const model = typeof flags.model === 'string' ? flags.model : DEFAULT_MODEL;
    const limit = flags.limit === undefined ? DEFAULT_LIMIT : Number(flags.limit);
    if (!Number.isInteger(limit) || limit < 1) {
        logError(`--limit must be a positive integer, got ${flags.limit}`);
        return 1;
    }
    if (limit > LARGE_LIMIT && !flags['allow-large']) {
        logError(`--limit=${limit} is above ${LARGE_LIMIT}; pass --allow-large only with the owner's approval`);
        return 1;
    }
    if (run && !apiKey) {
        logError(`ANTHROPIC_API_KEY is not set in ${join(REPO, '.env')} — the change judge needs an Anthropic API key `
            + 'to submit a batch. Add ANTHROPIC_API_KEY=... to that file (it is read from there only, never from argv).');
        return 1;
    }

    const llm = await loadLlmCost(env);
    const rateInfo = llm.ratesFor(model); // throws on an unpriced model: no guessed prices
    const rate = { input: rateInfo.input, output: rateInfo.output };
    log(`${run ? 'RUN' : 'DRY RUN'} · db ${describeUrl(dbUrl)} · model ${model} (${rateInfo.source}: $${rate.input}/$${rate.output} `
        + `per MTok online, half in a batch) · prompt ${PROMPT_VERSION} · effort ${EFFORT} · llm-cost ${llm.dir}`);

    const client = apiKey ? createAnthropicClient({ apiKey }) : null;

    if (run) {
        await psql(dbUrl, await readFile(DDL_FILE, 'utf8'), 'ddl change_judgment');
        const open = (await readCheckpoints()).filter((cp) => !cp.done);
        if (open.length && !flags.direct) {
            const cp = open[0];
            log(`resuming batch ${cp.batchId} submitted ${cp.submittedAt} (${Object.keys(cp.pending).length} item(s)); `
                + 'no new batch is submitted until it is collected');
            const totals = await collect({ client, llm, cp, dbUrl });
            return totals.error ? 1 : 0;
        }
    }

    const events = await loadEvents(dbUrl);
    const judgedKeys = await loadJudgedKeys(dbUrl, model);
    const candidates = selectCandidates(events, { judgedKeys });
    log(`${events.length} ${JUDGED_KINDS.join('/')} event(s) · ${judgedKeys.size} change(s) already judged by ${model}/${PROMPT_VERSION} · `
        + `${candidates.length} candidate change(s)`);
    if (!candidates.length) return 0;

    const sources = await loadSources(dbUrl, [...new Set(candidates.filter((c) => c.url).map((c) => sourceId(c.url)))]);
    const prepared = [];
    for (const c of candidates) prepared.push(await prepare(c, c.url ? sources.get(sourceId(c.url)) : null));

    const batchItems = prepared.slice(0, limit);
    const countedBy = client ? 'count-tokens endpoint' : 'ESTIMATE: characters / 4 (no ANTHROPIC_API_KEY in .env)';
    const batchEst = await estimate(batchItems, { model, rate, client });
    const allEst = client ? [...batchEst, ...(await estimate(prepared.slice(limit), { model, rate, client: null }))]
        : await estimate(prepared, { model, rate, client: null });

    if (!run) {
        log('candidates (newest first; * = in the next batch):');
        prepared.forEach((p, i) => {
            const c = p.candidate;
            const covers = c.eventIds.length > 1 ? ` covers ${c.eventIds.join(',')}` : '';
            console.log(`  ${i < limit ? '*' : ' '} ${String(i + 1).padStart(3)}. event ${c.eventId} ${c.kind.padEnd(13)} ${c.detectedAt} `
                + `${p.change.origin.padEnd(15)} ${p.prompt.truncated ? 'TRUNCATED ' : ''}${c.url ?? ''}${covers}`);
        });
        const first = batchItems[0];
        console.log(`\n----- system prompt (every item) -----\n${first.prompt.system}`);
        console.log(`\n----- user prompt for event ${first.candidate.eventId} -----\n${first.prompt.user}\n----- end -----\n`);
    }

    log(`cost estimate — input tokens by ${countedBy}; output assumed ${EST_OUTPUT_TOKENS} tok/item `
        + `(ceiling ${MAX_TOKENS}); batch rates $${rate.input / 2}/$${rate.output / 2} per MTok:`);
    for (const r of batchEst) {
        console.log(`    event ${String(r.item.candidate.eventId).padStart(4)} · in ${String(r.inputTokens).padStart(6)} tok · `
            + `est ${usd(r.usd)} · ceiling ${usd(r.ceilingUsd)}`);
    }
    log(`next batch (${batchEst.length} item(s)): input ${sum(batchEst, 'inputTokens')} tok · est ${usd(sum(batchEst, 'usd'))} · ceiling ${usd(sum(batchEst, 'ceilingUsd'))}`);
    log(`all ${allEst.length} candidate(s): input ${sum(allEst, 'inputTokens')} tok · est ${usd(sum(allEst, 'usd'))} · ceiling ${usd(sum(allEst, 'ceilingUsd'))}`);

    if (!run) {
        log('dry run: nothing submitted, nothing written. Submit the batch above with --run.');
        return 0;
    }

    if (flags.direct) return judgeDirect({ client, llm, dbUrl, model, items: batchItems });

    const requests = batchItems.map((p) => batchRequest(p.candidate, p.prompt, { model, maxTokens: MAX_TOKENS, effort: EFFORT }));
    const batchId = await llm.submitBatch({ client, provider: 'anthropic', requests });
    const pending = {};
    for (const p of batchItems) {
        const { event, ...candidate } = p.candidate;
        pending[customIdFor(p.candidate)] = { candidate: { ...candidate, event: { id: event.id, kind: event.kind } }, changeText: p.prompt.changeText };
    }
    const cp = { batchId, model, promptVersion: PROMPT_VERSION, submittedAt: ts(), pending, collected: [], done: false };
    await writeCheckpoint(cp);
    log(`batch ${batchId} submitted: ${requests.length} item(s), est ${usd(sum(batchEst, 'usd'))}; checkpoint written`);
    const totals = await collect({ client, llm, cp, dbUrl });
    // An errored item is not a judgment: the run does not report success while any exists.
    return totals.error ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
    logError(err.stack || err.message);
    process.exitCode = 1;
});
