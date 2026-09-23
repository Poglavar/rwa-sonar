// The Wayback fallback's pure half: when a host refuses the watcher outright (republic.com answers
// every scripted client, from the server and the laptop alike, with a 4.5 kB 403), the newest
// archived capture is the best text there is. This builds the CDX query and the raw-capture URL,
// reads the CDX answer, decides which blocked outcomes qualify, and words the record so a capture
// is never mistaken for a live read. Network and pacing live in ../watch-sources.mjs.

import { gunzipSync } from 'node:zlib';

/** At most this many fallbacks per run: each costs two paced archive requests. */
export const WAYBACK_FALLBACK_CAP = 40;
/** Minimum gap between two requests to web.archive.org during the fallback pass. */
export const WAYBACK_PACE_MS = 2000;

/** `https://web.archive.org/cdx/search/cdx?…` asking for the single newest 200 capture of `url`. */
export function cdxQueryUrl(url) {
    return `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}`
        + '&output=json&limit=-1&filter=statuscode:200';
}

/**
 * The CDX JSON answer is a header row then data rows: `[["urlkey","timestamp","original",
 * "mimetype","statuscode","digest","length"], [...]]`. With `limit=-1` the one data row is the
 * newest capture. Returns `{timestamp, original, mimetype, digest}` or null for "no capture" (an
 * empty body, `[]`, or a header with no rows). A malformed row is null, never a guessed timestamp.
 */
export function parseCdxNewest(body) {
    let rows = body;
    if (typeof body === 'string') {
        if (body.trim() === '') return null;
        try {
            rows = JSON.parse(body);
        } catch {
            return null;
        }
    }
    if (!Array.isArray(rows) || rows.length < 2 || !Array.isArray(rows[0])) return null;
    const header = rows[0];
    const row = rows[rows.length - 1];
    if (!Array.isArray(row)) return null;
    const field = (name) => {
        const at = header.indexOf(name);
        return at >= 0 && typeof row[at] === 'string' ? row[at] : null;
    };
    const timestamp = field('timestamp');
    const original = field('original');
    if (timestamp === null || !/^\d{14}$/.test(timestamp) || original === null || !/^https?:\/\//i.test(original)) return null;
    return { timestamp, original, mimetype: field('mimetype'), digest: field('digest') };
}

/** The CDX API routinely takes 20+ s to answer (21.6 s for republic.com/terms, 2026-09-23). */
export const CDX_TIMEOUT_MS = 60_000;

/**
 * The bytes of an `id_` capture, whatever its headers claim. Wayback replays the ORIGINAL
 * `Content-Encoding: gzip` header over a body it has already decompressed (republic.com/terms,
 * 2026-09-23: `content-encoding: gzip` on 402 kB of plain HTML), which makes an HTTP client that
 * honours the header fail with Z_DATA_ERROR. So the capture is fetched without decoding, and the
 * body is gunzipped only when it actually starts with the gzip magic bytes.
 */
export function decodeCaptureBody(buffer) {
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return gunzipSync(bytes);
    return bytes;
}

/** `id_` asks Wayback for the original bytes, without its toolbar or rewritten links. */
export function captureRawUrl(timestamp, original) {
    return `https://web.archive.org/web/${timestamp}id_/${original}`;
}

/**
 * A source that IS a Wayback capture link (a dossier citing `web.archive.org/web/<ts>/<url>` because
 * the original is gone): its timestamp and original URL, so it can be fetched as the raw `id_`
 * capture. Fetched as cited, the page came wrapped in the toolbar ("About this capture",
 * TIMESTAMPS…), and that chrome registered as a document change (event 2056, 2026-09-23).
 * Null for any other URL.
 */
export function citedCapture(url) {
    const m = typeof url === 'string'
        ? url.match(/^https?:\/\/web\.archive\.org\/web\/(\d{14})(?:[a-z]{2}_)?\/(https?:\/\/.+)$/)
        : null;
    return m ? { timestamp: m[1], original: m[2] } : null;
}

/** The capture as a reader opens it (with the toolbar): what we store and show as the archive link. */
export function captureViewUrl(timestamp, original) {
    return `https://web.archive.org/web/${timestamp}/${original}`;
}

/** `20260501123456` -> `2026-05-01T12:34:56Z`. Null for anything that is not a 14-digit stamp. */
export function captureIso(timestamp) {
    const m = typeof timestamp === 'string' ? timestamp.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/) : null;
    return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
}

/**
 * Only a host that REFUSES us qualifies: a 401/403 or a bot wall. Not a 429 (the host will talk to
 * us later), not a 400 (a malformed API call is not a document), not a JavaScript-only page (the
 * archive would hold the same empty shell), and never a URL that is already on web.archive.org.
 */
export function wantsWaybackFallback({ status, httpStatus = null, botWall = false, url = '' } = {}) {
    if (status !== 'blocked') return false;
    try {
        const host = new URL(url).hostname.toLowerCase();
        if (host === 'archive.org' || host.endsWith('.archive.org')) return false;
    } catch {
        return false;
    }
    return httpStatus === 401 || httpStatus === 403 || botWall === true;
}

/**
 * The line that goes into the result's `reason` (the checkpoint and the run log) when the text came
 * from a capture: it says the live page was NOT read, what it answered, and the capture date the
 * words are from. sonar.source carries the same facts as columns — `read_via = 'wayback'`,
 * `capture_at`, the live `http_status` — and its `error` stays null, because a successful archived
 * read is not a fetch error (db/2026-09-23-sonar-source-provenance.sql).
 */
export function waybackNote({ liveReason, captureTimestamp, captureUrl }) {
    return `live fetch blocked (${liveReason}); text read from the Wayback capture of `
        + `${captureIso(captureTimestamp) ?? captureTimestamp} — ${captureUrl}`;
}

/**
 * How a watcher result read from a capture labels what it writes: `evidence` fields spread into
 * every change event's evidence jsonb, and `prefix` put in front of every event summary and
 * version diff summary. A live read gets `{evidence: null, prefix: ''}` and is written unchanged.
 */
export function archivedProvenance(result) {
    if (result?.via !== 'wayback') return { evidence: null, prefix: '' };
    return {
        evidence: {
            via: 'wayback',
            captureTimestamp: result.captureTimestamp ?? null,
            captureUrl: result.captureUrl ?? null,
            liveReason: result.liveReason ?? null
        },
        prefix: `[Wayback capture of ${result.captureTimestamp ?? 'unknown date'}; live page refused us] `
    };
}
