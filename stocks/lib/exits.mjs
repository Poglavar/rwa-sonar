// Pure construction of stocks-exits.json: for every catalogued wrapper, the observed routes out of
// it (DEX pools per venue, the issuer's redemption route, lending markets that accept it) and one
// row per exact-token protocol integration for the DeFi-usage Sankey on exits.html. Nothing here
// fetches or reads a clock; every value carries the observation time of the file it came from, and
// a missing measurement stays null (a token nobody collected venues for is not a token with $0).

import { buildProtocolDossiers, protocolProofModel } from './protocol-dossiers.mjs';
import { mergeObservationIntoRedemption } from './redemption-feed.mjs';
import redemptionUsability from './redemption-usability.js';

const { describeObservationFeed, scopeObservedExecution, scopeRedemptionTerm } = redemptionUsability;

export const EXITS_SCHEMA = 'rwa-sonar-exits-v1';

/** Venue display names for the DexScreener dexIds seen on Solana stock pools. */
const VENUE_NAMES = { raydium: 'Raydium', orca: 'Orca', meteora: 'Meteora', meteoradbc: 'Meteora (bonding curve)' };

/** The redemption route, strongest evidence first. Each state is a separate, citable fact. */
export const REDEMPTION_ROUTE_STATES = {
    'observed-onchain': 'Redemption observed on-chain',
    operational: 'Route operationally available (official source)',
    'no-public-route': 'No public route found',
    documented: 'Contractual right documented only',
    'no-right': 'No redemption right',
    'not-recorded': 'Not recorded'
};

/** Sankey action columns (the task's vocabulary), in display order. */
export const FLOW_ACTIONS = ['collateral', 'loan', 'liquidity', 'vault'];

function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function sumOrNull(values) {
    const known = values.map(finite).filter((value) => value !== null);
    return known.length ? known.reduce((total, value) => total + value, 0) : null;
}

function range(min, max) {
    const lo = finite(min); const hi = finite(max);
    return lo === null && hi === null ? null : { min: lo ?? hi, max: hi ?? lo };
}

export function venueName(dexId) {
    if (typeof dexId !== 'string' || !dexId) return 'Unknown venue';
    return VENUE_NAMES[dexId] ?? dexId.charAt(0).toUpperCase() + dexId.slice(1);
}

/**
 * One issuer programme's redemption route as separate facts: the documented right, whether an
 * official current source says the route is operational, what the recurring on-chain scan saw,
 * and any stated minimum. No capacity figure exists unless the issuer publishes one, so none is
 * invented; `statedLimit` stays null.
 */
export function redemptionRoute(redemption) {
    const r = redemption && typeof redemption === 'object' ? redemption : null;
    const right = typeof r?.available === 'boolean' ? r.available : null;
    const operational = typeof r?.operationalRouteAvailable === 'boolean' ? r.operationalRouteAvailable : null;
    const observedFlag = r?.successfulRedemptionObserved === true;
    const evidence = r?.operationalEvidence ?? r?.operationalRouteEvidence ?? null;
    const execution = observedFlag ? scopeObservedExecution(r.successfulRedemptionEvidence, { answerScope: 'programme' }) : null;
    const feed = describeObservationFeed(r?.observationFeed ?? null);
    const minimum = scopeRedemptionTerm(r?.minimum ?? null, { field: 'minimum', termScope: r?.termScopes?.minimum, answerScope: 'programme' });
    let state = 'not-recorded';
    if (observedFlag) state = 'observed-onchain';
    else if (operational === true) state = 'operational';
    // A checked source with no published route is a finding even when the flag itself stays null.
    else if (operational === false || text(evidence?.status) === 'checked-no-public-route') state = 'no-public-route';
    else if (right === true) state = 'documented';
    else if (right === false) state = 'no-right';
    return {
        state,
        label: REDEMPTION_ROUTE_STATES[state],
        documentedRight: right,
        kyc: typeof r?.kyc === 'boolean' ? r.kyc : null,
        operational: {
            value: operational,
            status: text(evidence?.status),
            checkedAt: text(evidence?.checkedAt),
            url: text(evidence?.url),
            basis: text(evidence?.basis)
        },
        observed: {
            value: observedFlag ? true : (r?.successfulRedemptionObserved === false ? false : null),
            summary: execution?.summary ?? null,
            products: execution?.observedProducts ?? [],
            latestObservedAt: execution?.detail?.latestObservedAt ?? null,
            checkedAt: execution?.detail?.checkedAt ?? null,
            feedState: feed?.state ?? null,
            feedText: feed?.text ?? null,
            feedCheckedAt: text(r?.observationFeed?.lastScanAt) ?? text(r?.observationFeed?.checkedAt)
        },
        minimum: minimum.value === null ? null : { summary: minimum.summary, completeText: minimum.completeText },
        statedLimit: null
    };
}

/** DEX pools for one token from venues.json, with Meteora's own per-pool reading beside it. */
export function tokenPools(venuesItem, meteoraByPair = new Map()) {
    const pools = [];
    for (const pair of Array.isArray(venuesItem?.dex) ? venuesItem.dex : []) {
        if (!pair || typeof pair.pairAddress !== 'string') continue;
        const direct = meteoraByPair.get(pair.pairAddress) ?? null;
        const directOk = direct && (direct.error === null || direct.error === undefined) && finite(direct.liquidityUsd) !== null;
        pools.push({
            venue: typeof pair.dexId === 'string' ? pair.dexId : null,
            venueName: venueName(pair.dexId),
            pair: pair.pairAddress,
            quote: text(pair.quoteSymbol),
            liquidityUsd: finite(pair.liquidityUsd),
            volume24Usd: finite(pair.volume24Usd),
            url: text(pair.url),
            meteora: directOk ? { liquidityUsd: direct.liquidityUsd, fetchedAt: text(direct.fetchedAt), endpoint: text(direct.endpoint) } : null
        });
    }
    return pools.sort((a, b) => (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1));
}

/** The Sankey action column one integration belongs to. */
export function flowAction(integration) {
    if (integration?.category === 'dex') return 'liquidity';
    if (integration?.category === 'yield-vault') return 'vault';
    if (integration?.category === 'lending') {
        const loan = (integration.markets ?? []).some((m) => typeof m?.loanAddress === 'string');
        return loan ? 'loan' : 'collateral';
    }
    return null;
}

/** USD attached to one integration and what that number measures, or null when none is reported. */
export function flowUsd(integration) {
    const m = integration?.metrics ?? {};
    if (integration?.category === 'dex' && finite(m.liquidityUsd) !== null) return { usd: m.liquidityUsd, basis: 'pool-liquidity' };
    if (finite(m.sizeUsd) !== null) return { usd: m.sizeUsd, basis: 'reported-market-size' };
    return { usd: null, basis: null };
}

/**
 * Everything the page needs, from already-built inputs. `dossierSlugs` (from protocols/index.json)
 * limits dossier links to pages that were actually generated; without it no link is emitted.
 */
export function buildExits({
    tokens = [], issuers = [], venues = {}, meteora = {}, usage = {}, templates = [], marketResearch = {},
    observations = null, dossierSlugs = null, builtAt = null, sources = {}
}) {
    const venueByMint = new Map((venues.items ?? []).map((item) => [item.mint, item]));
    const meteoraByPair = new Map((meteora.items ?? []).map((item) => [item.pairAddress, item]));
    const known = dossierSlugs instanceof Set ? dossierSlugs : new Set();

    // The built issuer file may predate the recurring redemption scan; merge it the way the builder
    // does, stating staleness as of the scan's own generation time rather than a wall clock.
    const issuerOut = {};
    const redemptionBySlug = new Map();
    for (const issuer of issuers) {
        let redemption = issuer.redemption ?? null;
        const entry = observations?.issuers?.[issuer.slug] ?? null;
        if (redemption && !redemption.observationFeed && entry) {
            redemption = mergeObservationIntoRedemption(redemption, entry, { now: observations.generatedAt ?? null });
        }
        redemptionBySlug.set(issuer.slug, redemption);
        issuerOut[issuer.slug] = {
            slug: issuer.slug, name: issuer.name ?? issuer.slug, status: issuer.status ?? null,
            redemption: redemptionRoute(redemption)
        };
    }

    const dossiers = buildProtocolDossiers({
        tokens, issuers: issuers.map((i) => ({ ...i, redemption: redemptionBySlug.get(i.slug) ?? i.redemption })),
        usage, templates, marketResearch
    });
    const dossiersByMint = new Map();
    const flows = [];
    for (const d of dossiers) {
        const proof = protocolProofModel({ proof: d.proof, integration: d.integration, fetchedAt: d.fetchedAt });
        const action = flowAction(d.integration);
        const { usd, basis } = flowUsd(d.integration);
        const row = {
            mint: d.mint, symbol: d.symbol, issuer: d.issuer,
            protocolId: d.integration.protocolId, protocol: d.integration.protocolName ?? d.integration.protocolId,
            category: d.integration.category, action, stage: proof.stage, stageAsOf: proof.asOf,
            usd, usdBasis: basis, dossier: known.has(d.slug) ? d.slug : null,
            integration: d.integration, lenderExit: d.lenderExit
        };
        if (!dossiersByMint.has(d.mint)) dossiersByMint.set(d.mint, []);
        dossiersByMint.get(d.mint).push(row);
        if (action) {
            flows.push({ symbol: row.symbol, mint: row.mint, issuer: row.issuer, protocolId: row.protocolId, protocol: row.protocol,
                action, stage: row.stage, stageAsOf: row.stageAsOf, usd, usdBasis: basis, dossier: row.dossier,
                // A composite vault's collateral also sits in the lending market it routes through;
                // `via` names those legs so the page can say the two links overlap, not add up.
                ...(d.integration.composite ? { composite: true, via: [...new Set((d.integration.route ?? [])
                    .map((leg) => leg.marketName ?? null).filter(Boolean))] } : {}) });
        }
    }

    const outTokens = tokens.map((token) => {
        const venueItem = venueByMint.get(token.mint) ?? null;
        const pools = venueItem ? tokenPools(venueItem, meteoraByPair) : [];
        const rows = dossiersByMint.get(token.mint) ?? [];
        const lending = rows.filter((row) => row.category === 'lending').map((row) => {
            const m = row.integration.metrics ?? {};
            const debt = [...new Set((row.integration.markets ?? []).map((mk) => text(mk?.debtSymbol)).filter(Boolean))].sort();
            return {
                protocolId: row.protocolId, protocol: row.protocol, action: row.action, stage: row.stage, stageAsOf: row.stageAsOf,
                maxLtv: range(m.maxLtvMin, m.maxLtvMax), liquidationLtv: range(m.liquidationLtvMin, m.liquidationLtvMax),
                sizeUsd: row.usd, debt, use: text(row.integration.links?.use), dossier: row.dossier
            };
        }).sort((a, b) => a.protocol.localeCompare(b.protocol));
        const redemption = issuerOut[token.issuer]?.redemption ?? null;
        const observedProducts = redemption?.observed?.products ?? [];
        return {
            mint: token.mint, symbol: token.symbol ?? null, name: token.name ?? null, issuer: token.issuer ?? null,
            underlying: text(token.underlyingTicker), cardSlug: token.cardSlug ?? null,
            // not-collected: venues.json has no record for this mint; none-observed: collected, no pool.
            venueCoverage: venueItem === null ? 'not-collected' : (pools.length ? 'observed' : 'none-observed'),
            dexFetchedAt: text(venueItem?.dexFetchedAt),
            dexLiquidityUsd: venueItem === null ? null : sumOrNull(pools.map((pool) => pool.liquidityUsd)),
            pools,
            redemptionObservedForToken: redemption?.observed?.value === true
                ? observedProducts.some((p) => typeof p === 'string' && typeof token.symbol === 'string' && p.toLowerCase() === token.symbol.toLowerCase())
                : null,
            lending,
            lenderExit: lending.length ? { rating: rows[0].lenderExit?.rating ?? null, label: rows[0].lenderExit?.label ?? null, reason: rows[0].lenderExit?.reason ?? null } : null
        };
    });

    return {
        schema: EXITS_SCHEMA,
        builtAt,
        sources,
        caveats: [
            'DEX liquidity is DexScreener pool liquidity (both sides of the pool), an upper bound on what could be sold. Selling a large part of it would move the price.',
            'Redemption is shown as a route with its evidence state; no issuer publishes a capacity limit, so no dollar figure is shown for it.',
            'Lending markets let a holder borrow against the token without selling it; the lender-exit rating describes what a lender can do after seizure.',
            'Sankey USD mixes two measures, labelled per link: pool liquidity for DEX pools and the protocol-reported market size for lending markets.',
            'A composite vault link (e.g. xStocks Vaults) carries the vault strategy\'s collateral, which also sits in the lending market named in its `via`; those two links overlap and must not be added together.'
        ],
        issuers: issuerOut,
        tokens: outTokens,
        flows
    };
}
