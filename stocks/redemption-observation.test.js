// Fast tests for the on-chain redemption classifier against real, trimmed mainnet transactions:
// an Ondo GM redemption, mint and solver-routed redemption, the three xStocks redemption legs and
// an ordinary DEX swap that must never be read as a redemption.
const fixture = require('./fixtures/redemption-observation.sample.json');
const {
    classifyOndoTransaction, classifyXstocksLeg, pairXstocksRedemption
} = require('./lib/redemption-observation.mjs');

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDON = 'ZPFtoCe7WWqG4N3ZFRccS8T9SMBeHsd1Vmgv2i7ondo';
const NVDAON = 'gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo';
const METAX = 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu';
const ondoOpts = { stablecoins: { [USDC]: 'USDC', [USDON]: 'USDon' } };
const xsOpts = {
    treasury: 'S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS',
    redemptionAddresses: ['CgyuW2dWDJzWW2H1XTjPRkbg9Y41dW2Fjj69KWsiir8C'],
    xstockMints: new Set([METAX]),
    stablecoins: { [USDC]: 'USDC' }
};
const clone = (value) => JSON.parse(JSON.stringify(value));

describe('Ondo GM redemption classifier', () => {
    test('classifies an atomic burn-and-pay as an issuer redemption', () => {
        expect(classifyOndoTransaction(fixture.ondoRedeem, ondoOpts)).toMatchObject({
            kind: 'issuer-redemption', instruction: 'RedeemForUsdc', routed: false,
            holder: '2Cq2RNFFxxPXL7teNQAji1beA2vFbBDYW5BGPBFvoN9m', tokenMint: NVDAON,
            tokenAmount: 1.707764558, payoutSymbol: 'USDC', payoutAmount: 385.066699,
            slot: 449781266, blockTime: '2026-09-23T18:13:56Z'
        });
    });

    test('a GM mint is a subscription, not a redemption', () => {
        expect(classifyOndoTransaction(fixture.ondoMint, ondoOpts).kind).toBe('issuer-mint');
    });

    test('a redeem inside a solver program is intermediated, not a direct holder redemption', () => {
        expect(classifyOndoTransaction(fixture.ondoIntermediated, ondoOpts)).toMatchObject({
            kind: 'intermediated-redemption', routed: true
        });
    });

    test('an ordinary DEX swap never touches the issuer program', () => {
        expect(classifyOndoTransaction(fixture.dexSwap, ondoOpts).kind).toBe('not-issuer-program');
    });

    test('without the burn the same transaction is not accepted', () => {
        const tx = clone(fixture.ondoRedeem);
        for (const group of tx.meta.innerInstructions) {
            group.instructions = group.instructions.filter((ix) => ix.parsed?.type !== 'burnChecked');
        }
        expect(classifyOndoTransaction(tx, ondoOpts).kind).toBe('unclassified');
    });

    test('a failed transaction is never an observation, and an unknown mint is not a GM burn', () => {
        const failed = clone(fixture.ondoRedeem);
        failed.meta.err = { InstructionError: [1, 'Custom'] };
        expect(classifyOndoTransaction(failed, ondoOpts).kind).toBe('failed');
        expect(classifyOndoTransaction(fixture.ondoRedeem, { ...ondoOpts, gmMints: new Set(['other']) }).kind)
            .toBe('unclassified');
    });
});

describe('xStocks three-leg redemption', () => {
    const deposit = classifyXstocksLeg(fixture.xsDeposit, xsOpts);
    const sweep = classifyXstocksLeg(fixture.xsSweep, xsOpts);
    const payout = classifyXstocksLeg(fixture.xsPayout, xsOpts);

    test('classifies each leg from its own balance movements', () => {
        expect(deposit).toMatchObject({ kind: 'holder-deposit', holder: 'GQEwLMrpyr9x99CnHFAnQhHrwm7a36Qc1FYEw9Cdp6kG', tokenAmount: 8.791851 });
        expect(sweep).toMatchObject({ kind: 'redemption-sweep', tokenMint: METAX, tokenAmount: 8.791851 });
        expect(payout).toMatchObject({ kind: 'treasury-stablecoin-payout', payoutSymbol: 'USDC', payoutAmount: 6598.936608 });
    });

    test('a DEX swap of the same token is not a redemption leg', () => {
        expect(classifyXstocksLeg(fixture.dexSwap, xsOpts).kind).toBe('other');
    });

    test('pairs deposit, sweep and payout when the implied price matches the market', () => {
        expect(pairXstocksRedemption({ deposit, sweep, payouts: [payout], referencePriceUsd: 756.75 })).toMatchObject({
            accepted: true, settlementSeconds: 46, legs: { deposit: deposit.signature, sweep: sweep.signature, payout: payout.signature }
        });
    });

    test('refuses a price mismatch, a missing reference, a late payout and an ambiguous pair', () => {
        expect(pairXstocksRedemption({ deposit, sweep, payouts: [payout], referencePriceUsd: 900 }).accepted).toBe(false);
        expect(pairXstocksRedemption({ deposit, sweep, payouts: [payout], referencePriceUsd: null }))
            .toMatchObject({ accepted: false, reason: 'no independent reference price' });
        expect(pairXstocksRedemption({ deposit, sweep, payouts: [payout], referencePriceUsd: 756.75, maxSeconds: 10 }).accepted).toBe(false);
        const twin = { ...payout, signature: 'twin', payoutAmount: payout.payoutAmount + 1 };
        expect(pairXstocksRedemption({ deposit, sweep, payouts: [payout, twin], referencePriceUsd: 756.75 }))
            .toMatchObject({ accepted: false, reason: 'ambiguous: 2 payouts fit' });
    });

    test('a sweep that does not carry the deposit is rejected', () => {
        const other = { ...sweep, tokenAmount: 1 };
        expect(pairXstocksRedemption({ deposit, sweep: other, payouts: [payout], referencePriceUsd: 756.75 }).accepted).toBe(false);
    });
});
