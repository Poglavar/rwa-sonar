// Scoped, generated decision payloads for one underlying with any number of wrappers. Full issuer
// documents and the complete token catalogue stay behind their dedicated research routes.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// The same pure modules stocks.html runs (UMD, next-steps.md F11), so a bundle and the page agree.
const { sameUnderlyingGroups } = require('./discovery.js');
const { buyerPowers, sameStockComparisonModels, comparisonBundleFilename } = require('./comparison-shape.js');
const { defiUsageIndex } = require('./defi-view.js');
const { cardSlug } = require('./fmt.js');
const { compactLenders } = require('./closed-market-view.js');

function num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function present(value) {
    return value === true || (typeof value === 'string' && value.trim() !== '');
}

/**
 * The catalogue token cut to what the comparison and its buyer table read, in the catalogue's own
 * field names so the page reads a bundle token and a catalogue token alike. `closedMarket` is the
 * lender labels from stocks-closed-market.json: [] when the file was read and no lender takes the
 * token, and absent when the file was not built, so an unread file never reads as "no lender".
 */
function slimToken(token, closedByMint) {
    const control = token.control && typeof token.control === 'object' ? token.control : null;
    const slim = {
        mint: token.mint, symbol: token.symbol ?? null, issuer: token.issuer,
        underlyingTicker: token.underlyingTicker,
        cardSlug: token.cardSlug || cardSlug(token.symbol, token.mint),
        market: { usdPrice: num(token.market?.usdPrice), liquidity: num(token.market?.liquidity), vol24: num(token.market?.vol24) },
        reference: { price: num(token.reference?.price), premiumPct: num(token.reference?.premiumPct), source: token.reference?.source ?? null },
        activity: { dexPairs: num(token.activity?.dexPairs), cexMarkets: num(token.activity?.cexMarkets) },
        control: control === null ? null : {
            freezeAuthority: present(control.freezeAuthority),
            permanentDelegate: present(control.permanentDelegate),
            clawback: control.clawback === true,
            pausable: control.pausable === true,
            transferFeeBps: num(control.transferFeeBps),
            transferFeeScheduled: num(control.transferFeeScheduled?.bps) === null ? null : { bps: control.transferFeeScheduled.bps }
        }
    };
    if (closedByMint) {
        slim.closedMarket = compactLenders(closedByMint.get(token.mint) ?? null)
            .map((lender) => ({ protocolName: lender.protocolName, label: lender.label, labelKind: lender.labelKind }));
    }
    return slim;
}

export function buildComparisonBundles({ issuerDb, tokenDb, defiUsage = null, composability = null, reviewQueue = null, closedMarket = null, powerMap = null }) {
    const issuers = new Map((issuerDb?.issuers ?? []).map((issuer) => [issuer.slug, issuer]));
    const usage = defiUsageIndex(defiUsage);
    const builtAt = tokenDb?.builtAt ?? issuerDb?.builtAt ?? null;
    const observedMs = Date.parse(builtAt ?? '');
    const pending = new Set((reviewQueue?.items ?? []).filter((item) => item.priority === 'P0').map((item) => item.issuerSlug));
    const closedByMint = Array.isArray(closedMarket?.items) ? new Map(closedMarket.items.map((item) => [item.mint, item])) : null;
    const powersByIssuer = new Map((powerMap?.issuers ?? []).map((row) => [row.slug, buyerPowers(row)]));
    return sameUnderlyingGroups(tokenDb?.tokens, { includeSingle: true }).map((group) => ({
        schemaVersion: 1,
        ticker: group.ticker,
        builtAt,
        sources: {
            tokensBuiltAt: tokenDb?.builtAt ?? null,
            issuersBuiltAt: issuerDb?.builtAt ?? null,
            defiFetchedAt: defiUsage?.fetchedAt ?? null,
            templateReviewedAt: composability?.reviewedAt ?? null,
            // When the buyer table's numbers were read: prices and liquidity, premiums, lenders, key holders.
            marketFetchedAt: tokenDb?.sources?.universe?.fetchedAt ?? null,
            referencePricesFetchedAt: tokenDb?.sources?.referencePrices?.fetchedAt ?? null,
            closedMarketAt: closedMarket?.asOf ?? closedMarket?.generatedAt ?? null,
            powerMapBuiltAt: powerMap?.builtAt ?? null
        },
        models: sameStockComparisonModels(group, issuers, usage, composability, Number.isFinite(observedMs) ? observedMs : 0, { powersByIssuer })
            .map((model) => ({ ...model, tokens: model.tokens.map((token) => slimToken(token, closedByMint)) })),
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
