// Tests the shareholder-rights indicator (stocks/lib/holder-rights.js) and its curated data
// (stocks/data/holder-rights.json): every issuer answers every right with a source, the strip and
// table say what the data says, and "yes" stays reserved for holders who own the share itself.
const fs = require('node:fs');
const path = require('node:path');
const {
    RIGHTS, STATUSES, holderRightsDetailHtml, holderRightsHeadline, holderRightsRows, holderRightsStripHtml, validateHolderRights
} = require('./lib/holder-rights.js');

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'holder-rights.json'), 'utf8'));
const ISSUER_SLUGS = fs.readdirSync(path.join(__dirname, 'data', 'issuers'))
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'issuers', file), 'utf8')))
    .map((dossier) => dossier.slug)
    .filter(Boolean);

describe('the curated rights file', () => {
    it('answers all five rights for every issuer programme, each with a source', () => {
        const slugs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'stocks-issuers.json'), 'utf8')).issuers.map((row) => row.slug);
        expect(validateHolderRights(DATA, slugs)).toEqual([]);
        expect(Object.keys(DATA.issuers).sort()).toEqual([...slugs].sort());
    });

    it('gives "yes" only where the holder owns the share itself (registered share, same class)', () => {
        const withYes = Object.entries(DATA.issuers)
            .filter(([, entry]) => RIGHTS.some((right) => entry[right.id].status === 'yes'))
            .map(([slug]) => slug).sort();
        expect(withYes).toEqual(['bullish', 'securitize', 'superstate-opening-bell']);
    });

    it('catches a missing right, a bad status and an unquoted answer', () => {
        const broken = JSON.parse(JSON.stringify(DATA));
        delete broken.issuers.bullish.voting;
        broken.issuers.tessera.dividends.status = 'maybe';
        broken.issuers.prestocks.voting.source.quote = '';
        expect(validateHolderRights(broken, [...ISSUER_SLUGS, 'nobody'])).toEqual(expect.arrayContaining([
            'nobody: missing', 'bullish.voting: missing', 'tessera.dividends: status maybe', 'prestocks.voting: no without a quote'
        ]));
    });
});

describe('rows and headline', () => {
    it('reads a missing issuer as five unknowns, never as "no"', () => {
        const rows = holderRightsRows(null);
        expect(rows.map((row) => row.status)).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
        expect(holderRightsHeadline(rows)).toBe('Shareholder rights: not stated');
    });

    it('sums up each kind of programme in one line', () => {
        expect(holderRightsHeadline(holderRightsRows(DATA.issuers['superstate-opening-bell']))).toBe('All five shareholder rights');
        expect(holderRightsHeadline(holderRightsRows(DATA.issuers['xstocks-backed'])))
            .toBe('No shareholder rights; the issuer passes through dividends and splits');
        expect(holderRightsHeadline(holderRightsRows(DATA.issuers.prestocks))).toBe('No shareholder rights');
    });
});

describe('markup', () => {
    it('the strip carries every right with its mark, status text and reason', () => {
        const html = holderRightsStripHtml(holderRightsRows(DATA.issuers['ondo-global-markets']), { href: '#holder-rights' });
        for (const right of RIGHTS) expect(html).toContain(`</span>${right.label.replace('&', '&amp;')}<span class="rights-sr">`);
        expect(html).toContain(`<li class="rights-chip rights-discretion" title="Voting: ${STATUSES.discretion.label}. You can state a voting preference through Broadridge; Ondo does not have to follow it.">`);
        expect(html).toContain('aria-label="No shareholder rights; the issuer passes through dividends"');
        expect(html).toContain('<a class="rights-more" href="#holder-rights">');
    });

    it('the table names the source of each answer and escapes what it prints', () => {
        const html = holderRightsDetailHtml(holderRightsRows({
            dividends: { status: 'no', summary: 'None <b>at all</b>', source: { url: 'https://example.com/terms?a=1&b=2', locator: 's. 1', quote: 'no "dividends"' } }
        }));
        expect(html).toContain('id="holder-rights"');
        expect(html).toContain('None &lt;b&gt;at all&lt;/b&gt;');
        expect(html).toContain('href="https://example.com/terms?a=1&amp;b=2"');
        expect(html).toContain('example.com</a> · s. 1 · “no &quot;dividends&quot;”');
        expect(html.match(/<tr>/g)).toHaveLength(1 + RIGHTS.length);
        expect(html).toContain('Not stated in the documents we read.');
    });
});

describe('legend', () => {
    it('spells out only the marks the strip uses, for phones that cannot hover', () => {
        const html = holderRightsStripHtml(holderRightsRows(DATA.issuers.prestocks), { legend: true });
        expect(html).toContain(`<p class="rights-legend">${STATUSES.discretion.mark} only if the issuer decides · ${STATUSES.no.mark} no</p>`);
        expect(holderRightsStripHtml(holderRightsRows(DATA.issuers.prestocks))).not.toContain('rights-legend');
    });
});
