// Unit tests for stocks/lib/caselaw.mjs — the case-law watcher's decisions. Each test guards
// something a reader of the litigation feed would notice if it broke: a party searched under a
// brand that matches thousands of unrelated dockets, a legal name the dossier spells out but the
// watcher misses, a caption match read as text-only (or the reverse), a first run that floods the
// change feed with decades-old cases, a dismissed docket that keeps raising events, a docket entry
// counted as new twice, and SQL naming a column the DDL does not have.
//
// The CourtListener and SEC fixtures in fixtures/caselaw/ are REAL responses captured on
// 2026-09-23 (search type=r for "Securitize I, Inc.", type=o for "Payward", type=rd for docket
// 73511778, and the SEC litigation-release RSS feed), trimmed to a few results each.

import { readdirSync, readFileSync } from 'node:fs';

import {
    STOPLIST, backoffMs, buildCaseUpsertSql, buildQueryRunSql, compareEntries, containsPhrase,
    courtListenerUrl, deriveQueries, entryEvent, expandPartyName, extractLegalEntities, foldHits,
    formatTelegramSummary, issuerBrand, latestEntryFromDocuments, matchLevel, matchSecItems,
    normalisePhrase, normaliseStoredRows, parseCourtListenerResults, parseSecFeed, rankRows, retryable,
    reviewIndex, saysUnrelated, secFeedGap, selectEntryChecks, validateExtra
} from './lib/caselaw.mjs';
import { buildChangeEventSql } from './lib/watch.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/caselaw/${name}`, import.meta.url), 'utf8');
const SEARCH_R = JSON.parse(fixture('search-r-securitize.json'));
const SEARCH_O = JSON.parse(fixture('search-o-payward.json'));
const ENTRIES = JSON.parse(fixture('entries-rd-73511778.json'));
const SEC_XML = fixture('sec-litigation-releases.xml');
const CASELAW_DDL = readFileSync(new URL('../db/2026-09-23-sonar-caselaw.sql', import.meta.url), 'utf8');
const EVIDENCE_DDL = readFileSync(new URL('../db/2026-09-18-sonar-evidence.sql', import.meta.url), 'utf8');
const AT = '2026-09-23T08:00:00Z';
const LATER = '2026-09-24T04:23:00Z';

const names = (text) => extractLegalEntities(text).map((e) => e.name);

function realDossiers() {
    const dir = new URL('./data/issuers/', import.meta.url);
    return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => ({
        slug: f.replace(/\.json$/, ''),
        dossier: JSON.parse(readFileSync(new URL(f, dir), 'utf8'))
    }));
}

describe('names and phrases', () => {
    test('punctuation and case do not matter, as they do not to CourtListener', () => {
        expect(normalisePhrase('Payward, Inc.')).toBe('payward inc');
        expect(containsPhrase('In re PAYWARD INC. et al.', 'Payward, Inc.')).toBe(true);
        expect(containsPhrase('Continental Stock Transfer and Trust Company', 'Continental Stock Transfer & Trust Company')).toBe(true);
    });

    test('a phrase matches on word boundaries only', () => {
        expect(containsPhrase('Paywardian Holdings v. X', 'Payward')).toBe(false);
        expect(containsPhrase('Securitize I, Inc. v. tZERO', 'Securitize I, Inc.')).toBe(true);
    });
});

describe('extractLegalEntities', () => {
    test('takes whole legal names, suffix and all', () => {
        const text = '100% of Backed Finance AG purchased by Payward Europe Limited (Ireland), a wholly owned subsidiary of'
            + ' Payward, Inc. (Kraken, US). Issuer Backed Assets (JE) Limited, Jersey.';
        expect(names(text)).toEqual(['Backed Finance AG', 'Payward Europe Limited', 'Payward, Inc.', 'Backed Assets (JE) Limited']);
    });

    test('an ampersand name and a Company, LLC chain are one name each', () => {
        expect(names('The Transfer Agent is Continental Stock Transfer & Trust Company.')).toEqual(['Continental Stock Transfer & Trust Company']);
        expect(names('Register maintained by Equiniti Trust Company, LLC — SEC File No. 084-00416'))
            .toEqual(['Equiniti Trust Company, LLC']);
        expect(names('UAE Trek Labs Ltd FZE (VARA-licensed)')).toEqual(['Trek Labs Ltd FZE']);
    });

    test('a description is not a name: lower-case forms, generic words, jurisdictions', () => {
        expect(names('Bullish (Cayman Islands company; principal office)')).toEqual([]);
        expect(names('a Delaware LLC formed in 2025')).toEqual([]);
        expect(names('MINS LLC, Trust Company Complex, Ajeltake Road')).toEqual(['MINS LLC']);
    });

    test('"and" separates two names, and a misprinted double suffix ends at the first', () => {
        expect(names('relies on DekaBank and ALPACADB LTD as custodians')).toEqual(['ALPACADB LTD']);
        // The prospectus's own typo "Alpaca Securities LLC AG" must still yield the real name.
        expect(names('Alpaca Securities LLC AG will be acting as U.S. Broker')).toEqual(['Alpaca Securities LLC']);
    });

    test('label words and a sentence-final period are not part of the name', () => {
        expect(names('Parent Backed Finance AG (CH).')).toEqual(['Backed Finance AG']);
        expect(names('sole member Bullish US Holdings LLC.')).toEqual(['Bullish US Holdings LLC']);
        expect(names('Manager: OpenDeal Inc. (149 5th Ave)')).toEqual(['OpenDeal Inc.']);
    });

    test('a name stops at an opening parenthesis', () => {
        expect(names('Superstate (Superstate Inc. / Superstate Services LLC) — Opening Bell'))
            .toEqual(['Superstate Inc.', 'Superstate Services LLC']);
    });
});

describe('saysUnrelated', () => {
    test('a dossier naming an entity only to disclaim it does not make it a watch', () => {
        const text = "Note: 'Remora Capital Corporation' (Maryland, SEC CIK 2045370) is a middle-market credit BDC and is NOT related.";
        const [entity] = extractLegalEntities(text);
        expect(entity.name).toBe('Remora Capital Corporation');
        expect(saysUnrelated(text, entity.index)).toBe(true);
        const other = 'Step Finance said Remora Capital Corporation acquired it. Unrelated sentence follows.';
        const [e2] = extractLegalEntities(other);
        expect(saysUnrelated(other, e2.index)).toBe(false);
    });
});

describe('deriveQueries', () => {
    const dossier = (over) => ({ issuer: '', issuingEntity: '', parties: {}, whatIf: [], ...over });

    test('an over-broad brand is replaced by the legal name the dossier spells out', () => {
        const { queries, dropped } = deriveQueries([{
            slug: 'x',
            dossier: dossier({
                issuingEntity: 'Backed Assets (JE) Limited; parent purchased by a subsidiary of Payward, Inc. (Kraken, US).',
                parties: { tokenizationProviders: [{ name: 'Kraken', note: 'Tokenization Services Agreement with Payward, Inc.' }] }
            })
        }]);
        const phrases = queries.map((q) => q.phrase);
        expect(phrases).toContain('Payward, Inc.');
        expect(phrases.map(normalisePhrase)).not.toContain('kraken');
        expect(dropped.map((d) => d.name)).toContain('Kraken');
        expect(STOPLIST.has('kraken')).toBe(true);
    });

    test('a short party name expands to every legal name beginning with it', () => {
        expect(expandPartyName('Alpaca Securities', ['Alpaca Securities LLC', 'Alpaca Crypto LLC', 'Other Securities LLC']))
            .toEqual(['Alpaca Securities LLC']);
        expect(expandPartyName('OpenDeal (Republic)', ['OpenDeal Inc.', 'OpenDeal Portal LLC'])).toEqual(['OpenDeal Inc.', 'OpenDeal Portal LLC']);
        const { queries } = deriveQueries([{
            slug: 's',
            dossier: dossier({
                parties: { tokenizationProviders: [{ name: 'Securitize', note: 'patent suit names Securitize I, Inc. and Securitize Markets, LLC' }] }
            })
        }]);
        expect(queries.map((q) => q.phrase).sort()).toEqual(['Securitize I, Inc.', 'Securitize Markets, LLC']);
    });

    test('one query per name across issuers, carrying every issuer and origin', () => {
        const a = dossier({ parties: { custodians: [{ name: 'BitGo Trust Company' }] } });
        const b = dossier({ parties: { custodians: [{ name: 'BitGo Trust Company' }] } });
        const { queries } = deriveQueries([{ slug: 'a', dossier: a }, { slug: 'b', dossier: b }]);
        const bitgo = queries.filter((q) => q.phrase === 'BitGo Trust Company');
        expect(bitgo).toHaveLength(1);
        expect(bitgo[0].issuers).toEqual(['a', 'b']);
        expect(bitgo[0].origins.map((o) => o.from)).toEqual(['parties.custodians', 'parties.custodians']);
    });

    test('a longer name the shorter one already finds is folded into it', () => {
        const { queries } = deriveQueries([{
            slug: 't',
            dossier: dossier({ issuingEntity: 'Trek Labs Ltd operates the exchange; UAE Trek Labs Ltd FZE is licensed.' })
        }]);
        const trek = queries.find((q) => q.phrase === 'Trek Labs Ltd');
        expect(trek.covers).toEqual(['Trek Labs Ltd FZE']);
        expect(queries.map((q) => q.phrase)).not.toContain('Trek Labs Ltd FZE');
    });

    test('verification agents only when they are the security agent; distributors never', () => {
        const { queries } = deriveQueries([{
            slug: 'x',
            dossier: dossier({
                parties: {
                    verificationAgents: [{ name: 'Ankura Trust Company', note: 'Both Verification Agent and Security Agent.' },
                        { name: 'The Network Firm', note: 'Operates the attestation API.' }],
                    distributors: [{ name: 'Jupiter' }]
                }
            })
        }]);
        const phrases = queries.map((q) => q.phrase);
        expect(phrases).toContain('Ankura Trust Company');
        expect(phrases).not.toContain('The Network Firm');
        expect(phrases).not.toContain('Jupiter');
    });

    test('prior CourtListener searches are reported when not covered, never searched blindly', () => {
        const { queries, priorNotWatched } = deriveQueries([{
            slug: 'x',
            dossier: dossier({
                issuingEntity: 'Backed Assets (JE) Limited',
                whatIf: [{ searched: ['https://www.courtlistener.com/api/rest/v4/search/?q=%22tracker+certificate%22',
                    'https://www.courtlistener.com/api/rest/v4/search/ — "Backed Assets (JE) Limited", "tokenized"'] }]
            })
        }]);
        expect(queries.map((q) => q.phrase)).not.toContain('tokenized');
        expect(priorNotWatched.map((p) => p.phrase)).toEqual(['tokenized', 'tracker certificate']);
    });

    test('the known dockets come from caselaw-extra.json as docket queries', () => {
        const extra = JSON.parse(readFileSync(new URL('./data/caselaw-extra.json', import.meta.url), 'utf8'));
        validateExtra(extra);
        const { queries } = deriveQueries([], { extra });
        expect(queries.map((q) => q.id)).toEqual(['docket:ded:1:26-cv-00698', 'docket:ded:1:26-cv-00722']);
        expect(queries.every((q) => q.issuers.includes('securitize-secz'))).toBe(true);
        expect(() => validateExtra({ dockets: [{ name: 'x', courtId: 'ded' }] })).toThrow(/docketNumber is required/);
    });

    test('the issuer brand is its leading name', () => {
        expect(issuerBrand({ issuer: 'Remora Markets (formerly Moose Capital; subsidiary of Step Finance) — WOUND DOWN' })).toBe('Remora Markets');
        expect(issuerBrand({ issuer: 'RepublicX LLC — a Delaware LLC' })).toBe('RepublicX LLC');
    });

    test('over the REAL dossiers: legal names in, broad brands out, and the committed file is current', () => {
        const extra = JSON.parse(readFileSync(new URL('./data/caselaw-extra.json', import.meta.url), 'utf8'));
        const derived = deriveQueries(realDossiers(), { extra });
        const phrases = derived.queries.filter((q) => q.phrase).map((q) => normalisePhrase(q.phrase));
        for (const want of ['Payward, Inc.', 'Securitize I, Inc.', 'Alpaca Securities LLC', 'Backed Assets (JE) Limited',
            'Continental Stock Transfer & Trust Company', 'Superstate Services LLC', 'Trek Nexus Markets Ltd']) {
            expect(phrases).toContain(normalisePhrase(want));
        }
        for (const broad of ['kraken', 'alpaca', 'bullish', 'turnkey', 'securitize', 'shift', 'tessera']) {
            expect(phrases).not.toContain(broad);
        }
        // Disclaimed in the Remora dossier as NOT related.
        expect(phrases).not.toContain('remora capital corporation');
        const committed = JSON.parse(readFileSync(new URL('./data/caselaw-queries.json', import.meta.url), 'utf8'));
        expect(committed.queries).toEqual(JSON.parse(JSON.stringify(derived.queries)));
    });
});

describe('CourtListener parsing', () => {
    test('RECAP dockets become records keyed by docket id, with the source\'s own dates', () => {
        const { total, records } = parseCourtListenerResults(SEARCH_R, { type: 'r', phrase: 'Securitize I, Inc.' });
        expect(total).toBe(2);
        const tzero = records.find((r) => r.externalId === '73511778');
        expect(tzero.key).toBe('courtlistener-r:73511778');
        expect(tzero.caseName).toBe('Securitize I, Inc. v. tZERO Group, Inc.');
        expect(tzero.dateFiled).toBe('2026-06-22');
        expect(tzero.docketNumber).toBe('1:26-cv-00722');
        expect(tzero.url).toBe('https://www.courtlistener.com/docket/73511778/securitize-i-inc-v-tzero-group-inc/');
        expect(tzero.matchLevel).toBe('caption');
        expect(tzero.matchedEntry.date).toMatch(/^2026-/);
    });

    test('caption, then named party, then text — ranked in that order', () => {
        const [first] = parseCourtListenerResults(SEARCH_R, { type: 'r', phrase: 'tZERO Group, Inc.' }).records
            .filter((r) => r.externalId === '73511778');
        expect(first.matchLevel).toBe('caption');
        expect(matchLevel({ caseName: 'Liquid Rarity Exchange, LLC v. Securitize I, Inc.', parties: ['Securitize, Inc.'] }, 'Securitize, Inc.')).toBe('party');
        expect(matchLevel({ caseName: 'In re FTX Trading Ltd.', parties: [] }, 'Trek Labs Ltd')).toBe('text');
        const ranked = rankRows([
            { key: 't', matchLevel: 'text', dateFiled: '2026-09-01' },
            { key: 'c', matchLevel: 'caption', dateFiled: '2020-01-01' },
            { key: 'p', matchLevel: 'party', dateFiled: '2026-01-01' },
            { key: 'c2', matchLevel: 'caption', dateFiled: '2025-01-01' }
        ]);
        expect(ranked.map((r) => r.key)).toEqual(['c2', 'c', 'p', 't']);
    });

    test('opinions are keyed by cluster; a Payward hit in the text only is `text`', () => {
        const { records } = parseCourtListenerResults(SEARCH_O, { type: 'o', phrase: 'Payward' });
        expect(records[0].key).toBe('courtlistener-o:10128187');
        expect(records[0].caseName).toBe('Cure & Assoc v. LPL Financial');
        expect(records[0].matchLevel).toBe('text');
    });

    test('the newest docket entry is the latest date, then the highest number', () => {
        const latest = latestEntryFromDocuments(ENTRIES.results);
        expect(latest).toMatchObject({ date: '2026-09-18', number: 27 });
        expect(compareEntries({ date: '2026-09-18', number: 27 }, { date: '2026-09-18', number: 26 })).toBe(1);
        expect(compareEntries({ date: '2026-09-18', number: null }, null)).toBe(1);
    });

    test('search URLs are exact-phrase, newest first; entries by docket id', () => {
        const url = new URL(courtListenerUrl({ kind: 'search', type: 'r', phrase: 'Payward, Inc.' }));
        expect(url.searchParams.get('q')).toBe('"Payward, Inc."');
        expect(url.searchParams.get('order_by')).toBe('dateFiled desc');
        const docket = new URL(courtListenerUrl({ kind: 'docket', courtId: 'ded', docketNumber: '1:26-cv-00722' }));
        expect(docket.searchParams.get('q')).toBe('docketNumber:"1:26-cv-00722"');
        expect(docket.searchParams.get('court')).toBe('ded');
        expect(new URL(courtListenerUrl({ kind: 'entries', docketId: 5 })).searchParams.get('type')).toBe('rd');
    });
});

describe('SEC feeds', () => {
    const feed = { id: 'sec-lr', label: 'SEC litigation release' };
    const items = parseSecFeed(SEC_XML, feed);

    test('each item is keyed by its release number and dated in New York time', () => {
        expect(items).toHaveLength(6);
        expect(items[0]).toMatchObject({ key: 'sec-lr:LR-26645', caseName: 'Lawrence Billimek and Alan Williams', dateFiled: '2026-09-22' });
        expect(items[0].url).toBe('https://www.sec.gov/enforcement-litigation/litigation-releases/lr-26645');
    });

    test('a watched phrase in the title is a caption match; others are ignored', () => {
        const hits = matchSecItems(items, [
            { phrase: 'Wavemark Capital, LLC', issuers: ['x'] },
            { phrase: 'Payward, Inc.', issuers: ['y'] }
        ]);
        expect(hits).toHaveLength(1);
        expect(hits[0].record).toMatchObject({ key: 'sec-lr:LR-26643', matchLevel: 'caption' });
    });

    test('a feed that no longer reaches back to the last poll is a gap', () => {
        expect(secFeedGap(items, '2026-09-20T00:00:00Z')).toBe(false);
        expect(secFeedGap(items, '2026-08-01T00:00:00Z')).toBe(true);
        expect(secFeedGap(items, null)).toBe(false);
    });
});

describe('foldHits: what becomes an event', () => {
    const record = (over = {}) => ({
        key: 'courtlistener-r:1', source: 'courtlistener-r', externalId: '1', docketId: 1, caseName: 'Payward, Inc. v. Doe',
        court: 'D. Del.', courtId: 'ded', dateFiled: '2026-09-20', docketNumber: '1:26-cv-1', url: 'https://x/1',
        parties: [], matchLevel: 'caption', matchedEntry: null, ...over
    });
    const query = { phrase: 'Payward, Inc.', issuers: ['xstocks-backed', 'other'] };

    test('a baseline run records everything and raises nothing', () => {
        const previous = new Map();
        const { rows, events } = foldHits([record()], { previous, query, baseline: true, detectedAt: AT, review: new Map() });
        expect(rows).toHaveLength(1);
        expect(events).toEqual([]);
        expect(previous.get('courtlistener-r:1').firstSeenAt).toBe(AT);
    });

    test('a new case after the baseline is one caution event per issuer, never a litigated status', () => {
        const { events } = foldHits([record()], { previous: new Map(), query, baseline: false, detectedAt: AT, review: new Map() });
        expect(events.map((e) => e.subjectId)).toEqual(['xstocks-backed', 'other']);
        expect(events[0]).toMatchObject({ kind: 'litigation', subjectType: 'issuer', severity: 'caution', field: 'case:courtlistener-r:1' });
        expect(events[0].summary).toContain('Payward, Inc. v. Doe');
        expect(events[0].summary).toContain('not a decision');
        expect(events[0].evidence).toMatchObject({ url: 'https://x/1', query: 'Payward, Inc.' });
        expect(JSON.stringify(events)).not.toContain('"litigated"');
    });

    test('a text-only hit is info, not caution', () => {
        const { events } = foldHits([record({ matchLevel: 'text' })], { previous: new Map(), query, baseline: false, detectedAt: AT, review: new Map() });
        expect(events.every((e) => e.severity === 'info')).toBe(true);
    });

    test('a case seen before is not new; its first sighting survives, its queries accumulate', () => {
        const previous = new Map();
        foldHits([record()], { previous, query, baseline: true, detectedAt: AT, review: new Map() });
        const { events, rows } = foldHits([record()], {
            previous, query: { phrase: 'Payward Europe Limited', issuers: ['xstocks-backed'] }, baseline: false, detectedAt: LATER, review: new Map()
        });
        expect(events).toEqual([]);
        expect(rows[0].firstSeenAt).toBe(AT);
        expect(rows[0].lastSeenAt).toBe(LATER);
        expect(rows[0].queries).toEqual(['Payward Europe Limited', 'Payward, Inc.']);
    });

    test('a dismissed case is recorded but raises nothing', () => {
        const review = reviewIndex({ decisions: [{ key: 'courtlistener-r:1', status: 'dismissed', reason: 'consumer crypto dispute', reviewedAt: AT }] });
        const { rows, events } = foldHits([record()], { previous: new Map(), query, baseline: false, detectedAt: AT, review });
        expect(events).toEqual([]);
        expect(rows[0]).toMatchObject({ reviewStatus: 'dismissed', reviewNote: 'consumer crypto dispute' });
    });

    test('a review decision needs a known status and a reason', () => {
        expect(() => reviewIndex({ decisions: [{ key: 'k', status: 'litigated', reason: 'x' }] })).toThrow(/dismissed or confirmed/);
        expect(() => reviewIndex({ decisions: [{ key: 'k', status: 'dismissed' }] })).toThrow(/reason/);
    });
});

describe('docket entries', () => {
    const row = {
        key: 'courtlistener-r:73511778', source: 'courtlistener-r', docketId: 73511778, caseName: 'Securitize I, Inc. v. tZERO Group, Inc.',
        court: 'District Court, D. Delaware', docketNumber: '1:26-cv-00722', url: 'https://x', issuers: ['securitize-secz'],
        matchLevel: 'caption', reviewStatus: 'candidate', latestEntry: null, entriesCheckedAt: null
    };
    const latest = { date: '2026-09-18', number: 27, description: 'Answering Brief in Opposition', url: 'https://x/27' };

    test('the first check is a baseline', () => {
        const { row: next, events } = entryEvent(row, latest, { detectedAt: AT });
        expect(events).toEqual([]);
        expect(next).toMatchObject({ latestEntry: latest, entriesCheckedAt: AT });
    });

    test('a newer entry after that is a caution event; the same entry is nothing', () => {
        const checked = entryEvent(row, latest, { detectedAt: AT }).row;
        expect(entryEvent(checked, latest, { detectedAt: LATER }).events).toEqual([]);
        const newer = { date: '2026-09-25', number: 28, description: 'Reply Brief', url: 'https://x/28' };
        const { events } = entryEvent(checked, newer, { detectedAt: LATER });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ kind: 'litigation', subjectId: 'securitize-secz', severity: 'caution', field: 'entry:courtlistener-r:73511778:28' });
        expect(events[0].before).toBe('2026-09-18 #27');
    });

    test('followed dockets: captions, confirmed and pinned, never dismissed; pinned and oldest first', () => {
        const rows = [
            { ...row, key: 'a', docketId: 1, entriesCheckedAt: '2026-09-20T00:00:00Z' },
            { ...row, key: 'b', docketId: 2, matchLevel: 'text' },
            { ...row, key: 'c', docketId: 3, matchLevel: 'text', reviewStatus: 'confirmed', entriesCheckedAt: '2026-09-19T00:00:00Z' },
            { ...row, key: 'd', docketId: 4, reviewStatus: 'dismissed' },
            { ...row, key: 'e', docketId: 5, entriesCheckedAt: '2026-09-22T00:00:00Z' },
            { ...row, key: 'o', source: 'courtlistener-o', docketId: 6 }
        ];
        expect(selectEntryChecks(rows, { limit: 10, pinned: new Set(['e']) }).map((r) => r.key)).toEqual(['e', 'c', 'a']);
        expect(selectEntryChecks(rows, { limit: 1 }).map((r) => r.key)).toEqual(['c']);
    });
});

describe('retry and pacing decisions', () => {
    test('429 and 5xx are retried; 4xx are not', () => {
        expect(retryable(429)).toBe(true);
        expect(retryable(503)).toBe(true);
        expect(retryable(404)).toBe(false);
        expect(retryable(403)).toBe(false);
    });

    test('Retry-After is obeyed, otherwise exponential and capped', () => {
        expect(backoffMs(1, { retryAfter: '30' })).toBe(30_000);
        expect(backoffMs(1)).toBe(5000);
        expect(backoffMs(3)).toBe(20_000);
        expect(backoffMs(10)).toBe(120_000);
    });
});

describe('SQL and DDL', () => {
    test('every column the upsert writes is declared in the DDL', () => {
        const declared = CASELAW_DDL.match(/CREATE TABLE IF NOT EXISTS sonar\.litigation_case \(([\s\S]*?)\n\);/)[1]
            .split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((c) => /^[a-z_]+$/.test(c));
        const { sql } = buildCaseUpsertSql([{ key: 'k', source: 'courtlistener-r', matchLevel: 'caption' }]);
        const written = sql.match(/INSERT INTO sonar\.litigation_case AS c\n\s+\(([\s\S]*?)\)\n/)[1].split(',').map((c) => c.trim());
        expect(written.filter((c) => !declared.includes(c))).toEqual([]);
        expect(sql).toContain('ON CONFLICT (id) DO UPDATE');
        // first_seen_at is set once and never overwritten.
        expect(sql.split('DO UPDATE SET')[1]).not.toContain('first_seen_at');
    });

    test('the query-run upsert keeps the first run', () => {
        const { sql } = buildQueryRunSql([{ source: 'courtlistener-r', query: 'x', issuers: ['a'], origins: [], runAt: AT, total: 3 }]);
        expect(sql.split('DO UPDATE SET')[1]).not.toContain('first_run_at');
    });

    test('`litigation` is an allowed event kind in BOTH files that restate the constraint', () => {
        // evidence.sql is re-applied by load-db and watch-sources on every run; if it did not carry
        // `litigation`, its DROP+ADD would fail against the stored events.
        const lastList = (ddl) => [...ddl.matchAll(/ADD CONSTRAINT change_event_kind_check CHECK \(kind IN \(([\s\S]*?)\)\)/g)].at(-1)[1];
        expect(lastList(CASELAW_DDL)).toContain("'litigation'");
        expect(lastList(EVIDENCE_DDL)).toContain("'litigation'");
        expect(lastList(CASELAW_DDL).replace(/\s+/g, ' ')).toBe(lastList(EVIDENCE_DDL).replace(/\s+/g, ' '));
    });

    test('events go through the shared change_event loader', () => {
        const { events } = foldHits([{ key: 'k', source: 'sec-lr', caseName: "O'Brien; X LLC", matchLevel: 'caption', parties: [] }],
            { previous: new Map(), query: { phrase: 'X LLC', issuers: ['a'] }, baseline: false, detectedAt: AT, review: new Map() });
        const { sql } = buildChangeEventSql(events);
        expect(sql).toContain('"kind":"litigation"');
        expect(sql).toContain("O'Brien");
    });

    test('stored rows read back with ISO timestamps and numeric docket ids', () => {
        const [row] = normaliseStoredRows([{ key: 'k', docketId: '73511778', firstSeenAt: '2026-09-23T08:00:00+00:00', issuers: null }]);
        expect(row).toMatchObject({ docketId: 73511778, firstSeenAt: AT, issuers: [] });
    });
});

describe('formatTelegramSummary', () => {
    test('one message: counts, caution before info, and the no-auto-litigated reminder', () => {
        const events = [
            { severity: 'info', summary: 'text-only hit' },
            { severity: 'caution', summary: 'caption hit' }
        ];
        const text = formatTelegramSummary({ events, failures: ['r:phrase:x: HTTP 503'], queries: 66, requests: 150, durationMs: 300000, recorded: 90 });
        expect(text.split('\n')[0]).toBe('RWA Sonar case-law watch: 2 new event(s), 1 failure(s)');
        expect(text.indexOf('caption hit')).toBeLessThan(text.indexOf('text-only hit'));
        expect(text).toContain('Nothing is marked litigated automatically');
    });
});
