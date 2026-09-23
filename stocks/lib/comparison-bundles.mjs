// Scoped, generated decision payloads for one underlying with any number of wrappers. Full issuer
// documents and the complete token catalogue stay behind their dedicated research routes.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// The same pure modules stocks.html runs (UMD, next-steps.md F11), so a bundle and the page agree.
const { sameUnderlyingGroups } = require('./discovery.js');
const { sameStockComparisonModels, comparisonBundleFilename } = require('./comparison-shape.js');
const { defiUsageIndex } = require('./defi-view.js');
const { cardSlug } = require('./fmt.js');

export function buildComparisonBundles({ issuerDb, tokenDb, defiUsage = null, composability = null, reviewQueue = null }) {
    const issuers = new Map((issuerDb?.issuers ?? []).map((issuer) => [issuer.slug, issuer]));
    const usage = defiUsageIndex(defiUsage);
    const builtAt = tokenDb?.builtAt ?? issuerDb?.builtAt ?? null;
    const observedMs = Date.parse(builtAt ?? '');
    const pending = new Set((reviewQueue?.items ?? []).filter((item) => item.priority === 'P0').map((item) => item.issuerSlug));
    return sameUnderlyingGroups(tokenDb?.tokens, { includeSingle: true }).map((group) => ({
        schemaVersion: 1,
        ticker: group.ticker,
        builtAt,
        sources: {
            tokensBuiltAt: tokenDb?.builtAt ?? null,
            issuersBuiltAt: issuerDb?.builtAt ?? null,
            defiFetchedAt: defiUsage?.fetchedAt ?? null,
            templateReviewedAt: composability?.reviewedAt ?? null
        },
        models: sameStockComparisonModels(group, issuers, usage, composability, Number.isFinite(observedMs) ? observedMs : 0)
            .map((model) => ({ ...model, tokens: model.tokens.map((token) => ({
                mint: token.mint, symbol: token.symbol ?? null, issuer: token.issuer,
                underlyingTicker: token.underlyingTicker,
                cardSlug: token.cardSlug || cardSlug(token.symbol, token.mint)
            })) })),
        reviewPendingIssuers: group.rows.map((row) => row.issuer).filter((slug) => pending.has(slug))
    }));
}

export function comparisonBundleIndex(bundles) {
    return {
        schemaVersion: 1,
        builtAt: bundles[0]?.builtAt ?? null,
        groups: bundles.map((bundle) => ({
            ticker: bundle.ticker, path: comparisonBundleFilename(bundle.ticker),
            issuerCount: bundle.models.length,
            tokenCount: bundle.models.reduce((count, model) => count + model.tokens.length, 0),
            issuers: bundle.models.map((model) => model.issuerSlug),
            mints: bundle.models.flatMap((model) => model.tokens.map((token) => token.mint))
        }))
    };
}
