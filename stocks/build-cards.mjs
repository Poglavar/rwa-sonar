#!/usr/bin/env node
// Builds cards/<slug>.html + cards/<slug>.json + cards/index.json: one static, shareable page per
// tokenized stock, rendered entirely at build time (readable with JavaScript off) from the seven
// built files. It calls evaluateHealth itself rather than reading stocks-health.json, because a card
// shows each rule's INPUTS and that thin file deliberately drops them.
// The whole cards/ directory is generated per refresh and gitignored — rebuild it, never edit it.

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
    CARD_BYTE_LIMIT, CARD_BYTE_TARGET, MATERIAL_CHANGE_DAYS, assignSlugs, buildCard, indexEntry, isRealChange, publicCard, renderCard
} from './lib/cards.mjs';
import { composabilityTemplateFor, indexComposabilityTemplates } from './lib/composability.mjs';
import { readEnvFile } from './lib/env.mjs';
import { psql } from './lib/psql.mjs';
import { dossierFileFor, readWhatIf } from './lib/issuer-whatif.mjs';
import { cardFloatItem } from './lib/xstocks-float.mjs';
import { byString, log, logError, logWarn, parseArgs, readJson, ts, writeJson } from './lib/io.mjs';
import {
    OG_SUBDIR, ensureOgDir, ensureOgImage, loadFonts, ogImageAlt, ogImageModel, pruneOgImages, renderOgSvg
} from './lib/og-image.mjs';
import { TRUST_CHAIN } from './lib/trustchain.mjs';
import { loadSchematics } from './lib/schematics-load.mjs';
import discrepancyView from './lib/discrepancy-view.js';
import activityRows from './lib/activity-rows.js';

const HERE = import.meta.dirname;
const REPO_ROOT = join(HERE, '..');
const TOKENS_PATH = join(REPO_ROOT, 'stocks-tokens.json');
const ISSUERS_PATH = join(REPO_ROOT, 'stocks-issuers.json');
const TRADES_PATH = join(REPO_ROOT, 'stocks-trades.json');
const CLOSED_MARKET_PATH = join(REPO_ROOT, 'stocks-closed-market.json');
const HOLDERS_PATH = join(HERE, 'data', 'holders.json');
const VENUES_PATH = join(HERE, 'data', 'venues.json');
const METEORA_PATH = join(HERE, 'data', 'meteora.json');
const COMPOSABILITY_PATH = join(HERE, 'data', 'composability-templates.json');
const DEFI_USAGE_PATH = join(HERE, 'data', 'defi-usage.json');
const MARKET_RESEARCH_PATH = join(HERE, 'data', 'protocol-market-research.json');
const ISSUER_DOSSIER_DIR = join(HERE, 'data', 'issuers');
const SOURCES_STATE_PATH = join(HERE, 'data', 'sources-state.json');
const REVIEW_QUEUE_PATH = join(REPO_ROOT, 'stocks-review-queue.json');
// Curated editorial decisions on watcher events: which changes are real (public, in the change
// journal) and which were false alarms or our own corrections. They decide what a card may show.
const EVENT_RESOLUTIONS_PATH = join(HERE, 'data', 'event-resolutions.json');
// The underlying's trading schedule per mint (Pyth feed list), so a card can say whether that
// market was open at the snapshot instant rather than repeat the feed's read-time flag.
const REFERENCE_PRICES_PATH = join(HERE, 'data', 'reference-prices.json');
// Pyth prices read straight from Solana (stocks/fetch-pyth-onchain.mjs); gitignored, absent until it runs.
const PYTH_ONCHAIN_PATH = join(HERE, 'data', 'pyth-onchain.json');
const DEFAULT_OUT_DIR = 'cards';

/** Cache-busting stamp on ../card.css, ../trustchain.css and ../card.js. Bump when any of them changes. */
const ASSET_VERSION = '20260925fold';

function usage() {
    console.log(`build-cards.mjs — one static, shareable card per tokenized stock

USAGE
  node stocks/build-cards.mjs --run [options]

OPTIONS
  --run                     Actually build. Without it this help is printed and nothing runs.
  --base-url=<origin>       REQUIRED for og:url and the canonical link, e.g. https://rwasonar.com.
                            Omitted, both tags are left out — a builder has no request to derive an
                            origin from, and a guessed absolute URL is a dead link nobody sees fail.
  --out-dir=<dir>           Where the cards go (default ${DEFAULT_OUT_DIR}/, relative to the repo root).
  --no-og-images            Skip the per-token preview images; every card shares the site image.
  --help                    This text.

INPUTS
  stocks-tokens.json, stocks-issuers.json, stocks/data/holders.json, stocks/data/venues.json,
  stocks-trades.json, stocks-closed-market.json (When the market is closed), stocks/data/meteora.json,
  stocks/data/reference-prices.json (the underlying's trading schedule, for the session at build time),
  stocks/data/pyth-onchain.json (Pyth prices read from Solana for "Where prices come from"; absent: the
                            block lists the feeds and says the prices were not read),
  stocks/data/composability-templates.json, stocks/data/defi-usage.json,
  stocks/data/protocol-market-research.json (docs-vs-chain findings on decoded protocol markets),
  stocks/data/trust-chain.json, stocks/data/issuers/*.json (the what-if answers),
  stocks/data/sources-state.json (the archived copy behind each answer's source)
  sonar.change_judgment in DATABASE_URL (.env): the change judge's MATERIAL verdicts on change
                            events detected in the ${MATERIAL_CHANGE_DAYS} days before stocks-tokens.json builtAt.
                            No DATABASE_URL, or no judgment table there: every card omits the line.
                            Our own upkeep (a lost quote, an unreachable document) is dropped unless
                            stocks/data/event-resolutions.json or a 'confirmed' review_resolution says
                            it is a real change.

OUTPUT
  <out-dir>/<slug>.html   the card, everything readable rendered server-side
  <out-dir>/<slug>.json   the linked machine-readable record
  <out-dir>/index.json    [{slug, symbol, mint, issuer, status}] — what card.html resolves against
  <out-dir>/${OG_SUBDIR}/<slug>.<hash>.png  the card's 1200×630 og:image. Incremental: the hash covers
                          everything drawn plus the fonts, so an unchanged token is never re-rendered;
                          older hashes are pruned. Needs \`npm ci --prefix stocks/og\` (resvg); without
                          it the step warns and every card keeps the site image.

  The slug is the symbol when it is path-safe and unique case-insensitively, else the symbol plus
  the first 6 characters of the mint. Building twice from the same inputs produces byte-identical
  files apart from the one \`builtAt\` timestamp.`);
}

function indexBy(list, key) {
    const index = new Map();
    for (const row of Array.isArray(list) ? list : []) {
        const id = typeof row?.[key] === 'string' ? row[key] : null;
        if (id !== null && !index.has(id)) index.set(id, row);
    }
    return index;
}

function poolsByMint(pools) {
    const index = new Map();
    for (const pool of Array.isArray(pools) ? pools : []) {
        const mint = typeof pool?.mint === 'string' ? pool.mint : null;
        if (mint === null) continue;
        if (!index.has(mint)) index.set(mint, []);
        index.get(mint).push(pool);
    }
    return index;
}

/**
 * `{url: archiveUrl}` from the source registry's state file, so a what-if answer can offer the
 * archived copy beside the live link. Only sources that actually have an archived copy appear.
 */
function archiveIndex(state) {
    const index = Object.create(null);
    if (!state || typeof state !== 'object') return index;
    for (const [url, entry] of Object.entries(state)) {
        const archive = typeof entry?.archiveUrl === 'string' ? entry.archiveUrl.trim() : '';
        if (archive !== '') index[url] = archive;
    }
    return index;
}

/**
 * The product each multi-product issuer's dossier was researched on, by the repo's filing
 * convention: a dossier filed under a token-suffixed name (`backpack-securities-spcx.json`) was
 * researched on that token. Only a suffix that IS one of the issuer's own token symbols counts.
 * `terms` are the names that product goes by in the prose: its symbol, its ticker and the head of
 * its token name ("SpaceX - Backpack Securities" -> "SpaceX"). Every other token of that issuer
 * gets those passages labelled as the example (lib/cards.mjs researchExampleFor).
 */
async function researchProducts(dir, issuerSlugs, tokens) {
    let files = [];
    try {
        files = (await readdir(dir)).filter((name) => name.endsWith('.json'));
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        return new Map();
    }
    const out = new Map();
    for (const slug of issuerSlugs) {
        const file = dossierFileFor(slug, files);
        if (file === null || file === `${slug}.json`) continue;
        const suffix = file.slice(slug.length + 1, -'.json'.length).toLowerCase();
        const own = tokens.filter((token) => token.issuer === slug);
        const product = own.find((token) => String(token.symbol ?? '').toLowerCase() === suffix);
        // A single-product programme has no OTHER card for the example to be mistaken on.
        if (!product || own.length < 2) continue;
        const nameHead = typeof product.name === 'string' ? product.name.split(/\s+[-–—(]\s*/)[0].trim() : null;
        out.set(slug, { symbol: product.symbol, terms: [...new Set([product.symbol, product.underlyingTicker, nameHead].filter(Boolean))] });
    }
    return out;
}

/**
 * The change judge's material verdicts for the cards (stocks/EVIDENCE.md §2.3): every public change
 * event detected in the ${MATERIAL_CHANGE_DAYS} days up to `asOf` whose latest VALID judgment says
 * material, the same "latest valid wins" rule /api/changes applies. `asOf` is stocks-tokens.json's
 * builtAt, not the clock, so two builds from the same inputs render the same line; timestamps are
 * formatted in SQL so the session time zone cannot change a byte. Each row carries the facts a
 * curated resolution matches on (field, before, after, source URL) and whether a reviewer
 * `confirmed` it, so cardMaterialChanges can drop our own quote upkeep (cards.mjs isRealChange).
 * Returns {asOf, items, resolutions} or null when the verdicts cannot be read (no DATABASE_URL, or
 * no judgment table) — said in the log.
 */
async function readMaterialChanges(asOf) {
    const env = { ...(await readEnvFile(join(REPO_ROOT, '.env'))), ...process.env };
    if (!env.DATABASE_URL) {
        logWarn('no DATABASE_URL: cards carry no model-assessed material changes');
        return null;
    }
    if (typeof asOf !== 'string' || Number.isNaN(Date.parse(asOf))) {
        logWarn('stocks-tokens.json has no builtAt: cards carry no model-assessed material changes');
        return null;
    }
    const probe = await psql(env.DATABASE_URL, "SELECT to_regclass('sonar.change_judgment') IS NOT NULL;",
        'change judgment table probe', ['-t', '-A']);
    if (probe.trim() !== 't') {
        logWarn('sonar.change_judgment does not exist: cards carry no model-assessed material changes');
        return null;
    }
    const at = `'${asOf.replaceAll("'", "''")}'::timestamptz`;
    const sql = `
        SELECT COALESCE(json_agg(row_to_json(r) ORDER BY r."detectedAt" DESC, r.id DESC), '[]'::json)::text
        FROM (
            SELECT e.id::text AS id,
                   to_char(e.detected_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "detectedAt",
                   e.kind, e.severity, e.summary, e.subject_type AS "subjectType", e.subject_id AS "subjectId",
                   e.field, e.before, e.after, e.evidence->>'url' AS "sourceUrl",
                   COALESCE(t.issuer_slug, s.issuer_slug,
                            CASE WHEN e.subject_type = 'issuer' THEN e.subject_id END,
                            e.evidence->>'issuer') AS "issuerSlug",
                   EXISTS (SELECT 1 FROM sonar.review_resolution rc
                           WHERE rc.event_id = e.id AND rc.resolution = 'confirmed') AS confirmed,
                   mj.id::text AS "judgmentId", (mj.change_event_id = e.id) AS representative,
                   mj.material, mj.severity AS "assessmentSeverity", mj.summary AS "assessmentSummary"
            FROM sonar.change_event e
            LEFT JOIN sonar.stock_token t ON e.subject_type = 'token' AND t.mint = e.subject_id
            LEFT JOIN sonar.source s ON e.subject_type = 'source' AND s.id = e.subject_id
            JOIN LATERAL (
                SELECT j.id, j.change_event_id, j.material, j.severity, j.summary
                FROM sonar.change_judgment j
                WHERE j.status = 'valid'
                  AND (j.change_event_id = e.id
                       OR j.covers_event_ids @> jsonb_build_array(e.id)
                       OR j.covers_event_ids @> jsonb_build_array(e.id::text))
                ORDER BY j.updated_at DESC, j.id DESC
                LIMIT 1
            ) mj ON true
            WHERE mj.material
              AND e.detected_at > ${at} - interval '${MATERIAL_CHANGE_DAYS} days'
              AND e.detected_at <= ${at}
              AND NOT (e.kind = 'status' AND e.field = 'chain-watch'
                       AND COALESCE(e.summary, '') ~* '^baseline recorded:')
              -- Dismissed as a false alarm: raised from a read that was not the document
              -- (stocks/lib/unreadable.mjs), whatever the model said about it.
              AND NOT EXISTS (SELECT 1 FROM sonar.review_resolution rr
                               WHERE rr.event_id = e.id AND rr.resolution = 'false-alarm')
        ) r;`;
    const items = JSON.parse((await psql(env.DATABASE_URL, sql, 'material change verdicts', ['-t', '-A'])).trim() || '[]');
    const resolutions = (await readJson(EVENT_RESOLUTIONS_PATH, { items: [] }))?.items ?? [];
    return { asOf, items, resolutions: Array.isArray(resolutions) ? resolutions : [] };
}

/**
 * The per-token image step's state, or null (logged) when it is off or cannot run — the cards then
 * keep the site image. The renderer is imported only here, so a missing dependency never stops cards.
 */
async function prepareOgImages(outDir, enabled) {
    if (!enabled) {
        log('og images: skipped (--no-og-images); every card uses the site image');
        return null;
    }
    const fonts = await loadFonts();
    let renderer;
    try {
        const { createOgRenderer } = await import('./og/render.mjs');
        renderer = await createOgRenderer(fonts.files);
    } catch (err) {
        logWarn(`og images: renderer unavailable — ${err.message}. Every card keeps the site image.`);
        return null;
    }
    const dir = join(outDir, OG_SUBDIR);
    await ensureOgDir(dir);
    return { dir, fonts, renderer, keep: new Set(), rendered: 0, reused: 0, failed: 0, bytes: [], renderMs: 0 };
}

/** `{path, alt}` for renderCard, or null (the card keeps the site image) when rendering failed. */
async function cardOgImage(og, card) {
    if (og === null) return null;
    const model = ogImageModel(card);
    const svg = renderOgSvg(model, og.fonts);
    const started = performance.now();
    try {
        const result = await ensureOgImage({
            dir: og.dir, slug: card.slug, svg, fontDigest: og.fonts.digest, render: (input) => og.renderer.render(input)
        });
        og.keep.add(result.fileName);
        og.bytes.push(result.bytes);
        if (result.rendered) {
            og.rendered += 1;
            og.renderMs += performance.now() - started;
        } else {
            og.reused += 1;
        }
        return { path: `${DEFAULT_OUT_DIR}/${OG_SUBDIR}/${result.fileName}`, alt: ogImageAlt(model) };
    } catch (err) {
        og.failed += 1;
        logError(`og image for ${card.slug} failed: ${err.message} — that card keeps the site image`);
        return null;
    }
}

/** Drops cards from an earlier run whose token has since gone, so the directory cannot rot. */
async function pruneStale(outDir, keep) {
    let entries = [];
    try {
        entries = await readdir(outDir);
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        return 0;
    }
    let removed = 0;
    for (const name of entries) {
        if (name === 'index.json') continue;
        const match = /^(.+)\.(html|json)$/.exec(name);
        if (match === null || keep.has(match[1])) continue;
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
    // resolve, not join: an absolute --out-dir must stay where it points instead of being
    // glued onto the repo root (join does not reset on an absolute segment).
    const outDir = resolve(REPO_ROOT, typeof flags['out-dir'] === 'string' ? flags['out-dir'] : DEFAULT_OUT_DIR);
    if (baseUrl === null) {
        logWarn('no --base-url: og:url and the canonical link are omitted from every card ' +
            '(pass --base-url=https://rwasonar.com to emit them)');
    }

    const tokenDb = await readJson(TOKENS_PATH);
    if (!Array.isArray(tokenDb?.tokens)) throw new Error(`${TOKENS_PATH}: expected {tokens:[...]}`);
    const issuerDb = await readJson(ISSUERS_PATH);
    if (!Array.isArray(issuerDb?.issuers)) throw new Error(`${ISSUERS_PATH}: expected {issuers:[...]}`);
    const holderDb = await readJson(HOLDERS_PATH, { fetchedAt: null, items: [] });
    const venueDb = await readJson(VENUES_PATH, { fetchedAt: null, items: [] });
    const tradeDb = await readJson(TRADES_PATH, { generatedAt: null, pools: [] });
    // Absent (never built here) is not the same as "no lender": the card says which.
    const closedMarketDb = await readJson(CLOSED_MARKET_PATH, null);
    const meteoraDb = await readJson(METEORA_PATH, { fetchedAt: null, items: [] });
    const composabilityDb = await readJson(COMPOSABILITY_PATH, { reviewedAt: null, templates: [] });
    const defiUsageDb = await readJson(DEFI_USAGE_PATH, { fetchedAt: null, items: [] });
    const marketResearch = await readJson(MARKET_RESEARCH_PATH, { markets: [] });
    const sourcesState = await readJson(SOURCES_STATE_PATH, {});
    const reviewQueue = await readJson(REVIEW_QUEUE_PATH, { items: [] });
    const referenceDb = await readJson(REFERENCE_PRICES_PATH, { fetchedAt: null, items: [] });
    const pythOnchain = await readJson(PYTH_ONCHAIN_PATH, null);
    if (pythOnchain === null) logWarn(`no ${PYTH_ONCHAIN_PATH}: "Where prices come from" shows the feeds without on-chain prices (run stocks/fetch-pyth-onchain.mjs --run)`);
    else log(`pyth on-chain: ${pythOnchain.counts?.feeds ?? 0} feed(s), ${pythOnchain.counts?.feedsWithPrice ?? 0} with a price, read at ${pythOnchain.readAt} (chain clock)`);
    const materialChanges = await readMaterialChanges(tokenDb.builtAt ?? null);
    // xStocks public float (stocks/fetch-xstocks-float.mjs); absent on a machine that never read it.
    const floatDb = await readJson(join(HERE, 'data', 'xstocks-float.json'), null);

    const issuers = indexBy(issuerDb.issuers, 'slug');
    const whatIfBySlug = await readWhatIf(ISSUER_DOSSIER_DIR, [...issuers.keys()]);
    const researchedOn = await researchProducts(ISSUER_DOSSIER_DIR, [...issuers.keys()], tokenDb.tokens);
    for (const [slug, product] of researchedOn) {
        log(`research example: ${slug}'s dossier was researched on ${product.symbol}; its other cards label what names ${product.terms.join('/')}`);
    }
    const schematics = await loadSchematics({ issuers: [...issuers.values()] });
    const archives = archiveIndex(sourcesState);
    const holders = indexBy(holderDb?.items, 'mint');
    const venues = indexBy(venueDb?.items, 'mint');
    const closedMarket = indexBy(closedMarketDb?.items, 'mint');
    const meteora = indexBy(meteoraDb?.items, 'pairAddress');
    const composability = indexComposabilityTemplates(composabilityDb?.templates);
    const defiUsage = indexBy(defiUsageDb?.items, 'mint');
    const referencePrices = indexBy(referenceDb?.items, 'mint');
    const protocolDiscrepancies = discrepancyView.protocolDiscrepancyRecords(marketResearch,
        { protocolNames: discrepancyView.protocolNamesFromUsage(defiUsageDb) });
    const pools = poolsByMint(tradeDb?.pools);
    // CoinGecko reports an exchange pair quoted in one of our own tokens by its uppercased mint.
    const quoteSymbols = activityRows.quoteSymbolIndex(tokenDb.tokens);
    const sources = {
        tokens: tokenDb.builtAt ?? null,
        issuers: issuerDb.builtAt ?? null,
        issuerApi: tokenDb.sources?.sponsorApis?.fetchedAt ?? null,
        referencePrices: referenceDb?.fetchedAt ?? null,
        holders: holderDb?.fetchedAt ?? null,
        venues: venueDb?.fetchedAt ?? null,
        trades: tradeDb?.generatedAt ?? null,
        closedMarket: closedMarketDb?.generatedAt ?? null,
        meteora: meteoraDb?.fetchedAt ?? null,
        defiUsage: defiUsageDb?.fetchedAt ?? null
    };

    log(`read ${tokenDb.tokens.length} token(s), ${issuerDb.issuers.length} issuer(s), ` +
        `${holderDb?.items?.length ?? 0} holder record(s), ${venueDb?.items?.length ?? 0} venue record(s), ` +
        `${closedMarketDb === null ? 'NO stocks-closed-market.json' : `${closedMarketDb.items?.length ?? 0} closed-market item(s)`}, ${meteora.size} Meteora pool(s)`);
    const answered = [...whatIfBySlug.values()].filter((list) => list.length > 0).length;
    log(`what-if: ${TRUST_CHAIN.failureModes.length} failure mode(s) in catalogue ${TRUST_CHAIN.version}, ` +
        `${answered} of ${issuers.size} issuer(s) have answered them; ` +
        `${Object.keys(archives).length} source(s) have an archived copy`);
    if (materialChanges !== null) {
        const upkeep = materialChanges.items.filter((row) => !isRealChange(row, materialChanges.resolutions)).length;
        log(`change judge: ${materialChanges.items.length} change event(s) read as material (model assessment) ` +
            `in the ${MATERIAL_CHANGE_DAYS} days to ${materialChanges.asOf}; ${upkeep} of them are our own ` +
            `quote upkeep or curated false alarms and stay off the cards`);
    }

    const slugs = assignSlugs(tokenDb.tokens);
    const collisions = [...slugs.values()].filter((slug) => /-[1-9A-HJ-NP-Za-km-z]{6}$/.test(slug)).length;
    const builtAt = ts();
    await mkdir(outDir, { recursive: true });
    const og = await prepareOgImages(outDir, flags['no-og-images'] !== true);

    const index = [];
    const sizes = [];
    const aboveTarget = [];
    const overLimit = [];
    const counts = { good: 0, caution: 0, warning: 0, unknown: 0 };

    for (const token of tokenDb.tokens) {
        const slug = slugs.get(token.mint);
        if (slug === undefined) {
            logWarn(`no usable card slug for ${token.mint} (symbol ${JSON.stringify(token.symbol)}) — skipped`);
            continue;
        }
        const card = buildCard({
            token,
            issuer: issuers.get(token.issuer) ?? null,
            holdersItem: holders.get(token.mint) ?? null,
            floatItem: cardFloatItem(floatDb, token.mint),
            venuesItem: venues.get(token.mint) ?? null,
            closedMarketItem: closedMarket.get(token.mint) ?? null,
            closedMarketMeta: closedMarketDb,
            meteoraByPair: meteora,
            pools: pools.get(token.mint) ?? null,
            slug,
            builtAt,
            sources,
            catalogue: TRUST_CHAIN,
            whatIf: whatIfBySlug.get(token.issuer) ?? null,
            archives,
            composabilityTemplate: composabilityTemplateFor(token, composability),
            defiUsageItem: defiUsage.get(token.mint) ?? null,
            reviewItems: reviewQueue.items ?? [],
            schematics: schematics.issuers[token.issuer] ?? null,
            materialChanges,
            protocolDiscrepancies,
            quoteSymbols,
            referenceSchedule: referencePrices.get(token.mint)?.schedule ?? null,
            researchProduct: researchedOn.get(token.issuer) ?? null,
            referenceItem: referencePrices.get(token.mint) ?? null,
            pythOnchain,
            oraclePricing: marketResearch?.oraclePricing ?? null,
            // When the Jupiter price on the card was read, so a premium over Pyth is drawn only between close instants.
            priceReadAt: tokenDb.sources?.universe?.fetchedAt ?? null
        });
        const html = renderCard(card, { baseUrl, version: ASSET_VERSION, ogImage: await cardOgImage(og, card) });
        const bytes = Buffer.byteLength(html, 'utf8');
        const gzipBytes = gzipSync(html).byteLength;
        await writeFile(join(outDir, `${slug}.html`), html, 'utf8');
        await writeJson(join(outDir, `${slug}.json`), publicCard(card), 0);
        index.push(indexEntry(card));
        sizes.push({ slug, bytes, gzipBytes });
        if (bytes > CARD_BYTE_TARGET) aboveTarget.push({ slug, bytes });
        if (bytes > CARD_BYTE_LIMIT) overLimit.push({ slug, bytes });
        if (card.health.status in counts) counts[card.health.status] += 1;
    }

    index.sort((a, b) => byString(a.slug, b.slug));
    await writeJson(join(outDir, 'index.json'), index, 0);
    // The site's sitemaps are written by stocks/build-site-seo.mjs (sitemap.xml + sitemaps/) since
    // 2026-09-24; remove the cards-only one an earlier build left here so it is not served stale.
    await rm(join(outDir, 'sitemap.xml'), { force: true });
    const pruned = await pruneStale(outDir, new Set(index.map((entry) => entry.slug)));
    if (og !== null) {
        const ogPruned = await pruneOgImages(og.dir, og.keep);
        const total = og.bytes.reduce((sum, n) => sum + n, 0);
        const max = og.bytes.length ? Math.max(...og.bytes) : 0;
        log(`og images: ${og.rendered} rendered${og.rendered ? ` (${(og.renderMs / og.rendered).toFixed(0)} ms each)` : ''}, ` +
            `${og.reused} unchanged, ${og.failed} failed, ${ogPruned} old file(s) pruned · ` +
            `${(total / 1024 / 1024).toFixed(1)} MB total, max ${(max / 1024).toFixed(1)} kB`);
    }

    sizes.sort((a, b) => a.bytes - b.bytes);
    const compressed = [...sizes].sort((a, b) => a.gzipBytes - b.gzipBytes);
    const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;
    const median = sizes.length ? sizes[Math.floor(sizes.length / 2)].bytes : 0;
    const compressedMedian = compressed.length ? compressed[Math.floor(compressed.length / 2)].gzipBytes : 0;
    log(`wrote ${index.length} card(s) to ${outDir}${pruned ? ` (pruned ${pruned} stale file(s))` : ''}` +
        `${collisions ? ` — ${collisions} slug(s) needed a mint suffix` : ''}`);
    log(`status: ${counts.good} good, ${counts.caution} caution, ${counts.warning} warning, ${counts.unknown} unknown`);
    if (sizes.length > 0) {
        log(`card HTML: min ${kb(sizes[0].bytes)} (${sizes[0].slug}) · median ${kb(median)} · ` +
            `max ${kb(sizes[sizes.length - 1].bytes)} (${sizes[sizes.length - 1].slug}) · ` +
            `target ${kb(CARD_BYTE_TARGET)} · limit ${kb(CARD_BYTE_LIMIT)}`);
        log(`card gzip: min ${kb(compressed[0].gzipBytes)} (${compressed[0].slug}) · ` +
            `median ${kb(compressedMedian)} · max ${kb(compressed[compressed.length - 1].gzipBytes)} ` +
            `(${compressed[compressed.length - 1].slug})`);
    }
    if (aboveTarget.length > 0) {
        logWarn(`${aboveTarget.length} card(s) over the ${kb(CARD_BYTE_TARGET)} target: ` +
            aboveTarget.sort((a, b) => b.bytes - a.bytes).slice(0, 5).map((row) => `${row.slug} ${kb(row.bytes)}`).join(', '));
    }
    if (og !== null && og.failed > 0) {
        // Loud but not fatal: a card with the site image is still a correct card, and failing here
        // would withhold every card's data refresh over a cosmetic preview.
        logError(`${og.failed} og image(s) failed to render; those cards fell back to the site image`);
    }
    if (overLimit.length > 0) {
        logError(`${overLimit.length} card(s) over the ${kb(CARD_BYTE_LIMIT)} hard limit: ` +
            overLimit.sort((a, b) => b.bytes - a.bytes).slice(0, 5).map((row) => `${row.slug} ${kb(row.bytes)}`).join(', '));
        return 1;
    }
    return 0;
}

if (import.meta.filename === process.argv[1]) {
    main().then((code) => process.exit(code), (err) => {
        logError(err.stack ?? String(err));
        process.exit(1);
    });
}
