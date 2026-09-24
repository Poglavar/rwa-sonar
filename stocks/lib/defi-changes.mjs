// Pure shaping, diffing and alert formatting for the daily DeFi protocol watch.
// A human sees "token"; the exact Solana mint address remains the identity/evidence key.

import fmt from './fmt.js';
import { FOOTPRINT_EVENT_KINDS } from './defi-footprint.mjs';

// Registry kinds come from the daily exact-token registry comparison; the defi-integration-* kinds
// come from the on-chain footprint comparison (lib/defi-footprint.mjs diffFootprints).
export const DEFI_CHANGE_KINDS = [
    { id: 'token-added', label: 'Token added to protocol', severity: 'info' },
    { id: 'token-removed', label: 'Token removed from protocol', severity: 'warning' },
    { id: 'ltv-changed', label: 'Maximum LTV changed', severity: 'caution' },
    { id: 'market-inactive', label: 'Market became inactive', severity: 'warning' },
    { id: 'collateral-value-drop', label: 'Collateral value fell sharply', severity: 'caution' },
    { id: 'market-added', label: 'New market for token in protocol', severity: 'info' },
    { id: 'market-removed', label: 'Market for token left protocol', severity: 'warning' },
    ...FOOTPRINT_EVENT_KINDS
];

export const COLLATERAL_DROP_PCT = 25;
export const COLLATERAL_VALUE_FLOOR_USD = 100_000;

const KIND_ORDER = new Map(DEFI_CHANGE_KINDS.map((kind, index) => [kind.id, index]));
const SEVERITY_BY_KIND = new Map(DEFI_CHANGE_KINDS.map((kind) => [kind.id, kind.severity]));

function numberOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? Number(value.toPrecision(8)) : null;
}

function textOrNull(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function stringList(value) {
    return [...new Set((Array.isArray(value) ? value : []).map(textOrNull).filter(Boolean))].sort();
}

function integrationKey(row) {
    return `${row?.mint ?? ''}\u0000${row?.protocolId ?? ''}`;
}

function compareText(left, right) {
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

/** Slim one volatile protocol integration into fields whose changes have defined meaning. */
export function snapshotDefiIntegration(asset, integration) {
    const metrics = integration?.metrics ?? {};
    return {
        mint: textOrNull(asset?.mint),
        symbol: textOrNull(asset?.symbol),
        issuer: textOrNull(asset?.issuer),
        protocolId: textOrNull(integration?.protocolId),
        protocolName: textOrNull(integration?.protocolName),
        integrationId: textOrNull(integration?.id),
        // What the row rests on: a protocol's own listing, or (onchain-position) only loans or
        // positions read on-chain, which is an observation and never a listing.
        basis: textOrNull(integration?.proof?.sourceStatus),
        category: textOrNull(integration?.category),
        status: textOrNull(integration?.status),
        maxLtvMin: numberOrNull(metrics.maxLtvMin),
        maxLtvMax: numberOrNull(metrics.maxLtvMax),
        liquidationLtvMin: numberOrNull(metrics.liquidationLtvMin),
        liquidationLtvMax: numberOrNull(metrics.liquidationLtvMax),
        liquidationPenaltyMin: numberOrNull(metrics.liquidationPenaltyMin),
        liquidationPenaltyMax: numberOrNull(metrics.liquidationPenaltyMax),
        depositLimitUsd: numberOrNull(metrics.depositLimitUsd),
        borrowLimitUsd: numberOrNull(metrics.borrowLimitUsd),
        utilizationPct: numberOrNull(metrics.utilizationPct),
        maxOracleStalenessSeconds: numberOrNull(metrics.maxOracleStalenessSeconds),
        oracleProviders: stringList(metrics.oracleProviders),
        collateralValueUsd: integration?.category === 'lending' ? numberOrNull(metrics.sizeUsd) : null,
        // Non-DEX market/vault/bank addresses, so a protocol adding a NEW market for a token it
        // already lists (e.g. Kamino's Sentora xStocks Market) is an event too. DEX pools churn
        // daily and are deliberately excluded.
        markets: integration?.category === 'dex' ? null : marketIdentities(integration),
        corroborationStatus: textOrNull(integration?.corroboration?.status),
        corroboratedAccounts: numberOrNull(integration?.corroboration?.verifiedCount),
        publishedAccounts: numberOrNull(integration?.corroboration?.accountCount)
    };
}

function marketIdentities(integration) {
    const out = new Map();
    for (const market of Array.isArray(integration?.markets) ? integration.markets : []) {
        const key = textOrNull(market?.marketAddress) ?? textOrNull(market?.vaultAddress) ?? textOrNull(market?.bankAddress)
            ?? textOrNull(market?.collateralConfig) ?? textOrNull(market?.loanAddress);
        if (key && !out.has(key)) out.set(key, textOrNull(market?.name));
    }
    return [...out.entries()].sort(([a], [b]) => compareText(a, b)).map(([address, name]) => ({ address, name }));
}

/** Flatten the current per-token usage document into deterministic protocol rows. */
export function snapshotDefiUsage(usage) {
    const rows = [];
    for (const asset of Array.isArray(usage?.items) ? usage.items : []) {
        for (const integration of Array.isArray(asset?.integrations) ? asset.integrations : []) {
            const row = snapshotDefiIntegration(asset, integration);
            if (row.mint && row.protocolId) rows.push(row);
        }
    }
    return rows.sort((a, b) => compareText(integrationKey(a), integrationKey(b)));
}

const POSITION_BASIS = 'onchain-position';

function basisSeen(snapshot, basis) {
    return (Array.isArray(snapshot?.items) ? snapshot.items : []).some((row) => row?.basis === basis);
}

function indexRows(snapshot) {
    const rows = new Map();
    for (const row of Array.isArray(snapshot?.items) ? snapshot.items : []) {
        if (row?.mint && row?.protocolId) rows.set(integrationKey(row), row);
    }
    return rows;
}

function pct(value) {
    return value === null ? 'unknown' : `${(value * 100).toFixed(1).replace(/\.0$/, '')}%`;
}

function ltvText(range) {
    return range.min === range.max ? pct(range.min) : `${pct(range.min)}–${pct(range.max)}`;
}

function usd(value) {
    if (value === null) return 'unknown';
    return `$${Math.round(value).toLocaleString('en-US')}`;
}

function identity(row) {
    return {
        mint: row.mint,
        symbol: row.symbol,
        issuer: row.issuer,
        protocolId: row.protocolId,
        protocolName: row.protocolName,
        category: row.category
    };
}

function event(kind, row, before, after, summary, extra = {}) {
    return {
        kind,
        severity: SEVERITY_BY_KIND.get(kind),
        ...identity(row),
        before,
        after,
        summary,
        ...extra
    };
}

function ltvRange(row) {
    const min = numberOrNull(row?.maxLtvMin);
    const max = numberOrNull(row?.maxLtvMax);
    return min === null || max === null ? null : { min, max };
}

function sameLtv(left, right) {
    return left?.min === right?.min && left?.max === right?.max;
}

/**
 * Compare two daily protocol snapshots.
 *
 * Add/remove means an exact token address entered/left a protocol's observed registry. LTV changes
 * fire on any actual configured max-LTV move (not a market-value estimate). A collateral-value
 * drop needs both a >=25% fall and a previous value >=$100k, keeping dust markets quiet.
 */
export function diffDefiSnapshots(previous, current, {
    collateralDropPct = COLLATERAL_DROP_PCT,
    collateralValueFloorUsd = COLLATERAL_VALUE_FLOOR_USD
} = {}) {
    const emptyCounts = () => Object.fromEntries(DEFI_CHANGE_KINDS.map(({ id }) => [id, 0]));
    if (!previous || !current) {
        return {
            from: previous?.date ?? null,
            to: current?.date ?? null,
            fromFetchedAt: previous?.fetchedAt ?? null,
            toFetchedAt: current?.fetchedAt ?? null,
            counts: emptyCounts(),
            events: []
        };
    }
    const beforeRows = indexRows(previous);
    const afterRows = indexRows(current);
    let baselined = 0;
    const keys = [...new Set([...beforeRows.keys(), ...afterRows.keys()])].sort();
    const events = [];

    for (const key of keys) {
        const before = beforeRows.get(key);
        const after = afterRows.get(key);
        if (!before) {
            // The first day a measurement runs (no row of that basis the day before) records a
            // baseline: those rows existed before we could see them, so none is an addition.
            if (after.basis === POSITION_BASIS && !basisSeen(previous, POSITION_BASIS)) {
                baselined += 1;
                continue;
            }
            events.push(event('token-added', after, null, after.status, after.basis === POSITION_BASIS
                ? `A ${after.protocolName ?? after.protocolId} loan against ${after.symbol ?? after.mint} was first observed on-chain; no published listing names it.`
                : `${after.symbol ?? after.mint} now appears in ${after.protocolName ?? after.protocolId}'s checked registry.`, { basis: after.basis }));
            continue;
        }
        if (!after) {
            events.push(event('token-removed', before, before.status, null, before.basis === POSITION_BASIS
                ? `No open ${before.protocolName ?? before.protocolId} loan against ${before.symbol ?? before.mint} is observed any more.`
                : `${before.symbol ?? before.mint} no longer appears in ${before.protocolName ?? before.protocolId}'s checked registry.`, { basis: before.basis }));
            continue;
        }

        // Snapshots written before market identities were recorded carry no `markets`: no event.
        if (Array.isArray(before.markets) && Array.isArray(after.markets)) {
            const oldMarkets = new Map(before.markets.map((m) => [m.address, m]));
            const newMarkets = new Map(after.markets.map((m) => [m.address, m]));
            for (const [address, market] of newMarkets) {
                if (oldMarkets.has(address)) continue;
                events.push(event('market-added', after, null, market,
                    `${after.symbol ?? after.mint} gained a new ${after.protocolName ?? after.protocolId} market: ${market.name ?? address}.`,
                    { market }));
            }
            for (const [address, market] of oldMarkets) {
                if (newMarkets.has(address)) continue;
                events.push(event('market-removed', after, market, null,
                    `${after.symbol ?? after.mint} no longer appears in the ${after.protocolName ?? after.protocolId} market ${market.name ?? address}.`,
                    { market }));
            }
        }

        const oldLtv = ltvRange(before);
        const newLtv = ltvRange(after);
        if (oldLtv && newLtv && !sameLtv(oldLtv, newLtv)) {
            events.push(event('ltv-changed', after, oldLtv, newLtv,
                `${after.symbol ?? after.mint} maximum LTV on ${after.protocolName ?? after.protocolId} changed from `
                + `${ltvText(oldLtv)} to ${ltvText(newLtv)}.`));
        }

        if (before.status === 'live' && after.status !== 'live') {
            events.push(event('market-inactive', after, before.status, after.status,
                `${after.symbol ?? after.mint} on ${after.protocolName ?? after.protocolId} is no longer active.`));
        }

        const oldValue = numberOrNull(before.collateralValueUsd);
        const newValue = numberOrNull(after.collateralValueUsd);
        if (oldValue !== null && newValue !== null && oldValue >= collateralValueFloorUsd && newValue < oldValue) {
            const dropPct = ((oldValue - newValue) / oldValue) * 100;
            if (dropPct >= collateralDropPct) {
                events.push(event('collateral-value-drop', after, oldValue, newValue,
                    `${after.symbol ?? after.mint} collateral on ${after.protocolName ?? after.protocolId} fell `
                    + `${dropPct.toFixed(1)}%, from ${usd(oldValue)} to ${usd(newValue)}.`,
                { dropPct: numberOrNull(dropPct) }));
            }
        }
    }

    events.sort((a, b) => (KIND_ORDER.get(a.kind) - KIND_ORDER.get(b.kind))
        || compareText(a.symbol ?? '', b.symbol ?? '')
        || compareText(a.mint, b.mint)
        || compareText(a.protocolId, b.protocolId));

    const counts = emptyCounts();
    for (const item of events) counts[item.kind] += 1;
    return {
        from: previous?.date ?? null,
        to: current?.date ?? null,
        fromFetchedAt: previous?.fetchedAt ?? null,
        toFetchedAt: current?.fetchedAt ?? null,
        counts,
        // Rows recorded as the baseline of a measurement that ran for the first time.
        baselined,
        events
    };
}

/** Compact lines intended for the existing single 06:00 UTC bot-monitor digest. */
export function formatDefiNoticeLines(diff, maxDetails = 6) {
    if (!diff?.events?.length) return [];
    const countLabel = {
        'token-added': ['token added to a protocol', 'tokens added to protocols'],
        'token-removed': ['token removed from a protocol', 'tokens removed from protocols'],
        'ltv-changed': ['maximum LTV change', 'maximum LTV changes'],
        'market-inactive': ['market became inactive', 'markets became inactive'],
        'collateral-value-drop': ['sharp collateral-value drop', 'sharp collateral-value drops'],
        'market-added': ['new protocol market for a token', 'new protocol markets for tokens'],
        'market-removed': ['protocol market dropped for a token', 'protocol markets dropped for tokens'],
        'defi-integration-added': ['protocol newly holding a token on-chain', 'protocols newly holding tokens on-chain'],
        'defi-integration-candidate': ['unknown program holding a token (review)', 'unknown programs holding tokens (review)'],
        'defi-integration-removed': ['protocol no longer holding a visible balance', 'protocols no longer holding visible balances']
    };
    const countText = DEFI_CHANGE_KINDS
        .map(({ id }) => [diff.counts?.[id] ?? 0, id])
        .filter(([count]) => count > 0)
        .map(([count, id]) => `${count} ${countLabel[id][count === 1 ? 0 : 1]}`)
        .join(', ');
    const lines = [`RWA DeFi watch ${diff.from ?? '?'} → ${diff.to ?? '?'}: ${diff.events.length} change(s) — ${countText}`];
    for (const item of diff.events.slice(0, maxDetails)) {
        const slug = textOrNull(item.cardSlug) ?? fmt.cardSlug(item.symbol, item.mint);
        const assetUrl = slug ? ` · https://rwasonar.com/cards/${slug}.html` : '';
        lines.push(`  • ${item.summary}${assetUrl}`);
    }
    if (diff.events.length > maxDetails) {
        lines.push(`  • …and ${diff.events.length - maxDetails} more`);
    }
    lines.push('Evidence: https://rwasonar.com/monitor.html#defiChangesSection');
    return lines;
}

/**
 * Merge the on-chain footprint diff into the registry diff for the same day, so the journal,
 * monitor and morning digest carry both. Counts cover every declared kind.
 */
export function mergeFootprintDiff(registryDiff, footprintDiff) {
    const base = registryDiff ?? { from: footprintDiff?.from ?? null, to: footprintDiff?.to ?? null, counts: {}, events: [] };
    const events = [...(base.events ?? []), ...(footprintDiff?.events ?? [])];
    const counts = Object.fromEntries(DEFI_CHANGE_KINDS.map(({ id }) => [id, events.filter((event) => event.kind === id).length]));
    return { ...base, counts, events, footprint: footprintDiff ? { from: footprintDiff.from, to: footprintDiff.to, unreadMints: footprintDiff.unreadMints } : null };
}

const FEED_CHANGE = {
    'token-added': 'added',
    'market-added': 'added',
    'market-removed': 'removed',
    'defi-integration-added': 'added',
    'token-removed': 'removed',
    'defi-integration-removed': 'removed',
    'defi-integration-candidate': 'candidate'
};
const CATEGORY_WEIGHT = { 'yield-vault': 0, lending: 1, perps: 2, structured: 3, 'vault-strategy': 4, dex: 6 };

/**
 * The "New in DeFi" feed: every protocol addition / removal / candidate across the given daily
 * diffs, newest first, one row per (date, token, protocol, change) — a registry observation and an
 * on-chain observation of the same addition on the same day become one row with both sources.
 * Non-DEX integrations sort before DEX pools on the same day because they are rarer and carry
 * custody consequences; DEX pool churn stays in the feed but is grouped by the page.
 */
export function buildDefiNewFeed(diffs, { maxDays = 30, slugs = new Map() } = {}) {
    const rows = new Map();
    const dates = (Array.isArray(diffs) ? diffs : []).map((diff) => diff?.to).filter(Boolean).sort();
    const cutoff = dates.length ? dates[Math.max(0, dates.length - maxDays)] : null;
    for (const diff of Array.isArray(diffs) ? diffs : []) {
        if (!diff?.to || (cutoff && diff.to < cutoff)) continue;
        for (const event of diff.events ?? []) {
            const change = FEED_CHANGE[event.kind];
            if (!change || !event.mint) continue;
            const detectedBy = event.detectedBy === 'chain' ? 'chain' : 'registry';
            const key = `${diff.to}|${event.mint}|${event.protocolId ?? event.programId}|${event.market?.address ?? ''}|${change}`;
            const existing = rows.get(key);
            if (existing) {
                if (!existing.detectedBy.includes(detectedBy)) existing.detectedBy.push(detectedBy);
                continue;
            }
            rows.set(key, {
                date: diff.to,
                change,
                kind: event.kind,
                severity: event.severity ?? 'info',
                detectedBy: [detectedBy],
                mint: event.mint,
                symbol: event.symbol ?? null,
                issuer: event.issuer ?? null,
                cardSlug: event.cardSlug ?? slugs.get(event.mint) ?? null,
                protocolId: event.protocolId ?? null,
                protocolName: event.protocolName ?? event.protocolId ?? event.programId ?? null,
                programId: event.programId ?? null,
                category: event.category ?? null,
                market: event.market ?? null,
                basis: event.basis ?? null,
                summary: event.summary ?? null
            });
        }
    }
    const items = [...rows.values()].sort((a, b) => b.date.localeCompare(a.date)
        || (CATEGORY_WEIGHT[a.category] ?? 5) - (CATEGORY_WEIGHT[b.category] ?? 5)
        || ['added', 'candidate', 'removed'].indexOf(a.change) - ['added', 'candidate', 'removed'].indexOf(b.change)
        || String(a.symbol).localeCompare(String(b.symbol)));
    const count = (change, dex) => items.filter((row) => row.change === change && (dex ? row.category === 'dex' : row.category !== 'dex')).length;
    return {
        days: dates.filter((date) => !cutoff || date >= cutoff),
        counts: {
            added: count('added', false), removed: count('removed', false), candidates: count('candidate', false) + count('candidate', true),
            dexPoolsAdded: count('added', true), dexPoolsRemoved: count('removed', true)
        },
        items
    };
}
