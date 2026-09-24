// PURE decisions of the lending-market watcher (stocks/watch-lending.mjs): which accounts to watch
// for which market and token, which transactions a bounded run reads (oldest unprocessed first,
// cut at a slot so every account's checkpoint stays exact), how price observations become freeze
// episodes, and the SQL that stores liquidations, freeze episodes and checkpoints in schema sonar
// (db/2026-09-24-sonar-lending.sql). No network, no filesystem, no clock: every instant is the
// chain's own (block times, the Clock sysvar, Pyth publish times). Tested in ../lending-events.test.js.

import { jsonbLiteral } from './db-load.mjs';

/** Our records of the stock tokens begin here; a first run backfills from it. */
export const BACKFILL_FROM = '2026-09-16T00:00:00Z';
/**
 * Jupiter Lend refreshes each Chainlink cache every few minutes (under 10 min between successful
 * transactions on all four caches 2026-09-16 → 09-24, except the two freezes). User operations
 * refuse a price older than 600 s (Jupiter's oracle docs), so a gap longer than that is a freeze.
 */
export const JL_CACHE_MAX_GAP_S = 600;
/** Signatures are listed at the finalized commitment, which trails the chain by up to a minute. */
export const LISTING_LAG_S = 90;
/** Two stale KLend observations whose implied last update differs by more than this saw two updates. */
export const START_JITTER_S = 5;
/** A Pyth push account counts as frozen once it is this much older than the market's max age while the market is open. */
export const PYTH_GRACE_S = 900;
export const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111';

/**
 * Kamino's Scope configuration for the price account every stock reserve reads (3t4JZcu…). Admin
 * instructions such as ResumeSuspendedPrice pass it; price refreshes do not, so its history is a
 * few transactions a week (8 from 2026-09-16 to 09-24). Found as account 7 of the Squads-executed
 * ResumeSuspendedPrice 26SQ52zV… (2026-09-21).
 */
export const SCOPE_CONFIGURATION = '6cMwdbrJ95D7v5655Zsoe7oXmjQJMnagWK8EcdG6qmGM';

/** Loopscale MarketInformation accounts the research names (lib/loopscale.mjs decodes them). */
const LOOPSCALE_MARKETS = {
    EK6XyzmtAntYZ9jgpPsFSivoLdjMXrT3cpFGQ3UAYrjU: 'loopscale:xstocks-orca-vaults',
    DTzzuGFVZN8nmCS9HZubnM4vogqR8c4Rs5mChpLVjuCb: 'loopscale:secz-usdc-rwa'
};
const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'PYUSD', 'USDG', 'JupUSD', 'nUSD']);

const ROLE_ORDER = ['kamino-reserve', 'scope-config', 'jl-vault', 'jl-cache', 'nest-config', 'loopscale-loan', 'pyth-price'];
/**
 * Roles whose transactions are fetched and decoded. A `jl-cache` is read from its signature list
 * alone, and a `pyth-price` account from its own data once a run.
 */
export const FETCH_ROLES = new Set(['kamino-reserve', 'scope-config', 'jl-vault', 'nest-config', 'loopscale-loan']);
export const LISTED_ROLES = new Set([...FETCH_ROLES, 'jl-cache']);
/**
 * Hours between listings for roles whose accounts are nearly silent: the 22 Nest collateral
 * configs had 148 transactions and the 16 Loopscale loans 30 between 2026-09-16 and 09-24, so
 * listing them hourly spent 38 of a run's 67 getSignaturesForAddress calls on nothing. Kamino
 * reserves, Scope, Jupiter Lend vaults and caches are listed every run: freezes need them.
 */
export const LIST_EVERY_HOURS = { 'nest-config': 6, 'loopscale-loan': 6 };

/** Whether an account is listed this run: never listed, or its role's interval has passed since the last listing. */
export function dueForListing(role, listedAt, nowMs) {
    if (!LISTED_ROLES.has(role)) return false;
    const every = LIST_EVERY_HOURS[role];
    const last = Date.parse(listedAt ?? '');
    // Five minutes of slack, so a run that starts a little early is not pushed a whole interval.
    return !every || !Number.isFinite(last) || nowMs - last >= every * 3600000 - 300000;
}
/** Anchor account discriminator of the Pyth receiver's PriceUpdateV2 (sha256("account:PriceUpdateV2")[0..8]). */
const PRICE_UPDATE_V2 = '22f123639d7ef4cd';

function text(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function isoFromUnix(seconds) {
    return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
}

export function unixFromIso(value) {
    const ms = Date.parse(value ?? '');
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function marketIdOf(researchId) {
    return String(researchId).replace(/:oracle$/, '');
}

// --- the watch list ----------------------------------------------------------------------------

/**
 * Every account the watcher reads, from the curated oracle research (stocks/data/
 * protocol-market-research.json `oraclePricing`: Kamino reserves with their Scope entries, Jupiter
 * Lend vaults and Chainlink caches, Nest collateral configs, Loopscale's Pyth accounts) and the
 * DeFi collector's live market list (stocks/data/defi-usage.json: every Kamino reserve, Jupiter
 * Lend vault, Nest collateral config and Loopscale loan that holds a tracked stock), limited to the
 * mints in the catalogue (`tokens`). Returns plain objects keyed by address.
 */
export function buildWatchList({ research, defiUsage, tokens }) {
    const stockMints = new Map();
    for (const t of Array.isArray(tokens) ? tokens : []) {
        if (text(t?.mint)) stockMints.set(t.mint, text(t.symbol) ?? t.mint.slice(0, 6));
    }
    const accounts = new Map();
    const reserves = {};
    const caches = {};
    const loanMints = {};
    const marketByAddress = {};
    const stableMints = {};
    const add = (account, fields) => {
        if (!text(account) || accounts.has(account)) return;
        accounts.set(account, { account, ...fields });
    };

    for (const market of research?.oraclePricing?.markets ?? []) {
        const marketId = marketIdOf(market.id);
        if (text(market.marketAddress)) marketByAddress[market.marketAddress] = marketId;
        for (const c of market.collateral ?? []) {
            if (!stockMints.has(c.mint)) continue;
            if (market.protocolId === 'kamino' && text(c.reserve)) {
                reserves[c.reserve] = {
                    marketId, mint: c.mint, symbol: stockMints.get(c.mint), maxPriceAgeS: finite(c.maxPriceAgeSeconds),
                    scopeEntries: [c.chainlinkXEntry, c.scopePriceEntry, c.mostRecentOfEntry].filter(Number.isInteger)
                };
                add(c.reserve, { protocol: 'kamino', role: 'kamino-reserve', marketId, mint: c.mint });
            }
            if (market.protocolId === 'jupiter-lend') {
                if (text(c.cache)) {
                    caches[c.cache] = { marketId, mint: c.mint, symbol: stockMints.get(c.mint) };
                    add(c.cache, { protocol: 'jupiter-lend', role: 'jl-cache', marketId, mint: c.mint });
                }
                for (const v of c.vaults ?? []) {
                    if (!text(v.address)) continue;
                    marketByAddress[v.address] = marketId;
                    add(v.address, { protocol: 'jupiter-lend', role: 'jl-vault', marketId, mint: c.mint, vaultId: v.id ?? null });
                }
            }
            if (market.protocolId === 'nest' && text(c.collateralConfig)) {
                marketByAddress[c.collateralConfig] = marketId;
                add(c.collateralConfig, { protocol: 'nest', role: 'nest-config', marketId, mint: c.mint });
            }
            if (market.protocolId === 'loopscale' && text(c.oracleAccount)) {
                const maxAgeS = finite(market.stalenessAndPause?.maxPriceAgeSeconds) ?? 900;
                add(c.oracleAccount, { protocol: 'loopscale', role: 'pyth-price', marketId, mint: c.mint, maxAgeS });
            }
        }
    }

    for (const item of defiUsage?.items ?? []) {
        if (!stockMints.has(item?.mint)) continue;
        for (const integration of item.integrations ?? []) {
            for (const m of integration.markets ?? []) {
                if (text(m.debtMint) && STABLE_SYMBOLS.has(m.debtSymbol)) stableMints[m.debtMint] = m.debtSymbol;
                const protocol = integration.protocolId;
                if (protocol === 'kamino' && text(m.reserveAddress) && !reserves[m.reserveAddress]) {
                    const marketId = marketByAddress[m.marketAddress] ?? `kamino:${m.marketAddress}`;
                    reserves[m.reserveAddress] = { marketId, mint: item.mint, symbol: stockMints.get(item.mint), maxPriceAgeS: null, scopeEntries: [] };
                    add(m.reserveAddress, { protocol, role: 'kamino-reserve', marketId, mint: item.mint });
                } else if (protocol === 'jupiter-lend' && text(m.vaultAddress)) {
                    const marketId = marketByAddress[m.vaultAddress] ?? 'jupiter-lend:xstocks-vaults';
                    marketByAddress[m.vaultAddress] = marketId;
                    add(m.vaultAddress, { protocol, role: 'jl-vault', marketId, mint: item.mint, vaultId: m.vaultId ?? null });
                } else if (protocol === 'nest' && text(m.collateralConfig)) {
                    const marketId = marketByAddress[m.collateralConfig] ?? 'nest';
                    marketByAddress[m.collateralConfig] = marketId;
                    add(m.collateralConfig, { protocol, role: 'nest-config', marketId, mint: item.mint });
                } else if (protocol === 'loopscale' && text(m.loanAddress)) {
                    const mi = text(m.configuration?.marketInformation);
                    const marketId = (mi && LOOPSCALE_MARKETS[mi]) ?? (mi ? `loopscale:${mi}` : 'loopscale');
                    if (mi) marketByAddress[mi] = marketId;
                    loanMints[m.loanAddress] = item.mint;
                    add(m.loanAddress, { protocol, role: 'loopscale-loan', marketId, mint: item.mint });
                }
            }
        }
    }
    if (Object.keys(reserves).length) add(SCOPE_CONFIGURATION, { protocol: 'kamino', role: 'scope-config', marketId: null, mint: null });
    for (const [address, marketId] of Object.entries(LOOPSCALE_MARKETS)) marketByAddress[address] ??= marketId;

    const list = [...accounts.values()].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || (a.account < b.account ? -1 : 1));
    return { accounts: list, reserves, caches, loanMints, marketByAddress, stockMints: Object.fromEntries(stockMints), stableMints };
}

/** Scope entry index → the watched reserves whose price chain uses it. */
export function reservesByScopeEntry(reserves) {
    const out = new Map();
    for (const [reserve, meta] of Object.entries(reserves ?? {})) {
        for (const entry of meta.scopeEntries ?? []) {
            if (!out.has(entry)) out.set(entry, []);
            out.get(entry).push(reserve);
        }
    }
    return out;
}

// --- which transactions a run reads ------------------------------------------------------------

/**
 * One account's listing (getSignaturesForAddress pages, newest first, already cut at its
 * checkpoint or at the backfill start) → its pending signatures, oldest first.
 */
export function pendingOldestFirst(listed) {
    return (Array.isArray(listed) ? listed : [])
        .filter((s) => typeof s?.signature === 'string' && Number.isFinite(s.slot))
        .slice()
        .sort((a, b) => a.slot - b.slot || (a.blockTime ?? 0) - (b.blockTime ?? 0) || (a.signature < b.signature ? -1 : 1));
}

/**
 * The run's batch: the union of every fetched account's pending signatures (one entry per
 * transaction, remembering which accounts listed it), oldest slot first, up to `budget`
 * transactions — extended to the end of the last slot taken, so a slot is never split. `cutSlot`
 * is the newest slot read; everything at or before it is done for every account, which is what
 * lets each account's checkpoint advance independently and exactly.
 */
export function selectBatch(pendingByAccount, { budget }) {
    const union = new Map();
    for (const [account, pending] of pendingByAccount) {
        for (const s of pending) {
            const entry = union.get(s.signature) ?? { signature: s.signature, slot: s.slot, blockTime: s.blockTime ?? null, err: s.err ?? null, accounts: [] };
            entry.accounts.push(account);
            union.set(s.signature, entry);
        }
    }
    const ordered = [...union.values()].sort((a, b) => a.slot - b.slot || (a.signature < b.signature ? -1 : 1));
    if (!(budget > 0) || ordered.length === 0) return { batch: [], cutSlot: null, backlog: ordered.length };
    let end = Math.min(budget, ordered.length);
    while (end < ordered.length && ordered[end].slot === ordered[end - 1].slot) end += 1;
    const batch = ordered.slice(0, end);
    return { batch, cutSlot: batch.at(-1).slot, backlog: ordered.length - batch.length };
}

/**
 * After reading everything up to `cutSlot`: each account's new checkpoint is its newest pending
 * signature at or before the cut. Accounts with nothing at or before it keep their checkpoint.
 */
export function advanceCheckpoints(pendingByAccount, cutSlot) {
    const out = new Map();
    if (!Number.isFinite(cutSlot)) return out;
    for (const [account, pending] of pendingByAccount) {
        const done = pending.filter((s) => s.slot <= cutSlot);
        if (done.length) {
            const last = done.at(-1);
            out.set(account, { signature: last.signature, slot: last.slot, blockTime: isoFromUnix(last.blockTime), consumed: done.length });
        }
    }
    return out;
}

/**
 * How far a fetch run got when a read failed part-way: the newest slot all of whose selected
 * transactions were read. Transactions of a partly read slot are re-read next run.
 */
export function completedCut(batch, fetchedSignatures) {
    let cut = null;
    for (let i = 0; i < batch.length; i += 1) {
        if (!fetchedSignatures.has(batch[i].signature)) {
            const slot = batch[i].slot;
            // Everything strictly before this slot is complete.
            for (let j = i - 1; j >= 0; j -= 1) if (batch[j].slot < slot) return batch[j].slot;
            return null;
        }
        cut = batch[i].slot;
    }
    return cut;
}

// --- freeze episodes -----------------------------------------------------------------------------

function newEpisode(meta, fields) {
    return {
        protocol: meta.protocol, marketId: meta.marketId, mint: meta.mint, symbol: meta.symbol ?? null,
        startedTs: null, endedTs: null, lastSeenStaleTs: null, staleObservations: 0,
        observation: null, cause: null, causeDetail: null, startSignature: null, endSignature: null, evidence: {},
        ...fields
    };
}

/**
 * One KLend reserve observation (lib/lending-decode.mjs kaminoRefreshes, oldest first) applied to
 * the reserve's freeze state. A stale price is logged with its age, so its last update is
 * `blockTime − age` — the chain's own time, the same on every stale observation of one episode.
 * A fresh observation ends the open episode (the end is the first fresh observation, so the real
 * resume happened at or before it). A stale observation whose implied last update is later than
 * the open episode's saw a newer update: the old episode ended by then and a new one begins.
 */
export function applyReserveObservation(state, obs, meta) {
    const open = state?.open ?? null;
    const at = unixFromIso(obs.at);
    if (at === null) return { state: state ?? { open: null }, emit: [] };
    if (obs.stale) {
        const implied = Number.isFinite(obs.ageS) ? at - obs.ageS : null;
        if (open && implied !== null && open.startBasis === 'price-age' && implied > open.startedTs + START_JITTER_S) {
            const closed = { ...open, endedTs: implied, endSignature: null, endBasis: 'next-update' };
            const reopened = newEpisode(meta, {
                startedTs: implied, startBasis: 'price-age', lastSeenStaleTs: at, staleObservations: 1,
                observation: 'kamino-refresh-log', startSignature: obs.signature, lastStaleSignature: obs.signature,
                evidence: { reserve: meta.reserve, maxAgeS: obs.maxAgeS ?? null, firstStaleAt: obs.at, firstStaleAgeS: obs.ageS }
            });
            return { state: { open: reopened }, emit: [closed] };
        }
        if (open) {
            return {
                state: { open: { ...open, lastSeenStaleTs: Math.max(open.lastSeenStaleTs ?? at, at), staleObservations: open.staleObservations + 1, lastStaleSignature: obs.signature } },
                emit: []
            };
        }
        return {
            state: {
                open: newEpisode(meta, {
                    startedTs: implied ?? at, startBasis: implied === null ? 'first-stale-observation' : 'price-age',
                    lastSeenStaleTs: at, staleObservations: 1, observation: 'kamino-refresh-log',
                    startSignature: obs.signature, lastStaleSignature: obs.signature,
                    evidence: { reserve: meta.reserve, maxAgeS: obs.maxAgeS ?? null, firstStaleAt: obs.at, firstStaleAgeS: obs.ageS ?? null }
                })
            },
            emit: []
        };
    }
    if (open) {
        // A Scope resume between the last stale and this fresh observation is when the price came
        // back; this observation is only the first transaction to see it.
        const resumed = unixFromIso(open.causeDetail?.resumedAt);
        if (resumed !== null && resumed >= (open.lastSeenStaleTs ?? open.startedTs) && resumed <= at) {
            return { state: { open: null }, emit: [{ ...open, endedTs: resumed, endSignature: open.causeDetail.resumeSignature, endBasis: 'scope-resume', firstFreshAt: obs.at }] };
        }
        return { state: { open: null }, emit: [{ ...open, endedTs: at, endSignature: obs.signature, endBasis: 'first-fresh-observation' }] };
    }
    return { state: state ?? { open: null }, emit: [] };
}

/**
 * A Scope ResumeSuspendedPrice for an entry this reserve's price chain uses. With an episode open,
 * the resume names its cause. Without one (nobody transacted while the price was suspended), the
 * resume is itself the evidence of an episode: from the last Chainlink observation Scope held to
 * the resume.
 */
export function applyScopeResume(state, resume, meta) {
    const detail = {
        resumeSignature: resume.signature, resumedAt: resume.at, entry: resume.entry, label: resume.label ?? null,
        observationsAt: isoFromUnix(resume.observationsTs), activationAt: isoFromUnix(resume.activationTs)
    };
    const open = state?.open ?? null;
    if (open) return { state: { open: { ...open, cause: 'scope-suspension', causeDetail: detail } }, emit: [] };
    const started = Number.isFinite(resume.observationsTs) ? resume.observationsTs : null;
    const ended = unixFromIso(resume.at);
    if (started === null || ended === null || ended <= started) return { state: state ?? { open: null }, emit: [] };
    return {
        state: state ?? { open: null },
        emit: [newEpisode(meta, {
            startedTs: started, endedTs: ended, startBasis: 'scope-observation', endBasis: 'scope-resume',
            observation: 'scope-resume', cause: 'scope-suspension', causeDetail: detail,
            startSignature: null, endSignature: resume.signature, evidence: { reserve: meta.reserve }
        })]
    };
}

/**
 * A Jupiter Lend Chainlink cache's signatures (oldest first): every successful transaction on the
 * cache is a refresh or an operation that read a fresh price, so a gap between two of them longer
 * than `maxGapS` is a freeze from the last one to the next. State carries the last success across
 * runs; `coverageGap` (the listing did not reach the checkpoint) forgets it rather than invent a gap.
 */
export function applyCacheSignatures(state, sigs, meta, { maxGapS = JL_CACHE_MAX_GAP_S, coverageGap = false } = {}) {
    let lastOk = coverageGap ? null : (state?.lastOk ?? null);
    const emit = [];
    for (const s of sigs) {
        if (s.err !== null && s.err !== undefined) continue;
        if (!Number.isFinite(s.blockTime)) continue;
        if (lastOk && s.blockTime - lastOk.blockTime > maxGapS) {
            emit.push(newEpisode(meta, {
                startedTs: lastOk.blockTime, endedTs: s.blockTime, lastSeenStaleTs: null,
                startBasis: 'last-refresh', endBasis: 'next-refresh', observation: 'jl-cache-refresh-gap',
                startSignature: lastOk.signature, endSignature: s.signature, evidence: { cache: meta.account, maxGapS }
            }));
        }
        lastOk = { signature: s.signature, blockTime: s.blockTime, slot: s.slot };
    }
    return { state: { ...(state ?? {}), lastOk }, emit };
}

/** The cache's current gap, when it is already longer than `maxGapS` at the chain instant `nowTs`. */
export function ongoingCacheEpisode(state, nowTs, meta, { maxGapS = JL_CACHE_MAX_GAP_S } = {}) {
    const lastOk = state?.lastOk ?? null;
    if (!lastOk || !Number.isFinite(nowTs) || nowTs - lastOk.blockTime <= maxGapS + LISTING_LAG_S) return null;
    return newEpisode(meta, {
        startedTs: lastOk.blockTime, endedTs: null, lastSeenStaleTs: nowTs, startBasis: 'last-refresh',
        observation: 'jl-cache-refresh-gap', startSignature: lastOk.signature, evidence: { cache: meta.account, maxGapS }
    });
}

/** Cause of a Jupiter Lend gap from the oracle events in its first and last transactions. */
export function jupiterGapCause(episode, boundaryEvents) {
    const cache = episode?.evidence?.cache;
    const mine = (boundaryEvents ?? []).filter((e) => e.event === 'feed-suspended' && e.cache === cache && !e.failed);
    const lift = mine.find((e) => e.suspended === false && e.signature === episode.endSignature) ?? null;
    const set = mine.find((e) => e.suspended === true) ?? null;
    if (!lift && !set) return null;
    return {
        cause: 'operator-suspension',
        causeDetail: {
            suspendedBy: set?.keeper ?? null, suspendedSignature: set?.signature ?? null,
            liftedBy: lift?.keeper ?? null, liftedSignature: lift?.signature ?? null, liftedAt: lift?.at ?? null
        }
    };
}

// --- Pyth push accounts (Loopscale) -------------------------------------------------------------

/**
 * A Pyth receiver PriceUpdateV2 account: verification level (Partial carries a signature count,
 * Full does not, which shifts the message by one byte), then the price message. Null on anything
 * that is not one.
 */
export function decodePriceUpdateV2(input) {
    const buf = Buffer.isBuffer(input) ? input : typeof input === 'string' ? Buffer.from(input, 'base64') : null;
    if (!buf || buf.length < 8 + 32 + 1 + 32 + 8 + 8 + 4 + 8 || buf.subarray(0, 8).toString('hex') !== PRICE_UPDATE_V2) return null;
    const level = buf[40];
    const base = level === 0 ? 42 : level === 1 ? 41 : null;
    if (base === null || buf.length < base + 84 + 8) return null;
    const expo = buf.readInt32LE(base + 48);
    const price = Number(buf.readBigInt64LE(base + 32)) * 10 ** expo;
    return {
        verification: level === 1 ? 'full' : 'partial',
        feedId: buf.subarray(base, base + 32).toString('hex'),
        price,
        publishTs: Number(buf.readBigInt64LE(base + 52)),
        postedSlot: Number(buf.readBigUInt64LE(base + 84))
    };
}

/**
 * One hourly reading of a Pyth push account a lending market prices from. It opens a freeze
 * episode only while the listed share's market is open (`session` from lib/market-hours.mjs) and
 * the price is older than the market's max age plus PYTH_GRACE_S, so nights and weekends — when
 * equity feeds are not published — are never read as freezes. The episode starts at the last
 * publish time and ends at the first update after it (`firstUpdateTs`, from the account's
 * signatures), or at the newer publish time read now when that lookup found nothing.
 */
export function applyPythReading(state, { publishTs, nowTs, session, maxAgeS, firstUpdate = null }, meta) {
    const open = state?.open ?? null;
    if (!Number.isFinite(publishTs) || !Number.isFinite(nowTs)) return { state: state ?? { open: null }, emit: [], needsFirstUpdate: false };
    if (open && publishTs > open.startedTs) {
        if (firstUpdate === null) return { state, emit: [], needsFirstUpdate: true };
        const endedTs = Number.isFinite(firstUpdate.blockTime) && firstUpdate.blockTime > open.startedTs ? firstUpdate.blockTime : publishTs;
        return { state: { open: null }, emit: [{ ...open, endedTs, endSignature: firstUpdate.signature ?? null, endBasis: 'first-update' }], needsFirstUpdate: false };
    }
    if (open) {
        const next = { ...open, lastSeenStaleTs: nowTs, staleObservations: open.staleObservations + 1 };
        return { state: { open: next }, emit: [next], needsFirstUpdate: false };
    }
    if (session === 'open' && nowTs - publishTs > (maxAgeS ?? 900) + PYTH_GRACE_S) {
        const episode = newEpisode(meta, {
            startedTs: publishTs, lastSeenStaleTs: nowTs, staleObservations: 1, startBasis: 'publish-time',
            observation: 'pyth-account-age', cause: 'stale-oracle-account',
            evidence: { account: meta.account, maxAgeS: maxAgeS ?? null, ageAtDetectionS: nowTs - publishTs }
        });
        return { state: { open: episode }, emit: [episode], needsFirstUpdate: false };
    }
    return { state: state ?? { open: null }, emit: [], needsFirstUpdate: false };
}

/**
 * The US listed-share session calendar (regular hours plus holidays) as Pyth publishes it, taken
 * from the reference-price collector's feed list (stocks/data/reference-prices.json `items[].schedule`).
 */
export function usEquitySchedule(referencePrices) {
    for (const item of referencePrices?.items ?? []) {
        if (typeof item?.schedule === 'string' && item.schedule.startsWith('America/New_York;')) return item.schedule;
    }
    return null;
}

// --- rows ------------------------------------------------------------------------------------------

/** A freeze episode as the row sonar.lending_price_freeze stores. */
export function freezeRow(ep) {
    return {
        protocol: ep.protocol, marketId: ep.marketId, mint: ep.mint, symbol: ep.symbol ?? null,
        startedAt: isoFromUnix(ep.startedTs), endedAt: isoFromUnix(ep.endedTs), lastSeenStaleAt: isoFromUnix(ep.lastSeenStaleTs),
        staleObservations: Number.isInteger(ep.staleObservations) ? ep.staleObservations : null,
        observation: ep.observation, cause: ep.cause ?? null, causeDetail: ep.causeDetail ?? null,
        startSignature: ep.startSignature ?? null, endSignature: ep.endSignature ?? null,
        evidence: {
            ...(ep.evidence ?? {}), startBasis: ep.startBasis ?? null, endBasis: ep.endBasis ?? null,
            lastStaleSignature: ep.lastStaleSignature ?? null, firstFreshAt: ep.firstFreshAt ?? null
        }
    };
}

/**
 * A decoded liquidation (lib/lending-decode.mjs) as the row sonar.lending_liquidation stores: the
 * market id from the watch list, the debt token's symbol, and a stablecoin debt valued at $1 when
 * the protocol logged no price for it. Nothing else is filled in: an unknown USD value stays null.
 */
export function liquidationRow(liq, watch) {
    const marketId = watch.marketByAddress?.[liq.marketAddress]
        ?? (liq.protocol === 'jupiter-lend' ? 'jupiter-lend:xstocks-vaults' : `${liq.protocol}:${liq.marketAddress}`);
    const debtSymbol = watch.stockMints?.[liq.debtMint] ?? watch.stableMints?.[liq.debtMint] ?? null;
    const stable = watch.stableMints?.[liq.debtMint] !== undefined;
    const debtUsd = finite(liq.debtUsd) ?? (stable && finite(liq.debtAmount) !== null ? liq.debtAmount : null);
    return {
        signature: liq.signature, ixIndex: liq.invocation, slot: liq.slot, blockTime: liq.at,
        protocol: liq.protocol, marketId, marketAddress: liq.marketAddress ?? null, programId: liq.programId, instruction: liq.instruction,
        mint: liq.mint, symbol: liq.symbol ?? null,
        collateralAmount: finite(liq.collateralAmount), collateralToLiquidator: finite(liq.collateralToLiquidator),
        collateralPriceUsd: finite(liq.collateralPriceUsd), collateralUsd: finite(liq.collateralUsd), priceSource: liq.priceSource ?? null,
        debtMint: liq.debtMint ?? null, debtSymbol, debtAmount: finite(liq.debtAmount), debtUsd,
        debtPriceSource: finite(liq.debtUsd) !== null ? 'protocol-log' : debtUsd !== null ? 'stablecoin-at-1' : null,
        liquidator: liq.liquidator ?? null, borrower: liq.borrower ?? null, position: liq.position ?? null,
        evidence: { reserve: liq.reserve ?? null, ...(liq.detail ?? {}) }
    };
}

/** Obligation owner (KLend Obligation account, owner at byte 64) for the borrower column. */
export function obligationOwner(input, base58Encode) {
    const buf = Buffer.isBuffer(input) ? input : typeof input === 'string' ? Buffer.from(input, 'base64') : null;
    if (!buf || buf.length !== 3344 || buf.subarray(0, 8).toString('hex') !== 'a8ce8d6a584caca7') return null;
    return base58Encode(buf.subarray(64, 96));
}

// --- SQL --------------------------------------------------------------------------------------------

function upsert({ table, doc, columns, conflict, update }) {
    const colList = columns.map(([c]) => c).join(', ');
    const select = columns.map(([, expr]) => expr).join(',\n       ');
    const set = [...update.map((c) => `${c} = EXCLUDED.${c}`), 'updated_at = now()'].join(',\n       ');
    const guard = update.map((c) => `t.${c} IS DISTINCT FROM EXCLUDED.${c}`).join('\n    OR ');
    return `WITH doc AS (SELECT ${jsonbLiteral(doc)} AS d)\n`
        + `INSERT INTO ${table} AS t (${colList})\n`
        + `SELECT ${select}\n  FROM doc, jsonb_array_elements(d->'rows') AS x(r)\n`
        + `ON CONFLICT (${conflict}) DO UPDATE SET\n       ${set}\n WHERE ${guard};\n`;
}

const TS = (field) => `(r->>'${field}')::timestamptz`;
const NUM = (field) => `(r->>'${field}')::numeric`;
const TXT = (field) => `r->>'${field}'`;
const JSONB = (field) => `NULLIF(r->'${field}', 'null'::jsonb)`;

/** Upsert liquidation rows on (signature, ix_index); a re-read of the same transaction changes nothing. */
export function buildLiquidationSql(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (list.length === 0) return null;
    return upsert({
        table: 'sonar.lending_liquidation',
        doc: { rows: list },
        columns: [
            ['signature', TXT('signature')], ['ix_index', "(r->>'ixIndex')::int"], ['slot', "(r->>'slot')::bigint"], ['block_time', TS('blockTime')],
            ['protocol', TXT('protocol')], ['market_id', TXT('marketId')], ['market_address', TXT('marketAddress')],
            ['program_id', TXT('programId')], ['instruction', TXT('instruction')], ['mint', TXT('mint')], ['symbol', TXT('symbol')],
            ['collateral_amount', NUM('collateralAmount')], ['collateral_to_liquidator', NUM('collateralToLiquidator')],
            ['collateral_price_usd', NUM('collateralPriceUsd')], ['collateral_usd', NUM('collateralUsd')], ['price_source', TXT('priceSource')],
            ['debt_mint', TXT('debtMint')], ['debt_symbol', TXT('debtSymbol')], ['debt_amount', NUM('debtAmount')], ['debt_usd', NUM('debtUsd')],
            ['debt_price_source', TXT('debtPriceSource')],
            ['liquidator', TXT('liquidator')], ['borrower', TXT('borrower')], ['position', TXT('position')], ['evidence', JSONB('evidence')]
        ],
        conflict: 'signature, ix_index',
        // A price filled in later from the trade tape is not overwritten by a re-read that has none.
        update: ['market_id', 'symbol', 'debt_symbol', 'borrower', 'evidence']
    });
}

/** Upsert freeze episodes on (market_id, mint, started_at): an ongoing episode's row is updated as it grows and when it ends. */
export function buildFreezeSql(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (list.length === 0) return null;
    return upsert({
        table: 'sonar.lending_price_freeze',
        doc: { rows: list },
        columns: [
            ['protocol', TXT('protocol')], ['market_id', TXT('marketId')], ['mint', TXT('mint')], ['symbol', TXT('symbol')],
            ['started_at', TS('startedAt')], ['ended_at', TS('endedAt')], ['last_seen_stale_at', TS('lastSeenStaleAt')],
            ['stale_observations', "(r->>'staleObservations')::int"], ['observation', TXT('observation')],
            ['cause', TXT('cause')], ['cause_detail', JSONB('causeDetail')],
            ['start_signature', TXT('startSignature')], ['end_signature', TXT('endSignature')], ['evidence', JSONB('evidence')]
        ],
        conflict: 'market_id, mint, started_at',
        update: ['ended_at', 'last_seen_stale_at', 'stale_observations', 'cause', 'cause_detail', 'end_signature', 'evidence', 'symbol']
    });
}

/** Upsert each watched account's checkpoint and stream state. */
export function buildScanSql(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (list.length === 0) return null;
    return upsert({
        table: 'sonar.lending_scan',
        doc: { rows: list },
        columns: [
            ['account', TXT('account')], ['protocol', TXT('protocol')], ['role', TXT('role')], ['market_id', TXT('marketId')], ['mint', TXT('mint')],
            ['backfill_from', TS('backfillFrom')], ['last_signature', TXT('lastSignature')], ['last_slot', "(r->>'lastSlot')::bigint"],
            ['last_block_time', TS('lastBlockTime')], ['state', JSONB('state')], ['signatures_seen', "(r->>'signaturesSeen')::bigint"],
            ['listed_at', TS('listedAt')]
        ],
        conflict: 'account',
        update: ['protocol', 'role', 'market_id', 'mint', 'last_signature', 'last_slot', 'last_block_time', 'state', 'signatures_seen', 'listed_at']
    });
}

/**
 * Collateral with no protocol-logged price takes the median of our own trade tape
 * (sonar.stock_trade, suspect trades excluded) within an hour either side of the liquidation.
 * Rows with no trade in that window keep a null price; the next run tries again.
 */
export const TRADE_PRICE_FILL_SQL = `WITH p AS (
  SELECT l.signature, l.ix_index,
         (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY t.price_usd)
            FROM sonar.stock_trade t
           WHERE t.mint = l.mint AND t.suspect IS NULL AND t.price_usd > 0
             AND t.time BETWEEN l.block_time - interval '1 hour' AND l.block_time + interval '1 hour') AS price
    FROM sonar.lending_liquidation l
   WHERE l.collateral_price_usd IS NULL AND l.collateral_amount IS NOT NULL)
UPDATE sonar.lending_liquidation l
   SET collateral_price_usd = p.price, collateral_usd = l.collateral_amount * p.price,
       price_source = 'trade-tape-median-1h', updated_at = now()
  FROM p
 WHERE p.signature = l.signature AND p.ix_index = l.ix_index AND p.price IS NOT NULL;
`;

export const SCAN_STATE_QUERY = `SELECT COALESCE(json_agg(json_build_object(
    'account', account, 'role', role, 'backfillFrom', to_char(backfill_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'lastSignature', last_signature, 'lastSlot', last_slot,
    'lastBlockTime', to_char(last_block_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'state', state, 'signaturesSeen', signatures_seen,
    'listedAt', to_char(listed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))), '[]'::json)::text
  FROM sonar.lending_scan;`;
