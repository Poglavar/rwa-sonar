// Bounded read-only Ethereum/Solana observations; every RPC read is pinned to a chain block or slot.
import { createHash } from 'node:crypto';
import { summarizeExtensions } from '../../stocks/lib/classify.mjs';
const observed = (value) => ({ state: 'observed', value });
const unknown = (reason) => ({ state: 'unknown', value: null, reason });
const word = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
export function decodeWord(value, type) {
    if (!word(value)) throw new Error('Expected one ABI word');
    const n = BigInt(value);
    if (type === 'address') {
        if (value.slice(2, 26) !== '0'.repeat(24)) throw new Error('Invalid ABI address');
        return n === 0n ? null : '0x' + value.slice(-40).toLowerCase();
    }
    if (type === 'bool') { if (n > 1n) throw new Error('Invalid ABI boolean'); return n === 1n; }
    return n.toString();
}
export const SLOTS = {
    eip1967Implementation: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
    eip1967Admin: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
    eip1967Beacon: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
    legacyZeppelinImplementation: '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3',
    legacyZeppelinAdmin: '0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b'
};
export async function jsonRpc(endpoint, method, params) {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const body = await response.json();
    if (body.error || !Object.hasOwn(body, 'result')) throw new Error(`RPC ${body.error?.code || 'missing result'}: ${body.error?.message || method}`);
    return body.result;
}
export async function observeEthereum(deployment, rpc) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(deployment.address)) throw new Error('Invalid Ethereum address');
    if (await rpc('eth_chainId', []) !== '0x1') throw new Error('RPC is not Ethereum mainnet');
    const block = await rpc('eth_getBlockByNumber', ['finalized', false]);
    if (!block?.hash || !block.number || !block.timestamp) throw new Error('No finalized block');
    const tag = { blockHash: block.hash, requireCanonical: true };
    const code = await rpc('eth_getCode', [deployment.address, tag]);
    if (typeof code !== 'string' || !/^0x(?:[a-fA-F0-9]{2})+$/.test(code)) throw new Error('No contract code at finalized block');
    const fields = { codeSha256: observed(createHash('sha256').update(Buffer.from(code.slice(2), 'hex')).digest('hex')) };
    const read = async (key, method, params, type) => {
        try { fields[key] = observed(decodeWord(await rpc(method, params), type)); }
        catch (error) { fields[key] = unknown(error.message); }
    };
    for (const [key, slot] of Object.entries(SLOTS)) await read(key, 'eth_getStorageAt', [deployment.address, slot, tag], 'address');
    for (const [key, selector, type] of [['owner', '0x8da5cb5b', 'address'], ['authority', '0xbf7e214f', 'address'], ['paused', '0x5c975abb', 'bool'], ['supplyRaw', '0x18160ddd', 'uint'], ['decimals', '0x313ce567', 'uint']]) await read(key, 'eth_call', [{ to: deployment.address, data: selector }, tag], type);
    return { decoderVersion: 3, network: 'Ethereum', blockNumber: BigInt(block.number).toString(), blockHash: block.hash, blockTimestamp: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString(), fields,
        limitations: 'Observed code hash, conventional storage slots and read-only ABI responses. Empty conventional slots do not rule out other upgrade paths. Addresses do not establish key governance, legal powers or backing. SHA-256 code fingerprint is not Ethereum keccak.' };
}
export async function observeSolana(deployment, rpc) {
    const result = await rpc('getMultipleAccounts', [[deployment.address], { encoding: 'jsonParsed', commitment: 'finalized' }]);
    const account = result?.value?.[0], info = account?.data?.parsed?.info;
    const programmes = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
    if (!info || account.data.parsed.type !== 'mint' || !programmes.includes(account.owner) || !Number.isInteger(result.context?.slot)) throw new Error('RPC did not return a parsed SPL mint at a known slot');
    if (!/^\d+$/.test(info.supply) || !Number.isInteger(info.decimals)) throw new Error('Malformed mint supply/decimals');
    let blockTimestamp = null, blockSeconds = null, epoch = null;
    try { const time = await rpc('getBlockTime', [result.context.slot]); if (Number.isInteger(time)) { blockSeconds = time; blockTimestamp = new Date(time * 1000).toISOString(); } } catch { /* Block time can be unavailable for a valid slot-pinned mint read. */ }
    try {
        const schedule = await rpc('getEpochSchedule', []);
        if (Number.isInteger(schedule?.firstNormalSlot) && result.context.slot >= schedule.firstNormalSlot && Number.isInteger(schedule.firstNormalEpoch) && Number.isInteger(schedule.slotsPerEpoch) && schedule.slotsPerEpoch > 0) epoch = schedule.firstNormalEpoch + Math.floor((result.context.slot - schedule.firstNormalSlot) / schedule.slotsPerEpoch);
    } catch { /* A fee schedule without a verified epoch stays unknown. */ }
    const summary = summarizeExtensions(account, { nowSeconds: blockSeconds || 0, epoch });
    const fields = { tokenProgram: observed(account.owner), supplyRaw: observed(info.supply), decimals: observed(String(info.decimals)) };
    for (const key of ['mintAuthority', 'freezeAuthority']) fields[key] = Object.hasOwn(info, key) ? observed(info[key]) : unknown('RPC field missing');
    for (const [key, value] of Object.entries(summary)) if (key !== 'supply' && !Object.hasOwn(fields, key)) fields[key] = value === undefined || value === null ? unknown('Optional field not decoded or not applicable; see extensionNames') : observed(value);
    if (epoch === null && summary.transferFeeConfigured) for (const key of ['transferFeeBps', 'transferFeeCapped', 'transferFeeReadEpoch']) fields[key] = unknown('Slot epoch not established');
    if (blockSeconds === null && summary.extensionNames.includes('scaledUiAmountConfig')) fields.scaledUiAmountMultiplier = unknown('Slot timestamp not established');
    return { decoderVersion: 2, network: 'Solana', slot: result.context.slot, blockTimestamp, fields,
        limitations: 'Parsed finalized mint and Token-2022 extensions. No holder transactions, controller multisig thresholds, bridge backing or legal recovery procedure verified.' };
}
