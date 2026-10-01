import { jest } from '@jest/globals';
import monitor from '../rwa/lib/monitor.js';
import { observeEthereum, observeSolana, SLOTS } from '../rwa/lib/chain-observer.mjs';

const at = '2026-10-01T00:00:00Z';
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;

describe('deployment observer RPC reads', () => {
    test('pins every Ethereum state read to one finalized block hash', async () => {
        const hash = `0x${'ab'.repeat(32)}`;
        const block = { hash, number: '0x10', timestamp: '0x6553f100' };
        const rpc = jest.fn(async (method) => {
            if (method === 'eth_chainId') return '0x1';
            if (method === 'eth_getBlockByNumber') return block;
            if (method === 'eth_getCode') return '0x6000';
            if (method === 'eth_getStorageAt') return word(0);
            if (method === 'eth_call') return word(0);
            throw new Error(`unexpected RPC method ${method}`);
        });
        const result = await observeEthereum({ address: '0x' + '12'.repeat(20) }, rpc);
        const pinned = { blockHash: hash, requireCanonical: true };
        const stateReads = rpc.mock.calls.filter(([method]) => ['eth_getCode', 'eth_getStorageAt', 'eth_call'].includes(method));
        expect(stateReads).toHaveLength(11);
        for (const [method, params] of stateReads) {
            expect(method === 'eth_getStorageAt' ? params[2] : params[1]).toEqual(pinned);
        }
        expect(result).toMatchObject({ blockNumber: '16', blockHash: hash, blockTimestamp: '2023-11-14T22:13:20.000Z' });
        expect(result.fields.eip1967Implementation).toEqual({ state: 'observed', value: null });
    });

    test('a null or malformed EVM read remains unknown rather than becoming zero', async () => {
        const hash = `0x${'cd'.repeat(32)}`;
        const rpc = jest.fn(async (method, params) => {
            if (method === 'eth_chainId') return '0x1';
            if (method === 'eth_getBlockByNumber') return { hash, number: '0x20', timestamp: '0x6553f100' };
            if (method === 'eth_getCode') return '0x6000';
            if (method === 'eth_getStorageAt' && params[1] === SLOTS.eip1967Implementation) return null;
            if (method === 'eth_getStorageAt') return word(0);
            if (method === 'eth_call' && params[0].data === '0x8da5cb5b') return '0x1234';
            if (method === 'eth_call') return word(0);
            throw new Error(`unexpected RPC method ${method}`);
        });
        const result = await observeEthereum({ address: '0x' + '34'.repeat(20) }, rpc);
        expect(result.fields.eip1967Implementation).toMatchObject({ state: 'unknown', value: null });
        expect(result.fields.owner).toMatchObject({ state: 'unknown', value: null });
        expect(result.fields.paused).toEqual({ state: 'observed', value: false });
    });

    test('Solana observer pins the mint read to a finalized slot and preserves unavailable block time', async () => {
        const slot = 123456;
        const address = 'Mint111111111111111111111111111111111111111';
        const rpc = jest.fn(async (method, params) => {
            if (method === 'getMultipleAccounts') return { context: { slot }, value: [{ owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { type: 'mint', info: { supply: '0', decimals: 6, mintAuthority: null, freezeAuthority: null, extensions: [] } } } }] };
            if (method === 'getBlockTime') return null;
            throw new Error(`unexpected RPC method ${method}`);
        });
        const result = await observeSolana({ address }, rpc);
        expect(rpc.mock.calls[0]).toEqual(['getMultipleAccounts', [[address], { encoding: 'jsonParsed', commitment: 'finalized' }]]);
        expect(rpc.mock.calls[1]).toEqual(['getBlockTime', [slot]]);
        expect(result).toMatchObject({ network: 'Solana', slot, blockTimestamp: null });
        expect(result.fields.supplyRaw).toEqual({ state: 'observed', value: '0' });
        expect(result.fields.mintAuthority).toEqual({ state: 'observed', value: null });
        expect(result.fields.decimals).toEqual({ state: 'observed', value: '6' });
    });

    test('malformed Solana supply fails the observation instead of producing a zero value', async () => {
        const rpc = async (method) => method === 'getMultipleAccounts'
            ? { context: { slot: 22 }, value: [{ owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { type: 'mint', info: { supply: null, decimals: 6 } } } }] }
            : null;
        await expect(observeSolana({ address: 'Mint111111111111111111111111111111111111111' }, rpc)).rejects.toThrow('Malformed mint supply/decimals');
    });
});

describe('monitor coverage and material changes', () => {
    test('a failed latest read preserves the last successful observation and timestamp', () => {
        const success = monitor.recordAttempt(null, { ok: true, observation: { fields: { paused: { state: 'observed', value: false } } } }, { now: at, cadenceSeconds: 3600 });
        const failed = monitor.recordAttempt(success, { ok: false, error: 'malformed RPC result' }, { now: '2026-10-01T00:05:00Z', cadenceSeconds: 3600 });
        expect(failed).toMatchObject({ lastAttemptStatus: 'failed', lastError: 'malformed RPC result', lastSuccessAt: at, observation: success.observation });
        expect(monitor.coverage({}, failed, Date.parse('2026-10-01T00:05:00Z'))).toBe('failed-latest-check');
    });

    test('successful coverage becomes stale after two polling intervals', () => {
        const record = { configured: true, cadenceSeconds: 3600, lastSuccessAt: at, lastAttemptStatus: 'successful' };
        expect(monitor.coverage({}, record, Date.parse('2026-10-01T01:59:59Z'))).toBe('recent-observation');
        expect(monitor.coverage({}, record, Date.parse('2026-10-01T02:00:01Z'))).toBe('stale');
    });

    test('only changed fields observed successfully on both reads count as material controls', () => {
        const previous = { decoderVersion: 1, fields: {
            owner: { state: 'observed', value: '0xold' }, paused: { state: 'observed', value: false },
            supply: { state: 'observed', value: '10' }, supplyRaw: { state: 'observed', value: '10' }, decimals: { state: 'observed', value: '6' },
            removedField: { state: 'observed', value: true }, unavailable: { state: 'unknown', value: null }
        } };
        const next = { decoderVersion: 1, fields: {
            owner: { state: 'observed', value: '0xnew' }, paused: { state: 'unknown', value: null },
            supply: { state: 'observed', value: '11' }, supplyRaw: { state: 'observed', value: '11' }, decimals: { state: 'observed', value: '9' },
            newField: { state: 'observed', value: true }, unavailable: { state: 'observed', value: false }
        } };
        expect(monitor.materialChanges(previous, next)).toEqual([{ field: 'owner', before: '0xold', after: '0xnew' }]);
    });

    test('a decoder revision establishes a new baseline without public control-change events', () => {
        const oldRead = { decoderVersion: 1, fields: { owner: { state: 'observed', value: '0xold' } } };
        const revisedRead = { decoderVersion: 2, fields: { owner: { state: 'observed', value: '0xnew' } } };
        expect(monitor.materialChanges(oldRead, revisedRead)).toEqual([]);
    });
});
