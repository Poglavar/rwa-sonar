// Did a read give us the document, or something else served in its place? The watcher's answer
// for a 2xx body (and for a stored copy a 304 stands on): `readable`, or `unreadable` with a reason
// code and a short human reason. An unreadable read is our reader failing, not the document
// changing — a region-restriction page served to the server's region, a script-only shell, an RPC
// endpoint's info page, an empty body — and before this existed each one was hashed, diffed and
// raised as a change (next-steps.md item 11: 95 of the 162 events the judge rated material from
// 2026-09-17 to 2026-09-24 were raised against one RPC info page). Pure: no network, no filesystem;
// stocks/watch-sources.mjs applies the verdict (status `unreadable`, no version, no event, the last
// readable version stays the baseline). Tested on real reads in ../unreadable.test.js
// (stocks/fixtures/unreadable/).

import { createHash } from 'node:crypto';

import { jsonbLiteral } from './db-load.mjs';
import { emptyPublishedPage, jsOnlyShell } from './watch.mjs';

/**
 * The reason codes, each with the phrase the watch page prints as "couldn't read (<label>)".
 * `challenge` is not here: a bot wall is the host refusing us, and stays `blocked` (decideOutcome).
 */
export const UNREADABLE_LABELS = {
    'text-as-bytes': 'a text file read as bytes',
    empty: 'no readable text',
    'rpc-info': 'an RPC endpoint, not a document',
    geoblock: 'region-restricted page',
    'js-shell': 'script-only page',
    'near-empty': 'almost no readable text'
};

/** `couldn't read (<label>): <detail>` — what sonar.source.error and the run log carry. */
export function unreadableReason(code, detail) {
    const label = UNREADABLE_LABELS[code] ?? code;
    return `couldn't read (${label})${detail ? `: ${detail}` : ''}`;
}

const verdict = (code, detail) => ({ readable: false, code, label: UNREADABLE_LABELS[code], reason: unreadableReason(code, detail) });
const READABLE = Object.freeze({ readable: true });

/**
 * A region-restriction page is SHORT: Backed Assets' is 869 characters, Remora Markets' 437. A real
 * legal page mentions restricted jurisdictions at length ("xStocks are not available in the United
 * States or to U.S. persons…" in a footer), which is why the phrases below also need the whole read
 * to be this short, and why none of them is a bare "not available in the United States".
 */
const GEOBLOCK_TEXT_MAX = 2000;
const GEOBLOCK_PHRASES = [
    // Remora Markets' /not-available page (2026-03 Wayback captures and the 2026-09-24 live read).
    /\bnot available in your (?:region|country|jurisdiction|location|territory)\b/i,
    // Backed Assets' geoblock section (assets.backed.fi, read from the server 2026-09-17..24).
    /\baccess(?:ing)? (?:our|this) (?:website|site|service|platform|page|content)s? from an? (?:restricted|prohibited|unsupported|sanctioned) (?:country|region|jurisdiction|territory|location)\b/i,
    /\byour (?:region|country|jurisdiction|location) is (?:not supported|restricted|blocked|not permitted)\b/i
];

/**
 * An RPC endpoint answering a plain GET. api.mainnet-beta.solana.com serves Triton One's info page
 * ("RPC service operated by Triton One", links to /haproxy_status) — the text a dossier citation of
 * the endpoint was hashed as, and against which 95 quotes about mint and freeze authorities were
 * reported lost on 2026-09-19 and 2026-09-21. A JSON-RPC endpoint that answers GET with a JSON-RPC
 * error (`{"jsonrpc":"2.0","error":…}` and no `result`) is the same thing in JSON.
 */
const RPC_INFO_TEXT_MAX = 1500;
const RPC_INFO_MARKERS = [/\bRPC (?:service|node|endpoint|server)s?\b/i, /\/haproxy_(?:status|load)\b/i, /\bJSON-?RPC\b/i];

function rpcInfo({ kind, text, raw }) {
    if (kind === 'api') {
        try {
            const doc = JSON.parse(raw);
            return Boolean(doc) && typeof doc === 'object' && !Array.isArray(doc)
                && doc.jsonrpc === '2.0' && 'error' in doc && !('result' in doc);
        } catch {
            return false;
        }
    }
    if (kind !== 'html' || text.length > RPC_INFO_TEXT_MAX) return false;
    const title = text.split('\n', 1)[0];
    return /\bRPC\b/.test(title) && RPC_INFO_MARKERS.some((re) => re.test(text) || re.test(raw));
}

/** The decoded `<title>` of an HTML document, or null. */
function htmlTitle(raw) {
    const m = String(raw).match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
    if (!m) return null;
    return m[1].replace(/\s+/g, ' ').trim()
        .replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ');
}

/**
 * A single-page app's shell: nothing but the `<title>` (and at most a "Loading…" line) once the
 * markup is stripped, from a page that loads its content from script. Measured: securitize's
 * `/tokenize/instructions` (3.9 kB, `<div id="root"></div>`, 45 characters: the title),
 * brokercheck.finra.org (9 kB, `<bc-root></bc-root>`), Kamino ("Loading Kamino", 6 kB). Only a
 * SMALL page: `jsOnlyShell` in lib/watch.mjs catches the large ones, and a large page that reads as
 * its title can be our extraction dropping the content rather than a script rendering it
 * (cysec.gov.cy: 308 kB inside `<form id="aspnetForm">`, read as the title and 14 characters).
 */
const SHELL_BODY_MAX = 40;

/**
 * Evidence in the raw HTML that the page renders its content from script: the `<noscript>` notice
 * `jsOnlyShell` looks for, an empty app mount element, a Next.js flight payload.
 */
const SCRIPT_RENDERED = [
    /(enable|requires?)\s+javascript/i,
    /<div\s+id=["'](?:root|app|__next|__nuxt|svelte)["'][^>]*>\s*<\/div>/i,
    /<([a-z][\w-]*-root)\b[^>]*>\s*<\/\1>/i,
    /self\.__next_f\b/
];

function titleOnlyShell(text, raw) {
    if (raw.length >= NEAR_EMPTY_RAW_MIN || !/<script\b[^>]*\bsrc\s*=/i.test(raw)) return false;
    const title = htmlTitle(raw);
    const lines = text.split('\n');
    const body = (title !== null && lines[0] === title ? lines.slice(1) : lines).join('\n');
    return body.length < SHELL_BODY_MAX;
}

/**
 * A large page whose text has collapsed: under 600 characters from 20 kB or more of markup, where
 * the last READABLE version of the same source had at least three times as much. `jsOnlyShell`
 * already catches the same shape under 300 characters without a comparison (labelled near-empty
 * unless there is evidence of script rendering); between 300 and 600 a comparison is required,
 * because real pages are that short too — prestocks.com/products (395 characters from 142 kB),
 * figure.ai (455 from 38 kB), a GitBook index page (412 from 293 kB), all stable over a week of
 * reads on the server (2026-09-17..24).
 */
const NEAR_EMPTY_RAW_MIN = 20_000;
const NEAR_EMPTY_TEXT_MAX = 600;

/** Whether the near-empty rule can apply, i.e. whether the caller should look up `previousChars`. */
export function needsPreviousChars({ text = '', raw = '' } = {}) {
    return String(raw).length >= NEAR_EMPTY_RAW_MIN && String(text).length < NEAR_EMPTY_TEXT_MAX;
}

function nearEmpty(text, raw, previousChars) {
    if (!needsPreviousChars({ text, raw })) return false;
    if (typeof previousChars !== 'number' || !Number.isFinite(previousChars) || previousChars <= 0) return false;
    return previousChars >= text.length * 3;
}

const kb = (n) => `${Math.round(n / 1024)} kB`;

/**
 * Classify one read. Inputs:
 *  - `kind`: html | pdf | api — what the content-type said (and the bytes, for a PDF);
 *  - `via`: the reader (html, next-flight, notion, pdf, api, binary…);
 *  - `text`: the normalised text that would be hashed; `raw`: the body as a string (HTML/JSON);
 *  - `binary` / `bytesAreText`: the body was watched as bytes, and those bytes are really UTF-8 text;
 *  - `previousChars`: the text length of the last READABLE version, when there is one;
 *  - `quotes`: `{checked, lost}` for the dossier quotes registered on this source, read against
 *    this read's quote text — every checkable quote found means the read IS the cited document
 *    whatever it looks like (Remora's region-block page is itself cited, quoted verbatim).
 * Returns `{readable: true}` or `{readable: false, code, label, reason}`.
 */
export function classifyRead({ kind = 'html', via = null, text = '', raw = '', binary = false, bytesAreText = false,
    previousChars = null, quotes = null } = {}) {
    const body = typeof text === 'string' ? text : '';
    const markup = typeof raw === 'string' ? raw : '';
    if (quotes && quotes.checked > 0 && quotes.lost === 0) return READABLE;
    if (binary) {
        // A zip or an image is watched as its bytes on purpose; only text mistaken for bytes is a
        // failed read (stocks.securitize.io's broker instructions .md, octet-stream, 2026-09-24).
        return bytesAreText ? verdict('text-as-bytes', 'the host labelled a text file as bytes and it was hashed as a binary marker') : READABLE;
    }
    if (body.trim() === '') {
        return verdict('empty', kind === 'pdf' ? 'the PDF has no text layer' : 'nothing readable was left once the markup was stripped');
    }
    if (rpcInfo({ kind, text: body, raw: markup })) {
        return verdict('rpc-info', kind === 'api'
            ? 'the endpoint answered a plain GET with a JSON-RPC error'
            : `the endpoint served its info page ("${body.split('\n', 1)[0].slice(0, 80)}")`);
    }
    if (kind !== 'html' || via === 'notion') return READABLE;
    if (body.length <= GEOBLOCK_TEXT_MAX) {
        const phrase = GEOBLOCK_PHRASES.map((re) => body.match(re)).find(Boolean);
        if (phrase) return verdict('geoblock', `the host served a region-restriction notice ("${phrase[0]}") to the watcher's region`);
    }
    // A WordPress page published empty is read as empty on purpose (lib/watch.mjs emptyPublishedPage).
    if (emptyPublishedPage(markup)) return READABLE;
    const titleOnly = titleOnlyShell(body, markup);
    if (titleOnly || jsOnlyShell(body, markup)) {
        // Called a script-only page only on evidence of one (a JavaScript notice, or nothing but the
        // title from a page that loads scripts). A large page that just reads as almost nothing can
        // also be our extraction dropping the content: cysec.gov.cy's ASP.NET page lives inside
        // `<form id="aspnetForm">` (316 kB, 71 characters), backed.fi's article inside a `<header>`.
        if (titleOnly || SCRIPT_RENDERED.some((re) => re.test(markup))) {
            return verdict('js-shell', `${body.length} characters of text from ${kb(markup.length)} of markup; the content renders only in a browser`);
        }
        return verdict('near-empty', `${body.length} characters of text from ${kb(markup.length)} of markup`);
    }
    if (nearEmpty(body, markup, previousChars)) {
        return verdict('near-empty', `${body.length} characters of text from ${kb(markup.length)} of markup; the last readable version had ${previousChars}`);
    }
    return READABLE;
}

// --- dismissing the events such reads already raised --------------------------------------------

/**
 * Who and why, for the `sonar.review_resolution` row that dismisses an event raised from a read
 * that was not the document (db/2026-09-20-sonar-review-resolutions.sql: the append-only editorial
 * record the review API writes; `false-alarm` with a note). stocks/dismiss-unreadable-events.mjs.
 */
export const DISMISS_REVIEWER = 'watcher: unreadable-read classifier (stocks/lib/unreadable.mjs)';
export const DISMISS_ISSUE = 'unreadable-read';
const NOTE_MAX = 4000;

/**
 * Whether one watcher event (`legal-term` or `quote-lost`) was raised from a read that was not the
 * document, and why. `read` is `classifyRead`'s verdict on the stored copy the event was raised
 * from; `baseline` its verdict on the stored version a `legal-term` diff was taken against (a first
 * real read diffed against a Drive viewer shell is "the document appeared", not a change);
 * `quoteFound` whether a `quote-lost` event's quote IS in that same stored copy read by today's
 * quote reader — a lost quote that is there was lost by an older reader (the `<header>` and
 * `<footer>` rules), which is a false event of another class and is dismissed only on request
 * (`includeReaderFixed`). Returns `{category, code, reason}` or null to leave the event alone.
 */
export function dismissalFor({ kind, read = null, baseline = null, quoteFound = null, includeReaderFixed = false } = {}) {
    if (read && read.readable === false) return { category: 'unreadable-read', code: read.code, reason: read.reason };
    if (kind === 'legal-term' && baseline && baseline.readable === false) {
        return { category: 'unreadable-baseline', code: baseline.code, reason: `the version it was compared with ${baseline.reason.replace(/^couldn't read/, 'was unreadable')}` };
    }
    if (includeReaderFixed && kind === 'quote-lost' && quoteFound === true) {
        return { category: 'reader-fixed', code: null, reason: 'the quoted words are in the stored copy the event was raised from; the reader of the day missed them' };
    }
    return null;
}

/** The note stored with the dismissal: what the event was raised from and why it is not a change. */
export function dismissalNote({ eventId, kind, category, reason, textPath = null }) {
    const lead = category === 'reader-fixed'
        ? `Dismissed automatically: ${kind} event ${eventId} is a false alarm — ${reason}.`
        : category === 'unreadable-baseline'
            ? `Dismissed automatically: ${kind} event ${eventId} diffed the document against a stored copy that was not the document — ${reason}.`
            : `Dismissed automatically: ${kind} event ${eventId} was raised from a read that was not the document — ${reason}.`;
    const note = `${lead}${textPath ? ` Stored copy: ${textPath}.` : ''} The watcher no longer raises events from such reads (next-steps.md item 11).`;
    return note.length > NOTE_MAX ? `${note.slice(0, NOTE_MAX - 1)}…` : note;
}

/** A 16-hex review item id, the shape the review API uses, stable per event. */
export function dismissalItemId(eventId) {
    return createHash('sha1').update(`${DISMISS_ISSUE}|${eventId}`).digest('hex').slice(0, 16);
}

/**
 * The idempotent write for a set of dismissals `{eventId, issuerSlug, field, note}`: one
 * `false-alarm` review_resolution per event that has none yet, and `acknowledged_at` on each event
 * that is not acknowledged yet. Rows are never deleted; a rerun inserts and updates nothing.
 * `acknowledged_at` is the moment of this acknowledgement, which is what the column records.
 */
export function buildDismissalSql(dismissals, { tag = 'sonar' } = {}) {
    const rows = (Array.isArray(dismissals) ? dismissals : [])
        .filter((d) => Number.isInteger(d?.eventId) && typeof d.note === 'string' && d.note.length >= 3)
        .map((d) => ({ eventId: d.eventId, itemId: dismissalItemId(d.eventId), issuerSlug: d.issuerSlug ?? null, field: d.field ?? null, note: d.note }));
    const sql = `WITH doc AS (SELECT ${jsonbLiteral({ rows }, tag)} AS d),\n`
        + "     src AS (SELECT (x.r->>'eventId')::bigint AS event_id, x.r FROM doc, jsonb_array_elements(d->'rows') AS x(r)),\n"
        + '     inserted AS (\n'
        + '       INSERT INTO sonar.review_resolution\n'
        + '              (review_item_id, event_id, issuer_slug, field, issue, resolution, note, reviewer, previous_text, current_text)\n'
        + `       SELECT src.r->>'itemId', src.event_id, src.r->>'issuerSlug', src.r->>'field', '${DISMISS_ISSUE}', 'false-alarm',\n`
        + `              src.r->>'note', '${DISMISS_REVIEWER}', e.before, e.after\n`
        + '         FROM src JOIN sonar.change_event e ON e.id = src.event_id\n'
        + '        WHERE NOT EXISTS (SELECT 1 FROM sonar.review_resolution rr\n'
        + "                           WHERE rr.event_id = src.event_id AND rr.resolution = 'false-alarm')\n"
        + '       RETURNING event_id),\n'
        + '     acknowledged AS (\n'
        + '       UPDATE sonar.change_event e SET acknowledged_at = now(), updated_at = now()\n'
        + '         FROM src WHERE e.id = src.event_id AND e.acknowledged_at IS NULL\n'
        + '       RETURNING e.id)\n'
        + 'SELECT (SELECT count(*) FROM inserted) AS resolutions_inserted, (SELECT count(*) FROM acknowledged) AS events_acknowledged;\n';
    return { table: 'sonar.review_resolution + sonar.change_event', rows: rows.length, sql };
}
