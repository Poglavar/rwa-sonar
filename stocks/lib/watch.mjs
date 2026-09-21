// The document watcher's pure half (EVIDENCE.md §2): turn a fetched byte stream into the
// normalised text that gets hashed, decide from the HTTP result what state the source is in,
// score a diff by the §2.3 keyword list, and render the SQL that mirrors a run into
// sonar.source / sonar.source_version / sonar.change_event. No network and no filesystem here, so
// every decision is unit tested (../watch.test.js); stocks/watch-sources.mjs does the IO.

import { createHash } from 'node:crypto';

import { jsonbLiteral, renderUpsert } from './db-load.mjs';
import { byString } from './io.mjs';

/** A source's stable id and on-disk directory name: the first 12 hex of sha256(url). */
export function sourceId(url) {
    if (typeof url !== 'string' || url === '') throw new Error('sourceId needs a url');
    return createHash('sha256').update(url).digest('hex').slice(0, 12);
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
 */
export function normaliseLines(text, { htmlWidgets = false } = {}) {
    const out = [];
    for (const raw of String(text).replace(/\r\n?/g, '\n').replace(INVISIBLE, ' ').split('\n')) {
        const line = raw.replace(/[\t\f\v]/g, ' ').replace(/ {2,}/g, ' ').trim();
        if (looksLikeChurn(line, { htmlWidgets })) continue;
        out.push(line);
    }
    return out.join('\n');
}

/** HTML -> readable text: chrome elements removed, tags stripped, entities decoded. */
export function htmlToText(html) {
    let text = String(html);
    text = text.replace(/<!--[\s\S]*?-->/g, ' ');
    // Two passes: a <nav> inside a <header> only disappears once its parent has gone.
    text = text.replace(DROP_BLOCKS, ' ').replace(DROP_BLOCKS, ' ');
    text = text.replace(/<br\s*\/?>/gi, '\n').replace(BLOCK_END, '\n');
    text = text.replace(/<[^>]*>/g, ' ');
    text = decodeEntities(text);
    return normaliseLines(text, { htmlWidgets: true });
}

/**
 * JSON -> text with keys sorted, so a server that shuffles its key order is not reported as
 * having changed anything. Unparseable JSON falls back to plain text normalisation.
 */
export function jsonToText(body) {
    try {
        const sorted = sortKeysDeep(JSON.parse(body));
        return normaliseLines(JSON.stringify(sorted, null, 1));
    } catch {
        return normaliseLines(body);
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
export function pdfTextToText(text) {
    return normaliseLines(String(text).replace(/\f/g, '\n'));
}

/** Normalise by kind. The kind is the one the CONTENT-TYPE said, not the one the URL guessed. */
export function normaliseByKind(kind, payload) {
    if (kind === 'pdf') return pdfTextToText(payload);
    if (kind === 'api') return jsonToText(payload);
    return htmlToText(payload);
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

/** Content types we can turn into text. Everything else is bytes we can only watch as bytes. */
const TEXTUAL = /(^text\/)|html|xml|json|javascript|csv|plain|urlencoded/i;

export function isTextual(contentType) {
    return TEXTUAL.test(String(contentType ?? ''));
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
 * Severity of a document change from the cheapest signal that exists today (EVIDENCE.md §2.3):
 * a changed line carrying one of the keywords is `caution`, anything else is `info`. The quote
 * check that would make it `warning` is slice 2 — see `claimQuoteCheckHook` below.
 *
 * `api` sources are capped at `info` and never raise an event: a price or supply endpoint changes
 * between two fetches by design, so keyword-matching its body would fill the change feed with
 * noise and bury the legal terms this is for. Their movement is the market and on-chain watchers'
 * subject (EVIDENCE.md §2.4, §2.5), not the document watcher's.
 */
export function severityForChange({ kind, changedLines }) {
    const lines = Array.isArray(changedLines) ? changedLines : [];
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
export function quoteKey(text) {
    if (typeof text !== 'string') return '';
    return text
        .replace(/[\u2018\u2019\u201a\u2032]/g, '\'')
        .replace(/[\u201c\u201d\u201e\u2033]/g, '"')
        .replace(/[\u00ad]/g, '')
        // A bare page number on its own line is `pdftotext` crossing a page break mid-sentence
        // ("held in the\n68\nmain and sub accounts" — three such in one prospectus); it is
        // not part of any quote.
        .replace(/^[ \t]*\d{1,4}[ \t]*$/gm, '')
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
export function quoteFound(text, quote) {
    const fragments = quoteFragments(quote);
    if (fragments.length === 0) return null;
    const haystack = quoteKey(text);
    let from = 0;
    for (const fragment of fragments) {
        const at = haystack.indexOf(fragment, from);
        if (at < 0) return false;
        from = at + fragment.length;
    }
    return true;
}

/**
 * Every quote registered against one source, checked against that source's current text.
 * `quotes` are `{id, kind, ref, quote}` (kind `claim` or `what-if`, ref the field or the mode).
 */
export function checkQuotes(text, quotes) {
    const found = [];
    const lost = [];
    let skipped = 0;
    for (const item of Array.isArray(quotes) ? quotes : []) {
        const verdict = quoteFound(text, item?.quote);
        if (verdict === null) skipped += 1;
        else if (verdict) found.push(item);
        else lost.push(item);
    }
    return { checked: found.length + lost.length, found, lost, skipped };
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
    ['sec.gov', 'rwa-sonar source-watch contact@rwasonar.com']
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
    /px-captcha/i, /incapsula incident id/i, /cf-error-details/i
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
 * What state a fetch leaves a source in. Kept separate from the fetching so every branch is
 * testable: `ok` (200 and the same hash, or 304), `changed` (200 and a new hash), `gone` (404,
 * 410 or a host that no longer resolves — EVIDENCE.md §3 `document-gone`), `blocked` (the host
 * refuses us: 401/403/405/406/429-after-backoff/451, or a bot wall), `error` (anything else:
 * 5xx, timeout, reset — a run with one of these must not report success).
 */
export function decideOutcome({ httpStatus = null, networkErrorCode = null, blocked = false,
    sameHash = false, retriedAfterBackoff = false, jsOnly = false, vendor = null,
    host = null } = {}) {
    if (networkErrorCode) {
        if (networkErrorCode === 'ENOTFOUND') {
            return { status: 'gone', reason: 'dns: host does not resolve' };
        }
        return { status: 'error', reason: `network: ${networkErrorCode}` };
    }
    if (httpStatus === 304) return { status: 'ok', reason: 'http-304 not modified' };
    if (httpStatus === 404 || httpStatus === 410) return { status: 'gone', reason: `http-${httpStatus}` };
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

/**
 * Save Page Now 2 (the authenticated API): `POST /save` answers `{url, job_id}` and
 * `GET /save/status/<job_id>` answers `{status: 'pending'|'success'|'error', timestamp,
 * original_url, message, status_ext}`. Turned into `{done, archiveUrl, error}`: `done` false
 * while pending; success → the absolute archived URL built from the capture timestamp and the
 * original URL; error → the archive's own message. Anything unparseable is an error, never a
 * silent null.
 */
export function parseSpnStatus(body) {
    const j = body && typeof body === 'object' ? body : null;
    if (!j) return { done: true, archiveUrl: null, error: 'save-page-now status: not an object' };
    if (j.status === 'pending') return { done: false, archiveUrl: null, error: null };
    if (j.status === 'success') {
        const ts = typeof j.timestamp === 'string' && /^\d{14}$/.test(j.timestamp) ? j.timestamp : null;
        const original = typeof j.original_url === 'string' && j.original_url !== '' ? j.original_url : null;
        if (ts && original) return { done: true, archiveUrl: `https://web.archive.org/web/${ts}/${original}`, error: null };
        return { done: true, archiveUrl: null, error: 'save-page-now success without timestamp/original_url' };
    }
    const why = [j.status_ext, j.message].filter((x) => typeof x === 'string' && x !== '').join(': ');
    return { done: true, archiveUrl: null, error: `save-page-now ${j.status ?? 'unknown status'}${why ? ` — ${why}` : ''}` };
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
    ['error', "r->>'error'"]
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
    ['diff_removed', "(r->>'diffRemoved')::int"]
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
