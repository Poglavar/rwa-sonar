// Build and diff typed saved-watch snapshots for comparisons, exact tokens, issuers and protocol
// markets. Every alert names the exact target; a first observation is only a baseline.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// The same pure modules stocks.html runs (UMD, next-steps.md F11), so a server watch and the page agree.
const { comparisonSnapshot, comparisonSnapshotChanges } = require('./saved-items.js');
const { sameStockComparisonModels } = require('./comparison-shape.js');
const { sameUnderlyingGroups } = require('./discovery.js');

function finite(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function pct(value) {
    const number = finite(value);
    return number === null ? 'unknown' : Number(number.toFixed(4)).toString();
}

function sorted(values) {
    return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))].sort();
}

function targetOf(watch) {
    if (watch?.target && typeof watch.target === 'object') return watch.target;
    return { ticker: watch?.underlying_ticker ?? null, issuers: watch?.issuer_slugs ?? [] };
}

function marketMatches(market, key) {
    return Object.values(market ?? {}).some((value) => String(value) === String(key));
}

function tokenSnapshot(watch, data, nowMs) {
    const target = targetOf(watch);
    const token = data.tokens.find((row) => row.mint === target.mint);
    const usage = (data.defiUsage?.items ?? []).find((row) => row.mint === target.mint);
    return {
        type: 'token', target: { mint: target.mint }, savedAt: new Date(nowMs).toISOString(),
        token: token ? {
            present: true, mint: token.mint, symbol: token.symbol ?? null, issuerSlug: token.issuer ?? null,
            underlyingTicker: token.underlyingTicker ?? null, supplyUi: finite(token.supplyUi),
            liquidityUsd: finite(token.market?.liquidity), holderCount: finite(token.market?.holderCount),
            control: {
                mintAuthority: token.control?.mintAuthority ?? null,
                freezeAuthority: token.control?.freezeAuthority ?? null,
                permanentDelegate: token.control?.permanentDelegate ?? null,
                paused: typeof token.control?.paused === 'boolean' ? token.control.paused : null,
                transferFeeBps: finite(token.control?.transferFeeBps),
                hookActive: typeof token.control?.hookActive === 'boolean' ? token.control.hookActive : null,
                rebase: typeof token.control?.rebase === 'boolean' ? token.control.rebase : null
            },
            protocols: sorted((usage?.integrations ?? []).map((row) => row.id))
        } : { present: false, mint: target.mint }
    };
}

function issuerSnapshot(watch, data, nowMs) {
    const target = targetOf(watch);
    const issuer = data.issuers.find((row) => row.slug === target.issuerSlug);
    const mints = sorted(data.tokens.filter((row) => row.issuer === target.issuerSlug).map((row) => row.mint));
    return {
        type: 'issuer', target: { issuerSlug: target.issuerSlug }, savedAt: new Date(nowMs).toISOString(),
        issuer: issuer ? {
            present: true, slug: issuer.slug, name: issuer.name ?? issuer.slug, status: issuer.status ?? null,
            tokenMints: mints, discrepancyIds: sorted((issuer.discrepancies ?? []).map((row) => row.id)),
            redemptionRouteAvailable: typeof issuer.redemption?.operationalRouteAvailable === 'boolean'
                ? issuer.redemption.operationalRouteAvailable : null,
            evidenceLastCheckedAt: issuer.evidence?.lastCheckedAt ?? null,
            evidencePending: issuer.legalReview?.pending ?? null
        } : { present: false, slug: target.issuerSlug, tokenMints: mints }
    };
}

function protocolMarketSnapshot(watch, data, nowMs) {
    const target = targetOf(watch);
    const usage = (data.defiUsage?.items ?? []).find((row) => row.mint === target.mint);
    const integration = usage?.integrations?.find((row) => row.id === target.integrationId);
    const market = integration?.markets?.find((row) => marketMatches(row, target.marketKey));
    const research = (data.protocolMarketResearch?.markets ?? []).find((row) =>
        row.tokenMint === target.mint && row.integrationId === target.integrationId
        && [row.id, row.marketAddress, row.collateralReserve, row.debtReserve]
            .some((value) => String(value) === String(target.marketKey)));
    const configuration = research?.configuration ?? {};
    const status = configuration.reserveStatus ?? integration?.status ?? null;
    const metricLtv = finite(integration?.metrics?.maxLtvMax);
    const metricLiquidation = finite(integration?.metrics?.liquidationLtvMax);
    const maxLtvPct = finite(configuration.maxLtvPct) ?? (metricLtv === null ? null : metricLtv * 100);
    const collateralValueUsd = finite(research?.registryObservation?.reportedSizeUsd)
        ?? finite(integration?.metrics?.sizeUsd) ?? finite(integration?.metrics?.supplyUsd);
    return {
        type: 'protocol-market',
        target: { mint: target.mint, integrationId: target.integrationId, marketKey: target.marketKey },
        savedAt: new Date(nowMs).toISOString(),
        market: integration && market ? {
            present: true, mint: target.mint, symbol: usage?.symbol ?? null,
            integrationId: integration.id, protocol: integration.protocolName ?? integration.protocolId ?? null,
            marketKey: target.marketKey, marketName: market.name ?? null, status,
            active: ['live', 'active'].includes(String(status).toLowerCase()),
            maxLtvPct, collateralValueUsd,
            liquidationLtvPct: finite(configuration.liquidationLtvPct)
                ?? (metricLiquidation === null ? null : metricLiquidation * 100),
            observedAt: research?.observedAt ?? integration?.corroboration?.checkedAt ?? data.defiUsage?.fetchedAt ?? null
        } : {
            present: false, mint: target.mint, symbol: usage?.symbol ?? null,
            integrationId: target.integrationId, marketKey: target.marketKey
        }
    };
}

export function buildWatchSnapshot(watch, {
    issuers, tokens, defiUsage, composability, protocolMarketResearch = null
}, nowMs = Date.now()) {
    const type = watch.watch_type ?? 'comparison';
    const data = { issuers, tokens, defiUsage, composability, protocolMarketResearch };
    if (type === 'token') return tokenSnapshot(watch, data, nowMs);
    if (type === 'issuer') return issuerSnapshot(watch, data, nowMs);
    if (type === 'protocol-market') return protocolMarketSnapshot(watch, data, nowMs);
    const group = sameUnderlyingGroups(tokens, { includeSingle: true })
        .find((row) => row.ticker === watch.underlying_ticker);
    if (!group) return { ...comparisonSnapshot(watch.underlying_ticker, []), type: 'comparison' };
    const issuerMap = new Map(issuers.map((row) => [row.slug, row]));
    const defiMap = new Map((defiUsage?.items ?? []).map((row) => [row.mint, row]));
    const selected = new Set(watch.issuer_slugs ?? []);
    const models = sameStockComparisonModels(group, issuerMap, defiMap, composability, nowMs)
        .filter((model) => selected.has(model.issuerSlug));
    return { ...comparisonSnapshot(group.ticker, models), type: 'comparison' };
}

function tokenChanges(before, after) {
    const id = `${after?.symbol ?? before?.symbol ?? 'Token'} ${after?.mint ?? before?.mint}`;
    if (before?.present && !after?.present) return [`${id}: exact token removed from the catalogue`];
    if (!before?.present && after?.present) return [`${id}: exact token added to the catalogue`];
    if (!before?.present || !after?.present) return [];
    const changes = [];
    if (before.issuerSlug !== after.issuerSlug) changes.push(`${id}: issuer attribution changed from ${before.issuerSlug ?? 'unknown'} to ${after.issuerSlug ?? 'unknown'}`);
    if (JSON.stringify(before.control) !== JSON.stringify(after.control)) changes.push(`${id}: on-chain control configuration changed`);
    if (JSON.stringify(before.protocols) !== JSON.stringify(after.protocols)) changes.push(`${id}: exact-token protocol support changed`);
    if (finite(before.liquidityUsd) !== null && before.liquidityUsd >= 100_000
        && finite(after.liquidityUsd) !== null && after.liquidityUsd < before.liquidityUsd * 0.75) {
        changes.push(`${id}: reported liquidity fell at least 25%`);
    }
    return changes;
}

function issuerChanges(before, after) {
    const id = after?.name ?? before?.name ?? after?.slug ?? before?.slug ?? 'Issuer';
    if (before?.present && !after?.present) return [`${id}: issuer removed from the catalogue`];
    if (!before?.present && after?.present) return [`${id}: issuer added to the catalogue`];
    if (!before?.present || !after?.present) return [];
    const changes = [];
    if (before.status !== after.status) changes.push(`${id}: programme status changed from ${before.status ?? 'unknown'} to ${after.status ?? 'unknown'}`);
    const beforeMints = new Set(before.tokenMints ?? []);
    const afterMints = new Set(after.tokenMints ?? []);
    for (const mint of afterMints) if (!beforeMints.has(mint)) changes.push(`${id}: exact token added ${mint}`);
    for (const mint of beforeMints) if (!afterMints.has(mint)) changes.push(`${id}: exact token removed ${mint}`);
    if (before.redemptionRouteAvailable !== after.redemptionRouteAvailable) changes.push(`${id}: operational-redemption conclusion changed`);
    if (JSON.stringify(before.discrepancyIds) !== JSON.stringify(after.discrepancyIds)) changes.push(`${id}: reviewed claim-versus-reality discrepancies changed`);
    return changes;
}

function protocolMarketChanges(before, after) {
    const id = `${after?.symbol ?? before?.symbol ?? 'Token'} ${after?.mint ?? before?.mint} · `
        + `${after?.protocol ?? before?.protocol ?? after?.integrationId ?? before?.integrationId} · `
        + `${after?.marketName ?? before?.marketName ?? after?.marketKey ?? before?.marketKey}`;
    if (before?.present && !after?.present) return [`${id}: exact protocol market removed`];
    if (!before?.present && after?.present) return [`${id}: exact protocol market added`];
    if (!before?.present || !after?.present) return [];
    const changes = [];
    if (before.active !== after.active) changes.push(`${id}: market became ${after.active ? 'active' : 'inactive'}`);
    if (finite(before.maxLtvPct) !== finite(after.maxLtvPct)) {
        changes.push(`${id}: maximum LTV changed from ${pct(before.maxLtvPct)}% to ${pct(after.maxLtvPct)}%`);
    }
    if (finite(before.collateralValueUsd) !== null && before.collateralValueUsd >= 100_000
        && finite(after.collateralValueUsd) !== null && after.collateralValueUsd < before.collateralValueUsd * 0.75) {
        changes.push(`${id}: reported collateral value fell at least 25%`);
    }
    return changes;
}

export function diffWatch(watch, current) {
    if (!watch.baseline) return [];
    const type = current?.type ?? watch.watch_type ?? 'comparison';
    let summaries;
    if (type === 'token') summaries = tokenChanges(watch.baseline.token, current.token);
    else if (type === 'issuer') summaries = issuerChanges(watch.baseline.issuer, current.issuer);
    else if (type === 'protocol-market') summaries = protocolMarketChanges(watch.baseline.market, current.market);
    else summaries = comparisonSnapshotChanges(watch.baseline, current);
    return summaries.map((summary) => ({
        watchId: watch.watch_id, type, target: targetOf(watch), ticker: watch.underlying_ticker ?? null,
        title: watch.title || null, summary
    }));
}

function watchName(event) {
    if (event.title) return event.title;
    if (event.ticker) return event.ticker;
    if (event.type === 'token') return `Token ${event.target?.mint ?? ''}`.trim();
    if (event.type === 'issuer') return `Issuer ${event.target?.issuerSlug ?? ''}`.trim();
    if (event.type === 'protocol-market') return `Market ${event.target?.integrationId ?? ''}`.trim();
    return 'Saved watch';
}

export function formatWatchNoticeLines(events, maxLines = 6) {
    if (!Array.isArray(events) || events.length === 0) return [];
    const lines = [`Saved watches: ${events.length} material change${events.length === 1 ? '' : 's'}.`];
    for (const event of events.slice(0, Math.max(0, maxLines - 1))) lines.push(`${watchName(event)}: ${event.summary}`);
    if (events.length > maxLines - 1) lines.push(`…and ${events.length - (maxLines - 1)} more watch change(s).`);
    return lines.slice(0, maxLines);
}
