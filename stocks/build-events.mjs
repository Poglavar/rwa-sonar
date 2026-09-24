#!/usr/bin/env node
// Builds stocks-events.json: the latest-events feed the home page scrolls through (and falls back to
// when GET /api/events does not answer). Reads what the refresh already built plus the watchers'
// change rows from the database, and leaves every rule to lib/events.mjs. The build instant is the
// newest of the inputs' own timestamps, never the clock, so the same inputs give the same file.

import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { diffSnapshots } from './lib/changes.mjs';
import { readEnvFile } from './lib/env.mjs';
import {
    JUDGMENT_TABLE_PROBE, LENDING_TABLE_PROBE, MAX_EVENTS, WINDOW_DAYS, buildEventsFeed, changeRowsPsql, eventContext,
    issuerStatusChanges, lendingRowsPsql, lendingTimes
} from './lib/events.mjs';
import { log, logError, logWarn, parseArgs, readJson, writeJson } from './lib/io.mjs';
import { describeUrl, psql } from './lib/psql.mjs';
import { dataAsOf } from './lib/weekly.mjs';

const REPO_ROOT = join(import.meta.dirname, '..');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

function usage() {
    console.log(`build-events.mjs — the latest-events feed (stocks-events.json)

USAGE
  node stocks/build-events.mjs --run [options]

OPTIONS
  --run                 Actually build. Without it this help is printed and nothing runs.
  --root=<dir>          Repo root to read from and write to (default: this repo).
  --out=<file>          Output path (default <root>/stocks-events.json).
  --no-db               Do not read DATABASE_URL (watcher events are then left out, and said so).
  --change-rows=<file>  Read change_event rows from a JSON array instead of the database
                        (the SQL's shape or /api/changes items); for checking the rules on real rows.
  --lending-rows=<file> Read {liquidations, freezes} (the lending SQL's shape) from a file instead.
  --window-days=<n>     Days back from the newest input (default ${WINDOW_DAYS}).
  --limit=<n>           Max events kept (default ${MAX_EVENTS}).
  --print               Print every selected event, one line each, for review.
  --help                This text.

INPUTS
  stocks-tokens.json            firstSeenAt per token, card slugs
  stocks-issuers.json           issuer display names
  stocks-change-journal.json    curated external changes
  stocks-defi-new.json          protocol support added or removed
  protocols/index.json          protocol dossier pages to link (optional)
  stocks/data/history/<date>/   daily tokens.json + issuers.json snapshots (market and control moves)
  stocks/data/mint-created.json creation times from stocks/fetch-mint-created.mjs (optional)
  stocks/data/event-resolutions.json  editorial decisions on watcher events (always this repo's copy)
  DATABASE_URL (.env)           sonar.change_event rows (chain, document and court watchers) with
                                the change judge's latest valid reading, and the lending watcher's
                                sonar.lending_liquidation / lending_price_freeze rows

OUTPUT
  stocks-events.json  {asOf, windowDays, newestEventAt, methodology, inputs, counts, excluded, events}`);
}

async function historyDays(root) {
    const entries = await readdir(join(root, 'stocks', 'data', 'history'), { withFileTypes: true }).catch((err) => {
        if (err.code === 'ENOENT') return [];
        throw err;
    });
    return entries.filter((entry) => entry.isDirectory() && DATE_RE.test(entry.name)).map((entry) => entry.name).sort();
}

/** Consecutive-day diffs of the token snapshots, each dated by the newer snapshot's own build time. */
async function snapshotDiffs(root, days, sinceDay) {
    const snaps = [];
    for (const day of days) {
        const tokens = await readJson(join(root, 'stocks', 'data', 'history', day, 'tokens.json'), null);
        if (tokens === null) continue; // a DeFi-only day
        const issuers = await readJson(join(root, 'stocks', 'data', 'history', day, 'issuers.json'), null);
        snaps.push({ day, tokens, issuers });
    }
    const diffs = [];
    for (let i = 1; i < snaps.length; i += 1) {
        if (snaps[i].day < sinceDay) continue;
        diffs.push({
            ...diffSnapshots(snaps[i - 1].tokens, snaps[i].tokens),
            toObservedAt: snaps[i].tokens.builtAt ?? null,
            issuerChanges: snaps[i - 1].issuers && snaps[i].issuers ? issuerStatusChanges(snaps[i - 1].issuers, snaps[i].issuers) : []
        });
    }
    return { diffs, recordsBeginOn: snaps[0]?.day ?? null, newestBuiltAt: snaps.at(-1)?.tokens?.builtAt ?? null };
}

/** Watcher rows since `since`, or null (with the reason logged) when the database is not read. */
async function readChangeRows({ flags, since }) {
    if (typeof flags['change-rows'] === 'string') {
        const rows = await readJson(resolve(flags['change-rows']));
        if (!Array.isArray(rows)) throw new Error(`${flags['change-rows']}: expected a JSON array of change rows`);
        log(`watcher rows: ${rows.length} from ${flags['change-rows']}`);
        return { rows, read: `file ${flags['change-rows']}` };
    }
    if (flags['no-db']) {
        logWarn('--no-db: watcher events (chain, documents, court) are left out of this build');
        return { rows: [], read: null };
    }
    const env = { ...(await readEnvFile(join(REPO_ROOT, '.env'))), ...process.env };
    if (!env.DATABASE_URL) {
        logWarn('no DATABASE_URL: watcher events (chain, documents, court) are left out of this build');
        return { rows: [], read: null };
    }
    const judgments = (await psql(env.DATABASE_URL, JUDGMENT_TABLE_PROBE, 'judgment table probe', ['-t', '-A'])).trim() === 't';
    const rows = JSON.parse((await psql(env.DATABASE_URL, changeRowsPsql({ since, judgments }), 'change rows', ['-t', '-A'])).trim() || '[]');
    log(`watcher rows: ${rows.length} since ${since} from ${describeUrl(env.DATABASE_URL)} (change judge ${judgments ? 'present' : 'ABSENT'})`);
    return { rows, read: describeUrl(env.DATABASE_URL) };
}

/** Lending rows ({liquidations, freezes}) since `since`, or null (said why) when not read. */
async function readLendingRows({ flags, since }) {
    if (typeof flags['lending-rows'] === 'string') {
        const doc = await readJson(resolve(flags['lending-rows']));
        log(`lending rows: ${doc?.liquidations?.length ?? 0} liquidation(s), ${doc?.freezes?.length ?? 0} freeze(s) from ${flags['lending-rows']}`);
        return doc;
    }
    if (flags['no-db']) return null;
    const env = { ...(await readEnvFile(join(REPO_ROOT, '.env'))), ...process.env };
    if (!env.DATABASE_URL) return null;
    if ((await psql(env.DATABASE_URL, LENDING_TABLE_PROBE, 'lending table probe', ['-t', '-A'])).trim() !== 't') {
        logWarn('lending watcher tables absent (stocks/watch-lending.mjs --ddl creates them): no lending events this build');
        return null;
    }
    const doc = JSON.parse((await psql(env.DATABASE_URL, lendingRowsPsql({ since }), 'lending rows', ['-t', '-A'])).trim() || '{}');
    log(`lending rows: ${doc?.liquidations?.length ?? 0} liquidation(s), ${doc?.freezes?.length ?? 0} freeze(s) since ${since}`);
    return doc;
}

function positive(value, fallback) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }
    const root = resolve(typeof flags.root === 'string' ? flags.root : REPO_ROOT);
    const out = resolve(typeof flags.out === 'string' ? flags.out : join(root, 'stocks-events.json'));
    const windowDays = positive(flags['window-days'], WINDOW_DAYS);
    const limit = positive(flags.limit, MAX_EVENTS);

    const tokenDb = await readJson(join(root, 'stocks-tokens.json'));
    if (!Array.isArray(tokenDb?.tokens)) throw new Error('stocks-tokens.json: expected {tokens:[...]}');
    const issuerDb = await readJson(join(root, 'stocks-issuers.json'));
    if (!Array.isArray(issuerDb?.issuers)) throw new Error('stocks-issuers.json: expected {issuers:[...]}');
    const journal = await readJson(join(root, 'stocks-change-journal.json'), { generatedAt: null, items: [] });
    const defiNew = await readJson(join(root, 'stocks-defi-new.json'), null);
    if (defiNew === null) logWarn('stocks-defi-new.json absent: no DeFi events this build');
    const protocolIndex = await readJson(join(root, 'protocols', 'index.json'), []);
    const created = await readJson(join(root, 'stocks', 'data', 'mint-created.json'), { mints: {} });
    // Editorial decisions on watcher events are curated data in the repo, never a job output.
    const resolutions = await readJson(join(REPO_ROOT, 'stocks', 'data', 'event-resolutions.json'), { items: [] });

    const days = await historyDays(root);
    const fileAsOf = dataAsOf([tokenDb.builtAt, issuerDb.builtAt, journal.generatedAt, defiNew?.generatedAt]);
    if (fileAsOf === null) throw new Error('no input carries a usable timestamp: there is no window to build');
    // Two spare days: a diff dated inside the window compares with the day before it.
    const sinceMs = Date.parse(fileAsOf) - (windowDays + 2) * DAY_MS;
    const since = new Date(sinceMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const { diffs, recordsBeginOn, newestBuiltAt } = await snapshotDiffs(root, days, since.slice(0, 10));
    const { rows, read } = await readChangeRows({ flags, since });
    const lending = await readLendingRows({ flags, since });
    const asOf = dataAsOf([fileAsOf, newestBuiltAt, ...rows.map((row) => row?.detected_at), ...lendingTimes(lending)]);

    const protocolPages = {};
    for (const entry of Array.isArray(protocolIndex) ? protocolIndex : []) {
        if (typeof entry?.mint !== 'string' || typeof entry?.protocol !== 'string' || typeof entry?.slug !== 'string') continue;
        const key = `${entry.mint}|${entry.protocol.toLowerCase()}`;
        if (!(key in protocolPages)) protocolPages[key] = entry.slug;
    }
    const ctx = eventContext({
        issuerNames: Object.fromEntries(issuerDb.issuers.filter((row) => row?.slug).map((row) => [row.slug, row.name ?? row.slug])),
        cardSlugs: Object.fromEntries(tokenDb.tokens.filter((row) => row?.mint && row?.cardSlug).map((row) => [row.mint, row.cardSlug])),
        protocolPages,
        mintCreated: created?.mints ?? {},
        recordsBeginOn,
        resolutions: resolutions.items ?? []
    });
    const feed = buildEventsFeed({
        tokens: tokenDb.tokens, journal: journal.items ?? [], changeRows: rows, defiNew, diffs, lending, ctx, asOf, windowDays, limit
    });
    const document = {
        asOf: feed.asOf,
        windowDays: feed.windowDays,
        newestEventAt: feed.newestEventAt,
        methodology: feed.methodology,
        inputs: {
            tokens: tokenDb.builtAt ?? null,
            issuers: issuerDb.builtAt ?? null,
            changeJournal: journal.generatedAt ?? null,
            defiScanner: defiNew?.generatedAt ?? null,
            dailySnapshots: newestBuiltAt,
            recordsBeginOn,
            watcherRows: read === null ? 'not read in this build' : rows.length,
            lendingRows: lending === null ? 'not read in this build' : { liquidations: lending.liquidations?.length ?? 0, freezes: lending.freezes?.length ?? 0 },
            creationTimesKnown: Object.values(created?.mints ?? {}).filter((row) => row?.state === 'created' || row?.state === 'predates').length
        },
        counts: feed.counts,
        excluded: feed.excluded,
        events: feed.events
    };
    await writeJson(out, document);
    log(`${feed.events.length} event(s) as of ${feed.asOf} → ${out}`);
    log(`by category: ${Object.entries(feed.counts.byCategory).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
    log(`by source: ${Object.entries(feed.counts.bySource).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
    log(`excluded: ${Object.entries(feed.excluded).map(([k, v]) => `${k} ×${v}`).join('; ') || 'nothing'}`);
    if (flags.print) {
        for (const event of feed.events) {
            console.log([event.at.padEnd(20), event.category.padEnd(9), event.severity.padEnd(8), event.source.padEnd(16),
                event.title, `→ ${event.href}`, event.assessment ? `[model: ${event.assessment.severity}]` : ''].join(' '));
        }
    }
    return 0;
}

if (import.meta.filename === process.argv[1]) {
    main().then((code) => process.exit(code), (err) => {
        logError(err.stack ?? String(err));
        process.exit(1);
    });
}
