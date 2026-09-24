#!/usr/bin/env node
// Search, social and crawler plumbing for the whole site, run last in the `surfaces` release phase:
// (1) renders a 1200×630 preview image per hand-written page (stocks/lib/site-pages.mjs) with one
// live headline number, (2) rewrites each page's marked <head> SEO region, no-JS summary and contact
// footer, and (3) writes sitemap.xml (an index) plus one sitemap per page family, dated from the
// data's own timestamps. Generated families render their own images in their own builders.
//
// Why hand-written pages link a STABLE image name with ?v=<hash> (og/<key>.png?v=…) while the
// generated families use hashed file names: a generated family's HTML and its images are published
// together through one release pointer, so a hashed name is always present when the page naming it
// is. Hand-written pages are installed separately from the og/ family (rsync on deploy, an install
// loop on refresh), so for a moment the live page and the live image can be one build apart. With a
// stable name that moment serves the previous image, never a 404; the changed query string is
// still a new URL, which is what makes X, LinkedIn and the rest fetch the new picture.

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { log, logError, logWarn, parseArgs, readJson } from './lib/io.mjs';
import { loadFonts } from './lib/og-image.mjs';
import { ensureStableOgImage, pageOgAlt, pageOgModel, readOgManifest, renderPageOgSvg } from './lib/page-og.mjs';
import {
    META_DESCRIPTION_MAX, SITE_IMAGE, breadcrumbLd, contactFooterHtml, contactStylesheet, datasetLd, ldGraph,
    organizationLd, originOf, readSeoRegion, replaceSeoRegion, reportLd, seoHeadTags, webPageLd, websiteLd
} from './lib/site-seo.mjs';
import { SITE_PAGES, pageCrumbs, pageUrl, rootOf } from './lib/site-pages.mjs';
import fmt from './lib/fmt.js';
import siteNav from './lib/site-nav.js';

const REPO_ROOT = join(import.meta.dirname, '..');
/** Pages that carry only the contact footer (no indexable head of their own): value = link root. */
export const CONTACT_ONLY_PAGES = { '404.html': '/', 'card.html': './' };
const OG_DIR = 'og';
const SITEMAP_DIR = 'sitemaps';

function usage() {
    console.log(`build-site-seo.mjs — page preview images, SEO head regions, contact footers and sitemaps

USAGE
  node stocks/build-site-seo.mjs --run --base-url=https://rwasonar.com [options]
  node stocks/build-site-seo.mjs --list-pages     print the hand-written pages this step rewrites

OPTIONS
  --run               Actually build. Without it this help is printed and nothing runs.
  --base-url=<origin> REQUIRED: canonical, og:url, image and sitemap URLs are absolute and a
                      builder has no request to derive an origin from.
  --root=<dir>        Repository root to read and write (default: this checkout).
  --no-og-images      Keep the site image on every hand-written page.

INPUTS (each optional; a missing file drops its numbers, never draws a zero)
  stocks-tokens.json, stocks-issuers.json, stocks-legal-templates.json, stocks-health.json,
  stocks-power-map.json, stocks-flows.json, stocks-tracking.json, stocks-exits.json, stocks-graph.json,
  stocks-review-queue.json, stocks-change-journal.json, stocks-trades.json, rwa-assets-db.json,
  stocks/data/{defi-usage,sources,trust-chain,economics}.json, and the generated families'
  index files (cards/, templates/, protocols/, weekly/) for the sitemaps.

OUTPUTS
  ${OG_DIR}/<page>.png + ${OG_DIR}/index.json   one image per page, re-rendered only when its drawing changes
  the pages listed by --list-pages            rewritten only between their <!-- seo:… --> markers
  sitemap.xml                                 sitemap index → ${SITEMAP_DIR}/{pages,cards,issuers,templates,protocols,weekly}.xml`);
}

// ── Data

async function readData(root) {
    const j = (path) => readJson(join(root, path), null);
    const [tokens, issuers, templates, health, defi, powerMap, flows, tracking, exits, graph, review, journal, trades,
        assets, sources, trustChain, economics] = await Promise.all([
        j('stocks-tokens.json'), j('stocks-issuers.json'), j('stocks-legal-templates.json'), j('stocks-health.json'),
        j('stocks/data/defi-usage.json'), j('stocks-power-map.json'), j('stocks-flows.json'), j('stocks-tracking.json'),
        j('stocks-exits.json'), j('stocks-graph.json'), j('stocks-review-queue.json'), j('stocks-change-journal.json'),
        j('stocks-trades.json'), j('rwa-assets-db.json'), j('stocks/data/sources.json'), j('stocks/data/trust-chain.json'),
        j('stocks/data/economics.json')
    ]);
    return { tokens, issuers, templates, health, defi, powerMap, flows, tracking, exits, graph, review, journal, trades,
        assets, sources, trustChain, economics };
}

/** YYYY-MM-DD of an ISO timestamp, or null. */
function day(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) && Number.isFinite(Date.parse(value))
        ? value.slice(0, 10) : null;
}

/** The newest day among ISO timestamps, or null. */
function newestDay(values) {
    return values.map(day).filter(Boolean).sort().at(-1) ?? null;
}

/** Date of the last commit touching `file` — a static page's own change date — or null without git. */
function gitDay(root, file) {
    try {
        return day(execFileSync('git', ['log', '-1', '--format=%cI', '--', file], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    } catch {
        return null;
    }
}

function pageLastmod(root, page, data) {
    let value = null;
    try {
        value = day(page.lastmod?.(data) ?? null);
    } catch {
        value = null;
    }
    return value ?? gitDay(root, page.file);
}

// ── Page images

function imageModel(page, data) {
    let stats = [];
    try {
        stats = typeof page.stats === 'function' ? page.stats(data) ?? [] : [];
    } catch (err) {
        logWarn(`${page.file}: headline numbers unavailable (${err.message}); image drawn without them`);
    }
    const title = page.imageTitle ?? page.title.replace(/ — RWA Sonar$/, '').replace(/^RWA Sonar — /, '');
    return pageOgModel({
        kicker: page.kicker, title: title.charAt(0).toUpperCase() + title.slice(1), subtitle: page.subtitle,
        stats, facts: (page.facts ?? []).map((text) => ({ text, state: 'neutral' })), path: page.path.replace(/\/$/, '') || null
    });
}

async function prepareRenderer(enabled) {
    if (!enabled) return null;
    const fonts = await loadFonts();
    try {
        const { createOgRenderer } = await import('./og/render.mjs');
        return { fonts, renderer: await createOgRenderer(fonts.files) };
    } catch (err) {
        logWarn(`page og images: renderer unavailable — ${err.message}. Every page keeps the site image.`);
        return null;
    }
}

/** `{key → {url, alt}}` for every page; the site image for any page whose render failed. */
async function renderPageImages({ root, origin, data, og }) {
    const images = {};
    if (og === null) return images;
    const dir = join(root, OG_DIR);
    await mkdir(dir, { recursive: true });
    const manifest = await readOgManifest(dir);
    const keep = new Set(['index.json']);
    let rendered = 0;
    let reused = 0;
    for (const page of SITE_PAGES) {
        const model = imageModel(page, data);
        try {
            const result = await ensureStableOgImage({
                dir, key: page.key, svg: renderPageOgSvg(model, og.fonts), fontDigest: og.fonts.digest,
                render: (svg) => og.renderer.render(svg), manifest
            });
            keep.add(result.fileName);
            if (result.rendered) rendered += 1; else reused += 1;
            images[page.key] = { url: `${origin}/${OG_DIR}/${result.fileName}?v=${result.hash}`, alt: pageOgAlt(model), width: 1200, height: 630 };
        } catch (err) {
            logError(`page og image for ${page.file} failed: ${err.message} — it keeps the site image`);
        }
    }
    for (const key of Object.keys(manifest)) if (!SITE_PAGES.some((page) => page.key === key)) delete manifest[key];
    const tmp = join(dir, `index.json.tmp-${process.pid}`);
    await writeFile(tmp, `${JSON.stringify(manifest, null, 1)}\n`);
    await rename(tmp, join(dir, 'index.json'));
    let pruned = 0;
    for (const name of await readdir(dir)) {
        if (keep.has(name)) continue;
        await rm(join(dir, name), { force: true });
        pruned += 1;
    }
    log(`page og images: ${rendered} rendered, ${reused} unchanged, ${pruned} old file(s) pruned`);
    return images;
}

// ── Head, no-JS summary and contact regions

function pageJsonLd(origin, page, image, lastmod) {
    const url = pageUrl(origin, page);
    const crumbs = page.key === 'home' ? null : breadcrumbLd(pageCrumbs(origin, page));
    const name = page.title;
    const common = { origin, url, name, description: page.description, dateModified: lastmod };
    switch (page.schema) {
    case 'home':
        return ldGraph([organizationLd(origin), websiteLd(origin), webPageLd(common)]);
    case 'dataset':
        return ldGraph([organizationLd(origin), webPageLd(common), datasetLd({
            origin, url, name: page.dataset.name, description: page.description, dateModified: lastmod,
            keywords: page.dataset.keywords ?? [],
            distribution: [...(page.dataset.files ?? []).map((file) => ({ url: file, name: file })),
                ...(page.dataset.api ?? []).map((route) => ({ url: route, name: `/${route}` }))]
        }), crumbs]);
    case 'article':
        return ldGraph([organizationLd(origin), reportLd({ origin, url, headline: name.replace(/ — RWA Sonar$/, ''), description: page.description,
            dateModified: lastmod, image: image?.url ?? null, type: 'Article' }), crumbs]);
    case 'collection':
        return ldGraph([organizationLd(origin), webPageLd({ ...common, type: 'CollectionPage' }), crumbs]);
    default:
        return ldGraph([organizationLd(origin), webPageLd(common), crumbs]);
    }
}

const REGION_NOTE = '<!-- Generated by stocks/build-site-seo.mjs from stocks/lib/site-pages.mjs: edit the registry, not this block. -->';

export function headRegion(origin, page, image, lastmod) {
    const sep = '\n    ';
    // theme.js first: it must run before the page's stylesheets (the contact one below included).
    return `${sep}${REGION_NOTE}${sep}${siteNav.themeScriptHtml(rootOf(page.file))}${sep}` + seoHeadTags({
        title: page.title,
        description: page.description,
        socialDescription: page.socialDescription ?? null,
        url: pageUrl(origin, page),
        type: page.schema === 'article' ? 'article' : 'website',
        image: image ?? SITE_IMAGE,
        jsonLd: pageJsonLd(origin, page, image, lastmod),
        sep
    }) + `${sep}${contactStylesheet(rootOf(page.file))}\n    `;
}

/** A no-JavaScript summary for app pages: what the page shows, its live numbers and crawlable routes. */
export function noscriptRegion(page, data) {
    const e = fmt.escapeHtml;
    const root = rootOf(page.file);
    let stats = [];
    try {
        stats = (page.stats?.(data) ?? []).filter((row) => row?.value);
    } catch {
        stats = [];
    }
    const files = (page.dataset?.files ?? []).map((file) => `<a href="${root}${e(file)}">${e(file)}</a>`).join(', ');
    return '<noscript><section class="site-noscript">'
        + `<p>${e(page.description)}</p>`
        + (stats.length ? `<ul>${stats.map((row) => `<li><strong>${e(row.value)}</strong> ${e(row.label)}</li>`).join('')}</ul>` : '')
        + '<p>This view is interactive. Without JavaScript, read the same research as static pages: '
        + `<a href="${root}issuers/">issuer dossiers</a>, <a href="${root}templates/">legal templates</a>, `
        + `<a href="${root}protocols/">protocol dossiers</a>, <a href="${root}weekly/">weekly digests</a> and one report per token `
        + `(for example <a href="${root}cards/NVDAx.html">NVDAx</a>)`
        + (files ? `; the data behind this page: ${files}` : '')
        + '.</p></section></noscript>';
}

/** Legacy head tags a region replaces: title, description, robots, canonical, og:*, twitter:*, JSON-LD. */
const LEGACY_HEAD_TAGS = [
    /<title>[\s\S]*?<\/title>/g,
    /<meta\s+name="(?:description|robots)"[^>]*>/g,
    /<meta\s+(?:property|name)="(?:og|twitter):[^"]*"[^>]*>/g,
    /<link\s+rel="canonical"[^>]*>/g,
    /<script\s+type="application\/ld\+json">[\s\S]*?<\/script>/g
];

/**
 * Makes sure a page has its markers: the head region replaces the page's existing SEO tags and sits
 * after the viewport meta; the no-JS region follows the opening <body>; the contact region precedes
 * </body>. Idempotent — a page that already has a region keeps it where it is.
 */
export function ensureRegions(html, { head = true, noscript = false, contact = true } = {}) {
    let out = html;
    if (head && readSeoRegion(out, 'head') === null) {
        const headEnd = out.indexOf('</head>');
        if (headEnd === -1) throw new Error('page has no </head>');
        let headHtml = out.slice(0, headEnd);
        for (const pattern of LEGACY_HEAD_TAGS) headHtml = headHtml.replace(pattern, '');
        headHtml = headHtml.replace(/\n[ \t]*(?=\n)/g, '');
        const viewport = /<meta\s+name="viewport"[^>]*>/.exec(headHtml);
        if (viewport === null) throw new Error('page has no viewport meta to anchor the head region');
        const at = viewport.index + viewport[0].length;
        headHtml = `${headHtml.slice(0, at)}\n    <!-- seo:head:start --><!-- seo:head:end -->${headHtml.slice(at)}`;
        out = headHtml + out.slice(headEnd);
    }
    if (noscript && readSeoRegion(out, 'noscript') === null) {
        const body = /<body\b[^>]*>/.exec(out);
        if (body === null) throw new Error('page has no <body>');
        const at = body.index + body[0].length;
        out = `${out.slice(0, at)}\n<!-- seo:noscript:start --><!-- seo:noscript:end -->${out.slice(at)}`;
    }
    if (contact) out = placeContactRegion(out).html;
    return out;
}

const CONTACT_REGION = /<!-- seo:contact:start -->[\s\S]*?<!-- seo:contact:end -->\n?/;

/**
 * The contact region sits inside the page's own footer (before its last `</footer>`) so the page
 * has one footer; a page without a footer gets it before `</body>`. An existing region is moved
 * there. Returns `inner`: whether the region is inside a footer (then it renders as a block, not a
 * second <footer>).
 */
export function placeContactRegion(html) {
    const stripped = html.replace(CONTACT_REGION, '');
    const markers = '<!-- seo:contact:start --><!-- seo:contact:end -->';
    const footerEnd = stripped.lastIndexOf('</footer>');
    if (footerEnd !== -1) return { html: `${stripped.slice(0, footerEnd)}${markers}${stripped.slice(footerEnd)}`, inner: true };
    const at = stripped.lastIndexOf('</body>');
    if (at === -1) throw new Error('page has no </body>');
    return { html: `${stripped.slice(0, at)}${markers}\n${stripped.slice(at)}`, inner: false };
}

/** Pages without a head region get the footer's stylesheet beside it (a body-ok <link>). */
export function contactRegion(root, { withStylesheet = false, variant = null, inner = false } = {}) {
    return `\n${withStylesheet ? `${contactStylesheet(root)}\n` : ''}${contactFooterHtml(root, { variant, inner })}\n`;
}

async function writeIfChanged(path, before, after) {
    if (before === after) return false;
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, after);
    await rename(tmp, path);
    return true;
}

async function rewritePages({ root, origin, data, images }) {
    let changed = 0;
    for (const page of SITE_PAGES) {
        const path = join(root, page.file);
        const before = await readFile(path, 'utf8');
        const noscript = page.schema === 'dataset';
        let html = ensureRegions(before, { head: true, noscript, contact: false });
        const placed = placeContactRegion(html);
        html = placed.html;
        const lastmod = pageLastmod(root, page, data);
        html = replaceSeoRegion(html, 'head', headRegion(origin, page, images[page.key] ?? null, lastmod));
        if (noscript) html = replaceSeoRegion(html, 'noscript', noscriptRegion(page, data));
        html = replaceSeoRegion(html, 'contact', contactRegion(rootOf(page.file), { variant: page.contactVariant ?? null, inner: placed.inner }));
        if (await writeIfChanged(path, before, html)) changed += 1;
    }
    for (const [file, root_] of Object.entries(CONTACT_ONLY_PAGES)) {
        const path = join(root, file);
        const before = await readFile(path, 'utf8');
        const placed = placeContactRegion(before);
        const html = replaceSeoRegion(placed.html, 'contact', contactRegion(root_, { withStylesheet: true, inner: placed.inner }));
        if (await writeIfChanged(path, before, html)) changed += 1;
    }
    log(`seo regions: ${changed} of ${SITE_PAGES.length + Object.keys(CONTACT_ONLY_PAGES).length} page(s) rewritten`);
}

// ── Sitemaps

function xmlEscape(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** `<urlset>` for `[{loc, lastmod}]`, sorted by loc so the bytes do not depend on read order. */
export function urlsetXml(rows) {
    const body = [...rows].sort((a, b) => (a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0))
        .map((row) => `  <url><loc>${xmlEscape(row.loc)}</loc>${row.lastmod ? `<lastmod>${row.lastmod}</lastmod>` : ''}</url>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

export function sitemapIndexXml(rows) {
    const body = rows.map((row) => `  <sitemap><loc>${xmlEscape(row.loc)}</loc>${row.lastmod ? `<lastmod>${row.lastmod}</lastmod>` : ''}</sitemap>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`;
}

/** The 50,000-URL protocol limit; a family past it would have to be split. */
const SITEMAP_URL_LIMIT = 50000;

async function familyRows(root, origin, data) {
    const enc = encodeURIComponent;
    const families = {};
    families.pages = SITE_PAGES.map((page) => ({ loc: pageUrl(origin, page), lastmod: pageLastmod(root, page, data) }));

    const cards = await readJson(join(root, 'cards', 'index.json'), null);
    if (Array.isArray(cards)) {
        families.cards = [];
        for (const entry of cards) {
            const card = await readJson(join(root, 'cards', `${entry.slug}.json`), null);
            families.cards.push({ loc: `${origin}/cards/${enc(entry.slug)}.html`, lastmod: newestDay(Object.values(card?.sources ?? {})) });
        }
    } else logWarn('sitemap: no cards/index.json — the cards sitemap is left out');

    if (Array.isArray(data.issuers?.issuers)) {
        const issuers = data.issuers.issuers;
        families.issuers = [{ loc: `${origin}/issuers/`, lastmod: newestDay(issuers.map((i) => i?.evidence?.lastCheckedAt)) },
            ...issuers.map((issuer) => ({ loc: `${origin}/issuers/${enc(issuer.slug)}.html`, lastmod: day(issuer?.evidence?.lastCheckedAt) ?? day(data.issuers.builtAt) }))];
    }

    const templates = await readJson(join(root, 'templates', 'index.json'), null);
    if (Array.isArray(templates)) {
        families.templates = [{ loc: `${origin}/templates/`, lastmod: newestDay(templates.map((t) => t.reviewedAt)) },
            ...templates.map((t) => ({ loc: `${origin}/templates/${enc(t.id)}.html`, lastmod: day(t.reviewedAt) }))];
    } else logWarn('sitemap: no templates/index.json — the templates sitemap is left out');

    const protocols = await readJson(join(root, 'protocols', 'index.json'), null);
    if (Array.isArray(protocols)) {
        families.protocols = [{ loc: `${origin}/protocols/`, lastmod: day(data.defi?.fetchedAt) }];
        for (const entry of protocols) {
            const dossier = await readJson(join(root, 'protocols', `${entry.slug}.json`), null);
            families.protocols.push({ loc: `${origin}/protocols/${enc(entry.slug)}.html`, lastmod: day(dossier?.fetchedAt) });
        }
    } else logWarn('sitemap: no protocols/index.json — the protocols sitemap is left out');

    const weeks = await readJson(join(root, 'weekly', 'index.json'), null);
    if (Array.isArray(weeks)) {
        // A complete week stops changing at its end; the week in progress changes with its data.
        const lastmod = (w) => w.inProgress ? day(w.asOf) : [day(w.asOf), day(w.end)].filter(Boolean).sort()[0] ?? null;
        families.weekly = [{ loc: `${origin}/weekly/`, lastmod: newestDay(weeks.map((w) => w.asOf)) },
            ...weeks.map((w) => ({ loc: `${origin}/weekly/${enc(w.id)}.html`, lastmod: lastmod(w) }))];
    } else logWarn('sitemap: no weekly/index.json — the weekly sitemap is left out');
    return families;
}

async function writeSitemaps({ root, origin, data }) {
    const families = await familyRows(root, origin, data);
    await mkdir(join(root, SITEMAP_DIR), { recursive: true });
    const index = [];
    let urls = 0;
    for (const [name, rows] of Object.entries(families)) {
        if (rows.length > SITEMAP_URL_LIMIT) throw new Error(`sitemap ${name} has ${rows.length} URLs, over the ${SITEMAP_URL_LIMIT} limit: split it`);
        const file = `${SITEMAP_DIR}/${name}.xml`;
        const tmp = join(root, `${file}.tmp-${process.pid}`);
        await writeFile(tmp, urlsetXml(rows));
        await rename(tmp, join(root, file));
        index.push({ loc: `${origin}/${file}`, lastmod: newestDay(rows.map((row) => row.lastmod)) });
        urls += rows.length;
    }
    for (const name of await readdir(join(root, SITEMAP_DIR))) {
        if (!Object.hasOwn(families, name.replace(/\.xml$/, ''))) await rm(join(root, SITEMAP_DIR, name), { force: true });
    }
    const tmp = join(root, `sitemap.xml.tmp-${process.pid}`);
    await writeFile(tmp, sitemapIndexXml(index));
    await rename(tmp, join(root, 'sitemap.xml'));
    log(`sitemaps: ${urls} URL(s) in ${index.length} file(s): ${index.map((row) => row.loc.split('/').pop()).join(', ')}`);
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags['list-pages']) {
        console.log([...SITE_PAGES.map((page) => page.file), ...Object.keys(CONTACT_ONLY_PAGES)].join('\n'));
        return 0;
    }
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }
    const origin = originOf(flags['base-url']);
    if (origin === null) {
        logError('--base-url is required: every URL this step writes is absolute (e.g. --base-url=https://rwasonar.com)');
        return 1;
    }
    const root = resolve(typeof flags.root === 'string' ? flags.root : REPO_ROOT);
    const data = await readData(root);
    const tooLong = SITE_PAGES.filter((page) => page.description.length > META_DESCRIPTION_MAX);
    if (tooLong.length) throw new Error(`meta description over ${META_DESCRIPTION_MAX} characters: ${tooLong.map((p) => p.file).join(', ')}`);
    const og = await prepareRenderer(flags['no-og-images'] !== true);
    const images = await renderPageImages({ root, origin, data, og });
    await rewritePages({ root, origin, data, images });
    await writeSitemaps({ root, origin, data });
    return 0;
}

if (import.meta.filename === process.argv[1]) {
    main().then((code) => process.exit(code), (err) => {
        logError(err.stack ?? String(err));
        process.exit(1);
    });
}
