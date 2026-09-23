// Loopscale detection: Loan decoding against a real mainnet account read, the holder-scan join, and
// how the resulting integration reads through the shared proof vocabulary.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const {
    LOAN_DISCRIMINATOR_BASE58,
    LOOPSCALE_PROGRAM_ID,
    base58,
    decodeLoan,
    holderOwners,
    loopscalePositions,
    loopscaleUsage,
    unambiguousCell
} = require('./lib/loopscale.mjs');
const { applyOnchainCorroboration, buildDefiUsage, integrationAccountRefs } = require('./lib/defi-usage.mjs');
const { protocolProofModel } = require('./lib/protocol-proof.js');

const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'loopscale-loan-secz.sample.json'), 'utf8'));
const SECZ = { mint: '5VzwKkvynPJzcgwhBe7ESEyNgqMbo15yBu7Sehssd9ED', symbol: 'SECZ', issuer: 'securitize', decimals: 6, market: { usdPrice: 8 } };
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function holdersFor(owner = FIXTURE.loan.address) {
    return {
        fetchedAt: '2026-09-20T08:19:40Z',
        items: [{
            mint: SECZ.mint, symbol: 'SECZ',
            top20: [
                { tokenAccount: '8B9bU9fU8PNbYJsTmom965tTUtEuFaoKMH8sUeKLsdhw', owner: 'Hv8FoJFsrQhoyrR6Lcz4KFcpqNHU1Kxj2yaFDKU6vJdp', amountUi: 130917.545784 },
                { tokenAccount: FIXTURE.tokenAccount.address, owner, amountUi: 13391.402983 }
            ]
        }]
    };
}

describe('Loopscale Loan decoding (real mainnet account)', () => {
    const loan = decodeLoan(FIXTURE.loan.dataBase64);

    test('the fixture is a live Loopscale Loan that owns the SECZ token account', () => {
        expect(FIXTURE.loan.owner).toBe(LOOPSCALE_PROGRAM_ID);
        expect(FIXTURE.tokenAccount.owner).toBe(FIXTURE.loan.address);
        expect(FIXTURE.tokenAccount.mint).toBe(SECZ.mint);
    });

    test('collateral record names the exact mint and the same raw amount the token account holds', () => {
        expect(loan).not.toBeNull();
        expect(loan.collateral).toEqual([{
            index: 0, assetMint: SECZ.mint, amountRaw: FIXTURE.tokenAccount.amount, assetType: 0, assetIdentifier: SECZ.mint
        }]);
        expect(loan.borrower).toBe('4cK86cF31P8aBmfkYormj8od2YXrmwS52j32dcu71oxr');
        expect(loan.version).toBe(2);
    });

    test('one USDC ledger is decoded with its principal and term', () => {
        expect(loan.ledgers).toHaveLength(1);
        expect(loan.ledgers[0]).toMatchObject({
            index: 0, principalMint: USDC, principalDueRaw: '1513442034', principalRepaidRaw: '0',
            startTime: '2026-08-16T15:33:45Z', endTime: '2026-09-23T17:59:41Z'
        });
    });

    test('LTV and liquidation cells are read only when the loan shape makes them unambiguous', () => {
        expect(unambiguousCell(loan, loan.ltvMatrixCbps)).toBe(0.2);
        expect(unambiguousCell(loan, loan.lqtMatrixCbps)).toBe(0.4);
        expect(unambiguousCell({ ...loan, ledgers: [...loan.ledgers, loan.ledgers[0]] }, loan.ltvMatrixCbps)).toBeNull();
    });

    test('bytes that are not a Loan are refused, never read at Loan offsets', () => {
        const bytes = Buffer.from(FIXTURE.loan.dataBase64, 'base64');
        const wrongDiscriminator = Buffer.from(bytes); wrongDiscriminator[0] ^= 0xff;
        expect(decodeLoan(wrongDiscriminator)).toBeNull();
        expect(decodeLoan(bytes.subarray(0, 1000))).toBeNull();
        expect(decodeLoan(null)).toBeNull();
    });

    test('base58 round-trips the discriminator and a leading-zero key', () => {
        expect(LOAN_DISCRIMINATOR_BASE58).toBe(base58(Buffer.from([20, 195, 70, 117, 165, 227, 182, 1])));
        expect(base58(new Uint8Array(32))).toBe('11111111111111111111111111111111');
    });
});

describe('Loopscale holder join and integration record', () => {
    const loans = new Map([[FIXTURE.loan.address, decodeLoan(FIXTURE.loan.dataBase64)]]);

    test('owners are deduplicated from the top-20 scan', () => {
        expect(holderOwners(holdersFor())).toEqual([FIXTURE.loan.address, 'Hv8FoJFsrQhoyrR6Lcz4KFcpqNHU1Kxj2yaFDKU6vJdp'].sort());
    });

    test('only token accounts owned by a decoded Loan become positions; a record mismatch is flagged', () => {
        const positions = loopscalePositions(holdersFor(), loans);
        expect(positions).toHaveLength(1);
        expect(positions[0]).toMatchObject({ mint: SECZ.mint, loanAddress: FIXTURE.loan.address, matchesLoanRecord: true });
        const otherMint = { items: [{ ...holdersFor().items[0], mint: 'OtherMint1111111111111111111111111111111111' }] };
        expect(loopscalePositions(otherMint, loans)[0].matchesLoanRecord).toBe(false);
        expect(loopscaleUsage({ ...SECZ, mint: 'OtherMint1111111111111111111111111111111111' },
            { positions: loopscalePositions(otherMint, loans) })).toEqual([]);
    });

    test('SECZ reads as decoded Loopscale collateral with a borrow against it', () => {
        const scan = { fetchedAt: '2026-09-23T10:00:00Z', slot: FIXTURE.loan.slot, positions: loopscalePositions(holdersFor(), loans) };
        const [row] = loopscaleUsage(SECZ, scan);
        expect(row).toMatchObject({ protocolId: 'loopscale', category: 'lending', status: 'live', actions: ['collateral', 'borrow'] });
        expect(row.metrics).toMatchObject({ positions: 1, collateralTokens: 13391.402983, maxLtvMin: 0.2, liquidationLtvMax: 0.4 });
        expect(row.metrics.sizeUsd).toBeCloseTo(107131.22, 1);
        expect(row.markets[0]).toMatchObject({ loanAddress: FIXTURE.loan.address, debtMint: USDC, principalDueRaw: '1513442034' });
        expect(integrationAccountRefs(row)).toEqual([{ address: FIXTURE.loan.address, role: 'loan-account', expectedOwner: LOOPSCALE_PROGRAM_ID }]);
    });

    test('through buildDefiUsage the proof stage is decoded, sourced from an on-chain position', () => {
        const scan = { fetchedAt: '2026-09-23T10:00:00Z', slot: FIXTURE.loan.slot, positions: loopscalePositions(holdersFor(), loans) };
        const usage = buildDefiUsage({ tokens: [SECZ], loopscale: scan, fetchedAt: '2026-09-23T10:00:00Z' });
        const [integration] = usage.items[0].integrations;
        expect(integration.proof).toMatchObject({ sourceStatus: 'onchain-position', configurationDecoded: true, activityObserved: true, observedAt: '2026-09-23T10:00:00Z' });
        expect(usage.counts.withLending).toBe(1);
        expect(protocolProofModel({ proof: integration.proof })).toMatchObject({ stage: 'decoded' });
        expect(protocolProofModel({ proof: { ...integration.proof, configurationDecoded: false } }))
            .toMatchObject({ stage: 'account-observed', headline: 'A protocol account holding this exact token was observed on-chain' });
        applyOnchainCorroboration(usage, new Map([[FIXTURE.loan.address, { exists: true, owner: LOOPSCALE_PROGRAM_ID }]]), '2026-09-23T10:00:01Z');
        expect(integration.corroboration.accounts[0]).toMatchObject({ role: 'loan-account', owner: LOOPSCALE_PROGRAM_ID, expectedOwner: LOOPSCALE_PROGRAM_ID });
    });

    test('no scan means no Loopscale integration rather than an error', () => {
        expect(loopscaleUsage(SECZ, null)).toEqual([]);
        expect(buildDefiUsage({ tokens: [SECZ], fetchedAt: 'x' }).sources.loopscale).toBeNull();
    });
});
