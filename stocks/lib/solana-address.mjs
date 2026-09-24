// Pure Solana address arithmetic with no dependencies: base58, the ed25519 on-curve test that
// separates a wallet key from a program-derived address (PDA), and PDA derivation. The DeFi
// footprint scanner uses it to tell "a person's wallet holds this stock" from "a program holds it",
// and to derive a protocol's authority PDAs (e.g. a Kamino lending-market authority) from the
// market addresses its registry publishes, so a holding can be attributed without an RPC call.

import { createHash } from 'node:crypto';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((char, index) => [char, BigInt(index)]));

export function base58Decode(text) {
    if (typeof text !== 'string' || text === '') throw new Error('base58Decode: expected a non-empty string');
    let value = 0n;
    for (const char of text) {
        const digit = INDEX.get(char);
        if (digit === undefined) throw new Error(`base58Decode: invalid character ${JSON.stringify(char)}`);
        value = value * 58n + digit;
    }
    const bytes = [];
    while (value > 0n) {
        bytes.unshift(Number(value & 0xffn));
        value >>= 8n;
    }
    let zeros = 0;
    while (zeros < text.length && text[zeros] === '1') zeros += 1;
    return Buffer.from([...new Array(zeros).fill(0), ...bytes]);
}

export function base58Encode(bytes) {
    const buffer = Buffer.from(bytes);
    let value = 0n;
    for (const byte of buffer) value = (value << 8n) + BigInt(byte);
    let out = '';
    while (value > 0n) {
        out = ALPHABET[Number(value % 58n)] + out;
        value /= 58n;
    }
    for (const byte of buffer) {
        if (byte !== 0) break;
        out = `1${out}`;
    }
    return out;
}

/** 32-byte public key from a base58 address; throws on anything else. */
export function addressBytes(address) {
    const bytes = base58Decode(address);
    if (bytes.length !== 32) throw new Error(`not a 32-byte Solana address: ${address}`);
    return bytes;
}

// ed25519 field and curve constants (RFC 8032).
const P = 2n ** 255n - 19n;
const D = (-121665n * modInverse(121666n)) % P;

function mod(value) {
    const r = value % P;
    return r >= 0n ? r : r + P;
}

function modPow(base, exponent) {
    let result = 1n;
    let b = mod(base);
    let e = exponent;
    while (e > 0n) {
        if (e & 1n) result = (result * b) % P;
        b = (b * b) % P;
        e >>= 1n;
    }
    return result;
}

function modInverse(value) {
    return modPow(value, P - 2n);
}

/**
 * True when the 32 bytes decode to a point on the ed25519 curve — i.e. the address COULD have a
 * private key. PDAs are by construction off the curve. Follows RFC 8032 §5.1.3 decoding.
 */
export function isOnCurve(addressOrBytes) {
    const bytes = typeof addressOrBytes === 'string' ? addressBytes(addressOrBytes) : Buffer.from(addressOrBytes);
    if (bytes.length !== 32) return false;
    const copy = Buffer.from(bytes);
    const sign = copy[31] >> 7;
    copy[31] &= 0x7f;
    let y = 0n;
    for (let index = 31; index >= 0; index -= 1) y = (y << 8n) + BigInt(copy[index]);
    if (y >= P) return false;
    const y2 = mod(y * y);
    const u = mod(y2 - 1n);
    const v = mod(D * y2 + 1n);
    // x = u v^3 (u v^7)^((p-5)/8)
    const v3 = mod(v * v * v);
    let x = mod(u * v3 * modPow(u * v3 * v3 * v, (P - 5n) / 8n));
    const vx2 = mod(v * x * x);
    if (vx2 !== u) {
        if (vx2 === mod(-u)) x = mod(x * modPow(2n, (P - 1n) / 4n));
        else return false;
    }
    if (x === 0n && sign === 1) return false;
    return true;
}

const PDA_MARKER = Buffer.from('ProgramDerivedAddress');

function seedBytes(seed) {
    if (Buffer.isBuffer(seed) || seed instanceof Uint8Array) return Buffer.from(seed);
    if (typeof seed === 'string') return Buffer.from(seed, 'utf8');
    throw new Error('PDA seed must be bytes or a utf8 string');
}

export function createProgramAddress(seeds, programId) {
    const parts = seeds.map(seedBytes);
    if (parts.some((part) => part.length > 32)) throw new Error('PDA seed longer than 32 bytes');
    const hash = createHash('sha256').update(Buffer.concat([...parts, addressBytes(programId), PDA_MARKER])).digest();
    if (isOnCurve(hash)) return null;
    return base58Encode(hash);
}

/** findProgramAddress: the canonical (highest-bump) off-curve address for these seeds. */
export function findProgramAddress(seeds, programId) {
    for (let bump = 255; bump >= 0; bump -= 1) {
        const address = createProgramAddress([...seeds, Buffer.from([bump])], programId);
        if (address) return { address, bump };
    }
    throw new Error('no viable PDA bump');
}
