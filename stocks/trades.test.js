// Unit tests for the pure trade decoder and bucketing (lib/trades.mjs). The two transaction
// fixtures are VERBATIM `getTransaction` results (jsonParsed, maxSupportedTransactionVersion 0)
// read from the public RPC on 2026-09-16 for the SPYx/SOL Raydium pool
// BS9uyGV6XmNnPkM4f3xgxCdQEaFv7RSKs6fwrpvYHxfL — one sell, one buy 36 s earlier — trimmed to the
// fields the decoder reads and to nothing else: every amount, owner, decimal, signature, program
// and blockTime is the real one. SIGNATURE_PAGE is the real newest-50 page for the same pool, six
// of whose transactions reverted.
//
// That makes the decode checkable against a source it never saw: the sell resolves to 7.6755 SOL
// per SPYx and DexScreener quoted the same pool at priceNative 7.6946 the same minute.

const {
    finiteOrNull,
    sumOrNull,
    isoSeconds,
    timeFromBlockTime,
    quoteUsdRate,
    tokenBalanceDeltas,
    topLevelPrograms,
    partitionSignatures,
    selectPools,
    selectSignaturesToFetch,
    decodeTrade,
    tradeVolumeUsd,
    hourStartMs,
    hourlyBuckets,
    totalsFor,
    sortTradesNewestFirst,
    mergeTrades,
    mergeSeenSignatures,
    buildPayload,
    WSOL_MINT,
    USDC_MINT,
    USDT_MINT,
    HOUR_MS
} = require('./lib/trades.mjs');

const PAIR = 'BS9uyGV6XmNnPkM4f3xgxCdQEaFv7RSKs6fwrpvYHxfL';
const SPYX_MINT = 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W';
const JITOSOL_MINT = '6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx';
const FLASH_ROUTER = 'FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';

// DexScreener for this very pool the same minute: priceUsd "759.23", priceNative "7.6946".
const SOL_USD = 759.23 / 7.6946;
const SPYX_POOL = {
    pair: PAIR,
    mint: SPYX_MINT,
    symbol: 'SPYx',
    dex: 'raydium',
    quoteMint: WSOL_MINT,
    quoteSymbol: 'SOL',
    quoteUsdRate: SOL_USD
};

// A real SELL: the pool GAINED 0.14221443 SPYx and paid out 1.091564862 SOL. One hop of a
// three-mint route (jitoSOL → SPYx → SOL), which is why `routed` is true — and why the top-level
// programs are a router and the system program: Raydium's own program is CPI'd and never appears.
const SELL_TX = {
    blockTime: 1789592464,
    slot: 447619514,
    transaction: {
        signatures: ['4z9SDhxG6HhUp1k99vpHEQvpgH6SHVdpVZVfRwoTh85Du5a2rtFzcy5zro94aQCfcqd7eR19oNxcxLw7zjPbXDu8'],
        message: {
            accountKeys: [{ pubkey: '3ELRkjj4qoNSi31i9NAMnpDRfiAKCdB4asauSj1XWhMP', signer: true, writable: true }],
            instructions: [{ programId: COMPUTE_BUDGET }, { programId: COMPUTE_BUDGET }, { programId: FLASH_ROUTER }, { programId: FLASH_ROUTER }, { programId: SYSTEM_PROGRAM }]
        }
    },
    meta: {
        err: null,
        preTokenBalances: [
            { accountIndex: 1, mint: SPYX_MINT, owner: '3ELRkjj4qoNSi31i9NAMnpDRfiAKCdB4asauSj1XWhMP', uiTokenAmount: { amount: '0', decimals: 8, uiAmount: null, uiAmountString: '0' } },
            { accountIndex: 3, mint: JITOSOL_MINT, owner: '7a8xxAJBELDo6P9dikSYctdw6ce8F4mWr3ahcAD8Ao49', uiTokenAmount: { amount: '17864885266316676', decimals: 9, uiAmount: 17864885.266316675, uiAmountString: '17864885.266316676' } },
            { accountIndex: 10, mint: JITOSOL_MINT, owner: '3ELRkjj4qoNSi31i9NAMnpDRfiAKCdB4asauSj1XWhMP', uiTokenAmount: { amount: '2302916256574', decimals: 9, uiAmount: 2302.916256574, uiAmountString: '2302.916256574' } },
            { accountIndex: 12, mint: SPYX_MINT, owner: '7a8xxAJBELDo6P9dikSYctdw6ce8F4mWr3ahcAD8Ao49', uiTokenAmount: { amount: '234523393627', decimals: 8, uiAmount: 2345.23393627, uiAmountString: '2345.23393627' } },
            { accountIndex: 28, mint: SPYX_MINT, owner: PAIR, uiTokenAmount: { amount: '60533655162', decimals: 8, uiAmount: 605.33655162, uiAmountString: '605.33655162' } },
            { accountIndex: 32, mint: WSOL_MINT, owner: PAIR, uiTokenAmount: { amount: '6223006690470', decimals: 9, uiAmount: 6223.00669047, uiAmountString: '6223.00669047' } }
        ],
        postTokenBalances: [
            { accountIndex: 1, mint: SPYX_MINT, owner: '3ELRkjj4qoNSi31i9NAMnpDRfiAKCdB4asauSj1XWhMP', uiTokenAmount: { amount: '0', decimals: 8, uiAmount: null, uiAmountString: '0' } },
            { accountIndex: 3, mint: JITOSOL_MINT, owner: '7a8xxAJBELDo6P9dikSYctdw6ce8F4mWr3ahcAD8Ao49', uiTokenAmount: { amount: '17865460995380819', decimals: 9, uiAmount: 17865460.99538082, uiAmountString: '17865460.995380819' } },
            { accountIndex: 10, mint: JITOSOL_MINT, owner: '3ELRkjj4qoNSi31i9NAMnpDRfiAKCdB4asauSj1XWhMP', uiTokenAmount: { amount: '1727187192431', decimals: 9, uiAmount: 1727.187192431, uiAmountString: '1727.187192431' } },
            { accountIndex: 12, mint: SPYX_MINT, owner: '7a8xxAJBELDo6P9dikSYctdw6ce8F4mWr3ahcAD8Ao49', uiTokenAmount: { amount: '234509172184', decimals: 8, uiAmount: 2345.09172184, uiAmountString: '2345.09172184' } },
            { accountIndex: 28, mint: SPYX_MINT, owner: PAIR, uiTokenAmount: { amount: '60547876605', decimals: 8, uiAmount: 605.47876605, uiAmountString: '605.47876605' } },
            { accountIndex: 32, mint: WSOL_MINT, owner: PAIR, uiTokenAmount: { amount: '6221915125608', decimals: 9, uiAmount: 6221.915125608, uiAmountString: '6221.915125608' } }
        ]
    }
};

// A real BUY on the same pool 36 s earlier: the pool LOST 0.00176537 SPYx and took in 0.013623302
// SOL. Nine pre-balances against eleven post, so accounts 7 and 9 exist only in `post` and must
// count as +post; accounts 4 and 5 are unchanged and must not count as movements at all.
const BUY_TX = {
    blockTime: 1789592428,
    slot: 447619400,
    transaction: {
        signatures: ['3qjqKY3uHGvbBypGhPJbBqwxLx1oJ7q1muVVpyujDkb5Cy8Dm716N9Qqtyq4fkR1DRiGeckSZ2kFeWSe7rH1Nyou'],
        message: {
            accountKeys: [{ pubkey: 'AYCyfjJhryvvLWwGs1WqKLhkC4QQgRVuTFqLY3RXBDHs', signer: true, writable: true }],
            instructions: [{ programId: COMPUTE_BUDGET }, { programId: COMPUTE_BUDGET }, { programId: FLASH_ROUTER }, { programId: FLASH_ROUTER }, { programId: FLASH_ROUTER }, { programId: FLASH_ROUTER }, { programId: SYSTEM_PROGRAM }]
        }
    },
    meta: {
        err: null,
        preTokenBalances: [
            { accountIndex: 2, mint: JITOSOL_MINT, owner: 'WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh', uiTokenAmount: { amount: '3619656623959', decimals: 9, uiAmount: 3619.656623959, uiAmountString: '3619.656623959' } },
            { accountIndex: 4, mint: JITOSOL_MINT, owner: '9sHpTfmVpCfP2zexRNK6j38NBchMv1RWpdXPK5NEcZan', uiTokenAmount: { amount: '0', decimals: 9, uiAmount: null, uiAmountString: '0' } },
            { accountIndex: 5, mint: SPYX_MINT, owner: 'AYCyfjJhryvvLWwGs1WqKLhkC4QQgRVuTFqLY3RXBDHs', uiTokenAmount: { amount: '1', decimals: 8, uiAmount: 1e-8, uiAmountString: '0.00000001' } },
            { accountIndex: 6, mint: 'Cgif9yZT88fymfJpearjrgMXypXvwo2hPZiFCDhd39uz', owner: 'WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh', uiTokenAmount: { amount: '799124865075415', decimals: 6, uiAmount: 799124865.075415, uiAmountString: '799124865.075415' } },
            { accountIndex: 16, mint: JITOSOL_MINT, owner: '7a8xxAJBELDo6P9dikSYctdw6ce8F4mWr3ahcAD8Ao49', uiTokenAmount: { amount: '17852175049329628', decimals: 9, uiAmount: 17852175.049329627, uiAmountString: '17852175.049329628' } },
            { accountIndex: 23, mint: SPYX_MINT, owner: '7a8xxAJBELDo6P9dikSYctdw6ce8F4mWr3ahcAD8Ao49', uiTokenAmount: { amount: '234837780586', decimals: 8, uiAmount: 2348.37780586, uiAmountString: '2348.37780586' } },
            { accountIndex: 25, mint: JITOSOL_MINT, owner: '56XVRVAsgWv6ADaxzoNnbL38LMoWKM5WiSAhrAWUbd2p', uiTokenAmount: { amount: '84980918208', decimals: 9, uiAmount: 84.980918208, uiAmountString: '84.980918208' } },
            { accountIndex: 36, mint: SPYX_MINT, owner: PAIR, uiTokenAmount: { amount: '60219581984', decimals: 8, uiAmount: 602.19581984, uiAmountString: '602.19581984' } },
            { accountIndex: 38, mint: WSOL_MINT, owner: PAIR, uiTokenAmount: { amount: '6247117971878', decimals: 9, uiAmount: 6247.117971878, uiAmountString: '6247.117971878' } }
        ],
        postTokenBalances: [
            { accountIndex: 2, mint: JITOSOL_MINT, owner: 'WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh', uiTokenAmount: { amount: '3626586197467', decimals: 9, uiAmount: 3626.586197467, uiAmountString: '3626.586197467' } },
            { accountIndex: 4, mint: JITOSOL_MINT, owner: '9sHpTfmVpCfP2zexRNK6j38NBchMv1RWpdXPK5NEcZan', uiTokenAmount: { amount: '0', decimals: 9, uiAmount: null, uiAmountString: '0' } },
            { accountIndex: 5, mint: SPYX_MINT, owner: 'AYCyfjJhryvvLWwGs1WqKLhkC4QQgRVuTFqLY3RXBDHs', uiTokenAmount: { amount: '1', decimals: 8, uiAmount: 1e-8, uiAmountString: '0.00000001' } },
            { accountIndex: 6, mint: 'Cgif9yZT88fymfJpearjrgMXypXvwo2hPZiFCDhd39uz', owner: 'WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh', uiTokenAmount: { amount: '798811646288010', decimals: 6, uiAmount: 798811646.28801, uiAmountString: '798811646.28801' } },
            { accountIndex: 7, mint: JITOSOL_MINT, owner: 'AYCyfjJhryvvLWwGs1WqKLhkC4QQgRVuTFqLY3RXBDHs', uiTokenAmount: { amount: '0', decimals: 9, uiAmount: null, uiAmountString: '0' } },
            { accountIndex: 9, mint: 'Cgif9yZT88fymfJpearjrgMXypXvwo2hPZiFCDhd39uz', owner: 'AYCyfjJhryvvLWwGs1WqKLhkC4QQgRVuTFqLY3RXBDHs', uiTokenAmount: { amount: '313218787405', decimals: 6, uiAmount: 313218.787405, uiAmountString: '313218.787405' } },
            { accountIndex: 16, mint: JITOSOL_MINT, owner: '7a8xxAJBELDo6P9dikSYctdw6ce8F4mWr3ahcAD8Ao49', uiTokenAmount: { amount: '17852168049760428', decimals: 9, uiAmount: 17852168.049760427, uiAmountString: '17852168.049760428' } },
            { accountIndex: 23, mint: SPYX_MINT, owner: '7a8xxAJBELDo6P9dikSYctdw6ce8F4mWr3ahcAD8Ao49', uiTokenAmount: { amount: '234837957123', decimals: 8, uiAmount: 2348.37957123, uiAmountString: '2348.37957123' } },
            { accountIndex: 25, mint: JITOSOL_MINT, owner: '56XVRVAsgWv6ADaxzoNnbL38LMoWKM5WiSAhrAWUbd2p', uiTokenAmount: { amount: '85050913900', decimals: 9, uiAmount: 85.0509139, uiAmountString: '85.0509139' } },
            { accountIndex: 36, mint: SPYX_MINT, owner: PAIR, uiTokenAmount: { amount: '60219405447', decimals: 8, uiAmount: 602.19405447, uiAmountString: '602.19405447' } },
            { accountIndex: 38, mint: WSOL_MINT, owner: PAIR, uiTokenAmount: { amount: '6247131595180', decimals: 9, uiAmount: 6247.13159518, uiAmountString: '6247.13159518' } }
        ]
    }
};

// The real newest-50 `getSignaturesForAddress` page for the pool, reduced to signature/err/blockTime
// and to the six that reverted plus four that did not. The whole page spanned 137 SECONDS — this
// pool turns over its 50-signature window twice a minute, which is why the tape samples it rather
// than capturing every trade.
const SIGNATURE_PAGE = [
    { signature: 'k3ggL9ZhHiaftiDpLZhw9RRckefd6j33DMWirUyo2EKfsJ5Z51Lk44TWVsd9v6eorMcxR4LxWBuuDmAJ6KztF7f', slot: 447619525, err: { InstructionError: [2, { Custom: 6001 }] }, blockTime: 1789592468 },
    { signature: '5pCkic2zxTGZkZzKHwn7235nfRqaAqq5exd6S7EtLQCDTxMnKMPnmuJyVvHJ4KNxkR9WFvedfd8tttqDL7hftZKU', slot: 447619517, err: null, blockTime: 1789592467 },
    { signature: '4z9SDhxG6HhUp1k99vpHEQvpgH6SHVdpVZVfRwoTh85Du5a2rtFzcy5zro94aQCfcqd7eR19oNxcxLw7zjPbXDu8', slot: 447619514, err: null, blockTime: 1789592464 },
    { signature: '5z9auDSAeh8ohvG3C8npRnLBvgYNDBTYYcNxvVdVKRNtVJnKKdnTaXtyN1zLLLMHPCfhzKB2EQwVnLNPaBLFRCgb', slot: 447619404, err: { InstructionError: [3, { Custom: 100 }] }, blockTime: 1789592430 },
    { signature: '2CAFRBsSk5zu2pUyV9hMYsNRRQZKMvnKPiCVB5FZiZnBdKhqZL3xkjMJqUhPSEQVYRtRSNBmVmZLPMbGnZhzAaJu', slot: 447619404, err: { InstructionError: [3, { Custom: 100 }] }, blockTime: 1789592430 },
    { signature: '3qjqKY3uHGvbBypGhPJbBqwxLx1oJ7q1muVVpyujDkb5Cy8Dm716N9Qqtyq4fkR1DRiGeckSZ2kFeWSe7rH1Nyou', slot: 447619400, err: null, blockTime: 1789592428 },
    { signature: '43oWbAwzxJnujjrhoZPYQxmXjvVkPvDSNBLKDqZ1ZLaJiCwZ4XQ6pEPPtKPfLYnUXjNqLEwvSLKjUZ1hVZVYPiRt', slot: 447619240, err: { InstructionError: [2, { Custom: 1 }] }, blockTime: 1789592364 },
    { signature: '3m6MkmJMmyha2BPtvWfpZDVqRxMXQkPTzKZBBZjLNKSWQjMrJZBvEZKwWEsKPzDLKZQqVJNBnWKNZTvLPRJZnBQu', slot: 447619228, err: { InsufficientFundsForRent: { account_index: 0 } }, blockTime: 1789592360 },
    { signature: '2vK9Sim15i8vaa4okBcQDGLVWvbn5o8XtyKqypaQLDkTgthDysY1eyr88HNDaDagYgJ8zLqsTf2FWQbXdQArXXS3', slot: 447619203, err: null, blockTime: 1789592356 },
    { signature: 'Hj2jVtGbRrVbgVwAD8HtKEZPMQjKLZNBvWKQZLPRJnBVKZQwWEsKPzDLKZQqVJNBnWKNZTvLPRJZnBQuMKJZBvEZ', slot: 447619118, err: { InstructionError: [3, { Custom: 100 }] }, blockTime: 1789592332 }
];

const SELL_SIG = SELL_TX.transaction.signatures[0];
const BUY_SIG = BUY_TX.transaction.signatures[0];

describe('number and time guards', () => {
    test('a zero token balance arrives as uiAmount null, and must survive as a real zero', () => {
        // Verbatim from the fixture: the RPC sends `uiAmount: null` with `uiAmountString: "0"`.
        const zero = SELL_TX.meta.preTokenBalances[0].uiTokenAmount;
        expect(zero.uiAmount).toBeNull();
        expect(finiteOrNull(zero.uiAmountString)).toBe(0);
        expect(finiteOrNull(zero.uiAmount)).toBeNull();
    });

    test('sumOrNull keeps "nothing was summable" as null rather than $0', () => {
        expect(sumOrNull([1, null, 2])).toBe(3);
        expect(sumOrNull([null, undefined, 'x'])).toBeNull();
        expect(sumOrNull([0])).toBe(0);
    });

    test('blockTime is used verbatim, and its absence stays null instead of becoming now', () => {
        expect(timeFromBlockTime(1789592464)).toBe('2026-09-16T21:01:04Z');
        expect(timeFromBlockTime(null)).toBeNull();
        expect(timeFromBlockTime(undefined)).toBeNull();
        expect(isoSeconds(1789592464000)).toBe('2026-09-16T21:01:04Z');
    });
});

describe('quoteUsdRate', () => {
    test('SOL-quoted pools take the USD/SOL rate implied by the pool itself', () => {
        // The real strings DexScreener returned for this pool.
        expect(quoteUsdRate({ quoteMint: WSOL_MINT, priceUsd: '759.23', priceNative: '7.6946' })).toBeCloseTo(98.6705, 3);
    });

    test('USDC and USDT are 1 without a lookup', () => {
        expect(quoteUsdRate({ quoteMint: USDC_MINT })).toBe(1);
        expect(quoteUsdRate({ quoteMint: USDT_MINT, priceUsd: null, priceNative: null })).toBe(1);
    });

    test('any other quote asset is null, never a guessed rate', () => {
        // The section's largest pool by 24 h volume (DKNG) quotes in a memecoin, ALLINU.
        expect(quoteUsdRate({ quoteMint: '4MMQY9bwkxxTtsK3W227Q5ABT6yFY8Pmn9Ze7wmAXKY8', priceUsd: '3.5', priceNative: '120' })).toBeNull();
        expect(quoteUsdRate({ quoteMint: null })).toBeNull();
        expect(quoteUsdRate()).toBeNull();
    });

    test('a SOL pool with no usable price pair is null, not 0 and not NaN', () => {
        expect(quoteUsdRate({ quoteMint: WSOL_MINT, priceUsd: '759.23', priceNative: null })).toBeNull();
        expect(quoteUsdRate({ quoteMint: WSOL_MINT, priceUsd: '759.23', priceNative: '0' })).toBeNull();
        expect(quoteUsdRate({ quoteMint: WSOL_MINT, priceUsd: '', priceNative: '7.69' })).toBeNull();
    });
});

describe('tokenBalanceDeltas', () => {
    test('finds the pool\'s own two legs in a real swap', () => {
        const deltas = tokenBalanceDeltas(SELL_TX.meta);
        const poolToken = deltas.find((d) => d.owner === PAIR && d.mint === SPYX_MINT);
        const poolQuote = deltas.find((d) => d.owner === PAIR && d.mint === WSOL_MINT);
        expect(poolToken.delta).toBeCloseTo(0.14221443, 8);
        expect(poolQuote.delta).toBeCloseTo(-1.091564862, 9);
    });

    test('an unchanged balance is not a movement', () => {
        // Account 1 (the taker\'s empty SPYx account) is 0 before and after; accounts 4 and 5 in the
        // buy are likewise unchanged. None may appear, or `routed` would count phantom mints.
        const deltas = tokenBalanceDeltas(SELL_TX.meta);
        expect(deltas.some((d) => d.owner === '3ELRkjj4qoNSi31i9NAMnpDRfiAKCdB4asauSj1XWhMP' && d.mint === SPYX_MINT)).toBe(false);
        const buyDeltas = tokenBalanceDeltas(BUY_TX.meta);
        expect(buyDeltas.some((d) => d.owner === '9sHpTfmVpCfP2zexRNK6j38NBchMv1RWpdXPK5NEcZan')).toBe(false);
    });

    test('an account present only in post counts as +post', () => {
        // Account 9 exists only in postTokenBalances: the buyer\'s output account, opened by the swap.
        const deltas = tokenBalanceDeltas(BUY_TX.meta);
        const opened = deltas.find((d) => d.owner === 'AYCyfjJhryvvLWwGs1WqKLhkC4QQgRVuTFqLY3RXBDHs' && d.mint === 'Cgif9yZT88fymfJpearjrgMXypXvwo2hPZiFCDhd39uz');
        expect(opened.delta).toBeCloseTo(313218.787405, 6);
    });

    test('an account present only in pre counts as −pre', () => {
        const drained = tokenBalanceDeltas({
            preTokenBalances: [{ accountIndex: 4, mint: SPYX_MINT, owner: 'taker', uiTokenAmount: { amount: '250000000', decimals: 8, uiAmount: 2.5, uiAmountString: '2.5' } }],
            postTokenBalances: []
        });
        expect(drained).toEqual([{ owner: 'taker', mint: SPYX_MINT, delta: -2.5, decimals: 8 }]);
    });

    test('reads the raw integer amount, not the lossy uiAmount float', () => {
        // Verbatim from the buy fixture: the float dropped the last digit of the string form.
        const before = BUY_TX.meta.preTokenBalances[4].uiTokenAmount;
        const after = BUY_TX.meta.postTokenBalances[6].uiTokenAmount;
        expect(before.uiAmount).toBe(17852175.049329627);
        expect(before.uiAmountString).toBe('17852175.049329628');
        // Raw: 17852168049760428 − 17852175049329628 = −6999569200 → −6.9995692 exactly.
        const deltas = tokenBalanceDeltas(BUY_TX.meta);
        const routerLeg = deltas.find((d) => d.owner === '7a8xxAJBELDo6P9dikSYctdw6ce8F4mWr3ahcAD8Ao49' && d.mint === JITOSOL_MINT);
        expect(routerLeg.delta).toBe(Number(BigInt(after.amount) - BigInt(before.amount)) / 1e9);
        expect(routerLeg.delta).toBeCloseTo(-6.9995692, 7);
    });

    test('falls back to the stated decimal amount when the raw integer is withheld', () => {
        const deltas = tokenBalanceDeltas({
            preTokenBalances: [{ accountIndex: 1, mint: SPYX_MINT, owner: PAIR, uiTokenAmount: { decimals: 8, uiAmount: 10, uiAmountString: '10' } }],
            postTokenBalances: [{ accountIndex: 1, mint: SPYX_MINT, owner: PAIR, uiTokenAmount: { decimals: 8, uiAmount: 12.5, uiAmountString: '12.5' } }]
        });
        expect(deltas[0].delta).toBeCloseTo(2.5, 8);
    });

    test('a balance with no readable amount at all is skipped rather than counted as zero', () => {
        const deltas = tokenBalanceDeltas({
            preTokenBalances: [{ accountIndex: 1, mint: SPYX_MINT, owner: PAIR, uiTokenAmount: { decimals: 8 } }],
            postTokenBalances: [{ accountIndex: 1, mint: SPYX_MINT, owner: PAIR, uiTokenAmount: { decimals: 8 } }]
        });
        expect(deltas).toEqual([]);
    });

    test('sums several accounts of the same owner and mint, and drops a group that cancels out', () => {
        const meta = {
            preTokenBalances: [
                { accountIndex: 1, mint: SPYX_MINT, owner: PAIR, uiTokenAmount: { amount: '100000000', decimals: 8, uiAmount: 1, uiAmountString: '1' } },
                { accountIndex: 2, mint: SPYX_MINT, owner: PAIR, uiTokenAmount: { amount: '100000000', decimals: 8, uiAmount: 1, uiAmountString: '1' } }
            ],
            postTokenBalances: [
                { accountIndex: 1, mint: SPYX_MINT, owner: PAIR, uiTokenAmount: { amount: '150000000', decimals: 8, uiAmount: 1.5, uiAmountString: '1.5' } },
                { accountIndex: 2, mint: SPYX_MINT, owner: PAIR, uiTokenAmount: { amount: '50000000', decimals: 8, uiAmount: 0.5, uiAmountString: '0.5' } }
            ]
        };
        expect(tokenBalanceDeltas(meta)).toEqual([]);
    });

    test('an empty or absent meta yields no deltas instead of throwing', () => {
        expect(tokenBalanceDeltas(undefined)).toEqual([]);
        expect(tokenBalanceDeltas({})).toEqual([]);
        expect(tokenBalanceDeltas({ preTokenBalances: null, postTokenBalances: null })).toEqual([]);
    });
});

describe('topLevelPrograms', () => {
    test('drops compute budget, dedupes and sorts — and does not include the AMM', () => {
        expect(topLevelPrograms(SELL_TX)).toEqual([SYSTEM_PROGRAM, FLASH_ROUTER]);
        expect(topLevelPrograms(BUY_TX)).toEqual([SYSTEM_PROGRAM, FLASH_ROUTER]);
        // Raydium's CLMM program executed the swap, by CPI; it is nowhere in the top-level list.
        expect(topLevelPrograms(SELL_TX)).not.toContain('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
    });

    test('a transaction with no instruction list is an empty list, not a throw', () => {
        expect(topLevelPrograms({})).toEqual([]);
        expect(topLevelPrograms({ transaction: { message: { instructions: [{ programIdIndex: 3 }] } } })).toEqual([]);
    });
});

describe('decodeTrade on real transactions', () => {
    test('decodes the real SELL exactly', () => {
        expect(decodeTrade(SELL_TX, SPYX_POOL)).toEqual({
            sig: SELL_SIG,
            time: '2026-09-16T21:01:04Z',
            mint: SPYX_MINT,
            symbol: 'SPYx',
            dex: 'raydium',
            pair: PAIR,
            side: 'sell',
            size: 0.14221443,
            quoteAmount: 1.091564862,
            quoteSymbol: 'SOL',
            priceQuote: 1.091564862 / 0.14221443,
            priceUsd: (1.091564862 / 0.14221443) * SOL_USD,
            feePayer: '3ELRkjj4qoNSi31i9NAMnpDRfiAKCdB4asauSj1XWhMP',
            routed: true,
            programs: [SYSTEM_PROGRAM, FLASH_ROUTER]
        });
    });

    test('the decoded price agrees with what DexScreener said about the same pool', () => {
        // The one check that the decode is RIGHT rather than merely self-consistent: an independent
        // source quoted priceNative 7.6946 SOL and priceUsd $759.23 for this pool the same minute.
        const trade = decodeTrade(SELL_TX, SPYX_POOL);
        expect(trade.priceQuote).toBeCloseTo(7.6755, 3);
        expect(Math.abs(trade.priceQuote - 7.6946) / 7.6946).toBeLessThan(0.005);
        expect(trade.priceUsd).toBeCloseTo(757.1, 0);
        expect(Math.abs(trade.priceUsd - 759.23) / 759.23).toBeLessThan(0.005);
    });

    test('decodes the real BUY as the other side', () => {
        const trade = decodeTrade(BUY_TX, SPYX_POOL);
        expect(trade.side).toBe('buy');
        expect(trade.size).toBeCloseTo(0.00176537, 8);
        expect(trade.quoteAmount).toBeCloseTo(0.013623302, 9);
        expect(trade.priceQuote).toBeCloseTo(7.71697, 4);
        expect(trade.time).toBe('2026-09-16T21:00:28Z');
        expect(trade.feePayer).toBe('AYCyfjJhryvvLWwGs1WqKLhkC4QQgRVuTFqLY3RXBDHs');
        expect(trade.routed).toBe(true);
    });

    test('side follows the POOL\'s balance, so flipping it would flip the trade', () => {
        // Same transaction, pool legs swapped by hand: the pool losing the token is a buy.
        const mirrored = JSON.parse(JSON.stringify(SELL_TX));
        const pre = mirrored.meta.preTokenBalances.find((b) => b.owner === PAIR && b.mint === SPYX_MINT);
        const post = mirrored.meta.postTokenBalances.find((b) => b.owner === PAIR && b.mint === SPYX_MINT);
        [pre.uiTokenAmount, post.uiTokenAmount] = [post.uiTokenAmount, pre.uiTokenAmount];
        expect(decodeTrade(mirrored, SPYX_POOL).side).toBe('buy');
        expect(decodeTrade(SELL_TX, SPYX_POOL).side).toBe('sell');
    });

    test('a transaction that moves none of the tracked mint is undecodable, not a zero trade', () => {
        // The same real transaction read as if we were tracking a mint this pool does not hold.
        expect(decodeTrade(SELL_TX, { ...SPYX_POOL, mint: USDC_MINT })).toBeNull();
        // …and one that touches the pool without moving any token balance at all.
        expect(decodeTrade({ ...SELL_TX, meta: { preTokenBalances: [], postTokenBalances: [] } }, SPYX_POOL)).toBeNull();
    });

    test('a pool that was only MENTIONED is not a trade of size zero', () => {
        // Real shape, verified on the BROS pool 2026-09-16: getSignaturesForAddress returns every
        // transaction that mentions the address, and an arbitrage bot lists several pools among its
        // accounts while trading through only some. This pool's own vaults came back byte-identical
        // (So111=7446874521, BRVaZK=69492010 before and after) while other pools' balances moved.
        const mentioned = {
            blockTime: 1789592500,
            transaction: { signatures: ['mentioned-only'], message: { accountKeys: [{ pubkey: 'bot' }], instructions: [{ programId: 'HiP3dRdEbKmLxHBThuBnQGEd1JZJZKZPkwkvVKBXUKTD' }] } },
            meta: {
                err: null,
                preTokenBalances: [
                    { accountIndex: 4, mint: SPYX_MINT, owner: PAIR, uiTokenAmount: { amount: '69492010', decimals: 8, uiAmount: 0.6949201, uiAmountString: '0.6949201' } },
                    { accountIndex: 5, mint: WSOL_MINT, owner: PAIR, uiTokenAmount: { amount: '7446874521', decimals: 9, uiAmount: 7.446874521, uiAmountString: '7.446874521' } },
                    { accountIndex: 9, mint: SPYX_MINT, owner: 'OtherPool', uiTokenAmount: { amount: '100000000', decimals: 8, uiAmount: 1, uiAmountString: '1' } }
                ],
                postTokenBalances: [
                    { accountIndex: 4, mint: SPYX_MINT, owner: PAIR, uiTokenAmount: { amount: '69492010', decimals: 8, uiAmount: 0.6949201, uiAmountString: '0.6949201' } },
                    { accountIndex: 5, mint: WSOL_MINT, owner: PAIR, uiTokenAmount: { amount: '7446874521', decimals: 9, uiAmount: 7.446874521, uiAmountString: '7.446874521' } },
                    { accountIndex: 9, mint: SPYX_MINT, owner: 'OtherPool', uiTokenAmount: { amount: '150000000', decimals: 8, uiAmount: 1.5, uiAmountString: '1.5' } }
                ]
            }
        };
        expect(tokenBalanceDeltas(mentioned.meta).filter((d) => d.owner === PAIR)).toEqual([]);
        expect(decodeTrade(mentioned, SPYX_POOL)).toBeNull();
    });

    test('an unknown quote rate leaves priceUsd null while keeping the real size and quote price', () => {
        const trade = decodeTrade(SELL_TX, { ...SPYX_POOL, quoteUsdRate: null });
        expect(trade.size).toBe(0.14221443);
        expect(trade.priceQuote).toBeCloseTo(7.6755, 3);
        expect(trade.priceUsd).toBeNull();
    });

    test('a quote leg that is not in the transaction leaves the quote side null, not 0', () => {
        const trade = decodeTrade(SELL_TX, { ...SPYX_POOL, quoteMint: USDC_MINT });
        expect(trade.side).toBe('sell');
        expect(trade.size).toBe(0.14221443);
        expect(trade.quoteAmount).toBeNull();
        expect(trade.priceQuote).toBeNull();
        expect(trade.priceUsd).toBeNull();
    });

    test('falls back to the signature the caller asked for when the payload omits it', () => {
        const noSig = { ...SELL_TX, transaction: { ...SELL_TX.transaction, signatures: [] } };
        expect(decodeTrade(noSig, SPYX_POOL, { signature: SELL_SIG }).sig).toBe(SELL_SIG);
        expect(decodeTrade(noSig, SPYX_POOL).sig).toBeNull();
    });

    test('a two-mint swap is not flagged as routed', () => {
        const direct = JSON.parse(JSON.stringify(SELL_TX));
        direct.meta.preTokenBalances = direct.meta.preTokenBalances.filter((b) => b.mint !== JITOSOL_MINT);
        direct.meta.postTokenBalances = direct.meta.postTokenBalances.filter((b) => b.mint !== JITOSOL_MINT);
        expect(decodeTrade(direct, SPYX_POOL).routed).toBe(false);
        expect(decodeTrade(SELL_TX, SPYX_POOL).routed).toBe(true);
    });

    test('refuses a pool record it cannot attribute a trade to', () => {
        expect(decodeTrade(SELL_TX, { ...SPYX_POOL, pair: null })).toBeNull();
        expect(decodeTrade(SELL_TX, { ...SPYX_POOL, mint: '' })).toBeNull();
        expect(decodeTrade(null, SPYX_POOL)).toBeNull();
    });
});

describe('selectPools', () => {
    // Shaped exactly as venues.json items are, with the real top-three pools of 2026-09-16.
    const venues = {
        items: [
            { mint: 'DKNGmint', symbol: 'DKNG', dex: [{ pairAddress: '5752ia7jC3ZU1c8ycytaSyi5D4nVhApSKvreGbs7pwWL', dexId: 'raydium', quoteSymbol: 'ALLINU', quoteMint: '4MMQY9bwkxxTtsK3W227Q5ABT6yFY8Pmn9Ze7wmAXKY8', volume24Usd: 5211469 }] },
            { mint: SPYX_MINT, symbol: 'SPYx', dex: [{ pairAddress: PAIR, dexId: 'raydium', quoteSymbol: 'SOL', quoteMint: WSOL_MINT, volume24Usd: 3449185 }] },
            { mint: 'SKHYmint', symbol: 'SKHY', dex: [{ pairAddress: 'DPAU7wDyMXDgNAfzQYMfyNqmTjzcoRsSPA2LeGH71hgi', dexId: 'meteora', quoteSymbol: 'USDC', quoteMint: USDC_MINT, volume24Usd: 1769347 }] },
            { mint: 'quietMint', symbol: 'QUIET', dex: [{ pairAddress: 'quietPair', dexId: 'orca', quoteSymbol: 'USDC', quoteMint: USDC_MINT, volume24Usd: null }] },
            { mint: 'noPoolsMint', symbol: 'NONE', dex: [], cex: [{ market: 'LBank' }] }
        ]
    };

    test('ranks by 24 h volume and carries what the decoder needs', () => {
        const pools = selectPools(venues, 2);
        expect(pools.map((p) => p.symbol)).toEqual(['DKNG', 'SPYx']);
        expect(pools[1]).toEqual({ pair: PAIR, mint: SPYX_MINT, symbol: 'SPYx', dex: 'raydium', quoteMint: WSOL_MINT, quoteSymbol: 'SOL', volume24Usd: 3449185 });
    });

    test('a pool with no reported volume ranks last rather than first', () => {
        expect(selectPools(venues, 10).map((p) => p.symbol)).toEqual(['DKNG', 'SPYx', 'SKHY', 'QUIET']);
    });

    test('tokens with no pool at all are not pools', () => {
        expect(selectPools(venues, 10).some((p) => p.symbol === 'NONE')).toBe(false);
        expect(selectPools({ items: [] }, 5)).toEqual([]);
        expect(selectPools(null, 5)).toEqual([]);
    });

    test('drops a pair with no address, since there is nothing to query', () => {
        const broken = { items: [{ mint: 'm', symbol: 'X', dex: [{ dexId: 'raydium', volume24Usd: 9e9 }] }] };
        expect(selectPools(broken, 5)).toEqual([]);
    });

    test('the top pool by volume quotes in a memecoin, so its trades cannot be priced in USD', () => {
        // Not a hypothetical: DKNG/ALLINU was the section's largest pool by 24 h volume.
        const top = selectPools(venues, 1)[0];
        expect(quoteUsdRate({ quoteMint: top.quoteMint, priceUsd: '3.5', priceNative: '120' })).toBeNull();
    });
});

describe('partitionSignatures', () => {
    test('splits the real page into the 4 to fetch and the 6 that reverted', () => {
        const { ok, failed } = partitionSignatures(SIGNATURE_PAGE, { pair: PAIR });
        expect(ok).toHaveLength(4);
        expect(failed).toHaveLength(6);
        expect(ok.map((s) => s.sig)).toContain(SELL_SIG);
        expect(failed.map((s) => s.sig)).not.toContain(SELL_SIG);
        expect(ok[0]).toEqual({ sig: '5pCkic2zxTGZkZzKHwn7235nfRqaAqq5exd6S7EtLQCDTxMnKMPnmuJyVvHJ4KNxkR9WFvedfd8tttqDL7hftZKU', pair: PAIR, blockTime: 1789592467, slot: 447619517 });
    });

    test('an entirely failed page yields nothing to fetch and does not throw', () => {
        // Real shape: pools whose newest signatures are all reverts exist (SKHY on Meteora).
        const allFailed = SIGNATURE_PAGE.filter((s) => s.err !== null);
        const { ok, failed } = partitionSignatures(allFailed, { pair: PAIR });
        expect(ok).toEqual([]);
        expect(failed).toHaveLength(6);
        expect(partitionSignatures(null)).toEqual({ ok: [], failed: [] });
    });
});

describe('selectSignaturesToFetch', () => {
    const now = Date.parse('2026-09-16T21:02:00Z');
    const page = partitionSignatures(SIGNATURE_PAGE, { pair: PAIR }).ok;

    test('takes the oldest first, so a partial run leaves no hole behind it', () => {
        const chosen = selectSignaturesToFetch(page, { now, budget: 2 });
        expect(chosen.map((c) => c.blockTime)).toEqual([1789592356, 1789592428]);
    });

    test('skips signatures already stored', () => {
        const chosen = selectSignaturesToFetch(page, { now, budget: 10, known: [BUY_SIG, '2vK9Sim15i8vaa4okBcQDGLVWvbn5o8XtyKqypaQLDkTgthDysY1eyr88HNDaDagYgJ8zLqsTf2FWQbXdQArXXS3'] });
        expect(chosen.map((c) => c.sig).sort()).toEqual([SELL_SIG, '5pCkic2zxTGZkZzKHwn7235nfRqaAqq5exd6S7EtLQCDTxMnKMPnmuJyVvHJ4KNxkR9WFvedfd8tttqDL7hftZKU'].sort());
    });

    test('will not spend a request on a signature already outside the window', () => {
        const stale = [{ sig: 'old', pair: PAIR, blockTime: Math.floor(now / 1000) - 25 * 3600 }, ...page];
        expect(selectSignaturesToFetch(stale, { now, budget: 10 }).map((c) => c.sig)).not.toContain('old');
    });

    test('shares the budget round-robin across pools, so a busy pool is never starved', () => {
        // A quiet pool whose whole window is hours old would take the entire budget on a global
        // oldest-first sort, and the busiest pools — the point of the tape — would never be read.
        const quiet = Array.from({ length: 6 }, (_, i) => ({ sig: `quiet-${i}`, pair: 'QuietPool', blockTime: Math.floor(now / 1000) - 20 * 3600 + i }));
        const chosen = selectSignaturesToFetch([...quiet, ...page], { now, budget: 4 });
        expect(chosen.filter((c) => c.pair === 'QuietPool')).toHaveLength(2);
        expect(chosen.filter((c) => c.pair === PAIR)).toHaveLength(2);
    });

    test('a budget of zero fetches nothing, and a null budget takes everything', () => {
        expect(selectSignaturesToFetch(page, { now, budget: 0 })).toEqual([]);
        expect(selectSignaturesToFetch(page, { now, budget: null })).toHaveLength(4);
    });
});

describe('hourlyBuckets', () => {
    const now = Date.parse('2026-09-16T21:30:00Z');
    const hourAgo = (h) => new Date(Date.parse('2026-09-16T21:00:00Z') - h * HOUR_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const trade = (over) => ({ dex: 'raydium', side: 'sell', size: 1, priceUsd: 10, feePayer: 'alice', time: hourAgo(0), ...over });

    test('always returns 24 buckets ending with the current hour, empty ones included', () => {
        const buckets = hourlyBuckets([trade({})], { now });
        expect(buckets).toHaveLength(24);
        expect(buckets[23].hourStart).toBe('2026-09-16T21:00:00Z');
        expect(buckets[0].hourStart).toBe('2026-09-15T22:00:00Z');
        expect(buckets[23].byDex.raydium.trades).toBe(1);
        // An hour with nothing collected is present and EMPTY — not absent, and not zeroed out.
        expect(buckets[0].byDex).toEqual({});
        expect(buckets.filter((b) => Object.keys(b.byDex).length === 0)).toHaveLength(23);
    });

    test('places a trade by its own hour, on both sides of the boundary', () => {
        const buckets = hourlyBuckets([
            trade({ time: '2026-09-16T20:59:59Z', feePayer: 'a' }),
            trade({ time: '2026-09-16T21:00:00Z', feePayer: 'b' }),
            trade({ time: '2026-09-16T21:59:59Z', feePayer: 'c' })
        ], { now });
        expect(buckets[22].byDex.raydium.trades).toBe(1);
        expect(buckets[23].byDex.raydium.trades).toBe(2);
    });

    test('counts distinct fee payers per hour and venue, not trades', () => {
        const buckets = hourlyBuckets([
            trade({ feePayer: 'bot' }),
            trade({ feePayer: 'bot' }),
            trade({ feePayer: 'bot' }),
            trade({ feePayer: 'human', side: 'buy' })
        ], { now });
        const row = buckets[23].byDex.raydium;
        expect(row.trades).toBe(4);
        expect(row.traders).toBe(2);
        expect(row.sells).toBe(3);
        expect(row.buys).toBe(1);
    });

    test('keeps venues apart', () => {
        const buckets = hourlyBuckets([trade({}), trade({ dex: 'meteora', feePayer: 'bob' })], { now });
        expect(Object.keys(buckets[23].byDex).sort()).toEqual(['meteora', 'raydium']);
        expect(buckets[23].byDex.meteora.trades).toBe(1);
    });

    test('an hour whose trades could not be priced reports null volume, not $0', () => {
        const buckets = hourlyBuckets([trade({ priceUsd: null }), trade({ priceUsd: null, feePayer: 'b' })], { now });
        expect(buckets[23].byDex.raydium.trades).toBe(2);
        expect(buckets[23].byDex.raydium.volumeUsd).toBeNull();
    });

    test('sums the priced ones and ignores the unpriced', () => {
        const buckets = hourlyBuckets([trade({ size: 2, priceUsd: 10 }), trade({ priceUsd: null, feePayer: 'b' }), trade({ size: 3, priceUsd: 5, feePayer: 'c' })], { now });
        expect(buckets[23].byDex.raydium.volumeUsd).toBeCloseTo(35, 6);
    });

    test('a trade outside the window, with no time, or with no venue does not corrupt a bucket', () => {
        const buckets = hourlyBuckets([
            trade({ time: '2026-09-14T10:00:00Z' }),
            trade({ time: null }),
            trade({ dex: null, feePayer: 'x' })
        ], { now });
        expect(buckets.reduce((sum, b) => sum + Object.values(b.byDex).reduce((s, r) => s + r.trades, 0), 0)).toBe(1);
        expect(buckets[23].byDex.unknown.trades).toBe(1);
    });

    test('takes an ISO "now" as readily as a number, and refuses an unusable one', () => {
        expect(hourlyBuckets([], { now: '2026-09-16T21:30:00Z' })[23].hourStart).toBe('2026-09-16T21:00:00Z');
        expect(() => hourlyBuckets([], { now: 'not a time' })).toThrow(/usable "now"/);
    });

    test('hourStartMs floors to the hour', () => {
        expect(hourStartMs(Date.parse('2026-09-16T21:59:59.999Z'))).toBe(Date.parse('2026-09-16T21:00:00Z'));
    });
});

describe('totalsFor', () => {
    test('counts trades, sums priced volume and counts distinct traders', () => {
        const trades = [
            { size: 2, priceUsd: 10, feePayer: 'a' },
            { size: 1, priceUsd: 5, feePayer: 'a' },
            { size: 1, priceUsd: null, feePayer: 'b' }
        ];
        expect(totalsFor(trades, [])).toEqual({ trades: 3, volumeUsd: 25, traders: 2, failedShare: null });
    });

    test('failedShare is the real 6-of-50 share across the sampled pools', () => {
        const pools = [{ signaturesSeen: 50, failedTx: 6 }, { signaturesSeen: 50, failedTx: 44 }];
        expect(totalsFor([], pools).failedShare).toBeCloseTo(0.5, 10);
        expect(totalsFor([], [{ signaturesSeen: 50, failedTx: 6 }]).failedShare).toBeCloseTo(0.12, 10);
    });

    test('a pool whose whole window reverted is a failedShare of 1 and no trades', () => {
        const totals = totalsFor([], [{ signaturesSeen: 30, failedTx: 30 }]);
        expect(totals).toEqual({ trades: 0, volumeUsd: null, traders: 0, failedShare: 1 });
    });

    test('no signatures seen at all is null, not a 0% failure rate', () => {
        expect(totalsFor([], [{ signaturesSeen: 0, failedTx: 0 }]).failedShare).toBeNull();
        expect(totalsFor([], []).failedShare).toBeNull();
    });

    test('tradeVolumeUsd needs both a size and a USD price', () => {
        expect(tradeVolumeUsd({ size: 2, priceUsd: 3 })).toBe(6);
        expect(tradeVolumeUsd({ size: 2, priceUsd: null })).toBeNull();
        expect(tradeVolumeUsd({ size: null, priceUsd: 3 })).toBeNull();
    });
});

describe('mergeTrades', () => {
    const now = Date.parse('2026-09-16T21:30:00Z');
    const at = (iso, sig) => ({ sig, time: iso, dex: 'raydium', size: 1, priceUsd: 1, feePayer: 'a' });

    test('dedupes by signature and reports what changed', () => {
        const existing = [at('2026-09-16T21:00:00Z', 'a'), at('2026-09-16T20:00:00Z', 'b')];
        const incoming = [at('2026-09-16T21:00:00Z', 'a'), at('2026-09-16T21:20:00Z', 'c')];
        const result = mergeTrades(existing, incoming, { now });
        expect(result.trades.map((t) => t.sig)).toEqual(['c', 'a', 'b']);
        expect(result.added).toBe(1);
        expect(result.replaced).toBe(1);
    });

    test('a re-decode replaces the stored trade but keeps its first seenAt', () => {
        const first = mergeTrades([], [at('2026-09-16T21:00:00Z', 'a')], { now, seenAt: '2026-09-16T21:01:00Z' });
        expect(first.trades[0].seenAt).toBe('2026-09-16T21:01:00Z');
        const priced = { ...at('2026-09-16T21:00:00Z', 'a'), priceUsd: 757.1 };
        const second = mergeTrades(first.trades, [priced], { now, seenAt: '2026-09-16T21:20:00Z' });
        expect(second.trades[0].priceUsd).toBe(757.1);
        expect(second.trades[0].seenAt).toBe('2026-09-16T21:01:00Z');
    });

    test('prunes what fell out of the 24 h window and keeps what is still in it', () => {
        // now is 21:30, so the window opens at 21:30 the previous day.
        const result = mergeTrades([
            at('2026-09-15T22:00:00Z', 'edge-in'),
            at('2026-09-15T21:00:00Z', 'just-out'),
            at('2026-09-14T21:00:00Z', 'ancient')
        ], [], { now });
        expect(result.trades.map((t) => t.sig)).toEqual(['edge-in']);
        expect(result.pruned).toBe(2);
    });

    test('a trade the chain gave no blockTime for is held on the collector\'s own seenAt', () => {
        const noTime = { sig: 'x', time: null, dex: 'raydium', size: 1, priceUsd: 1, feePayer: 'a' };
        const kept = mergeTrades([], [noTime], { now, seenAt: '2026-09-16T21:25:00Z' });
        expect(kept.trades).toHaveLength(1);
        expect(kept.trades[0].seenAt).toBe('2026-09-16T21:25:00Z');
        // …and it is dropped once that observation is itself a day old, so it cannot accumulate.
        const later = mergeTrades(kept.trades, [], { now: Date.parse('2026-09-18T00:00:00Z') });
        expect(later.trades).toEqual([]);
        expect(later.pruned).toBe(1);
    });

    test('a trade with no signature cannot be stored', () => {
        expect(mergeTrades([], [{ time: '2026-09-16T21:00:00Z' }], { now }).trades).toEqual([]);
    });

    test('newest first, with unknown times last and ties broken on signature', () => {
        const sorted = sortTradesNewestFirst([
            { sig: 'b', time: '2026-09-16T20:00:00Z' },
            { sig: 'none', time: null },
            { sig: 'a', time: '2026-09-16T20:00:00Z' },
            { sig: 'newest', time: '2026-09-16T21:00:00Z' }
        ]);
        expect(sorted.map((t) => t.sig)).toEqual(['newest', 'a', 'b', 'none']);
    });
});

describe('mergeSeenSignatures', () => {
    const now = Date.parse('2026-09-16T21:30:00Z');

    test('remembers a fetched-but-undecodable signature so the budget is not spent on it twice', () => {
        const kept = mergeSeenSignatures([], [{ sig: 'liquidity-add', pair: PAIR, reason: 'no-pool-delta' }], { now });
        expect(kept).toEqual([{ sig: 'liquidity-add', seenAt: '2026-09-16T21:30:00Z', pair: PAIR, reason: 'no-pool-delta' }]);
        expect(selectSignaturesToFetch([{ sig: 'liquidity-add', pair: PAIR, blockTime: 1789592428 }], { now, budget: 10, known: kept.map((r) => r.sig) })).toEqual([]);
    });

    test('keeps the first sighting and forgets it after the window', () => {
        const first = mergeSeenSignatures([], [{ sig: 's', pair: PAIR }], { now: Date.parse('2026-09-16T10:00:00Z') });
        const again = mergeSeenSignatures(first, [{ sig: 's', pair: PAIR }], { now });
        expect(again[0].seenAt).toBe('2026-09-16T10:00:00Z');
        expect(mergeSeenSignatures(first, [], { now: Date.parse('2026-09-17T11:00:00Z') })).toEqual([]);
    });
});

describe('buildPayload', () => {
    const now = Date.parse('2026-09-16T21:30:00Z');
    const pools = [{ pair: PAIR, mint: SPYX_MINT, symbol: 'SPYx', dex: 'raydium', quoteMint: WSOL_MINT, quoteSymbol: 'SOL', quoteUsdRate: SOL_USD, signaturesSeen: 50, failedTx: 6, decoded: 2, undecodable: 0 }];

    test('publishes the real decoded pair of trades in the documented shape', () => {
        const trades = [decodeTrade(SELL_TX, SPYX_POOL), decodeTrade(BUY_TX, SPYX_POOL)].map((t) => ({ ...t, seenAt: '2026-09-16T21:05:00Z' }));
        const payload = buildPayload({ generatedAt: '2026-09-16T21:30:00Z', collectingSince: '2026-09-16T21:01:00Z', pools, trades, now });

        expect(Object.keys(payload)).toEqual(['generatedAt', 'collectingSince', 'pools', 'trades', 'hourly', 'totals']);
        expect(payload.trades.map((t) => t.sig)).toEqual([SELL_SIG, BUY_SIG]);
        // seenAt is the collector's bookkeeping and must not reach the published record.
        expect(payload.trades[0]).not.toHaveProperty('seenAt');
        expect(payload.hourly).toHaveLength(24);
        expect(payload.hourly[23].byDex.raydium).toEqual({ trades: 2, volumeUsd: expect.closeTo(109.05, 1), buys: 1, sells: 1, traders: 2 });
        expect(payload.totals.trades).toBe(2);
        expect(payload.totals.traders).toBe(2);
        expect(payload.totals.failedShare).toBeCloseTo(0.12, 10);
        expect(payload.totals.volumeUsd).toBeCloseTo(109.05, 1);
    });

    test('a run that decoded nothing still publishes the window and the failed share', () => {
        const payload = buildPayload({ generatedAt: '2026-09-16T21:30:00Z', collectingSince: '2026-09-16T21:01:00Z', pools: [{ pair: PAIR, signaturesSeen: 30, failedTx: 30, decoded: 0, undecodable: 0 }], trades: [], now });
        expect(payload.trades).toEqual([]);
        expect(payload.hourly).toHaveLength(24);
        expect(payload.hourly.every((b) => Object.keys(b.byDex).length === 0)).toBe(true);
        expect(payload.totals).toEqual({ trades: 0, volumeUsd: null, traders: 0, failedShare: 1 });
    });

    test('refuses to build without an instant to anchor the window to', () => {
        expect(() => buildPayload({ generatedAt: null, now: null })).toThrow(/needs `now`/);
    });
});
