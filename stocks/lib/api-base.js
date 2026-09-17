/*
 * Where the read-only JSON API lives, for the classic scripts that call it. In production the API
 * is published under the same origin as the pages (nginx proxies /api/ to 127.0.0.1:3300), so the
 * base is the empty string and a path is used as-is. A page opened from a dev server on another
 * port needs an absolute base, which comes from `?api=<origin>` in the URL or from a
 * `<meta name="rwa-api-base">` a deployment can plant — in that order, most specific first.
 *
 * Only http(s) origins are accepted, so a hostile `?api=javascript:…` or a relative path cannot
 * redirect the page's fetches. Pure except for apiBase(), which reads the document it is given.
 * UMD-wrapped rather than exporting bare top-level names, so it cannot shadow a global in the
 * classic scripts that load beside it. Tested in ../../api-base.test.js.
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.__rwaApi = factory();
})(this, function () {
    'use strict';

    /** The meta tag a deployment can plant when the API is not on the page's own origin. */
    const META_NAME = 'rwa-api-base';

    /** scheme://host[:port] and nothing else — no path, no query, no javascript: */
    const ORIGIN = /^https?:\/\/[^\s/?#]+$/;

    /** A usable base, trailing slashes removed, or null when the string is not an origin. */
    function normalizeBase(raw) {
        if (typeof raw !== 'string') return null;
        const text = raw.trim().replace(/\/+$/, '');
        if (text === '') return null;
        return ORIGIN.test(text) ? text : null;
    }

    /**
     * The base an explicit override asks for: `?api=` wins, then the meta tag's content, then the
     * empty string, which means "same origin as this page". Pure — both inputs are strings.
     */
    function resolveBase(search, metaContent) {
        const params = new URLSearchParams(typeof search === 'string' ? search : '');
        return normalizeBase(params.get('api')) ?? normalizeBase(metaContent) ?? '';
    }

    /** resolveBase() for a live document: the page's own query string and its own meta tag. */
    function apiBase(doc, loc) {
        const d = doc ?? (typeof document !== 'undefined' ? document : null);
        const l = loc ?? (typeof window !== 'undefined' ? window.location : null);
        const meta = d && typeof d.querySelector === 'function'
            ? d.querySelector(`meta[name="${META_NAME}"]`)
            : null;
        const content = meta && typeof meta.getAttribute === 'function' ? meta.getAttribute('content') : null;
        return resolveBase(l ? l.search : '', content);
    }

    /**
     * `a=1&b=x,y` from a plain object. An array becomes the comma list the API reads as OR; null,
     * undefined and the empty string are DROPPED, while `false` and `0` are kept — a filter on
     * `paused=false` is a question, not a missing value.
     */
    function queryString(params) {
        if (!params || typeof params !== 'object') return '';
        const parts = [];
        for (const [name, value] of Object.entries(params)) {
            const list = (Array.isArray(value) ? value : [value])
                .filter((v) => v !== null && v !== undefined && v !== '' && !Number.isNaN(v))
                .map((v) => encodeURIComponent(typeof v === 'boolean' ? String(v) : v));
            if (list.length === 0) continue;
            // The comma stays literal so a shared URL reads as the API's own filter syntax.
            parts.push(`${encodeURIComponent(name)}=${list.join(',')}`);
        }
        return parts.join('&');
    }

    /** `<base>/api/tokens?…` — the path is taken as given, the query built from an object. */
    function apiUrl(path, params, base) {
        const prefix = typeof base === 'string' ? base : apiBase();
        const route = typeof path === 'string' && path.startsWith('/') ? path : `/${path ?? ''}`;
        const query = queryString(params);
        return `${prefix}${route}${query === '' ? '' : `?${query}`}`;
    }

    return { META_NAME, normalizeBase, resolveBase, apiBase, queryString, apiUrl };
});
