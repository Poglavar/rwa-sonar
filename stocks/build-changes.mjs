#!/usr/bin/env node
// Builds stocks-changes.json, the health monitor's change log: every consecutive pair of daily
// snapshots under stocks/data/history/ is diffed, the FULL change list is kept for the newest pair
// only and every older pair is reduced to counts per kind, and the curated stocks/data/events.json
// entries are appended newest-first. Keeping one full list bounds the file no matter how many days
// accumulate. It also carries `newMints`: the tokens the universe first saw in the last fortnight,
// read from the `firstSeenAt` provenance stocks/lib/universe.mjs records, which is what the "New on
// Solana" strip on stocks.html and monitor.html scrolls. All the diffing and selecting lives in
// lib/changes.mjs and is unit-tested — this CLI only reads the files, calls it, writes the output
// and reports what moved.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
    CHANGE_KINDS, CHANGE_KIND_LABELS, NEW_MINT_WINDOW_DAYS, countByKind, diffSnapshots, selectNewMints
} from './lib/changes.mjs';
import { assignSlugs } from './lib/cards.mjs';
import { log, logError, logWarn, parseArgs, readJson, ts, writeJson } from './lib/io.mjs';

const HERE = import.meta.dirname;
const REPO_ROOT = join(HERE, '..');
const HISTORY_DIR = join(HERE, 'data', 'history');
const EVENTS_PATH = join(HERE, 'data', 'events.json');
const TOKENS_PATH = join(REPO_ROOT, 'stocks-tokens.json');
const DEFAULT_OUT = join(REPO_ROOT, 'stocks-changes.json');

const DEFAULT_DAYS = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function usage() {
    console.log(`build-changes.mjs — the daily change log for the health monitor

USAGE
  node stocks/build-changes.mjs --run [options]

OPTIONS
  --run            Actually build. Without it this help is printed and nothing runs.
  --days=<n>       How many of the newest snapshot days to consider (default ${DEFAULT_DAYS}).
  --out=<path>     Output file (default stocks-changes.json in the repo root).
  --help           This text.

INPUTS
  stocks/data/history/<date>/tokens.json   one day's slim token rows (stocks/snapshot.mjs)
  stocks/data/events.json                  curated, dated issuer events
  stocks-tokens.json                       the current build, for the newMints feed (optional)

OUTPUT
  {generatedAt, kinds:[{id,label}], days:[dates], latest:{from,to,changes:[...]},
   history:[{from,to,counts}], newMintWindowDays, newMints:[...],
   eventKinds:{kind:description}, events:[...]}

  \`latest\` carries the whole change list for the newest pair of days; \`history\` carries only
  \`counts\` per kind for every pair, oldest first, so a year of history stays a small file. With
  fewer than two snapshot days there is nothing to diff: \`latest\` is null and the build says so
  rather than emitting an empty diff that would read as "nothing changed".

  \`newMints\` is every token in stocks-tokens.json whose \`firstSeenAt\` is inside the last
  ${NEW_MINT_WINDOW_DAYS} days, newest first, as {mint, symbol, name, issuer, issuerName,
  firstSeenAt, cardSlug}. A token first seen on or before the FIRST recorded snapshot day is left
  out: on that day every mint in existence was "first seen", so the date is a lower bound rather
  than an arrival anyone watched. Without stocks-tokens.json the feed is empty and the build says so.

  Change kinds: ${CHANGE_KINDS.join(', ')}.`);
}

/** The snapshot dates on disk that actually have a tokens.json, oldest first. */
async function snapshotDates() {
    const entries = await readdir(HISTORY_DIR, { withFileTypes: true }).catch((err) => {
        if (err.code === 'ENOENT') return [];
        throw err;
    });
    return entries
        .filter((entry) => entry.isDirectory() && DATE_RE.test(entry.name))
        .map((entry) => entry.name)
        .sort();
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }
    const days = Number.isFinite(Number(flags.days)) && Number(flags.days) > 0 ? Math.floor(Number(flags.days)) : DEFAULT_DAYS;
    const outPath = typeof flags.out === 'string' ? flags.out : DEFAULT_OUT;

    const allDates = await snapshotDates();
    const dates = allDates.slice(-days);
    if (allDates.length > dates.length) {
        log(`${allDates.length} snapshot day(s) on disk; considering the newest ${dates.length} (--days=${days})`);
    }
    if (dates.length === 0) {
        logWarn(`no snapshot days under ${HISTORY_DIR} — run stocks/snapshot.mjs --run first`);
    } else {
        log(`snapshot days: ${dates.join(', ')}`);
    }

    const snapshots = new Map();
    for (const date of dates) {
        const path = join(HISTORY_DIR, date, 'tokens.json');
        const snapshot = await readJson(path, null);
        if (snapshot === null || !Array.isArray(snapshot.items)) {
            logWarn(`${path}: no {items:[...]} — skipping ${date}`);
            continue;
        }
        snapshots.set(date, snapshot);
    }
    const usable = [...snapshots.keys()];

    const history = [];
    let latest = null;
    for (let i = 1; i < usable.length; i += 1) {
        const diff = diffSnapshots(snapshots.get(usable[i - 1]), snapshots.get(usable[i]));
        history.push({ from: diff.from, to: diff.to, counts: countByKind(diff.changes) });
        latest = diff;
    }
    if (usable.length < 2) {
        logWarn(`only ${usable.length} usable snapshot day(s) — nothing to diff, \`latest\` will be null`);
    }

    const events = await readJson(EVENTS_PATH, null);
    const eventItems = Array.isArray(events?.events) ? [...events.events] : [];
    if (events === null) logWarn(`${EVENTS_PATH} is absent — the events section will be empty`);
    eventItems.sort((a, b) => String(b?.date ?? '').localeCompare(String(a?.date ?? '')));

    // One timestamp for the whole file, so the 14-day window is measured against the same instant
    // the file reports as its own.
    const generatedAt = ts();

    const tokenDb = await readJson(TOKENS_PATH, null);
    const tokenList = Array.isArray(tokenDb?.tokens) ? tokenDb.tokens : [];
    if (tokenDb === null || !Array.isArray(tokenDb.tokens)) {
        logWarn(`${TOKENS_PATH}: no {tokens:[...]} — the newMints feed will be empty `
            + '(run npm run stocks:build first)');
    }
    // `issuerIndex` is a LIST of {slug, name, …} records, not a map keyed by slug.
    const issuerNames = Object.fromEntries((Array.isArray(tokenDb?.issuerIndex) ? tokenDb.issuerIndex : [])
        .filter((issuer) => typeof issuer?.slug === 'string' && typeof issuer?.name === 'string' && issuer.name.trim() !== '')
        .map((issuer) => [issuer.slug, issuer.name]));
    // The builder's own slug rules, so a chip links to the file build-cards.mjs actually writes
    // (it appends a mint suffix when two tokens want the same slug).
    const newMints = selectNewMints(tokenList, {
        now: generatedAt,
        recordsBeginOn: usable[0] ?? null,
        slugs: assignSlugs(tokenList),
        issuerNames
    });

    await writeJson(outPath, {
        generatedAt,
        // The kind order and labels travel WITH the data, so monitor.js groups the change log by the
        // same ordering the diff used instead of keeping its own copy that could drift out of step.
        kinds: CHANGE_KINDS.map((id) => ({ id, label: CHANGE_KIND_LABELS[id] ?? id })),
        days: usable,
        latest,
        history,
        // The window travels with the feed, so the strip's own heading cannot claim a different
        // fortnight from the one that selected the rows.
        newMintWindowDays: NEW_MINT_WINDOW_DAYS,
        newMints,
        // events.json's own descriptions of what each event kind means, so the page's kind chip can
        // explain itself instead of the page inventing a gloss for a curated vocabulary.
        eventKinds: events?.kinds && typeof events.kinds === 'object' ? events.kinds : {},
        events: eventItems
    });

    for (const pair of history) {
        const counts = Object.entries(pair.counts);
        const summary = counts.length === 0 ? 'nothing changed' : counts.map(([kind, n]) => `${kind} ${n}`).join(', ');
        log(`${pair.from} → ${pair.to}: ${summary}`);
    }
    const newest = newMints[0]?.firstSeenAt ?? null;
    log(`newMints: ${newMints.length} mint(s) first seen in the last ${NEW_MINT_WINDOW_DAYS} day(s) out of `
        + `${tokenList.length} token(s)${newest === null ? '' : `, newest first seen ${newest}`}`
        + `${usable[0] ? ` (mints already there on ${usable[0]}, the first recorded day, are not counted)` : ''}`);
    const changeCount = latest?.changes.length ?? 0;
    log(`wrote ${outPath}: ${usable.length} day(s), ${history.length} pair(s), `
        + `${changeCount} change(s) in the latest pair, ${newMints.length} new mint(s), ${eventItems.length} curated event(s)`);
    return 0;
}

main().then((code) => process.exit(code), (err) => {
    logError(err.stack ?? String(err));
    process.exit(1);
});
