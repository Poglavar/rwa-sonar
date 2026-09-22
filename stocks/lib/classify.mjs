// Pure classification helpers for tokenized-stock mints: which issuer a token belongs
// to (from Jupiter tags, or from the mint authority as a fallback), which real-world
// ticker it tracks, and which Token-2022 capabilities its mint extensions grant.
// No I/O and no network here so it can be unit-tested headlessly (see ../classify.test.js).

export const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** Jupiter tags that mark a token as an equity-style RWA. A token needs at least one. */
export const STOCK_TAGS = ['stocks', 'xstocks', 'equities'];

/** Issuer tag → issuer slug. Checked in this order, so the first match wins. */
export const ISSUER_TAGS = [
    ['xstocks', 'xstocks-backed'],
    ['ondo', 'ondo-global-markets'],
    ['backpack', 'backpack-securities'],
    ['prestocks', 'prestocks'],
    ['tessera', 'tessera'],
    ['shift', 'shift']
];

/**
 * Known mint authorities, used only when tags are missing. Backpack mints each token
 * under a different authority, so this catches SPCX alone — tags stay primary.
 */
export const ISSUER_MINT_AUTHORITIES = {
    '7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj': 'xstocks-backed',
    '9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD': 'ondo-global-markets',
    WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc: 'prestocks',
    HK6jF79duLLLfCMRQFBSgo6CgQ5mF4tFMFU7CmKcXctZ: 'backpack-securities',
    EXvTtxurWBUNNCtLojaN8ZBJFNJPZFSH3szoih9hh7YW: 'tessera'
};

/** Issuers whose tokens track private companies, so there is no listed underlying ticker. */
export const PRIVATE_COMPANY_ISSUERS = ['prestocks', 'tessera'];

// Short display names per issuer slug — the same names the main table uses for its records.
// Dossiers keep the long-form issuer text; the built database and the page show these.
export const ISSUER_LABELS = {
    'xstocks-backed': 'Kraken xStocks',
    'ondo-global-markets': 'Ondo Global Markets',
    'backpack-securities': 'Backpack Securities',
    'superstate-opening-bell': 'Opening Bell by Superstate',
    'bullish': 'Bullish BLSH',
    'securitize': 'Securitize SECZ',
    'prestocks': 'PreStocks',
    'tessera': 'Tessera',
    'shift': 'Shift leveraged tokens',
    'remora-markets': 'Remora Markets',
    'ventuals': 'Ventuals Pre-IPO',
    'republic-mirror': 'Republic Mirror'
};

export function issuerLabel(slug) {
    return ISSUER_LABELS[slug] ?? slug;
}

export function hasStockTag(tags) {
    if (!Array.isArray(tags)) return false;
    return tags.some((tag) => STOCK_TAGS.includes(tag));
}

export function issuerFromTags(tags) {
    if (!Array.isArray(tags)) return null;
    for (const [tag, issuer] of ISSUER_TAGS) {
        if (tags.includes(tag)) return issuer;
    }
    return null;
}

// Issuers that mint each token from a fresh key but share one freeze authority across the line.
// Superstate Opening Bell tokens carry no Jupiter issuer tag (Galaxy Digital is listed untagged),
// so the shared freeze key is the only on-chain handle that names the issuer.
export const ISSUER_FREEZE_AUTHORITIES = {
    "2Yq4T3mPNfjtEyTxSbRjRKqLf1pwbTasuCQrWe6QpM7x": "superstate-opening-bell",
    "2cVYpagTt7ZGc3mmTXBa7fAznUtx5DUu6aCq8uVDaf4a": "backpack-securities",
};

export function issuerFromFreezeAuthority(auth) {
    if (typeof auth !== "string") return null;
    return ISSUER_FREEZE_AUTHORITIES[auth] ?? null;
}

export function issuerFromMintAuthority(auth) {
    if (typeof auth !== 'string') return null;
    return ISSUER_MINT_AUTHORITIES[auth] ?? null;
}

/**
 * The listed instrument a token tracks, derived from the issuer's symbol convention.
 * Returns null when the issuer is unknown or the underlying is a private company.
 */
export function underlyingTicker(symbol, issuer) {
    if (typeof symbol !== 'string' || symbol.length === 0) return null;
    if (PRIVATE_COMPANY_ISSUERS.includes(issuer)) return null;

    switch (issuer) {
        case 'xstocks-backed':
            return symbol.endsWith('x') ? symbol.slice(0, -1) : symbol;
        case 'ondo-global-markets':
            return symbol.endsWith('on') ? symbol.slice(0, -2) : symbol;
        case 'backpack-securities':
            return symbol;
        case 'shift':
            return symbol.replace(/[123][LS]$/, '');
        default:
            return null;
    }
}

function findExtension(extensions, name) {
    if (!Array.isArray(extensions)) return null;
    return extensions.find((ext) => ext && ext.extension === name) ?? null;
}

/**
 * The one place a raw token-program id becomes a name. An already-mapped name passes through
 * unchanged, so a caller can hand over either the `owner` of a parsed mint account or the
 * `tokenProgram` it reads back out of onchain.json / stocks-tokens.json. An id this does not know
 * is returned as-is rather than guessed at (see lib/recipe.mjs, which folds that into 'unknown').
 */
export function tokenProgramName(owner) {
    if (owner === TOKEN_2022_PROGRAM || owner === 'token-2022') return 'token-2022';
    if (owner === SPL_TOKEN_PROGRAM || owner === 'spl-token') return 'spl-token';
    return owner ?? null;
}

/**
 * Accepts either a whole jsonParsed account (`{owner, data:{parsed:{info}}}`) or an
 * already-unwrapped `{owner, info}` / `{owner, parsed:{info}}`, so callers can hand over
 * whatever depth they happen to hold.
 */
function unwrap(account) {
    const source = account ?? {};
    const info = source.info
        ?? source.data?.parsed?.info
        ?? source.parsed?.info
        ?? {};
    const owner = source.owner ?? source.data?.program ?? null;
    return { info, owner };
}

/**
 * Flatten a Token-2022 mint's extensions into the capability flags that matter for
 * grading how controllable a tokenized share is (who can seize, freeze, pause, tax or
 * re-denominate it) plus the plain mint facts.
 */
export function summarizeExtensions(parsedMintInfo) {
    const { info, owner } = unwrap(parsedMintInfo);
    const extensions = Array.isArray(info.extensions) ? info.extensions : [];

    const permanentDelegate = findExtension(extensions, 'permanentDelegate');
    const transferHook = findExtension(extensions, 'transferHook');
    const pausable = findExtension(extensions, 'pausableConfig');
    const defaultAccountState = findExtension(extensions, 'defaultAccountState');
    const transferFee = findExtension(extensions, 'transferFeeConfig');
    const confidential = findExtension(extensions, 'confidentialTransferMint');
    const scaled = findExtension(extensions, 'scaledUiAmountConfig');
    const metadata = findExtension(extensions, 'tokenMetadata');

    const feeBps = transferFee?.state?.newerTransferFee?.transferFeeBasisPoints;

    return {
        tokenProgram: tokenProgramName(owner),
        decimals: typeof info.decimals === 'number' ? info.decimals : null,
        supply: info.supply ?? null,
        mintAuthority: info.mintAuthority ?? null,
        freezeAuthority: info.freezeAuthority ?? null,
        permanentDelegate: permanentDelegate !== null,
        permanentDelegateAddress: permanentDelegate?.state?.delegate ?? null,
        transferHookConfigured: transferHook !== null,
        transferHookProgram: transferHook?.state?.programId ?? null,
        pausable: pausable !== null,
        paused: typeof pausable?.state?.paused === 'boolean' ? pausable.state.paused : null,
        defaultAccountStateFrozen: defaultAccountState?.state?.accountState === 'frozen',
        transferFeeConfigured: transferFee !== null,
        transferFeeBps: typeof feeBps === 'number' ? feeBps : null,
        // A zero current fee does not remove either administrative power.  Keep the two
        // authorities independently so downstream control assessment can distinguish an absent
        // extension from an installed, currently-zero fee schedule.
        transferFeeConfigAuthority: transferFee?.state?.transferFeeConfigAuthority ?? null,
        transferFeeWithdrawAuthority: transferFee?.state?.withdrawWithheldAuthority ?? null,
        confidentialTransfers: confidential !== null,
        scaledUiAmountMultiplier: scaled?.state?.multiplier ?? null,
        metadataUri: metadata?.state?.uri ?? null,
        metadataUpdateAuthority: metadata?.state?.updateAuthority ?? null,
        extensionNames: extensions.map((ext) => ext.extension).filter(Boolean).sort()
    };
}
