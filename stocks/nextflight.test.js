// Unit tests for stocks/lib/nextflight.mjs and its use in lib/watch.mjs `htmlDocumentText`: reading
// a client-rendered Next.js page from its `self.__next_f` flight payload. The fixture is the REAL
// response for Ventuals' Terms of Use, saved 2026-09-23:
//
//   ventuals-terms.nextjs.html   `GET https://ventuals.com/terms` after its 307 to
//                                app.ventuals.com/terms, verbatim (94,882 bytes). Its markup
//                                normalises to the 23 characters "Terms of Use | Ventuals"; the
//                                Terms are in 14 flight pushes, two of them `T` text rows (the
//                                warranty disclaimer and the liability cap) that are referenced
//                                from the tree as `$6`/`$7` and the first of which is split across
//                                two pushes. The router state also carries a `notFound` slot with a
//                                "404: This page could not be found." that must NOT be read.

import { readFileSync } from 'node:fs';

import { nextFlightStream, nextFlightText, parseFlightRows } from './lib/nextflight.mjs';
import { checkQuotes, htmlDocumentText, htmlToText, jsOnlyShell, normaliseByKind } from './lib/watch.mjs';

const REAL = readFileSync(new URL('./fixtures/sources/ventuals-terms.nextjs.html', import.meta.url), 'utf8');

/** Wrap flight chunks the way Next.js writes them into the page. */
function page(chunks, body = '<div id="root"></div>') {
    const scripts = chunks.map((c) => `<script>self.__next_f.push(${JSON.stringify([1, c])})</script>`).join('');
    return `<!DOCTYPE html><html><head></head><body>${body}<script>(self.__next_f=self.__next_f||[]).push([0])</script>${scripts}</body></html>`;
}

describe('nextFlightText on the real Ventuals Terms page', () => {
    const text = nextFlightText(REAL);

    test('the markup alone is a title; the flight payload is the whole document', () => {
        expect(htmlToText(REAL)).toBe('Terms of Use | Ventuals');
        expect(text.length).toBeGreaterThan(30_000);
        expect(text.startsWith('Terms of Use\nEffective date: Jan 15, 2026\nWelcome to our website-hosted user interface')).toBe(true);
    });

    test('text rows are spliced in where the tree references them, split pushes rejoined', () => {
        const lines = text.split('\n');
        const at = lines.findIndex((l) => l.startsWith('Warranty Disclaimer. Ventuals and its licensors'));
        expect(at).toBeGreaterThan(0);
        expect(lines[at]).toContain('SO THE ABOVE LIMITATIONS MAY NOT APPLY TO YOU.');
        expect(lines[at + 1]).toMatch(/^Limitation of Liability\. TO THE FULLEST EXTENT/);
        expect(lines[at + 1]).toContain('ONE HUNDRED PANAMANIAN BALBOA (PAB 100.00)');
    });

    test('no RSC wire syntax, router data or unrendered slots leak into the text', () => {
        expect(text).not.toMatch(/\$L[0-9a-f]+|\$undefined|\$Sreact|static\/chunks|dpl_|__PAGE__/);
        expect(text).not.toContain('404: This page could not be found.');
        // The page layout passes a `companies` data list as a component prop — data, not prose.
        expect(text).not.toContain('tradingHalted');
        expect(text).not.toContain('BIOTECH');
    });

    test('the dossier quotes that cite ventuals.com/terms are found verbatim', () => {
        const quotes = [
            'Welcome to our website-hosted user interface and other applications (together, the "Applications") made available by VNTL Markets S.A., a Panama corporation ("Ventuals," "we" and "us").',
            'These Terms are governed by and will be construed under the Panama Arbitration Law, Law No. 131 of 2013 (Official Gazette No. 27 449-C, Jan. 8, 2014) and the laws of the Republic of Panama, without regard to the conflicts of laws provisions thereof.'
        ].map((quote, i) => ({ id: String(i), quote }));
        expect(checkQuotes(htmlToText(REAL), quotes).found).toHaveLength(0);
        expect(checkQuotes(htmlDocumentText(REAL).text, quotes).found).toHaveLength(2);
    });

    test('htmlDocumentText picks the flight reading, normaliseByKind follows, and it is no longer a JS shell', () => {
        const read = htmlDocumentText(REAL);
        expect(read.via).toBe('next-flight');
        expect(normaliseByKind('html', REAL)).toBe(read.text);
        expect(jsOnlyShell(htmlToText(REAL), REAL)).toBe(true);
        expect(jsOnlyShell(read.text, REAL)).toBe(false);
    });
});

describe('the flight stream format', () => {
    test('a T row is sliced by UTF-8 BYTE length, not characters, and needs no newline', () => {
        const t = 'It’s “quoted” — ok';
        const stream = `3:T${Buffer.byteLength(t).toString(16)},${t}0:["$","p",null,{"children":"$3"}]\n`;
        const rows = parseFlightRows(stream);
        expect(rows.map((r) => [r.id, r.type])).toEqual([['3', 'text'], ['0', 'json']]);
        expect(rows[0].value).toBe(t);
    });

    test('import, hint and error rows are wire syntax; malformed rows are skipped, not fatal', () => {
        const rows = parseFlightRows('1:I[123,[],""]\n:HL["/x.css","style"]\n2:{broken\n4:["$","p",null,{"children":"kept"}]\n');
        expect(rows.map((r) => r.type)).toEqual(['tag', 'tag', 'json']);
    });

    test('only [1, "…"] pushes form the stream, concatenated in page order', () => {
        const html = page(['0:["$","p",null,{"child', 'ren":"joined"}]\n']);
        expect(nextFlightStream(html)).toBe('0:["$","p",null,{"children":"joined"}]\n');
        expect(nextFlightStream('<html><body>no flight here</body></html>')).toBeNull();
        expect(nextFlightText('<html><body>no flight here</body></html>')).toBeNull();
    });

    test('children text only: blocks break lines, inline elements join, props and $-refs are dropped', () => {
        const tree = ['$', 'div', null, { className: 'x', children: [
            ['$', 'h1', null, { children: 'Heading' }],
            ['$', 'p', null, { children: ['Pay ', ['$', 'strong', null, { children: '$$5' }], ' now'] }],
            ['$', '$L9', null, { items: [{ name: 'DATA' }], children: '$Lb' }],
            ['$', 'script', null, { children: 'var x = 1' }]
        ] }];
        const html = page([`0:${JSON.stringify(tree)}\n5:"$Sreact.suspense"\n`]);
        expect(nextFlightText(html)).toBe('Heading\nPay $5 now');
    });

    test('an unreferenced text row is appended rather than silently lost', () => {
        const html = page(['7:T5,hello0:["$","p",null,{"children":"first"}]\n']);
        expect(nextFlightText(html)).toBe('first\nhello');
    });
});

describe('htmlDocumentText leaves server-rendered pages alone', () => {
    test('a page whose markup already has the text keeps the plain HTML reading', () => {
        const prose = '<p>' + 'A server-rendered paragraph with real words in it. '.repeat(20) + '</p>';
        const html = page(['0:["$","p",null,{"children":"flight copy of the same page, and more words than the body"}]\n'], prose);
        expect(htmlDocumentText(html).via).toBe('html');
    });

    test('a short page with no flight payload is unchanged', () => {
        expect(htmlDocumentText('<html><body><p>Short page.</p></body></html>')).toEqual({ text: 'Short page.', quoteText: 'Short page.', via: 'html' });
    });

    test('flight text is only preferred when it says more than the markup', () => {
        const html = page(['0:["$","p",null,{"children":"x"}]\n'], '<p>A longer body text</p>');
        const read = htmlDocumentText(html);
        expect(read.text).toBe('A longer body text');
        expect(read.via).toBe('html');
        // The quote reading appends inline script payloads (lib/watch.mjs INLINE_SCRIPT) after the body.
        expect(read.quoteText.split('\n')[0]).toBe('A longer body text');
    });
});
