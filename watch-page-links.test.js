// Links into the watch page's change feed: every row has a stable `change-<event id>` anchor that a
// digest or card can target, and the feed's issuer and material filters round-trip through the URL
// (`?issuerSlug=` and `?material=true`). Pure helpers from watch.js, no browser.
const W = require('./watch.js');

describe('change row anchors', () => {
    test('a row carries change-<id>, and the hash that names it resolves back to it', () => {
        expect(W.changeAnchorId('2056')).toBe('change-2056');
        expect(W.changeAnchorId(2056)).toBe('change-2056');
        expect(W.changeAnchorFromHash('#change-2056')).toBe('change-2056');
        expect(W.changeAnchorFromHash('change-2056')).toBe('change-2056');
    });

    test('nothing unsafe or unrelated becomes an anchor', () => {
        for (const id of [null, undefined, '', '  ', '12 34', '"><script>', '20/56']) {
            expect(W.changeAnchorId(id)).toBeNull();
        }
        for (const hash of ['', '#', '#journalSection', '#change-', '#change-a b', '#change-%E0%A4%A', null]) {
            expect(W.changeAnchorFromHash(hash)).toBeNull();
        }
    });

    test('changeRows gives every row its anchor, and the anchor survives a missing id as null', () => {
        const rows = W.changeRows([
            { id: '2056', detected_at: '2026-09-23T10:00:00Z', kind: 'supply', subject_type: 'issuer', issuer_slug: 'xstocks', severity: 'info' },
            { detected_at: '2026-09-23T10:00:00Z', kind: 'supply', subject_type: 'issuer', issuer_slug: 'xstocks', severity: 'info' }
        ], {});
        expect(rows.map((row) => row.anchorId)).toEqual(['change-2056', null]);
    });
});

describe('feed filters in the URL', () => {
    test('issuerSlug and material are read from a shared link', () => {
        expect(W.feedFiltersFromSearch('?material=true&issuerSlug=ondo-global-markets')).toEqual({ material: true, issuer: 'ondo-global-markets' });
        expect(W.feedFiltersFromSearch('')).toEqual({ material: false, issuer: null });
        expect(W.feedFiltersFromSearch('?material=1&issuerSlug=Bad%20Slug')).toEqual({ material: false, issuer: null });
    });

    test('writing the filters back keeps every other parameter and round-trips', () => {
        const search = W.feedFiltersToSearch('?type=issuer&api=http://localhost:3300', { material: true, issuer: 'xstocks' });
        expect(new URLSearchParams(search).get('type')).toBe('issuer');
        expect(new URLSearchParams(search).get('api')).toBe('http://localhost:3300');
        expect(W.feedFiltersFromSearch(search)).toEqual({ material: true, issuer: 'xstocks' });
        const cleared = W.feedFiltersToSearch(search, { material: false, issuer: '' });
        expect(W.feedFiltersFromSearch(cleared)).toEqual({ material: false, issuer: null });
        expect(new URLSearchParams(cleared).get('type')).toBe('issuer');
        expect(W.feedFiltersToSearch('?material=true', { material: false, issuer: null })).toBe('');
    });
});
