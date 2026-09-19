#!/usr/bin/env node
// Diff the newest two daily DeFi snapshots and publish the evidence plus morning-alert lines.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { COLLATERAL_DROP_PCT, COLLATERAL_VALUE_FLOOR_USD, DEFI_CHANGE_KINDS, diffDefiSnapshots, formatDefiNoticeLines } from './lib/defi-changes.mjs';
import { log, logError, logWarn, parseArgs, readJson, ts, writeJson } from './lib/io.mjs';

const HERE = import.meta.dirname;
const ROOT = join(HERE, '..');
const HISTORY_DIR = join(HERE, 'data', 'history');
const OUT_PATH = join(ROOT, 'stocks-defi-changes.json');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function usage() {
    console.log(`build-defi-changes.mjs — compare the newest two daily protocol snapshots

USAGE
  node stocks/build-defi-changes.mjs --run

OUTPUT
  stocks-defi-changes.json — exact evidence plus compact noticeLines for the morning digest`);
}

async function snapshotDates() {
    const entries = await readdir(HISTORY_DIR, { withFileTypes: true }).catch((err) => {
        if (err.code === 'ENOENT') return [];
        throw err;
    });
    const dates = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || !DATE_RE.test(entry.name)) continue;
        const snapshot = await readJson(join(HISTORY_DIR, entry.name, 'defi.json'), null);
        if (snapshot?.date && Array.isArray(snapshot.items)) dates.push(entry.name);
    }
    return dates.sort();
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }
    const dates = await snapshotDates();
    let latest = null;
    if (dates.length >= 2) {
        const [from, to] = dates.slice(-2);
        const [previous, current] = await Promise.all([
            readJson(join(HISTORY_DIR, from, 'defi.json')),
            readJson(join(HISTORY_DIR, to, 'defi.json'))
        ]);
        latest = diffDefiSnapshots(previous, current);
        latest.noticeLines = formatDefiNoticeLines(latest);
    } else {
        logWarn(`${dates.length} protocol snapshot day(s) available — baseline recorded, nothing to compare yet`);
    }
    const output = {
        generatedAt: ts(),
        methodology: 'Daily exact-token protocol registry comparison. A first observation is a baseline, not an addition.',
        thresholds: {
            collateralDropPct: COLLATERAL_DROP_PCT,
            collateralValueFloorUsd: COLLATERAL_VALUE_FLOOR_USD,
            ltv: 'Any change where both days report a configured maximum LTV range.'
        },
        kinds: DEFI_CHANGE_KINDS,
        snapshotDates: dates,
        latest
    };
    await writeJson(OUT_PATH, output);
    log(`wrote ${OUT_PATH}: ${latest?.events.length ?? 0} change(s) across ${dates.length} snapshot day(s)`);
    return 0;
}

main().then((code) => process.exit(code), (err) => {
    logError(err.stack ?? String(err));
    process.exit(1);
});
