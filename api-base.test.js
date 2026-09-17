// Unit tests for stocks/lib/api-base.js — how a page decides WHERE the JSON API is, and how it
// spells a request. The two failures worth guarding: a base that is not an http(s) origin must not
// be honoured (`?api=javascript:…` would otherwise steer every fetch the page makes), and a `false`
// or `0` filter value must survive the query builder — dropping it would turn "paused = false" into
// "any paused state" and quietly answer a different question than the one that was asked.

const A = require('./stocks/lib/api-base.js');

/** A document stub with one meta tag, shaped like the single querySelector call apiBase makes. */
function docWithMeta(content) {
    return {
        querySelector(selector) {
            if (selector !== `meta[name="${A.META_NAME}"]`) return null;
            return content === null ? null : { getAttribute: () => content };
        }
    };
}

describe('resolveBase', () => {
    test('?api= wins over the meta tag, which wins over the same origin', () => {
        expect(A.resolveBase('?api=http://localhost:3300', 'https://rwasonar.com')).toBe('http://localhost:3300');
        expect(A.resolveBase('', 'https://rwasonar.com')).toBe('https://rwasonar.com');
        expect(A.resolveBase('', null)).toBe('');
        expect(A.resolveBase(undefined, undefined)).toBe('');
    });

    test('a trailing slash is dropped, so a path is never joined onto a double slash', () => {
        expect(A.resolveBase('?api=http://localhost:3300/', null)).toBe('http://localhost:3300');
        expect(A.resolveBase('?api=http://localhost:3300///', null)).toBe('http://localhost:3300');
    });

    test('anything that is not an http(s) origin is refused, not used as a base', () => {
        // Each of these must fall THROUGH to the next source rather than steering the page's fetches.
        expect(A.resolveBase('?api=javascript:alert(1)', null)).toBe('');
        expect(A.resolveBase('?api=/api', null)).toBe('');
        expect(A.resolveBase('?api=ftp://example.com', null)).toBe('');
        expect(A.resolveBase('?api=http://evil.example.com/path', null)).toBe('');
        expect(A.resolveBase('?api=%20', null)).toBe('');
        expect(A.resolveBase('?api=javascript:alert(1)', 'https://rwasonar.com')).toBe('https://rwasonar.com');
        expect(A.normalizeBase('not a url')).toBeNull();
    });

    test('an empty ?api= does not shadow the meta tag', () => {
        expect(A.resolveBase('?api=', 'https://rwasonar.com')).toBe('https://rwasonar.com');
    });
});

describe('apiBase', () => {
    test('reads the live document: the URL parameter, else the meta tag, else same origin', () => {
        expect(A.apiBase(docWithMeta('https://rwasonar.com'), { search: '?api=http://localhost:3300' }))
            .toBe('http://localhost:3300');
        expect(A.apiBase(docWithMeta('https://rwasonar.com'), { search: '' })).toBe('https://rwasonar.com');
        expect(A.apiBase(docWithMeta(null), { search: '?reduceMotion=1' })).toBe('');
    });
});

describe('queryString and apiUrl', () => {
    test('an array becomes the comma list the API reads as OR, with the comma left literal', () => {
        expect(A.queryString({ issuer: ['shift', 'prestocks'] })).toBe('issuer=shift,prestocks');
        expect(A.apiUrl('/api/tokens', { issuer: ['shift', 'prestocks'] }, ''))
            .toBe('/api/tokens?issuer=shift,prestocks');
    });

    test('null, undefined and the empty string are dropped; false and 0 are kept', () => {
        expect(A.queryString({ q: '', sort: null, order: undefined, paused: false, offset: 0 }))
            .toBe('paused=false&offset=0');
        expect(A.queryString({ issuer: [null, '', 'shift'] })).toBe('issuer=shift');
        expect(A.queryString({ issuer: [null, ''] })).toBe('');
    });

    test('values are percent-encoded, so a recipe label with a middot survives the round trip', () => {
        const url = A.apiUrl('/api/facets', { recipe: ['token-2022 · pausable'] }, '');
        expect(url).toBe('/api/facets?recipe=token-2022%20%C2%B7%20pausable');
        expect(new URLSearchParams(url.split('?')[1]).get('recipe')).toBe('token-2022 · pausable');
    });

    test('the base is prefixed and a path without a leading slash still gets one', () => {
        expect(A.apiUrl('/api/health', null, 'http://localhost:3300')).toBe('http://localhost:3300/api/health');
        expect(A.apiUrl('api/health', {}, 'http://localhost:3300')).toBe('http://localhost:3300/api/health');
        expect(A.apiUrl('/api/health', {}, '')).toBe('/api/health');
    });

    test('no parameters means no question mark at all', () => {
        expect(A.apiUrl('/api/facets', {}, '')).toBe('/api/facets');
        expect(A.apiUrl('/api/facets', { q: '' }, '')).toBe('/api/facets');
    });
});
