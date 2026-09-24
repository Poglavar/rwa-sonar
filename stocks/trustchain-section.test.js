// Unit tests for stocks/lib/trustchain-section.js: the issuer panel's trust-chain and what-if
// section bodies. Moved with the code out of stocks-page.test.js (next-steps.md F11), which still
// tests the page wiring that calls it.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const REPO = join(__dirname, '..');

// --- the trust chain and the what-if answers on the issuer panel (EVIDENCE.md §6) -------------
describe('the trust-chain section on the issuer panel', () => {
    const { readFileSync } = require('node:fs');
    const S = require('./lib/trustchain-section.js');

    const issuers = JSON.parse(readFileSync(join(REPO, 'stocks-issuers.json'), 'utf8')).issuers;
    const catalogue = JSON.parse(readFileSync(
        join(REPO, 'stocks', 'data', 'trust-chain.json'), 'utf8'));
    const record = issuers.find((row) => row.slug === 'xstocks-backed');

    it('draws the record’s own chain: one node per actor, one lane per flow', () => {
        const section = S.chainSectionHtml(record);
        expect(section.match(/class="tc-node[ "]/g)).toHaveLength(catalogue.actors.length);
        // The space matters: `tc-lanes` is the container group, not a lane.
        const lanes = [...section.matchAll(/<g class="(tc-lane [^"]*)"/g)].map((m) => m[1].split(' '));
        expect(lanes).toHaveLength(catalogue.flows.length);
        for (const classes of lanes) {
            expect(classes.filter((c) => c.startsWith('tc-ev-'))).toHaveLength(1);
            expect(classes.filter((c) => c.startsWith('tc-vf-'))).toHaveLength(1);
        }
    });

    it('shows each flow’s summary and the fields it rests on, with their claim status', () => {
        const section = S.chainSectionHtml(record);
        // On the TEXT, not just the element: a <p class="tc-flow-summary"> holding nothing but an
        // ellipsis passed a `toContain('tc-flow-summary')` for a whole browser session.
        for (const link of record.chain.links) {
            if (link.summary === null) continue;
            expect(section).toContain(link.summary.slice(0, 40));
        }
        expect(section).not.toContain('<p class="tc-flow-summary">\u2026</p>');
        expect(section).toContain('tc-field-path');
        // The values the panel CAN afford, unlike a card.
        expect(section).toContain('tc-field-value');
        expect(section).toContain('tc-claim-confirmed');
    });

    it('keeps the empty seats: an actor nobody fills is a finding, not a gap in the drawing', () => {
        const section = S.chainSectionHtml(record);
        const empty = record.chain.nodes.filter((node) => node.parties.length === 0).length;
        expect(empty).toBeGreaterThan(0);
        expect(section.match(/tc-node tc-node-empty/g)).toHaveLength(empty);
        expect(section).toContain('no party named');
    });

    it('says so, rather than drawing an empty frame, when a record has no chain', () => {
        expect(S.chainSectionHtml({ slug: 'x', name: 'X' }))
            .toContain('No trust chain has been built for this issuer yet');
        expect(S.chainSectionHtml(null)).toContain('No trust chain has been built');
    });
});

describe('the what-if section on the issuer panel', () => {
    const { readFileSync } = require('node:fs');
    const S = require('./lib/trustchain-section.js');
    const catalogue = JSON.parse(readFileSync(
        join(REPO, 'stocks', 'data', 'trust-chain.json'), 'utf8'));

    /** One answer-sheet row as /api/issuers/:slug/what-if returns it. */
    function row(over) {
        return {
            mode_id: 'keys-stolen',
            actor: 'holder',
            flow: 'transfer',
            question: 'My keys are stolen. Can the tokens be recovered?',
            look_for: 'Lost-token clauses.',
            ord: 0,
            status: 'documented',
            id: 'xstocks-backed:keys-stolen',
            issuer_slug: 'xstocks-backed',
            outcome: 'Nothing comes back as of right.',
            quote: 'the Issuer will not be capable of restoring the private key',
            url: 'https://example.com/prospectus.pdf',
            locator: 'p. 107',
            accessed_at: '2026-09-18T10:15:00.000Z',
            cases: [],
            searched: [],
            note: null,
            source_title: 'Base Prospectus',
            source_archive_url: null,
            actor_label: 'Holder',
            flow_label: 'Transfer and control',
            ...over
        };
    }

    const SHEET = {
        slug: 'xstocks-backed',
        name: 'Kraken xStocks',
        count: 5,
        summary: {},
        items: [
            row({}),
            row({ mode_id: 'court-order', ord: 1, status: 'inferred', quote: null, question: 'A court orders a seizure.' }),
            row({
                mode_id: 'custodian-insolvency', actor: 'custodian', actor_label: 'Custodian or prime broker',
                ord: 2, status: 'unknown', quote: null, searched: ['https://example.com/terms'],
                question: 'The custodian goes bankrupt.'
            }),
            row({
                mode_id: 'law-changes', actor: 'law', actor_label: 'Law, regulator and courts', ord: 3,
                status: 'missing', id: null, outcome: null, quote: null, url: null, locator: null,
                accessed_at: null, source_title: null, question: 'The law changes.'
            }),
            row({
                mode_id: 'dispute-forum', actor: 'law', actor_label: 'Law, regulator and courts', ord: 4,
                status: 'not-applicable', quote: null, url: null, note: 'No forum clause exists.',
                question: 'Where do I sue?'
            })
        ]
    };

    it('counts every status it shows, and leaves out the ones with nothing under them', () => {
        const html = S.whatIfSectionHtml(SHEET, catalogue);
        expect(html).toContain('<span class="wi-count-n">1</span> documented');
        expect(html).toContain('<span class="wi-count-n">1</span> inferred');
        expect(html).toContain('<span class="wi-count-n">1</span> unknown');
        expect(html).toContain('<span class="wi-count-n">1</span> n/a');
        expect(html).toContain('<span class="wi-count-n">1</span> missing');
        // Nothing is litigated here, so the counts line leaves that status out entirely rather
        // than printing a zero. (The word still appears in the note, which explains all five.)
        const counts = html.slice(0, html.indexOf('</p>'));
        expect(counts).not.toContain('litigated');
    });

    it('groups the answers by actor in the catalogue’s order, not the question order', () => {
        const heads = [...S.whatIfSectionHtml(SHEET, catalogue)
            .matchAll(/<h5 class="wi-actor-head">([^<]+)<\/h5>/g)].map((m) => m[1]);
        expect(heads).toEqual(['Holder', 'Custodian or prime broker', 'Law, regulator and courts']);
    });

    it('groups in the order the questions arrive when the catalogue did not load', () => {
        const heads = [...S.whatIfSectionHtml(SHEET, null)
            .matchAll(/<h5 class="wi-actor-head">([^<]+)<\/h5>/g)].map((m) => m[1]);
        expect(heads).toEqual(['Holder', 'Custodian or prime broker', 'Law, regulator and courts']);
    });

    it('shows the panel’s full evidence: the quote, the source with its locator and the read date', () => {
        const html = S.whatIfSectionHtml(SHEET, catalogue);
        expect(html).toContain('<blockquote class="wi-quote">');
        expect(html).toContain('the Issuer will not be capable of restoring the private key');
        expect(html).toContain('https://example.com/prospectus.pdf');
        expect(html).toContain('p. 107');
        expect(html).toContain('read 18 Sep 2026');
        // The panel names its sources in place: the footnote list is the card's economy, not this one's.
        expect(html).not.toContain('wi-ref');
    });

    it('shows where we looked for an unknown, because the gap is only evidence with it', () => {
        const html = S.whatIfSectionHtml(SHEET, catalogue);
        expect(html).toContain('Where we looked (1)');
        expect(html).toContain('https://example.com/terms');
    });

    it('shows the note that says why a not-applicable case cannot arise', () => {
        expect(S.whatIfSectionHtml(SHEET, catalogue)).toContain('No forum clause exists.');
    });

    it('draws a question nobody has answered as a gap, and never as an answer', () => {
        const html = S.whatIfSectionHtml(SHEET, catalogue);
        expect(html).toContain('wi-badge wi-s-missing');
        expect(html).toContain('Not answered yet for this issuer');
        expect(html).toContain('Nobody has read the documents for this question yet');
    });

    it('states the rule that an outcome is never invented', () => {
        expect(S.whatIfSectionHtml(SHEET, catalogue)).toContain('An outcome is never invented');
        expect(S.WHAT_IF_NOTE).toContain('never invented');
        expect(S.WHAT_IF_NOTE).toContain('38 questions');
    });

    it('says the API did not answer rather than showing a gap that is not one', () => {
        const html = S.whatIfSectionHtml(null, catalogue, { failure: 'HTTP 503' });
        expect(html).toContain('which did not answer: HTTP 503');
        expect(html).toContain('We show nothing instead of a partial sheet');
        // An unreachable API must never look like "this issuer has no answers".
        expect(html).not.toContain('wi-badge');
        expect(html).not.toContain('No what-if answers have been recorded');
    });

    it('says it is loading before the sheet has landed', () => {
        expect(S.whatIfSectionHtml(null, catalogue)).toContain('Loading the answer sheet');
    });

    it('says the server has no catalogue when the sheet comes back with no questions', () => {
        expect(S.whatIfSectionHtml({ items: [] }, catalogue))
            .toContain('did not load on the server');
    });

    it('escapes an answer, so a dossier cannot inject markup into the panel', () => {
        const html = S.whatIfSectionHtml(
            { items: [row({ outcome: '<img src=x onerror=1>' })] }, catalogue);
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img');
    });

    it('reads the actor order and labels from the catalogue file the builders read', () => {
        expect(S.chainActorOrder(catalogue)).toEqual(catalogue.actors.map((actor) => actor.id));
        expect(S.chainActorLabels(catalogue).holder).toBe('Holder');
        expect(S.chainActorOrder(null)).toEqual([]);
    });
});
