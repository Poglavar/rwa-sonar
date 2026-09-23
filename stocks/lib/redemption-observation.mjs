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

import { tokenBalanceDeltas } from './trades.mjs';

export const ONDO_GM_PROGRAM = 'XzTT4XB8m7sLD2xi6snefSasaswsKCxx5Tifjondogm';
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
    if (!redeem) return { ...base, kind: mint ? 'issuer-mint' : 'issuer-admin-or-other', instruction: mint ?? logged[0] ?? null };

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
                reason: 'redeemed through an intermediary program; proceeds routed onward' }
            : { ...base, kind: 'unclassified', instruction: redeem, reason: 'no matching holder token decrease and stablecoin increase' };
    }

    const decimals = Number(burn.tokenAmount?.decimals);
    const raw = rawAmount(burn);
    return {
        ...base,
        kind: 'issuer-redemption',
        instruction: redeem,
        routed,
        redeemer,
        holder,
        tokenMint: burn.mint,
        tokenAmount: raw !== null && Number.isInteger(decimals) ? Number(raw) / 10 ** decimals : -tokenOut.delta,
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
