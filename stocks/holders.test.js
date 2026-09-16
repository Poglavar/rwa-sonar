// Unit tests for the pure holder helpers (lib/holders.mjs). Every fixture is a verbatim copy of a
// real mainnet response read on 2026-09-16 through the Alchemy RPC: getTokenLargestAccounts for
// AAPLx (a scaled-UI Token-2022 mint, so the uiAmount/raw divergence is real), FWDI (Superstate,
// whose top 20 really does contain nine frozen zero-balance allowlist accounts) and HSDT (supply
// 0), plus the matching getMultipleAccounts jsonParsed accounts. Supplies and authorities are the
// values in data/onchain.json, so a change in the share math shows up as a mismatch against real
// numbers rather than an invented one.

const {
    finiteOrNull,
    stringOrNull,
    rawAmountOrNull,
    rawToUi,
    sharePct,
    sumOrNull,
    median,
    KNOWN_OWNERS,
    ISSUER_AUTHORITY,
    BURN_ADDRESS,
    ONCHAIN_AUTHORITY_FIELDS,
    mintSupplyInfo,
    mintAuthorityAddresses,
    buildOwnerLabels,
    labelOwner,
    tokenAccountInfo,
    shapeHolder,
    dedupeOwners,
    distinctOwnerCount,
    cumulativeSharePct,
    summariseMint
} = require('./lib/holders.mjs');

// --- Fixtures ---------------------------------------------------------------------------------

const AAPLX_MINT = 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp';
// data/onchain.json: decimals 8, supply "15376345272578", scaledUiAmountMultiplier 1.0026642075893797.
const AAPLX_DECIMALS = 8;
const AAPLX_SUPPLY = '15376345272578';
const AAPLX_MINT_AUTHORITY = '7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj';
const AAPLX_FREEZE_AUTHORITY = 'JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs';

// getTokenLargestAccounts(AAPLx) → value[0..2]. Note uiAmount 114435.13612376 against a raw
// 11406226514867/1e8 = 114062.26514867: the RPC applied the mint's ×1.0027 scaled-UI multiplier to
// uiAmount and not to `supply`, which is exactly the trap rawToUi() exists to avoid.
const AAPLX_LARGEST = [
    { address: 'G9y5mkpBgFvqEpTXduZWohxt4A8UTB8tbm6beGJUQ37A', amount: '11406226514867', decimals: 8, uiAmount: 114435.13612376, uiAmountString: '114435.13612376' },
    { address: '6Q4FvChjxaMtmEdCZjCSVa3rRmVhCdDkNG3dPTFH1Tzy', amount: '674902740397', decimals: 8, uiAmount: 6771.09005918, uiAmountString: '6771.09005918' },
    { address: 'GW4cuCxabGutpfLf445fTNaFXTqmgqMF83ReEgGsXzCK', amount: '656043105189', decimals: 8, uiAmount: 6581.87718326, uiAmountString: '6581.87718326' }
];

/** getMultipleAccounts([...], {encoding:'jsonParsed'}) → one value entry, trimmed of rentEpoch. */
function tokenAccount({ mint, owner, amount, decimals, state = 'initialized', program = 'spl-token-2022', extensions = [{ extension: 'immutableOwner' }] }) {
    return {
        data: {
            parsed: {
                info: {
                    extensions,
                    isNative: false,
                    mint,
                    owner,
                    state,
                    tokenAmount: { amount, decimals, uiAmount: Number(amount) / 10 ** decimals, uiAmountString: String(Number(amount) / 10 ** decimals) }
                },
                type: 'account'
            },
            program,
            space: 179
        },
        executable: false,
        lamports: 2136720,
        owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
        space: 179
    };
}

/** address → tokenAccountInfo() record, which is what shapeHolder/summariseMint consume. */
function infoMap(accounts) {
    return Object.fromEntries(Object.entries(accounts).map(([address, account]) => [address, tokenAccountInfo(account)]));
}

const AAPLX_ACCOUNTS = {
    G9y5mkpBgFvqEpTXduZWohxt4A8UTB8tbm6beGJUQ37A: tokenAccount({ mint: AAPLX_MINT, owner: 'S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS', amount: '11406226514867', decimals: 8 }),
    '6Q4FvChjxaMtmEdCZjCSVa3rRmVhCdDkNG3dPTFH1Tzy': tokenAccount({ mint: AAPLX_MINT, owner: '6LY1JzAFVZsP2a2xKrtU6znQMQ5h4i7tocWdgrkZzkzF', amount: '674902740397', decimals: 8 }),
    GW4cuCxabGutpfLf445fTNaFXTqmgqMF83ReEgGsXzCK: tokenAccount({ mint: AAPLX_MINT, owner: '6LY1JzAFVZsP2a2xKrtU6znQMQ5h4i7tocWdgrkZzkzF', amount: '656043105189', decimals: 8 })
};

const FWDI_MINT = '7GzQgf6DPo6ZANjnbhe9tNCpkGTv3zqHbsDx74jyQf9';
const FWDI_DECIMALS = 6;
const FWDI_SUPPLY = '7280819100000';
const FWDI_MINT_AUTHORITY = 'CWdsNnEuCYzxBjjd9dxvhYuatVHY2cGsMNNJcKsGFSqq';
// Shared by all four Opening Bell mints (data/onchain.json).
const SUPERSTATE_FREEZE_AUTHORITY = '2Yq4T3mPNfjtEyTxSbRjRKqLf1pwbTasuCQrWe6QpM7x';
const SUPERSTATE_BURN_ADDRESS = '2u8YwJTykTreziHBN5QwE7Bi2SyN8M2MicCscthtph9E';

const FWDI_LARGEST = [
    { address: '9bZ61DRTFySyDSM7fEUBzuDm8qxJGvGAjVkGM87r9ynR', amount: '3513514000000', decimals: 6, uiAmount: 3513514, uiAmountString: '3513514' },
    { address: 'GrSCwqkgxFsrhL61ogj7FjLXiMPYCzWK4kKdBGz4PN3h', amount: '3156493100000', decimals: 6, uiAmount: 3156493.1, uiAmountString: '3156493.1' },
    { address: '6bMtnfcAYnfeAw5LtjapRHHz4TjPxL39A5p1soixHKHx', amount: '600000000000', decimals: 6, uiAmount: 600000, uiAmountString: '600000' },
    // A real frozen allowlist account from the same top 20 — zero balance, state "frozen".
    { address: 'JDn5ctsQjWMwuovbYdV4zEX3ba1S6SYTy5y7RMp9ifGe', amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' }
];

const FWDI_ACCOUNTS = {
    '9bZ61DRTFySyDSM7fEUBzuDm8qxJGvGAjVkGM87r9ynR': tokenAccount({ mint: FWDI_MINT, owner: 'ANpjxEhcDLJH6EQ3HYwhbL37qfsUSRC4kWwAb7cYooAg', amount: '3513514000000', decimals: 6 }),
    GrSCwqkgxFsrhL61ogj7FjLXiMPYCzWK4kKdBGz4PN3h: tokenAccount({ mint: FWDI_MINT, owner: '8ULQxXHkM46CbAFLerRRaRBwtqC6M9bCMvxvTB4EUgX9', amount: '3156493100000', decimals: 6 }),
    '6bMtnfcAYnfeAw5LtjapRHHz4TjPxL39A5p1soixHKHx': tokenAccount({ mint: FWDI_MINT, owner: '3EobZcvPCheGcvX4fXxAviRpaDdJEbcCJvUxgWZZjwZn', amount: '600000000000', decimals: 6 }),
    JDn5ctsQjWMwuovbYdV4zEX3ba1S6SYTy5y7RMp9ifGe: tokenAccount({ mint: FWDI_MINT, owner: 'pcF1AxgrCjw6X37jApdUBbL5hfrFJNBqVX2jbkLEjg9', amount: '0', decimals: 6, state: 'frozen' })
};

// HSDT: supply "0" on chain, yet getTokenLargestAccounts still answers with 20 allowlist accounts,
// all amount "0". This is the mint that makes "missing/zero supply → null share" load-bearing.
const HSDT_MINT = '8UBqBGXM4NF22y5TZs8PhNVwVNqsHw2jBstfcxsSZaQ4';
const HSDT_LARGEST = [
    { address: 'J1oWPqa5oRZaUsL3efiSJhv6SuHeFVTV6NZZmRRinT8n', amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' },
    { address: 'HFpMeBdGUHE4tR6Co4tpc1GEb2EuG2aXg83hSArh6yzD', amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' },
    { address: 'H8VR3uhpYuy9nWwsYgvakskXwAeKAHrRpraK6RJEMQXC', amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' }
];

// IBITon (Ondo, decimals 9): its top 20 ARE the whole supply — Σ of these 19 raw amounts is
// exactly `supply`, which is what makes it the fixture for the "exactly 100%" case.
const IBITON_SUPPLY = '25922414576';
const IBITON_RAWS = [
    '17032136715', '4501223102', '2841407437', '508519250', '429349516', '276837742', '205801742',
    '125944521', '872724', '321827', '0', '0', '0', '0', '0', '0', '0', '0', '0'
];

const ONCHAIN_ITEMS = [
    { mint: AAPLX_MINT, symbol: 'AAPLx', mintAuthority: AAPLX_MINT_AUTHORITY, freezeAuthority: AAPLX_FREEZE_AUTHORITY },
    { mint: FWDI_MINT, symbol: 'FWDI', mintAuthority: FWDI_MINT_AUTHORITY, freezeAuthority: SUPERSTATE_FREEZE_AUTHORITY },
    { mint: HSDT_MINT, symbol: 'HSDT', mintAuthority: '7cowcPXxq3dfEKwg2MHmxkneKSNkzKuma8WZTaaZbwh6', freezeAuthority: SUPERSTATE_FREEZE_AUTHORITY },
    // A legacy SPL mint with no authorities at all — both null, which must not become a label.
    { mint: 'Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg', symbol: 'AMZNx', mintAuthority: null, freezeAuthority: null }
];

// The xStocks key that holds the biggest position in every xStock. It is the AAPLx mint's
// scaledUiAmountConfig authority (all 156 xStocks mints share it) — a Token-2022 EXTENSION
// authority, so data/onchain.json, which flattens the extensions to flags plus two authority
// addresses, carries it in no field. It is also Jupiter's `dev` on all 156 universe.json records.
const XSTOCKS_SCALED_UI_AUTHORITY = 'S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS';
const XSTOCKS_DELEGATE = '5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq';

/**
 * getMultipleAccounts([AAPLX_MINT], {encoding:'jsonParsed'}) → value[0], verbatim from
 * data/raw/mints-parsed-2026-09-16.json (rentEpoch dropped). This is the account the SUPPLY
 * denominator and the extension authorities are both read off.
 */
const AAPLX_MINT_ACCOUNT = {
    data: {
        parsed: {
            info: {
                decimals: 8,
                extensions: [
                    { extension: 'metadataPointer', state: { authority: XSTOCKS_DELEGATE, metadataAddress: AAPLX_MINT } },
                    { extension: 'permanentDelegate', state: { delegate: XSTOCKS_DELEGATE } },
                    { extension: 'defaultAccountState', state: { accountState: 'initialized' } },
                    { extension: 'scaledUiAmountConfig', state: { authority: XSTOCKS_SCALED_UI_AUTHORITY, multiplier: '1.0026642075893797', newMultiplier: '1.0032690125398187', newMultiplierEffectiveTimestamp: 1786149000 } },
                    { extension: 'pausableConfig', state: { authority: AAPLX_FREEZE_AUTHORITY, paused: false } },
                    { extension: 'confidentialTransferMint', state: { auditorElgamalPubkey: null, authority: XSTOCKS_DELEGATE, autoApproveNewAccounts: false } },
                    { extension: 'transferHook', state: { authority: XSTOCKS_DELEGATE, programId: null } },
                    { extension: 'tokenMetadata', state: { additionalMetadata: [], mint: AAPLX_MINT, name: 'Apple xStock', symbol: 'AAPLx', updateAuthority: XSTOCKS_DELEGATE, uri: 'https://xstocks-metadata.backed.fi/tokens/Solana/AAPLx/metadata.json' } }
                ],
                freezeAuthority: AAPLX_FREEZE_AUTHORITY,
                isInitialized: true,
                mintAuthority: AAPLX_MINT_AUTHORITY,
                supply: AAPLX_SUPPLY
            },
            type: 'mint'
        },
        program: 'spl-token-2022',
        space: 678
    },
    executable: false,
    lamports: 647086478,
    owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    space: 678
};

/** The same shape with the fields under test varied — for the missing/malformed supply cases. */
function mintAccount({ supply, decimals, mintAuthority = AAPLX_MINT_AUTHORITY, freezeAuthority = AAPLX_FREEZE_AUTHORITY, extensions = [] }) {
    return {
        data: {
            parsed: { info: { decimals, extensions, freezeAuthority, isInitialized: true, mintAuthority, supply }, type: 'mint' },
            program: 'spl-token-2022',
            space: 678
        },
        owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
    };
}

// --- Numeric guards --------------------------------------------------------------------------

describe('finiteOrNull / stringOrNull / sumOrNull', () => {
    test('never turns a missing value into 0', () => {
        expect(finiteOrNull(null)).toBeNull();
        expect(finiteOrNull(undefined)).toBeNull();
        expect(finiteOrNull('')).toBeNull();
        expect(finiteOrNull('abc')).toBeNull();
        expect(finiteOrNull(NaN)).toBeNull();
        expect(finiteOrNull(Infinity)).toBeNull();
        expect(finiteOrNull(0)).toBe(0);
        expect(finiteOrNull('114062.26514867')).toBeCloseTo(114062.26514867, 8);
    });

    test('stringOrNull rejects blanks', () => {
        expect(stringOrNull('  ')).toBeNull();
        expect(stringOrNull(null)).toBeNull();
        expect(stringOrNull(AAPLX_MINT)).toBe(AAPLX_MINT);
    });

    test('sumOrNull stays null when nothing is summable', () => {
        expect(sumOrNull([null, undefined, 'x'])).toBeNull();
        expect(sumOrNull([])).toBeNull();
        expect(sumOrNull([null, 2, null, 3])).toBe(5);
        expect(sumOrNull([0])).toBe(0);
    });

    test('median of the real per-issuer shares, and null for nothing', () => {
        expect(median([])).toBeNull();
        expect(median([null, 'x'])).toBeNull();
        expect(median([99.9, 98.4, 56.2])).toBeCloseTo(98.4, 10);
        expect(median([1, 2, 3, 4])).toBe(2.5);
    });
});

describe('rawAmountOrNull', () => {
    test('parses the RPC decimal strings exactly, beyond 2^53', () => {
        expect(rawAmountOrNull('15376345272578')).toBe(15376345272578n);
        // 18 digits: Number() would round this, BigInt does not.
        expect(rawAmountOrNull('123456789012345678')).toBe(123456789012345678n);
        expect(rawAmountOrNull('0')).toBe(0n);
    });

    test('a missing or malformed amount is null, not 0', () => {
        expect(rawAmountOrNull(null)).toBeNull();
        expect(rawAmountOrNull(undefined)).toBeNull();
        expect(rawAmountOrNull('')).toBeNull();
        expect(rawAmountOrNull('12.5')).toBeNull();
        expect(rawAmountOrNull('-5')).toBeNull();
        expect(rawAmountOrNull('1e9')).toBeNull();
    });
});

describe('rawToUi', () => {
    test('uses raw/10^decimals, NOT the RPC uiAmount (which carries the scaled-UI multiplier)', () => {
        const ui = rawToUi(AAPLX_LARGEST[0].amount, AAPLX_DECIMALS);
        expect(ui).toBeCloseTo(114062.26514867, 8);
        // The RPC's own uiAmount is ×1.00327 bigger. Asserting the DIFFERENCE is the point: if a
        // later edit ever switched to uiAmount, this goes red. The ratio is also NOT the
        // 1.0026642075893797 recorded in data/onchain.json a few hours earlier — the multiplier
        // accrues, so uiAmount is not even stable across snapshots, while raw/raw always is.
        expect(AAPLX_LARGEST[0].uiAmount / ui).toBeCloseTo(1.003269012539809, 10);
    });

    test('supply and amount come out in the same unit', () => {
        expect(rawToUi(AAPLX_SUPPLY, AAPLX_DECIMALS)).toBeCloseTo(153763.45272578, 8);
        expect(rawToUi(FWDI_SUPPLY, FWDI_DECIMALS)).toBeCloseTo(7280819.1, 6);
    });

    test('null in, null out — including a missing decimals', () => {
        expect(rawToUi(null, 8)).toBeNull();
        expect(rawToUi('11406226514867', null)).toBeNull();
        expect(rawToUi('11406226514867', undefined)).toBeNull();
        expect(rawToUi('11406226514867', 8.5)).toBeNull();
        expect(rawToUi('0', 6)).toBe(0);
    });
});

// --- The share math, and the zero/missing-supply case -----------------------------------------

describe('sharePct', () => {
    test('AAPLx top account holds 74.18% of supply, computed raw/raw', () => {
        // 11406226514867 / 15376345272578 × 100
        expect(sharePct(AAPLX_LARGEST[0].amount, AAPLX_SUPPLY)).toBeCloseTo(74.18034853, 6);
        expect(sharePct(AAPLX_LARGEST[1].amount, AAPLX_SUPPLY)).toBeCloseTo(4.38923, 4);
    });

    test('FWDI: the top two accounts are 48.26% and 43.35%', () => {
        expect(sharePct(FWDI_LARGEST[0].amount, FWDI_SUPPLY)).toBeCloseTo(48.2571, 3);
        expect(sharePct(FWDI_LARGEST[1].amount, FWDI_SUPPLY)).toBeCloseTo(43.3535, 3);
    });

    // THE red test: a missing or zero supply must produce null, never 0 and never Infinity.
    // Treating it as 0 either divides by zero (Infinity, which JSON.stringify writes as null but
    // which poisons every sum on the way there) or reports a 0% share for an account that in fact
    // holds every token that exists. HSDT is the real mint this happens on: supply "0", 20 live
    // allowlist accounts.
    test('a missing supply yields null shares, never 0', () => {
        expect(sharePct('11406226514867', null)).toBeNull();
        expect(sharePct('11406226514867', undefined)).toBeNull();
        expect(sharePct('11406226514867', '')).toBeNull();
        expect(sharePct('11406226514867', 'n/a')).toBeNull();
    });

    test('a ZERO supply yields null shares, never 0 and never Infinity (HSDT)', () => {
        expect(sharePct('0', '0')).toBeNull();
        expect(sharePct('1000', '0')).toBeNull();
        expect(sharePct('1000', 0)).toBeNull();
    });

    test('a missing amount yields null, and a real zero amount yields a real 0', () => {
        expect(sharePct(null, AAPLX_SUPPLY)).toBeNull();
        expect(sharePct('0', AAPLX_SUPPLY)).toBe(0);
    });
});

describe('cumulativeSharePct', () => {
    // The three real AAPLx raw amounts, biggest-first.
    const raws = AAPLX_LARGEST.map((entry) => entry.amount);

    test('Σraw / supply over the biggest-first entries', () => {
        expect(cumulativeSharePct(raws, AAPLX_SUPPLY, 1)).toBeCloseTo(74.18034853320272, 8);
        expect(cumulativeSharePct(raws, AAPLX_SUPPLY, 5)).toBeCloseTo(82.83614951836655, 8);
        expect(cumulativeSharePct(raws, AAPLX_SUPPLY, 20)).toBeCloseTo(82.83614951836655, 8);
    });

    // THE red test for the >100% class: 39 of the 441 mints are held entirely by their top 20, and
    // summing the per-account quotients gave them 100.00000000000001 — a share above 100% that no
    // denominator could fix. Σraw is exact, so a fully-held mint is exactly 100.
    test('a fully-held mint is EXACTLY 100, not 100.00000000000001', () => {
        // IBITon, verbatim: its 19 token accounts hold Σ = 25922414576 = the whole supply, and it
        // is one of the 39 that read 100.00000000000001 in the 2026-09-16 holders.json.
        expect(IBITON_RAWS.reduce((a, b) => a + BigInt(b), 0n).toString()).toBe(IBITON_SUPPLY);
        expect(cumulativeSharePct(IBITON_RAWS, IBITON_SUPPLY, 20)).toBe(100);
        // What the old sum-of-quotients did on the same numbers, for the record.
        expect(sumOrNull(IBITON_RAWS.map((raw) => sharePct(raw, IBITON_SUPPLY)))).toBeGreaterThan(100);
    });

    test('no amount, no supply or a zero supply stays null rather than summing to 0', () => {
        expect(cumulativeSharePct([null, undefined], AAPLX_SUPPLY, 20)).toBeNull();
        expect(cumulativeSharePct([], AAPLX_SUPPLY, 20)).toBeNull();
        expect(cumulativeSharePct(null, AAPLX_SUPPLY, 20)).toBeNull();
        expect(cumulativeSharePct(raws, null, 20)).toBeNull();
        expect(cumulativeSharePct(raws, '0', 20)).toBeNull();
    });
});

// --- The live supply denominator --------------------------------------------------------------

describe('mintSupplyInfo', () => {
    test('reads supply and decimals off a real jsonParsed mint account', () => {
        expect(mintSupplyInfo(AAPLX_MINT_ACCOUNT)).toEqual({ supply: '15376345272578', decimals: 8 });
    });

    test('supply stays a STRING, because it can exceed 2^53', () => {
        const { supply } = mintSupplyInfo(AAPLX_MINT_ACCOUNT);
        expect(typeof supply).toBe('string');
        // A 9-decimal mint with 20 M tokens: 2.0e16, past Number.MAX_SAFE_INTEGER (9.007e15). Read
        // as a float the denominator would round and every share against it would be wrong.
        const big = '20000000000000001';
        expect(String(Number(big))).toBe('20000000000000000');
        expect(rawAmountOrNull(big)).toBe(20000000000000001n);
        expect(mintSupplyInfo(mintAccount({ supply: big, decimals: 9 })).supply).toBe(big);
    });

    test('a token account is NOT a mint — null, never a supply figure', () => {
        expect(mintSupplyInfo(AAPLX_ACCOUNTS[AAPLX_LARGEST[0].address])).toBeNull();
        expect(mintSupplyInfo(tokenAccount({ mint: AAPLX_MINT, owner: XSTOCKS_DELEGATE, amount: '1', decimals: 8 }))).toBeNull();
    });

    test('a null / unparsed / empty account is null', () => {
        expect(mintSupplyInfo(null)).toBeNull();
        expect(mintSupplyInfo(undefined)).toBeNull();
        expect(mintSupplyInfo({})).toBeNull();
        expect(mintSupplyInfo({ data: ['O3Xk9MZV0Zk=', 'base64'] })).toBeNull();
        expect(mintSupplyInfo({ data: { parsed: { type: 'mint' }, program: 'spl-token-2022' } })).toBeNull();
    });

    test('a real supply 0 is "0", while a missing/malformed one stays null (never 0)', () => {
        expect(mintSupplyInfo(mintAccount({ supply: '0', decimals: 6 }))).toEqual({ supply: '0', decimals: 6 });
        expect(mintSupplyInfo(mintAccount({ supply: undefined, decimals: 6 })).supply).toBeNull();
        expect(mintSupplyInfo(mintAccount({ supply: '12.5', decimals: 6 })).supply).toBeNull();
        expect(mintSupplyInfo(mintAccount({ supply: AAPLX_SUPPLY, decimals: null })).decimals).toBeNull();
        expect(mintSupplyInfo(mintAccount({ supply: AAPLX_SUPPLY, decimals: 8.5 })).decimals).toBeNull();
    });

    test('a null supply makes every share against it null, not 0', () => {
        const { supply, decimals } = mintSupplyInfo(mintAccount({ supply: null, decimals: 8 }));
        expect(sharePct(AAPLX_LARGEST[0].amount, supply)).toBeNull();
        expect(rawToUi(supply, decimals)).toBeNull();
    });
});

describe('mintAuthorityAddresses', () => {
    test('collects the mint/freeze authorities AND every extension authority', () => {
        expect(mintAuthorityAddresses(AAPLX_MINT_ACCOUNT).sort()).toEqual([
            XSTOCKS_DELEGATE,            // metadataPointer + permanentDelegate + hook + metadata
            AAPLX_MINT_AUTHORITY,
            AAPLX_FREEZE_AUTHORITY,      // also the pausableConfig authority
            XSTOCKS_SCALED_UI_AUTHORITY
        ].sort());
    });

    test('a program id is not an authority, and duplicates collapse', () => {
        const addresses = mintAuthorityAddresses(AAPLX_MINT_ACCOUNT);
        expect(new Set(addresses).size).toBe(addresses.length);
        expect(addresses).not.toContain('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
    });

    test('a legacy mint with no authorities and no extensions yields nothing', () => {
        expect(mintAuthorityAddresses(mintAccount({ supply: '1', decimals: 6, mintAuthority: null, freezeAuthority: null, extensions: undefined }))).toEqual([]);
    });

    test('a token account, a null account and junk yield nothing', () => {
        expect(mintAuthorityAddresses(AAPLX_ACCOUNTS[AAPLX_LARGEST[0].address])).toEqual([]);
        expect(mintAuthorityAddresses(null)).toEqual([]);
        expect(mintAuthorityAddresses({ data: { parsed: { type: 'mint', info: { extensions: 'nope' } } } })).toEqual([]);
    });
});

// --- Owner labelling -------------------------------------------------------------------------

describe('buildOwnerLabels / labelOwner', () => {
    const labels = buildOwnerLabels(ONCHAIN_ITEMS);

    test('the static map holds only the cited Superstate burn address', () => {
        expect(Object.keys(KNOWN_OWNERS)).toEqual([SUPERSTATE_BURN_ADDRESS]);
        expect(KNOWN_OWNERS[SUPERSTATE_BURN_ADDRESS]).toBe(BURN_ADDRESS);
        expect(labelOwner(SUPERSTATE_BURN_ADDRESS, labels)).toBe(BURN_ADDRESS);
    });

    test('mint and freeze authorities from onchain.json become issuer-authority', () => {
        expect(labelOwner(AAPLX_MINT_AUTHORITY, labels)).toBe(ISSUER_AUTHORITY);
        expect(labelOwner(AAPLX_FREEZE_AUTHORITY, labels)).toBe(ISSUER_AUTHORITY);
        expect(labelOwner(FWDI_MINT_AUTHORITY, labels)).toBe(ISSUER_AUTHORITY);
        // Shared across all four Opening Bell mints — one entry, not four.
        expect(labelOwner(SUPERSTATE_FREEZE_AUTHORITY, labels)).toBe(ISSUER_AUTHORITY);
    });

    test('an unknown wallet stays unlabeled — no guessing', () => {
        expect(labelOwner(null, labels)).toBeNull();
        expect(labelOwner('', labels)).toBeNull();
        expect(labelOwner('ANpjxEhcDLJH6EQ3HYwhbL37qfsUSRC4kWwAb7cYooAg', labels)).toBeNull();
        // onchain.json ALONE cannot name the xStocks scaled-UI authority: the file keeps the
        // extension flags, not their authority keys. That is the gap the live mint accounts close.
        expect(labelOwner(XSTOCKS_SCALED_UI_AUTHORITY, labels)).toBeNull();
    });

    test('the other authority ADDRESS fields of an onchain record also label', () => {
        // The two onchain.json fields besides mint/freeze that hold a key, on a record that has
        // NOTHING else — so the label can only have come from them.
        const extensionOnly = buildOwnerLabels([{
            mint: AAPLX_MINT,
            permanentDelegateAddress: XSTOCKS_DELEGATE,
            metadataUpdateAuthority: XSTOCKS_DELEGATE,
            mintAuthority: null,
            freezeAuthority: null
        }]);
        expect(labelOwner(XSTOCKS_DELEGATE, extensionOnly)).toBe(ISSUER_AUTHORITY);
        expect(ONCHAIN_AUTHORITY_FIELDS).toEqual(['mintAuthority', 'freezeAuthority', 'permanentDelegateAddress', 'metadataUpdateAuthority']);
        // A boolean flag is not an address and must not become a label.
        expect(buildOwnerLabels([{ permanentDelegate: true, pausable: true }]).size).toBe(1);
    });

    test('a Token-2022 EXTENSION authority off the live mint account labels S7vYFF…', () => {
        // This is the real defect: S7vYFF… is the largest holder of every xStock and was
        // unlabelled, because it lives only in the mint's scaledUiAmountConfig extension.
        const withLive = buildOwnerLabels(ONCHAIN_ITEMS, mintAuthorityAddresses(AAPLX_MINT_ACCOUNT));
        expect(labelOwner(XSTOCKS_SCALED_UI_AUTHORITY, withLive)).toBe(ISSUER_AUTHORITY);
        expect(labelOwner(XSTOCKS_DELEGATE, withLive)).toBe(ISSUER_AUTHORITY);
        // ... and it reaches the holder record, which is where it is actually read.
        const record = shapeHolder(AAPLX_LARGEST[0], tokenAccountInfo(AAPLX_ACCOUNTS[AAPLX_LARGEST[0].address]), {
            rawSupply: AAPLX_SUPPLY, decimals: AAPLX_DECIMALS, mint: AAPLX_MINT, labels: withLive
        }).record;
        expect(record.owner).toBe(XSTOCKS_SCALED_UI_AUTHORITY);
        expect(record.ownerLabel).toBe(ISSUER_AUTHORITY);
    });

    test('the burn address still wins over an authority label for the same key', () => {
        const both = buildOwnerLabels([{ mintAuthority: SUPERSTATE_BURN_ADDRESS }], [SUPERSTATE_BURN_ADDRESS]);
        expect(labelOwner(SUPERSTATE_BURN_ADDRESS, both)).toBe(BURN_ADDRESS);
    });

    test('a malformed extraAuthorities list is ignored, not crashed on', () => {
        expect(buildOwnerLabels(ONCHAIN_ITEMS, null).size).toBe(6);
        expect(buildOwnerLabels(ONCHAIN_ITEMS, [null, '', 42]).size).toBe(6);
    });

    test('null authorities do not become labels', () => {
        expect(labels.has('null')).toBe(false);
        expect(labelOwner(null, labels)).toBeNull();
        // AAPLx + FWDI + HSDT authorities = 5 distinct keys (Superstate freeze is shared), + burn.
        expect(labels.size).toBe(6);
    });

    test('an empty or malformed onchain list still yields the static map', () => {
        expect(buildOwnerLabels(null).get(SUPERSTATE_BURN_ADDRESS)).toBe(BURN_ADDRESS);
        expect(buildOwnerLabels([null, {}, { mintAuthority: 42 }]).size).toBe(1);
    });
});

// --- Unwrapping the RPC account --------------------------------------------------------------

describe('tokenAccountInfo', () => {
    test('pulls owner, state, mint and program out of a real jsonParsed account', () => {
        expect(tokenAccountInfo(AAPLX_ACCOUNTS[AAPLX_LARGEST[0].address])).toEqual({
            owner: 'S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS',
            state: 'initialized',
            mint: AAPLX_MINT,
            program: 'spl-token-2022'
        });
        expect(tokenAccountInfo(FWDI_ACCOUNTS[FWDI_LARGEST[3].address]).state).toBe('frozen');
    });

    test('a closed account (RPC answers null) is null, not an empty holder', () => {
        expect(tokenAccountInfo(null)).toBeNull();
        expect(tokenAccountInfo(undefined)).toBeNull();
    });

    test('an unparsed base64 account is null rather than a holder with no owner', () => {
        // getMultipleAccounts falls back to ["<base64>","base64"] when it cannot parse the program.
        const base64Account = { data: ['O3Xk9MZV0Zk=', 'base64'], executable: false, lamports: 2136720, owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', space: 179 };
        expect(tokenAccountInfo(base64Account)).toBeNull();
    });

    test('a parsed account that is not a token account is refused', () => {
        const mintAccount = { data: { parsed: { type: 'mint', info: { decimals: 8, supply: AAPLX_SUPPLY } }, program: 'spl-token-2022', space: 648 } };
        expect(tokenAccountInfo(mintAccount)).toBeNull();
    });

    test('missing fields stay null instead of becoming empty strings', () => {
        const partial = { data: { parsed: { type: 'account', info: { mint: AAPLX_MINT } }, program: 'spl-token-2022' } };
        expect(tokenAccountInfo(partial)).toEqual({ owner: null, state: null, mint: AAPLX_MINT, program: 'spl-token-2022' });
    });
});

// --- Shaping one holder ----------------------------------------------------------------------

describe('shapeHolder', () => {
    const labels = buildOwnerLabels(ONCHAIN_ITEMS);

    test('joins the largest-accounts entry to its jsonParsed owner and state', () => {
        const out = shapeHolder(AAPLX_LARGEST[0], tokenAccountInfo(AAPLX_ACCOUNTS[AAPLX_LARGEST[0].address]), {
            rawSupply: AAPLX_SUPPLY, decimals: AAPLX_DECIMALS, mint: AAPLX_MINT, labels
        });
        expect(out.record).toEqual({
            tokenAccount: 'G9y5mkpBgFvqEpTXduZWohxt4A8UTB8tbm6beGJUQ37A',
            owner: 'S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS',
            amountUi: 114062.26514867,
            sharePct: 74.18034853320272,
            state: 'initialized',
            ownerLabel: null
        });
        expect(out.resolved).toBe(true);
        expect(out.mintMismatch).toBe(false);
        expect(out.decimalsMismatch).toBe(false);
        expect(out.raw).toBe(11406226514867n);
    });

    test('carries a real frozen state through (FWDI allowlist account)', () => {
        const out = shapeHolder(FWDI_LARGEST[3], tokenAccountInfo(FWDI_ACCOUNTS[FWDI_LARGEST[3].address]), {
            rawSupply: FWDI_SUPPLY, decimals: FWDI_DECIMALS, mint: FWDI_MINT, labels
        });
        expect(out.record.state).toBe('frozen');
        expect(out.record.amountUi).toBe(0);
        expect(out.record.sharePct).toBe(0);
    });

    test('an unresolved account leaves owner and state null instead of guessing', () => {
        const out = shapeHolder(AAPLX_LARGEST[1], null, { rawSupply: AAPLX_SUPPLY, decimals: AAPLX_DECIMALS, mint: AAPLX_MINT, labels });
        expect(out.record.owner).toBeNull();
        expect(out.record.state).toBeNull();
        expect(out.record.ownerLabel).toBeNull();
        // The balance is still known — it came from getTokenLargestAccounts, not the account read.
        expect(out.record.amountUi).toBeCloseTo(6749.02740397, 8);
        expect(out.record.sharePct).toBeCloseTo(4.38923, 4);
        expect(out.resolved).toBe(false);
    });

    test('an account for a DIFFERENT mint is refused, not attributed', () => {
        const wrong = tokenAccountInfo(tokenAccount({ mint: FWDI_MINT, owner: 'ANpjxEhcDLJH6EQ3HYwhbL37qfsUSRC4kWwAb7cYooAg', amount: '3513514000000', decimals: 6 }));
        const out = shapeHolder(AAPLX_LARGEST[0], wrong, { rawSupply: AAPLX_SUPPLY, decimals: AAPLX_DECIMALS, mint: AAPLX_MINT, labels });
        expect(out.mintMismatch).toBe(true);
        expect(out.record.owner).toBeNull();
        expect(out.record.state).toBeNull();
    });

    test('labels an owner that is an issuer authority or the burn address', () => {
        const authAccount = tokenAccountInfo(tokenAccount({ mint: FWDI_MINT, owner: FWDI_MINT_AUTHORITY, amount: '600000000000', decimals: 6 }));
        const burnAccount = tokenAccountInfo(tokenAccount({ mint: FWDI_MINT, owner: SUPERSTATE_BURN_ADDRESS, amount: '600000000000', decimals: 6 }));
        const entry = FWDI_LARGEST[2];
        expect(shapeHolder(entry, authAccount, { rawSupply: FWDI_SUPPLY, decimals: FWDI_DECIMALS, mint: FWDI_MINT, labels }).record.ownerLabel).toBe(ISSUER_AUTHORITY);
        expect(shapeHolder(entry, burnAccount, { rawSupply: FWDI_SUPPLY, decimals: FWDI_DECIMALS, mint: FWDI_MINT, labels }).record.ownerLabel).toBe(BURN_ADDRESS);
    });

    test('reports a decimals disagreement rather than averaging over it', () => {
        const out = shapeHolder({ ...AAPLX_LARGEST[0], decimals: 6 }, tokenAccountInfo(AAPLX_ACCOUNTS[AAPLX_LARGEST[0].address]), {
            rawSupply: AAPLX_SUPPLY, decimals: AAPLX_DECIMALS, mint: AAPLX_MINT, labels
        });
        expect(out.decimalsMismatch).toBe(true);
        // The mint's decimals win, so amountUi stays comparable to supplyUi.
        expect(out.record.amountUi).toBeCloseTo(114062.26514867, 8);
    });

    test('an entry with no address is dropped', () => {
        expect(shapeHolder({ amount: '1' }, null, {})).toBeNull();
        expect(shapeHolder(null, null, {})).toBeNull();
        expect(shapeHolder('nope', null, {})).toBeNull();
    });
});

// --- Owner dedupe ----------------------------------------------------------------------------

describe('dedupeOwners / distinctOwnerCount', () => {
    test('two token accounts of the same wallet collapse into one owner (real AAPLx pair)', () => {
        const entries = [
            { tokenAccount: '6Q4FvChjxaMtmEdCZjCSVa3rRmVhCdDkNG3dPTFH1Tzy', owner: '6LY1JzAFVZsP2a2xKrtU6znQMQ5h4i7tocWdgrkZzkzF', amountUi: 6749.02740397, sharePct: 4.3892272736657, state: 'initialized', ownerLabel: null },
            { tokenAccount: 'GW4cuCxabGutpfLf445fTNaFXTqmgqMF83ReEgGsXzCK', owner: '6LY1JzAFVZsP2a2xKrtU6znQMQ5h4i7tocWdgrkZzkzF', amountUi: 6560.43105189, sharePct: 4.266573711498141, state: 'initialized', ownerLabel: null },
            { tokenAccount: 'G9y5mkpBgFvqEpTXduZWohxt4A8UTB8tbm6beGJUQ37A', owner: 'S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS', amountUi: 114062.26514867, sharePct: 74.18034853320272, state: 'initialized', ownerLabel: null }
        ];
        const rows = dedupeOwners(entries);
        expect(rows).toHaveLength(2);
        expect(rows[0].owner).toBe('S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS');
        expect(rows[1].owner).toBe('6LY1JzAFVZsP2a2xKrtU6znQMQ5h4i7tocWdgrkZzkzF');
        expect(rows[1].accounts).toBe(2);
        expect(rows[1].amountUi).toBeCloseTo(13309.45845586, 8);
        expect(rows[1].sharePct).toBeCloseTo(8.655800985163841, 10);
        expect(distinctOwnerCount(entries)).toBe(2);
    });

    test('unread owners are NOT merged into one bucket', () => {
        const entries = [{ owner: null, amountUi: 5, sharePct: 1 }, { owner: null, amountUi: 4, sharePct: 1 }];
        expect(dedupeOwners(entries)).toHaveLength(2);
        expect(distinctOwnerCount(entries)).toBe(2);
    });

    test('null shares survive the merge as null, not 0', () => {
        const rows = dedupeOwners([
            { owner: 'A', amountUi: null, sharePct: null },
            { owner: 'A', amountUi: null, sharePct: null }
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0].sharePct).toBeNull();
        expect(rows[0].amountUi).toBeNull();
        expect(rows[0].accounts).toBe(2);
    });

    test('an empty list is 0 owners', () => {
        expect(dedupeOwners([])).toEqual([]);
        expect(distinctOwnerCount(null)).toBe(0);
    });
});

// --- The whole item --------------------------------------------------------------------------

describe('summariseMint', () => {
    const labels = buildOwnerLabels(ONCHAIN_ITEMS);

    test('AAPLx: real shares, real dedupe, no frozen account', () => {
        const { item, unresolved, mintMismatches } = summariseMint({
            mint: AAPLX_MINT, symbol: 'AAPLx', issuer: 'xstocks-backed',
            decimals: AAPLX_DECIMALS, rawSupply: AAPLX_SUPPLY,
            largest: AAPLX_LARGEST, accountByAddress: infoMap(AAPLX_ACCOUNTS), labels
        });
        expect(item.supplyUi).toBeCloseTo(153763.45272578, 8);
        expect(item.top20).toHaveLength(3);
        expect(item.top20[0].tokenAccount).toBe('G9y5mkpBgFvqEpTXduZWohxt4A8UTB8tbm6beGJUQ37A');
        expect(item.top1SharePct).toBeCloseTo(74.18034853, 6);
        expect(item.top5SharePct).toBeCloseTo(82.83614952, 6);
        expect(item.top20SharePct).toBeCloseTo(82.83614952, 6);
        expect(item.distinctOwnersTop20).toBe(2);
        expect(item.frozenAccountsTop20).toBe(0);
        expect(unresolved).toBe(0);
        expect(mintMismatches).toBe(0);
    });

    test('supplyUi is the raw supply, NOT the issuer-displayed scaled figure', () => {
        const { item } = summariseMint({ mint: AAPLX_MINT, decimals: AAPLX_DECIMALS, rawSupply: AAPLX_SUPPLY, largest: [], labels });
        expect(item.supplyUi).toBeCloseTo(153763.45272578, 8);
        // universe.json's totalSupply for AAPLx is 154266.10738090638 — the same supply with the
        // ×1.0026642 scaled-UI multiplier applied. holders.json deliberately does not.
        expect(item.supplyUi).not.toBeCloseTo(154266.10738090638, 2);
    });

    test('FWDI: counts the frozen allowlist account in the top 20', () => {
        const { item } = summariseMint({
            mint: FWDI_MINT, symbol: 'FWDI', issuer: 'superstate-opening-bell',
            decimals: FWDI_DECIMALS, rawSupply: FWDI_SUPPLY,
            largest: FWDI_LARGEST, accountByAddress: infoMap(FWDI_ACCOUNTS), labels
        });
        expect(item.frozenAccountsTop20).toBe(1);
        expect(item.distinctOwnersTop20).toBe(4);
        expect(item.top1SharePct).toBeCloseTo(48.2571, 3);
        expect(item.top5SharePct).toBeCloseTo(99.8515, 3);
        // The frozen zero-balance account sorts last and contributes a real 0, not a null.
        expect(item.top20[3].sharePct).toBe(0);
        expect(item.top20[3].state).toBe('frozen');
    });

    // The zero-supply case end to end: 20 live accounts, no supply to measure them against.
    test('HSDT (supply 0): every share is null, not 0', () => {
        const { item } = summariseMint({
            mint: HSDT_MINT, symbol: 'HSDT', issuer: 'superstate-opening-bell',
            decimals: 6, rawSupply: '0', largest: HSDT_LARGEST, accountByAddress: {}, labels
        });
        expect(item.supplyUi).toBe(0);
        expect(item.top20).toHaveLength(3);
        for (const entry of item.top20) {
            expect(entry.sharePct).toBeNull();
            expect(entry.amountUi).toBe(0);
        }
        expect(item.top1SharePct).toBeNull();
        expect(item.top5SharePct).toBeNull();
        expect(item.top20SharePct).toBeNull();
        // The accounts are still real and still counted.
        expect(item.distinctOwnersTop20).toBe(3);
    });

    test('a mint the RPC answered nothing for is an empty item, not a zero one', () => {
        const { item } = summariseMint({ mint: HSDT_MINT, decimals: 6, rawSupply: FWDI_SUPPLY, largest: [], labels });
        expect(item.top20).toEqual([]);
        expect(item.top1SharePct).toBeNull();
        expect(item.top20SharePct).toBeNull();
        expect(item.distinctOwnersTop20).toBe(0);
        expect(item.frozenAccountsTop20).toBe(0);
    });

    test('entries are re-sorted biggest-first whatever order they arrive in', () => {
        const shuffled = [AAPLX_LARGEST[2], AAPLX_LARGEST[0], AAPLX_LARGEST[1]];
        const { item } = summariseMint({ mint: AAPLX_MINT, decimals: AAPLX_DECIMALS, rawSupply: AAPLX_SUPPLY, largest: shuffled, accountByAddress: infoMap(AAPLX_ACCOUNTS), labels });
        expect(item.top20.map((e) => e.tokenAccount)).toEqual(AAPLX_LARGEST.map((e) => e.address));
        expect(item.top1SharePct).toBeCloseTo(74.18034853, 6);
    });

    test('unresolved accounts are counted so a partial batch is visible', () => {
        const { item, unresolved } = summariseMint({
            mint: AAPLX_MINT, decimals: AAPLX_DECIMALS, rawSupply: AAPLX_SUPPLY,
            largest: AAPLX_LARGEST, accountByAddress: { [AAPLX_LARGEST[0].address]: tokenAccountInfo(AAPLX_ACCOUNTS[AAPLX_LARGEST[0].address]) }, labels
        });
        expect(unresolved).toBe(2);
        expect(item.top20[1].owner).toBeNull();
        // One known wallet + two separate unknowns.
        expect(item.distinctOwnersTop20).toBe(3);
    });

    test('no supply figure at all: shares null, balances still reported', () => {
        const { item } = summariseMint({
            mint: AAPLX_MINT, decimals: AAPLX_DECIMALS, rawSupply: null,
            largest: AAPLX_LARGEST, accountByAddress: infoMap(AAPLX_ACCOUNTS), labels
        });
        expect(item.supplyUi).toBeNull();
        expect(item.top1SharePct).toBeNull();
        expect(item.top20SharePct).toBeNull();
        expect(item.top20[0].amountUi).toBeCloseTo(114062.26514867, 8);
        expect(item.top20[0].sharePct).toBeNull();
    });
});
