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

    test('ledger interest, term and rate fields follow the on-chain IDL (not the stale GitHub one)', () => {
        // Bytes 121–128 are last_interest_updated_time: they equal the previous day's end time, which
        // an interest_repaid amount could not; the Loopscale API reports the same apy 70000 / duration 1.
        expect(loan.ledgers[0]).toMatchObject({
            interestOutstandingRaw: '0', lastInterestUpdatedTime: '2026-09-22T17:59:41Z', duration: 1, durationType: 0, apyCbps: 70000
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

describe('Loopscale upgrade authority is a Squads v4 vault (real mainnet multisig account)', () => {
    const { LOOPSCALE_ATTRIBUTION } = require('./lib/loopscale.mjs');
    const { decodeSquadsMultisig, fromBase58, isOnCurve, squadsVaultPda, SQUADS_V4_PROGRAM_ID } = require('./lib/squads.mjs');
    const MULTISIG = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'squads-multisig-loopscale.sample.json'), 'utf8'));
    const UA = LOOPSCALE_ATTRIBUTION.upgradeAuthority;

    test('vault index 0 of the multisig derives to exactly the recorded upgrade authority', () => {
        expect(MULTISIG.owner).toBe(SQUADS_V4_PROGRAM_ID);
        expect(MULTISIG.address).toBe(UA.multisig);
        expect(squadsVaultPda(UA.multisig, UA.vaultIndex)).toEqual({ address: UA.authority, bump: 255 });
        expect(squadsVaultPda(UA.multisig, 1).address).not.toBe(UA.authority);
    });

    test('the authority is off the ed25519 curve (no private key); a member that signs transactions is on it', () => {
        expect(isOnCurve(fromBase58(UA.authority))).toBe(false);
        expect(isOnCurve(fromBase58('LoTy38EiLYg85rWq5okYjNwzQECGbYa6uPcJPj8MHu2'))).toBe(true);
        expect(isOnCurve(fromBase58('B8yKMPzag6PJ8EhGAWqCbWpTiRc64yBuSbfXA9kHmUi3'))).toBe(true);
    });

    test('the Multisig account decodes to the recorded threshold, time lock and members', () => {
        const ms = decodeSquadsMultisig(MULTISIG.dataBase64);
        expect(ms).toMatchObject({ threshold: UA.threshold, timeLockSeconds: UA.timeLockSeconds, configAuthority: UA.configAuthority,
            rentCollector: UA.authority, bump: 255, transactionIndex: '1027' });
        expect(ms.members).toHaveLength(UA.members);
        expect(ms.members.filter((m) => m.permissions.includes('vote'))).toHaveLength(UA.voters);
        expect(ms.members[0]).toEqual({ key: 'LoTy38EiLYg85rWq5okYjNwzQECGbYa6uPcJPj8MHu2', mask: 7, permissions: ['initiate', 'vote', 'execute'] });
        expect(ms.members.find((m) => m.key === 'stnD32KEQkgA7LTVNprUPBWXt86fstt1sdUiwUUJH4j').permissions).toEqual(['vote']);
    });

    test('bytes that are not a Squads Multisig are refused', () => {
        expect(decodeSquadsMultisig(FIXTURE.loan.dataBase64)).toBeNull();
        expect(decodeSquadsMultisig(Buffer.alloc(10))).toBeNull();
    });

    test('base58 decode round-trips through the encoder, including leading-zero keys', () => {
        for (const key of [UA.authority, UA.multisig, '11111111111111111111111111111111']) expect(base58(fromBase58(key))).toBe(key);
    });

    test('the SECZ integration carries the upgrade-authority evidence into the dossier', () => {
        const scan = { fetchedAt: '2026-09-23T10:00:00Z', slot: FIXTURE.loan.slot, positions: loopscalePositions(holdersFor(), loans()) };
        const [row] = loopscaleUsage(SECZ, scan);
        const ev = row.evidence.find((e) => e.type === 'program-upgrade-authority');
        expect(ev.url).toBe(`https://solscan.io/account/${UA.multisig}`);
        expect(ev.note).toContain('threshold 4');
        expect(ev.note).toContain(UA.authority);
    });

    function loans() { return new Map([[FIXTURE.loan.address, decodeLoan(FIXTURE.loan.dataBase64)]]); }
});

describe('Loopscale SECZ market configuration (real mainnet accounts, one finalized read)', () => {
    const {
        decodeMarketInformation, decodeStrategy, decodeProtocolAdminState, decodeVault, positionConfiguration, strategyTermsFor,
        MARKET_INFORMATION_LAYOUT
    } = require('./lib/loopscale.mjs');
    const MARKET = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'loopscale-market-secz.sample.json'), 'utf8'));
    const A = MARKET.accounts;
    const market = decodeMarketInformation(A.marketInformation.dataBase64);
    const strategy = decodeStrategy(A.strategy.dataBase64);
    const loan = decodeLoan(A.loan.dataBase64);

    test('every account in the fixture is Loopscale-owned and exactly the size the on-chain IDL implies', () => {
        for (const role of ['loan', 'marketInformation', 'strategy', 'protocolAdminState', 'vault']) expect(A[role].owner).toBe(LOOPSCALE_PROGRAM_ID);
        expect(A.marketInformation.space).toBe(MARKET_INFORMATION_LAYOUT.size);
        expect(A.strategy.space).toBe(8460);
    });

    test('the market lists SECZ at index 1 with its oracle, price-age, LTV and liquidation limits', () => {
        expect(market).toMatchObject({ authority: A.vault.address, principalMint: USDC, version: 1 });
        const secz = market.assets.find((asset) => asset.assetIdentifier === SECZ.mint);
        expect(secz).toEqual({
            index: 1, assetIdentifier: SECZ.mint, quoteMint: '11111111111111111111111111111111',
            oracleAccount: 'E22Z2nKBdA3RpJhM8G2mB35zFA95Qdbs3WGbMNxFhmuH', oracleType: 19, maxUncertaintyCbps: 50000, maxAgeSeconds: 65535,
            decimals: 6, ltvCbps: 200000, liquidationThresholdCbps: 400000, maxAllocationCbps: null, currentAllocationRaw: '1513732542'
        });
        // the whole allocation against SECZ is this one loan's principal
        expect(secz.currentAllocationRaw).toBe(loan.ledgers[0].principalDueRaw);
        expect(market.borrowCaps).toEqual({ max1hRaw: null, max24hRaw: null, maxOutstandingRaw: null });
    });

    test('a 112-byte asset stride (the GitHub IDL) would misread the SECZ entry, so the 128-byte stride is load-bearing', () => {
        const bytes = Buffer.from(A.marketInformation.dataBase64, 'base64');
        expect(base58(bytes.subarray(104 + 128, 104 + 128 + 32))).toBe(SECZ.mint);
        expect(base58(bytes.subarray(104 + 112, 104 + 112 + 32))).not.toBe(SECZ.mint);
    });

    test('the lender strategy quotes SECZ only at duration index 0, at 7 % APY', () => {
        expect(strategy).toMatchObject({ lender: A.vault.address, marketInformation: A.marketInformation.address, originationsEnabled: true,
            originationCapRaw: '100000000000', activeLoanCount: 24 });
        expect(strategyTermsFor(strategy, market, A.marketInformation.address, SECZ.mint)).toEqual([70000, null, null, null, null]);
        expect(strategyTermsFor(strategy, market, 'SomeOtherMarket111111111111111111111111111', SECZ.mint)).toBeNull();
        expect(strategyTermsFor(strategy, market, A.marketInformation.address, 'NotListed1111111111111111111111111111111111')).toBeNull();
    });

    test('who can change it: the vault manager and a single protocol-admin key; the protocol is not frozen', () => {
        expect(decodeVault(A.vault.dataBase64)).toMatchObject({ manager: 'bs1PuRvB9rBBZkryBjADYvxc2qYh51EVW2fsb1uTiBN', principalMint: USDC, depositsEnabled: true });
        expect(decodeProtocolAdminState(A.protocolAdminState.dataBase64)).toEqual({
            protocolAdmin: 'CyNKPfqsSLAejjZtEeNG3pR4SkPhSPHXdGhuNTyudrNs', operationsAdmin: 'BBEPbsJAM5ecjXEKzcSK7XNdJ4JfEkiauJRgRcybQeoA',
            refinanceAdmin: 'CyNKPfqsSLAejjZtEeNG3pR4SkPhSPHXdGhuNTyudrNs', frozen: false
        });
    });

    test('the loan was rolled for another day at 18:00:58Z, not repaid or liquidated', () => {
        expect(loan.ledgers[0]).toMatchObject({ principalDueRaw: '1513732542', principalRepaidRaw: '0', endTime: '2026-09-24T18:00:58Z',
            lastInterestUpdatedTime: '2026-09-23T18:00:58Z' });
        expect(loan.collateral[0]).toMatchObject({ assetMint: SECZ.mint, amountRaw: '13391402983' });
    });

    test('decoders refuse each other\'s bytes', () => {
        expect(decodeMarketInformation(A.strategy.dataBase64)).toBeNull();
        expect(decodeStrategy(A.marketInformation.dataBase64)).toBeNull();
        expect(decodeVault(A.protocolAdminState.dataBase64)).toBeNull();
        expect(decodeProtocolAdminState(A.vault.dataBase64)).toBeNull();
        expect(decodeMarketInformation(Buffer.from(A.marketInformation.dataBase64, 'base64').subarray(0, 22504))).toBeNull();
    });

    test('the position carries the market terms and the integration reports the configuration, not the loan snapshot', () => {
        const holders = { items: [{ mint: SECZ.mint, symbol: 'SECZ', top20: [{ tokenAccount: A.collateralTokenAccount.address, owner: A.loan.address, amountUi: 13391.402983 }] }] };
        const [position] = loopscalePositions(holders, new Map([[A.loan.address, loan]]));
        position.configuration = positionConfiguration(position, new Map([[A.marketInformation.address, market]]), new Map([[A.strategy.address, strategy]]));
        expect(position.configuration).toMatchObject({ oracleAccount: 'E22Z2nKBdA3RpJhM8G2mB35zFA95Qdbs3WGbMNxFhmuH', maxPriceAgeSeconds: 65535,
            maxUncertaintyPct: 5, maxLtvPct: 20, liquidationLtvPct: 40, collateralAllocationCapPct: null, lender: A.vault.address, apyPctByDuration: [7, null, null, null, null] });
        const [row] = loopscaleUsage(SECZ, { fetchedAt: '2026-09-23T18:25:17Z', slot: MARKET.slot, positions: [position] });
        expect(row.metrics).toMatchObject({ maxLtvMax: 0.2, liquidationLtvMin: 0.4 });
        expect(row.markets[0]).toMatchObject({ ledgerApyPct: 7, configuration: { marketInformation: A.marketInformation.address } });
        expect(row.decoding.scope).toMatch(/MarketInformation asset entry/);
        expect(positionConfiguration(position, new Map(), new Map())).toBeNull();
    });
});

describe('SECZ Loopscale market review promotes the dossier to configuration-decoded', () => {
    const { buildProtocolDossiers, renderProtocolDossier } = require('./lib/protocol-dossiers.mjs');
    const read = (p) => JSON.parse(readFileSync(join(__dirname, '..', p), 'utf8'));
    const research = read('stocks/data/protocol-market-research.json');
    const review = research.markets.find((m) => m.id === 'loopscale:secz-usdc-usdc-rwa-vault');

    test('the review names the program, the decoded market and the live loan, with sourced times', () => {
        expect(review).toMatchObject({ tokenMint: SECZ.mint, integrationId: 'loopscale:collateral', configurationDecoded: true,
            expectedProgramOwner: LOOPSCALE_PROGRAM_ID, observedProgramOwner: LOOPSCALE_PROGRAM_ID, programOwnerMatches: true,
            marketAddress: 'DTzzuGFVZN8nmCS9HZubnM4vogqR8c4Rs5mChpLVjuCb' });
        expect(review.configuration).toMatchObject({ maxLtvPct: 20, liquidationLtvPct: 40, maxPriceAgeSeconds: 65535 });
        for (const source of review.sources) expect(Date.parse(source.accessedAt)).toBeLessThanOrEqual(Date.now());
        expect(review.readOnlyExecution.status).toBe('not-performed');
    });

    test('the SECZ Loopscale dossier row carries the review and renders its limits', () => {
        const rows = buildProtocolDossiers({ tokens: read('stocks-tokens.json').tokens, issuers: read('stocks-issuers.json').issuers,
            usage: read('stocks/data/defi-usage.json'), templates: read('stocks/data/composability-templates.json').templates, marketResearch: research });
        const row = rows.find((r) => r.mint === SECZ.mint && r.integration.protocolId === 'loopscale');
        expect(row).toBeDefined();
        expect(row.marketVerifications).toHaveLength(1);
        expect(row.proof).toMatchObject({ configurationDecoded: true, readOnlyExecutionSimulated: false, observedAt: review.observedAt });
        const html = renderProtocolDossier(row);
        expect(html).toContain('SECZ collateral → USDC debt');
        expect(html).toContain('matches official mainnet programme ID');
        expect(html).toContain('end-of-day price');
    });
});
