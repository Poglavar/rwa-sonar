#!/usr/bin/env node
// Collects the Monday gap in Kamino's collateral prices: for every Kamino stock reserve in the
// research (stocks/data/protocol-market-research.json oraclePricing), reads Kamino's KEYLESS hourly
// reserve history (assetOraclePriceUSD) and stores, per weekend, the price the reserve held after
// Friday's close and the price it used at its first reading after the reopening. The rules live in
// lib/lender-gaps.mjs (tested). Writes stocks/data/lender-price-gaps.json after every reserve, so a
// killed run keeps what it read; the next run re-reads only the last week or so of each reserve.

import { join } from 'node:path';

import { log, logError, logWarn, parseArgs, readJson, sleep, ts, writeJson, fetchJson } from './lib/io.mjs';
import { fetchStartMs, historyUrl, kaminoReserves, mergeWeekends, seriesFromHistory, weekendGaps } from './lib/lender-gaps.mjs';
import { usEquitySchedule } from './lib/lending-events.mjs';
import { parseSchedule } from './lib/market-hours.mjs';

const HERE = import.meta.dirname;
const DEFAULT_OUT = join(HERE, 'data', 'lender-price-gaps.json');
const PACE_MS = 500;
const HOUR_MS = 60 * 60 * 1000;

function usage() {
    console.log(`fetch-lender-price-history.mjs — Kamino collateral price: Friday close → Monday open, per weekend

USAGE
  node stocks/fetch-lender-price-history.mjs --run [options]

OPTIONS
  --run              Actually fetch. Without it this help is printed and nothing runs.
  --limit=<n>        Read at most n reserves this run (default: all; for a small first run).
  --max-days=<n>     History read for a reserve with nothing stored yet (default 35).
  --out=<path>       Store (default stocks/data/lender-price-gaps.json).
  --help             This text.

SOURCE
  GET https://api.kamino.finance/kamino-market/<market>/reserves/<reserve>/metrics/history
      ?env=mainnet-beta&start=…&end=…&frequency=hour   (keyless; ~1 MB per 35 days per reserve)
  One call per Kamino stock reserve (16 in the research, 2026-09-24), ${PACE_MS} ms apart. A reserve
  already stored is re-read from a week before its newest weekend, so later runs are small.

OUTPUT
  {fetchedAt, source, method, reserves[], weekends[]}: weekends[] has marketId, mint, symbol,
  reserve, closeAt/closeValue (second hourly reading after Friday's close), heldValue, reopenAt/
  reopenValue (first reading in the regular session), gapPct and movedWhileClosedPct. Every
  timestamp is the API's own hourly reading time. Exposure (collateral within the gap of
  liquidation) is not measured here.`);
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }
    const outPath = typeof flags.out === 'string' ? flags.out : DEFAULT_OUT;
    const maxDays = Number.isInteger(Number(flags['max-days'])) && Number(flags['max-days']) > 0 ? Number(flags['max-days']) : 35;
    const research = await readJson(join(HERE, 'data', 'protocol-market-research.json'));
    const schedule = parseSchedule(usEquitySchedule(await readJson(join(HERE, 'data', 'reference-prices.json'), { items: [] })));
    if (schedule === null) throw new Error('no US equity schedule in stocks/data/reference-prices.json (run stocks/fetch-reference-prices.mjs)');
    let reserves = kaminoReserves(research?.oraclePricing);
    const limit = Number(flags.limit);
    if (Number.isInteger(limit) && limit > 0) reserves = reserves.slice(0, limit);
    const store = await readJson(outPath, { weekends: [], reserves: [] });
    const nowMs = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    const startedMs = Date.now();
    log(`reading ${reserves.length} Kamino reserve(s); ${store.weekends?.length ?? 0} weekend row(s) stored`);

    let weekends = store.weekends ?? [];
    const reserveState = new Map((store.reserves ?? []).map((r) => [`${r.marketId}|${r.reserve}`, r]));
    const failures = [];
    for (const [index, reserve] of reserves.entries()) {
        const startMs = fetchStartMs(weekends, reserve.marketId, reserve.mint, nowMs, maxDays);
        const url = historyUrl(reserve, startMs, nowMs);
        const res = await fetchJson(url, { timeoutMs: 60000 }).catch((err) => ({ ok: false, status: null, parseError: err.message }));
        if (!res.ok || !Array.isArray(res.json?.history)) {
            failures.push(`${reserve.symbol} ${reserve.marketId}: HTTP ${res.status} ${res.parseError ?? res.bodyPreview ?? ''}`.trim());
            logWarn(`${index + 1}/${reserves.length} ${reserve.symbol} (${reserve.marketId}): read failed — HTTP ${res.status}`);
            await sleep(PACE_MS);
            continue;
        }
        const series = seriesFromHistory(res.json.history);
        const rows = weekendGaps(series, schedule).map((row) => ({ marketId: reserve.marketId, mint: reserve.mint, symbol: reserve.symbol, reserve: reserve.reserve, ...row }));
        weekends = mergeWeekends(weekends, rows);
        reserveState.set(`${reserve.marketId}|${reserve.reserve}`, {
            marketId: reserve.marketId, reserve: reserve.reserve, mint: reserve.mint, symbol: reserve.symbol,
            readFrom: series.length ? new Date(series[0].t).toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
            readTo: series.length ? new Date(series.at(-1).t).toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
            readings: series.length
        });
        // Checkpoint after every reserve: a killed run keeps everything read so far.
        await writeJson(outPath, {
            fetchedAt: ts(),
            source: 'Kamino keyless reserve history (assetOraclePriceUSD, hourly)',
            method: 'Per weekend (a closed stretch of the US equity schedule containing a UTC Saturday): closeValue is the second hourly reading after the close, reopenValue the first reading in the regular session, gapPct = reopenValue / closeValue - 1. A reading gap over 2 h at either boundary leaves that weekend out.',
            reserves: [...reserveState.values()].sort((a, b) => (a.marketId + a.symbol < b.marketId + b.symbol ? -1 : 1)),
            weekends
        });
        const latest = rows.at(-1);
        const elapsed = (Date.now() - startedMs) / 1000;
        const eta = Math.round((elapsed / (index + 1)) * (reserves.length - index - 1));
        log(`${index + 1}/${reserves.length} ${reserve.symbol} (${reserve.marketId}): ${series.length} reading(s), ${rows.length} weekend(s)`
            + `${latest ? `, latest ${latest.reopenAt.slice(0, 10)} ${latest.gapPct >= 0 ? '+' : ''}${latest.gapPct.toFixed(2)} %` : ''} · ETA ${eta}s`);
        await sleep(PACE_MS);
    }
    log(`wrote ${outPath}: ${weekends.length} weekend row(s) across ${reserveState.size} reserve(s); ${failures.length} failed`);
    if (failures.length) {
        logError(`reserve reads failed: ${failures.join(' | ')}`);
        return 1;
    }
    return 0;
}

main().then((code) => process.exit(code), (err) => {
    logError(err.stack ?? String(err));
    process.exit(1);
});
