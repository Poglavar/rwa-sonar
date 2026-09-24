// Tests for the per-token social preview images: font metrics and text fitting, the image model
// (what it draws, and that prices/clocks cannot churn its hash), SVG determinism and bounds, the
// incremental store, the indexed-PNG encoder, the card meta tags, and — when stocks/og's resvg is
// installed — one real render checked for size and dimensions.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const {
    OG_HEIGHT, OG_WIDTH, ensureOgImage, fitSize, freezeFact, loadFonts, ogImageAlt, ogImageHash, ogImageModel,
    pruneOgImages, redemptionFact, renderOgSvg, textWidth, truncateToWidth, wrapToWidth
} = require('./lib/og-image.mjs');
const { encodeIndexedPng } = require('./lib/png-indexed.mjs');
const { OG_IMAGE_ALT, OG_IMAGE_PATH, assignSlugs, buildCard, renderCard } = require('./lib/cards.mjs');

const REPO_ROOT = path.join(__dirname, '..');
const read = (...parts) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ...parts), 'utf8'));
const tokenDb = read('stocks-tokens.json');
const issuers = new Map(read('stocks-issuers.json').issuers.map((row) => [row.slug, row]));
const SLUGS = assignSlugs(tokenDb.tokens);

function cardFor(symbol) {
    const token = tokenDb.tokens.find((row) => row.symbol === symbol);
    if (!token) throw new Error(`no token ${symbol}`);
    return buildCard({ token, issuer: issuers.get(token.issuer) ?? null, slug: SLUGS.get(token.mint), builtAt: '2026-09-24T00:00:00Z' });
}

function hasResvg() {
    return fs.existsSync(path.join(__dirname, 'og', 'node_modules', '@resvg', 'resvg-js'));
}

/** Decodes the PNGs encodeIndexedPng writes (8-bit palette, filter 0) back to 0xRRGGBB per pixel. */
function decodeIndexed(png) {
    let at = 8;
    let width = 0;
    let height = 0;
    let palette = null;
    const idat = [];
    while (at < png.length) {
        const length = png.readUInt32BE(at);
        const type = png.toString('latin1', at + 4, at + 8);
        const data = png.subarray(at + 8, at + 8 + length);
        const crc = png.readUInt32BE(at + 8 + length);
        expect(zlib.crc32(png.subarray(at + 4, at + 8 + length)) >>> 0).toBe(crc);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            expect([data[8], data[9]]).toEqual([8, 3]);
        }
        if (type === 'PLTE') palette = data;
        if (type === 'IDAT') idat.push(data);
        at += 12 + length;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const out = [];
    for (let y = 0; y < height; y += 1) {
        expect(raw[y * (width + 1)]).toBe(0);
        for (let x = 0; x < width; x += 1) {
            const i = raw[y * (width + 1) + 1 + x];
            out.push((palette[3 * i] << 16) | (palette[3 * i + 1] << 8) | palette[3 * i + 2]);
        }
    }
    return { width, height, pixels: out };
}

let fonts;
beforeAll(async () => {
    fonts = await loadFonts();
});

describe('font metrics and fitting', () => {
    it('measures real advance widths from the bundled Inter', () => {
        const m = fonts.metrics[700];
        expect(textWidth(m, 'W', 100)).toBeGreaterThan(textWidth(m, 'i', 100) * 2);
        expect(textWidth(m, 'NVDAx', 40)).toBeCloseTo(textWidth(m, 'NVDAx', 20) * 2, 5);
        // Heavier weights are wider, which is why each weight is measured with its own file.
        expect(textWidth(fonts.metrics[800], 'Holder concentration', 24)).toBeGreaterThan(textWidth(fonts.metrics[500], 'Holder concentration', 24));
        expect(textWidth(m, 'ab', 20, 5)).toBeCloseTo(textWidth(m, 'ab', 20) + 5, 5);
    });

    it('wraps into the line budget and never lets a line overflow', () => {
        const m = fonts.metrics[800];
        const long = 'An unsecured claim against the token issuer — not a share in the company, repeated until it cannot possibly fit';
        const lines = wrapToWidth(m, long, 30, 500, 3);
        expect(lines).toHaveLength(3);
        for (const line of lines) expect(textWidth(m, line, 30)).toBeLessThanOrEqual(500);
        expect(lines[2].endsWith('…')).toBe(true);
        expect(wrapToWidth(m, long, 30, 500, 1)).toHaveLength(1);
        expect(wrapToWidth(m, 'short', 30, 500, 3)).toEqual(['short']);
    });

    it('truncates with an ellipsis only when needed and shrinks to fit', () => {
        const m = fonts.metrics[500];
        expect(truncateToWidth(m, 'NVIDIA xStock', 30, 1000)).toBe('NVIDIA xStock');
        const cut = truncateToWidth(m, 'Forward Industries tokenized common stock (Superstate Opening Bell)', 30, 400);
        expect(cut.endsWith('…')).toBe(true);
        expect(textWidth(m, cut, 30)).toBeLessThanOrEqual(400);
        const size = fitSize(fonts.metrics[800], 'SUPERLONGSYMBOLNAME-7GzQgf', 1072, 96, 48);
        expect(size).toBeLessThan(96);
        expect(fitSize(fonts.metrics[800], 'SPYx', 1072, 96, 48)).toBe(96);
    });
});

describe('the image model', () => {
    it('draws the token, issuer, health, claim rung and key facts from the real NVDAx card', () => {
        const model = ogImageModel(cardFor('NVDAx'));
        expect(model).toMatchObject({ symbol: 'NVDAx', underlyingTicker: 'NVDA', issuer: 'Kraken xStocks', claimRung: 2 });
        expect(['good', 'caution', 'warning', 'unknown']).toContain(model.status);
        expect(model.claim).toBe('A claim secured over collateral — not the underlying share itself');
        expect(model.facts[0]).toMatch(/^Freeze key: \d+-of-\d+ multisig · clawback enabled$/);
        expect(model.facts.length).toBeGreaterThanOrEqual(2);
        expect(model.facts.length).toBeLessThanOrEqual(3);
        const alt = ogImageAlt(model);
        expect(alt).toContain('NVDAx');
        expect(alt).toContain('rung 2 of 4');
    });

    it('describes freeze-key governance and redemption evidence in plain words', () => {
        const auth = (capability, type, threshold = null) => ({ authorityAttribution: { authorities: [
            { id: 'freeze', technicalCapability: capability, governance: { type, signerThreshold: threshold } }] } });
        expect(freezeFact(auth('present', 'multisig', '2 of 5 eligible voters (7 members)'))).toBe('Freeze key: 2-of-5 multisig');
        expect(freezeFact(auth('present', 'hot-key'))).toBe('Freeze key: one hot wallet');
        expect(freezeFact({ ...auth('present', 'program'), control: { clawback: true } })).toBe('Freeze key: held by a program · clawback enabled');
        expect(freezeFact(auth('absent', 'unknown'))).toBe('No freeze key on this mint');
        expect(freezeFact(auth('unknown', 'unknown'))).toBe('Freeze power not established');
        const own = (feed, available = true) => ({ ownership: { redemption: { available }, redemptionFeed: feed } });
        expect(redemptionFact(own({ state: 'observed' }))).toBe('Redemptions observed on-chain');
        expect(redemptionFact(own({ state: 'not-observable' }))).toBe('Redemption documented; not observable on-chain');
        expect(redemptionFact(own(null))).toBe('Redemption documented, not independently observed');
        expect(redemptionFact(own(null, false))).toBe('No holder redemption right recorded');
        expect(ogImageModel({ ...own(null), control: { paused: true } }).facts[0]).toBe('Paused right now: transfers are halted');
    });

    it('keeps the hash when only prices move, and changes it when the health status does', () => {
        const card = cardFor('SPYx');
        const hashOf = (c) => ogImageHash(renderOgSvg(ogImageModel(c), fonts), fonts.digest);
        const moved = structuredClone(card);
        moved.reference.usdPrice = 1;
        moved.depth.liquidityUsd = 123;
        moved.builtAt = '2030-01-01T00:00:00Z';
        expect(hashOf(moved)).toBe(hashOf(card));
        const flipped = structuredClone(card);
        flipped.health.status = card.health.status === 'warning' ? 'good' : 'warning';
        expect(hashOf(flipped)).not.toBe(hashOf(card));
        expect(ogImageHash('<svg/>', 'other fonts')).not.toBe(ogImageHash('<svg/>', fonts.digest));
    });
});

describe('the SVG', () => {
    it('is deterministic, escaped, 1200×630 and keeps every line inside the canvas', () => {
        const model = { ...ogImageModel(cardFor('AAPLon')), name: 'Apple & <Co> "tokenized"' };
        const svg = renderOgSvg(model, fonts);
        expect(renderOgSvg(model, fonts)).toBe(svg);
        expect(svg).toContain(`width="${OG_WIDTH}" height="${OG_HEIGHT}"`);
        expect(svg).toContain('Apple &amp; &lt;Co&gt; &quot;tokenized&quot;');
        expect(svg).toContain('rwasonar.com');
        const texts = [...svg.matchAll(/<text x="([\d.-]+)" y="[\d.]+" font-size="(\d+)" font-weight="(\d+)"([^>]*)>([^<]*)<\/text>/g)];
        expect(texts.length).toBeGreaterThan(8);
        const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
        for (const [, x, size, weight, attrs, content] of texts) {
            const end = attrs.includes('text-anchor="end"');
            const width = textWidth(fonts.metrics[weight], unescape(content), Number(size));
            const left = end ? Number(x) - width : Number(x);
            expect(left).toBeGreaterThanOrEqual(56);
            expect(left + width).toBeLessThanOrEqual(OG_WIDTH - 56);
        }
    });
});

describe('incremental store', () => {
    it('renders once, reuses an unchanged image and prunes superseded ones', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-store-'));
        let calls = 0;
        const render = () => {
            calls += 1;
            return Buffer.from('png');
        };
        const first = await ensureOgImage({ dir, slug: 'NVDAx', svg: '<svg>a</svg>', fontDigest: 'f', render });
        const again = await ensureOgImage({ dir, slug: 'NVDAx', svg: '<svg>a</svg>', fontDigest: 'f', render });
        expect(first).toMatchObject({ rendered: true, bytes: 3 });
        expect(again).toMatchObject({ rendered: false, fileName: first.fileName });
        expect(first.fileName).toMatch(/^NVDAx\.[0-9a-f]{12}\.png$/);
        expect(calls).toBe(1);
        const changed = await ensureOgImage({ dir, slug: 'NVDAx', svg: '<svg>b</svg>', fontDigest: 'f', render });
        expect(changed.fileName).not.toBe(first.fileName);
        expect(calls).toBe(2);
        fs.writeFileSync(path.join(dir, 'GONE.aaaaaaaaaaaa.png.tmp-1'), 'x');
        expect(await pruneOgImages(dir, new Set([changed.fileName]))).toBe(2);
        expect(fs.readdirSync(dir)).toEqual([changed.fileName]);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe('indexed PNG encoder', () => {
    it('round-trips an image of up to 256 colours exactly', () => {
        const width = 40;
        const height = 7;
        const rgba = Buffer.alloc(width * height * 4);
        const expected = [];
        for (let i = 0; i < width * height; i += 1) {
            const color = ((i % 200) * 0x010203) & 0xffffff;
            rgba.writeUInt32BE(((color << 8) | 0xff) >>> 0, 4 * i);
            expected.push(color);
        }
        const { png, colors, exact } = encodeIndexedPng(rgba, width, height);
        expect(colors).toBe(200);
        expect(exact).toBe(1);
        const decoded = decodeIndexed(png);
        expect([decoded.width, decoded.height]).toEqual([width, height]);
        expect(decoded.pixels).toEqual(expected);
    });

    it('maps colours beyond the palette to the nearest entry and composites alpha over white', () => {
        const width = 300;
        const rgba = Buffer.alloc(width * 4);
        for (let i = 0; i < width; i += 1) rgba.set([i % 256, 0, 0, 255], 4 * i);
        // Three transparent pixels: frequent enough for white to earn a palette slot.
        for (const i of [0, 1, 2]) rgba.set([0, 0, 0, 0], 4 * i);
        const { png, exact } = encodeIndexedPng(rgba, width, 1);
        expect(exact).toBeLessThan(1);
        const { pixels } = decodeIndexed(png);
        expect(pixels[0]).toBe(0xffffff);
        for (let i = 3; i < width; i += 1) expect(Math.abs((pixels[i] >> 16) - (i % 256))).toBeLessThanOrEqual(2);
        expect(() => encodeIndexedPng(Buffer.alloc(3), 1, 1)).toThrow();
    });
});

describe('card meta tags', () => {
    const card = cardFor('NVDAx');
    it('points og:image and twitter:image at the token image, with size and alt', () => {
        const html = renderCard(card, { baseUrl: 'https://rwasonar.com', version: 'v', ogImage: { path: 'cards/og/NVDAx.0123456789ab.png', alt: 'NVDAx & co' } });
        expect(html).toContain('<meta property="og:image" content="https://rwasonar.com/cards/og/NVDAx.0123456789ab.png" />');
        expect(html).toContain('<meta name="twitter:image" content="https://rwasonar.com/cards/og/NVDAx.0123456789ab.png" />');
        expect(html).toContain('<meta property="og:image:width" content="1200" /><meta property="og:image:height" content="630" />');
        expect(html).toContain('<meta property="og:image:alt" content="NVDAx &amp; co" />');
        expect(html).toContain('<meta name="twitter:image:alt" content="NVDAx &amp; co" />');
        expect(html).not.toContain(OG_IMAGE_PATH);
    });

    it('falls back to the site image when no token image exists, and emits nothing without an origin', () => {
        const html = renderCard(card, { baseUrl: 'https://rwasonar.com', version: 'v', ogImage: null });
        expect(html).toContain(`<meta property="og:image" content="https://rwasonar.com/${OG_IMAGE_PATH}" />`);
        expect(html).toContain(`<meta property="og:image:alt" content="${OG_IMAGE_ALT}" />`);
        const anonymous = renderCard(card, { baseUrl: null, version: 'v', ogImage: { path: 'cards/og/x.png', alt: 'x' } });
        expect(anonymous).not.toContain('og:image');
    });
});

(hasResvg() ? describe : describe.skip)('real render (stocks/og installed)', () => {
    it('produces a 1200×630 indexed PNG under 60 kB', async () => {
        const { createOgRenderer } = await import('./og/render.mjs');
        const renderer = await createOgRenderer(fonts.files);
        const png = renderer.render(renderOgSvg(ogImageModel(cardFor('FWDI')), fonts));
        expect(png.subarray(1, 4).toString()).toBe('PNG');
        expect(png.readUInt32BE(16)).toBe(1200);
        expect(png.readUInt32BE(20)).toBe(630);
        expect(png.length).toBeLessThanOrEqual(60 * 1024);
        expect(Buffer.compare(png, renderer.render(renderOgSvg(ogImageModel(cardFor('FWDI')), fonts)))).toBe(0);
    }, 30000);
});
