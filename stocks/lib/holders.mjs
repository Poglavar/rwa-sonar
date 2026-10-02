// PURE helpers for the holder-concentration layer (no network, no fs, no clock): turn one
// getTokenLargestAccounts entry plus its jsonParsed token account into the record
// `data/holders.json` stores, compute top-1/5/20 supply shares, dedupe owners across token
// accounts and label the owners this repo can actually name. Every share stays null when the
// supply is unknown or zero instead of becoming a plausible-looking 0 or an Infinity.
// Unit-tested in stocks/holders.test.js.

/** A finite number, or null. Never turns null/''/'abc' into 0, which `Number()` would. */
export function finiteOrNull(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

/** A non-empty string, or null. */
export function stringOrNull(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * A raw base-unit amount as BigInt, or null. The RPC sends `amount` and `supply` as decimal
 * STRINGS precisely because they can exceed 2^53, so they are parsed exactly and never through
 * Number(). A negative or non-digit string is a shape change, not a zero.
 */
export function rawAmountOrNull(value) {
    if (typeof value === 'bigint') return value >= 0n ? value : null;
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (!/^\d+$/.test(text)) return null;
    return BigInt(text);
}

/**
 * Raw base units → whole tokens: `raw / 10^decimals`.
 *
 * This is deliberately NOT the RPC's `uiAmount`. On a Token-2022 mint with the scaled-UI-amount
 * extension the RPC multiplies `uiAmount` by the mint's current multiplier (measured 2026-09-16:
 * AAPLx returned amount 11406226514867 with decimals 8 but uiAmount 114435.13612376, a ×1.00327),
 * and the multiplier is NOT applied to `supply`. Mixing the two would divide a scaled numerator by
 * an unscaled denominator and overstate every share by the multiplier. Shares here are computed
 * from raw/raw, where the multiplier cancels out entirely, and the UI figures are the raw ones.
 */
export function rawToUi(raw, decimals) {
    const amount = rawAmountOrNull(raw);
    if (amount === null) return null;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) return null;
    return Number(amount) / 10 ** decimals;
}

/**
 * Share of supply in percent, from RAW amounts on both sides so any UI multiplier cancels.
 *
 * Returns null — never 0, never Infinity, never NaN — when the amount or the supply is missing OR
 * when the supply is zero. 24 of the 441 mints have supply 0 (HSDT and the unminted Ondo mints),
 * and a 0 there would read as "measured, holds nothing" for an account that in fact holds the only
 * tokens in existence, while a `/0` would emit Infinity into JSON as null anyway but poison every
 * sum it touched first.
 */
export function sharePct(rawAmount, rawSupply) {
    const amount = rawAmountOrNull(rawAmount);
    const supply = rawAmountOrNull(rawSupply);
    if (amount === null || supply === null || supply === 0n) return null;
    const pct = (Number(amount) / Number(supply)) * 100;
    return Number.isFinite(pct) ? pct : null;
}

/**
 * Sum that stays null when nothing summable was seen, so "no supply figure" and "holds nothing"
 * stay distinguishable in the cumulative shares.
 */
export function sumOrNull(values) {
    let total = null;
    for (const value of values) {
        const num = finiteOrNull(value);
        if (num === null) continue;
        total = total === null ? num : total + num;
    }
    return total;
}

/** Median of the finite values, or null when there are none. */
export function median(values) {
    const nums = [];
    for (const value of values) {
        const num = finiteOrNull(value);
        if (num !== null) nums.push(num);
    }
    if (nums.length === 0) return null;
    nums.sort((a, b) => a - b);
    const mid = nums.length >> 1;
    return nums.length % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

/**
 * One getMultipleAccounts({encoding:'jsonParsed'}) value entry for a MINT ADDRESS →
 * `{supply, decimals}`. Returns null for a null account (no such mint) and for anything that is
 * not a parsed mint — a token account passed in by mistake must not be read as a supply figure.
 *
 * `supply` stays the RPC's decimal STRING, never a Number: 2^53 is ~9.0e15 and a 9-decimal mint
 * with 10 M tokens is already 1.0e16, so parsing it as a float would silently round the
 * denominator of every share. It is validated through rawAmountOrNull() and handed back as a
 * string. A mint account whose `supply`/`decimals` are missing or malformed keeps null there
 * rather than a plausible-looking 0, and then every share computed against it is null.
 */
export function mintSupplyInfo(account) {
    const parsed = account?.data?.parsed ?? null;
    if (parsed === null || typeof parsed !== 'object') return null;
    if (parsed.type !== 'mint') return null;
    const info = parsed.info ?? null;
    if (info === null || typeof info !== 'object') return null;
    const supply = rawAmountOrNull(info.supply);
    const decimals = Number.isInteger(info.decimals) && info.decimals >= 0 && info.decimals <= 30 ? info.decimals : null;
    return { supply: supply === null ? null : supply.toString(), decimals };
}

/**
 * Every address a jsonParsed MINT account names as a key that controls the mint: the mint and
 * freeze authorities, plus each Token-2022 extension's `authority`, `delegate` or `updateAuthority`
 * (metadataPointer, permanentDelegate, scaledUiAmountConfig, pausableConfig,
 * confidentialTransferMint, transferHook, tokenMetadata). Duplicates are dropped; a program id is
 * NOT an authority and is not collected.
 *
 * This exists because `data/onchain.json` flattens the extensions down to the flags that decide how
 * controllable a share is and keeps only two of the authority ADDRESSES — so the key that holds the
 * biggest AAPLx position (`S7vYFF…`, the scaledUiAmountConfig authority on all 156 xStocks mints)
 * appears in no field of that file. Reading the authorities off the same live mint accounts the
 * supply comes from labels it from data, in the same run, instead of hardcoding it.
 */
export function mintAuthorityAddresses(account) {
    const parsed = account?.data?.parsed ?? null;
    if (parsed === null || typeof parsed !== 'object' || parsed.type !== 'mint') return [];
    const info = parsed.info ?? null;
    if (info === null || typeof info !== 'object') return [];
    const found = new Set();
    for (const key of [info.mintAuthority, info.freezeAuthority]) {
        const address = stringOrNull(key);
        if (address !== null) found.add(address);
    }
    for (const extension of Array.isArray(info.extensions) ? info.extensions : []) {
        const state = extension?.state ?? null;
        if (state === null || typeof state !== 'object') continue;
        for (const key of [state.authority, state.delegate, state.updateAuthority]) {
            const address = stringOrNull(key);
            if (address !== null) found.add(address);
        }
    }
    return [...found];
}

export const ISSUER_AUTHORITY = 'issuer-authority';
export const BURN_ADDRESS = 'burn-address';
export const ISSUER_INVENTORY = 'issuer-inventory';

/**
 * Addresses this repo can NAME, with the file that names them. Deliberately tiny: an owner is only
 * labelled when a dossier or a sponsor API in this repo says what it is, because a guessed label
 * ("probably an exchange") would be read as evidence. Everything else stays unlabeled, which is an
 * honest "we know the wallet, not who holds it".
 *
 * No per-mint authority is listed here — they are read from `data/onchain.json` and from the live
 * jsonParsed mint accounts by buildOwnerLabels() so they can never drift from the chain.
 */
export const KNOWN_OWNERS = {
    // Superstate's shared Solana equity burn address — the redemption rail for all four Opening
    // Bell equities. Cited by data/issuers/superstate-opening-bell.json ("Solana equity burn
    // address (shared, all equities)", source api.superstate.com/v2/instruments), by
    // `burnAddressSolana` on every Superstate instrument in data/sponsor-apis.json, and by
    // findings.md ("shared burn address 2u8YwJ…").
    '2u8YwJTykTreziHBN5QwE7Bi2SyN8M2MicCscthtph9E': BURN_ADDRESS,
    // xStocks issuer inventory: stocked only from the treasury S7vYFF…, and excluded from the
    // issuer's own circulating figure (data/issuers/xstocks-backed.json finding, 2026-09-24).
    // A top-20 position in 174 xStocks mints is the issuer's own stock, not an independent holder.
    '9U76mo3WuP28s4kYJ9CMH1CiQh6Ph3r5Zg5awZM5vMQd': ISSUER_INVENTORY
};

/**
 * The fields of a `data/onchain.json` record that hold an authority ADDRESS. `permanentDelegate`,
 * `pausable` and `transferHookConfigured` are booleans in that file and carry no key, and
 * `transferHookProgram` is a program id rather than an authority, so neither is read here.
 */
export const ONCHAIN_AUTHORITY_FIELDS = ['mintAuthority', 'freezeAuthority', 'permanentDelegateAddress', 'metadataUpdateAuthority'];

/**
 * address → label, from KNOWN_OWNERS plus every authority address the run can see:
 * `ONCHAIN_AUTHORITY_FIELDS` of each `data/onchain.json` record, and `extraAuthorities` — the
 * addresses `mintAuthorityAddresses()` read off the live jsonParsed mint accounts, which is the
 * only place the extension authorities (scaled-UI, pausable, transfer-hook, confidential-transfer,
 * metadata-pointer) survive. A burn address wins over an authority label if an address is ever
 * both, because "this supply was retired" is the stronger statement.
 *
 * Labels are global, not per mint: an issuer's authority key holding a position in a DIFFERENT
 * issuer's token is exactly the kind of thing worth seeing, so it is not filtered out.
 */
export function buildOwnerLabels(onchainItems, extraAuthorities = []) {
    const labels = new Map();
    const add = (key) => {
        const address = stringOrNull(key);
        if (address !== null && !labels.has(address)) labels.set(address, ISSUER_AUTHORITY);
    };
    for (const item of Array.isArray(onchainItems) ? onchainItems : []) {
        for (const field of ONCHAIN_AUTHORITY_FIELDS) add(item?.[field]);
    }
    for (const key of Array.isArray(extraAuthorities) ? extraAuthorities : []) add(key);
    for (const [address, label] of Object.entries(KNOWN_OWNERS)) labels.set(address, label);
    return labels;
}

/** The label for an owner, or null when the repo cannot name it. */
export function labelOwner(address, labels) {
    const owner = stringOrNull(address);
    if (owner === null) return null;
    if (labels instanceof Map) return labels.get(owner) ?? null;
    return labels?.[owner] ?? null;
}

/**
 * One getMultipleAccounts({encoding:'jsonParsed'}) value entry → the three fields the holder layer
 * needs: `{owner, state, mint, program}`. Returns null for an account the RPC answered null for (a
 * closed account), for one it could not parse (`data` comes back as a base64 pair when the owning
 * program is unknown) and for anything that is not a token account.
 *
 * This is the ONE place the RPC's nesting is unwrapped, so the record is the single format the rest
 * of the file and the run's checkpoint both speak — the checkpoint stores this, not the 3 KB
 * account it came from.
 */
export function tokenAccountInfo(account) {
    const parsed = account?.data?.parsed ?? null;
    if (parsed === null || typeof parsed !== 'object') return null;
    if (parsed.type !== undefined && parsed.type !== 'account') return null;
    const info = parsed.info ?? null;
    if (info === null || typeof info !== 'object') return null;
    return {
        owner: stringOrNull(info.owner),
        state: stringOrNull(info.state),
        mint: stringOrNull(info.mint),
        program: stringOrNull(account.data.program)
    };
}

/**
 * One getTokenLargestAccounts entry + the `tokenAccountInfo()` record for the same address →
 * `{tokenAccount, owner, amountUi, sharePct, state, ownerLabel}`.
 *
 * `info` may be null (getMultipleAccounts legitimately answers null for a closed account, and a
 * batch that failed leaves it unresolved): then `owner` and `state` are null rather than guessed —
 * an unknown owner must not collapse into the dedupe as if it were a wallet we had read.
 *
 * A record naming a DIFFERENT mint is an RPC/batch mix-up rather than data: owner and state are
 * dropped and `mintMismatch` is reported so the caller can count it, because attributing one
 * token's holder to another mint is worse than a gap.
 */
export function shapeHolder(largest, info, { rawSupply = null, decimals = null, mint = null, labels = null } = {}) {
    if (largest === null || typeof largest !== 'object') return null;
    const tokenAccount = stringOrNull(largest.address);
    if (tokenAccount === null) return null;

    const accountMint = stringOrNull(info?.mint);
    const mintMismatch = mint !== null && accountMint !== null && accountMint !== mint;
    const resolved = info !== null && info !== undefined && typeof info === 'object';
    const usable = resolved && !mintMismatch;

    const owner = usable ? stringOrNull(info.owner) : null;
    const state = usable ? stringOrNull(info.state) : null;

    return {
        record: {
            tokenAccount,
            owner,
            amountUi: rawToUi(largest.amount, decimals),
            sharePct: sharePct(largest.amount, rawSupply),
            state,
            ownerLabel: labelOwner(owner, labels)
        },
        raw: rawAmountOrNull(largest.amount),
        mintMismatch,
        // The per-entry `decimals` the RPC echoes should equal the mint's. A disagreement would
        // make amountUi and supplyUi incomparable, so it is surfaced rather than averaged over.
        decimalsMismatch: Number.isInteger(largest.decimals) && Number.isInteger(decimals) && largest.decimals !== decimals,
        resolved
    };
}

/**
 * Collapse token accounts by owner: `[{owner, ownerLabel, accounts, amountUi, sharePct}]`, biggest
 * first. Accounts whose owner we never learned are NOT merged into one bucket — each stays its own
 * `owner: null` row, because two unread accounts are two unknowns, not one wallet.
 */
export function dedupeOwners(entries) {
    const byOwner = new Map();
    const unknown = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
        if (entry === null || typeof entry !== 'object') continue;
        const owner = stringOrNull(entry.owner);
        const row = {
            owner,
            ownerLabel: entry.ownerLabel ?? null,
            accounts: 1,
            amountUi: finiteOrNull(entry.amountUi),
            sharePct: finiteOrNull(entry.sharePct)
        };
        if (owner === null) {
            unknown.push(row);
            continue;
        }
        const seen = byOwner.get(owner);
        if (seen === undefined) {
            byOwner.set(owner, row);
            continue;
        }
        seen.accounts += 1;
        seen.amountUi = sumOrNull([seen.amountUi, row.amountUi]);
        seen.sharePct = sumOrNull([seen.sharePct, row.sharePct]);
    }
    return [...byOwner.values(), ...unknown].sort((a, b) => {
        const byAmount = (b.amountUi ?? -1) - (a.amountUi ?? -1);
        if (byAmount !== 0) return byAmount;
        return String(a.owner).localeCompare(String(b.owner));
    });
}

/** How many DISTINCT wallets the entries resolve to. An unread owner counts as its own unknown. */
export function distinctOwnerCount(entries) {
    return dedupeOwners(entries).length;
}

/**
 * The share of supply held by the first `n` entries, from their RAW amounts (biggest-first) —
 * `Σraw / supply`, ONE division, not a sum of `n` rounded quotients. Null when the supply is
 * missing or zero, or when not one of the entries had a readable amount.
 *
 * Summing the per-account `sharePct` floats instead overshoots: on a mint whose top accounts hold
 * every token in existence, Σ(aᵢ/S) lands on 100.00000000000001 rather than 100, and 39 of the 441
 * mints did exactly that on 2026-09-16 — a share above 100% that no supply figure could fix,
 * because it was the arithmetic and not the denominator. Σaᵢ is exact in BigInt, so when the top 20
 * are the whole supply this returns exactly 100 and "a share over 100% is a bug" stays a real
 * invariant instead of something to explain away.
 */
export function cumulativeSharePct(raws, rawSupply, n) {
    const supply = rawAmountOrNull(rawSupply);
    if (!Array.isArray(raws) || supply === null || supply === 0n) return null;
    let total = null;
    for (const value of raws.slice(0, n)) {
        const raw = rawAmountOrNull(value);
        if (raw === null) continue;
        total = (total ?? 0n) + raw;
    }
    if (total === null) return null;
    const pct = (Number(total) / Number(supply)) * 100;
    return Number.isFinite(pct) ? pct : null;
}

/**
 * The full `items[]` record for one mint. `largest` is the getTokenLargestAccounts value array and
 * `accountByAddress` maps a token-account address to its `tokenAccountInfo()` record (or null when
 * the account was never read).
 *
 * `supplyUi` is the RAW supply / 10^decimals — the scaled-UI multiplier is deliberately NOT applied
 * (200 of the 441 mints carry one), so supplyUi and amountUi are the same unit and their ratio is
 * the real share. A consumer wanting the issuer's displayed share count must multiply by
 * `onchain.json`'s `scaledUiAmountMultiplier` itself.
 */
export function summariseMint({ mint, symbol = null, issuer = null, decimals = null, rawSupply = null, largest = [], accountByAddress = null, labels = null } = {}) {
    const shaped = [];
    let mintMismatches = 0;
    let decimalsMismatches = 0;
    let unresolved = 0;

    for (const entry of Array.isArray(largest) ? largest : []) {
        const address = stringOrNull(entry?.address);
        const account = address === null ? null : (accountByAddress instanceof Map ? accountByAddress.get(address) ?? null : accountByAddress?.[address] ?? null);
        const out = shapeHolder(entry, account, { rawSupply, decimals, mint, labels });
        if (out === null) continue;
        if (out.mintMismatch) mintMismatches += 1;
        if (out.decimalsMismatch) decimalsMismatches += 1;
        if (!out.resolved) unresolved += 1;
        shaped.push(out);
    }

    // getTokenLargestAccounts already answers biggest-first; re-sorted so the shares are
    // cumulative whatever order a checkpoint or a fixture happens to hold them in.
    shaped.sort((a, b) => {
        if (a.raw !== null && b.raw !== null && a.raw !== b.raw) return b.raw > a.raw ? 1 : -1;
        if (a.raw === null && b.raw !== null) return 1;
        if (b.raw === null && a.raw !== null) return -1;
        return a.record.tokenAccount.localeCompare(b.record.tokenAccount);
    });
    const top20 = shaped.map((out) => out.record);
    const raws = shaped.map((out) => out.raw);

    return {
        item: {
            mint,
            symbol,
            issuer,
            supplyUi: rawToUi(rawSupply, decimals),
            top20,
            top1SharePct: cumulativeSharePct(raws, rawSupply, 1),
            top5SharePct: cumulativeSharePct(raws, rawSupply, 5),
            top20SharePct: cumulativeSharePct(raws, rawSupply, 20),
            distinctOwnersTop20: distinctOwnerCount(top20),
            frozenAccountsTop20: top20.filter((entry) => entry.state === 'frozen').length
        },
        mintMismatches,
        decimalsMismatches,
        unresolved
    };
}
