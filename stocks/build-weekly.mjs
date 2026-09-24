#!/usr/bin/env node
// Builds weekly/<YYYY-Www>.html ("This week in tokenized stocks"), weekly/index.html and
// weekly/latest.html (a byte copy of the newest week, so a shared "latest" link carries that week's
// og:* tags without any script) from data the refresh has already built. Weeks start Monday 00:00
// UTC; the newest week is marked "in progress, as of <newest input timestamp>". All shaping and
// markup live in lib/weekly.mjs; this CLI only reads files and the database and writes pages.
// The weekly/ directory is generated and gitignored — rebuild it, never edit it.

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { diffSnapshots } from './lib/changes.mjs';
import { readEnvFile } from './lib/env.mjs';
import { log, logWarn, logError, parseArgs, readJson } from './lib/io.mjs';
import { describeUrl, psql } from './lib/psql.mjs';
import { absoluteImage, familyOgImage, finishFamilyOg, prepareFamilyOg } from './lib/og-family.mjs';
import { fmtCount, weeklyOgModel } from './lib/page-og.mjs';
import {
    WEEKLY_TABLE_PROBE, buildWeek, dataAsOf, parseTableProbe, renderWeekPage, renderWeeklyIndex,
    summariseSnapshot, weekHeadlines, weekLabel, weekRange, weeklyDbSql, weeksBetween
} from './lib/weekly.mjs';

const HERE = import.meta.dirname;
const REPO_ROOT = join(HERE, '..');
const HISTORY_DIR = join(HERE, 'data', 'history');
const DEFAULT_OUT_DIR = 'weekly';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_FILE_RE = /^\d{4}-W\d{2}\.html$/;

/** Cache-busting stamp on ../templates.css and ../weekly.css. Bump when either changes. */
const ASSET_VERSION = '20260924d';

function usage() {
    console.log(`build-weekly.mjs — "This week in tokenized stocks", one static page per ISO week

USAGE
  node stocks/build-weekly.mjs --run [options]

OPTIONS
  --run               Actually build. Without it this help is printed and nothing runs.
  --base-url=<origin> og:url and the canonical link, e.g. https://rwasonar.com. Omitted, both are
                      left out rather than guessed.
  --out-dir=<dir>     Output directory (default ${DEFAULT_OUT_DIR}/, relative to the repo root).
  --no-db             Do not read DATABASE_URL even when it is set (the database parts show as not read).
  --no-og-images      Keep the site preview image on every week page.
  --help              This text.

INPUTS
  stocks/data/history/<date>/tokens.json + issuers.json   daily snapshots (numbers, status moves)
  stocks-tokens.json      firstSeenAt of every token (new tokens), card slugs
  stocks-issuers.json     discrepancies (observedAt), redemption.observationFeed, issuer names
  stocks-change-journal.json   issuer, venue, protocol and catalogue changes
  stocks-trades.json      only its generatedAt (the trade counts come from the database)
  protocols/index.json    exact-token protocol dossiers to link, when built
  DATABASE_URL (.env)     sonar.change_judgment material verdicts (model assessment),
                          sonar.change_event counts, sonar.stock_trade weekly counts

OUTPUT
  <out-dir>/<YYYY-Www>.html  one per ISO week from the first snapshot's week to the newest input's
  <out-dir>/index.html       every week, newest first
  <out-dir>/latest.html      byte copy of the newest week page
  <out-dir>/index.json       [{id, start, end, inProgress, asOf}] per week (the sitemap reads it)
  <out-dir>/og/<id>.<hash>.png  each week's 1200×630 preview (npm ci --prefix stocks/og), re-rendered on change

  The build instant is the newest timestamp among the inputs, never the clock: the same inputs
  (files and database rows up to that instant) produce byte-identical pages.`);
}

async function snapshotDates() {
    const entries = await readdir(HISTORY_DIR, { withFileTypes: true }).catch((err) => {
        if (err.code === 'ENOENT') return [];
        throw err;
    });
    return entries.filter((entry) => entry.isDirectory() && DATE_RE.test(entry.name)).map((entry) => entry.name).sort();
}

/** Every day that has a token snapshot, summarised, plus the diffs of consecutive such days. */
async function readSnapshots() {
    const snapshots = [];
    const raw = [];
    for (const date of await snapshotDates()) {
        const tokens = await readJson(join(HISTORY_DIR, date, 'tokens.json'), null);
        if (tokens === null) continue; // a DeFi-only day
        const issuers = await readJson(join(HISTORY_DIR, date, 'issuers.json'), null);
        snapshots.push(summariseSnapshot(tokens, issuers));
        raw.push(tokens);
    }
    const diffs = [];
    for (let i = 1; i < raw.length; i += 1) diffs.push(diffSnapshots(raw[i - 1], raw[i]));
    return { snapshots, diffs };
}

/** `{material, events, trades}` from the database, or all null with the reason logged. */
async function readDatabase({ since, asOf, skip }) {
    const none = { material: null, events: null, trades: null, readAt: null };
    if (skip) {
        logWarn('--no-db: material changes, watcher events and trade counts are shown as not read');
        return none;
    }
    const env = { ...(await readEnvFile(join(REPO_ROOT, '.env'))), ...process.env };
    if (!env.DATABASE_URL) {
        logWarn('no DATABASE_URL: material changes, watcher events and trade counts are shown as not read');
        return none;
    }
    const tables = parseTableProbe(await psql(env.DATABASE_URL, WEEKLY_TABLE_PROBE, 'weekly table probe', ['-t', '-A']));
    log(`database ${describeUrl(env.DATABASE_URL)}: change_judgment ${tables.judgment ? 'present' : 'ABSENT'}, `
        + `change_event ${tables.event ? 'present' : 'ABSENT'}, stock_trade ${tables.trade ? 'present' : 'ABSENT'}`);
    const out = JSON.parse((await psql(env.DATABASE_URL, weeklyDbSql({ since, asOf, tables }), 'weekly read', ['-t', '-A'])).trim());
    return { ...out, readAt: asOf };
}

/** Removes week pages from an earlier run that the current week list no longer contains. */
async function pruneStale(outDir, keep) {
    let removed = 0;
    for (const name of await readdir(outDir)) {
        if (!WEEK_FILE_RE.test(name) || keep.has(name)) continue;
        await rm(join(outDir, name));
        removed += 1;
    }
    return removed;
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }
    const baseUrl = typeof flags['base-url'] === 'string' ? flags['base-url'] : null;
    if (baseUrl === null) logWarn('no --base-url: og:url and the canonical link are omitted');
    const outDir = resolve(REPO_ROOT, typeof flags['out-dir'] === 'string' ? flags['out-dir'] : DEFAULT_OUT_DIR);

    const tokenDb = await readJson(join(REPO_ROOT, 'stocks-tokens.json'));
    if (!Array.isArray(tokenDb?.tokens)) throw new Error('stocks-tokens.json: expected {tokens:[...]}');
    const issuerDb = await readJson(join(REPO_ROOT, 'stocks-issuers.json'));
    if (!Array.isArray(issuerDb?.issuers)) throw new Error('stocks-issuers.json: expected {issuers:[...]}');
    const journal = await readJson(join(REPO_ROOT, 'stocks-change-journal.json'), { generatedAt: null, items: [] });
    const trades = await readJson(join(REPO_ROOT, 'stocks-trades.json'), { generatedAt: null });
    const protocolIndex = await readJson(join(REPO_ROOT, 'protocols', 'index.json'), []);
    const { snapshots, diffs } = await readSnapshots();
    if (snapshots.length === 0) throw new Error(`no daily snapshot under ${HISTORY_DIR}: there is no first week to build`);

    const redemptionScans = issuerDb.issuers.map((issuer) => issuer?.redemption?.observationFeed?.lastScanAt ?? null);
    const asOf = dataAsOf([
        tokenDb.builtAt, issuerDb.builtAt, journal.generatedAt, trades.generatedAt,
        ...snapshots.map((snap) => snap.builtAt), ...redemptionScans
    ]);
    if (asOf === null) throw new Error('no input carries a usable timestamp: cannot tell which week is in progress');
    const recordsBeginOn = snapshots[0].date;
    const weeks = weeksBetween(recordsBeginOn, asOf);
    const db = await readDatabase({ since: weeks[0].start, asOf, skip: flags['no-db'] === true });

    const newestScan = dataAsOf(redemptionScans);
    const sources = {
        'Daily snapshots': snapshots.at(-1).builtAt,
        'Tokens (stocks-tokens.json)': tokenDb.builtAt ?? null,
        'Issuers (stocks-issuers.json)': issuerDb.builtAt ?? null,
        'Change journal': journal.generatedAt ?? null,
        'Redemption scans (newest)': newestScan,
        'Model assessments, watcher events, trades (database)': db.readAt
    };
    const protocolPages = {};
    for (const entry of Array.isArray(protocolIndex) ? protocolIndex : []) {
        if (typeof entry?.mint !== 'string' || typeof entry?.protocol !== 'string' || typeof entry?.slug !== 'string') continue;
        const key = `${entry.mint}|${entry.protocol.toLowerCase()}`;
        if (!(key in protocolPages)) protocolPages[key] = entry.slug;
    }
    const slugs = Object.fromEntries(tokenDb.tokens.filter((token) => token?.mint && token?.cardSlug).map((token) => [token.mint, token.cardSlug]));
    const inputs = {
        snapshots, diffs, tokens: tokenDb.tokens, issuers: issuerDb.issuers, journal: journal.items ?? [],
        material: db.material, events: db.events, trades: db.trades, sources, recordsBeginOn, slugs, protocolPages
    };

    const digests = weeks.map((week, index) => buildWeek(week, weeks[index - 1] ?? null, asOf, inputs));
    await mkdir(outDir, { recursive: true });
    const origin = typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim().replace(/\/+$/, '') : null;
    const og = await prepareFamilyOg({ outDir, urlPrefix: 'weekly', label: 'weekly', enabled: flags['no-og-images'] !== true && origin !== null });
    const weekImage = async (digest) => absoluteImage(origin, await familyOgImage(og, digest.week.id, weeklyOgModel({
        id: digest.week.id,
        label: weekLabel(digest.week).replace(/^w/, 'W'),
        range: weekRange(digest.week),
        inProgress: digest.inProgress,
        stats: [
            { value: fmtCount(digest.numbers.tokens.value), label: 'tokens tracked' },
            { value: fmtCount(digest.journal.length), label: 'issuer, venue or protocol changes' },
            { value: digest.material === null ? null : fmtCount(digest.material.length), label: 'material changes (model assessment)' },
            { value: fmtCount(digest.newTokens.reduce((sum, row) => sum + (row?.count ?? 0), 0)), label: 'tokens first catalogued' },
            { value: fmtCount(digest.discrepancies.length), label: 'new claim ≠ reality discrepancies' }
        ]
    })));
    const keep = new Set();
    let latestHtml = '';
    let latestImage = null;
    for (const [index, digest] of digests.entries()) {
        latestImage = await weekImage(digest);
        const html = renderWeekPage(digest, { baseUrl, version: ASSET_VERSION, hasNext: index < digests.length - 1, ogImage: latestImage });
        const name = `${digest.week.id}.html`;
        await writeFile(join(outDir, name), html, 'utf8');
        keep.add(name);
        latestHtml = html;
        log(`${digest.week.id}${digest.inProgress ? ' (in progress)' : ''}: `
            + weekHeadlines(digest).map((line) => line.text).join(' · '));
    }
    await writeFile(join(outDir, 'latest.html'), latestHtml, 'utf8');
    // The index shares the newest week's picture: its headline numbers are that week's.
    await writeFile(join(outDir, 'index.html'), renderWeeklyIndex(digests, { baseUrl, version: ASSET_VERSION, ogImage: latestImage }), 'utf8');
    await writeFile(join(outDir, 'index.json'), `${JSON.stringify(digests.map((digest) => ({
        id: digest.week.id, start: digest.week.start, end: digest.week.end, inProgress: digest.inProgress, asOf: digest.asOf
    })))}\n`, 'utf8');
    await finishFamilyOg(og);
    const pruned = await pruneStale(outDir, keep);
    log(`wrote ${digests.length} week page(s), index.html and latest.html to ${outDir} as of ${asOf}`
        + `${pruned ? ` (pruned ${pruned} stale page(s))` : ''}`);
    return 0;
}

if (import.meta.filename === process.argv[1]) {
    main().then((code) => process.exit(code), (err) => {
        logError(err.stack ?? String(err));
        process.exit(1);
    });
}
