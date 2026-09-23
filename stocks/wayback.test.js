// Unit tests for stocks/lib/wayback.mjs — the pure half of the Wayback fallback for hosts that
// refuse the watcher: the CDX query, reading its answer, which blocked outcomes qualify, and the
// provenance note that keeps an archived capture from passing as a live read. The CDX body below
// is the real shape of `web.archive.org/cdx/search/cdx?url=republic.com/terms&output=json&limit=-1`.

import { gzipSync } from 'node:zlib';

import {
    CDX_TIMEOUT_MS, WAYBACK_FALLBACK_CAP, WAYBACK_PACE_MS, archivedProvenance, captureIso, decodeCaptureBody, captureRawUrl, captureViewUrl, cdxQueryUrl,
    parseCdxNewest, waybackNote, wantsWaybackFallback, citedCapture
} from './lib/wayback.mjs';

const HEADER = ['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'];

describe('CDX query and answer', () => {
    test('asks for the newest 200 capture, with the url encoded', () => {
        expect(cdxQueryUrl('https://republic.com/terms?a=1&b=2')).toBe(
            'https://web.archive.org/cdx/search/cdx?url=https%3A%2F%2Frepublic.com%2Fterms%3Fa%3D1%26b%3D2'
            + '&output=json&limit=-1&filter=statuscode:200');
    });

    test('reads the data row by header name, as JSON text or parsed', () => {
        const body = [HEADER, ['com,republic)/terms', '20260812093015', 'https://republic.com/terms', 'text/html', '200', 'ABC', '51234']];
        const want = { timestamp: '20260812093015', original: 'https://republic.com/terms', mimetype: 'text/html', digest: 'ABC' };
        expect(parseCdxNewest(body)).toEqual(want);
        expect(parseCdxNewest(JSON.stringify(body))).toEqual(want);
    });

    test('no capture, or a malformed one, is null — never a guessed timestamp', () => {
        expect(parseCdxNewest('')).toBeNull();
        expect(parseCdxNewest('[]')).toBeNull();
        expect(parseCdxNewest([HEADER])).toBeNull();
        expect(parseCdxNewest('not json')).toBeNull();
        expect(parseCdxNewest([HEADER, ['k', '2026', 'https://x/', 'text/html', '200', 'D', '1']])).toBeNull();
        expect(parseCdxNewest([HEADER, ['k', '20260812093015', 'republic.com/terms', 'text/html', '200', 'D', '1']])).toBeNull();
    });
});

describe('capture URLs and dates', () => {
    test('id_ is the raw original bytes; the view URL is what a reader opens', () => {
        expect(captureRawUrl('20260812093015', 'https://republic.com/terms'))
            .toBe('https://web.archive.org/web/20260812093015id_/https://republic.com/terms');
        expect(captureViewUrl('20260812093015', 'https://republic.com/terms'))
            .toBe('https://web.archive.org/web/20260812093015/https://republic.com/terms');
    });

    test('capture timestamp to ISO, null for anything else', () => {
        expect(captureIso('20260812093015')).toBe('2026-08-12T09:30:15Z');
        expect(captureIso('2026081209301')).toBeNull();
        expect(captureIso(null)).toBeNull();
    });

    test('the note names the live refusal and the capture date', () => {
        expect(waybackNote({ liveReason: 'http-403 (bot wall)', captureTimestamp: '20260812093015', captureUrl: 'https://web.archive.org/web/20260812093015/https://republic.com/terms' }))
            .toBe('live fetch blocked (http-403 (bot wall)); text read from the Wayback capture of 2026-08-12T09:30:15Z'
                + ' — https://web.archive.org/web/20260812093015/https://republic.com/terms');
    });

    test('pacing and cap are the documented ones', () => {
        expect(WAYBACK_PACE_MS).toBeGreaterThanOrEqual(2000);
        expect(WAYBACK_FALLBACK_CAP).toBe(40);
    });
});

describe('which blocked sources fall back', () => {
    const url = 'https://republic.com/terms';
    test('401, 403 and a bot wall do', () => {
        expect(wantsWaybackFallback({ status: 'blocked', httpStatus: 403, url })).toBe(true);
        expect(wantsWaybackFallback({ status: 'blocked', httpStatus: 401, url })).toBe(true);
        expect(wantsWaybackFallback({ status: 'blocked', httpStatus: 200, botWall: true, url })).toBe(true);
    });

    test('rate limits, bad requests, JS-only pages, readable pages and the archive itself do not', () => {
        expect(wantsWaybackFallback({ status: 'blocked', httpStatus: 429, url })).toBe(false);
        expect(wantsWaybackFallback({ status: 'blocked', httpStatus: 400, url })).toBe(false);
        expect(wantsWaybackFallback({ status: 'blocked', httpStatus: 200, botWall: false, url })).toBe(false);
        expect(wantsWaybackFallback({ status: 'ok', httpStatus: 200, url })).toBe(false);
        expect(wantsWaybackFallback({ status: 'gone', httpStatus: 404, url })).toBe(false);
        expect(wantsWaybackFallback({ status: 'blocked', httpStatus: 403, url: 'https://web.archive.org/web/2026/https://x.com/' })).toBe(false);
        expect(wantsWaybackFallback({ status: 'blocked', httpStatus: 403, url: 'not a url' })).toBe(false);
    });
});

describe('provenance of a capture read', () => {
    test('events and versions from a capture carry the capture date and the live refusal', () => {
        const got = archivedProvenance({
            via: 'wayback', captureTimestamp: '2026-08-12T09:30:15Z', liveReason: 'http-403 (bot wall)',
            captureUrl: 'https://web.archive.org/web/20260812093015/https://republic.com/terms'
        });
        expect(got.evidence).toEqual({
            via: 'wayback', captureTimestamp: '2026-08-12T09:30:15Z', liveReason: 'http-403 (bot wall)',
            captureUrl: 'https://web.archive.org/web/20260812093015/https://republic.com/terms'
        });
        expect(got.prefix).toBe('[Wayback capture of 2026-08-12T09:30:15Z; live page refused us] ');
    });

    test('a live read is written unchanged', () => {
        expect(archivedProvenance({ via: 'html' })).toEqual({ evidence: null, prefix: '' });
        expect(archivedProvenance(null)).toEqual({ evidence: null, prefix: '' });
    });
});

describe('capture bodies', () => {
    test('a plain body under a replayed gzip header is returned as-is; real gzip is decoded', () => {
        const html = Buffer.from('<html><body>Republic Terms</body></html>');
        expect(decodeCaptureBody(html).equals(html)).toBe(true);
        expect(decodeCaptureBody(gzipSync(html)).toString()).toBe(html.toString());
        expect(decodeCaptureBody(Buffer.alloc(0)).length).toBe(0);
    });

    test('the CDX wait allows for its measured 20+ s answers', () => {
        expect(CDX_TIMEOUT_MS).toBeGreaterThanOrEqual(45_000);
    });
});

describe('citedCapture', () => {
    test('a cited Wayback link yields its timestamp and original, so it is fetched as raw id_ bytes', () => {
        expect(citedCapture('https://web.archive.org/web/20260129134823/https://remoramarkets.xyz/sitemap.xml'))
            .toEqual({ timestamp: '20260129134823', original: 'https://remoramarkets.xyz/sitemap.xml' });
        expect(citedCapture('https://web.archive.org/web/20250516144421id_/https://remora.markets/terms-conditions/'))
            .toEqual({ timestamp: '20250516144421', original: 'https://remora.markets/terms-conditions/' });
    });

    test('any other URL is not a cited capture', () => {
        expect(citedCapture('https://remora.markets/terms-conditions/')).toBeNull();
        expect(citedCapture('https://web.archive.org/web/2026*/https://x.com/')).toBeNull();
        expect(citedCapture(null)).toBeNull();
    });
});
