// A dependency-free Anthropic REST client exposing exactly the surface the shared batch library
// (agents/lib/llm-cost/batch.cjs) drives — `messages.batches.create / retrieve / results / cancel`
// — plus `messages.countTokens` for the dry run. The stocks pipeline has zero npm dependencies by
// design, which is why this is raw HTTP (Messages Batches API, anthropic-version 2023-06-01) and not
// @anthropic-ai/sdk. The key is passed in by the caller from .env and is never logged.

const API = 'https://api.anthropic.com';
const VERSION = '2023-06-01';

/** An API error with the vendor's own words, and never the key. */
function apiError(method, path, status, body) {
    const message = body?.error?.message ?? (typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body)?.slice(0, 300));
    const err = new Error(`anthropic ${method} ${path} -> HTTP ${status}: ${message}`);
    err.status = status;
    return err;
}

export function createAnthropicClient({ apiKey, baseUrl = API, fetchImpl = globalThis.fetch } = {}) {
    if (typeof apiKey !== 'string' || apiKey === '') throw new Error('createAnthropicClient needs an apiKey');
    const headers = { 'x-api-key': apiKey, 'anthropic-version': VERSION, 'content-type': 'application/json' };

    async function call(method, path, body) {
        const res = await fetchImpl(`${baseUrl}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const text = await res.text();
        let parsed = text;
        try { parsed = JSON.parse(text); } catch { /* keep the raw text for the error message */ }
        if (!res.ok) throw apiError(method, path, res.status, parsed);
        return parsed;
    }

    async function* jsonl(url) {
        const res = await fetchImpl(url, { method: 'GET', headers });
        const text = await res.text();
        if (!res.ok) throw apiError('GET', new URL(url).pathname, res.status, text);
        for (const line of text.split('\n')) {
            if (line.trim() !== '') yield JSON.parse(line);
        }
    }

    return {
        messages: {
            countTokens: (params) => call('POST', '/v1/messages/count_tokens', params),
            batches: {
                create: ({ requests }) => call('POST', '/v1/messages/batches', { requests }),
                retrieve: (id) => call('GET', `/v1/messages/batches/${encodeURIComponent(id)}`),
                cancel: (id) => call('POST', `/v1/messages/batches/${encodeURIComponent(id)}/cancel`),
                // batch.cjs does `for await (const r of await client.messages.batches.results(id))`.
                results: async (id) => {
                    const info = await call('GET', `/v1/messages/batches/${encodeURIComponent(id)}`);
                    if (!info.results_url) throw new Error(`batch ${id} has no results_url (status ${info.processing_status})`);
                    return jsonl(info.results_url);
                }
            }
        }
    };
}
