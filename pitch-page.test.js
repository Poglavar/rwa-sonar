const { readFileSync } = require('node:fs');
const { join } = require('node:path');

describe('web-native pitch deck', () => {
    const html = readFileSync(join(__dirname, 'pitch', 'index.html'), 'utf8');
    const css = readFileSync(join(__dirname, 'pitch', 'pitch.css'), 'utf8');
    const js = readFileSync(join(__dirname, 'pitch', 'pitch.js'), 'utf8');

    test('is a concise, indexable eight-slide Stocklana product narrative', () => {
        expect((html.match(/<section id="slide-/g) || [])).toHaveLength(8);
        for (const heading of [
            'The ticker is familiar.',
            'The token is mysterious.',
            'Same stock reference.',
            'AAPL comparison: answer first, evidence one click away.',
            'Watchers detect changes. Analysts assess the consequences.',
            'What Solana reveals about each token',
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

    test('describes the product directly and keeps coverage and review qualifications', () => {
        for (const oldCopy of ['The token is not.', 'not a mock-up', 'not missing research',
            'Monitoring is not the same', 'not exhaustive market claims']) {
            expect(html).not.toContain(oldCopy);
        }
        expect(html).toContain('Other tokens may exist outside it.');
        expect(js).toContain('Other tokens may exist outside our coverage.');
        expect(html).toContain('only when an analyst records a review');
        expect(html).toContain('Actual lending requires its own evidence beyond a registry listing');
    });

    test('uses the wide night-watch scene on the existing cover, with text outside the image', () => {
        const cover = html.match(/<section id="slide-1"[\s\S]*?<\/section>/)?.[0];
        expect(cover).toBeTruthy();
        expect(cover).toContain('class="cover-art"');
        expect(cover).toContain('night-watch-v2-768.webp 768w');
        expect(cover).toContain('width="1536" height="1024"');
        expect(cover).toContain('<figcaption>The visible token is the tip of the structure.</figcaption>');
        expect(cover).not.toContain('loading="lazy"');
        expect(html).not.toContain('class="sonar-visual"');
    });

    // Read the actual CSS colors so changing a theme or its card bindings can fail this
    // regression. This checks the shared card palettes, not browser layout or all WCAG criteria.
    function declarations(selector) {
        return Object.assign({}, ...Array.from(css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g))
            .filter(([, selectors]) => selectors.split(',').map(s => s.trim()).includes(selector))
            .map(([, , body]) => Object.fromEntries(body.split(';').filter(s => s.includes(':'))
                .map(s => { const split = s.indexOf(':'); return [s.slice(0, split).trim(), s.slice(split + 1).trim()]; }))));
    }

    function contrast(foreground, background) {
        function luminance(color) {
            expect(color).toMatch(/^#[a-f\d]{6}$/i);
            const rgb = color.slice(1).match(/../g).map(c => parseInt(c, 16) / 255)
                .map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
            return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
        }
        const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
        return (values[0] + .05) / (values[1] + .05);
    }

    test.each(['paper', 'violet'])('shared cards keep readable text on the %s slide', theme => {
        const vars = { ...declarations(':root'), ...declarations('.dimension-grid'),
            ...(theme === 'violet' ? declarations('.slide-violet .dimension-grid') : {}) };
        const resolve = value => value.replace(/var\((--[\w-]+)\)/g, (_, name) => resolve(vars[name]));
        const card = declarations('.dimension-grid article');
        const background = resolve(card.background);
        for (const selector of ['.dimension-grid p', '.dimension-grid small', '.dimension-grid article > span']) {
            const foreground = resolve(declarations(selector).color);
            // Normal-size text minimum: https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
            expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
        }
        expect(declarations('.result-card.muted-card').opacity ?? '1').toBe('1');
    });

    test('small labels and the navigation hint retain readable contrast', () => {
        const vars = declarations(':root');
        const resolve = value => value.replace(/var\((--[\w-]+)\)/g, (_, name) => vars[name]);
        for (const selector of ['.window-top', '.change-label']) {
            expect(contrast(resolve(declarations(selector).color), vars['--panel'])).toBeGreaterThanOrEqual(4.5);
        }
        const hint = declarations('.keyboard-hint');
        expect(contrast(resolve(hint.color), resolve(hint.background))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(resolve(declarations('.cover-art figcaption').color), declarations('.cover-art').background)).toBeGreaterThanOrEqual(4.5);
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
