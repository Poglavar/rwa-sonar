// Pure registry extraction for EVIDENCE.md §5.1: walks an issuer dossier (or the canonical-parties
// list) and collects every http(s) URL it cites, together with the field path it was found in
// (`documents[3].url`, `findings[2].evidence`, `whatIf[keys-stolen].cases[0]`, `redemption.rails`
// prose, …), so a URL is traceable back to the claim that depends on it. Deduped by normalised
// URL, classified pdf/html/api, with the `documents[].title` carried over as the title when that
// is where the URL came from.
// No filesystem and no network: stocks/extract-sources.mjs does the IO, this file is unit tested
// (see ../sources.test.js).

import { byString } from './io.mjs';

/**
 * A URL inside prose, stopping at whitespace and at the punctuation that normally closes a
 * citation rather than belonging to the URL: quotes, angle brackets, brackets, comma and
 * semicolon. Parentheses are NOT a stop: a URL may contain balanced ones — Republic's
 * `…Terms%20of%20Service%20(23%20June%202026)%20.pdf`, Wikipedia's `…_(disambiguation)` — and
 * stopping at `(` cut such a citation in half. A `)` that closes the surrounding prose
 * (`(see https://x.com/a)`) is unbalanced within the URL and is trimmed by `trimUrl`, together with
 * trailing sentence punctuation, which cannot be done here because a path may end in a dot.
 */
const URL_RE = /https?:\/\/[^\s"'<>[\],;`]+/g;

/** `(` minus `)` in a string: positive means an opening parenthesis is still unclosed. */
function parenDepth(text) {
    let depth = 0;
    for (const ch of text) {
        if (ch === '(') depth += 1;
        else if (ch === ')') depth -= 1;
    }
    return depth;
}

/** Query parameters that identify a campaign, not a document. Stripped when deduping. */
const TRACKING_PARAMS = new Set([
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
    'utm_name', 'utm_reader', 'utm_brand', 'utm_social', 'utm_social-type',
    'gclid', 'fbclid', 'mc_cid', 'mc_eid', 'ref_src', 'ref_url', 'igshid', 'mkt_tok'
]);

/** Hosts whose content is an API response rather than a document. */
const API_HOST_RE = /^(api|api\d|lite-api|data|rpc|graph|gateway)\./i;

/**
 * Trim the punctuation a sentence leaves stuck to a URL. Returns `null` for a citation that was
 * written down truncated (`…/token...`, `?query=...`): an ellipsis means the author elided the
 * rest, so what is left is not a URL anyone can fetch and inventing one would be worse than
 * reporting it. The caller reports those separately.
 */
export function trimUrl(raw) {
    if (typeof raw !== 'string') return null;
    let url = raw.trim();
    // A trailing ellipsis (ASCII or unicode) marks an elided URL, not a fetchable one.
    if (/(\.\.\.|…)$/.test(url)) return null;
    // Trailing punctuation, and a trailing `)` only while it has no `(` to close inside the URL:
    // `…/a).` loses both, `…_(disambiguation)` keeps its own parenthesis.
    for (;;) {
        const before = url;
        url = url.replace(/[.,;:!?'"`\]}]+$/, '');
        if (url.endsWith(')') && parenDepth(url) < 0) url = url.slice(0, -1);
        if (url === before) break;
    }
    if (!/^https?:\/\/[^/]+/i.test(url)) return null;
    return url;
}

/**
 * Normalise for dedupe only: lowercase scheme and host, drop the default port, drop the fragment,
 * drop tracking parameters, keep every other query parameter (an `?id=` or `?alt=media&token=` IS
 * the document), and give an empty path a `/`. The rest of the URL — case included — is left
 * alone, because paths are case sensitive on most servers.
 */
export function normaliseUrl(raw) {
    const trimmed = trimUrl(raw);
    if (trimmed === null) return null;
    let u;
    try {
        u = new URL(trimmed);
    } catch {
        return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.hostname === '') return null;
    u.hash = '';
    u.username = '';
    u.password = '';
    for (const key of [...u.searchParams.keys()]) {
        if (TRACKING_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
    }
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname === '') u.pathname = '/';
    let out = u.toString();
    // URL#toString keeps a lone `?` when every parameter was stripped.
    out = out.replace(/\?$/, '');
    return out;
}

/** pdf by extension, api by host/path shape, html otherwise. Content-type can correct this later. */
export function classifyKind(url) {
    let u;
    try {
        u = new URL(url);
    } catch {
        return 'html';
    }
    const path = u.pathname;
    if (/\.pdf$/i.test(path)) return 'pdf';
    if (/\.docx$/i.test(path)) return 'docx';
    if (/\.json$/i.test(path)) return 'api';
    if (API_HOST_RE.test(u.hostname)) return 'api';
    if (/(^|\/)api(\/|$)/i.test(path)) return 'api';
    return 'html';
}

/**
 * RPC responses and block-explorer views are evidence locators, not documents with stable text.
 * They stay in the provenance registry, while the chain watcher re-reads their actual accounts.
 */
export function isDocumentWatchable(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (host === 'api.mainnet-beta.solana.com') return false;
    if (host === 'explorer.solana.com' && /^\/(address|tx)\//i.test(parsed.pathname)) return false;
    // A parameterised lookup family cited in a research note is not itself a fetchable source.
    // Its exact query URLs remain watchable; the bare route only answers "missing parameter"
    // (raydium 500, Jupiter 400, Sanity 400 "no query", Drive 400 for `?id=` with no id).
    for (const [familyHost, path, param] of PARAMETERISED_FAMILIES) {
        if (host !== familyHost) continue;
        if (!(path instanceof RegExp ? path.test(parsed.pathname) : parsed.pathname === path)) continue;
        if (param === null ? !parsed.search : !parsed.searchParams.get(param)) return false;
    }
    return true;
}

/**
 * `[host, path, required parameter]`: the route is a document only with that parameter set
 * (`null`: with any query at all). The Drive entry is a prose template, `…/download?id=<fileId>`,
 * whose placeholder the URL extractor stops at.
 */
const PARAMETERISED_FAMILIES = [
    ['api-v3.raydium.io', '/pools/info/mint', null],
    ['lite-api.jup.ag', '/swap/v1/quote', null],
    ['8k2tqa6n.api.sanity.io', /^\/v[\d-]+\/data\/query\/[^/]+$/, 'query'],
    ['drive.usercontent.google.com', '/download', 'id']
];

/** Re-classify once the server has told us what it served. Falls back to the URL guess. */
export function kindFromContentType(contentType, url) {
    const ct = typeof contentType === 'string' ? contentType.toLowerCase() : '';
    if (ct.includes('application/pdf')) return 'pdf';
    if (ct.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document')) return 'docx';
    if (ct.includes('json')) return 'api';
    if (ct.includes('html') || ct.includes('xml')) return 'html';
    if (ct.includes('text/plain')) return 'html';
    return classifyKind(url);
}

/**
 * Every URL in one string, as `{url, truncated}`. `truncated` is a citation that was written with
 * an ellipsis; it carries the raw text so the caller can name it in the run summary.
 */
export function extractUrls(text) {
    if (typeof text !== 'string') return [];
    const out = [];
    for (const match of text.match(URL_RE) ?? []) {
        const url = normaliseUrl(match);
        if (url === null) out.push({ url: null, raw: match, truncated: true });
        else out.push({ url, raw: match, truncated: false });
    }
    return out;
}

/**
 * Walk any JSON value and yield `{url, path, raw, truncated}` for every URL in every string,
 * whether the string IS the URL (`sources[3]`) or merely contains it (`redemption.fees` prose).
 * `path` is the dotted/bracketed field path, which is the whole point: it says which claim leans
 * on the document.
 */
export function walkUrls(node, path = '', out = []) {
    if (typeof node === 'string') {
        for (const hit of extractUrls(node)) out.push({ ...hit, path });
        return out;
    }
    if (Array.isArray(node)) {
        node.forEach((value, i) => walkUrls(value, `${path}[${i}]`, out));
        return out;
    }
    if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
            walkUrls(value, path === '' ? key : `${path}.${key}`, out);
        }
    }
    return out;
}

/**
 * A `whatIf[]` citation, whose ARRAY INDEX is meaningless to a reader and unstable across edits:
 * inserting one answer renumbers every later one, so `whatIf[7].url` in the registry would point
 * at a different failure mode tomorrow. The mode id never moves, so it is what the label carries.
 */
const WHATIF_PATH = /^whatIf\[(\d+)\](.*)$/;

/**
 * The path as the registry records it. Everything is passed through unchanged except a `whatIf[]`
 * citation, which is relabelled by its failure MODE:
 *   `whatIf[7].url`            -> `whatIf[issuer-wind-down]`
 *   `whatIf[7].cases[1].url`   -> `whatIf[issuer-wind-down].cases[1]`
 *   `whatIf[7].searched[0]`    -> `whatIf[issuer-wind-down].searched[0]`
 * The trailing `.url` is dropped because it says nothing (the registry holds URLs). An entry with
 * no `mode` keeps its index rather than being dropped — a URL nobody can attribute is still a URL
 * the watcher must re-read.
 */
export function labelPath(doc, path) {
    const m = WHATIF_PATH.exec(typeof path === 'string' ? path : '');
    if (m === null) return path;
    const entry = Array.isArray(doc?.whatIf) ? doc.whatIf[Number(m[1])] : null;
    const mode = typeof entry?.mode === 'string' && entry.mode.trim() !== '' ? entry.mode.trim() : null;
    return `whatIf[${mode ?? m[1]}]${m[2].replace(/\.url$/, '')}`;
}

/** `documents[2].url` -> the `title` of that entry, when the dossier has one. */
function documentTitle(doc, path) {
    const m = /^documents\[(\d+)\]\.url$/.exec(path);
    if (!m) return null;
    const entry = Array.isArray(doc?.documents) ? doc.documents[Number(m[1])] : null;
    const title = entry?.title;
    return typeof title === 'string' && title.trim() !== '' ? title.trim() : null;
}

/**
 * Registry from a list of `{slug, doc}` dossiers (plus any extra documents, e.g.
 * canonical-parties.json, passed with a slug of `null`). Items are deduped by normalised URL and
 * sorted by URL so the written file is stable byte for byte across machines and runs.
 *
 * Attribution rules: `issuer` is the dossier that cites the URL in its `documents[]` if any does
 * (that is the strongest citation), else the first dossier by slug; `foundIn` keeps EVERY path
 * from EVERY dossier as `<slug>:<path>`, so a shared URL still shows all of its dependants.
 */
export function buildRegistry(dossiers, { generatedAt } = {}) {
    if (!generatedAt) throw new Error('buildRegistry needs generatedAt — a timestamp is never invented here');
    const byUrl = new Map();
    const truncated = [];

    for (const { slug, doc } of dossiers) {
        const prefix = slug ?? 'shared';
        for (const hit of walkUrls(doc)) {
            // The label a reader sees; `hit.path` stays the raw path, because documentTitle() and
            // anything else that indexes back into the document needs the real index.
            const label = labelPath(doc, hit.path);
            if (hit.truncated) {
                truncated.push({ issuer: slug ?? null, path: label, raw: hit.raw });
                continue;
            }
            let item = byUrl.get(hit.url);
            if (!item) {
                item = {
                    url: hit.url,
                    kind: classifyKind(hit.url),
                    issuer: null,
                    title: null,
                    foundIn: [],
                    _docTitle: null,
                    _docIssuer: null,
                    _firstIssuer: null
                };
                byUrl.set(hit.url, item);
            }
            const tagged = `${prefix}:${label}`;
            if (!item.foundIn.includes(tagged)) item.foundIn.push(tagged);
            if (slug && item._firstIssuer === null) item._firstIssuer = slug;
            const documentMatch = /^documents\[(\d+)\]\.url$/.exec(hit.path);
            const format = documentMatch ? doc.documents?.[Number(documentMatch[1])]?.format : null;
            if (['pdf', 'docx', 'html', 'api'].includes(format)) item.kind = format;
            const title = documentTitle(doc, hit.path);
            if (title && item._docTitle === null) {
                item._docTitle = title;
                item._docIssuer = slug ?? null;
            }
        }
    }

    const items = [...byUrl.values()].map((item) => {
        const foundIn = [...item.foundIn].sort(byString);
        return {
            url: item.url,
            kind: item.kind,
            issuer: item._docIssuer ?? item._firstIssuer ?? null,
            // No document title means the field path is the best name we have for it, which is
            // more useful than a null: `findings[4].evidence` says what depends on the document.
            title: item._docTitle ?? foundIn[0] ?? null,
            foundIn
        };
    }).sort((a, b) => byString(a.url, b.url));

    return { generatedAt, count: items.length, items, truncated };
}

/**
 * Add curated RWA research citations to the public-source registry. `foundIn` carries a stable,
 * explicit attribution because the existing source table has no product columns and issuer is
 * correctly nullable for these non-issuer dossiers. A citation is tagged once per applicable
 * holder context, so a shared URL remains filterable by product without assigning it to an issuer.
 */
export function addResearchSources(items, research, { generatedAt } = {}) {
    if (!generatedAt) throw new Error('addResearchSources needs generatedAt');
    const byUrl = new Map((Array.isArray(items) ? items : []).map((item) => [normaliseUrl(item.url), { ...item, foundIn: [...(item.foundIn ?? [])] }]));
    for (const product of research?.products ?? []) {
        const productId = product?.id;
        const instrumentId = product?.instrument?.id;
        if (typeof productId !== 'string' || typeof instrumentId !== 'string') continue;
        const contexts = Array.isArray(product.contexts) ? product.contexts : [];
        for (const source of product.sources ?? []) {
            const url = normaliseUrl(source?.url);
            if (!url || typeof source.id !== 'string' || !source.id || typeof source.title !== 'string' || !source.title.trim()) continue;
            let item = byUrl.get(url);
            if (!item) {
                item = { url, kind: classifyKind(url), issuer: null, title: source.title.trim(), foundIn: [] };
                byUrl.set(url, item);
            }
            for (const context of contexts) {
                if (typeof context?.id !== 'string' || typeof context?.termsId !== 'string') continue;
                const tag = `product=${encodeURIComponent(productId)}|instrument=${encodeURIComponent(instrumentId)}|context=${encodeURIComponent(context.id)}|terms=${encodeURIComponent(context.termsId)}|source=${encodeURIComponent(source.id)}`;
                if (!item.foundIn.includes(tag)) item.foundIn.push(tag);
            }
        }
    }
    const merged = [...byUrl.values()].map((item) => ({ ...item, foundIn: [...item.foundIn].sort(byString) }))
        .sort((a, b) => byString(a.url, b.url));
    return { generatedAt, count: merged.length, items: merged };
}

/** Find registry citations for one curated research product id. */
export function matchesResearchProduct(item, productId) {
    if (typeof productId !== 'string' || productId === '') return false;
    const prefix = `product=${encodeURIComponent(productId)}|`;
    return Array.isArray(item?.foundIn) && item.foundIn.some((label) => typeof label === 'string' && label.startsWith(prefix));
}

/** `{key: n}` sorted by count then key, for the run summary. */
export function countBy(items, pick) {
    const counts = new Map();
    for (const item of items) {
        const key = pick(item) ?? 'none';
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1] || byString(a[0], b[0])));
}

/** Host of a URL, lowercased; `null` for something unparseable (which normaliseUrl already bars). */
export function hostOf(url) {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return null;
    }
}

/** The `limit` hosts with the most URLs, as `[host, n]` pairs. */
export function topHosts(items, limit = 10) {
    return Object.entries(countBy(items, (item) => hostOf(item.url))).slice(0, limit);
}

/**
 * Mark the registry items that stocks/data/retired-sources.json retires: the item stays in the
 * registry (its citations still exist, and the dossiers and the evidence history still point at it)
 * but carries `retired: {at, reason}`, so the document watcher stops fetching it and records it as
 * retired instead. An entry must name a date and a reason; one that matches no registry item is
 * returned in `unmatched`, so a stale retirement is reported rather than silently kept.
 */
export function applyRetirements(items, retirements = []) {
    const byUrl = new Map();
    for (const entry of Array.isArray(retirements) ? retirements : []) {
        const url = normaliseUrl(entry?.url);
        if (!url) throw new Error(`retired source without a usable url: ${JSON.stringify(entry)}`);
        if (typeof entry.retiredAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.retiredAt)) {
            throw new Error(`retired source ${url} needs retiredAt as YYYY-MM-DD`);
        }
        if (typeof entry.reason !== 'string' || entry.reason.trim() === '') throw new Error(`retired source ${url} needs a reason`);
        byUrl.set(url, entry);
    }
    const matched = new Set();
    const out = items.map((item) => {
        const entry = byUrl.get(item.url);
        if (!entry) return item;
        matched.add(item.url);
        return { ...item, retired: { at: entry.retiredAt, reason: entry.reason } };
    });
    const unmatched = [...byUrl.keys()].filter((url) => !matched.has(url));
    return { items: out, retired: matched.size, unmatched };
}
