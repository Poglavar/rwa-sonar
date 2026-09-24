// Unit tests for the pure section of powers.js — the "who can touch your tokens" page. Each asserts
// something a reader would be misled by if it broke: an unknown holder drawn as a known one, a
// multisig without its threshold or timelock, a program path that hides its upgrade control, a use
// badge where nothing is on record, a missing address softened into silence, or a page that loads
// assets without cache-busting or lacks the elements its script looks up.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const P = require('./powers.js');

const HTML = readFileSync(join(__dirname, 'powers.html'), 'utf8');
const JS = readFileSync(join(__dirname, 'powers.js'), 'utf8');

const MAP = {
    builtAt: '2026-09-24T00:00:00Z',
    sources: {
        issuers: { file: 'stocks-issuers.json', builtAt: '2026-09-23T11:58:24Z' },
        chain: { method: 'getMultipleAccounts', fetchedAt: '2026-09-20T10:28:25Z', mintsRead: 2 }
    },
    powers: [
        { id: 'mint', label: 'Mint new tokens', short: 'Mint' },
        { id: 'freeze', label: 'Freeze a holder account', short: 'Freeze' },
        { id: 'pause', label: 'Pause every transfer', short: 'Pause' }
    ],
    counts: { 'single-key': 1, multisig: 1, program: 0, none: 0, unknown: 1 },
    issuers: []
};

function cell(over) {
    return {
        power: 'mint', kind: 'unknown', governanceType: 'unknown', viaProgramUpgrade: false,
        capability: { state: 'all', present: 2, absent: 0, unknown: 0, total: 2 },
        controller: null, signerThreshold: null, upgradeAuthority: null, upgradeGovernance: null,
        observedAt: null, lastRotatedAt: null, source: null, technicalNotes: null, timelock: null,
        contractualCircumstances: null, addresses: { distinct: 0, shown: [] },
        usage: { state: 'not-recorded', finding: null, effects: [] }, inheritedFrom: null, sameAddressAs: [],
        ...over
    };
}

const ROW = {
    slug: 'demo-issuer', name: 'Demo Issuer', status: 'live', mints: 2, mintsRead: 2,
    chainReadAt: { from: '2026-09-20T01:00:00Z', to: '2026-09-20T02:00:00Z' },
    governanceEvidence: 'RPC getAccountInfo, 2026-09-16: the freeze key is a Squads vault.',
    cells: [
        cell({ power: 'mint', kind: 'single-key', governanceType: 'hot-key', addresses: { distinct: 1, shown: [{ address: 'S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS', role: 'mint authority', mints: 2, onCurve: true }] }, usage: { state: 'effect-observed', finding: null, effects: ['supply has been minted on 2 of 2 mints'] } }),
        cell({ power: 'freeze', kind: 'multisig', governanceType: 'multisig', signerThreshold: '2 of 5 eligible voters (7 members)', timelock: { seconds: 0, phrase: 'zero execution timelock' }, controller: 'Squads v4 multisig 53Ab…', observedAt: '2026-09-20', usage: { state: 'recorded', finding: { schema: 'freeze-authority-has-been-exercised', statement: 'Froze once, thawed once.', evidence: 'rpc:x', observedAt: '2026-09-16' }, effects: [] } }),
        cell({ power: 'pause', kind: 'unknown' })
    ]
};

describe('the words a cell prints', () => {
    test('a multisig names its m-of-n and its timelock', () => {
        expect(P.cellWords(ROW.cells[1], MAP)).toEqual({ head: '2-of-5 multisig', details: ['no timelock'] });
        expect(P.thresholdShort('4 of 7')).toBe('4-of-7');
        expect(P.thresholdShort(null)).toBeNull();
        expect(P.timelockShort({ seconds: 7200 })).toBe('2 h timelock');
        expect(P.timelockShort({ seconds: 900 })).toBe('15 min timelock');
        expect(P.timelockShort(null)).toBeNull();
    });

    test('a program says who controls its upgrade, and says unknown when nobody has established it', () => {
        expect(P.cellWords(cell({ kind: 'program', upgradeGovernance: 'multisig' }), MAP).details).toContain('upgrade: multisig');
        expect(P.cellWords(cell({ kind: 'program' }), MAP).details).toContain('upgrade control unknown');
    });

    test('an unknown cell stays Unknown, and a partial capability and an inherited reading are spelled out', () => {
        expect(P.cellWords(cell({ kind: 'unknown' }), MAP).head).toBe('Unknown');
        expect(P.cellWords(cell({ kind: 'single-key', capability: { state: 'some', present: 3, total: 8 } }), MAP).details).toContain('on 3 of 8 mints');
        expect(P.cellWords(cell({ kind: 'single-key', inheritedFrom: 'freeze' }), MAP).details).toContain('same address as Freeze');
        expect(P.cellWords(cell({ kind: 'single-key', viaProgramUpgrade: true }), MAP).details).toContain('via the program’s upgrade key');
    });

    test('a use badge appears only when use is on record or its effect is on chain', () => {
        expect(P.usageBadge({ state: 'recorded' }).text).toBe('used');
        expect(P.usageBadge({ state: 'effect-observed' }).text).toBe('in effect');
        expect(P.usageBadge({ state: 'not-recorded' })).toBeNull();
    });
});

describe('rows and the grid', () => {
    const map = { ...MAP, issuers: [ROW] };

    test('a row links to the issuer dossier and to its failure scenarios', () => {
        const html = P.rowHtml(ROW, map);
        expect(html).toContain('href="./issuers/demo-issuer.html"');
        expect(html).toContain('href="./whatif.html?issuer=demo-issuer"');
        expect(html).toContain('mints read 2026-09-20');
    });

    test('every cell is a keyboard-reachable button with its kind class and a full spoken label', () => {
        const html = P.rowHtml(ROW, map);
        expect((html.match(/<button type="button" class="pm-cell /g) || []).length).toBe(3);
        expect(html).toContain('class="pm-cell pm-k-multisig"');
        expect(html).toContain('aria-label="Demo Issuer — Freeze a holder account: 2-of-5 multisig, no timelock"');
        expect(html).toContain('pm-used-recorded');
    });

    test('the summary and sources lines carry the counts and each source’s own date', () => {
        expect(P.summaryText(map)).toBe('3 cells (1 programmes × 3 powers): 1 one key · 1 multisig · 0 program · 0 not installed · 1 unknown');
        expect(P.sourcesText(map)).toContain('fetched 2026-09-20');
        expect(P.sourcesText(map)).toContain('built 2026-09-23');
        expect(P.sourcesText({})).toContain('fetched unknown');
    });

    test('an empty map says so instead of drawing an empty grid', () => {
        expect(P.gridHtml({ issuers: [] })).toContain('holds no programmes');
    });
});

describe('the detail panel', () => {
    const map = { ...MAP, issuers: [ROW] };

    test('addresses link to the explorer and say whether a private key can exist for them', () => {
        const { html } = P.detailHtml(ROW, ROW.cells[0], map);
        expect(html).toContain('href="https://solscan.io/account/S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS"');
        expect(html).toContain('a private key can exist for it');
        expect(html).toContain('On chain: supply has been minted on 2 of 2 mints.');
    });

    test('recorded use quotes the finding with its date and evidence', () => {
        const { title, html } = P.detailHtml(ROW, ROW.cells[1], map);
        expect(title).toBe('Demo Issuer: Freeze a holder account');
        expect(html).toContain('Froze once, thawed once.');
        expect(html).toContain('observed 2026-09-16');
        expect(html).toContain('“zero execution timelock”');
    });

    test('with no address and no record it says both plainly, and never claims the power was unused', () => {
        const { html } = P.detailHtml(ROW, ROW.cells[2], map);
        expect(html).toContain('No authority address for this power was read from the chain');
        expect(html).toContain('The power may still have been used.');
        expect(html).toContain('key-governance evidence (verbatim)');
    });

    test('findCell finds a cell by issuer and power, and nothing for a wrong one', () => {
        expect(P.findCell(map, 'demo-issuer', 'freeze').cell.kind).toBe('multisig');
        expect(P.findCell(map, 'demo-issuer', 'upgrade')).toBeNull();
        expect(P.findCell(map, 'nobody', 'mint')).toBeNull();
    });
});

describe('the page itself', () => {
    test('every element powers.js looks up by id exists in powers.html', () => {
        const ids = [...JS.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1]);
        expect(ids.length).toBeGreaterThan(6);
        for (const id of new Set(ids)) expect(HTML).toContain(`id="${id}"`);
    });

    test('scripts load fmt before powers.js, then the shared menus, all cache-busted', () => {
        const order = [...HTML.matchAll(/<script src="([^"?]+)/g)].map((match) => match[1]);
        // theme.js is the site theme, first in <head> (theme.test.js).
        expect(order).toEqual(['./theme.js', 'stocks/lib/fmt.js', 'powers.js',
            // The catalogue funnel figure (funnel-figure.js) and the funnel layout's dependencies.
            'stocks/lib/sort-values.js', 'stocks/lib/catalogue-counts.js', 'stocks/lib/issuer-labels.js',
            'stocks/lib/funnel-layout.js', 'funnel-figure.js', 'nav-menus.js']);
        for (const match of HTML.matchAll(/(?:src|href)="((?:powers|stocks|app-shell|motion|nav-menus)[^"]*\.(?:js|css))"/g)) {
            expect(match[1]).toMatch(/\?v=/);
        }
    });

    test('the header carries the shared Research menu with the compact Learn link', () => {
        const header = HTML.slice(HTML.indexOf('<header'), HTML.indexOf('</header>'));
        expect(header).toMatch(/class="nav-compact-only" href="\.\/learn\/"/);
        expect(header).toContain('href="./powers.html"');
    });
});
