// Reads mint accounts from a public Solana RPC with getMultipleAccounts (max 100 pubkeys per
// request), paced politely and with exponential backoff on 429. Yields jsonParsed accounts so
// classify.summarizeExtensions() can flatten the Token-2022 extensions.

import { fetchJson, log, logWarn, sleep } from './io.mjs';

export const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
export const MAX_ACCOUNTS_PER_REQUEST = 100;
export const BACKOFF_MS = [1000, 2000, 4000];

export function chunk(items, size = MAX_ACCOUNTS_PER_REQUEST) {
    if (size < 1) throw new Error(`chunk size must be >= 1, got ${size}`);
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

/**
 * One getMultipleAccounts call with retries on 429 / 5xx. Throws loudly once the backoff
 * ladder is exhausted or the RPC returns a JSON-RPC error — a silent gap here would look
 * exactly like a mint with no extensions.
 */
export async function getMultipleAccounts(pubkeys, { rpc = DEFAULT_RPC, timeoutMs = 60000 } = {}) {
    if (pubkeys.length > MAX_ACCOUNTS_PER_REQUEST) {
        throw new Error(`getMultipleAccounts takes at most ${MAX_ACCOUNTS_PER_REQUEST} pubkeys, got ${pubkeys.length}`);
    }
    const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getMultipleAccounts',
        params: [pubkeys, { encoding: 'jsonParsed' }]
    });

    for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt += 1) {
        const res = await fetchJson(rpc, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            timeoutMs
        });

        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < BACKOFF_MS.length) {
            const wait = BACKOFF_MS[attempt];
            logWarn(`RPC HTTP ${res.status}; backing off ${wait} ms (attempt ${attempt + 1}/${BACKOFF_MS.length})`);
            await sleep(wait);
            continue;
        }
        if (!res.ok) {
            throw new Error(`RPC HTTP ${res.status} after ${attempt} retries: ${res.bodyPreview}`);
        }
        if (res.json === null) {
            throw new Error(`RPC returned unparseable body: ${res.parseError} :: ${res.bodyPreview}`);
        }
        if (res.json.error) {
            throw new Error(`RPC error ${res.json.error.code}: ${res.json.error.message}`);
        }
        const value = res.json.result?.value;
        if (!Array.isArray(value)) {
            throw new Error(`RPC result.value was not an array: ${res.bodyPreview}`);
        }
        if (value.length !== pubkeys.length) {
            throw new Error(`RPC returned ${value.length} accounts for ${pubkeys.length} pubkeys`);
        }
        return value;
    }
    throw new Error('unreachable: backoff ladder exhausted without a verdict');
}

/**
 * Fetch every mint in batches, calling `onBatch(results, meta)` after each one so the caller
 * can checkpoint. `results` entries are `{ mint, account }`; a missing account is null.
 */
export async function fetchMintAccounts(mints, { rpc = DEFAULT_RPC, batchSize = MAX_ACCOUNTS_PER_REQUEST, paceMs = 400, onBatch = null } = {}) {
    const batches = chunk(mints, batchSize);
    const all = [];
    for (let i = 0; i < batches.length; i += 1) {
        const batch = batches[i];
        const accounts = await getMultipleAccounts(batch, { rpc });
        const results = batch.map((mint, idx) => ({ mint, account: accounts[idx] ?? null }));
        const missing = results.filter((r) => r.account === null).length;
        log(`RPC batch ${i + 1}/${batches.length}: ${batch.length} mints, ${missing} account(s) not found`);
        all.push(...results);
        if (onBatch) await onBatch(results, { index: i, total: batches.length });
        if (i < batches.length - 1 && paceMs > 0) await sleep(paceMs);
    }
    return all;
}
