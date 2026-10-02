#!/usr/bin/env node
// Builds stocks-flows.json for flows.html: daily creation/redemption flows per issuer on Solana
// (from the redemption observer's rolling file, stocks/observe-redemptions.mjs) and the xStocks
// public float (from stocks/fetch-xstocks-float.mjs). Reads files only — no network — and all the
// shaping lives in stocks/lib/flows.mjs. A missing input is published as null with the reason,
// never as zeros, so the page can say what is missing.

import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

import { FLOW_DAYS, buildFloat, buildFlows, dayWindow, makePriceFor } from './lib/flows.mjs';
import { log, logWarn, parseArgs, readJson, ts, writeJson } from './lib/io.mjs';

const HERE = import.meta.dirname;
const REPO = join(HERE, '..');
const DEFAULTS = {
    observations: join(HERE, 'data', 'redemption-observations.json'),
    float: join(HERE, 'data', 'xstocks-float.json'),
    tokens: join(REPO, 'stocks-tokens.json'),
    history: join(HERE, 'data', 'history'),
    sponsors: join(HERE, 'data', 'sponsor-apis.json'),
    out: join(REPO, 'stocks-flows.json')
};

const CAVEATS = [
    'Who redeems and creates: the primary market is open only to onboarded, whitelisted (KYC) wallets, so these flows are almost entirely authorised participants and market makers arbitraging the token against the share, not end holders. On xStocks one wallet made most observed deposits and also receives issuance.',
    'A day counts only over the hours the observer actually read. A day it did not read is shown as missing, never as zero; a partly read day shows its covered hours.',
    'The observer runs once a day and began recording amounts later than counts: before that point a day carries transaction counts but no amounts.',
    'Dollar values: the stablecoin paid or received in the same transaction where there is one (Ondo), otherwise the independent DEX trade tape at the event time, otherwise that day\'s snapshot price. A day with units nothing priced shows its priced part as a lower bound.',
    'xStocks creations and Superstate conversions into tokens are not collected, so their net flow is not computed. The xStocks public float below shows the net effect instead.'
];

function usage() {
    console.log(`build-flows.mjs — stocks-flows.json for flows.html (creation/redemption flows + xStocks public float)

USAGE
  node stocks/build-flows.mjs --run [options]

OPTIONS
  --run                 Build. Without it this help is printed and nothing runs.
  --observations=<f>    Redemption observer state (default ${relative(REPO, DEFAULTS.observations)}).
  --float=<f>           xStocks float read (default ${relative(REPO, DEFAULTS.float)}).
  --tokens=<f>          Catalogue (default ${relative(REPO, DEFAULTS.tokens)}).
  --history=<dir>       Daily snapshots for the day's price (default ${relative(REPO, DEFAULTS.history)}).
  --sponsors=<f>        Sponsor API cache, for the xStocks proof-of-reserves cross-check (default ${relative(REPO, DEFAULTS.sponsors)}).
  --days=<n>            Days in the flow window (default ${FLOW_DAYS}).
  --out=<f>             Output (default ${relative(REPO, DEFAULTS.out)}).
  --help                This text.`);
}

async function loadSnapshots(dir, days) {
    const out = new Map();
    for (const day of days) {
        const file = join(dir, day, 'tokens.json');
        if (!existsSync(file)) continue;
        const snap = await readJson(file);
        out.set(day, new Map((snap.items ?? []).map((i) => [i.mint, { marketValueUsd: i.marketValueUsd ?? null, supplyRaw: i.supplyRaw ?? null }])));
    }
    return out;
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) { usage(); return; }
    const path = (key) => (typeof flags[key] === 'string' ? flags[key] : DEFAULTS[key]);
    const days = Number(flags.days ?? FLOW_DAYS);
    if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('--days must be an integer 1–30 (the observer keeps 30 days)');
    const now = ts();

    const catalogue = await readJson(path('tokens'));
    const tokensByMint = new Map(catalogue.tokens.map((t) => [t.mint, t]));
    const priceObservedAt = catalogue.sources?.universe?.fetchedAt ?? null;
    const window = dayWindow(now, days);
    const snapshots = await loadSnapshots(path('history'), window);
    const priceFor = makePriceFor({ snapshots, tokensByMint, catalogueDay: priceObservedAt ? priceObservedAt.slice(0, 10) : null });
    const symbolOf = (mint) => tokensByMint.get(mint)?.symbol ?? null;

    const observations = await readJson(path('observations'), null);
    if (!observations) logWarn(`no ${relative(REPO, path('observations'))} — flows published as null (run node stocks/observe-redemptions.mjs --run)`);
    const flows = observations ? buildFlows(observations, { now, days, priceFor, symbolOf }) : null;

    const floatFile = await readJson(path('float'), null);
    if (!floatFile) logWarn(`no ${relative(REPO, path('float'))} — public float published as null (run node stocks/fetch-xstocks-float.mjs --run)`);
    const sponsors = await readJson(path('sponsors'), null);
    const porItems = sponsors?.items?.xstocksPor;
    const por = new Map((Array.isArray(porItems) ? porItems : []).map((p) => [p.symbol, p]));
    const float = buildFloat(floatFile, { tokensByMint, por, porFetchedAt: sponsors?.source?.sources?.xstocksPor?.fetchedAt ?? null, priceObservedAt });

    const out = {
        builtAt: now,
        sources: {
            observations: { file: 'stocks/data/redemption-observations.json', generatedAt: observations?.generatedAt ?? null },
            float: { file: 'stocks/data/xstocks-float.json', readAt: floatFile?.readAt ?? null },
            prices: { catalogue: 'stocks-tokens.json', observedAt: priceObservedAt, snapshotDays: [...snapshots.keys()] }
        },
        caveats: CAVEATS,
        flows,
        float
    };
    await writeJson(path('out'), out);
    const covered = (flows?.issuers ?? []).map((i) => `${i.slug} ${i.days.filter((d) => (d.redeemed?.coveredHours ?? 0) > 0).length}d`).join(', ');
    log(`build-flows: flows ${flows ? covered : 'null'} · float ${float ? `${float.pricedMints}/${float.mints} priced, read ${float.readAt}` : 'null'} · snapshots ${snapshots.size}/${window.length} day(s) · wrote ${relative(REPO, path('out'))}`);
}

main().catch((err) => {
    console.error(`[${ts()}] build-flows: FAILED — ${err.stack || err.message}`);
    process.exitCode = 1;
});
