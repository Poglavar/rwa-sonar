import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// The same pure module stocks.html runs (UMD, next-steps.md F11), so the index and the page agree.
const {
    composabilityTemplateForToken,
    defiProtocolRows,
    defiUsageIndex,
    productDecisionProfile
} = require('./defi-view.js');

function issuerRow(issuer) {
    return {
        slug: issuer.slug,
        name: issuer.name,
        status: issuer.status,
        legalForm: issuer.legalForm ?? null,
        issuingEntity: issuer.issuingEntity ?? null
    };
}

function tokenRow(token, profile) {
    return {
        mint: token.mint,
        symbol: token.symbol ?? null,
        name: token.name ?? null,
        issuer: token.issuer ?? null,
        underlyingTicker: token.underlyingTicker ?? null,
        // A pre-IPO token's comparison key and company (lib/private-companies.mjs); null otherwise.
        companyKey: token.companyKey ?? null,
        companyName: token.companyName ?? null,
        instrumentType: token.instrumentType ?? null,
        cardSlug: token.cardSlug ?? null,
        market: {
            liquidity: Number.isFinite(token?.market?.liquidity) ? token.market.liquidity : null,
            vol24: Number.isFinite(token?.market?.vol24) ? token.market.vol24 : null,
            holderCount: Number.isFinite(token?.market?.holderCount) ? token.market.holderCount : null
        },
        issuerApi: token?.issuerApi?.underlying?.name
            ? { underlying: { name: token.issuerApi.underlying.name } } : null,
        discoveryProfile: profile
    };
}

/**
 * The first page needs identities and precomputed decision filters, not every claim, venue,
 * holder row and protocol market. Keep those full artifacts behind the view that uses them.
 */
export function buildDiscoveryIndex({ issuerDb, tokenDb, defiUsage = null, composability = null }) {
    const issuers = Array.isArray(issuerDb?.issuers) ? issuerDb.issuers : [];
    const tokens = Array.isArray(tokenDb?.tokens) ? tokenDb.tokens : [];
    const byIssuer = new Map(issuers.map((issuer) => [issuer.slug, issuer]));
    const usageByMint = defiUsageIndex(defiUsage);
    const observedAt = Date.parse(tokenDb?.builtAt ?? issuerDb?.builtAt ?? '');
    const nowMs = Number.isFinite(observedAt) ? observedAt : Date.now();
    const compactTokens = tokens.map((token) => tokenRow(token, productDecisionProfile(
        byIssuer.get(token.issuer),
        token,
        usageByMint.get(token.mint)?.integrations ?? [],
        composabilityTemplateForToken(composability, token),
        nowMs
    )));
    return {
        schemaVersion: 1,
        builtAt: tokenDb?.builtAt ?? issuerDb?.builtAt ?? null,
        sources: tokenDb?.sources ?? issuerDb?.sources ?? {},
        counts: { issuers: issuers.length, tokens: tokens.length },
        issuers: issuers.map(issuerRow),
        tokens: compactTokens,
        protocols: defiProtocolRows(defiUsage)
    };
}
