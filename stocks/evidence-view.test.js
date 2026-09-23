// Unit tests for stocks/lib/evidence-view.js: the evidence chips, the popovers and the provenance
// summary. Moved with the code out of stocks-page.test.js (next-steps.md F11), which still tests
// the page wiring that calls it.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const REPO = join(__dirname, '..');

const {
    escapeHtml
} = require('./lib/fmt.js');
const {
    provenanceSummary,
    provenanceHtml
} = require('./lib/evidence-view.js');

describe('layperson discovery helpers', () => {
    it('exposes authority, evidence type, checked time, holder scope, jurisdiction and conflicts together', () => {
        const issuer = {
            entityJurisdiction: 'British Virgin Islands',
            redemption: { eligibility: 'KYC-verified non-US holders only' },
            documents: [{ url: 'https://example.com/terms' }],
            discrepancies: [{ status: 'open' }, { status: 'resolved' }],
            evidence: { confirmed: 8, unverified: 2, inference: 1, lastCheckedAt: '2026-09-18T12:00:00Z', coverage: { sourced: 9, needed: 10 } }
        };
        expect(provenanceSummary(issuer)).toMatchObject({
            authority: expect.stringContaining('linked issuer or legal document'),
            evidenceType: 'Direct evidence + analysis', jurisdiction: 'British Virgin Islands',
            holderScope: 'KYC-verified non-US holders only', conflicts: 1, sourced: 9, needed: 10
        });
        const html = provenanceHtml(issuer);
        for (const label of ['Source authority', 'Claim vs inference', 'Jurisdiction scope', 'Holder scope', 'Conflicting evidence']) {
            expect(html).toContain(label);
        }
    });
});

/**
 * Evidence chips (stocks/EVIDENCE.md §4). The claim logic itself is tested in
 * stocks/evidence.test.js against the shared module; what is tested here is the page's own markup
 * and the two numbers a reader sees: that a chip escapes a quote instead of injecting it, that an
 * unsafe URL is never rendered as a link, that a field which needs a source but has none gets the
 * hollow form and says so, and that the evidence line reads the way it was specified.
 */
describe('evidence chips on the issuer panel', () => {
    const S = ({ ...require('./lib/evidence-view.js'), ...require('./lib/fmt.js') });
    const { readFileSync } = require('node:fs');
    const FIXTURE = JSON.parse(
        readFileSync(join(REPO, 'stocks', 'fixtures', 'dossier-claims.sample.json'), 'utf8')
    );
    const evidence = require('./lib/evidence.js');
    const CLAIM_FIELDS = JSON.parse(
        readFileSync(join(REPO, 'stocks', 'data', 'claim-fields.json'), 'utf8')
    ).fields;

    /** The panel's index, as detailHtml() builds it: claims by field plus the needed set. */
    function index(record = FIXTURE) {
        const built = S.evidenceIndex(
            { ...record, claims: evidence.dossierClaims('fixture', record) },
            CLAIM_FIELDS
        );
        built.documents = record.documents ?? [];
        return built;
    }

    it('draws a chip on a field that has a claim, with the quote and the locator', () => {
        const html = S.fieldChipHtml(index(), 'redemption.rails', 'Rails');
        expect(html).toContain('<details class="ev-chip ev-confirmed">');
        expect(html).toContain('USDC or another mutually agreed form of value');
        expect(html).toContain('s. 4.1.1');
        // Both claims on the field are shown, strongest first.
        expect(html).toContain('2 claims');
        expect(html.indexOf('confirmed')).toBeLessThan(html.indexOf('unverified'));
    });

    it('shows the source under the title the dossier gave it, as a safe link', () => {
        const html = S.fieldChipHtml(index(), 'redemption.rails', 'Rails');
        expect(html).toContain('href="https://fixture.example/tos"');
        expect(html).toContain('Terms of Service (2026-08)');
        expect(html).toContain('rel="noopener noreferrer"');
    });

    it('cuts a runaway document title visibly and keeps the whole of it in the attribute', () => {
        // One real dossier title runs past 700 characters; printed in full it turns the popover
        // into a wall of link text.
        const long = `Republic – rSPAX offering page. ${'READ the side-by-side offering panels '.repeat(20)}`;
        const record = {
            ...FIXTURE,
            documents: [{ title: long, url: 'https://fixture.example/tos' }],
            claims: [{ field: 'legalForm', quote: 'x', url: 'https://fixture.example/tos',
                accessedAt: '2026-09-18T10:00:00Z', status: 'confirmed' }]
        };
        const html = S.fieldChipHtml(index(record), 'legalForm', 'Legal form');
        const label = /rel="noopener noreferrer">([^<]*)</.exec(html)[1];
        expect(label.length).toBeLessThanOrEqual(S.SOURCE_LABEL_MAX + 1);
        expect(label.endsWith('…')).toBe(true);
        expect(html).toContain(`title="${S.escapeHtml(long.replace(/\s+/g, ' ').trim())}"`);
        expect(S.sourceLabel('short one')).toBe('short one');
        expect(S.sourceLabel(null)).toBeNull();
    });

    it('never renders an unsafe URL as a link', () => {
        const nasty = {
            ...FIXTURE,
            documents: [],
            claims: [{
                field: 'legalForm',
                quote: 'x',
                url: 'javascript:alert(1)',
                accessedAt: '2026-09-18T10:00:00Z',
                status: 'confirmed'
            }]
        };
        const html = S.fieldChipHtml(index(nasty), 'legalForm', 'Legal form');
        expect(html).not.toContain('href="javascript:');
        expect(html).not.toContain('<a ');
    });

    it('escapes a quote rather than letting it close the popover', () => {
        const nasty = {
            ...FIXTURE,
            claims: [{
                field: 'legalForm',
                quote: '</div><img src=x onerror=alert(1)>',
                url: 'https://fixture.example/tos',
                accessedAt: '2026-09-18T10:00:00Z',
                status: 'confirmed'
            }]
        };
        const html = S.fieldChipHtml(index(nasty), 'legalForm', 'Legal form');
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img');
    });

    it('gives a field that needs a source but has none the hollow chip, and says why', () => {
        const html = S.fieldChipHtml(index(), 'governingLaw', 'Governing law');
        expect(html).toContain('ev-chip-none');
        expect(html).toContain('§?');
        expect(html).toContain(S.NO_CLAIM_TEXT);
        expect(S.NO_CLAIM_TEXT).toBe('no source recorded yet');
    });

    it('draws NO chip on a field that neither has nor needs a claim', () => {
        expect(S.fieldChipHtml(index(), 'confidence', 'Confidence')).toBe('');
        expect(S.fieldChipHtml(index(), 'chains', 'Chains')).toBe('');
        // No index at all (the token panel) draws nothing either.
        expect(S.fieldChipHtml(null, 'redemption.rails', 'Rails')).toBe('');
    });

    it('colours public claim badges while editorial corrections stay unpublished', () => {
        expect(S.claimStatusClass('confirmed')).toBe('ev-confirmed');
        expect(S.claimStatusClass('unverified')).toBe('ev-caution');
        expect(S.claimStatusClass('inference')).toBe('ev-muted');
        expect(S.claimStatusClass('made-up')).toBe('ev-muted');
        expect(S.claimStatusLabel('changed')).toBe('source changed');
    });

    it('marks an on-chain claim as one', () => {
        const html = S.fieldChipHtml(index(), 'keyGovernance.mint', 'Mint authority');
        expect(html).toContain('on-chain');
    });

    it('formats every timestamp and keeps the full ISO in a title', () => {
        expect(S.stampHtml('accessed', '2026-09-18T10:22:00Z'))
            .toBe('<span class="ev-stamp" title="2026-09-18T10:22:00Z">accessed 18 Sep 2026 10:22 UTC</span>');
        expect(S.stampHtml('accessed', null)).toBe('');
        expect(S.stampHtml('accessed', '')).toBe('');
    });

    it('reads the evidence line exactly as specified', () => {
        expect(S.evidenceLineText({
            claims: 39, confirmed: 34, unverified: 4, inference: 1,
            lastCheckedAt: '2026-09-18T10:22:00Z',
            coverage: { sourced: 34, needed: 41 }
        })).toBe('Evidence: 34 of 41 fields sourced · last checked 18 Sep 2026 10:22 UTC');
    });

    it('says "never checked" rather than inventing a date when nothing has been read', () => {
        const line = S.evidenceLineText({
            claims: 0, confirmed: 0, unverified: 0, inference: 0,
            lastCheckedAt: null, coverage: { sourced: 0, needed: 46 }
        });
        expect(line).toBe('Evidence: 0 of 46 fields sourced · never checked');
        expect(line).not.toContain('1970');
        expect(S.evidenceLineHtml(null)).toBe('');
    });

    it('prefers the build\'s own expanded need list over re-expanding in the browser', () => {
        // stocks-issuers.json carries `evidenceFields`; the fetched claim-fields.json is only the
        // fallback. Two different answers to "does this field need a source" would show one number
        // in the line and a different set of hollow chips beside it.
        const withList = S.evidenceIndex({ claims: [], evidenceFields: ['governingLaw'] }, CLAIM_FIELDS);
        expect([...withList.needed]).toEqual(['governingLaw']);
        const withoutList = S.evidenceIndex({ claims: [], governingLaw: 'BVI law' }, CLAIM_FIELDS);
        expect([...withoutList.needed]).toEqual(['governingLaw']);
    });
});
