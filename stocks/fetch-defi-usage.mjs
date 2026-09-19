#!/usr/bin/env node
// Builds one observed-use record for every stock mint. Lending comes from live, mint-addressed
// protocol registries; DEX pools come from the already refreshed venue data (with Meteora's
// direct protocol API evidence merged); the small curated file covers live vault products.

import { join } from 'node:path';
import {
    applyOnchainCorroboration,
    buildDefiUsage,
    integrationAccountRefs
} from './lib/defi-usage.mjs';
import { fetchJson, log, logError, logWarn, parseArgs, readJson, ts, writeJson } from './lib/io.mjs';

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
const PROJECT0_URL = 'https://ai.0.xyz/v1/banks';
const SAVE_URL = 'https://api.save.finance/v1/reserves?scope=all';
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

function rpcLabel(url) {
    try {
        return new URL(url).hostname;
    } catch {
        return 'configured Solana RPC';
    }
}

function chunks(values, size) {
    const out = [];
    for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
    return out;
}

async function corroborateSolanaAccounts(result, checkedAt) {
    const addresses = [...new Set(result.items.flatMap((item) => item.integrations ?? [])
        .flatMap((integration) => integrationAccountRefs(integration).map((ref) => ref.address)))].sort();
    const accounts = new Map();
    let slot = null;
    let error = null;
    log(`solana: checking ${addresses.length} published integration account(s) via ${rpcLabel(SOLANA_RPC_URL)}`);
    try {
        for (const [batchIndex, batch] of chunks(addresses, 100).entries()) {
            const response = await fetchJson(SOLANA_RPC_URL, {
                method: 'POST',
                headers: { accept: 'application/json', 'content-type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0', id: batchIndex + 1, method: 'getMultipleAccounts',
                    params: [batch, { commitment: 'confirmed', encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]
                }),
                timeoutMs: 60000
            });
            const values = response.json?.result?.value;
            if (!response.ok || !Array.isArray(values) || values.length !== batch.length) {
                throw new Error(`HTTP ${response.status}; expected ${batch.length} account result(s)`);
            }
            slot = Math.max(slot ?? 0, Number(response.json?.result?.context?.slot) || 0) || null;
            batch.forEach((address, index) => {
                const account = values[index];
                accounts.set(address, account === null ? { exists: false } : {
                    exists: true,
                    owner: account.owner ?? null,
                    executable: account.executable === true,
                    lamports: Number.isFinite(account.lamports) ? account.lamports : null,
                    space: Number.isFinite(account.space) ? account.space : null
                });
            });
        }
    } catch (err) {
        error = err.message;
        logWarn(`Solana account corroboration unavailable: ${error}`);
    }
    applyOnchainCorroboration(result, accounts, checkedAt, rpcLabel(SOLANA_RPC_URL));
    result.sources.solanaRpc = {
        fetchedAt: checkedAt,
        host: rpcLabel(SOLANA_RPC_URL),
        accountsRequested: addresses.length,
        accountsVerified: [...accounts.values()].filter((account) => account.exists === true).length,
        slot,
        error
    };
}

function usage() {
    console.log(`fetch-defi-usage.mjs — confirmed protocol usage per exact stock mint

USAGE
  node stocks/fetch-defi-usage.mjs --run

INPUTS
  stocks-tokens.json, stocks/data/venues.json, stocks/data/meteora.json,
  stocks/data/defi-integrations.json plus the keyless Kamino, Jupiter Lend, Nest, Project 0 and Save registries

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
    log(`project0: GET ${PROJECT0_URL}`);
    log(`save: GET ${SAVE_URL}`);
    const [kaminoResponse, jupiterResponse, nestResponse, project0Response, saveResponse] = await Promise.all([
        fetchJson(KAMINO_URL, { headers: { accept: 'application/json' }, timeoutMs: 60000 }),
        fetchJson(JUPITER_URL, { headers: { accept: 'application/json' }, timeoutMs: 60000 }),
        fetchJson(NEST_URL, { headers: { accept: 'application/json' }, timeoutMs: 60000 }),
        fetchJson(PROJECT0_URL, { headers: { accept: 'application/json' }, timeoutMs: 60000 }),
        fetchJson(SAVE_URL, { headers: { accept: 'application/json' }, timeoutMs: 60000 })
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
    if (!project0Response.ok || !Array.isArray(project0Response.json?.banks)
        || project0Response.json.banks.length === 0) {
        throw new Error(`Project 0 bank registry: HTTP ${project0Response.status}, expected non-empty {banks:[...]} :: ${project0Response.bodyPreview}`);
    }
    if (!saveResponse.ok || !Array.isArray(saveResponse.json?.results)
        || saveResponse.json.results.length === 0) {
        throw new Error(`Save reserve registry: HTTP ${saveResponse.status}, expected non-empty {results:[...]} :: ${saveResponse.bodyPreview}`);
    }
    const fetchedAt = ts();
    const result = buildDefiUsage({
        tokens: tokenDb.tokens,
        venues,
        meteora,
        kamino: kaminoResponse.json,
        jupiter: jupiterResponse.json,
        nest: nestResponse.json,
        project0: project0Response.json,
        save: saveResponse.json,
        curated,
        fetchedAt
    });
    await corroborateSolanaAccounts(result, fetchedAt);
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
