// Pure shaping, diffing and alert formatting for the daily DeFi protocol watch.
// A human sees "token"; the exact Solana mint address remains the identity/evidence key.

import fmt from './fmt.js';

export const DEFI_CHANGE_KINDS = [
    { id: 'token-added', label: 'Token added to protocol', severity: 'info' },
    { id: 'token-removed', label: 'Token removed from protocol', severity: 'warning' },
    { id: 'ltv-changed', label: 'Maximum LTV changed', severity: 'caution' },
    { id: 'market-inactive', label: 'Market became inactive', severity: 'warning' },
    { id: 'collateral-value-drop', label: 'Collateral value fell sharply', severity: 'caution' }
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
        category: textOrNull(integration?.category),
        status: textOrNull(integration?.status),
        maxLtvMin: numberOrNull(metrics.maxLtvMin),
        maxLtvMax: numberOrNull(metrics.maxLtvMax),
        liquidationLtvMin: numberOrNull(metrics.liquidationLtvMin),
        liquidationLtvMax: numberOrNull(metrics.liquidationLtvMax),
        collateralValueUsd: integration?.category === 'lending' ? numberOrNull(metrics.sizeUsd) : null
    };
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
    const keys = [...new Set([...beforeRows.keys(), ...afterRows.keys()])].sort();
    const events = [];

    for (const key of keys) {
        const before = beforeRows.get(key);
        const after = afterRows.get(key);
        if (!before) {
            events.push(event('token-added', after, null, after.status,
                `${after.symbol ?? after.mint} now appears in ${after.protocolName ?? after.protocolId}'s checked registry.`));
            continue;
        }
        if (!after) {
            events.push(event('token-removed', before, before.status, null,
                `${before.symbol ?? before.mint} no longer appears in ${before.protocolName ?? before.protocolId}'s checked registry.`));
            continue;
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
        'collateral-value-drop': ['sharp collateral-value drop', 'sharp collateral-value drops']
    };
    const countText = DEFI_CHANGE_KINDS
        .map(({ id }) => [diff.counts?.[id] ?? 0, id])
        .filter(([count]) => count > 0)
        .map(([count, id]) => `${count} ${countLabel[id][count === 1 ? 0 : 1]}`)
        .join(', ');
    const lines = [`RWA DeFi watch ${diff.from ?? '?'} → ${diff.to ?? '?'}: ${diff.events.length} change(s) — ${countText}`];
    for (const item of diff.events.slice(0, maxDetails)) {
        const slug = fmt.cardSlug(item.symbol, item.mint);
        const assetUrl = slug ? ` · https://rwasonar.com/cards/${slug}.html` : '';
        lines.push(`  • ${item.summary}${assetUrl}`);
    }
    if (diff.events.length > maxDetails) {
        lines.push(`  • …and ${diff.events.length - maxDetails} more`);
    }
    lines.push('Evidence: https://rwasonar.com/monitor.html#defiChangesSection');
    return lines;
}
