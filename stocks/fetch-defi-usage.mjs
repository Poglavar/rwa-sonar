#!/usr/bin/env node
// Builds one observed-use record for every stock mint. Lending comes from live, mint-addressed
// protocol registries; DEX pools come from the already refreshed venue data (with Meteora's
// direct protocol API evidence merged); the small curated file covers live vault products.
// Loopscale loans are read from the chain: every Loan account of the program is listed once
// (getProgramAccounts over the collateral slots only), each Loan whose own collateral record names
// a tracked mint is read in full and decoded — with the MarketInformation and Strategy accounts its
// ledger points at (oracle, LTV, liquidation threshold, lender terms) — from the program's own
// on-chain Anchor IDL, and the open principal against each exact token is summed from its ledgers.
// Loopscale's lending-vault registry only says which vaults accept a mint.

import { join } from 'node:path';
import {
    applyOnchainCorroboration,
    buildDefiUsage,
    integrationAccountRefs
} from './lib/defi-usage.mjs';
import { fetchJson, log, logError, logWarn, parseArgs, readJson, sleep, ts, writeJson } from './lib/io.mjs';
import { readEnvFile } from './lib/env.mjs';
import { DEFAULT_RPC, MAX_ACCOUNTS_PER_REQUEST, chunk, getAccountsWithContext, rpcCall } from './lib/solana-rpc.mjs';
import {
    LOAN_COLLATERAL_SLICE, LOAN_DISCRIMINATOR_BASE58, LOOPSCALE_PROGRAM_ID, collateralMintsFromSlice, decodeLoan, decodeMarketInformation,
    decodeStrategy, loopscalePositions, openPrincipalAgainst, positionConfiguration
} from './lib/loopscale.mjs';
import { KLEND_PROGRAM_ID, decodeObligation, decodeReserve, priceDropToLiquidation } from './lib/kamino-accounts.mjs';

const HERE = import.meta.dirname;
const ROOT = join(HERE, '..');
const TOKENS_PATH = join(ROOT, 'stocks-tokens.json');
const VENUES_PATH = join(HERE, 'data', 'venues.json');
const METEORA_PATH = join(HERE, 'data', 'meteora.json');
const CURATED_PATH = join(HERE, 'data', 'defi-integrations.json');
const OUT_PATH = join(HERE, 'data', 'defi-usage.json');
const ENV_PATH = join(ROOT, '.env');
const KAMINO_URL = 'https://api.kamino.finance/markets/collateral-reserves';
const KAMINO_MARKETS_URL = `https://api.kamino.finance/v2/kamino-market?programId=${KLEND_PROGRAM_ID}`;
const KAMINO_MARKET_RESERVES_URL = (market) => `https://api.kamino.finance/kamino-market/${market}/reserves/metrics`;
const KAMINO_VAULT_METRICS_URL = (vault) => `https://api.kamino.finance/kvaults/${vault}/metrics`;
const JUPITER_URL = 'https://api.jup.ag/lend/v1/borrow/vaults';
const NEST_URL = 'https://docs.nestusd.com/deployments/mainnet.json';
const PROJECT0_URL = 'https://ai.0.xyz/v1/banks';
const SAVE_URL = 'https://api.save.finance/v1/reserves?scope=all';
const LOOPSCALE_VAULTS_URL = 'https://tars.loopscale.com/v1/markets/lending_vaults/info';
// The keyed RPC bills compute units per second and is shared with the trade collector, so batches
// are paced like fetch-holders.mjs.
const RPC_PACE_MS = 350;
let SOLANA_RPC_URL = DEFAULT_RPC;
// getProgramAccounts goes to the public endpoint: Alchemy's free tier throttles it on the first call
// (measured 2026-09-24, see fetch-defi-footprint.mjs). The Loan listing is one call, ~5,900 accounts
// × 365 bytes of collateral slots, answered in about a second on 2026-09-24.
const LOAN_SCAN_RPC = DEFAULT_RPC;

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


async function fetchJsonRetry(url, label, attempts = 3) {
    let last = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        last = await fetchJson(url, { headers: { accept: 'application/json' }, timeoutMs: 60000 });
        if (last.ok && last.json !== null) return last;
        logWarn(`${label}: HTTP ${last.status} (attempt ${attempt}/${attempts})`);
        if (attempt < attempts) await sleep(1000 * attempt);
    }
    throw new Error(`${label}: HTTP ${last?.status} after ${attempts} attempts :: ${last?.bodyPreview}`);
}

/**
 * Every Kamino lending market's own reserve list, so curated/partner markets that the cross-market
 * collateral registry omits are still seen. Any failed market read fails the collector: a missing
 * market would otherwise read as its tokens being removed.
 */
async function fetchKaminoMarkets(stockMints) {
    const list = await fetchJsonRetry(KAMINO_MARKETS_URL, 'kamino markets');
    if (!Array.isArray(list.json) || list.json.length === 0) throw new Error('kamino markets: expected a non-empty array');
    const reserves = [];
    for (const market of list.json) {
        const response = await fetchJsonRetry(KAMINO_MARKET_RESERVES_URL(market.lendingMarket), `kamino reserves ${market.name}`);
        if (!Array.isArray(response.json)) throw new Error(`kamino reserves ${market.name}: expected an array`);
        for (const row of response.json) {
            reserves.push({
                market: market.lendingMarket, marketName: market.name ?? null, marketDescription: market.description ?? null,
                curated: market.isCurated === true, reserve: row.reserve, mint: row.liquidityTokenMint, symbol: row.liquidityToken ?? null,
                maxLtv: Number(row.maxLtv), borrowApy: Number(row.borrowApy), supplyApy: Number(row.supplyApy),
                totalSupplyUsd: Number(row.totalSupplyUsd), totalBorrowUsd: Number(row.totalBorrowUsd)
            });
        }
    }
    const stockReserves = reserves.filter((row) => stockMints.has(row.mint)).length;
    log(`kamino: ${list.json.length} market(s), ${reserves.length} reserve(s), ${stockReserves} for tracked stock mints`);
    return { markets: list.json.map((row) => ({ address: row.lendingMarket, name: row.name ?? null, curated: row.isCurated === true })), reserves, stockReserves };
}

/** Decode the risk configuration of every Kamino reserve whose liquidity mint is a tracked stock. */
async function decodeKaminoReserves(addresses) {
    const configs = new Map();
    let slot = null;
    for (const batch of chunk(addresses, 20)) {
        const result = await getAccountsWithContext(batch, { rpc: SOLANA_RPC_URL, encoding: 'base64' });
        slot = Math.max(slot ?? 0, result.slot ?? 0) || null;
        batch.forEach((address, index) => {
            const account = result.value[index];
            const decoded = account?.owner === KLEND_PROGRAM_ID ? decodeReserve(account.data?.[0]) : null;
            if (decoded) configs.set(address, decoded);
            else logWarn(`kamino reserve ${address}: not a decodable KLend reserve — configuration not recorded`);
        });
        await sleep(RPC_PACE_MS);
    }
    log(`kamino: decoded ${configs.size}/${addresses.length} stock reserve configuration(s) at slot ${slot}`);
    return { configs, slot, decodedAt: ts() };
}

function rawMintSupply(base64) {
    const data = typeof base64 === 'string' ? Buffer.from(base64, 'base64') : null;
    return data && data.length >= 44 ? data.readBigUInt64LE(36).toString() : null;
}

/**
 * Live state of each composite product route (reviewed in defi-integrations.json): the strategy's
 * Kamino obligation (collateral, debt, LTV, liquidation distance), the reserves' configured LTVs,
 * the vault share mint's Solana supply and the yield vault's reported APY. One getMultipleAccounts
 * for all routes; a route whose accounts do not decode as expected is logged and left unobserved.
 */
async function observeComposites(curated, kaminoMarkets, tokenByMint) {
    const observations = new Map();
    const composites = (curated?.integrations ?? []).filter((entry) => entry.composite && entry.routes);
    if (composites.length === 0) return observations;
    const addresses = [...new Set(composites.flatMap((entry) => Object.values(entry.routes)
        .flatMap((route) => [route.obligation, route.collateralReserve, route.debtReserve, route.solanaShareMint]))
        .filter((value) => typeof value === 'string'))];
    const { slot, value } = await getAccountsWithContext(addresses, { rpc: SOLANA_RPC_URL, encoding: 'base64' });
    await sleep(RPC_PACE_MS);
    const observedAt = ts();
    const byAddress = new Map(addresses.map((address, index) => [address, value[index]]));
    const reserveApi = new Map((kaminoMarkets?.reserves ?? []).map((row) => [row.reserve, row]));
    const vaultApy = new Map();
    for (const vault of new Set(composites.flatMap((entry) => Object.values(entry.routes).map((route) => route.yieldVault)).filter(Boolean))) {
        const response = await fetchJson(KAMINO_VAULT_METRICS_URL(vault), { headers: { accept: 'application/json' }, timeoutMs: 60000 });
        if (response.ok && response.json) vaultApy.set(vault, { apy: Number(response.json.apy), apy7d: Number(response.json.apy7d), apyFarmRewards: Number(response.json.apyFarmRewards) });
        else logWarn(`kamino vault ${vault} metrics: HTTP ${response.status} — yield not recorded`);
    }
    for (const entry of composites) {
        for (const [mint, route] of Object.entries(entry.routes)) {
            const token = tokenByMint.get(mint);
            const obligationAccount = byAddress.get(route.obligation);
            const obligation = obligationAccount?.owner === KLEND_PROGRAM_ID ? decodeObligation(obligationAccount.data?.[0]) : null;
            const collateral = byAddress.get(route.collateralReserve)?.owner === KLEND_PROGRAM_ID ? decodeReserve(byAddress.get(route.collateralReserve).data?.[0]) : null;
            const shareSupplyRaw = rawMintSupply(byAddress.get(route.solanaShareMint)?.data?.[0]);
            const problems = [];
            if (!obligation) problems.push('obligation not decodable');
            else {
                if (obligation.owner !== route.positionAuthority) problems.push(`obligation owner ${obligation.owner} is not the recorded position authority`);
                if (obligation.lendingMarket !== route.lendingMarket) problems.push('obligation is in a different lending market');
            }
            if (!collateral || collateral.liquidityMint !== mint) problems.push('collateral reserve does not decode to this mint');
            if (problems.length) {
                logWarn(`composite ${entry.id} ${token?.symbol ?? mint}: ${problems.join('; ')} — position not observed`);
                observations.set(`${entry.id}\u0000${mint}`, { shareSupplyRaw, position: null, metrics: null, decoding: null });
                continue;
            }
            const deposit = obligation.deposits.find((row) => row.reserve === route.collateralReserve) ?? null;
            const borrow = obligation.borrows.find((row) => row.reserve === route.debtReserve) ?? null;
            const decimals = Number.isInteger(token?.decimals) ? token.decimals : null;
            const debtApi = reserveApi.get(route.debtReserve) ?? null;
            const yieldVault = route.yieldVault ? vaultApy.get(route.yieldVault) ?? null : null;
            const position = {
                obligation: route.obligation,
                owner: obligation.owner,
                observedSlot: slot,
                observedAt,
                obligationLastUpdateSlot: obligation.lastUpdateSlot,
                collateralSymbol: token?.symbol ?? null,
                collateralTokens: deposit && decimals !== null ? Number(deposit.collateralAmountRaw) / 10 ** decimals : null,
                collateralUnit: 'Kamino reserve collateral tokens (≈ underlying xStock units; exchange rate not applied)',
                depositedValueUsd: obligation.depositedValueUsd,
                debtSymbol: route.debtSymbol ?? null,
                debtUsd: borrow?.marketValueUsd ?? null,
                loanToValue: obligation.loanToValue,
                maxLtv: collateral.maxLtvPct / 100,
                liquidationLtv: obligation.liquidationLoanToValue,
                priceDropToLiquidation: priceDropToLiquidation(obligation),
                debtBorrowApy: Number.isFinite(debtApi?.borrowApy) ? debtApi.borrowApy : null,
                yieldVault: route.yieldVault ?? null,
                yieldVaultApy: yieldVault?.apy ?? null,
                yieldVaultApy7d: yieldVault?.apy7d ?? null,
                valuesAsOf: 'Kamino stores USD values at the obligation\'s last refresh (obligationLastUpdateSlot), not at observedSlot.'
            };
            log(`composite ${entry.id} ${token?.symbol}: collateral $${Math.round(position.depositedValueUsd)}, debt $${Math.round(position.debtUsd ?? 0)} ${route.debtSymbol}, `
                + `LTV ${(position.loanToValue * 100).toFixed(1)}% / liquidation ${(position.liquidationLtv * 100).toFixed(1)}%, `
                + `price fall to liquidation ${(position.priceDropToLiquidation * 100).toFixed(1)}%`);
            observations.set(`${entry.id}\u0000${mint}`, {
                shareSupplyRaw,
                position,
                metrics: {
                    sizeUsd: position.depositedValueUsd,
                    debtAgainstCollateralUsd: position.debtUsd,
                    maxLtvMin: position.maxLtv, maxLtvMax: position.maxLtv,
                    liquidationLtvMin: collateral.liquidationLtvPct / 100, liquidationLtvMax: collateral.liquidationLtvPct / 100,
                    positionLtv: position.loanToValue,
                    priceDropToLiquidation: position.priceDropToLiquidation,
                    oracleProviders: ['scope']
                },
                decoding: {
                    observedAt, slot,
                    scope: 'The strategy\'s Kamino obligation (collateral, debt, LTV, liquidation value) and the collateral reserve\'s risk configuration, read from the chain; vault share accounting on the holder side is not decoded.',
                    decoder: 'stocks/lib/kamino-accounts.mjs (offsets verified against @kamino-finance/klend-sdk 12.0.0)',
                    idl: null
                }
            });
        }
    }
    return observations;
}

/** Every Loopscale lending vault (paged POST, 50 per page). Throws on any failed page. */
async function fetchLoopscaleVaults() {
    const vaults = [];
    for (let page = 0; page < 20; page += 1) {
        const response = await fetchJson(LOOPSCALE_VAULTS_URL, {
            method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ page, pageSize: 50 }), timeoutMs: 60000
        });
        if (!response.ok || !Array.isArray(response.json?.lendVaults)) {
            throw new Error(`Loopscale lending vaults page ${page}: HTTP ${response.status} :: ${response.bodyPreview}`);
        }
        vaults.push(...response.json.lendVaults);
        if (!response.json.hasMore) break;
    }
    if (vaults.length === 0) throw new Error('Loopscale lending vaults: empty registry');
    log(`loopscale: ${vaults.length} lending vault(s) in the keyless registry`);
    return vaults;
}

/**
 * Loopscale scan: one getProgramAccounts (public RPC) listing every Loan account with only its five
 * collateral slots, then full reads (configured RPC) of each Loan that names a tracked mint, then
 * the MarketInformation and Strategy accounts those Loans' ledgers point at. Throws on RPC failure:
 * an empty result here would read as "no Loopscale use", i.e. a removal.
 */
async function scanLoopscale(tokens) {
    const symbolByMint = new Map(tokens.map((token) => [token.mint, token.symbol ?? null]));
    let rpcCalls = 0;
    log(`loopscale: listing every Loan account (collateral slots only) via ${rpcLabel(LOAN_SCAN_RPC)}`);
    const listing = await rpcCall('getProgramAccounts', [LOOPSCALE_PROGRAM_ID, {
        encoding: 'base64', withContext: true, dataSlice: LOAN_COLLATERAL_SLICE,
        filters: [{ memcmp: { offset: 0, bytes: LOAN_DISCRIMINATOR_BASE58 } }]
    }], { rpc: LOAN_SCAN_RPC, timeoutMs: 120000 });
    rpcCalls += 1;
    if (!Array.isArray(listing?.value) || listing.value.length === 0) {
        throw new Error('loopscale: getProgramAccounts returned no Loan accounts — refusing to record "no Loopscale use"');
    }
    let slot = Number(listing.context?.slot) || null;
    const candidates = listing.value
        .filter((entry) => collateralMintsFromSlice(entry?.account?.data?.[0]).some((mint) => symbolByMint.has(mint)))
        .map((entry) => entry.pubkey)
        .sort();
    log(`loopscale: ${listing.value.length} Loan account(s) at slot ${slot}; ${candidates.length} name a tracked mint as collateral`);
    await sleep(RPC_PACE_MS);

    const loans = new Map();
    for (const batch of chunk(candidates, MAX_ACCOUNTS_PER_REQUEST)) {
        const { slot: batchSlot, value } = await getAccountsWithContext(batch, { rpc: SOLANA_RPC_URL, encoding: 'base64' });
        rpcCalls += 1;
        slot = Math.max(slot ?? 0, batchSlot ?? 0) || null;
        batch.forEach((address, i) => {
            const loan = value[i]?.owner === LOOPSCALE_PROGRAM_ID ? decodeLoan(value[i]?.data?.[0]) : null;
            if (loan) loans.set(address, loan);
            else logWarn(`loopscale: ${address} was listed as a Loan but is not a decodable Loopscale Loan now — not counted`);
        });
        await sleep(RPC_PACE_MS);
    }
    const positions = loopscalePositions(loans, symbolByMint);
    // Market configuration each loan is checked against: its ledger's MarketInformation (oracle, price
    // age, LTV, liquidation threshold, caps) and lender Strategy (APY per duration), one read.
    const configAddresses = [...new Set(positions.flatMap((row) => row.loan.ledgers.flatMap((ledger) => [ledger.marketInformation, ledger.strategy])))];
    const markets = new Map();
    const strategies = new Map();
    for (const batch of chunk(configAddresses, MAX_ACCOUNTS_PER_REQUEST)) {
        const { slot: batchSlot, value } = await getAccountsWithContext(batch, { rpc: SOLANA_RPC_URL, encoding: 'base64' });
        rpcCalls += 1;
        slot = Math.max(slot ?? 0, batchSlot ?? 0) || null;
        batch.forEach((address, i) => {
            if (value[i]?.owner !== LOOPSCALE_PROGRAM_ID) return logWarn(`loopscale: ${address} is not Loopscale-owned — configuration not read`);
            const market = decodeMarketInformation(value[i].data?.[0]);
            const strategy = market ? null : decodeStrategy(value[i].data?.[0]);
            if (market) markets.set(address, market);
            else if (strategy) strategies.set(address, strategy);
            else logWarn(`loopscale: ${address} decodes as neither MarketInformation nor Strategy — configuration not read`);
        });
        await sleep(RPC_PACE_MS);
    }
    for (const row of positions) {
        row.configuration = positionConfiguration(row, markets, strategies);
        // A Loan with collateral and no ledger has borrowed nothing and points at no market.
        if (row.loan.ledgers.length === 0) log(`loopscale: ${row.symbol ?? row.mint} Loan ${row.loanAddress} holds collateral with no ledger (nothing borrowed)`);
        else if (!row.configuration) logWarn(`loopscale: no market configuration decoded for ${row.symbol ?? row.mint} in Loan ${row.loanAddress}`);
    }
    const fetchedAt = ts();
    for (const mint of [...new Set(positions.map((row) => row.mint))]) {
        const rows = positions.filter((row) => row.mint === mint);
        const open = openPrincipalAgainst(rows, fetchedAt);
        log(`loopscale: ${rows[0].symbol ?? mint} ${rows.length} loan(s), open principal ` +
            `${open.openPrincipalUsd === null ? `not stated (${open.unattributedLoans} mixed-collateral, ${open.unpricedLoans} non-stablecoin)` : `$${open.openPrincipalUsd.toFixed(2)}`}, ` +
            `${open.loansPastEnd} past their end date`);
    }
    log(`loopscale: ${loans.size} Loan(s) holding tracked collateral, ${positions.length} position(s); ${rpcCalls} RPC call(s)`);
    return {
        fetchedAt,
        loanScanRpc: rpcLabel(LOAN_SCAN_RPC),
        loansScanned: listing.value.length,
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
  stocks/data/defi-integrations.json plus the keyless Kamino (cross-market registry AND every market's
  reserve list), Jupiter Lend, Nest, Project 0 and Save registries; Kamino stock reserves and composite
  product positions (Kamino obligations) are decoded from the chain;
  every Loopscale Loan account (getProgramAccounts on the public RPC), the Loans holding a tracked
  mint read and decoded on Solana (SOLANA_RPC_URL from ../.env): open principal per exact token

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
    const stockMints = new Set(tokenDb.tokens.map((token) => token.mint));
    const kaminoMarkets = await fetchKaminoMarkets(stockMints);
    const kaminoStockReserves = [...new Set([
        ...kaminoResponse.json.collateralReserves.filter((row) => stockMints.has(row.collateralMint)).map((row) => row.collateralReserve),
        ...kaminoMarkets.reserves.filter((row) => stockMints.has(row.mint)).map((row) => row.reserve)
    ])].sort();
    const kaminoDecoded = await decodeKaminoReserves(kaminoStockReserves);
    const compositeObservations = await observeComposites(curated, kaminoMarkets,
        new Map(tokenDb.tokens.map((token) => [token.mint, token])));
    const loopscaleVaults = await fetchLoopscaleVaults();
    const loopscale = await scanLoopscale(tokenDb.tokens);
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
        fetchedAt,
        kaminoMarkets,
        kaminoReserveConfigs: kaminoDecoded.configs,
        kaminoDecodedAt: kaminoDecoded.decodedAt,
        kaminoSlot: kaminoDecoded.slot,
        compositeObservations,
        loopscaleVaults
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
