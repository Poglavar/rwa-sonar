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

/**
 * Waits between retries of a READ. A poller running for hours will meet a dropped connection
 * (one killed the first batch's poller after 2h54m on 2026-09-23); a GET is idempotent, so it is
 * retried on a network error, 429 or 5xx. A POST is never retried here: re-sending a batch create
 * would submit, and pay for, the same work twice.
 */
export const READ_RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

function retryableStatus(status) {
    return status === 429 || (status >= 500 && status <= 599);
}

export function createAnthropicClient({ apiKey, baseUrl = API, fetchImpl = globalThis.fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retryDelaysMs = READ_RETRY_DELAYS_MS } = {}) {
    if (typeof apiKey !== 'string' || apiKey === '') throw new Error('createAnthropicClient needs an apiKey');
    const headers = { 'x-api-key': apiKey, 'anthropic-version': VERSION, 'content-type': 'application/json' };

    /** fetch with retries for GETs only; returns the Response of the last attempt. */
    async function send(method, url, init) {
        const delays = method === 'GET' ? retryDelaysMs : [];
        for (let attempt = 0; ; attempt += 1) {
            try {
                const res = await fetchImpl(url, init);
                if (!retryableStatus(res.status) || attempt >= delays.length) return res;
            } catch (err) {
                if (attempt >= delays.length) throw err;
            }
            await sleep(delays[attempt]);
        }
    }

    async function call(method, path, body) {
        const res = await send(method, `${baseUrl}${path}`, {
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
        const res = await send('GET', url, { method: 'GET', headers });
        const text = await res.text();
        if (!res.ok) throw apiError('GET', new URL(url).pathname, res.status, text);
        for (const line of text.split('\n')) {
            if (line.trim() !== '') yield JSON.parse(line);
        }
    }

    return {
        messages: {
            // One online call, full price. Used only by the judge's --direct fallback for a batch
            // that the Batch API accepts but never processes.
            create: (params) => call('POST', '/v1/messages', params),
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
