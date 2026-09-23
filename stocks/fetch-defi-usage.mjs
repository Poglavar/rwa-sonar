#!/usr/bin/env node
// Builds one observed-use record for every stock mint. Lending comes from live, mint-addressed
// protocol registries; DEX pools come from the already refreshed venue data (with Meteora's
// direct protocol API evidence merged); the small curated file covers live vault products.
// Loopscale publishes no collateral registry, so its use is read from the chain: the top-20 holder
// owners (holders.json, refreshed earlier in the same pipeline) are checked for a Loopscale program
// owner and any Loan account found is decoded from Loopscale's published IDL.

import { join } from 'node:path';
import {
    applyOnchainCorroboration,
    buildDefiUsage,
    integrationAccountRefs
} from './lib/defi-usage.mjs';
import { fetchJson, log, logError, logWarn, parseArgs, readJson, sleep, ts, writeJson } from './lib/io.mjs';
import { readEnvFile } from './lib/env.mjs';
import { DEFAULT_RPC, MAX_ACCOUNTS_PER_REQUEST, chunk, getAccountsWithContext } from './lib/solana-rpc.mjs';
import { LOOPSCALE_PROGRAM_ID, decodeLoan, holderOwners, loopscalePositions } from './lib/loopscale.mjs';

const HERE = import.meta.dirname;
const ROOT = join(HERE, '..');
const TOKENS_PATH = join(ROOT, 'stocks-tokens.json');
const VENUES_PATH = join(HERE, 'data', 'venues.json');
const METEORA_PATH = join(HERE, 'data', 'meteora.json');
const CURATED_PATH = join(HERE, 'data', 'defi-integrations.json');
const HOLDERS_PATH = join(HERE, 'data', 'holders.json');
const OUT_PATH = join(HERE, 'data', 'defi-usage.json');
const ENV_PATH = join(ROOT, '.env');
const KAMINO_URL = 'https://api.kamino.finance/markets/collateral-reserves';
const JUPITER_URL = 'https://api.jup.ag/lend/v1/borrow/vaults';
const NEST_URL = 'https://docs.nestusd.com/deployments/mainnet.json';
const PROJECT0_URL = 'https://ai.0.xyz/v1/banks';
const SAVE_URL = 'https://api.save.finance/v1/reserves?scope=all';
// The keyed RPC bills compute units per second and is shared with the trade collector, so batches
// are paced like fetch-holders.mjs.
const RPC_PACE_MS = 350;
let SOLANA_RPC_URL = DEFAULT_RPC;

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

/**
 * Loopscale scan, two phases: getMultipleAccounts with a zero-length data slice over every distinct
 * top-20 owner (owner program only), then full reads of the Loopscale-owned ones, decoded as Loans.
 * Throws on RPC failure: an empty result here would read as "no Loopscale use", i.e. a removal.
 */
async function scanLoopscale(holders) {
    if (!Array.isArray(holders?.items) || holders.items.length === 0) {
        throw new Error(`${HOLDERS_PATH}: no holder scan to derive Loopscale candidates from`);
    }
    const owners = holderOwners(holders);
    const batches = chunk(owners, MAX_ACCOUNTS_PER_REQUEST);
    let rpcCalls = 0;
    let slot = null;
    const loopscaleOwned = [];
    log(`loopscale: checking the owner program of ${owners.length} top-20 holder owner(s) across ` +
        `${holders.items.length} mint(s) in ${batches.length} batch(es) via ${rpcLabel(SOLANA_RPC_URL)}`);
    for (const [index, batch] of batches.entries()) {
        const { slot: batchSlot, value } = await getAccountsWithContext(batch,
            { rpc: SOLANA_RPC_URL, encoding: 'base64', dataSlice: { offset: 0, length: 0 } });
        rpcCalls += 1;
        slot = Math.max(slot ?? 0, batchSlot ?? 0) || null;
        batch.forEach((address, i) => { if (value[i]?.owner === LOOPSCALE_PROGRAM_ID) loopscaleOwned.push(address); });
        if ((index + 1) % 10 === 0 || index === batches.length - 1) {
            log(`loopscale: ${index + 1}/${batches.length} owner batch(es), ${loopscaleOwned.length} Loopscale-owned so far`);
        }
        await sleep(RPC_PACE_MS);
    }
    const loans = new Map();
    for (const batch of chunk(loopscaleOwned, MAX_ACCOUNTS_PER_REQUEST)) {
        const { slot: batchSlot, value } = await getAccountsWithContext(batch, { rpc: SOLANA_RPC_URL, encoding: 'base64' });
        rpcCalls += 1;
        slot = Math.max(slot ?? 0, batchSlot ?? 0) || null;
        batch.forEach((address, i) => {
            const loan = value[i]?.owner === LOOPSCALE_PROGRAM_ID ? decodeLoan(value[i]?.data?.[0]) : null;
            if (loan) loans.set(address, loan);
            else logWarn(`loopscale: ${address} is Loopscale-owned but not a decodable Loan — not counted`);
        });
        await sleep(RPC_PACE_MS);
    }
    const positions = loopscalePositions(holders, loans);
    for (const row of positions.filter((entry) => !entry.matchesLoanRecord)) {
        logWarn(`loopscale: ${row.symbol ?? row.mint} token account ${row.tokenAccount} is owned by Loan ${row.loanAddress}, ` +
            'but that Loan records no collateral of this mint — not counted');
    }
    for (const row of positions.filter((entry) => entry.matchesLoanRecord)) {
        log(`loopscale: ${row.symbol ?? row.mint} ${row.collateral.amountRaw} raw units posted in Loan ${row.loanAddress}`);
    }
    log(`loopscale: ${loopscaleOwned.length} Loopscale-owned account(s), ${loans.size} Loan(s), ` +
        `${positions.filter((entry) => entry.matchesLoanRecord).length} stock collateral position(s); ${rpcCalls} RPC call(s)`);
    return {
        fetchedAt: ts(),
        holdersFetchedAt: holders.fetchedAt ?? null,
        mintsCovered: holders.items.length,
        ownersChecked: owners.length,
        loopscaleAccounts: loopscaleOwned.length,
        loanCount: loans.size,
        rpcCalls,
        slot,
        error: null,
        positions
    };
}

function usage() {
    console.log(`fetch-defi-usage.mjs — confirmed protocol usage per exact stock mint

USAGE
  node stocks/fetch-defi-usage.mjs --run

INPUTS
  stocks-tokens.json, stocks/data/venues.json, stocks/data/meteora.json,
  stocks/data/defi-integrations.json plus the keyless Kamino, Jupiter Lend, Nest, Project 0 and Save registries;
  stocks/data/holders.json top-20 owners, checked on Solana (SOLANA_RPC_URL from ../.env) for Loopscale Loans

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
    const env = await readEnvFile(ENV_PATH);
    if (typeof env.SOLANA_RPC_URL === 'string' && env.SOLANA_RPC_URL !== '') SOLANA_RPC_URL = env.SOLANA_RPC_URL;
    else logWarn(`rpc: no SOLANA_RPC_URL in ${ENV_PATH} — using the throttled public endpoint`);
    const [tokenDb, venues, meteora, curated, holders] = await Promise.all([
        readJson(TOKENS_PATH),
        readJson(VENUES_PATH, { fetchedAt: null, items: [] }),
        readJson(METEORA_PATH, { fetchedAt: null, items: [] }),
        readJson(CURATED_PATH, { reviewedAt: null, integrations: [] }),
        readJson(HOLDERS_PATH, null)
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
    const loopscale = await scanLoopscale(holders);
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
        loopscale,
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
