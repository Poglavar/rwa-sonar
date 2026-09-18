// Reading a Notion-hosted document without a browser. PreStocks publishes its Terms of Service and
// Privacy Policy — the issuer's primary legal documents — as Notion pages, whose HTML is a 20 kB
// JavaScript shell that normalises to the single word "Notion"; the watcher recorded them as
// `blocked: javascript-only` and never diffed terms that say they may be amended "at any time …
// without prior notice". Notion's own public API answers without any auth for a publicly shared
// page: `POST https://www.notion.so/api/v3/loadPageChunk` returns a `recordMap.block` map, 100
// blocks at a time, and the document is that map walked in tree order from the page block's
// `content` array.
//
// Pure functions plus one async fetcher whose `fetch` is injectable, so the id extraction, the
// rendering and the cursor paging are all unit tested against a recordMap saved from a real fetch
// (../notion.test.js, ../fixtures/sources/notion-prestocks-terms.json). Nothing here invents text:
// a block we were not served, or one whose `role` is `none`, contributes nothing at all.

export const NOTION_CHUNK_API = 'https://www.notion.so/api/v3/loadPageChunk';

/** Blocks per request. Notion's own client asks for 100 and answers with a cursor for the rest. */
export const CHUNK_LIMIT = 100;

/**
 * Cap on the number of chunk requests for one page. A document that has not finished after this
 * many is reported as a failure rather than hashed as if it were complete — a half-read terms of
 * service whose missing half is where the fee changed would be worse than no watch at all.
 */
export const MAX_CHUNKS = 40;

/** `*.notion.site` (and notion.site itself): a page whose text only exists behind loadPageChunk. */
export function isNotionSiteHost(host) {
    const name = String(host ?? '').toLowerCase();
    return name === 'notion.site' || name.endsWith('.notion.site');
}

const HEX32 = /^[0-9a-f]{32}$/;

/** 32 hex characters -> the dashed 8-4-4-4-12 form loadPageChunk expects. */
function withDashes(hex) {
    const h = String(hex).toLowerCase().replace(/-/g, '');
    if (!HEX32.test(h)) return null;
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The page id out of a Notion page's HTML, as the dashed uuid loadPageChunk wants, or null.
 *
 * The order of these attempts matters and is not cosmetic. Measured on the real response for
 * `https://prestocks.notion.site/terms-of-service` (2026-09-18, 20,034 bytes): the page id is in
 * `__notion_html_async.push("requiredRedirectMetadata", {"pageId":"5af73892-…"})` near the end of
 * the body, while the FIRST dashed uuid in the document — 18 kB earlier, at byte 1,106 — is
 * `transcend-cdn.com/cm/4d6a6beb-…`, the consent vendor's tenant id. A "first uuid in the HTML"
 * rule therefore picks up the wrong id and every subsequent request 404s, which is why there is no
 * bare-dashed-uuid fallback here: an explicit `pageId`, the id in a `notion.site` permalink, or a
 * bare 32-hex run (a shape the vendor ids do not have), and otherwise null so the caller reports
 * that it could not find one instead of paging a stranger's page.
 */
export function notionPageIdFromHtml(html) {
    const text = String(html ?? '');
    const keyed = text.match(/"(?:pageId|page_id|rootPageId|blockId)"\s*:\s*"([0-9a-fA-F-]{32,36})"/);
    if (keyed) {
        const id = withDashes(keyed[1]);
        if (id) return id;
    }
    const permalink = text.match(/notion\.site\/(?:[^"'\s/]*-)?([0-9a-f]{32})\b/i);
    if (permalink) {
        const id = withDashes(permalink[1]);
        if (id) return id;
    }
    const bare = text.match(/\b([0-9a-f]{32})\b/);
    if (bare) {
        const id = withDashes(bare[1]);
        if (id) return id;
    }
    return null;
}

// --- rendering -------------------------------------------------------------------------------

/**
 * One block record out of `recordMap.block`. Two wrapper shapes come back from the same response
 * (measured 2026-09-18): `{spaceId, value: {value, role}}` and `{value: {value, role}}`, and the
 * older documented shape `{role, value}` is still what most writing about this API describes. A
 * record we are not allowed to read arrives as `{value: {role: 'none'}}` with no block at all —
 * that returns null and contributes nothing.
 */
export function unwrapBlock(record) {
    if (!record || typeof record !== 'object') return null;
    let value = record.value ?? record;
    if (value && typeof value === 'object' && 'value' in value) value = value.value;
    if (!value || typeof value !== 'object' || typeof value.id !== 'string') return null;
    return value;
}

/**
 * The plain text of a `properties.title`: an array of `[text, annotations?]` segments, where the
 * annotations are formatting (`[["i"]]`, `[["a", "mailto:legal@prestocks.com"]]`). Only the text is
 * kept — a bold or italic run is the same words, and a link's href is metadata rather than
 * something the document says.
 */
export function segmentsToText(segments) {
    if (!Array.isArray(segments)) return '';
    let out = '';
    for (const segment of segments) {
        if (typeof segment === 'string') out += segment;
        else if (Array.isArray(segment) && typeof segment[0] === 'string') out += segment[0];
    }
    return out;
}

/** Column order of a table: the format the block carries, falling back to the row's own keys. */
function tableColumns(table, firstRow) {
    const order = table?.format?.table_block_column_order;
    if (Array.isArray(order) && order.length) return order;
    const properties = firstRow?.properties;
    return properties && typeof properties === 'object' ? Object.keys(properties) : [];
}

function renderRow(row, columns) {
    const properties = row?.properties ?? {};
    const keys = columns.length ? columns : Object.keys(properties);
    return keys.map((key) => segmentsToText(properties[key]).trim()).join(' | ');
}

/**
 * `recordMap` walked in document order from `rootId` into plain text, one block per line:
 * headings and paragraphs on their own line, `bulleted_list` prefixed `- `, `numbered_list`
 * numbered within its own run of siblings, a `table` as one ` | `-joined line per row, a
 * `divider` as `---`. An unknown block type contributes its title text if it has any and nothing
 * otherwise, so a type Notion adds tomorrow still gets watched instead of silently disappearing.
 * Nested children follow their parent, unindented — the watcher's line normaliser trims leading
 * whitespace anyway, so indentation would not survive to be hashed.
 */
export function renderNotionBlocks(recordMap, rootId) {
    const blocks = recordMap?.block ?? recordMap?.recordMap?.block ?? {};
    const lines = [];
    const seen = new Set();

    const renderChildren = (ids) => {
        let ordinal = 0;
        for (const id of Array.isArray(ids) ? ids : []) {
            const block = unwrapBlock(blocks[id]);
            if (!block) continue;
            if (block.type === 'numbered_list') ordinal += 1;
            else ordinal = 0;
            renderOne(id, block, ordinal);
        }
    };

    const renderOne = (id, block, ordinal) => {
        if (seen.has(id)) return;
        seen.add(id);
        const text = segmentsToText(block.properties?.title).trim();
        const type = block.type;
        if (type === 'divider') {
            lines.push('---');
        } else if (type === 'bulleted_list' || type === 'to_do') {
            lines.push(`- ${text}`);
        } else if (type === 'numbered_list') {
            lines.push(`${ordinal || 1}. ${text}`);
        } else if (type === 'table') {
            const rowIds = Array.isArray(block.content) ? block.content : [];
            const columns = tableColumns(block, unwrapBlock(blocks[rowIds[0]]));
            for (const rowId of rowIds) {
                const row = unwrapBlock(blocks[rowId]);
                if (!row) continue;
                seen.add(rowId);
                lines.push(renderRow(row, columns));
            }
            return;
        } else if (type === 'table_row') {
            lines.push(renderRow(block, []));
        } else if (text !== '') {
            // Every other type — heading, paragraph, quote, callout, toggle, and anything Notion
            // adds tomorrow — is its own line of words. A block with no words contributes none.
            lines.push(text);
        }
        renderChildren(block.content);
    };

    const root = unwrapBlock(blocks[rootId]);
    if (!root) return '';
    renderOne(rootId, root, 0);
    return lines.join('\n');
}

// --- fetching --------------------------------------------------------------------------------

const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/**
 * The text of a Notion page: find its id (from `html` when the caller already fetched the shell,
 * otherwise with one GET), page through `loadPageChunk` until the cursor stack comes back empty,
 * merge every chunk's blocks, and render them. Returns `{text, pageId, blocks, chunks, recordMap}`
 * — `blocks` is the merged `recordMap.block` map, which is also what the caller should keep as the
 * raw copy of this version, so a stored version can be re-rendered later without re-fetching.
 *
 * Throws on anything that would leave a partial document: no id in the HTML, a non-2xx from
 * loadPageChunk, a response with no blocks, or a cursor still going after MAX_CHUNKS. The caller
 * records those as `error` (the source is readable in principle — this is our fetch failing), never
 * as `blocked`.
 */
export async function fetchNotionPageText(url, {
    fetch: fetchImpl = globalThis.fetch,
    userAgent = DEFAULT_UA,
    timeoutMs = 30_000,
    html = null,
    maxChunks = MAX_CHUNKS
} = {}) {
    const signal = () => (typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined);
    let shell = html;
    if (typeof shell !== 'string') {
        const res = await fetchImpl(url, {
            method: 'GET',
            headers: { 'User-Agent': userAgent, Accept: 'text/html,*/*' },
            redirect: 'follow',
            signal: signal()
        });
        if (!res.ok) throw new Error(`page shell ${url}: http ${res.status}`);
        shell = await res.text();
    }
    const pageId = notionPageIdFromHtml(shell);
    if (!pageId) throw new Error(`no page id in the html of ${url} (${shell.length} bytes)`);

    const blocks = {};
    let cursor = { stack: [] };
    let chunks = 0;
    for (;;) {
        if (chunks >= maxChunks) {
            throw new Error(`loadPageChunk ${pageId}: still paging after ${maxChunks} chunks`
                + ` (${Object.keys(blocks).length} blocks) — refusing to hash a partial document`);
        }
        const res = await fetchImpl(NOTION_CHUNK_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': userAgent },
            body: JSON.stringify({ pageId, limit: CHUNK_LIMIT, cursor, chunkNumber: chunks, verticalColumns: false }),
            signal: signal()
        });
        chunks += 1;
        if (!res.ok) throw new Error(`loadPageChunk ${pageId} chunk ${chunks}: http ${res.status}`);
        const payload = await res.json();
        Object.assign(blocks, payload?.recordMap?.block ?? {});
        const stack = payload?.cursor?.stack;
        if (!Array.isArray(stack) || stack.length === 0) break;
        cursor = payload.cursor;
    }
    if (Object.keys(blocks).length === 0) {
        throw new Error(`loadPageChunk ${pageId}: no blocks in ${chunks} chunk(s)`);
    }
    const recordMap = { block: blocks };
    return { text: renderNotionBlocks(recordMap, pageId), pageId, blocks, chunks, recordMap };
}
