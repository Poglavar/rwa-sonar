// The Anthropic REST client retries idempotent reads on network errors, 429 and 5xx, and never
// retries a POST (a batch create sent twice would be paid for twice); and it is a client the shared
// LLM layer (agents/lib/llm-cost/llm.mjs createLlm) drives end to end over HTTP — the wire requests
// carry the layer's default model and effort, online calls go out as plain messages.create, and a
// batch's JSONL results come back priced.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAnthropicClient } from './lib/anthropic-rest.mjs';
import { JUDGMENT_SCHEMA, judgeRequest } from './lib/change-judge.mjs';

function fakeFetch(script) {
    const calls = [];
    const impl = async (url, init) => {
        calls.push(init.method);
        const step = script.shift();
        if (step instanceof Error) throw step;
        return { ok: step.status < 400, status: step.status, text: async () => JSON.stringify(step.body ?? {}) };
    };
    return { impl, calls };
}

const noSleep = async () => {};

describe('anthropic-rest retries', () => {
    test('a GET survives a dropped connection and a 503', async () => {
        const f = fakeFetch([new TypeError('fetch failed'), { status: 503 }, { status: 200, body: { processing_status: 'ended' } }]);
        const client = createAnthropicClient({ apiKey: 'k', fetchImpl: f.impl, sleep: noSleep });
        const out = await client.messages.batches.retrieve('msgbatch_x');
        expect(out.processing_status).toBe('ended');
        expect(f.calls).toEqual(['GET', 'GET', 'GET']);
    });

    test('a GET gives up after the retry budget', async () => {
        const f = fakeFetch([new TypeError('fetch failed'), new TypeError('fetch failed'), new TypeError('fetch failed'), new TypeError('fetch failed')]);
        const client = createAnthropicClient({ apiKey: 'k', fetchImpl: f.impl, sleep: noSleep });
        await expect(client.messages.batches.retrieve('msgbatch_x')).rejects.toThrow(/fetch failed/);
        expect(f.calls).toHaveLength(4);
    });

    test('a POST is never retried', async () => {
        const f = fakeFetch([new TypeError('fetch failed'), { status: 200, body: { id: 'msgbatch_y' } }]);
        const client = createAnthropicClient({ apiKey: 'k', fetchImpl: f.impl, sleep: noSleep });
        await expect(client.messages.batches.create({ requests: [] })).rejects.toThrow(/fetch failed/);
        expect(f.calls).toEqual(['POST']);
    });
});

describe('anthropic-rest under the shared LLM layer', () => {
    let ledgerDir;
    let llmLib;
    let costLib;

    beforeAll(async () => {
        // index.cjs reads LLM_COST_DIR at load time: point it at a temp dir before the import.
        ledgerDir = mkdtempSync(join(tmpdir(), 'anthropic-rest-ledger-'));
        process.env.LLM_COST_DIR = ledgerDir;
        llmLib = await import(new URL('../../agents/lib/llm-cost/llm.mjs', import.meta.url).href);
        costLib = await import(new URL('../../agents/lib/llm-cost/index.mjs', import.meta.url).href);
    });
    afterAll(() => rmSync(ledgerDir, { recursive: true, force: true }));

    const usage = { input_tokens: 3000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const answer = { material: false, severity: 'info', affects: ['cosmetic'], summary: 'Nothing changed for holders.', quotedChange: [], confidence: 0.9 };
    const prompt = { system: 'SYS', user: 'USER' };

    /** Routes by method + path; records every request with its parsed JSON body and headers. */
    function router(routes) {
        const calls = [];
        const impl = async (url, init) => {
            const { pathname } = new URL(url);
            const call = { method: init.method, path: pathname, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
            calls.push(call);
            const handler = routes[`${init.method} ${pathname}`];
            if (!handler) return { ok: false, status: 404, text: async () => '{"error":{"message":"no route"}}' };
            const out = handler(call);
            const text = typeof out === 'string' ? out : JSON.stringify(out);
            return { ok: true, status: 200, text: async () => text };
        };
        return { impl, calls };
    }

    test('the layer recognises it as an Anthropic client', () => {
        expect(llmLib.providerOf(createAnthropicClient({ apiKey: 'k' }))).toBe('anthropic');
    });

    test('a batch goes out at the default model and effort and comes back priced and ledgered', async () => {
        const defaults = llmLib.DEFAULTS.providers.anthropic;
        const message = { model: defaults.model, stop_reason: 'end_turn', usage, content: [{ type: 'text', text: JSON.stringify(answer) }] };
        const f = router({
            'POST /v1/messages/batches': () => ({ id: 'msgbatch_rest' }),
            'GET /v1/messages/batches/msgbatch_rest': () => ({ processing_status: 'ended', request_counts: { succeeded: 1 },
                results_url: 'https://api.anthropic.com/v1/messages/batches/msgbatch_rest/results' }),
            'GET /v1/messages/batches/msgbatch_rest/results': () => `${JSON.stringify({ custom_id: 'evt-1', result: { type: 'succeeded', message } })}\n`
        });
        const llm = llmLib.createLlm({ client: createAnthropicClient({ apiKey: 'k', fetchImpl: f.impl, sleep: noSleep }), repo: 'rwa-sonar', script: 'judge-changes' });
        expect(llm.model).toBe(defaults.model);

        const batchId = await llm.submitBatch([llm.batchRequest('evt-1', judgeRequest(prompt))]);
        expect(batchId).toBe('msgbatch_rest');
        const sent = f.calls.find((c) => c.path === '/v1/messages/batches').body.requests[0];
        expect(sent.custom_id).toBe('evt-1');
        expect(sent.params).toMatchObject({
            model: defaults.model, max_tokens: llmLib.DEFAULT_MAX_TOKENS, system: 'SYS',
            messages: [{ role: 'user', content: [{ type: 'text', text: 'USER' }] }],
            output_config: { effort: defaults.effort, format: { type: 'json_schema', schema: JUDGMENT_SCHEMA } }
        });
        // Opus 5.5 rejects these, and thinking is always adaptive; the batch API rejects fallbacks.
        for (const k of ['thinking', 'temperature', 'top_p', 'tool_choice', 'fallbacks', 'betas']) expect(sent.params).not.toHaveProperty(k);

        expect((await llm.pollBatch(batchId)).done).toBe(true);
        const items = [];
        for await (const item of llm.collectBatch(batchId, { schema: JUDGMENT_SCHEMA })) items.push(item);
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ customId: 'evt-1', data: answer, model: defaults.model, stopReason: 'end_turn' });
        expect(items[0].costUsd).toBeCloseTo(costLib.computeCost(defaults.model, usage, { batch: true }), 12);
        const ledger = readFileSync(join(ledgerDir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        expect(ledger.find((r) => r.batchId === 'msgbatch_rest')).toMatchObject({ model: defaults.model, batch: true, customId: 'evt-1' });
    });

    test('an online call is a plain non-streaming POST /v1/messages at full price', async () => {
        const defaults = llmLib.DEFAULTS.providers.anthropic;
        const f = router({
            'POST /v1/messages': () => ({ model: defaults.model, stop_reason: 'end_turn', usage, content: [{ type: 'text', text: JSON.stringify(answer) }] })
        });
        const llm = llmLib.createLlm({ client: createAnthropicClient({ apiKey: 'k', fetchImpl: f.impl, sleep: noSleep }), repo: 'rwa-sonar', script: 'judge-changes' });
        const out = await llm.complete({ ...judgeRequest(prompt), meta: { customId: 'evt-2', mode: 'direct' } });
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0].path).toBe('/v1/messages');
        expect(f.calls[0].headers).not.toHaveProperty('anthropic-beta');
        expect(f.calls[0].body.model).toBe(defaults.model);
        expect(f.calls[0].body).not.toHaveProperty('stream');
        expect(f.calls[0].body).not.toHaveProperty('fallbacks');
        expect(out.data).toEqual(answer);
        expect(out.costUsd).toBeCloseTo(costLib.computeCost(defaults.model, usage), 12);
    });

    test('an online refusal throws LlmOutputError carrying what it cost', async () => {
        const defaults = llmLib.DEFAULTS.providers.anthropic;
        const f = router({ 'POST /v1/messages': () => ({ model: defaults.model, stop_reason: 'refusal', usage, content: [] }) });
        const llm = llmLib.createLlm({ client: createAnthropicClient({ apiKey: 'k', fetchImpl: f.impl, sleep: noSleep }), repo: 'rwa-sonar', script: 'judge-changes' });
        const err = await llm.complete(judgeRequest(prompt)).catch((e) => e);
        expect(err.name).toBe('LlmOutputError');
        expect(err.reason).toBe('refusal');
        expect(err.costUsd).toBeGreaterThan(0);
    });
});
