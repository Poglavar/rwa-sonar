#!/usr/bin/env node
// Pulls the issuers' own public APIs — PreStocks, Tessera, Ondo and Superstate — for the facts no chain or
// aggregator carries: the sponsor's mark price and valuation, holder counts, the underlying
// market's stats and the trading/pause status. Writes stocks/data/sponsor-apis.json; each
// source has its own envelope so one failure cannot hide or abort the others.

import { join } from 'node:path';
import { byString, fetchJson, isoDate, log, logError, parseArgs, readJson, ts, writeJson } from './lib/io.mjs';

const HERE = import.meta.dirname;
const DEFAULT_OUT = join(HERE, 'data', 'sponsor-apis.json');
const RAW_DIR = join(HERE, 'data', 'raw');

// Ondo's CDN answers a bare fetch with a challenge page, so ask as a browser would.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const SOURCES = {
    prestocks: { url: 'https://prestocks.com/api/prestocks', headers: { accept: 'application/json' } },
    tessera: { url: 'https://rest-api.tessera.pe/v1/public/token-details', headers: { accept: 'application/json' } },
    ondo: { url: 'https://app.ondo.finance/api/v2/assets', headers: { accept: 'application/json', 'user-agent': BROWSER_UA } },
    superstate: { url: 'https://api.superstate.com/v2/instruments', headers: { accept: 'application/json', 'user-agent': BROWSER_UA } }
};

function usage() {
    console.log(`fetch-sponsor-apis.mjs — collect issuer-side data from PreStocks, Tessera, Ondo and Superstate

USAGE
  node stocks/fetch-sponsor-apis.mjs --run [options]

OPTIONS
  --run                 Actually fetch. Without it this help is printed and nothing runs.
  --only=<a,b>          Fetch a subset of: ${Object.keys(SOURCES).join(', ')}.
  --out=<path>          Output file (default stocks/data/sponsor-apis.json).
  --help                This text.

NOTES
  Each raw response is saved to stocks/data/raw/sponsor-<id>-<date>.json (Ondo is ~3 MB; Superstate ~70 KB, equities only are kept).
  The output keeps a per-source envelope with the HTTP status; a failing source is reported
  at the end and makes the exit code non-zero, but never stops the other sources.`);
}

/** Numbers arrive as strings in these APIs. A missing value must stay null, never become 0. */
function num(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function prestocksItem(entry) {
    const tokenPrice = num(entry.tokenPrice);
    const markPrice = num(entry.markPrice);
    const premiumPct = tokenPrice !== null && markPrice !== null && markPrice > 0
        ? (tokenPrice / markPrice - 1) * 100
        : null;
    return {
        mint: entry.contract_address ?? null,
        symbol: entry.symbol ?? null,
        name: entry.name ?? null,
        description: entry.description ?? null,
        image: entry.image ?? null,
        externalUrl: entry.external_url ?? null,
        markPrice,
        markValuation: num(entry.markValuation),
        tokenPrice,
        impliedValuation: num(entry.impliedValuation),
        supply: num(entry.supply),
        premiumPct
    };
}

function tesseraItem(entry) {
    return {
        mint: entry.mint ?? null,
        id: entry.id ?? null,
        name: entry.name ?? null,
        symbol: entry.symbol ?? null,
        code: entry.code ?? null,
        sector: entry.sector ?? null,
        markPrice: num(entry.markPrice),
        holders: num(entry.holders),
        markValuation: num(entry.markValuation)
    };
}

function ondoItem(asset) {
    const underlying = asset.underlyingMarket ?? {};
    const marketCap = num(underlying.marketCap);
    const sharesOutstanding = num(underlying.sharesOutstanding);
    const impliedUnderlyingPrice = marketCap !== null && sharesOutstanding !== null && marketCap > 0 && sharesOutstanding > 0
        ? marketCap / sharesOutstanding
        : null;
    return {
        symbol: asset.symbol ?? null,
        ticker: asset.ticker ?? null,
        assetName: asset.assetName ?? null,
        createdAt: asset.createdAt ?? null,
        ondoPrice: num(asset.primaryMarket?.price),
        impliedUnderlyingPrice,
        underlying: {
            name: underlying.name ?? null,
            marketCap,
            sharesOutstanding,
            volume: num(underlying.volume),
            averageVolume: num(underlying.averageVolume),
            priceHigh52w: num(underlying.priceHigh52w),
            priceLow52w: num(underlying.priceLow52w)
        },
        tagSlugs: Array.isArray(asset.tags) ? asset.tags.map((t) => t.tagSlug).filter(Boolean) : [],
        isTradingPaused: asset.isTradingPaused ?? null,
        isOffhoursTradable: asset.isOffhoursTradable ?? null,
        tradingStatus: asset.assetTradingStatus ?? null
    };
}

// Superstate's public instrument registry: an object keyed by ticker covering both its funds and the
// Opening Bell equities. Chain id 900 is Solana. Equities carry the CUSIP of the listed share, the
// transfer-agent's total/circulating supply and the split multiplier — the register-side numbers
// a grading step compares against the on-chain mint supply.
const SUPERSTATE_SOLANA_CHAIN_ID = '900';
function superstateItem(instrument) {
    const byChain = instrument.deploy_status_by_chain?.by_chain ?? {};
    const solana = byChain[SUPERSTATE_SOLANA_CHAIN_ID] ?? null;
    const chains = Object.entries(byChain).map(([chainId, d]) => ({ chainId, status: d?.type ?? null, tokenAddress: d?.token_address ?? null }));
    return {
        mint: solana?.token_address ?? null,
        ticker: instrument.instrument_symbol ?? null,
        name: instrument.instrument_name ?? null,
        domain: instrument.instrument_domain ?? null,
        cusip: instrument.cusip ?? null,
        issuerEntityName: instrument.issuer_entity_name ?? null,
        allowlistType: instrument.allowlist_type ?? null,
        equityType: instrument.equity_info?.equity_type ?? null,
        splitMultiplier: num(instrument.equity_info?.current_split_multiplier?.multiplier),
        totalSupply: num(instrument.total_supply),
        circulatingSupply: num(instrument.circulating_supply),
        currentPrice: num(instrument.current_price),
        burnAddressSolana: instrument.equity_burn_addresses_by_chain?.[SUPERSTATE_SOLANA_CHAIN_ID] ?? null,
        solanaDeployedAt: solana?.deployed_contract_address_created_at ?? null,
        features: {
            tokenEnabled: instrument.features?.is_token_enabled_any_chain ?? null,
            tradeEnabled: instrument.features?.is_trade_enabled_any_chain ?? null,
            mintingEnabled: instrument.features?.is_minting_enabled ?? null
        },
        chains
    };
}

const SHAPERS = {
    prestocks: (json) => {
        if (!Array.isArray(json)) throw new Error(`expected an array, got ${typeof json}`);
        return json.map(prestocksItem).sort((a, b) => byString(String(a.mint), String(b.mint)));
    },
    tessera: (json) => {
        if (!Array.isArray(json)) throw new Error(`expected an array, got ${typeof json}`);
        return json.map(tesseraItem).sort((a, b) => byString(String(a.mint), String(b.mint)));
    },
    ondo: (json) => {
        if (!json || !Array.isArray(json.assets)) throw new Error('expected {assets:[...]}');
        // No mint in this payload (it is the sponsor's asset registry, not a token list), so
        // sort by symbol instead.
        return json.assets.map(ondoItem).sort((a, b) => byString(String(a.symbol), String(b.symbol)));
    },
    superstate: (json) => {
        if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('expected an object keyed by ticker');
        // Keep the equities only; the same registry also lists Superstate's funds (USTB, USCC, …).
        return Object.values(json).filter((i) => i?.instrument_domain === 'Equities').map(superstateItem)
            .sort((a, b) => byString(String(a.ticker), String(b.ticker)));
    }
};

async function fetchSource(id) {
    const { url, headers } = SOURCES[id];
    const startedAt = ts();
    log(`${id}: GET ${url}`);
    const res = await fetchJson(url, { headers, timeoutMs: 180000 });
    const rawPath = join(RAW_DIR, `sponsor-${id}-${isoDate()}.json`);
    await writeJson(rawPath, { fetchedAt: startedAt, url, status: res.status, body: res.json ?? res.bodyPreview });
    log(`${id}: HTTP ${res.status}, ${res.bytes} bytes, raw saved to ${rawPath}`);

    const envelope = { url, fetchedAt: startedAt, status: res.status, ok: false, count: 0, error: null, rawFile: `sponsor-${id}-${isoDate()}.json`, items: [] };
    if (!res.ok) {
        envelope.error = `HTTP ${res.status}: ${res.bodyPreview}`;
        return envelope;
    }
    if (res.json === null) {
        envelope.error = `unparseable body: ${res.parseError} :: ${res.bodyPreview}`;
        return envelope;
    }
    try {
        envelope.items = SHAPERS[id](res.json);
        envelope.ok = true;
        envelope.count = envelope.items.length;
    } catch (err) {
        envelope.error = `unexpected payload shape: ${err.message}`;
    }
    return envelope;
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }

    const ids = typeof flags.only === 'string'
        ? flags.only.split(',').map((s) => s.trim()).filter(Boolean)
        : Object.keys(SOURCES);
    for (const id of ids) {
        if (!SOURCES[id]) throw new Error(`unknown source "${id}"; known: ${Object.keys(SOURCES).join(', ')}`);
    }

    const outPath = typeof flags.out === 'string' ? flags.out : DEFAULT_OUT;
    // A partial run (--only) must not discard the other sources' previous results, so start from
    // whatever the output file already holds and overwrite only the sources fetched now.
    const previous = await readJson(outPath, null);
    const sources = { ...(previous?.source?.sources ?? {}) };
    const items = { ...(previous?.items ?? {}) };

    // One source at a time, writing after each, so a later failure keeps the earlier results.
    for (const id of ids) {
        let envelope;
        try {
            envelope = await fetchSource(id);
        } catch (err) {
            envelope = { url: SOURCES[id].url, fetchedAt: ts(), status: null, ok: false, count: 0, error: `${err.name}: ${err.message}`, rawFile: null, items: [] };
            logError(`${id}: ${err.stack ?? err.message}`);
        }
        const { items: sourceItems, ...meta } = envelope;
        sources[id] = meta;
        items[id] = sourceItems;
        if (meta.ok) log(`${id}: ${sourceItems.length} item(s)`);
        else logError(`${id}: ${meta.error}`);

        await writeJson(outPath, {
            fetchedAt: ts(),
            source: {
                note: 'items is keyed by source because the sponsor payloads have different shapes; a --only run keeps the other sources from the previous file',
                sources
            },
            items
        });
    }

    log(`wrote ${outPath}: ${ids.map((id) => `${id} ${items[id].length}`).join(', ')}`);

    const failed = ids.filter((id) => !sources[id].ok);
    if (failed.length) {
        logError(`${failed.length}/${ids.length} source(s) failed:`);
        for (const id of failed) logError(`  ${id} (HTTP ${sources[id].status}): ${sources[id].error}`);
        return 1;
    }
    return 0;
}

main().then((code) => process.exit(code), (err) => {
    logError(err.stack ?? String(err));
    process.exit(1);
});
