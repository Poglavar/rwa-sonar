#!/usr/bin/env node
// Reads CoinMarketCap's "Tokenized Stock" category: every listed tokenized stock, on every chain and
// from every issuer, with its circulating supply and CoinMarketCap's own update time. The cards use
// it to say what share of all tokenized shares of a stock a token holds (lib/cross-chain.mjs).
// Writes stocks/data/cmc-tokenized.json. About 8 credits a run (1,897 listings in two pages); the
// key is CMC_API_KEY in .env, never printed. One request per page, so a killed run just reruns.

import { join } from 'node:path';

import { readEnvFile } from './lib/env.mjs';
import { log, logError, parseArgs, writeJson } from './lib/io.mjs';

const REPO = join(import.meta.dirname, '..');
const OUT = join(REPO, 'stocks', 'data', 'cmc-tokenized.json');
/** CoinMarketCap's "Tokenized Stock" category id (v1/cryptocurrency/categories, checked 2026-09-30). */
export const CATEGORY_ID = '604f2767ebccdd50cd175fd0';
const PAGE = 1000;

function usage() {
    console.log(`fetch-cmc-tokenized.mjs — CoinMarketCap's tokenized-stock listings, all chains

USAGE
  node stocks/fetch-cmc-tokenized.mjs --run

Writes ${OUT.replace(`${REPO}/`, '')}: {fetchedAt, categoryId, credits, coins:[{id, name, symbol,
platform, circulating_supply, last_updated}]}. Needs CMC_API_KEY in ${join(REPO, '.env')}.`);
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (!flags.run || flags.help) {
        usage();
        return 0;
    }
    const key = process.env.CMC_API_KEY || (await readEnvFile(join(REPO, '.env'))).CMC_API_KEY;
    if (!key) throw new Error(`CMC_API_KEY is not set in ${join(REPO, '.env')}`);
    const coins = [];
    let credits = 0;
    let total = null;
    for (let start = 1; total === null || start <= total; start += PAGE) {
        const res = await fetch(`https://pro-api.coinmarketcap.com/v1/cryptocurrency/category?id=${CATEGORY_ID}&start=${start}&limit=${PAGE}`,
            { headers: { 'X-CMC_PRO_API_KEY': key, accept: 'application/json' } });
        const body = await res.json().catch(() => null);
        if (res.status !== 200 || !body?.data) throw new Error(`CoinMarketCap answered ${res.status}: ${body?.status?.error_message ?? 'no data'}`);
        total = body.data.num_tokens;
        credits += body.status?.credit_count ?? 0;
        const page = Array.isArray(body.data.coins) ? body.data.coins : [];
        for (const c of page) {
            coins.push({ id: c.id, name: c.name, symbol: c.symbol, platform: c.platform ? { name: c.platform.name } : null,
                circulating_supply: c.circulating_supply, last_updated: c.last_updated });
        }
        log(`page from ${start}: ${page.length} listing(s) of ${total}`);
        if (page.length === 0) break;
    }
    await writeJson(OUT, { fetchedAt: new Date().toISOString(), categoryId: CATEGORY_ID, credits, coins });
    log(`wrote ${OUT}: ${coins.length} listing(s), ${credits} credit(s)`);
    return 0;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
    logError(err.stack || err.message);
    process.exitCode = 1;
});
