// Pure construction of observed, mint-specific DeFi usage. This is deliberately separate from
// composability.mjs: a token may be structurally usable but have no live integration, or be accepted
// by a protocol whose legal and control assumptions remain weak.

import { byString } from './io.mjs';
import { LOOPSCALE_PROGRAM_ID, STABLE_PRINCIPALS, loopscaleUsage } from './loopscale.mjs';

export const DEFI_ACTION_LABELS = {
    swap: 'Swap',
    'provide-liquidity': 'Provide liquidity',
    collateral: 'Use as collateral',
    borrow: 'Borrow against',
    lend: 'Supply / lend',
    deposit: 'Deposit in vault',
    'earn-yield': 'Earn yield'
};

export const DEFI_ACTION_MECHANISMS = {
    swap: { custody: 'atomic', enforcement: 'smart-contract', consequence: 'Exchange the token against pool liquidity.' },
    'provide-liquidity': { custody: 'protocol', enforcement: 'smart-contract', consequence: 'Pool contracts custody the deposited token until an LP withdrawal.' },
    collateral: { custody: 'protocol', enforcement: 'smart-contract', consequence: 'The protocol can retain and liquidate posted collateral under its market rules.' },
    borrow: { custody: 'protocol', enforcement: 'smart-contract', consequence: 'Borrowing is limited by configured collateral and liquidation parameters.' },
    lend: { custody: 'protocol', enforcement: 'smart-contract', consequence: 'The protocol records a programmatic claim on supplied assets.' },
    deposit: { custody: 'protocol', enforcement: 'smart-contract-plus-operator', consequence: 'The vault controls deposited assets; strategy and withdrawal rules may add operator dependencies.' },
    'earn-yield': { custody: 'protocol', enforcement: 'smart-contract-plus-operator', consequence: 'Returns depend on the vault strategy and its underlying protocols.' }
};

const DEX_PROTOCOLS = [
    { pattern: /^raydium(?:-|$)/, id: 'raydium', name: 'Raydium', lp: true },
    { pattern: /^orca(?:-|$)/, id: 'orca', name: 'Orca', lp: true },
    { pattern: /^meteora$/, id: 'meteora', name: 'Meteora', lp: true },
    { pattern: /^meteoradbc$/, id: 'meteora', name: 'Meteora', lp: false }
];

const ACCESS_BY_ISSUER = {
    'superstate-opening-bell': 'Only Superstate-verified, allowlisted holders and protocol accounts can use the market.',
    'xstocks-backed': 'Issuer eligibility and the protocol’s geographic restrictions apply; direct issuer redemption remains KYC-gated.'
};

function num(value) {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
}

function sum(values) {
    const finite = values.map(num).filter((value) => value !== null);
    return finite.length === 0 ? null : finite.reduce((total, value) => total + value, 0);
}

function unique(values) {
    return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()))].sort(byString);
}

function text(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function firstText(...values) {
    return values.map(text).find(Boolean) ?? null;
}

function range(values) {
    const finite = values.map(num).filter((value) => value !== null);
    return finite.length ? { min: Math.min(...finite), max: Math.max(...finite) } : { min: null, max: null };
}

function tokenAmountUsd(raw, decimals, price) {
    const amount = num(raw);
    const scale = num(decimals);
    const usd = num(price);
    return amount === null || scale === null || usd === null ? null : (amount / (10 ** scale)) * usd;
}

/** Every action is an explicit confirmed capability, not an inference from token compatibility. */
export function capabilityRecords(actions) {
    return unique(Array.isArray(actions) ? actions : []).map((action) => ({
        action,
        label: DEFI_ACTION_LABELS[action] ?? action,
        status: 'confirmed',
        ...(DEFI_ACTION_MECHANISMS[action] ?? {
            custody: 'unknown', enforcement: 'unknown', consequence: 'Confirmed by the integration source; mechanism not yet classified.'
        })
    }));
}

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function accountRef(address, role) {
    const value = text(address);
    return value && SOLANA_ADDRESS_RE.test(value) ? { address: value, role } : null;
}

/** Extract only accounts whose role is published by the protocol or pool source. */
export function integrationAccountRefs(integration) {
    const refs = [];
    for (const market of Array.isArray(integration?.markets) ? integration.markets : []) {
        if (integration?.category === 'dex') refs.push(accountRef(market?.address, 'liquidity-pool'));
        refs.push(accountRef(market?.marketAddress, 'lending-market'));
        refs.push(accountRef(market?.reserveAddress, 'collateral-reserve'));
        refs.push(accountRef(market?.vaultAddress, 'borrow-vault'));
        refs.push(accountRef(market?.bankAddress ?? market?.address, integration?.protocolId === 'project0' ? 'collateral-bank' : null));
        refs.push(accountRef(market?.collateralConfig, 'collateral-config'));
        refs.push(accountRef(market?.collateralVault, 'collateral-vault'));
        refs.push(accountRef(market?.oracleAddress, 'oracle'));
        refs.push(accountRef(market?.obligationAddress, 'obligation'));
        refs.push(accountRef(market?.vaultStateAddress, 'vault-state'));
        refs.push(accountRef(market?.shareMint, 'vault-share-mint'));
        const loan = accountRef(market?.loanAddress, 'loan-account');
        if (loan && integration?.protocolId === 'loopscale') refs.push({ ...loan, expectedOwner: LOOPSCALE_PROGRAM_ID });
    }
    const byIdentity = new Map();
    for (const ref of refs.filter((entry) => entry?.role)) byIdentity.set(`${ref.address}\u0000${ref.role}`, ref);
    return [...byIdentity.values()].sort((a, b) => byString(`${a.role}:${a.address}`, `${b.role}:${b.address}`));
}

function evidenceTier(integration, corroboration) {
    if ((corroboration?.verifiedCount ?? 0) > 0) return 'account-existence-checked';
    const types = new Set((integration?.evidence ?? []).map((row) => row?.type));
    if (types.has('protocol-api') || types.has('deployment-manifest')) return 'protocol-published';
    if (types.has('official-product-page')) return 'reviewed-official-product';
    if (types.has('onchain-account')) return 'onchain-observed';
    return 'market-observed';
}

/** The checks actually performed for one integration; absent checks stay explicit, never implied. */
export function integrationProof(integration) {
    const types = new Set((Array.isArray(integration?.evidence) ? integration.evidence : []).map((row) => row?.type));
    const corroboration = integration?.corroboration ?? null;
    const metrics = integration?.metrics ?? {};
    const sourceStatus = types.has('protocol-api') || types.has('deployment-manifest')
        ? 'exact-token-registry'
        : types.has('official-product-page') ? 'named-product-page'
            : types.has('onchain-account') ? 'onchain-position'
                : types.has('market-data-aggregator') ? 'observed-market' : 'other-source';
    const activityKeys = ['volume24Usd', 'txns24', 'positions', 'debtAgainstCollateralUsd'];
    const activityObserved = activityKeys.some((key) => num(metrics[key]) !== null && num(metrics[key]) > 0);
    return {
        sourceStatus,
        accountExistence: corroboration === null ? 'not-checked'
            : corroboration.status === 'confirmed' ? 'checked'
                : corroboration.status ?? 'unavailable',
        accountCount: num(corroboration?.accountCount),
        existingAccountCount: num(corroboration?.verifiedCount),
        // Only a collector that decoded the protocol's own account bytes from a published layout sets
        // `decoding`; a registry row never does.
        configurationDecoded: integration?.decoding != null,
        ...(integration?.decoding?.observedAt ? { observedAt: integration.decoding.observedAt } : {}),
        readOnlyExecutionSimulated: false,
        activityObserved,
        activityBasis: activityObserved ? activityKeys.filter((key) => num(metrics[key]) !== null && num(metrics[key]) > 0) : []
    };
}

/** Attach batched Solana getMultipleAccounts results without claiming they prove legal meaning. */
export function applyOnchainCorroboration(usage, accountsByAddress, checkedAt, rpcUrl = null) {
    for (const item of Array.isArray(usage?.items) ? usage.items : []) {
        for (const integration of Array.isArray(item?.integrations) ? item.integrations : []) {
            const refs = integrationAccountRefs(integration);
            const accounts = refs.map((ref) => ({ ...ref, ...(accountsByAddress?.get(ref.address) ?? { exists: null }) }));
            const verifiedCount = accounts.filter((account) => account.exists === true).length;
            const missingCount = accounts.filter((account) => account.exists === false).length;
            integration.capabilities = capabilityRecords(integration.actions);
            integration.corroboration = {
                status: refs.length === 0 ? 'not-addressable'
                    : verifiedCount === refs.length ? 'confirmed'
                        : verifiedCount > 0 ? 'partial'
                            : missingCount === refs.length ? 'failed' : 'unavailable',
                checkedAt,
                rpcUrl,
                accountCount: refs.length,
                verifiedCount,
                accounts
            };
            integration.evidenceTier = evidenceTier(integration, integration.corroboration);
            integration.proof = integrationProof(integration);
        }
    }
    if (usage?.counts) {
        const integrations = usage.items.flatMap((item) => item.integrations ?? []);
        usage.counts.accountExistenceChecked = integrations.filter((entry) => entry.evidenceTier === 'account-existence-checked').length;
        usage.counts.withAccountExistenceChecked = usage.items.filter((item) =>
            item.integrations?.some((entry) => entry.evidenceTier === 'account-existence-checked')).length;
    }
    return usage;
}

function dexProtocol(dexId) {
    const id = typeof dexId === 'string' ? dexId.toLowerCase() : '';
    const known = DEX_PROTOCOLS.find((entry) => entry.pattern.test(id));
    if (known) return { ...known, rawId: id };
    const label = id ? id.split(/[-_]/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ') : 'Unknown DEX';
    return { id: id || 'unknown-dex', name: label, lp: false, rawId: id };
}

function activeStatus(liquidityUsd, volume24Usd) {
    return (num(liquidityUsd) ?? 0) > 0 || (num(volume24Usd) ?? 0) > 0 ? 'live' : 'available';
}

/** One record per DEX protocol with one or more pools for this exact mint. */
export function dexUsage(token, venuesItem, meteoraByPair = new Map()) {
    const groups = new Map();
    for (const pair of Array.isArray(venuesItem?.dex) ? venuesItem.dex : []) {
        if (!pair || typeof pair.pairAddress !== 'string') continue;
        const protocol = dexProtocol(pair.dexId);
        if (!groups.has(protocol.id)) groups.set(protocol.id, { protocol, pairs: [] });
        groups.get(protocol.id).pairs.push(pair);
    }

    return [...groups.values()].map(({ protocol, pairs }) => {
        const liquidityUsd = sum(pairs.map((pair) => pair.liquidityUsd));
        const volume24Usd = sum(pairs.map((pair) => pair.volume24Usd));
        const txns24 = sum(pairs.map((pair) => pair.txns24));
        const directMeteora = protocol.id === 'meteora'
            ? pairs.map((pair) => meteoraByPair.get(pair.pairAddress)).filter((pool) => pool && pool.error === null)
            : [];
        const canLp = pairs.some((pair) => dexProtocol(pair.dexId).lp);
        const top = pairs.slice().sort((a, b) => (num(b.liquidityUsd) ?? -1) - (num(a.liquidityUsd) ?? -1))[0];
        return {
            id: `${protocol.id}:pools`,
            protocolId: protocol.id,
            protocolName: protocol.name,
            category: 'dex',
            status: activeStatus(liquidityUsd, volume24Usd),
            actions: canLp ? ['swap', 'provide-liquidity'] : ['swap'],
            summary: canLp
                ? `Swap the token or provide liquidity in ${pairs.length} observed ${protocol.name} pool${pairs.length === 1 ? '' : 's'}.`
                : `Swap the token in ${pairs.length} observed ${protocol.name} pool${pairs.length === 1 ? '' : 's'}.`,
            accessNote: null,
            links: {
                use: typeof top?.url === 'string' ? top.url : null,
                protocol: null
            },
            metrics: { pools: pairs.length, liquidityUsd, volume24Usd, txns24 },
            markets: pairs.map((pair) => ({
                address: pair.pairAddress,
                quoteSymbol: pair.quoteSymbol ?? null,
                liquidityUsd: num(pair.liquidityUsd),
                volume24Usd: num(pair.volume24Usd),
                url: pair.url ?? null
            })),
            evidence: [{
                type: directMeteora.length > 0 ? 'protocol-api' : 'market-data-aggregator',
                url: directMeteora[0]?.endpoint ?? top?.url ?? null,
                note: directMeteora.length > 0
                    ? `${directMeteora.length} pool${directMeteora.length === 1 ? '' : 's'} also resolved in Meteora’s own per-pool API.`
                    : 'The exact pool address and current pool metrics were observed in the Solana DexScreener feed.'
            }]
        };
    }).sort((a, b) => byString(a.protocolId, b.protocolId));
}

/**
 * Kamino, from two keyless sources joined on the exact reserve: the cross-market collateral registry
 * (debt categories and per-debt terms) and every market's own reserve list (which also carries
 * curated/partner markets the registry omits — e.g. the Sentora xStocks Market behind Kraken's
 * xStocks Vaults, found by the on-chain footprint on 2026-09-24). When the reserve accounts were
 * read and decoded (lib/kamino-accounts.mjs), their configured LTV / liquidation threshold replace
 * the API figures and the integration records the decode.
 */
export function kaminoUsage(token, collateralRows, { marketReserves = [], reserveConfigs = new Map(), decodedAt = null, slot = null } = {}) {
    const rows = (Array.isArray(collateralRows) ? collateralRows : [])
        .filter((row) => row?.collateralMint === token?.mint);
    const listedReserves = new Set(rows.map((row) => row.collateralReserve));
    const extra = (Array.isArray(marketReserves) ? marketReserves : [])
        .filter((row) => row?.mint === token?.mint && !listedReserves.has(row.reserve))
        .filter((row) => (num(row.maxLtv) ?? 0) > 0 || (reserveConfigs.get(row.reserve)?.maxLtvPct ?? 0) > 0);
    if (rows.length === 0 && extra.length === 0) return [];
    const configFor = (reserve) => {
        const config = reserveConfigs.get(reserve) ?? null;
        return config && config.liquidityMint === token.mint ? config : null;
    };
    const terms = rows.flatMap((row) => Array.isArray(row.borrowReserveTerms) ? row.borrowReserveTerms : []);
    const maxLtvs = [
        ...rows.map((row) => configFor(row.collateralReserve)?.maxLtvPct ?? null).filter((v) => v !== null).map((v) => v / 100),
        ...rows.filter((row) => !configFor(row.collateralReserve)).flatMap((row) => (row.borrowReserveTerms ?? []).map((term) => num(term.maxLtv))),
        ...extra.map((row) => (configFor(row.reserve)?.maxLtvPct ?? null) !== null ? configFor(row.reserve).maxLtvPct / 100 : num(row.maxLtv))
    ].filter((value) => value !== null);
    const liquidationLtvs = [
        ...rows.map((row) => configFor(row.collateralReserve)?.liquidationLtvPct ?? null).filter((v) => v !== null).map((v) => v / 100),
        ...rows.filter((row) => !configFor(row.collateralReserve)).flatMap((row) => (row.borrowReserveTerms ?? []).map((term) => num(term.liquidationLtv))),
        ...extra.map((row) => configFor(row.reserve)?.liquidationLtvPct ?? null).filter((v) => v !== null).map((v) => v / 100)
    ].filter((value) => value !== null);
    const borrowFactors = range(terms.map((term) => term.borrowFactor));
    const sizeUsd = sum([...rows.map((row) => row.sizeUsd), ...extra.map((row) => row.totalSupplyUsd)]);
    const decodedReserves = [...rows.map((row) => row.collateralReserve), ...extra.map((row) => row.reserve)].filter((reserve) => configFor(reserve));
    const marketRow = (config, extraFields) => ({
        ...extraFields,
        ...(config ? {
            reserveStatus: config.status,
            maxLtv: config.maxLtvPct / 100,
            liquidationLtv: config.liquidationLtvPct / 100,
            liquidationBonusBps: config.minLiquidationBonusBps === config.maxLiquidationBonusBps
                ? config.minLiquidationBonusBps : `${config.minLiquidationBonusBps}-${config.maxLiquidationBonusBps}`
        } : {})
    });
    return [{
        id: 'kamino:collateral',
        protocolId: 'kamino',
        protocolName: 'Kamino',
        category: 'lending',
        status: activeStatus(sizeUsd, null),
        actions: ['collateral', 'borrow'],
        summary: 'Post this exact mint as collateral in a configured Kamino market and borrow an eligible debt asset against it.',
        accessNote: token?.issuer === 'superstate-opening-bell' && token?.symbol === 'FWDI'
            ? `${ACCESS_BY_ISSUER[token.issuer]} The FWDI lending launch is ex-US.`
            : (ACCESS_BY_ISSUER[token?.issuer] ?? 'Kamino eligibility and geographic restrictions apply.'),
        links: {
            use: 'https://kamino.com/borrow',
            protocol: 'https://kamino.com/docs/'
        },
        metrics: {
            sizeUsd,
            maxLtvMin: maxLtvs.length ? Math.min(...maxLtvs) : null,
            maxLtvMax: maxLtvs.length ? Math.max(...maxLtvs) : null,
            liquidationLtvMin: liquidationLtvs.length ? Math.min(...liquidationLtvs) : null,
            liquidationLtvMax: liquidationLtvs.length ? Math.max(...liquidationLtvs) : null,
            borrowFactorMin: borrowFactors.min,
            borrowFactorMax: borrowFactors.max,
            collateralBackingDebtUsd: sum(rows.map((row) => row.collateralBackingDebtUsd)),
            debtAgainstCollateralUsd: sum(rows.map((row) => row.debtAgainstCollateralUsd))
        },
        markets: [
            ...rows.map((row) => marketRow(configFor(row.collateralReserve), {
                name: row.lendingMarketName ?? row.name ?? null,
                marketAddress: firstText(row.lendingMarket),
                reserveAddress: firstText(row.collateralReserve),
                debtReserveAddresses: unique([...(row.borrowReserves ?? []), ...((row.borrowReserveTerms ?? []).map((term) => term?.reserve))]),
                source: 'collateral-registry'
            })),
            ...extra.map((row) => marketRow(configFor(row.reserve), {
                name: row.marketName ?? row.marketDescription ?? null,
                marketAddress: firstText(row.market),
                reserveAddress: firstText(row.reserve),
                curated: row.curated === true,
                sizeUsd: num(row.totalSupplyUsd),
                source: 'market-reserve-list'
            }))
        ],
        debtCategories: unique(rows.map((row) => row.debtCategory)),
        ...(decodedReserves.length ? {
            decoding: {
                observedAt: decodedAt,
                slot,
                scope: `Reserve risk configuration (status, maximum LTV, liquidation threshold, liquidation bonus) of ${decodedReserves.length} collateral reserve${decodedReserves.length === 1 ? '' : 's'} read from the chain; debt-side terms and executions are not decoded.`,
                decoder: 'stocks/lib/kamino-accounts.mjs (offsets verified against @kamino-finance/klend-sdk 12.0.0)',
                idl: null,
                reserves: decodedReserves
            }
        } : {}),
        evidence: [
            ...(rows.length ? [{
                type: 'protocol-api',
                url: 'https://api.kamino.finance/markets/collateral-reserves',
                note: `${rows.length} live registry row${rows.length === 1 ? '' : 's'} match this exact collateral mint.`
            }] : []),
            ...(extra.length ? [{
                type: 'protocol-api',
                url: 'https://api.kamino.finance/v2/kamino-market',
                note: `${extra.length} reserve${extra.length === 1 ? '' : 's'} with a positive LTV for this exact mint in ${unique(extra.map((row) => row.marketName)).join(', ')} (per-market reserve list; not in the cross-market collateral registry).`
            }] : [])
        ]
    }];
}

/** Jupiter returns one row per collateral/debt vault, so one stock mint can have several rows. */
export function jupiterUsage(token, vaults) {
    const rows = (Array.isArray(vaults) ? vaults : [])
        .filter((row) => row?.supplyToken?.address === token?.mint);
    if (rows.length === 0) return [];
    const collateralUsd = sum(rows.map((row) => {
        const raw = num(row.totalSupply);
        const decimals = num(row.supplyToken?.decimals);
        const price = num(row.supplyToken?.price);
        return raw === null || decimals === null || price === null
            ? null
            : (raw / (10 ** decimals)) * price;
    }));
    const maxLtvs = rows.map((row) => num(row.collateralFactor)).filter((value) => value !== null)
        .map((value) => value / 1000);
    const liquidationLtvs = rows.map((row) => num(row.liquidationThreshold)).filter((value) => value !== null)
        .map((value) => value / 1000);
    const positions = sum(rows.map((row) => row.totalPositions));
    // The REST serializer exposes CF/LT in tenths of a percent (750 = 75%), while the Fluid-style
    // liquidation penalty keeps four-decimal percentage precision (300 = 3%).
    const liquidationPenalties = range(rows.map((row) => num(row.liquidationPenalty) === null ? null : num(row.liquidationPenalty) / 10000));
    const supplyUsd = sum(rows.map((row) => tokenAmountUsd(row.totalSupply, row.supplyToken?.decimals, row.supplyToken?.price)));
    const withdrawableUsd = sum(rows.map((row) => tokenAmountUsd(row.withdrawable, row.supplyToken?.decimals, row.supplyToken?.price)));
    const oracleProviders = unique(rows.flatMap((row) => (row.oracleSources ?? [])
        .map((source) => Object.keys(source?.sourceType ?? {})[0])));
    return [{
        id: 'jupiter-lend:collateral',
        protocolId: 'jupiter-lend',
        protocolName: 'Jupiter Lend',
        category: 'lending',
        status: (collateralUsd ?? 0) > 0 || (positions ?? 0) > 0 ? 'live' : 'available',
        actions: ['collateral', 'borrow'],
        summary: 'Post this exact mint as collateral in a Jupiter Lend vault and borrow an enabled debt token against it.',
        accessNote: ACCESS_BY_ISSUER[token?.issuer] ?? 'Jupiter eligibility and geographic restrictions apply.',
        links: {
            use: 'https://jup.ag/lend/borrow',
            protocol: 'https://developers.jup.ag/docs/lend/'
        },
        metrics: {
            sizeUsd: collateralUsd,
            positions,
            maxLtvMin: maxLtvs.length ? Math.min(...maxLtvs) : null,
            maxLtvMax: maxLtvs.length ? Math.max(...maxLtvs) : null,
            liquidationLtvMin: liquidationLtvs.length ? Math.min(...liquidationLtvs) : null,
            liquidationLtvMax: liquidationLtvs.length ? Math.max(...liquidationLtvs) : null,
            liquidationPenaltyMin: liquidationPenalties.min,
            liquidationPenaltyMax: liquidationPenalties.max,
            supplyUsd,
            withdrawableUsd,
            oracleProviders
        },
        markets: rows.map((row) => ({
            name: `Borrow ${row.borrowToken?.uiSymbol ?? row.borrowToken?.symbol ?? 'debt asset'}`,
            vaultId: row.id ?? null,
            vaultAddress: firstText(row.address),
            debtMint: row.borrowToken?.address ?? null,
            debtSymbol: row.borrowToken?.uiSymbol ?? row.borrowToken?.symbol ?? null,
            oracleAddress: firstText(row.oracle),
            oracleProviders: unique((row.oracleSources ?? []).map((source) => Object.keys(source?.sourceType ?? {})[0]))
        })),
        evidence: [{
            type: 'protocol-api',
            url: 'https://api.jup.ag/lend/v1/borrow/vaults',
            note: `${rows.length} current vault row${rows.length === 1 ? '' : 's'} match this exact collateral mint.`
        }]
    }];
}

/** Nest publishes a versioned mainnet deployment manifest with full mint and market addresses. */
export function nestUsage(token, manifest) {
    const rows = (Array.isArray(manifest?.collateral) ? manifest.collateral : [])
        .filter((row) => row?.mint === token?.mint);
    if (rows.length === 0) return [];
    const maxLtvs = rows.map((row) => num(row.borrowLtvBps)).filter((value) => value !== null)
        .map((value) => value / 10000);
    const liquidationLtvs = rows.map((row) => num(row.liquidationThresholdBps)).filter((value) => value !== null)
        .map((value) => value / 10000);
    return [{
        id: 'nest:collateral',
        protocolId: 'nest',
        protocolName: 'Nest',
        category: 'lending',
        status: 'available',
        actions: ['collateral', 'borrow'],
        summary: 'Deposit this exact mint into its configured Nest collateral market and mint the nUSD stablecoin against it.',
        accessNote: ACCESS_BY_ISSUER[token?.issuer] ?? 'Nest eligibility and geographic restrictions apply.',
        links: {
            use: 'https://app.nestusd.com/',
            protocol: 'https://docs.nestusd.com/nest/borrowing/'
        },
        metrics: {
            maxLtvMin: maxLtvs.length ? Math.min(...maxLtvs) : null,
            maxLtvMax: maxLtvs.length ? Math.max(...maxLtvs) : null,
            liquidationLtvMin: liquidationLtvs.length ? Math.min(...liquidationLtvs) : null,
            liquidationLtvMax: liquidationLtvs.length ? Math.max(...liquidationLtvs) : null,
            maxOracleConfidence: range(rows.map((row) => num(row.maxConfidenceBps) === null ? null : num(row.maxConfidenceBps) / 10000)).max,
            maxOracleStalenessSeconds: range(rows.map((row) => row.maxStalenessSeconds)).max,
            oracleProviders: unique(rows.map((row) => row.oracleProvider))
        },
        markets: rows.map((row) => ({
            name: `${row.displaySymbol ?? row.symbol ?? token?.symbol ?? 'Stock'} / nUSD`,
            collateralConfig: row.collateralConfig ?? null,
            collateralVault: row.collateralVault ?? null
        })),
        evidence: [{
            type: 'deployment-manifest',
            url: 'https://docs.nestusd.com/deployments/mainnet.json',
            note: `Nest's ${manifest?.schema ?? 'mainnet'} manifest contains a configured market for this exact collateral mint.`
        }]
    }];
}

/** Project 0's hosted agent API is a current projection of the protocol's on-chain Bank accounts. */
export function project0Usage(token, registry) {
    const rows = (Array.isArray(registry?.banks) ? registry.banks : [])
        .filter((row) => row?.mint === token?.mint)
        .filter((row) => row?.risk_tier === 'Collateral')
        .filter((row) => row?.operational_state === 'Operational')
        .filter((row) => (num(row?.weights?.asset_weight_init) ?? 0) > 0);
    if (rows.length === 0) return [];
    const sizeUsd = sum(rows.map((row) => row?.size?.deposits_usd));
    const weights = rows.map((row) => num(row?.weights?.asset_weight_init)).filter((value) => value !== null);
    return [{
        id: 'project0:collateral',
        protocolId: 'project0',
        protocolName: 'Project 0',
        category: 'lending',
        status: (sizeUsd ?? 0) > 0 ? 'live' : 'available',
        actions: ['lend', 'collateral', 'borrow'],
        summary: 'Supply this exact mint to an operational Project 0 collateral bank and borrow an enabled debt asset against the resulting position.',
        accessNote: ACCESS_BY_ISSUER[token?.issuer] ?? 'Project 0 and issuer eligibility restrictions apply.',
        links: {
            use: 'https://app.0.xyz/',
            protocol: 'https://docs.marginfi.com/guides/borrowing'
        },
        metrics: {
            sizeUsd,
            collateralWeightMin: weights.length ? Math.min(...weights) : null,
            collateralWeightMax: weights.length ? Math.max(...weights) : null,
            maintenanceWeightMin: range(rows.map((row) => row?.weights?.asset_weight_maint)).min,
            maintenanceWeightMax: range(rows.map((row) => row?.weights?.asset_weight_maint)).max,
            utilizationPct: range(rows.map((row) => row?.rates?.utilization_pct)).max,
            depositLimitUsd: sum(rows.map((row) => row?.size?.deposit_limit_usd)),
            borrowLimitUsd: sum(rows.map((row) => row?.size?.borrow_limit_usd)),
            depositCapacityRemainingUsd: sum(rows.map((row) => row?.size?.deposit_capacity_remaining_usd)),
            borrowCapacityRemainingUsd: sum(rows.map((row) => row?.size?.borrow_capacity_remaining_usd))
        },
        markets: rows.map((row) => ({
            name: `${row.venue ?? 'Project 0'} ${row.symbol ?? token?.symbol ?? 'collateral'} bank`,
            bankAddress: row.address ?? null,
            venue: row.venue ?? null,
            operationalState: row.operational_state ?? null
        })),
        evidence: [{
            type: 'protocol-api',
            url: 'https://ai.0.xyz/v1/banks',
            note: `${rows.length} operational collateral bank${rows.length === 1 ? '' : 's'} match this exact mint in Project 0's current bank registry.`
        }]
    }];
}

/** Save's official reserve API publishes the exact liquidity mint and current risk config. */
export function saveUsage(token, registry) {
    const rows = (Array.isArray(registry?.results) ? registry.results : [])
        .filter((row) => row?.reserve?.liquidity?.mintPubkey === token?.mint)
        .filter((row) => (num(row?.reserve?.config?.loanToValueRatio) ?? 0) > 0);
    if (rows.length === 0) return [];
    const maxLtvs = rows.map((row) => num(row?.reserve?.config?.loanToValueRatio)).filter((value) => value !== null)
        .map((value) => value / 100);
    const liquidationLtvs = rows.map((row) => num(row?.reserve?.config?.liquidationThreshold)).filter((value) => value !== null)
        .map((value) => value / 100);
    const liquidationPenalties = rows.map((row) => num(row?.reserve?.config?.liquidationBonus)).filter((value) => value !== null)
        .map((value) => value / 100);
    const configuredAmount = (row, field) => {
        const raw = num(row?.reserve?.config?.[field]);
        const decimals = num(row?.reserve?.liquidity?.mintDecimals);
        return raw === null || decimals === null ? null : raw / (10 ** decimals);
    };
    return [{
        id: 'save:collateral',
        protocolId: 'save',
        protocolName: 'Save',
        category: 'lending',
        // The reserve endpoint proves configuration but does not expose a reliable market-active
        // flag. A residual balance is not enough to call a reserve live.
        status: 'available',
        actions: ['lend', 'collateral', 'borrow'],
        summary: 'Supply this exact mint to a configured Save reserve and use the resulting protocol position as collateral under the reserve’s current risk parameters.',
        accessNote: ACCESS_BY_ISSUER[token?.issuer] ?? 'Save and issuer eligibility restrictions apply.',
        links: { use: 'https://save.finance/', protocol: 'https://docs.save.finance/protocol/parameters' },
        metrics: {
            maxLtvMin: range(maxLtvs).min,
            maxLtvMax: range(maxLtvs).max,
            liquidationLtvMin: range(liquidationLtvs).min,
            liquidationLtvMax: range(liquidationLtvs).max,
            liquidationPenaltyMin: range(liquidationPenalties).min,
            liquidationPenaltyMax: range(liquidationPenalties).max,
            depositLimitTokens: sum(rows.map((row) => configuredAmount(row, 'depositLimit'))),
            borrowLimitTokens: sum(rows.map((row) => configuredAmount(row, 'borrowLimit'))),
            oracleProviders: unique(rows.flatMap((row) => [
                row?.reserve?.liquidity?.pythOracle ? 'pyth' : null,
                row?.reserve?.liquidity?.switchboardOracle ? 'switchboard' : null
            ]))
        },
        markets: rows.map((row) => ({
            name: 'Save lending reserve',
            marketAddress: row?.reserve?.lendingMarket ?? null,
            reserveAddress: row?.reserve?.address ?? row?.reserve?.pubkey ?? null,
            oracleAddress: row?.reserve?.liquidity?.pythOracle ?? row?.reserve?.liquidity?.switchboardOracle ?? null
        })),
        evidence: [{
            type: 'protocol-api',
            url: 'https://api.save.finance/v1/reserves?scope=all',
            note: `${rows.length} current reserve row${rows.length === 1 ? '' : 's'} match this exact mint with a positive collateral LTV.`
        }]
    }];
}

/**
 * One leg of a composite product with the per-asset addresses filled in. `$field` placeholders in a
 * leg (e.g. "$obligation") are replaced from that asset's route record.
 */
function compositeLeg(leg, route) {
    const out = {};
    for (const [field, value] of Object.entries(leg ?? {})) {
        out[field] = typeof value === 'string' && value.startsWith('$') ? (route?.[value.slice(1)] ?? null) : value;
    }
    return out;
}

/**
 * Hand-reviewed products. A composite product (a vault whose strategy uses another protocol, e.g.
 * xStocks Vaults: Veda vault → Sentora strategy → Kamino market → Kamino Earn vault) keeps the
 * whole route per asset: every leg names its protocol, program and exact account, and — when the
 * collector decoded the live position (`observations`) — the position's collateral, debt, LTV and
 * the price fall that would liquidate it.
 */
export function curatedUsage(token, curated, observations = new Map()) {
    return (Array.isArray(curated?.integrations) ? curated.integrations : [])
        .filter((entry) => Array.isArray(entry.mints) && entry.mints.includes(token?.mint))
        .map((entry) => {
            const route = entry.routes?.[token.mint] ?? null;
            const observed = observations.get(`${entry.id}\u0000${token.mint}`) ?? null;
            const legs = route ? (entry.legs ?? []).map((leg) => compositeLeg(leg, route)) : [];
            const lendingLeg = legs.find((leg) => leg.role === 'collateral');
            return {
                id: entry.id,
                protocolId: entry.protocolId,
                protocolName: entry.protocolName,
                category: entry.category,
                status: entry.status,
                actions: entry.actions,
                summary: entry.summary,
                accessNote: entry.accessNote ?? null,
                interface: entry.interface ?? null,
                curator: entry.curator ?? null,
                underlyingProtocols: entry.underlyingProtocols ?? [],
                networkPath: entry.networkPath ?? null,
                ...(entry.composite ? {
                    composite: true,
                    announcedAt: entry.announcedAt ?? null,
                    holderReceives: route?.shareSymbol
                        ? { ...(entry.holderReceives ?? {}), shareSymbol: route.shareSymbol, shareChain: route.shareChain ?? 'solana',
                            shareAddress: route.shareAddress ?? route.solanaShareMint ?? null, solanaShareMint: route.solanaShareMint ?? null,
                            shareSupplyOnSolanaRaw: observed?.shareSupplyRaw ?? null }
                        : (entry.holderReceives ?? null),
                    route: legs,
                    risks: entry.risks ?? [],
                    position: observed?.position ?? null
                } : {}),
                links: entry.links ?? {},
                metrics: observed?.metrics ?? null,
                markets: route ? [{
                    name: lendingLeg?.marketName ?? entry.protocolName,
                    marketAddress: lendingLeg?.marketAddress ?? null,
                    reserveAddress: lendingLeg?.reserveAddress ?? null,
                    debtMint: route.debtMint ?? null,
                    debtSymbol: route.debtSymbol ?? null,
                    obligationAddress: route.obligation ?? null,
                    vaultStateAddress: route.vault ?? null,
                    shareMint: route.solanaShareMint ?? null
                }] : [],
                ...(observed?.decoding ? { decoding: observed.decoding } : {}),
                evidence: entry.evidence ?? []
            };
        });
}

/**
 * Loopscale lending vaults (keyless `tars.loopscale.com/v1/markets/lending_vaults/info`): a vault
 * whose strategy terms name this exact mint as accepted collateral is a standing lender offer.
 * Returned as market rows so they merge into the chain-decoded Loopscale integration when one exists.
 *
 * `vaultAllocation` is the vault's own `allocationInfo.currentAllocationAmount` for this collateral,
 * kept under that name because it does NOT measure the loans: on 2026-09-24 it read $30.5k / $21.3k
 * / $80.6k / $4.0k for TSLAx / NVDAx / SPYx / CRCLx while the Loan accounts held $3,962 of open
 * principal against the four together (stocks/research/after-hours-collateral-pricing.md). What is
 * lent against a token comes from the Loans (lib/loopscale.mjs openPrincipalAgainst).
 */
export function loopscaleVaultMarkets(token, vaults) {
    const rows = [];
    for (const entry of Array.isArray(vaults) ? vaults : []) {
        const terms = entry?.vaultStrategy?.terms?.assetTerms?.[token?.mint];
        if (!terms) continue;
        const principal = STABLE_PRINCIPALS[entry.vault?.principalMint] ?? null;
        const allocationRaw = num(terms.allocationInfo?.currentAllocationAmount);
        const apys = (Array.isArray(terms.durationAndApys) ? terms.durationAndApys : []).map((pair) => num(pair?.[1])).filter((value) => value !== null);
        rows.push({
            name: `${entry.vaultMetadata?.name ?? 'Loopscale lending vault'} (lends ${principal?.symbol ?? 'principal'})`,
            vaultAddress: firstText(entry.vault?.address),
            strategyAddress: firstText(entry.vaultStrategy?.strategy?.address),
            debtMint: entry.vault?.principalMint ?? null,
            debtSymbol: principal?.symbol ?? null,
            vaultAllocation: allocationRaw === null || !principal ? null : allocationRaw / 10 ** principal.decimals,
            vaultAllocationLabel: 'vault allocation counter (currentAllocationAmount); open loans are read from the Loan accounts',
            lenderApyPct: apys.length ? Math.max(...apys) / 10_000 : null,
            depositsEnabled: entry.vault?.depositsEnabled === true,
            paused: entry.pause === true || entry.pause?.paused === true,
            source: 'lending-vault-registry'
        });
    }
    return rows;
}

/**
 * Merge lending-vault offers into the Loopscale integration (or create it from them alone). The
 * vaults say who will lend; they never set how much IS lent. That is the chain-read loan measure,
 * and when the Loan scan ran (`loanScan` non-null) a vault-only token is a measured zero: the scan
 * reads every Loan account of the program, so no Loan names this mint.
 */
function withLoopscaleVaults(token, integrations, vaults, loanScan) {
    const markets = loopscaleVaultMarkets(token, vaults);
    const existing = integrations.find((entry) => entry.protocolId === 'loopscale');
    if (markets.length === 0) {
        if (existing) existing.summary = `${existing.summary} No lending vault lists it; terms are set per lender on the order book.`;
        return integrations;
    }
    const evidence = {
        type: 'protocol-api',
        url: 'https://tars.loopscale.com/v1/markets/lending_vaults/info',
        note: `${markets.length} Loopscale lending vault${markets.length === 1 ? ' accepts' : 's accept'} this exact mint as collateral.`
    };
    const listed = ` ${markets.length} lending vault${markets.length === 1 ? '' : 's'} list${markets.length === 1 ? 's' : ''} it as collateral.`;
    if (existing) {
        existing.summary = `${existing.summary}${listed}`;
        existing.markets = [...(existing.markets ?? []), ...markets];
        existing.evidence = [...(existing.evidence ?? []), evidence];
        return integrations;
    }
    const scanned = loanScan !== null && loanScan !== undefined;
    return [...integrations, {
        id: 'loopscale:collateral',
        protocolId: 'loopscale',
        protocolName: 'Loopscale',
        category: 'lending',
        status: 'available',
        actions: ['collateral', 'borrow'],
        summary: `Borrow against this exact mint from a Loopscale lending vault whose strategy lists it as accepted collateral (fixed-rate, order-book loans).${scanned ? ' No open loan against it was found on-chain.' : ''}`,
        accessNote: ACCESS_BY_ISSUER[token?.issuer] ?? 'Loopscale and issuer eligibility, allowlisting and transfer restrictions apply.',
        links: { use: 'https://app.loopscale.com/', protocol: 'https://docs.loopscale.com/' },
        metrics: scanned
            ? { positions: 0, debtAgainstCollateralUsd: 0, debtLabel: 'open loan principal' }
            : { positions: null, debtAgainstCollateralUsd: null, debtLabel: 'open loan principal' },
        markets,
        evidence: [evidence]
    }];
}

export function buildDefiUsage({ tokens, venues, meteora, kamino, jupiter, nest, project0, save, loopscale = null, curated, fetchedAt,
    kaminoMarkets = null, kaminoReserveConfigs = new Map(), kaminoDecodedAt = null, kaminoSlot = null, compositeObservations = new Map(),
    loopscaleVaults = null }) {
    const venueByMint = new Map((Array.isArray(venues?.items) ? venues.items : []).map((row) => [row.mint, row]));
    const meteoraByPair = new Map((Array.isArray(meteora?.items) ? meteora.items : []).map((row) => [row.pairAddress, row]));
    const kaminoRows = Array.isArray(kamino?.collateralReserves) ? kamino.collateralReserves : [];
    const items = (Array.isArray(tokens) ? tokens : []).map((token) => {
        const integrations = withLoopscaleVaults(token, [
            ...kaminoUsage(token, kaminoRows, { marketReserves: kaminoMarkets?.reserves ?? [], reserveConfigs: kaminoReserveConfigs, decodedAt: kaminoDecodedAt, slot: kaminoSlot }),
            ...jupiterUsage(token, jupiter),
            ...nestUsage(token, nest),
            ...project0Usage(token, project0),
            ...saveUsage(token, save),
            ...loopscaleUsage(token, loopscale),
            ...curatedUsage(token, curated, compositeObservations),
            ...dexUsage(token, venueByMint.get(token.mint), meteoraByPair)
        ], loopscaleVaults, loopscale);
        for (const integration of integrations) {
            integration.capabilities = capabilityRecords(integration.actions);
            integration.corroboration = null;
            integration.evidenceTier = evidenceTier(integration, null);
            integration.proof = integrationProof(integration);
        }
        return {
            mint: token.mint,
            symbol: token.symbol ?? null,
            issuer: token.issuer ?? null,
            confirmedUseCount: integrations.length,
            protocols: unique(integrations.map((entry) => entry.protocolName)),
            actions: unique(integrations.flatMap((entry) => entry.actions ?? [])),
            integrations
        };
    });
    const count = (predicate) => items.filter(predicate).length;
    return {
        fetchedAt,
        methodology: 'Only an exact mint in a live protocol registry, an observed on-chain pool, or a hand-reviewed asset-specific live product is included. Generic Token-2022 compatibility and issuer ecosystem claims are excluded.',
        sources: {
            kamino: { fetchedAt, url: 'https://api.kamino.finance/markets/collateral-reserves', rows: kaminoRows.length,
                markets: kaminoMarkets === null ? null : {
                    url: 'https://api.kamino.finance/v2/kamino-market', count: kaminoMarkets.markets?.length ?? 0,
                    reserves: kaminoMarkets.reserves?.length ?? 0, stockReserves: kaminoMarkets.stockReserves ?? null
                },
                reservesDecoded: kaminoReserveConfigs.size, decodedAt: kaminoDecodedAt, slot: kaminoSlot },
            jupiterLend: { fetchedAt, url: 'https://api.jup.ag/lend/v1/borrow/vaults', rows: Array.isArray(jupiter) ? jupiter.length : 0 },
            nest: {
                fetchedAt,
                url: 'https://docs.nestusd.com/deployments/mainnet.json',
                schema: nest?.schema ?? null,
                rows: Array.isArray(nest?.collateral) ? nest.collateral.length : 0
            },
            project0: {
                fetchedAt,
                url: 'https://ai.0.xyz/v1/banks',
                cachedAt: num(project0?._meta?.cached_at),
                rows: Array.isArray(project0?.banks) ? project0.banks.length : 0
            },
            save: {
                fetchedAt,
                url: 'https://api.save.finance/v1/reserves?scope=all',
                rows: Array.isArray(save?.results) ? save.results.length : 0
            },
            loopscale: loopscale === null ? null : {
                fetchedAt: loopscale.fetchedAt ?? null,
                programId: LOOPSCALE_PROGRAM_ID,
                method: 'every Loan account of the program listed with getProgramAccounts (discriminator filter, collateral slots only); each Loan whose collateral names a tracked mint read in full and decoded from the published IDL. Open principal = principal due − repaid per ledger, stablecoins at $1.',
                loanScanRpc: loopscale.loanScanRpc ?? null,
                loansScanned: loopscale.loansScanned ?? null,
                loans: loopscale.loanCount ?? null,
                positions: Array.isArray(loopscale.positions) ? loopscale.positions.length : 0,
                rpcCalls: loopscale.rpcCalls ?? null,
                slot: loopscale.slot ?? null,
                error: loopscale.error ?? null
            },
            loopscaleVaults: loopscaleVaults === null ? null : { fetchedAt, url: 'https://tars.loopscale.com/v1/markets/lending_vaults/info', rows: loopscaleVaults.length },
            dexPools: { fetchedAt: venues?.fetchedAt ?? null, source: venues?.source ?? null },
            meteora: { fetchedAt: meteora?.fetchedAt ?? null, source: meteora?.source ?? null },
            curated: { reviewedAt: curated?.reviewedAt ?? null, version: curated?.version ?? null }
        },
        counts: {
            assets: items.length,
            withAnyConfirmedUse: count((item) => item.integrations.length > 0),
            withLending: count((item) => item.integrations.some((entry) => entry.category === 'lending')),
            withYieldVault: count((item) => item.integrations.some((entry) => entry.category === 'yield-vault')),
            withDexPool: count((item) => item.integrations.some((entry) => entry.category === 'dex')),
            withNoneConfirmed: count((item) => item.integrations.length === 0),
            integrations: items.reduce((total, item) => total + item.integrations.length, 0)
        },
        items
    };
}
