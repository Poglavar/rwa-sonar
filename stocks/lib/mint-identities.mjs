// Builds one provenance-first identity register from the market catalogue, issuer exact-mint
// registries, reviewed manual sources and finalized mint-account observations.

import { sponsorMintIndex } from './discovery-candidates.mjs';

const REGISTRY_SOURCE_BY_ISSUER = {
    prestocks: 'prestocks',
    tessera: 'tessera',
    'superstate-opening-bell': 'superstate',
    'xstocks-backed': 'xstocks',
    'backpack-securities': 'backpack'
};

function list(value) {
    return Array.isArray(value) ? value : [];
}

function text(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function countBy(items, field) {
    const counts = {};
    for (const item of items) {
        const key = text(item?.[field]) ?? 'unknown';
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function registryRows(sponsorApis) {
    const rows = [];
    const sourceUrls = sponsorApis?.source?.sources ?? {};
    const xstocksPorAvailable = sourceUrls?.xstocksPor?.ok === true;
    const xstocksPor = new Map(list(sponsorApis?.items?.xstocksPor)
        .map((item) => [text(item?.symbol), item]).filter(([symbol]) => symbol));
    const mapping = {
        prestocks: 'prestocks', tessera: 'tessera', superstate: 'superstate-opening-bell',
        xstocks: 'xstocks-backed', backpack: 'backpack-securities'
    };
    for (const [source, issuer] of Object.entries(mapping)) {
        for (const item of list(sponsorApis?.items?.[source])) {
            const mint = text(item?.mint);
            if (!mint) continue;
            const proof = source === 'xstocks' ? xstocksPor.get(text(item.symbol)) ?? null : null;
            rows.push({
                mint,
                issuer,
                symbol: text(item.symbol) ?? text(item.ticker),
                name: text(item.name) ?? text(item.assetName),
                underlyingTicker: text(item.ticker) ?? text(item.underlyingTicker) ?? text(item.symbol),
                source,
                sourceUrl: text(sourceUrls?.[source]?.url),
                sourceFetchedAt: text(sourceUrls?.[source]?.fetchedAt),
                sourceOk: sourceUrls?.[source]?.ok === true,
                sourceStatus: text(item.sourceStatus),
                tradingHalted: typeof item.tradingHalted === 'boolean' ? item.tradingHalted : null,
                depositEnabled: typeof item.depositEnabled === 'boolean' ? item.depositEnabled : null,
                withdrawEnabled: typeof item.withdrawEnabled === 'boolean' ? item.withdrawEnabled : null,
                proofFeedAvailable: source === 'xstocks' ? xstocksPorAvailable : null,
                proofOfReserves: proof ? {
                    timestamp: text(proof.timestamp),
                    sharesHeld: text(proof.sharesHeld),
                    circulatingSupply: text(proof.circulatingSupply),
                    holdings: list(proof.holdings)
                } : null
            });
        }
    }
    return rows;
}

export function buildMintIdentities({ universe, onchain, identityOnchain = null, sponsorApis, manualMints }) {
    const catalogue = new Map(list(universe?.items).map((item) => [text(item?.mint), item]).filter(([mint]) => mint));
    const chain = new Map([
        ...list(onchain?.items).map((item) => [text(item?.mint), item]),
        ...list(identityOnchain?.items).map((item) => [text(item?.mint), item])
    ].filter(([mint]) => mint));
    const manual = new Map(list(manualMints).map((item) => [text(item?.mint), item]).filter(([mint]) => mint));
    const exact = sponsorMintIndex(sponsorApis);
    const registry = new Map(registryRows(sponsorApis).map((item) => [item.mint, item]));
    const allMints = new Set([...catalogue.keys(), ...registry.keys(), ...manual.keys()]);

    const items = [...allMints].sort().map((mint) => {
        const market = catalogue.get(mint) ?? null;
        const issuerRecord = registry.get(mint) ?? null;
        const reviewed = manual.get(mint) ?? null;
        const chainRecord = chain.get(mint) ?? null;
        const issuer = text(issuerRecord?.issuer) ?? text(reviewed?.issuer) ?? text(market?.issuer);
        const exactMatch = exact.has(mint);
        const registrySource = REGISTRY_SOURCE_BY_ISSUER[issuer] ?? null;
        const registryMeta = registrySource ? sponsorApis?.source?.sources?.[registrySource] : null;
        const registryAvailable = registryMeta?.ok === true;
        let identityStatus = 'programme-corroborated';
        if (exactMatch && registryAvailable) identityStatus = 'issuer-confirmed';
        else if (exactMatch) identityStatus = 'issuer-confirmed-last-successful';
        else if (reviewed) identityStatus = 'reviewed-primary-source';
        else if (registryAvailable) identityStatus = 'not-in-current-issuer-registry';

        let currentIssuerRegistry = 'not-published';
        if (exactMatch) currentIssuerRegistry = registryAvailable ? 'listed' : 'last-known-listed';
        else if (registrySource) currentIssuerRegistry = registryAvailable ? 'not-listed' : 'unavailable';

        let analysisStatus = 'pending-catalogue-and-chain';
        if (market && chainRecord) analysisStatus = 'catalogued';
        else if (market) analysisStatus = 'pending-chain-ingestion';
        else if (chainRecord) analysisStatus = 'pending-catalogue-ingestion';

        const rawSupply = text(chainRecord?.supply);
        const proof = issuerRecord?.proofOfReserves ?? null;
        const proofCirculating = text(proof?.circulatingSupply);
        let operationalStatus = 'insufficient-data';
        if (identityStatus === 'not-in-current-issuer-registry') operationalStatus = 'registry-lifecycle-review';
        else if (!chainRecord) operationalStatus = 'chain-unobserved';
        else if (rawSupply === '0') operationalStatus = 'zero-supply';
        else if (chainRecord.paused === true || issuerRecord?.tradingHalted === true) operationalStatus = 'halted';
        else if (issuer === 'xstocks-backed' && issuerRecord?.proofFeedAvailable !== true) operationalStatus = 'reserve-feed-unavailable';
        else if (issuer === 'xstocks-backed' && proof === null) operationalStatus = 'reserve-evidence-missing';
        else if (issuer === 'xstocks-backed' && proofCirculating === null) operationalStatus = 'reserve-evidence-incomplete';
        else if (issuer === 'xstocks-backed' && Number(proofCirculating) === 0) operationalStatus = 'issuer-reports-zero-circulation';
        else if (issuer === 'xstocks-backed' && Number(proofCirculating) > 0) operationalStatus = 'issuer-reports-positive-circulation';
        else if (issuerRecord?.depositEnabled === true || issuerRecord?.withdrawEnabled === true) operationalStatus = 'issuer-enabled';
        else if (exactMatch) operationalStatus = 'issuer-listed';

        return {
            mint,
            symbol: text(issuerRecord?.symbol) ?? text(reviewed?.symbol) ?? text(market?.symbol),
            name: text(issuerRecord?.name) ?? text(reviewed?.name) ?? text(market?.name),
            issuer,
            underlyingTicker: text(issuerRecord?.underlyingTicker) ?? text(market?.underlyingTicker),
            identityStatus,
            currentIssuerRegistry,
            catalogued: market !== null,
            analysisStatus,
            operationalStatus,
            listedOnJupiter: market?.listedOnJupiter === true,
            seenInLatestSearch: typeof market?.seenInSearch === 'boolean' ? market.seenInSearch : null,
            firstSeenAt: text(market?.firstSeenAt),
            lastSeenAt: text(market?.lastSeenAt),
            issuerRegistry: issuerRecord ? {
                source: issuerRecord.source,
                url: issuerRecord.sourceUrl,
                fetchedAt: issuerRecord.sourceFetchedAt,
                available: issuerRecord.sourceOk,
                sourceStatus: issuerRecord.sourceStatus,
                tradingHalted: issuerRecord.tradingHalted,
                depositEnabled: issuerRecord.depositEnabled,
                withdrawEnabled: issuerRecord.withdrawEnabled,
                proofFeedAvailable: issuerRecord.proofFeedAvailable,
                proofOfReserves: issuerRecord.proofOfReserves
            } : null,
            reviewedSource: reviewed ? { url: text(reviewed.source), note: text(reviewed.note) } : null,
            onchain: chainRecord ? {
                tokenProgram: text(chainRecord.tokenProgram),
                supplyRaw: text(chainRecord.supply),
                mintAuthority: text(chainRecord.mintAuthority),
                freezeAuthority: text(chainRecord.freezeAuthority),
                permanentDelegate: text(chainRecord.permanentDelegateAddress),
                metadataUpdateAuthority: text(chainRecord.metadataUpdateAuthority),
                transferHookProgram: text(chainRecord.transferHookProgram),
                paused: typeof chainRecord.paused === 'boolean' ? chainRecord.paused : null
            } : null
        };
    });

    const sourceTimes = {
        universe: universe?.fetchedAt ?? null,
        onchain: onchain?.fetchedAt ?? null,
        sponsorApis: sponsorApis?.fetchedAt ?? null,
        identityOnchain: identityOnchain?.fetchedAt ?? null
    };
    const builtAt = Object.values(sourceTimes).filter((value) => typeof value === 'string').sort().at(-1) ?? null;

    return {
        fetchedAt: builtAt,
        builtAt,
        sourceTimes,
        counts: {
            total: items.length,
            catalogued: items.filter((item) => item.catalogued).length,
            chainObserved: items.filter((item) => item.onchain !== null).length,
            pendingCatalogueIngestion: items.filter((item) => !item.catalogued).length,
            pendingChainIngestion: items.filter((item) => item.onchain === null).length,
            byIdentityStatus: countBy(items, 'identityStatus'),
            byAnalysisStatus: countBy(items, 'analysisStatus'),
            byOperationalStatus: countBy(items, 'operationalStatus'),
            byIssuer: countBy(items, 'issuer')
        },
        note: 'Issuer-confirmed means the exact mint appears in a successfully fetched issuer-controlled registry. A failed feed is unavailable, never evidence of removal. Catalogue and chain ingestion are separate: registry-only mints remain pending until their chain state and market/legal joins have been collected.',
        items
    };
}
