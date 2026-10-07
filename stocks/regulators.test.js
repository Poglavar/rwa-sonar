// Unit tests for stocks/lib/regulators.mjs — the regulator-notice watcher's decisions. Each test
// guards something a reader of the regulator feed would notice if it broke: a parser that silently
// reads nothing after a site change, a notice stamped with our fetch time instead of the
// regulator's date, "Ltd" and "Limited" read as different firms, a brand mention counted as a full
// legal-name hit, a first run that floods the feed with years-old warnings, a source that fails
// every day without failing the run, and SQL naming a column the DDL does not have.
//
// The fixtures in fixtures/regulators/ are REAL responses captured on 2026-09-30, trimmed to a few
// items each (BrokerCheck fetched via valhalla: the laptop IP is behind FINRA's WAF).

import { readdirSync, readFileSync } from 'node:fs';

import { deriveQueries } from './lib/caselaw.mjs';
import {
    ROUTINE_FORMS, SOURCES, brokerCheckNames, buildCheckSql, buildMatchUpsertSql, canonicalName, checkVerdict,
    deriveWatchNames, distinctiveCore, fcaDates, feedGap, foldMatches, formatTelegramSummary, knownBlock, matchKey, matchNotices,
    nameCore, nameStrength, normaliseStoredChecks, normaliseStoredMatches, numericDate, parseAsicReleases,
    parseBafinMeasures, parseBafinNews, parseBrokerCheckFirm, parseBrokerCheckSearch, parseCbiUnauthorised,
    parseCftcEnforcement, parseCima, parseCsv, parseEdgarSearch, parseEsmaNcasp, parseEsmaSanctions,
    parseFcaNews, parseFcaPublications, parseFcaWarnings, parseFinmaNews, parseFinmaWarnings, parseFinraDisciplinary,
    parseFmaLi, parseMasAlerts, parseSecPressReleases, parseSecSuspensions, parseSmvAlerts, rfc822Dates, runVerdict, selectSources, zonedToUtc
} from './lib/regulators.mjs';
import { buildChangeEventSql } from './lib/watch.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/regulators/${name}`, import.meta.url), 'utf8');
const json = (name) => JSON.parse(fixture(name));
const DDL = readFileSync(new URL('../db/2026-10-01-sonar-regulators.sql', import.meta.url), 'utf8');
const AT = '2026-10-01T05:37:00Z';
const LATER = '2026-10-02T05:37:00Z';

function realDossiers() {
    const dir = new URL('./data/issuers/', import.meta.url);
    return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => ({
        slug: f.replace(/\.json$/, ''),
        dossier: JSON.parse(readFileSync(new URL(f, dir), 'utf8'))
    }));
}
const EXTRA = JSON.parse(readFileSync(new URL('./data/caselaw-extra.json', import.meta.url), 'utf8'));
const NAMES = deriveWatchNames(realDossiers(), { extra: EXTRA });
const byPhrase = (phrase) => NAMES.find((n) => n.phrase === phrase);

describe('watched names come from the case-law derivation', () => {
    test('exactly the case-law phrase set, not a second copy that can drift', () => {
        const caselaw = deriveQueries(realDossiers(), { extra: EXTRA }).queries.filter((q) => q.kind === 'phrase').map((q) => q.phrase);
        expect(NAMES.map((n) => n.phrase)).toEqual(caselaw);
        expect(NAMES.length).toBeGreaterThan(40);
    });

    test('a name with a corporate suffix is a legal name; a brand or bare name is not', () => {
        expect(byPhrase('Backed Assets (JE) Limited')).toMatchObject({ legal: true, core: 'backed assets je' });
        expect(byPhrase('Payward, Inc.')).toMatchObject({ legal: true, core: 'payward' });
        expect(byPhrase('xStocks')).toMatchObject({ legal: false, core: null });
        expect(byPhrase('DekaBank')).toMatchObject({ legal: false, core: null });
    });

    test('a stoplisted or generic core never becomes a weak name', () => {
        // "Securitize" is on the case-law stoplist (also a verb), so "Securitize, Inc." has no core.
        expect(byPhrase('Securitize, Inc.').core).toBeNull();
        expect(byPhrase('Fireblocks, Inc.').core).toBeNull();
        expect(distinctiveCore('trust')).toBe(false);
        expect(distinctiveCore('flux')).toBe(false);
        expect(distinctiveCore('payward')).toBe(true);
    });
});

describe('name matching', () => {
    test('corporate suffix spellings are one name', () => {
        expect(canonicalName('Backed Assets (JE) Ltd')).toBe(canonicalName('Backed Assets (JE) Limited'));
        expect(canonicalName('RQD Clearing L.L.C.')).toBe(canonicalName('RQD Clearing, LLC'));
        expect(canonicalName('Maerki Baumann & Co AG')).toBe(canonicalName('Maerki Baumann and Company AG'));
        expect(nameCore('Trek Labs Australia Pty Ltd')).toBe('trek labs australia');
    });

    test('strong = the full legal name, weak = its core or a brand, null = not named', () => {
        expect(nameStrength('Clone warning: Backed Assets (JE) Ltd', byPhrase('Backed Assets (JE) Limited'))).toBe('strong');
        expect(nameStrength('Payward Inc. settles', byPhrase('Payward, Inc.'))).toBe('strong');
        expect(nameStrength('Payward settles', byPhrase('Payward, Inc.'))).toBe('weak');
        expect(nameStrength('fake xStocks platform', byPhrase('xStocks'))).toBe('weak');
        // Word boundaries: a longer word is not the name.
        expect(nameStrength('Paywardly Ltd', byPhrase('Payward, Inc.'))).toBeNull();
        expect(nameStrength('we securitize loans', byPhrase('Securitize, Inc.'))).toBeNull();
    });

    test('the title / named firm is the subject; the stronger reading wins', () => {
        const notices = [
            { id: 'a', title: 'Warning: Alpaca Securities LLC (clone)', subjects: [], text: 'unrelated' },
            { id: 'b', title: 'Quarterly bulletin', subjects: [], text: 'mentions Alpaca Securities LLC in passing' },
            { id: 'c', title: 'Alpaca Securities news', subjects: [], text: 'Alpaca Securities LLC was fined' }
        ];
        const got = matchNotices(notices, [byPhrase('Alpaca Securities LLC')]).map((m) => [m.notice.id, m.strength, m.matchedIn]);
        expect(got).toEqual([['a', 'strong', 'subject'], ['b', 'strong', 'text'], ['c', 'strong', 'text']]);
    });
});

describe('dates are the regulator\'s own, in its own time zone', () => {
    test('the FCA wall-clock date is London time (BST in September)', () => {
        expect(fcaDates('Wednesday, September 30, 2026 - 13:20')).toEqual({ publishedAt: '2026-09-30T12:20:00Z', publishedDate: '2026-09-30' });
        expect(fcaDates('Monday, December 7, 2026 - 09:05').publishedAt).toBe('2026-12-07T09:05:00Z');
        expect(fcaDates('yesterday')).toEqual({ publishedAt: null, publishedDate: null });
    });

    test('an RSS pubDate keeps its instant and takes the regulator\'s calendar date', () => {
        expect(rfc822Dates('Fri, 12 Jun 2026 01:09:01 GMT', 'America/New_York')).toEqual({
            publishedAt: '2026-06-12T01:09:01Z', publishedDate: '2026-06-11'
        });
        expect(rfc822Dates('Wed, 30 Sep 2026 23:30:00 +0000', 'Europe/Berlin').publishedDate).toBe('2026-10-01');
        expect(rfc822Dates('', 'Europe/Berlin')).toEqual({ publishedAt: null, publishedDate: null });
    });

    test('zonedToUtc handles both sides of a DST change', () => {
        expect(zonedToUtc({ year: 2026, month: 7, day: 1, hour: 12 }, 'Europe/Zurich').toISOString()).toBe('2026-07-01T10:00:00.000Z');
        expect(zonedToUtc({ year: 2026, month: 1, day: 1, hour: 12 }, 'Europe/Zurich').toISOString()).toBe('2026-01-01T11:00:00.000Z');
    });

    test('numeric dates in both orders, and nothing invented for garbage', () => {
        expect(numericDate('24.09.2026')).toBe('2026-09-24');
        expect(numericDate('09/29/2026', 'mdy')).toBe('2026-09-29');
        expect(numericDate('29/09/2026', 'mdy')).toBeNull();
        expect(numericDate('')).toBeNull();
    });
});

describe('parsers read the real payloads', () => {
    test('SEC trading suspensions (the case-law SEC parser, reused): New York date, release number id', () => {
        const [n] = parseSecSuspensions(fixture('sec-trading-suspensions.xml'));
        // pubDate is 01:09 UTC on 12 June — still 11 June in New York, the date the SEC puts on it.
        expect(n).toMatchObject({ id: '34-105675', type: 'suspension', title: 'Happy City Holdings Limited',
            publishedAt: '2026-06-12T01:09:01Z', publishedDate: '2026-06-11' });
        expect(n.url).toBe('https://www.sec.gov/files/litigation/suspensions/2026/34-105675.pdf');
    });

    test('SEC press releases: the release number from the slug', () => {
        const list = parseSecPressReleases(fixture('sec-press-releases.xml'));
        expect(list[0].id).toBe('2026-95');
        expect(list.every((n) => /^\d{4}-\d{2}-\d{2}$/.test(n.publishedDate))).toBe(true);
    });

    test('CFTC enforcement: the press-release number, title as subject', () => {
        const [n] = parseCftcEnforcement(fixture('cftc-enforcement.xml'));
        expect(n).toMatchObject({ id: '9304-26', type: 'enforcement', publishedDate: '2026-09-25' });
        expect(n.subjects[0]).toContain('Cash FX Group S.A.');
    });

    test('FCA warnings, news and publications: guid id, London date, final notices typed as enforcement', () => {
        const [w] = parseFcaWarnings(fixture('fca-warnings.xml'));
        expect(w).toMatchObject({ id: '175311', type: 'warning', title: 'vbitfxbroker.com (new)', publishedDate: '2026-09-30' });
        expect(w.text).toContain('Unauthorised firm details');
        expect(parseFcaNews(fixture('fca-news.xml'))[0]).toMatchObject({ id: '174841', type: 'news' });
        const pubs = fixture('fca-publications.xml');
        expect(parseFcaPublications(pubs)[0].type).toBe('publication');
        const asFinal = pubs.replace('/publications/newsletters/primary-market-bulletin-66', '/publications/final-notices/some-firm-ltd');
        expect(parseFcaPublications(asFinal)[0].type).toBe('enforcement');
    });

    test('FINMA warning list: GUID id, Swiss date, and the InCore clone warning is read', () => {
        const list = parseFinmaWarnings(json('finma-warnings.json'));
        expect(list[0]).toMatchObject({ id: '{FF1B5247-0E2C-4666-BD48-69C56E451109}', type: 'warning', publishedDate: '2026-09-24' });
        expect(list.map((n) => n.title)).toContain('www.incore-fund.com / www.incore-private.com/');
        expect(parseFinmaNews(fixture('finma-news.xml'))[0].id).toBe('{312CB69C-5810-4967-ADB1-8F3E95E693BF}');
    });

    test('BaFin: the link is the id, "warnt" titles are warnings, measures are sanctions', () => {
        const [n] = parseBafinNews(fixture('bafin-news.xml'));
        expect(n).toMatchObject({ type: 'warning', publishedAt: '2026-09-30T07:32:00Z', publishedDate: '2026-09-30' });
        expect(n.id).toMatch(/^https:\/\/www\.bafin\.de\/SharedDocs\/.*bitbucks_space\.html$/);
        expect(parseBafinMeasures(fixture('bafin-measures.xml')).every((m) => m.type === 'sanction')).toBe(true);
    });

    test('ESMA sanctions: the sanction\'s own date, not the day ESMA listed it', () => {
        const [n] = parseEsmaSanctions(json('esma-sanctions.json'));
        expect(n).toMatchObject({ id: 'sn15271', type: 'sanction', subjects: ['ARKEA DIRECT BANK'], publishedDate: '2026-04-22' });
    });

    test('ESMA MiCA non-compliant CASPs (CSV): a stable id from authority + names + website', () => {
        const list = parseEsmaNcasp(fixture('esma-mica-ncasp.csv'));
        expect(list[0]).toMatchObject({ type: 'warning', subjects: ['Bank Bit', 'www.bank-bit.com'] });
        expect(parseEsmaNcasp(fixture('esma-mica-ncasp.csv'))[0].id).toBe(list[0].id);
        expect(parseCsv('a,b\n"x, y","say ""hi"""\n')).toEqual([{ a: 'x, y', b: 'say "hi"' }]);
    });

    test('Central Bank of Ireland: the embedded list, with the firm name decoded', () => {
        const [n] = parseCbiUnauthorised(fixture('cbi-unauthorised.html'));
        expect(n.subjects).toEqual(['Infinity Insurance & Assistance / Infinity European Assistance']);
        expect(n.publishedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test('FMA Liechtenstein: element id, Vaduz date from the unix release date', () => {
        const [w] = parseFmaLi(json('fma-li-warnings.json'), { kind: 'warnings' });
        expect(w).toMatchObject({ id: '1685', type: 'warning', publishedDate: '2026-09-29' });
        expect(parseFmaLi(json('fma-li-news.json'), { kind: 'news' })[0]).toMatchObject({ id: '1682', type: 'news' });
    });

    test('CIMA: date text, detail slug or PDF name as id', () => {
        const [w] = parseCima(fixture('cima-warnings.html'), { type: 'warning' });
        expect(w).toMatchObject({ id: '2026-08-31-WarningNotice-Non-CompliantDirectors_1788212450.pdf', publishedDate: '2026-08-31' });
        const [e] = parseCima(fixture('cima-enforcement.html'), { type: 'enforcement' });
        expect(e).toMatchObject({ id: 'termination-of-struck-or-dissolved-entities-5', publishedDate: '2026-08-28' });
    });

    test('MAS: every alias is a subject; a list longer than one page is a failure, not a truncation', () => {
        const [n] = parseMasAlerts(json('mas-investor-alerts.json'));
        expect(n).toMatchObject({ id: '6012', publishedDate: '2026-09-30' });
        expect(n.subjects).toEqual(expect.arrayContaining(['ProfitsMirror Ltd.', 'Profits Mirror', 'profitsmirror.com']));
        expect(() => parseMasAlerts(json('mas-investor-alerts-truncated.json'))).toThrow(/920 entries but only 3/);
    });

    test('SMV Panama and ASIC: the post\'s own UTC time', () => {
        expect(parseSmvAlerts(json('smv-panama-alerts.json'))[0]).toMatchObject({
            id: '34832', subjects: ['ALGOBI.COM'], publishedAt: '2026-09-11T15:32:24Z', publishedDate: '2026-09-11'
        });
        const asic = parseAsicReleases(json('asic-bannings-alerts.json'));
        expect(asic.map((n) => n.id)).toEqual(['26-231MR', '26-230MR', '24-274MR']);
        expect(asic[2].publishedDate).toBe('2024-12-13');
    });

    test('EDGAR full-text search: only filings the entity filed, routine forms out', () => {
        const raw = json('edgar-fts-securitize-corp.json');
        // The fixture really contains routine insider forms, so dropping them is tested, not assumed.
        expect(raw.hits.hits.some((h) => ROUTINE_FORMS.has(h._source.form))).toBe(true);
        const list = parseEdgarSearch(raw, byPhrase('Securitize Corp.'));
        expect(list.length).toBeGreaterThan(0);
        for (const n of list) {
            expect(ROUTINE_FORMS.has(n.title.split(' filed by ')[0])).toBe(false);
            expect(n.subjects.some((s) => nameStrength(s, byPhrase('Securitize Corp.')))).toBe(true);
            expect(n.url).toMatch(/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d{18}\/[\d-]+-index\.htm$/);
            expect(n.publishedDate).toMatch(/^2026-/);
        }
        expect(new Set(list.map((n) => n.id)).size).toBe(list.length);
    });

    test('BrokerCheck: disclosures become an undated register notice whose id changes with the counts', () => {
        expect(parseBrokerCheckSearch(json('brokercheck-search-alpaca-securities.json'))[0]).toMatchObject({ crd: '288202', name: 'ALPACA SECURITIES LLC' });
        const { notices } = parseBrokerCheckFirm(json('brokercheck-firm-288202.json'));
        expect(notices).toEqual([expect.objectContaining({
            id: 'crd-288202:ACTIVE:Regulatory Event=2', type: 'register', publishedAt: null, publishedDate: null
        })]);
        expect(parseBrokerCheckFirm(json('brokercheck-firm-134284.json')).notices[0].id).toBe('crd-134284:ACTIVE:Regulatory Event=6');
        expect(parseBrokerCheckFirm(json('brokercheck-firm-317194.json')).notices).toEqual([]);
        // One more disclosure → a different notice id → a new match.
        const bumped = json('brokercheck-firm-288202.json');
        const content = JSON.parse(bumped.hits.hits[0]._source.content);
        content.disclosures = content.disclosures.map((d) => ({ ...d, disclosureCount: d.disclosureCount + 1 }));
        bumped.hits.hits[0]._source.content = JSON.stringify(content);
        expect(parseBrokerCheckFirm(bumped).notices[0].id).toBe('crd-288202:ACTIVE:Regulatory Event=3');
        expect(brokerCheckNames(NAMES).map((n) => n.phrase)).toEqual(expect.arrayContaining(['Alpaca Securities LLC', 'RQD Clearing, LLC']));
    });

    test('FINRA disciplinary actions: the Alpaca AWC is read with its firm and date', () => {
        const [n] = parseFinraDisciplinary(fixture('finra-disciplinary-alpaca.html'));
        expect(n).toMatchObject({ id: '2021072094901', type: 'enforcement', subjects: ['Alpaca Securities LLC'], publishedDate: '2026-03-17' });
        expect(n.text).toContain('1.87 million transactions');
        expect(parseFinraDisciplinary(fixture('finra-disciplinary-page.html')).map((x) => x.subjects[0])).toContain('Harvey Alan Brode');
    });

    test('a changed page is an error, never zero notices', () => {
        expect(() => parseFinmaWarnings({})).toThrow(/no items parsed/);
        expect(() => parseFcaWarnings('<html>Just a moment...</html>')).toThrow(/no items parsed/);
        expect(() => parseCima('<html></html>', { type: 'warning' })).toThrow(/no items parsed/);
        expect(() => parseFinraDisciplinary('<html>maintenance</html>')).toThrow(/no results table/);
        expect(() => parseEsmaNcasp('x,y\n1,2\n')).toThrow(/columns changed/);
    });
});

describe('true hits in the real payloads', () => {
    test('the FINRA AWC names Alpaca Securities LLC strongly, for both issuers that use it', () => {
        const matches = matchNotices(parseFinraDisciplinary(fixture('finra-disciplinary-alpaca.html')), NAMES);
        const alpaca = matches.find((m) => m.name.phrase === 'Alpaca Securities LLC');
        expect(alpaca).toMatchObject({ strength: 'strong', matchedIn: 'subject' });
        expect(alpaca.name.issuers).toEqual(['ondo-global-markets', 'xstocks-backed']);
    });

    test('BrokerCheck disclosures for RQD Clearing match despite the "RQD*" spelling', () => {
        const matches = matchNotices(parseBrokerCheckFirm(json('brokercheck-firm-134284.json')).notices, NAMES);
        expect(matches.map((m) => [m.name.phrase, m.strength])).toEqual([['RQD Clearing, LLC', 'strong']]);
    });

    test('the unrelated FINMA "Bullish Capital" and the InCore clone domains do not match (stoplist / no watched name)', () => {
        expect(matchNotices(parseFinmaWarnings(json('finma-warnings.json')), NAMES)).toEqual([]);
    });
});

describe('foldMatches: what becomes an event', () => {
    const regulator = { id: 'finra-disciplinary', label: 'FINRA disciplinary actions' };
    const awc = () => matchNotices(parseFinraDisciplinary(fixture('finra-disciplinary-alpaca.html')), NAMES);

    test('a first read is a baseline: recorded, nothing raised', () => {
        const previous = new Map();
        const { rows, events } = foldMatches(awc(), { regulator, previous, baseline: true, detectedAt: AT });
        expect(rows.length).toBeGreaterThan(0);
        expect(events).toEqual([]);
        expect(previous.has(matchKey('finra-disciplinary', '2021072094901', 'alpaca securities llc'))).toBe(true);
    });

    test('a new strong subject match on an enforcement notice is one warning per issuer; seen again it is nothing', () => {
        const previous = new Map();
        const { events } = foldMatches(awc(), { regulator, previous, baseline: false, detectedAt: AT });
        expect(events.map((e) => [e.subjectId, e.severity, e.kind])).toEqual([
            ['ondo-global-markets', 'warning', 'regulator-notice'], ['xstocks-backed', 'warning', 'regulator-notice']
        ]);
        expect(events[0].field).toBe('notice:finra-disciplinary:2021072094901');
        expect(events[0].evidence).toMatchObject({ publishedDate: '2026-03-17', strength: 'strong' });
        const again = foldMatches(awc(), { regulator, previous, baseline: false, detectedAt: LATER });
        expect(again.events).toEqual([]);
        expect(again.rows[0]).toMatchObject({ firstSeenAt: AT, lastSeenAt: LATER });
    });

    test('severity: weak → info, strong in text → caution; a dismissed match raises nothing', () => {
        const name = byPhrase('Payward, Inc.');
        const notices = [
            { id: 'w', type: 'warning', title: 'Payward clone', subjects: [], text: null, publishedDate: '2026-09-30' },
            { id: 't', type: 'news', title: 'Bulletin', subjects: [], text: 'Payward, Inc. was mentioned', publishedDate: '2026-09-30' }
        ];
        const { events } = foldMatches(matchNotices(notices, [name]), { regulator, previous: new Map(), baseline: false, detectedAt: AT });
        expect(events.map((e) => [e.evidence.noticeId, e.severity])).toEqual([['w', 'info'], ['t', 'caution']]);
        const review = new Map([[matchKey('finra-disciplinary', 'w', name.entity), { status: 'dismissed', reason: 'clone' }]]);
        const dismissed = foldMatches(matchNotices(notices, [name]), { regulator, previous: new Map(), baseline: false, detectedAt: AT, review });
        expect(dismissed.events.map((e) => e.evidence.noticeId)).toEqual(['t']);
        expect(dismissed.rows.find((r) => r.noticeId === 'w').reviewStatus).toBe('dismissed');
    });

    test('two names of one issuer in one notice are one event naming both', () => {
        const notice = { id: 'n', type: 'enforcement', title: 'Order against Trek Labs Ltd and Trek Forge Ltd', subjects: [], text: null };
        const { rows, events } = foldMatches(matchNotices([notice], NAMES), { regulator, previous: new Map(), baseline: false, detectedAt: AT });
        expect(rows.length).toBeGreaterThanOrEqual(2);
        expect(events).toHaveLength(1);
        expect(events[0].evidence.phrases).toEqual(expect.arrayContaining(['Trek Forge Ltd', 'Trek Labs Ltd']));
    });
});

describe('source verdicts: a silent or failing source fails the run', () => {
    const feed = SOURCES.find((s) => s.id === 'fca-news');
    const notices = [{ publishedAt: '2026-09-29T10:00:00Z' }, { publishedAt: '2026-09-30T10:00:00Z' }];

    test('failures count up across runs and keep the last good read; a good read resets them', () => {
        const first = checkVerdict(feed, { error: 'HTTP 403', runAt: AT, prev: { lastOkAt: '2026-09-30T05:00:00Z', consecutiveFailures: 0 } });
        expect(first).toMatchObject({ status: 'failed', consecutiveFailures: 1, lastOkAt: '2026-09-30T05:00:00Z', noticesRead: null });
        const second = checkVerdict(feed, { error: 'HTTP 403', runAt: LATER, prev: first });
        expect(second.consecutiveFailures).toBe(2);
        expect(checkVerdict(feed, { notices, runAt: '2026-09-30T12:00:00Z', prev: second })).toMatchObject({ status: 'ok', consecutiveFailures: 0 });
    });

    test('a readable feed whose newest notice is too old is stale', () => {
        const v = checkVerdict(feed, { notices, runAt: '2026-11-01T00:00:00Z', prev: null });
        expect(v.status).toBe('stale');
        expect(v.lastError).toMatch(/newest notice 2026-09-30 is 31 days old/);
    });

    test('a newest-N feed that no longer reaches the last good read is a gap', () => {
        expect(feedGap(notices, '2026-09-28T00:00:00Z')).toBe(true);
        expect(feedGap(notices, '2026-09-29T12:00:00Z')).toBe(false);
        expect(checkVerdict(feed, { notices, runAt: '2026-09-30T12:00:00Z', prev: { lastOkAt: '2026-09-28T00:00:00Z' } }).status).toBe('gap');
        // A complete list cannot have a gap.
        const complete = SOURCES.find((s) => s.id === 'finma-warnings');
        expect(checkVerdict(complete, { notices, runAt: '2026-09-30T12:00:00Z', prev: { lastOkAt: '2026-09-28T00:00:00Z' } }).status).toBe('ok');
    });

    test('the hourly FCA warnings feed is not in the daily run, and --only rejects unknown ids', () => {
        expect(selectSources().map((s) => s.id)).not.toContain('fca-warnings');
        expect(selectSources('fca-warnings').map((s) => s.id)).toEqual(['fca-warnings']);
        expect(() => selectSources('jfsc')).toThrow(/unknown source/);
        expect(new Set(SOURCES.map((s) => s.id)).size).toBe(SOURCES.length);
    });
});

describe('SQL and DDL', () => {
    const declared = (table) => DDL.match(new RegExp(`CREATE TABLE IF NOT EXISTS sonar\\.${table} \\(([\\s\\S]*?)\\n\\);`))[1]
        .split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((c) => /^[a-z_]+$/.test(c));

    test('every column the match upsert writes is declared, and first_seen_at is never overwritten', () => {
        const { sql } = buildMatchUpsertSql([{ key: 'k' }]);
        const written = sql.match(/INSERT INTO sonar\.regulator_notice_match AS m\n\s+\(([\s\S]*?)\)\n/)[1].split(',').map((c) => c.trim());
        expect(written.filter((c) => !declared('regulator_notice_match').includes(c))).toEqual([]);
        expect(sql).toContain('ON CONFLICT (regulator, notice_id, entity) DO UPDATE');
        expect(sql.split('DO UPDATE SET')[1]).not.toContain('first_seen_at');
    });

    test('every column the check upsert writes is declared, and first_run_at is kept', () => {
        const { sql } = buildCheckSql([{ regulator: 'x', status: 'ok' }]);
        const written = sql.match(/INSERT INTO sonar\.regulator_check AS c\n\s+\(([\s\S]*?)\)\n/)[1].split(',').map((c) => c.trim());
        expect(written.filter((c) => !declared('regulator_check').includes(c))).toEqual([]);
        expect(sql.split('DO UPDATE SET')[1]).not.toContain('first_run_at');
        for (const status of ['ok', 'failed', 'stale', 'gap']) expect(DDL).toMatch(new RegExp(`last_status IN \\([^)]*'${status}'`));
    });

    test('`regulator-notice` is an allowed kind, stated in the one kinds file; this DDL does not touch the list', () => {
        expect(readFileSync(new URL('../db/2026-10-01-sonar-change-event-kinds.sql', import.meta.url), 'utf8')).toContain("'regulator-notice'");
        expect(DDL).not.toMatch(/change_event_kind_check/);
        expect(DDL).toMatch(/SET ROLE geo_user/);
    });

    test('events go through the shared change_event loader', () => {
        const { events } = foldMatches(matchNotices(parseFinraDisciplinary(fixture('finra-disciplinary-alpaca.html')), NAMES),
            { regulator: { id: 'finra-disciplinary', label: 'FINRA' }, previous: new Map(), baseline: false, detectedAt: AT });
        const { sql } = buildChangeEventSql(events);
        expect(sql).toContain('"kind":"regulator-notice"');
    });

    test('stored rows read back with ISO timestamps and their key', () => {
        const [m] = normaliseStoredMatches([{ regulator: 'r', noticeId: 'n', entity: 'e', firstSeenAt: '2026-10-01 05:37:00+00', issuers: null }]);
        expect(m).toMatchObject({ key: 'r|n|e', firstSeenAt: AT, issuers: [] });
        const [c] = normaliseStoredChecks([{ regulator: 'r', lastOkAt: '2026-10-01 05:37:00+00', consecutiveFailures: '3' }]);
        expect(c).toMatchObject({ lastOkAt: AT, consecutiveFailures: 3 });
    });
});

describe('known-blocked sources: reported, never a failure', () => {
    const cftc = SOURCES.find((s) => s.id === 'cftc-enforcement');
    const fca = SOURCES.find((s) => s.id === 'fca-news');
    // The real error of 2026-10-07 05:41 UTC, as pacedFetch words it.
    const CF_403 = 'https://www.cftc.gov/RSS/RSSENF/rssenf.xml: HTTP 403 (Cloudflare challenge/block): <!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>';

    test('cftc-enforcement is flagged; its Cloudflare block (403, or a 429 challenge) is the known block', () => {
        expect(cftc.knownBlocked).toMatchObject({ since: '2026-10-07' });
        expect(knownBlock(cftc, CF_403)).toBe(cftc.knownBlocked);
        expect(knownBlock(cftc, 'https://www.cftc.gov/RSS/RSSENF/rssenf.xml: HTTP 429 (Cloudflare challenge/block): <!DOCTYPE html>')).toBe(cftc.knownBlocked);
    });

    test('any other failure of a flagged source, and a block of an unflagged one, still fail', () => {
        expect(knownBlock(cftc, 'https://www.cftc.gov/RSS/RSSENF/rssenf.xml: HTTP 500: oops')).toBeNull();
        expect(knownBlock(cftc, 'timeout after 45000 ms')).toBeNull();
        expect(knownBlock(cftc, null)).toBeNull();
        expect(knownBlock(fca, 'https://www.fca.org.uk/news/rss.xml: HTTP 403 (Cloudflare challenge/block): …')).toBeNull();
    });

    test('the run verdict lists a known block apart: ok with no failures, partial or failed only on real ones', () => {
        const blocked = { status: 'blocked', knownBlocked: cftc.knownBlocked, consecutiveFailures: 1, lastError: CF_403 };
        const ok = { status: 'ok', consecutiveFailures: 0, lastError: null };
        const v = runVerdict({ 'sec-press-releases': ok, 'cftc-enforcement': blocked, 'fca-news': ok });
        expect(v.watchStatus).toBe('ok');
        expect(v.failures).toEqual([]);
        expect(v.blocked).toHaveLength(1);
        expect(v.blocked[0]).toMatch(/^cftc-enforcement: blocked \(known since 2026-10-07\) — Cloudflare/);
        const failed = { status: 'failed', consecutiveFailures: 2, lastError: 'HTTP 500' };
        expect(runVerdict({ 'cftc-enforcement': blocked, 'fca-news': failed, 'sec-press-releases': ok }))
            .toMatchObject({ watchStatus: 'partial', failures: ['fca-news: failed (2 runs in a row) — HTTP 500'] });
        expect(runVerdict({ 'cftc-enforcement': blocked, 'fca-news': failed }).watchStatus).toBe('failed');
    });

    test('a good read of a flagged source is an ordinary ok verdict', () => {
        const v = checkVerdict(cftc, { notices: [{ publishedAt: '2026-09-30T14:00:00Z' }], runAt: '2026-10-08T05:40:00Z', prev: { lastOkAt: '2026-10-06T05:40:00Z' } });
        expect(v.status).toBe('ok');
        expect(runVerdict({ 'cftc-enforcement': { status: v.status, consecutiveFailures: 0 } })).toEqual({ failures: [], blocked: [], watchStatus: 'ok' });
    });
});

describe('formatTelegramSummary', () => {
    test('a known block is a reminder line and a count, not a failure', () => {
        const text = formatTelegramSummary({ events: [], failures: ['fca-news: failed — HTTP 500'], checks: 23, noticesRead: 9000, durationMs: 1000,
            blocked: ['cftc-enforcement: blocked (known since 2026-10-07) — Cloudflare'] });
        expect(text.split('\n')[0]).toBe('RWA Sonar regulator watch: 0 new match event(s), 1 failure(s), 1 known-blocked source(s)');
        expect(text).toContain('⊘ cftc-enforcement: blocked (known since 2026-10-07)');
    });

    test('one message: counts, warnings first, failures listed', () => {
        const events = [
            { severity: 'info', summary: 'weak one' },
            { severity: 'warning', summary: 'FINRA: AWC names Alpaca Securities LLC' }
        ];
        const text = formatTelegramSummary({ events, failures: ['fca-news: failed — HTTP 403'], checks: 23, noticesRead: 9000, durationMs: 152000 });
        const lines = text.split('\n');
        expect(lines[0]).toBe('RWA Sonar regulator watch: 2 new match event(s), 1 failure(s)');
        expect(lines[2]).toContain('[warning]');
        expect(text).toContain('✗ fca-news: failed — HTTP 403');
    });
});
