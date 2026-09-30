// Unit tests for stocks/lib/entities.mjs — the legal-entity watcher's decisions. Each test guards
// something a reader of the entity feed would notice if it broke: an SPV that is not watched at all,
// an LEI accepted for the wrong company ("Payward Ventures, Inc." for "Payward, Inc."), a duplicate
// LEI picked at random, a lapsed LEI or an insolvency notice that raises nothing, an insolvency
// notice for a different company raised against ours, and a re-run that writes the same state twice.
//
// The GLEIF, Zefix and Gazette fixtures in fixtures/entities/ are REAL responses captured on
// 2026-09-30 (trimmed where noted in the capture). The Companies House profile is NOT: no API key
// was available, so it is hand-written from the documented resource and says so in its `_note`.

import { readdirSync, readFileSync } from 'node:fs';

import {
    buildObservationSql, buildReadLatestQuery, changedFields, companiesHouseState, completesName,
    deriveEntities, diffStates, foldObservation, formatTelegramSummary, gazetteState, gleifSearchNames,
    gleifState, jurisdictionCode, jurisdictionConsistent, legalNameKey, matchGleif, matchZefix,
    padCompanyNumber, parseCompaniesHouseOfficers, parseCompaniesHouseProfile, parseGazetteNoticeData,
    parseGazetteSearch, parseGleifRecord, parseGleifReportingException, parseGleifSearch, parseZefixFirm,
    registriesFromGleif, resolutionEntry, stableStringify, stateHash, watchTasks, zefixPublicationSeverity,
    zefixState
} from './lib/entities.mjs';
import { buildChangeEventSql } from './lib/watch.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/entities/${name}`, import.meta.url), 'utf8'));
const DDL = readFileSync(new URL('../db/2026-10-01-sonar-entities.sql', import.meta.url), 'utf8');
const AT = '2026-09-30T12:00:00Z';
const LATER = '2026-10-01T03:29:00Z';

const ISSUERS_DIR = new URL('./data/issuers/', import.meta.url);
const DOSSIERS = readdirSync(ISSUERS_DIR).filter((f) => f.endsWith('.json')).sort()
    .map((f) => ({ slug: f.replace(/\.json$/, ''), dossier: JSON.parse(readFileSync(new URL(f, ISSUERS_DIR), 'utf8')) }));
const CANONICAL = JSON.parse(readFileSync(new URL('./data/canonical-parties.json', import.meta.url), 'utf8'));
const REGISTRY = JSON.parse(readFileSync(new URL('./data/entity-registry-ids.json', import.meta.url), 'utf8'));

const BACKED = parseGleifRecord(fixture('gleif-record-backed-assets-je.json').data);
const BITGO = parseGleifRecord(fixture('gleif-record-bitgo-trust-lapsed.json').data);
const GOLDMAN = parseGleifRecord(fixture('gleif-record-goldman-sachs-international.json').data);
const GOLDMAN_PARENT = parseGleifRecord(fixture('gleif-parent-goldman-sachs-international.json').data);
const INCORE = parseZefixFirm(fixture('zefix-firm-incore-bank.json'));

describe('names and jurisdictions', () => {
    it('reduces legal names to what a register compares, without merging different companies', () => {
        expect(legalNameKey('BACKED ASSETS (JE) LIMITED')).toBe(legalNameKey('Backed Assets (JE) Limited'));
        expect(legalNameKey('Alpha Holdings L.L.C.')).toBe(legalNameKey('Alpha Holdings LLC'));
        expect(legalNameKey('Maerki Baumann & Co. AG')).toBe(legalNameKey('MAERKI BAUMANN & CO. AG'));
        expect(legalNameKey('Equiniti Trust Company, LLC')).toBe(legalNameKey('EQUINITI TRUST CO LLC'));
        expect(legalNameKey('Payward, Inc.')).not.toBe(legalNameKey('Payward Ventures, Inc.'));
        expect(legalNameKey('Trek Labs Ltd')).not.toBe(legalNameKey('Trek Labs Ltd FZE'));
        expect(legalNameKey('Securitize I, Inc.')).not.toBe(legalNameKey('Securitize, Inc.'));
    });

    it('reads a jurisdiction code from the dossiers\' free text, and none from a list of several', () => {
        expect(jurisdictionCode('Jersey (Channel Islands)')).toBe('JE');
        expect(jurisdictionCode('Zug, Switzerland')).toBe('CH');
        expect(jurisdictionCode('Delaware, USA')).toBe('US-DE');
        expect(jurisdictionCode('Wilmington, North Carolina, USA')).toBe('US');
        expect(jurisdictionCode('British Virgin Islands / Delaware / UAE / Australia')).toBeNull();
        expect(jurisdictionCode('')).toBeNull();
        expect(jurisdictionConsistent('US', 'US-DE')).toBe(true);
        expect(jurisdictionConsistent('US-DE', 'US-NY')).toBe(false);
        expect(jurisdictionConsistent(null, 'KY')).toBe(true);
        expect(jurisdictionConsistent('GB', 'IE')).toBe(false);
    });

    it('completes "X Trust Company" with its corporate form, but never merges two Trek companies', () => {
        expect(completesName('Equiniti Trust Company', 'Equiniti Trust Company, LLC')).toBe(true);
        expect(completesName('Trek Labs Ltd', 'Trek Labs Ltd FZE')).toBe(false);
    });

    it('searches GLEIF under the name and then its distinctive body', () => {
        expect(gleifSearchNames('Ankura Trust Company, LLC')).toEqual(['Ankura Trust Company, LLC', 'Ankura Trust']);
        expect(gleifSearchNames('Payward, Inc.')).toEqual(['Payward, Inc.', 'Payward']);
        expect(gleifSearchNames('InCore Bank AG')).toEqual(['InCore Bank AG', 'InCore Bank']);
    });
});

describe('which entities are watched (derived from the real dossiers)', () => {
    const { entities, dropped } = deriveEntities(DOSSIERS, { canonical: CANONICAL });
    const by = (name) => entities.find((e) => e.key === legalNameKey(name));

    it('watches the issuing SPVs, custodians and security agent with their jurisdictions', () => {
        expect(by('Backed Assets (JE) Limited')).toMatchObject({ jurisdiction: 'JE', issuers: ['xstocks-backed'] });
        expect(by('Backed Assets (JE) Limited').roles).toContain('token-issuer');
        expect(by('InCore Bank AG')).toMatchObject({ jurisdiction: 'CH' });
        expect(by('Security Agent Services AG').roles).toContain('security-agent');
        expect(by('Ondo Global Markets (BVI) Limited')).toMatchObject({ jurisdiction: 'VG' });
        // The dossier's own "(Delaware)" right after the name wins over the group's list of places.
        expect(by('Trek Labs, Inc.')).toMatchObject({ jurisdiction: 'US-DE' });
    });

    it('reuses the case-law derivation: its stoplist brand is not an entity, the legal name it expands to is', () => {
        expect(by('Kraken')).toBeUndefined();
        expect(by('Payward, Inc.')).toBeDefined();
        expect(dropped.map((d) => d.name)).toContain('xStocks');
        expect(by('xStocks')).toBeUndefined();
    });

    it('keeps one entity per company: no "BitGo Trust Company" beside "BitGo Trust Company, Inc.", but both Trek Labs Ltd companies', () => {
        expect(by('BitGo Trust Company, Inc.')).toBeDefined();
        expect(entities.filter((e) => e.key.startsWith('bitgo trust co'))).toHaveLength(1);
        expect(by('Trek Labs Ltd')).toBeDefined();
        expect(by('Trek Labs Ltd FZE')).toBeDefined();
        expect(by('Backpack Securities')).toBeUndefined();
        expect(by('Backpack Securities Global Limited')).toBeDefined();
    });

    it('does not borrow a one-word brand\'s jurisdiction for an entity whose name starts with it', () => {
        // canonical-parties.json: "Bullish" is Cayman; Bullish Digital TA LLC is its US transfer agent.
        expect(by('Bullish Digital TA LLC').jurisdiction).not.toBe('KY');
    });

    it('every derived entity is in the committed registry file (else --resolve was not re-run)', () => {
        const keys = new Set(REGISTRY.entities.map((e) => e.key));
        expect(entities.filter((e) => !keys.has(e.key)).map((e) => e.name)).toEqual([]);
    });
});

describe('GLEIF', () => {
    it('parses a real lei-record: status, registration, register number, parent link', () => {
        expect(BACKED).toMatchObject({
            lei: '984500001AB7C6C7F577', legalName: 'BACKED ASSETS (JE) LIMITED', jurisdiction: 'JE',
            entityStatus: 'ACTIVE', registrationStatus: 'ISSUED', registeredAt: 'RA000414', registeredAs: '152608',
            lastUpdateDate: '2026-02-03T16:15:09Z', hasDirectParent: false, parentException: true, successors: []
        });
        expect(BITGO.registrationStatus).toBe('LAPSED');
        expect(GOLDMAN.hasDirectParent).toBe(true);
        expect(GOLDMAN_PARENT.legalName).toBe('GOLDMAN SACHS GROUP UK LIMITED');
        expect(parseGleifReportingException(fixture('gleif-parent-exception-backed-assets-je.json'))).toBe('NON_CONSOLIDATING');
        expect(() => parseGleifRecord({ id: 'x' })).toThrow(/not a GLEIF lei-record/);
    });

    it('accepts only the exact legal name: "Payward, Inc." and not Payward Ventures, Payward Financial …', () => {
        const records = parseGleifSearch(fixture('gleif-search-payward-inc.json'));
        expect(records.length).toBeGreaterThan(3);
        const m = matchGleif({ key: legalNameKey('Payward, Inc.'), name: 'Payward, Inc.', jurisdiction: 'US' }, records);
        expect(m).toMatchObject({ status: 'resolved', accepted: true, lei: { id: '254900IE1ULEZR01BF54', confidence: 'high' } });
    });

    it('never accepts an exact name whose jurisdiction contradicts the dossier', () => {
        const records = parseGleifSearch(fixture('gleif-search-payward-inc.json'));
        const m = matchGleif({ key: legalNameKey('Payward, Inc.'), name: 'Payward, Inc.', jurisdiction: 'GB' }, records);
        expect(m).toMatchObject({ status: 'ambiguous', accepted: false, lei: null });
    });

    it('two live LEIs for one Swiss name are ambiguous, until the Zefix UID picks the one that states it', () => {
        const records = parseGleifSearch(fixture('gleif-search-maerki-baumann.json'));
        const entity = { key: legalNameKey('Maerki Baumann & Co. AG'), name: 'Maerki Baumann & Co. AG', jurisdiction: 'CH' };
        const plain = matchGleif(entity, records);
        expect(plain).toMatchObject({ status: 'ambiguous', accepted: false });
        expect(plain.candidates.map((c) => c.lei).sort()).toEqual(['529900FMZSRFHZA8OU51', '984500771XABFC806105']);
        const picked = matchGleif(entity, records, { nationalIds: ['CHE101015393'] });
        expect(picked).toMatchObject({ status: 'resolved', accepted: true, lei: { id: '529900FMZSRFHZA8OU51', matchedBy: 'exact-legal-name+registeredAs' } });
        expect(picked.note).toMatch(/984500771XABFC806105/);
        expect(registriesFromGleif(picked.record).zefix).toMatchObject({ uid: 'CHE101015393' });
    });

    it('lists a near miss as a candidate and never accepts it', () => {
        const records = parseGleifSearch(fixture('gleif-search-continental-stock-transfer.json'));
        const m = matchGleif({ key: legalNameKey('Continental Stock Transfer & Trust Company'), name: 'Continental Stock Transfer & Trust Company', jurisdiction: 'US' }, records);
        expect(m.accepted).toBe(false);
        expect(m.lei).toBeNull();
        expect(m.candidates.some((c) => /Continental Stock Transfer/i.test(c.name))).toBe(true);
    });

    it('takes national ids from the accepted record\'s own registeredAs', () => {
        expect(registriesFromGleif(BACKED)).toEqual({ jfsc: { id: '152608', matchedBy: 'gleif-registeredAs', confidence: 'high', watched: false } });
        expect(registriesFromGleif({ ...BACKED, jurisdiction: 'GB', registeredAt: 'RA000585', registeredAs: '4150611' })['companies-house'].id).toBe('04150611');
        expect(padCompanyNumber('SC123456')).toBe('SC123456');
    });
});

describe('Zefix', () => {
    it('parses a real firm: status, seat, SOGC publications newest first with their mutation types', () => {
        expect(INCORE).toMatchObject({ uid: 'CHE113315761', ehraid: 856432, name: 'InCore Bank AG', status: 'EXISTIEREND', legalSeat: 'Schlieren' });
        expect(INCORE.publications.length).toBeGreaterThan(1);
        const dates = INCORE.publications.map((p) => p.date);
        expect([...dates].sort().reverse()).toEqual(dates);
        expect(INCORE.publications[0].types.length).toBeGreaterThan(0);
        expect(zefixState(INCORE).sourceUpdatedAt).toBe(INCORE.shabDate);
    });

    it('matches a Swiss firm by exact name', () => {
        const firms = fixture('zefix-search-maerki-baumann.json').list.map(parseZefixFirm);
        const m = matchZefix({ key: legalNameKey('Maerki Baumann & Co. AG'), name: 'Maerki Baumann & Co. AG' }, firms);
        expect(m).toMatchObject({ accepted: true, zefix: { uid: 'CHE101015393' } });
        expect(matchZefix({ key: 'no such firm ag', name: 'No Such Firm AG' }, firms).accepted).toBe(false);
    });

    it('grades SOGC publications: bankruptcy and liquidation critical, officer changes info', () => {
        expect(zefixPublicationSeverity(['konkurs'])).toBe('critical');
        expect(zefixPublicationSeverity(['aufloesung'])).toBe('critical');
        expect(zefixPublicationSeverity(['fusion'])).toBe('warning');
        expect(zefixPublicationSeverity(['aenderungorgane'])).toBe('info');
    });
});

describe('The Gazette', () => {
    const search = parseGazetteSearch(fixture('gazette-insolvency-search-thomas-cook-group-plc.json'));
    const noticeData = {
        4660296: parseGazetteNoticeData(fixture('gazette-notice-4660296.jsonld.json')),
        4445601: parseGazetteNoticeData(fixture('gazette-notice-4445601.jsonld.json'))
    };
    const notices = search.filter((n) => noticeData[n.id]);

    it('parses the insolvency search and the company number in a notice\'s linked data', () => {
        expect(search.length).toBeGreaterThanOrEqual(2);
        expect(search.every((n) => /^\d+$/.test(n.id) && n.url.startsWith('https://www.thegazette.co.uk/notice/'))).toBe(true);
        expect(noticeData[4660296].companyNumbers).toEqual(['06091951']);
        expect(parseGazetteSearch(fixture('gazette-insolvency-search-gtn-europe.json'))).toEqual([]);
    });

    it('confirms a notice by company number (leading zeros or not) and drops one for another company', () => {
        const ours = gazetteState({ companyNumber: '6091951', legalName: 'Thomas Cook Group plc', notices, noticeData });
        expect(ours.state.confirmed.map((n) => n.id).sort()).toEqual(['4445601', '4660296']);
        expect(ours.sourceUpdatedAt).toBe(notices.map((n) => n.published).sort().at(-1));
        const other = gazetteState({ companyNumber: '12345678', legalName: 'Thomas Cook Group plc', notices, noticeData });
        expect(other.state.confirmed).toEqual([]);
        expect(other.state.nameOnly).toEqual([]);
    });

    it('a confirmed insolvency notice is a critical `insolvency` finding even on the first read', () => {
        const { state } = gazetteState({ companyNumber: '06091951', legalName: 'Thomas Cook Group plc', notices, noticeData });
        const f = diffStates('gazette', null, state);
        expect(f).toHaveLength(2);
        expect(f.every((x) => x.severity === 'critical' && x.kind === 'insolvency')).toBe(true);
        expect(diffStates('gazette', state, state)).toEqual([]);
    });
});

describe('Companies House (documented shape — no key available)', () => {
    const profile = parseCompaniesHouseProfile(fixture('companies-house-profile.DOCUMENTED-SHAPE.json'));

    it('parses status, insolvency history and previous names', () => {
        expect(profile).toMatchObject({ companyNumber: '01234567', status: 'liquidation', hasInsolvencyHistory: true, previousNames: ['EXAMPLE CUSTODY LIMITED'] });
        expect(parseCompaniesHouseOfficers({ items: [{ name: 'B', officer_role: 'director' }, { name: 'A', officer_role: 'secretary', resigned_on: '2020-01-01' }] })).toEqual(['B (director)']);
        expect(companiesHouseState(profile, []).sourceUpdatedAt).toBeNull();
    });

    it('a company in liquidation is a critical insolvency finding on the first read', () => {
        const f = diffStates('companies-house', null, companiesHouseState(profile, []).state);
        expect(f.find((x) => x.field === 'status')).toMatchObject({ severity: 'critical', kind: 'insolvency', after: 'liquidation' });
    });
});

describe('change detection', () => {
    const healthy = gleifState(BACKED, null, 'NON_CONSOLIDATING').state;

    it('a healthy first read is recorded but raises nothing; a lapsed LEI on the first read is a warning', () => {
        expect(diffStates('gleif', null, healthy)).toEqual([]);
        expect(diffStates('gleif', null, gleifState(BITGO).state)).toEqual([
            { field: 'registrationStatus', before: null, after: 'LAPSED', severity: 'warning', kind: 'entity-status' }
        ]);
    });

    it('grades GLEIF changes: INACTIVE and successors critical, lapse warning, name change warning, renewal info', () => {
        const f = (patch) => diffStates('gleif', healthy, { ...healthy, ...patch });
        expect(f({ entityStatus: 'INACTIVE' })).toEqual([{ field: 'entityStatus', before: 'ACTIVE', after: 'INACTIVE', severity: 'critical', kind: 'entity-status' }]);
        expect(f({ registrationStatus: 'LAPSED' })[0].severity).toBe('warning');
        expect(f({ registrationStatus: 'RETIRED' })[0].severity).toBe('critical');
        expect(f({ successors: [{ lei: 'X', name: 'Y' }] })[0]).toMatchObject({ field: 'successors', severity: 'critical' });
        expect(f({ legalName: 'BACKED ASSETS (JE) II LIMITED' })[0]).toMatchObject({ field: 'legalName', severity: 'warning' });
        expect(f({ nextRenewalDate: '2028-02-13T12:19:06Z' })[0]).toMatchObject({ field: 'nextRenewalDate', severity: 'info' });
        expect(f({ directParent: { lei: 'P', name: 'PARENT' }, directParentException: null })[0]).toMatchObject({ field: 'directParent', severity: 'warning' });
        expect(f({})).toEqual([]);
    });

    it('a GLEIF re-validation that only moves lastUpdateDate is not a change', () => {
        const a = gleifState(BACKED).state;
        const b = gleifState({ ...BACKED, lastUpdateDate: '2027-01-01T00:00:00Z' }).state;
        expect(stateHash(a)).toBe(stateHash(b));
    });

    it('Zefix: a firm leaving EXISTIEREND is critical; a new bankruptcy publication is an insolvency finding; old ones are not new', () => {
        const prev = zefixState(INCORE).state;
        expect(diffStates('zefix', prev, { ...prev, status: 'GELOESCHT' })[0]).toMatchObject({ field: 'status', severity: 'critical' });
        const pub = { id: '9999999999', date: '2026-10-01', types: ['konkurs'] };
        const next = { ...prev, publications: [pub, ...prev.publications] };
        expect(diffStates('zefix', prev, next)).toEqual([
            { field: 'publication:9999999999', before: null, after: '2026-10-01 konkurs', severity: 'critical', kind: 'insolvency' }
        ]);
        const slidIn = { ...prev, publications: [...prev.publications, { id: '1', date: '2001-01-01', types: ['konkurs'] }] };
        expect(diffStates('zefix', prev, slidIn)).toEqual([]);
    });

    it('state hashes ignore key order', () => {
        expect(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(stableStringify({ a: [{ c: 3, d: 2 }], b: 1 }));
        expect(changedFields({ a: 1, b: 2 }, { a: 1, b: 3 })).toEqual(['b']);
    });
});

describe('folding an observation into a row and events', () => {
    const task = { id: 'gleif:254900QXDWGM1T0HGF47', source: 'gleif', identifier: '254900QXDWGM1T0HGF47', entityKey: 'bitgo trust co inc', entityName: 'BitGo Trust Company, Inc.', issuers: ['republic-mirror', 'ondo-global-markets'] };
    const issued = gleifState({ ...BITGO, registrationStatus: 'ISSUED' });
    const lapsed = gleifState(BITGO);

    it('the same state again writes no row, only a confirmation', () => {
        const prev = { state: lapsed.state, stateHash: stateHash(lapsed.state) };
        const r = foldObservation(task, { ...lapsed, url: 'u' }, { previous: prev, detectedAt: LATER });
        expect(r.row).toBeNull();
        expect(r.events).toEqual([]);
        expect(r.confirm).toMatchObject({ entityKey: task.entityKey, stateHash: prev.stateHash, observedAt: LATER });
    });

    it('a change writes one row with the source\'s own date and one event per issuer in the chain', () => {
        const prev = { state: issued.state, stateHash: stateHash(issued.state) };
        const r = foldObservation(task, { ...lapsed, url: 'https://search.gleif.org/#/record/254900QXDWGM1T0HGF47' }, { previous: prev, detectedAt: LATER });
        expect(r.row).toMatchObject({ changeKind: 'changed', changedFields: ['registrationStatus'], sourceUpdatedAt: BITGO.lastUpdateDate, observedAt: LATER, issuers: ['ondo-global-markets', 'republic-mirror'] });
        expect(r.row.sourceUpdatedAt).not.toBe(LATER);
        expect(r.events.map((e) => e.subjectId)).toEqual(['ondo-global-markets', 'republic-mirror']);
        expect(r.events[0]).toMatchObject({ kind: 'entity-status', subjectType: 'issuer', severity: 'warning', before: 'ISSUED', after: 'LAPSED', detectedAt: LATER });
        expect(r.events[0].field).toBe('BitGo Trust Company, Inc. · gleif:registrationStatus');
    });

    it('the first observation is a baseline row', () => {
        const r = foldObservation(task, { ...issued, url: 'u' }, { previous: null, detectedAt: AT });
        expect(r.row.changeKind).toBe('baseline');
        expect(r.events).toEqual([]);
    });
});

describe('what is watched', () => {
    const entry = {
        key: 'gtn europe financial services ltd', name: 'GTN Europe Financial Services Limited', status: 'resolved', issuers: ['xstocks-backed'],
        lei: { id: '9845001B7C507X754824', name: 'GTN EUROPE FINANCIAL SERVICES LIMITED' },
        registries: { 'companies-house': { id: '14150611' } }
    };

    it('only accepted ids; Companies House only with a key; the Gazette for every UK company number', () => {
        expect(watchTasks(entry).map((t) => t.id)).toEqual(['gleif:9845001B7C507X754824', 'gazette:14150611']);
        expect(watchTasks(entry, { companiesHouseKey: true }).map((t) => t.source)).toEqual(['gleif', 'companies-house', 'gazette']);
        expect(watchTasks({ ...entry, status: 'ambiguous' })).toEqual([]);
        expect(watchTasks({ ...entry, status: 'ambiguous', reviewed: true })).toHaveLength(2);
    });

    it('--resolve keeps a reviewed entry as the reviewer left it', () => {
        const previous = { ...entry, status: 'resolved', reviewed: true, lei: { id: 'HAND-PICKED' }, jurisdiction: 'GB' };
        const next = resolutionEntry({ key: entry.key, name: entry.name, issuers: ['a', 'b'], roles: [], jurisdiction: null }, { previous, resolvedAt: AT });
        expect(next.lei.id).toBe('HAND-PICKED');
        expect(next.issuers).toEqual(['a', 'b']);
    });

    it('the committed registry: a `resolved` entry names an id, and no unaccepted candidate is ever watched', () => {
        for (const e of REGISTRY.entities) {
            const tasks = watchTasks(e, { companiesHouseKey: true });
            if (e.status === 'resolved') expect(Boolean(e.lei?.id || Object.keys(e.registries ?? {}).length)).toBe(true);
            if (e.status !== 'resolved' && e.reviewed !== true) expect(tasks).toEqual([]);
            const candidateIds = new Set(Object.values(e.candidates ?? {}).flat().map((c) => c.lei ?? c.uid));
            for (const t of tasks) if (t.source === 'gleif') expect(candidateIds.has(t.identifier)).toBe(false);
        }
    });
});

describe('SQL and the schema', () => {
    it('inserts only when the latest stored state differs, and names only columns the DDL has', () => {
        const { sql } = buildObservationSql({ rows: [{ entityKey: 'k', source: 'gleif', identifier: 'L', stateHash: 'h', state: {}, observedAt: AT }], confirms: [{ entityKey: 'k', source: 'gleif', identifier: 'L', stateHash: 'h', observedAt: AT }] });
        expect(sql).toMatch(/IS DISTINCT FROM r->>'stateHash'/);
        expect(sql).toMatch(/ON CONFLICT \(entity_key, source, identifier, observed_at\) DO NOTHING/);
        expect(sql).toMatch(/UPDATE sonar\.entity_observation/);
        const table = DDL.slice(DDL.indexOf('CREATE TABLE IF NOT EXISTS sonar.entity_observation'), DDL.indexOf('CREATE INDEX'));
        const insertCols = /INSERT INTO sonar\.entity_observation\s*\(([^)]+)\)/.exec(sql)[1].split(',').map((c) => c.trim());
        for (const col of insertCols) expect(table).toMatch(new RegExp(`\\n\\s+${col}\\s`));
        expect(DDL).toMatch(/entity_observation_once UNIQUE \(entity_key, source, identifier, observed_at\)/);
        expect(buildReadLatestQuery()).toMatch(/DISTINCT ON \(entity_key, source, identifier\)/);
        expect(buildObservationSql({}).sql).toBe('');
    });

    it('the change_event kind list accepts both new kinds, and every source is allowed', () => {
        // The allowed kinds live in one file, applied last (stocks/lib/schema.mjs).
        const kinds = /change_event_kind_check CHECK \(kind IN \(([^;]+)\)\);/.exec(readFileSync(new URL('../db/2026-10-01-sonar-change-event-kinds.sql', import.meta.url), 'utf8'))[1];
        for (const k of ['entity-status', 'insolvency', 'litigation', 'status']) expect(kinds).toContain(`'${k}'`);
        for (const s of ['gleif', 'zefix', 'companies-house', 'gazette']) expect(DDL).toContain(`'${s}'`);
        expect(DDL).toMatch(/OWNER TO geo_user/);
        expect(buildChangeEventSql([{ detectedAt: AT, kind: 'insolvency', subjectType: 'issuer', subjectId: 'x', severity: 'critical' }]).sql).toMatch(/INSERT INTO sonar\.change_event/);
    });

    it('one Telegram summary, strongest first', () => {
        const text = formatTelegramSummary({
            findings: [
                { severity: 'info', entityName: 'A', source: 'gleif', field: 'nextRenewalDate', before: 'x', after: 'y' },
                { severity: 'critical', entityName: 'B', source: 'gazette', field: 'notice:1', before: null, after: 'Winding-Up Orders' }
            ],
            events: 3, failures: ['gleif X: timeout'], entitiesWatched: 22, resolved: 22, unresolved: 40, requests: 50, durationMs: 30000
        });
        const lines = text.split('\n');
        expect(lines[0]).toBe('RWA Sonar entity watch: 2 change(s), 1 failure(s)');
        expect(lines[2]).toMatch(/\[critical\] B/);
        expect(text).toMatch(/✗ gleif X: timeout/);
    });
});
