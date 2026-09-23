const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { renderIssuerIndex, renderIssuerPage } = require('./lib/issuer-pages.mjs');
const { renderTemplatePage } = require('./lib/template-pages.mjs');
const { assignSlugs } = require('./lib/cards.mjs');

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
        expect(html).toContain('Route currently available');
        expect(html).toContain('Successful redemption independently observed');
        expect(html).toContain('Asset-specific; inspect the exact-token report');
        expect(html).toContain('Can the issuer intervene?');
        expect(html).toContain('../economics.html?issuer=xstocks-backed');
        expect(html).toContain('<meta name="twitter:site" content="@RWASonar" />');
        expect(html).toContain('href="https://x.com/RWASonar"');
    });

    it('states evidence context and keeps outside-world discrepancies visible', () => {
        // Derived from the record, not typed: research raises the sourced count over time.
        const { sourced, needed } = issuer.evidence.coverage;
        expect(Number.isInteger(sourced) && Number.isInteger(needed) && needed > 0).toBe(true);
        expect(html).toContain(`${sourced} of ${needed} required fields sourced`);
        expect(html).toContain('Unknown means not established, never “no”');
        expect(html).toContain('Published claim ≠ observed reality');
        expect(html).toContain('not a history of edits to RWA Sonar');
    });

    it('labels the TSLAx fee as a programme example instead of an issuer-wide term', () => {
        expect(html).toContain('Product example only — TSLAx; no programme-wide fee is confirmed.');
        expect(html).toContain('<details class="redemption-term">');
        expect(html).toContain('0.50%');
    });

    it('shows the effective signer behind each installed control path', () => {
        expect(html).toContain('Who can exercise token controls');
        expect(html).toContain('Unattributed direct signer S7vYFF');
        expect(html).toContain('2 of 4');
        expect(html).toContain('initiate-only members are not counted as voters');
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

describe('asset chips link to the card file build-cards writes', () => {
    // A symbol shared by two mints (FWDI, COPX) gets `<symbol>-<mint prefix>.html`; a bare
    // `<symbol>.html` link was a live 404 on the Backpack issuer and template pages (2026-09-23).
    const cardSlugs = assignSlugs(tokens.tokens);
    const written = new Set(cardSlugs.values());
    const cardLinks = (html) => [...html.matchAll(/href="\.\.\/cards\/([^"]+)\.html"/g)].map((m) => decodeURIComponent(m[1]));

    it('every issuer page links only to existing cards', () => {
        for (const issuer of issuers.issuers) {
            const html = renderIssuerPage({ issuer, tokens: tokens.tokens.filter((row) => row.issuer === issuer.slug), templates: templates.templates },
                { cardSlugs });
            for (const slug of cardLinks(html)) expect(written.has(slug) ? slug : `missing card ${slug} on ${issuer.slug}`).toBe(slug);
        }
    });

    it('every template page links only to existing cards', () => {
        for (const template of templates.templates) {
            for (const slug of cardLinks(renderTemplatePage(template, { cardSlugs }))) {
                expect(written.has(slug) ? slug : `missing card ${slug} on ${template.id}`).toBe(slug);
            }
        }
    });
});
