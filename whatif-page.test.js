// Unit tests for the pure section of whatif.js — the failure-mode matrix behind whatif.html
// (stocks/EVIDENCE.md §6). Every test asserts something a reader would be misled by if it broke:
// that a question with no answer row for an issuer is drawn as `missing` rather than dropped or
// softened into `not-applicable`, that the headline counts are over the WHOLE matrix and do not
// move when a filter narrows what is on screen, that the status filter narrows rows without
// punching holes in a row, that the six statuses are exactly the ones the database will accept,
// that a column's short name is derived from the issuer's own slug and spelling rather than typed
// into a map that would rot, and that an unsafe URL never becomes a link.
//
// The status vocabulary is a CHECK constraint in db/2026-09-18-sonar-whatif.sql plus the API's own
// `missing`, which is never stored — that pair is what these tests lock the page to.

const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const W = require('./whatif.js');
const WI = require('./stocks/lib/whatif-render.js');

const HTML = readFileSync(join(__dirname, 'whatif.html'), 'utf8');
const CSS = readFileSync(join(__dirname, 'whatif.css'), 'utf8');
const JS = readFileSync(join(__dirname, 'whatif.js'), 'utf8');
const CATALOGUE = JSON.parse(readFileSync(join(__dirname, 'stocks', 'data', 'trust-chain.json'), 'utf8'));

/** The DDL file that declares the what-if table, whichever dated name it carries. */
function whatIfDdl() {
    const dir = join(__dirname, 'db');
    const file = readdirSync(dir).find((name) => /whatif|what-if|trust-chain/.test(name) && name.endsWith('.sql'));
    return file === undefined ? null : readFileSync(join(dir, file), 'utf8');
}

/** A failure mode as /api/failure-modes returns one. */
function mode(over) {
    return {
        id: 'keys-stolen',
        actor: 'holder',
        flow: 'transfer',
        question: 'My private keys are stolen and the tokens are moved. Can they be recovered?',
        look_for: 'Lost-token, replacement or reissuance clauses.',
        ord: 0,
        answered: 2,
        documented: 2,
        inferred: 0,
        litigated: 0,
        unknown: 0,
        not_applicable: 0,
        actor_label: 'Holder',
        flow_label: 'Transfer and control',
        missing: 10,
        ...over
    };
}

/** An answer row as /api/what-if returns one. */
function answer(over) {
    return {
        id: 'xstocks-backed:keys-stolen',
        issuer_slug: 'xstocks-backed',
        mode_id: 'keys-stolen',
        status: 'documented',
        outcome: 'Nothing comes back as of right.',
        quote: 'the token network or the Issuer will not be capable of restoring the private key',
        url: 'https://example.com/prospectus.pdf',
        locator: 'p. 107, clause II',
        accessed_at: '2026-09-18T10:15:00.000Z',
        cases: [],
        searched: [],
        note: null,
        source_id: '4ce8c942b7a9',
        source_title: 'Base Prospectus, Backed Assets (JE) Limited',
        source_kind: 'pdf',
        source_status: 'ok',
        source_archive_url: null,
        source_last_checked_at: '2026-09-18T11:03:34.000Z',
        actor: 'holder',
        flow: 'transfer',
        question: 'My private keys are stolen and the tokens are moved. Can they be recovered?',
        ord: 0,
        actor_label: 'Holder',
        flow_label: 'Transfer and control',
        ...over
    };
}

/** Three issuers as /api/issuers returns them. */
const ISSUERS = [
    { slug: 'xstocks-backed', name: 'Kraken xStocks' },
    { slug: 'superstate-opening-bell', name: 'Opening Bell by Superstate' },
    { slug: 'ondo-global-markets', name: 'Ondo Global Markets' }
];

/** Four modes over three actors, so the grouping and the actor filter have something to do. */
const MODES = [
    mode({ id: 'keys-stolen', actor: 'holder', ord: 0 }),
    mode({ id: 'court-order', actor: 'holder', ord: 1, question: 'A court orders my tokens seized.' }),
    mode({
        id: 'custodian-insolvency', actor: 'custodian', ord: 2, actor_label: 'Custodian or prime broker',
        question: 'The custodian goes bankrupt.'
    }),
    mode({ id: 'law-changes', actor: 'law', ord: 3, actor_label: 'Law, regulator and courts', question: 'The law changes.' })
];

/** One answer per cell we want filled; everything else must come out `missing`. */
const ANSWERS = [
    answer({ issuer_slug: 'xstocks-backed', mode_id: 'keys-stolen', status: 'documented' }),
    answer({ issuer_slug: 'xstocks-backed', mode_id: 'court-order', status: 'inferred', quote: null }),
    answer({ issuer_slug: 'superstate-opening-bell', mode_id: 'keys-stolen', status: 'unknown', quote: null, searched: ['https://example.com/terms'] }),
    answer({ issuer_slug: 'superstate-opening-bell', mode_id: 'custodian-insolvency', status: 'not-applicable', quote: null, url: null, note: 'No custodian in this structure.' })
];

function matrix(over = {}) {
    return W.buildMatrix({
        modes: MODES,
        issuers: ISSUERS,
        answers: ANSWERS,
        order: WI.actorOrder(CATALOGUE),
        labels: WI.actorLabels(CATALOGUE),
        ...over
    });
}

describe('the status vocabulary', () => {
    test('is the five the table accepts plus the API’s own `missing`, and nothing else', () => {
        expect(W.WHATIF_STATUSES).toEqual([
            'documented', 'inferred', 'litigated', 'unknown', 'not-applicable', 'missing'
        ]);
        expect(W.MISSING_STATUS).toBe('missing');
        // The catalogue defines the five stored ones; `missing` is deliberately not among them.
        expect(Object.keys(CATALOGUE.answerStatuses).sort())
            .toEqual(['documented', 'inferred', 'litigated', 'not-applicable', 'unknown']);
        expect(CATALOGUE.answerStatuses).not.toHaveProperty('missing');
    });

    test('matches the DDL’s CHECK constraint, so the page cannot drift from the database', () => {
        const ddl = whatIfDdl();
        if (ddl === null) return;
        const stored = W.WHATIF_STATUSES.filter((status) => status !== 'missing');
        for (const status of stored) expect(ddl).toContain(`'${status}'`);
        // The one value the table must refuse: it is an absence, not an answer.
        expect(/CHECK[\s\S]{0,400}'missing'/.test(ddl)).toBe(false);
    });

    test('every status has a short label, a meaning and a colour token in the stylesheets', () => {
        const stocksCss = readFileSync(join(__dirname, 'stocks.css'), 'utf8');
        const sharedCss = readFileSync(join(__dirname, 'trustchain.css'), 'utf8');
        for (const status of W.WHATIF_STATUSES) {
            expect(typeof W.STATUS_SHORT[status]).toBe('string');
            expect(W.STATUS_SHORT[status].length).toBeGreaterThan(0);
            expect(typeof W.STATUS_MEANING[status]).toBe('string');
            expect(stocksCss).toContain(`--wi-${status}`);
            expect(sharedCss).toContain(`.wi-s-${status}`);
        }
    });
});

describe('shortName', () => {
    test('takes the slug’s first segment, spelled the way the issuer’s own name spells it', () => {
        expect(W.shortName('superstate-opening-bell', 'Opening Bell by Superstate')).toBe('Superstate');
        expect(W.shortName('xstocks-backed', 'Kraken xStocks')).toBe('xStocks');
        expect(W.shortName('ondo-global-markets', 'Ondo Global Markets')).toBe('Ondo');
        expect(W.shortName('backpack-securities', 'Backpack Securities')).toBe('Backpack');
        expect(W.shortName('ventuals', 'Ventuals Pre-IPO')).toBe('Ventuals');
        expect(W.shortName('shift', 'Shift leveraged tokens')).toBe('Shift');
    });

    test('titlecases the slug when the name does not contain it, and survives a missing name', () => {
        expect(W.shortName('newissuer-two', 'Something Else Entirely')).toBe('Newissuer');
        expect(W.shortName('tessera', null)).toBe('Tessera');
        expect(W.shortName('', 'Only A Name')).toBe('Only A Name');
        expect(W.shortName('', null)).toBe('—');
    });

    test('a thirteenth issuer needs no map entry: the columns are derived, not listed', () => {
        // The guard against the rot a hand-written short-name map would have: whatif.js must not
        // contain a slug-to-label table.
        expect(JS).not.toMatch(/ISSUER_SHORT|SHORT_NAMES/);
        const columns = W.issuerColumns([...ISSUERS, { slug: 'brand-new-thing', name: 'Brand New Thing' }]);
        expect(columns.map((c) => c.short)).toContain('Brand');
    });
});

describe('issuerColumns', () => {
    test('one column per issuer, alphabetical by short name, with the full name kept', () => {
        const columns = W.issuerColumns(ISSUERS);
        expect(columns.map((c) => c.short)).toEqual(['Ondo', 'Superstate', 'xStocks']);
        expect(columns[0].name).toBe('Ondo Global Markets');
        expect(columns[0].slug).toBe('ondo-global-markets');
    });

    test('an issuer with no slug is dropped rather than drawn as a nameless column', () => {
        expect(W.issuerColumns([{ name: 'No slug' }, ...ISSUERS])).toHaveLength(3);
        expect(W.issuerColumns(null)).toEqual([]);
    });
});

describe('indexAnswers', () => {
    test('keys every answer by <issuer>:<mode>, which is the row’s own id', () => {
        const index = W.indexAnswers(ANSWERS);
        expect(index.size).toBe(4);
        expect(index.get('xstocks-backed:keys-stolen').status).toBe('documented');
        expect(W.answerKey('a', 'b')).toBe('a:b');
    });

    test('a row missing its issuer or its mode is skipped, never keyed as undefined', () => {
        const index = W.indexAnswers([answer({ issuer_slug: null }), answer({ mode_id: null }), answer({})]);
        expect(index.size).toBe(1);
        expect([...index.keys()]).toEqual(['xstocks-backed:keys-stolen']);
    });
});

describe('buildMatrix', () => {
    test('one row per question and one cell per issuer, whatever is answered', () => {
        const m = matrix();
        expect(m.rows).toHaveLength(4);
        expect(m.columns).toHaveLength(3);
        for (const row of m.rows) expect(row.cells).toHaveLength(3);
        expect(m.total).toBe(4);
        expect(m.shown).toBe(4);
    });

    test('a question with no answer row for an issuer is drawn as `missing`, not dropped', () => {
        const m = matrix();
        const row = m.rows.find((r) => r.mode === 'law-changes');
        expect(row.cells.map((cell) => cell.status)).toEqual(['missing', 'missing', 'missing']);
        for (const cell of row.cells) expect(cell.answer).toBeNull();
        // And never softened into the one status that would read as "there is nothing to answer".
        expect(row.cells.some((cell) => cell.status === 'not-applicable')).toBe(false);
    });

    test('the counts are over every cell in the matrix: 4 answers, 8 gaps', () => {
        const m = matrix();
        expect(m.counts).toEqual({
            documented: 1, inferred: 1, litigated: 0, unknown: 1, 'not-applicable': 1, missing: 8
        });
        const scope = W.scopeLine(m);
        expect(scope.cells).toBe(12);
        expect(scope.answered).toBe(4);
        expect(scope.missing).toBe(8);
        expect(scope.questions).toBe(4);
        expect(scope.issuers).toBe(3);
    });

    test('the counts do NOT move when a filter narrows what is on screen', () => {
        const all = matrix();
        const filtered = matrix({ filters: { status: ['unknown'], actor: [] } });
        expect(filtered.counts).toEqual(all.counts);
        expect(filtered.total).toBe(all.total);
        expect(filtered.shown).toBeLessThan(all.total);
    });

    test('groups follow the catalogue’s actor order and carry its labels', () => {
        const m = matrix();
        expect(m.groups.map((group) => group.actor)).toEqual(['holder', 'custodian', 'law']);
        expect(m.groups.map((group) => group.label))
            .toEqual(['Holder', 'Custodian or prime broker', 'Law, regulator and courts']);
        expect(m.groups[0].rows).toHaveLength(2);
    });

    test('without the catalogue, actors group in the order the questions first name them', () => {
        const m = W.buildMatrix({ modes: MODES, issuers: ISSUERS, answers: ANSWERS });
        expect(m.groups.map((group) => group.actor)).toEqual(['holder', 'custodian', 'law']);
    });

    test('an actor the catalogue’s order does not mention keeps its group, at the end', () => {
        const m = W.buildMatrix({
            modes: [...MODES, mode({ id: 'novel', actor: 'oracle-committee', actor_label: null, ord: 4 })],
            issuers: ISSUERS,
            answers: ANSWERS,
            order: WI.actorOrder(CATALOGUE)
        });
        expect(m.groups[m.groups.length - 1].actor).toBe('oracle-committee');
        expect(m.rows).toHaveLength(5);
    });
});

describe('the filters', () => {
    test('the actor filter keeps only that actor’s questions', () => {
        const m = matrix({ filters: { status: [], actor: ['holder'] } });
        expect(m.shown).toBe(2);
        expect(m.groups).toHaveLength(1);
        expect(m.groups[0].actor).toBe('holder');
    });

    test('the status filter keeps the rows that have such a cell and marks those cells', () => {
        const m = matrix({ filters: { status: ['unknown'], actor: [] } });
        expect(m.rows.map((row) => row.mode)).toEqual(['keys-stolen']);
        const row = m.rows[0];
        expect(row.cells.filter((cell) => cell.marked).map((cell) => cell.issuer))
            .toEqual(['superstate-opening-bell']);
        // It narrows rows, never cells: the row still shows all three issuers.
        expect(row.cells).toHaveLength(3);
    });

    test('filtering on `missing` finds the questions nobody has answered', () => {
        const m = matrix({ filters: { status: ['missing'], actor: [] } });
        expect(m.rows.map((row) => row.mode).sort())
            .toEqual(['court-order', 'custodian-insolvency', 'keys-stolen', 'law-changes']);
    });

    test('two statuses are OR, and a combination nothing matches shows an empty matrix honestly', () => {
        expect(matrix({ filters: { status: ['documented', 'litigated'], actor: [] } }).shown).toBe(1);
        const none = matrix({ filters: { status: ['litigated'], actor: [] } });
        expect(none.shown).toBe(0);
        expect(W.matrixHtml(none)).toContain('No question matches these filters');
        expect(W.matrixHtml(none)).toContain('clear a filter');
    });

    test('status and actor together are AND', () => {
        expect(matrix({ filters: { status: ['documented'], actor: ['custodian'] } }).shown).toBe(0);
        expect(matrix({ filters: { status: ['documented'], actor: ['holder'] } }).shown).toBe(1);
    });
});

describe('parseFilterState', () => {
    test('a comma list and a repeated parameter both mean OR, and duplicates collapse', () => {
        expect(W.parseFilterState('?status=unknown,missing')).toEqual({ status: ['unknown', 'missing'], actor: [] });
        expect(W.parseFilterState('?status=unknown&status=missing')).toEqual({ status: ['unknown', 'missing'], actor: [] });
        expect(W.parseFilterState('?status=unknown,unknown')).toEqual({ status: ['unknown'], actor: [] });
        expect(W.parseFilterState('?actor=holder&actor=custodian').actor).toEqual(['holder', 'custodian']);
    });

    test('a status the database has never heard of is dropped, not forwarded', () => {
        expect(W.parseFilterState('?status=documented,excellent').status).toEqual(['documented']);
        expect(W.parseFilterState('?status=excellent').status).toEqual([]);
    });

    test('the page’s own parameters are not filters', () => {
        const state = W.parseFilterState('?api=http://127.0.0.1:3300&reduceMotion=1&status=unknown');
        expect(state).toEqual({ status: ['unknown'], actor: [] });
    });

    test('nothing, or nonsense, parses to no filters rather than throwing', () => {
        expect(W.parseFilterState('')).toEqual({ status: [], actor: [] });
        expect(W.parseFilterState(null)).toEqual({ status: [], actor: [] });
    });
});

describe('filterStateToSearch', () => {
    test('round-trips a state and keeps the page’s own parameters in front', () => {
        const state = { status: ['unknown', 'missing'], actor: ['holder'] };
        const search = W.filterStateToSearch(state, { api: 'http://127.0.0.1:3300' });
        // The comma stays literal, the same way monitor.html writes its facets, so a shared URL
        // reads as the API's own OR syntax.
        expect(search).toBe('api=http%3A%2F%2F127.0.0.1%3A3300&status=unknown,missing&actor=holder');
        expect(W.parseFilterState(`?${search}`)).toEqual(state);
    });

    test('an unfiltered matrix has a clean URL', () => {
        expect(W.filterStateToSearch({ status: [], actor: [] })).toBe('');
    });
});

describe('the rendered matrix', () => {
    test('every cell is a button carrying its mode, its issuer and a title that names the status', () => {
        const html = W.matrixHtml(matrix());
        expect(html.match(/class="wm-cell /g)).toHaveLength(12);
        expect(html).toContain('data-mode="keys-stolen"');
        expect(html).toContain('data-issuer="xstocks-backed"');
        expect(html).toContain('wi-s-documented');
        expect(html).toContain('wi-s-missing');
        // The colour is never the only carrier: the title and the aria-label say the status.
        expect(html).toContain('Kraken xStocks: documented');
        expect(html).toContain('aria-label="Ondo Global Markets: missing');
    });

    test('the header strip has one cell per issuer plus the question column', () => {
        const html = W.headHtml(W.issuerColumns(ISSUERS));
        expect(html.match(/class="wm-head-i"/g)).toHaveLength(3);
        expect(html).toContain('>Failure mode<');
        expect(html).toContain('title="Kraken xStocks"');
    });

    test('a marked cell is marked in the markup, so the status filter is visible', () => {
        const html = W.matrixHtml(matrix({ filters: { status: ['unknown'], actor: [] } }));
        expect(html.match(/wm-marked/g)).toHaveLength(1);
    });

    test('the column key names every issuer in full, so a short name is never the only label', () => {
        const html = W.columnKeyHtml(W.issuerColumns(ISSUERS));
        for (const issuer of ISSUERS) expect(html).toContain(issuer.name);
    });

    test('the status legend states what each status licenses, `missing` included', () => {
        const html = W.statusKeyHtml();
        for (const status of W.WHATIF_STATUSES) {
            expect(html).toContain(`wm-key-swatch wi-s-${status}`);
            expect(html).toContain(W.STATUS_MEANING[status]);
        }
        expect(html).toContain('nobody has answered this question for this issuer yet');
    });

    test('a question is escaped, so a catalogue cannot inject markup', () => {
        const html = W.matrixHtml(W.buildMatrix({
            modes: [mode({ question: '<img src=x onerror=1>' })],
            issuers: ISSUERS,
            answers: []
        }));
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img');
    });

    test('the counts line names each status with its own count', () => {
        const html = W.countsHtml(matrix());
        expect(html).toContain('>8</span> missing');
        expect(html).toContain('>1</span> documented');
        // A status nothing is counted under is left out rather than printed as a zero.
        expect(html).not.toContain('litigated');
    });
});

describe('the answer panel', () => {
    function cellFor(modeId, issuerSlug, over = {}) {
        const m = matrix(over);
        const row = m.rows.find((r) => r.mode === modeId);
        return { row, cell: row.cells.find((c) => c.issuer === issuerSlug) };
    }

    test('a documented answer shows its outcome, its quote and its source with the read date', () => {
        const { row, cell } = cellFor('keys-stolen', 'xstocks-backed');
        const html = W.answerPanelHtml(row, cell);
        expect(html).toContain('Nothing comes back as of right.');
        expect(html).toContain('<blockquote class="wi-quote">');
        expect(html).toContain('https://example.com/prospectus.pdf');
        expect(html).toContain('p. 107, clause II');
        expect(html).toContain('read 18 Sep 2026');
        expect(html).toContain('wi-badge wi-s-documented');
    });

    test('an unknown answer shows where we looked, because the gap is only evidence with it', () => {
        const { row, cell } = cellFor('keys-stolen', 'superstate-opening-bell');
        const html = W.answerPanelHtml(row, cell);
        expect(html).toContain('Where we looked (1)');
        expect(html).toContain('https://example.com/terms');
    });

    test('a not-applicable answer shows the note that says why the case cannot arise', () => {
        const { row, cell } = cellFor('custodian-insolvency', 'superstate-opening-bell');
        const html = W.answerPanelHtml(row, cell);
        expect(html).toContain('No custodian in this structure.');
        expect(html).toContain('wi-s-not-applicable');
    });

    test('a missing cell says nobody has answered, and what would have to be read', () => {
        const { row, cell } = cellFor('law-changes', 'xstocks-backed');
        const html = W.answerPanelHtml(row, cell);
        expect(html).toContain('Nobody has answered this question for this issuer yet');
        expect(html).toContain('no outcome is guessed at here');
        expect(html).toContain('What has to be read for it');
        // And never a quote, a source or a read date it does not have.
        expect(html).not.toContain('<blockquote');
        expect(html).not.toContain('class="wi-meta"');
        expect(html).not.toMatch(/read \d/);
    });

    test('a litigated answer cites its case, with the court and the holding', () => {
        const m = W.buildMatrix({
            modes: MODES,
            issuers: ISSUERS,
            answers: [answer({
                mode_id: 'law-changes',
                status: 'litigated',
                cases: [{
                    name: 'SEC v. Example', court: 'S.D.N.Y.', date: '2025-04-01',
                    url: 'https://example.com/opinion', holding: 'Tokens were securities.'
                }]
            })]
        });
        const row = m.rows.find((r) => r.mode === 'law-changes');
        const html = W.answerPanelHtml(row, row.cells.find((c) => c.issuer === 'xstocks-backed'));
        expect(html).toContain('SEC v. Example');
        expect(html).toContain('S.D.N.Y., 2025-04-01');
        expect(html).toContain('Tokens were securities.');
        expect(html).toContain('https://example.com/opinion');
    });

    test('an unsafe URL never becomes a link', () => {
        const m = W.buildMatrix({
            modes: MODES,
            issuers: ISSUERS,
            answers: [answer({ url: 'javascript:alert(1)', source_title: 'Nasty' })]
        });
        const row = m.rows.find((r) => r.mode === 'keys-stolen');
        const html = W.answerPanelHtml(row, row.cells.find((c) => c.issuer === 'xstocks-backed'));
        expect(html).not.toContain('javascript:');
        expect(html).not.toContain('<a href');
        expect(html).toContain('Nasty');
    });

    test('an archived copy is offered beside the live link when the registry has one', () => {
        const m = W.buildMatrix({
            modes: MODES,
            issuers: ISSUERS,
            answers: [answer({ source_archive_url: 'https://web.archive.org/web/2026/x' })]
        });
        const row = m.rows.find((r) => r.mode === 'keys-stolen');
        const html = W.answerPanelHtml(row, row.cells.find((c) => c.issuer === 'xstocks-backed'));
        expect(html).toContain('archived copy');
        expect(html).toContain('https://web.archive.org/web/2026/x');
    });
});

describe('the page itself', () => {
    test('every element whatif.js looks up by id exists in whatif.html', () => {
        const ids = [...JS.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1]);
        expect(ids.length).toBeGreaterThan(8);
        for (const id of new Set(ids)) expect(HTML).toContain(`id="${id}"`);
    });

    test('the page loads the four scripts it needs, fmt and api-base before whatif.js', () => {
        const order = [...HTML.matchAll(/<script src="([^"?]+)/g)].map((match) => match[1]);
        expect(order).toEqual([
            'stocks/lib/fmt.js',
            'stocks/lib/api-base.js',
            'stocks/lib/whatif-render.js',
            'whatif.js'
        ]);
    });

    test('every asset is cache-busted, because a stale matrix is indistinguishable from a wrong one', () => {
        for (const match of HTML.matchAll(/(?:src|href)="((?:whatif|stocks)[^"]*\.(?:js|css))"/g)) {
            expect(match[1]).toMatch(/\?v=/);
        }
    });

    test('the header states the rule that outcomes are never invented, and names all four statuses', () => {
        expect(HTML).toContain('An outcome is never invented');
        for (const word of ['documented', 'inferred', 'litigated', 'unknown']) {
            expect(HTML).toContain(`<em>${word}</em>`);
        }
    });

    test('it links to the other pages, and they link back to it', () => {
        for (const page of ['stocks.html', 'graph.html', 'live.html', 'monitor.html', 'watch.html', 'index.html']) {
            expect(HTML).toContain(`href="./${page}"`);
            const other = readFileSync(join(__dirname, page), 'utf8');
            expect(other).toContain('href="./whatif.html"');
        }
    });

    test('shares stocks.css and trustchain.css, so the colour tokens and the .wi-* answer rows are the shared ones', () => {
        expect(HTML).toContain('stocks.css?v=');
        expect(HTML).toContain('trustchain.css?v=');
        expect(HTML).toContain('whatif.css?v=');
        // The shared rows load before this page's own sheet, which may refine them.
        expect(HTML.indexOf('trustchain.css?v=')).toBeLessThan(HTML.indexOf('whatif.css?v='));
        // The matrix stylesheet must not redefine the shared status tokens.
        expect(CSS).not.toContain('--wi-documented:');
    });

    test('the matrix is a stack by default and a grid only from a width that fits twelve columns', () => {
        // Mobile first: the grid lives inside a min-width query, not the other way round.
        expect(CSS).toMatch(/@media \(min-width: 900px\)/);
        const grid = CSS.slice(CSS.indexOf('@media (min-width: 900px)'));
        expect(grid).toContain('display: contents');
        expect(grid).toContain('grid-template-columns');
        // And nothing anywhere forces a width wider than a phone.
        expect(CSS).not.toMatch(/min-width:\s*[4-9]\d\dpx;/);
    });

    test('no !important anywhere: a fix that needs one is a fix in the wrong place', () => {
        expect(CSS).not.toContain('!important');
    });

    test('nothing in whatif.css declares `color` on a cell or a chip, which would erase the status', () => {
        // whatif.css is loaded AFTER stocks.css, so an equal-specificity `color` on .wm-cell or
        // .wm-chip beats the .wi-s-<status> rule that carries this page's entire meaning — and the
        // failure is silent: 456 cells in one grey, with no error anywhere. Found in the browser
        // on 2026-09-18, which is why it is asserted rather than remembered.
        for (const selector of ['.wm-cell', '.wm-chip']) {
            const at = CSS.indexOf(`${selector} {`);
            expect(at).toBeGreaterThan(-1);
            const block = CSS.slice(at, CSS.indexOf('}', at));
            expect(block).not.toMatch(/(^|[^-])color:/);
        }
        // And the status colour must be reachable: every one of the six is defined in trustchain.css,
        // which this page loads before whatif.css.
        const sharedCss = readFileSync(join(__dirname, 'trustchain.css'), 'utf8');
        for (const status of W.WHATIF_STATUSES) {
            expect(sharedCss).toMatch(new RegExp(`\\.wi-s-${status}\\s*\\{[^}]*color:`));
        }
    });

    test('the answer panel is a dialog, so Escape closes it and focus is trapped for free', () => {
        expect(HTML).toContain('<dialog id="answerPanel"');
        expect(JS).toContain('showModal');
    });
});
