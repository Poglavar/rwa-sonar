// Unit tests for the pure grading rules in lib/grade.mjs (MODEL.md §3). The maturity fixtures are
// verbatim copies of real rwa-assets-db.json records, scored here by a local re-implementation of
// index.html's own loop, so grade.mjs cannot drift from what the page shows. The claim, verification,
// control and market cases cover every rung and every strength, plus the null/NaN paths where a
// missing number must stay missing instead of silently becoming zero.

const {
    SITE_BOOLEANS,
    NON_SITE_BOOLEANS,
    PREMIUM_MIN_LIQUIDITY_USD,
    claimRung,
    controlSurface,
    instrumentType,
    isNo,
    isYes,
    marketReality,
    maturityScore,
    maturityStage,
    maturityStageNum,
    median,
    supplyUi,
    verificationStrength,
    vocabularyValue
} = require('./lib/grade.mjs');

// ---------------------------------------------------------------- index.html parity

// index.html lines 906-960: every field NOT in this set is a scored property field.
const GENERAL_FIELDS = new Set([
    'name', 'ticker', 'type', 'description', 'website',
    'blockchain', 'blockchain_logo', 'asset_image', 'asset_image_background',
    'contractAddress', 'tokenStandard', 'recipe',
    '_links', '_maturityStage', '_maturityScore'
]);

// index.html lines 1113-1156, transcribed. This is the reference implementation under test.
function pageIsYes(value) {
    return ['yes', 'y', '1', 'true'].includes(String(value ?? '').trim().toLowerCase());
}
function pageIsNo(value) {
    return ['no', 'n', '0', 'false'].includes(String(value ?? '').trim().toLowerCase());
}
function pageMaturityStageNum(row) {
    if (!row) return 0;
    if (!pageIsYes(row.blockchainIsMainLedger)) return 0;
    if (!pageIsYes(row.unconditionalTransfers)) return 1;
    if (!pageIsYes(row.bearerRedemption)) return 2;
    if (!pageIsYes(row.forcedTransfers)) return 3;
    return 4;
}
function pageMaturityScore(row) {
    if (!row || typeof row !== 'object') return 0;
    let score = 0;
    for (const [key, value] of Object.entries(row)) {
        if (GENERAL_FIELDS.has(key)) continue;
        if (pageIsYes(value)) score++;
        else if (pageIsNo(value)) score--;
    }
    return score;
}

// Five real records, copied verbatim from rwa-assets-db.json on 2026-09-16 (only `description`,
// `asset_image`, `blockchain_logo` and `website` are dropped — all four are general fields and
// therefore score-neutral). Chosen to span the stages and to carry only the ten site booleans as
// property fields, plus the score-neutral `issuer` string; three of them omit a boolean entirely.
const REAL_RECORDS = [
    {
        name: 'Circle USDC',
        ticker: 'USDC',
        type: 'Stablecoin (USD)',
        blockchain: 'Ethereum',
        contractAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        tokenStandard: 'ERC-20',
        blockchainIsMainLedger: 'yes',
        unconditionalTransfers: 'yes',
        bearerRedemption: 'no',
        forcedTransfers: 'yes',
        titleDeed: 'no',
        tokenSelfCustody: 'yes',
        issuerIndependent: 'no',
        presetJurisdiction: 'yes',
        thirdPartyAttestations: 'yes',
        aiReady: 'yes',
        issuer: 'Circle'
    },
    {
        // No `thirdPartyAttestations` key at all — an absent boolean scores 0, as the page treats it.
        name: 'Tether Gold',
        ticker: 'XAUT',
        type: 'Tokenized Commodity (Gold)',
        blockchain: 'Ethereum',
        contractAddress: '0x68749665FF8D2d112Fa859AA293F07A622782F38',
        tokenStandard: 'ERC-20',
        blockchainIsMainLedger: 'yes',
        unconditionalTransfers: 'yes',
        bearerRedemption: 'no',
        forcedTransfers: 'no',
        titleDeed: 'yes',
        tokenSelfCustody: 'yes',
        issuerIndependent: 'no',
        presetJurisdiction: 'yes',
        aiReady: 'yes',
        issuer: 'Tether'
    },
    {
        name: 'Felix USDhl',
        ticker: 'USDhl',
        type: 'Tokenized Money Market Fund',
        blockchain: 'Hyperliquid',
        contractAddress: '',
        tokenStandard: 'HyperEVM',
        blockchainIsMainLedger: 'no',
        unconditionalTransfers: 'no',
        bearerRedemption: 'no',
        forcedTransfers: 'no',
        titleDeed: 'no',
        tokenSelfCustody: 'yes',
        issuerIndependent: 'no',
        presetJurisdiction: 'no',
        aiReady: 'no',
        issuer: 'Felix'
    },
    {
        name: 'Remora Markets',
        ticker: '',
        type: 'Tokenized Equity',
        blockchain: 'Solana',
        contractAddress: '',
        tokenStandard: 'SPL',
        blockchainIsMainLedger: 'no',
        unconditionalTransfers: 'yes',
        bearerRedemption: 'no',
        forcedTransfers: 'no',
        titleDeed: 'no',
        tokenSelfCustody: 'yes',
        issuerIndependent: 'no',
        thirdPartyAttestations: 'yes',
        presetJurisdiction: 'yes',
        issuer: 'Remora'
    },
    {
        name: 'Oro GOLD',
        ticker: 'GOLD',
        type: 'Tokenized Commodity (Gold)',
        blockchain: 'Solana',
        contractAddress: '',
        tokenStandard: 'SPL',
        blockchainIsMainLedger: 'no',
        unconditionalTransfers: 'yes',
        bearerRedemption: 'no',
        forcedTransfers: 'no',
        titleDeed: 'yes',
        tokenSelfCustody: 'yes',
        issuerIndependent: 'no',
        thirdPartyAttestations: 'yes',
        presetJurisdiction: 'yes',
        issuer: 'Oro'
    }
];

describe('ledger maturity parity with index.html', () => {
    test.each(REAL_RECORDS.map((row) => [row.name, row]))('%s scores as the page does', (_name, row) => {
        expect(maturityStageNum(row)).toBe(pageMaturityStageNum(row));
        expect(maturityScore(row)).toBe(pageMaturityScore(row));
    });

    test('the known stage and score of each fixture is stable', () => {
        const actual = REAL_RECORDS.map((row) => `${row.name} ${maturityStage(row)} ${maturityScore(row)}`);
        expect(actual).toEqual([
            'Circle USDC Level 2 4',
            'Tether Gold Level 2 3',
            'Felix USDhl Level 0 -7',
            'Remora Markets Level 0 -1',
            'Oro GOLD Level 0 1'
            // These five are what the live page shows today; a change here is a change on the site.
        ]);
    });

    test('a non-site boolean written into a record would shift the page score but not ours', () => {
        const clean = REAL_RECORDS[0];
        const polluted = { ...clean, meetingOfMinds: 'yes' };
        expect(pageMaturityScore(polluted)).toBe(pageMaturityScore(clean) + 1);
        expect(maturityScore(polluted)).toBe(maturityScore(clean));
        for (const key of NON_SITE_BOOLEANS) expect(SITE_BOOLEANS).not.toContain(key);
    });

    test('accepts the dossier shape {key: {value, reason}} as well as the flat shape', () => {
        const flat = { blockchainIsMainLedger: 'yes', unconditionalTransfers: 'yes', bearerRedemption: 'yes', forcedTransfers: 'yes' };
        const nested = Object.fromEntries(
            Object.entries(flat).map(([key, value]) => [key, { value, reason: 'cited elsewhere' }])
        );
        expect(maturityStageNum(nested)).toBe(4);
        expect(maturityStageNum(nested)).toBe(maturityStageNum(flat));
        expect(maturityScore(nested)).toBe(4);
        expect(vocabularyValue(nested, 'bearerRedemption')).toBe('yes');
        expect(vocabularyValue(flat, 'bearerRedemption')).toBe('yes');
        expect(vocabularyValue(nested, 'titleDeed')).toBeNull();
    });

    test('the ladder stops at the first pillar that is not a yes', () => {
        expect(maturityStageNum({ blockchainIsMainLedger: 'unknown' })).toBe(0);
        expect(maturityStageNum({ blockchainIsMainLedger: 'yes' })).toBe(1);
        expect(maturityStageNum({ blockchainIsMainLedger: 'yes', unconditionalTransfers: 'yes' })).toBe(2);
        expect(maturityStageNum({ blockchainIsMainLedger: 'yes', unconditionalTransfers: 'yes', bearerRedemption: 'yes' })).toBe(3);
        expect(maturityStageNum(null)).toBe(0);
        expect(maturityStage({})).toBe('Level 0');
    });

    test('unknown is neither a yes nor a no', () => {
        expect(isYes('unknown')).toBe(false);
        expect(isNo('unknown')).toBe(false);
        expect(isYes('YES ')).toBe(true);
        expect(isNo('false')).toBe(true);
        expect(maturityScore({ blockchainIsMainLedger: 'unknown', titleDeed: 'no' })).toBe(-1);
    });
});

// ---------------------------------------------------------------- claim depth

describe('claimRung', () => {
    test('rung 0 — synthetic exposure', () => {
        expect(claimRung({ legalForm: 'derivative' })).toEqual({ rung: 0, label: 'synthetic exposure' });
        expect(claimRung({ legalForm: 'spv-synthetic' })).toEqual({ rung: 0, label: 'synthetic exposure' });
    });

    test('rung 1 — an unsecured note, which is a note with no security interest', () => {
        for (const legalForm of ['structured-note', 'tracker-certificate', 'debt-note']) {
            expect(claimRung({ legalForm })).toEqual({ rung: 1, label: 'unsecured claim on the issuer' });
            expect(claimRung({ legalForm, securityInterest: { exists: false } }).rung).toBe(1);
            expect(claimRung({ legalForm, securityInterest: { exists: null } }).rung).toBe(1);
            expect(claimRung({ legalForm, securityInterest: { exists: 'yes' } }).rung).toBe(1);
        }
    });

    test('rung 2 — the same note with a real security interest', () => {
        expect(claimRung({ legalForm: 'tracker-certificate', securityInterest: { exists: true } }))
            .toEqual({ rung: 2, label: 'secured claim on collateral' });
        expect(claimRung({ legalForm: 'structured-note', securityInterest: { exists: true } }).rung).toBe(2);
    });

    test('rung 3 — a redeemable SPV claim', () => {
        expect(claimRung({ legalForm: 'spv-claim-redeemable' }))
            .toEqual({ rung: 3, label: 'beneficial interest in the security' });
    });

    test('rung 4 — the registered share itself', () => {
        expect(claimRung({ legalForm: 'registered-share' })).toEqual({ rung: 4, label: 'registered share' });
    });

    test('an unknown or absent legal form is null, not rung 0', () => {
        expect(claimRung({ legalForm: 'something-else' })).toEqual({ rung: null, label: null });
        expect(claimRung({})).toEqual({ rung: null, label: null });
        expect(claimRung(null)).toEqual({ rung: null, label: null });
    });
});

// ---------------------------------------------------------------- verification strength

describe('verificationStrength', () => {
    const cases = [
        ['none', 0, 'none'],
        ['unknown', 0, 'none'],
        ['issuer-statement', 1, 'issuer'],
        ['auditor-attestation', 2, 'auditor'],
        ['daily-verification-agent', 3, 'daily agent'],
        ['chainlink-por', 4, 'on-chain PoR'],
        ['transfer-agent-register', 5, 'register']
    ];

    test.each(cases)('%s → %i (%s)', (type, strength, label) => {
        const graded = verificationStrength({ custodyVerification: { type, machineReadable: false } });
        expect(graded.strength).toBe(strength);
        expect(graded.label).toBe(label);
        expect(graded.machineReadable).toBe(false);
    });

    test('machineReadable is carried through and is only true when the dossier says true', () => {
        expect(verificationStrength({ custodyVerification: { type: 'chainlink-por', machineReadable: true } }))
            .toEqual({ strength: 4, label: 'on-chain PoR', machineReadable: true, type: 'chainlink-por' });
        expect(verificationStrength({ custodyVerification: { type: 'chainlink-por', machineReadable: 'true' } }).machineReadable)
            .toBe(false);
    });

    test('an absent block is strength 0, an unrecognised type is null rather than a silent 0', () => {
        expect(verificationStrength({}).strength).toBe(0);
        expect(verificationStrength(null).strength).toBe(0);
        expect(verificationStrength({ custodyVerification: { type: '' } }).strength).toBe(0);
        const bogus = verificationStrength({ custodyVerification: { type: 'daily-verification-agnt' } });
        expect(bogus.strength).toBeNull();
        expect(bogus.label).toBeNull();
        expect(bogus.type).toBe('daily-verification-agnt');
    });
});

// ---------------------------------------------------------------- control surface

describe('controlSurface', () => {
    const mint = (over = {}) => ({
        permanentDelegate: false,
        freezeAuthority: null,
        pausable: false,
        defaultAccountStateFrozen: false,
        transferHookProgram: null,
        transferFeeBps: null,
        paused: null,
        ...over
    });

    test('all / some / none over the issuer mints', () => {
        const tokens = [
            mint({ permanentDelegate: true, pausable: true, freezeAuthority: 'FRZ1' }),
            mint({ permanentDelegate: false, pausable: true, freezeAuthority: 'FRZ1' })
        ];
        const surface = controlSurface(tokens);
        expect(surface.clawback).toBe('some');
        expect(surface.pausable).toBe('all');
        expect(surface.freezeAuthority).toBe('all');
        expect(surface.allowlist).toBe('none');
        expect(surface.hookActive).toBe('none');
    });

    test('a configured hook with a null program is not an active hook', () => {
        expect(controlSurface([mint({ transferHookProgram: null })]).hookActive).toBe('none');
        expect(controlSurface([mint({ transferHookProgram: '' })]).hookActive).toBe('none');
        expect(controlSurface([mint({ transferHookProgram: 'HOOKprog' })]).hookActive).toBe('all');
    });

    test('transfer fees are the sorted distinct non-null values and paused is a count', () => {
        const tokens = [
            mint({ transferFeeBps: 25, paused: true }),
            mint({ transferFeeBps: null, paused: false }),
            mint({ transferFeeBps: 10, paused: true }),
            mint({ transferFeeBps: 25, paused: null })
        ];
        const surface = controlSurface(tokens);
        expect(surface.transferFeeBps).toEqual([10, 25]);
        expect(surface.pausedNow).toBe(2);
    });

    test('an issuer with no mints gets null flags, never a fabricated "none"', () => {
        const surface = controlSurface([]);
        expect(surface.clawback).toBeNull();
        expect(surface.freezeAuthority).toBeNull();
        expect(surface.transferFeeBps).toEqual([]);
        expect(surface.pausedNow).toBe(0);
        expect(controlSurface(null).clawback).toBeNull();
    });
});

// ---------------------------------------------------------------- market reality

describe('marketReality', () => {
    const token = (mint, over = {}) => ({
        mint,
        issuer: 'x',
        listedOnJupiter: true,
        liquidity: null,
        holderCount: null,
        paused: null,
        stats24h: null,
        audit: null,
        ...over
    });

    test('sums, median and shares over a small universe slice', () => {
        const tokens = [
            token('A', {
                liquidity: 100000, holderCount: 10, paused: false,
                stats24h: { buyVolume: 300, sellVolume: 200, buyOrganicVolume: 100, sellOrganicVolume: 50, numTraders: 3 },
                audit: { topHoldersPercentage: 40 }
            }),
            token('B', {
                liquidity: 60000, holderCount: 20, paused: true,
                stats24h: { buyVolume: 0, sellVolume: 0, buyOrganicVolume: 0, sellOrganicVolume: 0, numTraders: 0 },
                audit: { topHoldersPercentage: 60 }
            }),
            token('C', { listedOnJupiter: false, liquidity: 10, holderCount: 5, audit: { topHoldersPercentage: 80 }, stats24h: { buyVolume: 500, sellVolume: 0 } })
        ];
        const prices = [
            { mint: 'A', premiumPct: 1 },
            { mint: 'B', premiumPct: 3 },
            { mint: 'C', premiumPct: 99 }
        ];

        const market = marketReality(tokens, prices);
        expect(market.tokens).toBe(3);
        expect(market.tokensListedOnJupiter).toBe(2);
        expect(market.dexLiquidityUsd).toBe(160010);
        expect(market.vol24Usd).toBe(1000);
        expect(market.organicSharePct).toBe(15);
        expect(market.holdersSum).toBe(35);
        expect(market.medianTop10Pct).toBe(60);
        expect(market.pausedTokens).toBe(1);
        expect(market.zeroVolumeShare).toBeCloseTo(1 / 3, 12);
        // Only A and B clear the liquidity floor, so C's 99 % premium cannot pollute the median.
        expect(market.premiumSampleSize).toBe(2);
        expect(market.premiumMedianPct).toBe(2);
    });

    test('the premium liquidity floor is strict — 50 000 is excluded, 50 001 is not', () => {
        const at = marketReality([token('A', { liquidity: PREMIUM_MIN_LIQUIDITY_USD })], [{ mint: 'A', premiumPct: 5 }]);
        expect(at.premiumSampleSize).toBe(0);
        expect(at.premiumMedianPct).toBeNull();

        const above = marketReality([token('A', { liquidity: PREMIUM_MIN_LIQUIDITY_USD + 1 })], [{ mint: 'A', premiumPct: 5 }]);
        expect(above.premiumSampleSize).toBe(1);
        expect(above.premiumMedianPct).toBe(5);
    });

    test('nulls and NaNs are skipped, never counted as zero', () => {
        const tokens = [
            token('A', { liquidity: null, holderCount: null, stats24h: null, audit: { topHoldersPercentage: null } }),
            token('B', { liquidity: Number.NaN, holderCount: Number.NaN, stats24h: { buyVolume: Number.NaN, sellVolume: Number.NaN }, audit: { topHoldersPercentage: Number.NaN } }),
            token('C', { liquidity: 200, holderCount: 4, stats24h: { buyVolume: 10, sellVolume: null }, audit: { topHoldersPercentage: 50 } })
        ];
        const market = marketReality(tokens, []);
        // 200 and 4, not 200/3 or a zero-padded sum; the missing ones simply did not contribute.
        expect(market.dexLiquidityUsd).toBe(200);
        expect(market.holdersSum).toBe(4);
        expect(market.vol24Usd).toBe(10);
        expect(market.medianTop10Pct).toBe(50);
        // Only C has a known volume, and it is not zero.
        expect(market.zeroVolumeShare).toBe(0);
        expect(market.organicSharePct).toBeNull();
        expect(market.premiumMedianPct).toBeNull();
        expect(market.premiumSampleSize).toBe(0);
    });

    test('an issuer with no tokens aggregates to nulls and zero counts', () => {
        const market = marketReality([], []);
        expect(market).toEqual({
            tokens: 0,
            tokensListedOnJupiter: 0,
            dexLiquidityUsd: null,
            vol24Usd: null,
            organicSharePct: null,
            holdersSum: null,
            medianTop10Pct: null,
            premiumMedianPct: null,
            premiumSampleSize: 0,
            zeroVolumeShare: null,
            pausedTokens: 0
        });
    });

    test('reads an already-built token record and its own reference block', () => {
        const built = [{
            mint: 'A',
            listedOnJupiter: true,
            control: { paused: true },
            market: { liquidity: 80000, holderCount: 7, vol24: 400, organicVol24: 100, top10HolderPct: 30 },
            reference: { premiumPct: -2 }
        }];
        const market = marketReality(built, null);
        expect(market.dexLiquidityUsd).toBe(80000);
        expect(market.holdersSum).toBe(7);
        expect(market.vol24Usd).toBe(400);
        expect(market.organicSharePct).toBe(25);
        expect(market.medianTop10Pct).toBe(30);
        expect(market.pausedTokens).toBe(1);
        expect(market.premiumMedianPct).toBe(-2);
    });
});

describe('median', () => {
    test('even counts average the two middle values', () => {
        expect(median([1, 2, 3, 4])).toBe(2.5);
        expect(median([4, 1, 3, 2])).toBe(2.5);
        expect(median([-3, 3])).toBe(0);
        expect(median([1, 2, 2, 100])).toBe(2);
    });

    test('odd counts take the middle value', () => {
        expect(median([5])).toBe(5);
        expect(median([9, 1, 5])).toBe(5);
    });

    test('non-finite values are dropped before the median is taken', () => {
        expect(median([1, null, 3, Number.NaN, undefined, 5])).toBe(3);
        expect(median([null, Number.NaN])).toBeNull();
        expect(median([])).toBeNull();
        expect(median(null)).toBeNull();
    });
});

// ---------------------------------------------------------------- instrument type

describe('instrumentType', () => {
    test('issuer conventions', () => {
        expect(instrumentType({ issuer: 'prestocks', symbol: 'OPENAI' })).toBe('private-company');
        expect(instrumentType({ issuer: 'tessera', symbol: 'tKalshi' })).toBe('private-company');
        expect(instrumentType({ issuer: 'shift', symbol: 'SPX3L' })).toBe('leveraged');
        expect(instrumentType({ issuer: 'superstate-opening-bell', symbol: 'GLXY' })).toBe('stock');
        expect(instrumentType({ issuer: 'bullish', symbol: 'BLSH' })).toBe('stock');
        expect(instrumentType({ issuer: 'securitize', symbol: 'SECZ' })).toBe('stock');
        expect(instrumentType({ issuer: null, symbol: 'ZZZ' })).toBe('unknown');
    });

    test('Ondo reads its own tags, asset class before instrument type', () => {
        const ondo = { issuer: 'ondo-global-markets', underlyingTicker: 'AAPL' };
        expect(instrumentType(ondo, { tagSlugs: ['stock', 'equities'] })).toBe('stock');
        expect(instrumentType(ondo, { tagSlugs: ['etf', 'equities'] })).toBe('etf');
        expect(instrumentType(ondo, { tagSlugs: ['closed-end-fund-cef'] })).toBe('etf');
        expect(instrumentType(ondo, { tagSlugs: ['etf', 'fixed-income'] })).toBe('fixed-income');
        expect(instrumentType(ondo, { tagSlugs: ['etf', 'commodities'] })).toBe('commodity');
        expect(instrumentType(ondo, { tagSlugs: ['etf', 'crypto-native-assets'] })).toBe('crypto-etp');
        expect(instrumentType(ondo, { tagSlugs: ['equities'] })).toBe('unknown');
        expect(instrumentType(ondo, null)).toBe('unknown');
    });

    test('xStocks and Backpack: the documented ETF list and an ETF in the name', () => {
        expect(instrumentType({ issuer: 'xstocks-backed', name: 'Tesla xStock', underlyingTicker: 'TSLA' })).toBe('stock');
        expect(instrumentType({ issuer: 'xstocks-backed', name: 'SP500 xStock', underlyingTicker: 'SPY' })).toBe('etf');
        expect(instrumentType({ issuer: 'xstocks-backed', name: 'Uranium ETF xStock', underlyingTicker: 'URA' })).toBe('etf');
        expect(instrumentType({ issuer: 'backpack-securities', name: 'IBM - Backpack Securities', underlyingTicker: 'IBM' })).toBe('stock');
    });

    test('"Netflix" contains the letters ETF but is not a fund', () => {
        expect(instrumentType({ issuer: 'xstocks-backed', name: 'Netflix xStock', underlyingTicker: 'NFLX' })).toBe('stock');
    });
});

// ---------------------------------------------------------------- supply

describe('supplyUi', () => {
    test('raw supply is scaled by decimals and by the Token-2022 UI multiplier', () => {
        expect(supplyUi('367022839632', 9, '1.003376073740221')).toBeCloseTo(368.26193580294296, 9);
        expect(supplyUi('22963699778248', 8, '1')).toBeCloseTo(229636.99778248, 8);
        expect(supplyUi(1000, 2, 2)).toBe(20);
    });

    test('no multiplier config means a multiplier of exactly one', () => {
        expect(supplyUi('5000', 3, null)).toBe(5);
        expect(supplyUi('5000', 3, undefined)).toBe(5);
    });

    test('a missing or unusable input yields null, never 0', () => {
        expect(supplyUi(null, 9, '1')).toBeNull();
        expect(supplyUi('', 9, '1')).toBeNull();
        expect(supplyUi(undefined, 9, '1')).toBeNull();
        expect(supplyUi('not-a-number', 9, '1')).toBeNull();
        expect(supplyUi('100', null, '1')).toBeNull();
        expect(supplyUi('100', 1.5, '1')).toBeNull();
        expect(supplyUi('100', 2, 'weird')).toBeNull();
        expect(supplyUi('100', 2, 0)).toBeNull();
        expect(supplyUi('100', 2, -1)).toBeNull();
        expect(supplyUi(Number.NaN, 2, 1)).toBeNull();
    });

    test('a zero supply is a real zero and stays a zero', () => {
        expect(supplyUi('0', 6, '1')).toBe(0);
    });
});
