// Fast renderer, safety, cardinality and artwork-delivery contracts without a browser suite.
const { readFileSync, statSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const page = require('./economics.js');
const data = require('./stocks/data/economics.json');
const model = require('./stocks/lib/economics.js');

describe('economics research view', () => {
    test('a different xStock never inherits TSLAx fee figures', () => {
        const html = page.renderProfile(model.selectProfile(data, 'xstocks-backed'), { productSymbol: 'FGDLx' });
        expect(html).toContain('No FGDLx-specific fee is confirmed');
        expect(html).not.toContain('0.50%');
        expect(html).not.toContain('0.25%');
        expect(html).toContain('5%');
        expect(html).toContain('Contractual cap');
        expect(html).toContain('not an additional fee');
    });

    test('current issuer statement and future cap stay separate, with their own source context', () => {
        const html = page.renderProfile(model.selectProfile(data, 'xstocks-backed'), { productSymbol: 'TSLAx' });
        expect(html).toContain('None stated at present');
        expect(html).toContain('Up to 0.25% per year');
        expect(html).toContain('2025-06-30');
        expect(html).toContain('Source checked 2026-09-22');
        expect(html).toContain('https://assets.backed.fi/products/tesla-xstock');
    });

    test('unreviewed programme does not appear free or fully mapped', () => {
        const html = page.renderProfile(model.selectProfile(data, 'bullish'));
        expect(html).toContain('Economics review pending');
        expect(html).toContain('This does not mean the product is free');
        expect(html).toContain('Payment not established');
        expect(html).toContain('Unmapped does not mean free');
        expect(html).not.toContain('0%');
        expect(html).not.toContain('0.00');
    });

    test.each([1, 2, 3, 12])('renders all %i selected programmes and no silent pair limit', count => {
        const ids = data.profiles.slice(0, count).map(profile => profile.id);
        const html = page.renderSelection(data, ids);
        expect((html.match(/class="economics-profile"/g) || []).length).toBe(count);
        for (const id of ids) expect(html).toContain(`id="profile-${id}"`);
        if (count > 1) expect(html).toContain('profile-drilldown');
    });

    test('clear and invalid selections never silently choose a programme', () => {
        expect(page.renderSelection(data, [])).toContain('Choose one or more');
        expect(page.renderSelection(data, ['missing'])).toContain('Choose one or more');
        expect(page.selectedProfiles(data, ['prestocks', 'prestocks'])).toHaveLength(1);
    });

    test('observation dates and incentive uncertainty are visible without pretending a fresh observation', () => {
        const html = page.renderProfile(model.selectProfile(data, 'prestocks'));
        expect(html).toContain('Observed 2026-09-20');
        expect(html).toContain('Source checked 2026-09-17');
        expect(html).toContain('1% (100 basis points)');
        expect(html).toContain('Incentive analysis');
        expect(html).toContain('legal beneficiary');
        expect(html).toContain('Payment not established');
        expect(page.renderProfile(model.selectProfile(data, 'prestocks'))).toBe(html);
    });

    test('tax scope survives a token-specific context', () => {
        const html = page.renderProfile(model.selectProfile(data, 'ondo-global-markets'), { productSymbol: 'AAPLon' });
        expect(html).toContain('30% of applicable dividends, not of the investment');
        expect(html).toContain('Not an issuer fee or a statement of the token holder');
        expect(html).toContain('Tax, not issuer revenue');
    });

    test('long-term funding disclosure is separated from current financial condition', () => {
        const html = page.renderProfile(model.selectProfile(data, 'xstocks-backed'));
        expect(html).toContain('Recorded basis:');
        expect(html).toContain('dependent on capital and financing');
        expect(html).toContain('not a current financial statement');
        expect(html).toContain('s.2.3.2.1');
        expect(html).toContain('Incentive analysis');
    });

    test('escapes content and only links safe web source URLs', () => {
        const profile = { id: 'test', name: '<script>alert(1)</script>', coverage: 'initial-review', summary: 'a&b', fees: [{ id: 'x', stage: 'enter', label: '<img src=x>', amountText: null, scope: {}, sourceIds: ['x'] }], actors: [], gaps: [], sources: [{ id: 'x', url: 'javascript:alert(1)', label: '<source>' }] };
        const html = page.renderProfile(profile);
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('href="javascript:');
        expect(html).toContain('&lt;script&gt;');
        expect(page.safeSourceUrl('data:text/html,test')).toBeNull();
        expect(page.safeSourceUrl('https://example.com/')).toBe('https://example.com/');
    });

    test('load failures produce an explicit unavailable state instead of empty or zero fees', async () => {
        const elements = Object.fromEntries(['economicsResults', 'programmeSelect', 'programmeChoices', 'coverageLine', 'productContext', 'selectionCount'].map(id => [id, {}]));
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await page.start({ getElementById: id => elements[id] }, { fetch: async () => ({ ok: false, status: 503 }) });
            expect(elements.coverageLine.textContent).toBe('Economics research unavailable');
            expect(elements.economicsResults.innerHTML).toContain('could not be loaded');
            expect(elements.economicsResults.innerHTML).not.toContain('free');
        } finally { error.mockRestore(); }
    });
});

describe('graphics and integration', () => {
    test('delivers three real image assets, bounded WebP bytes and original masters', () => {
        let total = 0;
        for (const name of ['scout', 'iceberg', 'patrol']) {
            const base = join(__dirname, 'images/dolphin-detectives', `${name}-v1`);
            expect(readFileSync(`${base}.png`).subarray(1, 4).toString()).toBe('PNG');
            expect(readFileSync(`${base}.webp`).subarray(8, 12).toString()).toBe('WEBP');
            total += statSync(`${base}.webp`).size;
        }
        expect(total).toBeLessThan(500 * 1024);
        expect(existsSync(join(__dirname, 'design/dolphin-detectives/PROMPTS.md'))).toBe(true);
    });

    test('team scenes retain originals and keep responsive delivery under a shared byte budget', () => {
        let total = 0;
        for (const name of ['night-watch', 'survey-team']) {
            const base = join(__dirname, 'images/dolphin-detectives', `${name}-v2`);
            const master = readFileSync(`${base}.png`);
            expect(master.subarray(1, 4).toString()).toBe('PNG');
            expect([master.readUInt32BE(16), master.readUInt32BE(20)]).toEqual([1536, 1024]);
            for (const suffix of ['', '-768']) {
                const delivery = readFileSync(`${base}${suffix}.webp`);
                expect(delivery.subarray(8, 12).toString()).toBe('WEBP');
                total += delivery.length;
            }
            expect(statSync(`${base}-768.webp`).size).toBeLessThan(statSync(`${base}.webp`).size);
        }
        expect(total).toBeLessThan(350 * 1024);
        for (const name of ['scout-v1-384', 'patrol-v1-256']) {
            const spot = readFileSync(join(__dirname, 'images/dolphin-detectives', `${name}.webp`));
            expect(spot.subarray(8, 12).toString()).toBe('WEBP');
            expect(spot.length).toBeLessThan(20 * 1024);
        }
        expect(existsSync(join(__dirname, 'design/dolphin-detectives/INTEGRATION.md'))).toBe(true);
    });

    test('gallery distinguishes illustration from evidence and points to the six-slide pitch', () => {
        const gallery = readFileSync(join(__dirname, 'design/dolphin-detectives/index.html'), 'utf8');
        expect(gallery).toContain('Current findings, observation times and review status stay in their own panels.');
        expect(gallery).toContain('not a measured risk distribution');
        expect(gallery).toContain('The pitch is six slides.');
        expect(gallery).toContain('night-watch-v2-768.webp 768w');
        expect(gallery).toContain('survey-team-v2-768.webp 768w');
        expect(gallery).not.toContain('The existing pitch has not been edited');
        const pitch = readFileSync(join(__dirname, 'pitch/index.html'), 'utf8');
        expect((pitch.match(/<section id="slide-/g) || [])).toHaveLength(6);
    });

    test('all integrated artwork references resolve and use web delivery rather than PNG masters', () => {
        for (const file of ['index.html', 'pitch/index.html', 'methodology.html', 'learn/index.html',
            'watch.html', 'stocks.html', 'economics.html', 'design/dolphin-detectives/index.html']) {
            const html = readFileSync(join(__dirname, file), 'utf8');
            const images = [...html.matchAll(/<img\b[^>]*src="([^"]*dolphin-detectives[^\"]+)"[^>]*>/g)];
            expect(images.length).toBeGreaterThan(0);
            for (const [tag, src] of images) {
                expect(src).toMatch(/\.webp$/);
                expect(existsSync(join(__dirname, file, '..', src))).toBe(true);
                expect(tag).toMatch(/width="\d+"/);
                expect(tag).toMatch(/height="\d+"/);
                expect(tag).toMatch(/alt="[^"]*"/);
            }
        }
    });

    test('economics is reachable from the main surfaces', () => {
        for (const file of ['index.html', 'stocks.html', 'stocks.js']) expect(readFileSync(join(__dirname, file), 'utf8')).toContain('./economics.html');
        const html = readFileSync(join(__dirname, 'economics.html'), 'utf8');
        expect(html.indexOf('stocks/lib/economics.js')).toBeLessThan(html.indexOf('src="./economics.js'));
        expect(html).toContain('it does not add a new collector');
    });
});
