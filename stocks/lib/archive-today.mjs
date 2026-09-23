// archive.today (archive.ph / archive.md) as a second archive after the Wayback Machine: its
// Memento timemap says whether it holds a copy of a page and when it was taken. Only the timemap
// is used — archive.today serves the memento pages themselves behind a reCAPTCHA to scripted
// clients (HTTP 429 "One more step", 2026-09-23), and this watcher does not solve CAPTCHAs — so a
// memento is recorded as a link to an archived copy, never read as the page's text. Pure: no
// network here (stocks/watch-sources.mjs does the IO).

/** The Memento timemap (RFC 7089 link-format) of `url` on archive.today. */
export function archiveTodayTimemapUrl(url) {
    return `https://archive.ph/timemap/${url}`;
}

const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

/** `Tue, 31 Mar 2026 11:19:32 GMT` -> `2026-03-31T11:19:32Z`; null for anything else. */
export function mementoDatetimeIso(value) {
    const m = typeof value === 'string'
        ? value.match(/^\w{3}, (\d{2}) (\w{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/)
        : null;
    if (!m || !MONTHS[m[2]]) return null;
    return `${m[3]}-${MONTHS[m[2]]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

/**
 * The newest memento in a timemap body: `{url, datetime}` (datetime the memento's own ISO time,
 * never ours), or null when the body lists none. Entries look like
 * `<http://archive.md/20260331111932/https://…>; rel="first last memento"; datetime="Tue, 31 Mar 2026 11:19:32 GMT",`.
 */
export function parseTimemapNewest(body) {
    if (typeof body !== 'string') return null;
    let newest = null;
    for (const entry of body.split(/,\s*\n|\n/)) {
        const m = entry.match(/^\s*<([^>]+)>\s*;(.*)$/);
        if (!m) continue;
        const rel = m[2].match(/\brel="([^"]*)"/);
        if (!rel || !rel[1].split(/\s+/).includes('memento')) continue;
        const datetime = mementoDatetimeIso(m[2].match(/\bdatetime="([^"]*)"/)?.[1]);
        if (datetime === null) continue;
        if (newest === null || datetime > newest.datetime) newest = { url: m[1].replace(/^http:\/\//, 'https://'), datetime };
    }
    return newest;
}
