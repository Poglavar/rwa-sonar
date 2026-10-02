#!/usr/bin/env node
// Diff the newest two daily DeFi snapshots — the exact-token registry snapshot (defi.json) and the
// on-chain footprint snapshot (defi-footprint.json) — and publish the evidence plus morning-alert
// lines; also publish the rolling "New in DeFi" feed (stocks-defi-new.json) over every stored day.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { COLLATERAL_DROP_PCT, COLLATERAL_VALUE_FLOOR_USD, DEFI_CHANGE_KINDS, buildDefiNewFeed, diffDefiSnapshots, formatDefiNoticeLines, mergeFootprintDiff } from './lib/defi-changes.mjs';
import { CANDIDATE_MIN_SHARE_PCT, CANDIDATE_MIN_USD, diffFootprints } from './lib/defi-footprint.mjs';
import { assignSlugs } from './lib/cards.mjs';
import { log, logError, logWarn, parseArgs, readJson, ts, writeJson } from './lib/io.mjs';

const HERE = import.meta.dirname;
const ROOT = join(HERE, '..');
const HISTORY_DIR = join(HERE, 'data', 'history');
const OUT_PATH = join(ROOT, 'stocks-defi-changes.json');
const FEED_PATH = join(ROOT, 'stocks-defi-new.json');
const FOOTPRINT_PATH = join(HERE, 'data', 'defi-footprint.json');
const TOKENS_PATH = join(ROOT, 'stocks-tokens.json');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function usage() {
    console.log(`build-defi-changes.mjs — compare the newest two daily protocol snapshots

USAGE
  node stocks/build-defi-changes.mjs --run

OUTPUT
  stocks-defi-changes.json — exact evidence plus compact noticeLines for the morning digest
  stocks-defi-new.json     — "New in DeFi": protocol additions/removals/candidates over the last 30
                             stored days (registry and on-chain), plus the current review candidates`);
}

async function snapshotDates(file = 'defi.json') {
    const entries = await readdir(HISTORY_DIR, { withFileTypes: true }).catch((err) => {
        if (err.code === 'ENOENT') return [];
        throw err;
    });
    const dates = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || !DATE_RE.test(entry.name)) continue;
        const snapshot = await readJson(join(HISTORY_DIR, entry.name, file), null);
        if (snapshot?.date && (Array.isArray(snapshot.items) || (snapshot.reads && typeof snapshot.reads === 'object'))) dates.push(entry.name);
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
    const footprintDates = await snapshotDates('defi-footprint.json');
    const tokenDb = await readJson(TOKENS_PATH, { tokens: [] });
    const slugs = assignSlugs(tokenDb.tokens);
    const withSlugs = (diff) => ({ ...diff, events: diff.events.map((event) => ({ ...event, cardSlug: slugs.get(event.mint) ?? null })) });
    const load = (date, file) => readJson(join(HISTORY_DIR, date, file));
    // Every consecutive pair of stored days, for the rolling feed; the last pair is `latest`.
    const registryDiffs = [];
    for (let i = 1; i < dates.length; i += 1) {
        registryDiffs.push(withSlugs(diffDefiSnapshots(await load(dates[i - 1], 'defi.json'), await load(dates[i], 'defi.json'))));
    }
    const footprintDiffs = [];
    for (let i = 1; i < footprintDates.length; i += 1) {
        footprintDiffs.push(withSlugs(diffFootprints(await load(footprintDates[i - 1], 'defi-footprint.json'), await load(footprintDates[i], 'defi-footprint.json'))));
    }
    let latest = null;
    const lastRegistry = registryDiffs.at(-1) ?? null;
    const lastFootprint = footprintDiffs.at(-1) ?? null;
    if (lastRegistry || lastFootprint) {
        // Only merge the footprint diff when it ends on the same day as the registry diff (or there
        // is no registry diff), so a stale footprint pair is never re-announced as today's news.
        const footprintToday = lastFootprint && (!lastRegistry || lastFootprint.to === lastRegistry.to) ? lastFootprint : null;
        latest = mergeFootprintDiff(lastRegistry, footprintToday);
        latest.noticeLines = formatDefiNoticeLines(latest);
    } else {
        logWarn(`${dates.length} registry and ${footprintDates.length} footprint snapshot day(s) — baseline recorded, nothing to compare yet`);
    }
    const output = {
        generatedAt: ts(),
        methodology: 'Daily exact-token protocol registry comparison plus the on-chain footprint comparison (which programs hold each token). A first observation is a baseline, not an addition; a mint that could not be read on either day raises no footprint event.',
        thresholds: {
            collateralDropPct: COLLATERAL_DROP_PCT,
            collateralValueFloorUsd: COLLATERAL_VALUE_FLOOR_USD,
            ltv: 'Any change where both days report a configured maximum LTV range.',
            footprintCandidateMinSharePct: CANDIDATE_MIN_SHARE_PCT,
            footprintCandidateMinUsd: CANDIDATE_MIN_USD
        },
        kinds: DEFI_CHANGE_KINDS,
        snapshotDates: dates,
        footprintSnapshotDates: footprintDates,
        latest
    };
    const footprint = await readJson(FOOTPRINT_PATH, null);
    const feed = buildDefiNewFeed([...registryDiffs, ...footprintDiffs], { slugs });
    await writeJson(FEED_PATH, {
        generatedAt: output.generatedAt,
        methodology: 'Protocol additions, removals and review candidates for exact tokenized-stock mints over the last 30 stored days. "registry" = the protocol\'s own exact-token registry or pool list; "chain" = a protocol program observed holding the token on-chain. An addition is an observation date, not proof that a user transaction succeeds.',
        ...feed,
        candidates: (footprint?.candidates ?? []).map((row) => ({ ...row, cardSlug: slugs.get(row.mint) ?? null })),
        footprintFetchedAt: footprint?.fetchedAt ?? null
    });
    log(`wrote ${FEED_PATH}: ${feed.items.length} feed row(s) over ${feed.days.length} day(s), ${footprint?.candidates?.length ?? 0} current candidate(s)`);
    await writeJson(OUT_PATH, output);
    log(`wrote ${OUT_PATH}: ${latest?.events.length ?? 0} change(s) across ${dates.length} registry / ${footprintDates.length} footprint snapshot day(s)`);
    return 0;
}

main().then((code) => process.exit(code), (err) => {
    logError(err.stack ?? String(err));
    process.exit(1);
});
