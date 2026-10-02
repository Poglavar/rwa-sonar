// The legal-entity watcher's decisions (stocks/watch-entities.mjs), kept pure so they are unit
// tested without a network or a database (stocks/entities.test.js): which legal entities a tokenized
// stock depends on (derived from the dossiers through the case-law watcher's own name extraction),
// how an entity is matched to an LEI or a national register number, how a GLEIF, Zefix, Companies
// House or Gazette payload becomes one comparable state, which differences between two states are
// findings and how severe they are, and the SQL that stores it all.
//
// A tokenized share is only as good as the SPV that issued it and the custodian holding the share:
// an LEI that lapses, an entity that goes INACTIVE, a Swiss firm that enters liquidation or a UK
// company with a winding-up order is a finding about every token in that chain.

import { createHash } from 'node:crypto';

import { jsonbLiteral } from './db-load.mjs';
import {
    deriveQueries, dossierText, extractLegalEntities, hasLegalSuffix, normalisePhrase, saysUnrelated
} from './caselaw.mjs';

// ---------------------------------------------------------------------------------------------
// Names and jurisdictions
// ---------------------------------------------------------------------------------------------

const SUFFIX_CANON = new Map([
    ['limited', 'ltd'], ['incorporated', 'inc'], ['corporation', 'corp'], ['company', 'co'],
    ['aktiengesellschaft', 'ag'], ['plc', 'plc']
]);

/**
 * A legal name reduced to what registers compare: normalised like the case-law phrases, runs of
 * single letters joined ("L.L.C." → "llc", "S.A." → "sa"), corporate forms canonical ("Limited" ≡
 * "Ltd", "Company" ≡ "Co"), a leading "the" dropped. "BACKED ASSETS (JE) LIMITED" and "Backed Assets
 * (JE) Limited" are the same key; "Payward Ventures, Inc." and "Payward, Inc." are not.
 */
export function legalNameKey(name) {
    const merged = [];
    let letters = '';
    for (const t of [...normalisePhrase(name).split(' ').filter(Boolean), null]) {
        if (t !== null && t.length === 1) {
            letters += t;
            continue;
        }
        if (letters) merged.push(letters);
        letters = '';
        if (t !== null) merged.push(t);
    }
    const words = merged.map((w) => SUFFIX_CANON.get(w) ?? w);
    if (words[0] === 'the' && words.length > 1) words.shift();
    return words.join(' ');
}

/** ISO-3166 style codes for the places the dossiers write; US states other than Delaware are just US. */
const JURISDICTION_PATTERNS = [
    [/\bjersey\b|\(je\)/i, 'JE'],
    [/british virgin|\bbvi\b/i, 'VG'],
    [/cayman/i, 'KY'],
    [/switzerland|\bswiss\b|\bzug\b|zurich|zürich|\(ch\)/i, 'CH'],
    [/united kingdom|\bengland\b|\bwales\b|\bscotland\b|\buk\b|\(gb\)/i, 'GB'],
    [/ireland/i, 'IE'],
    [/liechtenstein/i, 'LI'],
    [/germany|deutschland/i, 'DE'],
    [/marshall islands/i, 'MH'],
    [/panama/i, 'PA'],
    [/new zealand/i, 'NZ'],
    [/australia/i, 'AU'],
    [/\buae\b|dubai|abu dhabi|united arab emirates/i, 'AE'],
    [/comoros|anjouan/i, 'KM'],
    [/gibraltar/i, 'GI'],
    [/delaware/i, 'US-DE'],
    [/united states|\busa\b|\bu\.s\.|\bus\b|california|new york|texas|wyoming|north carolina|south dakota|new hampshire|connecticut|florida|nevada/i, 'US']
];

/**
 * The jurisdiction a dossier's free text names, as a code, or null when it names none or several
 * that disagree ("British Virgin Islands / Delaware / UAE / Australia" is a group, not an entity).
 * US + Delaware is Delaware.
 */
export function jurisdictionCode(text) {
    const raw = String(text ?? '');
    if (!raw.trim()) return null;
    const codes = new Set();
    for (const [re, code] of JURISDICTION_PATTERNS) if (re.test(raw)) codes.add(code);
    if (codes.has('US-DE')) codes.delete('US');
    return codes.size === 1 ? [...codes][0] : null;
}

/** True when a register's jurisdiction does not contradict the dossier's (unknown on either side is no contradiction). */
export function jurisdictionConsistent(expected, actual) {
    if (!expected || !actual) return true;
    if (expected === actual) return true;
    if (expected === 'US') return actual.startsWith('US');
    return false;
}

// ---------------------------------------------------------------------------------------------
// Which entities to watch
// ---------------------------------------------------------------------------------------------

/** Dossier fields, beyond what the case-law derivation reads, whose legal entities are in the trust chain. */
export const EXTRA_ENTITY_FIELDS = [
    ['underlyingCustodian', 'underlying-custodian'],
    ['securityInterest', 'security-interest']
];

function partyRecords(dossier) {
    const out = [];
    for (const list of Object.values(dossier?.parties ?? {})) {
        for (const p of Array.isArray(list) ? list : []) if (typeof p?.name === 'string') out.push(p);
    }
    return out;
}

/**
 * The first record whose name is the entity's, or a prefix of it of at least two words ("Alpaca
 * Securities" → "Alpaca Securities LLC"). A one-word brand ("Bullish") is not a prefix match: the
 * group's Cayman parent says nothing about where its US transfer agent is incorporated.
 */
function recordFor(key, records) {
    const exact = records.find((r) => legalNameKey(r.name) === key && r.jurisdiction);
    if (exact) return exact;
    return records.find((r) => {
        const k = legalNameKey(String(r.name).replace(/\([^)]*\)/g, ' '));
        return k && k.includes(' ') && key.startsWith(`${k} `) && r.jurisdiction;
    }) ?? null;
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A jurisdiction the dossier writes in parentheses right after the name: "Trek Labs, Inc. (Delaware)". */
function jurisdictionAfterName(name, text) {
    const re = new RegExp(`${escapeRegExp(name)}\\s*\\(([^)]{2,40})\\)`, 'g');
    for (const m of text.matchAll(re)) {
        const code = jurisdictionCode(m[1]);
        if (code) return { code, from: `text: (${m[1]})` };
    }
    return null;
}

/**
 * A folded pair that is one entity written two ways: "Equiniti Trust Company" and "Equiniti Trust
 * Company, LLC". Only a name ending in "Company" is completed this way — "Trek Labs Ltd" and "Trek
 * Labs Ltd FZE" are two companies in two countries.
 */
export function completesName(shorter, longer) {
    const a = legalNameKey(shorter);
    const b = legalNameKey(longer);
    return /\bco$/.test(a) && new RegExp(`^${escapeRegExp(a)} (llc|inc|ltd)$`).test(b);
}

/**
 * The legal entities to watch, derived from the dossiers. The case-law watcher's derivation
 * (lib/caselaw.mjs deriveQueries: every entity in `issuingEntity`, every token issuer,
 * tokenization provider, transfer agent, custodian, parent and security agent expanded to the
 * legal names the dossier spells out, with its stoplist) is reused as is; a folded phrase's
 * longer names (`covers`) are entities of their own here. Added: the legal entities named in
 * `underlyingCustodian` and `securityInterest`. Issuer brands with no corporate suffix ("xStocks")
 * are not entities and are dropped. Each entity carries a jurisdiction code where a dossier party
 * or canonical-parties.json states one, or the name carries one ("(JE)", "(BVI)").
 */
export function deriveEntities(dossiers, { canonical = [] } = {}) {
    const byKey = new Map();
    const dropped = [];
    const add = (name, issuer, role, from) => {
        const key = legalNameKey(name);
        if (!key) return;
        if (!byKey.has(key)) byKey.set(key, { key, name: name.trim(), legalName: hasLegalSuffix(name), issuers: [], roles: [], from: [] });
        const e = byKey.get(key);
        // Prefer the spelling with a corporate suffix, then the longer one.
        if (!e.legalName && hasLegalSuffix(name)) Object.assign(e, { name: name.trim(), legalName: true });
        if (!e.issuers.includes(issuer)) e.issuers.push(issuer);
        if (!e.roles.includes(role)) e.roles.push(role);
        if (!e.from.includes(from)) e.from.push(from);
    };

    const { queries } = deriveQueries(dossiers);
    for (const q of queries) {
        if (q.kind !== 'phrase') continue;
        const covers = q.covers ?? [];
        for (const name of [q.phrase, ...covers]) {
            if (name === q.phrase && covers.some((c) => completesName(name, c))) continue;
            const origins = q.origins.filter((o) => o.via === undefined || o.via === name || name === q.phrase);
            if (!hasLegalSuffix(name) && origins.every((o) => o.role === 'issuer-brand')) {
                for (const issuer of q.issuers) dropped.push({ name, issuer, reason: 'issuer brand, not a legal name' });
                continue;
            }
            for (const o of origins) {
                if (o.role === 'issuer-brand' && !hasLegalSuffix(name)) continue;
                add(name, o.issuer, o.role, o.from);
            }
        }
    }
    for (const { slug, dossier } of dossiers) {
        for (const [field, role] of EXTRA_ENTITY_FIELDS) {
            const text = typeof dossier?.[field] === 'string' ? dossier[field] : '';
            for (const { name, index } of extractLegalEntities(text)) {
                if (saysUnrelated(text, index)) continue;
                add(name, slug, role, field);
            }
        }
    }
    // A bare name the dossier also spells out in full ("Backpack Securities" → "Backpack Securities
    // Global Limited") is that entity, not a second one.
    for (const e of [...byKey.values()]) {
        if (e.legalName) continue;
        const fuller = [...byKey.values()].find((o) => o !== e && o.legalName && o.key.startsWith(`${e.key} `)
            && e.issuers.every((i) => o.issuers.includes(i)));
        if (!fuller) continue;
        for (const r of e.roles) if (!fuller.roles.includes(r)) fuller.roles.push(r);
        for (const f of e.from) if (!fuller.from.includes(f)) fuller.from.push(f);
        byKey.delete(e.key);
    }

    const records = dossiers.flatMap(({ dossier }) => partyRecords(dossier));
    const texts = new Map(dossiers.map(({ slug, dossier }) => [slug, dossierText(dossier)]));
    const fromRecord = (r, label) => {
        const code = r ? jurisdictionCode(r.jurisdiction) : null;
        return code ? { code, from: `${label}: ${r.jurisdiction}` } : null;
    };
    const entities = [...byKey.values()].map((e) => {
        const inName = jurisdictionCode((e.name.match(/\(([A-Z]{2,4})\)/) ?? [])[0] ?? '');
        // Precedence: the name itself, the dossier's own "(Delaware)" after the name, the party
        // record, canonical-parties.json.
        const pick = [
            inName ? { code: inName, from: 'name' } : null,
            ...e.issuers.map((i) => jurisdictionAfterName(e.name, texts.get(i) ?? '')),
            fromRecord(recordFor(e.key, records), 'party'),
            fromRecord(recordFor(e.key, canonical), 'canonical-parties')
        ].find(Boolean) ?? null;
        return {
            ...e,
            issuers: [...e.issuers].sort(),
            roles: [...e.roles].sort(),
            from: [...e.from].sort(),
            jurisdiction: pick?.code ?? null,
            jurisdictionFrom: pick?.from ?? null
        };
    }).sort((a, b) => a.key.localeCompare(b.key));
    return { entities, dropped };
}

// ---------------------------------------------------------------------------------------------
// Sources: URLs
// ---------------------------------------------------------------------------------------------

export const GLEIF_API = 'https://api.gleif.org/api/v1';
export const ZEFIX_API = 'https://www.zefix.ch/ZefixREST/api/v1';
export const COMPANIES_HOUSE_API = 'https://api.company-information.service.gov.uk';
export const GAZETTE = 'https://www.thegazette.co.uk';

/** GLEIF's register authority code for Companies House (England & Wales, Scotland, Northern Ireland). */
export const RA_COMPANIES_HOUSE = 'RA000585';
/** GLEIF's register authority code for the Jersey Financial Services Commission companies registry. */
export const RA_JERSEY = 'RA000414';

/**
 * The names to search GLEIF under, in order: the name as written, then its distinctive body without
 * the corporate form ("Ankura Trust Company, LLC" → "Ankura Trust Company"). GLEIF's legalName filter
 * is a token search, so "…, LLC" ranks every entity called "LLC" first (measured 2026-09-30); the
 * body finds the record, and the exact-name test still needs the full name to match.
 */
export function gleifSearchNames(name) {
    const words = String(name ?? '').trim().split(/\s+/);
    while (words.length > 1 && hasLegalSuffix(words.slice(-2).join(' '))) words.pop();
    const body = words.join(' ').replace(/[,;]+$/, '').trim();
    return [...new Set([String(name).trim(), body].filter(Boolean))];
}

export function gleifSearchUrl(name) {
    return `${GLEIF_API}/lei-records?filter[entity.legalName]=${encodeURIComponent(name)}&page[size]=20`;
}
export function gleifRecordUrl(lei) {
    return `${GLEIF_API}/lei-records/${encodeURIComponent(lei)}`;
}
export function gleifParentUrl(lei) {
    return `${GLEIF_API}/lei-records/${encodeURIComponent(lei)}/direct-parent`;
}
export function zefixFirmUrl(ehraid) {
    return `${ZEFIX_API}/firm/${encodeURIComponent(ehraid)}.json`;
}
export const ZEFIX_SEARCH_URL = `${ZEFIX_API}/firm/search.json`;
export function zefixSearchBody(nameOrUid) {
    return JSON.stringify({ name: nameOrUid, languageKey: 'en', maxEntries: 20, deletedFirms: true });
}
export function companiesHouseProfileUrl(number) {
    return `${COMPANIES_HOUSE_API}/company/${encodeURIComponent(number)}`;
}
export function companiesHouseOfficersUrl(number) {
    return `${COMPANIES_HOUSE_API}/company/${encodeURIComponent(number)}/officers?items_per_page=100`;
}
export function companiesHouseSearchUrl(name) {
    return `${COMPANIES_HOUSE_API}/search/companies?q=${encodeURIComponent(name)}&items_per_page=20`;
}
/**
 * The Gazette's structured insolvency notices, searched by the exact legal name. `company-number`
 * is NOT a filter the search honours (measured 2026-09-30: it returns every notice), and the
 * all-notices search also returns scanned Companies House supplement pages that list thousands of
 * companies, so the insolvency category is searched by name and each hit is confirmed by the
 * company number in its linked data.
 */
export function gazetteSearchUrl(name) {
    return `${GAZETTE}/insolvency/notice/data.json?text=${encodeURIComponent(`"${name}"`)}&results-page-size=100`;
}
export function gazetteNoticeDataUrl(noticeId) {
    return `${GAZETTE}/notice/${encodeURIComponent(noticeId)}/data.jsonld`;
}

// ---------------------------------------------------------------------------------------------
// Sources: parsing
// ---------------------------------------------------------------------------------------------

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** One GLEIF lei-record (the `data` object) → the fields this watcher compares. */
export function parseGleifRecord(record) {
    if (!record || typeof record !== 'object' || !record.attributes?.entity) throw new Error('not a GLEIF lei-record');
    const { entity, registration } = record.attributes;
    const successors = [
        ...(entity.successorEntity?.lei || entity.successorEntity?.name ? [entity.successorEntity] : []),
        ...(Array.isArray(entity.successorEntities) ? entity.successorEntities : [])
    ];
    const parentLink = record.relationships?.['direct-parent']?.links ?? {};
    return {
        lei: record.id ?? record.attributes.lei,
        legalName: str(entity.legalName?.name),
        otherNames: (entity.otherNames ?? []).map((n) => str(n?.name)).filter(Boolean),
        jurisdiction: str(entity.jurisdiction),
        country: str(entity.legalAddress?.country),
        legalForm: str(entity.legalForm?.id) ?? str(entity.legalForm?.other),
        entityStatus: str(entity.status),
        registrationStatus: str(registration?.status),
        expirationDate: str(entity.expiration?.date),
        expirationReason: str(entity.expiration?.reason),
        successors: successors.map((s) => ({ lei: str(s.lei), name: str(s.name) }))
            .filter((s) => s.lei || s.name)
            .sort((a, b) => `${a.lei}|${a.name}`.localeCompare(`${b.lei}|${b.name}`)),
        registeredAt: str(entity.registeredAt?.id),
        registeredAs: str(entity.registeredAs),
        creationDate: str(entity.creationDate),
        lastUpdateDate: str(registration?.lastUpdateDate),
        nextRenewalDate: str(registration?.nextRenewalDate),
        corroborationLevel: str(registration?.corroborationLevel),
        // A reported parent is linked as `lei-record` (measured 2026-09-30); a declined one as
        // `reporting-exception`.
        hasDirectParent: Boolean(parentLink['lei-record'] || parentLink.related),
        parentException: Boolean(parentLink['reporting-exception'])
    };
}

/** A GLEIF reporting exception (why no parent is reported) → its reason, e.g. NON_CONSOLIDATING. */
export function parseGleifReportingException(json) {
    const a = json?.data?.attributes;
    if (!a) throw new Error('not a GLEIF reporting exception');
    return str(a.reason);
}

export function gleifParentExceptionUrl(lei) {
    return `${GLEIF_API}/lei-records/${encodeURIComponent(lei)}/direct-parent-reporting-exception`;
}

/** A GLEIF search response → parsed records. */
export function parseGleifSearch(json) {
    if (!json || !Array.isArray(json.data)) throw new Error('GLEIF search: no data[] in the response');
    return json.data.map(parseGleifRecord);
}

/** A Zefix firm (search list item or detail) → the fields this watcher compares. Newest publications first. */
export function parseZefixFirm(firm) {
    if (!firm || typeof firm !== 'object' || !firm.uid) throw new Error('not a Zefix firm');
    const pubs = (Array.isArray(firm.shabPub) ? firm.shabPub : [])
        .map((p) => ({
            id: String(p.shabId),
            date: str(p.shabDate),
            types: (p.mutationTypes ?? []).map((t) => t.key).filter(Boolean).sort()
        }))
        .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.id.localeCompare(a.id));
    const names = (list) => (Array.isArray(list) ? list : []).map((f) => str(f?.name)).filter(Boolean).sort();
    return {
        uid: firm.uid,
        ehraid: firm.ehraid ?? null,
        name: str(firm.name),
        translations: Array.isArray(firm.translation) ? firm.translation.filter(Boolean) : [],
        status: str(firm.status),
        legalSeat: str(firm.legalSeat),
        legalFormId: firm.legalFormId ?? null,
        deleteDate: str(firm.deleteDate),
        shabDate: str(firm.shabDate),
        wasTakenOverBy: names(firm.wasTakenOverBy),
        hasTakenOver: names(firm.hasTakenOver),
        publications: pubs,
        excerptUrl: str(firm.cantonalExcerptWeb)
    };
}

/** Companies House company profile → the fields this watcher compares. */
export function parseCompaniesHouseProfile(json) {
    if (!json || typeof json !== 'object' || !json.company_number) throw new Error('not a Companies House company profile');
    return {
        companyNumber: json.company_number,
        name: str(json.company_name),
        status: str(json.company_status),
        statusDetail: str(json.company_status_detail),
        hasInsolvencyHistory: json.has_insolvency_history === true,
        dateOfCessation: str(json.date_of_cessation),
        previousNames: (json.previous_company_names ?? []).map((n) => str(n?.name)).filter(Boolean).sort(),
        jurisdiction: str(json.jurisdiction)
    };
}

/** Companies House officers list → the active officers, as "NAME (role)", sorted. */
export function parseCompaniesHouseOfficers(json) {
    if (!json || !Array.isArray(json.items)) throw new Error('Companies House officers: no items[]');
    return json.items.filter((o) => !o.resigned_on)
        .map((o) => `${String(o.name ?? '').trim()} (${o.officer_role ?? '?'})`)
        .sort();
}

/** A Gazette notice search (JSON feed) → notices: {id, code, category, published, title, url}. */
export function parseGazetteSearch(json) {
    if (!json || typeof json !== 'object' || !('f:total' in json)) throw new Error('Gazette search: not a notice feed');
    return [].concat(json.entry ?? []).map((e) => {
        const id = String(e.id ?? '').match(/\/notice\/(\d+)$/)?.[1] ?? null;
        return {
            id,
            code: e['f:notice-code'] ? String(e['f:notice-code']) : null,
            category: str(e.category?.['@term']),
            published: str(e.published),
            title: String(e.title ?? '').replace(/\/n/g, ' ').replace(/\s+/g, ' ').trim(),
            url: id ? `${GAZETTE}/notice/${id}` : null
        };
    }).filter((n) => n.id);
}

/** The company numbers and names a Gazette notice's linked data names. */
export function parseGazetteNoticeData(json) {
    const graph = Array.isArray(json?.['@graph']) ? json['@graph'] : [];
    const companies = graph.filter((n) => n.companyNumber || String(n['@type'] ?? '').includes('Company'));
    return {
        companyNumbers: [...new Set(companies.map((c) => str(c.companyNumber)).filter(Boolean))].sort(),
        names: [...new Set(companies.map((c) => str(c['gazorg:name'])?.replace(/\s+/g, ' ')).filter(Boolean))].sort()
    };
}

/** Companies House numbers are 8 characters; registers and GLEIF sometimes drop the leading zeros. */
export function padCompanyNumber(n) {
    const s = String(n ?? '').trim().toUpperCase();
    return /^\d{1,7}$/.test(s) ? s.padStart(8, '0') : s;
}

// ---------------------------------------------------------------------------------------------
// Resolution: entity → LEI and national register ids
// ---------------------------------------------------------------------------------------------

const DEAD_REGISTRATIONS = new Set(['ANNULLED', 'DUPLICATE']);

function candidateSummary(r) {
    return { lei: r.lei, name: r.legalName, jurisdiction: r.jurisdiction, entityStatus: r.entityStatus, registrationStatus: r.registrationStatus };
}

/**
 * Match an entity against GLEIF search results. Only an EXACT legal-name match (after
 * `legalNameKey`) is ever accepted, and only when it is the one such record and its jurisdiction
 * does not contradict the dossier's; a match on a former/other name is proposed at medium
 * confidence but NOT accepted. Several exact matches are `ambiguous` unless the jurisdiction
 * leaves exactly one. Everything else is `unmatched`, with the nearest candidates for review.
 */
export function matchGleif(entity, records, { nationalIds = [] } = {}) {
    const key = entity.key ?? legalNameKey(entity.name);
    const national = new Set(nationalIds.map((id) => String(id).replace(/[.\-\s]/g, '').toUpperCase()));
    const live = records.filter((r) => !DEAD_REGISTRATIONS.has(r.registrationStatus));
    const pool = live.length ? live : records;
    const exact = pool.filter((r) => legalNameKey(r.legalName) === key);
    const candidates = pool.slice(0, 5).map(candidateSummary);
    if (exact.length === 1) {
        const r = exact[0];
        if (jurisdictionConsistent(entity.jurisdiction, r.jurisdiction)) {
            return { status: 'resolved', accepted: true, lei: { id: r.lei, name: r.legalName, jurisdiction: r.jurisdiction, matchedBy: 'exact-legal-name', confidence: 'high' }, record: r, candidates: [] };
        }
        return {
            status: 'ambiguous', accepted: false, lei: null, record: null, candidates: [candidateSummary(r)],
            note: `exact legal name, but GLEIF says ${r.jurisdiction} where the dossier says ${entity.jurisdiction}`
        };
    }
    if (exact.length > 1) {
        const inJurisdiction = entity.jurisdiction ? exact.filter((r) => jurisdictionConsistent(entity.jurisdiction, r.jurisdiction)) : [];
        if (inJurisdiction.length === 1) {
            const r = inJurisdiction[0];
            return { status: 'resolved', accepted: true, lei: { id: r.lei, name: r.legalName, jurisdiction: r.jurisdiction, matchedBy: 'exact-legal-name+jurisdiction', confidence: 'high' }, record: r, candidates: exact.map(candidateSummary) };
        }
        // Several records with one name in one country: the one whose own registeredAs is the
        // national register number matched independently (Zefix) is the entity; the others are
        // listed, because two live LEIs for one name is itself worth a look.
        const byNational = exact.filter((r) => r.registeredAs && national.has(r.registeredAs.replace(/[.\-\s]/g, '').toUpperCase()));
        if (byNational.length === 1) {
            const r = byNational[0];
            return {
                status: 'resolved', accepted: true,
                lei: { id: r.lei, name: r.legalName, jurisdiction: r.jurisdiction, matchedBy: 'exact-legal-name+registeredAs', confidence: 'high' },
                record: r,
                candidates: exact.filter((x) => x !== r).map(candidateSummary),
                note: `${exact.length - 1} other record(s) with this exact legal name: ${exact.filter((x) => x !== r).map((x) => `${x.lei} (${x.entityStatus}/${x.registrationStatus}, registeredAs ${x.registeredAs ?? '-'})`).join('; ')}`
            };
        }
        return { status: 'ambiguous', accepted: false, lei: null, record: null, candidates: exact.map(candidateSummary), note: `${exact.length} records with this exact legal name` };
    }
    const byOther = pool.filter((r) => r.otherNames.some((n) => legalNameKey(n) === key));
    if (byOther.length) {
        return {
            status: 'ambiguous', accepted: false, lei: null, record: null, candidates: byOther.map(candidateSummary),
            note: 'matches a former or other name on the record, not the current legal name — review'
        };
    }
    return { status: 'unmatched', accepted: false, lei: null, record: null, candidates, note: pool.length ? 'no exact legal-name match among GLEIF results' : 'GLEIF has no record under this name' };
}

/** National register ids GLEIF itself states for an accepted LEI record (the register authority's own number). */
export function registriesFromGleif(record) {
    const out = {};
    if (!record?.registeredAs) return out;
    if (record.registeredAt === RA_COMPANIES_HOUSE && (record.jurisdiction ?? '').startsWith('GB')) {
        out['companies-house'] = { id: padCompanyNumber(record.registeredAs), matchedBy: 'gleif-registeredAs', confidence: 'high' };
    }
    if (/^CHE\d{9}$/.test(record.registeredAs.replace(/[.-]/g, '')) && record.jurisdiction === 'CH') {
        out.zefix = { uid: record.registeredAs.replace(/[.-]/g, ''), matchedBy: 'gleif-registeredAs', confidence: 'high' };
    }
    if (record.registeredAt === RA_JERSEY && record.jurisdiction === 'JE') {
        out.jfsc = { id: record.registeredAs, matchedBy: 'gleif-registeredAs', confidence: 'high', watched: false };
    }
    return out;
}

/** Match an entity against Zefix search results: exact name or an official translation of it. */
export function matchZefix(entity, firms) {
    const key = entity.key ?? legalNameKey(entity.name);
    const exact = firms.filter((f) => [f.name, ...f.translations].some((n) => legalNameKey(n) === key));
    const existing = exact.filter((f) => f.status === 'EXISTIEREND');
    const pick = existing.length === 1 ? existing[0] : exact.length === 1 ? exact[0] : null;
    if (pick) return { status: 'resolved', accepted: true, zefix: { uid: pick.uid, ehraid: pick.ehraid, name: pick.name, matchedBy: 'exact-name', confidence: 'high' } };
    const candidates = (exact.length ? exact : firms).slice(0, 5).map((f) => ({ uid: f.uid, ehraid: f.ehraid, name: f.name, status: f.status, legalSeat: f.legalSeat }));
    return { status: exact.length ? 'ambiguous' : 'unmatched', accepted: false, zefix: null, candidates };
}

/**
 * The registry file entry for one entity after a resolve pass. A `reviewed: true` entry is a human
 * decision and is kept as is (only its issuers/roles follow the dossiers).
 */
export function resolutionEntry(entity, { gleif = null, zefix = null, previous = null, resolvedAt }) {
    const base = {
        key: entity.key, name: entity.name, issuers: entity.issuers, roles: entity.roles,
        jurisdiction: entity.jurisdiction, jurisdictionFrom: entity.jurisdictionFrom
    };
    if (previous?.reviewed === true) return { ...previous, ...base, jurisdiction: previous.jurisdiction ?? entity.jurisdiction };
    const registries = gleif?.accepted ? registriesFromGleif(gleif.record) : {};
    if (!registries.zefix && zefix?.accepted) registries.zefix = zefix.zefix;
    if (registries.zefix && zefix?.accepted && zefix.zefix.uid === registries.zefix.uid) registries.zefix.ehraid = zefix.zefix.ehraid;
    const leiOk = Boolean(gleif?.accepted);
    const status = leiOk || registries.zefix ? 'resolved' : gleif?.status === 'ambiguous' || zefix?.status === 'ambiguous' ? 'ambiguous' : 'unmatched';
    return {
        ...base,
        status,
        lei: leiOk ? gleif.lei : null,
        registries,
        candidates: {
            ...(gleif && gleif.candidates.length ? { gleif: gleif.candidates } : {}),
            ...(zefix && !zefix.accepted && zefix.candidates?.length ? { zefix: zefix.candidates } : {})
        },
        note: [gleif?.note, !entity.legalName ? 'not a full legal name in the dossier — a reviewer must pick the entity' : null].filter(Boolean).join('; ') || null,
        reviewed: false,
        resolvedAt
    };
}

/** The watch tasks one registry entry yields: only accepted identifiers, never a candidate. */
export function watchTasks(entry, { companiesHouseKey = false } = {}) {
    if (!entry || !(entry.status === 'resolved' || entry.reviewed === true)) return [];
    const tasks = [];
    const base = { entityKey: entry.key, entityName: entry.name, issuers: entry.issuers ?? [] };
    if (entry.lei?.id) tasks.push({ ...base, id: `gleif:${entry.lei.id}`, source: 'gleif', identifier: entry.lei.id });
    const z = entry.registries?.zefix;
    if (z?.uid) tasks.push({ ...base, id: `zefix:${z.uid}`, source: 'zefix', identifier: z.uid, ehraid: z.ehraid ?? null });
    const ch = entry.registries?.['companies-house'];
    if (ch?.id) {
        if (companiesHouseKey) tasks.push({ ...base, id: `companies-house:${ch.id}`, source: 'companies-house', identifier: ch.id });
        tasks.push({ ...base, id: `gazette:${ch.id}`, source: 'gazette', identifier: ch.id, legalName: entry.lei?.name ?? entry.name });
    }
    return tasks;
}

// ---------------------------------------------------------------------------------------------
// State and change detection
// ---------------------------------------------------------------------------------------------

/** Stable JSON: keys sorted at every level, so the same state always hashes the same. */
export function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

export function stateHash(state) {
    return createHash('sha256').update(stableStringify(state)).digest('hex').slice(0, 32);
}

/**
 * The comparable state per source, and the source's OWN last-update date (never the fetch time:
 * GLEIF's registration.lastUpdateDate, Zefix's shabDate — the date of the latest SOGC publication,
 * the Gazette's newest matched notice date; Companies House states none, so it is null).
 * `lastUpdateDate` itself is not part of the state: a record re-validated with nothing changed is
 * not a change.
 */
export function gleifState(record, parent = null, parentExceptionReason = null) {
    const { lastUpdateDate, hasDirectParent, parentException, otherNames, creationDate, corroborationLevel, country, ...rest } = record;
    return {
        state: {
            ...rest,
            otherNames: [...otherNames].sort(),
            directParent: parent ? { lei: parent.lei, name: parent.legalName } : null,
            // Why no parent is reported: NON_CONSOLIDATING, NATURAL_PERSONS, NO_KNOWN_PERSON, …
            directParentException: parent ? null : parentExceptionReason
        },
        sourceUpdatedAt: lastUpdateDate
    };
}

export function zefixState(firm) {
    const { publications, shabDate, excerptUrl, ehraid, translations, ...rest } = firm;
    return {
        state: { ...rest, translations: [...translations].sort(), publications: publications.slice(0, 15) },
        sourceUpdatedAt: shabDate
    };
}

export function companiesHouseState(profile, officers) {
    return { state: { ...profile, officers: officers ?? null }, sourceUpdatedAt: null };
}

/**
 * Gazette state: the insolvency notices that name the company. `confirmed` carry our company
 * number in their linked data; `nameOnly` match the exact legal name but state no company number
 * (or none could be read) and are listed so a person can look; notices for a DIFFERENT company
 * number are left out.
 */
export function gazetteState({ companyNumber, legalName, notices, noticeData }) {
    const key = legalNameKey(legalName);
    const confirmed = [];
    const nameOnly = [];
    for (const n of notices) {
        const data = noticeData[n.id] ?? null;
        const numbers = (data?.companyNumbers ?? []).map(padCompanyNumber);
        const entry = { id: n.id, code: n.code, category: n.category, published: n.published, title: n.title, url: n.url };
        if (numbers.includes(padCompanyNumber(companyNumber))) confirmed.push(entry);
        else if (numbers.length === 0 && [n.title, ...(data?.names ?? [])].some((t) => legalNameKey(t) === key)) nameOnly.push(entry);
    }
    const byId = (a, b) => a.id.localeCompare(b.id);
    const dates = [...confirmed, ...nameOnly].map((n) => n.published).filter(Boolean).sort();
    return {
        state: { companyNumber: padCompanyNumber(companyNumber), confirmed: confirmed.sort(byId), nameOnly: nameOnly.sort(byId) },
        sourceUpdatedAt: dates.length ? dates[dates.length - 1] : null
    };
}

/** Zefix SOGC mutation types whose publication is itself a finding, strongest first. */
export function zefixPublicationSeverity(types) {
    const t = types.join(' ');
    if (/konkurs|aufloes|loesch|liquid|nachlass|stundung|sanierung|ueberschuld/.test(t)) return 'critical';
    if (/fusion|uebernahme|vermoegensuebertragung|spaltung|umwandlung|rechtsform/.test(t)) return 'warning';
    if (/firma|firmen|sitz|kapital/.test(t)) return 'caution';
    return 'info';
}

const CH_ACTIVE = new Set(['active', 'open', 'registered']);
const CH_INSOLVENT = new Set(['liquidation', 'receivership', 'administration', 'voluntary-arrangement', 'insolvency-proceedings']);

const fmt = (v) => (v === null || v === undefined ? null : typeof v === 'string' ? v : stableStringify(v));

/**
 * Findings between two states of one entity at one source. `prev` null is the first observation:
 * only an ADVERSE current state is a finding then (a lapsed LEI, an INACTIVE entity, a Swiss firm
 * not EXISTIEREND, a UK company not active, any confirmed insolvency notice), because a first read
 * says nothing about change but an issuer's SPV already in liquidation is exactly what this is for.
 * Returns [{field, before, after, severity, kind}] where kind is `entity-status` or `insolvency`.
 */
export function diffStates(source, prev, next) {
    const out = [];
    const f = (field, before, after, severity, kind = 'entity-status') => out.push({ field, before: fmt(before), after: fmt(after), severity, kind });
    const changed = (k) => prev && stableStringify(prev[k]) !== stableStringify(next[k]);
    if (source === 'gleif') {
        const statusSeverity = (s) => (s === 'ACTIVE' ? 'info' : 'critical');
        const regSeverity = (s) => (s === 'ISSUED' || s === 'PENDING_TRANSFER' || s === 'PENDING_ARCHIVAL' ? 'info'
            : s === 'LAPSED' ? 'warning' : 'critical');
        if (!prev) {
            if (next.entityStatus && next.entityStatus !== 'ACTIVE') f('entityStatus', null, next.entityStatus, 'critical');
            if (next.registrationStatus && next.registrationStatus !== 'ISSUED') f('registrationStatus', null, next.registrationStatus, regSeverity(next.registrationStatus));
            if (next.successors.length) f('successors', null, next.successors, 'critical');
            if (next.expirationReason) f('expiration', null, `${next.expirationReason} ${next.expirationDate ?? ''}`.trim(), 'critical');
            return out;
        }
        if (changed('entityStatus')) f('entityStatus', prev.entityStatus, next.entityStatus, statusSeverity(next.entityStatus));
        if (changed('registrationStatus')) f('registrationStatus', prev.registrationStatus, next.registrationStatus, regSeverity(next.registrationStatus));
        if (changed('legalName')) f('legalName', prev.legalName, next.legalName, 'warning');
        if (changed('successors')) f('successors', prev.successors, next.successors, next.successors.length ? 'critical' : 'caution');
        if (changed('expirationReason') || changed('expirationDate')) {
            f('expiration', `${prev.expirationReason ?? ''} ${prev.expirationDate ?? ''}`.trim() || null,
                `${next.expirationReason ?? ''} ${next.expirationDate ?? ''}`.trim() || null, next.expirationReason ? 'critical' : 'caution');
        }
        if (changed('directParent')) f('directParent', prev.directParent, next.directParent, 'warning');
        if (changed('directParentException') && !changed('directParent')) f('directParentException', prev.directParentException, next.directParentException, 'caution');
        for (const k of ['jurisdiction', 'legalForm', 'registeredAs', 'registeredAt']) if (changed(k)) f(k, prev[k], next[k], 'warning');
        if (changed('otherNames')) f('otherNames', prev.otherNames, next.otherNames, 'caution');
        if (changed('nextRenewalDate')) f('nextRenewalDate', prev.nextRenewalDate, next.nextRenewalDate, 'info');
        return out;
    }
    if (source === 'zefix') {
        if (!prev) {
            if (next.status && next.status !== 'EXISTIEREND') f('status', null, next.status, 'critical');
            if (next.deleteDate) f('deleteDate', null, next.deleteDate, 'critical');
            if (next.wasTakenOverBy.length) f('wasTakenOverBy', null, next.wasTakenOverBy, 'critical');
            return out;
        }
        if (changed('status')) f('status', prev.status, next.status, next.status === 'EXISTIEREND' ? 'caution' : 'critical');
        if (changed('deleteDate')) f('deleteDate', prev.deleteDate, next.deleteDate, next.deleteDate ? 'critical' : 'caution');
        if (changed('name')) f('name', prev.name, next.name, 'warning');
        if (changed('legalSeat')) f('legalSeat', prev.legalSeat, next.legalSeat, 'caution');
        if (changed('legalFormId')) f('legalFormId', prev.legalFormId, next.legalFormId, 'warning');
        if (changed('wasTakenOverBy')) f('wasTakenOverBy', prev.wasTakenOverBy, next.wasTakenOverBy, 'critical');
        const seen = new Set((prev.publications ?? []).map((p) => p.id));
        const oldest = (prev.publications ?? []).map((p) => p.date).filter(Boolean).sort()[0] ?? null;
        for (const p of next.publications) {
            // Only publications newer than the stored window: an old one that slid out of the stored
            // top 15 is not new.
            if (seen.has(p.id) || (oldest && p.date && p.date < oldest)) continue;
            const severity = zefixPublicationSeverity(p.types);
            f(`publication:${p.id}`, null, `${p.date} ${p.types.join(',') || 'publication'}`, severity, severity === 'critical' ? 'insolvency' : 'entity-status');
        }
        return out;
    }
    if (source === 'companies-house') {
        const statusSeverity = (s) => (CH_ACTIVE.has(s) ? 'caution' : CH_INSOLVENT.has(s) ? 'critical' : 'critical');
        if (!prev) {
            if (next.status && !CH_ACTIVE.has(next.status)) f('status', null, next.status, 'critical', CH_INSOLVENT.has(next.status) ? 'insolvency' : 'entity-status');
            if (next.hasInsolvencyHistory) f('hasInsolvencyHistory', null, true, 'warning', 'insolvency');
            return out;
        }
        if (changed('status')) f('status', prev.status, next.status, statusSeverity(next.status), CH_INSOLVENT.has(next.status) ? 'insolvency' : 'entity-status');
        if (changed('statusDetail')) f('statusDetail', prev.statusDetail, next.statusDetail, 'warning');
        if (changed('hasInsolvencyHistory')) f('hasInsolvencyHistory', prev.hasInsolvencyHistory, next.hasInsolvencyHistory, next.hasInsolvencyHistory ? 'critical' : 'caution', 'insolvency');
        if (changed('dateOfCessation')) f('dateOfCessation', prev.dateOfCessation, next.dateOfCessation, 'critical');
        if (changed('name')) f('name', prev.name, next.name, 'warning');
        if (changed('officers') && prev.officers !== null && next.officers !== null) f('officers', prev.officers, next.officers, 'info');
        return out;
    }
    if (source === 'gazette') {
        const before = new Set([...(prev?.confirmed ?? []), ...(prev?.nameOnly ?? [])].map((n) => n.id));
        for (const n of next.confirmed) {
            if (!before.has(n.id)) f(`notice:${n.id}`, null, `${n.published?.slice(0, 10) ?? '?'} ${n.category ?? n.code ?? 'notice'}: ${n.title}`, 'critical', 'insolvency');
        }
        for (const n of next.nameOnly) {
            if (!before.has(n.id)) f(`notice:${n.id}`, null, `${n.published?.slice(0, 10) ?? '?'} ${n.category ?? n.code ?? 'notice'} (name match, no company number): ${n.title}`, 'warning', 'insolvency');
        }
        return out;
    }
    throw new Error(`diffStates: unknown source ${source}`);
}

/** The field names whose value differs between two states (what a stored change row says moved). */
export function changedFields(prev, next) {
    if (!prev) return [];
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    return [...keys].filter((k) => stableStringify(prev[k]) !== stableStringify(next[k])).sort();
}

/** A human link to the record at the source. */
export function sourceUrl(source, identifier, extra = {}) {
    if (source === 'gleif') return `https://search.gleif.org/#/record/${identifier}`;
    if (source === 'zefix') return extra.excerptUrl ?? `https://www.zefix.ch/en/search/entity/list?name=${encodeURIComponent(identifier)}`;
    if (source === 'companies-house') return `https://find-and-update.company-information.service.gov.uk/company/${identifier}`;
    if (source === 'gazette') return `${GAZETTE}/insolvency/notice?text=${encodeURIComponent(`"${extra.legalName ?? identifier}"`)}`;
    return null;
}

/**
 * One observation of one entity at one source → the row to store (only if its state differs from
 * the latest stored one) and the change events, one per issuer whose chain includes the entity.
 */
export function foldObservation(task, { state, sourceUpdatedAt, url }, { previous, detectedAt }) {
    const hash = stateHash(state);
    const prevState = previous?.state ?? null;
    if (previous && previous.stateHash === hash) {
        return { row: null, confirm: { ...rowKey(task), stateHash: hash, observedAt: detectedAt }, findings: [], events: [] };
    }
    const findings = diffStates(task.source, prevState, state);
    const row = {
        ...rowKey(task),
        entityName: task.entityName,
        issuers: [...task.issuers].sort(),
        state,
        stateHash: hash,
        sourceUpdatedAt: sourceUpdatedAt ?? null,
        changeKind: previous ? 'changed' : 'baseline',
        changedFields: changedFields(prevState, state),
        findings,
        url,
        observedAt: detectedAt
    };
    const events = [];
    for (const fnd of findings) {
        for (const issuer of row.issuers) {
            events.push({
                detectedAt,
                kind: fnd.kind,
                subjectType: 'issuer',
                subjectId: issuer,
                field: `${task.entityName} · ${task.source}:${fnd.field}`,
                before: fnd.before,
                after: fnd.after,
                severity: fnd.severity,
                evidence: { entity: task.entityName, source: task.source, identifier: task.identifier, url, sourceUpdatedAt: sourceUpdatedAt ?? null, baseline: !previous },
                summary: `${task.entityName} (${task.source} ${task.identifier}): ${fnd.field} ${fnd.before === null ? '' : `${String(fnd.before).slice(0, 80)} → `}${String(fnd.after ?? '(none)').slice(0, 160)}${previous ? '' : ' (first observation)'}`
            });
        }
    }
    return { row, confirm: null, findings, events };
}

function rowKey(task) {
    return { entityKey: task.entityKey, source: task.source, identifier: task.identifier };
}

// ---------------------------------------------------------------------------------------------
// SQL (psql over stdin, like every other loader here)
// ---------------------------------------------------------------------------------------------

/** The latest stored observation per (entity, source, identifier), as one JSON array. */
export function buildReadLatestQuery() {
    return "SELECT coalesce(jsonb_agg(jsonb_build_object('entityKey', entity_key, 'source', source,\n"
        + "  'identifier', identifier, 'state', state, 'stateHash', state_hash, 'observedAt', observed_at)), '[]'::jsonb)\n"
        + '  FROM (SELECT DISTINCT ON (entity_key, source, identifier) *\n'
        + '          FROM sonar.entity_observation\n'
        + '         ORDER BY entity_key, source, identifier, observed_at DESC, id DESC) latest;\n';
}

/**
 * Insert observation rows — each only when the latest stored state for its (entity, source,
 * identifier) has a different hash, so a re-run or a resumed run writes nothing twice — and move
 * `last_confirmed_at` on the latest row of every unchanged one.
 */
export function buildObservationSql({ rows = [], confirms = [] }, { tag = 'sonar' } = {}) {
    const statements = [];
    const latestHash = "(SELECT o.state_hash FROM sonar.entity_observation o\n"
        + "          WHERE o.entity_key = r->>'entityKey' AND o.source = r->>'source' AND o.identifier = r->>'identifier'\n"
        + '          ORDER BY o.observed_at DESC, o.id DESC LIMIT 1)';
    if (rows.length) {
        statements.push(`WITH doc AS (SELECT ${jsonbLiteral({ rows }, tag)} AS d),\n`
            + "     src AS (SELECT x.r FROM doc, jsonb_array_elements(d->'rows') AS x(r))\n"
            + 'INSERT INTO sonar.entity_observation\n'
            + '       (entity_key, entity_name, source, identifier, issuers, state, state_hash, source_updated_at,\n'
            + '        change_kind, changed_fields, findings, url, observed_at, last_confirmed_at)\n'
            + "SELECT r->>'entityKey', r->>'entityName', r->>'source', r->>'identifier',\n"
            + "       ARRAY(SELECT jsonb_array_elements_text(coalesce(r->'issuers', '[]'::jsonb)) ORDER BY 1),\n"
            + "       r->'state', r->>'stateHash', (r->>'sourceUpdatedAt')::timestamptz, r->>'changeKind',\n"
            + "       ARRAY(SELECT jsonb_array_elements_text(coalesce(r->'changedFields', '[]'::jsonb))),\n"
            + "       coalesce(r->'findings', '[]'::jsonb), r->>'url', (r->>'observedAt')::timestamptz, (r->>'observedAt')::timestamptz\n"
            + '  FROM src\n'
            + ` WHERE ${latestHash} IS DISTINCT FROM r->>'stateHash'\n`
            + 'ON CONFLICT (entity_key, source, identifier, observed_at) DO NOTHING;\n');
    }
    if (confirms.length) {
        statements.push(`WITH doc AS (SELECT ${jsonbLiteral({ rows: confirms }, tag)} AS d),\n`
            + "     src AS (SELECT x.r FROM doc, jsonb_array_elements(d->'rows') AS x(r))\n"
            + 'UPDATE sonar.entity_observation t\n'
            + "   SET last_confirmed_at = (r->>'observedAt')::timestamptz, updated_at = now()\n"
            + '  FROM src\n'
            + ' WHERE t.id = (SELECT o.id FROM sonar.entity_observation o\n'
            + "                WHERE o.entity_key = r->>'entityKey' AND o.source = r->>'source' AND o.identifier = r->>'identifier'\n"
            + '                ORDER BY o.observed_at DESC, o.id DESC LIMIT 1)\n'
            + "   AND t.state_hash = r->>'stateHash'\n"
            + "   AND t.last_confirmed_at < (r->>'observedAt')::timestamptz;\n");
    }
    return { table: 'sonar.entity_observation', rows: rows.length, confirms: confirms.length, sql: statements.join('') };
}

// ---------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------

const SEVERITY_RANK = { critical: 0, warning: 1, caution: 2, info: 3 };

/** One Telegram message per run: counts, the strongest findings, the failures. Plain text. */
export function formatTelegramSummary({ findings, events, failures, entitiesWatched, resolved, unresolved, requests, durationMs }) {
    const lines = [`RWA Sonar entity watch: ${findings.length} change(s), ${failures.length} failure(s)`];
    lines.push(`${entitiesWatched} entities · ${resolved} resolved · ${unresolved} unresolved · ${events} event(s) · ${requests} request(s) · ${(durationMs / 1000).toFixed(0)} s`);
    const top = [...findings].sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9)).slice(0, 8);
    for (const x of top) lines.push(`• [${x.severity}] ${x.entityName} (${x.source}): ${x.field} ${x.before === null ? '' : `${String(x.before).slice(0, 60)} → `}${String(x.after ?? '(none)').slice(0, 140)}`);
    if (findings.length > top.length) lines.push(`… and ${findings.length - top.length} more in sonar.entity_observation`);
    for (const f of failures.slice(0, 5)) lines.push(`✗ ${f.slice(0, 200)}`);
    if (failures.length > 5) lines.push(`… and ${failures.length - 5} more failure(s)`);
    return lines.join('\n');
}
