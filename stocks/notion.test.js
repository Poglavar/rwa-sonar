// Unit tests for stocks/lib/notion.mjs — reading a Notion-hosted legal document without a browser.
// Both fixtures are the REAL responses for PreStocks' Terms of Service, saved 2026-09-18:
//
//   notion-prestocks-terms.shell.html   `GET https://prestocks.notion.site/terms-of-service`
//                                       verbatim (20,034 bytes). It carries the page id in a
//                                       `requiredRedirectMetadata` script AND, 18 kB earlier, the
//                                       consent vendor's own dashed uuid — the decoy that makes
//                                       the ORDER of the id-extraction attempts load-bearing.
//   notion-prestocks-terms.json         the three `loadPageChunk` responses merged into one
//                                       `{pageId, recordMap: {block}}` (232 blocks), which is the
//                                       shape the watcher keeps as the raw copy of a version.
//                                       Only Notion's `crdt_data` editing internals were dropped;
//                                       every field the renderer reads is verbatim. Regenerate by
//                                       paging loadPageChunk for the page id below.
//
// A synthetic recordMap could not show the two things that actually broke: the wrapper around each
// block record is doubly nested (`{spaceId, value: {value, role}}`), and one record in this very
// page comes back as `{value: {role: 'none'}}` with no block in it at all.

import { readFileSync } from 'node:fs';

import {
    CHUNK_LIMIT, NOTION_CHUNK_API, fetchNotionPageText, isNotionSiteHost, notionPageIdFromHtml,
    renderNotionBlocks, segmentsToText, unwrapBlock
} from './lib/notion.mjs';

const FIXTURES = new URL('./fixtures/sources/', import.meta.url);
const SHELL = readFileSync(new URL('notion-prestocks-terms.shell.html', FIXTURES), 'utf8');
const TERMS = JSON.parse(readFileSync(new URL('notion-prestocks-terms.json', FIXTURES), 'utf8'));
const TERMS_PAGE_ID = '5af73892-884d-4833-842a-d172487af3fa';

/** A block record in the shape the API actually returns, for the synthetic cases. */
function block(id, type, title, content = undefined, extra = {}) {
    const value = { id, type, properties: title === null ? {} : { title }, ...extra };
    if (content) value.content = content;
    return { spaceId: 'space', value: { value, role: 'reader' } };
}

describe('the notion.site host test', () => {
    it('matches a subdomain and the bare domain, and nothing that merely contains it', () => {
        expect(isNotionSiteHost('prestocks.notion.site')).toBe(true);
        expect(isNotionSiteHost('NOTION.SITE')).toBe(true);
        expect(isNotionSiteHost('notion.site.evil.com')).toBe(false);
        expect(isNotionSiteHost('www.notion.so')).toBe(false);
        expect(isNotionSiteHost(null)).toBe(false);
    });
});

describe('the page id out of a real Notion shell', () => {
    it('finds the page id in the saved response and NOT the consent vendor uuid before it', () => {
        expect(notionPageIdFromHtml(SHELL)).toBe(TERMS_PAGE_ID);
        // The decoy is really there, and really comes first: byte 1,106 versus byte 19,647.
        expect(SHELL).toContain('transcend-cdn.com/cm/4d6a6beb-faf4-4a4e-9e1c-c7692d5f9c2f');
        expect(SHELL.indexOf('4d6a6beb')).toBeLessThan(SHELL.indexOf('5af73892'));
        expect(notionPageIdFromHtml(SHELL)).not.toContain('4d6a6beb');
    });

    it('dashes a 32-hex id, reads one out of a notion.site permalink, and gives up cleanly', () => {
        expect(notionPageIdFromHtml('{"pageId":"5af73892884d4833842ad172487af3fa"}')).toBe(TERMS_PAGE_ID);
        expect(notionPageIdFromHtml('<a href="https://x.notion.site/Terms-5af73892884d4833842ad172487af3fa">t</a>'))
            .toBe(TERMS_PAGE_ID);
        expect(notionPageIdFromHtml('5af73892884d4833842ad172487af3fa is the id')).toBe(TERMS_PAGE_ID);
        expect(notionPageIdFromHtml('<html><body>no id here</body></html>')).toBeNull();
        expect(notionPageIdFromHtml('')).toBeNull();
        expect(notionPageIdFromHtml(null)).toBeNull();
        // A dashed uuid on its own is NOT accepted as a page id — that is the decoy's shape.
        expect(notionPageIdFromHtml('<script src="//cdn/4d6a6beb-faf4-4a4e-9e1c-c7692d5f9c2f/x.js">'))
            .toBeNull();
    });
});

describe('block records and their text', () => {
    it('unwraps both wrapper shapes and refuses a record with no block in it', () => {
        expect(unwrapBlock(block('a', 'text', [['hi']])).id).toBe('a');
        expect(unwrapBlock({ value: { value: { id: 'b', type: 'text' } } }).id).toBe('b');
        expect(unwrapBlock({ role: 'reader', value: { id: 'c', type: 'text' } }).id).toBe('c');
        // The one real record in this page that we are not served.
        expect(unwrapBlock({ spaceId: 'space', value: { role: 'none' } })).toBeNull();
        expect(unwrapBlock(undefined)).toBeNull();
        expect(unwrapBlock({ value: { value: { type: 'text' } } })).toBeNull();
    });

    it('keeps the words of an annotated title and drops the annotations', () => {
        expect(segmentsToText([['Last Updated: September 8, 2026', [['i']]]]))
            .toBe('Last Updated: September 8, 2026');
        expect(segmentsToText([['contact us at '], ['legal@prestocks.com', [['a', 'mailto:legal@prestocks.com']]], ['.']]))
            .toBe('contact us at legal@prestocks.com.');
        expect(segmentsToText(null)).toBe('');
        expect(segmentsToText([[42], 'raw'])).toBe('raw');
    });
});

describe('rendering the real Terms of Service', () => {
    const text = renderNotionBlocks(TERMS.recordMap, TERMS_PAGE_ID);

    it('renders the whole document the fetch cannot read, not a JavaScript shell', () => {
        expect(text.length).toBeGreaterThan(100_000);
        expect(text.split('\n').length).toBeGreaterThan(200);
        // The shell it replaces normalises to one word; this is the document.
        expect(SHELL.length).toBeLessThan(21_000);
    });

    it('starts at the page title and ends at the last block of the document', () => {
        const lines = text.split('\n');
        expect(lines[0]).toBe('PreStocks Terms of Service');
        expect(lines[1]).toBe('Last Updated: September 8, 2026');
        expect(lines.at(-1)).toContain('you may contact us via the in-app support functionality');
    });

    it('carries the clauses this watcher exists for, verbatim and on their own lines', () => {
        const lines = text.split('\n');
        // The amendment clause: the reason a document that cannot be diffed is a hole in the watch.
        expect(text).toContain('all of which may be changed at any time in our sole discretion');
        expect(text).toContain('without notice and without any obligation to notify you');
        // Headings are their own lines, not glued to the paragraph that follows.
        for (const heading of ['Acceptance of These Terms of Service', 'Pre-IPO Tokens', 'Survival',
            'Contact Us', 'Entire Agreement and No Reliance']) {
            expect(lines).toContain(heading);
        }
    });

    it('prefixes list items and leaves no markup or entity behind', () => {
        const lines = text.split('\n');
        expect(lines.filter((l) => l.startsWith('- ')).length).toBeGreaterThan(40);
        expect(text).not.toMatch(/<\/?(p|div|span|script|li|h[1-6])\b/i);
        expect(text).not.toMatch(/&(amp|nbsp|quot|#\d+);/);
    });

    it('skips the record this page returns with no block in it instead of inventing a line', () => {
        const records = Object.values(TERMS.recordMap.block);
        expect(records.some((r) => unwrapBlock(r) === null)).toBe(true);
        expect(text).not.toContain('undefined');
        expect(text).not.toContain('[object Object]');
    });
});

describe('rendering the block types the real page has none of', () => {
    const recordMap = {
        block: {
            root: block('root', 'page', [['Fee Schedule']], ['h', 'n1', 'n2', 'b1', 'n3', 'div', 'tbl', 'weird', 'gone', 'tog']),
            h: block('h', 'sub_header', [['Fees']]),
            n1: block('n1', 'numbered_list', [['first']]),
            n2: block('n2', 'numbered_list', [['second']], ['n2a']),
            n2a: block('n2a', 'bulleted_list', [['nested under the second']]),
            b1: block('b1', 'bulleted_list', [['a bullet between them']]),
            n3: block('n3', 'numbered_list', [['numbering restarts after the bullet']]),
            div: block('div', 'divider', null),
            tbl: block('tbl', 'table', null, ['r1', 'r2'], { format: { table_block_column_order: ['cB', 'cA'] } }),
            r1: { value: { value: { id: 'r1', type: 'table_row', properties: { cA: [['0.50%']], cB: [['Redemption fee']] } } } },
            r2: { value: { value: { id: 'r2', type: 'table_row', properties: { cA: [['none']], cB: [['Custody fee']] } } } },
            weird: block('weird', 'equation', [['E = mc^2']]),
            gone: { spaceId: 'space', value: { role: 'none' } },
            tog: block('tog', 'toggle', [['More detail']], ['togchild']),
            togchild: block('togchild', 'text', [['the detail itself']])
        }
    };
    const lines = renderNotionBlocks(recordMap, 'root').split('\n');

    it('numbers a run of numbered_list siblings and restarts it after a break', () => {
        expect(lines).toEqual([
            'Fee Schedule',
            'Fees',
            '1. first',
            '2. second',
            '- nested under the second',
            '- a bullet between them',
            '1. numbering restarts after the bullet',
            '---',
            'Redemption fee | 0.50%',
            'Custody fee | none',
            'E = mc^2',
            'More detail',
            'the detail itself'
        ]);
    });

    it('renders table rows in the column order the table declares, not the row key order', () => {
        // The row's own keys are cA, cB; the table says cB first, and the table wins.
        expect(lines).toContain('Redemption fee | 0.50%');
        expect(lines).not.toContain('0.50% | Redemption fee');
    });

    it('does not loop on a block that contains itself, and renders nothing for an empty map', () => {
        const cyclic = { block: { a: block('a', 'page', [['A']], ['b']), b: block('b', 'text', [['B']], ['a']) } };
        expect(renderNotionBlocks(cyclic, 'a')).toBe('A\nB');
        expect(renderNotionBlocks({ block: {} }, 'missing')).toBe('');
        expect(renderNotionBlocks(null, 'missing')).toBe('');
    });
});

// --- paging ----------------------------------------------------------------------------------

/** A fake fetch that answers the shell GET and then the chunk POSTs, recording every request. */
function fakeNotion(chunks, { shell = SHELL } = {}) {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
        calls.push({ url, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null });
        if (options.method !== 'POST') {
            return { ok: true, status: 200, text: async () => shell };
        }
        const next = chunks.shift();
        if (!next) throw new Error('the fake fetch ran out of chunks');
        if (typeof next.status === 'number' && next.status >= 400) {
            return { ok: false, status: next.status, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => next };
    };
    return { fetchImpl, calls };
}

describe('fetchNotionPageText paging', () => {
    it('pages until the cursor stack comes back empty and merges every chunk', async () => {
        const stack = [[{ table: 'block', id: TERMS_PAGE_ID, index: 99, spaceId: 'space' }]];
        const { fetchImpl, calls } = fakeNotion([
            {
                cursor: { stack },
                recordMap: {
                    block: {
                        [TERMS_PAGE_ID]: block(TERMS_PAGE_ID, 'page', [['Terms']], ['a', 'b']),
                        a: block('a', 'text', [['first half']])
                    }
                }
            },
            {
                cursor: { stack: [] },
                recordMap: { block: { b: block('b', 'text', [['second half']]) } }
            }
        ]);
        const out = await fetchNotionPageText('https://prestocks.notion.site/terms-of-service', { fetch: fetchImpl });

        expect(out.pageId).toBe(TERMS_PAGE_ID);
        expect(out.chunks).toBe(2);
        expect(out.text).toBe('Terms\nfirst half\nsecond half');
        expect(Object.keys(out.blocks).sort()).toEqual([TERMS_PAGE_ID, 'a', 'b'].sort());
        expect(out.recordMap).toEqual({ block: out.blocks });

        // one GET for the shell, then one POST per chunk, to the documented endpoint
        expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'POST']);
        expect(calls[1].url).toBe(NOTION_CHUNK_API);
        expect(calls[1].body).toEqual({
            pageId: TERMS_PAGE_ID, limit: CHUNK_LIMIT, cursor: { stack: [] }, chunkNumber: 0, verticalColumns: false
        });
        // the second request carries the cursor the first one answered with, and the next number
        expect(calls[2].body.cursor).toEqual({ stack });
        expect(calls[2].body.chunkNumber).toBe(1);
    });

    it('skips the shell GET when the caller already has the html', async () => {
        const { fetchImpl, calls } = fakeNotion([
            { cursor: { stack: [] }, recordMap: { block: { [TERMS_PAGE_ID]: block(TERMS_PAGE_ID, 'page', [['Terms']]) } } }
        ]);
        const out = await fetchNotionPageText('https://prestocks.notion.site/terms-of-service',
            { fetch: fetchImpl, html: SHELL });
        expect(out.text).toBe('Terms');
        expect(calls.map((c) => c.method)).toEqual(['POST']);
    });

    it('throws rather than hash a partial document', async () => {
        const url = 'https://prestocks.notion.site/terms-of-service';
        const forever = () => ({
            cursor: { stack: [[{ table: 'block', id: TERMS_PAGE_ID, index: 99 }]] },
            recordMap: { block: { [TERMS_PAGE_ID]: block(TERMS_PAGE_ID, 'page', [['Terms']]) } }
        });

        // a chunk that errors
        await expect(fetchNotionPageText(url, { fetch: fakeNotion([{ status: 502 }]).fetchImpl, html: SHELL }))
            .rejects.toThrow(/loadPageChunk .* chunk 1: http 502/);
        // a cursor that never ends
        await expect(fetchNotionPageText(url, {
            fetch: fakeNotion([forever(), forever(), forever()]).fetchImpl, html: SHELL, maxChunks: 2
        })).rejects.toThrow(/still paging after 2 chunks/);
        // an empty recordMap
        await expect(fetchNotionPageText(url, {
            fetch: fakeNotion([{ cursor: { stack: [] }, recordMap: { block: {} } }]).fetchImpl, html: SHELL
        })).rejects.toThrow(/no blocks in 1 chunk/);
        // no id to page with
        await expect(fetchNotionPageText(url, { fetch: fakeNotion([]).fetchImpl, html: '<html>nothing</html>' }))
            .rejects.toThrow(/no page id in the html/);
        // the shell itself refused
        await expect(fetchNotionPageText(url, {
            fetch: async () => ({ ok: false, status: 403, text: async () => '' })
        })).rejects.toThrow(/page shell .*: http 403/);
    });
});
