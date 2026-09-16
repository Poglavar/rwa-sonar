// Unit tests for the pure grading rules in lib/grade.mjs (MODEL.md §3). The maturity fixtures are
// verbatim copies of real rwa-assets-db.json records, scored here by a local re-implementation of
// index.html's own loop, so grade.mjs cannot drift from what the page shows. The claim, verification,
// control and market cases cover every rung and every strength, plus the null/NaN paths where a
// missing number must stay missing instead of silently becoming zero.

const {
    SITE_BOOLEANS,
    NON_SITE_BOOLEANS,
    PREMIUM_MIN_LIQUIDITY_USD,
    SPREAD_MAX_STALENESS_MS,
    SPREAD_MIN_CEX_VOLUME_USD,
    SPREAD_MIN_DEX_LIQUIDITY_USD,
    TRADERS_NOTE,
    claimRung,
    controlSurface,
    instrumentType,
    isNo,
    isYes,
    issuerActivity,
    marketReality,
    maturityScore,
    maturityStage,
    maturityStageNum,
    median,
    supplyUi,
    tokenActivity,
    tradesPerTrader,
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

// ---------------------------------------------------------------- §11 trading activity

// Real figures, read on 2026-09-16: Jupiter's stats24h for the AAPLx mint and the DexScreener /
// CoinGecko venue record fetch-venues.mjs wrote for it. The null-heavy cases below are the point of
// the suite: a token nobody reported counts for must never read as a token nobody traded.
const AAPLX_STATS = {
    buyVolume: 12215344.700786933,
    sellVolume: 11421516.460551076,
    buyOrganicVolume: 1365088.0483179328,
    sellOrganicVolume: 1211153.5663495657,
    numBuys: 62651,
    numSells: 62337,
    numTraders: 13024,
    numOrganicBuyers: 163,
    priceChange: -0.3879910004589042
};

// venues.json's own fetchedAt: every staleness decision below is measured from this, not the clock.
const VENUES_AS_OF = '2026-09-16T18:10:00Z';

const AAPLX_VENUES = {
    mint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp',
    issuer: 'xstocks-backed',
    dex: [
        { dexId: 'raydium', pairAddress: 'CKwJ', quoteSymbol: 'USDC', priceUsd: 334.17, liquidityUsd: 229556.28, volume24Usd: 105338.15, txns24: 444 },
        { dexId: 'raydium', pairAddress: 'Hy7r', quoteSymbol: 'USDC', priceUsd: 334.5, liquidityUsd: 12000, volume24Usd: 900, txns24: null },
        { dexId: 'orca', pairAddress: '7gci', quoteSymbol: 'USDC', priceUsd: 333.9, liquidityUsd: 101268.72, volume24Usd: 51204.9, txns24: 61 }
    ],
    cex: [
        { market: 'BigONE', priceUsd: 335.55, volume24Usd: 754951, lastTradedAt: '2026-09-16T18:03:50+00:00' },
        { market: 'Bybit', priceUsd: 335.02, volume24Usd: 156621, lastTradedAt: '2026-09-16T18:04:30+00:00' },
        { market: 'Raydium (CLMM)', priceUsd: 333.62, volume24Usd: 148383, lastTradedAt: '2026-09-16T16:50:58+00:00' }
    ]
};

describe('tokenActivity', () => {
    test('joins Jupiter trade counts with the venue record (MODEL.md §11.2)', () => {
        const activity = tokenActivity({ mint: 'A', stats24h: AAPLX_STATS }, AAPLX_VENUES, { asOf: VENUES_AS_OF });
        expect(activity).toEqual({
            buys24: 62651,
            sells24: 62337,
            trades24: 124988,
            traders24: 13024,
            organicBuyers24: 163,
            tradesPerTrader: 124988 / 13024,
            dexPairs: 3,
            dexTxns24: 505, // 444 + 61; the pool with no txns figure contributes nothing
            cexMarkets: 3,
            venueCount: 5, // raydium + orca + three CoinGecko markets — pools are not venues
            // Every pool is deep enough and every market traded within the 2 h window — but
            // CoinGecko's "Raydium (CLMM)" is the raydium pool again, so it is not a sixth price.
            venuesPriced: 5,
            venueSpreadPct: (335.55 / 333.9 - 1) * 100,
            venueSpreadLow: 'orca',
            venueSpreadHigh: 'BigONE',
            lastTradedAt: '2026-09-16T18:04:30+00:00',
            lastTradedVenue: 'Bybit'
        });
    });

    test('a token with no stats and no venue record is all nulls, not all zeros', () => {
        expect(tokenActivity({ mint: 'A', stats24h: null }, null)).toEqual({
            buys24: null,
            sells24: null,
            trades24: null,
            traders24: null,
            organicBuyers24: null,
            tradesPerTrader: null,
            dexPairs: null,
            dexTxns24: null,
            cexMarkets: null,
            venueCount: null,
            venuesPriced: null,
            venueSpreadPct: null,
            venueSpreadLow: null,
            venueSpreadHigh: null,
            lastTradedAt: null,
            lastTradedVenue: null
        });
        expect(tokenActivity(null, undefined).trades24).toBeNull();
    });

    test('a venue record that came back empty reports 0 venues, and unknown trade counts', () => {
        // The distinction the nulls above protect: looked up and found nothing ≠ never looked up.
        const activity = tokenActivity({ mint: 'A', stats24h: null }, { mint: 'A', dex: [], cex: [] });
        expect(activity.dexPairs).toBe(0);
        expect(activity.cexMarkets).toBe(0);
        expect(activity.venueCount).toBe(0);
        expect(activity.dexTxns24).toBeNull();
        expect(activity.trades24).toBeNull();
    });

    test('one known count and one missing one sums only what was reported', () => {
        const activity = tokenActivity({ stats24h: { numBuys: 12, numSells: null, numTraders: 4 } }, null);
        expect(activity.trades24).toBe(12);
        expect(activity.sells24).toBeNull();
        expect(activity.tradesPerTrader).toBe(3);
    });

    test('NaN, strings and a zero trader count never produce a number', () => {
        expect(tokenActivity({ stats24h: { numBuys: Number.NaN, numSells: Number.NaN } }, null).trades24).toBeNull();
        // 0 traders with trades recorded is contradictory source data, not an infinite ratio.
        expect(tokenActivity({ stats24h: { numBuys: 5, numSells: 5, numTraders: 0 } }, null).tradesPerTrader).toBeNull();
        expect(tradesPerTrader(10, 0)).toBeNull();
        expect(tradesPerTrader(10, null)).toBeNull();
        expect(tradesPerTrader(null, 10)).toBeNull();
        expect(tradesPerTrader(10, 4)).toBe(2.5);
    });

    test('lastTradedAt is the latest INSTANT, not the largest string', () => {
        const activity = tokenActivity({ stats24h: null }, {
            dex: [],
            cex: [
                { market: 'Later', volume24Usd: 1, lastTradedAt: '2026-09-16T07:30:00+02:00' }, // 05:30Z
                { market: 'Earlier', volume24Usd: 1, lastTradedAt: '2026-09-16T06:00:00+00:00' },
                { market: 'Unknown', volume24Usd: 1, lastTradedAt: null },
                { market: 'Broken', volume24Usd: 1, lastTradedAt: 'not a date' }
            ]
        });
        expect(activity.lastTradedAt).toBe('2026-09-16T06:00:00+00:00');
        expect(activity.lastTradedVenue).toBe('Earlier');
    });
});

describe('issuerActivity', () => {
    const built = (mint, activity, market = {}) => ({ mint, activity, market });

    test('aggregates the issuer’s tokens and their distinct venues (MODEL.md §11.3)', () => {
        const a = tokenActivity({ stats24h: AAPLX_STATS }, AAPLX_VENUES);
        const b = tokenActivity({ stats24h: { numBuys: 50, numSells: 30, numTraders: 20 } }, {
            dex: [{ dexId: 'orca', pairAddress: 'x', volume24Usd: 400, liquidityUsd: 5000, txns24: 80 }],
            cex: [{ market: 'Bybit', volume24Usd: 900, lastTradedAt: '2026-09-16T19:00:00+00:00' }]
        });
        const issuer = issuerActivity(
            [
                built('A', a, { vol24: 23636861.16, organicVol24: 2576241.61 }),
                built('B', b, { vol24: 1000, organicVol24: 250 })
            ],
            [AAPLX_VENUES, { mint: 'B', dex: [{ dexId: 'orca', volume24Usd: 400, liquidityUsd: 5000 }], cex: [{ market: 'Bybit', volume24Usd: 900, lastTradedAt: '2026-09-16T19:00:00+00:00' }] }]
        );

        expect(issuer.tokens).toBe(2);
        expect(issuer.tokensTraded24).toBe(2);
        expect(issuer.trades24).toBe(124988 + 80);
        expect(issuer.traders24).toBe(13024 + 20);
        expect(issuer.tradersNote).toBe(TRADERS_NOTE);
        expect(issuer.tradesPerTrader).toBeCloseTo((124988 + 80) / (13024 + 20), 10);
        expect(issuer.organicSharePct).toBeCloseTo((2576241.61 + 250) / (23636861.16 + 1000) * 100, 10);
        // raydium, orca, BigONE, Bybit, Raydium (CLMM) — Bybit and orca serve both tokens and are
        // counted once each, which is what makes this a venue count and not a pair count.
        expect(issuer.venueCount).toBe(5);
        expect(issuer.lastTradedAt).toBe('2026-09-16T19:00:00+00:00');
        expect(issuer.lastTradedVenue).toBe('Bybit');
    });

    test('venuesTop is the six biggest by 24 h volume, with liquidity only where a DEX pair has it', () => {
        const items = [{
            mint: 'A',
            dex: [
                { dexId: 'raydium', volume24Usd: 700, liquidityUsd: 7000 },
                { dexId: 'orca', volume24Usd: 600, liquidityUsd: 6000 },
                { dexId: 'meteora', volume24Usd: 500, liquidityUsd: 5000 }
            ],
            cex: [
                { market: 'Bybit', volume24Usd: 900 },
                { market: 'BigONE', volume24Usd: 800 },
                { market: 'Kraken', volume24Usd: 400 },
                { market: 'MEXC', volume24Usd: 300 },
                { market: 'Quiet', volume24Usd: null }
            ]
        }];
        const { venuesTop, venueCount } = issuerActivity([], items);
        expect(venueCount).toBe(8);
        expect(venuesTop).toHaveLength(6);
        expect(venuesTop.map((v) => v.name)).toEqual(['Bybit', 'BigONE', 'raydium', 'orca', 'meteora', 'Kraken']);
        expect(venuesTop[0]).toEqual({ name: 'Bybit', kind: 'cex', volume24Usd: 900, liquidityUsd: null });
        expect(venuesTop[2]).toEqual({ name: 'raydium', kind: 'dex', volume24Usd: 700, liquidityUsd: 7000 });
    });

    test('an issuer nothing is reported for stays null — a Σ of unknowns is not 0', () => {
        // THE null-as-zero guard. Every token's counts and volumes are missing, so every Σ must be
        // null; a reduce seeded with 0 would publish "0 trades, 0 traders, 0% organic" as fact.
        const unknown = tokenActivity({ stats24h: null }, { dex: [], cex: [] });
        const issuer = issuerActivity(
            [built('A', unknown, { vol24: null, organicVol24: null }), built('B', unknown, {})],
            [{ mint: 'A', dex: [], cex: [] }]
        );
        expect(issuer.trades24).toBeNull();
        expect(issuer.traders24).toBeNull();
        expect(issuer.tradesPerTrader).toBeNull();
        expect(issuer.organicSharePct).toBeNull();
        expect(issuer.tokensTraded24).toBe(0);
        expect(issuer.lastTradedAt).toBeNull();
    });

    test('a token with unknown trades is not counted as traded, and does not pad the Σ', () => {
        const traded = tokenActivity({ stats24h: { numBuys: 6, numSells: 4, numTraders: 2 } }, null);
        const quiet = tokenActivity({ stats24h: { numBuys: 0, numSells: 0, numTraders: 0 } }, null);
        const unknown = tokenActivity({ stats24h: null }, null);
        const issuer = issuerActivity([built('A', traded), built('B', quiet), built('C', unknown)], []);
        expect(issuer.tokens).toBe(3);
        expect(issuer.tokensTraded24).toBe(1);
        expect(issuer.trades24).toBe(10);
        expect(issuer.traders24).toBe(2);
        expect(issuer.venueCount).toBeNull(); // no venue records were read at all
        expect(issuer.venuesTop).toEqual([]);
    });

    test('an issuer with no tokens aggregates to nulls and zero counts', () => {
        expect(issuerActivity([], [])).toEqual({
            tokens: 0,
            tokensTraded24: 0,
            trades24: null,
            traders24: null,
            tradersNote: TRADERS_NOTE,
            tradesPerTrader: null,
            organicSharePct: null,
            venueCount: null,
            venueSpreadMedianPct: null,
            venuesTop: [],
            lastTradedAt: null,
            lastTradedVenue: null
        });
        expect(issuerActivity(null, null).tokens).toBe(0);
    });

    test('reads raw universe items too, for a caller that has not built the token records yet', () => {
        const issuer = issuerActivity([
            { mint: 'A', stats24h: { numBuys: 3, numSells: 2, numTraders: 1 }, liquidity: 10 },
            { mint: 'B', stats24h: { numBuys: 1, numSells: 1, numTraders: 1, buyVolume: 60, sellVolume: 40, buyOrganicVolume: 10, sellOrganicVolume: 10 } }
        ], []);
        expect(issuer.trades24).toBe(7);
        expect(issuer.traders24).toBe(2);
        expect(issuer.organicSharePct).toBe(20);
    });
});

describe('venueSpreadPct (the cross-venue price gap)', () => {
    const at = (iso) => iso;
    const dexPair = (dexId, priceUsd, liquidityUsd) => ({ dexId, pairAddress: dexId + priceUsd, priceUsd, liquidityUsd, volume24Usd: 1, txns24: 1 });
    const ticker = (market, priceUsd, volume24Usd, lastTradedAt = '2026-09-16T18:00:00+00:00') => ({ market, priceUsd, volume24Usd, lastTradedAt: at(lastTradedAt) });
    const spread = (venuesItem, asOf = VENUES_AS_OF) => tokenActivity({ stats24h: null }, venuesItem, { asOf });

    test('is (highest / lowest − 1) × 100 and names both sides', () => {
        // The real shape of the widest gap in the corpus: a DEX pool against a CEX book.
        const activity = spread({ dex: [dexPair('raydium', 100, 50000)], cex: [ticker('Kraken', 117, 250000)] });
        expect(activity.venuesPriced).toBe(2);
        expect(activity.venueSpreadPct).toBeCloseTo(17, 10);
        expect(activity.venueSpreadLow).toBe('raydium');
        expect(activity.venueSpreadHigh).toBe('Kraken');
    });

    test('two pools of the same dex still measure a spread, and identical prices are 0 %', () => {
        expect(spread({ dex: [dexPair('raydium', 100, 50000), dexPair('raydium', 101, 50000)], cex: [] }).venueSpreadPct)
            .toBeCloseTo(1, 10);
        const tied = spread({ dex: [dexPair('raydium', 100, 50000), dexPair('orca', 100, 50000)], cex: [] });
        expect(tied.venueSpreadPct).toBe(0);
        // A tie still names two venues; one venue printed twice would read as a data error.
        expect([tied.venueSpreadLow, tied.venueSpreadHigh]).toEqual(['raydium', 'orca']);
    });

    test('a thin pool is not a price: below the liquidity floor it cannot widen the spread', () => {
        const thin = { dex: [dexPair('raydium', 100, 50000), dexPair('meteora', 180, SPREAD_MIN_DEX_LIQUIDITY_USD - 1)], cex: [ticker('Kraken', 101, 250000)] };
        const activity = spread(thin);
        expect(activity.venuesPriced).toBe(2);
        expect(activity.venueSpreadHigh).toBe('Kraken');
        expect(activity.venueSpreadPct).toBeCloseTo(1, 10);
        // …and exactly at the floor it does qualify.
        expect(spread({ dex: [dexPair('raydium', 100, 50000), dexPair('meteora', 180, SPREAD_MIN_DEX_LIQUIDITY_USD)], cex: [] }).venueSpreadPct)
            .toBeCloseTo(80, 10);
    });

    test('a market nobody traded on is not a price either: below the volume floor it is ignored', () => {
        const activity = spread({ dex: [dexPair('raydium', 100, 50000)], cex: [ticker('Sleepy', 300, SPREAD_MIN_CEX_VOLUME_USD - 1), ticker('Kraken', 102, 250000)] });
        expect(activity.venuesPriced).toBe(2);
        expect(activity.venueSpreadPct).toBeCloseTo(2, 10);
        expect(spread({ dex: [dexPair('raydium', 100, 50000)], cex: [ticker('Kraken', 300, SPREAD_MIN_CEX_VOLUME_USD)] }).venuesPriced).toBe(2);
    });

    test('a stale print is excluded, measured from the venues file’s fetchedAt', () => {
        // THE staleness guard. Kraken last traded 9 h before the file was fetched: its 300 is a
        // yesterday price, and pairing it with a live pool would invent a 200 % arbitrage gap.
        const stale = { dex: [dexPair('raydium', 100, 50000)], cex: [ticker('Kraken', 300, 250000, '2026-09-16T09:00:00+00:00'), ticker('Bybit', 101, 250000)] };
        const activity = spread(stale);
        expect(activity.venuesPriced).toBe(2);
        expect(activity.venueSpreadHigh).toBe('Bybit');
        expect(activity.venueSpreadPct).toBeCloseTo(1, 10);

        // Just inside the window it counts; just outside it does not.
        const asOfMs = Date.parse(VENUES_AS_OF);
        const inside = new Date(asOfMs - SPREAD_MAX_STALENESS_MS + 1000).toISOString();
        const outside = new Date(asOfMs - SPREAD_MAX_STALENESS_MS - 1000).toISOString();
        expect(spread({ dex: [dexPair('raydium', 100, 50000)], cex: [ticker('Kraken', 300, 250000, inside)] }).venuesPriced).toBe(2);
        expect(spread({ dex: [dexPair('raydium', 100, 50000)], cex: [ticker('Kraken', 300, 250000, outside)] }).venuesPriced).toBe(1);
    });

    test('an unknown or unparseable timestamp, and a missing asOf, keep a ticker out', () => {
        const one = { dex: [dexPair('raydium', 100, 50000)], cex: [ticker('Kraken', 300, 250000, null), ticker('Bybit', 300, 250000, 'not a date')] };
        expect(spread(one).venuesPriced).toBe(1);
        expect(spread(one).venueSpreadPct).toBeNull();
        // No asOf: no ticker can be shown to be fresh, so only the pools are priced.
        const both = { dex: [dexPair('raydium', 100, 50000)], cex: [ticker('Kraken', 300, 250000)] };
        expect(tokenActivity({ stats24h: null }, both, {}).venuesPriced).toBe(1);
        expect(tokenActivity({ stats24h: null }, both).venueSpreadPct).toBeNull();
        // …unless the item itself carries the fetch moment.
        expect(tokenActivity({ stats24h: null }, { ...both, fetchedAt: VENUES_AS_OF }).venuesPriced).toBe(2);
    });

    test('fewer than two qualifying venues is no measurement, not a tight market', () => {
        expect(spread({ dex: [dexPair('raydium', 100, 50000)], cex: [] })).toMatchObject({
            venuesPriced: 1, venueSpreadPct: null, venueSpreadLow: null, venueSpreadHigh: null
        });
        expect(spread({ dex: [], cex: [] })).toMatchObject({ venuesPriced: 0, venueSpreadPct: null });
        // A priceless or zero-priced venue never qualifies, so it cannot make a pair.
        expect(spread({ dex: [dexPair('raydium', 100, 50000), dexPair('orca', null, 50000)], cex: [] }).venuesPriced).toBe(1);
        expect(spread({ dex: [dexPair('raydium', 100, 50000), dexPair('orca', 0, 50000)], cex: [] }).venuesPriced).toBe(1);
    });

    test('the issuer aggregate takes the MEDIAN over its tokens that have a spread', () => {
        const token = (pct) => ({
            mint: `m${pct}`,
            activity: { ...tokenActivity({ stats24h: null }, null), venueSpreadPct: pct },
            market: {}
        });
        expect(issuerActivity([token(1), token(5), token(9)], []).venueSpreadMedianPct).toBe(5);
        // A token priced on one venue has no spread and must not drag the median toward zero.
        expect(issuerActivity([token(4), token(6), token(null)], []).venueSpreadMedianPct).toBe(5);
        expect(issuerActivity([token(null), token(null)], []).venueSpreadMedianPct).toBeNull();
    });
});

describe('venueSpreadPct — one venue reported by both sources is still one venue', () => {
    const spread = (venuesItem) => tokenActivity({ stats24h: null }, venuesItem, { asOf: VENUES_AS_OF });
    const pool = (dexId, priceUsd) => ({ dexId, pairAddress: `${dexId}-1`, priceUsd, liquidityUsd: 50000, volume24Usd: 1, txns24: 1 });
    const market = (name, priceUsd) => ({ market: name, priceUsd, volume24Usd: 250000, lastTradedAt: '2026-09-16T18:00:00+00:00' });

    test('a meteora pool and CoinGecko’s "Meteora" are not an arbitrage gap', () => {
        // The LLY shape: one venue, two prints taken at different moments. 11.6 % of nothing.
        const activity = spread({ dex: [pool('meteora', 100)], cex: [market('Meteora', 111.56)] });
        expect(activity.venuesPriced).toBe(1);
        expect(activity.venueSpreadPct).toBeNull();
        expect(activity.venueSpreadLow).toBeNull();
        expect(activity.venueSpreadHigh).toBeNull();
        // The venue COUNT still reports both, because that is what the two sources listed.
        expect(activity.venueCount).toBe(2);
    });

    test('the parenthesised suffix and the case do not hide the duplicate', () => {
        expect(spread({ dex: [pool('raydium', 100)], cex: [market('Raydium (CLMM)', 120)] }).venuesPriced).toBe(1);
        expect(spread({ dex: [pool('orca', 100)], cex: [market('Orca', 120)] }).venuesPriced).toBe(1);
        // Two CoinGecko names for one dex collapse too, even with no pool of it priced.
        expect(spread({ dex: [], cex: [market('Raydium', 100), market('Raydium (CLMM)', 120)] }).venuesPriced).toBe(1);
    });

    test('the DexScreener price is the one kept, and a genuine second venue still counts', () => {
        const activity = spread({ dex: [pool('raydium', 100)], cex: [market('Raydium (CLMM)', 120), market('Kraken', 101)] });
        expect(activity.venuesPriced).toBe(2);
        expect(activity.venueSpreadLow).toBe('raydium');
        expect(activity.venueSpreadHigh).toBe('Kraken');
        expect(activity.venueSpreadPct).toBeCloseTo(1, 10);
    });

    test('a CEX market is NOT dropped when no pool of that dex qualified', () => {
        // The thin-pool case: the CoinGecko market is then the only price that venue has.
        const thin = { dex: [{ dexId: 'meteora', pairAddress: 'm-1', priceUsd: 100, liquidityUsd: 500, volume24Usd: 1, txns24: 1 }], cex: [market('Meteora', 110), market('Kraken', 111)] };
        expect(spread(thin).venuesPriced).toBe(2);
        expect(spread(thin).venueSpreadLow).toBe('Meteora');
    });
});
