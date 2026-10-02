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
 * The scaled-UI multiplier IN EFFECT at `nowSeconds`. Token-2022 switches to `newMultiplier` once
 * `newMultiplierEffectiveTimestamp` has passed without rewriting `multiplier`, so reading
 * `multiplier` alone understated rebases: 84 of 833 xStocks mints read as rebased against 378 by
 * this rule, and PreStocks' SPACEX ×5 and OPENAI ×1.4861347 read as ×1 (found 2026-09-24).
 * Null when the extension is absent or the value is not a number.
 */
export function effectiveUiMultiplier(state, nowSeconds) {
    if (!state) return null;
    const due = Number(state.newMultiplierEffectiveTimestamp);
    const value = Number.isFinite(due) && due > 0 && due <= nowSeconds ? state.newMultiplier : state.multiplier;
    return value !== undefined && value !== null && Number.isFinite(Number(value)) ? String(value) : null;
}

/** One leg of a Token-2022 transfer-fee schedule: `{epoch, bps, capped}`, or null when unreadable. */
function feeLeg(fee) {
    const epoch = Number.isInteger(fee?.epoch) ? fee.epoch : null;
    const bps = Number.isInteger(fee?.transferFeeBasisPoints) ? fee.transferFeeBasisPoints : null;
    if (epoch === null || bps === null) return null;
    // jsonParsed prints maximumFee as a number, and u64::MAX (the "no cap" value) parses as 2^64.
    const max = Number(fee?.maximumFee);
    return { epoch, bps, capped: Number.isFinite(max) ? max < 2 ** 64 : null };
}

/**
 * The transfer fee in effect at `epoch`, and the change already scheduled after it. Token-2022
 * keeps two legs: `olderTransferFee` applies until `newerTransferFee.epoch`, the newer one from that
 * epoch on — so a newly set fee (always two epochs ahead) is NOT the fee in effect yet. PreStocks
 * set 300 bps from epoch 1043 on seven mints while epoch 1042 still charged 100 bps.
 *
 * With no epoch the fee in effect is only known when both legs agree; otherwise it is null rather
 * than a guess. Returns `{bps, capped, scheduled: {bps, epoch, capped} | null}`.
 */
export function transferFeeAtEpoch(state, epoch = null) {
    const older = feeLeg(state?.olderTransferFee);
    const newer = feeLeg(state?.newerTransferFee);
    if (newer === null) return { bps: null, capped: null, scheduled: null };
    const same = older !== null && older.bps === newer.bps && older.capped === newer.capped;
    if (!Number.isInteger(epoch)) {
        return same || older === null ? { bps: newer.bps, capped: newer.capped, scheduled: null } : { bps: null, capped: null, scheduled: null };
    }
    if (epoch >= newer.epoch || older === null) return { bps: newer.bps, capped: newer.capped, scheduled: null };
    return { bps: older.bps, capped: older.capped, scheduled: same ? null : { bps: newer.bps, epoch: newer.epoch, capped: newer.capped } };
}

/**
 * Flatten a Token-2022 mint's extensions into the capability flags that matter for
 * grading how controllable a tokenized share is (who can seize, freeze, pause, tax or
 * re-denominate it) plus the plain mint facts. `nowSeconds` is the read time, which decides
 * whether a scheduled multiplier has taken effect; `epoch` is the chain's epoch at the read, which
 * decides which transfer-fee leg is in effect (transferFeeAtEpoch).
 */
export function summarizeExtensions(parsedMintInfo, { nowSeconds = Math.floor(Date.now() / 1000), epoch = null } = {}) {
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

    const fee = transferFee === null ? null : transferFeeAtEpoch(transferFee.state, epoch);

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
        // The fee in effect at the read epoch, NOT simply the newer leg: a scheduled rise is
        // reported beside it until its epoch arrives.
        transferFeeBps: fee?.bps ?? null,
        transferFeeCapped: fee?.capped ?? null,
        transferFeeScheduled: fee?.scheduled ?? null,
        transferFeeReadEpoch: transferFee !== null && Number.isInteger(epoch) ? epoch : null,
        // A zero current fee does not remove either administrative power.  Keep the two
        // authorities independently so downstream control assessment can distinguish an absent
        // extension from an installed, currently-zero fee schedule.
        transferFeeConfigAuthority: transferFee?.state?.transferFeeConfigAuthority ?? null,
        transferFeeWithdrawAuthority: transferFee?.state?.withdrawWithheldAuthority ?? null,
        confidentialTransfers: confidential !== null,
        scaledUiAmountMultiplier: effectiveUiMultiplier(scaled?.state, nowSeconds),
        // The pending change, kept visible: a scheduled rebase is a fact about the token too.
        scaledUiAmountMultiplierNext: scaled?.state?.newMultiplier ?? null,
        scaledUiAmountMultiplierNextAt: Number(scaled?.state?.newMultiplierEffectiveTimestamp) > 0
            ? new Date(Number(scaled.state.newMultiplierEffectiveTimestamp) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
        metadataUri: metadata?.state?.uri ?? null,
        metadataUpdateAuthority: metadata?.state?.updateAuthority ?? null,
        extensionNames: extensions.map((ext) => ext.extension).filter(Boolean).sort()
    };
}

/** A finite number or null — never a 0 conjured out of null by Number(). */
function finiteOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A catalogue token's `control` block from its onchain.json item (summarizeExtensions' output), or
 * every field null when the mint was never read. Shared by build-stocks-db.mjs; unit-tested in
 * ../classify.test.js.
 */
export function controlFromOnchain(onchain) {
    return {
        mintAuthority: onchain ? (onchain.mintAuthority ?? false) : null,
        clawback: onchain ? onchain.permanentDelegate === true : null,
        permanentDelegate: onchain
            ? (onchain.permanentDelegateAddress ?? (onchain.permanentDelegate === false ? false : null))
            : null,
        freezeAuthority: onchain ? (onchain.freezeAuthority ?? false) : null,
        pausable: onchain ? onchain.pausable === true : null,
        paused: typeof onchain?.paused === 'boolean' ? onchain.paused : null,
        allowlist: onchain ? onchain.defaultAccountStateFrozen === true : null,
        // Presence is separate from the current bps: `0` is an installed extension and `null`
        // from an older partial collector is unknown, not evidence of absence.
        transferFee: onchain
            ? (typeof onchain.transferFeeConfigured === 'boolean'
                ? onchain.transferFeeConfigured
                : (Array.isArray(onchain.extensionNames)
                    ? onchain.extensionNames.includes('transferFeeConfig')
                    : (Number.isFinite(onchain.transferFeeBps) ? true : null)))
            : null,
        transferFeeBps: finiteOrNull(onchain?.transferFeeBps),
        // Whether the fee in effect has a maximum per transfer (false: u64::MAX, no cap), the
        // change already scheduled ({bps, epoch, capped}), and the epoch the two were read at.
        transferFeeCapped: typeof onchain?.transferFeeCapped === 'boolean' ? onchain.transferFeeCapped : null,
        transferFeeScheduled: onchain?.transferFeeScheduled && typeof onchain.transferFeeScheduled === 'object'
            ? onchain.transferFeeScheduled : null,
        transferFeeReadEpoch: Number.isInteger(onchain?.transferFeeReadEpoch) ? onchain.transferFeeReadEpoch : null,
        transferFeeConfigAuthority: onchain
            ? (onchain.transferFeeConfigAuthority ?? null)
            : null,
        transferFeeWithdrawAuthority: onchain
            ? (onchain.transferFeeWithdrawAuthority ?? null)
            : null,
        hookActive: onchain ? typeof onchain.transferHookProgram === 'string' : null,
        // The scaled-UI-amount (rebase) extension being installed at all — NOT whether the
        // multiplier is currently 1. A multiplier of 1 is a rebase that has not been used yet, and
        // the capability is what the recipe and the keyControl health rule are about (MODEL.md
        // §2.7): one signature from the rebase authority restates every holder's displayed balance.
        rebase: onchain ? typeof onchain.scaledUiAmountMultiplier === 'string' : null
    };
}
