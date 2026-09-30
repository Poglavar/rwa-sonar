#!/usr/bin/env node
// Runs the change judge's exported prompts (stocks/judge-changes.mjs --export) through the Claude
// CLI (`claude -p`, the owner's subscription, not the API key) and writes one answer per line for
// `judge-changes.mjs --import`. Meant for a machine that has the CLI logged in (the laptop); the
// server keeps the database and the document texts, so only prompts and answers travel.
// Resumable: an answer already in the output file is not asked again.

import { spawn } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { JUDGMENT_SCHEMA } from './lib/change-judge.mjs';
import { log, logError, logWarn, parseArgs } from './lib/io.mjs';

const REPO = join(import.meta.dirname, '..');
const DEFAULT_MODEL = 'claude-opus-5-5';
const DEFAULT_EFFORT = 'high';
const DEFAULT_WORKERS = 3;
/** A high-effort answer has taken up to a minute; five is a hung child, not a slow one. */
const CALL_TIMEOUT_MS = 5 * 60_000;

function usage() {
    console.log(`judge-with-cli.mjs — judge exported change prompts with the Claude CLI

USAGE
  node stocks/judge-with-cli.mjs --run --in=PROMPTS.jsonl --out=ANSWERS.jsonl [options]

  --run            Ask the model (without it this help is printed and nothing runs).
  --in=FILE        Prompts from \`node stocks/judge-changes.mjs --export=FILE\` (run where the DB is).
  --out=FILE       Answers, one JSON line each; appended, so a rerun resumes. Store them with
                   \`node stocks/judge-changes.mjs --import=FILE\`.
  --model=ID       default ${DEFAULT_MODEL}.
  --effort=LEVEL   default ${DEFAULT_EFFORT}.
  --workers=N      parallel CLI calls (default ${DEFAULT_WORKERS}).
  --limit=N        stop after N new answers.

Billing: the CLI runs on the logged-in subscription (ANTHROPIC_API_KEY is removed from its
environment). Each call is ledgered with llm-cost recordSubscriptionRun: cost 0, with the CLI's
own API-equivalent value kept separately.`);
}

function readJsonLines(text) {
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** One `claude -p` call; resolves with the CLI's JSON envelope. The prompt goes in on stdin. */
function askCli({ system, user, model, effort }) {
    return new Promise((resolve, reject) => {
        const env = { ...process.env };
        delete env.ANTHROPIC_API_KEY;
        const child = spawn('claude', ['-p', '--model', model, '--effort', effort, '--output-format', 'json',
            '--tools', '', '--system-prompt', system, '--json-schema', JSON.stringify(JUDGMENT_SCHEMA)],
        { env, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        const timer = setTimeout(() => { child.kill('SIGTERM'); }, CALL_TIMEOUT_MS);
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', (e) => { clearTimeout(timer); reject(new Error(`cannot run claude: ${e.message}`)); });
        child.on('close', (code) => {
            clearTimeout(timer);
            try {
                const envelope = JSON.parse(out);
                if (envelope.is_error) return reject(new Error(`claude: ${envelope.subtype ?? 'error'} ${envelope.result ?? ''}`.trim()));
                return resolve(envelope);
            } catch {
                return reject(new Error(`claude exited ${code}: ${(err || out).trim().slice(0, 400)}`));
            }
        });
        child.stdin.end(user);
    });
}

async function loadLedger() {
    const dir = process.env.LLM_COST_LIB || join(REPO, '..', 'agents', 'lib', 'llm-cost');
    const file = join(dir, 'index.mjs');
    if (!existsSync(file)) {
        logWarn(`llm-cost not found at ${dir}: calls are not ledgered`);
        return null;
    }
    return import(pathToFileURL(file).href);
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (!flags.run || flags.help || typeof flags.in !== 'string' || typeof flags.out !== 'string') {
        usage();
        return flags.run ? 1 : 0;
    }
    const model = typeof flags.model === 'string' ? flags.model : DEFAULT_MODEL;
    const effort = typeof flags.effort === 'string' ? flags.effort : DEFAULT_EFFORT;
    const workers = Math.max(1, Number(flags.workers) || DEFAULT_WORKERS);
    const prompts = readJsonLines(await readFile(flags.in, 'utf8'));
    const done = new Set(existsSync(flags.out)
        ? readJsonLines(await readFile(flags.out, 'utf8')).filter((a) => !a.error).map((a) => a.customId) : []);
    let todo = prompts.filter((p) => !done.has(p.customId));
    if (flags.limit !== undefined) todo = todo.slice(0, Number(flags.limit));
    log(`judge-with-cli: ${prompts.length} prompt(s), ${done.size} already answered (skipped), ${todo.length} to ask · ${model} · effort ${effort} · ${workers} worker(s)`);
    const ledger = await loadLedger();

    const started = Date.now();
    const totals = { ok: 0, error: 0, equivalentUsd: 0 };
    let next = 0;
    async function worker() {
        while (next < todo.length) {
            const p = todo[next];
            next += 1;
            const t0 = Date.now();
            let answer;
            try {
                const envelope = await askCli({ system: p.system, user: p.user, model, effort });
                const text = envelope.structured_output ? JSON.stringify(envelope.structured_output) : String(envelope.result ?? '');
                const usageRow = {
                    input_tokens: envelope.usage?.input_tokens ?? 0,
                    output_tokens: envelope.usage?.output_tokens ?? 0,
                    cache_read_input_tokens: envelope.usage?.cache_read_input_tokens ?? 0,
                    cache_creation_input_tokens: envelope.usage?.cache_creation_input_tokens ?? 0
                };
                answer = { customId: p.customId, promptVersion: p.promptVersion, candidate: p.candidate, changeText: p.changeText,
                    model, effort, text, usage: usageRow, equivalentUsd: envelope.total_cost_usd ?? null, durationMs: Date.now() - t0 };
                ledger?.recordSubscriptionRun({ repo: 'rwa-sonar', script: 'stocks/judge-with-cli.mjs', model, usage: usageRow,
                    equivalentUsd: envelope.total_cost_usd, meta: { customId: p.customId, effort, promptVersion: p.promptVersion } });
                totals.ok += 1;
                totals.equivalentUsd += envelope.total_cost_usd ?? 0;
            } catch (err) {
                answer = { customId: p.customId, promptVersion: p.promptVersion, candidate: p.candidate, changeText: p.changeText,
                    model, effort, error: err.message };
                totals.error += 1;
                logWarn(`${p.customId}: ${err.message}`);
            }
            await appendFile(flags.out, `${JSON.stringify(answer)}\n`);
            const k = totals.ok + totals.error;
            const eta = Math.round(((Date.now() - started) / k) * (todo.length - k) / 1000);
            log(`${k}/${todo.length} · ${p.customId} ${answer.error ? 'ERROR' : 'ok'} in ${((Date.now() - t0) / 1000).toFixed(1)} s`
                + ` · equivalent $${totals.equivalentUsd.toFixed(2)} so far · ETA ${Math.floor(eta / 60)}m${String(eta % 60).padStart(2, '0')}s`);
        }
    }
    await Promise.all(Array.from({ length: Math.min(workers, todo.length) }, worker));
    log(`judge-with-cli: ${totals.ok} answered, ${totals.error} failed (rerun to retry them) · subscription, API-equivalent $${totals.equivalentUsd.toFixed(2)}`);
    return totals.error ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
    logError(err.stack || err.message);
    process.exitCode = 1;
});
