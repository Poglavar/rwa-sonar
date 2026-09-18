#!/usr/bin/env node
// Builds cards/<slug>.html + cards/<slug>.json + cards/index.json: one static, shareable page per
// tokenized stock, rendered entirely at build time (readable with JavaScript off) from the seven
// built files. It calls evaluateHealth itself rather than reading stocks-health.json, because a card
// shows each rule's INPUTS and that thin file deliberately drops them.
// The whole cards/ directory is generated per refresh and gitignored — rebuild it, never edit it.

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CARD_BYTE_BUDGET, assignSlugs, buildCard, indexEntry, publicCard, renderCard } from './lib/cards.mjs';
import { byString, log, logError, logWarn, parseArgs, readJson, ts, writeJson } from './lib/io.mjs';
import { TRUST_CHAIN } from './lib/trustchain.mjs';

const HERE = import.meta.dirname;
const REPO_ROOT = join(HERE, '..');
const TOKENS_PATH = join(REPO_ROOT, 'stocks-tokens.json');
const ISSUERS_PATH = join(REPO_ROOT, 'stocks-issuers.json');
const TRADES_PATH = join(REPO_ROOT, 'stocks-trades.json');
const AFTERHOURS_PATH = join(REPO_ROOT, 'stocks-afterhours.json');
const HOLDERS_PATH = join(HERE, 'data', 'holders.json');
const VENUES_PATH = join(HERE, 'data', 'venues.json');
const METEORA_PATH = join(HERE, 'data', 'meteora.json');
const ISSUER_DOSSIER_DIR = join(HERE, 'data', 'issuers');
const SOURCES_STATE_PATH = join(HERE, 'data', 'sources-state.json');
const DEFAULT_OUT_DIR = 'cards';

/** Cache-busting stamp on ../card.css and ../card.js. Bump when either of those changes. */
const ASSET_VERSION = '20260918e';

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
  --help                    This text.

INPUTS
  stocks-tokens.json, stocks-issuers.json, stocks/data/holders.json, stocks/data/venues.json,
  stocks-trades.json, stocks-afterhours.json, stocks/data/meteora.json,
  stocks/data/trust-chain.json, stocks/data/issuers/*.json (the what-if answers),
  stocks/data/sources-state.json (the archived copy behind each answer's source)

OUTPUT
  <out-dir>/<slug>.html   the card, everything rendered server-side, with its JSON inlined
  <out-dir>/<slug>.json   the same record on its own
  <out-dir>/index.json    [{slug, symbol, mint, issuer, status}] — what card.html resolves against

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
 * The dossier file that belongs to an issuer slug. Three of the twelve dossiers are filed under a
 * token-suffixed name (`bullish-blsh.json` for `bullish`), so the rule is: the exact name first,
 * then the one file whose name is the slug plus a suffix. Derived rather than typed, so a new
 * issuer needs no map entry — and an AMBIGUOUS prefix returns null and is warned about rather than
 * resolved by guessing, because the wrong dossier would put another issuer's answers on this card.
 */
function dossierFileFor(slug, files) {
    if (files.includes(`${slug}.json`)) return `${slug}.json`;
    const prefixed = files.filter((name) => name.startsWith(`${slug}-`));
    return prefixed.length === 1 ? prefixed[0] : null;
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
 * One issuer slug -> its dossier's `whatIf[]`. The answers are the one part of a dossier that
 * stocks-issuers.json deliberately does not carry (EVIDENCE.md §6.4: they are prose with quotes and
 * case citations, and the API serves them), so the card builder reads the dossiers directly.
 */
async function readWhatIf(dir, slugs) {
    const index = new Map();
    let files = [];
    try {
        files = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort(byString);
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        logWarn(`${dir} is not there, so no card can show a what-if answer`);
        return index;
    }
    for (const slug of slugs) {
        const file = dossierFileFor(slug, files);
        if (file === null) {
            logWarn(`no dossier file for issuer "${slug}" — its cards show 38 unanswered questions`);
            continue;
        }
        const dossier = await readJson(join(dir, file), null);
        index.set(slug, Array.isArray(dossier?.whatIf) ? dossier.whatIf : []);
    }
    return index;
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
    const afterhoursDb = await readJson(AFTERHOURS_PATH, { generatedAt: null, items: [] });
    const meteoraDb = await readJson(METEORA_PATH, { fetchedAt: null, items: [] });
    const sourcesState = await readJson(SOURCES_STATE_PATH, {});

    const issuers = indexBy(issuerDb.issuers, 'slug');
    const whatIfBySlug = await readWhatIf(ISSUER_DOSSIER_DIR, [...issuers.keys()]);
    const archives = archiveIndex(sourcesState);
    const holders = indexBy(holderDb?.items, 'mint');
    const venues = indexBy(venueDb?.items, 'mint');
    const afterhours = indexBy(afterhoursDb?.items, 'mint');
    const meteora = indexBy(meteoraDb?.items, 'pairAddress');
    const pools = poolsByMint(tradeDb?.pools);
    const sources = {
        tokens: tokenDb.builtAt ?? null,
        issuers: issuerDb.builtAt ?? null,
        issuerApi: tokenDb.sources?.sponsorApis?.fetchedAt ?? null,
        holders: holderDb?.fetchedAt ?? null,
        venues: venueDb?.fetchedAt ?? null,
        trades: tradeDb?.generatedAt ?? null,
        afterhours: afterhoursDb?.generatedAt ?? null,
        meteora: meteoraDb?.fetchedAt ?? null
    };

    log(`read ${tokenDb.tokens.length} token(s), ${issuerDb.issuers.length} issuer(s), ` +
        `${holderDb?.items?.length ?? 0} holder record(s), ${venueDb?.items?.length ?? 0} venue record(s), ` +
        `${afterhoursDb?.items?.length ?? 0} after-hours item(s), ${meteora.size} Meteora pool(s)`);
    const answered = [...whatIfBySlug.values()].filter((list) => list.length > 0).length;
    log(`what-if: ${TRUST_CHAIN.failureModes.length} failure mode(s) in catalogue ${TRUST_CHAIN.version}, ` +
        `${answered} of ${issuers.size} issuer(s) have answered them; ` +
        `${Object.keys(archives).length} source(s) have an archived copy`);

    const slugs = assignSlugs(tokenDb.tokens);
    const collisions = [...slugs.values()].filter((slug) => /-[1-9A-HJ-NP-Za-km-z]{6}$/.test(slug)).length;
    const builtAt = ts();
    await mkdir(outDir, { recursive: true });

    const index = [];
    const sizes = [];
    const oversize = [];
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
            venuesItem: venues.get(token.mint) ?? null,
            afterhoursItem: afterhours.get(token.mint) ?? null,
            meteoraByPair: meteora,
            pools: pools.get(token.mint) ?? null,
            slug,
            builtAt,
            sources,
            catalogue: TRUST_CHAIN,
            whatIf: whatIfBySlug.get(token.issuer) ?? null,
            archives
        });
        const html = renderCard(card, { baseUrl, version: ASSET_VERSION });
        const bytes = Buffer.byteLength(html, 'utf8');
        await writeFile(join(outDir, `${slug}.html`), html, 'utf8');
        await writeJson(join(outDir, `${slug}.json`), publicCard(card), 0);
        index.push(indexEntry(card));
        sizes.push({ slug, bytes });
        if (bytes > CARD_BYTE_BUDGET) oversize.push({ slug, bytes });
        if (card.health.status in counts) counts[card.health.status] += 1;
    }

    index.sort((a, b) => byString(a.slug, b.slug));
    await writeJson(join(outDir, 'index.json'), index, 0);
    const pruned = await pruneStale(outDir, new Set(index.map((entry) => entry.slug)));

    sizes.sort((a, b) => a.bytes - b.bytes);
    const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;
    const median = sizes.length ? sizes[Math.floor(sizes.length / 2)].bytes : 0;
    log(`wrote ${index.length} card(s) to ${outDir}${pruned ? ` (pruned ${pruned} stale file(s))` : ''}` +
        `${collisions ? ` — ${collisions} slug(s) needed a mint suffix` : ''}`);
    log(`status: ${counts.good} good, ${counts.caution} caution, ${counts.warning} warning, ${counts.unknown} unknown`);
    if (sizes.length > 0) {
        log(`card size: min ${kb(sizes[0].bytes)} (${sizes[0].slug}) · median ${kb(median)} · ` +
            `max ${kb(sizes[sizes.length - 1].bytes)} (${sizes[sizes.length - 1].slug})`);
    }
    if (oversize.length > 0) {
        logError(`${oversize.length} card(s) over the ${kb(CARD_BYTE_BUDGET)} budget: ` +
            oversize.sort((a, b) => b.bytes - a.bytes).slice(0, 5).map((row) => `${row.slug} ${kb(row.bytes)}`).join(', '));
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
