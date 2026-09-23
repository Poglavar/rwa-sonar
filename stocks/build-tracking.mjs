#!/usr/bin/env node
// Builds stocks-tracking.json for tracking.html: per underlying share, every Solana wrapper's
// premium/discount to the share's reference price over time (with the underlying market's closed
// stretches), and the holder-concentration-vs-liquidity scatter of every token. It also keeps
// stocks/data/tracking-log.json, an accumulating, idempotent log of every reference observation
// and every trade that could be paired with a contemporaneous reference — the published trade tape
// is a rolling 24 h window and reference-prices.json holds only the latest fetch, so without the
// log the history would never grow past one day. All arithmetic is in lib/tracking.mjs (tested).

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { log, logWarn, parseArgs, readJson, ts, writeJson } from './lib/io.mjs';
import { parseSchedule } from './lib/market-hours.mjs';
import {
    LOG_KEEP_MS, PAIR_TOLERANCE_MS, buildConcentrationSection, buildPremiumSection, closedIntervals,
    emptyLog, mergeLog, referenceObservations, snapshotPoints
} from './lib/tracking.mjs';

const HERE = import.meta.dirname;
const REPO_ROOT = join(HERE, '..');
const DAY_MS = 24 * 60 * 60 * 1000;

function usage() {
    console.log(`build-tracking.mjs — premium/discount history and concentration-vs-liquidity data

USAGE
  node stocks/build-tracking.mjs --run [options]

OPTIONS
  --run              Actually build. Without it this help is printed and nothing runs.
  --in-dir=<dir>     Read the inputs from this repo-shaped directory (default: the repo root).
  --log=<path>       Tracking log to read and update (default stocks/data/tracking-log.json).
  --out=<path>       Output file (default stocks-tracking.json in the repo root).
  --now=<iso>        The build instant (default: now). Closed stretches are drawn up to it.
  --help             This text.

INPUTS (relative to --in-dir)
  stocks-tokens.json                      wrappers per underlying, cardSlug, Jupiter liquidity/holders
  stocks/data/reference-prices.json       latest reference price + Jupiter price + Pyth schedule
  stocks-trades.json                      the rolling 24 h trade tape
  stocks/data/history/<date>/tokens.json  daily snapshot premia
  stocks/data/holders.json                top-20 holders with owner labels
  stocks/data/venues.json                 DexScreener pools (liquidity fallback)
  stocks-issuers.json                     issuer display names (optional)

PAIRING RULE
  A trade's premium is computed only against a reference observed in the SAME closed stretch of
  the underlying market, or within ${PAIR_TOLERANCE_MS / 60000} minutes of it. Unpaired trades are counted, not plotted.
  The log is idempotent (references keyed by mint+fetchedAt, trades by signature) and pruned to
  ${LOG_KEEP_MS / DAY_MS} days, so rerunning with the same inputs changes nothing.`);
}

async function readHistory(inDir) {
    const dir = join(inDir, 'stocks', 'data', 'history');
    let dates = [];
    try {
        dates = (await readdir(dir)).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort();
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
    const docs = [];
    for (const date of dates) {
        const doc = await readJson(join(dir, date, 'tokens.json'), null);
        if (doc === null) continue;
        docs.push({ date, builtAt: doc.builtAt ?? null, items: doc.items ?? [] });
    }
    return docs;
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }
    const inDir = typeof flags['in-dir'] === 'string' ? flags['in-dir'] : REPO_ROOT;
    const logPath = typeof flags.log === 'string' ? flags.log : join(REPO_ROOT, 'stocks', 'data', 'tracking-log.json');
    const outPath = typeof flags.out === 'string' ? flags.out : join(REPO_ROOT, 'stocks-tracking.json');
    const nowIso = typeof flags.now === 'string' ? flags.now : ts();
    const nowMs = Date.parse(nowIso);
    if (!Number.isFinite(nowMs)) throw new Error(`--now is not a timestamp: ${nowIso}`);

    const tokensDoc = await readJson(join(inDir, 'stocks-tokens.json'));
    const referenceDoc = await readJson(join(inDir, 'stocks', 'data', 'reference-prices.json'));
    const tradesDoc = await readJson(join(inDir, 'stocks-trades.json'), { trades: [] });
    const holdersDoc = await readJson(join(inDir, 'stocks', 'data', 'holders.json'), { items: [] });
    const venuesDoc = await readJson(join(inDir, 'stocks', 'data', 'venues.json'), { items: [] });
    const issuersDoc = await readJson(join(inDir, 'stocks-issuers.json'), { issuers: [] });
    const history = await readHistory(inDir);
    const previousLog = await readJson(logPath, emptyLog());
    const tokens = Array.isArray(tokensDoc?.tokens) ? tokensDoc.tokens : [];
    const trades = Array.isArray(tradesDoc?.trades) ? tradesDoc.trades : [];
    log(`read ${tokens.length} token(s) (built ${tokensDoc.builtAt}), ${referenceDoc.items?.length ?? 0} reference item(s) ` +
        `(fetched ${referenceDoc.fetchedAt}), ${trades.length} trade(s) (generated ${tradesDoc.generatedAt ?? 'n/a'}), ` +
        `${history.length} daily snapshot(s), log with ${previousLog.references.length} reference(s) / ${previousLog.trades.length} paired trade(s)`);

    // Closed stretches per distinct schedule, over the span every logged instant can reach.
    const keepFromMs = nowMs - LOG_KEEP_MS;
    const newRefs = referenceObservations(referenceDoc);
    const instants = [
        ...previousLog.references.map((r) => Date.parse(r.at)),
        ...previousLog.trades.map((r) => Date.parse(r.t)),
        ...newRefs.map((r) => Date.parse(r.at)),
        ...trades.map((r) => Date.parse(r.time))
    ].filter(Number.isFinite);
    const spanFrom = Math.max(keepFromMs, (instants.length ? Math.min(...instants) : nowMs) - DAY_MS);
    const intervalsBySchedule = new Map();
    const intervalsByMint = new Map();
    for (const item of referenceDoc.items ?? []) {
        if (typeof item?.schedule !== 'string' || typeof item?.mint !== 'string') continue;
        if (!intervalsBySchedule.has(item.schedule)) {
            intervalsBySchedule.set(item.schedule, closedIntervals(parseSchedule(item.schedule), spanFrom, nowMs));
        }
        const intervals = intervalsBySchedule.get(item.schedule);
        if (intervals !== null) intervalsByMint.set(item.mint, intervals);
    }

    const { log: nextLog, skipped } = mergeLog(previousLog, { references: newRefs, trades, intervalsByMint, keepFromMs });
    await writeJson(logPath, nextLog);
    log(`log now ${nextLog.references.length} reference observation(s), ${nextLog.trades.length} paired trade(s); ` +
        `trades not paired: ${JSON.stringify(skipped)}`);

    const snapshots = snapshotPoints(history);
    const premium = buildPremiumSection({ tokens, referenceDoc, log: nextLog, snapshots, nowMs });
    const concentration = buildConcentrationSection({
        tokens, holdersDoc, venuesDoc, universeFetchedAt: tokensDoc.sources?.universe?.fetchedAt ?? null
    });
    if (premium.counts.underlyings === 0) logWarn('no underlying has a single premium observation');

    const payload = {
        generatedAt: nowIso,
        inputs: {
            tokensBuiltAt: tokensDoc.builtAt ?? null,
            referenceFetchedAt: referenceDoc.fetchedAt ?? null,
            tradesGeneratedAt: tradesDoc.generatedAt ?? null,
            tradesCollectingSince: tradesDoc.collectingSince ?? null,
            historyDates: history.map((doc) => doc.date),
            logReferences: nextLog.references.length,
            logPairedTrades: nextLog.trades.length,
            logFrom: nextLog.references[0]?.at ?? null,
            unpairedTradesThisRun: skipped
        },
        pairToleranceMinutes: PAIR_TOLERANCE_MS / 60000,
        issuers: Object.fromEntries((issuersDoc.issuers ?? []).filter((i) => i?.slug && i?.name).map((i) => [i.slug, i.name])),
        premium,
        concentration
    };
    await writeJson(outPath, payload, 0);
    log(`wrote ${outPath}: ${premium.counts.underlyings} underlying(s) with observations ` +
        `(${premium.counts.quotePoints} quote, ${premium.counts.snapshotPoints} snapshot, ${premium.counts.tradePoints} trade-hour point(s)); ` +
        `scatter ${concentration.counts.plotted} plotted, ${concentration.counts.inCorner} in the corner, ` +
        `${concentration.counts.notPlotted} not plotted (liquidity missing ${concentration.counts.missingLiquidity}, ` +
        `zero ${concentration.counts.zeroLiquidity}, holders missing ${concentration.counts.missingHolders})`);
    return 0;
}

main().then((code) => process.exit(code), (err) => {
    console.error(`[${ts()}] ERROR build-tracking failed:`, err.stack || err.message);
    process.exit(1);
});
