// The case-law watcher's decisions (stocks/watch-caselaw.mjs), kept pure so they are unit tested
// without a network or a database (stocks/caselaw.test.js): which names to search for, derived
// from the dossiers' parties and legal entities rather than typed by hand; how a CourtListener or
// SEC result becomes one comparable record; whether a hit names the party in the caption, among
// the parties, or only somewhere in the text; which differences against the stored state are
// change events; and the SQL that stores it all.
//
// It feeds the `litigated` what-if status (stocks/data/trust-chain.json `answerStatuses`) but never
// sets it: every event is a CANDIDATE for human review. Promoting an answer to `litigated` needs a
// decision somebody actually read.

import { jsonbLiteral } from './db-load.mjs';

// ---------------------------------------------------------------------------------------------
// Names and phrases
// ---------------------------------------------------------------------------------------------

/**
 * A name reduced to what a search engine compares: lower case, punctuation gone, whitespace
 * collapsed. CourtListener ignores punctuation inside a quoted phrase ("Payward, Inc." and
 * "Payward Inc" return the same 202 dockets), so the local caption test must ignore it too, or
 * a caption the API matched would read as a text-only hit here.
 */
export function normalisePhrase(text) {
    return String(text ?? '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/** True when `phrase` occurs in `text` on word boundaries, after both are normalised. */
export function containsPhrase(text, phrase) {
    const hay = normalisePhrase(text);
    const needle = normalisePhrase(phrase);
    if (!needle) return false;
    return ` ${hay} `.includes(` ${needle} `);
}

/** Corporate-form words that END a legal name. Compared without a trailing period. */
export const LEGAL_SUFFIXES = new Set([
    'inc', 'incorporated', 'llc', 'l.l.c', 'ltd', 'limited', 'corp', 'corporation', 'ag', 's.a',
    'sa', 'gmbh', 'plc', 'lp', 'l.p', 'llp', 'company', 'foundation', 'fze', 'n.a', 'pte', 'bv',
    'b.v', 'nv', 'n.v', 'sarl', 's.a.r.l', 'se', 'kg'
]);

/**
 * Words that cannot make a name distinctive on their own. A candidate made ONLY of these (plus a
 * suffix) — "Trust Company", "Delaware LLC", "New York Limited" — is a description, not a party,
 * and as an exact phrase it would match half of PACER.
 */
const GENERIC_WORDS = new Set([
    'the', 'a', 'an', 'and', 'of', 'trust', 'company', 'bank', 'capital', 'holdings', 'holding',
    'group', 'services', 'service', 'securities', 'financial', 'finance', 'global', 'international',
    'markets', 'market', 'management', 'partners', 'fund', 'funds', 'investments', 'digital',
    'technologies', 'technology', 'labs', 'exchange', 'brokerage', 'clearing', 'custody',
    'delaware', 'nevada', 'cayman', 'islands', 'british', 'virgin', 'bvi', 'jersey', 'panama',
    'swiss', 'switzerland', 'new', 'york', 'us', 'u.s', 'usa', 'united', 'states', 'uk', 'ireland',
    'europe', 'european', 'america', 'american', 'texas', 'california', 'florida', 'marshall',
    'dakota', 'south', 'north', 'zealand', 'australia', 'dubai', 'uae', 'gibraltar', 'liechtenstein'
]);

/** Capitalised words that start a sentence or a label and are never part of the name after them. */
const LEADING_NOISE = new Set([
    'parent', 'manager', 'register', 'registrant', 'director', 'signatory', 'note', 'platform',
    'formerly', 'also', 'issuer', 'custodian', 'named', 'its', 'the', 'a', 'an', 'and', 'by', 'of',
    'on', 'in', 'see', 'under', 'from', 'with', 'for', 'to', 'as', 'both', 'each', 'via', 'whereas',
    'related', 'entity', 'entities', 'sole', 'member', 'owner', 'operator', 'provider', 'agent',
    'then', 'now', 'while', 'but', 'or', 'nor', 'if', 'when', 'where', 'which', 'who',
    // Region labels in a list of group entities ("UAE Trek Labs Ltd FZE"). Not "American": that
    // one begins real names ("American Stock Transfer & Trust Company, LLC").
    'uae', 'uk', 'eea', 'eu', 'us', 'usa'
]);

// Not `and`: "DekaBank and ALPACADB LTD" is two names, and a firm whose name contains "and" is
// written with an ampersand in every document these dossiers cite.
const CONNECTORS = new Set(['&', 'of', 'de', 'du', 'der', 'von', 'van', 'la', 'le']);

function suffixCore(token) {
    return token.replace(/\.$/, '').toLowerCase();
}

/** A corporate-form word written as one: capitalised, so "a Cayman Islands company" is not a name. */
function isSuffix(token) {
    return /^[A-Z]/.test(token) && LEGAL_SUFFIXES.has(suffixCore(token));
}

/**
 * Two suffixes that legitimately follow each other: "Equiniti Trust Company, LLC", "Trek Labs Ltd
 * FZE". Any other pair is two names or a typo ("Alpaca Securities LLC AG" is the prospectus's own
 * misprint), so the first suffix ends the name.
 */
function suffixesChain(first, second) {
    const a = suffixCore(first);
    const b = suffixCore(second);
    if (a === 'company') return ['llc', 'l.l.c', 'inc', 'ltd', 'limited'].includes(b);
    if (a === 'ltd' || a === 'limited') return b === 'fze';
    return false;
}

/** Suffixes whose period is part of the abbreviation; any other final period is a sentence end. */
const DOTTED_SUFFIXES = new Set(['inc', 'corp', 'ltd', 's.a', 'n.a', 'l.l.c', 'l.p', 'b.v', 'n.v', 's.a.r.l']);

/** An abbreviation whose own period is not a sentence end: "Co.", "S.A.", "N.A.", "U.S.". */
function isAbbreviation(core) {
    return /^(?:[A-Z]\.){1,4}$/.test(core) || /^(?:Co|Corp|Inc|Ltd|Bros|Mfg|No|St)\.$/.test(core);
}

function isNameToken(core) {
    if (CONNECTORS.has(core)) return true;
    if (/^\([A-Z]{1,6}\)$/.test(core)) return true; // (BVI), (JE)
    return /^[A-Z0-9][A-Za-z0-9&'’.\-]*$/.test(core);
}

/**
 * Every legal-entity name in `text`: a run of capitalised words that ends in a corporate-form
 * suffix — "Payward, Inc.", "Backed Assets (JE) Limited", "Continental Stock Transfer & Trust
 * Company", "Trek Labs Ltd FZE". Deliberately conservative: a name must end in a suffix, may run
 * at most eight words back from it, and must contain at least one distinctive word. Returns
 * `{name, index}` in text order; `index` is where the name ends, for the unrelated-mention test.
 */
export function extractLegalEntities(text) {
    const source = String(text ?? '');
    const tokens = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(source)) !== null) {
        const raw = m[0];
        const paren = raw.match(/^(\([A-Z]{1,6}\))([,;:]*)$/); // (BVI), (JE)
        if (paren) {
            tokens.push({ raw, core: paren[1], trailing: paren[2], start: m.index, end: m.index + raw.length });
            continue;
        }
        // Trailing punctuation that is never part of a name. A final period is kept: "Inc." needs
        // it, and a sentence-final "LLC." is handled by the suffix test ignoring it.
        const stripped = raw.replace(/[,;:)\]”"'’]+$/, '');
        const core = stripped.replace(/^[“"‘'(]+(?=[A-Z])/, '');
        tokens.push({ raw, core, trailing: raw.slice(stripped.length), start: m.index, end: m.index + raw.length });
    }
    const found = [];
    for (let i = 0; i < tokens.length; i += 1) {
        const tok = tokens[i];
        if (!isSuffix(tok.core)) continue;
        const next = tokens[i + 1] ?? null;
        // Not the END of a name when the next word continues it ("Trust Company Complex") or is a
        // further suffix ("Equiniti Trust Company, LLC", "Trek Labs Ltd FZE") — the longer name is
        // taken when the scan reaches that later suffix.
        if (next && !next.raw.startsWith('(')) {
            const nextIsSuffix = isSuffix(next.core);
            if (nextIsSuffix && suffixesChain(tok.core, next.core)
                && (tok.trailing === '' || tok.trailing === ',')) continue;
            if (!nextIsSuffix && tok.trailing === '' && !/\.$/.test(tok.core) && /^[A-Z]/.test(next.core)) continue;
        }
        const words = [tok.core];
        for (let j = i - 1; j >= 0 && words.length < 9; j -= 1) {
            const prev = tokens[j];
            const commaBeforeSuffix = j === i - 1 && prev.trailing === ',';
            if (prev.trailing && !commaBeforeSuffix) break;
            if (/\.$/.test(prev.core) && !isAbbreviation(prev.core)) break;
            if (!isNameToken(prev.core)) break;
            // A suffix before this word ends the previous name, unless the two chain.
            if (isSuffix(prev.core) && !(j === i - 1 && suffixesChain(prev.core, tok.core))) break;
            words.unshift(commaBeforeSuffix ? `${prev.core},` : prev.core);
            // An opening parenthesis starts the name: "(Superstate Inc. / …", "(Delaware LLC, …".
            if (/^[“"‘'(]/.test(prev.raw) && !/^\([A-Z]{1,6}\)/.test(prev.raw)) break;
        }
        // A sentence-final period is not part of "LLC", but it is part of "Inc.".
        if (/\.$/.test(words[words.length - 1]) && !DOTTED_SUFFIXES.has(suffixCore(words[words.length - 1]))) {
            words[words.length - 1] = words[words.length - 1].replace(/\.$/, '');
        }
        // Strip label words and connectors from the front: "Parent Backed Finance AG".
        while (words.length > 1 && (LEADING_NOISE.has(words[0].replace(/,$/, '').toLowerCase())
            || CONNECTORS.has(words[0]))) {
            words.shift();
        }
        if (words.length < 2) continue;
        const body = words.slice(0, -1).map((w) => normalisePhrase(w)).filter(Boolean);
        if (!body.some((w) => w.split(' ').some((part) => !GENERIC_WORDS.has(part)))) continue;
        found.push({ name: words.join(' '), index: tok.end });
    }
    return found;
}

/**
 * A dossier naming an entity only to say it is unrelated ("'Remora Capital Corporation' … is NOT
 * related") must not turn that entity into a watch. True when such a disclaimer follows the name
 * within the same sentence.
 */
export function saysUnrelated(text, index) {
    const after = String(text ?? '').slice(index, index + 160);
    const sentence = after.split(/(?<=[.!?])\s+(?=[A-Z])/)[0];
    return /\b(?:not related|unrelated|no relation|not affiliated|unaffiliated)\b/i.test(sentence);
}

/**
 * Bare names too broad to search on their own: each matches thousands of unrelated dockets
 * ("Kraken" is also a sea monster and several unrelated companies; "Alpaca" an animal; "Turnkey"
 * an adjective). When a dossier spells the legal name out ("Payward, Inc.", "Alpaca Securities
 * LLC"), that name is searched instead; when it does not, the party is dropped with this reason
 * and the drop is listed in the generated query file for review.
 */
export const STOPLIST = new Map([
    ['kraken', 'brand, not a legal name — the dossier names the entity Payward, Inc.'],
    ['alpaca', 'common word; search the legal entity (Alpaca Securities LLC, Alpaca Crypto LLC)'],
    ['bullish', 'common English word; search Bullish Digital TA LLC and the other legal entities'],
    ['turnkey', 'common English word'],
    ['republic', 'common word'],
    ['notice', 'common word'],
    ['superstate', 'short brand; search Superstate Services LLC / Superstate Inc.'],
    ['securitize', 'also a verb ("securitize"); search the legal entities'],
    ['fireblocks', 'brand; kept only when a legal name is spelled out'],
    ['chainlink', 'brand and generic term'],
    ['shift', 'common English word; search SHIFT DAO LLC'],
    ['tessera', 'shared with unrelated litigants (Tessera Technologies patent cases); search Tessera Works Foundation and the issuer entities'],
    // Measured 2026-09-23: 23 opinions, none about SHIFT — "mins" is also "minutes", so the phrase
    // matches "30 mins. LLC …" in unrelated opinions.
    ['mins llc', 'matches "mins" (minutes) followed by any LLC in unrelated opinions; SHIFT DAO LLC is searched instead']
]);

/** The dossier party groups whose members are watched, with the role label recorded per origin. */
export const WATCHED_GROUPS = [
    ['tokenIssuers', 'token-issuer'],
    ['tokenizationProviders', 'tokenization-provider'],
    ['transferAgents', 'transfer-agent'],
    ['custodians', 'custodian'],
    ['parents', 'parent']
];

/** A verification agent is watched only when the dossier says it is the security agent or trustee. */
export function isSecurityAgent(party) {
    return /security agent|trustee|collateral agent/i.test(`${party?.name ?? ''} ${party?.note ?? ''}`);
}

/** Every string anywhere in a JSON value, joined — the corpus a party name is expanded against. */
export function dossierText(value) {
    const out = [];
    const walk = (v) => {
        if (typeof v === 'string') out.push(v);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(value);
    return out.join('\n');
}

/**
 * The legal names a party's short name stands for in this dossier: every extracted legal entity
 * that begins with the party's name on a word boundary. "Securitize" → "Securitize Corp.",
 * "Securitize I, Inc.", "Securitize Transfer Agent, LLC"; "Alpaca Securities" → "Alpaca
 * Securities LLC". A parenthetical in the party name ("OpenDeal (Republic)") is not part of it.
 */
export function expandPartyName(name, entities) {
    const base = normalisePhrase(String(name ?? '').replace(/\([^)]*\)/g, ' '));
    if (!base) return [];
    const out = new Map();
    for (const entity of entities) {
        const norm = normalisePhrase(entity);
        if (norm !== base && norm.startsWith(`${base} `)) {
            if (!out.has(norm)) out.set(norm, entity);
        }
    }
    return [...out.values()];
}

/** True when the name already ends in a corporate-form suffix. */
export function hasLegalSuffix(name) {
    const words = String(name ?? '').trim().split(/\s+/);
    return words.length > 1 && isSuffix(words[words.length - 1].replace(/[,;:)]+$/, ''));
}

/**
 * Quoted phrases from the CourtListener searches a dossier already records in `whatIf[].searched`
 * — the research pass's own search terms, e.g. `"Backpack Securities", "Trek Labs"` or
 * `?q=%22Backed+Assets%22`. They are NOT searched automatically: many are topic phrases
 * ("tokenized", "transfer agent", "pre-IPO") or people's names, far too broad for a daily watch.
 * They are used as a coverage check instead — `deriveQueries` reports every prior search the derived
 * set does not cover, so a reviewer can promote the good ones to caselaw-extra.json.
 */
export function searchedPhrases(dossier) {
    const phrases = new Set();
    for (const answer of Array.isArray(dossier?.whatIf) ? dossier.whatIf : []) {
        for (const entry of Array.isArray(answer?.searched) ? answer.searched : []) {
            if (typeof entry !== 'string' || !/courtlistener/i.test(entry)) continue;
            let text = entry;
            try {
                text = entry.replace(/\?q=([^\s)]+)/g, (_, q) => ` ${decodeURIComponent(q.replace(/\+/g, ' '))} `);
            } catch { /* a malformed escape leaves the entry as written */ }
            for (const match of text.matchAll(/["“]([^"“”]{3,80})["”]/g)) {
                const phrase = match[1].trim();
                if (phrase && !/^https?:/i.test(phrase)) phrases.add(phrase);
            }
        }
    }
    return [...phrases];
}

/**
 * The issuer's own name as the dossier's `issuer` field leads with it: "Remora Markets (formerly
 * …)" → "Remora Markets", "PreStocks" → "PreStocks". A platform with no incorporated issuer is sued
 * under its brand, so the brand is a party name too — through the stoplist like any other.
 */
export function issuerBrand(dossier) {
    const raw = typeof dossier?.issuer === 'string' ? dossier.issuer : '';
    const head = raw.split(/\s+\(|\s+[—–-]\s+|,|;/)[0].trim();
    return head.length >= 3 ? head : null;
}

/**
 * The query set, derived from the dossiers. For each dossier:
 *   1. every legal entity named in `issuingEntity` (the issuer's own legal map), unless the
 *      dossier says in the same breath that it is unrelated;
 *   2. the issuer's brand (`issuerBrand`);
 *   3. every party in the watched groups (token issuer, tokenization provider, transfer agent,
 *      custodian, parent) and every verification agent that is the security agent, expanded to
 *      the legal names the dossier spells out for it; a bare name is kept only when no legal name
 *      exists and it is not on the stoplist.
 * Plus the manual additions (`extra.queries`, `extra.dockets`). Deduplicated across issuers by
 * normalised phrase, and a phrase another phrase already contains at its start is folded into it
 * ("Trek Labs Ltd FZE" is found by "Trek Labs Ltd"): one query, the union of issuers and origins.
 */
export function deriveQueries(dossiers, { extra = {} } = {}) {
    const byKey = new Map();
    const dropped = [];
    const add = (phrase, issuer, origin) => {
        const key = normalisePhrase(phrase);
        if (!key) return;
        const stop = STOPLIST.get(key);
        if (stop) {
            dropped.push({ name: phrase, issuer, origin: origin.from, reason: `stoplist: ${stop}` });
            return;
        }
        if (!byKey.has(key)) {
            byKey.set(key, { id: `phrase:${key}`, kind: 'phrase', phrase: phrase.trim(), issuers: [], origins: [], covers: [] });
        }
        const q = byKey.get(key);
        if (!q.issuers.includes(issuer)) q.issuers.push(issuer);
        if (!q.origins.some((o) => o.issuer === issuer && o.from === origin.from && o.party === origin.party)) {
            q.origins.push({ issuer, ...origin });
        }
    };

    const prior = [];
    for (const { slug, dossier } of dossiers) {
        const entityText = typeof dossier?.issuingEntity === 'string' ? dossier.issuingEntity : '';
        for (const { name, index } of extractLegalEntities(entityText)) {
            if (saysUnrelated(entityText, index)) {
                dropped.push({ name, issuer: slug, origin: 'issuingEntity', reason: 'the dossier says it is unrelated' });
                continue;
            }
            add(name, slug, { from: 'issuingEntity', party: null, role: 'legal-entity' });
        }
        const brand = issuerBrand(dossier);
        if (brand) add(brand, slug, { from: 'issuer', party: null, role: 'issuer-brand' });

        const corpus = dossierText(dossier);
        const entities = extractLegalEntities(corpus).map((e) => e.name);
        const parties = dossier?.parties ?? {};
        const watched = [];
        for (const [group, role] of WATCHED_GROUPS) {
            for (const p of Array.isArray(parties[group]) ? parties[group] : []) watched.push({ party: p, group, role });
        }
        for (const p of Array.isArray(parties.verificationAgents) ? parties.verificationAgents : []) {
            if (isSecurityAgent(p)) watched.push({ party: p, group: 'verificationAgents', role: 'security-agent' });
        }
        for (const { party, group, role } of watched) {
            const name = typeof party?.name === 'string' ? party.name.trim() : '';
            if (!name) continue;
            const expansions = expandPartyName(name, entities);
            const origin = { from: `parties.${group}`, party: name, role };
            if (expansions.length) {
                for (const legal of expansions) add(legal, slug, origin);
                // The bare name as well, when it is itself a full legal name.
                if (hasLegalSuffix(name)) add(name, slug, origin);
            } else {
                add(name, slug, origin);
            }
        }
        for (const phrase of searchedPhrases(dossier)) prior.push({ issuer: slug, phrase });
    }

    for (const q of Array.isArray(extra.queries) ? extra.queries : []) {
        for (const issuer of q.issuers ?? []) add(q.phrase, issuer, { from: 'extra', party: null, role: 'manual', note: q.note ?? null });
    }

    // Fold "X Ltd FZE" into "X Ltd": an exact-phrase search for the shorter name already returns
    // every case the longer one would, so the longer query is only a wasted request.
    const keys = [...byKey.keys()].sort((a, b) => a.length - b.length);
    for (const key of keys) {
        const q = byKey.get(key);
        if (!q) continue;
        const shorter = keys.find((k) => k !== key && k.length < key.length && byKey.has(k) && key.startsWith(`${k} `));
        if (!shorter) continue;
        const into = byKey.get(shorter);
        into.issuers = union(into.issuers, q.issuers);
        into.origins.push(...q.origins.map((o) => ({ ...o, via: q.phrase })));
        into.covers = union(into.covers, [q.phrase, ...q.covers]);
        byKey.delete(key);
    }

    const queries = [...byKey.values()];
    for (const d of Array.isArray(extra.dockets) ? extra.dockets : []) {
        queries.push({
            id: `docket:${d.courtId}:${d.docketNumber}`,
            kind: 'docket',
            phrase: null,
            name: d.name,
            courtId: d.courtId,
            docketNumber: d.docketNumber,
            issuers: [...(d.issuers ?? [])],
            origins: (d.issuers ?? []).map((issuer) => ({ issuer, from: 'extra', party: null, role: 'known-docket', note: d.note ?? null })),
            covers: []
        });
    }
    for (const q of queries) {
        q.issuers.sort();
        q.origins.sort((a, b) => `${a.issuer}|${a.from}|${a.party}|${a.via ?? ''}`.localeCompare(`${b.issuer}|${b.from}|${b.party}|${b.via ?? ''}`));
    }
    queries.sort((a, b) => a.id.localeCompare(b.id));

    const searchedKeys = queries.filter((q) => q.phrase).map((q) => normalisePhrase(q.phrase));
    const covered = (name) => {
        const key = normalisePhrase(name);
        return searchedKeys.some((k) => key === k || key.startsWith(`${k} `));
    };
    // A name dropped for one issuer but searched for another is not dropped at all.
    const reallyDropped = dropped
        .filter((d) => !covered(d.name))
        .sort((a, b) => `${a.issuer}|${a.name}`.localeCompare(`${b.issuer}|${b.name}`));
    const seenPrior = new Set();
    const priorNotWatched = prior
        .filter((p) => !covered(p.phrase))
        .filter((p) => {
            const k = `${p.issuer}|${normalisePhrase(p.phrase)}`;
            if (seenPrior.has(k)) return false;
            seenPrior.add(k);
            return true;
        })
        .sort((a, b) => `${a.issuer}|${a.phrase}`.localeCompare(`${b.issuer}|${b.phrase}`));
    return { queries, dropped: reallyDropped, priorNotWatched };
}

/** Validate caselaw-extra.json. Throws on a malformed entry rather than silently skipping it. */
export function validateExtra(extra) {
    const errors = [];
    for (const [i, q] of (extra?.queries ?? []).entries()) {
        if (typeof q?.phrase !== 'string' || !q.phrase.trim()) errors.push(`queries[${i}]: phrase is required`);
        if (!Array.isArray(q?.issuers) || q.issuers.length === 0) errors.push(`queries[${i}]: issuers[] is required`);
    }
    for (const [i, d] of (extra?.dockets ?? []).entries()) {
        for (const k of ['name', 'courtId', 'docketNumber']) {
            if (typeof d?.[k] !== 'string' || !d[k].trim()) errors.push(`dockets[${i}]: ${k} is required`);
        }
        if (!Array.isArray(d?.issuers) || d.issuers.length === 0) errors.push(`dockets[${i}]: issuers[] is required`);
    }
    if (errors.length) throw new Error(`caselaw-extra.json is invalid:\n  ${errors.join('\n  ')}`);
    return extra;
}

export const REVIEW_STATUSES = ['candidate', 'dismissed', 'confirmed'];

/**
 * Read caselaw-reviewed.json into a Map key → decision. `dismissed` keeps a record as a recorded
 * candidate that raises no further events (the Payward dockets about ordinary crypto disputes);
 * `confirmed` means a human judged it relevant, and its docket is always followed for new entries.
 */
export function reviewIndex(reviewed) {
    const index = new Map();
    const errors = [];
    for (const [i, d] of (reviewed?.decisions ?? []).entries()) {
        if (typeof d?.key !== 'string' || !d.key) errors.push(`decisions[${i}]: key is required`);
        else if (!['dismissed', 'confirmed'].includes(d.status)) errors.push(`decisions[${i}]: status must be dismissed or confirmed, got ${JSON.stringify(d.status)}`);
        else if (typeof d.reason !== 'string' || !d.reason.trim()) errors.push(`decisions[${i}]: a reason is required`);
        else if (index.has(d.key)) errors.push(`decisions[${i}]: ${d.key} is decided twice`);
        else index.set(d.key, d);
    }
    if (errors.length) throw new Error(`caselaw-reviewed.json is invalid:\n  ${errors.join('\n  ')}`);
    return index;
}

// ---------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------

export const COURTLISTENER_SEARCH = 'https://www.courtlistener.com/api/rest/v4/search/';
export const COURTLISTENER_WEB = 'https://www.courtlistener.com';
export const SEC_FEEDS = [
    { id: 'sec-lr', label: 'SEC litigation release', url: 'https://www.sec.gov/enforcement-litigation/litigation-releases/rss' },
    { id: 'sec-ap', label: 'SEC administrative proceeding', url: 'https://www.sec.gov/enforcement-litigation/administrative-proceedings/rss' }
];

/**
 * The CourtListener search URL for one task. Results are ordered by filing date, newest first, so
 * the first page is where a NEW case appears; relevance order would reshuffle between runs and
 * make an old case look new the day it drifts onto page one.
 */
export function courtListenerUrl(task) {
    const params = new URLSearchParams();
    if (task.kind === 'entries') {
        params.set('q', `docket_id:${task.docketId}`);
        params.set('type', 'rd');
        params.set('order_by', 'entry_date_filed desc');
    } else if (task.kind === 'docket') {
        params.set('q', `docketNumber:"${task.docketNumber}"`);
        params.set('type', 'r');
        params.set('court', task.courtId);
    } else {
        params.set('q', `"${task.phrase}"`);
        params.set('type', task.type);
        params.set('order_by', 'dateFiled desc');
    }
    return `${COURTLISTENER_SEARCH}?${params.toString()}`;
}

function absolute(url) {
    if (typeof url !== 'string' || !url) return null;
    return url.startsWith('http') ? url : `${COURTLISTENER_WEB}${url}`;
}

function dateOnly(value) {
    if (typeof value !== 'string' || !value) return null;
    const m = value.match(/^\d{4}-\d{2}-\d{2}/);
    return m ? m[0] : null;
}

/**
 * How firmly a hit is tied to the name: `caption` when the case name contains it, `party` when a
 * RECAP docket lists it among the parties but the caption does not, `text` when it matched only
 * somewhere in the documents (a creditor matrix, an exhibit, a footnote). Ranked in that order.
 */
export function matchLevel({ caseName, parties = [] }, phrase) {
    if (!phrase) return 'caption';
    if (containsPhrase(caseName, phrase)) return 'caption';
    if (parties.some((p) => containsPhrase(p, phrase))) return 'party';
    return 'text';
}

export const MATCH_RANK = { caption: 0, party: 1, text: 2 };

/**
 * One CourtListener search response → records. `type` o (opinions, keyed by cluster) or r (RECAP
 * dockets, keyed by docket). The dates are the source's own (`dateFiled`); nothing is stamped with
 * our clock except `firstSeenAt`/`lastSeenAt`, which are by definition when WE saw it.
 */
export function parseCourtListenerResults(json, { type, phrase }) {
    const results = Array.isArray(json?.results) ? json.results : [];
    const out = [];
    for (const r of results) {
        const caseName = typeof r.caseName === 'string' && r.caseName.trim() ? r.caseName.trim()
            : (typeof r.caseNameFull === 'string' && r.caseNameFull.trim() ? r.caseNameFull.trim() : null);
        const parties = Array.isArray(r.party) ? r.party.filter((p) => typeof p === 'string') : [];
        let key;
        let url;
        let entry = null;
        if (type === 'o') {
            if (r.cluster_id === undefined || r.cluster_id === null) continue;
            key = `courtlistener-o:${r.cluster_id}`;
            url = absolute(r.absolute_url);
        } else {
            if (r.docket_id === undefined || r.docket_id === null) continue;
            key = `courtlistener-r:${r.docket_id}`;
            url = absolute(r.docket_absolute_url ?? r.absolute_url);
            // The matching documents this search returned: a lower bound on the newest entry, not
            // the newest entry itself (that needs its own request; see latestEntryFromDocuments).
            entry = latestEntryFromDocuments(r.recap_documents);
        }
        out.push({
            key,
            source: type === 'o' ? 'courtlistener-o' : 'courtlistener-r',
            externalId: String(type === 'o' ? r.cluster_id : r.docket_id),
            docketId: r.docket_id ?? null,
            caseName,
            court: r.court ?? null,
            courtId: r.court_id ?? null,
            dateFiled: dateOnly(r.dateFiled),
            dateTerminated: dateOnly(r.dateTerminated),
            docketNumber: r.docketNumber ?? null,
            url,
            parties,
            matchLevel: matchLevel({ caseName, parties }, phrase),
            matchedEntry: entry
        });
    }
    return { total: typeof json?.count === 'number' ? json.count : null, records: out, more: Boolean(json?.next) };
}

/** The newest docket entry among RECAP documents: highest (entry_date_filed, entry_number). */
export function latestEntryFromDocuments(documents) {
    let best = null;
    for (const d of Array.isArray(documents) ? documents : []) {
        const date = dateOnly(d?.entry_date_filed);
        const number = Number.isInteger(d?.entry_number) ? d.entry_number : null;
        if (date === null && number === null) continue;
        const cand = {
            date,
            number,
            description: (d.short_description || d.description || '').replace(/\s+/g, ' ').trim().slice(0, 300) || null,
            url: absolute(d.absolute_url)
        };
        if (best === null || compareEntries(cand, best) > 0) best = cand;
    }
    return best;
}

/** Order two entries by date, then by entry number. A null sorts before any value. */
export function compareEntries(a, b) {
    const da = a?.date ?? '';
    const db = b?.date ?? '';
    if (da !== db) return da < db ? -1 : 1;
    const na = a?.number ?? -1;
    const nb = b?.number ?? -1;
    return na === nb ? 0 : (na < nb ? -1 : 1);
}

function decodeXml(text) {
    return String(text ?? '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&amp;/g, '&')
        .trim();
}

function tag(xml, name) {
    const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
    return m ? decodeXml(m[1]) : null;
}

/**
 * An SEC litigation-release or administrative-proceeding RSS feed → items. The release number is
 * `dc:creator` (LR-26645, 34-106468); the date is the feed's own `pubDate`, converted to the
 * calendar date in New York, which is the date the SEC itself puts on the release.
 */
export function parseSecFeed(xml, feed) {
    const items = [];
    for (const m of String(xml ?? '').matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const body = m[1];
        const title = tag(body, 'title');
        const link = tag(body, 'link');
        const number = tag(body, 'dc:creator');
        const pub = tag(body, 'pubDate');
        const parsed = pub ? new Date(pub) : null;
        const date = parsed && Number.isFinite(parsed.getTime())
            ? parsed.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) : null;
        const id = number || link;
        if (!id || !title) continue;
        items.push({
            key: `${feed.id}:${id}`,
            source: feed.id,
            externalId: id,
            caseName: title.replace(/\s+/g, ' ').trim(),
            description: tag(body, 'description'),
            court: feed.label,
            courtId: 'sec',
            dateFiled: date,
            publishedAt: parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null,
            docketNumber: number,
            url: link,
            parties: [],
            matchedEntry: null
        });
    }
    return items;
}

/**
 * The SEC items that name a watched phrase. A release's title IS its respondents, so a hit there is
 * a caption match. Returns one `{record, query}` pair per (item, query) hit.
 */
export function matchSecItems(items, queries) {
    const hits = [];
    for (const item of items) {
        const text = `${item.caseName}\n${item.description ?? ''}`;
        for (const q of queries) {
            if (!q.phrase) continue;
            if (!containsPhrase(text, q.phrase)) continue;
            hits.push({ record: { ...item, matchLevel: containsPhrase(item.caseName, q.phrase) ? 'caption' : 'text' }, query: q });
        }
    }
    return hits;
}

/**
 * True when the feed no longer reaches back to the previous poll: its oldest item is newer than
 * the last time we read it, so anything published in between may have scrolled off unseen.
 */
export function secFeedGap(items, lastPolledAt) {
    if (!lastPolledAt || items.length === 0) return false;
    const oldest = items.map((i) => i.publishedAt).filter(Boolean).sort()[0];
    return Boolean(oldest) && oldest > lastPolledAt;
}

// ---------------------------------------------------------------------------------------------
// Pacing and retry
// ---------------------------------------------------------------------------------------------

/** Statuses worth retrying: rate limited, or the server's own failure. */
export function retryable(status) {
    return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Backoff before retry `attempt` (1-based). A `Retry-After` in seconds is obeyed when it is
 * given; otherwise exponential from `baseMs`, capped at two minutes.
 */
export function backoffMs(attempt, { retryAfter = null, baseMs = 5000 } = {}) {
    const seconds = Number(retryAfter);
    if (retryAfter !== null && retryAfter !== '' && Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, 300_000);
    }
    return Math.min(baseMs * 2 ** (attempt - 1), 120_000);
}

// ---------------------------------------------------------------------------------------------
// Comparing against the stored state
// ---------------------------------------------------------------------------------------------

function union(a = [], b = []) {
    return [...new Set([...(a ?? []), ...(b ?? [])])].sort();
}

/** Better of two match levels. */
function strongest(a, b) {
    if (!a) return b;
    if (!b) return a;
    return MATCH_RANK[a] <= MATCH_RANK[b] ? a : b;
}

function sourceLabel(source) {
    return {
        'courtlistener-o': 'opinion',
        'courtlistener-r': 'RECAP docket',
        'sec-lr': 'SEC litigation release',
        'sec-ap': 'SEC administrative proceeding'
    }[source] ?? source;
}

function describeCase(record) {
    const bits = [record.court, record.docketNumber, record.dateFiled ? `filed ${record.dateFiled}` : null].filter(Boolean);
    return `${record.caseName ?? '(no caption)'}${bits.length ? ` (${bits.join(', ')})` : ''}`;
}

const LEVEL_WORDS = { caption: 'named in the caption', party: 'a named party', text: 'in the text only' };

/**
 * Fold one task's hits into the state and decide the events.
 *
 * - `previous` is the stored state, Map key → row (mutated: the merged rows are written back so a
 *   record two queries both return in one run is new only once).
 * - `baseline` is true when this query has never run before: its hits are recorded and raise
 *   nothing, so adding a query (or the first run) is not a flood of events for old cases.
 * - A record whose key has a `dismissed` decision is still recorded — `lastSeenAt` moves — but
 *   raises no event.
 *
 * Severity is `caution` when the name is in the caption or among the parties, `info` when it
 * matched only somewhere in the text: a transfer agent appears in thousands of creditor matrices,
 * and those are worth a line in the feed, not a flag on the issuer.
 */
export function foldHits(hits, { previous, query, baseline, detectedAt, review }) {
    const rows = [];
    const events = [];
    for (const record of hits) {
        const prev = previous.get(record.key) ?? null;
        const decision = review.get(record.key) ?? null;
        const queryLabel = query.phrase ?? `${query.courtId} ${query.docketNumber}`;
        const merged = {
            key: record.key,
            source: record.source,
            externalId: record.externalId,
            docketId: record.docketId ?? prev?.docketId ?? null,
            caseName: record.caseName ?? prev?.caseName ?? null,
            court: record.court ?? prev?.court ?? null,
            courtId: record.courtId ?? prev?.courtId ?? null,
            dateFiled: record.dateFiled ?? prev?.dateFiled ?? null,
            dateTerminated: record.dateTerminated ?? prev?.dateTerminated ?? null,
            docketNumber: record.docketNumber ?? prev?.docketNumber ?? null,
            url: record.url ?? prev?.url ?? null,
            parties: record.parties?.length ? record.parties : (prev?.parties ?? []),
            matchLevel: strongest(prev?.matchLevel, record.matchLevel),
            queries: union(prev?.queries, [queryLabel]),
            issuers: union(prev?.issuers, query.issuers),
            firstSeenAt: prev?.firstSeenAt ?? detectedAt,
            lastSeenAt: detectedAt,
            latestEntry: prev?.latestEntry ?? null,
            entriesCheckedAt: prev?.entriesCheckedAt ?? null,
            reviewStatus: decision?.status ?? 'candidate',
            reviewNote: decision?.reason ?? null
        };
        // The matched documents are a lower bound for the newest entry; never move it backwards.
        if (record.matchedEntry && compareEntries(record.matchedEntry, merged.latestEntry) > 0) {
            merged.latestEntry = record.matchedEntry;
        }
        previous.set(record.key, merged);
        rows.push(merged);
        if (prev !== null || baseline || merged.reviewStatus === 'dismissed') continue;
        const severity = record.matchLevel === 'text' ? 'info' : 'caution';
        for (const issuer of query.issuers) {
            events.push({
                detectedAt,
                kind: 'litigation',
                subjectType: 'issuer',
                subjectId: issuer,
                field: `case:${record.key}`,
                before: null,
                after: record.caseName,
                severity,
                summary: `New ${sourceLabel(record.source)}: ${describeCase(record)} — "${queryLabel}"`
                    + ` (${LEVEL_WORDS[record.matchLevel]}) for ${issuer}. A candidate for review, not a decision.`,
                evidence: {
                    url: record.url,
                    query: queryLabel,
                    source: record.source,
                    court: record.court,
                    docketNumber: record.docketNumber,
                    dateFiled: record.dateFiled,
                    matchLevel: record.matchLevel
                }
            });
        }
    }
    return { rows, events };
}

/**
 * The dockets whose entries are followed: RECAP dockets with the name in the caption, the known
 * dockets from caselaw-extra.json, and anything a human confirmed — never a dismissed one. The
 * least recently checked go first, and at most `limit` are checked per run.
 */
export function selectEntryChecks(rows, { limit = 30, pinned = new Set() } = {}) {
    return rows
        .filter((r) => r.source === 'courtlistener-r' && r.docketId !== null && r.docketId !== undefined)
        .filter((r) => r.reviewStatus !== 'dismissed')
        .filter((r) => r.matchLevel === 'caption' || r.reviewStatus === 'confirmed' || pinned.has(r.key))
        .sort((a, b) => {
            const pa = pinned.has(a.key) ? 0 : 1;
            const pb = pinned.has(b.key) ? 0 : 1;
            if (pa !== pb) return pa - pb;
            return String(a.entriesCheckedAt ?? '').localeCompare(String(b.entriesCheckedAt ?? ''));
        })
        .slice(0, limit);
}

/**
 * A docket's newest entry against the stored one. The first check is a baseline and raises
 * nothing; a later, newer entry is one `caution` event per issuer the docket is watched for.
 */
export function entryEvent(row, latest, { detectedAt }) {
    const prev = row.latestEntry ?? null;
    const next = { ...row, entriesCheckedAt: detectedAt };
    if (!latest) return { row: next, events: [] };
    const newer = compareEntries(latest, prev) > 0;
    if (newer) next.latestEntry = latest;
    if (!newer || prev === null || row.reviewStatus === 'dismissed' || row.entriesCheckedAt === null) {
        return { row: next, events: [] };
    }
    const events = row.issuers.map((issuer) => ({
        detectedAt,
        kind: 'litigation',
        subjectType: 'issuer',
        subjectId: issuer,
        field: `entry:${row.key}:${latest.number ?? latest.date}`,
        before: prev ? `${prev.date ?? '?'} #${prev.number ?? '?'}` : null,
        after: `${latest.date ?? '?'} #${latest.number ?? '?'}`,
        severity: 'caution',
        summary: `New docket entry in ${describeCase(row)}: #${latest.number ?? '?'} of ${latest.date ?? '?'}`
            + `${latest.description ? ` — ${latest.description.slice(0, 160)}` : ''}. For ${issuer}; a candidate for review.`,
        evidence: { url: latest.url ?? row.url, docketUrl: row.url, source: row.source, docketNumber: row.docketNumber, entry: latest }
    }));
    return { row: next, events };
}

/** Rows ranked for reading: caption first, then party, then text; newest filing first within. */
export function rankRows(rows) {
    return [...rows].sort((a, b) => {
        const la = MATCH_RANK[a.matchLevel] ?? 9;
        const lb = MATCH_RANK[b.matchLevel] ?? 9;
        if (la !== lb) return la - lb;
        return String(b.dateFiled ?? '').localeCompare(String(a.dateFiled ?? ''));
    });
}

// ---------------------------------------------------------------------------------------------
// SQL (psql over stdin, like every other loader here)
// ---------------------------------------------------------------------------------------------

/** Every stored case, as one JSON array on one line (read with psql -t -A). */
export function buildReadCasesQuery() {
    return "SELECT coalesce(jsonb_agg(jsonb_build_object(\n"
        + "  'key', id, 'source', source, 'externalId', external_id, 'docketId', docket_id,\n"
        + "  'caseName', case_name, 'court', court, 'courtId', court_id, 'dateFiled', date_filed,\n"
        + "  'dateTerminated', date_terminated, 'docketNumber', docket_number, 'url', url,\n"
        + "  'parties', parties, 'matchLevel', match_level, 'queries', queries, 'issuers', to_jsonb(issuers),\n"
        + "  'firstSeenAt', first_seen_at, 'lastSeenAt', last_seen_at, 'latestEntry', latest_entry,\n"
        + "  'entriesCheckedAt', entries_checked_at, 'reviewStatus', review_status, 'reviewNote', review_note)\n"
        + "  ORDER BY id), '[]'::jsonb) FROM sonar.litigation_case;\n";
}

/** Every query's run record, as one JSON array. */
export function buildReadQueriesQuery() {
    return "SELECT coalesce(jsonb_agg(jsonb_build_object('source', source, 'query', query,\n"
        + "  'firstRunAt', first_run_at, 'lastRunAt', last_run_at, 'lastTotal', last_total) ORDER BY source, query),\n"
        + "  '[]'::jsonb) FROM sonar.litigation_query;\n";
}

/** Timestamps as psql hands them back ("2026-09-23 08:00:00+00") → ISO, so string order is time order. */
export function normaliseStoredRows(rows) {
    const iso = (v) => (typeof v === 'string' && v ? new Date(v.replace(' ', 'T')).toISOString().replace(/\.\d{3}Z$/, 'Z') : v ?? null);
    return (Array.isArray(rows) ? rows : []).map((r) => ({
        ...r,
        docketId: r.docketId === null || r.docketId === undefined ? null : Number(r.docketId),
        firstSeenAt: iso(r.firstSeenAt),
        lastSeenAt: iso(r.lastSeenAt),
        entriesCheckedAt: iso(r.entriesCheckedAt),
        firstRunAt: iso(r.firstRunAt),
        lastRunAt: iso(r.lastRunAt),
        issuers: Array.isArray(r.issuers) ? r.issuers : [],
        queries: Array.isArray(r.queries) ? r.queries : [],
        parties: Array.isArray(r.parties) ? r.parties : []
    }));
}

/**
 * Upsert case rows. `first_seen_at` is never overwritten; everything else is the merged state
 * foldHits/entryEvent computed. The IS DISTINCT FROM guard keeps an unchanged row's updated_at.
 */
export function buildCaseUpsertSql(rows, { tag = 'sonar' } = {}) {
    const doc = { rows: rows.map((r) => ({ ...r, latestEntry: r.latestEntry ?? null })) };
    const sql = `WITH doc AS (SELECT ${jsonbLiteral(doc, tag)} AS d),\n`
        + "     src AS (SELECT x.r FROM doc, jsonb_array_elements(d->'rows') AS x(r))\n"
        + 'INSERT INTO sonar.litigation_case AS c\n'
        + '       (id, source, external_id, docket_id, case_name, court, court_id, date_filed, date_terminated,\n'
        + '        docket_number, url, parties, match_level, queries, issuers, first_seen_at, last_seen_at,\n'
        + '        latest_entry, latest_entry_date, entries_checked_at, review_status, review_note)\n'
        + "SELECT r->>'key', r->>'source', r->>'externalId', (r->>'docketId')::bigint, r->>'caseName',\n"
        + "       r->>'court', r->>'courtId', (r->>'dateFiled')::date, (r->>'dateTerminated')::date,\n"
        + "       r->>'docketNumber', r->>'url', coalesce(r->'parties', '[]'::jsonb), r->>'matchLevel',\n"
        + "       coalesce(r->'queries', '[]'::jsonb),\n"
        + "       ARRAY(SELECT jsonb_array_elements_text(coalesce(r->'issuers', '[]'::jsonb)) ORDER BY 1),\n"
        + "       (r->>'firstSeenAt')::timestamptz, (r->>'lastSeenAt')::timestamptz,\n"
        + "       CASE WHEN jsonb_typeof(r->'latestEntry') = 'object' THEN r->'latestEntry' END,\n"
        + "       (r->'latestEntry'->>'date')::date, (r->>'entriesCheckedAt')::timestamptz,\n"
        + "       r->>'reviewStatus', r->>'reviewNote'\n"
        + '  FROM src\n'
        + 'ON CONFLICT (id) DO UPDATE SET\n'
        + '       docket_id = EXCLUDED.docket_id, case_name = EXCLUDED.case_name, court = EXCLUDED.court,\n'
        + '       court_id = EXCLUDED.court_id, date_filed = EXCLUDED.date_filed,\n'
        + '       date_terminated = EXCLUDED.date_terminated, docket_number = EXCLUDED.docket_number,\n'
        + '       url = EXCLUDED.url, parties = EXCLUDED.parties, match_level = EXCLUDED.match_level,\n'
        + '       queries = EXCLUDED.queries, issuers = EXCLUDED.issuers, last_seen_at = EXCLUDED.last_seen_at,\n'
        + '       latest_entry = EXCLUDED.latest_entry, latest_entry_date = EXCLUDED.latest_entry_date,\n'
        + '       entries_checked_at = EXCLUDED.entries_checked_at, review_status = EXCLUDED.review_status,\n'
        + '       review_note = EXCLUDED.review_note, updated_at = now()\n'
        + ' WHERE (c.docket_id, c.case_name, c.court, c.court_id, c.date_filed, c.date_terminated, c.docket_number,\n'
        + '        c.url, c.parties, c.match_level, c.queries, c.issuers, c.last_seen_at, c.latest_entry,\n'
        + '        c.entries_checked_at, c.review_status, c.review_note)\n'
        + '       IS DISTINCT FROM\n'
        + '       (EXCLUDED.docket_id, EXCLUDED.case_name, EXCLUDED.court, EXCLUDED.court_id, EXCLUDED.date_filed,\n'
        + '        EXCLUDED.date_terminated, EXCLUDED.docket_number, EXCLUDED.url, EXCLUDED.parties,\n'
        + '        EXCLUDED.match_level, EXCLUDED.queries, EXCLUDED.issuers, EXCLUDED.last_seen_at,\n'
        + '        EXCLUDED.latest_entry, EXCLUDED.entries_checked_at, EXCLUDED.review_status, EXCLUDED.review_note);\n';
    return { table: 'sonar.litigation_case', rows: rows.length, sql };
}

/** Record one query run: its first run is kept, the last run and hit count move. */
export function buildQueryRunSql(runs, { tag = 'sonar' } = {}) {
    const sql = `WITH doc AS (SELECT ${jsonbLiteral({ runs }, tag)} AS d),\n`
        + "     src AS (SELECT x.r FROM doc, jsonb_array_elements(d->'runs') AS x(r))\n"
        + 'INSERT INTO sonar.litigation_query AS q (source, query, issuers, origins, first_run_at, last_run_at, last_total)\n'
        + "SELECT r->>'source', r->>'query',\n"
        + "       ARRAY(SELECT jsonb_array_elements_text(coalesce(r->'issuers', '[]'::jsonb)) ORDER BY 1),\n"
        + "       coalesce(r->'origins', '[]'::jsonb), (r->>'runAt')::timestamptz, (r->>'runAt')::timestamptz,\n"
        + "       (r->>'total')::int\n"
        + '  FROM src\n'
        + 'ON CONFLICT (source, query) DO UPDATE SET\n'
        + '       issuers = EXCLUDED.issuers, origins = EXCLUDED.origins, last_run_at = EXCLUDED.last_run_at,\n'
        + '       last_total = EXCLUDED.last_total, updated_at = now();\n';
    return { table: 'sonar.litigation_query', rows: runs.length, sql };
}

// ---------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------

/** One Telegram message per run: counts, the first few events, the failures. Plain text. */
export function formatTelegramSummary({ events, failures, queries, requests, durationMs, recorded }) {
    const lines = [`RWA Sonar case-law watch: ${events.length} new event(s), ${failures.length} failure(s)`];
    lines.push(`${queries} quer${queries === 1 ? 'y' : 'ies'} · ${requests} request(s) · ${recorded} record(s) · ${(durationMs / 1000).toFixed(0)} s`);
    const top = [...events].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'caution' ? -1 : 1)).slice(0, 8);
    for (const e of top) lines.push(`• [${e.severity}] ${e.summary.slice(0, 220)}`);
    if (events.length > top.length) lines.push(`… and ${events.length - top.length} more in sonar.change_event (kind litigation)`);
    for (const f of failures.slice(0, 5)) lines.push(`✗ ${f.slice(0, 200)}`);
    if (failures.length > 5) lines.push(`… and ${failures.length - 5} more failure(s)`);
    lines.push('Nothing is marked litigated automatically — each event is for review.');
    return lines.join('\n');
}
