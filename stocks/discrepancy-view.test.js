// Unit tests for stocks/lib/discrepancy-view.js: claims-versus-reality rows, filters and markup.
// Moved with the code out of stocks-page.test.js (next-steps.md F11), which still tests the page
// wiring that calls it.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const REPO = join(__dirname, '..');

const {
    discrepancyRows,
    filterDiscrepancyRows,
    discrepancyDirectoryHtml
} = require('./lib/discrepancy-view.js');

describe('claims-versus-reality directory', () => {
    const issuers = JSON.parse(readFileSync(join(REPO, 'stocks-issuers.json'), 'utf8')).issuers;
    const tokens = JSON.parse(readFileSync(join(REPO, 'stocks-tokens.json'), 'utf8')).tokens;
    const rows = discrepancyRows(issuers, tokens);

    it('publishes current outside-world conflicts with programme and token scope', () => {
        expect(rows.length).toBeGreaterThanOrEqual(5);
        expect(rows.every((row) => row.status === 'open')).toBe(true);
        expect(rows.every((row) => row.issuerSlug && row.issuerName && row.affectedCount > 0)).toBe(true);
        expect(rows.every((row) => row.claim?.text && row.reality?.text)).toBe(true);
    });

    it('filters independently by issuer, asset, impact and lifecycle state', () => {
        const first = rows[0];
        expect(filterDiscrepancyRows(rows, { issuer: first.issuerSlug })).toEqual(
            rows.filter((row) => row.issuerSlug === first.issuerSlug));
        expect(filterDiscrepancyRows(rows, { impact: first.holderImpact })).toContain(first);
        expect(filterDiscrepancyRows(rows, { status: 'resolved' })).toHaveLength(0);
        const token = first.affectedTokens[0];
        expect(filterDiscrepancyRows(rows, { asset: token.symbol || token.ticker || token.mint })).toContain(first);
    });

    it('keeps the claim, observed reality, source context and first-observed date together', () => {
        const html = discrepancyDirectoryHtml([rows[0]]);
        expect(html).toContain('Published claim');
        expect(html).toContain('Observed reality');
        expect(html).toContain('first observed');
        expect(html).toContain('Open issuer dossier');
    });

    it('escapes hostile discrepancy prose and refuses unsafe source URLs', () => {
        const html = discrepancyDirectoryHtml([{
            issuerSlug: 'issuer', issuerName: '<img src=x>', severity: 'warning', holderImpact: 'high',
            status: 'open', scope: 'issuer programme', affectedCount: 1, title: '<script>x</script>',
            claim: { text: '<b>claim</b>', sources: [{ label: '<i>bad</i>', url: 'javascript:alert(1)' }] },
            reality: { text: '<img src=x>', sources: [] }, impact: '<svg>risk</svg>', observedAt: '2026-09-22'
        }]);
        expect(html).not.toMatch(/<(?:script|img|svg|b|i)[ >]/);
        expect(html).not.toContain('javascript:');
        expect(html).toContain('&lt;script&gt;');
    });
});

describe('claim-versus-reality discrepancies', () => {
    const S = require('./lib/discrepancy-view.js');

    const fixture = {
        slug: 'fixture',
        discrepancies: [{
            id: 'scope',
            title: 'The published scope is broader than the implementation',
            severity: 'warning',
            observedAt: '2026-09-20',
            claim: {
                text: 'Every price is independently checked.',
                sources: [{ label: 'Product docs', url: 'https://example.com/docs', locator: 'Pricing', accessedAt: '2026-09-20' }]
            },
            reality: {
                text: 'The independent check covers only the settlement asset.',
                sources: [{ label: 'Program source', url: 'https://example.com/code', locator: 'validate()', accessedAt: '2026-09-20' }]
            },
            impact: 'The reference price remains inside the issuer trust boundary.'
        }]
    };

    it('puts the claim and observed reality side by side with a source for each', () => {
        const html = S.discrepanciesHtml(fixture);
        expect(html).toContain('Claim ≠ observed reality');
        expect(html).toContain('Published claim');
        expect(html).toContain('Observed reality');
        expect(html).toContain('https://example.com/docs');
        expect(html).toContain('https://example.com/code');
        expect(html).toContain('Why it matters');
    });

    it('escapes prose and refuses unsafe source URLs', () => {
        const hostile = structuredClone(fixture);
        hostile.discrepancies[0].claim.text = '<img src=x onerror=alert(1)>';
        hostile.discrepancies[0].claim.sources[0].url = 'javascript:alert(1)';
        const html = S.discrepanciesHtml(hostile);
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(html).not.toContain('<img');
        expect(html).not.toContain('href="javascript:');
    });

    it('keeps the card alert compact and opens the source-backed issuer dossier', () => {
        const html = S.discrepancyCalloutHtml(fixture);
        expect(html).toContain('data-slug="fixture"');
        expect(html).toContain('documented and source-backed');
        expect(html).not.toContain('Every price is independently checked');
    });
});
