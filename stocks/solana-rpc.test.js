import { jest } from '@jest/globals';
import { accountBatchSize, fetchMintAccounts, getAccountsWithContext } from './lib/solana-rpc.mjs';

describe('provider-specific getMultipleAccounts limits', () => {
    test('defaults to 100 and validates configured caps against the protocol maximum', () => {
        expect(accountBatchSize()).toBe(100);
        expect(accountBatchSize('5')).toBe(5);
        expect(() => accountBatchSize('0')).toThrow('integer from 1 to 100');
        expect(() => accountBatchSize('101')).toThrow('integer from 1 to 100');
    });

    test('a five-account cap keeps request order and each response context slot per batch', async () => {
        const requests = [];
        let slot = 700;
        const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
            const body = JSON.parse(options.body);
            const [pubkeys] = body.params;
            requests.push(pubkeys);
            return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {
                context: { slot: slot++ },
                value: pubkeys.map((pubkey) => ({ pubkey }))
            } }), { status: 200, headers: { 'content-type': 'application/json' } });
        });
        const seen = [];
        const mints = Array.from({ length: 11 }, (_, i) => `mint-${i + 1}`);
        try {
            const result = await fetchMintAccounts(mints, {
                rpc: 'https://rpc.invalid',
                batchSize: accountBatchSize('5'),
                paceMs: 0,
                onBatch: (batch, meta) => seen.push({ mints: batch.map(({ mint }) => mint), slot: meta.slot })
            });
            expect(requests.map((batch) => batch.length)).toEqual([5, 5, 1]);
            expect(requests.flat()).toEqual(mints);
            expect(seen).toEqual([
                { mints: mints.slice(0, 5), slot: 700 },
                { mints: mints.slice(5, 10), slot: 701 },
                { mints: mints.slice(10), slot: 702 }
            ]);
            expect(result.map(({ mint }) => mint)).toEqual(mints);
        } finally {
            fetchMock.mockRestore();
        }
    });

    test('rejects an oversized request when the configured provider cap is lower than 100', async () => {
        await expect(getAccountsWithContext(Array(6).fill('key'), {
            rpc: 'http://127.0.0.1:1', maxAccounts: 5
        })).rejects.toThrow('takes at most 5 pubkeys');
    });
});
