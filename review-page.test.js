const { readFileSync } = require('node:fs');
const path = require('node:path');
const review = require('./review.js');

describe('public evidence review queue', () => {
    test('filters by consequence, issue, issuer and free text', () => {
        const row = { priority: 'P1', area: 'insolvency', issue: 'missing', issuerSlug: 'xstocks-backed', issuerName: 'xStocks', field: 'bankruptcyRemote', detail: 'No opinion', action: 'Research it' };
        expect(review.matches(row, { priority: 'P1', area: 'insolvency', issuer: 'xstocks-backed', query: 'opinion' })).toBe(true);
        expect(review.matches(row, { area: 'redemption' })).toBe(false);
    });

    test('escapes content and refuses executable source URLs', () => {
        const html = review.itemHtml({
            priority: 'P0', area: 'control', issue: 'changed', issuerName: '<Issuer>',
            title: '<b>Changed</b>', detail: 'x', action: 'y', sourceUrl: 'javascript:alert(1)',
            retrievalState: 'retrieved successfully',
            contentComparisonState: 'source bytes or cited text changed; relevance is not yet reviewed',
            analystReviewState: 'pending analyst review',
            conclusionValidityState: 'published conclusion must be treated as provisional',
            affectedConclusions: ['issuer intervention'],
            resolutionCriteria: 'Compare the source and record the decision.'
        });
        expect(html).toContain('&lt;Issuer&gt;');
        expect(html).not.toContain('javascript:');
        expect(html).toContain('Retrieval');
        expect(html).toContain('source bytes or cited text changed');
        expect(html).toContain('Affected conclusions:');
        expect(html).toContain('Resolution criteria:');
    });

    test('each item is one compact row: a <details> whose summary holds date, priority and title, then one line', () => {
        const entry = {
            id: 'abc/1', priority: 'P0', area: 'control', issue: 'changed', issuerName: 'xStocks',
            title: 'Freeze authority changed', detail: 'The mint now names a new freeze authority.', action: 'Re-read the terms',
            claimImpact: 'May let the issuer freeze holders.', observedAt: '2026-09-23T09:51:55.000Z',
            href: './issuers/xstocks-backed.html', sourceUrl: 'https://example.com/terms'
        };
        const html = review.itemHtml(entry);
        expect(html).toMatch(/^<li id="review-abc-1" class="fold-row review-item fold-critical" data-priority="P0"><details><summary>/);
        const summary = html.slice(html.indexOf('<summary>'), html.indexOf('</summary>'));
        expect(summary).toContain('<span class="fold-line1">23 Sep 2026 · <span class="review-priority">P0</span> <strong class="fold-title">Freeze authority changed</strong></span>');
        expect(summary).toContain('<span class="fold-line2">xStocks · May let the issuer freeze holders.</span>');
        // Links live in the opened body, so a click on the row only toggles it.
        expect(summary).not.toContain('<a ');
        const body = html.slice(html.indexOf('<div class="fold-body'));
        expect(body).toContain('Open dossier →');
        expect(body).toContain('Open source ↗');
        expect(body).toContain('The mint now names a new freeze authority.');
        expect(body).toContain('Re-read the terms');
        expect(html).toMatch(/<\/div><\/details><\/li>$/);
    });

    test('a row the URL targets, or one the reader had open, renders open', () => {
        const entry = { id: 'x', priority: 'P3', area: 'other', issue: 'stale', issuerName: 'I', title: 't', detail: 'd', action: 'a' };
        expect(review.itemHtml(entry)).toContain('<details><summary>');
        expect(review.itemHtml(entry, { open: true })).toContain('<details open><summary>');
        expect(review.itemHtml(entry, { target: true })).toMatch(/class="fold-row review-item fold-target"[^>]*><details open>/);
        expect(review.shortDate('2026-01-05')).toBe('5 Jan 2026');
        expect(review.shortDate(null)).toBeNull();
        const source = readFileSync(path.join(__dirname, 'review.js'), 'utf8');
        expect(source).toContain("queue.querySelectorAll('li.fold-row > details[open]')");
        expect(readFileSync(path.join(__dirname, 'review.html'), 'utf8')).toContain('<ol id="reviewQueue" class="fold-list review-queue">');
    });

    test('page is canonical, indexable and loads the generated queue externally', () => {
        const html = readFileSync(path.join(__dirname, 'review.html'), 'utf8');
        expect(html).toContain('rel="canonical" href="https://rwasonar.com/review.html"');
        expect(html).toContain('id="reviewQueue"');
        expect(html).not.toContain('noindex');
        expect(html).not.toMatch(/<script(?![^>]*\s(?:src=|type="application\/ld\+json"))/); // JSON-LD is inert data
        expect(readFileSync(path.join(__dirname, 'review.js'), 'utf8')).toContain("fetch('./stocks-review-queue.json')");
    });
});
