// The document watcher's pure half (EVIDENCE.md §2): turn a fetched byte stream into the
// normalised text that gets hashed, decide from the HTTP result what state the source is in,
// score a diff by the §2.3 keyword list, and render the SQL that mirrors a run into
// sonar.source / sonar.source_version / sonar.change_event. No network and no filesystem here, so
// every decision is unit tested (../watch.test.js); stocks/watch-sources.mjs does the IO.

import { createHash } from 'node:crypto';

import { claimId, jsonbLiteral, renderUpsert, whatIfId } from './db-load.mjs';
import { byString } from './io.mjs';
import { nextFlightText } from './nextflight.mjs';
import { renderNotionBlocks } from './notion.mjs';

/** A source's stable id and on-disk directory name: the first 12 hex of sha256(url). */
export function sourceId(url) {
    if (typeof url !== 'string' || url === '') throw new Error('sourceId needs a url');
    return createHash('sha256').update(url).digest('hex').slice(0, 12);
}

/** Full runs own the collector heartbeat; targeted repair/smoke runs get scoped diagnostics. */
export function sourceWatchStatsFileName({ only = null, limit = null, onlyBlocked = false } = {}) {
    if (!only && !limit && !onlyBlocked) return '.last-source-watch-stats.json';
    const scope = [onlyBlocked ? 'only-blocked' : null, only || null, limit ? `limit-${limit}` : null]
        .filter(Boolean).join('-').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
    return `.last-source-watch-stats-${scope}.json`;
}

/**
 * The sources `--only-blocked` re-reads: those whose stored state says the live host did not give
 * us the document last time — `blocked` (a refusal, a bot wall, a JavaScript-only page, a 400/429),
 * the same refusal on a source no quote relies on (`reachable-unverified`),
 * or read from an archived capture or a companion API because the live page refused us. A repair run over exactly
 * these measures what a fallback change buys without re-fetching the other ~500 sources.
 */
export function previouslyBlocked(sources, state) {
    return (Array.isArray(sources) ? sources : []).filter((source) => {
        const prev = state?.[source?.url];
        if (!prev) return false;
        return prev.status === 'blocked' || prev.status === 'reachable-unverified' || prev.via === 'wayback' || prev.readVia === 'wayback'
            || (typeof prev.companionUrl === 'string' && prev.companionUrl !== '');
    });
}

export function sha256Hex(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** `2026-09-17T15:06:09Z` -> `2026-09-17T15-06-09Z`, so it can be a filename everywhere. */
export function fileStamp(isoTs) {
    return String(isoTs).replace(/:/g, '-');
}

/** Extension for the raw copy of a fetch, by the kind the server actually served. */
export function rawExtension(kind) {
    if (kind === 'pdf') return 'pdf';
    if (kind === 'api') return 'json';
    return 'html';
}

// --- normalisation ---------------------------------------------------------------------------

/** Elements whose text is chrome, not content: never part of what we hash. */
// `footer` is deliberately NOT dropped: that is where sites put the legal disclaimer ("xStocks
// are not available in the United States or to U.S. persons…", the MiFID distributor line), and
// stripping it cost a sourced claim its words on 2026-09-18. Copyright years and cookie lines
// in a footer are churn the line filter already removes.
const DROP_BLOCKS = /<(script|style|noscript|template|svg|iframe|nav|header|form|select|button)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/**
 * The same, keeping `<header>`: what the QUOTE check reads. A `<header>` is usually page chrome
 * (logo, menu), which is why the hashed text drops it, but a page can put content there too —
 * republic.com/rspax renders its offering-summary strip (status "Closed", price per token, the
 * minimum investment) inside a `<header>`, so quotes of those words read as lost (2026-09-23).
 * Chrome kept in the quote text costs nothing: a quote is looked FOR, extra lines cannot lose it.
 */
const DROP_BLOCKS_KEEP_HEADER = /<(script|style|noscript|template|svg|iframe|nav|form|select)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/**
 * The quote reading also keeps `<button>` text (dropped above only for the hash: "Get", "Invest"
 * are chrome) and appends every inline `<script>` body. A server-rendered page can carry the words
 * it renders as a data payload: superstate.com/assets/fwdi ships its holdings breakdown as a
 * SvelteKit object inside a `<script>`, and a quote of it read as lost (2026-09-24). Like the
 * header rule above, extra text in the quote reading cannot lose a quote; the hash never sees it.
 */
const INLINE_SCRIPT = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script\s*>/gi;

/** Elements that end a line of text. */
const BLOCK_END = /<\/(p|div|li|tr|td|th|h[1-6]|section|article|blockquote|pre|table|thead|tbody|ul|ol|dl|dd|dt|figure|figcaption|main|aside|address|details|summary)\s*>/gi;

const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
    thinsp: ' ', shy: '', ndash: '-', mdash: '-', minus: '-', hellip: '…', bull: '*',
    lsquo: "'", rsquo: "'", sbquo: ',', ldquo: '"', rdquo: '"', copy: '©', reg: '®',
    trade: '™', deg: '°', euro: '€', pound: '£', yen: '¥', cent: '¢', middot: '·',
    laquo: '«', raquo: '»', times: '×', divide: '/', frac12: '1/2', sup2: '2', sup3: '3'
};

/** Decode the entity forms that survive tag stripping. Unknown names are left as written. */
export function decodeEntities(text) {
    return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X'
                ? Number.parseInt(body.slice(2), 16)
                : Number.parseInt(body.slice(1), 10);
            if (!Number.isFinite(code) || code < 9 || code > 0x10ffff) return whole;
            try {
                return String.fromCodePoint(code);
            } catch {
                return whole;
            }
        }
        const named = NAMED_ENTITIES[body.toLowerCase()];
        return named === undefined ? whole : named;
    });
}

/**
 * Lines that churn without the document changing, so hashing them would report a change every
 * single day and the real ones would drown: a bare date or timestamp, a relative time, a view or
 * follower counter, a cookie/consent banner and a spinner.
 *
 * Deliberately NOT dropped: a line like `Last updated 2026-09-08`, which is a date WITH a label.
 * That one only moves when the document itself moves, and on a terms-of-service page it is the
 * single most informative line on the page — dropping it would throw away signal, not noise.
 */
const CHURN_PATTERNS = [
    // Bare dates and datetimes, in the forms these sites actually print.
    /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?)?$/i,
    /^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$/,
    /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2},? \d{4}$/i,
    /^\d{1,2} (jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{4}$/i,
    /^\d{1,2}:\d{2}(:\d{2})?( ?[ap]\.?m\.?)?( [a-z]{2,5})?$/i,
    // Relative times.
    /^(about |over |almost |~)?\d+ (second|minute|hour|day|week|month|year)s? ago$/i,
    /^(just now|yesterday|today|a (few )?(second|minute|hour|day)s? ago)$/i,
    // Counters.
    /^\d[\d,. ]*(k|m|b)? ?(views?|reads?|followers?|following|likes?|comments?|members?|online|users?|shares?|replies|posts?)$/i,
    /^\(\d[\d,.]*\)$/,
    // Spinners, nav chrome and no-JS notices.
    /^(loading|loading[.…]{1,3}|please wait[.…]{0,3}|skip to (main )?content|back to top|menu|close|search)$/i,
    /^(you need to enable javascript|please enable javascript|javascript is required)/i
];

/**
 * A cookie banner needs all three: a cookie/GDPR word, a banner verb, and to be short. A
 * paragraph in a terms of service is long and survives; `We use cookies to improve your
 * experience. Accept all` does not.
 */
const COOKIE_WORD = /\bcookies?\b|\bgdpr\b|privacy preferences|cookie (consent|settings|policy)|manage consent/i;
const COOKIE_BANNER_VERB = /(accept|reject|allow all|deny|manage|we use|uses? cookies|settings|preferences|opt[- ]?out)/i;
const COOKIE_BANNER_MAX = 300;

/**
 * A price or percentage alone on a line, e.g. `$76,336.00`, `-0.79%`, `2,451.08`: a live ticker
 * widget. This is what made a news page report a 432-line change between two runs eleven minutes
 * apart (measured on decrypt.co, 2026-09-17: a BTC/ETH/BNB price strip above the article). Applied
 * to HTML ONLY, never to PDF text — in a prospectus a bare `0.50%` on its own line is a cell of a
 * fee table, and a fee changing is exactly what must not be filtered away.
 */
const BARE_NUMBER = /^[-+]?[$€£¥]?\d[\d, .]*%?$/;

/**
 * Note what is deliberately NOT churn: a long opaque token on its own line. A 32-44 character
 * base58 string is what a Solana mint or authority key looks like, and an authority key appearing
 * or changing in a document is precisely the event this watcher exists to catch, so a "looks like a
 * session id" rule would throw away the best signal on the page. A false `changed` costs one
 * info-severity version row; a dropped key costs the finding.
 */
export function looksLikeChurn(line, { htmlWidgets = false } = {}) {
    const text = line.trim();
    if (text === '') return true;
    if (COOKIE_WORD.test(text) && COOKIE_BANNER_VERB.test(text) && text.length < COOKIE_BANNER_MAX) {
        return true;
    }
    if (htmlWidgets && BARE_NUMBER.test(text)) return true;
    return CHURN_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Invisible characters that are not `\n` but do split or pad a line: non-breaking and zero-width
 * spaces, the Unicode line/paragraph separators, and a stray BOM. Built at runtime rather than
 * written as a regex literal, because a literal U+2028 in the source WOULD END THE LINE it is on.
 */
const INVISIBLE = new RegExp(`[${String.fromCharCode(0x00a0, 0x200b, 0x200c, 0x200d, 0x2028, 0x2029, 0xfeff)}]`, 'g');

/**
 * Collapse runs of whitespace inside a line, drop churn lines, drop empties. `htmlWidgets` turns on
 * the HTML-only rules (see `looksLikeChurn`); PDF and JSON text is filtered more conservatively,
 * because there every line is content someone wrote.
 *
 * `keepChurn` keeps the churn lines (only empties go): that is the text the verbatim QUOTE check
 * reads. The churn filter exists so the hash and the diff do not move with a ticker, but it also
 * drops a price alone on its line — `$275` on republic.com/rspax — and a quote containing that
 * amount then reads as lost (2026-09-23). The hash and diff keep the filtered text.
 */
export function normaliseLines(text, { htmlWidgets = false, keepChurn = false } = {}) {
    const out = [];
    for (const raw of String(text).replace(/\r\n?/g, '\n').replace(INVISIBLE, ' ').split('\n')) {
        const line = raw.replace(/[\t\f\v]/g, ' ').replace(/ {2,}/g, ' ').trim();
        if (keepChurn ? line === '' : looksLikeChurn(line, { htmlWidgets })) continue;
        out.push(line);
    }
    return out.join('\n');
}

/**
 * HTML -> readable text: chrome elements removed, tags stripped, entities decoded. `forQuotes`
 * is the quote check's reading: churn lines kept (see `normaliseLines`) and `<header>` content
 * kept (see `DROP_BLOCKS_KEEP_HEADER`). The default is the reading that is hashed and diffed.
 */
export function htmlToText(html, { forQuotes = false } = {}) {
    let text = String(html);
    text = text.replace(/<!--[\s\S]*?-->/g, ' ');
    const payloads = forQuotes ? [...text.matchAll(INLINE_SCRIPT)].map((m) => m[1].trim()).filter((body) => body !== '') : [];
    // Two passes: a <nav> inside a <header> only disappears once its parent has gone.
    const drop = forQuotes ? DROP_BLOCKS_KEEP_HEADER : DROP_BLOCKS;
    text = text.replace(drop, ' ').replace(drop, ' ');
    text = text.replace(/<br\s*\/?>/gi, '\n').replace(BLOCK_END, '\n');
    text = text.replace(/<[^>]*>/g, ' ');
    text = decodeEntities(text);
    if (payloads.length) text = `${text}\n${payloads.join('\n')}`;
    return normaliseLines(text, { htmlWidgets: true, keepChurn: forQuotes });
}

/**
 * Below this many characters of extracted HTML text a page is "short": the same bound
 * `jsOnlyShell` uses for "a browser would have rendered more than this".
 */
const SHORT_HTML_TEXT = 600;

/** Real markup tags only — never a comparison like `<5M` in prose (see `quoteKey`). */
const MARKUP_TAG = /<\/?[A-Za-z][A-Za-z0-9:_-]*(?:\s[^>\n]*)?\s*\/?>/g;

/**
 * HTML -> readable text, and which reader produced it. A Next.js App Router page rendered on the
 * client ships an empty body and puts its words in the `self.__next_f` flight payload instead:
 * ventuals.com/terms normalised to the 23 characters "Terms of Use | Ventuals" while 31 kB of
 * Terms sat in the same response (2026-09-23). When the markup yields a SHORT text and the flight
 * payload yields MORE, the flight text is the document (lib/nextflight.mjs); a server-rendered
 * page, whose body already carries the text, keeps the plain HTML reading untouched.
 */
export function htmlDocumentText(html) {
    const text = htmlToText(html);
    const plain = () => ({ text, quoteText: htmlToText(html, { forQuotes: true }), via: 'html' });
    if (text.length >= SHORT_HTML_TEXT) return plain();
    const flight = nextFlightText(html);
    if (flight === null) return plain();
    const flightRaw = decodeEntities(flight.replace(MARKUP_TAG, ' '));
    const flightText = normaliseLines(flightRaw, { htmlWidgets: true });
    if (flightText.length <= text.length) return plain();
    return {
        text: flightText,
        quoteText: normaliseLines(flightRaw, { htmlWidgets: true, keepChurn: true }),
        via: 'next-flight'
    };
}

/**
 * JSON -> text with keys sorted, so a server that shuffles its key order is not reported as
 * having changed anything. Unparseable JSON falls back to plain text normalisation.
 */
export function jsonToText(body, { keepChurn = false } = {}) {
    try {
        const sorted = sortKeysDeep(JSON.parse(body));
        return normaliseLines(JSON.stringify(sorted, null, 1), { keepChurn });
    } catch {
        return normaliseLines(body, { keepChurn });
    }
}

function sortKeysDeep(value) {
    if (Array.isArray(value)) return value.map(sortKeysDeep);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort(byString).map((k) => [k, sortKeysDeep(value[k])]));
    }
    return value;
}

/** pdftotext output -> text: page breaks and layout padding out, churn lines out. */
export function pdfTextToText(text, { keepChurn = false } = {}) {
    return normaliseLines(String(text).replace(/\f/g, '\n'), { keepChurn });
}

/** Normalise by kind. The kind is the one the CONTENT-TYPE said, not the one the URL guessed. */
export function normaliseByKind(kind, payload, { keepChurn = false } = {}) {
    if (kind === 'pdf') return pdfTextToText(payload, { keepChurn });
    if (kind === 'api') return jsonToText(payload, { keepChurn });
    const read = htmlDocumentText(payload);
    return keepChurn ? read.quoteText : read.text;
}

/**
 * A stored version re-read for the quote check (a 304, or the same Wayback capture as last run):
 * the raw copy kept on disk -> `{text, quoteText, jsOnly}`, where `text` is the churn-filtered
 * reading (what was hashed) and `quoteText` the unfiltered one. `rawExt` is the stored file's
 * extension, `via` the reader recorded for it; `payload` is the raw file as a string — for a PDF,
 * pdftotext's output, which only the IO side can produce. `jsOnly` says the stored copy is itself a
 * JavaScript shell: a 304 then only confirms that nothing readable is still nothing readable.
 * Null for a stored copy that cannot be re-read (a binary marker, an unparseable recordMap).
 */
export function storedReading({ rawExt, via = null, payload }) {
    if (typeof payload !== 'string') return null;
    if (via === 'binary') return null;
    if (rawExt === 'pdf') {
        return { text: pdfTextToText(payload), quoteText: pdfTextToText(payload, { keepChurn: true }), jsOnly: false };
    }
    if (rawExt === 'json' && via === 'notion') {
        let doc;
        try {
            doc = JSON.parse(payload);
        } catch {
            return null;
        }
        if (!doc?.recordMap || typeof doc.pageId !== 'string') return null;
        const rendered = renderNotionBlocks(doc.recordMap, doc.pageId);
        return {
            text: normaliseLines(rendered, { htmlWidgets: true }),
            quoteText: normaliseLines(rendered, { htmlWidgets: true, keepChurn: true }),
            jsOnly: false
        };
    }
    if (rawExt === 'json') {
        return { text: jsonToText(payload), quoteText: jsonToText(payload, { keepChurn: true }), jsOnly: false };
    }
    const read = htmlDocumentText(payload);
    return { text: read.text, quoteText: read.quoteText, jsOnly: isJsOnlyRead({ kind: 'html', text: read.text, rawHtml: payload }) };
}

/**
 * Publisher-specific article tails that change independently of the cited story. This runs after
 * generic HTML extraction and is deliberately host-scoped: stripping a heading globally could
 * remove substantive text from another document. The retained prefix contains the full article.
 */
export function stripPublisherChrome(url, text) {
    let host = '';
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return text;
    }
    const markers = host === 'www.coindesk.com'
        ? ['\nLatest Crypto News\n']
        : host === 'www.tekedia.com'
            ? ['\nProducts\n']
            : host === 'www.cryptotimes.io'
                ? ['\nCrypto Connections\n']
            : [];
    let output = String(text);
    for (const marker of markers) {
        const index = output.indexOf(marker);
        if (index >= 0) output = output.slice(0, index);
    }
    return output.trim();
}

/**
 * The text-extraction generation a source is read with; a rise drops the conditional headers once
 * and refreshes the baseline without an external-change event (watch-sources.mjs). Increment when
 * an extraction rule changes. PDF and JSON extraction are generation 1. HTML is 2 since the
 * Next.js flight reader (`htmlDocumentText`): without the bump a page stored as a title would keep
 * answering 304 to its old etag and never be read again. The host-scoped publisher rules add one.
 */
export function publisherNormalizerVersion(url, kind = 'html') {
    const base = kind === 'html' ? 2 : 1;
    try {
        const host = new URL(url).hostname.toLowerCase();
        return ['www.coindesk.com', 'www.tekedia.com', 'www.cryptotimes.io'].includes(host) ? base + 1 : base;
    } catch {
        return base;
    }
}

/**
 * `%PDF-` at byte zero. Google Drive serves every download as `application/octet-stream`
 * (measured on all six of the Drive files the dossiers cite, 2026-09-18), so the content-type
 * cannot say what it is and `kindFromContentType` falls back to the URL — which, for
 * `drive.google.com/uc?export=download&id=…`, has no extension to guess from and yields `html`.
 * The bytes themselves are unambiguous, so they get the last word: a document that IS a PDF goes
 * through `pdftotext` instead of having its binary stream stripped of angle brackets.
 */
export function looksLikePdf(buffer) {
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');
    return bytes.subarray(0, 5).toString('latin1') === '%PDF-';
}

/**
 * The direct-download URL for a Google Drive file link, or null for anything else.
 *
 * Backpack Securities publishes all five of its binding documents — the issuer terms, the trust
 * deed, the risk disclosure, the brokerage terms, the exchange user agreement — as
 * `https://drive.google.com/file/d/<id>/view` links, and that page is Drive's own JavaScript
 * viewer: the watcher's stored text for them was two lines, the file name and `Учитава се…`
 * (the "Loading…" of whatever locale Google guessed), so five legal PDFs were recorded as
 * watched while nothing about them was being watched at all. `…/uc?export=download&id=<id>`
 * answers with the actual bytes — a 303 to `drive.usercontent.google.com/download?…` and then
 * the PDF, followed by the normal redirect handling. The registered source URL stays the Drive
 * link, because that is what the dossier cites and what a reader would open.
 *
 * Only a FILE link is rewritten. A `/drive/folders/…` link is a listing rather than a document,
 * and there is no download URL to invent for it.
 */
export function driveDownloadUrl(url) {
    let u;
    try {
        u = new URL(String(url));
    } catch {
        return null;
    }
    const host = u.hostname.toLowerCase();
    if (host !== 'drive.google.com' && host !== 'docs.google.com') return null;
    const path = u.pathname.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/);
    const id = path ? path[1] : (/\/(open|uc)$/.test(u.pathname) ? u.searchParams.get('id') : null);
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{10,}$/.test(id)) return null;
    return `https://drive.google.com/uc?export=download&id=${id}`;
}

/**
 * A Dropbox shared FILE link (`/scl/fi/<id>/<name>`, or a file inside a shared folder,
 * `/scl/fo/<id>/<key>/<path>/<name.ext>`) with `dl=0` serves Dropbox's JavaScript previewer,
 * which the watcher can only record as `blocked`; the same link with `dl=1` answers with the
 * file's bytes (measured 2026-09-24 on Ankura's Ondo daily reports: `application/binary`, the
 * PDF). The dossier keeps citing the `dl=0` link a reader opens; only the fetch moves.
 *
 * A shared FOLDER link (`/scl/fo/<id>/<key>` with no file path) is not rewritten: its `dl=1` is a
 * zip of the whole folder (31 MB for the Ondo daily reports), which is not a document. Cite the
 * individual file instead.
 */
export function dropboxDownloadUrl(url) {
    let u;
    try {
        u = new URL(String(url));
    } catch {
        return null;
    }
    const host = u.hostname.toLowerCase();
    if (host !== 'www.dropbox.com' && host !== 'dropbox.com') return null;
    const segments = u.pathname.split('/').filter(Boolean);
    const isFile = (segments[0] === 'scl' && segments[1] === 'fi' && segments.length >= 4)
        || (segments[0] === 'scl' && segments[1] === 'fo' && segments.length >= 5 && /\.[A-Za-z0-9]{2,5}$/.test(segments[segments.length - 1]));
    if (!isFile) return null;
    u.searchParams.set('dl', '1');
    return u.toString();
}

/** Content types we can turn into text. Everything else is bytes we can only watch as bytes. */
const TEXTUAL = /(^text\/)|html|xml|json|javascript|csv|plain|urlencoded/i;

export function isTextual(contentType) {
    return TEXTUAL.test(String(contentType ?? ''));
}

/**
 * A body the server labelled as bytes (`application/octet-stream`) that is really text: valid
 * UTF-8 with no NUL and hardly any other control characters. stocks.securitize.io serves its broker
 * instructions (`/drs/brokers/general_instructions.md`) that way, and three quotes verbatim in it
 * were reported lost because the file was hashed as a binary marker (2026-09-24). A zip, an image
 * or a PDF fails the UTF-8 or the NUL test.
 */
export function looksLikeText(buffer) {
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');
    if (bytes.length === 0 || bytes.includes(0)) return false;
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return false;
    }
    const controls = (text.match(/[\u0001-\u0008\u000e-\u001f\u007f]/g) ?? []).length;
    return controls / text.length < 0.001;
}

/**
 * What to hash for a payload that is neither text nor PDF. One of the dossiers cites a `.zip` of
 * attestations from a CDN; decoding a zip as UTF-8 produced 1.6 MB of mojibake whose hash would
 * change with the compressor's mood. So a binary source is watched as BYTES: a single marker line
 * that says what it is, how big it is and the digest of its contents. A change in the bundle still
 * raises a version and a diff of one line, and nothing pretends to have read it.
 */
export function binaryMarker(buffer, contentType) {
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');
    const digest = createHash('sha256').update(bytes).digest('hex');
    return `binary ${String(contentType ?? 'unknown').split(';')[0].trim()} `
        + `${bytes.length} bytes sha256:${digest}`;
}

// --- severity --------------------------------------------------------------------------------

/**
 * EVIDENCE.md §2.3 keyword list. Word boundaries matter: `transferFeeBps` in a JSON body must not
 * count as the word "fee", while `Fee Schedule` must.
 */
export const KEYWORDS = [
    ['redemption', /\bredemptions?\b|\bredeem(s|ed|able|ing)?\b/i],
    ['fee', /\bfees?\b/i],
    ['custody', /\bcustody\b/i],
    ['custodian', /\bcustodians?\b/i],
    ['jurisdiction', /\bjurisdictions?\b/i],
    ['governing law', /\bgoverning law\b/i],
    ['freeze', /\bfreez(e|es|ing)\b|\bfrozen\b/i],
    ['pause', /\bpaus(e|es|ed|ing)\b|\bpausable\b/i],
    ['clawback', /\bclaw[- ]?backs?\b/i],
    ['burn', /\bburn(s|ed|ing|t)?\b/i],
    ['delegate', /\bdelegat(e|es|ed|ing|ion)\b/i],
    ['authority', /\bauthorit(y|ies)\b/i],
    ['terminate', /\bterminat(e|es|ed|ing|ion)\b/i],
    ['suspend', /\bsuspend(s|ed|ing)?\b|\bsuspensions?\b/i],
    ['eligibility', /\beligibility\b|\beligible\b/i],
    ['lock-up', /\block[- ]?ups?\b|\blocked[- ]?up\b/i],
    ['dividend', /\bdividends?\b/i]
];

/**
 * A price ticker quoted inline in prose: a symbol, a price and a signed % change —
 * `xStocks AAPLx $343.15 +1.3% offers SPCXx`, `built on Wormhole W $0.012 +3.1% and`. News sites
 * render these from a live feed, so the sentence around one "changes" on every fetch (sonar
 * change_event 197, 2026-09-23: the only difference was `$343.15 +1.3%` -> `$341.91 +0.9%`, and
 * the unchanged word "redemption" elsewhere in that line raised it to `caution`). The % change is
 * required, so a price stated in prose (`USDC $1.00`) is not mistaken for a widget.
 */
const TICKER_INLINE = /\b[A-Z][A-Z0-9]{0,11}x?\s+\$\s?\d[\d,]*(?:\.\d+)?\s+[-+]\d+(?:\.\d+)?%/g;
/** One token of a ticker strip: a symbol, a price, a % change, or the words up/down/percent. */
const TICKER_WORD = /^(?:[A-Z][A-Z0-9]{0,11}x?|\$|[$€£]?\d[\d,]*(?:\.\d+)?%?|[-+]\d+(?:\.\d+)?%|up|down|percent)$/;
/** "2 hours ago" inside a line: a news list re-stamps every item on every fetch. */
const RELATIVE_TIME_INLINE = /\b(?:about |over |almost |~)?\d+ (?:second|minute|hour|day|week|month|year)s? ago\b/gi;

/**
 * A line that is nothing but a price-ticker strip: symbols, prices and % changes and no prose —
 * CoinDesk's footer `CD20 $2,495.93 CD20 up 1.32 percent 1.32% BTC $86,553.96 BTC up 0.81 …`.
 * Needs at least one symbol and one `$` price, so a bare number line is left to `looksLikeChurn`.
 */
export function isTickerLine(line) {
    const words = String(line ?? '').trim().split(/\s+/).filter(Boolean);
    if (words.length < 2 || !words.every((w) => TICKER_WORD.test(w))) return false;
    return words.some((w) => /^[A-Z]/.test(w)) && words.some((w) => w.includes('$'));
}

/** What is left of a changed line once the parts that move by themselves are taken out. */
function volatileKey(line) {
    return String(line)
        .replace(TICKER_INLINE, ' ')
        .replace(RELATIVE_TIME_INLINE, ' ')
        // A news list renumbers its items when one is added on top ("1 …" becomes "2 …").
        .replace(/^\s*\d{1,3}\s+(?=\S)/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * The changed lines that carry a real change: ticker-strip lines dropped, and every removed line
 * cancelled against an added line that is the same once inline tickers, relative times and a list
 * ordinal are taken out (a multiset match, so two identical lines cancel two, not one).
 * A line that only moved position still counts — that is the diff's business, not churn.
 */
export function substantiveChanges({ removedLines = [], addedLines = [] } = {}) {
    const keep = (line) => !isTickerLine(line) && volatileKey(line) !== '';
    const removed = removedLines.filter(keep);
    const added = addedLines.filter(keep);
    const addedKeys = new Map();
    for (const line of added) {
        const key = volatileKey(line);
        addedKeys.set(key, (addedKeys.get(key) ?? 0) + 1);
    }
    const cancelled = new Map();
    const out = [];
    for (const line of removed) {
        const key = volatileKey(line);
        if ((addedKeys.get(key) ?? 0) > 0) {
            addedKeys.set(key, addedKeys.get(key) - 1);
            cancelled.set(key, (cancelled.get(key) ?? 0) + 1);
        } else {
            out.push(line);
        }
    }
    for (const line of added) {
        const key = volatileKey(line);
        if ((cancelled.get(key) ?? 0) > 0) {
            cancelled.set(key, cancelled.get(key) - 1);
        } else {
            out.push(line);
        }
    }
    return out;
}

/**
 * Severity of a document change from the cheapest signal that exists today (EVIDENCE.md §2.3):
 * a changed line carrying one of the keywords is `caution`, anything else is `info`. The quote
 * check that would make it `warning` is slice 2 — see `claimQuoteCheckHook` below.
 *
 * `api` sources are capped at `info` and never raise an event: a price or supply endpoint changes
 * between two fetches by design, so keyword-matching its body would fill the change feed with
 * noise and bury the legal terms this is for. Their movement is the market and on-chain watchers'
 * subject (EVIDENCE.md §2.4, §2.5), not the document watcher's.
 */
export function severityForChange({ kind, changedLines, removedLines = null, addedLines = null }) {
    // Keywords are looked for in the lines that REALLY changed (see `substantiveChanges`): a line
    // re-rendered only because a ticker price or an "N hours ago" moved is not a legal change, even
    // when an unchanged word in it is on the keyword list.
    const lines = Array.isArray(removedLines) && Array.isArray(addedLines)
        ? substantiveChanges({ removedLines, addedLines })
        : (Array.isArray(changedLines) ? changedLines : []).filter((line) => !isTickerLine(line));
    if (kind === 'api') {
        return { severity: 'info', method: 'none', keywords: [], capped: true };
    }
    const hits = new Set();
    const matchedLines = [];
    for (const line of lines) {
        let matched = false;
        for (const [name, re] of KEYWORDS) {
            if (re.test(line)) {
                hits.add(name);
                matched = true;
            }
        }
        if (matched && matchedLines.length < 5) matchedLines.push(line.slice(0, 300));
    }
    if (hits.size === 0) return { severity: 'info', method: 'none', keywords: [], capped: false };
    return {
        severity: 'caution',
        method: 'keyword',
        keywords: [...hits].sort(byString),
        matchedLines,
        capped: false
    };
}

/**
 * Verbatim quote check (EVIDENCE.md §2.3, the first and cheapest signal): is each claim's quote
 * still in its source's text? "Verbatim" has to survive what extraction does to a document —
 * `pdftotext -layout` breaks "ledger-based" into "ledger- based" at a line end (measured: 20 of
 * 30 prospectus quotes fail a whitespace-only comparison for that reason alone), typographic
 * quotes come and go, and a quote may be trimmed with an ellipsis at either end or in the middle.
 * So both sides are reduced to their letters: quotes straightened, soft hyphens dropped, then every
 * whitespace and hyphen removed, case folded. A quote with an internal ellipsis is a sequence of
 * fragments that must appear in that order; fragments under 12 characters are ignored, since
 * "the" proves nothing.
 */
export function quoteKey(text, { pdf = false } = {}) {
    if (typeof text !== 'string') return '';
    // A bare page number on its own line is `pdftotext` crossing a page break mid-sentence
    // ("held in the\n68\nmain and sub accounts" — three such in one prospectus); it is not part
    // of any quote. PDF text ONLY: in HTML a number alone on its line is content — a Seedrs
    // progress block prints "958" investors and "850" on lines of their own, and stripping them
    // made a verbatim quote read as lost (2026-09-23).
    const source = pdf ? text.replace(/^[ \t]*\d{1,4}[ \t]*$/gm, '') : text;
    return source
        // Claims may preserve the source representation (XML tags or Markdown links/emphasis)
        // while the fetcher stores reader-visible text. Compare the words, not presentation syntax.
        // Strip real XML/HTML tags, but never a comparison in extracted prose or a fee table.
        // The old broad `<[^>]+>` pattern swallowed everything from `<5M` to the next `>` row.
        .replace(/<\/?[A-Za-z][A-Za-z0-9:_-]*(?:\s[^>\n]*)?\s*\/?>/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\\([\\`*_{}\[\]()#+.!$-])/g, '$1')
        .replace(/[`*_]/g, '')
        .replace(/[\u2018\u2019\u201a\u2032]/g, '\'')
        .replace(/[\u201c\u201d\u201e\u2033]/g, '"')
        .replace(/[\u00ad]/g, '')
        .replace(/[\s\u00a0\-\u2010\u2011\u2012\u2013\u2014]+/g, '')
        .toLowerCase();
}

const QUOTE_FRAGMENT_MIN = 12;

/** The checkable fragments of a quote: split on ellipses, keyed, short ones dropped. */
export function quoteFragments(quote) {
    if (typeof quote !== 'string') return [];
    return quote
        .split(/\u2026|\.\.\./)
        .map((part) => quoteKey(part))
        .filter((part) => part.length >= QUOTE_FRAGMENT_MIN);
}

/**
 * true when every fragment of `quote` occurs in `text`, in order; false when one is missing;
 * null when the quote has nothing checkable (empty, or only short fragments) — a null is "not
 * checked", never "lost".
 */
export function quoteFound(text, quote, { pdf = false } = {}) {
    const fragments = quoteFragments(quote);
    if (fragments.length === 0) return null;
    const haystack = quoteKey(text, { pdf });
    let from = 0;
    for (const fragment of fragments) {
        const at = haystack.indexOf(fragment, from);
        if (at < 0) return false;
        from = at + fragment.length;
    }
    return true;
}

/**
 * A quoted item — a `claims[]` row or a `whatIf[]` answer — keeps the human-readable citation URL
 * while the dossier may name an official machine-readable companion that contains the exact same
 * text (`quoteVerificationSources`: GitBook's llms-full.txt for a client-rendered docs page, a
 * `__data.json` or Markdown export). The relationship is explicit in the dossier; the watcher never
 * searches an issuer's other pages opportunistically.
 */
export function verificationUrlFor(item, dossier) {
    const cited = typeof item?.url === 'string' ? item.url : null;
    if (cited === null) return null;
    const mapping = (Array.isArray(dossier?.quoteVerificationSources) ? dossier.quoteVerificationSources : [])
        .find((row) => row?.sourceUrl === cited && typeof row?.verificationUrl === 'string');
    return mapping?.verificationUrl ?? cited;
}

/**
 * A claim that records what a source USED to say: `changed`, or a `contradicted-corrected`
 * correction whose note marks it `SUPERSEDED` (xstocks-backed `chains`: the 9-chain list the
 * issuer later extended to 10). With a confirmed successor on the same field and URL it is
 * history and is not watched. Its status stays as it is; the publication view needs
 * `contradicted-corrected` to show the correction.
 */
function retiredByConfirmedSuccessor(claim) {
    if (claim.status === 'changed') return true;
    return claim.status === 'contradicted-corrected' && /\bSUPERSEDED\b/.test(String(claim.note ?? ''));
}

/**
 * Every quote one dossier relies on, as `{url, id, kind, ref, slug, quote, citedUrl}`: `url` is
 * where the watcher checks the words (the declared companion, when there is one), `citedUrl` the
 * citation readers see. `claims[]` get the sonar.claim id, `whatIf[]` answers the sonar.what_if id;
 * both go through the same `quoteVerificationSources` mapping, so a what-if answer citing a page
 * that renders only in a browser is checked against its companion exactly as a claim is.
 */
export function dossierQuotes(slug, dossier) {
    const out = [];
    const claims = Array.isArray(dossier?.claims) ? dossier.claims : [];
    // A `changed` claim with a confirmed successor (same field, same URL, new quote) is history: the
    // source already said something else and the dossier recorded it. Only the successor is watched,
    // so the old quote is not reported lost again on every run.
    const confirmedAt = new Set(claims.filter((c) => c?.status === 'confirmed' && typeof c.quote === 'string')
        .map((c) => `${c.field}\u0000${c.url}`));
    for (const claim of claims) {
        if (typeof claim?.quote !== 'string' || typeof claim?.url !== 'string') continue;
        if (retiredByConfirmedSuccessor(claim) && confirmedAt.has(`${claim.field}\u0000${claim.url}`)) continue;
        out.push({
            url: verificationUrlFor(claim, dossier), id: claimId(slug, claim.field, claim.url, claim.quote),
            kind: 'claim', ref: claim.field, slug, quote: claim.quote, citedUrl: claim.url
        });
    }
    for (const entry of Array.isArray(dossier?.whatIf) ? dossier.whatIf : []) {
        if (typeof entry?.quote !== 'string' || typeof entry?.url !== 'string') continue;
        out.push({
            url: verificationUrlFor(entry, dossier), id: whatIfId(slug, entry.mode),
            kind: 'what-if', ref: entry.mode, slug, quote: entry.quote, citedUrl: entry.url
        });
    }
    return out;
}

/**
 * Every quote registered against one source, checked against that source's current text.
 * `quotes` are `{id, kind, ref, quote}` (kind `claim` or `what-if`, ref the field or the mode).
 */
export function checkQuotes(text, quotes, { pdf = false } = {}) {
    const found = [];
    const lost = [];
    let skipped = 0;
    for (const item of Array.isArray(quotes) ? quotes : []) {
        const verdict = quoteFound(text, item?.quote, { pdf });
        if (verdict === null) skipped += 1;
        else if (verdict) found.push(item);
        else lost.push(item);
    }
    return { checked: found.length + lost.length, found, lost, skipped };
}

/**
 * The quote check for one source after one look at it. A `blocked` source — a JavaScript-only page,
 * a bot wall with no usable Wayback capture — has no text worth reading: the stub it served
 * ("Ventuals" for app.ventuals.com/sunset, whose letter renders only in a browser) is not the
 * document, so checking a quote against it would report every quote lost. Its quotes are "not
 * checkable": verdict null, counted in `notCheckable`, never `lost`. Other outcomes with no text
 * (gone, error) return null — nothing was checked and the previous verdicts stand.
 */
export function quoteVerdicts({ status, text, quotes, kind = 'html' }) {
    const items = Array.isArray(quotes) ? quotes : [];
    if (status === 'blocked') return { checked: 0, found: [], lost: [], skipped: 0, notCheckable: items.length };
    if (typeof text !== 'string' || (status !== 'ok' && status !== 'changed')) return null;
    return { ...checkQuotes(text, items, { pdf: kind === 'pdf' }), notCheckable: 0 };
}

/**
 * The watcher's write-back to `sonar.claim`: `last_checked_at` for every quote it looked for,
 * `last_confirmed_at` (and `confirmed` again, if it had been `changed`) when the quote was found,
 * `changed` when it was not. `unverified` rows whose quote IS found become `confirmed`: the
 * watcher just read the words in the source, which is what confirmed means. A claim whose quote
 * is lost never becomes false — it becomes `changed`, with the change event beside it, and a
 * human decides (EVIDENCE.md §1).
 */
export function buildClaimCheckSql(checks, { tag = 'sonar' } = {}) {
    const items = (Array.isArray(checks) ? checks : [])
        .filter((c) => typeof c?.id === 'string' && typeof c?.found === 'boolean' && typeof c?.checkedAt === 'string')
        .map((c) => ({ id: c.id, found: c.found, checkedAt: c.checkedAt }));
    const doc = { checks: items };
    const sql = `WITH doc AS (SELECT ${jsonbLiteral(doc, tag)} AS d),\n`
        + "     src AS (SELECT x.r FROM doc, jsonb_array_elements(d->'checks') AS x(r))\n"
        + 'UPDATE sonar.claim c\n'
        + "   SET last_checked_at   = (r->>'checkedAt')::timestamptz,\n"
        + "       last_confirmed_at = CASE WHEN (r->>'found')::boolean THEN (r->>'checkedAt')::timestamptz\n"
        + '                                ELSE c.last_confirmed_at END,\n'
        + "       status            = CASE WHEN (r->>'found')::boolean AND c.status IN ('changed', 'unverified') THEN 'confirmed'\n"
        + "                                WHEN NOT (r->>'found')::boolean AND c.status IN ('confirmed', 'unverified') THEN 'changed'\n"
        + '                                ELSE c.status END,\n'
        + '       updated_at        = now()\n'
        + '  FROM src\n'
        + " WHERE c.id = r->>'id';\n";
    return { table: 'sonar.claim', rows: items.length, sql };
}

// --- HTTP outcome ----------------------------------------------------------------------------

/**
 * Per-host User-Agent overrides. The default is a browser string, because several of these hosts
 * answer a scripted UA with a bot wall — but the SEC requires the opposite: its access policy says
 * automated requests must declare who is asking and how to reach them, and `*.sec.gov` answers a
 * plain browser UA with 403 while a declared one gets 200. Add a host here rather than weakening
 * the default for everyone; the longest matching suffix wins.
 */
export const HOST_USER_AGENTS = [
    ['sec.gov', 'rwa-sonar source-watch contact@rwasonar.com'],
    // crates.io's data-access policy asks API clients for a UA naming the application and a contact.
    ['crates.io', 'rwa-sonar source-watch contact@rwasonar.com']
];

export const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
    + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** The UA to send to `host`: an override when the host (or its parent domain) has one. */
export function userAgentFor(host, { fallback = DEFAULT_USER_AGENT } = {}) {
    const name = String(host ?? '').toLowerCase();
    let best = null;
    for (const [suffix, ua] of HOST_USER_AGENTS) {
        if (name === suffix || name.endsWith(`.${suffix}`)) {
            if (best === null || suffix.length > best[0].length) best = [suffix, ua];
        }
    }
    return best ? best[1] : fallback;
}

/**
 * Hosts whose 503 is their own outage rather than a fault in our watch. archive.org's availability
 * and CDX APIs were answering 503 "temporarily offline" on 2026-09-17; the dossiers cite six
 * `web.archive.org` URLs, and one third-party maintenance window must not turn the daily verdict
 * red. Such a 503 (after the two backoffs) is recorded as `blocked` with the reason, exactly like
 * any other host that will not serve us today.
 */
const FLAKY_503_HOSTS = ['web.archive.org', 'archive.org'];

export function tolerates503(host) {
    const name = String(host ?? '').toLowerCase();
    return FLAKY_503_HOSTS.some((h) => name === h || name.endsWith(`.${h}`));
}

/**
 * A bot wall is recognised from the BODY, never from the headers. Every site behind Cloudflare
 * sends `cf-ray` and `server: cloudflare` on a perfectly good 200, so a header check marks most of
 * the web as blocked — measured on the first run, where it mislabelled prestocks' own pages.
 */
const CHALLENGE_BODY = [
    /just a moment/i, /attention required/i, /enable javascript and cookies to continue/i,
    /checking your browser/i, /verify you are (a )?human/i, /are you a robot/i, /captcha/i,
    /access denied/i, /request (blocked|unsuccessful)/i, /ddos protection by/i, /perimeterx/i,
    /px-captcha/i, /incapsula incident id/i, /cf-error-details/i,
    // Vercel's challenge page, which it serves with HTTP 429 (kalshi.com, data.chain.link):
    // not a rate limit, so backing off and retrying cannot change the answer.
    /vercel security checkpoint/i
];

/** Vendors visible in the response headers. Only ever an annotation on a status that already refused us. */
const VENDOR_HEADERS = [
    ['cloudflare', /cloudflare/i], ['akamai', /akamai/i], ['incapsula', /incap|imperva/i],
    ['perimeterx', /perimeterx|_px/i], ['sucuri', /sucuri/i], ['fastly', /fastly/i]
];

export function challengeInBody(bodyPreview = '') {
    return CHALLENGE_BODY.some((re) => re.test(String(bodyPreview)));
}

export function blockVendor(headers = {}) {
    const hay = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n');
    for (const [name, re] of VENDOR_HEADERS) if (re.test(hay)) return name;
    return null;
}

/**
 * A page that renders entirely in the browser: 200, valid HTML, a `<noscript>` telling you to
 * enable JavaScript, and almost no text once the markup is stripped. Notion-hosted terms of
 * service look exactly like this — `https://url.prestocks.com/terms-of-service` normalises to the
 * single word "Notion". It is not a bot wall and not an error: it is a document a fetch cannot
 * read, which is what `blocked` is for, with the reason saying so instead of silently hashing six
 * characters and calling the terms of service watched.
 *
 * `blocked` is the verdict of last resort, though, not the first answer: where the document can be
 * had another way, the watcher takes that way and this test never runs. PreStocks' Notion pages go
 * through lib/notion.mjs (`loadPageChunk`, 123 kB of real Terms) and Google Drive's viewer through
 * `driveDownloadUrl` above (the PDF itself). Both were `blocked`/two-line shells until 2026-09-18.
 *
 * The JavaScript notice has to be looked for in the RAW html, because it lives in a `<noscript>`
 * block that normalisation strips. Both conditions are required: plenty of real pages carry the
 * notice and still serve their text (Backpack's support articles do), and a genuinely short page
 * (a sitemap, a metadata JSON) is still readable.
 */
export function jsOnlyShell(text, rawHtml = '') {
    const body = String(text ?? '');
    if (body.length >= 600) return false;
    const raw = String(rawHtml);
    if (/(enable|requires?)\s+javascript/i.test(raw)) return true;
    // No notice, but a big document that renders to almost nothing readable is the same thing:
    // backed.fi's Webflow pages came back as 40 kB of markup and 188 characters of cookie popup
    // (2026-09-18), and were hashed as a real page until a claim check found nothing in them.
    return raw.length > JS_SHELL_RAW_MIN && body.length < JS_SHELL_TEXT_MAX;
}
const JS_SHELL_RAW_MIN = 20_000;
const JS_SHELL_TEXT_MAX = 300;

/**
 * A server-rendered WordPress page whose content area was published empty: the theme's
 * `<div class="page-content">` (or `entry-content`) holds nothing but whitespace. That is not a
 * JavaScript shell — nothing is left for a browser to render — and the emptiness is the evidence:
 * Remora Markets' Whitepaper, Terms & Conditions, Privacy Policy and KYC Info pages were created
 * blank on 2025-02-25 and archived that way (2025-05-16 Wayback captures, 93 kB of theme markup
 * around 320 characters of navigation), and the dossier cites them to show exactly that. Such a
 * page is read like any other: hashed, watched, `ok` while it stays empty.
 */
export function emptyPublishedPage(rawHtml = '') {
    const raw = String(rawHtml);
    if (!/<meta[^>]+name="generator"[^>]+content="WordPress/i.test(raw)) return false;
    return /<div class="(?:page|entry)-content">\s*<\/div>/.test(raw);
}

/**
 * Whether a 2xx read is a JavaScript-only shell (see `jsOnlyShell`). Only an HTML page read as
 * HTML can be one: a Notion page has already been read through its API, and a binary payload (a
 * zip, a PNG served as the cited "document") is watched as bytes — its one-line marker is short
 * and its body large by nature, which made `cdn.sanity.io/…zip` and a logo PNG "javascript-only"
 * once a run actually re-read them (2026-09-23).
 */
export function isJsOnlyRead({ kind, binary = false, notion = false, text, rawHtml = '' }) {
    if (notion || binary || kind !== 'html') return false;
    if (emptyPublishedPage(rawHtml)) return false;
    return jsOnlyShell(text, rawHtml);
}

/**
 * The validators (etag, last-modified) to store after one response, and the HTTP status of the
 * response they came from. Only a 2xx body's validators describe the document; a 304 confirms the
 * stored ones; anything else (404, 403, a bot wall) keeps what we had. Measured 2026-09-24: a
 * PreStocks FAQ bundle went 404 on Vercel, the 404 page's etag was stored, and a conditional GET
 * with it answered 304 — so a dead URL was reported `ok, http-304` on every later run.
 */
export function responseValidators({ httpStatus, headers = {}, prev = null } = {}) {
    if (httpStatus >= 200 && httpStatus < 300) {
        return { etag: headers.etag ?? null, lastModified: headers['last-modified'] ?? null, validatorStatus: httpStatus };
    }
    const kept = { etag: prev?.etag ?? null, lastModified: prev?.lastModified ?? null, validatorStatus: prev?.validatorStatus ?? null };
    if (httpStatus === 304) {
        return { ...kept, etag: headers.etag ?? kept.etag, lastModified: headers['last-modified'] ?? kept.lastModified };
    }
    return kept;
}

/**
 * Conditional request headers from the stored state. None when there is nothing to fall back on:
 * a 304 only means "what you have is current", so for a source with no stored text (first sight,
 * or every earlier read was a JavaScript shell or a refusal) it would report `ok` over nothing.
 * Measured 2026-09-23: securitize.io's Terms of Service, ventuals.com/terms and six more pages
 * had answered 304 as `ok` for days with no text ever stored, so none of their quotes was checked.
 * None either when the extraction generation rose, so the page is read by the new reader.
 */
export function conditionalHeaders(prev, { normalizerUpgrade = false } = {}) {
    if (!prev || normalizerUpgrade || typeof prev.textPath !== 'string' || prev.textPath === '') {
        return { etag: null, lastModified: null };
    }
    // Only validators a 2xx body gave us (`responseValidators`). A state entry without that proof
    // may hold a 404 page's etag, which the host then confirms with a 304 forever.
    if (!(prev.validatorStatus >= 200 && prev.validatorStatus < 300)) return { etag: null, lastModified: null };
    return { etag: prev.etag ?? null, lastModified: prev.lastModified ?? null };
}

/**
 * An exact API query whose cited evidence IS its error answer. Remora's dossier quotes Jupiter's
 * `…/swap/v1/quote?inputMint=…` answering HTTP 400 `{"error":"The token … is not tradable",
 * "errorCode":"TOKEN_NOT_TRADABLE"}`: that JSON is the observation, so the watcher reads it like
 * any document instead of calling the source blocked (three quotes were "not checkable" for that
 * reason until 2026-09-23). Only a 400/422 (the request was understood and answered), only a JSON
 * body, and only a URL that carries its query — a bare route family (`…/swap/v1/quote`, a Sanity
 * `/data/query/production` with no `query`) answers "missing parameter", which is no evidence of
 * anything and stays blocked.
 */
export function apiAnswerIsDocument({ httpStatus = null, contentType = null, url = '' } = {}) {
    if (httpStatus !== 400 && httpStatus !== 422) return false;
    if (!/json/i.test(String(contentType ?? ''))) return false;
    try {
        return new URL(url).search.length > 1;
    } catch {
        return false;
    }
}

/**
 * What state a fetch leaves a source in. Kept separate from the fetching so every branch is
 * testable: `ok` (200 and the same hash, or 304), `changed` (200 and a new hash), `gone` (404,
 * 410 or a host that no longer resolves — EVIDENCE.md §3 `document-gone`), `blocked` (the host
 * refuses us: 401/403/405/406/429-after-backoff/451, or a bot wall), `error` (anything else:
 * 5xx, timeout, reset — a run with one of these must not report success).
 */
export function decideOutcome({ httpStatus = null, networkErrorCode = null, blocked = false,
    sameHash = false, retriedAfterBackoff = false, jsOnly = false, vendor = null,
    host = null, apiAnswer = false } = {}) {
    if (networkErrorCode) {
        if (networkErrorCode === 'ENOTFOUND') {
            return { status: 'gone', reason: 'dns: host does not resolve' };
        }
        if (networkErrorCode === 'CERT_HAS_EXPIRED') {
            return { status: 'blocked', reason: 'tls: certificate expired' };
        }
        // The server sends its leaf certificate without the intermediate (www.cysec.gov.cy,
        // measured 2026-09-24: openssl "unable to verify the first certificate"). Browsers fetch the
        // missing intermediate themselves; Node does not. A host misconfiguration, not our failure,
        // so it is a refusal with the reason rather than an error that fails every run.
        if (networkErrorCode === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
            return { status: 'blocked', reason: 'tls: incomplete certificate chain (the server omits its intermediate certificate)' };
        }
        if (networkErrorCode === 'ETIMEDOUT' && retriedAfterBackoff && tolerates503(host)) {
            return { status: 'blocked', reason: 'network timeout after backoff (host temporarily unavailable)' };
        }
        return { status: 'error', reason: `network: ${networkErrorCode}` };
    }
    if (httpStatus === 304) return { status: 'ok', reason: 'http-304 not modified' };
    // The cited evidence is the API's own error answer (see `apiAnswerIsDocument`).
    if (apiAnswer) {
        return sameHash
            ? { status: 'ok', reason: `same hash (http-${httpStatus} JSON answer is the cited response)` }
            : { status: 'changed', reason: `new hash (http-${httpStatus} JSON answer is the cited response)` };
    }
    if (httpStatus === 404 || httpStatus === 410) return { status: 'gone', reason: `http-${httpStatus}` };
    if (httpStatus === 429 && blocked) return { status: 'blocked', reason: 'http-429 (bot wall)' };
    if (httpStatus === 429) {
        return retriedAfterBackoff
            ? { status: 'blocked', reason: 'http-429 after backoff' }
            : { status: 'error', reason: 'http-429' };
    }
    // 400 belongs here rather than in `error`: the sources include a Sanity GROQ query endpoint
    // (`…/data/query/production`) that answers a bare GET with "param query is required". No
    // amount of retrying makes that a document, so it is recorded with its status and left alone
    // instead of failing every single run — which is the fastest way to make a failing run
    // indistinguishable from a working one.
    if (httpStatus === 400 || httpStatus === 401 || httpStatus === 403 || httpStatus === 405
        || httpStatus === 406 || httpStatus === 451) {
        const why = blocked ? ' (bot wall)' : (vendor ? ` (${vendor})` : '');
        return { status: 'blocked', reason: `http-${httpStatus}${why}` };
    }
    if (httpStatus !== null && httpStatus >= 200 && httpStatus < 300) {
        if (blocked) return { status: 'blocked', reason: 'bot wall served with a 200' };
        if (jsOnly) return { status: 'blocked', reason: 'javascript-only page: no text without a browser' };
        return sameHash ? { status: 'ok', reason: 'same hash' } : { status: 'changed', reason: 'new hash' };
    }
    // A host that is simply down today (archive.org's APIs were, on 2026-09-17) is recorded, not
    // counted as a fault in our watch — see `tolerates503`.
    if (httpStatus === 503 && retriedAfterBackoff && tolerates503(host)) {
        return { status: 'blocked', reason: 'http-503 after backoff (host temporarily unavailable)' };
    }
    if (httpStatus !== null) return { status: 'error', reason: `http-${httpStatus}` };
    return { status: 'error', reason: 'no response' };
}

/**
 * A refusal nothing depends on is not a finding. `blocked` exists so that a quote we cannot check
 * is reported as "not checkable" instead of silently passing; a source no dossier quotes — a
 * homepage in a `website` field, a listing named in a what-if's `searched` trail, a folder cited as
 * "the series" — has no words to check, and what its citation needs is that the host still answers
 * at that address. So a `blocked` source with NO registered quote whose host did answer (any HTTP
 * status: a 403 bot wall, a JavaScript shell) becomes `reachable-unverified`: reachable, content
 * not read. It still goes `gone` on a 404/410/NXDOMAIN like any other source. A refusal without an
 * HTTP answer (network timeout, expired certificate) proves nothing about reachability and stays
 * `blocked`, and so does any source a quote relies on — adding a quote to a dossier turns the same
 * refusal back into `blocked` on the next run. Returns the replacement `{status, reason}` or null.
 */
export function quotelessRefusal({ status, httpStatus = null, reason = '', quotesRegistered = 0 } = {}) {
    if (status !== 'blocked' || quotesRegistered > 0) return null;
    if (typeof httpStatus !== 'number' || !Number.isFinite(httpStatus)) return null;
    return {
        status: 'reachable-unverified',
        reason: `${reason} — host answered HTTP ${httpStatus}; no dossier quote relies on this source, so reachability is all its citation needs (content not read)`
    };
}

/** A run fails on `error` only: `gone` is a finding about the citation, `blocked` is the host. */
export function runFailed(results) {
    return results.some((r) => r.status === 'error');
}

/** A restart can reuse completed outcomes, but transient errors must make a real request again. */
export function reusableCheckpoint(result) {
    return Boolean(result) && result.status !== 'error';
}

/**
 * Why a Save Page Now attempt produced no archived URL. Measured 2026-09-17: an anonymous
 * `GET https://web.archive.org/save/<url>` answers **HTTP 500** with the interactive Save Page Now
 * form and no `Content-Location`, i.e. it saves nothing — reproducible with plain curl, so it is
 * their policy and not our client. EVIDENCE.md §2.2 already anticipates the fix (an archive.org
 * account key, which also returns a job id); until there is one, the run says exactly this rather
 * than logging an unexplained 500.
 */
export function archiveRefusal(httpStatus) {
    if (httpStatus === 500) {
        return 'save-page-now refused an anonymous save (http 500) — needs an archive.org account key';
    }
    if (httpStatus === 429) return 'save-page-now rate limit (http 429)';
    if (httpStatus === 503 || httpStatus === 502 || httpStatus === 504) {
        return `archive-unavailable: save-page-now is temporarily offline (http ${httpStatus})`;
    }
    if (typeof httpStatus === 'number' && httpStatus >= 400) return `save-page-now http ${httpStatus}`;
    return `no archive location (http ${httpStatus})`;
}

/**
 * When to stop attempting Save Page Now for the rest of a run. Each attempt costs 5 s of pacing
 * plus its own latency, so 300 sources against an archive that is offline (or refusing anonymous
 * saves, which is today's answer) is half an hour spent proving the same thing. After this many
 * consecutive failures the pass reports `archive-unavailable` once and stops.
 */
export const ARCHIVE_GIVE_UP_AFTER = 5;

/**
 * Save Page Now 2 caps the number of capture sessions one account may have in flight and answers
 * a submit over that cap with a message rather than a status code. That is back-pressure, not a
 * failure of the source: the right response is to wait the minute it asks for and submit again,
 * and such an answer must never count towards giving up on the archive for the run.
 */
export function spnBusy(message) {
    return typeof message === 'string' && /limit of active Save Page Now sessions/i.test(message);
}

/** Connection-level failures reaching web.archive.org: worth a minute's wait and a retry. */
export function spnTransient(error) {
    return typeof error === 'string' && /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|timeout|fetch failed)$/.test(error);
}

/**
 * Save Page Now refuses a second capture of a URL within 24 hours ("The same snapshot had been
 * made 17 hours, 38 minutes ago. You can make new capture of this URL after 24 hours." — seen for
 * shiftrwa.xyz and terms.tessera.pe, 2026-09-22). That is not a failure: a capture from the last
 * day exists and is one CDX lookup away, so it must not leave `archive_url` empty.
 */
export function spnAlreadyCaptured(message) {
    return typeof message === 'string' && /same snapshot had been made/i.test(message);
}

/** How recent a CDX capture must be to stand in for the snapshot SPN just declined to repeat. */
export const RECENT_CAPTURE_HOURS = 48;

/** True when a 14-digit Wayback timestamp is within `hours` before `nowMs` (never a guess). */
export function captureIsRecent(timestamp, nowMs, hours = RECENT_CAPTURE_HOURS) {
    const m = typeof timestamp === 'string' ? timestamp.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/) : null;
    if (!m || !Number.isFinite(nowMs)) return false;
    const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
    return at <= nowMs + 60_000 && nowMs - at <= hours * 3_600_000;
}

/**
 * A URL on the Wayback Machine itself (a CDX query cited as evidence of what was captured) is
 * already the archive: Save Page Now refuses it ("We're currently facing some limitations when it
 * comes to archiving this site", four times for the remora.markets CDX queries, 2026-09-22), so
 * submitting it only burns 15 s of pacing and a failure line per run.
 */
export function archivableUrl(url) {
    let host;
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return false;
    }
    return host !== 'archive.org' && !host.endsWith('.archive.org');
}

/**
 * Which sources an `--archive-missing-only` pass submits to Save Page Now: those whose stored
 * state has no `archiveUrl`. A `gone` or `error` source has nothing live to archive (the daily
 * run skips them for the same reason), and a source with no state yet has never been read — the
 * next watch run archives it on first sight. `blocked` stays in: the archive fetches from its own
 * network, and often gets what our host is refused. Returns the targets and a count per skip reason.
 */
export function archiveMissingTargets(sources, state) {
    const targets = [];
    const skipped = { archived: 0, unchecked: 0, gone: 0, error: 0, archiveHost: 0 };
    for (const source of Array.isArray(sources) ? sources : []) {
        if (!archivableUrl(source?.url)) {
            skipped.archiveHost += 1;
            continue;
        }
        const row = state?.[source?.url] ?? null;
        if (!row) {
            skipped.unchecked += 1;
            continue;
        }
        if (typeof row.archiveUrl === 'string' && row.archiveUrl !== '') {
            skipped.archived += 1;
            continue;
        }
        if (row.status === 'gone' || row.status === 'error') {
            skipped[row.status] += 1;
            continue;
        }
        targets.push({ url: source.url, status: row.status ?? null });
    }
    return { targets, skipped };
}

/**
 * Fill `sonar.source.archive_url` for rows that have none. Only NULLs are written: a full watch
 * run that archived a newer version meanwhile keeps its own capture.
 */
export function buildArchiveUrlSql(updates, { tag = 'sonar' } = {}) {
    const items = (Array.isArray(updates) ? updates : [])
        .filter((u) => typeof u?.id === 'string' && typeof u?.archiveUrl === 'string' && u.archiveUrl !== '');
    const doc = { rows: items.map((u) => ({ id: u.id, archiveUrl: u.archiveUrl })) };
    const sql = `WITH doc AS (SELECT ${jsonbLiteral(doc, tag)} AS d)\n`
        + 'UPDATE sonar.source AS s SET archive_url = x.r->>\'archiveUrl\', updated_at = now()\n'
        + '  FROM doc, jsonb_array_elements(d->\'rows\') AS x(r)\n'
        + ' WHERE s.id = x.r->>\'id\' AND s.archive_url IS NULL;';
    return { table: 'sonar.source', rows: items.length, sql };
}

/** `/web/20260917150655/https://x/y` or a full archived URL -> the absolute archived URL. */
export function parseArchiveLocation(value, fallbackUrl = null) {
    if (typeof value === 'string' && value !== '') {
        if (/^https?:\/\//i.test(value)) return value;
        if (value.startsWith('/web/')) return `https://web.archive.org${value}`;
    }
    if (typeof fallbackUrl === 'string' && /^https?:\/\/web\.archive\.org\/web\//i.test(fallbackUrl)) {
        return fallbackUrl;
    }
    return null;
}

const ASSET_PATH = /(?:^|\/)favicon\.ico$|\.(?:ico|png|jpe?g|gif|svg|webp|css|js|woff2?)$/i;

/**
 * A "successful" job whose capture is an asset of the page rather than the page. Measured
 * 2026-09-23: remora.markets (expired TLS certificate) came back `success` with `original_url`
 * `https://remora.markets/favicon.ico`, which would have been stored as the archived copy of the
 * home page. A redirect to another page is still accepted; only a static asset is refused.
 */
export function capturedSubresource(originalUrl, requestedUrl) {
    let original;
    let requested;
    try {
        original = new URL(originalUrl);
        requested = new URL(requestedUrl);
    } catch {
        return false;
    }
    return original.pathname !== requested.pathname
        && ASSET_PATH.test(original.pathname) && !ASSET_PATH.test(requested.pathname);
}

/**
 * Save Page Now 2 (the authenticated API): `POST /save` answers `{url, job_id}` and
 * `GET /save/status/<job_id>` answers `{status: 'pending'|'success'|'error', timestamp,
 * original_url, message, status_ext}`. Turned into `{done, archiveUrl, error}`: `done` false
 * while pending; success → the absolute archived URL built from the capture timestamp and the
 * original URL; error → the archive's own message. Anything unparseable is an error, never a
 * silent null.
 */
export function parseSpnStatus(body, requestedUrl = null) {
    const j = body && typeof body === 'object' ? body : null;
    if (!j) return { done: true, archiveUrl: null, error: 'save-page-now status: not an object' };
    if (j.status === 'pending') return { done: false, archiveUrl: null, error: null };
    if (j.status === 'success') {
        const ts = typeof j.timestamp === 'string' && /^\d{14}$/.test(j.timestamp) ? j.timestamp : null;
        const original = typeof j.original_url === 'string' && j.original_url !== '' ? j.original_url : null;
        if (ts && original && capturedSubresource(original, requestedUrl)) {
            return { done: true, archiveUrl: null, error: `save-page-now captured ${original} instead of the page` };
        }
        if (ts && original) return { done: true, archiveUrl: `https://web.archive.org/web/${ts}/${original}`, error: null };
        return { done: true, archiveUrl: null, error: 'save-page-now success without timestamp/original_url' };
    }
    const why = [j.status_ext, j.message].filter((x) => typeof x === 'string' && x !== '').join(': ');
    return { done: true, archiveUrl: null, error: `save-page-now ${j.status ?? 'unknown status'}${why ? ` — ${why}` : ''}` };
}

// --- provenance ------------------------------------------------------------------------------

/** Every `read_via` value db/2026-09-23-sonar-source-provenance.sql accepts. */
export const READ_VIA = ['live', 'html', 'next-flight', 'pdf', 'api', 'binary', 'notion', 'drive', 'wayback', 'companion'];

/**
 * Which reader produced the text a source row now stands on (`sonar.source.read_via`): the
 * watcher's `via` for a fresh read, `drive` when a Google Drive link was fetched as its download,
 * the previous reader when a live 304 confirmed the stored text, `live` for a 304 with no reader on
 * record, and null when nothing was read (gone, blocked, error). `capture_at` is the Wayback
 * capture's own CDX timestamp and exists only for `wayback` — never a fetch time.
 */
export function readProvenance(result, prev = null) {
    const none = { readVia: null, captureAt: null };
    if (!result || (result.status !== 'ok' && result.status !== 'changed')) return none;
    if (result.via === 'wayback') {
        return { readVia: 'wayback', captureAt: typeof result.captureTimestamp === 'string' ? result.captureTimestamp : null };
    }
    if (typeof result.via === 'string') {
        // The live page refused or rendered nothing and the words came from the same publisher's
        // own API (lib/companions.mjs); the row must not look like a live read of the cited page.
        if (typeof result.companionReader === 'string' && result.companionReader) return { readVia: 'companion', captureAt: null };
        if (typeof result.resolvedUrl === 'string' && driveDownloadUrl(result.url) === result.resolvedUrl) {
            return { readVia: 'drive', captureAt: null };
        }
        return { readVia: READ_VIA.includes(result.via) ? result.via : null, captureAt: null };
    }
    if (result.httpStatus === 304) {
        const earlier = prev?.readVia;
        return { readVia: READ_VIA.includes(earlier) && earlier !== 'wayback' ? earlier : 'live', captureAt: null };
    }
    return none;
}

// --- SQL -------------------------------------------------------------------------------------

const SOURCE_COLUMNS = [
    ['id', "r->>'id'"],
    ['url', "r->>'url'"],
    ['kind', "r->>'kind'"],
    ['title', "r->>'title'"],
    ['issuer_slug', "r->>'issuer'"],
    ['found_in', "CASE WHEN jsonb_typeof(r->'foundIn') = 'array' THEN r->'foundIn' ELSE NULL END"],
    ['first_seen_at', "(r->>'firstSeenAt')::timestamptz"],
    ['last_checked_at', "(r->>'lastCheckedAt')::timestamptz"],
    ['last_changed_at', "(r->>'lastChangedAt')::timestamptz"],
    ['check_every', "(r->>'checkEvery')::interval"],
    ['archive_url', "r->>'archiveUrl'"],
    ['status', "r->>'status'"],
    ['content_hash', "r->>'contentHash'"],
    ['http_status', "(r->>'httpStatus')::int"],
    ['error', "r->>'error'"],
    ['read_via', "r->>'readVia'"],
    ['capture_at', "(r->>'captureAt')::timestamptz"]
];

/**
 * Upsert the sources this run looked at. `first_seen_at` is insert-only — a source keeps the day
 * we first saw it for good — and `url` never changes for a given id, because the id IS its hash.
 * Everything else is refreshed under the IS DISTINCT FROM guard from lib/db-load.mjs, so a run
 * that changed nothing does not touch a single `updated_at`.
 */
export function buildSourceSql(sources, { tag = 'sonar' } = {}) {
    const items = Array.isArray(sources) ? sources : [];
    const doc = { sources: items };
    const sql = renderUpsert({
        table: 'sonar.source',
        ctes: [
            `doc AS (SELECT ${jsonbLiteral(doc, tag)} AS d)`,
            "src AS (SELECT DISTINCT ON (x.r->>'id') x.r"
            + "\n              FROM doc, jsonb_array_elements(d->'sources') WITH ORDINALITY AS x(r, ord)"
            + "\n             ORDER BY x.r->>'id', x.ord DESC)"
        ],
        from: 'src',
        columns: SOURCE_COLUMNS,
        conflict: 'id',
        update: SOURCE_COLUMNS.map(([c]) => c).filter((c) => !['id', 'url', 'first_seen_at'].includes(c))
    });
    return { table: 'sonar.source', rows: new Set(items.map((s) => s.id)).size, sql };
}

const VERSION_COLUMNS = [
    ['source_id', "r->>'sourceId'"],
    ['fetched_at', "(r->>'fetchedAt')::timestamptz"],
    ['content_hash', "r->>'contentHash'"],
    ['bytes', "(r->>'bytes')::bigint"],
    ['text_chars', "(r->>'textChars')::int"],
    ['text_path', "r->>'textPath'"],
    ['raw_path', "r->>'rawPath'"],
    ['archive_url', "r->>'archiveUrl'"],
    ['etag', "r->>'etag'"],
    ['last_modified', "r->>'lastModified'"],
    ['diff_summary', "r->>'diffSummary'"],
    ['diff_severity', "r->>'diffSeverity'"],
    ['diff_method', "r->>'diffMethod'"],
    ['diff_added', "(r->>'diffAdded')::int"],
    ['diff_removed', "(r->>'diffRemoved')::int"],
    ['read_via', "r->>'readVia'"],
    ['capture_at', "(r->>'captureAt')::timestamptz"]
];

/** One row per fetch that produced new content. Idempotent on (source_id, fetched_at). */
export function buildVersionSql(versions, { tag = 'sonar' } = {}) {
    const items = Array.isArray(versions) ? versions : [];
    const doc = { versions: items };
    const sql = renderUpsert({
        table: 'sonar.source_version',
        ctes: [
            `doc AS (SELECT ${jsonbLiteral(doc, tag)} AS d)`,
            "src AS (SELECT DISTINCT ON (x.r->>'sourceId', x.r->>'fetchedAt') x.r"
            + "\n              FROM doc, jsonb_array_elements(d->'versions') WITH ORDINALITY AS x(r, ord)"
            + "\n             ORDER BY x.r->>'sourceId', x.r->>'fetchedAt', x.ord DESC)"
        ],
        from: 'src',
        columns: VERSION_COLUMNS,
        conflict: 'source_id, fetched_at',
        update: VERSION_COLUMNS.map(([c]) => c).filter((c) => !['source_id', 'fetched_at'].includes(c))
    });
    const keys = new Set(items.map((v) => `${v.sourceId}@${v.fetchedAt}`));
    return { table: 'sonar.source_version', rows: keys.size, sql };
}

/**
 * Insert change events, skipping any this run would duplicate. The dedupe key is the same tuple
 * the unique index in the DDL uses — (subject, kind, field, detected_at) — so re-running the
 * watcher over an unchanged checkpoint writes nothing rather than growing the feed.
 */
export function buildChangeEventSql(events, { tag = 'sonar' } = {}) {
    const items = Array.isArray(events) ? events : [];
    const doc = { events: items };
    const sql = `WITH doc AS (SELECT ${jsonbLiteral(doc, tag)} AS d),\n`
        + "     src AS (SELECT x.r FROM doc, jsonb_array_elements(d->'events') AS x(r))\n"
        + 'INSERT INTO sonar.change_event\n'
        + '       (detected_at, kind, subject_type, subject_id, field, before, after, severity,\n'
        + '        evidence, summary)\n'
        + "SELECT (r->>'detectedAt')::timestamptz, r->>'kind', r->>'subjectType', r->>'subjectId',\n"
        + "       r->>'field', r->>'before', r->>'after', r->>'severity',\n"
        + "       CASE WHEN r ? 'evidence' THEN r->'evidence' ELSE NULL END, r->>'summary'\n"
        + '  FROM src\n'
        + ' WHERE NOT EXISTS (\n'
        + '           SELECT 1 FROM sonar.change_event e\n'
        + "            WHERE e.subject_type = r->>'subjectType'\n"
        + "              AND e.subject_id   = r->>'subjectId'\n"
        + "              AND e.kind         = r->>'kind'\n"
        + "              AND coalesce(e.field, '') = coalesce(r->>'field', '')\n"
        + "              AND e.detected_at  = (r->>'detectedAt')::timestamptz);\n";
    return { table: 'sonar.change_event', rows: items.length, sql };
}
