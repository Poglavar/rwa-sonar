// PURE logic for the on-chain DeFi footprint scanner (stocks/fetch-defi-footprint.mjs): which
// PROGRAMS hold each tracked stock, attributed through a curated program registry, and which of
// those holdings are integrations we do not yet collect. No network, fs or clock here, so every
// rule — wallet vs program, candidate thresholds, the diff that must never turn a failed read into
// a removal — is unit-tested in stocks/defi-footprint.test.js.
//
// The chain is the most reliable discovery source because a protocol cannot use a token without a
// token account the token program records: whatever a registry or announcement says, the balance
// has to sit in an account owned by a wallet, a program-owned data account, or a program-derived
// address (PDA). The largest accounts are where integrations show up first.

import { addressBytes, findProgramAddress, isOnCurve } from './solana-address.mjs';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const CANDIDATE_MIN_SHARE_PCT = 0.5;
export const CANDIDATE_MIN_USD = 10_000;
/** Categories whose holdings are DeFi integrations; custody and plumbing never become candidates. */
export const DEFI_CATEGORIES = new Set(['lending', 'dex', 'perps', 'yield-vault', 'vault-strategy', 'structured', 'bridge']);
export const FOOTPRINT_EVENT_KINDS = [
    { id: 'defi-integration-added', label: 'Protocol newly holds token (on-chain)', severity: 'info' },
    { id: 'defi-integration-candidate', label: 'Unknown program holds token (candidate)', severity: 'caution' },
    { id: 'defi-integration-removed', label: 'Protocol no longer holds a visible balance (on-chain)', severity: 'warning' }
];

function text(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function round(value, digits = 6) {
    return finite(value) === null ? null : Number(value.toFixed(digits));
}

function safeOnCurve(address) {
    try {
        return isOnCurve(address);
    } catch {
        return null;
    }
}

export function slugify(label) {
    return String(label ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

/**
 * Index the curated registry: programs and fixed addresses by address. Throws on duplicates.
 * `externalLabels` ({programId: label}, e.g. Jupiter's keyless program-id-to-label map of every
 * DEX it routes through) fill in programs the curated file does not list, as `dex` with
 * verification `jupiter-program-label` — the curated entry always wins.
 */
export function indexRegistry(registry, { externalLabels = null } = {}) {
    const programs = new Map();
    for (const row of Array.isArray(registry?.programs) ? registry.programs : []) {
        const id = text(row?.programId);
        if (!id) continue;
        if (programs.has(id)) throw new Error(`defi program registry lists ${id} twice`);
        programs.set(id, row);
    }
    for (const [programId, label] of Object.entries(externalLabels ?? {})) {
        if (programs.has(programId) || !text(label)) continue;
        const protocolId = slugify(label);
        programs.set(programId, { programId, protocolId, protocolName: label, category: 'dex', usageProtocolIds: [protocolId], verification: 'jupiter-program-label' });
    }
    const addresses = new Map();
    for (const row of Array.isArray(registry?.knownAddresses) ? registry.knownAddresses : []) {
        const address = text(row?.address);
        if (!address) continue;
        if (addresses.has(address)) throw new Error(`defi program registry lists known address ${address} twice`);
        addresses.set(address, row);
    }
    return { programs, addresses };
}

/**
 * Authority PDAs a registry lets us derive locally, e.g. every Kamino lending market's
 * lending-market-authority (seeds ["lma", market]) which owns that market's reserve vaults. A market
 * list that failed to load yields none — attribution then falls back to the owner program or a
 * transaction lookup, never to a guess.
 */
export function deriveAuthorities(derivations, marketsBySource) {
    const out = new Map();
    for (const rule of Array.isArray(derivations) ? derivations : []) {
        const markets = marketsBySource?.[rule?.marketsFrom] ?? [];
        for (const market of markets) {
            const marketAddress = text(market?.address);
            if (!marketAddress) continue;
            const seeds = (rule.seeds ?? []).map((seed) => (seed === '$market' ? addressBytes(marketAddress) : seed));
            const { address } = findProgramAddress(seeds, rule.programId);
            out.set(address, {
                programId: rule.programId,
                role: rule.role ?? 'market-authority',
                market: { address: marketAddress, name: text(market?.name) }
            });
        }
    }
    return out;
}

/**
 * Who stands behind one token-account owner. `ownerAccount` is the getMultipleAccounts result for
 * the OWNER address (null when it has no account). Order: curated address → derived authority →
 * the program that owns the owner's data account → wallet key (on the curve) → PDA, resolved from
 * a transaction when a resolution is cached, else left unresolved.
 */
export function classifyOwner({ owner, ownerAccount, index, authorities = new Map(), pdaResolutions = {} }) {
    const known = index.addresses.get(owner);
    if (known) {
        return { kind: 'known-address', programId: text(known.programId), via: 'curated-address', label: text(known.label), role: text(known.role), knownAddress: known };
    }
    const derived = authorities.get(owner);
    if (derived) return { kind: 'program', programId: derived.programId, via: 'derived-authority', role: derived.role, market: derived.market };
    const accountOwner = text(ownerAccount?.owner);
    if (ownerAccount && accountOwner && accountOwner !== SYSTEM_PROGRAM) {
        return { kind: 'program', programId: accountOwner, via: 'owner-account-program' };
    }
    const onCurve = safeOnCurve(owner);
    if (onCurve === true) return { kind: 'wallet', programId: null, via: 'on-curve-key' };
    const resolved = pdaResolutions?.[owner];
    // An inflow-only resolution naming a router/aggregator identifies who deposited, not who owns.
    const weakRouter = resolved?.basis === 'incoming-transfer-caller' && index.programs.get(resolved.programId)?.category === 'aggregator';
    if (text(resolved?.programId) && !weakRouter) {
        return { kind: 'program', programId: resolved.programId, via: 'transaction-resolved', resolution: resolved };
    }
    return { kind: 'unresolved-pda', programId: null, via: onCurve === false ? 'off-curve-unresolved' : 'invalid-address' };
}

function attribution(classification, index) {
    const program = classification.programId ? index.programs.get(classification.programId) : null;
    const knownAddress = classification.knownAddress ?? null;
    const source = knownAddress ?? program;
    return {
        programId: classification.programId ?? null,
        protocolId: text(source?.protocolId),
        protocolName: text(source?.protocolName) ?? text(program?.protocolName),
        component: text(source?.component) ?? text(program?.component),
        category: text(source?.category) ?? text(program?.category) ?? null,
        usageProtocolIds: [...new Set([...(knownAddress?.usageProtocolIds ?? []), ...(program?.usageProtocolIds ?? [])])],
        known: Boolean(source),
        via: classification.via
    };
}

/** Everything integrations.json already lists for one mint: protocol ids and Kamino market addresses. */
export function listedIndex(usage) {
    const byMint = new Map();
    for (const item of Array.isArray(usage?.items) ? usage.items : []) {
        const protocols = new Set();
        const markets = new Set();
        for (const integration of item.integrations ?? []) {
            if (text(integration?.protocolId)) protocols.add(integration.protocolId);
            for (const market of integration.markets ?? []) {
                for (const key of ['marketAddress', 'address', 'vaultAddress', 'bankAddress', 'loanAddress']) {
                    if (text(market?.[key])) markets.add(market[key]);
                }
            }
            for (const leg of integration.route ?? []) {
                if (text(leg?.marketAddress)) markets.add(leg.marketAddress);
                if (text(leg?.protocolId)) protocols.add(leg.protocolId);
            }
        }
        byMint.set(item.mint, { protocols, markets });
    }
    return byMint;
}

/**
 * Shape one mint's holdings into per-program rows. `accounts` are `{tokenAccount, owner, amountUi,
 * sharePct}`; wallets are summarised, never listed (they are people, not integrations).
 */
export function mintFootprint({ token, read, accounts, ownerAccounts, index, authorities, pdaResolutions, listed }) {
    const priceUsd = finite(token?.market?.usdPrice);
    const groups = new Map();
    const wallets = { accounts: 0, sharePct: 0, amountUi: 0 };
    const unresolved = [];
    for (const row of Array.isArray(accounts) ? accounts : []) {
        const owner = text(row?.owner);
        if (!owner) continue;
        const classification = classifyOwner({ owner, ownerAccount: ownerAccounts.get(owner) ?? null, index, authorities, pdaResolutions });
        if (classification.kind === 'wallet') {
            wallets.accounts += 1;
            wallets.sharePct += finite(row.sharePct) ?? 0;
            wallets.amountUi += finite(row.amountUi) ?? 0;
            continue;
        }
        if (classification.kind === 'unresolved-pda') {
            unresolved.push({ owner, tokenAccount: row.tokenAccount, amountUi: finite(row.amountUi), sharePct: finite(row.sharePct) });
        }
        const who = classification.kind === 'unresolved-pda'
            ? { programId: null, protocolId: null, protocolName: null, component: null, category: null, usageProtocolIds: [], known: false, via: classification.via }
            : attribution(classification, index);
        const marketAddress = classification.market?.address ?? null;
        const key = `${who.programId ?? `pda:${owner}`}|${marketAddress ?? ''}`;
        if (!groups.has(key)) {
            groups.set(key, {
                key, ...who,
                owner: who.programId ? null : owner,
                market: classification.market ?? null,
                label: classification.label ?? null,
                resolutionBasis: classification.resolution?.basis ?? null,
                tokenAccounts: [], owners: new Set(), amountUi: 0, sharePct: 0
            });
        }
        const group = groups.get(key);
        group.tokenAccounts.push(row.tokenAccount);
        group.owners.add(owner);
        group.amountUi += finite(row.amountUi) ?? 0;
        group.sharePct += finite(row.sharePct) ?? 0;
    }
    const programs = [...groups.values()].map((group) => {
        const usd = priceUsd === null ? null : group.amountUi * priceUsd;
        const isDefi = group.known && DEFI_CATEGORIES.has(group.category);
        const listedHere = listed?.get(token.mint);
        const listedInUsage = isDefi && Boolean(listedHere) && (group.market?.address
            ? listedHere.markets.has(group.market.address)
            : group.usageProtocolIds.some((id) => listedHere.protocols.has(id)));
        return {
            key: group.key,
            programId: group.programId,
            protocolId: group.protocolId,
            protocolName: group.protocolName,
            component: group.component,
            category: group.category,
            known: group.known,
            defi: isDefi,
            via: group.via,
            // 'incoming-transfer-caller' = attributed only from the program that deposited; weaker.
            resolutionBasis: group.resolutionBasis,
            market: group.market,
            label: group.label,
            unresolvedOwner: group.owner,
            owners: [...group.owners].sort(),
            tokenAccounts: group.tokenAccounts.sort(),
            amountUi: round(group.amountUi, 9),
            sharePct: round(group.sharePct, 6),
            usd: round(usd, 2),
            listedInUsage
        };
    }).sort((a, b) => (b.sharePct ?? 0) - (a.sharePct ?? 0) || String(a.key).localeCompare(String(b.key)));
    const amounts = (Array.isArray(accounts) ? accounts : []).map((row) => finite(row?.amountUi)).filter((value) => value !== null);
    return {
        mint: token.mint,
        symbol: text(token.symbol),
        issuer: text(token.issuer),
        read,
        accountsSeen: amounts.length,
        // Top-N only: an account smaller than the smallest one returned is invisible. With fewer
        // than 20 returned the view is complete, so the floor is zero.
        visibilityFloorUi: amounts.length >= 20 ? Math.min(...amounts) : 0,
        wallets: { accounts: wallets.accounts, sharePct: round(wallets.sharePct, 6), amountUi: round(wallets.amountUi, 9) },
        programs,
        unresolved
    };
}

function aboveThreshold(row, { minSharePct = CANDIDATE_MIN_SHARE_PCT, minUsd = CANDIDATE_MIN_USD } = {}) {
    return (finite(row?.sharePct) ?? 0) >= minSharePct || (finite(row?.usd) ?? 0) >= minUsd;
}

/**
 * Review candidates: an UNKNOWN program (or unresolved PDA) holding a tracked stock above the
 * threshold, and a KNOWN DeFi protocol holding a stock our registry collection does not list for
 * that protocol/market. Custody, bridges' escrow and plumbing are known but never candidates.
 */
export function footprintCandidates(items, thresholds = {}) {
    const out = [];
    for (const item of Array.isArray(items) ? items : []) {
        if (item?.read?.status !== 'ok') continue;
        for (const row of item.programs ?? []) {
            if (!aboveThreshold(row, thresholds)) continue;
            let reason = null;
            if (!row.known) reason = row.programId ? 'unknown-program' : 'unresolved-pda';
            else if (row.defi && !row.listedInUsage) reason = 'unlisted-integration';
            if (!reason) continue;
            out.push({
                id: `${item.mint}|${row.key}`,
                reason,
                mint: item.mint,
                symbol: item.symbol,
                issuer: item.issuer,
                programId: row.programId,
                protocolId: row.protocolId,
                protocolName: row.protocolName,
                category: row.category,
                market: row.market,
                via: row.via,
                resolutionBasis: row.resolutionBasis ?? null,
                owners: row.owners,
                tokenAccounts: row.tokenAccounts,
                amountUi: row.amountUi,
                sharePct: row.sharePct,
                usd: row.usd,
                observedAt: item.read.observedAt ?? null,
                summary: candidateSummary(reason, item, row)
            });
        }
    }
    return out.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0) || (b.sharePct ?? 0) - (a.sharePct ?? 0) || a.id.localeCompare(b.id));
}

function money(value) {
    return finite(value) === null ? 'value unknown' : `$${Math.round(value).toLocaleString('en-US')}`;
}

function candidateSummary(reason, item, row) {
    const who = item.symbol ?? item.mint;
    const share = finite(row.sharePct) === null ? '' : ` (${row.sharePct.toFixed(2)}% of supply, ${money(row.usd)})`;
    if (reason === 'unknown-program') return `Program ${row.programId} holds ${who}${share}; it is not in the protocol registry.`;
    if (reason === 'unresolved-pda') return `A program-derived address ${row.unresolvedOwner} holds ${who}${share}; its program is not yet resolved.`;
    const market = row.market?.name ? ` market "${row.market.name}" (${row.market.address})` : '';
    const weak = row.resolutionBasis === 'incoming-transfer-caller' ? ' Attribution rests only on the program that deposited into the account (weaker evidence).' : '';
    return `${row.protocolName ?? row.protocolId}${market} holds ${who}${share}, but no collected registry lists this exact use.${weak}`;
}

/**
 * Compact, diffable daily form of the footprint (committed per day, so kept small): every mint's
 * read status and visibility floor, plus only the holdings a diff can act on — known DeFi
 * protocols and unattributed programs. Wallets, custody and plumbing are left out.
 */
export function snapshotFootprint(footprint) {
    const reads = {};
    const holdings = [];
    const minor = {};
    for (const item of footprint?.items ?? []) {
        // [status, visibility floor, symbol, issuer] — an array because this map has one entry per mint.
        reads[item.mint] = [item.read?.status ?? 'not-scanned', item.visibilityFloorUi ?? null, item.symbol ?? null, item.issuer ?? null];
        for (const row of item.programs ?? []) {
            if (!row.defi && row.known) continue;
            // Below the threshold only the key is kept: enough to know tomorrow that a holding that
            // crossed the threshold existed before (growth, not a new integration).
            if (!aboveThreshold(row)) {
                (minor[item.mint] ??= []).push(row.key);
                continue;
            }
            holdings.push({
                mint: item.mint, key: row.key, programId: row.programId, protocolId: row.protocolId, protocolName: row.protocolName,
                category: row.category, known: row.known, defi: row.defi,
                ...(row.market ? { market: row.market } : {}),
                amountUi: row.amountUi, sharePct: row.sharePct === null ? null : Number(row.sharePct.toFixed(4)),
                usd: row.usd === null ? null : Math.round(row.usd), listedInUsage: row.listedInUsage
            });
        }
    }
    return { fetchedAt: footprint?.fetchedAt ?? null, reads, holdings, minor };
}

/**
 * Compare two footprint snapshots. A mint whose read was not `ok` on EITHER side produces no event:
 * a failed or skipped read is never a removal (nor an addition). A removal also needs the old
 * holding to be large enough that it would still be visible in today's top accounts; otherwise
 * "not seen" only means "not among the largest", which says nothing.
 */
export function diffFootprints(previous, current, thresholds = {}) {
    const counts = Object.fromEntries(FOOTPRINT_EVENT_KINDS.map(({ id }) => [id, 0]));
    const result = { from: previous?.date ?? null, to: current?.date ?? null, counts, unreadMints: 0, events: [] };
    if (!previous || !current) return result;
    const severity = new Map(FOOTPRINT_EVENT_KINDS.map((kind) => [kind.id, kind.severity]));
    const group = (snapshot) => {
        const byMint = new Map();
        for (const row of snapshot.holdings ?? []) {
            if (!byMint.has(row.mint)) byMint.set(row.mint, new Map());
            byMint.get(row.mint).set(row.key, row);
        }
        return byMint;
    };
    const oldByMint = group(previous);
    const newByMint = group(current);
    const readOf = (value) => (Array.isArray(value) ? { status: value[0], floor: value[1], symbol: value[2], issuer: value[3] } : value ?? null);
    for (const [mint, raw] of Object.entries(current.reads ?? {})) {
        const read = readOf(raw);
        const oldRead = readOf(previous.reads?.[mint]);
        if (!oldRead || oldRead.status !== 'ok' || read.status !== 'ok') {
            result.unreadMints += 1;
            continue;
        }
        const oldRows = oldByMint.get(mint) ?? new Map();
        const newRows = newByMint.get(mint) ?? new Map();
        const oldMinor = new Set(previous.minor?.[mint] ?? []);
        const base = (row) => ({
            mint, symbol: read.symbol ?? null, issuer: read.issuer ?? null,
            programId: row.programId, protocolId: row.protocolId ?? null,
            protocolName: row.protocolName ?? row.protocolId ?? row.programId ?? 'Unresolved program',
            category: row.category ?? null, market: row.market ?? null, detectedBy: 'chain'
        });
        const who = read.symbol ?? mint;
        for (const [key, row] of newRows) {
            if (oldRows.has(key) || oldMinor.has(key) || !aboveThreshold(row, thresholds)) continue;
            if (row.defi) {
                result.events.push({ kind: 'defi-integration-added', severity: severity.get('defi-integration-added'), ...base(row),
                    before: null, after: { amountUi: row.amountUi, sharePct: row.sharePct, usd: row.usd },
                    listedInUsage: row.listedInUsage === true,
                    summary: `${who} is now held by ${row.protocolName ?? row.protocolId}${row.market?.name ? ` (${row.market.name})` : ''} on-chain: ${row.amountUi} tokens, ${money(row.usd)}.` });
            } else if (!row.known) {
                result.events.push({ kind: 'defi-integration-candidate', severity: severity.get('defi-integration-candidate'), ...base(row),
                    before: null, after: { amountUi: row.amountUi, sharePct: row.sharePct, usd: row.usd },
                    summary: `An unregistered program ${row.programId ?? '(unresolved PDA)'} now holds ${who}: ${row.amountUi} tokens, ${money(row.usd)}. Needs review.` });
            }
        }
        const floor = finite(read.floor) ?? 0;
        for (const [key, row] of oldRows) {
            if (newRows.has(key) || !row.defi || !aboveThreshold(row, thresholds)) continue;
            if ((finite(row.amountUi) ?? 0) <= floor) continue;
            result.events.push({ kind: 'defi-integration-removed', severity: severity.get('defi-integration-removed'), ...base(row),
                before: { amountUi: row.amountUi, sharePct: row.sharePct, usd: row.usd }, after: null,
                summary: `${row.protocolName ?? row.protocolId}${row.market?.name ? ` (${row.market.name})` : ''} no longer holds a visible ${who} balance; it held ${row.amountUi} before, and anything above ${floor} would have been seen.` });
        }
    }
    const order = new Map(FOOTPRINT_EVENT_KINDS.map((kind, i) => [kind.id, i]));
    result.events.sort((a, b) => order.get(a.kind) - order.get(b.kind) || String(a.symbol).localeCompare(String(b.symbol)) || String(a.programId).localeCompare(String(b.programId)));
    for (const event of result.events) counts[event.kind] += 1;
    return result;
}

const INFRASTRUCTURE = new Set([
    SYSTEM_PROGRAM,
    'ComputeBudget111111111111111111111111111111',
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
]);

/**
 * Which program moved tokens in or out of `tokenAccount` in one jsonParsed transaction. A token
 * account owned by a PDA can only send tokens when its owning program signs by CPI, so the
 * parent program of an OUTGOING transfer is the owner; the parent of an incoming one is weaker
 * evidence (the depositing program), kept separately. Top-level transfers have no program parent.
 */
export function transferParents(tx, tokenAccount) {
    const outflow = new Set();
    const inflow = new Set();
    const message = tx?.transaction?.message;
    const inner = Array.isArray(tx?.meta?.innerInstructions) ? tx.meta.innerInstructions : [];
    (Array.isArray(message?.instructions) ? message.instructions : []).forEach((instruction, index) => {
        const stack = [instruction.programId];
        const group = inner.find((row) => row?.index === index);
        for (const child of Array.isArray(group?.instructions) ? group.instructions : []) {
            const height = Number.isInteger(child.stackHeight) ? child.stackHeight : 2;
            stack.length = height - 1;
            const parent = stack[height - 2] ?? null;
            const info = child?.parsed?.info;
            if (info && /^transfer/.test(child.parsed?.type ?? '') && parent && !INFRASTRUCTURE.has(parent)) {
                if (info.source === tokenAccount) outflow.add(parent);
                if (info.destination === tokenAccount) inflow.add(parent);
            }
            stack[height - 1] = child.programId;
        }
    });
    return { outflow: [...outflow].sort(), inflow: [...inflow].sort() };
}

/**
 * A PDA owner's program from several transactions touching its token account: a unique outflow
 * parent is decisive; otherwise a unique inflow parent is recorded as weaker evidence; anything
 * ambiguous stays unresolved rather than guessed.
 */
export function resolvePdaProgram(parentsList, { ignore = new Set() } = {}) {
    const outflow = new Set(parentsList.flatMap((row) => row.outflow ?? []));
    const inflow = new Set(parentsList.flatMap((row) => row.inflow ?? []).filter((id) => !ignore.has(id)));
    if (outflow.size === 1) return { programId: [...outflow][0], basis: 'outgoing-transfer-signer' };
    if (outflow.size === 0 && inflow.size === 1) return { programId: [...inflow][0], basis: 'incoming-transfer-caller' };
    return { programId: null, basis: outflow.size > 1 ? 'ambiguous-outflow' : inflow.size > 1 ? 'ambiguous-inflow' : 'no-program-transfer-seen', programs: [...new Set([...outflow, ...inflow])].sort() };
}

/**
 * Which mints to scan directly this run: every mint not covered by a fresh holders.json read, never
 * scanned ones first, then oldest scan first, capped by the call budget. Pure so the rotation is
 * testable; `scans` is the state file's per-mint `{scannedAt}`.
 */
export function selectMintsToScan(tokens, { coveredMints, scans = {}, budget }) {
    const eligible = (Array.isArray(tokens) ? tokens : [])
        .filter((token) => typeof token?.mint === 'string' && !coveredMints.has(token.mint))
        .filter((token) => token.supplyRaw === undefined || token.supplyRaw === null || String(token.supplyRaw) !== '0');
    eligible.sort((a, b) => {
        const left = scans[a.mint]?.scannedAt ?? '';
        const right = scans[b.mint]?.scannedAt ?? '';
        if (left !== right) return left < right ? -1 : 1;
        return a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0;
    });
    return eligible.slice(0, Math.max(0, budget));
}
