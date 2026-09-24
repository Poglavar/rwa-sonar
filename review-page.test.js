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

    test('page is canonical, indexable and loads the generated queue externally', () => {
        const html = readFileSync(path.join(__dirname, 'review.html'), 'utf8');
        expect(html).toContain('rel="canonical" href="https://rwasonar.com/review.html"');
        expect(html).toContain('id="reviewQueue"');
        expect(html).not.toContain('noindex');
        expect(html).not.toMatch(/<script(?![^>]*\s(?:src=|type="application\/ld\+json"))/); // JSON-LD is inert data
        expect(readFileSync(path.join(__dirname, 'review.js'), 'utf8')).toContain("fetch('./stocks-review-queue.json')");
    });
});
