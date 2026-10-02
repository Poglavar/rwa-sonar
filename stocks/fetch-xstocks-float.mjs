#!/usr/bin/env node
// Collects the real outstanding supply ("public float") of every xStock: mint supply minus the
// balances of the issuer-attributed wallets (lib/xstocks-float.mjs XSTOCKS_ISSUER_WALLETS, each
// cited in the xStocks dossier). Redeemed xStocks are not burned — the prospectus defines
// de-activation as a transfer into issuer inventory — so raw supply alone overstates what the public
// holds. Writes stocks/data/xstocks-float.json, which stocks/build-flows.mjs publishes.
//
// Bounded RPC: ceil(mints / 100) getMultipleAccounts + one getTokenAccountsByOwner per wallet
// (≈ 9 + 6 = 15 calls for the 833 catalogued xStocks). No checkpoint — a kill restarts from zero,
// which costs those 15 calls; the output is written once, atomically, only after every read
// succeeded, so a failed run keeps the last good file instead of publishing a partial inventory.

import { join, relative } from 'node:path';

import { readEnvFile } from './lib/env.mjs';
import { log, logError, parseArgs, readJson, sleep, ts, writeJson } from './lib/io.mjs';
import { DEFAULT_RPC, chunk, getAccountsWithContext, getTokenAccountsByOwner } from './lib/solana-rpc.mjs';
import {
    TOKEN_2022, XSTOCKS_ISSUER_WALLETS, aggregate, dossierCitations, floatRow, mintFacts, pushHistory, rollPrevious, sumInventory
} from './lib/xstocks-float.mjs';

const HERE = import.meta.dirname;
const REPO = join(HERE, '..');
const DEFAULT_OUT = join(HERE, 'data', 'xstocks-float.json');
const TOKENS_FILE = join(REPO, 'stocks-tokens.json');
const DOSSIER_FILE = join(HERE, 'data', 'issuers', 'xstocks-backed.json');
const ENV_FILE = join(REPO, '.env');
const ISSUER = 'xstocks-backed';
const PACE_MS = 350;

function usage() {
    console.log(`fetch-xstocks-float.mjs — xStocks public float = mint supply − issuer-attributed wallet balances

USAGE
  node stocks/fetch-xstocks-float.mjs --run [options]

OPTIONS
  --run            Actually read the chain. Without it this help is printed and nothing runs.
  --rpc=<url>      RPC endpoint (default SOLANA_RPC_URL from .env, else ${DEFAULT_RPC}). Never printed.
  --out=<file>     Output (default ${relative(REPO, DEFAULT_OUT)}).
  --tokens=<file>  Catalogue giving the xStocks mints and prices (default stocks-tokens.json).
  --help           This text.

WHAT A RUN DOES
  1. Checks every issuer-attributed wallet is still cited in ${relative(REPO, DOSSIER_FILE)} (fails if not).
  2. getMultipleAccounts over the catalogued ${ISSUER} mints (supply, decimals, scaled-UI multiplier).
  3. getTokenAccountsByOwner (Token-2022) for each of the ${XSTOCKS_ISSUER_WALLETS.length} wallets.
  4. float = supply − inventory per mint (raw units); keeps the previous day's floats and a daily
     aggregate history priced with the catalogue's market price.

FAILURE SEMANTICS
  Any failed read ends the run non-zero WITHOUT writing: a missing wallet would overstate the float.
  A mint whose account cannot be read is kept with status no-supply (nulls, never zeros).`);
}

function rpcHost(url) {
    try { return new URL(url).hostname; } catch { return 'configured RPC'; }
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) { usage(); return; }
    const startedAt = ts();
    const env = await readEnvFile(ENV_FILE);
    const rpc = typeof flags.rpc === 'string' ? flags.rpc : env.SOLANA_RPC_URL ?? process.env.SOLANA_RPC_URL ?? DEFAULT_RPC;
    const outFile = typeof flags.out === 'string' ? flags.out : DEFAULT_OUT;
    const tokensFile = typeof flags.tokens === 'string' ? flags.tokens : TOKENS_FILE;

    const dossier = await readJson(DOSSIER_FILE);
    const citations = dossierCitations(dossier, XSTOCKS_ISSUER_WALLETS.map((w) => w.address));
    const uncited = XSTOCKS_ISSUER_WALLETS.filter((w) => citations[w.address].length === 0).map((w) => w.address);
    if (uncited.length) throw new Error(`issuer wallet(s) no longer cited in the dossier: ${uncited.join(', ')} — re-derive the list before collecting`);

    const catalogue = await readJson(tokensFile);
    const tokens = catalogue.tokens.filter((t) => t.issuer === ISSUER);
    const symbolOf = new Map(tokens.map((t) => [t.mint, t.symbol ?? null]));
    const mints = tokens.map((t) => t.mint);
    log(`fetch-xstocks-float: ${mints.length} ${ISSUER} mint(s), ${XSTOCKS_ISSUER_WALLETS.length} issuer-attributed wallet(s) via ${rpcHost(rpc)}`);

    const slots = [];
    const facts = new Map();
    const batches = chunk(mints);
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (let i = 0; i < batches.length; i += 1) {
        const { slot, value } = await getAccountsWithContext(batches[i], { rpc });
        slots.push(slot);
        batches[i].forEach((mint, j) => facts.set(mint, mintFacts(value[j], nowSeconds)));
        log(`  mints ${i + 1}/${batches.length} · slot ${slot}`);
        await sleep(PACE_MS);
    }

    const byWallet = {};
    const walletRows = [];
    const mintSet = new Set(mints);
    for (const [i, wallet] of XSTOCKS_ISSUER_WALLETS.entries()) {
        const { slot, accounts } = await getTokenAccountsByOwner(wallet.address, { rpc, programId: TOKEN_2022, timeoutMs: 120000 });
        slots.push(slot);
        byWallet[wallet.address] = accounts;
        const held = accounts.filter((a) => mintSet.has(a.mint) && a.amount !== null && a.amount !== '0');
        walletRows.push({ ...wallet, dossierPaths: citations[wallet.address].slice(0, 5), dossierCitations: citations[wallet.address].length,
            tokenAccounts: accounts.length, xstockAccountsWithBalance: held.length, slot });
        log(`  wallet ${i + 1}/${XSTOCKS_ISSUER_WALLETS.length} ${wallet.role} ${wallet.address.slice(0, 6)}… · ${accounts.length} token account(s), ${held.length} xStock balance(s) · slot ${slot}`);
        await sleep(PACE_MS);
    }

    const inventory = sumInventory(byWallet, mintSet);
    const items = mints.map((mint) => floatRow({ mint, symbol: symbolOf.get(mint), facts: facts.get(mint), inventory: inventory.get(mint) }));
    const readAt = ts();
    const existing = await readJson(outFile, null);
    const byMint = new Map(tokens.map((t) => [t.mint, t]));
    const priceOf = (mint) => byMint.get(mint)?.market?.usdPrice ?? null;
    const priceObservedAt = catalogue.sources?.universe?.fetchedAt ?? null;
    const totals = aggregate(items, priceOf);
    const counts = items.reduce((acc, i) => ({ ...acc, [i.status]: (acc[i.status] ?? 0) + 1 }), {});

    const out = {
        schema: 1,
        readAt,
        startedAt,
        rpcHost: rpcHost(rpc),
        slots: { min: Math.min(...slots), max: Math.max(...slots) },
        method: 'public float = mint supply − Σ balances of the issuer-attributed wallets (raw base units); supply and balances are separate reads a few seconds apart, see `slots`.',
        attributionCaveat: 'The wallets are attributed to the issuer from on-chain behaviour recorded in the xStocks dossier; the chain cannot prove that S7vYFF… is the wallet the Tokenizer holds on behalf of the Issuer. Issuer-held or not-yet-activated tokens in wallets the dossier does not attribute are counted as float, so the float is an upper bound.',
        wallets: walletRows,
        counts,
        totals: { ...totals, priceSource: 'stocks-tokens.json market.usdPrice (Jupiter)', priceObservedAt },
        previous: rollPrevious(existing, readAt),
        history: pushHistory(existing?.history, { date: readAt.slice(0, 10), readAt, ...totals, priceObservedAt }),
        items
    };
    await writeJson(outFile, out);
    log(`fetch-xstocks-float: ${JSON.stringify(counts)} · inventory ${totals.inventorySharePct ?? '—'}% of priced supply · float $${totals.floatUsd.toLocaleString('en')} (${totals.unpricedMints} unpriced) · slots ${out.slots.min}–${out.slots.max} · wrote ${relative(REPO, outFile)}`);
}

main().catch((err) => {
    logError(`fetch-xstocks-float: run NOT successful — ${err.stack || err.message}`);
    process.exitCode = 1;
});
