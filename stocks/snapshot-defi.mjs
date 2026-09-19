#!/usr/bin/env node
// Freeze the current exact-token protocol integrations into one compact UTC-day snapshot.

import { join } from 'node:path';
import { isoDate, log, logError, parseArgs, readJson, writeJson } from './lib/io.mjs';
import { snapshotDefiUsage } from './lib/defi-changes.mjs';

const HERE = import.meta.dirname;
const USAGE_PATH = join(HERE, 'data', 'defi-usage.json');
const HISTORY_DIR = join(HERE, 'data', 'history');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function usage() {
    console.log(`snapshot-defi.mjs — freeze one day of confirmed protocol integrations

USAGE
  node stocks/snapshot-defi.mjs --run [--date=YYYY-MM-DD] [--from=<path>]

OUTPUT
  stocks/data/history/<date>/defi.json

The first snapshot is a baseline and raises no changes. Re-running a date overwrites that day's
snapshot; the next date is compared with the final state recorded for the previous day.`);
}

function sourceEvidence(sources = {}) {
    return Object.fromEntries(Object.entries(sources).map(([id, source]) => [id, {
        fetchedAt: source?.fetchedAt ?? source?.reviewedAt ?? null,
        url: source?.url ?? null,
        rows: source?.rows ?? null
    }]));
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }
    const date = typeof flags.date === 'string' ? flags.date : isoDate();
    if (!DATE_RE.test(date)) throw new Error(`--date must be YYYY-MM-DD, got ${JSON.stringify(date)}`);
    const input = typeof flags.from === 'string' ? flags.from : USAGE_PATH;
    const current = await readJson(input);
    if (!Array.isArray(current?.items)) throw new Error(`${input}: expected {items:[...]}`);
    const items = snapshotDefiUsage(current);
    const out = join(HISTORY_DIR, date, 'defi.json');
    await writeJson(out, {
        date,
        fetchedAt: current.fetchedAt ?? null,
        sources: sourceEvidence(current.sources),
        items
    }, 1);
    log(`wrote ${out}: ${items.length} exact token/protocol integration(s)`);
    return 0;
}

main().then((code) => process.exit(code), (err) => {
    logError(err.stack ?? String(err));
    process.exit(1);
});
