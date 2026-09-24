// Unit tests for stocks/lib/chainwatch.mjs — the hourly on-chain watcher's decisions. Every test
// asserts something a reader of the change feed would notice if it broke: that a real mint account
// flattens into the state the DB stores, that a state hash does not depend on how the object was
// built, that each EVIDENCE.md §3 kind fires on its own field and only past its threshold, that a
// first sight is a baseline rather than 471 spurious events, and that the SQL actually names the
// columns it claims to.
//
// The mint accounts in fixtures/mint-account.sample.json are REAL getMultipleAccounts(jsonParsed)
// payloads captured from the RPC on 2026-09-17: USDC (an SPL-token mint with no extensions at all),
// TSLAx (Kraken xStocks, eight extensions), PreStocks POLYMARKET (ten, including the transfer fee
// with its withheld amount and both authorities) and Ondo AAPLon (a live scaled-UI multiplier with
// a scheduled change, which is the field most easily mis-parsed).

import { readFileSync } from 'node:fs';

import {
    AUTHORITY_FIELDS, COMPARABLE_COLUMNS, MINT_STATE_COLUMNS, THRESHOLDS, TOGGLE_FIELDS,
    baselineEvents, buildLatestBalanceQuery, buildLatestStateQuery, buildMintStateSql,
    buildWalletBalanceSql, buildWalletIndex, countBy, diffStates, formatTelegramSummary, intOrNull,
    movePct, normaliseTimestamp, numericString, parseMintState, parseStateRows,
    selectMetadataFetches, selectWatchedWallets, stateHash, topEvents, uiAmount, unixToIso,
    walletMoves
} from './lib/chainwatch.mjs';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/mint-account.sample.json', import.meta.url), 'utf8'));
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TSLAX = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';
const POLYMARKET = 'Pre8AREmFPtoJFT8mQSXQLh56cwJmM7CFDRuoGBZiUP';
const AAPLON = '123mYEnRLM2LLYsJW3K6oyYh8uP1fngj732iG638ondo';
const AT = '2026-09-18T10:00:00Z';
const EARLIER = '2026-09-18T09:00:00Z';

function parse(mint, extra = {}) {
    return parseMintState(FIXTURE.accounts[mint], {
        mint, slot: FIXTURE.context.slot, observedAt: AT, ...extra
    });
}

describe('parseMintState on real accounts', () => {
    test('a plain SPL-token mint yields the mint facts and every extension field null', () => {
        const state = parse(USDC);
        expect(state.mint).toBe(USDC);
        expect(state.tokenProgram).toBe('spl-token');
        expect(state.decimals).toBe(6);
        // The supply is a u64 that does not fit a double exactly: it must survive as a string.
        expect(state.supply).toBe(FIXTURE.accounts[USDC].data.parsed.info.supply);
        expect(typeof state.supply).toBe('string');
        expect(state.mintAuthority).toBe('BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG');
        // No extensions at all, so nothing may be invented — and `paused` must be null, not false:
        // a mint that CANNOT be paused is not the same fact as one that is currently unpaused.
        expect(state.pausable).toBe(false);
        expect(state.paused).toBeNull();
        expect(state.permanentDelegate).toBeNull();
        expect(state.hookProgram).toBeNull();
        expect(state.hookAuthority).toBeNull();
        expect(state.transferFeeBps).toBeNull();
        expect(state.transferFeeMax).toBeNull();
        expect(state.withheld).toBeNull();
        expect(state.uiMultiplier).toBeNull();
        expect(state.uiMultiplierEffectiveAt).toBeNull();
        expect(state.metadataUri).toBeNull();
        expect(state.metadataHash).toBeNull();
    });

    test('an xStocks mint yields its pausable, delegate, hook and multiplier state', () => {
        const state = parse(TSLAX);
        expect(state.tokenProgram).toBe('token-2022');
        expect(state.decimals).toBe(8);
        expect(state.pausable).toBe(true);
        expect(state.paused).toBe(false);
        expect(state.permanentDelegate).toBe('5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq');
        // The hook extension is present with no program: "configured but inactive" must read as
        // hook_program null and a hook AUTHORITY that exists — the authority is who can switch it on.
        expect(state.hookProgram).toBeNull();
        expect(state.hookAuthority).toBe('5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq');
        expect(state.uiMultiplier).toBe('1');
        // The scaled-UI authority is a DIFFERENT key from the mint and hook authorities on this
        // mint, which is the whole reason each authority gets its own column: folding them into one
        // "who controls this" field would hide a rotation of any but the first.
        expect(state.uiMultiplierAuthority).toBe('S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS');
        expect(state.mintAuthority).toBe('7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj');
        expect(state.metadataUri).toMatch(/^https:\/\//);
        expect(state.metadataUpdateAuthority).toBe('5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq');
        expect(state.slot).toBe(FIXTURE.context.slot);
        expect(state.observedAt).toBe(AT);
    });

    test('a fee-bearing mint yields the bps, the cap, the withheld amount and both fee authorities', () => {
        const state = parse(POLYMARKET);
        expect(state.transferFeeBps).toBe(50);
        // maximumFee is u64::MAX ("no cap"), which the RPC sends as a JSON number and JSON.parse
        // rounds to the double 1.8446744073709552e19 before this code ever sees it. What matters is
        // that it is stored as DIGITS and the same digits every run: `1.8446744073709552e+19` is not
        // something `(r->>'x')::numeric` accepts, and a hash that depended on how JS printed a double
        // would report a change that never happened. The digits are the double's exact value.
        expect(state.transferFeeMax).toBe('18446744073709551616');
        expect(state.transferFeeMax).not.toMatch(/e/i);
        expect(numericString(state.withheld)).toBe(state.withheld);
        expect(state.feeConfigAuthority).toBe('WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc');
        expect(state.withdrawWithheldAuthority).toBe('WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc');
        // The epoch the newer fee applies from: Token-2022 sets it two epochs ahead, so the feed can
        // say "scheduled" rather than "raised" while it is still in the future.
        expect(state.transferFeeEpoch).toBe(1032);
        expect(state.defaultFrozen).toBe(false);
        // This mint has no scheduled multiplier change: Token-2022 spells that as timestamp 0, and
        // 0 must not become 1970-01-01 (see `unixToIso`).
        expect(state.uiMultiplierEffectiveAt).toBeNull();
    });

    test('a mint with a live multiplier keeps its digits and its scheduled date', () => {
        const state = parse(AAPLON);
        // 1.003376073740221 is 16 significant digits: through a double and back it would still
        // print the same, but through a jsonb NUMBER it would not — hence the ::text casts.
        expect(state.uiMultiplier).toBe('1.003376073740221');
        expect(state.uiMultiplierNext).toBe('1.003376073740221');
        expect(state.uiMultiplierEffectiveAt).toBe(unixToIso(1788344044));
        expect(state.uiMultiplierEffectiveAt).toBe('2026-09-02T10:14:04Z');
        expect(state.uiMultiplierAuthority).toBe('9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD');
        // Ondo's hook extension is configured with no program, and its freeze authority is a key
        // of its own — both are the live values on 2026-09-17.
        expect(state.hookProgram).toBeNull();
        expect(state.freezeAuthority).toBe('51QVCuHfL1FeNjd8BDeffCKhCcAYoULnVB3yjNhShiuK');
    });

    test('every state carries exactly the js keys the mint_state columns need', () => {
        const state = parse(POLYMARKET);
        for (const [, jsKey] of MINT_STATE_COLUMNS) {
            if (jsKey === 'stateHash') continue; // set by the run once the metadata hash is known
            expect(Object.prototype.hasOwnProperty.call(state, jsKey)).toBe(true);
        }
    });

    test('a null account or an empty object yields nulls, never zeros', () => {
        const state = parseMintState(null, { mint: 'x' });
        expect(state.supply).toBeNull();
        expect(state.decimals).toBeNull();
        expect(state.transferFeeBps).toBeNull();
    });
});

describe('stateHash', () => {
    test('is stable across key order and across a rebuild of the same values', () => {
        const a = parse(TSLAX);
        const shuffled = {};
        for (const key of Object.keys(a).sort().reverse()) shuffled[key] = a[key];
        expect(stateHash(shuffled)).toBe(stateHash(a));
    });

    test('ignores the columns that describe the reading rather than the state', () => {
        const a = parse(TSLAX);
        const later = { ...a, observedAt: '2026-10-01T00:00:00Z', slot: a.slot + 5000 };
        expect(stateHash(later)).toBe(stateHash(a));
        expect(COMPARABLE_COLUMNS.map(([c]) => c)).not.toContain('slot');
        expect(COMPARABLE_COLUMNS.map(([c]) => c)).not.toContain('observed_at');
        expect(COMPARABLE_COLUMNS.map(([c]) => c)).not.toContain('state_hash');
    });

    test('moves when any comparable field moves, including a metadata hash filled in', () => {
        const a = parse(TSLAX);
        expect(stateHash({ ...a, paused: true })).not.toBe(stateHash(a));
        expect(stateHash({ ...a, supply: '1' })).not.toBe(stateHash(a));
        expect(stateHash({ ...a, metadataHash: 'abc' })).not.toBe(stateHash(a));
    });

    test('a false boolean and a null are different states', () => {
        const a = parse(TSLAX);
        expect(stateHash({ ...a, paused: null })).not.toBe(stateHash({ ...a, paused: false }));
    });

    test('two different mints with the same comparable state hash the same — the mint is not hashed', () => {
        // Which is the point: the hash answers "did THIS mint's state change", and the mint is the
        // key the comparison is made under, so hashing it as well would only hide a bug in the key.
        const a = parse(TSLAX);
        expect(stateHash({ ...a, mint: 'somethingelse' })).toBe(stateHash(a));
    });
});

describe('value normalisation', () => {
    test('numericString never turns a missing value into a number', () => {
        expect(numericString(null)).toBeNull();
        expect(numericString(undefined)).toBeNull();
        expect(numericString('')).toBeNull();
        expect(numericString('n/a')).toBeNull();
        expect(numericString(Number.NaN)).toBeNull();
        expect(numericString(Infinity)).toBeNull();
        expect(numericString(0)).toBe('0');
        expect(numericString('1.003376073740221')).toBe('1.003376073740221');
    });

    test('intOrNull does not coerce null to 0', () => {
        expect(intOrNull(null)).toBeNull();
        expect(intOrNull('')).toBeNull();
        expect(intOrNull(false)).toBeNull();
        expect(intOrNull(0)).toBe(0);
        expect(intOrNull('50')).toBe(50);
    });

    test('unixToIso treats 0 as "unset" and refuses an absurd timestamp', () => {
        expect(unixToIso(0)).toBeNull();
        expect(unixToIso(null)).toBeNull();
        expect(unixToIso(9_999_999_999_999)).toBeNull();
        expect(unixToIso(1788344044)).toBe('2026-09-02T10:14:04Z');
    });

    test('uiAmount applies the decimals without floating point drift', () => {
        expect(uiAmount('22963694377459', 8)).toBe('229636.94377459');
        expect(uiAmount('1', 9)).toBe('0.000000001');
        expect(uiAmount('1000000000', 9)).toBe('1');
        expect(uiAmount('0', 9)).toBe('0');
        expect(uiAmount(null, 9)).toBeNull();
        expect(uiAmount('5', null)).toBe('5');
    });

    test('movePct uses integer arithmetic for a u64 supply', () => {
        expect(movePct('1000000000000000000', '1010000000000000000')).toBeCloseTo(1, 6);
        expect(movePct('100', '90')).toBeCloseTo(10, 6);
        expect(movePct('0', '5')).toBe(Infinity);
        expect(movePct('0', '0')).toBe(0);
        expect(movePct(null, '5')).toBeNull();
    });

    test('normaliseTimestamp makes psql and the RPC agree on one spelling', () => {
        expect(normaliseTimestamp('2026-09-18T10:00:00+00:00')).toBe(AT);
        expect(normaliseTimestamp('2026-09-18 10:00:00+00')).toBe(AT);
        expect(normaliseTimestamp(null)).toBeNull();
        expect(normaliseTimestamp('not a date')).toBeNull();
    });
});

describe('diffStates', () => {
    const base = () => ({ ...parse(TSLAX), observedAt: EARLIER });
    const next = (changes) => ({ ...parse(TSLAX), ...changes });

    test('a first sight raises nothing at all', () => {
        expect(diffStates(null, parse(TSLAX))).toEqual([]);
    });

    test('an identical state raises nothing', () => {
        expect(diffStates(base(), parse(TSLAX))).toEqual([]);
    });

    test('every authority field rotating is one authority-key warning each', () => {
        for (const [column, key] of AUTHORITY_FIELDS) {
            const events = diffStates(base(), next({ [key]: 'RotatedKey1111111111111111111111111111111' }));
            const found = events.filter((e) => e.field === column);
            expect(found).toHaveLength(1);
            expect(found[0].kind).toBe('authority-key');
            expect(found[0].severity).toBe('warning');
            expect(found[0].after).toBe('RotatedKey1111111111111111111111111111111');
        }
    });

    test('an authority being revoked to null is still an authority-key event', () => {
        const events = diffStates(base(), next({ mintAuthority: null }));
        expect(events).toHaveLength(1);
        expect(events[0].kind).toBe('authority-key');
        expect(events[0].before).toBe('7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj');
        expect(events[0].after).toBeNull();
    });

    test('pausing, freezing by default and a fee appearing are extension-toggle warnings', () => {
        expect(diffStates(base(), next({ paused: true }))[0]).toMatchObject({
            kind: 'extension-toggle', field: 'paused', before: 'false', after: 'true', severity: 'warning'
        });
        expect(diffStates(base(), next({ defaultFrozen: true }))[0]).toMatchObject({
            kind: 'extension-toggle', field: 'default_frozen', severity: 'warning'
        });
        expect(diffStates(base(), next({ transferFeeBps: 50 }))[0]).toMatchObject({
            kind: 'extension-toggle', field: 'transfer_fee_bps', before: null, after: '50'
        });
        // A fee row carries when the new fee applies and its cap; other rows do not.
        const fee = diffStates(base(), next({ transferFeeBps: 300, transferFeeEpoch: 1043, transferFeeMax: '18446744073709551616', paused: true }));
        expect(fee.find((e) => e.field === 'transfer_fee_bps').evidence.transferFee).toEqual({ newerEpoch: 1043, maximumFee: '18446744073709551616' });
        expect(fee.find((e) => e.field === 'paused').evidence.transferFee).toBeUndefined();
        for (const [column] of TOGGLE_FIELDS) {
            expect(typeof column).toBe('string');
        }
    });

    test('a transfer hook switched on is a toggle; one program swapped for another is a rotation', () => {
        const on = diffStates(base(), next({ hookProgram: 'Hook1111111111111111111111111111111111111' }));
        expect(on).toHaveLength(1);
        expect(on[0]).toMatchObject({ kind: 'extension-toggle', field: 'hook_program', severity: 'warning' });
        expect(on[0].summary).toMatch(/switched on/);

        const off = diffStates({ ...base(), hookProgram: 'Hook1111111111111111111111111111111111111' },
            next({ hookProgram: null }));
        expect(off[0]).toMatchObject({ kind: 'extension-toggle', field: 'hook_program' });
        expect(off[0].summary).toMatch(/switched off/);

        const rotated = diffStates({ ...base(), hookProgram: 'Hook1111111111111111111111111111111111111' },
            next({ hookProgram: 'Hook2222222222222222222222222222222222222' }));
        expect(rotated[0]).toMatchObject({ kind: 'authority-key', field: 'hook_program', severity: 'warning' });
        expect(rotated[0].summary).toMatch(/rotated/);
    });

    test('a rebase is caution below the ratio thresholds and warning at or past them', () => {
        const from = { ...base(), uiMultiplier: '1', uiMultiplierNext: '1' };
        const small = diffStates(from, next({ uiMultiplier: '1.02', uiMultiplierNext: '1.02' }));
        expect(small.filter((e) => e.field === 'ui_multiplier')[0]).toMatchObject({
            kind: 'rebase', severity: 'caution'
        });

        const up = diffStates(from, next({ uiMultiplier: '1.05', uiMultiplierNext: '1.05' }));
        expect(up.filter((e) => e.field === 'ui_multiplier')[0].severity).toBe('warning');
        expect(THRESHOLDS.rebaseWarnRatioUp).toBe(1.05);

        const down = diffStates(from, next({ uiMultiplier: '0.5', uiMultiplierNext: '0.5' }));
        expect(down.filter((e) => e.field === 'ui_multiplier')[0].severity).toBe('warning');

        const justUnder = diffStates(from, next({ uiMultiplier: '0.51', uiMultiplierNext: '0.51' }));
        expect(justUnder.filter((e) => e.field === 'ui_multiplier')[0].severity).toBe('caution');
    });

    test('a scheduled multiplier and its effective date are rebase events of their own', () => {
        const from = { ...base(), uiMultiplier: '1', uiMultiplierNext: '1', uiMultiplierEffectiveAt: null };
        const events = diffStates(from, next({
            uiMultiplier: '1', uiMultiplierNext: '2', uiMultiplierEffectiveAt: '2026-10-01T00:00:00Z'
        }));
        const fields = events.map((e) => e.field).sort();
        expect(fields).toEqual(['ui_multiplier_effective_at', 'ui_multiplier_next']);
        expect(events.every((e) => e.kind === 'rebase')).toBe(true);
        // A 2x announced against a multiplier of 1 is past the up threshold, so it is a warning
        // BEFORE it takes effect — which is the whole point of watching the scheduled value.
        expect(events.find((e) => e.field === 'ui_multiplier_next').severity).toBe('warning');
    });

    test('supply moves under 1 % are not events, 1 % is info and 10 % is caution', () => {
        const from = { ...base(), supply: '1000000' };
        expect(diffStates(from, next({ supply: '1009999' }))).toEqual([]);
        expect(diffStates(from, next({ supply: '1010000' }))[0]).toMatchObject({
            kind: 'supply', field: 'supply', severity: 'info'
        });
        expect(diffStates(from, next({ supply: '1100000' }))[0].severity).toBe('caution');
        expect(diffStates(from, next({ supply: '500000' }))[0].severity).toBe('caution');
        expect(diffStates(from, next({ supply: '500000' }))[0].summary).toMatch(/down/);
        expect(THRESHOLDS.supplyInfoPct).toBe(1);
        expect(THRESHOLDS.supplyCautionPct).toBe(10);
    });

    test('a supply appearing from zero is reported rather than divided by zero', () => {
        const events = diffStates({ ...base(), supply: '0' }, next({ supply: '1000' }));
        expect(events).toHaveLength(1);
        expect(events[0].summary).toMatch(/from zero/);
    });

    test('the metadata URI moving is a caution; the document hash only once we have both', () => {
        const uri = diffStates(base(), next({ metadataUri: 'https://elsewhere/x.json' }));
        expect(uri[0]).toMatchObject({ kind: 'metadata', field: 'metadata_uri', severity: 'caution' });

        // null -> hash is the first fetch, not a change: it must NOT raise an event.
        const firstFetch = diffStates({ ...base(), metadataHash: null }, next({ metadataHash: 'a'.repeat(64) }));
        expect(firstFetch.filter((e) => e.field === 'metadata_hash')).toEqual([]);

        const moved = diffStates({ ...base(), metadataHash: 'a'.repeat(64) },
            next({ metadataHash: 'b'.repeat(64) }));
        expect(moved[0]).toMatchObject({ kind: 'metadata', field: 'metadata_hash', severity: 'caution' });
    });

    test('decimals changing is critical, because every balance has been re-denominated', () => {
        const events = diffStates(base(), next({ decimals: 6 }));
        expect(events[0]).toMatchObject({ kind: 'rebase', field: 'decimals', severity: 'critical' });
    });

    test('every event carries the slot, the observed_at pair and the account as evidence', () => {
        const events = diffStates(base(), next({ paused: true }),
            { symbol: 'TSLAx', issuer: 'xstocks-backed' });
        expect(events[0].subjectType).toBe('token');
        expect(events[0].subjectId).toBe(TSLAX);
        expect(events[0].detectedAt).toBe(AT);
        expect(events[0].evidence).toMatchObject({
            account: TSLAX,
            slot: FIXTURE.context.slot,
            observedAt: AT,
            previousObservedAt: EARLIER,
            symbol: 'TSLAx',
            issuer: 'xstocks-backed'
        });
        expect(events[0].summary).toMatch(/TSLAx/);
    });

    test('several fields moving at once yield several events, one per field', () => {
        const events = diffStates(base(), next({
            paused: true, mintAuthority: null, supply: '1', metadataUri: 'https://x/y.json'
        }));
        expect(events.map((e) => e.field).sort())
            .toEqual(['metadata_uri', 'mint_authority', 'paused', 'supply']);
    });
});

describe('baselineEvents', () => {
    test('one info event per issuer, whatever the number of mints', () => {
        const events = baselineEvents([
            { mint: 'a', issuer: 'ondo-global-markets', slot: 1, observedAt: AT },
            { mint: 'b', issuer: 'ondo-global-markets', slot: 1, observedAt: AT },
            { mint: 'c', issuer: 'xstocks-backed', slot: 1, observedAt: AT }
        ], { detectedAt: AT });
        expect(events).toHaveLength(2);
        expect(events.map((e) => e.subjectId)).toEqual(['ondo-global-markets', 'xstocks-backed']);
        expect(events[0]).toMatchObject({
            kind: 'status', subjectType: 'issuer', field: 'chain-watch', severity: 'info', after: 'baseline'
        });
        expect(events[0].evidence.mintCount).toBe(2);
        expect(events[0].summary).toMatch(/baseline recorded: 2 mint/);
    });

    test('a mint with no issuer is attributed to nobody rather than to the first issuer seen', () => {
        const events = baselineEvents([{ mint: 'a', issuer: null, slot: 1, observedAt: AT }]);
        expect(events[0].subjectId).toBe('unattributed');
    });

    test('no first sights, no events', () => {
        expect(baselineEvents([])).toEqual([]);
    });
});

describe('labelled wallets', () => {
    const labels = new Map([
        ['AuthorityA11111111111111111111111111111111', 'issuer-authority'],
        ['AuthorityB11111111111111111111111111111111', 'issuer-authority'],
        ['Burn11111111111111111111111111111111111111', 'burn-address']
    ]);
    const onchain = [
        { mint: 'm1', issuer: 'ondo-global-markets', mintAuthority: 'AuthorityA11111111111111111111111111111111' },
        { mint: 'm2', issuer: 'ondo-global-markets', mintAuthority: 'AuthorityA11111111111111111111111111111111' },
        { mint: 'm3', issuer: 'xstocks-backed', freezeAuthority: 'AuthorityB11111111111111111111111111111111' },
        { mint: 'm4', issuer: 'prestocks', freezeAuthority: 'AuthorityB11111111111111111111111111111111' }
    ];

    test('the index records which mints an address controls and attributes the issuer', () => {
        const index = buildWalletIndex(labels, onchain, {});
        expect(index.get('AuthorityA11111111111111111111111111111111').mints).toEqual(['m1', 'm2']);
        expect(index.get('AuthorityA11111111111111111111111111111111').issuer).toBe('ondo-global-markets');
        // Authority over two issuers' mints is attributed to neither, not to whichever came first.
        expect(index.get('AuthorityB11111111111111111111111111111111').issuer).toBe('shared');
        expect(index.get('Burn11111111111111111111111111111111111111').mints).toEqual([]);
    });

    test('a key classify.mjs names outright keeps that issuer whatever it controls', () => {
        const index = buildWalletIndex(labels, onchain,
            { 'AuthorityB11111111111111111111111111111111': 'superstate-opening-bell' });
        expect(index.get('AuthorityB11111111111111111111111111111111').issuer).toBe('superstate-opening-bell');
        expect(index.get('AuthorityB11111111111111111111111111111111').named).toBe(true);
    });

    test('the cap keeps the named keys and the busiest authorities, deterministically', () => {
        const index = buildWalletIndex(labels, onchain,
            { 'Burn11111111111111111111111111111111111111': 'superstate-opening-bell' });
        const { watched, skipped } = selectWatchedWallets(index, { limit: 2 });
        expect(watched.map((w) => w.wallet)).toEqual([
            'Burn11111111111111111111111111111111111111',      // named outright
            'AuthorityA11111111111111111111111111111111'       // 2 mints, ties broken by address
        ]);
        expect(skipped).toBe(1);
        // Same input, same order: a Map's iteration order must not decide who gets watched.
        expect(selectWatchedWallets(index, { limit: 2 }).watched.map((w) => w.wallet))
            .toEqual(watched.map((w) => w.wallet));
    });
});

describe('selectMetadataFetches', () => {
    const states = [
        { mint: 'b', metadataUri: 'https://x/b.json' },
        { mint: 'a', metadataUri: 'https://x/a.json' },
        { mint: 'c', metadataUri: null },
        { mint: 'd', metadataUri: 'https://x/d.json' }
    ];

    test('mints never hashed and mints whose URI moved, URI moves first', () => {
        const previous = new Map([
            ['a', { mint: 'a', metadataUri: 'https://x/a.json', metadataHash: 'a'.repeat(64) }],
            ['d', { mint: 'd', metadataUri: 'https://OLD/d.json', metadataHash: 'd'.repeat(64) }]
        ]);
        const wanted = selectMetadataFetches(states, previous, { limit: 10 });
        expect(wanted.map((w) => w.mint)).toEqual(['d', 'b']);
        expect(wanted[0].uriMoved).toBe(true);
    });

    test('a mint with no URI is never fetched, and the cap is respected in a stable order', () => {
        const wanted = selectMetadataFetches(states, new Map(), { limit: 2 });
        expect(wanted.map((w) => w.mint)).toEqual(['a', 'b']);
        expect(wanted.some((w) => w.mint === 'c')).toBe(false);
    });
});

describe('walletMoves', () => {
    const wallet = 'AuthorityA11111111111111111111111111111111';
    const token = (amount, observedAt = AT) => ({ wallet, mint: 'm1', label: 'issuer-authority', amount, observedAt });
    const sol = (amount, observedAt = AT) => ({ wallet, mint: null, label: 'issuer-authority', amount, observedAt });

    test('a token position moving under 5 % is not an event; 5 % is info and 25 % caution', () => {
        expect(walletMoves([token('1000', EARLIER)], [token('1049')])).toEqual([]);
        const info = walletMoves([token('1000', EARLIER)], [token('1050')]);
        expect(info[0]).toMatchObject({ kind: 'treasury', severity: 'info', subjectType: 'token', subjectId: 'm1' });
        expect(info[0].field).toBe(`treasury:${wallet}`);
        expect(walletMoves([token('1000', EARLIER)], [token('1250')])[0].severity).toBe('caution');
        expect(walletMoves([token('1000', EARLIER)], [token('700')])[0].severity).toBe('caution');
        expect(THRESHOLDS.treasuryInfoPct).toBe(5);
        expect(THRESHOLDS.treasuryCautionPct).toBe(25);
    });

    test('SOL is judged in whole SOL, not in percent', () => {
        expect(walletMoves([sol('1000', EARLIER)], [sol('1099')])).toEqual([]);
        const info = walletMoves([sol('1000', EARLIER)], [sol('1100')]);
        expect(info[0]).toMatchObject({ kind: 'treasury', severity: 'info', subjectType: 'issuer' });
        expect(info[0].field).toBe(`sol:${wallet}`);
        expect(THRESHOLDS.solMove).toBe(100);
        // 100 SOL out of 200 is both past the absolute floor and a quarter of the balance.
        expect(walletMoves([sol('200', EARLIER)], [sol('100')])[0].severity).toBe('caution');
        // A 1 % move of a huge float is past 100 SOL but not a quarter: info, not caution.
        expect(walletMoves([sol('100000', EARLIER)], [sol('99000')])[0].severity).toBe('info');
    });

    test('a SOL event is attributed to the issuer that owns the key, else to shared', () => {
        const attributed = walletMoves([sol('1000', EARLIER)], [sol('1200')],
            { issuerByWallet: { [wallet]: 'ondo-global-markets' } });
        expect(attributed[0].subjectId).toBe('ondo-global-markets');
        expect(walletMoves([sol('1000', EARLIER)], [sol('1200')])[0].subjectId).toBe('shared');
    });

    test('the first reading of a position is not a move', () => {
        expect(walletMoves([], [token('1000'), sol('5000')])).toEqual([]);
    });

    test('a missing amount is never read as zero', () => {
        expect(walletMoves([token(null, EARLIER)], [token('1000')])).toEqual([]);
        expect(walletMoves([token('1000', EARLIER)], [token(null)])).toEqual([]);
    });

    test('a position appearing from nothing is reported with its evidence', () => {
        const events = walletMoves([token('0', EARLIER)], [token('500')]);
        expect(events).toHaveLength(1);
        expect(events[0].severity).toBe('caution');
        expect(events[0].evidence).toMatchObject({
            account: wallet, mint: 'm1', label: 'issuer-authority',
            observedAt: AT, previousObservedAt: EARLIER, rpc: 'getTokenAccountsByOwner'
        });
    });
});

describe('SQL builders', () => {
    const state = () => ({ ...parse(TSLAX), stateHash: 'f'.repeat(64) });

    test('the mint_state insert names every column and inserts a reading only once', () => {
        const built = buildMintStateSql([state()]);
        expect(built.table).toBe('sonar.mint_state');
        expect(built.rows).toBe(1);
        for (const [column] of MINT_STATE_COLUMNS) expect(built.sql).toContain(column);
        expect(built.sql).toContain('ON CONFLICT (mint, observed_at) DO NOTHING');
        // Numbers must be cast from jsonb TEXT, never read as a jsonb number.
        expect(built.sql).toContain("(r->>'supply')::numeric");
        expect(built.sql).toContain("(r->>'slot')::bigint");
        expect(built.sql).toContain("(r->>'observedAt')::timestamptz");
        expect(built.sql).toContain(TSLAX);
    });

    test('the same mint offered twice in one run is one row, the last one winning', () => {
        const built = buildMintStateSql([state(), state()]);
        expect(built.rows).toBe(1);
        expect(built.sql).toContain('DISTINCT ON');
    });

    test('the wallet_balance insert dedupes on the expression index, so a SOL row can have no mint', () => {
        const built = buildWalletBalanceSql([
            { wallet: 'w1', mint: null, label: 'burn-address', observedAt: AT, amount: '12.5' },
            { wallet: 'w1', mint: 'm1', label: 'burn-address', observedAt: AT, amount: '3' }
        ]);
        expect(built.rows).toBe(2);
        expect(built.sql).toContain("ON CONFLICT (wallet, coalesce(mint, ''), observed_at) DO NOTHING");
        expect(built.sql).toContain("(r->>'amount')::numeric");
    });

    test('an empty run renders SQL that touches nothing', () => {
        expect(buildMintStateSql([]).rows).toBe(0);
        expect(buildWalletBalanceSql([]).rows).toBe(0);
    });

    test('the read-back queries take the latest row per subject and cast numerics to text', () => {
        const states = buildLatestStateQuery();
        expect(states).toContain('DISTINCT ON (mint)');
        expect(states).toContain('ORDER BY mint, observed_at DESC');
        expect(states).toContain('s.supply::text');
        expect(states).toContain("to_json(s.observed_at)#>>'{}'");
        // A numeric read back as a JSON number would round a 15-digit multiplier.
        expect(states).not.toMatch(/'uiMultiplier', s\.ui_multiplier\b(?!::text)/);

        const balances = buildLatestBalanceQuery();
        expect(balances).toContain("DISTINCT ON (wallet, coalesce(mint, ''))");
        expect(balances).toContain('b.amount::text');
    });

    test('parseStateRows reads psql output back into states that compare against fresh ones', () => {
        const rows = parseStateRows(
            '{"mint":"m1","observedAt":"2026-09-18T10:00:00+00:00","slot":"447853695",'
            + '"supply":"1000","decimals":"8","transferFeeBps":null,'
            + '"uiMultiplierEffectiveAt":"2026-08-30T20:54:04+00:00","stateHash":"abc"}\n\n'
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            mint: 'm1', observedAt: AT, slot: 447853695, supply: '1000', decimals: 8,
            transferFeeBps: null, uiMultiplierEffectiveAt: '2026-08-30T20:54:04Z'
        });
    });

    test('a state written and read back through the same casts diffs as unchanged', () => {
        // The round trip that matters: what psql gives back must not look like a change.
        const fresh = state();
        const roundTripped = parseStateRows(JSON.stringify({
            ...fresh, observedAt: '2026-09-18T10:00:00+00:00', slot: String(fresh.slot),
            decimals: String(fresh.decimals)
        }))[0];
        expect(diffStates(roundTripped, fresh)).toEqual([]);
        expect(stateHash(roundTripped)).toBe(stateHash(fresh));
    });
});

describe('the run summary', () => {
    const events = [
        { kind: 'supply', severity: 'info', field: 'supply', subjectId: 'm1', before: '1', after: '2', evidence: { symbol: 'AAPLon', issuer: 'ondo-global-markets' } },
        { kind: 'authority-key', severity: 'warning', field: 'mint_authority', subjectId: 'm2', before: 'a', after: 'b', evidence: { symbol: 'TSLAx' } },
        { kind: 'rebase', severity: 'critical', field: 'decimals', subjectId: 'm3', before: '8', after: '6', evidence: {} },
        { kind: 'treasury', severity: 'caution', field: 'sol:w', subjectId: 'shared', before: '1', after: '2', evidence: {} }
    ];

    test('countBy tallies kinds and severities, biggest first', () => {
        expect(countBy(events, 'severity')).toEqual({ caution: 1, critical: 1, info: 1, warning: 1 });
        expect(Object.keys(countBy([...events, events[1]], 'severity'))[0]).toBe('warning');
    });

    test('topEvents puts the worst first, not the newest', () => {
        expect(topEvents(events, 3).map((e) => e.severity)).toEqual(['critical', 'warning', 'caution']);
    });

    test('one message carries the counts, the top three and the duration', () => {
        const text = formatTelegramSummary({
            events, failures: [{ reason: 'mint x: no account' }], mintsRead: 471, unchanged: 468,
            changed: 3, walletsRead: 40, metadataFetched: 50, durationMs: 62_000, host: 'rpc.example'
        });
        expect(text.split('\n')[0]).toBe('rwa-sonar chain watch: 4 event(s), 1 failure(s)');
        expect(text).toContain('mints 471 read · 468 unchanged · 3 changed');
        expect(text).toContain('62.0 s');
        expect(text).toContain('critical 1');
        expect(text).toContain('[critical] m3 decimals: 8 -> 6');
        expect(text).toContain('[warning] TSLAx mint_authority');
        expect(text).toContain('failures: mint x: no account');
        // One message, so at most three events are named however many there are.
        expect(text.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(3);
    });

    test('a clean run says so in two lines and names no events', () => {
        const text = formatTelegramSummary({ mintsRead: 471, unchanged: 471, durationMs: 1000 });
        expect(text.split('\n')).toHaveLength(2);
        expect(text).toContain('0 event(s), 0 failure(s)');
    });
});
