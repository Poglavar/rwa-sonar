import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    comparisonSnapshot, comparisonSnapshotChanges, sameStockComparisonModels, sameUnderlyingGroups
} = require('../../stocks.js');

export function buildWatchSnapshot(watch, { issuers, tokens, defiUsage, composability }, nowMs = Date.now()) {
    const group = sameUnderlyingGroups(tokens).find((row) => row.ticker === watch.underlying_ticker);
    if (!group) return comparisonSnapshot(watch.underlying_ticker, []);
    const issuerMap = new Map(issuers.map((row) => [row.slug, row]));
    const defiMap = new Map((defiUsage?.items ?? []).map((row) => [row.mint, row]));
    const selected = new Set(watch.issuer_slugs ?? []);
    const models = sameStockComparisonModels(group, issuerMap, defiMap, composability, nowMs)
        .filter((model) => selected.has(model.issuerSlug));
    return comparisonSnapshot(group.ticker, models);
}

export function diffWatch(watch, current) {
    if (!watch.baseline) return [];
    return comparisonSnapshotChanges(watch.baseline, current).map((summary) => ({
        watchId: watch.watch_id,
        ticker: watch.underlying_ticker,
        title: watch.title || null,
        summary
    }));
}

export function formatWatchNoticeLines(events, maxLines = 6) {
    if (!Array.isArray(events) || events.length === 0) return [];
    const lines = [`Saved stock watches: ${events.length} material change${events.length === 1 ? '' : 's'}.`];
    for (const event of events.slice(0, Math.max(0, maxLines - 1))) {
        const name = event.title || event.ticker;
        lines.push(`${name}: ${event.summary}`);
    }
    if (events.length > maxLines - 1) lines.push(`…and ${events.length - (maxLines - 1)} more watch change(s).`);
    return lines.slice(0, maxLines);
}
