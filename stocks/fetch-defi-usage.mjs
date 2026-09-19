#!/usr/bin/env node
// Builds one observed-use record for every stock mint. Lending comes from live, mint-addressed
// protocol registries; DEX pools come from the already refreshed venue data (with Meteora's
// direct protocol API evidence merged); the small curated file covers live vault products.

import { join } from 'node:path';
import { buildDefiUsage } from './lib/defi-usage.mjs';
import { fetchJson, log, logError, parseArgs, readJson, ts, writeJson } from './lib/io.mjs';

const HERE = import.meta.dirname;
const ROOT = join(HERE, '..');
const TOKENS_PATH = join(ROOT, 'stocks-tokens.json');
const VENUES_PATH = join(HERE, 'data', 'venues.json');
const METEORA_PATH = join(HERE, 'data', 'meteora.json');
const CURATED_PATH = join(HERE, 'data', 'defi-integrations.json');
const OUT_PATH = join(HERE, 'data', 'defi-usage.json');
const KAMINO_URL = 'https://api.kamino.finance/markets/collateral-reserves';
const JUPITER_URL = 'https://api.jup.ag/lend/v1/borrow/vaults';
const NEST_URL = 'https://docs.nestusd.com/deployments/mainnet.json';

function usage() {
    console.log(`fetch-defi-usage.mjs — confirmed protocol usage per exact stock mint

USAGE
  node stocks/fetch-defi-usage.mjs --run

INPUTS
  stocks-tokens.json, stocks/data/venues.json, stocks/data/meteora.json,
  stocks/data/defi-integrations.json plus the keyless Kamino, Jupiter Lend and Nest registries

OUTPUT
  stocks/data/defi-usage.json — all mints, including an empty integrations[] when no current
  asset-specific use is confirmed. Generic compatibility and issuer marketing claims are excluded.`);
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }
    const [tokenDb, venues, meteora, curated] = await Promise.all([
        readJson(TOKENS_PATH),
        readJson(VENUES_PATH, { fetchedAt: null, items: [] }),
        readJson(METEORA_PATH, { fetchedAt: null, items: [] }),
        readJson(CURATED_PATH, { reviewedAt: null, integrations: [] })
    ]);
    if (!Array.isArray(tokenDb?.tokens)) throw new Error(`${TOKENS_PATH}: expected {tokens:[...]}`);

    log(`kamino: GET ${KAMINO_URL}`);
    log(`jupiter: GET ${JUPITER_URL}`);
    log(`nest: GET ${NEST_URL}`);
    const [kaminoResponse, jupiterResponse, nestResponse] = await Promise.all([
        fetchJson(KAMINO_URL, { headers: { accept: 'application/json' }, timeoutMs: 60000 }),
        fetchJson(JUPITER_URL, { headers: { accept: 'application/json' }, timeoutMs: 60000 }),
        fetchJson(NEST_URL, { headers: { accept: 'application/json' }, timeoutMs: 60000 })
    ]);
    if (!kaminoResponse.ok || !Array.isArray(kaminoResponse.json?.collateralReserves)
        || kaminoResponse.json.collateralReserves.length === 0) {
        throw new Error(`Kamino collateral registry: HTTP ${kaminoResponse.status}, expected non-empty {collateralReserves:[...]} :: ${kaminoResponse.bodyPreview}`);
    }
    if (!jupiterResponse.ok || !Array.isArray(jupiterResponse.json) || jupiterResponse.json.length === 0) {
        throw new Error(`Jupiter Lend vault registry: HTTP ${jupiterResponse.status}, expected non-empty [...] :: ${jupiterResponse.bodyPreview}`);
    }
    if (!nestResponse.ok || nestResponse.json?.schema !== 'nest-public-deployment-v1' ||
        nestResponse.json?.cluster !== 'mainnet-beta' || !Array.isArray(nestResponse.json?.collateral)
        || nestResponse.json.collateral.length === 0) {
        throw new Error(`Nest deployment registry: HTTP ${nestResponse.status}, expected reviewed non-empty mainnet manifest :: ${nestResponse.bodyPreview}`);
    }
    const fetchedAt = ts();
    const result = buildDefiUsage({
        tokens: tokenDb.tokens,
        venues,
        meteora,
        kamino: kaminoResponse.json,
        jupiter: jupiterResponse.json,
        nest: nestResponse.json,
        curated,
        fetchedAt
    });
    await writeJson(OUT_PATH, result);
    log(`wrote ${OUT_PATH}: ${result.counts.withAnyConfirmedUse}/${result.counts.assets} asset(s) have ` +
        `${result.counts.integrations} confirmed integration(s); ${result.counts.withLending} lending, ` +
        `${result.counts.withYieldVault} yield-vault, ${result.counts.withDexPool} DEX`);
    return 0;
}

main().then((code) => process.exit(code), (err) => {
    logError(err.stack ?? String(err));
    process.exit(1);
});
