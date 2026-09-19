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
        const html = review.itemHtml({ priority: 'P0', area: 'control', issue: 'changed', issuerName: '<Issuer>', title: '<b>Changed</b>', detail: 'x', action: 'y', sourceUrl: 'javascript:alert(1)' });
        expect(html).toContain('&lt;Issuer&gt;');
        expect(html).not.toContain('javascript:');
    });

    test('page is canonical, indexable and loads the generated queue externally', () => {
        const html = readFileSync(path.join(__dirname, 'review.html'), 'utf8');
        expect(html).toContain('rel="canonical" href="https://rwasonar.com/review.html"');
        expect(html).toContain('id="reviewQueue"');
        expect(html).not.toContain('noindex');
        expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
        expect(readFileSync(path.join(__dirname, 'review.js'), 'utf8')).toContain("fetch('./stocks-review-queue.json')");
    });
});
