const { readFileSync } = require('node:fs');
const { join } = require('node:path');

describe('web-native pitch deck', () => {
    const html = readFileSync(join(__dirname, 'pitch', 'index.html'), 'utf8');
    const css = readFileSync(join(__dirname, 'pitch', 'pitch.css'), 'utf8');
    const js = readFileSync(join(__dirname, 'pitch', 'pitch.js'), 'utf8');

    test('is a concise, indexable twelve-slide product narrative', () => {
        expect((html.match(/<section id="slide-/g) || [])).toHaveLength(12);
        for (const heading of [
            "Don't trust the ticker.",
            'The ticker is the least interesting part.',
            'Turn a familiar symbol into an inspectable system.',
            'The missing diligence layer.',
            'Make trust assumptions legible for every real-world asset.'
        ]) expect(html).toContain(heading);
        expect(html).toContain('rel="canonical" href="https://rwasonar.com/pitch/"');
        expect(html).toContain('href="../stocks.html?view=assets"');
        expect(html).toContain('Start with the stock, not an address');
        expect(html).toContain('Evidence and raw data on demand');
        expect(html).not.toContain('noindex');
        expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
    });

    test('supports presentation navigation, live counts, mobile layout and print-to-PDF', () => {
        expect(js).toContain("new URLSearchParams(location.search).get('api')");
        expect(js).toContain('fetch(`${apiOrigin}/api/health`');
        expect(js).toContain('IntersectionObserver');
        expect(js).toContain("event.key.toLowerCase() === 'o'");
        expect(css).toContain('@media (max-width: 900px)');
        expect(css).toContain('@media print');
        expect(css).toContain('size: 16in 9in');
    });
});
