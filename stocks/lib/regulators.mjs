// The regulator-notice watcher's decisions (stocks/watch-regulators.mjs), kept pure so they are
// unit tested without a network or a database (stocks/regulators.test.js): which names are
// watched (the case-law watcher's own derivation, imported, never copied), how each regulator's
// publication becomes comparable notices, when a notice names a watched party strongly (the full
// legal name) or weakly (a brand, a bare name, or the legal name without its suffix), what is an
// event, and the SQL that stores it all.
//
// Nothing here marks an issuer as sanctioned or warned against: every event is a CANDIDATE for a
// human to read.

import { createHash } from 'node:crypto';

import {
    GENERIC_WORDS, STOPLIST, deriveQueries, hasLegalSuffix, normalisePhrase, parseSecFeed
} from './caselaw.mjs';
import { jsonbLiteral } from './db-load.mjs';
import { decodeEntities } from './watch.mjs';

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

/**
 * Corporate-form spellings folded to one token, after normalisePhrase has removed punctuation:
 * "Limited"/"Ltd", "Incorporated"/"Inc", "Corporation"/"Corp", "Company"/"Co", and the dotted
 * forms that normalisation splits into letters ("L.L.C." → "l l c" → "llc").
 */
const SUFFIX_WORDS = new Map([
    ['limited', 'ltd'], ['incorporated', 'inc'], ['corporation', 'corp'], ['company', 'co'],
    ['aktiengesellschaft', 'ag']
]);
const SPLIT_SUFFIXES = [
    [/ l l c(?= )/g, ' llc'], [/ l l p(?= )/g, ' llp'], [/ l p(?= )/g, ' lp'], [/ p l c(?= )/g, ' plc'],
    [/ s a r l(?= )/g, ' sarl'], [/ s a(?= )/g, ' sa'], [/ n a(?= )/g, ' na'], [/ b v(?= )/g, ' bv'],
    [/ n v(?= )/g, ' nv'], [/ a g(?= )/g, ' ag']
];

/** Suffix tokens (canonical) stripped to find a legal name's core. `foundation` is not one: "Ondo" alone is not a name. */
const CANONICAL_SUFFIXES = new Set([
    'inc', 'ltd', 'llc', 'llp', 'corp', 'co', 'ag', 'sa', 'gmbh', 'plc', 'lp', 'fze', 'pte', 'bv', 'nv',
    'sarl', 'se', 'kg', 'na', 'pty'
]);

/** A name or a text as space-padded canonical tokens, so a phrase test is a substring test on word boundaries. */
export function canonicalName(text) {
    let s = ` ${normalisePhrase(text)} `;
    for (const [re, to] of SPLIT_SUFFIXES) s = s.replace(re, to);
    return ` ${s.trim().split(' ').filter(Boolean).map((w) => SUFFIX_WORDS.get(w) ?? w).join(' ')} `;
}

/**
 * A legal name without its corporate suffixes (and a connector left dangling by them):
 * "Maerki Baumann & Co. AG" → "maerki baumann", "Trek Labs Australia Pty Ltd" → "trek labs australia".
 */
export function nameCore(phrase) {
    const words = canonicalName(phrase).trim().split(' ').filter(Boolean);
    while (words.length > 1 && (CANONICAL_SUFFIXES.has(words.at(-1)) || words.at(-1) === 'and')) words.pop();
    return words.join(' ');
}

/**
 * True when a suffix-less core is still distinctive enough to count as a (weak) mention: not on the
 * case-law stoplist ("securitize", "superstate", "fireblocks"), containing a non-generic word, and
 * either two words or one word of at least five letters. "Payward" is; "Flux" alone would not be.
 */
export function distinctiveCore(core) {
    if (!core || STOPLIST.has(core)) return false;
    const words = core.split(' ');
    if (!words.some((w) => !GENERIC_WORDS.has(w))) return false;
    return words.length >= 2 || words[0].length >= 5;
}

/**
 * The watched names, derived from the dossiers by the case-law watcher's own deriveQueries (so the
 * two watchers can never watch different parties). A phrase that ends in a corporate suffix is a
 * full legal name; anything else — a brand ("xStocks"), a bare name ("DekaBank") — can only ever
 * produce a weak match.
 */
export function deriveWatchNames(dossiers, { extra = {} } = {}) {
    const { queries } = deriveQueries(dossiers, { extra });
    return queries.filter((q) => q.kind === 'phrase' && q.phrase).map((q) => {
        const legal = hasLegalSuffix(q.phrase);
        const core = legal ? nameCore(q.phrase) : null;
        return {
            entity: normalisePhrase(q.phrase),
            phrase: q.phrase,
            issuers: [...q.issuers],
            roles: [...new Set(q.origins.map((o) => o.role))].sort(),
            legal,
            canonical: canonicalName(q.phrase),
            core: core && core !== canonicalName(q.phrase).trim() && distinctiveCore(core) ? core : null
        };
    });
}

/**
 * How firmly `text` names `name`: `strong` when the full legal name appears (suffix variants
 * equal), `weak` when only the brand / bare name, or the legal name's distinctive core without
 * its suffix, appears; null when it does not appear at all.
 */
export function nameStrength(text, name) {
    const hay = canonicalName(text);
    if (hay.includes(name.canonical)) return name.legal ? 'strong' : 'weak';
    if (name.core && hay.includes(` ${name.core} `)) return 'weak';
    return null;
}

const STRENGTH_RANK = { strong: 0, weak: 1 };

/**
 * Every (notice, name) pair where the notice names a watched party. The notice's `subjects` (the
 * named firm on a warning list, the respondent) and title count as `subject`; the summary or body
 * as `text`. The stronger reading wins, and within one strength, `subject` wins.
 */
export function matchNotices(notices, names) {
    const out = [];
    for (const notice of notices) {
        const head = [notice.title, ...(notice.subjects ?? [])].filter(Boolean).join('\n');
        const body = notice.text ?? '';
        for (const name of names) {
            const inHead = nameStrength(head, name);
            const inBody = body ? nameStrength(body, name) : null;
            if (!inHead && !inBody) continue;
            let strength;
            let matchedIn;
            if (inHead && (!inBody || STRENGTH_RANK[inHead] <= STRENGTH_RANK[inBody])) {
                strength = inHead;
                matchedIn = 'subject';
            } else {
                strength = inBody;
                matchedIn = 'text';
            }
            out.push({ notice, name, strength, matchedIn });
        }
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// Dates. Every notice carries the regulator's OWN date: `publishedAt` when the source gives a time,
// `publishedDate` (the calendar date in the regulator's own time zone) always when it gives one.
// Neither is ever our fetch time; a source without a date leaves both null.
// ---------------------------------------------------------------------------------------------

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
    'october', 'november', 'december'];

function isoSeconds(date) {
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The calendar date of an instant in a time zone, YYYY-MM-DD. */
export function dateInZone(date, timeZone) {
    return date.toLocaleDateString('en-CA', { timeZone });
}

/** A wall-clock time in `timeZone` → the UTC instant (two passes settle any DST edge). */
export function zonedToUtc({ year, month, day, hour = 0, minute = 0 }, timeZone) {
    const wall = Date.UTC(year, month - 1, day, hour, minute);
    let guess = wall;
    for (let i = 0; i < 2; i += 1) {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
            timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
        }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
        const shown = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
        guess += wall - shown;
    }
    return new Date(guess);
}

/** An RFC 822 date (RSS pubDate) → {publishedAt, publishedDate in the regulator's zone}. */
export function rfc822Dates(value, timeZone) {
    const d = value ? new Date(value) : null;
    if (!d || !Number.isFinite(d.getTime())) return { publishedAt: null, publishedDate: null };
    return { publishedAt: isoSeconds(d), publishedDate: dateInZone(d, timeZone) };
}

/** The FCA's own RSS date, "Wednesday, September 30, 2026 - 13:20", London wall-clock time. */
export function fcaDates(value) {
    const m = String(value ?? '').match(/([A-Za-z]+) (\d{1,2}), (\d{4}) - (\d{1,2}):(\d{2})/);
    const month = m ? MONTHS.indexOf(m[1].toLowerCase()) + 1 : 0;
    if (!m || month === 0) return { publishedAt: null, publishedDate: null };
    const parts = { year: Number(m[3]), month, day: Number(m[2]), hour: Number(m[4]), minute: Number(m[5]) };
    return {
        publishedAt: isoSeconds(zonedToUtc(parts, 'Europe/London')),
        publishedDate: `${m[3]}-${String(month).padStart(2, '0')}-${m[2].padStart(2, '0')}`
    };
}

/** A date-only string → YYYY-MM-DD. `order` is dmy ("30.09.2026", "30/09/2026") or mdy ("09/30/2026"). */
export function numericDate(value, order = 'dmy') {
    const m = String(value ?? '').trim().match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (!m) return null;
    const [day, month] = order === 'dmy' ? [m[1], m[2]] : [m[2], m[1]];
    if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return null;
    return `${m[3]}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/** "31 August 2026" → 2026-08-31. */
export function longDate(value) {
    const m = String(value ?? '').trim().match(/^(\d{1,2}) ([A-Za-z]+) (\d{4})$/);
    const month = m ? MONTHS.indexOf(m[2].toLowerCase()) + 1 : 0;
    return m && month ? `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

// ---------------------------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------------------------

/** Tags stripped, entities decoded, whitespace collapsed. */
export function plainText(html) {
    return decodeEntities(String(html ?? '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim();
}

function xmlTag(block, name) {
    const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
    if (!m) return null;
    // An RSS description is escaped HTML: decode once for the markup, then strip it.
    const raw = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
    return plainText(decodeEntities(raw));
}

/** RSS 2.0 → raw items {title, link, guid, pubDate, description, category, creator}. */
export function rssItems(xml) {
    return [...String(xml ?? '').matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)].map(([, body]) => ({
        title: xmlTag(body, 'title'),
        link: xmlTag(body, 'link'),
        guid: xmlTag(body, 'guid'),
        pubDate: xmlTag(body, 'pubDate'),
        description: xmlTag(body, 'description'),
        category: xmlTag(body, 'category'),
        creator: xmlTag(body, 'dc:creator')
    }));
}

/** A small RFC 4180 CSV reader (quoted fields, doubled quotes, CRLF), header row → objects. */
export function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    const src = String(text ?? '').replace(/^﻿/, '');
    for (let i = 0; i < src.length; i += 1) {
        const c = src[i];
        if (quoted) {
            if (c === '"' && src[i + 1] === '"') { field += '"'; i += 1; } else if (c === '"') quoted = false;
            else field += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
            if (c === '\r' && src[i + 1] === '\n') i += 1;
            row.push(field);
            field = '';
            if (row.some((v) => v !== '')) rows.push(row);
            row = [];
        } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); if (row.some((v) => v !== '')) rows.push(row); }
    const [header = [], ...data] = rows;
    return data.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

function shortHash(text) {
    return createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

function requireItems(items, what) {
    if (!Array.isArray(items) || items.length === 0) throw new Error(`${what}: no items parsed — the format changed or the body is not the list`);
    return items;
}

// ---------------------------------------------------------------------------------------------
// Parsers: one regulator publication → notices {id, type, title, subjects[], text, url,
// publishedAt, publishedDate}. Each throws when it reads nothing, so a changed page is a failure,
// never a quiet "no notices".
// ---------------------------------------------------------------------------------------------

/** SEC trading suspensions: the case-law watcher's SEC feed parser, reused. The title IS the company. */
export function parseSecSuspensions(xml) {
    return requireItems(parseSecFeed(xml, { id: 'sec-ts', label: 'SEC trading suspension' }), 'SEC trading suspensions').map((i) => ({
        id: i.externalId,
        type: 'suspension',
        title: i.caseName,
        subjects: [i.caseName],
        text: i.description ?? null,
        url: i.url?.trim() ?? null,
        publishedAt: i.publishedAt ? isoSeconds(new Date(i.publishedAt)) : null,
        publishedDate: i.dateFiled
    }));
}

/** A generic RSS feed. `idOf(item)` picks the id; `typeOf(item)` the notice type; dates via `dates(pubDate)`. */
export function parseRssNotices(xml, { what, idOf, typeOf, dates, subjectIsTitle = false }) {
    return requireItems(rssItems(xml), what).map((item) => {
        const id = idOf(item);
        if (!id) throw new Error(`${what}: an item has no id (title ${JSON.stringify(item.title)})`);
        return {
            id,
            type: typeOf(item),
            title: item.title,
            subjects: subjectIsTitle && item.title ? [item.title] : [],
            text: item.description || null,
            url: item.link || null,
            ...dates(item.pubDate)
        };
    });
}

const lastPathSegment = (url) => String(url ?? '').replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop() || null;

export const parseSecPressReleases = (xml) => parseRssNotices(xml, {
    what: 'SEC press releases',
    // The release number leads the slug ("2026-95-sec-charges-…"); the guid is a bare UUID.
    idOf: (i) => lastPathSegment(i.link)?.match(/^\d{4}-\d+/)?.[0] ?? lastPathSegment(i.link) ?? i.guid,
    typeOf: () => 'press-release',
    dates: (v) => rfc822Dates(v, 'America/New_York')
});

export const parseCftcEnforcement = (xml) => parseRssNotices(xml, {
    what: 'CFTC enforcement releases',
    idOf: (i) => lastPathSegment(i.guid ?? i.link),
    typeOf: () => 'enforcement',
    dates: (v) => rfc822Dates(v, 'America/New_York'),
    subjectIsTitle: true
});

export const parseFcaWarnings = (xml) => parseRssNotices(xml, {
    what: 'FCA warnings', idOf: (i) => i.guid ?? i.link, typeOf: () => 'warning', dates: fcaDates, subjectIsTitle: true
});

export const parseFcaNews = (xml) => parseRssNotices(xml, {
    what: 'FCA news', idOf: (i) => i.guid ?? i.link, typeOf: () => 'news', dates: fcaDates
});

/** FCA publications: a final notice is enforcement, everything else a publication. */
export const parseFcaPublications = (xml) => parseRssNotices(xml, {
    what: 'FCA publications',
    idOf: (i) => i.guid ?? i.link,
    typeOf: (i) => (/\/final-notices\/|\/decision-notices\//.test(i.link ?? '') ? 'enforcement' : 'publication'),
    dates: fcaDates
});

export const parseFinmaNews = (xml) => parseRssNotices(xml, {
    what: 'FINMA news',
    idOf: (i) => i.guid ?? i.link,
    typeOf: (i) => (/sanction/i.test(i.category ?? '') ? 'sanction' : /enforcement/i.test(i.category ?? '') ? 'enforcement' : 'news'),
    dates: (v) => rfc822Dates(v, 'Europe/Zurich')
});

/** BaFin: no guid, so the link (without its query) is the id; "… warnt …" titles are warnings. */
export const parseBafinNews = (xml) => parseRssNotices(xml, {
    what: 'BaFin publications',
    idOf: (i) => (i.link ? i.link.replace(/[?#].*$/, '') : null),
    typeOf: (i) => (/warnt|warning/i.test(i.title ?? '') ? 'warning' : 'news'),
    dates: (v) => rfc822Dates(v, 'Europe/Berlin')
});

export const parseBafinMeasures = (xml) => parseRssNotices(xml, {
    what: 'BaFin measures and sanctions',
    idOf: (i) => (i.link ? i.link.replace(/[?#].*$/, '') : null),
    typeOf: () => 'sanction',
    dates: (v) => rfc822Dates(v, 'Europe/Berlin'),
    subjectIsTitle: true
});

/** FINMA warning list (the complete list, one JSON call). The title is the warned name / domain. */
export function parseFinmaWarnings(json) {
    const items = requireItems(json?.Items, 'FINMA warning list');
    return items.map((i) => ({
        id: String(i.Id),
        type: 'warning',
        title: plainText(i.Title),
        subjects: [plainText(i.Title)],
        text: i.FacetColumn ?? null,
        url: i.Link ? `https://www.finma.ch${i.Link}` : null,
        publishedAt: null,
        publishedDate: numericDate(i.Date, 'dmy')
    }));
}

/**
 * Filing forms that say nothing about the entity's standing: insider ownership reports (an
 * officer's Form 4 names the company as issuer every time they sell), employee-plan registrations,
 * fund holdings and prospectus supplements. Measured 2026-09-30: three Form 4s in one day for
 * Securitize Corp. would each have been an event.
 */
export const ROUTINE_FORMS = new Set(['3', '4', '5', '144', 'S-8', 'S-8 POS', '13F-HR', 'SC 13G', 'SCHEDULE 13G',
    'NPORT-P', '485BPOS', '497', '497K', 'N-CSR', 'N-CEN', '424B2', '424B3', 'FWP']);

/**
 * EDGAR full-text search: only filings the watched name itself FILED (a display name), one notice
 * per accession, routine forms (and their amendments) left out.
 */
export function parseEdgarSearch(json, name) {
    const hits = json?.hits?.hits;
    if (!Array.isArray(hits)) throw new Error('EDGAR full-text search: no hits array — the format changed');
    const byAdsh = new Map();
    for (const hit of hits) {
        const s = hit?._source ?? {};
        if (ROUTINE_FORMS.has(String(s.form ?? '').replace(/\/A$/, ''))) continue;
        const filers = (s.display_names ?? []).map((n) => String(n).replace(/\s*\(CIK \d+\)\s*$/, '').replace(/\s+/g, ' ').trim());
        if (!filers.some((f) => nameStrength(f, name))) continue;
        const adsh = s.adsh ?? String(hit._id ?? '').split(':')[0];
        if (!adsh || byAdsh.has(adsh)) continue;
        const cik = Number((s.ciks ?? [])[0]);
        byAdsh.set(adsh, {
            id: adsh,
            type: 'filing',
            title: `${s.form ?? 'filing'} filed by ${filers.join('; ')}`,
            subjects: filers,
            text: s.file_description ?? null,
            url: Number.isFinite(cik) ? `https://www.sec.gov/Archives/edgar/data/${cik}/${adsh.replace(/-/g, '')}/${adsh}-index.htm` : null,
            publishedAt: null,
            publishedDate: /^\d{4}-\d{2}-\d{2}$/.test(s.file_date ?? '') ? s.file_date : null
        });
    }
    return [...byAdsh.values()];
}

/** BrokerCheck firm search → candidate firms. */
export function parseBrokerCheckSearch(json) {
    const hits = json?.hits?.hits;
    if (!Array.isArray(hits)) throw new Error('BrokerCheck search: no hits array — the format changed');
    return hits.map((h) => h?._source ?? {}).filter((s) => s.firm_source_id).map((s) => ({
        crd: String(s.firm_source_id),
        name: s.firm_name ?? null,
        otherNames: Array.isArray(s.firm_other_names) ? s.firm_other_names : [],
        scope: s.firm_scope ?? null
    }));
}

/**
 * BrokerCheck firm detail → one `register` notice when the firm has any disclosure. BrokerCheck
 * gives counts, not dated events, so the notice has NO date; its id carries the status and the
 * counts, so a new disclosure (or a firm going inactive) is a new notice.
 */
export function parseBrokerCheckFirm(json) {
    const raw = json?.hits?.hits?.[0]?._source?.content;
    if (typeof raw !== 'string') throw new Error('BrokerCheck firm: no content — the format changed');
    const c = JSON.parse(raw);
    const info = c.basicInformation ?? {};
    const crd = String(info.firmId ?? '');
    const name = info.firmName ?? null;
    const disclosures = (c.disclosures ?? []).filter((d) => Number(d.disclosureCount) > 0)
        .map((d) => ({ type: d.disclosureType, count: Number(d.disclosureCount) }))
        .sort((a, b) => a.type.localeCompare(b.type));
    const scope = info.firmScope ?? info.bcScope ?? null;
    const firm = { crd, name, otherNames: info.otherNames ?? [], scope, disclosures };
    if (!crd || !name) throw new Error('BrokerCheck firm: no firm id or name');
    if (disclosures.length === 0) return { firm, notices: [] };
    const list = disclosures.map((d) => `${d.count} ${d.type}`).join(', ');
    return {
        firm,
        notices: [{
            id: `crd-${crd}:${scope ?? '?'}:${disclosures.map((d) => `${d.type}=${d.count}`).join(',')}`,
            type: 'register',
            title: `${name} (CRD ${crd}${scope ? `, ${scope}` : ''}): BrokerCheck discloses ${list}`,
            subjects: [...new Set([name, ...firm.otherNames])],
            text: null,
            url: `https://brokercheck.finra.org/firm/summary/${crd}`,
            publishedAt: null,
            publishedDate: null
        }]
    };
}

/** FINRA Disciplinary Actions Online: one results page (HTML table) → notices. An empty page is not an error. */
export function parseFinraDisciplinary(html) {
    const body = String(html ?? '');
    const tbody = body.match(/<tbody>([\s\S]*?)<\/tbody>/);
    if (!tbody && !/views-view-table|view-empty/.test(body)) throw new Error('FINRA disciplinary actions: no results table — the page changed');
    const rows = [...(tbody?.[1] ?? '').matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
    return rows.map((row) => {
        // Cells are addressed by their `headers` attribute (the column id), not by position.
        const cell = (column) => row.match(new RegExp(`<td headers="${column}-table-column"[^>]*>([\\s\\S]*?)</td>`))?.[1] ?? '';
        const link = cell('view-field-fda-attachment-file-media').match(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/);
        // A firm is `<span class="cell">Name</span>`, an individual `<span class="cell wraplines">`; the icon cell holds only an <i>.
        const parties = [...cell('view-views-conditional-field-3').matchAll(/<span class="cell(?: wraplines)?">([^<]+)<\/span>/g)]
            .map((m) => plainText(m[1])).filter(Boolean);
        const caseId = link ? plainText(link[2]) : null;
        if (!caseId) throw new Error('FINRA disciplinary actions: a row without a case id — the table changed');
        const type = plainText(cell('view-field-fda-document-type-tax'));
        return {
            id: caseId,
            type: 'enforcement',
            title: `${type || 'Disciplinary action'}: ${parties.join('; ') || caseId}`,
            subjects: parties,
            text: plainText(cell('view-views-conditional-field')) || null,
            url: `https://www.finra.org${decodeEntities(link[1])}`,
            publishedAt: null,
            publishedDate: numericDate(plainText(cell('view-field-core-official-dt')), 'mdy')
        };
    });
}

/** ESMA sanctions register (Solr). The sanction's own date is `sn_date`; `sn_modificationDate` is only when ESMA listed it. */
export function parseEsmaSanctions(json) {
    const docs = requireItems(json?.response?.docs, 'ESMA sanctions register');
    return docs.map((d) => {
        const entity = plainText(d.sn_entityName ?? '') || plainText(d.sn_otherEntityName ?? '') || null;
        const date = typeof d.sn_date === 'string' ? d.sn_date.slice(0, 10) : null;
        return {
            id: String(d.id),
            type: 'sanction',
            title: `${d.sn_ncaCodeFullName ?? d.sn_sanctioningNCACode ?? 'NCA'}: ${d.sn_natureFullName ?? 'sanction'} — ${entity ?? '(entity not named)'}`,
            subjects: [entity, plainText(d.sn_otherEntityName ?? '') || null].filter(Boolean),
            text: [plainText(d.sn_text ?? ''), plainText(d.sn_translatedText ?? '')].filter(Boolean).join('\n') || null,
            url: `https://registers.esma.europa.eu/publication/details?core=esma_registers_sanctions&docId=${encodeURIComponent(d.id)}`,
            publishedAt: null,
            publishedDate: date
        };
    });
}

/** ESMA MiCA interim register, non-compliant CASPs (CSV). No id column: the key is authority + names + website. */
export function parseEsmaNcasp(csv) {
    const rows = requireItems(parseCsv(csv), 'ESMA MiCA non-compliant CASPs');
    if (!('ae_commercial_name' in rows[0])) throw new Error('ESMA MiCA non-compliant CASPs: the columns changed');
    return rows.map((r) => {
        const names = [r.ae_lei_name, r.ae_commercial_name].filter(Boolean);
        return {
            id: shortHash([r.ae_competentAuthority, r.ae_lei_name, r.ae_commercial_name, r.ae_website].join('|')),
            type: 'warning',
            title: `${r.ae_competentAuthority}: ${[...new Set(names)].join(' / ') || r.ae_website}`,
            subjects: [...new Set([...names, r.ae_website].filter(Boolean))],
            text: r.ae_reason || null,
            url: 'https://www.esma.europa.eu/esmas-activities/digital-finance-and-innovation/markets-crypto-assets-regulation-mica',
            publishedAt: null,
            publishedDate: numericDate(r.ae_decision_date, 'dmy')
        };
    });
}

/** Central Bank of Ireland unauthorised firms: the complete list is a JS array in the page. */
export function parseCbiUnauthorised(html) {
    const re = /\{\s*"firmName":\s*decodeTitle\("((?:[^"\\]|\\.)*)"\),\s*"country":\s*"((?:[^"\\]|\\.)*)",\s*"warningDate":\s*"([^"]*)"[^}]*?"url":\s*decodeTitle\("((?:[^"\\]|\\.)*)"\)\s*\}/g;
    const out = [...String(html ?? '').matchAll(re)].map(([, name, country, date, url]) => {
        const firm = plainText(name);
        const publishedDate = numericDate(date, 'dmy');
        const link = plainText(url) || null;
        return {
            id: link ?? `${normalisePhrase(firm)}|${publishedDate ?? date}`,
            type: 'warning',
            title: `${firm} (${plainText(country)})`,
            subjects: [firm],
            text: null,
            url: link,
            publishedAt: null,
            publishedDate
        };
    });
    return requireItems(out, 'Central Bank of Ireland unauthorised firms');
}

/** FMA Liechtenstein dynamic search (warnings or news), one page → notices. `release_date` / `date` is local midnight. */
export function parseFmaLi(json, { kind }) {
    const items = requireItems(json?.result, `FMA Liechtenstein ${kind}`);
    return items.map((i) => {
        const seconds = Number(kind === 'warnings' ? i.release_date : i.date);
        const at = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
        const category = String(i.category_label ?? '');
        return {
            id: String(i.element_id),
            type: kind === 'warnings' ? 'warning' : (Number(i.category) === 53 || /enforcement|durchsetzung/i.test(category) ? 'enforcement' : 'news'),
            title: plainText(i.title),
            subjects: kind === 'warnings' ? [plainText(i.title)] : [],
            text: plainText([i.text, i.teaser, i.content].filter(Boolean).join('\n')) || null,
            url: i.detail_url ?? null,
            publishedAt: null,
            publishedDate: at ? dateInZone(at, 'Europe/Vaduz') : null
        };
    });
}

/** CIMA notice pages (warning, enforcement, public notices): complete lists, one `news-item` per notice. */
export function parseCima(html, { type }) {
    const blocks = String(html ?? '').split(/<div class="news-item\b/).slice(1);
    const out = blocks.map((b) => {
        const date = longDate(plainText(b.match(/<div class="date">([\s\S]*?)<\/div>/)?.[1] ?? ''));
        const h2 = b.match(/<h2>([\s\S]*?)<\/h2>/)?.[1] ?? '';
        const title = plainText(h2);
        const href = h2.match(/href="([^"]+)"/)?.[1] ?? b.match(/href="([^"]+\.pdf)"/i)?.[1] ?? null;
        const summary = plainText(b.match(/<p>([\s\S]*?)<\/p>/)?.[1] ?? '');
        if (!title || !href) return null;
        return {
            id: lastPathSegment(href),
            type,
            title,
            subjects: [title],
            text: summary || null,
            url: href,
            publishedAt: null,
            publishedDate: date
        };
    }).filter(Boolean);
    return requireItems(out, `CIMA ${type} notices`);
}

/** MAS Investor Alert List (the complete list). Names are `;`- or `,`-separated aliases. */
export function parseMasAlerts(json) {
    const docs = requireItems(json?.response?.docs, 'MAS Investor Alert List');
    const found = json.response.numFound;
    if (typeof found === 'number' && found > docs.length) {
        throw new Error(`MAS Investor Alert List: ${found} entries but only ${docs.length} returned — raise rows=`);
    }
    return docs.map((d) => {
        const names = String(d.unregulatedpersons_s ?? (d.unregulatedpersons_t ?? []).join(';'))
            .split(/\s[;,]\s|;/).map((s) => s.trim()).filter(Boolean);
        const sites = String(d.website_s ?? '').split(/\s+/).filter(Boolean);
        return {
            id: String(d.id),
            type: 'warning',
            title: `Investor Alert List: ${names.join(' / ') || sites[0] || d.id}`,
            subjects: [...names, ...sites],
            text: null,
            url: 'https://www.mas.gov.sg/investor-alert-list',
            publishedAt: null,
            publishedDate: typeof d.date_dt === 'string' ? d.date_dt.slice(0, 10) : null
        };
    });
}

/** Panama SMV investor alerts (WordPress REST, category 130). `date_gmt` is the post's own UTC time. */
export function parseSmvAlerts(json) {
    const posts = requireItems(json, 'Panama SMV investor alerts');
    return posts.map((p) => {
        const title = plainText(p.title?.rendered ?? '');
        const at = p.date_gmt ? new Date(`${p.date_gmt}Z`) : null;
        const ok = at && Number.isFinite(at.getTime());
        return {
            id: String(p.id),
            type: 'warning',
            title,
            subjects: [title.replace(/^.*?(?:ENTIDAD NO AUTORIZADA|NON[- ]AUTHORIZED ENTITY)\s*[–-]\s*/i, '').trim()].filter(Boolean),
            text: null,
            url: p.link ?? null,
            publishedAt: ok ? isoSeconds(at) : null,
            publishedDate: ok ? dateInZone(at, 'America/Panama') : null
        };
    });
}

/** ASIC bannings and alerts media releases (the complete list). */
export function parseAsicReleases(json) {
    const items = requireItems(json, 'ASIC bannings and alerts');
    return items.map((i) => {
        const at = i.publishedDate ? new Date(i.publishedDate) : null;
        const ok = at && Number.isFinite(at.getTime());
        return {
            id: String(i.documentNumber || i.id),
            type: 'enforcement',
            title: plainText(i.name),
            subjects: [],
            text: plainText(i.metaDescription ?? '') || null,
            url: i.url ? `https://asic.gov.au${i.url}` : null,
            publishedAt: ok ? isoSeconds(at) : null,
            publishedDate: ok ? dateInZone(at, 'Australia/Sydney') : null
        };
    });
}

// ---------------------------------------------------------------------------------------------
// Sources. `window`: `complete` (the whole list every time), `newest` (only the newest N — a gap
// since the last good read is a failure), or `query` (asked per watched name / date window).
// `maxSilentDays`: a readable source whose newest notice is older than this is `stale`.
// `cadence`: `daily` sources run in the daily job; `hourly` ones only with --only (their own PM2 job).
// `knownBlocked`: {since, reason} for a source whose host blocks the server; its block is reported
// as "blocked (known)" and is not a failure (see knownBlock), while a good read is still recorded.
// ---------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const addDays = (isoDay, n) => new Date(Date.parse(`${isoDay}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const mdy = (isoDay) => `${isoDay.slice(5, 7)}/${isoDay.slice(8, 10)}/${isoDay.slice(0, 4)}`;

/** The window a query source looks back over: long enough that a missed day or two loses nothing. */
export const QUERY_WINDOW_DAYS = 30;

/** Names a broker-dealer could carry: legal names with a US corporate form. */
const US_FORMS = new Set(['llc', 'inc', 'corp', 'co', 'lp', 'llp']);

export function brokerCheckNames(names) {
    return names.filter((n) => n.legal && US_FORMS.has(n.canonical.trim().split(' ').at(-1)));
}

export const SOURCES = [
    {
        id: 'sec-trading-suspensions', regulator: 'SEC', jurisdiction: 'US', label: 'SEC trading suspensions',
        url: 'https://www.sec.gov/enforcement-litigation/trading-suspensions/rss', format: 'rss', window: 'newest',
        cadence: 'daily', maxSilentDays: 365, parse: parseSecSuspensions
    },
    {
        id: 'sec-press-releases', regulator: 'SEC', jurisdiction: 'US', label: 'SEC press releases',
        url: 'https://www.sec.gov/news/pressreleases.rss', format: 'rss', window: 'newest',
        cadence: 'daily', maxSilentDays: 21, parse: parseSecPressReleases
    },
    {
        id: 'sec-edgar-fts', regulator: 'SEC', jurisdiction: 'US', label: 'SEC EDGAR filings by watched entities',
        url: 'https://efts.sec.gov/LATEST/search-index', format: 'json', window: 'query', cadence: 'daily', maxSilentDays: null,
        requests: ({ names, today, windowDays }) => names.filter((n) => n.legal).map((n) => ({
            name: n,
            url: `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(`"${n.phrase}"`)}&dateRange=custom`
                + `&startdt=${addDays(today, -(windowDays ?? QUERY_WINDOW_DAYS))}&enddt=${today}`
        })),
        parseEach: (body, req) => parseEdgarSearch(JSON.parse(body), req.name)
    },
    {
        id: 'finra-brokercheck', regulator: 'FINRA', jurisdiction: 'US', label: 'FINRA BrokerCheck disclosures',
        url: 'https://api.brokercheck.finra.org/search/firm', format: 'json', window: 'query', cadence: 'daily', maxSilentDays: null,
        paceMs: 2500, twoStage: true
    },
    {
        id: 'finra-disciplinary', regulator: 'FINRA', jurisdiction: 'US', label: 'FINRA disciplinary actions',
        url: 'https://www.finra.org/rules-guidance/oversight-enforcement/finra-disciplinary-actions', format: 'html',
        window: 'query', cadence: 'daily', maxSilentDays: 30, maxPages: 100, paceMs: 4000,
        pageUrl: ({ today, windowDays }, page) => 'https://www.finra.org/rules-guidance/oversight-enforcement/finra-disciplinary-actions?search=&firms='
            + `&individuals=&field_fda_case_id_txt=&field_core_official_dt%5Bmin%5D=${mdy(addDays(today, -(windowDays ?? QUERY_WINDOW_DAYS)))}`
            + `&field_core_official_dt%5Bmax%5D=${mdy(today)}&field_fda_document_type_tax=All&page=${page}`,
        parsePage: parseFinraDisciplinary, pageSize: 15
    },
    {
        id: 'cftc-enforcement', regulator: 'CFTC', jurisdiction: 'US', label: 'CFTC enforcement press releases',
        url: 'https://www.cftc.gov/RSS/RSSENF/rssenf.xml', format: 'rss', window: 'newest', cadence: 'daily',
        maxSilentDays: 60, parse: parseCftcEnforcement,
        // Measured from the server 2026-10-07: Node's fetch gets a Cloudflare challenge (403) on every
        // cftc.gov path tried (this RSS, the general RSS, /PressRoom/PressReleases incl. its
        // ?field_press_release_types_value=Enforcement listing), whatever the User-Agent; curl passed
        // the HTML listing but got 429 challenges on /RSS/ after a few requests. Read daily until 2026-10-06.
        knownBlocked: {
            since: '2026-10-07',
            reason: 'Cloudflare challenges the server\'s Node fetch on every cftc.gov path (RSS and press-release listing)'
        }
    },
    {
        id: 'fca-news', regulator: 'FCA', jurisdiction: 'UK', label: 'FCA news and press releases',
        url: 'https://www.fca.org.uk/news/rss.xml', format: 'rss', window: 'newest', cadence: 'daily', maxSilentDays: 14, parse: parseFcaNews
    },
    {
        id: 'fca-publications', regulator: 'FCA', jurisdiction: 'UK', label: 'FCA publications (incl. final notices)',
        url: 'https://www.fca.org.uk/publications/rss.xml', format: 'rss', window: 'newest', cadence: 'daily', maxSilentDays: 21,
        parse: parseFcaPublications
    },
    {
        id: 'fca-warnings', regulator: 'FCA', jurisdiction: 'UK', label: 'FCA warnings (unauthorised and clone firms)',
        url: 'https://www.fca.org.uk/news/warnings/rss.xml', format: 'rss', window: 'newest', cadence: 'hourly', maxSilentDays: 7,
        parse: parseFcaWarnings
    },
    {
        id: 'finma-warnings', regulator: 'FINMA', jurisdiction: 'CH', label: 'FINMA warning list',
        url: 'https://www.finma.ch/en/api/search/getresult', format: 'json', window: 'complete', cadence: 'daily', maxSilentDays: 30,
        method: 'POST', body: 'ds=%7B1C6B8731-638C-4003-A93C-A625BF7A6800%7D&Order=4',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
        parse: (body) => parseFinmaWarnings(JSON.parse(body))
    },
    {
        id: 'finma-news', regulator: 'FINMA', jurisdiction: 'CH', label: 'FINMA news and sanctions',
        url: 'https://www.finma.ch/en/rss/news/', format: 'rss', window: 'newest', cadence: 'daily', maxSilentDays: 45, parse: parseFinmaNews
    },
    {
        id: 'bafin-news', regulator: 'BaFin', jurisdiction: 'DE', label: 'BaFin publications (incl. warnings)',
        url: 'https://www.bafin.de/DE/service/rss/_function/rssnewsfeed.xml?nn=150166', format: 'rss', window: 'newest',
        cadence: 'daily', maxSilentDays: 14, parse: parseBafinNews
    },
    {
        id: 'bafin-measures', regulator: 'BaFin', jurisdiction: 'DE', label: 'BaFin measures and sanctions',
        url: 'https://www.bafin.de/DE/service/rss/_function/RSS_Massnahmen.xml?nn=150166', format: 'rss', window: 'newest',
        cadence: 'daily', maxSilentDays: 60, parse: parseBafinMeasures
    },
    {
        id: 'esma-sanctions', regulator: 'ESMA', jurisdiction: 'EU', label: 'ESMA sanctions register (all EU NCAs)',
        url: 'https://registers.esma.europa.eu/solr/esma_registers_sanctions/select?q=*:*&wt=json&rows=100&sort=sn_modificationDate%20desc',
        format: 'json', window: 'complete', cadence: 'daily', maxSilentDays: 180, parse: (body) => parseEsmaSanctions(JSON.parse(body))
    },
    {
        id: 'esma-mica-ncasp', regulator: 'ESMA', jurisdiction: 'EU', label: 'ESMA MiCA register: non-compliant CASPs',
        url: 'https://www.esma.europa.eu/sites/default/files/2024-12/NCASP.csv', format: 'csv', window: 'complete', cadence: 'daily',
        maxSilentDays: 120, parse: parseEsmaNcasp
    },
    {
        id: 'cbi-unauthorised', regulator: 'Central Bank of Ireland', jurisdiction: 'IE', label: 'CBI unauthorised firms',
        url: 'https://www.centralbank.ie/regulation/how-we-regulate/authorisation/unauthorised-firms/search-unauthorised-firms',
        format: 'html', window: 'complete', cadence: 'daily', maxSilentDays: 60, parse: parseCbiUnauthorised
    },
    {
        id: 'fma-li-warnings', regulator: 'FMA Liechtenstein', jurisdiction: 'LI', label: 'FMA Liechtenstein warnings',
        url: 'https://www.fma-li.li/dynamic-search/default/j-warning-search?locale=en', format: 'json', window: 'complete',
        cadence: 'daily', maxSilentDays: 365, maxPages: 10, pageSize: 12,
        pageUrl: (ctx, page) => `https://www.fma-li.li/dynamic-search/default/j-warning-search?locale=en&page=${page + 1}`,
        parsePage: (body) => parseFmaLi(JSON.parse(body), { kind: 'warnings' })
    },
    {
        id: 'fma-li-news', regulator: 'FMA Liechtenstein', jurisdiction: 'LI', label: 'FMA Liechtenstein news and announcements',
        url: 'https://www.fma-li.li/dynamic-search/default/j-news-search?locale=en', format: 'json', window: 'newest',
        cadence: 'daily', maxSilentDays: 60, maxPages: 3, pageSize: 12,
        pageUrl: (ctx, page) => `https://www.fma-li.li/dynamic-search/default/j-news-search?locale=en&page=${page + 1}`,
        parsePage: (body) => parseFmaLi(JSON.parse(body), { kind: 'news' })
    },
    {
        id: 'cima-warnings', regulator: 'CIMA', jurisdiction: 'KY', label: 'CIMA warning notices',
        url: 'https://www.cima.ky/warning-notices', format: 'html', window: 'complete', cadence: 'daily', maxSilentDays: 365,
        parse: (body) => parseCima(body, { type: 'warning' })
    },
    {
        id: 'cima-enforcement', regulator: 'CIMA', jurisdiction: 'KY', label: 'CIMA enforcement notices',
        url: 'https://www.cima.ky/enforcement-notices', format: 'html', window: 'complete', cadence: 'daily', maxSilentDays: 180,
        parse: (body) => parseCima(body, { type: 'enforcement' })
    },
    {
        id: 'cima-public-notices', regulator: 'CIMA', jurisdiction: 'KY', label: 'CIMA general public notices',
        url: 'https://www.cima.ky/general-public-notices', format: 'html', window: 'complete', cadence: 'daily', maxSilentDays: 180,
        parse: (body) => parseCima(body, { type: 'notice' })
    },
    {
        id: 'mas-investor-alerts', regulator: 'MAS', jurisdiction: 'SG', label: 'MAS Investor Alert List',
        url: 'https://www.mas.gov.sg/api/v1/ialsearch?rows=5000&start=0', format: 'json', window: 'complete', cadence: 'daily',
        maxSilentDays: 30, parse: (body) => parseMasAlerts(JSON.parse(body))
    },
    {
        id: 'smv-panama-alerts', regulator: 'SMV Panama', jurisdiction: 'PA', label: 'SMV Panama investor alerts',
        url: 'https://supervalores.gob.pa/wp-json/wp/v2/posts?categories=130&per_page=100&_fields=id,date,date_gmt,modified,link,title',
        format: 'json', window: 'newest', cadence: 'daily', maxSilentDays: 120, parse: (body) => parseSmvAlerts(JSON.parse(body))
    },
    {
        id: 'asic-bannings-alerts', regulator: 'ASIC', jurisdiction: 'AU', label: 'ASIC bannings and alerts releases',
        url: 'https://download.asic.gov.au/asic-nga/data/newsroom/newsroom-bannings-alerts.json', format: 'json', window: 'complete',
        cadence: 'daily', maxSilentDays: 45, parse: (body) => parseAsicReleases(JSON.parse(body))
    }
];

/**
 * Regulators researched and NOT polled, with the reason (verified 2026-09-30 from the laptop and
 * from valhalla/prod). Listed in --help and the stats file so the gap is on record, not forgotten.
 */
export const NOT_FEASIBLE = [
    { regulator: 'JFSC (Jersey)', reason: 'www.jerseyfsc.org answers every path (pages, RSS, sitemap, Umbraco API) with a Cloudflare managed JS challenge' },
    { regulator: 'BVI FSC', reason: 'www.bvifsc.vg answers every path with a Cloudflare block page (403), from laptop and server IPs' },
    { regulator: 'IOSCO I-SCAN', reason: '/i-scan/ is Cloudflare-blocked; the homepage shows only the newest 5 alerts without names, and the IOSCO RSS is stale since 2025-11' },
    { regulator: 'GFSC (Gibraltar)', reason: 'www.fsc.gi answers every path with a Cloudflare challenge' },
    { regulator: 'FMA (New Zealand)', reason: 'www.fma.govt.nz (incl. its warnings CSV and RSS) answers with a Cloudflare challenge' },
    { regulator: 'FCA Warning List search and FS Register', reason: 'the list search is behind a Cloudflare challenge; the Register API needs a free developer key (X-AUTH-EMAIL/X-AUTH-KEY) nobody has requested yet' },
    { regulator: 'SEC investor alerts and bulletins', reason: 'no feed; investor.gov HTML only, and the alerts are generic, rarely naming a firm' },
    { regulator: 'SEC litigation releases and administrative proceedings', reason: 'already polled by the case-law watcher (stocks/watch-caselaw.mjs)' },
    { regulator: 'CySEC', reason: 'no feed; warnings name firms only inside PDFs; no watched party is confirmed to be CySEC-licensed' },
    { regulator: 'ASIC Moneysmart "companies you should not deal with"', reason: 'moneysmart.gov.au is Cloudflare-blocked' }
];

/** Which sources a run polls: daily ones by default; `only` (comma list of ids) overrides, hourly ones included. */
export function selectSources(only = null) {
    if (!only) return SOURCES.filter((s) => s.cadence === 'daily');
    const wanted = String(only).split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = wanted.filter((id) => !SOURCES.some((s) => s.id === id));
    if (unknown.length) throw new Error(`unknown source(s) ${unknown.join(', ')} — known: ${SOURCES.map((s) => s.id).join(', ')}`);
    return SOURCES.filter((s) => wanted.includes(s.id));
}

/**
 * True when a newest-N source no longer reaches back to the last good read: its oldest notice is
 * newer than that read, so anything published in between may have scrolled off unseen.
 */
export function feedGap(notices, lastOkAt) {
    if (!lastOkAt || notices.length === 0) return false;
    const oldest = notices.map((n) => n.publishedAt ?? (n.publishedDate ? `${n.publishedDate}T00:00:00Z` : null))
        .filter(Boolean).sort()[0];
    return Boolean(oldest) && oldest > lastOkAt;
}

// ---------------------------------------------------------------------------------------------
// Comparing against the stored state
// ---------------------------------------------------------------------------------------------

function union(a = [], b = []) {
    return [...new Set([...(a ?? []), ...(b ?? [])])].sort();
}

/** The stored-row key of one match. */
export function matchKey(regulator, noticeId, entity) {
    return `${regulator}|${noticeId}|${entity}`;
}

/** Notice types a regulator only publishes against a firm: a strong match in the subject is a `warning`. */
const ADVERSE_TYPES = new Set(['warning', 'enforcement', 'suspension', 'sanction']);

/**
 * Fold one regulator's matches into the state and decide the events.
 *
 * - `previous` is the stored state, Map matchKey → row (mutated, so a pair seen twice in one run is
 *   new once).
 * - `baseline` is true when this regulator has never been checked: everything is recorded and
 *   nothing is raised, so adding a source is not a flood of old notices.
 * - A `dismissed` row is still recorded (last_seen_at moves) but raises nothing.
 * - Events: one per (issuer, notice), at the strongest reading among its matched names. Severity
 *   `warning` for a strong match in the subject of an adverse notice (a warning, an enforcement
 *   action, a suspension), `caution` for any other strong match, `info` for a weak one.
 */
export function foldMatches(matches, { regulator, previous, baseline, detectedAt, review = new Map() }) {
    const rows = [];
    const perIssuer = new Map();
    for (const { notice, name, strength, matchedIn } of matches) {
        const key = matchKey(regulator.id, notice.id, name.entity);
        const prev = previous.get(key) ?? null;
        const decision = review.get(key) ?? null;
        const row = {
            key,
            regulator: regulator.id,
            noticeId: notice.id,
            entity: name.entity,
            phrase: name.phrase,
            issuers: union(prev?.issuers, name.issuers),
            strength,
            matchedIn,
            noticeType: notice.type ?? null,
            noticeTitle: notice.title ?? null,
            noticeUrl: notice.url ?? null,
            publishedAt: notice.publishedAt ?? null,
            publishedDate: notice.publishedDate ?? null,
            snippet: snippetAround(`${notice.title ?? ''}\n${(notice.subjects ?? []).join('\n')}\n${notice.text ?? ''}`, name),
            firstSeenAt: prev?.firstSeenAt ?? detectedAt,
            lastSeenAt: detectedAt,
            reviewStatus: decision?.status ?? prev?.reviewStatus ?? 'candidate',
            reviewNote: decision?.reason ?? prev?.reviewNote ?? null
        };
        previous.set(key, row);
        rows.push(row);
        if (prev !== null || baseline || row.reviewStatus === 'dismissed') continue;
        for (const issuer of name.issuers) {
            const k = `${issuer}|${notice.id}`;
            const best = perIssuer.get(k);
            const better = !best || STRENGTH_RANK[strength] < STRENGTH_RANK[best.strength]
                || (strength === best.strength && matchedIn === 'subject' && best.matchedIn !== 'subject');
            if (better) perIssuer.set(k, { issuer, notice, strength, matchedIn, phrases: union(best?.phrases, [name.phrase]) });
            else best.phrases = union(best.phrases, [name.phrase]);
        }
    }
    const events = [...perIssuer.values()].map(({ issuer, notice, strength, matchedIn, phrases }) => {
        const severity = strength === 'weak' ? 'info'
            : (matchedIn === 'subject' && ADVERSE_TYPES.has(notice.type) ? 'warning' : 'caution');
        const date = notice.publishedDate ?? 'undated';
        return {
            detectedAt,
            kind: 'regulator-notice',
            subjectType: 'issuer',
            subjectId: issuer,
            field: `notice:${regulator.id}:${notice.id}`,
            before: null,
            after: notice.title ?? notice.id,
            severity,
            summary: `${regulator.label}: ${notice.title ?? notice.id} (${notice.type ?? 'notice'}, ${date}) names`
                + ` "${phrases.join('", "')}" — ${strength === 'strong' ? 'the full legal name' : 'a brand or partial name only'},`
                + ` ${matchedIn === 'subject' ? 'in its subject' : 'in its text'}. For ${issuer}; a candidate for review, not a finding.`,
            evidence: {
                url: notice.url ?? null,
                regulator: regulator.id,
                noticeId: notice.id,
                noticeType: notice.type ?? null,
                publishedDate: notice.publishedDate ?? null,
                phrases,
                strength,
                matchedIn
            }
        };
    });
    return { rows, events };
}

/** Up to ~240 characters of `text` around the first mention of the name, for a reader of the row. */
export function snippetAround(text, name) {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!flat) return null;
    const first = (name.core ?? name.canonical.trim()).split(' ')[0];
    const at = flat.toLowerCase().indexOf(first);
    const start = Math.max(0, (at < 0 ? 0 : at) - 100);
    return `${start > 0 ? '…' : ''}${flat.slice(start, start + 240)}${start + 240 < flat.length ? '…' : ''}`;
}

/**
 * The verdict on one source this run, against its stored check row: `failed` when it could not be
 * read; `gap` when a newest-N feed no longer reaches back to the last good read; `stale` when it
 * was read but its newest notice is older than the source's `maxSilentDays` (a feed that stopped
 * publishing reads exactly like one with nothing to report); else `ok`. Anything but `ok` fails the run.
 * `lastOkAt` moves on a gap or stale read (the source WAS read), never on a failed one.
 * `consecutiveFailures` carries across runs, so a source that fails every day is visibly so.
 */
export function checkVerdict(source, { prev = null, error = null, notices = [], matches = 0, runAt }) {
    const newest = notices.map((n) => n.publishedAt ?? (n.publishedDate ? `${n.publishedDate}T00:00:00Z` : null))
        .filter(Boolean).sort().at(-1) ?? null;
    let status = 'ok';
    let lastError = null;
    if (error) {
        status = 'failed';
        lastError = String(error).slice(0, 500);
    } else if (source.window === 'newest' && feedGap(notices, prev?.lastOkAt ?? null)) {
        status = 'gap';
        lastError = `the feed's oldest notice is newer than the last good read (${prev.lastOkAt}) — notices in between may have been missed`;
    } else if (source.maxSilentDays && !newest) {
        status = 'stale';
        lastError = 'no dated notice read';
    } else if (source.maxSilentDays) {
        const ageDays = (Date.parse(runAt) - Date.parse(newest)) / 86_400_000;
        if (ageDays > source.maxSilentDays) {
            status = 'stale';
            lastError = `newest notice ${newest.slice(0, 10)} is ${Math.floor(ageDays)} days old (expected within ${source.maxSilentDays})`;
        }
    }
    const newestEver = [prev?.newestPublishedAt, newest].filter(Boolean).sort().at(-1) ?? null;
    return {
        regulator: source.id,
        label: source.label,
        url: source.url,
        runAt,
        status,
        lastError,
        lastOkAt: status === 'failed' ? (prev?.lastOkAt ?? null) : runAt,
        consecutiveFailures: status === 'ok' ? 0 : (prev?.consecutiveFailures ?? 0) + 1,
        noticesRead: error ? null : notices.length,
        matches: error ? null : matches,
        newestPublishedAt: newestEver
    };
}

/** A read that a host's bot wall refused: a 403, or any status carrying the Cloudflare challenge marker. */
const BLOCK_RE = /HTTP (?:403\b|\d{3} \(Cloudflare challenge\/block\))/;

/**
 * The `knownBlocked` record when `error` is the block a source is known for, else null. Only the
 * block itself is excused: any other failure of that source (a timeout, a 500, a parse error, a
 * gap after it reads again) is still a failure.
 */
export function knownBlock(source, error) {
    if (!source?.knownBlocked || !error) return null;
    return BLOCK_RE.test(String(error)) ? source.knownBlocked : null;
}

/**
 * The run's verdict from the per-source results {status, consecutiveFailures, lastError, knownBlocked}.
 * Status `blocked` (a known block) is listed apart and is neither a failure nor ok; `watchStatus`
 * is `failed` when every polled source failed, `partial` when some did, else `ok`.
 */
export function runVerdict(results) {
    const entries = Object.entries(results ?? {});
    const failures = [];
    const blocked = [];
    for (const [id, r] of entries) {
        if (r.status === 'blocked') {
            blocked.push(`${id}: blocked (known since ${r.knownBlocked?.since ?? '?'}${r.consecutiveFailures > 1 ? `, ${r.consecutiveFailures} runs in a row` : ''}) — ${r.knownBlocked?.reason ?? r.lastError ?? '?'}`);
        } else if (r.status !== 'ok') {
            failures.push(`${id}: ${r.status}${r.consecutiveFailures > 1 ? ` (${r.consecutiveFailures} runs in a row)` : ''} — ${r.lastError ?? '?'}`);
        }
    }
    const polled = entries.length - blocked.length;
    const watchStatus = failures.length === 0 ? 'ok' : (failures.length === polled ? 'failed' : 'partial');
    return { failures, blocked, watchStatus };
}

// ---------------------------------------------------------------------------------------------
// SQL (psql over stdin, like every other loader here)
// ---------------------------------------------------------------------------------------------

/** Every stored match, as one JSON array on one line (read with psql -t -A). */
export function buildReadMatchesQuery() {
    return "SELECT coalesce(jsonb_agg(jsonb_build_object(\n"
        + "  'regulator', regulator, 'noticeId', notice_id, 'entity', entity, 'phrase', phrase,\n"
        + "  'issuers', to_jsonb(issuers), 'strength', strength, 'matchedIn', matched_in,\n"
        + "  'firstSeenAt', first_seen_at, 'lastSeenAt', last_seen_at, 'reviewStatus', review_status,\n"
        + "  'reviewNote', review_note) ORDER BY regulator, notice_id, entity), '[]'::jsonb)\n"
        + '  FROM sonar.regulator_notice_match;\n';
}

/** Every source's check row. */
export function buildReadChecksQuery() {
    return "SELECT coalesce(jsonb_agg(jsonb_build_object('regulator', regulator, 'firstRunAt', first_run_at,\n"
        + "  'lastRunAt', last_run_at, 'lastOkAt', last_ok_at, 'lastStatus', last_status,\n"
        + "  'consecutiveFailures', consecutive_failures, 'newestPublishedAt', newest_published_at)\n"
        + "  ORDER BY regulator), '[]'::jsonb) FROM sonar.regulator_check;\n";
}

/** A stored timestamp → ISO seconds. Accepts jsonb's "…T05:37:00+00:00" and psql text's "… 05:37:00+00". */
const isoOrNull = (v) => {
    if (typeof v !== 'string' || !v) return null;
    const d = new Date(v.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
    if (!Number.isFinite(d.getTime())) throw new Error(`unparseable stored timestamp ${JSON.stringify(v)}`);
    return isoSeconds(d);
};

/** Stored rows → the in-memory shapes (ISO timestamps, so string order is time order). */
export function normaliseStoredMatches(rows) {
    return (Array.isArray(rows) ? rows : []).map((r) => ({
        ...r,
        key: matchKey(r.regulator, r.noticeId, r.entity),
        issuers: Array.isArray(r.issuers) ? r.issuers : [],
        firstSeenAt: isoOrNull(r.firstSeenAt),
        lastSeenAt: isoOrNull(r.lastSeenAt)
    }));
}

export function normaliseStoredChecks(rows) {
    return (Array.isArray(rows) ? rows : []).map((r) => ({
        ...r,
        firstRunAt: isoOrNull(r.firstRunAt),
        lastRunAt: isoOrNull(r.lastRunAt),
        lastOkAt: isoOrNull(r.lastOkAt),
        newestPublishedAt: isoOrNull(r.newestPublishedAt),
        consecutiveFailures: Number(r.consecutiveFailures ?? 0)
    }));
}

/**
 * Upsert match rows, idempotent on (regulator, notice_id, entity). `first_seen_at` is never
 * overwritten; the IS DISTINCT FROM guard keeps an unchanged row's updated_at.
 */
export function buildMatchUpsertSql(rows, { tag = 'sonar' } = {}) {
    const sql = `WITH doc AS (SELECT ${jsonbLiteral({ rows }, tag)} AS d),\n`
        + "     src AS (SELECT x.r FROM doc, jsonb_array_elements(d->'rows') AS x(r))\n"
        + 'INSERT INTO sonar.regulator_notice_match AS m\n'
        + '       (regulator, notice_id, entity, phrase, issuers, strength, matched_in, notice_type, notice_title,\n'
        + '        notice_url, published_at, published_date, snippet, first_seen_at, last_seen_at, review_status,\n'
        + '        review_note)\n'
        + "SELECT r->>'regulator', r->>'noticeId', r->>'entity', r->>'phrase',\n"
        + "       ARRAY(SELECT jsonb_array_elements_text(coalesce(r->'issuers', '[]'::jsonb)) ORDER BY 1),\n"
        + "       r->>'strength', r->>'matchedIn', r->>'noticeType', r->>'noticeTitle', r->>'noticeUrl',\n"
        + "       (r->>'publishedAt')::timestamptz, (r->>'publishedDate')::date, r->>'snippet',\n"
        + "       (r->>'firstSeenAt')::timestamptz, (r->>'lastSeenAt')::timestamptz, r->>'reviewStatus', r->>'reviewNote'\n"
        + '  FROM src\n'
        + 'ON CONFLICT (regulator, notice_id, entity) DO UPDATE SET\n'
        + '       phrase = EXCLUDED.phrase, issuers = EXCLUDED.issuers, strength = EXCLUDED.strength,\n'
        + '       matched_in = EXCLUDED.matched_in, notice_type = EXCLUDED.notice_type,\n'
        + '       notice_title = EXCLUDED.notice_title, notice_url = EXCLUDED.notice_url,\n'
        + '       published_at = EXCLUDED.published_at, published_date = EXCLUDED.published_date,\n'
        + '       snippet = EXCLUDED.snippet, last_seen_at = EXCLUDED.last_seen_at,\n'
        + '       review_status = EXCLUDED.review_status, review_note = EXCLUDED.review_note, updated_at = now()\n'
        + ' WHERE (m.phrase, m.issuers, m.strength, m.matched_in, m.notice_type, m.notice_title, m.notice_url,\n'
        + '        m.published_at, m.published_date, m.snippet, m.last_seen_at, m.review_status, m.review_note)\n'
        + '       IS DISTINCT FROM\n'
        + '       (EXCLUDED.phrase, EXCLUDED.issuers, EXCLUDED.strength, EXCLUDED.matched_in, EXCLUDED.notice_type,\n'
        + '        EXCLUDED.notice_title, EXCLUDED.notice_url, EXCLUDED.published_at, EXCLUDED.published_date,\n'
        + '        EXCLUDED.snippet, EXCLUDED.last_seen_at, EXCLUDED.review_status, EXCLUDED.review_note);\n';
    return { table: 'sonar.regulator_notice_match', rows: rows.length, sql };
}

/** Record one source's check: the first run is kept, everything else moves. */
export function buildCheckSql(checks, { tag = 'sonar' } = {}) {
    const sql = `WITH doc AS (SELECT ${jsonbLiteral({ checks }, tag)} AS d),\n`
        + "     src AS (SELECT x.r FROM doc, jsonb_array_elements(d->'checks') AS x(r))\n"
        + 'INSERT INTO sonar.regulator_check AS c\n'
        + '       (regulator, label, url, first_run_at, last_run_at, last_ok_at, last_status, last_error,\n'
        + '        consecutive_failures, notices_read, matches, newest_published_at)\n'
        + "SELECT r->>'regulator', r->>'label', r->>'url', (r->>'runAt')::timestamptz, (r->>'runAt')::timestamptz,\n"
        + "       (r->>'lastOkAt')::timestamptz, r->>'status', r->>'lastError', (r->>'consecutiveFailures')::int,\n"
        + "       (r->>'noticesRead')::int, (r->>'matches')::int, (r->>'newestPublishedAt')::timestamptz\n"
        + '  FROM src\n'
        + 'ON CONFLICT (regulator) DO UPDATE SET\n'
        + '       label = EXCLUDED.label, url = EXCLUDED.url, last_run_at = EXCLUDED.last_run_at,\n'
        + '       last_ok_at = EXCLUDED.last_ok_at, last_status = EXCLUDED.last_status, last_error = EXCLUDED.last_error,\n'
        + '       consecutive_failures = EXCLUDED.consecutive_failures, notices_read = EXCLUDED.notices_read,\n'
        + '       matches = EXCLUDED.matches, newest_published_at = EXCLUDED.newest_published_at, updated_at = now();\n';
    return { table: 'sonar.regulator_check', rows: checks.length, sql };
}

// ---------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------

/** One Telegram message per run: counts, the first few new matches, the failing sources. Plain text. */
export function formatTelegramSummary({ events, failures, checks, noticesRead, durationMs, blocked = [] }) {
    const lines = [`RWA Sonar regulator watch: ${events.length} new match event(s), ${failures.length} failure(s)`
        + `${blocked.length ? `, ${blocked.length} known-blocked source(s)` : ''}`];
    lines.push(`${checks} source(s) · ${noticesRead} notice(s) read · ${(durationMs / 1000).toFixed(0)} s`);
    const rank = { warning: 0, caution: 1, info: 2 };
    const top = [...events].sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9)).slice(0, 8);
    for (const e of top) lines.push(`• [${e.severity}] ${e.summary.slice(0, 220)}`);
    if (events.length > top.length) lines.push(`… and ${events.length - top.length} more in sonar.change_event (kind regulator-notice)`);
    for (const f of failures.slice(0, 6)) lines.push(`✗ ${f.slice(0, 200)}`);
    if (failures.length > 6) lines.push(`… and ${failures.length - 6} more failure(s)`);
    // Known blocks are a reminder, not a failure: one line each so they are not forgotten.
    for (const b of blocked.slice(0, 3)) lines.push(`⊘ ${b.slice(0, 200)}`);
    lines.push('Nothing is marked warned or sanctioned automatically — each event is for review.');
    return lines.join('\n');
}
