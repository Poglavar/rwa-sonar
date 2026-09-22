// Unit tests for the pure classifiers in lib/classify.mjs. Fixtures are trimmed copies of real
// mainnet jsonParsed mints read on 2026-09-16 (xStocks TSLAx, Ondo SPCXon, PreStocks ANDURIL,
// Tessera tOpenAI), so a change in how extensions are flattened shows up as a value mismatch.

const {
    hasStockTag,
    issuerFromTags,
    issuerFromMintAuthority,
    issuerFromFreezeAuthority,
    issuerLabel,
    underlyingTicker,
    summarizeExtensions
} = require('./lib/classify.mjs');

// XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB — Tesla xStock, Token-2022, 8 decimals.
const TSLAX_ACCOUNT = {
    owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    space: 678,
    data: {
        program: 'spl-token-2022',
        parsed: {
            type: 'mint',
            info: {
                decimals: 8,
                freezeAuthority: 'JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs',
                isInitialized: true,
                mintAuthority: '7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj',
                supply: '22963699778248',
                extensions: [
                    { extension: 'metadataPointer', state: { authority: '5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq', metadataAddress: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB' } },
                    { extension: 'permanentDelegate', state: { delegate: '5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq' } },
                    { extension: 'defaultAccountState', state: { accountState: 'initialized' } },
                    { extension: 'scaledUiAmountConfig', state: { authority: 'S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS', multiplier: '1', newMultiplier: '1', newMultiplierEffectiveTimestamp: 0 } },
                    { extension: 'pausableConfig', state: { authority: 'JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs', paused: false } },
                    { extension: 'confidentialTransferMint', state: { auditorElgamalPubkey: null, authority: '5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq', autoApproveNewAccounts: false } },
                    { extension: 'transferHook', state: { authority: '5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq', programId: null } },
                    { extension: 'tokenMetadata', state: { additionalMetadata: [], mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', name: 'Tesla xStock', symbol: 'TSLAx', updateAuthority: '5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq', uri: 'https://xstocks-metadata.backed.fi/tokens/Solana/TSLAx/metadata.json' } }
                ]
            }
        }
    }
};

// wzAyQTorWyoVXuJKj2x8EqKEGJpS13z6EWE9z5Aondo — SpaceX (Ondo Tokenized): no permanentDelegate.
const SPCXON_ACCOUNT = {
    owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    space: 649,
    data: {
        parsed: {
            type: 'mint',
            info: {
                decimals: 9,
                freezeAuthority: '51QVCuHfL1FeNjd8BDeffCKhCcAYoULnVB3yjNhShiuK',
                mintAuthority: '9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD',
                supply: '1311176186366',
                extensions: [
                    { extension: 'scaledUiAmountConfig', state: { authority: '9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD', multiplier: '1', newMultiplier: '1', newMultiplierEffectiveTimestamp: 1788344044 } },
                    { extension: 'metadataPointer', state: { authority: '9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD', metadataAddress: 'wzAyQTorWyoVXuJKj2x8EqKEGJpS13z6EWE9z5Aondo' } },
                    { extension: 'pausableConfig', state: { authority: '9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD', paused: false } },
                    { extension: 'defaultAccountState', state: { accountState: 'initialized' } },
                    { extension: 'confidentialTransferMint', state: { auditorElgamalPubkey: null, authority: '9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD', autoApproveNewAccounts: false } },
                    { extension: 'transferHook', state: { authority: '9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD', programId: null } },
                    { extension: 'tokenMetadata', state: { additionalMetadata: [], mint: 'wzAyQTorWyoVXuJKj2x8EqKEGJpS13z6EWE9z5Aondo', name: 'SpaceX (Ondo Tokenized)', symbol: 'SPCXon', updateAuthority: '9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD', uri: 'https://app.ondo.finance/api/v2/assets/SPCXon/sol_metadata.json' } }
                ]
            }
        }
    }
};

// PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB — Anduril PreStocks: 50 bps transfer fee.
const ANDURIL_ACCOUNT = {
    owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    space: 905,
    data: {
        parsed: {
            type: 'mint',
            info: {
                decimals: 9,
                freezeAuthority: 'WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc',
                mintAuthority: 'WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc',
                supply: '11805978688696',
                extensions: [
                    { extension: 'permanentDelegate', state: { delegate: 'WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc' } },
                    { extension: 'defaultAccountState', state: { accountState: 'initialized' } },
                    { extension: 'transferFeeConfig', state: { newerTransferFee: { epoch: 1032, maximumFee: 18446744073709552000, transferFeeBasisPoints: 50 }, olderTransferFee: { epoch: 848, maximumFee: 0, transferFeeBasisPoints: 0 }, transferFeeConfigAuthority: 'WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc', withdrawWithheldAuthority: 'WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc', withheldAmount: 57088666 } },
                    { extension: 'confidentialTransferMint', state: { auditorElgamalPubkey: null, authority: 'WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc', autoApproveNewAccounts: false } },
                    { extension: 'confidentialTransferFeeConfig', state: { authority: 'WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc', harvestToMintEnabled: true } },
                    { extension: 'transferHook', state: { authority: 'WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc', programId: null } },
                    { extension: 'scaledUiAmountConfig', state: { authority: 'WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc', multiplier: '1', newMultiplier: '1', newMultiplierEffectiveTimestamp: 0 } },
                    { extension: 'metadataPointer', state: { authority: 'WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc', metadataAddress: 'PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB' } },
                    { extension: 'pausableConfig', state: { authority: 'WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc', paused: false } },
                    { extension: 'tokenMetadata', state: { additionalMetadata: [], mint: 'PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB', name: 'Anduril PreStocks', symbol: 'ANDURIL', updateAuthority: 'WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc', uri: 'https://prestocks.com/metadata/anduril.json' } }
                ]
            }
        }
    }
};

// oPAiAikWTaFj9RYoRFD35ccfwhnMcB3ThgBZRHSkjTZ — T-OpenAI: only fee + metadata extensions.
const TOPENAI_ACCOUNT = {
    owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    space: 492,
    data: {
        parsed: {
            type: 'mint',
            info: {
                decimals: 9,
                freezeAuthority: '7n2PNcDXVDMK2m8dyV9cVPNY7p4jM4ZMHv7TzfibEt8o',
                mintAuthority: 'EXvTtxurWBUNNCtLojaN8ZBJFNJPZFSH3szoih9hh7YW',
                supply: '684811681819',
                extensions: [
                    { extension: 'transferFeeConfig', state: { newerTransferFee: { epoch: 987, maximumFee: 18446744073709552000, transferFeeBasisPoints: 20 }, olderTransferFee: { epoch: 987, maximumFee: 18446744073709552000, transferFeeBasisPoints: 20 }, transferFeeConfigAuthority: 'EXvTtxurWBUNNCtLojaN8ZBJFNJPZFSH3szoih9hh7YW', withdrawWithheldAuthority: 'DjMKLEZe8d1nfCWQjoeoihqCU1owkxM8j2WqgFcCbzft', withheldAmount: 1476999090 } },
                    { extension: 'metadataPointer', state: { authority: 'EXvTtxurWBUNNCtLojaN8ZBJFNJPZFSH3szoih9hh7YW', metadataAddress: 'oPAiAikWTaFj9RYoRFD35ccfwhnMcB3ThgBZRHSkjTZ' } },
                    { extension: 'tokenMetadata', state: { additionalMetadata: [], mint: 'oPAiAikWTaFj9RYoRFD35ccfwhnMcB3ThgBZRHSkjTZ', name: 'T-OpenAI', symbol: 'tOpenAI', updateAuthority: 'EXvTtxurWBUNNCtLojaN8ZBJFNJPZFSH3szoih9hh7YW', uri: 'https://cdn.tesseralab.co/tessera/t-openai.json' } }
                ]
            }
        }
    }
};

describe('hasStockTag', () => {
    it('keeps a record carrying any equity tag', () => {
        expect(hasStockTag(['stocks', 'rwa', 'token-2022', 'xstocks'])).toBe(true);
        expect(hasStockTag(['equities'])).toBe(true);
        expect(hasStockTag(['xstocks'])).toBe(true);
    });

    it('rejects records with no equity tag, and non-arrays', () => {
        expect(hasStockTag(['rwa', 'verified', 'token-2022'])).toBe(false);
        expect(hasStockTag([])).toBe(false);
        expect(hasStockTag(undefined)).toBe(false);
        expect(hasStockTag('stocks')).toBe(false);
    });
});

describe('issuerFromFreezeAuthority', () => {
    test('names Superstate from the shared Opening Bell freeze key', () => {
        expect(issuerFromFreezeAuthority('2Yq4T3mPNfjtEyTxSbRjRKqLf1pwbTasuCQrWe6QpM7x')).toBe('superstate-opening-bell');
    });
    test('returns null for an unknown or missing key', () => {
        expect(issuerFromFreezeAuthority('JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs')).toBe(null);
        expect(issuerFromFreezeAuthority(undefined)).toBe(null);
    });
});

describe('issuerFromTags', () => {
    it('maps every known issuer tag to its slug', () => {
        expect(issuerFromTags(['stocks', 'xstocks'])).toBe('xstocks-backed');
        expect(issuerFromTags(['stocks', 'ondo'])).toBe('ondo-global-markets');
        expect(issuerFromTags(['stocks', 'backpack'])).toBe('backpack-securities');
        expect(issuerFromTags(['stocks', 'prestocks'])).toBe('prestocks');
        expect(issuerFromTags(['stocks', 'tessera'])).toBe('tessera');
        expect(issuerFromTags(['stocks', 'shift'])).toBe('shift');
    });

    it('returns null when no issuer tag is present', () => {
        expect(issuerFromTags(['stocks', 'rwa', 'verified'])).toBe(null);
        expect(issuerFromTags(null)).toBe(null);
    });
});

describe('issuerFromMintAuthority', () => {
    it('recognises the known issuer mint authorities', () => {
        expect(issuerFromMintAuthority('7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj')).toBe('xstocks-backed');
        expect(issuerFromMintAuthority('9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD')).toBe('ondo-global-markets');
        expect(issuerFromMintAuthority('WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc')).toBe('prestocks');
        expect(issuerFromMintAuthority('HK6jF79duLLLfCMRQFBSgo6CgQ5mF4tFMFU7CmKcXctZ')).toBe('backpack-securities');
        expect(issuerFromMintAuthority('EXvTtxurWBUNNCtLojaN8ZBJFNJPZFSH3szoih9hh7YW')).toBe('tessera');
    });

    it('returns null for unknown or absent authorities', () => {
        expect(issuerFromMintAuthority('S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS')).toBe(null);
        expect(issuerFromMintAuthority(null)).toBe(null);
        expect(issuerFromMintAuthority(undefined)).toBe(null);
    });
});

describe('underlyingTicker', () => {
    it('strips the xStocks trailing x, including dotted class symbols', () => {
        expect(underlyingTicker('TSLAx', 'xstocks-backed')).toBe('TSLA');
        expect(underlyingTicker('BRK.Bx', 'xstocks-backed')).toBe('BRK.B');
        expect(underlyingTicker('SPYx', 'xstocks-backed')).toBe('SPY');
    });

    it('strips the Ondo trailing on', () => {
        expect(underlyingTicker('NKEon', 'ondo-global-markets')).toBe('NKE');
        expect(underlyingTicker('SPCXon', 'ondo-global-markets')).toBe('SPCX');
    });

    it('passes Backpack symbols through unchanged', () => {
        expect(underlyingTicker('SPCX', 'backpack-securities')).toBe('SPCX');
        expect(underlyingTicker('AAPL', 'backpack-securities')).toBe('AAPL');
    });

    it('strips the Shift leverage suffix', () => {
        expect(underlyingTicker('SPCX2L', 'shift')).toBe('SPCX');
        expect(underlyingTicker('SPX3L', 'shift')).toBe('SPX');
        expect(underlyingTicker('TSLA2S', 'shift')).toBe('TSLA');
        expect(underlyingTicker('SPX', 'shift')).toBe('SPX');
    });

    it('returns null for private-company issuers and unknown issuers', () => {
        expect(underlyingTicker('ANDURIL', 'prestocks')).toBe(null);
        expect(underlyingTicker('tOpenAI', 'tessera')).toBe(null);
        expect(underlyingTicker('AAPLx', null)).toBe(null);
        expect(underlyingTicker('AAPLx', 'some-new-issuer')).toBe(null);
    });

    it('returns null for an empty or non-string symbol', () => {
        expect(underlyingTicker('', 'xstocks-backed')).toBe(null);
        expect(underlyingTicker(undefined, 'xstocks-backed')).toBe(null);
        expect(underlyingTicker(42, 'xstocks-backed')).toBe(null);
    });
});

describe('summarizeExtensions', () => {
    it('flattens the xStocks TSLAx mint exactly', () => {
        expect(summarizeExtensions(TSLAX_ACCOUNT)).toEqual({
            tokenProgram: 'token-2022',
            decimals: 8,
            supply: '22963699778248',
            mintAuthority: '7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj',
            freezeAuthority: 'JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs',
            permanentDelegate: true,
            permanentDelegateAddress: '5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq',
            transferHookConfigured: true,
            transferHookProgram: null,
            pausable: true,
            paused: false,
            defaultAccountStateFrozen: false,
            transferFeeConfigured: false,
            transferFeeBps: null,
            transferFeeConfigAuthority: null,
            transferFeeWithdrawAuthority: null,
            confidentialTransfers: true,
            scaledUiAmountMultiplier: '1',
            metadataUri: 'https://xstocks-metadata.backed.fi/tokens/Solana/TSLAx/metadata.json',
            metadataUpdateAuthority: '5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq',
            extensionNames: [
                'confidentialTransferMint', 'defaultAccountState', 'metadataPointer', 'pausableConfig',
                'permanentDelegate', 'scaledUiAmountConfig', 'tokenMetadata', 'transferHook'
            ]
        });
    });

    it('reports no permanent delegate for the Ondo mint', () => {
        const summary = summarizeExtensions(SPCXON_ACCOUNT);
        expect(summary.permanentDelegate).toBe(false);
        expect(summary.permanentDelegateAddress).toBe(null);
        expect(summary.decimals).toBe(9);
        expect(summary.pausable).toBe(true);
        expect(summary.paused).toBe(false);
        expect(summary.transferFeeBps).toBe(null);
        expect(summary.metadataUri).toBe('https://app.ondo.finance/api/v2/assets/SPCXon/sol_metadata.json');
        expect(summary.mintAuthority).toBe('9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD');
    });

    it('reads the newer transfer fee in basis points', () => {
        expect(summarizeExtensions(ANDURIL_ACCOUNT).transferFeeBps).toBe(50);
        expect(summarizeExtensions(ANDURIL_ACCOUNT).transferFeeConfigured).toBe(true);
        expect(summarizeExtensions(TOPENAI_ACCOUNT).transferFeeBps).toBe(20);
        expect(summarizeExtensions(ANDURIL_ACCOUNT)).toMatchObject({
            transferFeeConfigAuthority: 'WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc',
            transferFeeWithdrawAuthority: 'WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc'
        });
    });

    it('sees the Tessera mint as fee + metadata only', () => {
        const summary = summarizeExtensions(TOPENAI_ACCOUNT);
        expect(summary.extensionNames).toEqual(['metadataPointer', 'tokenMetadata', 'transferFeeConfig']);
        expect(summary.pausable).toBe(false);
        expect(summary.paused).toBe(null);
        expect(summary.permanentDelegate).toBe(false);
        expect(summary.confidentialTransfers).toBe(false);
        expect(summary.transferHookConfigured).toBe(false);
        expect(summary.transferHookProgram).toBe(null);
        expect(summary.scaledUiAmountMultiplier).toBe(null);
        expect(summary.freezeAuthority).toBe('7n2PNcDXVDMK2m8dyV9cVPNY7p4jM4ZMHv7TzfibEt8o');
    });

    it('distinguishes a frozen default account state from an initialized one', () => {
        expect(summarizeExtensions(TSLAX_ACCOUNT).defaultAccountStateFrozen).toBe(false);
        const frozen = JSON.parse(JSON.stringify(TSLAX_ACCOUNT));
        frozen.data.parsed.info.extensions.find((e) => e.extension === 'defaultAccountState').state.accountState = 'frozen';
        expect(summarizeExtensions(frozen).defaultAccountStateFrozen).toBe(true);
    });

    it('reports an armed transfer hook program when one is set', () => {
        const hooked = JSON.parse(JSON.stringify(TSLAX_ACCOUNT));
        hooked.data.parsed.info.extensions.find((e) => e.extension === 'transferHook').state.programId = 'HookProgram1111111111111111111111111111111';
        const summary = summarizeExtensions(hooked);
        expect(summary.transferHookConfigured).toBe(true);
        expect(summary.transferHookProgram).toBe('HookProgram1111111111111111111111111111111');
    });

    it('names the token program from the account owner', () => {
        expect(summarizeExtensions({ owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', info: {} }).tokenProgram).toBe('spl-token');
        expect(summarizeExtensions({ owner: 'SomeOtherProgram', info: {} }).tokenProgram).toBe('SomeOtherProgram');
        expect(summarizeExtensions({ info: {} }).tokenProgram).toBe(null);
    });

    it('accepts an already-unwrapped {owner, info} pair', () => {
        const unwrapped = { owner: TSLAX_ACCOUNT.owner, info: TSLAX_ACCOUNT.data.parsed.info };
        expect(summarizeExtensions(unwrapped)).toEqual(summarizeExtensions(TSLAX_ACCOUNT));
    });

    it('returns nulls rather than zeros for a mint with no extensions', () => {
        const summary = summarizeExtensions({ owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', info: { decimals: 6, supply: '0' } });
        expect(summary.decimals).toBe(6);
        expect(summary.transferFeeBps).toBe(null);
        expect(summary.scaledUiAmountMultiplier).toBe(null);
        expect(summary.paused).toBe(null);
        expect(summary.extensionNames).toEqual([]);
    });
});

describe('issuerLabel', () => {
    test('returns the record name for a known slug and the slug otherwise', () => {
        expect(issuerLabel('xstocks-backed')).toBe('Kraken xStocks');
        expect(issuerLabel('shift')).toBe('Shift leveraged tokens');
        expect(issuerLabel('nobody')).toBe('nobody');
    });
});
