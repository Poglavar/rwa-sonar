#!/usr/bin/env node
// Freeze the current exact-token protocol integrations into one compact UTC-day snapshot.

import { join } from 'node:path';
import { isoDate, log, logError, logWarn, parseArgs, readJson, writeJson } from './lib/io.mjs';
import { snapshotDefiUsage } from './lib/defi-changes.mjs';
import { snapshotFootprint } from './lib/defi-footprint.mjs';

const HERE = import.meta.dirname;
const USAGE_PATH = join(HERE, 'data', 'defi-usage.json');
const FOOTPRINT_PATH = join(HERE, 'data', 'defi-footprint.json');
// A footprint older than this is not frozen as today's: the next comparison then runs against the
// last genuine observation instead of repeating a stale day (a failed scan is never a snapshot).
const FOOTPRINT_MAX_AGE_HOURS = 30;
const HISTORY_DIR = join(HERE, 'data', 'history');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function usage() {
    console.log(`snapshot-defi.mjs — freeze one day of confirmed protocol integrations

USAGE
  node stocks/snapshot-defi.mjs --run [--date=YYYY-MM-DD] [--from=<path>]

OUTPUT
  stocks/data/history/<date>/defi.json
  stocks/data/history/<date>/defi-footprint.json  (only when stocks/data/defi-footprint.json is < ${FOOTPRINT_MAX_AGE_HOURS} h old)

The first snapshot is a baseline and raises no changes. Re-running a date overwrites that day's
snapshot; the next date is compared with the final state recorded for the previous day.`);
}

function sourceEvidence(sources = {}) {
    return Object.fromEntries(Object.entries(sources).map(([id, source]) => [id, {
        fetchedAt: source?.fetchedAt ?? source?.reviewedAt ?? null,
        url: source?.url ?? null,
        rows: source?.rows ?? null,
        host: source?.host ?? null,
        slot: source?.slot ?? null,
        accountsRequested: source?.accountsRequested ?? null,
        accountsVerified: source?.accountsVerified ?? null,
        error: source?.error ?? null
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

    const footprint = await readJson(FOOTPRINT_PATH, null);
    const ageHours = footprint?.fetchedAt ? (Date.now() - Date.parse(footprint.fetchedAt)) / 3_600_000 : null;
    if (typeof flags.from === 'string') {
        log('footprint: --from given, footprint snapshot left untouched');
    } else if (ageHours === null || !(ageHours <= FOOTPRINT_MAX_AGE_HOURS)) {
        logWarn(`footprint: ${FOOTPRINT_PATH} is ${ageHours === null ? 'missing' : `${ageHours.toFixed(1)} h old`} — not frozen as ${date}`);
    } else {
        const footprintOut = join(HISTORY_DIR, date, 'defi-footprint.json');
        const compact = snapshotFootprint(footprint);
        await writeJson(footprintOut, { date, ...compact }, 0);
        log(`wrote ${footprintOut}: ${Object.values(compact.reads).filter((read) => read[0] === 'ok').length}/${Object.keys(compact.reads).length} mint(s) read, ${compact.holdings.length} DeFi/unattributed holding(s)`);
    }
    return 0;
}

main().then((code) => process.exit(code), (err) => {
    logError(err.stack ?? String(err));
    process.exit(1);
});
