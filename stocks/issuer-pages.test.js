const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { renderIssuerIndex, renderIssuerPage } = require('./lib/issuer-pages.mjs');

const root = join(__dirname, '..');
const issuers = JSON.parse(readFileSync(join(root, 'stocks-issuers.json'), 'utf8'));
const tokens = JSON.parse(readFileSync(join(root, 'stocks-tokens.json'), 'utf8'));
const templates = JSON.parse(readFileSync(join(root, 'stocks-legal-templates.json'), 'utf8'));

describe('canonical issuer dossiers', () => {
    const issuer = issuers.issuers.find((row) => row.slug === 'xstocks-backed');
    const issuerTokens = tokens.tokens.filter((row) => row.issuer === issuer.slug);
    const html = renderIssuerPage({ issuer, tokens: issuerTokens, templates: templates.templates, builtAt: issuers.builtAt },
        { baseUrl: 'https://rwasonar.com', version: 'test' });

    it('has a stable canonical URL and starts with the plain-English decision', () => {
        expect(html).toContain('rel="canonical" href="https://rwasonar.com/issuers/xstocks-backed.html"');
        expect(html).toContain('The short answer');
        expect(html).toContain('What do you own?');
        expect(html).toContain('Can you redeem?');
        expect(html).toContain('Can the issuer intervene?');
        expect(html).toContain('<meta name="twitter:site" content="@RWASonar" />');
        expect(html).toContain('href="https://x.com/RWASonar"');
    });

    it('states evidence context and keeps outside-world discrepancies visible', () => {
        expect(html).toContain('47 of 50 required fields sourced');
        expect(html).toContain('Unknown means not established, never “no”');
        expect(html).toContain('Published claim ≠ observed reality');
        expect(html).toContain('not a history of edits to RWA Sonar');
    });

    it('links each short answer to the relevant plain-language guide', () => {
        for (const guide of ['beneficial-ownership', 'redemption', 'issuer-control', 'bankruptcy-remoteness', 'defi-custody']) {
            expect(html).toContain(`../learn/${guide}.html`);
        }
    });

    it('links the reusable legal template and limits the initial asset wall', () => {
        expect(html).toContain('../templates/xstocks-backed--token-2022-pausable-clawback-rebase.html');
        expect(html).toContain('Browse the complete catalogue');
        expect((html.match(/<li><a href="\.\.\/cards\//g) || []).length).toBe(36);
        expect(html).not.toContain('[object Object]');
    });

    it('publishes an index containing every programme', () => {
        const index = renderIssuerIndex(issuers.issuers, { baseUrl: 'https://rwasonar.com' });
        for (const row of issuers.issuers) expect(index).toContain(`./${row.slug}.html`);
        expect(index).toContain('<meta name="twitter:site" content="@RWASonar" />');
    });
});
