// PURE decoders for the two Kamino Lend (KLend) account types the DeFi collectors read directly:
// Reserve (risk configuration) and Obligation (a borrower's collateral and debt). No SDK: the
// offsets below were located against a reserve the official @kamino-finance/klend-sdk 12.0.0 had
// decoded (xStocks Pool NVDAx: LTV 55 %, liquidation 65 %, bonus 500–1000 bps, recorded in
// protocol-market-research.json on 2026-09-22) and cross-checked on the obligation side against the
// obligation's own allowed/unhealthy borrow values (LTV × deposit value, to the cent). Every decode
// checks the Anchor discriminator and account size first and returns null on any mismatch, so a
// layout change is a loud "not decoded", never a plausible wrong number.

import { base58Encode } from './solana-address.mjs';

export const KLEND_PROGRAM_ID = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';
export const RESERVE_DISCRIMINATOR = '2bf2ccca1af73b7f';
export const RESERVE_SIZE = 8624;
export const OBLIGATION_DISCRIMINATOR = 'a8ce8d6a584caca7';
export const OBLIGATION_SIZE = 3344;
const EMPTY = '11111111111111111111111111111111';
const SF = 2n ** 60n;

function bytes(input) {
    if (Buffer.isBuffer(input)) return input;
    if (typeof input === 'string') return Buffer.from(input, 'base64');
    return null;
}

function key(data, offset) {
    return base58Encode(data.subarray(offset, offset + 32));
}

/** Kamino's scaled fraction (u128 with 60 fractional bits) as a Number. */
function scaledFraction(data, offset) {
    const raw = data.readBigUInt64LE(offset) + (data.readBigUInt64LE(offset + 8) << 64n);
    return Number(raw / SF) + Number(raw % SF) / Number(SF);
}

/** Risk configuration of one reserve. Percentages are whole numbers as Kamino stores them. */
export function decodeReserve(input) {
    const data = bytes(input);
    if (!data || data.length !== RESERVE_SIZE || data.subarray(0, 8).toString('hex') !== RESERVE_DISCRIMINATOR) return null;
    const statusCode = data[4856];
    return {
        lendingMarket: key(data, 32),
        liquidityMint: key(data, 128),
        statusCode,
        status: statusCode === 0 ? 'active' : statusCode === 1 ? 'obsolete' : statusCode === 2 ? 'hidden' : 'unknown',
        maxLtvPct: data[4872],
        liquidationLtvPct: data[4873],
        minLiquidationBonusBps: data.readUInt16LE(4874),
        maxLiquidationBonusBps: data.readUInt16LE(4876)
    };
}

/**
 * One obligation: owner, deposits (reserve + collateral-token amount + USD value at the last
 * refresh) and borrows (reserve + debt amount + USD value), plus the obligation's own aggregate
 * values. USD values are what Kamino stored at the obligation's last RefreshObligation.
 */
export function decodeObligation(input) {
    const data = bytes(input);
    if (!data || data.length !== OBLIGATION_SIZE || data.subarray(0, 8).toString('hex') !== OBLIGATION_DISCRIMINATOR) return null;
    const deposits = [];
    for (let i = 0; i < 8; i += 1) {
        const offset = 96 + i * 136;
        const reserve = key(data, offset);
        if (reserve === EMPTY) continue;
        deposits.push({
            reserve,
            collateralAmountRaw: data.readBigUInt64LE(offset + 32).toString(),
            marketValueUsd: scaledFraction(data, offset + 40)
        });
    }
    const borrows = [];
    for (let i = 0; i < 5; i += 1) {
        const offset = 1208 + i * 200;
        const reserve = key(data, offset);
        if (reserve === EMPTY) continue;
        borrows.push({
            reserve,
            borrowedAmountRaw: scaledFraction(data, offset + 88),
            marketValueUsd: scaledFraction(data, offset + 104)
        });
    }
    const depositedValueUsd = scaledFraction(data, 1192);
    const borrowFactorAdjustedDebtUsd = scaledFraction(data, 2208);
    const allowedBorrowValueUsd = scaledFraction(data, 2240);
    const unhealthyBorrowValueUsd = scaledFraction(data, 2256);
    return {
        lendingMarket: key(data, 32),
        owner: key(data, 64),
        lastUpdateSlot: Number(data.readBigUInt64LE(16)),
        deposits,
        borrows,
        depositedValueUsd,
        borrowFactorAdjustedDebtUsd,
        borrowedAssetsMarketValueUsd: scaledFraction(data, 2224),
        allowedBorrowValueUsd,
        unhealthyBorrowValueUsd,
        loanToValue: depositedValueUsd > 0 ? borrowFactorAdjustedDebtUsd / depositedValueUsd : null,
        liquidationLoanToValue: depositedValueUsd > 0 ? unhealthyBorrowValueUsd / depositedValueUsd : null
    };
}

/**
 * How far the collateral price can fall (fraction, e.g. 0.127 = 12.7 %) before a single-collateral
 * obligation reaches its liquidation threshold, holding debt constant. Null when not computable.
 */
export function priceDropToLiquidation(obligation) {
    const ltv = obligation?.loanToValue;
    const liq = obligation?.liquidationLoanToValue;
    if (typeof ltv !== 'number' || typeof liq !== 'number' || !Number.isFinite(ltv) || !Number.isFinite(liq) || liq <= 0) return null;
    if (ltv === 0) return 1;
    return Math.max(0, 1 - ltv / liq);
}
