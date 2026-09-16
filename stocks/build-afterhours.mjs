#!/usr/bin/env node
// Builds stocks-afterhours.json: per tokenized stock, the premium it traded at while its
// underlying market was OPEN against the premium it traded at while that market was CLOSED, and
// the gap between them. The session comes from the Pyth feed schedule persisted on every
// reference-price record (keyless, so this works without the price entitlement); the premium comes
// from the stored trade tape. All the arithmetic lives in lib/afterhours.mjs and is unit-tested —
// this CLI only reads the two inputs, calls it, writes the file and reports what it found.

import { join } from 'node:path';
import { log, logError, logWarn, parseArgs, readJson, ts, writeJson } from './lib/io.mjs';
import { MIN_SIDE_TRADES, buildAfterhoursItems, buildPayload, summarize } from './lib/afterhours.mjs';

const HERE = import.meta.dirname;
const REPO_ROOT = join(HERE, '..');
const TRADES_PATH = join(REPO_ROOT, 'stocks-trades.json');
const REFERENCE_PATH = join(HERE, 'data', 'reference-prices.json');
const DEFAULT_OUT = join(REPO_ROOT, 'stocks-afterhours.json');

function usage() {
    console.log(`build-afterhours.mjs — after-hours premium per tokenized stock

USAGE
  node stocks/build-afterhours.mjs --run [options]

OPTIONS
  --run                 Actually build. Without it this help is printed and nothing runs.
  --out=<path>          Output file (default stocks-afterhours.json in the repo root).
  --help                This text.

INPUTS
  stocks-trades.json                  the stored trade tape (.trades[]: time, mint, priceUsd, suspect)
  stocks/data/reference-prices.json   refPrice + the Pyth feed \`schedule\` per mint

OUTPUT
  One item per mint that has BOTH a parsed schedule and a reference price. Each trade's premium is
  priceUsd / refPrice - 1 in percent; trades are bucketed by the session their timestamp falls in
  (a holiday counts as closed) and each side is the MEDIAN of its bucket, or null below
  ${MIN_SIDE_TRADES} trades. gapPct = closedPremiumPct - openPremiumPct, null if either side is null.
  A mint with no Pyth feed (PreStocks' private companies, Tessera) has no listed market to be open
  or closed at all, so it is omitted and counted in \`omittedMints\` rather than emitted as nulls.

NOTES
  refPrice is the LAST reference price at build time, not a per-trade historical reference. While
  the underlying market is shut that price does not move, so the closed-session figure is sound;
  the open-session figure is measured against a reference that has since moved. Re-run
  stocks:prices and this build together to keep the two close.`);
}

function fmtPct(value) {
    return Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}%` : 'n/a';
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }
    const outPath = typeof flags.out === 'string' ? flags.out : DEFAULT_OUT;

    const trades = await readJson(TRADES_PATH);
    if (!Array.isArray(trades?.trades)) throw new Error(`${TRADES_PATH}: expected {trades:[...]}`);
    const reference = await readJson(REFERENCE_PATH);
    if (!Array.isArray(reference?.items)) throw new Error(`${REFERENCE_PATH}: expected {items:[...]}`);

    const withSchedule = reference.items.filter((item) => typeof item?.schedule === 'string' && item.schedule !== '').length;
    log(`read ${trades.trades.length} trade(s) (generated ${trades.generatedAt}) and ${reference.items.length} reference item(s) ` +
        `(fetched ${reference.fetchedAt}), ${withSchedule} of them carrying a Pyth schedule`);
    if (withSchedule === 0) {
        logWarn('no reference item carries a schedule — re-run stocks:prices, which persists it from the keyless Pyth feed list');
    }

    const { items, omittedMints, skipped } = buildAfterhoursItems(trades.trades, reference.items);
    const payload = buildPayload({
        generatedAt: ts(),
        tradesGeneratedAt: trades.generatedAt ?? null,
        referenceFetchedAt: reference.fetchedAt ?? null,
        items,
        omittedMints,
        skipped
    });
    await writeJson(outPath, payload);

    const stats = summarize(items);
    const omittedTrades = omittedMints.reduce((sum, row) => sum + row.trades, 0);
    if (omittedMints.length > 0) {
        log(`omitted ${omittedMints.length} traded mint(s) / ${omittedTrades} trade(s) with no measurable reference: ` +
            omittedMints.map((row) => `${row.symbol ?? row.mint} (${row.reason}, ${row.trades})`).join(', '));
    }
    log(`skipped trades: ${skipped.suspect} suspect, ${skipped.noPriceUsd} without a USD price, ` +
        `${skipped.unknownSession} with an unknown session, ${skipped.badTime} with an unparseable time, ${skipped.noPremium} without a premium`);
    const largest = stats.largestGap === null
        ? 'none (no mint has both sides)'
        : `${stats.largestGap.symbol ?? stats.largestGap.mint} ${fmtPct(stats.largestGap.gapPct)} ` +
          `(open ${fmtPct(stats.largestGap.openPremiumPct)} on ${stats.largestGap.tradesOpen}, closed ${fmtPct(stats.largestGap.closedPremiumPct)} on ${stats.largestGap.tradesClosed})`;
    log(`wrote ${outPath}: ${stats.items} item(s), ${stats.bothSides} with both sides ` +
        `(${stats.closedOnly} closed-only, ${stats.openOnly} open-only) — largest |gap| ${largest}`);
    return 0;
}

main().then((code) => process.exit(code), (err) => {
    logError(err.stack ?? String(err));
    process.exit(1);
});
