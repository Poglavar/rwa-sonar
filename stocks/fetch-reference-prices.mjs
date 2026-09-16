#!/usr/bin/env node
// Attaches a reference price for the UNDERLYING listed instrument to every token in
// data/universe.json, and with it the premium/discount the Solana token trades at. Sources are
// tried in descending order of independence — Pyth Hermes oracle, then Ondo's implied underlying
// price, then the issuer's own mark for private companies — and the one actually used is recorded
// per token, so a premium computed against a sponsor's self-published mark is never mistaken for
// one measured against an oracle. Writes stocks/data/reference-prices.json.

import { join } from 'node:path';
import { readEnvFile } from './lib/env.mjs';
import { byString, fetchJson, isoDate, log, logError, logWarn, parseArgs, readJson, sleep, ts, writeJson } from './lib/io.mjs';
import { ageSeconds, decodePythPrice, feedSummary, findFeedForTicker, indexFeedsBySymbol, premiumPct } from './lib/pyth.mjs';

const HERE = import.meta.dirname;
const ENV_PATH = join(HERE, '..', '.env');
const UNIVERSE_PATH = join(HERE, 'data', 'universe.json');
const SPONSORS_PATH = join(HERE, 'data', 'sponsor-apis.json');
const DEFAULT_OUT = join(HERE, 'data', 'reference-prices.json');
const RAW_DIR = join(HERE, 'data', 'raw');

// The feed list is public; the price endpoints need a key AND a per-feed grant on that key.
const FEEDS_URL = 'https://hermes.pyth.network/v2/price_feeds?asset_type=equity';
const LATEST_URL = 'https://hermes.pyth.network/v2/updates/price/latest';

const BATCH_SIZE = 50;
const BATCH_PACE_MS = 300;
const PROBE_PACE_MS = 250;
const BACKOFF_MS = [1000, 2000, 4000];

// Issuers whose token symbol IS the listed ticker. They carry no Jupiter issuer tag, so
// lib/classify.mjs leaves underlyingTicker null for them and the symbol is the only handle.
const SYMBOL_IS_TICKER_ISSUERS = ['superstate-opening-bell', 'securitize', 'bullish'];

// Leveraged issuers. A 2x/3x token cannot be compared to the spot price of its underlying at all:
// its NAV is a path-dependent function of that price, so any "premium" against spot is meaningless.
const LEVERAGED_ISSUERS = ['shift'];
const LEVERAGED_NOTE = 'leveraged; no 1:1 reference';

function usage() {
    console.log(`fetch-reference-prices.mjs — reference price + premium per tokenized stock

USAGE
  node stocks/fetch-reference-prices.mjs --run [options]

OPTIONS
  --run                 Actually fetch. Without it this help is printed and nothing runs.
  --force               Re-probe every Pyth feed entitlement, ignoring today's cache.
  --no-pyth             Skip Pyth entirely and build from the sponsor sources only.
  --out=<path>          Output file (default stocks/data/reference-prices.json).
  --help                This text.

INPUTS
  stocks/data/universe.json     tokens, their underlyingTicker and Jupiter usdPrice
  stocks/data/sponsor-apis.json Ondo implied underlying prices, PreStocks/Tessera marks
  ../.env                       PYTH_API_KEY (optional; a missing key only disables Pyth)

OUTPUT
  One record per token. Alongside the reference price itself, a token whose ticker matched a Pyth
  feed carries that feed's \`schedule\` (the underlying market's trading hours, verbatim) and
  \`marketHours\` ({isOpen, nextOpen, nextClose}, unix seconds). Both come off the KEYLESS feed
  list, so they are filled in whether or not the key may read that feed's price, and are null only
  when no feed matched. build-afterhours.mjs buckets trades by session with them.

NOTES
  The Hermes key is entitled to a SUBSET of equity feeds and a batched request fails as a whole
  with HTTP 403 when any one id in it is unentitled, so every unique feed is probed once on its
  own first. That probe is checkpointed to stocks/data/raw/pyth-entitlement-<date>.json and
  reused for the rest of the day; only entitled ids are then batched (${BATCH_SIZE}/request).
  Prices themselves are never cached — they are the point of the run.`);
}

/**
 * The ticker to look a reference up by. universe.json is authoritative; the symbol fallback
 * covers the untagged issuers listed above. Returns null when there is no listed underlying
 * (PreStocks/Tessera private companies) or the issuer is unknown.
 */
function resolveTicker(item) {
    if (typeof item?.underlyingTicker === 'string' && item.underlyingTicker !== '') return item.underlyingTicker;
    if (SYMBOL_IS_TICKER_ISSUERS.includes(item?.issuer) && typeof item?.symbol === 'string' && item.symbol !== '') return item.symbol;
    return null;
}

/**
 * The underlying market's trading schedule, verbatim, off a matched feed — e.g.
 * `America/New_York;0930-1600,...;0907/C,...`. It rides on the KEYLESS feed list, so it is present
 * whether or not this key may read that feed's price, and lets build-afterhours.mjs place a trade
 * in an open or closed session without a Pyth key at all. Parsing lives in lib/market-hours.mjs.
 */
function scheduleOf(feed) {
    const schedule = feed?.attributes?.schedule;
    return typeof schedule === 'string' && schedule !== '' ? schedule : null;
}

/** The feed's own `market_hours`, unix seconds kept as numbers. A missing part stays null. */
function marketHoursOf(feed) {
    const hours = feed?.market_hours;
    if (!hours || typeof hours !== 'object') return null;
    const seconds = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
    return {
        isOpen: typeof hours.is_open === 'boolean' ? hours.is_open : null,
        nextOpen: seconds(hours.next_open),
        nextClose: seconds(hours.next_close)
    };
}

/** GET Hermes with the key, retrying only 429/5xx. Anything else is returned for the caller to judge. */
async function hermesGet(url, key, label) {
    for (let attempt = 0; ; attempt += 1) {
        const res = await fetchJson(url, { headers: { accept: 'application/json', Authorization: `Bearer ${key}` }, timeoutMs: 60000 });
        if (res.ok || !(res.status === 429 || res.status >= 500)) return res;
        if (attempt >= BACKOFF_MS.length) {
            throw new Error(`Hermes kept failing for ${label}: HTTP ${res.status} after ${BACKOFF_MS.length} retries :: ${res.bodyPreview}`);
        }
        const wait = BACKOFF_MS[attempt];
        logWarn(`${label}: HTTP ${res.status}, retrying in ${wait} ms`);
        await sleep(wait);
    }
}

function latestUrl(ids) {
    return `${LATEST_URL}?${ids.map((id) => `ids[]=${encodeURIComponent(id)}`).join('&')}`;
}

/** The feed id Hermes names in a "Not entitled: feed <hex>" body, or null. */
function notEntitledFeedId(bodyPreview) {
    return /feed ([0-9a-f]{64})/i.exec(String(bodyPreview))?.[1]?.toLowerCase() ?? null;
}

async function fetchFeedList() {
    const fetchedAt = ts();
    log(`pyth: GET ${FEEDS_URL}`);
    const res = await fetchJson(FEEDS_URL, { headers: { accept: 'application/json' }, timeoutMs: 120000 });
    if (!res.ok) throw new Error(`Pyth feed list failed: HTTP ${res.status} :: ${res.bodyPreview}`);
    if (!Array.isArray(res.json)) throw new Error(`Pyth feed list: expected an array, got ${typeof res.json} :: ${res.bodyPreview}`);
    const rawFile = `pyth-feeds-${isoDate()}.json`;
    await writeJson(join(RAW_DIR, rawFile), { fetchedAt, url: FEEDS_URL, status: res.status, count: res.json.length, body: res.json });
    log(`pyth: ${res.json.length} equity feeds, ${res.bytes} bytes, raw saved to ${rawFile}`);
    return { feeds: res.json, fetchedAt, rawFile };
}

/**
 * One request per feed id to find out which ones this key may read. Checkpointed after every
 * probe so a killed run resumes; "ok"/"not-entitled" are final, "error" is retried next run.
 */
async function probeEntitlements(feedIds, key, { force }) {
    const cachePath = join(RAW_DIR, `pyth-entitlement-${isoDate()}.json`);
    const cached = force ? {} : (await readJson(cachePath, { entitlement: {} })).entitlement ?? {};
    const entitlement = {};
    for (const [id, state] of Object.entries(cached)) {
        if (state === 'ok' || state === 'not-entitled') entitlement[id] = state;
    }

    const todo = feedIds.filter((id) => entitlement[id] === undefined);
    const reused = feedIds.length - todo.length;
    if (reused > 0) log(`pyth: reusing ${reused} cached entitlement result(s) from ${cachePath}`);
    if (todo.length === 0) return { entitlement, cachePath };

    log(`pyth: probing ${todo.length} feed(s) one at a time (${PROBE_PACE_MS} ms apart, ~${Math.ceil(todo.length * PROBE_PACE_MS / 1000)} s)`);
    const startedMs = Date.now();
    for (let i = 0; i < todo.length; i += 1) {
        const id = todo[i];
        // A per-feed failure is recorded and retried next run; a rejected KEY is fatal, because
        // every remaining probe would fail the same way and 244 of them would say nothing new.
        let res = null;
        try {
            res = await hermesGet(latestUrl([id]), key, `entitlement probe ${id.slice(0, 8)}`);
        } catch (err) {
            entitlement[id] = 'error';
            logWarn(`entitlement probe ${id.slice(0, 8)}: ${err.name}: ${err.message}`);
        }
        if (res !== null) {
            if (res.ok) entitlement[id] = 'ok';
            else if (res.status === 403) entitlement[id] = 'not-entitled';
            else if (res.status === 401) throw new Error(`Hermes rejected PYTH_API_KEY with HTTP 401 — fix or remove the key :: ${res.bodyPreview}`);
            else {
                entitlement[id] = 'error';
                logWarn(`entitlement probe ${id.slice(0, 8)}: unexpected HTTP ${res.status} :: ${res.bodyPreview}`);
            }
        }
        const done = i + 1;
        if (done % 25 === 0 || done === todo.length) {
            const perItem = (Date.now() - startedMs) / done;
            const etaSec = Math.round(perItem * (todo.length - done) / 1000);
            const ok = Object.values(entitlement).filter((s) => s === 'ok').length;
            log(`pyth: probed ${done}/${todo.length} · ${ok} entitled so far · ETA ${etaSec}s`);
            await writeJson(cachePath, { fetchedAt: ts(), note: 'per-feed Hermes entitlement for the key in ../.env; "error" entries are re-probed on the next run', entitlement });
        }
        await sleep(PROBE_PACE_MS);
    }
    await writeJson(cachePath, { fetchedAt: ts(), note: 'per-feed Hermes entitlement for the key in ../.env; "error" entries are re-probed on the next run', entitlement });
    return { entitlement, cachePath };
}

/**
 * Batched latest prices for ids already known to be entitled. A 403 still rejects the WHOLE batch
 * if one grant has lapsed since the probe, so the named feed is demoted and the batch retried
 * rather than losing the other 49 prices.
 */
async function fetchLatestPrices(entitledIds, key, entitlement) {
    const parsedById = new Map();
    const rawBatches = [];
    const batches = [];
    for (let i = 0; i < entitledIds.length; i += BATCH_SIZE) batches.push(entitledIds.slice(i, i + BATCH_SIZE));

    for (let b = 0; b < batches.length; b += 1) {
        let remaining = batches[b];
        while (remaining.length > 0) {
            const label = `price batch ${b + 1}/${batches.length} (${remaining.length} ids)`;
            const res = await hermesGet(latestUrl(remaining), key, label);
            if (res.ok) {
                if (!Array.isArray(res.json?.parsed)) throw new Error(`${label}: expected {parsed:[...]}, got ${res.bodyPreview}`);
                for (const entry of res.json.parsed) {
                    if (typeof entry?.id === 'string') parsedById.set(entry.id.toLowerCase(), entry);
                }
                rawBatches.push({ fetchedAt: ts(), ids: remaining, parsed: res.json.parsed });
                const missing = remaining.filter((id) => !parsedById.has(id));
                log(`pyth: ${label} → ${res.json.parsed.length} price(s)${missing.length ? `, ${missing.length} id(s) absent from the response` : ''}`);
                break;
            }
            if (res.status === 403) {
                const bad = notEntitledFeedId(res.bodyPreview);
                if (bad === null || !remaining.includes(bad)) {
                    throw new Error(`${label}: HTTP 403 naming no feed from this batch :: ${res.bodyPreview}`);
                }
                logWarn(`${label}: feed ${bad} is no longer entitled; dropping it and retrying the rest`);
                entitlement[bad] = 'not-entitled';
                remaining = remaining.filter((id) => id !== bad);
                continue;
            }
            throw new Error(`${label}: HTTP ${res.status} :: ${res.bodyPreview}`);
        }
        if (b < batches.length - 1) await sleep(BATCH_PACE_MS);
    }
    return { parsedById, rawBatches };
}

function emptyRef() {
    return { refSource: null, refPrice: null, refConf: null, refPublishTime: null, refAgeSeconds: null, note: null };
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }
    const outPath = typeof flags.out === 'string' ? flags.out : DEFAULT_OUT;

    const universe = await readJson(UNIVERSE_PATH);
    if (!Array.isArray(universe?.items)) throw new Error(`${UNIVERSE_PATH}: expected {items:[...]}`);
    const sponsors = await readJson(SPONSORS_PATH);
    if (!sponsors?.items) throw new Error(`${SPONSORS_PATH}: expected {items:{...}}`);
    log(`read ${universe.items.length} token(s) from universe.json (fetched ${universe.fetchedAt})`);

    // Sponsor lookups: Ondo publishes an implied price per listed ticker, PreStocks and Tessera a
    // mark per mint. Tessera's API symbol is not the on-chain one, so mint is the only safe join.
    const ondoByTicker = new Map();
    for (const asset of sponsors.items.ondo ?? []) {
        if (typeof asset?.ticker === 'string' && asset.ticker !== '' && !ondoByTicker.has(asset.ticker)) ondoByTicker.set(asset.ticker, asset);
    }
    const markByMint = new Map();
    for (const id of ['prestocks', 'tessera']) {
        for (const entry of sponsors.items[id] ?? []) {
            if (typeof entry?.mint === 'string' && entry.mint !== '' && !markByMint.has(entry.mint)) markByMint.set(entry.mint, { ...entry, sponsor: id });
        }
    }
    log(`sponsor references: ${ondoByTicker.size} Ondo ticker(s), ${markByMint.size} issuer mark(s) by mint`);

    const env = await readEnvFile(ENV_PATH);
    const key = typeof env.PYTH_API_KEY === 'string' && env.PYTH_API_KEY !== '' ? env.PYTH_API_KEY : null;
    const usePyth = !flags['no-pyth'];
    if (key === null) logWarn(`no PYTH_API_KEY in ${ENV_PATH} — skipping Pyth prices; every token falls back to a sponsor reference or none`);
    if (!usePyth) logWarn('--no-pyth: skipping Pyth entirely, building from the sponsor sources only');

    // The feed list is public, so it is worth having even without a key: it still says which
    // tickers Pyth covers at all, and whether their market was open.
    let feedIndex = new Map();
    let pythFeedsFetchedAt = null;
    let feedsRawFile = null;
    let equityFeedCount = 0;
    if (usePyth) {
        const list = await fetchFeedList();
        feedIndex = indexFeedsBySymbol(list.feeds);
        pythFeedsFetchedAt = list.fetchedAt;
        feedsRawFile = list.rawFile;
        equityFeedCount = list.feeds.length;
    }

    // Resolve every token's ticker and feed once, so the network work is per unique feed.
    const resolved = universe.items.map((item) => {
        const leveraged = LEVERAGED_ISSUERS.includes(item.issuer);
        const ticker = leveraged ? null : resolveTicker(item);
        const feed = ticker === null ? null : findFeedForTicker(feedIndex, ticker);
        return {
            item,
            leveraged,
            ticker,
            feed: feed === null ? null : feedSummary(feed),
            schedule: scheduleOf(feed),
            marketHours: marketHoursOf(feed)
        };
    });

    const unmatchedTickers = [...new Set(resolved.filter((r) => r.ticker !== null && r.feed === null).map((r) => r.ticker))].sort(byString);
    const feedIds = [...new Set(resolved.filter((r) => r.feed?.feedId).map((r) => r.feed.feedId))].sort(byString);
    log(`tickers: ${new Set(resolved.filter((r) => r.ticker !== null).map((r) => r.ticker)).size} unique, ${feedIds.length} matched a Pyth feed, ${unmatchedTickers.length} unmatched`);

    let entitlement = {};
    let entitlementCachePath = null;
    let parsedById = new Map();
    if (usePyth && key !== null && feedIds.length > 0) {
        const probe = await probeEntitlements(feedIds, key, { force: Boolean(flags.force) });
        entitlement = probe.entitlement;
        entitlementCachePath = probe.cachePath;
        const entitledIds = feedIds.filter((id) => entitlement[id] === 'ok');
        log(`pyth: ${entitledIds.length}/${feedIds.length} feed(s) entitled, ${feedIds.filter((id) => entitlement[id] === 'not-entitled').length} not entitled, ${feedIds.filter((id) => entitlement[id] === 'error').length} probe error(s)`);
        if (entitledIds.length > 0) {
            const prices = await fetchLatestPrices(entitledIds, key, entitlement);
            parsedById = prices.parsedById;
            const rawFile = `pyth-latest-${isoDate()}.json`;
            await writeJson(join(RAW_DIR, rawFile), { fetchedAt: ts(), url: LATEST_URL, batches: prices.rawBatches });
            log(`pyth: ${parsedById.size} price(s) decoded, raw saved to ${rawFile}`);
        }
        // The probe may have demoted a feed mid-batch, so persist the final view.
        await writeJson(entitlementCachePath, { fetchedAt: ts(), note: 'per-feed Hermes entitlement for the key in ../.env; "error" entries are re-probed on the next run', entitlement });
    }

    const nowMs = Date.now();
    const items = resolved.map(({ item, leveraged, ticker, feed, schedule, marketHours }) => {
        const jupiterPrice = Number.isFinite(item.usdPrice) ? item.usdPrice : null;
        const feedId = feed?.feedId ?? null;
        const entitledState = feedId === null ? null : entitlement[feedId] ?? null;
        const record = {
            mint: item.mint,
            symbol: item.symbol ?? null,
            issuer: item.issuer ?? null,
            underlyingTicker: ticker,
            jupiterPrice,
            pythFeedId: feedId,
            pythEntitled: entitledState === null ? null : entitledState === 'ok',
            marketOpen: feed?.marketOpen ?? null,
            schedule,
            marketHours,
            ...emptyRef(),
            premiumPct: null
        };

        // A 2x/3x token has no 1:1 reference at all; comparing it to spot would invent a premium.
        if (leveraged) {
            record.note = LEVERAGED_NOTE;
            return record;
        }

        const parsed = feedId === null ? null : parsedById.get(feedId) ?? null;
        if (parsed !== null) {
            const decoded = decodePythPrice(parsed.price);
            if (decoded.price !== null && decoded.price > 0) {
                record.refSource = 'pyth';
                record.refPrice = decoded.price;
                record.refConf = decoded.conf;
                record.refPublishTime = decoded.publishTime;
                record.refAgeSeconds = ageSeconds(decoded.publishTime, nowMs);
                record.premiumPct = premiumPct(jupiterPrice, decoded.price);
                return record;
            }
            logWarn(`${item.symbol}: Pyth returned an unusable price for ${ticker} (${JSON.stringify(parsed.price)})`);
        }

        const ondo = ticker === null ? null : ondoByTicker.get(ticker) ?? null;
        if (ondo !== null && Number.isFinite(ondo.impliedUnderlyingPrice) && ondo.impliedUnderlyingPrice > 0) {
            record.refSource = 'ondo-implied';
            record.refPrice = ondo.impliedUnderlyingPrice;
            record.premiumPct = premiumPct(jupiterPrice, ondo.impliedUnderlyingPrice);
            record.note = 'marketCap / sharesOutstanding from the Ondo asset registry; no publish time in that payload';
            return record;
        }

        const mark = markByMint.get(item.mint) ?? null;
        if (mark !== null && Number.isFinite(mark.markPrice) && mark.markPrice > 0) {
            record.refSource = 'issuer-mark';
            record.refPrice = mark.markPrice;
            record.premiumPct = premiumPct(jupiterPrice, mark.markPrice);
            record.note = `${mark.sponsor} mark price, self-published by the issuer; no publish time in that payload`;
            return record;
        }

        return record;
    }).sort((a, b) => byString(String(a.mint), String(b.mint)));

    const counts = {
        pyth: items.filter((i) => i.refSource === 'pyth').length,
        ondoImplied: items.filter((i) => i.refSource === 'ondo-implied').length,
        issuerMark: items.filter((i) => i.refSource === 'issuer-mark').length,
        none: items.filter((i) => i.refSource === null).length
    };
    const probeErrors = feedIds.filter((id) => entitlement[id] === 'error');
    const entitledTickers = [...new Set(resolved.filter((r) => r.feed?.feedId && entitlement[r.feed.feedId] === 'ok').map((r) => r.ticker))].sort(byString);

    await writeJson(outPath, {
        fetchedAt: ts(),
        source: {
            note: 'refSource names which reference a premium was measured against; a sponsor mark is the issuer\'s own number and is not an independent price',
            pythFeedsFetchedAt,
            pythKeyPresent: key !== null,
            counts,
            hermes: {
                feedsUrl: FEEDS_URL,
                latestUrl: LATEST_URL,
                equityFeedCount,
                feedsProbed: feedIds.length,
                feedsEntitled: feedIds.filter((id) => entitlement[id] === 'ok').length,
                feedsNotEntitled: feedIds.filter((id) => entitlement[id] === 'not-entitled').length,
                feedsProbeError: probeErrors.length,
                entitledTickers,
                unmatchedTickers,
                rawFiles: [feedsRawFile].filter(Boolean)
            },
            inputs: {
                universeFetchedAt: universe.fetchedAt ?? null,
                universeCount: universe.items.length,
                sponsorApisFetchedAt: sponsors.fetchedAt ?? null
            }
        },
        items
    });
    log(`wrote ${outPath}: ${items.length} item(s) — pyth ${counts.pyth}, ondo-implied ${counts.ondoImplied}, issuer-mark ${counts.issuerMark}, none ${counts.none}`);

    if (probeErrors.length > 0) {
        logError(`${probeErrors.length} feed(s) failed to probe and will be retried next run: ${probeErrors.map((id) => id.slice(0, 8)).join(', ')}`);
        return 1;
    }
    return 0;
}

main().then((code) => process.exit(code), (err) => {
    logError(err.stack ?? String(err));
    process.exit(1);
});
