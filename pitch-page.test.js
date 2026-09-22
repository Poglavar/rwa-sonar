const { readFileSync } = require('node:fs');
const { join } = require('node:path');

describe('web-native pitch deck', () => {
    const html = readFileSync(join(__dirname, 'pitch', 'index.html'), 'utf8');
    const css = readFileSync(join(__dirname, 'pitch', 'pitch.css'), 'utf8');
    const js = readFileSync(join(__dirname, 'pitch', 'pitch.js'), 'utf8');

    test('is a concise, indexable eight-slide Stocklana product narrative', () => {
        expect((html.match(/<section id="slide-/g) || [])).toHaveLength(8);
        for (const heading of [
            "Don't trust the ticker.",
            'Same stock reference.',
            'AAPL comparison: answer first, evidence one click away.',
            'Monitoring is not the same as review.',
            'The ticker is familiar. The token is mysterious.',
            'Pilot users who need to rely on tokenized-stock evidence.'
        ]) expect(html).toContain(heading);
        expect(html).toContain('rel="canonical" href="https://rwasonar.com/pitch/"');
        expect(html).toContain('href="../stocks.html?view=compare&compare=AAPL"');
        expect(html).toContain('Stocklana main track');
        expect(html).toContain('25 Sep 2026, 4:00pm ET');
        expect(html).toContain('AAPLx');
        expect(html).toContain('AAPLon');
        expect(html).toContain('XspurdrAqbRJMQfAUEfh88QxE3XbSWxQGu3GneJR6e3');
        expect(html).toContain('PreStocks transfer fee 0.50%');
        expect(html).toContain('Stocklana main track first');
        expect(html).toContain('Code license choice remains pending owner confirmation');
        expect(html).toContain('https://github.com/Poglavar/rwa-sonar/tree/colosseum-worlds-fair');
        expect(html).toContain('<meta name="twitter:site" content="@RWASonar" />');
        expect(html).toContain('Follow @RWASonar');
        expect(html).toContain('href="https://x.com/RWASonar"');
        expect(html).not.toContain('Colosseum · 2026');
        expect(html).not.toContain('The token is an exact address, not a brand label.');
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
