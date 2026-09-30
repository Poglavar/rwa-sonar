// Unit tests for stocks/lib/powers.mjs — reading uses of issuer powers out of real transactions.
// Every fixture in fixtures/powers/ is a getTransaction(jsonParsed, maxSupportedTransactionVersion 1)
// result captured read-only from mainnet on 2026-09-30; mints.json holds the jsonParsed mint
// accounts of the mints they touch, read the same day.
//   ondo-squads-freeze / -thaw          27MTKQS2… / 58v9gkTN… 2026-04-30 Ondo freeze vault 51QVCu… (Squads CDCCa8…) freezes and thaws one account
//   tessera-freeze / -thaw              2vjJK8s8… / 21DUPxVv… 2026-06-07 Tessera's plain freeze key on tSpaceX
//   bullish-forced-burn                 4NyKQSR8… 2026-08-13 Bullish's permanent delegate burns 25,100.5 BLSH from GcougkTb…
//   squads-add-member-proposed          5j6VvEJF… 2026-07-20 xStocks delegate multisig Dsm8Dm…: AddMember FN5JKy… (all permissions)
//   squads-remove-member-proposed/-executed 5GarMpAn… / 5agfY69c… 2026-07-22 the same multisig removes FnZHJQ…
//   squads-threshold-proposed/-executed 2oLWSvcR… / 3MaZwgkZ… 2026-04-27 Ondo freeze multisig CDCCa8…: threshold → 3
//   backpack-trade                      2n6JGbY8… 2026-09-30 a Backpack trade: owner burn (no power) + per-mint UpdateMultiplier
//   ondo-buy-mint                       34ah7igh… 2026-09-30 an Ondo purchase: mintTo straight into the buyer's account
//   xstocks-set-authority-via-squads    23C8MS6v… 2026-04-29 xStocks freeze vault JDq14B… hands ten mints' mint authority to 7pt9tk…
//   prestocks-transfer-fee-set          5RroCLX1… 2026-09-08 PreStocks' shared key (Squads 53Ab3R…) sets ANDURIL's transfer fee to 50 bps

import { readFileSync } from 'node:fs';

import { base58Encode } from './lib/solana-address.mjs';
import {
    buildDailySql, buildScanSql, buildUseSql, buildWatchList, classifyUse, committedPrefix, decodeConfigActions,
    decodePowerUses, decodeSquadsInstruction, decodeTokenRaw, mintRoles, planReads, rollupRoutine, squadsVaultOf,
    summaryText, unitsToDecimal, useRow
} from './lib/powers.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/powers/${name}.json`, import.meta.url), 'utf8'));
const MINTS = fixture('mints');
const WATCH = buildWatchList(MINTS.accounts, MINTS.tokens);

const ONDO_FREEZE_VAULT = '51QVCuHfL1FeNjd8BDeffCKhCcAYoULnVB3yjNhShiuK';
const ONDO_FREEZE_MULTISIG = 'CDCCa8yPj9eyE57ZT4NJ1pbNdeFCcJEoTyy4UjNbC3pF';
const XSTOCKS_FREEZE_VAULT = 'JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs';
const XSTOCKS_DELEGATE_MULTISIG = 'Dsm8Dmh6ip3pc19G3oB3FBc2Kx7A9sQBSA2akD2Jraot';
const TESSERA_FREEZE = '7n2PNcDXVDMK2m8dyV9cVPNY7p4jM4ZMHv7TzfibEt8o';
const BULLISH_DELEGATE = 'DPT54eBQJf7ghEQTzX7vjAb8WaDRMJFQchX6MKm3dFcD';
const BLSH = '6d5zakCaxjjRALNRyudC6ArivxeBGT3XUAci7ybWQY8U';

// The watch list as the watcher builds it, plus the keys these older fixtures signed with that are
// no longer a current authority of a fixture mint (Ondo's freeze vault acts on an untracked mint).
const WATCHED = new Set([...WATCH.addresses.keys(), ONDO_FREEZE_VAULT, XSTOCKS_FREEZE_VAULT]);
const MULTISIGS = new Set([ONDO_FREEZE_MULTISIG, XSTOCKS_DELEGATE_MULTISIG]);
const decode = (name, opts = {}) => decodePowerUses(fixture(name), { byMint: WATCH.byMint, watched: WATCHED, multisigs: MULTISIGS, ...opts });

describe('the watch list comes from the mint accounts', () => {
    it('reads each role off a jsonParsed mint and dedupes keys shared by many mints', () => {
        const xstocks = MINTS.tokens.filter((t) => t.issuer === 'xstocks-backed');
        expect(xstocks.length).toBeGreaterThan(5);
        const delegate = WATCH.addresses.get('5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq');
        expect([...delegate.roles]).toEqual(['permanentDelegate']);
        expect(delegate.mints).toBe(xstocks.length);
        expect(delegate.priority).toBe(1);
        const freeze = WATCH.addresses.get(XSTOCKS_FREEZE_VAULT);
        expect([...freeze.roles].sort()).toEqual(['freeze', 'pause']);
        // The xStocks treasury only updates multipliers: routine, read after the holder-power keys.
        expect([...WATCH.addresses.get('S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS').roles]).toEqual(['multiplier']);
        expect(WATCH.addresses.get('S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS').priority).toBe(2);
    });

    it('keeps the fee-withdraw key out of the watched roles, and refuses a non-mint account', () => {
        const tessera = mintRoles(MINTS.accounts[MINTS.tokens.find((t) => t.symbol === 'tSpaceX').mint]);
        expect(tessera.roles.withdrawWithheld).toBeTruthy();
        expect(WATCH.addresses.has(tessera.roles.withdrawWithheld)).toBe(false);
        expect(mintRoles({ data: { parsed: { type: 'account', info: {} } } })).toBeNull();
        expect(mintRoles(null)).toBeNull();
    });
});

describe('freezes and thaws', () => {
    it('reads a freeze executed through a Squads vault, with the multisig it went through', () => {
        const { uses, warnings } = decode('ondo-squads-freeze');
        expect(warnings).toEqual([]);
        expect(uses).toHaveLength(1);
        const [u] = uses;
        expect(u).toMatchObject({
            action: 'freeze', authority: ONDO_FREEZE_VAULT, viaMultisig: ONDO_FREEZE_MULTISIG,
            mint: '12F5fd9mTPCXwfWXjJ42mDBeMYxgo45dxXUUkkYdondo', targetAccount: '7GiHUapLLCYEEh3PhEHcxqSmv8qbhu4ZoupBjoJ8DHMr',
            targetOwner: 'onANiutGisbudi5EXNmecxhx7931e69PScVGWWeVuaf', slot: 416734133, blockTime: '2026-04-30T20:56:14Z'
        });
        // The mint is not in our universe; the key is, so the use is kept and marked.
        expect(u.detail.untrackedMint).toBe(true);
        const cls = classifyUse(u, new Map());
        expect(cls).toMatchObject({ action: 'freeze', holderAffecting: true, severity: 'warning', routine: false });
    });

    it('a freeze of an issuer-labelled account is routine; a thaw of a holder is holder-affecting but info', () => {
        const [freeze] = decode('tessera-freeze').uses;
        expect(freeze).toMatchObject({ action: 'freeze', authority: TESSERA_FREEZE, viaMultisig: null });
        expect(classifyUse(freeze, new Map([[freeze.targetOwner, 'issuer-inventory']]))).toMatchObject({ routine: true, holderAffecting: false });
        const [thaw] = decode('tessera-thaw').uses;
        expect(thaw.targetOwner).toBe(freeze.targetOwner);
        expect(classifyUse(thaw, new Map())).toMatchObject({ action: 'thaw', holderAffecting: true, severity: 'info' });
    });

    it('ignores a transaction signed by a key it does not watch', () => {
        expect(decode('tessera-freeze', { watched: new Set(['11111111111111111111111111111111']) }).uses).toEqual([]);
    });
});

describe('the permanent delegate', () => {
    it('a burn by the delegate out of an account it does not own is a critical forced burn', () => {
        const [u] = decode('bullish-forced-burn').uses;
        expect(u).toMatchObject({ action: 'delegate-burn', authority: BULLISH_DELEGATE, mint: BLSH, amountRaw: '25100500000',
            targetOwner: 'GcougkTbWjTJteFXq15P1PxjEyQxsffLDHoxcB5d4nxr' });
        const cls = classifyUse(u, new Map());
        expect(cls).toMatchObject({ action: 'forced-burn', holderAffecting: true, severity: 'critical' });
        const row = useRow(u, cls, { byMint: WATCH.byMint });
        expect(row).toMatchObject({ amount: '25100.5', symbol: 'BLSH', issuer: 'bullish', authorityRole: 'permanentDelegate' });
    });

    it('the same burn signed by a key that is NOT the mint\'s permanent delegate is not a power use', () => {
        const byMint = new Map(WATCH.byMint);
        byMint.set(BLSH, { ...byMint.get(BLSH), roles: { ...byMint.get(BLSH).roles, permanentDelegate: 'SomeoneElse1111111111111111111111111111111' } });
        expect(decode('bullish-forced-burn', { byMint }).uses).toEqual([]);
    });

    it('an owner burning its own tokens in a Backpack trade is not a power; the multiplier update is routine', () => {
        const { uses } = decode('backpack-trade');
        expect(uses.map((u) => u.action)).toEqual(['multiplier-update']);
        expect(uses[0].detail).toMatchObject({ newMultiplier: '1', effectiveTimestamp: 0 });
        expect(classifyUse(uses[0], new Map())).toMatchObject({ routine: true, targetKind: 'mint' });
    });
});

describe('mints, fees and authority changes', () => {
    it('an Ondo purchase mints straight into the buyer: routine, counted per day', () => {
        const { uses } = decode('ondo-buy-mint');
        const mints = uses.filter((u) => u.action === 'mint');
        expect(mints).toHaveLength(1);
        expect(mints[0]).toMatchObject({ authority: '9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD', amountRaw: '29817386',
            targetOwner: 'DSqMPMsMAbEJVNuPKv1ZFdzt6YvJaDPDddfeW7ajtqds' });
        expect(classifyUse(mints[0], new Map())).toMatchObject({ routine: true, targetKind: 'other' });
        // The same transaction's USDon burn is by a key acting as an ordinary delegate on a mint we do not track.
        expect(uses.some((u) => u.action === 'delegate-burn')).toBe(false);
    });

    it('reads ten SetAuthority instructions a Squads vault executed', () => {
        const { uses } = decode('xstocks-set-authority-via-squads');
        expect(uses).toHaveLength(10);
        expect(new Set(uses.map((u) => u.detail.authorityType))).toEqual(new Set(['mintTokens']));
        expect(new Set(uses.map((u) => u.detail.newAuthority))).toEqual(new Set(['7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj']));
        expect(uses.every((u) => u.viaMultisig === '8gep9m2BmCqz4qCQMcqZoqnaGedXgRWehFYhKaPuiu8X')).toBe(true);
        expect(new Set(uses.map((u) => u.ixIndex)).size).toBe(10);
        expect(classifyUse(uses[0], new Map())).toMatchObject({ severity: 'warning', holderAffecting: false });
    });

    it('a transfer-fee change reaches every holder', () => {
        const { uses } = decode('prestocks-transfer-fee-set');
        expect(uses).toHaveLength(1);
        expect(uses[0]).toMatchObject({ action: 'transfer-fee-set', mint: 'PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB',
            authority: 'WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc', viaMultisig: '53Ab3Rqx1a5uiV7qmsX4qbdbrqstVDpnH4LoJGfsZsU8' });
        expect(uses[0].detail).toMatchObject({ basisPoints: 50, maximumFee: '18446744073709551615', uncapped: true });
        expect(classifyUse(uses[0], new Map())).toMatchObject({ holderAffecting: true, severity: 'warning' });
    });
});

describe('Squads v4', () => {
    it('proves a key is a vault only by re-deriving its PDA from the executing multisig', () => {
        expect(squadsVaultOf(fixture('ondo-squads-freeze'), ONDO_FREEZE_VAULT)).toEqual({ multisig: ONDO_FREEZE_MULTISIG, vaultIndex: 0 });
        // The fee payer sits in the same transaction and is not a vault of it.
        expect(squadsVaultOf(fixture('ondo-squads-freeze'), 'Do6TjuVbtSoCDBerE4zwgq6F9Qpto1Qp4JH3u7z3udBJ')).toBeNull();
        expect(squadsVaultOf(fixture('tessera-freeze'), TESSERA_FREEZE)).toBeNull();
    });

    it('decodes config proposals: add member, remove member, change threshold', () => {
        const add = decode('squads-add-member-proposed').uses;
        expect(add).toHaveLength(1);
        expect(add[0]).toMatchObject({ action: 'squads-config-proposed', authority: XSTOCKS_DELEGATE_MULTISIG });
        expect(add[0].detail.actions).toEqual([{ type: 'AddMember', member: 'FN5JKy3ySbUH2QoCc329ni75oz76t7qFFg6xGfWkq68t', permissions: ['initiate', 'vote', 'execute'] }]);
        const remove = decode('squads-remove-member-proposed').uses[0];
        expect(remove.detail.actions).toEqual([{ type: 'RemoveMember', member: 'FnZHJQKXADcMrqB64pLRQ6FnSaVWZEDXnMCqqQ4WkPeK' }]);
        const threshold = decode('squads-threshold-proposed').uses[0];
        expect(threshold.authority).toBe(ONDO_FREEZE_MULTISIG);
        expect(threshold.detail.actions).toEqual([{ type: 'ChangeThreshold', threshold: 3 }]);
        expect(classifyUse(threshold, new Map())).toMatchObject({ severity: 'info', holderAffecting: false });
    });

    it('an execution names the proposal\'s config transaction, so the two can be joined', () => {
        const proposed = decode('squads-remove-member-proposed').uses[0];
        const executed = decode('squads-remove-member-executed').uses[0];
        expect(executed.action).toBe('squads-config-executed');
        expect(executed.targetAccount).toBe(proposed.targetAccount);
        expect(classifyUse(executed, new Map())).toMatchObject({ severity: 'warning' });
        const t = decode('squads-threshold-executed').uses[0];
        expect(t.targetAccount).toBe(decode('squads-threshold-proposed').uses[0].targetAccount);
    });

    it('a multisig the run does not watch yields nothing', () => {
        expect(decode('squads-threshold-proposed', { multisigs: new Set() }).uses).toEqual([]);
    });

    it('decodes every ConfigAction variant and refuses a truncated one', () => {
        const k = Buffer.alloc(32, 7);
        const parts = [Buffer.from([4, 0, 0, 0]),
            Buffer.from([2]), Buffer.from([2, 0]),
            Buffer.from([3]), Buffer.from([0x80, 0x51, 0x01, 0x00]),
            Buffer.from([5]), k,
            Buffer.from([6, 0])];
        const { actions } = decodeConfigActions(Buffer.concat(parts), 0);
        expect(actions).toEqual([{ type: 'ChangeThreshold', threshold: 2 }, { type: 'SetTimeLock', timeLockSeconds: 86400 },
            { type: 'RemoveSpendingLimit', spendingLimit: base58Encode(k) }, { type: 'SetRentCollector', rentCollector: null }]);
        expect(() => decodeConfigActions(Buffer.from([1, 0, 0, 0, 2, 5]), 0)).toThrow(/truncated/);
        expect(() => decodeConfigActions(Buffer.from([1, 0, 0, 0, 9]), 0)).toThrow(/variant 9/);
        // multisig_set_time_lock (a config authority acting directly)
        const direct = decodeSquadsInstruction(Buffer.concat([Buffer.from('949a794dd4fe9b48', 'hex'), Buffer.from([0x10, 0x0e, 0, 0, 0])]), ['M', 'A']);
        expect(direct).toMatchObject({ name: 'multisig_set_time_lock', multisig: 'M', configAuthority: 'A', actions: [{ type: 'SetTimeLock', timeLockSeconds: 3600 }] });
    });
});

describe('instructions the RPC did not parse are decoded from their bytes', () => {
    it('reads raw FreezeAccount, Pause, UpdateMultiplier and SetTransferFee layouts', () => {
        expect(decodeTokenRaw([10], ['acc', 'mint', 'auth'])).toEqual({ type: 'freezeAccount', info: { account: 'acc', mint: 'mint', freezeAuthority: 'auth' } });
        expect(decodeTokenRaw([41, 1], ['mint', 'auth'])).toEqual({ type: 'pause', info: { mint: 'mint', authority: 'auth' } });
        expect(decodeTokenRaw([41, 2], ['mint', 'auth']).type).toBe('resume');
        const mult = Buffer.alloc(18); mult[0] = 40; mult[1] = 1; mult.writeDoubleLE(1.0125, 2); mult.writeBigInt64LE(1790000000n, 10);
        expect(decodeTokenRaw(mult, ['mint', 'auth']).info).toEqual({ mint: 'mint', authority: 'auth', newMultiplier: '1.0125', newMultiplierTimestamp: 1790000000 });
        const fee = Buffer.alloc(12); fee[0] = 23; fee[1] = 5; fee.writeUInt16LE(50, 2); fee.writeBigUInt64LE(1000000n, 4);
        expect(decodeTokenRaw(fee, ['mint', 'auth']).info).toMatchObject({ transferFeeBasisPoints: 50, maximumFee: '1000000' });
        const burn = Buffer.alloc(9); burn[0] = 8; burn.writeBigUInt64LE(42n, 1);
        expect(decodeTokenRaw(burn, ['acc', 'mint', 'auth']).info.amount).toBe('42');
        expect(decodeTokenRaw([9], ['a'])).toBeNull(); // CloseAccount: not a power this watcher reads
    });

    it('decodes the Tessera freeze the same way when the instruction arrives unparsed', () => {
        const tx = fixture('tessera-freeze');
        const i = tx.transaction.message.instructions.findIndex((ix) => ix.parsed?.type === 'freezeAccount');
        const info = tx.transaction.message.instructions[i].parsed.info;
        tx.transaction.message.instructions[i] = { programId: tx.transaction.message.instructions[i].programId,
            accounts: [info.account, info.mint, info.freezeAuthority], data: base58Encode([10]) };
        const raw = decodePowerUses(tx, { byMint: WATCH.byMint, watched: WATCHED, multisigs: MULTISIGS }).uses;
        const parsed = decode('tessera-freeze').uses;
        expect(raw).toEqual(parsed);
    });
});

describe('budget and checkpoints', () => {
    const sig = (s, slot, err = null) => ({ signature: s, slot, blockTime: 1790000000 + slot, err });

    it('reads holder-power addresses first, oldest first, each shared transaction once, failed ones never', () => {
        const listings = new Map([
            ['routine', { priority: 2, pending: [sig('r1', 1), sig('shared', 5)] }],
            ['freeze', { priority: 1, pending: [sig('f1', 3), sig('bad', 4, { InstructionError: [0, 'x'] }), sig('shared', 5)] }]
        ]);
        expect(planReads(listings, { budget: 10 })).toEqual({ toRead: ['f1', 'shared', 'r1'], backlog: 0 });
        expect(planReads(listings, { budget: 2 })).toEqual({ toRead: ['f1', 'shared'], backlog: 1 });
    });

    it('a checkpoint never passes an unread signature', () => {
        const pending = [sig('a', 1), sig('b', 2, { err: 1 }), sig('c', 3), sig('d', 4)];
        expect(committedPrefix(pending, new Set(['a', 'd'])).map((s) => s.signature)).toEqual(['a', 'b']);
        expect(committedPrefix(pending, new Set(['a', 'c', 'd'])).map((s) => s.signature)).toEqual(['a', 'b', 'c', 'd']);
        expect(committedPrefix(pending, new Set())).toEqual([]);
    });
});

describe('storing', () => {
    it('rolls routine uses up per day and sums raw amounts without floats', () => {
        const u = (s, t, amt) => ({ use: { signature: s, blockTime: t, mint: 'M', authority: 'A', amountRaw: amt }, cls: { action: 'mint', targetKind: 'other' } });
        const rows = rollupRoutine([u('x', '2026-09-30T01:00:00Z', '9007199254740993'), u('y', '2026-09-30T02:00:00Z', '7'), u('z', '2026-10-01T00:00:01Z', '1')]);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ day: '2026-09-30', uses: 2, amountRaw: '9007199254741000', firstSignature: 'x', lastSignature: 'y' });
        expect(rows[1]).toMatchObject({ day: '2026-10-01', uses: 1 });
    });

    it('builds idempotent use and scan upserts, and an additive daily upsert', () => {
        expect(buildUseSql([])).toBeNull();
        const use = buildUseSql([{ signature: 's', ixIndex: 0, detail: { note: "it's" } }]);
        expect(use).toMatch(/ON CONFLICT \(signature, ix_index\) DO UPDATE/);
        expect(use).toMatch(/IS DISTINCT FROM/);
        expect(buildDailySql([{ day: '2026-09-30' }])).toMatch(/uses = t\.uses \+ EXCLUDED\.uses/);
        expect(buildScanSql([{ address: 'a', roles: ['freeze'] }])).toMatch(/ON CONFLICT \(address\)/);
    });

    it('formats base units with BigInt, never through a float', () => {
        expect(unitsToDecimal('25100500000', 6)).toBe('25100.5');
        expect(unitsToDecimal('5', 9)).toBe('0.000000005');
        expect(unitsToDecimal('123456789012345678901', 0)).toBe('123456789012345678901');
        expect(unitsToDecimal(null, 6)).toBeNull();
        expect(unitsToDecimal('12', null)).toBeNull();
    });

    it('sends one message only for a holder-affecting use above info, or a failure', () => {
        const thaw = { holderAffecting: true, severity: 'info', issuer: 'bullish', action: 'thaw' };
        const burn = { holderAffecting: true, severity: 'critical', issuer: 'bullish', action: 'forced-burn', signature: 'S', blockTime: 't', symbol: 'BLSH' };
        expect(summaryText({ holderRows: [thaw], failures: [] })).toBeNull();
        expect(summaryText({ holderRows: [], failures: ['list x: boom'] })).toMatch(/1 failure/);
        const text = summaryText({ holderRows: [thaw, burn], failures: [] });
        expect(text).toMatch(/2 holder-affecting/);
        expect(text).toMatch(/solscan\.io\/tx\/S/);
    });
});
