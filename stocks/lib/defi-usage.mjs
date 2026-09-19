// Pure construction of observed, mint-specific DeFi usage. This is deliberately separate from
// composability.mjs: a token may be structurally usable but have no live integration, or be accepted
// by a protocol whose legal and control assumptions remain weak.

import { byString } from './io.mjs';

export const DEFI_ACTION_LABELS = {
    swap: 'Swap',
    'provide-liquidity': 'Provide liquidity',
    collateral: 'Use as collateral',
    borrow: 'Borrow against',
    deposit: 'Deposit in vault',
    'earn-yield': 'Earn yield'
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

/** A live Kamino registry can repeat one collateral mint by debt category and by lending market. */
export function kaminoUsage(token, collateralRows) {
    const rows = (Array.isArray(collateralRows) ? collateralRows : [])
        .filter((row) => row?.collateralMint === token?.mint);
    if (rows.length === 0) return [];
    const sizeUsd = sum(rows.map((row) => row.sizeUsd));
    const terms = rows.flatMap((row) => Array.isArray(row.borrowReserveTerms) ? row.borrowReserveTerms : []);
    const maxLtvs = terms.map((term) => num(term.maxLtv)).filter((value) => value !== null);
    const liquidationLtvs = terms.map((term) => num(term.liquidationLtv)).filter((value) => value !== null);
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
            liquidationLtvMax: liquidationLtvs.length ? Math.max(...liquidationLtvs) : null
        },
        markets: unique(rows.map((row) => row.lendingMarketName)).map((name) => ({ name })),
        debtCategories: unique(rows.map((row) => row.debtCategory)),
        evidence: [{
            type: 'protocol-api',
            url: 'https://api.kamino.finance/markets/collateral-reserves',
            note: `${rows.length} live registry row${rows.length === 1 ? '' : 's'} match this exact collateral mint.`
        }]
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
            liquidationLtvMax: liquidationLtvs.length ? Math.max(...liquidationLtvs) : null
        },
        markets: rows.map((row) => ({
            name: `Borrow ${row.borrowToken?.uiSymbol ?? row.borrowToken?.symbol ?? 'debt asset'}`,
            vaultId: row.id ?? null,
            debtMint: row.borrowToken?.address ?? null
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
            liquidationLtvMax: liquidationLtvs.length ? Math.max(...liquidationLtvs) : null
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

export function curatedUsage(token, curated) {
    return (Array.isArray(curated?.integrations) ? curated.integrations : [])
        .filter((entry) => Array.isArray(entry.mints) && entry.mints.includes(token?.mint))
        .map((entry) => ({
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
            links: entry.links ?? {},
            metrics: null,
            evidence: entry.evidence ?? []
        }));
}

export function buildDefiUsage({ tokens, venues, meteora, kamino, jupiter, nest, curated, fetchedAt }) {
    const venueByMint = new Map((Array.isArray(venues?.items) ? venues.items : []).map((row) => [row.mint, row]));
    const meteoraByPair = new Map((Array.isArray(meteora?.items) ? meteora.items : []).map((row) => [row.pairAddress, row]));
    const kaminoRows = Array.isArray(kamino?.collateralReserves) ? kamino.collateralReserves : [];
    const items = (Array.isArray(tokens) ? tokens : []).map((token) => {
        const integrations = [
            ...kaminoUsage(token, kaminoRows),
            ...jupiterUsage(token, jupiter),
            ...nestUsage(token, nest),
            ...curatedUsage(token, curated),
            ...dexUsage(token, venueByMint.get(token.mint), meteoraByPair)
        ];
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
            kamino: { fetchedAt, url: 'https://api.kamino.finance/markets/collateral-reserves', rows: kaminoRows.length },
            jupiterLend: { fetchedAt, url: 'https://api.jup.ag/lend/v1/borrow/vaults', rows: Array.isArray(jupiter) ? jupiter.length : 0 },
            nest: {
                fetchedAt,
                url: 'https://docs.nestusd.com/deployments/mainnet.json',
                schema: nest?.schema ?? null,
                rows: Array.isArray(nest?.collateral) ? nest.collateral.length : 0
            },
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
