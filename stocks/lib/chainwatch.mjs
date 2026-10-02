// The on-chain watcher's pure half (stocks/EVIDENCE.md §2.4): flatten a jsonParsed mint account
// into the comparable state the DB stores, hash it, diff two states into sonar.change_event rows,
// diff two labelled-wallet balance readings, and render the SQL that mirrors a run into
// sonar.mint_state / sonar.wallet_balance. No network and no filesystem here, so every decision is
// unit tested (../chainwatch.test.js); stocks/watch-chain.mjs does the IO.
//
// What this covers that the daily snapshot diff (lib/changes.mjs) cannot: changes.mjs compares two
// DAILY snapshots of the built token rows, so it sees a pause or a multiplier move once a day and
// only for the fields the snapshot keeps. This watcher runs hourly over the raw accounts and keeps
// the fields a snapshot throws away — every extension authority, the withheld fee amount, the hook
// authority, the scheduled-but-not-yet-effective multiplier and the hash of the metadata JSON.
// The two are deliberately not merged: the kinds, thresholds and subjects are different.

import { createHash } from 'node:crypto';

import { summarizeExtensions } from './classify.mjs';
import { jsonbLiteral } from './db-load.mjs';
import { byString } from './io.mjs';

/**
 * Every column of sonar.mint_state, as [column, jsKey, type]. One list drives the insert SQL, the
 * read-back query and the state hash, so a column can never be written in one place and forgotten
 * in another. `comparable: false` marks the three columns that describe the READING rather than
 * the state (see `stateHash`).
 */
export const MINT_STATE_COLUMNS = [
    ['mint', 'mint', 'text', { comparable: false }],
    ['observed_at', 'observedAt', 'timestamptz', { comparable: false }],
    ['slot', 'slot', 'bigint', { comparable: false }],
    ['supply', 'supply', 'numeric'],
    ['decimals', 'decimals', 'int'],
    ['mint_authority', 'mintAuthority', 'text'],
    ['freeze_authority', 'freezeAuthority', 'text'],
    ['paused', 'paused', 'bool'],
    ['pausable', 'pausable', 'bool'],
    ['default_frozen', 'defaultFrozen', 'bool'],
    ['permanent_delegate', 'permanentDelegate', 'text'],
    ['transfer_fee_bps', 'transferFeeBps', 'int'],
    ['transfer_fee_max', 'transferFeeMax', 'numeric'],
    ['withheld', 'withheld', 'numeric'],
    ['fee_config_authority', 'feeConfigAuthority', 'text'],
    ['withdraw_withheld_authority', 'withdrawWithheldAuthority', 'text'],
    ['hook_program', 'hookProgram', 'text'],
    ['hook_authority', 'hookAuthority', 'text'],
    ['ui_multiplier', 'uiMultiplier', 'numeric'],
    ['ui_multiplier_next', 'uiMultiplierNext', 'numeric'],
    ['ui_multiplier_effective_at', 'uiMultiplierEffectiveAt', 'timestamptz'],
    ['ui_multiplier_authority', 'uiMultiplierAuthority', 'text'],
    ['metadata_uri', 'metadataUri', 'text'],
    ['metadata_update_authority', 'metadataUpdateAuthority', 'text'],
    ['metadata_hash', 'metadataHash', 'text'],
    ['state_hash', 'stateHash', 'text', { comparable: false }]
];

/** The columns the state hash is taken over: the state, not the reading. */
export const COMPARABLE_COLUMNS = MINT_STATE_COLUMNS
    .filter(([, , , opts]) => opts?.comparable !== false)
    .map(([column, jsKey]) => [column, jsKey])
    .sort((a, b) => byString(a[0], b[0]));

/**
 * The thresholds EVIDENCE.md §2.4 asks for, in one place so a test and the summary text read the
 * same numbers. Percentages are percent, not basis points; `solMove` is whole SOL.
 */
export const THRESHOLDS = {
    supplyInfoPct: 1,
    supplyCautionPct: 10,
    rebaseWarnRatioUp: 1.05,
    rebaseWarnRatioDown: 0.5,
    treasuryInfoPct: 5,
    treasuryCautionPct: 25,
    solMove: 100
};

/** At most this many labelled wallets are read per run (EVIDENCE.md §2.4: one RPC call each). */
export const WALLET_LIMIT = 40;

/** At most this many metadata JSON documents are fetched per run. */
export const METADATA_LIMIT = 50;

// --- value normalisation ---------------------------------------------------------------------

/**
 * A numeric column's value as a canonical decimal STRING, or null when absent.
 *
 * A string is kept verbatim (the RPC sends `supply` and the scaled-UI multipliers as strings, and
 * reformatting them would make the stored value differ from the chain's own spelling). A number is
 * rendered without exponent notation, which matters for exactly one real value: a transfer fee's
 * `maximumFee` is u64::MAX, which arrives from JSON.parse as 1.8446744073709552e19 and must not be
 * stored as `1.8446744073709552e+19` — Postgres would take it, but the hash would then depend on
 * how JS happened to print it.
 *
 * Anything that is not a finite number or a decimal string is null, NEVER 0: a missing measurement
 * that arithmetic turns into a real-looking zero is the single most productive bug family here.
 */
export function numericString(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return null;
        if (Number.isInteger(value)) return BigInt(value).toString();
        return String(value);
    }
    if (typeof value === 'string') {
        const text = value.trim();
        return /^-?\d+(\.\d+)?$/.test(text) ? text : null;
    }
    return null;
}

/** An integer column's value, or null. Never coerces a non-number into 0. */
export function intOrNull(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
    return null;
}

/**
 * A unix-seconds timestamp from the chain as an ISO string. 0 is how Token-2022 spells "no
 * scheduled multiplier change" (148 of the 471 mints on 2026-09-17), so it is `null` rather than
 * 1970-01-01; a value outside a sane range is null too rather than a fabricated date.
 */
export function unixToIso(seconds) {
    const value = intOrNull(seconds);
    if (value === null || value <= 0 || value > 4_000_000_000) return null;
    return new Date(value * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A timestamp from anywhere (RPC, psql, our own clock) in one spelling, so equality is equality. */
export function normaliseTimestamp(value) {
    if (value === null || value === undefined || value === '') return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function stringOrNull(value) {
    return typeof value === 'string' && value !== '' ? value : null;
}

function boolOrNull(value) {
    return typeof value === 'boolean' ? value : null;
}

/** Raw base-unit amount + decimals -> UI amount as a decimal string. Null in, null out. */
export function uiAmount(raw, decimals) {
    const digits = intOrNull(decimals);
    const text = numericString(raw);
    if (text === null || digits === null || digits < 0 || text.includes('.')) {
        return text === null ? null : text;
    }
    const negative = text.startsWith('-');
    const body = (negative ? text.slice(1) : text).padStart(digits + 1, '0');
    const whole = body.slice(0, body.length - digits) || '0';
    const frac = digits === 0 ? '' : body.slice(body.length - digits).replace(/0+$/, '');
    return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

// --- parsing ---------------------------------------------------------------------------------

function findExtension(extensions, name) {
    if (!Array.isArray(extensions)) return null;
    return extensions.find((ext) => ext && ext.extension === name) ?? null;
}

function unwrapInfo(account) {
    const source = account ?? {};
    return source.info ?? source.data?.parsed?.info ?? source.parsed?.info ?? {};
}

/**
 * One jsonParsed mint account -> the comparable state sonar.mint_state stores.
 *
 * The fields fetch-onchain.mjs already reads come from `classify.summarizeExtensions()`, imported
 * rather than re-implemented so the two files can never disagree about what "paused" means. What
 * this adds are the fields that flattening for the grade throws away but a watcher needs: the
 * transfer-fee cap, the withheld amount and both fee authorities, the transfer-hook authority (as
 * opposed to its program), the scheduled multiplier with its effective timestamp and its
 * authority. `mint`, `slot` and `observedAt` describe the READING and are passed in by the caller
 * — the account itself does not carry its own address.
 *
 * `metadataUri` / `metadataUpdateAuthority` come from the tokenMetadata extension only. The
 * metadataPointer extension has an `authority` of its own, but it authorises moving the POINTER
 * rather than editing the metadata, so folding the two into one column would report a rotation
 * that did not happen.
 */
export function parseMintState(account, { mint = null, slot = null, observedAt = null,
    metadataHash = null } = {}) {
    const info = unwrapInfo(account);
    const extensions = Array.isArray(info.extensions) ? info.extensions : [];
    const summary = summarizeExtensions(account);

    const transferFee = findExtension(extensions, 'transferFeeConfig')?.state ?? null;
    const newerFee = transferFee?.newerTransferFee ?? null;
    const hook = findExtension(extensions, 'transferHook')?.state ?? null;
    const scaled = findExtension(extensions, 'scaledUiAmountConfig')?.state ?? null;
    const pausable = findExtension(extensions, 'pausableConfig');
    const metadata = findExtension(extensions, 'tokenMetadata')?.state ?? null;

    return {
        mint: stringOrNull(mint),
        observedAt: normaliseTimestamp(observedAt),
        slot: intOrNull(slot),
        supply: numericString(summary.supply),
        decimals: intOrNull(summary.decimals),
        mintAuthority: stringOrNull(summary.mintAuthority),
        freezeAuthority: stringOrNull(summary.freezeAuthority),
        paused: boolOrNull(summary.paused),
        pausable: pausable !== null,
        defaultFrozen: summary.defaultAccountStateFrozen === true,
        permanentDelegate: stringOrNull(summary.permanentDelegateAddress),
        transferFeeBps: intOrNull(newerFee?.transferFeeBasisPoints),
        transferFeeMax: numericString(newerFee?.maximumFee),
        // Not a mint_state column: the epoch the newer fee applies from (Token-2022 sets it two
        // epochs ahead). It rides only in a fee change's evidence, so the feed can tell a
        // scheduled fee from one already charged.
        transferFeeEpoch: intOrNull(newerFee?.epoch),
        withheld: numericString(transferFee?.withheldAmount),
        feeConfigAuthority: stringOrNull(transferFee?.transferFeeConfigAuthority),
        withdrawWithheldAuthority: stringOrNull(transferFee?.withdrawWithheldAuthority),
        hookProgram: stringOrNull(summary.transferHookProgram),
        hookAuthority: stringOrNull(hook?.authority),
        uiMultiplier: numericString(scaled?.multiplier),
        uiMultiplierNext: numericString(scaled?.newMultiplier),
        uiMultiplierEffectiveAt: unixToIso(scaled?.newMultiplierEffectiveTimestamp),
        uiMultiplierAuthority: stringOrNull(scaled?.authority),
        metadataUri: stringOrNull(summary.metadataUri),
        metadataUpdateAuthority: stringOrNull(metadata?.updateAuthority),
        metadataHash: stringOrNull(metadataHash),
        tokenProgram: summary.tokenProgram
    };
}

/**
 * sha256 over the comparable columns, rendered as `column=value` lines in column-name order. The
 * order is the COMPARABLE_COLUMNS list, not the order of the keys in the object, so two states
 * built with their keys in any order hash identically. A null/absent value is the empty string,
 * which is why `metadataHash: null` (not fetched) and a metadata document that hashes to nothing
 * can never collide — a sha256 is never the empty string.
 */
export function stateHash(state) {
    const source = state ?? {};
    const lines = COMPARABLE_COLUMNS.map(([column, jsKey]) => {
        const value = source[jsKey];
        if (value === null || value === undefined) return `${column}=`;
        if (typeof value === 'boolean') return `${column}=${value ? 'true' : 'false'}`;
        return `${column}=${String(value)}`;
    });
    return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

// --- diffing ---------------------------------------------------------------------------------

/** Fields whose change is a rotated key: EVIDENCE.md §3 `authority-key`, always a warning. */
export const AUTHORITY_FIELDS = [
    ['mint_authority', 'mintAuthority'],
    ['freeze_authority', 'freezeAuthority'],
    ['permanent_delegate', 'permanentDelegate'],
    ['fee_config_authority', 'feeConfigAuthority'],
    ['withdraw_withheld_authority', 'withdrawWithheldAuthority'],
    ['hook_authority', 'hookAuthority'],
    ['ui_multiplier_authority', 'uiMultiplierAuthority'],
    ['metadata_update_authority', 'metadataUpdateAuthority']
];

/**
 * Fields whose change is a capability being switched: EVIDENCE.md §3 `extension-toggle`, warning.
 * `pausable` is here on top of the three §2.4 names because an extension APPEARING on a live mint
 * would be the same class of event and is free to watch — it has never moved, so it adds no noise.
 */
export const TOGGLE_FIELDS = [
    ['paused', 'paused'],
    ['default_frozen', 'defaultFrozen'],
    ['transfer_fee_bps', 'transferFeeBps'],
    ['pausable', 'pausable']
];

function show(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return String(value);
}

function ratioOf(before, after) {
    const a = Number(before);
    const b = Number(after);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
    return b / a;
}

/** |after - before| as a percentage of before, using BigInt so a u64 supply keeps every digit. */
export function movePct(before, after) {
    const a = numericString(before);
    const b = numericString(after);
    if (a === null || b === null) return null;
    if (a.includes('.') || b.includes('.')) {
        const x = Number(a);
        const y = Number(b);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x === 0) return null;
        return Math.abs((y - x) / x) * 100;
    }
    const x = BigInt(a);
    const y = BigInt(b);
    if (x === 0n) return y === 0n ? 0 : Infinity;
    const delta = y > x ? y - x : x - y;
    // Basis points first, so the division happens in integers and only the last step is a float.
    return Number((delta * 1_000_000n) / (x < 0n ? -x : x)) / 10_000;
}

/**
 * Two states of the same mint -> the change events between them (EVIDENCE.md §3).
 *
 * `prev` null is a FIRST SIGHT and yields no events at all: a mint we have never read has not
 * changed anything, and reporting 471 "authority set" events on the first run would bury the feed
 * the watcher exists to fill. The run records one `info` baseline event per issuer instead
 * (`baselineEvents`).
 *
 * The one field that appears in two kinds is `hook_program`: set or unset (null <-> address) is a
 * capability being switched on, so it is an `extension-toggle`, while one program id replaced by
 * another is a rotation, so it is an `authority-key`. Both are warnings, so the split changes only
 * how the feed reads, not what it flags.
 */
export function diffStates(prev, next, { symbol = null, issuer = null, detectedAt = null } = {}) {
    if (!next) return [];
    if (!prev) return [];

    const mint = next.mint ?? prev.mint ?? null;
    const at = normaliseTimestamp(detectedAt ?? next.observedAt) ?? next.observedAt ?? null;
    const evidence = {
        account: mint,
        slot: next.slot ?? null,
        observedAt: next.observedAt ?? null,
        previousObservedAt: prev.observedAt ?? null,
        previousSlot: prev.slot ?? null,
        rpc: 'getMultipleAccounts',
        symbol,
        issuer
    };
    const label = symbol ?? mint ?? '(unknown mint)';
    const events = [];
    // A fee change also records when the new fee applies and its cap (not in mint_state's hash).
    const feeEvidence = { ...evidence, transferFee: { newerEpoch: next.transferFeeEpoch ?? null, maximumFee: show(next.transferFeeMax) } };
    const emit = (kind, field, before, after, severity, summary) => {
        events.push({
            detectedAt: at,
            kind,
            subjectType: 'token',
            subjectId: mint,
            field,
            before: show(before),
            after: show(after),
            severity,
            evidence: field === 'transfer_fee_bps' ? feeEvidence : evidence,
            summary
        });
    };

    for (const [column, key] of AUTHORITY_FIELDS) {
        if (show(prev[key]) === show(next[key])) continue;
        emit('authority-key', column, prev[key], next[key], 'warning',
            `${label}: ${column} ${show(prev[key]) ?? 'none'} -> ${show(next[key]) ?? 'none'}`);
    }

    for (const [column, key] of TOGGLE_FIELDS) {
        if (show(prev[key]) === show(next[key])) continue;
        emit('extension-toggle', column, prev[key], next[key], 'warning',
            `${label}: ${column} ${show(prev[key]) ?? 'none'} -> ${show(next[key]) ?? 'none'}`);
    }

    if (show(prev.hookProgram) !== show(next.hookProgram)) {
        const wasSet = prev.hookProgram !== null && prev.hookProgram !== undefined;
        const isSet = next.hookProgram !== null && next.hookProgram !== undefined;
        const kind = wasSet && isSet ? 'authority-key' : 'extension-toggle';
        emit(kind, 'hook_program', prev.hookProgram, next.hookProgram, 'warning',
            `${label}: transfer hook ${isSet ? (wasSet ? 'program rotated' : 'switched on') : 'switched off'}`
            + ` (${show(prev.hookProgram) ?? 'none'} -> ${show(next.hookProgram) ?? 'none'})`);
    }

    // A rebase: the live multiplier moved, or a new one was scheduled. The severity comes from how
    // big the move is against the multiplier in force, so a 1:1 000 reverse split is not filed at
    // the same level as a 0.03 % accrual.
    if (show(prev.uiMultiplier) !== show(next.uiMultiplier)) {
        const ratio = ratioOf(prev.uiMultiplier, next.uiMultiplier);
        const severity = ratio !== null
            && (ratio >= THRESHOLDS.rebaseWarnRatioUp || ratio <= THRESHOLDS.rebaseWarnRatioDown)
            ? 'warning' : 'caution';
        emit('rebase', 'ui_multiplier', prev.uiMultiplier, next.uiMultiplier, severity,
            `${label}: scaled-UI multiplier ${show(prev.uiMultiplier)} -> ${show(next.uiMultiplier)}`
            + (ratio === null ? '' : ` (x${ratio.toPrecision(6)})`));
    }
    if (show(prev.uiMultiplierNext) !== show(next.uiMultiplierNext)) {
        const ratio = ratioOf(next.uiMultiplier ?? prev.uiMultiplier, next.uiMultiplierNext);
        const severity = ratio !== null
            && (ratio >= THRESHOLDS.rebaseWarnRatioUp || ratio <= THRESHOLDS.rebaseWarnRatioDown)
            ? 'warning' : 'caution';
        emit('rebase', 'ui_multiplier_next', prev.uiMultiplierNext, next.uiMultiplierNext, severity,
            `${label}: a multiplier of ${show(next.uiMultiplierNext)} is scheduled`
            + `${next.uiMultiplierEffectiveAt ? ` for ${next.uiMultiplierEffectiveAt}` : ''}`);
    }
    if (show(prev.uiMultiplierEffectiveAt) !== show(next.uiMultiplierEffectiveAt)) {
        emit('rebase', 'ui_multiplier_effective_at', prev.uiMultiplierEffectiveAt,
            next.uiMultiplierEffectiveAt, 'caution',
            `${label}: multiplier effective date ${show(prev.uiMultiplierEffectiveAt) ?? 'none'}`
            + ` -> ${show(next.uiMultiplierEffectiveAt) ?? 'none'}`);
    }

    // Supply: only past the threshold, because an ondo mint's supply moves with every subscription
    // and an event per basis point would be the whole feed.
    if (show(prev.supply) !== show(next.supply)) {
        const pct = movePct(prev.supply, next.supply);
        if (pct !== null && pct >= THRESHOLDS.supplyInfoPct) {
            const severity = pct >= THRESHOLDS.supplyCautionPct ? 'caution' : 'info';
            const grew = Number(next.supply) > Number(prev.supply);
            emit('supply', 'supply', prev.supply, next.supply, severity,
                `${label}: supply ${grew ? 'up' : 'down'} ${pct === Infinity ? 'from zero' : `${pct.toFixed(2)} %`}`
                + ` (${show(prev.supply)} -> ${show(next.supply)})`);
        }
    }

    // Metadata. A null -> hash transition is the first time we fetched the document, not a change
    // to it (DDL note on metadata_hash), so only a hash that actually moved is an event.
    if (show(prev.metadataUri) !== show(next.metadataUri)) {
        emit('metadata', 'metadata_uri', prev.metadataUri, next.metadataUri, 'caution',
            `${label}: metadata URI ${show(prev.metadataUri) ?? 'none'} -> ${show(next.metadataUri) ?? 'none'}`);
    }
    if (prev.metadataHash && next.metadataHash && prev.metadataHash !== next.metadataHash) {
        emit('metadata', 'metadata_hash', prev.metadataHash, next.metadataHash, 'caution',
            `${label}: the metadata JSON at ${show(next.metadataUri) ?? 'its URI'} changed`);
    }

    // Decimals cannot change on a Token-2022 mint. If one ever does, every balance in every wallet
    // has been re-denominated, which is a rebase by another name and the loudest thing this
    // watcher can say.
    if (show(prev.decimals) !== show(next.decimals)) {
        emit('rebase', 'decimals', prev.decimals, next.decimals, 'critical',
            `${label}: DECIMALS changed ${show(prev.decimals)} -> ${show(next.decimals)}`
            + ' — every balance has been re-denominated');
    }

    return events;
}

/**
 * One `info` event per issuer whose mints were read for the first time (EVIDENCE.md §2.4). Kind
 * `status` is the §3 kind for a statement about the subject rather than about a field of it; the
 * field says which watcher made it, so the Watch page can tell a baseline from a live/defunct flag.
 */
export function baselineEvents(firstSightMints, { detectedAt = null } = {}) {
    const byIssuer = new Map();
    for (const item of Array.isArray(firstSightMints) ? firstSightMints : []) {
        const issuer = item?.issuer ?? 'unattributed';
        if (!byIssuer.has(issuer)) byIssuer.set(issuer, []);
        byIssuer.get(issuer).push(item);
    }
    const at = normaliseTimestamp(detectedAt) ?? normaliseTimestamp(new Date());
    return [...byIssuer.entries()]
        .sort((a, b) => byString(a[0], b[0]))
        .map(([issuer, mints]) => ({
            detectedAt: at,
            kind: 'status',
            subjectType: 'issuer',
            subjectId: issuer,
            field: 'chain-watch',
            before: null,
            after: 'baseline',
            severity: 'info',
            evidence: {
                mints: mints.map((m) => m.mint).sort(byString).slice(0, 50),
                mintCount: mints.length,
                slot: mints[0]?.slot ?? null,
                observedAt: mints[0]?.observedAt ?? null,
                rpc: 'getMultipleAccounts'
            },
            summary: `baseline recorded: ${mints.length} mint(s) of ${issuer} read on chain for the`
                + ' first time — no change events until the next run'
        }));
}

// --- labelled wallets -----------------------------------------------------------------------

/**
 * address -> {wallet, label, issuer, mints} for every address this repo can name, built from the
 * labels lib/holders.mjs produced plus the onchain records that say which mints the address is an
 * authority for. `issuer` is the issuer the address is attributed to: the one the classify.mjs
 * tables name outright, else the issuer of the mints it controls when they agree, else 'shared' —
 * a key controlling two issuers' mints is attributed to neither rather than to the first one seen.
 */
export function buildWalletIndex(labels, onchainItems, issuerByKey = {}) {
    const index = new Map();
    const labelPairs = labels instanceof Map ? [...labels.entries()] : Object.entries(labels ?? {});
    for (const [wallet, label] of labelPairs) {
        if (typeof wallet !== 'string' || wallet === '') continue;
        index.set(wallet, { wallet, label, issuer: issuerByKey[wallet] ?? null, mints: [], named: Boolean(issuerByKey[wallet]) });
    }
    const AUTHORITY_KEYS = ['mintAuthority', 'freezeAuthority', 'permanentDelegateAddress',
        'metadataUpdateAuthority'];
    for (const item of Array.isArray(onchainItems) ? onchainItems : []) {
        for (const key of AUTHORITY_KEYS) {
            const wallet = stringOrNull(item?.[key]);
            if (wallet === null || !index.has(wallet)) continue;
            const entry = index.get(wallet);
            if (!entry.mints.includes(item.mint)) entry.mints.push(item.mint);
            if (!entry.named) {
                const issuer = stringOrNull(item.issuer);
                if (issuer !== null) {
                    if (entry.issuer === null) entry.issuer = issuer;
                    else if (entry.issuer !== issuer) entry.issuer = 'shared';
                }
            }
        }
    }
    for (const entry of index.values()) entry.mints.sort(byString);
    return index;
}

/**
 * The wallets a run actually reads, capped: each one costs a getTokenAccountsByOwner call, and the
 * repo can name 82 addresses while §2.4 budgets 40. Ranking is deterministic and defensible: an
 * address a dossier names outright (the burn address, the issuer keys in classify.mjs) first, then
 * by how many mints the address is an authority for — a key controlling 165 mints is the one whose
 * balance moving matters — then by address so a tie never depends on Map order.
 */
export function selectWatchedWallets(index, { limit = WALLET_LIMIT } = {}) {
    const entries = index instanceof Map ? [...index.values()] : Object.values(index ?? {});
    const ranked = entries.slice().sort((a, b) => {
        const named = Number(Boolean(b.named)) - Number(Boolean(a.named));
        if (named !== 0) return named;
        const mints = (b.mints?.length ?? 0) - (a.mints?.length ?? 0);
        if (mints !== 0) return mints;
        return byString(a.wallet, b.wallet);
    });
    return { watched: ranked.slice(0, limit), skipped: Math.max(0, ranked.length - limit) };
}

/**
 * Which mints' metadata JSON to fetch this run: the ones whose URI we have never hashed, and the
 * ones whose URI moved (the old hash describes a document that is no longer cited). Capped, and
 * ordered so a cold start works through the universe in a stable order instead of re-reading the
 * same 50.
 */
export function selectMetadataFetches(states, previousByMint, { limit = METADATA_LIMIT } = {}) {
    const out = [];
    for (const state of Array.isArray(states) ? states : []) {
        if (!state?.metadataUri) continue;
        const prev = previousByMint instanceof Map
            ? previousByMint.get(state.mint) ?? null
            : previousByMint?.[state.mint] ?? null;
        const uriMoved = prev !== null && show(prev.metadataUri) !== show(state.metadataUri);
        const never = !prev?.metadataHash;
        if (uriMoved || never) out.push({ mint: state.mint, uri: state.metadataUri, uriMoved });
    }
    out.sort((a, b) => Number(b.uriMoved) - Number(a.uriMoved) || byString(a.mint, b.mint));
    return out.slice(0, limit);
}

/**
 * Two readings of the labelled wallets -> `treasury` events (EVIDENCE.md §3). Both sides are
 * `{wallet, mint, label, amount, observedAt}` rows with `mint === null` for native SOL and `amount`
 * in UI units.
 *
 * A token position moving by 5 % is `info` and 25 % is `caution`; SOL is absolute (100 SOL), since
 * a percentage of a gas float says nothing, with `caution` when the move is that big AND a quarter
 * of the balance. A position appearing where there was none is a caution: a treasury wallet
 * receiving a token it never held is the interesting direction.
 */
export function walletMoves(prevBalances, nextBalances, { detectedAt = null, issuerByWallet = {} } = {}) {
    const key = (row) => `${row.wallet}|${row.mint ?? ''}`;
    const before = new Map();
    for (const row of Array.isArray(prevBalances) ? prevBalances : []) before.set(key(row), row);
    const events = [];

    for (const row of Array.isArray(nextBalances) ? nextBalances : []) {
        const prev = before.get(key(row)) ?? null;
        if (prev === null) continue; // first reading of this position: nothing has moved yet.
        const from = numericString(prev.amount);
        const to = numericString(row.amount);
        if (from === null || to === null || from === to) continue;

        const isSol = row.mint === null || row.mint === undefined;
        const pct = movePct(from, to);
        const delta = Math.abs(Number(to) - Number(from));
        const issuer = issuerByWallet[row.wallet] ?? null;
        let severity = null;
        if (isSol) {
            if (!Number.isFinite(delta) || delta < THRESHOLDS.solMove) continue;
            severity = pct !== null && pct >= THRESHOLDS.treasuryCautionPct ? 'caution' : 'info';
        } else {
            if (pct === null || pct < THRESHOLDS.treasuryInfoPct) continue;
            severity = pct >= THRESHOLDS.treasuryCautionPct ? 'caution' : 'info';
        }

        const at = normaliseTimestamp(detectedAt ?? row.observedAt) ?? row.observedAt ?? null;
        const moved = Number(to) > Number(from) ? 'in' : 'out';
        const size = pct === Infinity ? 'from zero' : `${pct.toFixed(2)} %`;
        events.push({
            detectedAt: at,
            kind: 'treasury',
            subjectType: isSol ? 'issuer' : 'token',
            subjectId: isSol ? (issuer ?? 'shared') : row.mint,
            field: `${isSol ? 'sol' : 'treasury'}:${row.wallet}`,
            before: from,
            after: to,
            severity,
            evidence: {
                account: row.wallet,
                mint: row.mint ?? null,
                label: row.label ?? null,
                observedAt: row.observedAt ?? null,
                previousObservedAt: prev.observedAt ?? null,
                rpc: isSol ? 'getMultipleAccounts' : 'getTokenAccountsByOwner'
            },
            summary: `${row.label ?? 'labelled wallet'} ${row.wallet.slice(0, 8)}…`
                + `: ${isSol ? 'SOL' : 'token'} moved ${moved} ${size}`
                + ` (${from} -> ${to}${isSol ? ' SOL' : ''})`
        });
    }
    return events;
}

// --- SQL -------------------------------------------------------------------------------------

const CAST = { text: '', int: '::int', bigint: '::bigint', numeric: '::numeric', bool: '::boolean', timestamptz: '::timestamptz' };

function selectExpression([column, jsKey, type]) {
    // Everything arrives as a jsonb string, so `->>` then a cast. jsonb's own number type is never
    // used: a u64 supply and a 15-digit multiplier both lose digits as a JSON number.
    return [column, `(r->>'${jsKey}')${CAST[type] ?? ''}`];
}

/**
 * Insert the states this run read. `ON CONFLICT DO NOTHING` rather than an upsert: a state row is
 * a READING and is never revised — a second run at the same observed_at read the same account at
 * the same instant, so there is nothing to update. The caller passes only states whose hash
 * differs from the latest stored one, so an unchanged mint touches nothing at all.
 */
export function buildMintStateSql(states, { tag = 'sonar' } = {}) {
    const items = Array.isArray(states) ? states : [];
    const columns = MINT_STATE_COLUMNS.map(selectExpression);
    const sql = `WITH doc AS (SELECT ${jsonbLiteral({ states: items }, tag)} AS d),\n`
        + "     src AS (SELECT DISTINCT ON (x.r->>'mint', x.r->>'observedAt') x.r\n"
        + "               FROM doc, jsonb_array_elements(d->'states') WITH ORDINALITY AS x(r, ord)\n"
        + "              ORDER BY x.r->>'mint', x.r->>'observedAt', x.ord DESC)\n"
        + `INSERT INTO sonar.mint_state (${MINT_STATE_COLUMNS.map(([c]) => c).join(', ')})\n`
        + `SELECT\n${columns.map(([c, expr]) => `       ${expr} AS ${c}`).join(',\n')}\n`
        + '  FROM src\n'
        + 'ON CONFLICT (mint, observed_at) DO NOTHING;\n';
    const keys = new Set(items.map((s) => `${s.mint}@${s.observedAt}`));
    return { table: 'sonar.mint_state', rows: keys.size, sql };
}

/** Insert the balance readings. Same reasoning as above: a reading is never revised. */
export function buildWalletBalanceSql(balances, { tag = 'sonar' } = {}) {
    const items = Array.isArray(balances) ? balances : [];
    const sql = `WITH doc AS (SELECT ${jsonbLiteral({ balances: items }, tag)} AS d),\n`
        + "     src AS (SELECT DISTINCT ON (x.r->>'wallet', coalesce(x.r->>'mint', ''), x.r->>'observedAt') x.r\n"
        + "               FROM doc, jsonb_array_elements(d->'balances') WITH ORDINALITY AS x(r, ord)\n"
        + "              ORDER BY x.r->>'wallet', coalesce(x.r->>'mint', ''), x.r->>'observedAt', x.ord DESC)\n"
        + 'INSERT INTO sonar.wallet_balance (wallet, mint, label, observed_at, amount)\n'
        + "SELECT r->>'wallet', r->>'mint', r->>'label', (r->>'observedAt')::timestamptz,\n"
        + "       (r->>'amount')::numeric\n"
        + '  FROM src\n'
        + "ON CONFLICT (wallet, coalesce(mint, ''), observed_at) DO NOTHING;\n";
    const keys = new Set(items.map((b) => `${b.wallet}|${b.mint ?? ''}@${b.observedAt}`));
    return { table: 'sonar.wallet_balance', rows: keys.size, sql };
}

/**
 * The latest stored state per mint, one JSON object per line. Every column is read back as TEXT
 * (`to_json(x)#>>'{}'` for a timestamptz, `::text` for a number): row_to_json would emit a numeric
 * as a JSON number, and `1.003376073740221` through a double and back is how a watcher invents a
 * change that never happened.
 */
export function buildLatestStateQuery() {
    const fields = MINT_STATE_COLUMNS.map(([column, jsKey, type]) => {
        if (type === 'timestamptz') return `'${jsKey}', to_json(s.${column})#>>'{}'`;
        if (type === 'bool') return `'${jsKey}', s.${column}`;
        return `'${jsKey}', s.${column}::text`;
    });
    return 'SELECT jsonb_build_object(\n'
        + `           ${fields.join(',\n           ')}\n`
        + '       )::text\n'
        + '  FROM (SELECT DISTINCT ON (mint) * FROM sonar.mint_state ORDER BY mint, observed_at DESC) s\n'
        + ' ORDER BY s.mint;\n';
}

/** The latest stored balance per (wallet, mint), one JSON object per line. */
export function buildLatestBalanceQuery() {
    return 'SELECT jsonb_build_object(\n'
        + "           'wallet', b.wallet, 'mint', b.mint, 'label', b.label,\n"
        + "           'observedAt', to_json(b.observed_at)#>>'{}', 'amount', b.amount::text\n"
        + '       )::text\n'
        + '  FROM (SELECT DISTINCT ON (wallet, coalesce(mint, \'\')) *\n'
        + '          FROM sonar.wallet_balance\n'
        + "         ORDER BY wallet, coalesce(mint, ''), observed_at DESC) b\n"
        + " ORDER BY b.wallet, coalesce(b.mint, '');\n";
}

/** psql -t -A output of one of the queries above -> the rows, with timestamps normalised. */
export function parseStateRows(text) {
    const out = [];
    for (const line of String(text ?? '').split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        const row = JSON.parse(trimmed);
        row.observedAt = normaliseTimestamp(row.observedAt);
        if ('uiMultiplierEffectiveAt' in row) {
            row.uiMultiplierEffectiveAt = normaliseTimestamp(row.uiMultiplierEffectiveAt);
        }
        if ('slot' in row) row.slot = intOrNull(row.slot);
        if ('decimals' in row) row.decimals = intOrNull(row.decimals);
        if ('transferFeeBps' in row) row.transferFeeBps = intOrNull(row.transferFeeBps);
        out.push(row);
    }
    return out;
}

// --- reporting -------------------------------------------------------------------------------

export const SEVERITY_ORDER = ['critical', 'warning', 'caution', 'info'];

export function countBy(events, field) {
    const counts = {};
    for (const event of Array.isArray(events) ? events : []) {
        const value = String(event?.[field] ?? 'unknown');
        counts[value] = (counts[value] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || byString(a[0], b[0])));
}

/** The three most severe events, worst first; ties keep the order they were detected in. */
export function topEvents(events, limit = 3) {
    const rank = new Map(SEVERITY_ORDER.map((s, i) => [s, i]));
    return (Array.isArray(events) ? events.slice() : [])
        .map((event, index) => ({ event, index }))
        .sort((a, b) => (rank.get(a.event.severity) ?? 99) - (rank.get(b.event.severity) ?? 99)
            || a.index - b.index)
        .slice(0, limit)
        .map(({ event }) => event);
}

/**
 * The one Telegram message a run is allowed to send (workspace convention: one summary per run,
 * never per item). Plain text, so a mint address with an underscore cannot break the formatting.
 */
export function formatTelegramSummary({ events = [], failures = [], mintsRead = 0, unchanged = 0,
    changed = 0, walletsRead = 0, metadataFetched = 0, durationMs = 0, host = null } = {}) {
    const byKind = countBy(events, 'kind');
    const bySeverity = countBy(events, 'severity');
    const lines = [`rwa-sonar chain watch: ${events.length} event(s), ${failures.length} failure(s)`];
    lines.push(`mints ${mintsRead} read · ${unchanged} unchanged · ${changed} changed`
        + ` · wallets ${walletsRead} · metadata ${metadataFetched}`
        + ` · ${(durationMs / 1000).toFixed(1)} s${host ? ` · ${host}` : ''}`);
    if (events.length) {
        lines.push(`severity: ${Object.entries(bySeverity).map(([k, v]) => `${k} ${v}`).join(', ')}`);
        lines.push(`kinds: ${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(', ')}`);
        for (const event of topEvents(events, 3)) {
            const who = event.evidence?.symbol ?? event.subjectId ?? '?';
            const issuer = event.evidence?.issuer ? ` (${event.evidence.issuer})` : '';
            lines.push(`- [${event.severity}] ${who}${issuer} ${event.field}:`
                + ` ${event.before ?? 'none'} -> ${event.after ?? 'none'}`);
        }
    }
    if (failures.length) {
        lines.push(`failures: ${failures.slice(0, 3).map((f) => f.reason ?? String(f)).join('; ')}`
            + `${failures.length > 3 ? ` …+${failures.length - 3}` : ''}`);
    }
    return lines.join('\n');
}
