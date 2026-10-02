// PURE decoders for the lending-market transactions stocks/watch-lending.mjs reads: liquidations of
// tokenized-stock collateral (Kamino KLend, Jupiter Lend vaults, Nest, Loopscale) and the price
// observations behind collateral price freezes (KLend reserve refresh logs, Scope's
// ResumeSuspendedPrice, Jupiter Lend's Chainlink cache suspension events). Input is a
// getTransaction(encoding 'json', maxSupportedTransactionVersion 0) result; no network, no clock.
//
// Every amount comes from the program's own words: an instruction's accounts and arguments, the
// program's log lines and Anchor events, and the transaction's pre/post token balances. Layouts
// follow each program's published IDL (sources in LENDING_DECODE_SOURCES). Tested against real
// transactions in ../lending-decode.test.js (fixtures under ../fixtures/lending/).

import { createHash } from 'node:crypto';

import { base58Decode, base58Encode } from './solana-address.mjs';

export const KLEND_PROGRAM = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';
export const SCOPE_PROGRAM = 'HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ';
export const JL_VAULTS_PROGRAM = 'jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi';
export const JL_ORACLE_PROGRAM = 'jupnw4B6Eqs7ft6rxpzYLJZYSnrpRgPcr589n5Kv4oc';
export const NEST_PROGRAM = 'HxbLPNuQD7KKDVQoSQgY1cLMLrsaoseT65Xoczh7zHQW';
export const LOOPSCALE_PROGRAM = '1oopBoJG58DgkUVKkEzKgyG9dvRmpgeEm1AVjoHkF78';

/** Where each layout below comes from (read 2026-09-24). */
export const LENDING_DECODE_SOURCES = {
    klend: 'https://raw.githubusercontent.com/Kamino-Finance/klend-sdk/master/src/idl/klend.json (kamino_lending 1.25.0)',
    jupiterLendVaults: 'https://raw.githubusercontent.com/jup-ag/jupiter-lend/main/target/idl/vaults.json (vaults 0.1.8)',
    jupiterLendOracle: 'https://raw.githubusercontent.com/jup-ag/jupiter-lend/main/target/idl/oracle.json',
    nest: 'https://docs.nestusd.com/idl/nest_core.json (nest_core 0.1.0)',
    loopscale: 'on-chain Anchor IDL account 8jaPDEbzjkgJT8qTgMwCxbVUZt3p2MoMsCovyNyuNShD (see lib/loopscale.mjs)',
    scope: 'program logs of Scope ResumeSuspendedPrice (tx 26SQ52zV…, 2026-09-21)'
};

/**
 * Signature-verification precompiles run as top-level instructions but never log
 * "Program … invoke", so they are skipped when logs are matched to instructions.
 */
const PRECOMPILES = new Set([
    'Ed25519SigVerify111111111111111111111111111',
    'KeccakSecp256k11111111111111111111111111111',
    'Secp256r1SigVerify1111111111111111111111111'
]);

/** Anchor instruction discriminator: sha256("global:<name>")[0..8] as hex. */
export function anchorDiscriminator(name) {
    return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8).toString('hex');
}

const KLEND_IX = {
    [anchorDiscriminator('refresh_reserve')]: 'refresh_reserve',
    [anchorDiscriminator('refresh_reserves_batch')]: 'refresh_reserves_batch',
    [anchorDiscriminator('liquidate_obligation_and_redeem_reserve_collateral')]: 'liquidate_obligation_and_redeem_reserve_collateral',
    [anchorDiscriminator('liquidate_obligation_and_redeem_reserve_collateral_v2')]: 'liquidate_obligation_and_redeem_reserve_collateral_v2'
};
const JL_VAULT_IX = {
    [anchorDiscriminator('liquidate')]: 'liquidate',
    [anchorDiscriminator('liquidate_dex')]: 'liquidate_dex',
    [anchorDiscriminator('liquidate_perfect_dex')]: 'liquidate_perfect_dex'
};
const NEST_IX = {
    [anchorDiscriminator('liquidate_with_oracle')]: 'liquidate_with_oracle',
    [anchorDiscriminator('start_liquidation_with_oracle')]: 'start_liquidation_with_oracle'
};
const LOOPSCALE_IX = { [anchorDiscriminator('liquidate_ledger')]: 'liquidate_ledger' };
/** Anchor event discriminators (the IDLs' `events[].discriminator`). */
const JL_EVENT = {
    LogLiquidate: Buffer.from([154, 128, 202, 147, 65, 233, 195, 73]).toString('hex'),
    FeedSuspended: Buffer.from([63, 149, 247, 255, 189, 80, 154, 253]).toString('hex'),
    FeedInTransition: Buffer.from([211, 67, 128, 58, 147, 192, 179, 111]).toString('hex')
};
/** Accounts per reserve in a KLend refresh_reserves_batch (reserve, market, pyth, switchboard ×2, scope). */
const BATCH_STRIDE = 6;

// --- the transaction as a list of invocations ------------------------------------------------

/** Every account key of a (legacy or v0) transaction, in index order. */
export function txAccountKeys(tx) {
    const message = tx?.transaction?.message ?? {};
    const loaded = tx?.meta?.loadedAddresses ?? {};
    const keys = (message.accountKeys ?? []).map((key) => (typeof key === 'string' ? key : key?.pubkey ?? null));
    return [...keys, ...(loaded.writable ?? []), ...(loaded.readonly ?? [])];
}

function ixData(data) {
    if (typeof data !== 'string' || data === '') return Buffer.alloc(0);
    try {
        return base58Decode(data);
    } catch {
        return Buffer.alloc(0);
    }
}

/**
 * The transaction's instructions in execution order (each top-level instruction followed by its
 * inner ones), each with the log lines and Anchor event payloads its program printed while it was
 * the innermost running program. Matching is by the runtime's own "Program X invoke [n]" lines,
 * checked against each instruction's program id; `aligned` is false (and no logs are attached
 * after that point) when they disagree or the log was truncated, so a decoder can never read one
 * program's logs as another's.
 */
export function txInvocations(tx) {
    const keys = txAccountKeys(tx);
    const message = tx?.transaction?.message ?? {};
    const innerByIndex = new Map((tx?.meta?.innerInstructions ?? []).map((group) => [group.index, group.instructions ?? []]));
    const invocations = [];
    const push = (ix, top) => invocations.push({
        index: invocations.length,
        top,
        programId: keys[ix.programIdIndex] ?? null,
        accounts: (ix.accounts ?? []).map((i) => keys[i] ?? null),
        data: ixData(ix.data),
        logs: [],
        events: []
    });
    (message.instructions ?? []).forEach((ix, top) => {
        push(ix, top);
        for (const inner of innerByIndex.get(top) ?? []) push(inner, top);
    });
    const runnable = invocations.filter((inv) => !PRECOMPILES.has(inv.programId));
    const logs = tx?.meta?.logMessages;
    let aligned = Array.isArray(logs);
    let truncated = false;
    let next = 0;
    const stack = [];
    for (const line of Array.isArray(logs) ? logs : []) {
        if (line === 'Log truncated') {
            truncated = true;
            aligned = false;
            break;
        }
        const invoke = /^Program (\S+) invoke \[(\d+)\]$/.exec(line);
        if (invoke) {
            const inv = runnable[next];
            next += 1;
            if (!inv || inv.programId !== invoke[1]) {
                aligned = false;
                break;
            }
            stack.push(inv);
            continue;
        }
        if (/^Program \S+ (success|failed)/.test(line)) {
            stack.pop();
            continue;
        }
        const top = stack.at(-1);
        if (!top) continue;
        if (line.startsWith('Program log: ')) top.logs.push(line.slice(13));
        else if (line.startsWith('Program data: ')) top.events.push(line.slice(14));
    }
    return { invocations, aligned, truncated };
}

// --- token balances ---------------------------------------------------------------------------

/**
 * Per token account: mint, owner, decimals and the raw balance change (BigInt) the transaction
 * made. An account present only before or only after counts the missing side as zero, which is
 * what the runtime means by it (the account was created or closed in this transaction).
 */
export function tokenDeltas(tx) {
    const keys = txAccountKeys(tx);
    const out = new Map();
    const read = (list, side) => {
        for (const b of Array.isArray(list) ? list : []) {
            const account = keys[b.accountIndex];
            if (!account) continue;
            const row = out.get(account) ?? { account, mint: b.mint, owner: b.owner ?? null, decimals: b.uiTokenAmount?.decimals ?? null, pre: 0n, post: 0n };
            const raw = BigInt(b.uiTokenAmount?.amount ?? '0');
            row[side] = raw;
            out.set(account, row);
        }
    };
    read(tx?.meta?.preTokenBalances, 'pre');
    read(tx?.meta?.postTokenBalances, 'post');
    for (const row of out.values()) row.delta = row.post - row.pre;
    return out;
}

/** mint → decimals, from the transaction's own token balances. */
export function mintDecimals(tx) {
    const out = new Map();
    for (const row of tokenDeltas(tx).values()) if (Number.isInteger(row.decimals)) out.set(row.mint, row.decimals);
    return out;
}

/** A raw integer amount in UI units, or null when the decimals are unknown. */
export function uiAmount(raw, decimals) {
    if (raw === null || raw === undefined || !Number.isInteger(decimals)) return null;
    const value = typeof raw === 'bigint' ? raw : BigInt(String(raw));
    const negative = value < 0n;
    const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
    const whole = digits.slice(0, digits.length - decimals);
    const frac = decimals > 0 ? digits.slice(-decimals).replace(/0+$/, '') : '';
    return Number(`${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`);
}

function u64(buf, offset) {
    return buf.length >= offset + 8 ? buf.readBigUInt64LE(offset) : null;
}

function key(buf, offset) {
    return buf.length >= offset + 32 ? base58Encode(buf.subarray(offset, offset + 32)) : null;
}

// --- Kamino ------------------------------------------------------------------------------------

/**
 * The reserve refreshes one KLend invocation performed, in order, from its logs. KLend prints, per
 * reserve, any staleness it found ("Price is too old age=A max_age=M" then "Price is too old
 * token=[X]" for the price, or "Price twap is too old token=[X]" for the TWAP) and closes with
 * "Token: X Price: P". A single refresh_reserve names its reserve as account 0; a
 * refresh_reserves_batch lists them BATCH_STRIDE accounts apart, in the order it logs them. When
 * the count of closed refreshes and the count of reserves disagree nothing is attributed.
 */
export function kaminoRefreshes(inv) {
    if (inv?.programId !== KLEND_PROGRAM) return [];
    const kind = KLEND_IX[inv.data.subarray(0, 8).toString('hex')];
    if (kind !== 'refresh_reserve' && kind !== 'refresh_reserves_batch') return [];
    const reserves = kind === 'refresh_reserve'
        ? [inv.accounts[0]]
        : inv.accounts.filter((_, i) => i % BATCH_STRIDE === 0);
    const segments = [];
    let current = { name: null, price: null, stale: false, ageS: null, maxAgeS: null, twapStale: false, twapDivergent: false };
    let pendingAge = null;
    const flush = () => {
        segments.push(current);
        current = { name: null, price: null, stale: false, ageS: null, maxAgeS: null, twapStale: false, twapDivergent: false };
        pendingAge = null;
    };
    for (const line of inv.logs) {
        let m = /^Price is too old age=(\d+) max_age=(\d+)/.exec(line);
        if (m) {
            pendingAge = { ageS: Number(m[1]), maxAgeS: Number(m[2]) };
            continue;
        }
        m = /^Price is too old token=\[([^\]]*)\]/.exec(line);
        if (m) {
            current.name = m[1];
            current.stale = true;
            if (pendingAge) Object.assign(current, pendingAge);
            pendingAge = null;
            continue;
        }
        if (/^Price twap is too old token=/.test(line)) {
            current.twapStale = true;
            pendingAge = null;
            continue;
        }
        if (/^Price twap check failed token=|^Price is too far from TWAP/.test(line)) {
            current.twapDivergent = true;
            continue;
        }
        m = /^Token: (.+?) Price: (-?\d+(?:\.\d+)?)$/.exec(line);
        if (m) {
            current.name = m[1];
            current.price = Number(m[2]);
            flush();
        }
    }
    if (segments.length !== reserves.length) return [];
    return segments.map((segment, i) => ({ reserve: reserves[i], ...segment }));
}

/**
 * One KLend liquidation (v1 or v2; v2 nests the same 20 accounts first). The amounts are KLend's
 * own "pnl: Liquidator repaid R and withdrew W collateral with fees F" line: R in the repay
 * reserve's token, W the collateral token the liquidator received and F the protocol's share of
 * it, so the collateral taken from the borrower is W + F. When the log is not there (a truncated
 * log), the same two amounts are read from the balances of the withdraw reserve's liquidity supply
 * (what the borrower's collateral lost) and the repay reserve's supply (what the debt regained).
 */
export function kaminoLiquidation(inv, deltas = null) {
    if (inv?.programId !== KLEND_PROGRAM) return null;
    const kind = KLEND_IX[inv.data.subarray(0, 8).toString('hex')];
    if (kind !== 'liquidate_obligation_and_redeem_reserve_collateral' && kind !== 'liquidate_obligation_and_redeem_reserve_collateral_v2') return null;
    const a = inv.accounts;
    let pnl = null;
    let bonusBps = null;
    let reason = null;
    for (const line of inv.logs) {
        const m = /^pnl: Liquidator repaid (\d+) and withdrew (\d+) collateral with fees (\d+)/.exec(line);
        if (m) pnl = { repaid: BigInt(m[1]), withdrew: BigInt(m[2]), fees: BigInt(m[3]) };
        const b = /liquidated with liquidation bonus: (\d+) bps/.exec(line);
        if (b) bonusBps = Number(b[1]);
        const r = /eligible for liquidation because of (\w+)/.exec(line);
        if (r) reason = r[1];
    }
    const supplyDrop = deltas?.get(a[11]);
    const repayGain = deltas?.get(a[6]);
    return {
        instruction: kind,
        amountsFrom: pnl ? 'program-log' : 'token-balances',
        takenFromBalancesRaw: !pnl && supplyDrop && supplyDrop.mint === a[8] && supplyDrop.delta < 0n ? -supplyDrop.delta : null,
        repaidFromBalancesRaw: !pnl && repayGain && repayGain.mint === a[5] && repayGain.delta > 0n ? repayGain.delta : null,
        liquidator: a[0] ?? null,
        obligation: a[1] ?? null,
        lendingMarket: a[2] ?? null,
        repayReserve: a[4] ?? null,
        repayMint: a[5] ?? null,
        withdrawReserve: a[7] ?? null,
        withdrawMint: a[8] ?? null,
        requestedRepayRaw: u64(inv.data, 8),
        repaidRaw: pnl?.repaid ?? null,
        withdrewRaw: pnl?.withdrew ?? null,
        feesRaw: pnl?.fees ?? null,
        bonusBps,
        reason
    };
}

/**
 * Scope's ResumeSuspendedPrice: an admin re-enabling a price entry that Scope suspended around a
 * corporate action. The log carries the entry index, its label and the Chainlink report data it
 * was holding: the observation time of the last report before the suspension and the activation
 * time of the corporate action.
 */
export function scopeResume(inv) {
    if (inv?.programId !== SCOPE_PROGRAM || !inv.logs.some((line) => line === 'Instruction: ResumeSuspendedPrice')) return null;
    let entry = null;
    let label = null;
    let observationsTs = null;
    let activationTs = null;
    for (const line of inv.logs) {
        const m = /^ResumeSuspendedPrice, token: (\d+) \(([^)]*)\)/.exec(line);
        if (m) {
            entry = Number(m[1]);
            // Scope pads the fixed-width label with NUL bytes.
            label = m[2].replace(/\u0000/g, '').trim();
        }
        const o = /observations_timestamp: (\d+)/.exec(line);
        if (o) observationsTs = Number(o[1]);
        const t = /activation_date_time: (\d+)/.exec(line);
        if (t) activationTs = Number(t[1]);
    }
    return entry === null ? null : { entry, label, observationsTs, activationTs };
}

// --- Jupiter Lend ------------------------------------------------------------------------------

/**
 * One Jupiter Lend vault liquidation. Jupiter Lend liquidates by price tick, not by borrower, so
 * there is no single position: the event LogLiquidate reports the collateral and debt moved in the
 * vault's internal units, and the tokens that actually moved are read from the balances of the
 * liquidator's receiving (`to_token_account`) and paying (`signer_token_account`) accounts.
 */
export function jupiterLendLiquidation(inv, deltas) {
    if (inv?.programId !== JL_VAULTS_PROGRAM) return null;
    const kind = JL_VAULT_IX[inv.data.subarray(0, 8).toString('hex')];
    if (!kind) return null;
    const a = inv.accounts;
    let event = null;
    for (const payload of inv.events) {
        const buf = Buffer.from(payload, 'base64');
        if (buf.subarray(0, 8).toString('hex') !== JL_EVENT.LogLiquidate || buf.length < 8 + 32 + 8 + 8 + 32) continue;
        event = { signer: key(buf, 8), colAmountRaw: u64(buf, 40), debtAmountRaw: u64(buf, 48), to: key(buf, 56) };
    }
    const received = deltas?.get(a[3]) ?? null;
    const paid = deltas?.get(a[1]) ?? null;
    return {
        instruction: kind,
        liquidator: a[0] ?? null,
        vaultConfig: a[4] ?? null,
        vaultState: a[5] ?? null,
        collateralMint: a[6] ?? null,
        debtMint: a[7] ?? null,
        oracle: a[8] ?? null,
        collateralReceivedRaw: received && received.mint === a[6] && received.delta > 0n ? received.delta : null,
        debtPaidRaw: paid && paid.mint === a[7] && paid.delta < 0n ? -paid.delta : null,
        event
    };
}

/**
 * Jupiter Lend oracle events: LogChainlinkDataStreamsFeedSuspended (a keeper or the operator
 * setting or lifting `xstocks_suspended` on one cache) and LogChainlinkDataStreamsFeedMarketIsInTransition.
 */
export function jupiterOracleEvents(inv) {
    if (inv?.programId !== JL_ORACLE_PROGRAM) return [];
    const out = [];
    for (const payload of inv.events) {
        const buf = Buffer.from(payload, 'base64');
        const disc = buf.subarray(0, 8).toString('hex');
        if (disc === JL_EVENT.FeedSuspended && buf.length >= 8 + 32 + 32 + 1) {
            out.push({ event: 'feed-suspended', cache: key(buf, 8), keeper: key(buf, 40), suspended: buf[72] === 1 });
        } else if (disc === JL_EVENT.FeedInTransition && buf.length >= 8 + 32 + 8) {
            out.push({ event: 'feed-in-transition', feedId: buf.subarray(8, 40).toString('hex'), transitionTs: Number(u64(buf, 40)) });
        }
    }
    return out;
}

// --- Nest --------------------------------------------------------------------------------------

/**
 * One Nest liquidation. `liquidate_with_oracle` repays `requested_repay` nUSD and takes collateral
 * in one step; `start_liquidation_with_oracle` (the two-step path the liquidation authority uses)
 * takes the collateral now and repays from the sale proceeds in a later settle transaction, so its
 * debt side is unknown here. The collateral taken is the drop of the market's collateral vault.
 */
export function nestLiquidation(inv, deltas) {
    if (inv?.programId !== NEST_PROGRAM) return null;
    const kind = NEST_IX[inv.data.subarray(0, 8).toString('hex')];
    if (!kind) return null;
    const a = inv.accounts;
    const vault = deltas?.get(a[5]) ?? null;
    return {
        instruction: kind,
        collateralConfig: a[1] ?? null,
        position: a[2] ?? null,
        collateralMint: a[4] ?? null,
        liquidator: kind === 'liquidate_with_oracle' ? (a[14] ?? null) : (a[8] ?? null),
        collateralTakenRaw: vault && vault.mint === a[4] && vault.delta < 0n ? -vault.delta : null,
        requestedRepayRaw: kind === 'liquidate_with_oracle' ? u64(inv.data, 8) : null,
        nusdMint: kind === 'liquidate_with_oracle' ? (a[8] ?? null) : null
    };
}

// --- Loopscale ---------------------------------------------------------------------------------

/**
 * One Loopscale liquidate_ledger: the liquidator repays a loan ledger's principal to the lender's
 * strategy. Accounts per the on-chain IDL: liquidator 1, borrower 2, loan 3, strategy 4,
 * market_information 5, liquidator_ta 6, principal_mint 8. The principal repaid is the drop of the
 * liquidator's principal account; collateral that moves in the same transaction is read by the caller.
 */
export function loopscaleLiquidation(inv, deltas) {
    if (inv?.programId !== LOOPSCALE_PROGRAM) return null;
    const kind = LOOPSCALE_IX[inv.data.subarray(0, 8).toString('hex')];
    if (!kind) return null;
    const a = inv.accounts;
    const paid = deltas?.get(a[6]) ?? null;
    return {
        instruction: kind,
        liquidator: a[1] ?? null,
        borrower: a[2] ?? null,
        loan: a[3] ?? null,
        marketInformation: a[5] ?? null,
        principalMint: a[8] ?? null,
        principalPaidRaw: paid && paid.mint === a[8] && paid.delta < 0n ? -paid.delta : null
    };
}

// --- one transaction -----------------------------------------------------------------------------

function unixToIso(seconds) {
    return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
}

function mul(a, b) {
    return typeof a === 'number' && Number.isFinite(a) && typeof b === 'number' && Number.isFinite(b) ? a * b : null;
}

/**
 * Everything the lending watcher needs from one transaction: the KLend reserve price observations
 * (every reserve refreshed, watched or not — the liquidation rows need the debt side's price too),
 * liquidations whose seized collateral is one of `stockMints` (mint → symbol), Scope resumes and
 * Jupiter Lend oracle events. Liquidations of any other collateral are counted, not returned.
 * `loanMints` (Loopscale loan → collateral mint) names the collateral of a Loopscale loan.
 */
export function decodeLendingTransaction(tx, { stockMints = new Map(), loanMints = new Map() } = {}) {
    const signature = tx?.transaction?.signatures?.[0] ?? null;
    const blockTime = Number.isFinite(tx?.blockTime) ? tx.blockTime : null;
    const at = unixToIso(blockTime);
    const out = {
        signature, slot: tx?.slot ?? null, blockTime: at, failed: tx?.meta?.err !== null && tx?.meta?.err !== undefined,
        observations: [], liquidations: [], scopeResumes: [], oracleEvents: [], otherCollateralLiquidations: 0, warnings: []
    };
    if (!tx?.meta || blockTime === null) {
        out.warnings.push('transaction without meta or block time');
        return out;
    }
    const { invocations, aligned, truncated } = txInvocations(tx);
    if (!aligned) out.warnings.push(truncated ? 'log truncated' : 'logs do not match the instructions');
    const deltas = tokenDeltas(tx);
    const decimals = mintDecimals(tx);
    // A failed transaction's state changes are rolled back: its refresh logs are still what KLend
    // saw at that instant, but nothing it "liquidated" happened.
    const settled = !out.failed;

    for (const inv of invocations) {
        for (const refresh of kaminoRefreshes(inv)) {
            out.observations.push({ ...refresh, invocation: inv.index, signature, slot: out.slot, at });
        }
        const resume = scopeResume(inv);
        if (resume) out.scopeResumes.push({ ...resume, signature, slot: out.slot, at, failed: out.failed });
        for (const event of jupiterOracleEvents(inv)) out.oracleEvents.push({ ...event, signature, slot: out.slot, at, failed: out.failed });
        if (!settled) continue;

        const kl = kaminoLiquidation(inv, deltas);
        if (kl) {
            if (!stockMints.has(kl.withdrawMint)) {
                out.otherCollateralLiquidations += 1;
                continue;
            }
            const priceOf = (reserve) => out.observations.filter((o) => o.reserve === reserve && o.invocation < inv.index && o.price !== null).at(-1)?.price ?? null;
            const colDec = decimals.get(kl.withdrawMint);
            const debtDec = decimals.get(kl.repayMint);
            const collateralAmount = kl.withdrewRaw === null ? uiAmount(kl.takenFromBalancesRaw, colDec) : uiAmount(kl.withdrewRaw + kl.feesRaw, colDec);
            const debtAmount = uiAmount(kl.repaidRaw ?? kl.repaidFromBalancesRaw, debtDec);
            const collateralPrice = priceOf(kl.withdrawReserve);
            const debtPrice = priceOf(kl.repayReserve);
            out.liquidations.push({
                protocol: 'kamino', programId: KLEND_PROGRAM, instruction: kl.instruction, invocation: inv.index,
                signature, slot: out.slot, at,
                marketAddress: kl.lendingMarket, reserve: kl.withdrawReserve,
                mint: kl.withdrawMint, symbol: stockMints.get(kl.withdrawMint),
                collateralAmount, collateralToLiquidator: uiAmount(kl.withdrewRaw, colDec),
                collateralPriceUsd: collateralPrice, collateralUsd: mul(collateralAmount, collateralPrice),
                priceSource: collateralPrice === null ? null : 'protocol-log',
                debtMint: kl.repayMint, debtAmount, debtUsd: mul(debtAmount, debtPrice),
                liquidator: kl.liquidator, borrower: null, position: kl.obligation,
                detail: { bonusBps: kl.bonusBps, reason: kl.reason, repayReserve: kl.repayReserve, debtPriceUsd: debtPrice, amountsFrom: kl.amountsFrom }
            });
            continue;
        }
        const jl = jupiterLendLiquidation(inv, deltas);
        if (jl) {
            if (!stockMints.has(jl.collateralMint)) {
                out.otherCollateralLiquidations += 1;
                continue;
            }
            out.liquidations.push({
                protocol: 'jupiter-lend', programId: JL_VAULTS_PROGRAM, instruction: jl.instruction, invocation: inv.index,
                signature, slot: out.slot, at,
                marketAddress: jl.vaultConfig, reserve: null,
                mint: jl.collateralMint, symbol: stockMints.get(jl.collateralMint),
                collateralAmount: uiAmount(jl.collateralReceivedRaw, decimals.get(jl.collateralMint)), collateralToLiquidator: uiAmount(jl.collateralReceivedRaw, decimals.get(jl.collateralMint)),
                collateralPriceUsd: null, collateralUsd: null, priceSource: null,
                debtMint: jl.debtMint, debtAmount: uiAmount(jl.debtPaidRaw, decimals.get(jl.debtMint)), debtUsd: null,
                liquidator: jl.liquidator, borrower: null, position: null,
                detail: { vaultState: jl.vaultState, oracle: jl.oracle, event: jl.event && {
                    colAmountRaw: jl.event.colAmountRaw?.toString() ?? null, debtAmountRaw: jl.event.debtAmountRaw?.toString() ?? null, to: jl.event.to
                } }
            });
            continue;
        }
        const nest = nestLiquidation(inv, deltas);
        if (nest) {
            if (!stockMints.has(nest.collateralMint)) {
                out.otherCollateralLiquidations += 1;
                continue;
            }
            const taken = uiAmount(nest.collateralTakenRaw, decimals.get(nest.collateralMint));
            out.liquidations.push({
                protocol: 'nest', programId: NEST_PROGRAM, instruction: nest.instruction, invocation: inv.index,
                signature, slot: out.slot, at,
                marketAddress: nest.collateralConfig, reserve: null,
                mint: nest.collateralMint, symbol: stockMints.get(nest.collateralMint),
                collateralAmount: taken, collateralToLiquidator: null,
                collateralPriceUsd: null, collateralUsd: null, priceSource: null,
                debtMint: nest.nusdMint, debtAmount: nest.requestedRepayRaw === null ? null : uiAmount(nest.requestedRepayRaw, decimals.get(nest.nusdMint) ?? 6),
                debtUsd: null,
                liquidator: nest.liquidator, borrower: null, position: nest.position,
                detail: { twoStep: nest.instruction === 'start_liquidation_with_oracle' }
            });
            continue;
        }
        const ls = loopscaleLiquidation(inv, deltas);
        if (ls) {
            // The loan's collateral mint comes from the watch list (the loans the DeFi collector
            // decoded); what the liquidator's own accounts received of it in this transaction is
            // the amount, and stays unknown when the collateral is claimed in another transaction.
            const mint = loanMints.get(ls.loan) ?? null;
            if (mint === null || !stockMints.has(mint)) {
                out.otherCollateralLiquidations += 1;
                continue;
            }
            const received = [...deltas.values()].find((d) => d.owner === ls.liquidator && d.mint === mint && d.delta > 0n) ?? null;
            const amount = received ? uiAmount(received.delta, received.decimals) : null;
            out.liquidations.push({
                protocol: 'loopscale', programId: LOOPSCALE_PROGRAM, instruction: ls.instruction, invocation: inv.index,
                signature, slot: out.slot, at,
                marketAddress: ls.marketInformation, reserve: null,
                mint, symbol: stockMints.get(mint),
                collateralAmount: amount, collateralToLiquidator: amount,
                collateralPriceUsd: null, collateralUsd: null, priceSource: null,
                debtMint: ls.principalMint, debtAmount: uiAmount(ls.principalPaidRaw, decimals.get(ls.principalMint)), debtUsd: null,
                liquidator: ls.liquidator, borrower: ls.borrower, position: ls.loan,
                detail: {}
            });
        }
    }
    return out;
}
