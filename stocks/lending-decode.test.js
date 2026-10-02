// Unit tests for stocks/lib/lending-decode.mjs — reading liquidations and collateral price
// observations out of real lending transactions. Every fixture in fixtures/lending/transactions.sample.json
// is a getTransaction(json, v0) result captured read-only from mainnet on 2026-09-24:
//   kamino-liquidation-hoodx            5M5fgsqf… 2026-07-31 KLend v2 liquidation, HOODx seized for USDC (refresh_reserves_batch)
//   kamino-liquidation-mstrx-spyx-debt  sReCn1Hg… 2026-07-23 MSTRx seized for SPYx debt, TSLAx TWAP divergence logged
//   kamino-stale-qqqx                   4yQFa5RQ… 2026-09-19 failed withdraw: "Price is too old age=3607" for QQQx
//   kamino-stale-four-xstocks           2FqsYtM2… 2026-09-24 09:01 the all-xStock refresh gap, four stale reserves
//   scope-resume-qqqx                   26SQ52zV… 2026-09-21 Scope ResumeSuspendedPrice for entry 280 (QQQx)
//   jupiter-lend-lift-qqqx              4yhWfLvG… 2026-09-21 Jupiter Lend lifts the QQQx cache suspension
//   nest-start-liquidation-silver       5sm1QsgW… 2026-09-11 Nest two-step liquidation of a non-stock collateral

import { readFileSync } from 'node:fs';

import {
    KLEND_PROGRAM, anchorDiscriminator, decodeLendingTransaction, jupiterOracleEvents, kaminoLiquidation,
    kaminoRefreshes, scopeResume, tokenDeltas, txInvocations, uiAmount
} from './lib/lending-decode.mjs';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/lending/transactions.sample.json', import.meta.url), 'utf8')).transactions;
const HOODX = 'XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg';
const MSTRX = 'XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ';
const SPYX = 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SILVER = 'SiLVFMgD3eD2rgK628NbTBq9MnuJF5FW2CRaVyTB35L';
const STOCKS = new Map([[HOODX, 'HOODx'], [MSTRX, 'MSTRx'], [SPYX, 'SPYx']]);
const QQQX_RESERVE = '2jerdAXR8r2B6z3P7P6VgSiePQX7wqcpbEqdDbm8mgeB';
const HOODX_RESERVE = '4UBJu5Xp1aziV9frBQBhc1RnKrgXHAWHYejQytkYr8gq';

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

describe('transactions as invocations', () => {
    test('log lines land on the instruction that printed them, inner calls included', () => {
        const { invocations, aligned } = txInvocations(FIXTURE['kamino-liquidation-hoodx']);
        expect(aligned).toBe(true);
        const klend = invocations.filter((inv) => inv.programId === KLEND_PROGRAM);
        expect(klend.map((inv) => inv.logs[0])).toEqual([
            'Instruction: RefreshReservesBatch', 'Instruction: RefreshObligation', 'Instruction: LiquidateObligationAndRedeemReserveCollateralV2'
        ]);
        // The farms program's logs belong to its own inner invocation, not to KLend's liquidation.
        const liquidation = klend[2];
        expect(liquidation.logs.some((line) => line.startsWith('pnl: Liquidator repaid 20257283'))).toBe(true);
        expect(liquidation.logs.some((line) => line.startsWith('SetStakeDelegated'))).toBe(false);
    });

    test('a log that names another program than the instruction list stops attributing logs', () => {
        const tx = clone(FIXTURE['kamino-liquidation-hoodx']);
        tx.meta.logMessages = tx.meta.logMessages.map((line) => line.replace(`Program ${KLEND_PROGRAM} invoke [1]`, 'Program 11111111111111111111111111111111 invoke [1]'));
        const { invocations, aligned } = txInvocations(tx);
        expect(aligned).toBe(false);
        expect(invocations.filter((inv) => inv.programId === KLEND_PROGRAM).every((inv) => inv.logs.length === 0)).toBe(true);
        // The liquidation still happened (its instruction ran in a successful transaction): its
        // amounts come from the reserves' balances instead, and with no price logged the USD value
        // is unknown — null, never 0.
        const decoded = decodeLendingTransaction(tx, { stockMints: STOCKS });
        expect(decoded.warnings).toEqual(['logs do not match the instructions']);
        expect(decoded.observations).toEqual([]);
        expect(decoded.liquidations[0]).toMatchObject({
            collateralAmount: 0.24858447, collateralToLiquidator: null, debtAmount: 20.257283,
            collateralPriceUsd: null, collateralUsd: null, priceSource: null, detail: { amountsFrom: 'token-balances' }
        });
    });

    test('token balance changes are signed raw amounts per account', () => {
        const deltas = tokenDeltas(FIXTURE['kamino-liquidation-hoodx']);
        const supply = [...deltas.values()].find((d) => d.account === 'FxKswSw4T1agtrVJwQnk5pi92rrQujczQFysghqpkrW');
        expect(supply).toMatchObject({ mint: HOODX, decimals: 8, delta: -24858447n });
        expect(uiAmount(-24858447n, 8)).toBe(-0.24858447);
        expect(uiAmount(1n, null)).toBeNull();
    });
});

describe('Kamino reserve price observations', () => {
    test('a batch refresh names each reserve in its account order, with the price KLend logged', () => {
        const inv = txInvocations(FIXTURE['kamino-liquidation-hoodx']).invocations.find((i) => i.logs[0] === 'Instruction: RefreshReservesBatch');
        expect(kaminoRefreshes(inv).map((o) => [o.reserve, o.name, o.price, o.stale])).toEqual([
            [HOODX_RESERVE, 'HOODx', 85.55, false],
            ['97zoywd8mPZsGTg8q1wdD2Wgkdrs2tqusp1Qqcxbyj7E', 'USDC', 0.9998, false]
        ]);
    });

    test('a stale price carries its age and the limit; the TWAP line is not read as the price', () => {
        const decoded = decodeLendingTransaction(FIXTURE['kamino-stale-qqqx'], { stockMints: STOCKS });
        const qqqx = decoded.observations.find((o) => o.reserve === QQQX_RESERVE);
        expect(qqqx).toMatchObject({ name: 'QQQx', stale: true, ageS: 3607, maxAgeS: 300, twapStale: true, price: 723.5764 });
        expect(decoded.observations.filter((o) => o.stale)).toHaveLength(1);
        expect(decoded.failed).toBe(true);
        expect(decoded.blockTime).toBe('2026-09-19T18:28:52Z');
    });

    test('the 24 Sep refresh gap: four xStocks stale at the same age, USDC fresh', () => {
        const decoded = decodeLendingTransaction(FIXTURE['kamino-stale-four-xstocks'], { stockMints: STOCKS });
        expect(decoded.observations.map((o) => `${o.name}:${o.stale ? o.ageS : 'fresh'}`)).toEqual(['NVDAx:1287', 'GOOGLx:1287', 'SPYx:1287', 'USDC:fresh', 'AAPLx:1287']);
    });

    test('a refresh whose closing lines do not match its reserves is not attributed at all', () => {
        const inv = txInvocations(FIXTURE['kamino-liquidation-hoodx']).invocations.find((i) => i.logs[0] === 'Instruction: RefreshReservesBatch');
        expect(kaminoRefreshes({ ...inv, logs: inv.logs.filter((line) => !line.startsWith('Token: USDC')) })).toEqual([]);
    });
});

describe('Kamino liquidations', () => {
    test('HOODx: collateral taken = what the liquidator got + the protocol fee, valued at the logged price', () => {
        const [liq] = decodeLendingTransaction(FIXTURE['kamino-liquidation-hoodx'], { stockMints: STOCKS }).liquidations;
        expect(liq).toMatchObject({
            protocol: 'kamino', instruction: 'liquidate_obligation_and_redeem_reserve_collateral_v2', at: '2026-07-31T13:30:51Z',
            marketAddress: '5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua', reserve: HOODX_RESERVE, mint: HOODX, symbol: 'HOODx',
            collateralAmount: 0.24858447, collateralToLiquidator: 0.24266579, collateralPriceUsd: 85.55, priceSource: 'protocol-log',
            debtMint: USDC, debtAmount: 20.257283,
            liquidator: '7dGrdJRYtsNR8UYxZ3TnifXGjGc9eRYLq9sELwYpuuUu', position: 'An6n6M3jjkCuDrU5JSLnhrvaLjDfcVDvJBVwFoi7eArt'
        });
        expect(liq.collateralUsd).toBeCloseTo(21.2664, 4);
        expect(liq.debtUsd).toBeCloseTo(20.2532, 4);
        expect(liq.detail).toMatchObject({ bonusBps: 500, reason: 'LtvExceeded' });
        // Cross-check against the chain's own balances: the reserve's supply vault lost exactly that much.
        const supply = tokenDeltas(FIXTURE['kamino-liquidation-hoodx']).get('FxKswSw4T1agtrVJwQnk5pi92rrQujczQFysghqpkrW');
        expect(uiAmount(-supply.delta, 8)).toBe(liq.collateralAmount);
    });

    test('MSTRx seized for a SPYx debt: the debt side takes the SPYx reserve price from the same transaction', () => {
        const [liq] = decodeLendingTransaction(FIXTURE['kamino-liquidation-mstrx-spyx-debt'], { stockMints: STOCKS }).liquidations;
        expect(liq).toMatchObject({ mint: MSTRX, collateralAmount: 0.03889215, collateralPriceUsd: 96.65, debtMint: SPYX, debtAmount: 0.00481468 });
        expect(liq.debtUsd).toBeCloseTo(0.00481468 * 743.5449, 8);
        const obs = decodeLendingTransaction(FIXTURE['kamino-liquidation-mstrx-spyx-debt'], { stockMints: STOCKS }).observations;
        expect(obs.find((o) => o.name === 'TSLAx')).toMatchObject({ stale: false, twapDivergent: true });
    });

    test('a liquidation of collateral that is not a tracked stock is counted, not returned', () => {
        const decoded = decodeLendingTransaction(FIXTURE['kamino-liquidation-hoodx'], { stockMints: new Map([[SPYX, 'SPYx']]) });
        expect(decoded.liquidations).toEqual([]);
        expect(decoded.otherCollateralLiquidations).toBe(1);
    });

    test('the instruction is recognised by its Anchor discriminator, not by its log line', () => {
        const inv = txInvocations(FIXTURE['kamino-liquidation-hoodx']).invocations.find((i) => i.logs[0]?.startsWith('Instruction: Liquidate'));
        expect(inv.data.subarray(0, 8).toString('hex')).toBe(anchorDiscriminator('liquidate_obligation_and_redeem_reserve_collateral_v2'));
        expect(kaminoLiquidation({ ...inv, logs: inv.logs.slice(1) })).not.toBeNull();
        expect(kaminoLiquidation({ ...inv, data: Buffer.alloc(8) })).toBeNull();
    });

    test('a failed transaction liquidated nothing, whatever its instructions say', () => {
        const tx = clone(FIXTURE['kamino-liquidation-hoodx']);
        tx.meta.err = { InstructionError: [5, { Custom: 6017 }] };
        const decoded = decodeLendingTransaction(tx, { stockMints: STOCKS });
        expect(decoded.liquidations).toEqual([]);
        expect(decoded.observations.length).toBeGreaterThan(0);
    });
});

describe('suspensions and resumes', () => {
    test('Scope ResumeSuspendedPrice: entry, label, and the Chainlink observation and activation times it held', () => {
        const [resume] = decodeLendingTransaction(FIXTURE['scope-resume-qqqx']).scopeResumes;
        expect(resume).toMatchObject({ entry: 280, label: 'ChainlinkX QQQx/USD AU', observationsTs: 1789838905, activationTs: 1789858800, at: '2026-09-21T13:42:13Z' });
        const inv = txInvocations(FIXTURE['scope-resume-qqqx']).invocations.find((i) => i.logs.includes('Instruction: ResumeSuspendedPrice'));
        expect(scopeResume({ ...inv, logs: inv.logs.filter((l) => l !== 'Instruction: ResumeSuspendedPrice') })).toBeNull();
    });

    test('Jupiter Lend: the multisig lifting the QQQx cache suspension is a feed-suspended event with suspended = false', () => {
        const events = decodeLendingTransaction(FIXTURE['jupiter-lend-lift-qqqx']).oracleEvents;
        expect(events).toEqual([expect.objectContaining({
            event: 'feed-suspended', cache: 'DLuv79r7JPgdF2C266h1kuX8DPhg2amDtaTqz9Zm25w1', suspended: false, at: '2026-09-21T12:31:24Z'
        })]);
        const inv = txInvocations(FIXTURE['jupiter-lend-lift-qqqx']).invocations.find((i) => i.events.length);
        expect(jupiterOracleEvents({ ...inv, events: [] })).toEqual([]);
    });
});

describe('Nest', () => {
    test('a two-step liquidation takes collateral now and repays later: the debt side is unknown here', () => {
        const tx = FIXTURE['nest-start-liquidation-silver'];
        expect(decodeLendingTransaction(tx, { stockMints: STOCKS })).toMatchObject({ liquidations: [], otherCollateralLiquidations: 1 });
        const [liq] = decodeLendingTransaction(tx, { stockMints: new Map([[SILVER, 'SILVER']]) }).liquidations;
        expect(liq).toMatchObject({
            protocol: 'nest', instruction: 'start_liquidation_with_oracle', mint: SILVER, collateralAmount: 1,
            debtAmount: null, liquidator: 'ARHCji9gGyRCBkNKyDzCe2C9HqQcZSRpsmie5hd918BF', detail: { twoStep: true }
        });
    });
});
