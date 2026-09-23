// Pure shaping for the "Who can touch your tokens" power map (powers.html, stocks-power-map.json):
// one row per issuer programme, one cell per holder-affecting power, each saying WHO holds the
// power as the authority-attribution model resolves it (single key, multisig, program/PDA, none,
// unknown), the exact addresses read from the chain, and whether use of the power is on record.
// No governance is inferred here: the holder kind comes only from shapeAuthorityAttribution, and
// an address's on/off-curve reading is plain ed25519 arithmetic over the address itself.

import { shapeAuthorityAttribution } from './authority-attribution.mjs';

/**
 * The columns, in reading order. `model` is the authority-attribution capability id the holder is
 * taken from; `fallbackModel` is consulted only when the first one's controller is unknown (the
 * model keeps permanent delegate and clawback as two rows for one on-chain mechanism).
 */
export const POWERS = [
    { id: 'mint', model: 'mint', label: 'Mint new tokens', short: 'Mint' },
    { id: 'freeze', model: 'freeze', label: 'Freeze a holder account', short: 'Freeze' },
    { id: 'moveBurn', model: 'permanentDelegate', fallbackModel: 'clawback', label: 'Move or burn your tokens (permanent delegate / clawback)', short: 'Move / burn' },
    { id: 'pause', model: 'pause', label: 'Pause every transfer', short: 'Pause' },
    { id: 'rebase', model: 'rebase', label: 'Rebase displayed balances (UI multiplier)', short: 'Rebase' },
    { id: 'transferFee', model: 'transferFee', label: 'Set or withdraw a transfer fee', short: 'Fee' },
    { id: 'upgrade', model: 'upgrade', label: 'Upgrade the issuer programme', short: 'Upgrade' }
];

/** Holder kinds, most direct first. The page's legend and colours key on these ids. */
export const HOLDER_KINDS = ['single-key', 'multisig', 'program', 'none', 'unknown'];

// ---------------------------------------------------------------------------------------------
// ed25519: is a 32-byte address a curve point (a key someone can hold) or off-curve (a PDA)?
// ---------------------------------------------------------------------------------------------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const P = (1n << 255n) - 19n;

function modPow(base, exp, mod) {
    let result = 1n;
    let b = ((base % mod) + mod) % mod;
    let e = exp;
    while (e > 0n) {
        if (e & 1n) result = (result * b) % mod;
        b = (b * b) % mod;
        e >>= 1n;
    }
    return result;
}

const D = ((-121665n * modPow(121666n, P - 2n, P)) % P + P) % P;

/** Base58 → bytes, or null for anything that is not base58. */
export function base58Decode(text) {
    if (typeof text !== 'string' || text === '') return null;
    let value = 0n;
    for (const ch of text) {
        const digit = B58.indexOf(ch);
        if (digit < 0) return null;
        value = value * 58n + BigInt(digit);
    }
    const bytes = [];
    while (value > 0n) {
        bytes.unshift(Number(value & 0xffn));
        value >>= 8n;
    }
    for (const ch of text) {
        if (ch !== '1') break;
        bytes.unshift(0);
    }
    return Uint8Array.from(bytes);
}

/**
 * true when the address decompresses to an ed25519 point (so a private key for it can exist),
 * false when it does not (a program-derived address: no private key exists, only a program can
 * sign for it), null when it is not a 32-byte base58 address. Same test as Solana's
 * `Pubkey::is_on_curve`: y from the little-endian bytes with the sign bit cleared, and the point
 * exists iff (y² − 1)/(d·y² + 1) is a square mod p.
 */
export function isOnCurve(address) {
    const bytes = base58Decode(address);
    if (bytes === null || bytes.length !== 32) return null;
    let y = 0n;
    for (let i = 31; i >= 0; i -= 1) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
    y %= P;
    const y2 = (y * y) % P;
    const u = (y2 - 1n + P) % P;
    const v = (D * y2 + 1n) % P;
    if (v === 0n) return u === 0n;
    const ratio = (u * modPow(v, P - 2n, P)) % P;
    if (ratio === 0n) return true;
    return modPow(ratio, (P - 1n) / 2n, P) === 1n;
}

// ---------------------------------------------------------------------------------------------
// Chain facts per mint, from the raw jsonParsed getMultipleAccounts record fetch-onchain keeps
// ---------------------------------------------------------------------------------------------

function str(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * The authority addresses one parsed Token-2022 mint account names, per power, plus the few state
 * values that record a power's use. Every field is null when the account does not carry it.
 */
export function mintAuthorities(record) {
    const info = record?.account?.data?.parsed?.info;
    if (!info || typeof info !== 'object') return null;
    const ext = new Map((Array.isArray(info.extensions) ? info.extensions : [])
        .map((row) => [row?.extension, row?.state ?? {}]));
    const fee = ext.get('transferFeeConfig') ?? null;
    const scaled = ext.get('scaledUiAmountConfig') ?? null;
    const pausable = ext.get('pausableConfig') ?? null;
    // Token-2022 applies `newMultiplier` from its effective timestamp on, without rewriting
    // `multiplier`: the multiplier in force at read time is the new one once that time has passed.
    const readAt = Date.parse(str(record?._fetchedAt) ?? '') / 1000;
    const effectiveAt = Number(scaled?.newMultiplierEffectiveTimestamp);
    const switched = str(scaled?.newMultiplier) !== null && Number.isFinite(effectiveAt) && effectiveAt > 0
        && Number.isFinite(readAt) && effectiveAt <= readAt;
    const feeBps = Number.isFinite(fee?.newerTransferFee?.transferFeeBasisPoints) ? fee.newerTransferFee.transferFeeBasisPoints : null;
    return {
        fetchedAt: str(record?._fetchedAt),
        supply: str(info.supply),
        addresses: {
            mint: str(info.mintAuthority) === null ? [] : [{ address: info.mintAuthority, role: 'mint authority' }],
            freeze: str(info.freezeAuthority) === null ? [] : [{ address: info.freezeAuthority, role: 'freeze authority' }],
            moveBurn: str(ext.get('permanentDelegate')?.delegate) === null ? [] : [{ address: ext.get('permanentDelegate').delegate, role: 'permanent delegate' }],
            pause: str(pausable?.authority) === null ? [] : [{ address: pausable.authority, role: 'pause authority' }],
            rebase: str(scaled?.authority) === null ? [] : [{ address: scaled.authority, role: 'scaled-UI (multiplier) authority' }],
            transferFee: [
                ...(str(fee?.transferFeeConfigAuthority) === null ? [] : [{ address: fee.transferFeeConfigAuthority, role: 'fee-config authority' }]),
                ...(str(fee?.withdrawWithheldAuthority) === null ? [] : [{ address: fee.withdrawWithheldAuthority, role: 'withheld-fee withdraw authority' }])
            ],
            upgrade: []
        },
        paused: typeof pausable?.paused === 'boolean' ? pausable.paused : null,
        multiplier: switched ? scaled.newMultiplier : str(scaled?.multiplier),
        multiplierPending: str(scaled?.newMultiplier) !== null && Number.isFinite(effectiveAt) && effectiveAt > 0 && !switched
            && Number(scaled.newMultiplier) !== Number(scaled.multiplier) ? scaled.newMultiplier : null,
        feeBps,
        withheldAmount: Number.isFinite(fee?.withheldAmount) ? fee.withheldAmount : null
    };
}

// ---------------------------------------------------------------------------------------------
// One cell
// ---------------------------------------------------------------------------------------------

function modelRow(model, id) {
    return model.authorities.find((row) => row.id === id) ?? null;
}

/** all / some / none / unobserved, over the issuer's tokens' technical capability for one power. */
export function capabilityOver(rows) {
    const total = rows.length;
    const present = rows.filter((value) => value === 'present').length;
    const absent = rows.filter((value) => value === 'absent').length;
    let state;
    if (total === 0) state = 'unobserved';
    else if (present === total) state = 'all';
    else if (present > 0) state = 'some';
    else if (absent === total) state = 'none';
    else state = 'unknown';
    return { state, present, absent, unknown: total - present - absent, total };
}

/**
 * The holder kind for one power. A capability observed absent on every mint is `none` whatever
 * the governance label; otherwise the model's resolved governance type decides, and anything it
 * does not establish stays `unknown`. A 1-of-n multisig is a single key (one member can act), and
 * a program whose upgrade key is one signer already arrives here resolved to that signer.
 */
export function holderKind(capabilityState, governanceType) {
    if (capabilityState === 'none') return 'none';
    if (governanceType === 'none') return 'none';
    if (governanceType === 'hot-key' || governanceType === 'single-signer-multisig') return 'single-key';
    if (governanceType === 'multisig') return 'multisig';
    if (governanceType === 'program') return 'program';
    return 'unknown';
}

/**
 * The execution delay a reviewed technical note states, as `{seconds, phrase}` — 0 for "zero
 * execution timelock" / "no timelock" / "no multisig or timelock" — or null when the note states
 * none. Only the FIRST stated timelock is read: a note that goes on to describe a second vault
 * (Ondo's mint note names the 900 s minting vault, then the 7,200 s upgrade vault) leads with the
 * one that governs the power it is attached to. The phrase is kept so the page can quote it.
 */
export function timelockFrom(text) {
    if (typeof text !== 'string') return null;
    const match = /(\d[\d,]*)-second timelock|\b(zero|no)\b[^.;]{0,20}\btimelock/i.exec(text);
    if (!match) return null;
    const seconds = match[1] !== undefined ? Number(match[1].replace(/,/g, '')) : 0;
    return Number.isFinite(seconds) ? { seconds, phrase: match[0].trim() } : null;
}

/** Distinct addresses with how many of the issuer's mints name each, most-named first. */
export function tallyAddresses(perMint, limit = 6) {
    const counts = new Map();
    for (const list of perMint) {
        for (const { address, role } of list) {
            const key = `${address}\u0000${role}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
    }
    const rows = [...counts.entries()].map(([key, mints]) => {
        const [address, role] = key.split('\u0000');
        return { address, role, mints, onCurve: isOnCurve(address) };
    }).sort((a, b) => b.mints - a.mints || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
    return { distinct: rows.length, shown: rows.slice(0, limit) };
}

function finding(issuer, schema) {
    const row = (Array.isArray(issuer?.findings) ? issuer.findings : []).find((entry) => entry?.schema === schema);
    if (!row) return null;
    return {
        schema,
        statement: str(row.statement),
        evidence: str(row.evidence),
        observedAt: str(row.observedAt)
    };
}

/**
 * Whether a power's use is on record. `recorded` = a dossier finding says it was exercised;
 * `effect-observed` = the chain read shows its effect now (a multiplier other than 1, a paused
 * mint, a non-zero fee or withheld fees, supply that was minted); `not-recorded` otherwise. Never
 * "never used": the absence of a record is not evidence of no use.
 */
export function usageFor(powerId, issuer, chain) {
    const n = chain.length;
    const count = (predicate) => chain.filter(predicate).length;
    const effects = [];
    let recorded = null;
    if (powerId === 'freeze') recorded = finding(issuer, 'freeze-authority-has-been-exercised');
    if (powerId === 'pause') {
        recorded = finding(issuer, 'issuer-paused-trading-for-session');
        const paused = count((row) => row.paused === true);
        if (paused > 0) effects.push(`paused now on ${paused} of ${n} mints`);
    }
    if (powerId === 'transferFee') {
        recorded = finding(issuer, 'transfer-fee-charged-on-chain');
        const charging = count((row) => Number.isFinite(row.feeBps) && row.feeBps > 0);
        if (charging > 0) effects.push(`a non-zero fee is configured on ${charging} of ${n} mints`);
        const withheld = count((row) => Number.isFinite(row.withheldAmount) && row.withheldAmount > 0);
        if (withheld > 0) effects.push(`fees are withheld on ${withheld} of ${n} mints`);
    }
    if (powerId === 'rebase') {
        const moved = count((row) => row.multiplier !== null && Number(row.multiplier) !== 1);
        if (moved > 0) effects.push(`the balance multiplier in force is not 1 on ${moved} of ${n} mints`);
        const pending = count((row) => row.multiplierPending != null);
        if (pending > 0) effects.push(`a multiplier change is scheduled on ${pending} of ${n} mints`);
    }
    if (powerId === 'mint') {
        const minted = count((row) => row.supply !== null && row.supply !== '0');
        if (minted > 0) effects.push(`supply has been minted on ${minted} of ${n} mints`);
    }
    const state = recorded !== null ? 'recorded' : effects.length > 0 ? 'effect-observed' : 'not-recorded';
    return { state, finding: recorded, effects };
}

/**
 * MODEL.md §2.7's rule, applied from the chain: where an unknown power's authority IS, on every
 * mint that carries it, the same address as a power whose holder is known, it inherits that
 * holder. Only when every such matching power agrees on the kind; a disagreement (one address,
 * two characterisations — e.g. a programme PDA signing on behalf of a separately governed role)
 * leaves the cell unknown, with the matches recorded so the page can say why.
 */
export function inheritSharedAddresses(cells, chain) {
    const byPower = new Map(cells.map((cell) => [cell.power, cell]));
    return cells.map((cell) => {
        if (cell.kind !== 'unknown') return cell;
        const carrying = chain.filter((entry) => (entry.addresses[cell.power] ?? []).length > 0);
        if (carrying.length === 0) return cell;
        const matches = [];
        for (const other of cells) {
            if (other.power === cell.power || other.inheritedFrom) continue;
            const same = carrying.every((entry) => {
                const theirs = new Set((entry.addresses[other.power] ?? []).map((row) => row.address));
                return entry.addresses[cell.power].every((row) => theirs.has(row.address));
            });
            if (same) matches.push(other.power);
        }
        const known = matches.map((power) => byPower.get(power)).filter((other) => ['single-key', 'multisig', 'program'].includes(other.kind));
        const kinds = [...new Set(known.map((other) => other.kind))];
        if (kinds.length !== 1) return { ...cell, sameAddressAs: matches };
        return { ...cell, kind: kinds[0], inheritedFrom: known[0].power, sameAddressAs: matches };
    });
}

function fetchedRange(chain) {
    const times = chain.map((row) => row.fetchedAt).filter((value) => value !== null).sort();
    return times.length === 0 ? null : { from: times[0], to: times[times.length - 1] };
}

/** One issuer row: every power's cell, the links, and the evidence the governance rests on. */
export function shapeIssuerRow(issuer, tokens, chainByMint) {
    const own = tokens.filter((token) => token?.issuer === issuer.slug);
    const perToken = own.map((token) => shapeAuthorityAttribution({ token, issuer }));
    const issuerModel = shapeAuthorityAttribution({ token: null, issuer });
    const chain = own.map((token) => chainByMint.get(token.mint)).filter(Boolean);
    const cells = POWERS.map((power) => {
        let row = modelRow(issuerModel, power.model);
        let modelId = power.model;
        if (row?.governance.type === 'unknown' && power.fallbackModel) {
            const alt = modelRow(issuerModel, power.fallbackModel);
            if (alt && alt.governance.type !== 'unknown') { row = alt; modelId = power.fallbackModel; }
        }
        const capability = capabilityOver(perToken.map((model) => modelRow(model, modelId)?.technicalCapability ?? 'unknown'));
        const governance = row?.governance ?? null;
        const kind = holderKind(capability.state, governance?.type ?? 'unknown');
        return {
            power: power.id,
            modelId,
            kind,
            governanceType: governance?.type ?? 'unknown',
            viaProgramUpgrade: governance?.viaProgramUpgrade === true,
            capability,
            controller: governance?.controller ?? null,
            signerThreshold: governance?.signerThreshold ?? null,
            upgradeAuthority: governance?.upgradeAuthority ?? null,
            upgradeGovernance: governance?.upgradeGovernance ?? null,
            observedAt: governance?.observedAt ?? null,
            lastRotatedAt: governance?.lastRotatedAt ?? null,
            source: governance?.source ?? null,
            technicalNotes: governance?.technicalNotes ?? null,
            timelock: timelockFrom(governance?.technicalNotes ?? null),
            contractualCircumstances: governance?.contractualCircumstances ?? null,
            addresses: tallyAddresses(chain.map((entry) => entry.addresses[power.id] ?? [])),
            usage: usageFor(power.id, issuer, chain),
            inheritedFrom: null,
            sameAddressAs: []
        };
    });
    return {
        slug: issuer.slug,
        name: str(issuer.name) ?? issuer.slug,
        status: str(issuer.status),
        mints: own.length,
        mintsRead: chain.length,
        chainReadAt: fetchedRange(chain),
        governanceEvidence: str(issuer.keyGovernance?.evidence ?? issuer.control?.keyGovernance?.evidence),
        authorityFactsSource: str(issuer.authorityFactsSource),
        cells: inheritSharedAddresses(cells, chain)
    };
}

/** Kind counts over every cell of every row, for the headline line. */
export function kindCounts(rows) {
    const counts = Object.fromEntries(HOLDER_KINDS.map((kind) => [kind, 0]));
    for (const row of rows) for (const cell of row.cells) counts[cell.kind] += 1;
    return counts;
}

/** The whole map. `raw` is the jsonParsed getMultipleAccounts file ({accounts: {mint: record}}). */
export function buildPowerMap({ issuersDb, tokensDb, onchain, raw, builtAt }) {
    const issuers = Array.isArray(issuersDb?.issuers) ? issuersDb.issuers : [];
    const tokens = Array.isArray(tokensDb?.tokens) ? tokensDb.tokens : [];
    const chainByMint = new Map();
    for (const [mint, record] of Object.entries(raw?.accounts ?? {})) {
        const shaped = mintAuthorities(record);
        if (shaped !== null) chainByMint.set(mint, shaped);
    }
    const rows = issuers.map((issuer) => shapeIssuerRow(issuer, tokens, chainByMint))
        .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    return {
        builtAt,
        sources: {
            issuers: { file: 'stocks-issuers.json', builtAt: str(issuersDb?.builtAt) },
            tokens: { file: 'stocks-tokens.json', builtAt: str(tokensDb?.builtAt) },
            chain: {
                file: str(onchain?.source?.rawFile) === null ? null : `stocks/data/raw/${onchain.source.rawFile}`,
                fetchedAt: str(onchain?.fetchedAt),
                rpc: str(onchain?.source?.rpc),
                method: str(onchain?.source?.method),
                mintsRead: chainByMint.size
            }
        },
        powers: POWERS.map(({ id, label, short }) => ({ id, label, short })),
        kinds: HOLDER_KINDS,
        counts: kindCounts(rows),
        issuers: rows
    };
}
