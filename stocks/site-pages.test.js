// SEO invariants over what is actually published: every hand-written page's committed <head>
// matches the registry (lib/site-pages.mjs) and carries unique title/description, canonical,
// OpenGraph/X tags with a page-specific image and valid JSON-LD; every public page carries the
// contact footer; robots.txt, llms.txt and llms-full.txt say what crawlers need; and the generated
// families (cards, issuers, templates, protocols, weekly) render the same tags from real data.

const fs = require('node:fs');
const path = require('node:path');

const { CONTACT_LINKS, META_DESCRIPTION_MAX } = require('./lib/site-seo.mjs');
const { SITE_PAGES, pageUrl } = require('./lib/site-pages.mjs');
const { CONTACT_ONLY_PAGES, headRegion } = require('./build-site-seo.mjs');
const { assignSlugs, buildCard, renderCard } = require('./lib/cards.mjs');
const { renderIssuerIndex, renderIssuerPage } = require('./lib/issuer-pages.mjs');
const { renderTemplateIndex, renderTemplatePage } = require('./lib/template-pages.mjs');
const { buildProtocolDossiers, renderProtocolDossier, renderProtocolIndex } = require('./lib/protocol-dossiers.mjs');

const ROOT = path.join(__dirname, '..');
const ORIGIN = 'https://rwasonar.com';
const readText = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const readJson = (file) => JSON.parse(readText(file));

function unescape(value) {
    return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** The SEO facts of one HTML document: every tag once, JSON-LD parsed. */
function seoOf(html) {
    const head = html.slice(0, html.indexOf('</head>'));
    const all = (re) => [...head.matchAll(re)].map((m) => unescape(m[1]));
    const one = (re) => {
        const found = all(re);
        expect(found).toHaveLength(1);
        return found[0];
    };
    const ld = all(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g).map((text) => JSON.parse(text));
    return {
        title: one(/<title>([^<]*)<\/title>/g),
        description: one(/<meta name="description" content="([^"]*)" \/>/g),
        canonical: one(/<link rel="canonical" href="([^"]*)" \/>/g),
        ogTitle: one(/<meta property="og:title" content="([^"]*)" \/>/g),
        ogDescription: one(/<meta property="og:description" content="([^"]*)" \/>/g),
        ogUrl: one(/<meta property="og:url" content="([^"]*)" \/>/g),
        ogType: one(/<meta property="og:type" content="([^"]*)" \/>/g),
        ogSiteName: one(/<meta property="og:site_name" content="([^"]*)" \/>/g),
        ogImage: one(/<meta property="og:image" content="([^"]*)" \/>/g),
        ogImageAlt: one(/<meta property="og:image:alt" content="([^"]*)" \/>/g),
        ogImageWidth: one(/<meta property="og:image:width" content="([^"]*)" \/>/g),
        ogImageHeight: one(/<meta property="og:image:height" content="([^"]*)" \/>/g),
        twitterCard: one(/<meta name="twitter:card" content="([^"]*)" \/>/g),
        twitterSite: one(/<meta name="twitter:site" content="([^"]*)" \/>/g),
        twitterCreator: one(/<meta name="twitter:creator" content="([^"]*)" \/>/g),
        twitterImage: one(/<meta name="twitter:image" content="([^"]*)" \/>/g),
        ld
    };
}

function expectCompleteSeo(seo, url) {
    expect(seo.canonical).toBe(url);
    expect(seo.ogUrl).toBe(url);
    expect(seo.description.length).toBeGreaterThan(40);
    expect(seo.description.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX);
    expect(seo.ogSiteName).toBe('RWA Sonar');
    expect(seo.ogImage).toMatch(/^https:\/\/rwasonar\.com\/\S+\.png(\?v=[0-9a-f]{8,})?$/);
    expect(seo.twitterImage).toBe(seo.ogImage);
    expect([seo.ogImageWidth, seo.ogImageHeight]).toEqual(['1200', '630']);
    expect(seo.ogImageAlt.length).toBeGreaterThan(20);
    expect(seo.twitterCard).toBe('summary_large_image');
    expect([seo.twitterSite, seo.twitterCreator]).toEqual(['@RWASonar', '@RWASonar']);
    expect(seo.ld).toHaveLength(1);
    const types = seo.ld[0]['@graph'].map((node) => node['@type']);
    expect(types).toContain('Organization');
    return types;
}

function expectContactFooter(html) {
    // One contact block per page: a standalone <footer>, or a block inside the page's own footer.
    expect(html.match(/class="site-contact[ "]/g) ?? []).toHaveLength(1);
    const match = html.match(/<(footer|div) class="site-contact[^"]*"[\s\S]*?<\/\1>(\s*<!-- seo:contact:end -->)?\s*(<\/footer>)?/);
    expect(match).toBeTruthy();
    if (match[1] === 'div') expect(match[3]).toBe('</footer>');
    const footer = match[0];
    for (const url of [CONTACT_LINKS.x, CONTACT_LINKS.telegramGroup, CONTACT_LINKS.github]) {
        expect(footer).toContain(`href="${url}"`);
    }
    expect(footer).not.toContain(`href="${CONTACT_LINKS.bot}"`);
}

describe('hand-written pages', () => {
    const pages = SITE_PAGES.map((page) => ({ page, html: readText(page.file) }));

    test.each(pages.map(({ page, html }) => [page.file, page, html]))('%s has a complete, page-specific head', (_, page, html) => {
        const seo = seoOf(html);
        const types = expectCompleteSeo(seo, pageUrl(ORIGIN, page));
        expect(seo.title).toBe(page.title);
        expect(seo.ogImage).toMatch(new RegExp(`^https://rwasonar\\.com/og/${page.key}\\.png\\?v=[0-9a-f]{12}$`));
        const expected = { home: 'WebSite', dataset: 'Dataset', article: 'Article', collection: 'CollectionPage', webpage: 'WebPage' }[page.schema];
        expect(types).toContain(expected);
        if (page.key !== 'home') expect(types).toContain('BreadcrumbList');
        expect(html).not.toContain('noindex');
    });

    test('the committed head of every page is exactly what the registry renders (nothing edited by hand)', () => {
        for (const { page, html } of pages) {
            const seo = seoOf(html);
            const graph = seo.ld[0]['@graph'];
            const lastmod = graph.find((node) => node.dateModified)?.dateModified ?? null;
            const region = html.slice(html.indexOf('<!-- seo:head:start -->') + '<!-- seo:head:start -->'.length, html.indexOf('<!-- seo:head:end -->'));
            expect(region).toBe(headRegion(ORIGIN, page, { url: seo.ogImage, alt: seo.ogImageAlt, width: 1200, height: 630 }, lastmod));
        }
    });

    test('titles, descriptions and images are unique across pages', () => {
        const seos = pages.map(({ html }) => seoOf(html));
        for (const key of ['title', 'description', 'canonical', 'ogImage']) {
            expect(new Set(seos.map((seo) => seo[key])).size).toBe(seos.length);
        }
    });

    test('app pages that render with JavaScript carry a no-script summary of their substance', () => {
        for (const { page, html } of pages.filter((row) => row.page.schema === 'dataset')) {
            const summary = html.match(/<noscript><section class="site-noscript">([\s\S]*?)<\/section><\/noscript>/)?.[1];
            expect(summary).toContain(page.description.replace(/'/g, '&#39;'));
            expect(summary).toContain('issuers/');
        }
    });

    test('every public page, including the 404 and the card redirect, ends with the contact footer', () => {
        for (const file of [...SITE_PAGES.map((page) => page.file), ...Object.keys(CONTACT_ONLY_PAGES)]) {
            expectContactFooter(readText(file));
        }
        // Every root page is either in the registry, contact-only, or a design file kept out of crawls.
        const known = new Set([...SITE_PAGES.map((page) => page.file), ...Object.keys(CONTACT_ONLY_PAGES), 'sonar-animation.html']);
        for (const file of fs.readdirSync(ROOT).filter((name) => name.endsWith('.html'))) expect(known.has(file)).toBe(true);
    });
});

describe('crawler files', () => {
    test('robots.txt allows search and AI crawlers and names the sitemap index', () => {
        const robots = readText('robots.txt');
        expect(robots).toMatch(/^User-agent: \*\nAllow: \/$/m);
        expect(robots).not.toMatch(/^Disallow: \/$/m);
        for (const bot of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'CCBot']) expect(robots).toContain(`User-agent: ${bot}`);
        expect(robots).toContain('Sitemap: https://rwasonar.com/sitemap.xml');
    });

    test('llms.txt follows the convention: title, summary, sections of described links, contact', () => {
        const llms = readText('llms.txt');
        expect(llms.split('\n')[0]).toBe('# RWA Sonar');
        expect(llms).toMatch(/^> .{80,}/m);
        const links = [...llms.matchAll(/^- \[[^\]]+\]\((https:\/\/[^)]+)\): \S/gm)].map((m) => m[1]);
        expect(links.length).toBeGreaterThan(30);
        for (const key of ['stocks', 'whatif', 'powers', 'exits', 'methodology', 'learn', 'watch']) {
            expect(links).toContain(pageUrl(ORIGIN, SITE_PAGES.find((page) => page.key === key)));
        }
        for (const url of [CONTACT_LINKS.x, CONTACT_LINKS.telegramGroup, CONTACT_LINKS.bot, CONTACT_LINKS.github]) expect(llms).toContain(url);
        expect(llms).not.toMatch(/mailto:/);
    });

    test('llms-full.txt carries the method, the pages, the data and the contact channels', () => {
        const full = readText('llms-full.txt');
        for (const text of ['claim depth', 'documented', 'inferred', 'Token-2022', 'https://rwasonar.com/sitemap.xml',
            'https://rwasonar.com/stocks-tokens.json', '/api/tokens', CONTACT_LINKS.telegramGroup, CONTACT_LINKS.bot]) {
            expect(full).toContain(text);
        }
    });
});

describe('generated families', () => {
    const tokenDb = readJson('stocks-tokens.json');
    const issuerDb = readJson('stocks-issuers.json');
    const templates = readJson('stocks-legal-templates.json').templates;
    const slugs = assignSlugs(tokenDb.tokens);
    const image = { url: 'https://rwasonar.com/x/og/a.0123456789ab.png', alt: 'Alt text for the page image', width: 1200, height: 630 };

    test('cards: Report + breadcrumb, a ≤160 description, their own image, the contact footer', () => {
        const token = tokenDb.tokens.find((row) => row.symbol === 'NVDAx');
        const card = buildCard({ token, issuer: issuerDb.issuers.find((row) => row.slug === token.issuer), slug: slugs.get(token.mint), builtAt: '2026-09-24T00:00:00Z' });
        const html = renderCard(card, { baseUrl: ORIGIN, ogImage: { path: 'cards/og/NVDAx.0123456789ab.png', alt: 'RWA Sonar card for NVDAx, the Kraken xStocks wrapper of NVDA' } });
        const types = expectCompleteSeo(seoOf(html), `${ORIGIN}/cards/NVDAx.html`);
        expect(types).toEqual(expect.arrayContaining(['Report', 'BreadcrumbList']));
        expect(seoOf(html).ogImage).toBe(`${ORIGIN}/cards/og/NVDAx.0123456789ab.png`);
        expectContactFooter(html);
    });

    test('issuer dossiers: unique titles, Report JSON-LD, the page image, the contact footer', () => {
        const titles = new Set();
        for (const issuer of issuerDb.issuers) {
            const html = renderIssuerPage({ issuer, tokens: tokenDb.tokens.filter((t) => t.issuer === issuer.slug), templates, builtAt: issuerDb.builtAt },
                { baseUrl: ORIGIN, ogImage: image });
            const seo = seoOf(html);
            expect(expectCompleteSeo(seo, `${ORIGIN}/issuers/${issuer.slug}.html`)).toContain('Report');
            expect(seo.ogImage).toBe(image.url);
            titles.add(seo.title);
            expectContactFooter(html);
        }
        expect(titles.size).toBe(issuerDb.issuers.length);
        const index = renderIssuerIndex(issuerDb.issuers, { baseUrl: ORIGIN, ogImage: image });
        expect(expectCompleteSeo(seoOf(index), `${ORIGIN}/issuers/`)).toContain('CollectionPage');
        expectContactFooter(index);
    });

    test('legal templates: unique titles, Report JSON-LD, the contact footer', () => {
        const titles = new Set(templates.map((template) => {
            const html = renderTemplatePage(template, { baseUrl: ORIGIN, cardSlugs: slugs, ogImage: image });
            expect(expectCompleteSeo(seoOf(html), `${ORIGIN}/templates/${template.id}.html`)).toContain('Report');
            expectContactFooter(html);
            return seoOf(html).title;
        }));
        expect(titles.size).toBe(templates.length);
        expect(expectCompleteSeo(seoOf(renderTemplateIndex(templates, { baseUrl: ORIGIN, ogImage: image })), `${ORIGIN}/templates/`)).toContain('CollectionPage');
    });

    test('protocol dossiers: unique titles, Report JSON-LD, the contact footer', () => {
        const dossiers = buildProtocolDossiers({ tokens: tokenDb.tokens, issuers: issuerDb.issuers, usage: readJson('stocks/data/defi-usage.json'),
            templates: readJson('stocks/data/composability-templates.json').templates });
        expect(dossiers.length).toBeGreaterThan(10);
        const titles = new Set(dossiers.map((dossier) => {
            const html = renderProtocolDossier(dossier, { baseUrl: ORIGIN, ogImage: image });
            expect(expectCompleteSeo(seoOf(html), `${ORIGIN}/protocols/${dossier.slug}.html`)).toContain('Report');
            expectContactFooter(html);
            return seoOf(html).title;
        }));
        expect(titles.size).toBe(dossiers.length);
        expect(expectCompleteSeo(seoOf(renderProtocolIndex(dossiers, { baseUrl: ORIGIN, ogImage: image })), `${ORIGIN}/protocols/`)).toContain('CollectionPage');
    });
});
