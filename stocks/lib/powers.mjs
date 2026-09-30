// Uses of issuer powers, pure: which keys to watch (read off the live jsonParsed mint accounts),
// how to decode one jsonParsed getTransaction result into the power uses its authority keys made
// (Token / Token-2022 freeze, thaw, delegate transfer and burn, mint, pause, multiplier, fee and
// authority changes; Squads v4 configuration changes), how to tell a routine use from one that
// reached a holder, which transactions a run reads within its budget and how far each address's
// checkpoint may move, and the SQL that stores it all. stocks/watch-powers.mjs does the IO;
// stocks/powers.test.js runs these functions on real transactions saved in
// stocks/fixtures/powers/. No network, no clock, no filesystem.

import { jsonbLiteral } from './db-load.mjs';
import { base58Decode, base58Encode } from './solana-address.mjs';
import { SQUADS_V4_PROGRAM_ID, squadsVaultPda } from './squads.mjs';

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export { SQUADS_V4_PROGRAM_ID };
const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);

/**
 * The authority roles watched, as read off a mint account. The transfer-fee WITHDRAW authority is
 * read (mintRoles) but not watched: withdrawing withheld fees is routine, and Tessera's three
 * withdraw keys each sit in 500+ transactions a day (measured 2026-09-30), so watching them would
 * spend most of the budget on nothing. A fee withdrawal by a key watched for another role is still
 * counted.
 */
export const ROLES = ['mint', 'freeze', 'permanentDelegate', 'pause', 'multiplier', 'transferFeeConfig'];
/** Roles whose use can reach a holder's account or every holder at once; listed and read first. */
export const HOLDER_POWER_ROLES = new Set(['freeze', 'permanentDelegate', 'pause', 'transferFeeConfig']);
/** Owner labels (lib/holders.mjs, lib/xstocks-float.mjs) that mean "an issuer wallet". */
export const ISSUER_LABELS = new Set(['issuer-authority', 'issuer-inventory', 'burn-address', 'issuer-wallet']);

// --- the watch list ----------------------------------------------------------------------------

const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);

/**
 * The watched authority of each role on one jsonParsed mint account, plus decimals and program.
 * Null for an account that is not a parsed mint (never guessed).
 */
export function mintRoles(account) {
    const parsed = account?.data?.parsed;
    if (!parsed || parsed.type !== 'mint' || !parsed.info) return null;
    const info = parsed.info;
    const ext = (name) => (Array.isArray(info.extensions) ? info.extensions : []).find((e) => e?.extension === name)?.state ?? null;
    return {
        decimals: Number.isInteger(info.decimals) ? info.decimals : null,
        program: str(account.owner) ?? (account.data.program === 'spl-token-2022' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM),
        roles: {
            mint: str(info.mintAuthority),
            freeze: str(info.freezeAuthority),
            permanentDelegate: str(ext('permanentDelegate')?.delegate),
            pause: str(ext('pausableConfig')?.authority),
            multiplier: str(ext('scaledUiAmountConfig')?.authority),
            transferFeeConfig: str(ext('transferFeeConfig')?.transferFeeConfigAuthority),
            withdrawWithheld: str(ext('transferFeeConfig')?.withdrawWithheldAuthority)
        }
    };
}

/**
 * `mintAccounts` {mint: jsonParsed account|null} and the stocks-tokens.json rows → per-mint facts
 * and the deduplicated authority addresses (many mints share one key: all 1,027 xStocks one freeze
 * vault). `only` keeps the mints of those issuers. `priority` 1 = holds a holder power, 2 = routine
 * roles only (mint, multiplier).
 */
export function buildWatchList(mintAccounts, tokens, { only = null } = {}) {
    const byMint = new Map();
    const addresses = new Map();
    const unreadable = [];
    for (const t of tokens) {
        if (only && !only.has(t.issuer)) continue;
        const facts = mintRoles(mintAccounts[t.mint]);
        if (!facts) { unreadable.push(t.mint); continue; }
        byMint.set(t.mint, { mint: t.mint, symbol: t.symbol ?? null, issuer: t.issuer ?? null, ...facts });
        for (const role of ROLES) {
            const address = facts.roles[role];
            if (!address) continue;
            const entry = addresses.get(address) ?? { address, kind: 'authority', roles: new Set(), issuers: new Set(), mints: 0 };
            entry.roles.add(role);
            if (t.issuer) entry.issuers.add(t.issuer);
            entry.mints += 1;
            addresses.set(address, entry);
        }
    }
    for (const entry of addresses.values()) {
        entry.priority = [...entry.roles].some((r) => HOLDER_POWER_ROLES.has(r)) ? 1 : 2;
    }
    return { byMint, addresses, unreadable };
}

// --- reading one transaction -------------------------------------------------------------------

/** Account keys of a jsonParsed transaction (static and lookup-table loaded, in index order). */
export function accountKeys(tx) {
    return (tx?.transaction?.message?.accountKeys ?? []).map((k) => (typeof k === 'string' ? k : k?.pubkey ?? null));
}

/** Every instruction in execution order: each top-level one, then its inner ones. */
export function flattenInstructions(tx) {
    const top = tx?.transaction?.message?.instructions ?? [];
    const inner = new Map((tx?.meta?.innerInstructions ?? []).map((g) => [g.index, g.instructions ?? []]));
    const out = [];
    top.forEach((ix, i) => {
        out.push({ ixIndex: out.length, path: `${i}`, top: i, ix, parent: null });
        (inner.get(i) ?? []).forEach((child, k) => out.push({ ixIndex: out.length, path: `${i}.${k}`, top: i, ix: child, parent: ix }));
    });
    return out;
}

/** token account → {mint, owner, decimals}, from the transaction's own pre/post token balances. */
export function tokenAccountFacts(tx) {
    const keys = accountKeys(tx);
    const facts = new Map();
    for (const list of [tx?.meta?.preTokenBalances ?? [], tx?.meta?.postTokenBalances ?? []]) {
        for (const b of list) {
            const account = keys[b.accountIndex];
            if (!account) continue;
            const prev = facts.get(account) ?? {};
            facts.set(account, {
                mint: str(b.mint) ?? prev.mint ?? null,
                owner: str(b.owner) ?? prev.owner ?? null,
                decimals: Number.isInteger(b.uiTokenAmount?.decimals) ? b.uiTokenAmount.decimals : prev.decimals ?? null
            });
        }
    }
    return facts;
}

const u64 = (buf, o) => (buf.length >= o + 8 ? buf.readBigUInt64LE(o).toString() : null);
const key = (buf, o) => (buf.length >= o + 32 ? base58Encode(buf.subarray(o, o + 32)) : null);

// Token-2022 SetAuthority AuthorityType (spl-token-2022 instruction.rs), as jsonParsed names them.
const AUTHORITY_TYPES = ['mintTokens', 'freezeAccount', 'accountOwner', 'closeAccount', 'transferFeeConfig', 'withheldWithdraw',
    'closeMint', 'interestRate', 'permanentDelegate', 'confidentialTransferMint', 'transferHookProgramId',
    'confidentialTransferFeeConfig', 'metadataPointer', 'groupPointer', 'groupMemberPointer', 'scaledUiAmount', 'pause'];
const ACCOUNT_STATES = ['uninitialized', 'initialized', 'frozen'];

/**
 * Raw Token / Token-2022 instruction bytes → the same {type, info} shape jsonParsed gives, for the
 * instructions this watcher cares about; null for any other. Layouts: spl-token-2022
 * instruction.rs (tags 3–15 as in spl-token; 23 TransferFeeExtension, 25 DefaultAccountState,
 * 33 TransferHook, 40 ScaledUiAmount, 41 Pausable, each with a sub-instruction byte).
 */
export function decodeTokenRaw(bytes, accounts) {
    const buf = Buffer.from(bytes);
    if (buf.length === 0) return null;
    const a = (i) => accounts[i] ?? null;
    const tag = buf[0];
    const amount = u64(buf, 1);
    switch (tag) {
    case 3: return { type: 'transfer', info: { source: a(0), destination: a(1), authority: a(2), amount } };
    case 12: return { type: 'transferChecked', info: { source: a(0), mint: a(1), destination: a(2), authority: a(3), tokenAmount: { amount, decimals: buf[9] ?? null } } };
    case 7: return { type: 'mintTo', info: { mint: a(0), account: a(1), mintAuthority: a(2), amount } };
    case 14: return { type: 'mintToChecked', info: { mint: a(0), account: a(1), mintAuthority: a(2), tokenAmount: { amount, decimals: buf[9] ?? null } } };
    case 8: return { type: 'burn', info: { account: a(0), mint: a(1), authority: a(2), amount } };
    case 15: return { type: 'burnChecked', info: { account: a(0), mint: a(1), authority: a(2), tokenAmount: { amount, decimals: buf[9] ?? null } } };
    case 10: return { type: 'freezeAccount', info: { account: a(0), mint: a(1), freezeAuthority: a(2) } };
    case 11: return { type: 'thawAccount', info: { account: a(0), mint: a(1), freezeAuthority: a(2) } };
    case 6: {
        const hasNew = buf[2] === 1;
        return { type: 'setAuthority', info: { mint: a(0), authority: a(1), authorityType: AUTHORITY_TYPES[buf[1]] ?? `type-${buf[1]}`, newAuthority: hasNew ? key(buf, 3) : null } };
    }
    case 23: {
        const sub = buf[1];
        if (sub === 5) {
            return { type: 'setTransferFee', info: { mint: a(0), transferFeeConfigAuthority: a(1), transferFeeBasisPoints: buf.length >= 4 ? buf.readUInt16LE(2) : null, maximumFee: u64(buf, 4) } };
        }
        if (sub === 2) return { type: 'withdrawWithheldTokensFromMint', info: { mint: a(0), feeRecipient: a(1), withdrawWithheldAuthority: a(2) } };
        if (sub === 3) return { type: 'withdrawWithheldTokensFromAccounts', info: { mint: a(0), feeRecipient: a(1), withdrawWithheldAuthority: a(2) } };
        return null;
    }
    case 25:
        if (buf[1] === 1) return { type: 'updateDefaultAccountState', info: { mint: a(0), freezeAuthority: a(1), accountState: ACCOUNT_STATES[buf[2]] ?? `state-${buf[2]}` } };
        return null;
    case 33:
        if (buf[1] === 1) return { type: 'updateTransferHook', info: { mint: a(0), authority: a(1), programId: key(buf, 2) } };
        return null;
    case 40:
        if (buf[1] === 1 && buf.length >= 18) {
            return { type: 'updateMultiplier', info: { mint: a(0), authority: a(1), newMultiplier: String(buf.readDoubleLE(2)), newMultiplierTimestamp: Number(buf.readBigInt64LE(10)) } };
        }
        return null;
    case 41:
        if (buf[1] === 1) return { type: 'pause', info: { mint: a(0), authority: a(1) } };
        if (buf[1] === 2) return { type: 'resume', info: { mint: a(0), authority: a(1) } };
        return null;
    default:
        return null;
    }
}

// --- Squads v4 -----------------------------------------------------------------------------------

// sha256("global:<name>")[0..8], the Anchor instruction discriminators of Squads-Protocol/v4.
const SQUADS_IX = {
    c208a15799a419ab: 'vault_transaction_execute',
    ac2cb398157feab4: 'batch_execute_transaction',
    '9bec57e4894b5127': 'config_transaction_create',
    '7292f4bdfc8c2428': 'config_transaction_execute',
    '01dbd76cb8e5d608': 'multisig_add_member',
    d975b1d2b691da48: 'multisig_remove_member',
    '8d2a0f7ea95c3eb5': 'multisig_change_threshold',
    '949a794dd4fe9b48': 'multisig_set_time_lock',
    '8f5dc78f5ca9c1e8': 'multisig_set_config_authority',
    '30cc4139d2469c4a': 'multisig_set_rent_collector',
    '0bf29f2a56c55973': 'multisig_add_spending_limit',
    e4c6886f7b04b271: 'multisig_remove_spending_limit'
};

const PERMISSIONS = [[1, 'initiate'], [2, 'vote'], [4, 'execute']];
const permissionNames = (mask) => PERMISSIONS.filter(([bit]) => mask & bit).map(([, n]) => n);

/** Borsh Vec<ConfigAction> at `o` (Squads v4 state/config_transaction.rs). Throws on a truncated buffer. */
export function decodeConfigActions(buf, o) {
    const need = (n) => { if (o + n > buf.length) throw new Error('config actions truncated'); };
    const readKey = () => { need(32); const k = key(buf, o); o += 32; return k; };
    const readVecKeys = () => { need(4); const n = buf.readUInt32LE(o); o += 4; const out = []; for (let i = 0; i < n; i++) out.push(readKey()); return out; };
    need(4);
    const count = buf.readUInt32LE(o); o += 4;
    const actions = [];
    for (let i = 0; i < count; i++) {
        need(1);
        const variant = buf[o]; o += 1;
        if (variant === 0) {
            const member = readKey(); need(1); const mask = buf[o]; o += 1;
            actions.push({ type: 'AddMember', member, permissions: permissionNames(mask) });
        } else if (variant === 1) {
            actions.push({ type: 'RemoveMember', member: readKey() });
        } else if (variant === 2) {
            need(2); actions.push({ type: 'ChangeThreshold', threshold: buf.readUInt16LE(o) }); o += 2;
        } else if (variant === 3) {
            need(4); actions.push({ type: 'SetTimeLock', timeLockSeconds: buf.readUInt32LE(o) }); o += 4;
        } else if (variant === 4) {
            const createKey = readKey(); need(1); const vaultIndex = buf[o]; o += 1;
            const mint = readKey(); need(9); const amount = buf.readBigUInt64LE(o).toString(); o += 8; const period = buf[o]; o += 1;
            actions.push({ type: 'AddSpendingLimit', createKey, vaultIndex, mint, amount, period, members: readVecKeys(), destinations: readVecKeys() });
        } else if (variant === 5) {
            actions.push({ type: 'RemoveSpendingLimit', spendingLimit: readKey() });
        } else if (variant === 6) {
            need(1); const has = buf[o]; o += 1;
            actions.push({ type: 'SetRentCollector', rentCollector: has === 1 ? readKey() : null });
        } else {
            throw new Error(`unknown ConfigAction variant ${variant}`);
        }
    }
    return { actions, end: o };
}

/** Borsh Option<String> memo at `o`, or null. */
function readMemo(buf, o) {
    if (o >= buf.length || buf[o] !== 1 || o + 5 > buf.length) return null;
    const len = buf.readUInt32LE(o + 1);
    return buf.subarray(o + 5, o + 5 + len).toString('utf8');
}

/** One Squads v4 instruction (raw bytes + account list) → {name, multisig, …args}, or null. */
export function decodeSquadsInstruction(bytes, accounts) {
    const buf = Buffer.from(bytes);
    if (buf.length < 8) return null;
    const name = SQUADS_IX[buf.subarray(0, 8).toString('hex')] ?? null;
    if (!name) return null;
    const out = { name, multisig: accounts[0] ?? null };
    if (name === 'config_transaction_create') {
        const { actions, end } = decodeConfigActions(buf, 8);
        Object.assign(out, { transaction: accounts[1] ?? null, creator: accounts[2] ?? null, actions, memo: readMemo(buf, end) });
    } else if (name === 'config_transaction_execute') {
        Object.assign(out, { member: accounts[1] ?? null, proposal: accounts[2] ?? null, transaction: accounts[3] ?? null });
    } else if (name.startsWith('multisig_')) {
        out.configAuthority = accounts[1] ?? null;
        let action = null;
        if (name === 'multisig_add_member' && buf.length >= 41) action = { type: 'AddMember', member: key(buf, 8), permissions: permissionNames(buf[40]) };
        if (name === 'multisig_remove_member') action = { type: 'RemoveMember', member: key(buf, 8) };
        if (name === 'multisig_change_threshold' && buf.length >= 10) action = { type: 'ChangeThreshold', threshold: buf.readUInt16LE(8) };
        if (name === 'multisig_set_time_lock' && buf.length >= 12) action = { type: 'SetTimeLock', timeLockSeconds: buf.readUInt32LE(8) };
        if (name === 'multisig_set_config_authority') action = { type: 'SetConfigAuthority', configAuthority: key(buf, 8) };
        if (name === 'multisig_set_rent_collector') action = { type: 'SetRentCollector' };
        if (name === 'multisig_add_spending_limit') action = { type: 'AddSpendingLimit' };
        if (name === 'multisig_remove_spending_limit') action = { type: 'RemoveSpendingLimit' };
        out.actions = action ? [action] : [];
    }
    return out;
}

const rawBytes = (ix) => (typeof ix?.data === 'string' && ix.data !== '' ? base58Decode(ix.data) : null);

/**
 * Is `address` a vault of a Squads v4 multisig that executed in this transaction? Returns
 * {multisig, vaultIndex} only when the vault PDA derived from the executing multisig reproduces
 * `address` byte for byte (indexes 0..maxIndex), so a coincidental co-occurrence is never taken.
 */
export function squadsVaultOf(tx, address, { maxIndex = 7 } = {}) {
    for (const { ix } of flattenInstructions(tx)) {
        if (ix?.programId !== SQUADS_V4_PROGRAM_ID) continue;
        const bytes = rawBytes(ix);
        if (!bytes) continue;
        const sq = decodeSquadsInstruction(bytes, ix.accounts ?? []);
        if (!sq || !['vault_transaction_execute', 'batch_execute_transaction'].includes(sq.name) || !sq.multisig) continue;
        for (let i = 0; i <= maxIndex; i += 1) {
            if (squadsVaultPda(sq.multisig, i).address === address) return { multisig: sq.multisig, vaultIndex: i };
        }
    }
    return null;
}

// --- decoding the power uses of one transaction ----------------------------------------------------

const AUTHORITY_FIELDS = ['authority', 'multisigAuthority', 'freezeAuthority', 'multisigFreezeAuthority', 'mintAuthority',
    'multisigMintAuthority', 'transferFeeConfigAuthority', 'multisigTransferFeeConfigAuthority', 'withdrawWithheldAuthority',
    'multisigWithdrawWithheldAuthority', 'owner', 'multisigOwner'];

function authorityOf(info) {
    for (const f of AUTHORITY_FIELDS) if (str(info?.[f])) return info[f];
    return null;
}

function amountOf(info) {
    return str(info?.tokenAmount?.amount) ?? (info?.amount !== undefined && info?.amount !== null ? String(info.amount) : null);
}

/** Token types that carry no issuer power when signed by their own key, or are not watched at all. */
const TOKEN_TYPES_IGNORED = new Set(['initializeMint', 'initializeMint2', 'initializeAccount', 'initializeAccount2', 'initializeAccount3',
    'initializeImmutableOwner', 'getAccountDataSize', 'approve', 'approveChecked', 'revoke', 'closeAccount', 'syncNative',
    'initializeMetadataPointer', 'initializePermanentDelegate', 'initializeDefaultAccountState', 'initializeScaledUiAmountConfig',
    'initializePausableConfig', 'initializeConfidentialTransferMint', 'initializeTransferHook', 'initializeTokenMetadata',
    'initializeTransferFeeConfig', 'initializeMintCloseAuthority', 'updateTokenMetadataField', 'updateMetadataPointer',
    'transferCheckedWithFee', 'harvestWithheldTokensToMint', 'amountToUiAmount', 'uiAmountToAmount', 'reallocate',
    'initializeGroupPointer', 'initializeGroupMemberPointer', 'initializeNonTransferableMint', 'createNativeMint',
    'withdrawExcessLamports', 'enableCpiGuard', 'disableCpiGuard', 'enableRequiredMemoTransfers', 'disableRequiredMemoTransfers',
    'initializeMultisig', 'initializeMultisig2', 'emitTokenMetadata', 'updateTokenMetadataUpdateAuthority', 'removeTokenMetadataKey']);

/**
 * One jsonParsed getTransaction result → the power uses in it made by a watched key.
 * `byMint` is buildWatchList().byMint; `watched` the set of watched authority addresses; `multisigs`
 * the set of watched Squads multisig accounts. Each use carries the raw facts; classifyUse() says
 * what it means. `warnings` names instructions that mention a watched key but could not be read.
 */
export function decodePowerUses(tx, { byMint, watched, multisigs = new Set() }) {
    const uses = [];
    const warnings = [];
    if (!tx || tx.meta?.err) return { uses, warnings };
    const signature = tx.transaction?.signatures?.[0] ?? null;
    const slot = Number.isFinite(tx.slot) ? tx.slot : null;
    const blockTime = Number.isFinite(tx.blockTime) ? new Date(tx.blockTime * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
    const facts = tokenAccountFacts(tx);
    const base = (entry, programId) => ({ signature, ixIndex: entry.ixIndex, ixPath: entry.path, slot, blockTime, programId });

    for (const entry of flattenInstructions(tx)) {
        const { ix, parent } = entry;
        const programId = ix?.programId ?? null;
        let via = null;
        if (parent?.programId === SQUADS_V4_PROGRAM_ID) {
            const p = rawBytes(parent) ? decodeSquadsInstruction(rawBytes(parent), parent.accounts ?? []) : null;
            if (p && ['vault_transaction_execute', 'batch_execute_transaction'].includes(p.name)) via = p.multisig;
        }

        if (programId === SQUADS_V4_PROGRAM_ID) {
            const bytes = rawBytes(ix);
            let sq = null;
            try {
                sq = bytes ? decodeSquadsInstruction(bytes, ix.accounts ?? []) : null;
            } catch (err) {
                if (multisigs.has(ix.accounts?.[0])) warnings.push(`squads-undecodable: ${err.message}`);
                continue;
            }
            if (!sq || !multisigs.has(sq.multisig)) continue;
            const action = sq.name === 'config_transaction_create' ? 'squads-config-proposed'
                : sq.name === 'config_transaction_execute' ? 'squads-config-executed'
                    : sq.name.startsWith('multisig_') ? 'squads-config-direct' : null;
            if (!action) continue;
            uses.push({
                ...base(entry, programId), action, authority: sq.multisig, mint: null, targetAccount: sq.transaction ?? null,
                targetOwner: null, amountRaw: null, decimals: null, viaMultisig: null,
                detail: { instruction: sq.name, actions: sq.actions ?? null, memo: sq.memo ?? null, creator: sq.creator ?? null,
                    member: sq.member ?? null, proposal: sq.proposal ?? null, configAuthority: sq.configAuthority ?? null }
            });
            continue;
        }
        if (!TOKEN_PROGRAMS.has(programId)) continue;

        let decoded = null;
        if (ix.parsed && typeof ix.parsed === 'object') decoded = { type: ix.parsed.type, info: ix.parsed.info ?? {} };
        else if (rawBytes(ix)) decoded = decodeTokenRaw(rawBytes(ix), ix.accounts ?? []);
        if (!decoded) continue;
        const { type, info } = decoded;
        const authority = authorityOf(info);
        if (!authority || !watched.has(authority)) continue;

        const mintOf = (account) => str(info.mint) ?? facts.get(account)?.mint ?? null;
        // A watched key acting on a mint outside our universe is still that key's power in use (only
        // a mint's own freeze / mint / pause / multiplier key can sign those), so it is kept, marked.
        const push = (action, fields) => {
            const mint = fields.mint;
            if (!mint) return;
            const tracked = byMint.get(mint) ?? null;
            const decimals = tracked?.decimals ?? [...facts.values()].find((f) => f.mint === mint && Number.isInteger(f.decimals))?.decimals ?? null;
            uses.push({ ...base(entry, programId), action, authority, viaMultisig: via, targetAccount: null, targetOwner: null,
                amountRaw: null, decimals, ...fields, detail: { ...(fields.detail ?? {}), ...(tracked ? {} : { untrackedMint: true }) } });
        };

        switch (type) {
        case 'freezeAccount':
        case 'thawAccount': {
            const account = str(info.account);
            push(type === 'freezeAccount' ? 'freeze' : 'thaw', { mint: mintOf(account), targetAccount: account, targetOwner: facts.get(account)?.owner ?? null });
            break;
        }
        case 'transfer':
        case 'transferChecked':
        case 'burn':
        case 'burnChecked': {
            const account = str(info.source) ?? str(info.account);
            const mint = mintOf(account);
            const owner = facts.get(account)?.owner ?? null;
            // Only the permanent delegate acting on an account it does not own is a power use; an
            // owner moving or burning its own tokens, or an ordinary approved delegate, is not.
            if (!byMint.has(mint) || byMint.get(mint).roles.permanentDelegate !== authority || owner === authority) break;
            const isBurn = type.startsWith('burn');
            push(isBurn ? 'delegate-burn' : 'delegate-transfer', {
                mint, targetAccount: account, targetOwner: owner, amountRaw: amountOf(info),
                detail: isBurn ? {} : { destination: str(info.destination), destinationOwner: facts.get(str(info.destination))?.owner ?? null }
            });
            break;
        }
        case 'mintTo':
        case 'mintToChecked': {
            const account = str(info.account);
            push('mint', { mint: str(info.mint), targetAccount: account, targetOwner: facts.get(account)?.owner ?? null, amountRaw: amountOf(info) });
            break;
        }
        case 'pause':
        case 'resume':
            push(type, { mint: str(info.mint) });
            break;
        case 'updateMultiplier':
            push('multiplier-update', { mint: str(info.mint), detail: { newMultiplier: info.newMultiplier ?? null, effectiveTimestamp: info.newMultiplierTimestamp ?? null } });
            break;
        case 'setTransferFee':
        {
            // jsonParsed gives the u64 cap as a JS number, which cannot hold u64::MAX exactly; any
            // cap at or above 2^64 − 2^11 (its nearest double) is the "no cap" value.
            const max = info.maximumFee ?? null;
            const uncapped = max !== null && Number(max) >= 18446744073709549568;
            push('transfer-fee-set', { mint: str(info.mint), detail: { basisPoints: info.transferFeeBasisPoints ?? null,
                maximumFee: max === null ? null : uncapped ? '18446744073709551615' : String(max), uncapped } });
        }
            break;
        case 'withdrawWithheldTokensFromMint':
        case 'withdrawWithheldTokensFromAccounts':
            push('fee-withdraw', { mint: str(info.mint), detail: { feeRecipient: str(info.feeRecipient) } });
            break;
        case 'updateDefaultAccountState':
            push('default-state-set', { mint: str(info.mint), detail: { accountState: info.accountState ?? null } });
            break;
        case 'updateTransferHook':
            push('hook-update', { mint: str(info.mint), detail: { programId: info.programId ?? info.transferHookProgramId ?? null } });
            break;
        case 'setAuthority': {
            const mint = str(info.mint) ?? str(info.account);
            push('set-authority', { mint, detail: { authorityType: info.authorityType ?? null, newAuthority: info.newAuthority ?? null } });
            break;
        }
        default:
            if (!TOKEN_TYPES_IGNORED.has(type)) warnings.push(`unrecognised token instruction ${type} by a watched key`);
        }
    }
    return { uses, warnings };
}

// --- what a use means ----------------------------------------------------------------------------

/** Actions counted per day instead of stored one row each. */
export const ROUTINE_ACTIONS = new Set(['mint', 'multiplier-update', 'fee-withdraw']);

const ROLE_OF_ACTION = {
    freeze: 'freeze', thaw: 'freeze', 'delegate-transfer': 'permanentDelegate', 'delegate-burn': 'permanentDelegate',
    mint: 'mint', pause: 'pause', resume: 'pause', 'multiplier-update': 'multiplier', 'transfer-fee-set': 'transferFeeConfig',
    'fee-withdraw': 'withdrawWithheld', 'default-state-set': 'freeze'
};

/** Decimal string of `raw` base units at `decimals` (BigInt, never a float), or null. */
export function unitsToDecimal(raw, decimals) {
    if (typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isInteger(decimals)) return null;
    if (decimals === 0) return raw;
    const padded = raw.padStart(decimals + 1, '0');
    const whole = padded.slice(0, -decimals);
    const frac = padded.slice(-decimals).replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole;
}

/**
 * A decoded use + the owner labels → {routine, action, holderAffecting, severity, targetLabel,
 * targetKind}. An owner the repo cannot label — including one the transaction did not reveal — is
 * NOT an issuer wallet: a freeze of it is holder-affecting.
 */
export function classifyUse(use, labels) {
    const label = use.targetOwner ? labels.get(use.targetOwner) ?? null : null;
    const issuerTarget = label !== null && ISSUER_LABELS.has(label);
    const out = { targetLabel: label, targetKind: issuerTarget ? 'issuer' : 'other', routine: false, holderAffecting: false, severity: 'info', action: use.action };
    switch (use.action) {
    case 'freeze':
        return issuerTarget ? { ...out, routine: true } : { ...out, holderAffecting: true, severity: 'warning' };
    case 'thaw':
        return issuerTarget ? { ...out, routine: true } : { ...out, holderAffecting: true, severity: 'info' };
    case 'delegate-transfer':
        return issuerTarget ? { ...out, routine: true } : { ...out, action: 'forced-transfer', holderAffecting: true, severity: 'critical' };
    case 'delegate-burn':
        return issuerTarget ? { ...out, routine: true } : { ...out, action: 'forced-burn', holderAffecting: true, severity: 'critical' };
    case 'mint':
    case 'multiplier-update':
    case 'fee-withdraw':
        return { ...out, routine: true, targetKind: use.action === 'mint' ? out.targetKind : 'mint' };
    case 'pause':
        return { ...out, targetKind: 'mint', holderAffecting: true, severity: 'critical' };
    case 'resume':
        return { ...out, targetKind: 'mint', holderAffecting: true, severity: 'info' };
    case 'transfer-fee-set':
        return { ...out, targetKind: 'mint', holderAffecting: true, severity: 'warning' };
    case 'default-state-set': {
        const frozen = use.detail?.accountState === 'frozen';
        return { ...out, targetKind: 'mint', holderAffecting: frozen, severity: frozen ? 'warning' : 'info' };
    }
    case 'set-authority':
    case 'hook-update':
    case 'squads-config-executed':
    case 'squads-config-direct':
        return { ...out, targetKind: use.action.startsWith('squads') ? 'multisig' : 'mint', severity: 'warning' };
    case 'squads-config-proposed':
        return { ...out, targetKind: 'multisig', severity: 'info' };
    default:
        throw new Error(`classifyUse: unknown action ${use.action}`);
    }
}

/**
 * The stored row of one non-routine use. `issuersOf(address)` names the issuers a watched key
 * serves; a use on an untracked mint (or a multisig row) takes the issuer from there when it is one.
 */
export function useRow(use, cls, { byMint, issuersOf = () => [] }) {
    const m = use.mint ? byMint.get(use.mint) ?? null : null;
    const keyIssuers = issuersOf(use.authority);
    const role = ROLE_OF_ACTION[use.action] ?? (use.action.startsWith('squads') ? 'squads-multisig' : use.action === 'set-authority' ? 'authority' : null);
    return {
        signature: use.signature, ixIndex: use.ixIndex, slot: use.slot, blockTime: use.blockTime, mint: use.mint ?? null,
        symbol: m?.symbol ?? null, issuer: m?.issuer ?? (keyIssuers.length === 1 ? keyIssuers[0] : null), authority: use.authority, authorityRole: role,
        viaMultisig: use.viaMultisig ?? null, action: cls.action, targetAccount: use.targetAccount ?? null,
        targetOwner: use.targetOwner ?? null, targetLabel: cls.targetLabel, amountRaw: use.amountRaw ?? null,
        amount: unitsToDecimal(use.amountRaw ?? null, use.decimals ?? m?.decimals ?? null),
        holderAffecting: cls.holderAffecting, severity: cls.severity, programId: use.programId,
        detail: { ...use.detail, ixPath: use.ixPath, ...(use.targetOwner === null && use.targetAccount && use.mint ? { ownerUnknown: true } : {}) }
    };
}

/** Routine uses → daily rollup rows keyed (UTC day, mint, authority, action, target kind). */
export function rollupRoutine(items) {
    const out = new Map();
    for (const { use, cls } of items) {
        const day = use.blockTime.slice(0, 10);
        const k = `${day}|${use.mint}|${use.authority}|${cls.action}|${cls.targetKind}`;
        const row = out.get(k) ?? { day, mint: use.mint, authority: use.authority, action: cls.action, targetKind: cls.targetKind,
            uses: 0, amountRaw: null, firstSignature: use.signature, lastSignature: use.signature, firstBlockTime: use.blockTime, lastBlockTime: use.blockTime };
        row.uses += 1;
        if (typeof use.amountRaw === 'string' && /^\d+$/.test(use.amountRaw)) row.amountRaw = String(BigInt(row.amountRaw ?? '0') + BigInt(use.amountRaw));
        if (use.blockTime < row.firstBlockTime) { row.firstBlockTime = use.blockTime; row.firstSignature = use.signature; }
        if (use.blockTime >= row.lastBlockTime) { row.lastBlockTime = use.blockTime; row.lastSignature = use.signature; }
        out.set(k, row);
    }
    return [...out.values()];
}

// --- which transactions a run reads ------------------------------------------------------------------

/**
 * `listings` Map(address → {priority, pending: oldest-first [{signature, slot, blockTime, err}]}).
 * Failed transactions need no read. The rest are read once each (a transaction listed by several
 * addresses counts once), holder-power addresses first, oldest slot first, up to `budget`.
 */
export function planReads(listings, { budget }) {
    const bySig = new Map();
    for (const [, listing] of listings) {
        for (const s of listing.pending) {
            if (s.err !== null && s.err !== undefined) continue;
            const prev = bySig.get(s.signature);
            if (!prev || listing.priority < prev.priority) bySig.set(s.signature, { signature: s.signature, slot: s.slot, priority: listing.priority });
        }
    }
    const all = [...bySig.values()].sort((a, b) => a.priority - b.priority || a.slot - b.slot);
    return { toRead: all.slice(0, budget).map((e) => e.signature), backlog: Math.max(0, all.length - budget) };
}

/**
 * The oldest-first stretch of one address's pending list that is fully accounted for (failed, or
 * read successfully): its uses may be stored and the checkpoint moved to its last entry. Anything
 * after the first unread signature waits for the next run, so nothing is skipped.
 */
export function committedPrefix(pending, readOk) {
    const prefix = [];
    for (const s of pending) {
        const failed = s.err !== null && s.err !== undefined;
        if (!failed && !readOk.has(s.signature)) break;
        prefix.push(s);
    }
    return prefix;
}

// --- SQL ---------------------------------------------------------------------------------------------

function upsert({ table, doc, columns, conflict, update, set = null }) {
    const colList = columns.map(([c]) => c).join(', ');
    const select = columns.map(([, expr]) => expr).join(',\n       ');
    const setList = set ?? [...update.map((c) => `${c} = EXCLUDED.${c}`), 'updated_at = now()'].join(',\n       ');
    const guard = update.map((c) => `t.${c} IS DISTINCT FROM EXCLUDED.${c}`).join('\n    OR ');
    return `WITH doc AS (SELECT ${jsonbLiteral(doc)} AS d)\n`
        + `INSERT INTO ${table} AS t (${colList})\n`
        + `SELECT ${select}\n  FROM doc, jsonb_array_elements(d->'rows') AS x(r)\n`
        + `ON CONFLICT (${conflict}) DO UPDATE SET\n       ${setList}\n${set ? '' : ` WHERE ${guard}`};\n`;
}

const TS = (f) => `(r->>'${f}')::timestamptz`;
const NUM = (f) => `(r->>'${f}')::numeric`;
const TXT = (f) => `r->>'${f}'`;
const JSONB = (f) => `NULLIF(r->'${f}', 'null'::jsonb)`;
const ARR = (f) => `CASE WHEN jsonb_typeof(r->'${f}') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(r->'${f}')) END`;

/** Upsert non-routine uses on (signature, ix_index): a re-read of the same transaction changes nothing. */
export function buildUseSql(rows) {
    if (!rows?.length) return null;
    return upsert({
        table: 'sonar.power_use',
        doc: { rows },
        columns: [
            ['signature', TXT('signature')], ['ix_index', "(r->>'ixIndex')::int"], ['slot', "(r->>'slot')::bigint"], ['block_time', TS('blockTime')],
            ['mint', TXT('mint')], ['symbol', TXT('symbol')], ['issuer', TXT('issuer')], ['authority', TXT('authority')],
            ['authority_role', TXT('authorityRole')], ['via_multisig', TXT('viaMultisig')], ['action', TXT('action')],
            ['target_account', TXT('targetAccount')], ['target_owner', TXT('targetOwner')], ['target_label', TXT('targetLabel')],
            ['amount_raw', NUM('amountRaw')], ['amount', NUM('amount')], ['holder_affecting', "(r->>'holderAffecting')::bool"],
            ['severity', TXT('severity')], ['program_id', TXT('programId')], ['detail', JSONB('detail')]
        ],
        conflict: 'signature, ix_index',
        update: ['symbol', 'issuer', 'target_label', 'holder_affecting', 'severity', 'action', 'detail']
    });
}

/**
 * Add routine counts to the daily rollup. NOT idempotent by itself — the caller commits it in the
 * same transaction as the checkpoints of the addresses whose listings produced the uses, so each
 * use is added exactly once.
 */
export function buildDailySql(rows) {
    if (!rows?.length) return null;
    return upsert({
        table: 'sonar.power_use_daily',
        doc: { rows },
        columns: [
            ['day', "(r->>'day')::date"], ['mint', TXT('mint')], ['authority', TXT('authority')], ['action', TXT('action')],
            ['target_kind', TXT('targetKind')], ['uses', "(r->>'uses')::int"], ['amount_raw', NUM('amountRaw')],
            ['first_signature', TXT('firstSignature')], ['last_signature', TXT('lastSignature')],
            ['first_block_time', TS('firstBlockTime')], ['last_block_time', TS('lastBlockTime')]
        ],
        conflict: 'day, mint, authority, action, target_kind',
        update: [],
        set: ['uses = t.uses + EXCLUDED.uses',
            'amount_raw = CASE WHEN t.amount_raw IS NULL AND EXCLUDED.amount_raw IS NULL THEN NULL ELSE COALESCE(t.amount_raw, 0) + COALESCE(EXCLUDED.amount_raw, 0) END',
            'first_signature = CASE WHEN EXCLUDED.first_block_time < t.first_block_time THEN EXCLUDED.first_signature ELSE t.first_signature END',
            'first_block_time = LEAST(t.first_block_time, EXCLUDED.first_block_time)',
            'last_signature = CASE WHEN EXCLUDED.last_block_time >= t.last_block_time THEN EXCLUDED.last_signature ELSE t.last_signature END',
            'last_block_time = GREATEST(t.last_block_time, EXCLUDED.last_block_time)',
            'updated_at = now()'].join(',\n       ')
    });
}

/** Upsert the per-address checkpoints. */
export function buildScanSql(rows) {
    if (!rows?.length) return null;
    return upsert({
        table: 'sonar.power_scan',
        doc: { rows },
        columns: [
            ['address', TXT('address')], ['kind', TXT('kind')], ['roles', ARR('roles')], ['issuers', ARR('issuers')],
            ['backfill_from', TS('backfillFrom')], ['last_signature', TXT('lastSignature')], ['last_slot', "(r->>'lastSlot')::bigint"],
            ['last_block_time', TS('lastBlockTime')], ['state', JSONB('state')], ['signatures_seen', "(r->>'signaturesSeen')::bigint"],
            ['listed_at', TS('listedAt')]
        ],
        conflict: 'address',
        update: ['kind', 'roles', 'issuers', 'backfill_from', 'last_signature', 'last_slot', 'last_block_time', 'state', 'signatures_seen', 'listed_at']
    });
}

const ISO = (col) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

export const SCAN_STATE_QUERY = `SELECT COALESCE(json_agg(json_build_object(
    'address', address, 'kind', kind, 'backfillFrom', ${ISO('backfill_from')},
    'lastSignature', last_signature, 'lastSlot', last_slot, 'lastBlockTime', ${ISO('last_block_time')},
    'state', state, 'signaturesSeen', signatures_seen, 'listedAt', ${ISO('listed_at')})), '[]'::json)::text
  FROM sonar.power_scan;`;

/** The actions of already-stored config proposals, for executions whose proposal an earlier run read. */
export function proposalActionsQuery(transactions) {
    return `SELECT COALESCE(json_object_agg(target_account, detail->'actions'), '{}'::json)::text FROM sonar.power_use
 WHERE action = 'squads-config-proposed' AND target_account IN (SELECT jsonb_array_elements_text(${jsonbLiteral(transactions)}));`;
}

// --- the run's one message ------------------------------------------------------------------------------

/** At most one Telegram text per run: null when there is nothing holder-affecting and no failure. */
export function summaryText({ holderRows, configRows = [], failures = [], stats }) {
    // A thaw or a resume reaches holders too, but gives back rather than takes: alone it sends nothing.
    if (!holderRows.some((r) => r.severity !== 'info') && !failures.length) return null;
    const lines = [`RWA Sonar · issuer powers: ${holderRows.length} holder-affecting use(s)${configRows.length ? `, ${configRows.length} multisig change(s)` : ''}${failures.length ? `, ${failures.length} failure(s)` : ''}`];
    const byKey = new Map();
    for (const r of holderRows) {
        const k = `${r.issuer ?? '?'} ${r.action}`;
        byKey.set(k, (byKey.get(k) ?? 0) + 1);
    }
    for (const [k, n] of [...byKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) lines.push(`· ${k} ×${n}`);
    const worst = holderRows.find((r) => r.severity === 'critical') ?? holderRows.find((r) => r.severity === 'warning') ?? holderRows[0];
    if (worst) lines.push(`e.g. ${worst.blockTime} ${worst.symbol ?? worst.mint ?? ''} ${worst.action} https://solscan.io/tx/${worst.signature}`);
    if (failures.length) lines.push(`failures: ${failures.slice(0, 3).join(' | ')}`);
    if (stats?.backlog) lines.push(`backlog ${stats.backlog} transaction(s)`);
    return lines.join('\n');
}
