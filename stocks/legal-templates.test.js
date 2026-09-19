// Tests the reusable legal-template layer against the real issuer/token build and verifies that
// its static pages expose scope, precedence, insolvency, corporate actions and redemption evidence.

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const {
    DOCUMENT_PRECEDENCE,
    EVIDENCE_LEVELS,
    buildLegalTemplates,
    documentAuthority
} = require('./lib/legal-templates.mjs');
const { renderTemplateIndex, renderTemplatePage } = require('./lib/template-pages.mjs');

const read = (...parts) => JSON.parse(readFileSync(join(__dirname, '..', ...parts), 'utf8'));
const issuerDb = read('stocks-issuers.json');
const tokenDb = read('stocks-tokens.json');
const composability = read('stocks', 'data', 'composability-templates.json');
const templates = buildLegalTemplates({
    templates: composability.templates.map((row) => ({ ...row, reviewedAt: composability.reviewedAt })),
    issuers: issuerDb.issuers,
    tokens: tokenDb.tokens,
    archives: {}
});

describe('legal template records', () => {
    it('covers every current mint exactly once across the nine reviewed issuer/recipe templates', () => {
        expect(templates).toHaveLength(9);
        expect(templates.reduce((sum, row) => sum + row.inheritance.count, 0)).toBe(tokenDb.tokens.length);
        const mints = templates.flatMap((row) => row.inheritance.items.map((item) => item.mint));
        expect(new Set(mints).size).toBe(tokenDb.tokens.length);
    });

    it('keeps inheritance explicit and does not manufacture asset exceptions', () => {
        for (const template of templates) {
            expect(template.inheritance.count).toBeGreaterThan(0);
            expect(template.inheritance.underlyingCount).toBeGreaterThan(0);
            expect(template.inheritance.exceptions).toEqual([]);
            expect(template.technologyRecipe).toMatch(/^token-2022/);
        }
    });

    it('carries a claim chain and all six independently graded evidence facets', () => {
        for (const template of templates) {
            expect(template.claimChain.nodes.length).toBeGreaterThan(0);
            expect(template.claimChain.links.length).toBeGreaterThan(0);
            expect(template.evidenceConfidence.map((row) => row.id)).toEqual([
                'ownership', 'custody', 'eligibility', 'redemption', 'corporateActions', 'technicalControl'
            ]);
            expect(template.evidenceConfidence.find((row) => row.id === 'technicalControl').level)
                .toBe('onchain-observation');
        }
        const ondo = templates.find((row) => row.issuer.slug === 'ondo-global-markets');
        expect(ondo.claimChain.nodes.find((node) => node.actor === 'security-agent').parties[0].name)
            .toMatch(/Ankura/);
        expect(ondo.insolvency.operationalDetails.perfectionOrPriority).toMatch(/first-priority perfected/i);
    });

    it('states document precedence and retains missing version/effective-date metadata as gaps', () => {
        expect(DOCUMENT_PRECEDENCE).toHaveLength(6);
        expect(DOCUMENT_PRECEDENCE[0].label).toMatch(/Mandatory law/);
        expect(documentAuthority({ type: 'terms', title: 'Terms' })).toBe('binding-legal');
        expect(documentAuthority({ type: 'press', title: 'Launch' })).toBe('third-party-claim');
        expect(templates.some((template) => template.sourceAuthority.sources.some((source) => source.version === null)))
            .toBe(true);
    });

    it('does not confuse a documented redemption route with an observed completed redemption', () => {
        expect(templates.every((template) => template.redemption.evidenceStatus === 'documented-process')).toBe(true);
        expect(templates.every((template) => template.redemption.evidenceLabel.includes('no independently observed'))).toBe(true);
    });

    it('uses only declared evidence levels', () => {
        const allowed = new Set(EVIDENCE_LEVELS.map((row) => row.id));
        for (const facet of templates.flatMap((template) => template.evidenceConfidence)) {
            expect(allowed.has(facet.level)).toBe(true);
        }
    });
});

describe('legal template pages', () => {
    const ondo = templates.find((row) => row.issuer.slug === 'ondo-global-markets');
    const page = renderTemplatePage(ondo, { baseUrl: 'https://rwasonar.com', version: 'test' });

    it('renders every required legal-analysis section and canonical identity', () => {
        for (const heading of [
            'What this analysis covers', 'Evidence confidence', 'Complete claim chain',
            'Jurisdiction and holder eligibility', 'Insolvency and enforcement',
            'Corporate actions', 'Redemption path', 'Source authority and precedence'
        ]) expect(page).toContain(heading);
        expect(page).toContain(`<link rel="canonical" href="https://rwasonar.com/templates/${ondo.id}.html" />`);
        expect(page).toContain('no independently observed completed redemption');
    });

    it('escapes analysis and source text', () => {
        const hostile = structuredClone(ondo);
        hostile.summary = '<img src=x onerror=alert(1)>';
        hostile.sourceAuthority.sources[0].title = '<script>alert(1)</script>';
        const html = renderTemplatePage(hostile);
        expect(html).not.toContain('<img src=x');
        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).toContain('&lt;img');
        expect(html).toContain('&lt;script&gt;');
    });

    it('renders one catalogue card and stable detail link per template', () => {
        const html = renderTemplateIndex(templates, { baseUrl: 'https://rwasonar.com' });
        for (const template of templates) {
            expect(html).toContain(`./${template.id}.html`);
        }
        expect(html.match(/class="template-card"/g)).toHaveLength(templates.length);
    });
});
