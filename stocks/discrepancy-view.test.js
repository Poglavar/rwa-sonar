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

describe('protocol docs-versus-chain findings in the directory', () => {
    const S = require('./lib/discrepancy-view.js');
    const read = (file) => JSON.parse(readFileSync(join(REPO, file), 'utf8'));
    const research = read('stocks/data/protocol-market-research.json');
    const records = S.protocolDiscrepancyRecords(research, { protocolNames: S.protocolNamesFromUsage(read('stocks/data/defi-usage.json')) });
    const rows = S.discrepancyRows(read('stocks-issuers.json').issuers, read('stocks-tokens.json').tokens, records);
    const loopscale = rows.filter((row) => row.kind === 'protocol' && row.protocolId === 'loopscale');
    // The dossier pages are generated (gitignored), so check against the builder's own slugs.
    const { buildProtocolDossiers } = require('./lib/protocol-dossiers.mjs');
    const dossierSlugs = buildProtocolDossiers({ tokens: read('stocks-tokens.json').tokens, issuers: read('stocks-issuers.json').issuers,
        usage: read('stocks/data/defi-usage.json'), templates: read('stocks/data/composability-templates.json').templates,
        marketResearch: research }).map((dossier) => dossier.slug);

    it('reads the stored market records without copying or dropping their evidence', () => {
        const stored = research.markets.flatMap((market) => market.discrepancies ?? []);
        expect(records.map((row) => row.id)).toEqual(stored.map((row) => row.id));
        for (const [index, row] of records.entries()) {
            expect(row.claim).toBe(stored[index].claim);
            expect(row.reality).toBe(stored[index].reality);
            expect(row.observedAt).toBe(stored[index].observedAt);
        }
    });

    it('puts the Loopscale findings on SECZ with a link to the existing protocol dossier', () => {
        expect(loopscale.map((row) => row.id).sort()).toEqual(['loopscale-secrets-manager-role', 'loopscale-upgrade-multisig-threshold']);
        for (const row of loopscale) {
            expect(row).toMatchObject({ protocolName: 'Loopscale', affectedCount: 1, status: 'open', observedAt: '2026-09-23' });
            expect(row.affectedTokens[0].symbol).toBe('SECZ');
            expect(row.href).toBe('./protocols/secz-loopscale-loopscale-collateral-5vzwkk.html');
            expect(dossierSlugs).toContain(row.dossierSlug);
            expect(row.checkedAt).toBe('2026-09-23T19:31:59Z');
        }
        expect(S.filterDiscrepancyRows(rows, { asset: 'loopscale' })).toHaveLength(2);
        expect(S.filterDiscrepancyRows(rows, { asset: 'SECZ' })).toEqual(expect.arrayContaining(loopscale));
    });

    it('renders both sides with each source, its locator and access date, and the dossier link', () => {
        const html = S.discrepancyDirectoryHtml(loopscale);
        expect(html).toContain('Open protocol dossier');
        expect(html).toContain('href="./protocols/secz-loopscale-loopscale-collateral-5vzwkk.html"');
        expect(html).toContain('cannot initiate actions on its own');
        expect(html).toContain('datetime="2026-09-23T19:30:20Z"');
        expect(html).toContain('https://solscan.io/tx/3JGFRfzWr7zwjFZRitv4RX8fRmQubbLM3DH7RBouzuUyse9hyv9qkC71o3ZxTkm9rX6T6GjLtBgL6eYs4VCKLjp7');
        expect(html).not.toContain('Open issuer dossier');
    });

    it('gives a market without an integration id no dossier link rather than a guessed one', () => {
        const [row] = S.protocolDiscrepancyRecords({ markets: [{ protocolId: 'x', tokenMint: 'M', symbol: 'T',
            discrepancies: [{ id: 'd', title: 'Docs differ', claim: { text: 'a' }, reality: { text: 'b' } }] }] });
        expect(row).toMatchObject({ dossierSlug: null, protocolName: 'X' });
        expect(S.protocolDiscrepancyRecords(null)).toEqual([]);
    });
});
