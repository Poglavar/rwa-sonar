// Unit tests for stocks/lib/unreadable.mjs — does a read carry the document, or something served in
// its place? Every unreadable fixture is a REAL body the watcher stored on the server and raised
// change events against between 2026-09-17 and 2026-09-24 (stocks/fixtures/unreadable/), and every
// readable one is a real page that must keep being read:
//
//   solana-rpc-triton-info.html                     api.mainnet-beta.solana.com, 2026-09-17 (95 quote-lost events)
//   helius-rpc-get-answer.json                      mainnet.helius-rpc.com answering a plain GET, 2026-09-24
//   backed-assets-legal-documentation-geoblock.html assets.backed.fi/legal-documentation from the server, 2026-09-17
//   remora-not-available-wayback-20260306150852.html the region-block page Remora's dossier cites and quotes
//   securitize-tokenize-instructions-spa-shell.html stocks.securitize.io/tokenize/instructions, 2026-09-21
//   brokercheck-firm-summary-spa-shell.html         brokercheck.finra.org/firm/summary/317194, 2026-09-17
//   cysec-announcements-aspnet-form.html            cysec.gov.cy announcements, trimmed: an ASP.NET <form> page
//   superstate-fwdi-total-supply.html               api.superstate.com …/total-supply: a bare number
//   backed-fi-news-proof-of-reserve.html            a Webflow article whose text sits in a dropped <header>
//   figure-ai-home.html                             a real short homepage (must stay readable)
//   ../sources/backed-fi-legal-documentation.html   the same Backed page read from outside the US (readable)
//   ../sources/ventuals-app-sunset-2026-09-17.html  app.ventuals.com/sunset, a Next.js client shell
//   ../sources/remora-whitepaper-wayback-*.html     a WordPress page published empty (readable, on purpose)
//   ../sources/securitize-drs-general-instructions.md   Markdown the host serves as octet-stream

import { readFileSync } from 'node:fs';

import {
    DISMISS_REVIEWER, UNREADABLE_LABELS, buildDismissalSql, classifyRead, dismissalFor, dismissalItemId, dismissalNote,
    needsPreviousChars, unreadableReason
} from './lib/unreadable.mjs';
import { binaryMarker, htmlDocumentText, jsonToText, looksLikeText } from './lib/watch.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/unreadable/${name}`, import.meta.url), 'utf8');
const source = (name) => readFileSync(new URL(`./fixtures/sources/${name}`, import.meta.url), 'utf8');

/** What the watcher hands the classifier for an HTML body: the hashed text and the raw markup. */
function htmlRead(raw, extra = {}) {
    const read = htmlDocumentText(raw);
    return classifyRead({ kind: 'html', via: read.via, text: read.text, raw, ...extra });
}

describe('classifyRead: the reads that raised false changes', () => {
    test('an RPC endpoint\'s info page is not a document', () => {
        const verdict = htmlRead(fixture('solana-rpc-triton-info.html'));
        expect(verdict).toMatchObject({ readable: false, code: 'rpc-info' });
        expect(verdict.reason).toBe('couldn\'t read (an RPC endpoint, not a document): the endpoint served its info page ("Triton One RPC")');
    });

    test('a JSON-RPC error answering a plain GET is the same thing in JSON; a JSON document is not', () => {
        const raw = fixture('helius-rpc-get-answer.json');
        expect(classifyRead({ kind: 'api', text: jsonToText(raw), raw })).toMatchObject({ readable: false, code: 'rpc-info' });
        const answer = '{"jsonrpc":"2.0","result":{"value":1},"id":1}';
        expect(classifyRead({ kind: 'api', text: jsonToText(answer), raw: answer }).readable).toBe(true);
        const metadata = '{"name":"Tesla xStock","symbol":"TSLAx"}';
        expect(classifyRead({ kind: 'api', text: jsonToText(metadata), raw: metadata }).readable).toBe(true);
    });

    test('a region-restriction page served to the server\'s region', () => {
        const backed = htmlRead(fixture('backed-assets-legal-documentation-geoblock.html'));
        expect(backed).toMatchObject({ readable: false, code: 'geoblock', label: 'region-restricted page' });
        expect(backed.reason).toContain('access our website from a restricted country');
        const remora = htmlRead(fixture('remora-not-available-wayback-20260306150852.html'));
        expect(remora).toMatchObject({ readable: false, code: 'geoblock' });
        expect(remora.reason).toContain('not available in your region');
    });

    test('the same Backed page read from outside the US stays readable, footer disclaimer and all', () => {
        const raw = source('backed-fi-legal-documentation.html');
        expect(htmlDocumentText(raw).text).toMatch(/not (be )?(offered|available)/i);
        expect(htmlRead(raw)).toEqual({ readable: true });
    });

    test('a cited page is read as a document when every quote registered on it is in it', () => {
        // Remora's dossier cites its /not-available page for the words "our services are currently
        // not available in your region due to regulatory requirements".
        const raw = fixture('remora-not-available-wayback-20260306150852.html');
        expect(htmlRead(raw, { quotes: { checked: 1, lost: 0 } })).toEqual({ readable: true });
        // A lost quote is not "every quote found": the region block is still a region block.
        expect(htmlRead(raw, { quotes: { checked: 3, lost: 1 } })).toMatchObject({ readable: false, code: 'geoblock' });
        // Nothing checkable proves nothing.
        expect(htmlRead(raw, { quotes: { checked: 0, lost: 0 } })).toMatchObject({ readable: false, code: 'geoblock' });
    });

    test('a single-page app\'s shell: the title and nothing else, content loaded by script', () => {
        const securitize = htmlRead(fixture('securitize-tokenize-instructions-spa-shell.html'));
        expect(securitize).toMatchObject({ readable: false, code: 'js-shell', label: 'script-only page' });
        expect(securitize.reason).toMatch(/^couldn't read \(script-only page\): 45 characters of text from 4 kB of markup/);
        expect(htmlRead(fixture('brokercheck-firm-summary-spa-shell.html'))).toMatchObject({ readable: false, code: 'js-shell' });
        expect(htmlRead(source('ventuals-app-sunset-2026-09-17.html'))).toMatchObject({ readable: false, code: 'js-shell' });
    });

    test('a large page that reads as almost nothing is near-empty unless something shows script rendering', () => {
        // cysec.gov.cy wraps its whole page in <form id="aspnetForm">, which the hash reading drops:
        // our extraction's gap, not a script-only page, and the reason must not say otherwise.
        const verdict = htmlRead(fixture('cysec-announcements-aspnet-form.html'));
        expect(verdict).toMatchObject({ readable: false, code: 'near-empty', label: 'almost no readable text' });
        expect(verdict.reason).toBe('couldn\'t read (almost no readable text): 57 characters of text from 30 kB of markup');
        // The same shape with a Next.js flight payload in it is a script shell.
        const raw = fixture('cysec-announcements-aspnet-form.html').replace('</body>', '<script>self.__next_f.push([1,""])</script></body>');
        expect(htmlRead(raw)).toMatchObject({ readable: false, code: 'js-shell' });
    });

    test('a title-only page with no script is not called a script shell', () => {
        expect(htmlRead('<html><head><title>Notice</title></head><body><p>Moved.</p></body></html>')).toEqual({ readable: true });
    });

    test('a response with no readable text at all', () => {
        // "8723436.100000", served as a page: the ticker-widget churn rule drops a bare number.
        const raw = fixture('superstate-fwdi-total-supply.html');
        expect(htmlRead(raw)).toMatchObject({ readable: false, code: 'empty' });
        expect(classifyRead({ kind: 'pdf', text: '' })).toMatchObject({ readable: false, code: 'empty' });
        expect(classifyRead({ kind: 'pdf', text: '' }).reason).toBe('couldn\'t read (no readable text): the PDF has no text layer');
    });

    test('a text file hashed as bytes is a failed read; a real binary is watched as bytes', () => {
        const md = Buffer.from(source('securitize-drs-general-instructions.md'), 'utf8');
        const marker = binaryMarker(md, 'application/octet-stream');
        expect(classifyRead({ kind: 'html', text: marker, binary: true, bytesAreText: looksLikeText(md) }))
            .toMatchObject({ readable: false, code: 'text-as-bytes' });
        const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x08, 0x00]);
        expect(classifyRead({ kind: 'html', text: binaryMarker(zip, 'application/zip'), binary: true, bytesAreText: looksLikeText(zip) }))
            .toEqual({ readable: true });
    });
});

describe('classifyRead: real reads that must stay readable', () => {
    test('a real short homepage from a large page', () => {
        expect(htmlRead(fixture('figure-ai-home.html'))).toEqual({ readable: true });
    });

    test('a WordPress page published empty is read as empty on purpose', () => {
        expect(htmlRead(source('remora-whitepaper-wayback-20250516143234.html'))).toEqual({ readable: true });
    });

    test('a Next.js page whose words are in its flight payload', () => {
        const raw = source('ventuals-terms.nextjs.html');
        expect(htmlDocumentText(raw).via).toBe('next-flight');
        expect(htmlRead(raw)).toEqual({ readable: true });
    });

    test('a Notion page is judged on the text its API rendered, not on the shell it came in', () => {
        expect(classifyRead({ kind: 'html', via: 'notion', text: 'Terms of Service\nThese terms govern…', raw: '{"recordMap":{}}' }))
            .toEqual({ readable: true });
    });

    test('PDF and JSON text is never judged by HTML markers', () => {
        const text = 'Access Restricted\nour services are currently not available in your region';
        expect(classifyRead({ kind: 'pdf', text })).toEqual({ readable: true });
        expect(classifyRead({ kind: 'api', text, raw: JSON.stringify({ text }) })).toEqual({ readable: true });
    });
});

describe('classifyRead: near-empty only against the last readable version', () => {
    const raw = fixture('backed-fi-news-proof-of-reserve.html');
    const text = htmlDocumentText(raw).text;

    test('the Webflow article reads as 555 characters of chrome from 60 kB of markup', () => {
        expect(text.length).toBe(555);
        expect(needsPreviousChars({ text, raw })).toBe(true);
    });

    test('with no readable version to compare with, a short read of a big page is left alone', () => {
        expect(htmlRead(raw)).toEqual({ readable: true });
        expect(htmlRead(raw, { previousChars: null })).toEqual({ readable: true });
    });

    test('a collapse to a third or less of the last readable version is near-empty', () => {
        const verdict = htmlRead(raw, { previousChars: 4200 });
        expect(verdict).toMatchObject({ readable: false, code: 'near-empty', label: 'almost no readable text' });
        expect(verdict.reason).toBe('couldn\'t read (almost no readable text): 555 characters of text from 60 kB of markup; the last readable version had 4200');
        expect(htmlRead(raw, { previousChars: 1600 })).toEqual({ readable: true });
    });

    test('a small page is never near-empty, whatever it had before', () => {
        expect(needsPreviousChars({ text: 'short', raw: '<p>short</p>' })).toBe(false);
        expect(classifyRead({ kind: 'html', text: 'A short notice with a few words.', raw: '<p>A short notice with a few words.</p>', previousChars: 50_000 }))
            .toEqual({ readable: true });
    });
});

describe('unreadableReason', () => {
    test('every code has the label the watch page prints as "couldn\'t read (…)"', () => {
        expect(Object.keys(UNREADABLE_LABELS).sort()).toEqual(['empty', 'geoblock', 'js-shell', 'near-empty', 'rpc-info', 'text-as-bytes']);
        expect(unreadableReason('geoblock', 'x')).toBe('couldn\'t read (region-restricted page): x');
        expect(unreadableReason('empty')).toBe('couldn\'t read (no readable text)');
    });
});

describe('dismissing the events unreadable reads already raised', () => {
    const rpc = htmlRead(fixture('solana-rpc-triton-info.html'));
    const drive = { readable: false, code: 'js-shell', reason: 'couldn\'t read (script-only page): 44 characters of text from 131 kB of markup; the content renders only in a browser' };

    test('an event raised from an unreadable read is dismissed with the classifier\'s reason', () => {
        expect(dismissalFor({ kind: 'quote-lost', read: rpc })).toEqual({ category: 'unreadable-read', code: 'rpc-info', reason: rpc.reason });
        expect(dismissalFor({ kind: 'legal-term', read: rpc })?.category).toBe('unreadable-read');
    });

    test('a legal-term diff against an unreadable stored version is dismissed; a quote loss is judged on its own read', () => {
        // drive.google.com/file/d/1R1-…/view: the viewer shell, then the PDF — "the document appeared".
        const d = dismissalFor({ kind: 'legal-term', read: { readable: true }, baseline: drive });
        expect(d).toMatchObject({ category: 'unreadable-baseline', code: 'js-shell' });
        expect(d.reason).toBe('the version it was compared with was unreadable (script-only page): 44 characters of text from 131 kB of markup; the content renders only in a browser');
        expect(dismissalFor({ kind: 'quote-lost', read: { readable: true }, baseline: drive })).toBeNull();
        expect(dismissalFor({ kind: 'legal-term', read: { readable: true }, baseline: { readable: true } })).toBeNull();
    });

    test('a quote lost by an older reader is dismissed only on request', () => {
        expect(dismissalFor({ kind: 'quote-lost', read: { readable: true }, quoteFound: true })).toBeNull();
        expect(dismissalFor({ kind: 'quote-lost', read: { readable: true }, quoteFound: true, includeReaderFixed: true }))
            .toMatchObject({ category: 'reader-fixed', code: null });
        expect(dismissalFor({ kind: 'quote-lost', read: { readable: true }, quoteFound: false, includeReaderFixed: true })).toBeNull();
        expect(dismissalFor({ kind: 'legal-term', read: { readable: true }, quoteFound: true, includeReaderFixed: true })).toBeNull();
    });

    test('the note names the event, the reason and the stored copy, within the column\'s 4000 characters', () => {
        const note = dismissalNote({ eventId: 658, kind: 'quote-lost', category: 'unreadable-read', reason: rpc.reason,
            textPath: 'stocks/data/sources/6fe2b1790f13/2026-09-17T17-30-08Z.txt' });
        expect(note).toBe('Dismissed automatically: quote-lost event 658 was raised from a read that was not the document — '
            + 'couldn\'t read (an RPC endpoint, not a document): the endpoint served its info page ("Triton One RPC"). '
            + 'Stored copy: stocks/data/sources/6fe2b1790f13/2026-09-17T17-30-08Z.txt. The watcher no longer raises events from such reads (next-steps.md item 11).');
        expect(dismissalNote({ eventId: 1, kind: 'legal-term', category: 'unreadable-read', reason: 'x'.repeat(5000) }).length).toBe(4000);
    });

    test('the item id is the review API\'s 16-hex shape and stable per event', () => {
        expect(dismissalItemId(658)).toMatch(/^[0-9a-f]{16}$/);
        expect(dismissalItemId(658)).toBe(dismissalItemId(658));
        expect(dismissalItemId(658)).not.toBe(dismissalItemId(659));
    });

    test('the write only adds what is missing: a resolution per event without one, an ack per unacknowledged event', () => {
        const { sql, rows } = buildDismissalSql([
            { eventId: 658, issuerSlug: 'xstocks-backed', field: 'mintAuthority', note: 'Dismissed automatically: …' },
            { eventId: 'x', note: 'not an id' },
            { eventId: 659, note: '' }
        ]);
        expect(rows).toBe(1);
        expect(sql).toContain("'false-alarm'");
        expect(sql).toContain(`'${DISMISS_REVIEWER}'`);
        expect(sql).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM sonar\.review_resolution rr\s+WHERE rr\.event_id = src\.event_id AND rr\.resolution = 'false-alarm'\)/);
        expect(sql).toMatch(/SET acknowledged_at = now\(\), updated_at = now\(\)\s+FROM src WHERE e\.id = src\.event_id AND e\.acknowledged_at IS NULL/);
        expect(sql).not.toMatch(/\bDELETE\b/i);
        expect(sql).toContain(dismissalItemId(658));
    });
});
