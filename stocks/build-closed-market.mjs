#!/usr/bin/env node
// Builds stocks-closed-market.json: per tokenized stock, what each Solana lending market that takes
// it as collateral does when the US market is closed (price source label, liquidation threshold,
// one sentence for a borrower), its collateral price freezes in the last 30 days (the lending
// watcher's rows in Postgres), the Monday gap, Solana depth and — only where a lender prices from the
// token's own 24/7 trading — the weekend move in that price. Replaces the old closed-hours premium
// (stocks-afterhours.json). All rules live in lib/closed-market.mjs and are unit-tested; this CLI
// reads the inputs, calls it, writes the file and reports what it found. Without a database (a
// laptop without DATABASE_URL) the freezes are recorded as not collected, never as none.

import { join, resolve } from 'node:path';

import { readEnvFile } from './lib/env.mjs';
import { log, logError, logWarn, parseArgs, readJson, ts, writeJson } from './lib/io.mjs';
import { describeUrl, psql } from './lib/psql.mjs';
import {
    CLOSED_MARKET_TABLE_PROBE, FREEZE_WINDOW_DAYS, buildClosedMarket, buildPayload, closedMarketRowsPsql, summarize
} from './lib/closed-market.mjs';

const HERE = import.meta.dirname;
const REPO_ROOT = join(HERE, '..');
const DAY_MS = 24 * 60 * 60 * 1000;

function usage() {
    console.log(`build-closed-market.mjs — "When the market is closed" per tokenized stock (stocks-closed-market.json)

USAGE
  node stocks/build-closed-market.mjs --run [options]

OPTIONS
  --run                  Actually build. Without it this help is printed and nothing runs.
  --out=<path>           Output file (default stocks-closed-market.json in the repo root).
  --no-db                Do not read DATABASE_URL: freezes are recorded as not collected.
  --freeze-rows=<file>   Read {freezes, scan} (the SQL's shape) from a file instead of the database.
  --help                 This text.

INPUTS
  stocks-tokens.json                          the catalogue (mint, symbol)
  stocks/data/protocol-market-research.json   oraclePricing: each lending market's price source, labels,
                                              liquidation thresholds and one borrower sentence (researched)
  stocks/data/defi-usage.json                 lending integrations the research did not price ("not researched")
  finding-types.json                          the finding types this view emits
  DATABASE_URL (.env)                         sonar.lending_price_freeze + sonar.lending_scan (stocks/watch-lending.mjs)
  stocks/data/lender-price-gaps.json          Monday gaps (stocks/fetch-lender-price-history.mjs), optional
  stocks/data/solana-depth.json               depth samples (stocks/fetch-solana-depth.mjs), optional
  stocks-tracking.json                        premium points, for the weekend move in a 24/7 lender's price, optional

OUTPUT
  {schema, generatedAt, asOf, researchReviewedAt, freezeWindowDays, labels, method, inputs, weekend, items[]}:
  one item per token at least one lending market takes. A missing input is recorded in \`inputs\`
  and shown on the page as not collected.`);
}

/** The watcher's freeze and scan rows, or {read: false, reason} — never a thrown build. */
async function readFreezeRows({ flags, since }) {
    if (typeof flags['freeze-rows'] === 'string') {
        const doc = await readJson(resolve(flags['freeze-rows']));
        log(`freeze rows: ${doc?.freezes?.length ?? 0} episode(s), ${doc?.scan?.length ?? 0} scan row(s) from ${flags['freeze-rows']}`);
        return { read: true, source: `file ${flags['freeze-rows']}`, freezes: doc?.freezes ?? [], scan: doc?.scan ?? [] };
    }
    if (flags['no-db']) return { read: false, reason: '--no-db', freezes: [], scan: [] };
    const env = { ...(await readEnvFile(join(REPO_ROOT, '.env'))), ...process.env };
    if (!env.DATABASE_URL) return { read: false, reason: 'no DATABASE_URL', freezes: [], scan: [] };
    try {
        if ((await psql(env.DATABASE_URL, CLOSED_MARKET_TABLE_PROBE, 'lending table probe', ['-t', '-A'])).trim() !== 't') {
            return { read: false, reason: 'lending watcher tables absent (stocks/watch-lending.mjs --ddl creates them)', freezes: [], scan: [] };
        }
        const doc = JSON.parse((await psql(env.DATABASE_URL, closedMarketRowsPsql({ since }), 'closed-market rows', ['-t', '-A'])).trim() || '{}');
        log(`freeze rows: ${doc?.freezes?.length ?? 0} episode(s) touching the window since ${since}, ${doc?.scan?.length ?? 0} scan row(s) from ${describeUrl(env.DATABASE_URL)}`);
        return { read: true, source: describeUrl(env.DATABASE_URL), freezes: doc?.freezes ?? [], scan: doc?.scan ?? [] };
    } catch (err) {
        // A laptop without the database, or a database that is down: say so, build the rest.
        return { read: false, reason: `database not readable: ${String(err.message).split('\n')[0]}`, freezes: [], scan: [] };
    }
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }
    const outPath = typeof flags.out === 'string' ? resolve(flags.out) : join(REPO_ROOT, 'stocks-closed-market.json');
    const generatedAt = ts();
    const since = new Date(Date.parse(generatedAt) - FREEZE_WINDOW_DAYS * DAY_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');

    const tokenDb = await readJson(join(REPO_ROOT, 'stocks-tokens.json'));
    if (!Array.isArray(tokenDb?.tokens)) throw new Error('stocks-tokens.json: expected {tokens:[...]}');
    const research = await readJson(join(HERE, 'data', 'protocol-market-research.json'));
    if (!Array.isArray(research?.oraclePricing?.markets)) throw new Error('protocol-market-research.json: no oraclePricing.markets');
    const defiUsage = await readJson(join(HERE, 'data', 'defi-usage.json'), { items: [] });
    const findingTypes = await readJson(join(REPO_ROOT, 'finding-types.json'));
    const gapDoc = await readJson(join(HERE, 'data', 'lender-price-gaps.json'), null);
    const depthDoc = await readJson(join(HERE, 'data', 'solana-depth.json'), null);
    const tracking = await readJson(join(REPO_ROOT, 'stocks-tracking.json'), null);
    const freeze = await readFreezeRows({ flags, since });
    if (!freeze.read) logWarn(`freezes not collected in this build (${freeze.reason}); the page says so`);
    if (gapDoc === null) logWarn('stocks/data/lender-price-gaps.json absent: Monday gaps not collected (run stocks/fetch-lender-price-history.mjs)');
    if (depthDoc === null) logWarn('stocks/data/solana-depth.json absent: Solana depth not collected (run stocks/fetch-solana-depth.mjs)');
    if (tracking === null) logWarn('stocks-tracking.json absent: the weekend move in 24/7 lenders\' prices is not collected');

    const { items, weekend } = buildClosedMarket({
        tokens: tokenDb.tokens,
        oraclePricing: research.oraclePricing,
        defiUsage,
        freezeRows: freeze.freezes,
        scanRows: freeze.scan,
        freezesRead: freeze.read,
        gapDoc,
        depthDoc,
        tracking,
        findingTypes,
        asOf: generatedAt
    });
    const payload = buildPayload({
        generatedAt,
        asOf: generatedAt,
        researchReviewedAt: research.oraclePricing.reviewedAt ?? null,
        weekend,
        items,
        inputs: {
            tokensBuiltAt: tokenDb.builtAt ?? null,
            defiUsageFetchedAt: defiUsage?.fetchedAt ?? null,
            freezes: freeze.read ? { read: true, since, source: freeze.source } : { read: false, reason: freeze.reason },
            mondayGaps: gapDoc === null ? { read: false } : { read: true, fetchedAt: gapDoc.fetchedAt ?? null },
            depth: depthDoc === null ? { read: false } : { read: true, fetchedAt: depthDoc.fetchedAt ?? null },
            tracking: tracking === null ? { read: false } : { read: true, generatedAt: tracking.generatedAt ?? null }
        }
    });
    await writeJson(outPath, payload);

    const stats = summarize(items);
    log(`wrote ${outPath}: ${stats.tokens} token(s) with a lender, ${stats.lenderRows} lender row(s) `
        + `(${Object.entries(stats.byKind).map(([k, n]) => `${k} ${n}`).join(', ')}), ${stats.freezeEpisodes} freeze episode(s) listed, `
        + `${stats.findings} finding(s), depth for ${stats.withDepth}, weekend move for ${stats.withWeekendMove}`);
    return 0;
}

main().then((code) => process.exit(code), (err) => {
    logError(err.stack ?? String(err));
    process.exit(1);
});
