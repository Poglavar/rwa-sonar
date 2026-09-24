// Guards the learning hub and six explainers as substantive, indexable pages rather than thin SEO shells.

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const GUIDES = [
    ['beneficial-ownership.html', 'Do you own the share?', 'Whose name appears on the company'],
    ['bankruptcy-remoteness.html', 'What if the issuer fails?', 'Which legal entity owns the underlying shares?'],
    ['redemption.html', 'Can you turn it into cash?', 'Who is legally entitled to redeem'],
    ['issuer-control.html', 'Who can override your wallet?', 'Which extensions are active now'],
    ['oracle-risk.html', 'What does the price prove?', 'Which instrument does this number price'],
    ['defi-custody.html', 'Does protocol custody mean control?', 'Is this exact mint currently enabled']
];

function visibleWords(html) {
    return html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').trim().split(/\s+/).filter(Boolean);
}

describe('layperson learning hub', () => {
    const hub = readFileSync(join(__dirname, 'learn', 'index.html'), 'utf8');

    test('links all six distinct concepts into a suggested reading path', () => {
        for (const [file] of GUIDES) expect(hub).toContain(`href="./${file}"`);
        expect(hub).toContain('Three passes through any token');
        expect(hub).toContain('rel="canonical" href="https://rwasonar.com/learn/"');
    });
    test('uses a small intrinsic-size decorative scout illustration', () => {
        expect(hub).toContain('scout-v1-384.webp');
        expect(hub).toContain('width="384" height="256"');
        expect(hub).toContain('alt="" decoding="async"');
    });
});
describe.each(GUIDES)('%s', (file, heading, diagnosticQuestion) => {
    const html = readFileSync(join(__dirname, 'learn', file), 'utf8');

    test('is substantive, indexable and evidence-oriented', () => {
        expect(html).toContain(`<h1>${heading}</h1>`);
        expect(html).toContain(diagnosticQuestion);
        expect(html).toContain('The shortest useful answer');
        expect(html).toContain('How RWA Sonar shows it');
        expect(html).toContain('Questions to ask');
        expect(html).toContain(`rel="canonical" href="https://rwasonar.com/learn/${file}"`);
        expect(html).not.toContain('noindex');
        expect(html).not.toMatch(/<script(?![^>]*\s(?:src=|type="application\/ld\+json"))/); // JSON-LD is inert data
        expect(visibleWords(html).length).toBeGreaterThan(500);
    });
});
