// The Anthropic REST client retries idempotent reads on network errors, 429 and 5xx, and never
// retries a POST (a batch create sent twice would be paid for twice).
import { createAnthropicClient } from './lib/anthropic-rest.mjs';

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
