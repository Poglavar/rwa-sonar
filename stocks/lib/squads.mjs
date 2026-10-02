// Squads v4 multisig reading, pure: derive a vault PDA from its multisig and decode the Multisig
// account bytes (threshold, time lock, config authority, members and their permissions). Used to
// prove that an authority address is a Squads vault rather than a single keypair: the derivation must
// reproduce the authority byte for byte. Layout is the Anchor `Multisig` struct of Squads-Protocol/v4
// (programs/squads_multisig_program/src/state/multisig.rs), Borsh-serialized.

import { createHash } from 'node:crypto';
import { base58 } from './loopscale.mjs';

export const SQUADS_V4_PROGRAM_ID = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';

// sha256("account:Multisig")[0..8], the Anchor account discriminator.
export const MULTISIG_DISCRIMINATOR = Object.freeze([0xe0, 0x74, 0x79, 0xba, 0x44, 0xa1, 0x4f, 0xec]);

// Permissions bitmask of a member (Squads v4 `Permission`).
const PERMISSIONS = [[1, 'initiate'], [2, 'vote'], [4, 'execute']];

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Decode a base58 string to bytes (32 for a public key). */
export function fromBase58(text) {
    let n = 0n;
    for (const ch of text) {
        const v = ALPHABET.indexOf(ch);
        if (v < 0) throw new Error(`invalid base58 character ${JSON.stringify(ch)}`);
        n = n * 58n + BigInt(v);
    }
    const bytes = [];
    while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
    for (const ch of text) { if (ch !== '1') break; bytes.unshift(0); }
    return Uint8Array.from(bytes);
}

// ed25519 curve membership: y (little-endian, top bit = sign of x) must decompress to a point, i.e.
// x² = (y² − 1) / (d·y² + 1) must have a square root mod p. A PDA is valid only when it is OFF the curve.
const P = 2n ** 255n - 19n;
const D = (-121665n * modInv(121666n)) % P;
function mod(a) { const r = a % P; return r < 0n ? r + P : r; }
function modPow(b, e) { let r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = r * b % P; b = b * b % P; e >>= 1n; } return r; }
function modInv(a) { return modPow(a, P - 2n); }

export function isOnCurve(bytes) {
    if (bytes.length !== 32) return false;
    let y = 0n;
    for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
    if (y >= P) return false;
    const y2 = y * y % P;
    const x2 = mod((y2 - 1n) * modInv(mod(D * y2 + 1n)));
    if (x2 === 0n) return (bytes[31] & 0x80) === 0;
    return modPow(x2, (P - 1n) / 2n) === 1n; // Euler's criterion
}

/** Solana create_program_address; returns null when the hash lands on the curve (invalid PDA). */
export function createProgramAddress(seeds, programId) {
    const h = createHash('sha256');
    for (const seed of seeds) h.update(seed);
    h.update(fromBase58(programId)).update('ProgramDerivedAddress');
    const out = new Uint8Array(h.digest());
    return isOnCurve(out) ? null : base58(out);
}

/** Solana find_program_address: highest bump (255 down) whose address is off the curve. */
export function findProgramAddress(seeds, programId) {
    for (let bump = 255; bump >= 0; bump--) {
        const address = createProgramAddress([...seeds, Uint8Array.of(bump)], programId);
        if (address) return { address, bump };
    }
    throw new Error('no viable bump');
}

/** Squads v4 vault PDA: seeds ["multisig", multisig, "vault", index u8]. */
export function squadsVaultPda(multisig, index = 0) {
    const enc = new TextEncoder();
    return findProgramAddress([enc.encode('multisig'), fromBase58(multisig), enc.encode('vault'), Uint8Array.of(index)], SQUADS_V4_PROGRAM_ID);
}

/**
 * Decode a Squads v4 Multisig account (base64 string or bytes). Returns null when the discriminator
 * does not match, so a non-multisig account is never mistaken for one.
 */
export function decodeSquadsMultisig(data) {
    const buf = typeof data === 'string' ? Buffer.from(data, 'base64') : Buffer.from(data);
    if (buf.length < 8 + 32 + 32 + 2 + 4 + 8 + 8 + 1 + 1 + 4) return null;
    if (!MULTISIG_DISCRIMINATOR.every((b, i) => buf[i] === b)) return null;
    let o = 8;
    const key = () => { const k = base58(buf.subarray(o, o + 32)); o += 32; return k; };
    const createKey = key();
    const configAuthority = key();
    const threshold = buf.readUInt16LE(o); o += 2;
    const timeLockSeconds = buf.readUInt32LE(o); o += 4;
    const transactionIndex = buf.readBigUInt64LE(o).toString(); o += 8;
    const staleTransactionIndex = buf.readBigUInt64LE(o).toString(); o += 8;
    const hasRentCollector = buf[o]; o += 1;
    const rentCollector = hasRentCollector === 1 ? key() : null;
    const bump = buf[o]; o += 1;
    const count = buf.readUInt32LE(o); o += 4;
    if (o + count * 33 > buf.length) return null;
    const members = [];
    for (let i = 0; i < count; i++) {
        const memberKey = key();
        const mask = buf[o]; o += 1;
        members.push({ key: memberKey, mask, permissions: PERMISSIONS.filter(([bit]) => mask & bit).map(([, name]) => name) });
    }
    return {
        createKey,
        // All-zero config authority = "autonomous": config changes must pass the multisig itself.
        configAuthority: configAuthority === '11111111111111111111111111111111' ? null : configAuthority,
        threshold, timeLockSeconds, transactionIndex, staleTransactionIndex, rentCollector, bump, members
    };
}
