// Fast tests for flows.js (the pure half of flows.html): a day not read renders as missing and never
// as a bar, a lower-bound total is marked, an uncollected side says so, the float chart and table
// carry real values, and the page loads only local classic scripts.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const page = require('./flows.js');

const side = (hours, usd, extra = {}) => ({ coveredHours: hours, amountHours: hours, count: hours > 0 ? 3 : null,
    value: usd === null ? null : { usd, complete: true, events: 3, unpricedMints: [], sources: { settlement: 3 }, top: [], ...extra } });
const issuer = {
    slug: 'ondo-global-markets', name: 'Ondo', state: 'observed', amountsFrom: 'first-coverage', lastScanStatus: 'ok',
    created: { counted: true, what: 'mints' }, redeemed: { counted: true, what: 'burns' },
    days: [
        { date: '2026-09-21', created: side(0, null), redeemed: side(0, null), netUsd: null },
        { date: '2026-09-22', created: side(24, 300), redeemed: side(24, 100), netUsd: 200 },
        { date: '2026-09-23', created: side(12, 50), redeemed: side(12, 40, { complete: false, unpricedMints: ['AX'] }), netUsd: null }
    ]
};

describe('flow chart', () => {
    const svg = page.flowChartSvg(issuer);
    test('draws bars only for read, priced days — a missing day gets a hatched strip, not a bar', () => {
        expect((svg.match(/class="fl-bar fl-created/g) || []).length).toBe(2);
        expect((svg.match(/class="fl-bar fl-redeemed/g) || []).length).toBe(2);
        expect(svg).toContain('fl-cov-missing');
        expect(svg).toContain('fl-cov-full');
        expect(svg).toContain('fl-cov-partial');
    });
    test('a partly priced day is a lower bound; net only where defined', () => {
        expect(svg).toContain('fl-redeemed fl-lower');
        expect((svg.match(/class="fl-net"/g) || []).length).toBe(1);
        expect(page.sideLabel(issuer.days[2].redeemed)).toBe('≥ $40.00 · 3 tx');
    });
    test('every day column is keyboard focusable with its numbers as the label', () => {
        expect((svg.match(/tabindex="0"/g) || []).length).toBe(3);
        expect(page.dayReadout(issuer, issuer.days[0])).toContain('created not read');
        expect(page.dayReadout(issuer, issuer.days[1])).toContain('net +$200.00');
    });
    test('an uncollected side is stated, not drawn as zero', () => {
        const xs = { ...issuer, created: { counted: false, why: 'not collected yet' }, days: issuer.days.map((d) => ({ ...d, created: null, netUsd: null })) };
        expect(page.flowChartSvg(xs)).toContain('creations not collected');
        expect(page.flowTableHtml(xs)).toContain('not collected');
        expect(page.issuerHtml(xs)).toContain('not collected yet');
    });
    test('the table marks the missing day and lists unpriced mints', () => {
        const html = page.flowTableHtml(issuer);
        expect(html).toContain('<td class="fl-missing">not read</td>');
        expect(html).toContain('unpriced: AX');
    });
    test('no observation file → says so instead of drawing zero flows', () => {
        expect(page.flowsSectionHtml(null)).toMatch(/not zero flows/);
    });
});

describe('float section', () => {
    const float = {
        readAt: '2026-09-23T22:31:59Z', slots: { min: 1, max: 2 }, priceSource: 'catalogue', priceObservedAt: '2026-09-20T10:28:13Z',
        pricedMints: 1, mints: 2, unpricedWithFloat: 1, medianInventorySharePct: 55, previousReadAt: null,
        totals: { supplyUsd: 1000, inventoryUsd: 600, floatUsd: 400, inventorySharePct: 60, pricedMints: 1 },
        attributionCaveat: 'cannot prove S7vYFF… is the Tokenizer wallet',
        wallets: [{ address: 'S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS', role: 'treasury', basis: 'b', dossierCitations: 9, dossierPaths: ['a'], xstockAccountsWithBalance: 5 }],
        porConflicts: ['AX'], porCompared: 1, por: { source: 'por', fetchedAt: '2026-09-20T07:39:15Z' },
        top: [{ symbol: 'AX', supplyUi: 100, inventoryUi: 60, floatUi: 40, inventorySharePct: 60, floatUsd: 400, inventoryUsd: 600, floatChangeUi: -2, porCirculatingAllChains: 30, floatExceedsPor: true }]
    };
    test('renders the aggregate, the per-token bar and the table with the real values', () => {
        const html = page.floatSectionHtml(float);
        expect(html).toContain('$400.00');
        expect(html).toContain('60.0%');
        expect(html).toContain('−2.00');
        expect(html).toContain('The float is an upper bound');
        expect(html).toContain('cannot prove S7vYFF');
        expect(page.floatChartSvg(float)).toContain('All 1 priced');
        expect(page.floatChartSvg(float, { width: 340 })).toContain('viewBox="0 0 340 ');
    });
    test('the label column fits "All 107 priced" on a phone instead of clipping it at the left edge', () => {
        const wide = { ...float, totals: { ...float.totals, pricedMints: 107 } };
        const svg = page.floatChartSvg(wide, { width: 300 });
        const x = Number(/<text class="fl-lab" x="([\d.]+)"[^>]*>All 107 priced</.exec(svg)[1]);
        expect(x).toBeGreaterThanOrEqual('All 107 priced'.length * 7.4);
    });
    test('no float read → says so', () => {
        expect(page.floatSectionHtml(null)).toMatch(/not been read/);
    });
});

describe('flows.html', () => {
    const html = readFileSync(join(__dirname, 'flows.html'), 'utf8');
    test('carries the site shell and loads local classic scripts only, with cache-bust stamps', () => {
        expect(html).toContain('class="page-header app-header"');
        expect(html).toContain('class="nav-compact-only" href="./learn/"');
        expect(html).toMatch(/<script src="nav-menus\.js\?v=/);
        expect(html).toMatch(/<link rel="stylesheet" href="motion\.css\?v=/);
        for (const [, src] of html.matchAll(/<script src="([^"]+)"/g)) expect(src).toMatch(/^[\w./-]+\.js\?v=\d{8}[a-z]?$/);
    });
});
