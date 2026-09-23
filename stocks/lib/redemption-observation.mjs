// Classifies Solana transactions as observed issuer redemptions (versus mints, DEX trades and
// other transfers) for the programmes whose redemption leaves an on-chain trail. Pure: it reads
// jsonParsed getTransaction objects and returns facts; fetching and recording live elsewhere.
//
// Two settlement shapes exist and they need different proof:
// - Ondo Global Markets: ONE atomic transaction of the Ondo GM program (redeem_for_usdc /
//   redeem_for_usdon) burns the holder's GM token and pays USDon, or USDC out of the program's
//   own vault, to the same signer. The transaction alone is the proof.
// - xStocks (Backed): THREE separate transactions — the holder transfers the xStock to the
//   issuer's redemption address, the issuer sweeps it to its treasury, and the treasury pays a
//   stablecoin back to the holder. Nothing on-chain links the legs, so a payout is accepted only
//   when it is the single payout to that holder, inside the settlement window, whose implied price
//   agrees with an independent market price.
// - Superstate Opening Bell: a burn-to-book-entry CONVERSION, not a cash redemption. The holder
//   sends the equity token to the published burn address, whose owner then burns it; the transfer
//   agent credits book-entry shares off-chain. The two on-chain legs are observable, the book-entry
//   credit is not, and by design no payout ever appears on-chain.

import { tokenBalanceDeltas } from './trades.mjs';

export const ONDO_GM_PROGRAM = 'XzTT4XB8m7sLD2xi6snefSasaswsKCxx5Tifjondogm';
/** The GM mint-authority PDA of the Ondo program: a mint it controls is a GM token. */
export const ONDO_GM_MINT_AUTHORITY = '9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD';
export const XSTOCKS_TREASURY = 'S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS';
export const XSTOCKS_REDEMPTION_ADDRESS = 'CgyuW2dWDJzWW2H1XTjPRkbg9Y41dW2Fjj69KWsiir8C';
/** Superstate's published Solana equity burn address (docs.superstate.com, "Burn to book-entry"). */
export const SUPERSTATE_EQUITY_BURN_ADDRESS = '2u8YwJTykTreziHBN5QwE7Bi2SyN8M2MicCscthtph9E';
export const ONDO_REDEEM_INSTRUCTIONS = ['RedeemForUsdc', 'RedeemForUsdon'];
export const ONDO_MINT_INSTRUCTIONS = ['MintWithUsdc', 'MintWithUsdon'];

/** Programs that may appear at top level of a direct Ondo redemption without making it routed. */
const ONDO_DIRECT_TOP_LEVEL = new Set([
    ONDO_GM_PROGRAM,
    'KeccakSecp256k11111111111111111111111111111',
    'ComputeBudget111111111111111111111111111111',
    '11111111111111111111111111111111',
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
]);

function keyOf(entry) {
    return typeof entry === 'string' ? entry : entry?.pubkey ?? null;
}

function signersOf(tx) {
    const keys = tx?.transaction?.message?.accountKeys;
    return (Array.isArray(keys) ? keys : []).filter((k) => typeof k === 'object' && k?.signer).map(keyOf);
}

function parsedInstructions(tx) {
    const top = tx?.transaction?.message?.instructions ?? [];
    const inner = (tx?.meta?.innerInstructions ?? []).flatMap((group) => group?.instructions ?? []);
    return [...top, ...inner].filter((ix) => ix?.parsed && typeof ix.parsed === 'object');
}

function anchorInstructions(tx) {
    return (tx?.meta?.logMessages ?? [])
        .filter((line) => typeof line === 'string' && line.startsWith('Program log: Instruction: '))
        .map((line) => line.slice('Program log: Instruction: '.length));
}

function topLevelProgramIds(tx) {
    return (tx?.transaction?.message?.instructions ?? []).map((ix) => ix?.programId).filter(Boolean);
}

function rawAmount(info) {
    const raw = info?.tokenAmount?.amount ?? info?.amount;
    return typeof raw === 'string' && /^\d+$/.test(raw) ? BigInt(raw) : null;
}

function timeOf(tx) {
    return typeof tx?.blockTime === 'number' ? new Date(tx.blockTime * 1000).toISOString().replace('.000Z', 'Z') : null;
}

/** Burned token units: the burn's raw amount over its decimals, else the owner's balance drop. */
function burnedAmount(burn, tokenOut) {
    const decimals = Number(burn.tokenAmount?.decimals);
    const raw = rawAmount(burn);
    if (raw !== null && Number.isInteger(decimals)) return Number(raw) / 10 ** decimals;
    return tokenOut ? -tokenOut.delta : null;
}

function decimalsForMint(meta, mint) {
    for (const balance of [...(meta?.postTokenBalances ?? []), ...(meta?.preTokenBalances ?? [])]) {
        const d = balance?.uiTokenAmount?.decimals;
        if (balance?.mint === mint && Number.isInteger(d)) return d;
    }
    return null;
}

/**
 * The creation side of an Ondo GM subscription (MintWithUsdc / MintWithUsdon): the GM units minted
 * by the program's mint-authority PDA and the stablecoin the signer paid in the same transaction.
 * Amounts are null — never zero — when the transaction does not show them unambiguously (no mintTo
 * by the PDA, two different GM mints, or unknown decimals).
 */
function ondoMintAmounts(tx, stablecoins) {
    const mints = parsedInstructions(tx).filter((ix) => ix.parsed.type === 'mintTo' || ix.parsed.type === 'mintToChecked')
        .filter((ix) => ix.parsed.info?.mintAuthority === ONDO_GM_MINT_AUTHORITY);
    const distinct = [...new Set(mints.map((ix) => ix.parsed.info?.mint))];
    if (distinct.length !== 1) return { tokenMint: null, tokenAmount: null, paidSymbol: null, paidAmount: null, amountNote: `expected one GM mint minted by the program PDA, found ${distinct.length}` };
    const tokenMint = distinct[0];
    const decimals = decimalsForMint(tx.meta, tokenMint);
    let raw = 0n;
    for (const ix of mints) {
        const r = rawAmount(ix.parsed.info);
        if (r === null) { raw = null; break; }
        raw += r;
    }
    const tokenAmount = raw !== null && decimals !== null ? Number(raw) / 10 ** decimals : null;
    const signers = signersOf(tx);
    const paid = tokenBalanceDeltas(tx.meta).filter((d) => signers.includes(d.owner) && d.delta < 0 && d.mint in stablecoins)
        .sort((a, b) => a.delta - b.delta)[0] ?? null;
    return { tokenMint, tokenAmount, paidSymbol: paid ? stablecoins[paid.mint] : null, paidAmount: paid ? -paid.delta : null };
}

/**
 * One Ondo GM transaction → `{kind, ...}`. `kind` is 'issuer-redemption' only when the program
 * logged a redeem instruction, the transaction succeeded, the signer's own GM balance was burned
 * (supply reduced, so this is not a transfer to a counterparty) and the same signer's stablecoin
 * balance rose. A redeem performed inside a third-party program (an intent solver or aggregator)
 * is 'intermediated-redemption': the issuer leg happened, but the redeemer is the intermediary.
 */
export function classifyOndoTransaction(tx, { gmMints = null, program = ONDO_GM_PROGRAM, stablecoins = {} } = {}) {
    const signature = tx?.transaction?.signatures?.[0] ?? null;
    const base = { signature, slot: tx?.slot ?? null, blockTime: timeOf(tx) };
    if (tx?.meta?.err) return { ...base, kind: 'failed' };
    const keys = (tx?.transaction?.message?.accountKeys ?? []).map(keyOf);
    if (!keys.includes(program)) return { ...base, kind: 'not-issuer-program' };

    const logged = anchorInstructions(tx);
    const redeem = logged.find((name) => ONDO_REDEEM_INSTRUCTIONS.includes(name)) ?? null;
    const mint = logged.find((name) => ONDO_MINT_INSTRUCTIONS.includes(name)) ?? null;
    if (!redeem && mint) return { ...base, kind: 'issuer-mint', instruction: mint, ...ondoMintAmounts(tx, stablecoins) };
    if (!redeem) return { ...base, kind: 'issuer-admin-or-other', instruction: logged[0] ?? null };

    const signers = signersOf(tx);
    const burns = parsedInstructions(tx).filter((ix) => ix.parsed.type === 'burnChecked' || ix.parsed.type === 'burn')
        .filter((ix) => signers.includes(ix.parsed.info?.authority))
        .filter((ix) => gmMints === null || gmMints.has(ix.parsed.info?.mint));
    if (burns.length !== 1) return { ...base, kind: 'unclassified', instruction: redeem, reason: `expected one holder-signed GM burn, found ${burns.length}` };
    const burn = burns[0].parsed.info;
    const redeemer = burn.authority;

    const deltas = tokenBalanceDeltas(tx.meta);
    // The burned account's OWNER is the holder; the burn authority may be a delegate (a solver).
    const tokenOuts = deltas.filter((d) => d.mint === burn.mint && d.delta < 0);
    const tokenOut = tokenOuts.length === 1 ? tokenOuts[0] : null;
    const holder = tokenOut?.owner ?? null;
    // The holder must itself sign and be paid: a co-signing front end or delegate may hold the
    // burn authority, but the proceeds have to land with the holder whose tokens were burned.
    const payout = deltas.filter((d) => d.owner === holder && signers.includes(holder) && d.delta > 0 && d.mint in stablecoins)
        .sort((a, b) => b.delta - a.delta)[0] ?? null;
    const routed = topLevelProgramIds(tx).some((id) => !ONDO_DIRECT_TOP_LEVEL.has(id));
    if (!tokenOut || !payout || routed) {
        // A solver can redeem inside its own program, as delegate of the holder's account, and
        // forward the proceeds onward in the same transaction: the burn is real, but the leg to
        // the end holder runs through the intermediary's own terms, not the issuer's.
        return routed && tokenOut
            ? { ...base, kind: 'intermediated-redemption', instruction: redeem, routed, redeemer, holder, tokenMint: burn.mint,
                tokenAmount: burnedAmount(burn, tokenOut),
                reason: 'redeemed through an intermediary program; proceeds routed onward' }
            : { ...base, kind: 'unclassified', instruction: redeem, reason: 'no matching holder token decrease and stablecoin increase' };
    }

    return {
        ...base,
        kind: 'issuer-redemption',
        instruction: redeem,
        routed,
        redeemer,
        holder,
        tokenMint: burn.mint,
        tokenAmount: burnedAmount(burn, tokenOut),
        payoutMint: payout.mint,
        payoutSymbol: stablecoins[payout.mint],
        payoutAmount: payout.delta
    };
}

/**
 * One xStocks transfer leg, from the issuer's point of view. `treasury` is the issuer wallet that
 * receives every mintTo and pays redemption proceeds; `redemptionAddresses` are the documented
 * per-chain redemption (sweeping) addresses. Anything else — a DEX swap, a wallet-to-wallet send —
 * is 'other', which is how an ordinary trade is kept out of the redemption evidence.
 */
export function classifyXstocksLeg(tx, { treasury, redemptionAddresses = [], xstockMints, stablecoins = {} }) {
    const signature = tx?.transaction?.signatures?.[0] ?? null;
    const base = { signature, slot: tx?.slot ?? null, blockTime: timeOf(tx) };
    if (tx?.meta?.err) return { ...base, kind: 'failed' };
    const redemption = new Set(redemptionAddresses);
    const deltas = tokenBalanceDeltas(tx.meta);
    const one = (predicate) => { const hits = deltas.filter(predicate); return hits.length === 1 ? hits[0] : null; };

    const toRedemption = one((d) => redemption.has(d.owner) && d.delta > 0 && xstockMints.has(d.mint));
    if (toRedemption) {
        const from = one((d) => d.mint === toRedemption.mint && d.delta < 0 && !redemption.has(d.owner) && d.owner !== treasury);
        if (from && Math.abs(from.delta + toRedemption.delta) < 1e-9 && deltas.length === 2) {
            return { ...base, kind: 'holder-deposit', holder: from.owner, redemptionAddress: toRedemption.owner,
                tokenMint: from.mint, tokenAmount: -from.delta };
        }
    }
    const intoTreasury = one((d) => d.owner === treasury && d.delta > 0 && xstockMints.has(d.mint));
    if (intoTreasury) {
        const from = one((d) => d.mint === intoTreasury.mint && d.delta < 0);
        if (from && redemption.has(from.owner) && deltas.length === 2) {
            return { ...base, kind: 'redemption-sweep', redemptionAddress: from.owner, tokenMint: from.mint, tokenAmount: intoTreasury.delta };
        }
    }
    const payout = one((d) => d.owner === treasury && d.delta < 0 && d.mint in stablecoins);
    if (payout && signersOf(tx).includes(treasury)) {
        const to = one((d) => d.mint === payout.mint && d.delta > 0);
        if (to && deltas.length === 2) {
            return { ...base, kind: 'treasury-stablecoin-payout', recipient: to.owner, payoutMint: payout.mint,
                payoutSymbol: stablecoins[payout.mint], payoutAmount: to.delta };
        }
    }
    return { ...base, kind: 'other' };
}

/**
 * Link a holder deposit, its sweep and a treasury payout into one redemption, or say why not.
 * The payout must go to the depositing holder after the deposit and within `maxSeconds`, and its
 * implied price (payout / tokens) must be within `tolerance` of `referencePriceUsd`. Exactly one
 * payout may fit: two candidates make the attribution a guess, and a guess is not an observation.
 */
export function pairXstocksRedemption({ deposit, sweep = null, payouts = [], referencePriceUsd, maxSeconds = 180, tolerance = 0.02 }) {
    if (deposit?.kind !== 'holder-deposit') return { accepted: false, reason: 'not a holder deposit to a redemption address' };
    if (!(typeof referencePriceUsd === 'number' && Number.isFinite(referencePriceUsd) && referencePriceUsd > 0)) {
        return { accepted: false, reason: 'no independent reference price' };
    }
    const t0 = Date.parse(deposit.blockTime);
    if (sweep) {
        const sweptMatches = sweep.kind === 'redemption-sweep' && sweep.tokenMint === deposit.tokenMint
            && Math.abs(sweep.tokenAmount - deposit.tokenAmount) < 1e-9 && Date.parse(sweep.blockTime) >= t0;
        if (!sweptMatches) return { accepted: false, reason: 'sweep does not carry the deposited amount to the treasury' };
    }
    const fits = payouts.filter((p) => p?.kind === 'treasury-stablecoin-payout' && p.recipient === deposit.holder)
        .filter((p) => { const dt = (Date.parse(p.blockTime) - t0) / 1000; return dt >= 0 && dt <= maxSeconds; })
        .map((p) => ({ payout: p, impliedPriceUsd: p.payoutAmount / deposit.tokenAmount }))
        .filter((c) => Math.abs(c.impliedPriceUsd / referencePriceUsd - 1) <= tolerance);
    if (fits.length === 0) return { accepted: false, reason: 'no payout to the holder at a price consistent with the market inside the window' };
    if (fits.length > 1) return { accepted: false, reason: `ambiguous: ${fits.length} payouts fit` };
    const [{ payout, impliedPriceUsd }] = fits;
    return {
        accepted: true,
        holder: deposit.holder,
        tokenMint: deposit.tokenMint,
        tokenAmount: deposit.tokenAmount,
        payoutSymbol: payout.payoutSymbol,
        payoutAmount: payout.payoutAmount,
        impliedPriceUsd,
        referencePriceUsd,
        settlementSeconds: (Date.parse(payout.blockTime) - t0) / 1000,
        legs: { deposit: deposit.signature, sweep: sweep?.signature ?? null, payout: payout.signature }
    };
}

function memosOf(tx) {
    return (tx?.transaction?.message?.instructions ?? [])
        .filter((ix) => ix?.program === 'spl-memo' && typeof ix.parsed === 'string').map((ix) => ix.parsed);
}

/**
 * One transaction touching Superstate's equity burn address. 'holder-deposit' is a holder sending
 * an Opening Bell equity token to the burn address (exactly two balance movements that cancel);
 * 'issuer-burn' is the burn address's owner burning an equity balance it holds. A burn of any
 * other Superstate mint at the same address (the funds share it) is 'other-mint': the fund route
 * pays out and is a different product.
 */
export function classifySuperstateLeg(tx, { burnAddress = SUPERSTATE_EQUITY_BURN_ADDRESS, equityMints }) {
    const signature = tx?.transaction?.signatures?.[0] ?? null;
    const base = { signature, slot: tx?.slot ?? null, blockTime: timeOf(tx) };
    if (tx?.meta?.err) return { ...base, kind: 'failed' };
    const deltas = tokenBalanceDeltas(tx.meta);
    const burns = parsedInstructions(tx).filter((ix) => ix.parsed.type === 'burnChecked' || ix.parsed.type === 'burn')
        .filter((ix) => (ix.parsed.info?.authority ?? ix.parsed.info?.multisigAuthority) === burnAddress);
    if (burns.length === 1) {
        const info = burns[0].parsed.info;
        const out = deltas.find((d) => d.owner === burnAddress && d.mint === info.mint && d.delta < 0) ?? null;
        if (!equityMints.has(info.mint)) return { ...base, kind: 'other-mint', tokenMint: info.mint };
        if (out && deltas.length === 1) {
            return { ...base, kind: 'issuer-burn', tokenMint: info.mint, tokenAmount: -out.delta };
        }
        return { ...base, kind: 'unclassified', reason: 'burn by the burn address without a matching single balance decrease' };
    }
    const into = deltas.filter((d) => d.owner === burnAddress && d.delta > 0);
    if (into.length === 1 && deltas.length === 2) {
        const from = deltas.find((d) => d.mint === into[0].mint && d.delta < 0 && d.owner !== burnAddress) ?? null;
        if (from && Math.abs(from.delta + into[0].delta) < 1e-9) {
            if (!equityMints.has(from.mint)) return { ...base, kind: 'other-mint', tokenMint: from.mint };
            return { ...base, kind: 'holder-deposit', holder: from.owner, tokenMint: from.mint, tokenAmount: into[0].delta,
                memo: memosOf(tx)[0] ?? null };
        }
    }
    return { ...base, kind: 'other' };
}

/**
 * Tie an issuer burn to the holder deposit it consumed: same mint and amount, deposited no later
 * than the burn and within `maxSeconds`; the most recent such deposit wins, each deposit once.
 * An unmatched burn is still the issuer's own conversion act — it is returned with holder null.
 */
export function pairSuperstateConversion({ burn, deposits = [], used = new Set(), maxSeconds = 7 * 86400 }) {
    const t = Date.parse(burn.blockTime);
    const match = deposits.filter((d) => d?.kind === 'holder-deposit' && !used.has(d.signature) && d.tokenMint === burn.tokenMint
        && Math.abs(d.tokenAmount - burn.tokenAmount) < 1e-9)
        .filter((d) => { const dt = (t - Date.parse(d.blockTime)) / 1000; return dt >= 0 && dt <= maxSeconds; })
        .sort((a, b) => Date.parse(b.blockTime) - Date.parse(a.blockTime))[0] ?? null;
    return {
        holder: match?.holder ?? null,
        tokenMint: burn.tokenMint,
        tokenAmount: burn.tokenAmount,
        memo: match?.memo ?? null,
        secondsToBurn: match ? (t - Date.parse(match.blockTime)) / 1000 : null,
        legs: { deposit: match?.signature ?? null, burn: burn.signature }
    };
}

/**
 * The independent market price of `mint` at `time`: the median of at least `minPrints` non-suspect
 * DEX trades within ±`windowSeconds` (the trade collector's stocks/data/trades-24h.json rows).
 * Returns null rather than a thin guess, so a redemption is never priced off one print.
 */
export function referencePriceAt(trades, { mint, time, windowSeconds = 1800, minPrints = 3 }) {
    const t = Date.parse(time);
    if (!Number.isFinite(t)) return null;
    const prices = (Array.isArray(trades) ? trades : [])
        .filter((row) => row?.mint === mint && !row.suspect && typeof row.priceUsd === 'number' && Number.isFinite(row.priceUsd) && row.priceUsd > 0)
        .filter((row) => Math.abs(Date.parse(row.time) - t) <= windowSeconds * 1000)
        .map((row) => row.priceUsd).sort((a, b) => a - b);
    if (prices.length < minPrints) return null;
    const mid = Math.floor(prices.length / 2);
    return prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
}
