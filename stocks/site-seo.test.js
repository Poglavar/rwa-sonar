// Tests for the site-wide SEO and preview-image plumbing: the shared head tags, JSON-LD and contact
// footer (lib/site-seo.mjs), the page image models, SVG determinism and both image stores
// (lib/page-og.mjs), the head/footer region rewriting, and one end-to-end run of
// build-site-seo.mjs against a temporary copy of the site with fixture families, checking the
// sitemaps it writes and that a second run changes nothing.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
    CONTACT_LINKS, META_DESCRIPTION_MAX, SITE_IMAGE, clampText, contactFooterHtml, jsonLdScript, readSeoRegion,
    replaceSeoRegion, seoHeadTags
} = require('./lib/site-seo.mjs');
const {
    claimPhrase, ensureStableOgImage, fmtUsdShort, issuerOgModel, keyControlSummary, pageOgAlt, pageOgModel,
    protocolOgModel, renderPageOgSvg, templateOgModel
} = require('./lib/page-og.mjs');
const { OG_HEIGHT, OG_WIDTH, loadFonts, ogImageFileName, ogImageHash } = require('./lib/og-image.mjs');
const { CONTACT_ONLY_PAGES, ensureRegions, sitemapIndexXml, urlsetXml } = require('./build-site-seo.mjs');
const { SITE_PAGES } = require('./lib/site-pages.mjs');

const REPO_ROOT = path.join(__dirname, '..');
const read = (...parts) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ...parts), 'utf8'));

let fonts;
beforeAll(async () => {
    fonts = await loadFonts();
});

describe('seoHeadTags', () => {
    const base = { title: 'X — RWA Sonar', description: 'd'.repeat(10), url: 'https://rwasonar.com/x.html' };

    test('emits every social and search tag with absolute URLs and the site image as fallback', () => {
        const html = seoHeadTags(base);
        for (const tag of ['<title>X — RWA Sonar</title>', '<link rel="canonical" href="https://rwasonar.com/x.html" />',
            '<meta property="og:url" content="https://rwasonar.com/x.html" />', '<meta property="og:site_name" content="RWA Sonar" />',
            `<meta property="og:image" content="${SITE_IMAGE.url}" />`, '<meta property="og:image:width" content="1200" />',
            '<meta property="og:image:height" content="630" />', '<meta property="og:image:type" content="image/png" />',
            '<meta name="twitter:card" content="summary_large_image" />', '<meta name="twitter:site" content="@RWASonar" />',
            '<meta name="twitter:creator" content="@RWASonar" />', `<meta name="twitter:image" content="${SITE_IMAGE.url}" />`]) {
            expect(html).toContain(tag);
        }
        expect(html).toMatch(/<meta property="og:image:alt" content="[^"]+" \/>/);
    });

    test('without an origin it states nothing absolute and falls back to a small card', () => {
        const html = seoHeadTags({ ...base, url: null, jsonLd: { a: 1 } });
        expect(html).not.toMatch(/canonical|og:url|og:image|ld\+json/);
        expect(html).toContain('<meta name="twitter:card" content="summary" />');
    });

    test('clamps the meta description to 160 characters at a word, but keeps a longer social one', () => {
        const long = `${'word '.repeat(60)}end`;
        const html = seoHeadTags({ ...base, description: long });
        const meta = html.match(/name="description" content="([^"]+)"/)[1];
        expect(meta.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX);
        expect(meta.endsWith('…')).toBe(true);
        expect(html.match(/og:description" content="([^"]+)"/)[1].length).toBeGreaterThan(META_DESCRIPTION_MAX);
        expect(clampText('short')).toBe('short');
    });

    test('escapes attribute values and keeps JSON-LD from closing its script element', () => {
        const html = seoHeadTags({ ...base, title: 'A "quoted" <b>', jsonLd: { name: '</script><script>alert(1)</script>' } });
        expect(html).toContain('<title>A &quot;quoted&quot; &lt;b&gt;</title>');
        expect(html.match(/<\/script>/g)).toHaveLength(1);
        expect(JSON.parse(jsonLdScript({ x: '</' }).replace(/^<script[^>]*>|<\/script>$/g, ''))).toEqual({ x: '</' });
    });
});

describe('contact footer', () => {
    test('carries X, the Telegram channel and group and GitHub, no alerts bot and no e-mail address', () => {
        const html = contactFooterHtml('../');
        for (const url of [CONTACT_LINKS.x, CONTACT_LINKS.telegramChannel, CONTACT_LINKS.telegramGroup, CONTACT_LINKS.github]) expect(html).toContain(`href="${url}"`);
        expect(html).toContain('RWA Sonar Watch');
        expect(html).not.toContain(`href="${CONTACT_LINKS.bot}"`);
        expect(html).not.toContain('watch.html');
        // Icons come from one shared sprite; every link still has an accessible name.
        for (const id of ['x', 'telegram', 'github']) expect(html).toMatch(new RegExp(`<use href="\\.\\./images/contact-icons\\.svg\\?v=[0-9a-z]+#${id}"/>`));
        expect(html.match(/<svg class="site-contact-icon" aria-hidden="true"/g)).toHaveLength(4);
        expect(html.match(/<a href="https:[^"]+"[^>]*aria-label="[^"]+"/g)).toHaveLength(4);
        expect(html).not.toMatch(/mailto:|@[a-z0-9-]+\.[a-z]{2,}/i);
    });
});

describe('regions', () => {
    const page = '<!doctype html><html><head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width" />\n'
        + '    <title>Old</title>\n    <meta name="description" content="old" />\n    <meta property="og:image" content="x" /><link rel="canonical" href="y" />\n'
        + '    <link rel="stylesheet" href="a.css" />\n</head><body class="p"><main>Body og:image text</main></body></html>';

    test('ensureRegions replaces legacy SEO tags with markers and leaves everything else alone', () => {
        const out = ensureRegions(page, { head: true, noscript: true, contact: true });
        expect(out).not.toMatch(/<title>Old|content="old"|og:image" content="x"|canonical/);
        expect(out).toContain('<link rel="stylesheet" href="a.css" />');
        expect(out).toContain('<main>Body og:image text</main>');
        expect(readSeoRegion(out, 'head')).toBe('');
        expect(out.indexOf('seo:noscript:start')).toBeGreaterThan(out.indexOf('<body class="p">'));
        expect(out.indexOf('seo:contact:end')).toBeLessThan(out.indexOf('</body>'));
        expect(ensureRegions(out, { head: true, noscript: true, contact: true })).toBe(out);
    });

    test('replaceSeoRegion refuses a page without its markers or with them twice', () => {
        expect(() => replaceSeoRegion(page, 'head', 'x')).toThrow(/not marked/);
        const twice = '<!-- seo:a:start --><!-- seo:a:end --><!-- seo:a:start --><!-- seo:a:end -->';
        expect(() => replaceSeoRegion(twice, 'a', 'x')).toThrow(/more than once/);
    });
});

describe('page image models', () => {
    test('a stat without a value is dropped, never drawn as zero', () => {
        const model = pageOgModel({ title: 'T', stats: [{ value: null, label: 'gone' }, { value: '0', label: 'kept zero' }] });
        expect(model.stats).toEqual([{ value: '0', label: 'kept zero', tone: null }]);
        expect(() => pageOgModel({ title: ' ' })).toThrow(/title/);
    });

    test('issuer: name, holder claim, documented answers of the catalogue, token count, key holders', () => {
        const issuer = read('stocks-issuers.json').issuers.find((row) => row.slug === 'xstocks-backed');
        const powerRow = read('stocks-power-map.json').issuers.find((row) => row.slug === 'xstocks-backed');
        const model = issuerOgModel({ issuer, tokenCount: 833, powerRow, questionCount: 38 });
        expect(model.title).toBe(issuer.name);
        expect(model.subtitle).toContain(claimPhrase(issuer.grades.claimRung));
        expect(model.stats[0].value).toBe(`${issuer.whatIfCounts.documented}/38`);
        expect(model.stats[1].value).toBe('833');
        expect(model.stats[2].value).toBe(keyControlSummary(powerRow));
        expect(keyControlSummary(powerRow)).toMatch(/^Mint: .+ · Freeze: /);
        expect(pageOgAlt(model)).toContain('Who holds the keys: Mint:');
    });

    test('protocol: token × protocol and a yes/no proof ladder', () => {
        const model = protocolOgModel({ symbol: 'AAPLx', slug: 's', integration: { protocolName: 'Kamino', actions: ['collateral'] },
            proof: { sourceStatus: 'exact-token-registry', accountCount: 2, existingAccountCount: 2, configurationDecoded: false, readOnlyExecutionSimulated: false } });
        expect(model.title).toBe('AAPLx × Kamino');
        expect(model.facts.map((fact) => fact.state)).toEqual(['yes', 'yes', 'no', 'no']);
    });

    test('template: issuer and recipe, inherited token count, review date', () => {
        const template = read('stocks-legal-templates.json').templates[0];
        const model = templateOgModel(template);
        expect(model.title).toContain(template.technologyRecipe);
        expect(model.stats[0].value).toBe(String(template.inheritance.count));
    });

    test('money is shortened, and a missing amount stays missing', () => {
        expect(fmtUsdShort(683594216)).toBe('$684M');
        expect(fmtUsdShort(2503912465)).toBe('$2.5B');
        expect(fmtUsdShort(null)).toBeNull();
    });
});

describe('page image SVG and stores', () => {
    const model = pageOgModel({ kicker: 'Test', title: 'A title that is long enough to wrap onto a second line of the image', subtitle: 'Sub',
        stats: [{ value: '1,183', label: 'tokens' }, { value: 'Mint: one key · Freeze: 2-of-4 multisig', label: 'who holds the keys' }], path: 'x.html' });

    test('is deterministic, 1200×630, font-only Inter, and the hash follows what is drawn', () => {
        const a = renderPageOgSvg(model, fonts);
        expect(renderPageOgSvg(model, fonts)).toBe(a);
        expect(a).toContain(`width="${OG_WIDTH}" height="${OG_HEIGHT}"`);
        expect(a).toContain('font-family="Inter"');
        const other = renderPageOgSvg(pageOgModel({ ...model, stats: [{ value: '1,184', label: 'tokens' }] }), fonts);
        expect(ogImageHash(other, fonts.digest)).not.toBe(ogImageHash(a, fonts.digest));
        expect(ogImageFileName('issuer', ogImageHash(a, fonts.digest))).toMatch(/^issuer\.[0-9a-f]{12}\.png$/);
    });

    test('the stable store renders once per drawing and names the file by the page key', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-og-'));
        const manifest = {};
        let renders = 0;
        const render = () => { renders += 1; return Buffer.from('png'); };
        const svg = renderPageOgSvg(model, fonts);
        const first = await ensureStableOgImage({ dir, key: 'home', svg, fontDigest: fonts.digest, render, manifest });
        const second = await ensureStableOgImage({ dir, key: 'home', svg, fontDigest: fonts.digest, render, manifest });
        expect(first).toEqual({ fileName: 'home.png', hash: ogImageHash(svg, fonts.digest), rendered: true });
        expect(second.rendered).toBe(false);
        expect(renders).toBe(1);
        const changed = await ensureStableOgImage({ dir, key: 'home', svg: `${svg} `, fontDigest: fonts.digest, render, manifest });
        expect(changed.rendered).toBe(true);
        expect(changed.hash).not.toBe(first.hash);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const hasResvg = fs.existsSync(path.join(__dirname, 'og', 'node_modules', '@resvg', 'resvg-js'));
    (hasResvg ? test : test.skip)('renders a real PNG of the right size, byte-identical twice', async () => {
        const { createOgRenderer } = await import('./og/render.mjs');
        const renderer = await createOgRenderer(fonts.files);
        const svg = renderPageOgSvg(model, fonts);
        const png = renderer.render(svg);
        expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
        expect(png.readUInt32BE(16)).toBe(1200);
        expect(png.readUInt32BE(20)).toBe(630);
        expect(png.byteLength).toBeLessThan(300 * 1024); // WhatsApp's preview limit
        expect(Buffer.compare(renderer.render(svg), png)).toBe(0);
    });
});

describe('sitemap XML', () => {
    test('urlset is sorted, escaped and dated only where a date exists', () => {
        const xml = urlsetXml([{ loc: 'https://a/b?x=1&y=2', lastmod: '2026-09-20' }, { loc: 'https://a/a', lastmod: null }]);
        expect(xml.indexOf('https://a/a')).toBeLessThan(xml.indexOf('https://a/b'));
        expect(xml).toContain('<loc>https://a/b?x=1&amp;y=2</loc><lastmod>2026-09-20</lastmod>');
        expect(xml).toContain('<url><loc>https://a/a</loc></url>');
        expect(sitemapIndexXml([{ loc: 'https://a/s.xml', lastmod: null }])).toContain('<sitemapindex');
    });
});

describe('build-site-seo.mjs end to end', () => {
    const ORIGIN = 'https://example.test';
    let root;

    function put(rel, content) {
        const file = path.join(root, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    }

    function run() {
        return spawnSync(process.execPath, [path.join(__dirname, 'build-site-seo.mjs'), '--run', `--base-url=${ORIGIN}`, `--root=${root}`, '--no-og-images'],
            { encoding: 'utf8' });
    }

    beforeAll(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'site-seo-'));
        for (const file of [...SITE_PAGES.map((page) => page.file), ...Object.keys(CONTACT_ONLY_PAGES)]) {
            put(file, fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
        }
        for (const file of ['stocks-tokens.json', 'stocks-issuers.json', 'stocks-health.json', 'stocks-power-map.json']) {
            put(file, fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
        }
        put('cards/index.json', [{ slug: 'AAPLx' }, { slug: 'A&B' }]);
        put('cards/AAPLx.json', { sources: { tokens: '2026-09-23T10:00:00Z', holders: '2026-09-20T08:00:00Z', meteora: null } });
        put('cards/A&B.json', { sources: {} });
        put('templates/index.json', [{ id: 't1', reviewedAt: '2026-09-19' }]);
        put('protocols/index.json', [{ slug: 'p1' }]);
        put('protocols/p1.json', { fetchedAt: '2026-09-22T01:02:03Z' });
        put('weekly/index.json', [
            { id: '2026-W38', start: '2026-09-14T00:00:00Z', end: '2026-09-21T00:00:00Z', inProgress: false, asOf: '2026-09-23T21:49:40Z' },
            { id: '2026-W39', start: '2026-09-21T00:00:00Z', end: '2026-09-28T00:00:00Z', inProgress: true, asOf: '2026-09-23T21:49:40Z' }
        ]);
    });

    afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

    test('refuses to run without a stated origin', () => {
        const out = spawnSync(process.execPath, [path.join(__dirname, 'build-site-seo.mjs'), '--run', `--root=${root}`], { encoding: 'utf8' });
        expect(out.status).toBe(1);
        expect(out.stderr + out.stdout).toMatch(/--base-url is required/);
    });

    test('rewrites every page head for the stated origin, with the site image when images are off', () => {
        const out = run();
        expect(out.status).toBe(0);
        for (const page of SITE_PAGES) {
            const html = fs.readFileSync(path.join(root, page.file), 'utf8');
            expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/${page.path}" />`);
            expect(html).toContain(`<meta property="og:image" content="${SITE_IMAGE.url}" />`);
            expect(html).toContain(`href="${CONTACT_LINKS.telegramGroup}"`);
        }
        for (const file of Object.keys(CONTACT_ONLY_PAGES)) {
            expect(fs.readFileSync(path.join(root, file), 'utf8')).toContain(`href="${CONTACT_LINKS.telegramGroup}"`);
        }
    });

    test('writes a sitemap index over every family, dated from the data', () => {
        const index = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8');
        for (const family of ['pages', 'cards', 'issuers', 'templates', 'protocols', 'weekly']) {
            expect(index).toContain(`<loc>${ORIGIN}/sitemaps/${family}.xml</loc>`);
        }
        const pages = fs.readFileSync(path.join(root, 'sitemaps/pages.xml'), 'utf8');
        for (const page of SITE_PAGES) expect(pages).toContain(`<loc>${ORIGIN}/${page.path}</loc>`);
        const tokensBuilt = read('stocks-tokens.json').builtAt.slice(0, 10);
        expect(pages).toContain(`<loc>${ORIGIN}/stocks.html</loc><lastmod>${tokensBuilt}</lastmod>`);
        const cards = fs.readFileSync(path.join(root, 'sitemaps/cards.xml'), 'utf8');
        expect(cards).toContain(`<loc>${ORIGIN}/cards/AAPLx.html</loc><lastmod>2026-09-23</lastmod>`);
        expect(cards).toContain(`<loc>${ORIGIN}/cards/A%26B.html</loc></url>`);
        const weekly = fs.readFileSync(path.join(root, 'sitemaps/weekly.xml'), 'utf8');
        expect(weekly).toContain(`<loc>${ORIGIN}/weekly/2026-W38.html</loc><lastmod>2026-09-21</lastmod>`);
        expect(weekly).toContain(`<loc>${ORIGIN}/weekly/2026-W39.html</loc><lastmod>2026-09-23</lastmod>`);
        const issuers = fs.readFileSync(path.join(root, 'sitemaps/issuers.xml'), 'utf8');
        expect(issuers.match(/<url>/g)).toHaveLength(read('stocks-issuers.json').issuers.length + 1);
        expect(fs.readFileSync(path.join(root, 'sitemaps/protocols.xml'), 'utf8')).toContain('<lastmod>2026-09-22</lastmod>');
    });

    test('a second run changes nothing', () => {
        const snapshot = () => [...SITE_PAGES.map((p) => p.file), 'sitemap.xml', 'sitemaps/pages.xml', 'sitemaps/cards.xml']
            .map((file) => fs.readFileSync(path.join(root, file), 'utf8'));
        const before = snapshot();
        expect(run().status).toBe(0);
        expect(snapshot()).toEqual(before);
    });
});
