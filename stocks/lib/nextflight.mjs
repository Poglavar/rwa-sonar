// Readable text from a Next.js App Router page whose HTML body is an empty client-rendered shell:
// the words live only in the React Server Components "flight" stream the page pushes with
// `self.__next_f.push([1, "…"])`. This decodes that stream, keeps the human-readable text in
// document order, and drops the RSC wire syntax (module imports, props, references, chunk ids).
// Pure: no network and no filesystem, unit tested in ../nextflight.test.js.

/**
 * The flight stream, as the browser would reassemble it: every `self.__next_f.push([1, "…"])`
 * payload, JSON-decoded and concatenated in page order. A push is only a transport chunk — one
 * row, even one text row, regularly spans two pushes (measured on ventuals.com/terms: a 1,400-byte
 * text row split across the first two). Pushes of other types (`[0]` bootstrap, `[2, …]` form
 * state, `[3, …]` binary) carry no page text and are skipped. Null when the page has none.
 */
export function nextFlightStream(html) {
    const source = String(html ?? '');
    const re = /self\.__next_f\.push\(\s*(\[[\s\S]*?\])\s*\)\s*(?:;\s*)?<\/script>/g;
    let stream = '';
    let pushes = 0;
    let match;
    while ((match = re.exec(source)) !== null) {
        let call;
        try {
            call = JSON.parse(match[1]);
        } catch {
            continue;
        }
        if (Array.isArray(call) && call[0] === 1 && typeof call[1] === 'string') {
            stream += call[1];
            pushes += 1;
        }
    }
    return pushes === 0 ? null : stream;
}

/**
 * Split a flight stream into rows `{id, type, value}`. A row is `<hex id>:<payload>`:
 *  - `T<hex byte length>,<text>` — a raw text row, NOT newline-terminated; its length counts
 *    UTF-8 bytes, so it is sliced from the byte buffer (a `’` is three bytes, not one char);
 *  - a tag letter before JSON (`I[…]` module import, `HL[…]` preload hint, `E{…}` error, …) —
 *    wire syntax, kept as `type: 'tag'` and never read for text;
 *  - otherwise one JSON value up to the newline (the React tree, metadata, plain strings).
 * A row that does not parse is skipped rather than aborting the page: the rest may still read.
 */
export function parseFlightRows(stream) {
    const bytes = Buffer.from(String(stream ?? ''), 'utf8');
    const rows = [];
    let pos = 0;
    while (pos < bytes.length) {
        const colon = bytes.indexOf(0x3a, pos); // ':'
        if (colon < 0) break;
        const id = bytes.subarray(pos, colon).toString('utf8').trim();
        if (!/^[0-9a-f]*$/i.test(id)) {
            // Not a row start: resynchronise at the next newline.
            const nl = bytes.indexOf(0x0a, pos);
            if (nl < 0) break;
            pos = nl + 1;
            continue;
        }
        const at = colon + 1;
        if (bytes[at] === 0x54) { // 'T'
            const comma = bytes.indexOf(0x2c, at);
            const length = comma > at ? Number.parseInt(bytes.subarray(at + 1, comma).toString('latin1'), 16) : Number.NaN;
            if (Number.isFinite(length) && length >= 0) {
                const start = comma + 1;
                rows.push({ id, type: 'text', value: bytes.subarray(start, start + length).toString('utf8') });
                pos = start + length;
                continue;
            }
        }
        const nl = bytes.indexOf(0x0a, at);
        const end = nl < 0 ? bytes.length : nl;
        const payload = bytes.subarray(at, end).toString('utf8');
        pos = end + 1;
        if (/^[A-Z]{1,2}[[{"]/.test(payload)) {
            rows.push({ id, type: 'tag', value: null });
            continue;
        }
        try {
            rows.push({ id, type: 'json', value: JSON.parse(payload) });
        } catch {
            // A malformed row is dropped; its neighbours are unaffected.
        }
    }
    return rows;
}

/** Elements whose children are never reader-visible text. */
const SKIP_ELEMENTS = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link', 'svg', 'path',
    'head', 'iframe', 'button', 'select', 'option', 'input', 'textarea', 'form', 'nav']);

/** Elements that break a line, mirroring `BLOCK_END` in lib/watch.mjs `htmlToText`. */
const BLOCK_ELEMENTS = new Set(['p', 'div', 'li', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'section', 'article', 'blockquote', 'pre', 'table', 'thead', 'tbody', 'ul', 'ol', 'dl', 'dd', 'dt',
    'figure', 'figcaption', 'main', 'aside', 'address', 'details', 'summary', 'br', 'hr', 'title',
    'header', 'footer', 'body', 'html']);

/**
 * `$…` strings are RSC references and sentinels, not words: `$L1` a lazy component, `$@c` a
 * promise, `$Sreact.fragment` a symbol, `$undefined`, `$1` a model row. `$$…` is an escaped
 * literal dollar sign. A reference to a TEXT row is replaced by that row's text where it stands.
 */
function resolveString(value, textRows, used) {
    if (!value.startsWith('$')) return value;
    if (value.startsWith('$$')) return value.slice(1);
    const ref = value.match(/^\$([0-9a-f]+)$/i);
    if (ref && textRows.has(ref[1])) {
        used.add(ref[1]);
        return textRows.get(ref[1]);
    }
    return null;
}

/**
 * Walk a flight value collecting text, in order. Only a string that is an element's `children`
 * (at any depth of nested arrays and elements) is page text. Everything else is wire data and is
 * only searched for elements: router state (`{"b": "<build id>", "c": ["", "terms"], "f": [...]}`
 * wraps the page tree), a component's props (`companies: [...]` on ventuals.com), metadata bags.
 */
function collect(node, out, textRows, used, inChildren) {
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (typeof node === 'string' || typeof node === 'number') {
        if (!inChildren) return;
        const text = typeof node === 'number' ? String(node) : resolveString(node, textRows, used);
        if (text !== null) out.push(text);
        return;
    }
    if (Array.isArray(node)) {
        if (node[0] === '$' && typeof node[1] === 'string' && node.length >= 4) {
            const type = node[1];
            if (SKIP_ELEMENTS.has(type)) return;
            const block = BLOCK_ELEMENTS.has(type);
            const props = node[3] && typeof node[3] === 'object' ? node[3] : {};
            if (block) out.push('\n');
            if (typeof props.dangerouslySetInnerHTML?.__html === 'string') out.push(props.dangerouslySetInnerHTML.__html);
            // Only `children` is read. Other props can hold whole elements too, but those are
            // alternates the page does not show: the router's `notFound` slot put a "404: This page
            // could not be found." into every ventuals.com page read when props were walked.
            collect(props.children, out, textRows, used, true);
            if (block) out.push('\n');
            return;
        }
        for (const child of node) collect(child, out, textRows, used, inChildren);
        return;
    }
    if (typeof node === 'object') {
        for (const value of Object.values(node)) collect(value, out, textRows, used, false);
    }
}

/**
 * Readable text of a Next.js flight payload, or null when the page has no flight stream. Text rows
 * appear where the tree references them; a text row nothing references (rare) is appended at the
 * end so no words are silently lost. Tags that came through as text are left for the caller's
 * normaliser (lib/watch.mjs strips tags and entities from whatever it is given).
 */
export function nextFlightText(html) {
    const stream = nextFlightStream(html);
    if (stream === null) return null;
    const rows = parseFlightRows(stream);
    const textRows = new Map(rows.filter((r) => r.type === 'text').map((r) => [r.id, r.value]));
    const used = new Set();
    const out = [];
    for (const row of rows) {
        if (row.type !== 'json') continue;
        // A bare string row is a symbol (`"$Sreact.suspense"`) or a server value, not page prose.
        if (typeof row.value === 'string') continue;
        collect(row.value, out, textRows, used, false);
        out.push('\n');
    }
    for (const [id, text] of textRows) if (!used.has(id)) out.push('\n', text, '\n');
    return out.join('')
        .split('\n')
        .map((line) => line.replace(/[ \t]+/g, ' ').trim())
        .filter((line) => line !== '')
        .join('\n');
}
