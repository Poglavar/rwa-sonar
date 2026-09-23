// Unit tests for the pure section of watch.js — the shaping behind watch.html (stocks/EVIDENCE.md
// §4). Every test asserts something a reader would notice if it broke: that the four vocabularies
// this page prints (source kinds and statuses, change kinds and severities, claim statuses) are
// exactly the ones the database will accept, that "last sweep" is the newest check and not the
// alphabetically last string, that the source registry's token-suffixed issuer slugs fold back
// onto the dossier's own slug instead of appearing as extra issuers, that a freshness bar's
// segments cover exactly 100 % of the claims or nothing at all, that a truncated value always
// keeps its full text for the hover, and that an unsafe URL never becomes a link.
//
// The vocabulary tests exist to stop this page and the schema drifting apart: all five lists are
// CHECK constraints in db/2026-09-18-sonar-evidence.sql and db/2026-09-18-sonar-claims.sql, which
// is the only place they are defined. The LABELS are this page's own; the values are not.

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const W = require('./watch.js');

const HTML = readFileSync(join(__dirname, 'watch.html'), 'utf8');
const CSS = readFileSync(join(__dirname, 'watch.css'), 'utf8');
const JS = readFileSync(join(__dirname, 'watch.js'), 'utf8');
const EVIDENCE_DDL = readFileSync(join(__dirname, 'db', '2026-09-18-sonar-evidence.sql'), 'utf8');
const CLAIM_DDL = readFileSync(join(__dirname, 'db', '2026-09-18-sonar-claims.sql'), 'utf8');

test('watch intro uses a small intrinsic patrol illustration and preserves monitoring details', () => {
    expect(HTML).toContain('patrol-v1-256.webp');
    expect(HTML).toContain('width="256" height="256"');
    expect(HTML).toContain('<summary>How monitoring works</summary>');
    expect(HTML).toContain('Observation times and review status remain with the evidence.');
});

/** The quoted values of a `CONSTRAINT <name> CHECK (<col> IN ('a', 'b', …))` in a DDL file. */
function checkValues(sql, name) {
    const at = sql.indexOf(`CONSTRAINT ${name}`);
    if (at < 0) throw new Error(`${name} is no longer declared in the DDL`);
    const statement = sql.slice(at, sql.indexOf(';', at));
    const list = statement.match(/IN \(([\s\S]*?)\)\)/);
    if (list === null) throw new Error(`${name} is not an IN (…) check any more`);
    return [...list[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

/** A source row as /api/sources returns one. */
function source(over) {
    return {
        id: 'aaaa0000aaaa',
        url: 'https://example.com/terms.pdf',
        kind: 'pdf',
        title: 'Example terms',
        issuer_slug: 'xstocks-backed',
        first_seen_at: '2026-09-17T15:00:00.000Z',
        last_checked_at: '2026-09-17T16:00:00.000Z',
        last_changed_at: null,
        archive_url: null,
        status: 'ok',
        error: null,
        claims: 3,
        versions: 1,
        ...over
    };
}

/** A change event as /api/changes returns one. */
function change(over) {
    return {
        id: '8',
        detected_at: '2026-09-17T17:15:17.000Z',
        kind: 'legal-term',
        subject_type: 'source',
        subject_id: 'aaaa0000aaaa',
        issuer_slug: 'xstocks-backed',
        field: null,
        before: 'a'.repeat(64),
        after: 'b'.repeat(64),
        severity: 'caution',
        evidence: { url: 'https://example.com/terms.pdf', versionFetchedAt: '2026-09-17T17:15:17Z' },
        summary: 'Terms moved: +16 -16 line(s) · keywords: redemption',
        acknowledged_at: null,
        ...over
    };
}

const NAMES = new Map([
    ['xstocks-backed', 'Backed (xStocks)'],
    ['bullish', 'Bullish BLSH'],
    ['securitize', 'Securitize'],
    ['backpack-securities', 'Backpack Securities']
]);

// ------------------------------------------------- the vocabularies the database will accept

describe('the five vocabularies this page holds a copy of', () => {
    test('SOURCE_KINDS and SOURCE_STATUSES are exactly the source table\'s CHECK constraints', () => {
        // A kind or status the page does not know would be counted into a tile that does not
        // exist, and so would vanish from the totals without anything reporting it.
        expect(W.SOURCE_KINDS).toEqual(checkValues(EVIDENCE_DDL, 'source_kind_check'));
        expect(W.SOURCE_STATUSES.slice().sort())
            .toEqual(checkValues(EVIDENCE_DDL, 'source_status_check').slice().sort());
        expect(W.SOURCE_STATUSES).toHaveLength(6);
    });

    test('CHANGE_KINDS and SEVERITIES are exactly the change_event CHECK constraints', () => {
        expect(W.CHANGE_KINDS.slice().sort())
            .toEqual(checkValues(EVIDENCE_DDL, 'change_event_kind_check').slice().sort());
        expect(W.SEVERITIES.slice().sort())
            .toEqual(checkValues(EVIDENCE_DDL, 'change_event_severity_check').slice().sort());
    });

    test('the public claim statuses omit the internal editorial-correction state', () => {
        const databaseStatuses = checkValues(CLAIM_DDL, 'claim_status_check');
        expect(databaseStatuses).toContain('contradicted-corrected');
        expect(W.CLAIM_STATUSES).not.toContain('contradicted-corrected');
        expect(W.CLAIM_STATUSES.slice().sort())
            .toEqual(databaseStatuses.filter((status) => status !== 'contradicted-corrected').sort());
    });

    test('every value in every vocabulary has a label, a tone and a blurb', () => {
        // A missing entry is how a filter ends up offering a blank option, or a chip ends up
        // rendering a raw enum value as though it were English.
        for (const kind of W.CHANGE_KINDS) expect(typeof W.CHANGE_KIND_LABELS[kind]).toBe('string');
        for (const status of W.SOURCE_STATUSES) {
            expect(W.TONES).toContain(W.SOURCE_STATUS_TONE[status]);
            expect(typeof W.SOURCE_STATUS_BLURBS[status]).toBe('string');
        }
        for (const kind of W.SOURCE_KINDS) expect(typeof W.SOURCE_KIND_BLURBS[kind]).toBe('string');
        for (const status of W.CLAIM_STATUSES) {
            expect(typeof W.CLAIM_STATUS_LABELS[status]).toBe('string');
            expect(typeof W.CLAIM_STATUS_BLURBS[status]).toBe('string');
            expect(W.TONES).toContain(W.CLAIM_STATUS_TONE[status]);
        }
    });

    test('confirmed is the only claim status that reads as good', () => {
        // "Unverified" must never be painted as a pass — the same rule the health monitor holds
        // for `unknown`: we did not verify this is not the same claim as this is fine.
        const good = W.CLAIM_STATUSES.filter((status) => W.CLAIM_STATUS_TONE[status] === 'good');
        expect(good).toEqual(['confirmed']);
    });
});

// ------------------------------------------------- the since window and pagination

describe('the since quick pick', () => {
    const NOW = Date.UTC(2026, 8, 17, 18, 0, 0); // 2026-09-17T18:00:00Z

    test('each window is that many hours before the given clock', () => {
        expect(W.sinceIso('24h', NOW)).toBe('2026-09-16T18:00:00.000Z');
        expect(W.sinceIso('7d', NOW)).toBe('2026-09-10T18:00:00.000Z');
        expect(W.sinceIso('30d', NOW)).toBe('2026-08-18T18:00:00.000Z');
    });

    test('"all" and an unknown key are no lower bound at all, never a narrowed one', () => {
        // A silently narrowed window is the worst answer available: it looks like a full feed.
        expect(W.sinceIso('all', NOW)).toBeNull();
        expect(W.sinceIso('', NOW)).toBeNull();
        expect(W.sinceIso('forever', NOW)).toBeNull();
        expect(W.sinceIso(undefined, NOW)).toBeNull();
    });

    test('every choice the page offers is one sinceIso understands', () => {
        for (const choice of W.SINCE_CHOICES) {
            const iso = W.sinceIso(choice.key, NOW);
            if (choice.hours === null) expect(iso).toBeNull();
            else expect(Date.parse(iso)).toBe(NOW - choice.hours * 3600 * 1000);
        }
    });
});

describe('the anonymous since-your-last-visit journal baseline', () => {
    const rows = W.journalRows({ items: [
        { id: 'rights', date: '2026-09-21', kind: 'legal-term', title: 'Redemption eligibility changed', severity: 'info' },
        { id: 'venue', date: '2026-09-21', kind: 'venue', title: 'A venue was added', severity: 'info' }
    ] });

    test('the first visit establishes a baseline instead of calling the whole history new', () => {
        const summary = W.journalVisitSummary(rows, null);
        expect(summary).toMatchObject({ firstVisit: true, newCount: 0, highImpactCount: 0 });
        expect(summary.currentIdentities).toEqual(['rights', 'venue']);
    });

    test('later visits count only unseen journal identities and preserve impact ranking', () => {
        const summary = W.journalVisitSummary(rows, ['venue']);
        expect(summary).toMatchObject({ firstVisit: false, newCount: 1, highImpactCount: 1 });
        expect(summary.unseen.map((row) => row.id)).toEqual(['rights']);
    });

    test('a row without an id still has a repeatable identity', () => {
        const row = { date: '2026-09-21', kind: 'venue', title: 'Pool removed' };
        expect(W.journalIdentity(row)).toBe(W.journalIdentity({ ...row }));
    });

    test('labels observation time honestly instead of implying the outside event happened then', () => {
        expect(W.journalTimeLabel({ date: '2026-09-21', firstObservedAt: '2026-09-21' }))
            .toBe('First observed 2026-09-21');
        expect(W.journalTimeLabel({ date: '2026-09-21', eventAt: '2026-09-20', firstObservedAt: '2026-09-21' }))
            .toBe('Event 2026-09-20 · First observed 2026-09-21');
    });
});

describe('paginating the source registry', () => {
    test('the offsets cover the whole registry and never ask for a page past the end', () => {
        expect(W.pageOffsets(337, 500)).toEqual([0]);
        expect(W.pageOffsets(500, 500)).toEqual([0]);
        expect(W.pageOffsets(501, 500)).toEqual([0, 500]);
        expect(W.pageOffsets(1264, 500)).toEqual([0, 500, 1000]);
    });

    test('an empty or unknown total is still one call, which is how the total is learnt', () => {
        expect(W.pageOffsets(0, 500)).toEqual([0]);
        expect(W.pageOffsets(null, 500)).toEqual([0]);
    });
});

// ------------------------------------------------- truncation, which must never lose anything

describe('truncation keeps the whole value for the hover', () => {
    test('a short value is untouched and is not marked truncated', () => {
        const shape = W.truncate('p. 5, cl. 1.20', 40);
        expect(shape).toMatchObject({ text: 'p. 5, cl. 1.20', truncated: false, empty: false });
    });

    test('a long value is cut on a word boundary and keeps its full text', () => {
        const full = 'Underlying Assets may comprise shares or other equity securities, debt securities';
        const shape = W.truncate(full, 40);
        expect(shape.truncated).toBe(true);
        expect(shape.full).toBe(full);
        expect(shape.text.endsWith('…')).toBe(true);
        expect(shape.text.length).toBeLessThanOrEqual(41);
        expect(full.startsWith(shape.text.slice(0, -1))).toBe(true);
    });

    test('an absent value is a dash and is flagged empty, so no row prints "undefined"', () => {
        for (const value of [null, undefined, '', '   ']) {
            expect(W.truncate(value, 20)).toMatchObject({ text: '—', empty: true });
        }
    });

    test('a content hash is cut to twelve characters and flagged as one', () => {
        // before/after on a document diff ARE sha256 hashes; 64 characters of hex in a feed row
        // pushes the summary off the screen and nobody reads the middle of one.
        const shape = W.shapeValue('a'.repeat(64), 90);
        expect(shape.hashLike).toBe(true);
        expect(shape.text).toBe(`${'a'.repeat(12)}…`);
        expect(shape.full).toBe('a'.repeat(64));
        expect(W.shapeValue('paused', 90)).toMatchObject({ hashLike: false, text: 'paused' });
        expect(W.isHashLike('deadbeef')).toBe(false);
    });
});

// ------------------------------------------------- the issuer slug the source registry uses

describe('folding the source registry\'s issuer slugs onto the dossiers', () => {
    test('a token-suffixed slug resolves to the issuer it belongs to', () => {
        // Measured 2026-09-17: sonar.source keys three of the twelve issuers with a token suffix
        // while sonar.claim and sonar.stock_issuer do not, so without this the page shows fifteen
        // issuers, three of them nameless duplicates.
        expect(W.resolveIssuerSlug('bullish-blsh', NAMES)).toBe('bullish');
        expect(W.resolveIssuerSlug('securitize-secz', NAMES)).toBe('securitize');
        expect(W.resolveIssuerSlug('backpack-securities-spcx', NAMES)).toBe('backpack-securities');
    });

    test('an exact slug wins, and an unknown slug is kept rather than dropped', () => {
        expect(W.resolveIssuerSlug('xstocks-backed', NAMES)).toBe('xstocks-backed');
        expect(W.resolveIssuerSlug('someone-else', NAMES)).toBe('someone-else');
        expect(W.resolveIssuerSlug(null, NAMES)).toBeNull();
        expect(W.resolveIssuerSlug('   ', NAMES)).toBeNull();
    });

    test('the longest matching issuer wins, so a prefix cannot steal another issuer\'s sources', () => {
        const names = new Map([['backed', 'Backed'], ['backed-finance', 'Backed Finance']]);
        expect(W.resolveIssuerSlug('backed-finance-xyz', names)).toBe('backed-finance');
    });

    test('a dossier link is the anchor stocks.js gives each card, and unsafe slugs get none', () => {
        expect(W.dossierHref('xstocks-backed')).toBe('./issuers/xstocks-backed.html');
        expect(W.dossierHref('a b')).toBeNull();
        expect(W.dossierHref(null)).toBeNull();
    });
});

// ------------------------------------------------- the source tiles and the per-issuer rows

describe('the source tiles', () => {
    const sources = [
        source({ id: 's1', kind: 'pdf', status: 'ok', last_checked_at: '2026-09-17T09:50:27.000Z' }),
        source({ id: 's2', kind: 'html', status: 'changed', last_checked_at: '2026-09-17T17:20:18.000Z' }),
        source({ id: 's3', kind: 'html', status: 'blocked', error: 'HTTP 403', last_checked_at: '2026-09-17T12:00:00.000Z' }),
        source({ id: 's4', kind: 'api', status: 'gone', last_checked_at: null }),
        source({ id: 's5', kind: 'html', status: 'ok', archive_url: 'https://web.archive.org/web/2026/x' }),
        source({ id: 's6', kind: 'html', status: 'ok', archive_url: 'javascript:alert(1)' })
    ];

    test('every kind and every status is a tile, including the ones with no sources in them', () => {
        const totals = W.sourceTotals(sources);
        expect(totals.byKind.map((tile) => [tile.key, tile.count]))
            .toEqual([['pdf', 1], ['html', 4], ['api', 1], ['onchain', 0]]);
        expect(totals.byStatus.map((tile) => [tile.key, tile.count]))
            .toEqual([['new', 0], ['ok', 3], ['changed', 1], ['gone', 1], ['blocked', 1], ['error', 0]]);
        expect(totals.total).toBe(6);
    });

    test('the last sweep is the newest check, not the last string in the list', () => {
        // 09:50 sorts before 17:20 but arrives first; a max taken by iteration order reports the
        // wrong sweep time, and "last sweep 8 hours ago" is exactly the sort of number nobody
        // double-checks.
        expect(W.sourceTotals(sources).lastSweepAt).toBe('2026-09-17T17:20:18.000Z');
        expect(W.sourceTotals([source({ last_checked_at: null })]).lastSweepAt).toBeNull();
    });

    test('only a real archive URL counts as archived, and a fetch error is counted', () => {
        const totals = W.sourceTotals(sources);
        expect(totals.archived).toBe(1);
        expect(totals.errors).toBe(1);
    });

    test('an empty registry has zero everywhere rather than throwing', () => {
        const totals = W.sourceTotals(null);
        expect(totals.total).toBe(0);
        expect(totals.lastSweepAt).toBeNull();
        expect(totals.byStatus.every((tile) => tile.count === 0)).toBe(true);
    });
});

describe('source read provenance', () => {
    test('a source read from a Wayback capture says so, with the capture\'s own date', () => {
        const row = W.sourceRow(source({
            status: 'ok', http_status: 403, read_via: 'wayback', capture_at: '2026-09-18T13:57:22.000Z', error: null
        }));
        expect(row.readVia).toBe('wayback');
        expect(row.captureAt).toBe('2026-09-18T13:57:22.000Z');
        expect(row.captureNote).toBe('read from the Wayback capture of 18 Sep 2026 13:57 UTC');
    });

    test('a live read carries no capture note, and a stray capture time on one is ignored', () => {
        expect(W.sourceRow(source({ read_via: 'html' })).captureNote).toBeNull();
        expect(W.sourceRow(source({ read_via: 'pdf', capture_at: '2026-09-18T13:57:22.000Z' })).captureAt).toBeNull();
        expect(W.sourceRow(source({})).captureNote).toBeNull();
    });

    test('the page renders the capture note on the source row', () => {
        expect(JS).toContain('wat-source-capture');
        expect(JS).toMatch(/\$\{capture\}/);
    });
});

describe('the per-issuer source rows', () => {
    const sources = [
        source({ id: 's1', issuer_slug: 'securitize-secz', status: 'ok' }),
        source({ id: 's2', issuer_slug: 'securitize', status: 'gone', title: 'A dead filing' }),
        source({ id: 's3', issuer_slug: 'securitize', status: 'blocked', error: 'HTTP 403' }),
        source({ id: 's4', issuer_slug: 'xstocks-backed', status: 'changed', last_checked_at: '2026-09-17T18:00:00.000Z' }),
        source({ id: 's5', issuer_slug: null, status: 'ok' }),
        source({ id: 's6', issuer_slug: '   ', status: 'ok' })
    ];

    test('a suffixed slug and its real slug are ONE row, with the issuer\'s name and dossier', () => {
        const rows = W.sourcesByIssuer(sources, NAMES);
        const securitize = rows.find((row) => row.slug === 'securitize');
        expect(rows.map((row) => row.slug)).toEqual(['securitize', 'xstocks-backed', 'unattributed']);
        expect(securitize.count).toBe(3);
        expect(securitize.name).toBe('Securitize');
        expect(securitize.href).toBe('./issuers/securitize.html');
    });

    test('the per-issuer counts are the states worth acting on', () => {
        const securitize = W.sourcesByIssuer(sources, NAMES).find((row) => row.slug === 'securitize');
        expect(securitize).toMatchObject({ gone: 1, blocked: 1, changed: 0, archived: 0 });
    });

    test('a source with no issuer is grouped, named and left unlinked rather than dropped', () => {
        // And it reads LAST however many there are (51 of 337 on 2026-09-17, more than any single
        // issuer): two orphans outnumber xstocks-backed's one and still sort behind it, because
        // "No issuer recorded" leading the section reads as though it were the biggest issuer.
        const rows = W.sourcesByIssuer(sources, NAMES);
        const orphan = rows.find((row) => row.slug === W.UNATTRIBUTED);
        expect(rows[rows.length - 1].slug).toBe(W.UNATTRIBUTED);
        expect(orphan.count).toBe(2);
        expect(orphan.href).toBeNull();
        expect(rows.reduce((sum, row) => sum + row.count, 0)).toBe(sources.length);
    });

    test('inside an issuer the worst state reads first', () => {
        const securitize = W.sourcesByIssuer(sources, NAMES).find((row) => row.slug === 'securitize');
        expect(securitize.items.map((item) => item.status)).toEqual(['blocked', 'gone', 'ok']);
    });

    test('a "title" that is only a dossier field path is not printed as the document\'s name', () => {
        // 109 of the 337 sources on 2026-09-17 carry a field path as their title, because the
        // dossier cited a bare URL. Listing a third of the registry as `xstocks-backed:sources[14]`
        // tells the reader nothing about the document; the URL does, and the field path still says
        // something true — which dossier field cites it — so it moves rather than being dropped.
        const [group] = W.sourcesByIssuer([source({
            title: 'xstocks-backed:sources[14]',
            url: 'https://tools.prnewswire.com/en-us/live/20823/release/20250630EN21069'
        })], NAMES);
        expect(group.items[0].title.full).toBe('tools.prnewswire.com/release/20250630EN21069');
        expect(group.items[0].citedAs).toBe('xstocks-backed:sources[14]');
    });

    test('a real title is kept exactly as it is, with no field path invented for it', () => {
        const [group] = W.sourcesByIssuer([source({ title: 'Backed Assets (JE) Limited — Base Prospectus' })], NAMES);
        expect(group.items[0].title.full).toBe('Backed Assets (JE) Limited — Base Prospectus');
        expect(group.items[0].citedAs).toBeNull();
    });

    test('the URL label is the host and the end of the path, and never throws', () => {
        expect(W.urlLabel('https://www.sec.gov/Archives/edgar/data/2045370/000121390025048152/ea0.htm'))
            .toBe('sec.gov/000121390025048152/ea0.htm');
        expect(W.urlLabel('https://backed.fi/')).toBe('backed.fi');
        expect(W.urlLabel('not a url at all')).toBe('not a url at all');
        expect(W.urlLabel(null)).toBeNull();
        expect(W.isFieldPathTitle('securitize-secz:attestations[10].link')).toBe(true);
        expect(W.isFieldPathTitle('backpack-securities-spcx:parties.distributors[2].source')).toBe(true);
        // A real title that merely CONTAINS a colon must survive: the pattern is anchored at both
        // ends and the field name has to start lowercase, so neither of these is a field path.
        expect(W.isFieldPathTitle('Ondo: the prospectus')).toBe(false);
        expect(W.isFieldPathTitle('ondo: the tracker certificate')).toBe(false);
        expect(W.isFieldPathTitle('xstocks-backed:sources[14] and a note')).toBe(false);
        // Dossier field names are camelCase and start lowercase; a capital after the colon is a
        // title (`shift:Leveraged`, a name with a prefix), not a path into a record.
        expect(W.isFieldPathTitle('shift:Leveraged')).toBe(false);
    });

    test('a source row links its own URL, its archive copy and nothing unsafe', () => {
        const rows = W.sourcesByIssuer([
            source({ url: 'javascript:alert(1)', archive_url: 'https://web.archive.org/web/2026/x' })
        ], NAMES);
        const item = rows[0].items[0];
        expect(item.href).toBeNull();
        expect(item.archiveHref).toBe('https://web.archive.org/web/2026/x');
    });
});

// ------------------------------------------------- the change feed

describe('the change feed rows', () => {
    const sourceIndex = new Map([['aaaa0000aaaa', W.sourceRow(source({
        title: 'Backpack Securities — Issuer Terms and Conditions',
        archive_url: 'https://web.archive.org/web/2026/terms'
    }))]]);

    test('a document diff names the source it was read from and links the document', () => {
        const [row] = W.changeRows([change()], { names: NAMES, sources: sourceIndex });
        expect(row.subjectLabel).toBe('Backpack Securities — Issuer Terms and Conditions');
        expect(row.subjectHref).toBe('https://example.com/terms.pdf');
        expect(row.kindLabel).toBe('Legal term');
        expect(row.severity).toBe('caution');
        expect(row.evidence.href).toBe('https://example.com/terms.pdf');
        expect(row.evidence.archiveHref).toBe('https://web.archive.org/web/2026/terms');
        expect(row.evidence.versionFetchedAt).toBe('2026-09-17T17:15:17Z');
        // The evidence IS the document the event is about, and the row says so instead of
        // printing the same long title twice.
        expect(row.evidence.sameAsSubject).toBe(true);
    });

    test('evidence that is NOT the subject document is not flagged as the same thing', () => {
        const [onchain] = W.changeRows([change({
            subject_type: 'token', subject_id: 'MINT_A', kind: 'rebase',
            evidence: { account: 'MINT_A', slot: 1 }
        })], { names: NAMES, sources: sourceIndex });
        expect(onchain.evidence.sameAsSubject).toBe(false);
        const [other] = W.changeRows([change({
            evidence: { url: 'https://example.com/a-different-page' }
        })], { names: NAMES, sources: sourceIndex });
        expect(other.evidence.sameAsSubject).toBe(false);
        expect(other.evidence.href).toBe('https://example.com/a-different-page');
    });

    test('the two hashes a diff moved between are cut short but never lost', () => {
        const [row] = W.changeRows([change()], { names: NAMES, sources: sourceIndex });
        expect(row.before.hashLike).toBe(true);
        expect(row.before.full).toBe('a'.repeat(64));
        expect(row.after.full).toBe('b'.repeat(64));
        expect(row.before.text.length).toBeLessThan(20);
    });

    test('a token subject links to its card by SYMBOL, which only the token index knows', () => {
        const tokens = new Map([['MINT_A', { symbol: 'AAPLx', name: 'Apple xStock' }]]);
        const [row] = W.changeRows([change({
            subject_type: 'token', subject_id: 'MINT_A', kind: 'extension-toggle', severity: 'warning'
        })], { names: NAMES, tokens });
        expect(row.subjectLabel).toBe('AAPLx');
        expect(row.subjectHref).toBe('./cards/AAPLx.html');
        expect(row.subjectNote).toBe('Apple xStock');
    });

    test('a token with no row in the API gets a shortened mint and NO link, never a 404', () => {
        const [row] = W.changeRows([change({ subject_type: 'token', subject_id: 'MINT_UNKNOWN_123456789' })], { names: NAMES });
        expect(row.subjectHref).toBeNull();
        expect(row.subjectLabel).toMatch(/^MINT_UNKNOWN…?$/);
    });

    test('an issuer subject reads as the issuer\'s name and links to its dossier', () => {
        const [row] = W.changeRows([change({
            subject_type: 'issuer', subject_id: 'bullish', issuer_slug: 'bullish-blsh', kind: 'status'
        })], { names: NAMES });
        expect(row.subjectLabel).toBe('Bullish BLSH');
        expect(row.subjectHref).toBe('./issuers/bullish.html');
        expect(row.issuerName).toBe('Bullish BLSH');
        expect(row.kindLabel).toBe('Issuer status');
    });

    test('an on-chain change shows the account, the slot and the signature it was read at', () => {
        const [row] = W.changeRows([change({
            subject_type: 'token',
            subject_id: 'MINT_A',
            kind: 'authority-key',
            evidence: { account: 'MINT_A', slot: 371882104, signature: 'sig'.repeat(20) }
        })], { names: NAMES });
        expect(row.evidence.parts).toEqual(['account MINT_A', 'slot 371,882,104', 'tx sigsigsigsigsigs…']);
        expect(row.evidence.href).toBeNull();
    });

    test('a market change shows the two snapshot dates it was diffed from', () => {
        const [row] = W.changeRows([change({
            kind: 'liquidity', subject_type: 'token', subject_id: 'MINT_A',
            evidence: { snapshotDates: ['2026-09-16', '2026-09-17'] }
        })], { names: NAMES });
        expect(row.evidence.parts).toEqual(['snapshots 2026-09-16 → 2026-09-17']);
    });

    test('an event with no evidence at all says so rather than pretending to have some', () => {
        const [row] = W.changeRows([change({ evidence: null, subject_type: 'issuer', subject_id: 'bullish' })], { names: NAMES });
        expect(row.evidence.label).toBeNull();
        expect(row.evidence.href).toBeNull();
        expect(row.evidence.parts).toEqual([]);
    });

    test('an issuer event does not name its issuer twice in the same row', () => {
        // The chain watcher's first rows once repeated the Backpack programme name twice.
        const [own] = W.changeRows([change({ subject_type: 'issuer', subject_id: 'bullish', issuer_slug: 'bullish-blsh' })], { names: NAMES });
        expect(own.issuerIsSubject).toBe(true);
        const [doc] = W.changeRows([change()], { names: NAMES });
        expect(doc.issuerIsSubject).toBe(false);
        expect(doc.issuerName).toBe('Backed (xStocks)');
    });

    test('a slot with no document behind it still counts as evidence', () => {
        // "no evidence recorded · slot 447,856,408" was on the page: the label was null because
        // there is no source, but the slot IS the evidence, so the row must not deny having any.
        const [row] = W.changeRows([change({
            subject_type: 'issuer', subject_id: 'bullish', evidence: { slot: 447856408 }
        })], { names: NAMES });
        expect(row.evidence.label).toBeNull();
        expect(W.evidenceIsEmpty(row.evidence)).toBe(false);
        const [bare] = W.changeRows([change({ subject_type: 'issuer', subject_id: 'bullish', evidence: null })], { names: NAMES });
        expect(W.evidenceIsEmpty(bare.evidence)).toBe(true);
        expect(W.evidenceIsEmpty(null)).toBe(true);
    });

    test('a severity the schema does not have falls back to info, never to critical', () => {
        const [row] = W.changeRows([change({ severity: 'catastrophic' })], { names: NAMES });
        expect(row.severity).toBe('info');
    });
});

// ------------------------------------------------- the freshness bars

describe('the evidence freshness bars', () => {
    const summary = {
        claims: 95, confirmed: 54, unverified: 33, inference: 2, corrected: 6, changed: 0,
        source_gone: 0, fields_sourced: 49, fields_with_claims: 88,
        last_checked_at: '2026-09-17T15:25:34.000Z'
    };

    test('the segments cover exactly 100 % of the claims', () => {
        // 54/95, 33/95, 6/95, 2/95 all round down; a bar that sums to 99 leaves a sliver of
        // background showing, which reads as a category nobody named.
        const [row] = W.freshnessBars([{ slug: 'bullish', name: 'Bullish BLSH', summary }]);
        expect(row.segments.reduce((sum, seg) => sum + seg.pct, 0)).toBe(100);
        expect(row.claims).toBe(95);
    });

    test('only the statuses that occur get a segment, and they stay in trust order', () => {
        const [row] = W.freshnessBars([{ slug: 'bullish', summary }]);
        expect(row.segments.map((seg) => seg.status))
            .toEqual(['confirmed', 'inference', 'unverified']);
        expect(row.segments[0].count).toBe(60);
        expect(row.segments.every((seg) => seg.count > 0)).toBe(true);
    });

    test('an issuer with no claims yet is an empty bar, not a full one', () => {
        const [row] = W.freshnessBars([{ slug: 'nobody', summary: { claims: 0 } }]);
        expect(row.segments).toEqual([]);
        expect(row.claims).toBe(0);
        expect(W.sharesOf([0, 0, 0], 0).reduce((a, b) => a + b, 0)).toBe(0);
    });

    test('the dossier\'s own coverage is used when a caller has it, and is labelled as such', () => {
        // /api/issuers does not carry the dossier's `evidence` block today (checked 2026-09-17), so
        // the denominator is the claims' own distinct fields — and `basis` says which it is, so the
        // page can never present one as the other.
        const [claims] = W.freshnessBars([{ slug: 'bullish', summary }]);
        expect(claims).toMatchObject({ sourced: 49, needed: 88, basis: 'claims' });
        const [dossier] = W.freshnessBars([{ slug: 'bullish', summary, coverage: { sourced: 39, needed: 48 } }]);
        expect(dossier).toMatchObject({ sourced: 39, needed: 48, basis: 'dossier' });
    });

    test('the issuer with the most claims reads first, and every row can be clicked through', () => {
        const rows = W.freshnessBars([
            { slug: 'bullish', name: 'Bullish BLSH', summary: { claims: 95, confirmed: 95 } },
            { slug: 'securitize', name: 'Securitize', summary: { claims: 128, confirmed: 128 } }
        ]);
        expect(rows.map((row) => row.slug)).toEqual(['securitize', 'bullish']);
        expect(rows[0].href).toBe('./issuers/securitize.html');
    });

    test('percentages are handed out to the segments that exist, never to an empty one', () => {
        const shares = W.sharesOf([1, 0, 2], 3);
        expect(shares[1]).toBe(0);
        expect(shares.reduce((a, b) => a + b, 0)).toBe(100);
    });
});

describe('the public change journal', () => {
    test('keeps safe links and lifecycle context while rejecting executable URLs', () => {
        const [row] = W.journalRows({ items: [{
            id: 'one', date: '2026-09-20', kind: 'asset-added', severity: 'info',
            title: 'NEWx entered the catalogue', href: 'javascript:alert(1)',
            assets: [{ mint: 'M', symbol: 'NEWx', operationalStatus: 'issuer-reports-zero-circulation', href: './cards/newx.html' }],
            sources: [{ label: 'Issuer', url: 'https://issuer.example/registry' }]
        }] });
        expect(row.href).toBeNull();
        expect(row.assets[0]).toMatchObject({ symbol: 'NEWx', operationalStatus: 'issuer-reports-zero-circulation', href: './cards/newx.html' });
        expect(row.sources[0].url).toBe('https://issuer.example/registry');
    });

    test('ranks changes by likely holder impact while keeping technical severity separate', () => {
        const rows = W.journalRows({ items: [
            { id: 'catalogue', date: '2026-09-21', kind: 'asset-added', severity: 'info', title: 'Mint added' },
            { id: 'rights', date: '2026-09-20', kind: 'legal-term', severity: 'caution', title: 'Redemption changed', field: 'redemption.rails' },
            { id: 'market', date: '2026-09-21', kind: 'liquidity', severity: 'warning', title: 'Liquidity fell' }
        ] });
        const groups = W.impactGroups(rows);
        expect(groups.map((group) => group.key)).toEqual(['high', 'medium', 'low']);
        expect(groups[0].items[0]).toMatchObject({ id: 'rights', severity: 'caution' });
        expect(groups[0].items[0].impact.reason).toContain('enforceability');
    });
});

// ------------------------------------------------- the claims lookup

describe('the claims lookup rows', () => {
    const claim = {
        id: 'backpack-securities:collateral.composition:758ac5ce',
        subject_type: 'issuer',
        issuer_slug: 'backpack-securities',
        field: 'collateral.composition',
        value: 'shares',
        quote: 'Underlying Assets may comprise shares or other equity securities.',
        url: 'https://drive.google.com/file/d/1stJoNwPAOaHDbFmL72OGSkAxyCf-_RCo/view',
        locator: "p. 5, cl. 1.20 'Underlying Assets'",
        status: 'confirmed',
        method: 'manual',
        note: null,
        source_title: 'Backpack Securities — Issuer Terms and Conditions',
        source_archive_url: null,
        accessed_at: '2026-09-17T15:17:23.000Z',
        recorded_at: '2026-09-17T17:17:24.884Z',
        last_checked_at: '2026-09-17T15:17:23.000Z',
        last_confirmed_at: '2026-09-17T15:17:23.000Z'
    };

    test('a claim row carries the quote, the source, the locator and the three timestamps', () => {
        const [row] = W.claimRows([claim]);
        expect(row.quote.full).toBe(claim.quote);
        expect(row.sourceTitle.full).toBe(claim.source_title);
        expect(row.sourceHref).toBe(claim.url);
        expect(row.locator.full).toBe(claim.locator);
        expect(row).toMatchObject({
            accessedAt: claim.accessed_at,
            recordedAt: claim.recorded_at,
            lastCheckedAt: claim.last_checked_at,
            statusLabel: 'confirmed',
            tone: 'good'
        });
    });

    test('a claim whose source has only a field-path title shows the document, not the path', () => {
        const [row] = W.claimRows([{
            ...claim,
            source_title: 'ventuals:attestations[0].link',
            url: 'https://docs.ventuals.com/overview/markets'
        }]);
        expect(row.sourceTitle.full).toBe('docs.ventuals.com/overview/markets');
        expect(row.citedAs).toBe('ventuals:attestations[0].link');
    });

    test('a structured value is shown as JSON rather than as "[object Object]"', () => {
        const [row] = W.claimRows([{ ...claim, field: 'chains', value: ['Solana'] }]);
        expect(row.value.full).toBe('["Solana"]');
    });

    test('a claim with no quote keeps its status and its note instead of pretending to have one', () => {
        const [row] = W.claimRows([{
            ...claim, status: 'inference', quote: null, url: null, note: 'Our reading of cl. 4.'
        }]);
        expect(row.quote.empty).toBe(true);
        expect(row.note.full).toBe('Our reading of cl. 4.');
        expect(row.sourceHref).toBeNull();
        expect(row.tone).toBe('caution');
    });

    test('a status the schema does not have falls back to unverified, never to confirmed', () => {
        const [row] = W.claimRows([{ ...claim, status: 'probably-fine' }]);
        expect(row.status).toBe('unverified');
    });

    test('the field filter is a case-insensitive substring, because the API\'s is exact', () => {
        const rows = W.claimRows([claim, { ...claim, id: 'x', field: 'redemption.rails' }]);
        expect(W.filterClaimRows(rows, 'REDEMPTION').map((row) => row.field)).toEqual(['redemption.rails']);
        expect(W.filterClaimRows(rows, 'collateral')).toHaveLength(1);
        expect(W.filterClaimRows(rows, '')).toHaveLength(2);
        expect(W.filterClaimRows(rows, 'nothing-like-this')).toHaveLength(0);
    });
});

// ------------------------------------------------- failure reporting and request ordering

describe('when the API does not answer', () => {
    test('the message names the call and what happened to it', () => {
        expect(W.describeApiFailure({ path: '/api/changes', status: 500 }))
            .toBe('/api/changes answered HTTP 500.');
        expect(W.describeApiFailure({ path: '/api/sources', message: 'Failed to fetch' }))
            .toBe('/api/sources did not answer: Failed to fetch');
        expect(W.describeApiFailure({})).toBe('the API did not answer.');
    });

    test('a slow earlier answer cannot repaint a feed the reader has moved off', () => {
        const sequence = W.createSequence();
        const first = sequence.next();
        const second = sequence.next();
        expect(sequence.isCurrent(first)).toBe(false);
        expect(sequence.isCurrent(second)).toBe(true);
    });
});

// ------------------------------------------------- the page itself

describe('watch.html and watch.css', () => {
    test('every element watch.js looks up by id exists in watch.html', () => {
        // A renamed id is a section that silently never renders: the lookup returns null and the
        // render function returns early without a word.
        const ids = [...JS.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1]);
        expect(ids.length).toBeGreaterThan(10);
        for (const id of ids) expect(HTML).toContain(`id="${id}"`);
    });

    test('the scripts load in dependency order, each with a cache-busting version', () => {
        const fmtAt = HTML.indexOf('stocks/lib/fmt.js?v=');
        const apiAt = HTML.indexOf('stocks/lib/api-base.js?v=');
        const watchAt = HTML.indexOf('watch.js?v=');
        expect(fmtAt).toBeGreaterThan(-1);
        expect(apiAt).toBeGreaterThan(fmtAt);
        expect(watchAt).toBeGreaterThan(apiAt);
        expect(HTML).toMatch(/stocks\.css\?v=\d{8}[a-z]/);
        expect(HTML).toMatch(/watch\.css\?v=\d{8}[a-z]/);
    });

    test('the page links to every other page, and the others link back to it', () => {
        for (const page of ['./stocks.html', './graph.html', './live.html', './monitor.html', './index.html']) {
            expect(HTML).toContain(`href="${page}"`);
        }
        for (const page of ['index.html', 'stocks.html', 'graph.html', 'live.html', 'monitor.html']) {
            const other = readFileSync(join(__dirname, page), 'utf8');
            expect(other).toMatch(/<a id="nav-watch"[^>]*href="\.\/watch\.html"/);
        }
    });

    test('no JavaScript and no styling decision is inline in the HTML', () => {
        expect(HTML).not.toMatch(/<script(?![^>]*\ssrc=)/);
        expect(HTML).not.toMatch(/\sstyle="/);
        expect(HTML).not.toMatch(/\son[a-z]+="/);
    });

    test('nothing is forced with !important and every colour comes from a custom property', () => {
        expect(CSS).not.toContain('!important');
        expect(CSS).not.toMatch(/:\s*#[0-9a-fA-F]{3,6}\b/);
        expect(CSS).toMatch(/var\(--panel-border\)/);
    });

    test('an expanded issuer panel actually disappears when it is collapsed', () => {
        // The browser's own `[hidden] { display: none }` loses to any author `display` rule, which
        // is how a "collapsed" panel keeps showing its sources.
        expect(CSS).toMatch(/\.wat-issuer-body\[hidden\]\s*\{\s*\n\s*display: none;/);
    });

    test('every tone the module names is defined once in the CSS, and none is a duplicate', () => {
        // Every reader-facing evidence state needs a distinct colour as well as its text label.
        for (const tone of W.TONES) expect(CSS).toContain(`.wat-tone-${tone} {`);
        const severities = W.SEVERITIES.filter((severity) => W.TONES.includes(severity));
        expect(severities).toEqual(['info', 'caution', 'warning', 'critical']);
        const claimTones = W.CLAIM_STATUSES.map((status) => W.CLAIM_STATUS_TONE[status]);
        expect(new Set(claimTones).size).toBe(claimTones.length);
    });

    test('every container of source text can break a word that is wider than a phone', () => {
        // A claim quote carried a 96-character URL with no space in it and pushed the page
        // sideways at 360 px. Anything that renders words we did not write needs this.
        const block = (selector) => {
            const at = CSS.indexOf(`${selector} {`);
            if (at < 0) throw new Error(`${selector} is no longer a rule in watch.css`);
            return CSS.slice(at, CSS.indexOf('}', at));
        };
        for (const selector of ['.wat-cut', '.wat-claim-quote', '.wat-source-title',
            '.wat-claim-meta', '.wat-change-body dd', '.wat-subject']) {
            expect(block(selector)).toContain('overflow-wrap: anywhere');
        }
    });

    test('the layout has a phone case for the two things that would overlap on one', () => {
        expect(CSS).toMatch(/@media \(max-width: 600px\)[\s\S]*\.wat-dossier\s*\{[\s\S]*?position: static/);
        expect(CSS).toMatch(/@media \(max-width: 600px\)[\s\S]*\.wat-change-body\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
    });

    test('the intro says what is watched, how often, and that a claim carries its quote', () => {
        const intro = HTML.slice(HTML.indexOf('class="method-note"'), HTML.indexOf('class="data-line"'));
        for (const word of ['daily', 'hourly', 'quote', 'claim']) expect(intro).toContain(word);
    });
});
