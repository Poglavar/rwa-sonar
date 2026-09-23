// Unit tests for stocks/lib/funnel-layout.js: the funnel graphic's layout: circles inside the box,
// radii by mint count, connectors between circles that exist. Moved with the code out of
// stocks-page.test.js (next-steps.md F11), which still tests the page wiring that calls it.

const {
    fmtNumber
} = require('./lib/fmt.js');

/**
 * The funnel graphic (stocks-funnel.json → funnelLayout → an inline SVG). The layout is the part
 * with arithmetic in it, so it is tested here rather than looked at: every circle inside the box,
 * radii that rise with the mint count and floor instead of vanishing, and connectors that only ever
 * join two circles that exist. Its wiring into stocks.html and stocks.js is pinned in stocks-page.test.js.
 */
describe('the funnel graphic', () => {
    const page = require('./lib/funnel-layout.js');
    const funnelDb = require('../stocks-funnel.json');

    /** A funnel small enough to reason about, with the same shape lib/funnel.mjs emits. */
    const FUNNEL = {
        columns: [
            {
                key: 'tokens', title: 'Mints', total: 100, nodes: [
                    { id: 'instrument:stock', label: 'Stocks', count: 99, kind: 'instrument' },
                    { id: 'instrument:etf', label: 'ETFs', count: 1, kind: 'instrument' }
                ]
            },
            {
                key: 'issuers', title: 'Issuer programmes', total: 100, nodes: [
                    { id: 'big', label: 'Big Issuer', count: 99, status: 'live' },
                    { id: 'tiny', label: 'Tiny Issuer', count: 1, status: 'live' },
                    { id: 'gone', label: 'Gone Issuer', count: 0, status: 'defunct' },
                    { id: 'soon', label: 'Soon Issuer', count: 0, status: 'live' }
                ]
            },
            {
                key: 'recipes', title: 'Recipes (program + extensions)', total: 100, nodes: [
                    { id: 'recipe:token-2022 · pausable', label: 'token-2022 · pausable', count: 100 }
                ]
            },
            {
                key: 'programs', title: 'Token program', total: 100, nodes: [
                    { id: 'program:token-2022', label: 'Token-2022', count: 100 }
                ]
            }
        ],
        edges: [
            { from: 'instrument:stock', to: 'big', count: 99 },
            { from: 'instrument:etf', to: 'tiny', count: 1 },
            { from: 'big', to: 'recipe:token-2022 · pausable', count: 99 },
            { from: 'tiny', to: 'recipe:token-2022 · pausable', count: 1 },
            { from: 'recipe:token-2022 · pausable', to: 'program:token-2022', count: 100 }
        ]
    };

    const layout = page.funnelLayout(FUNNEL, { width: 1000, height: 400 });
    const nodeById = new Map(layout.nodes.map((node) => [node.id, node]));

    it('heads the section with the real totals, spelled from the data', () => {
        expect(page.funnelTitle(FUNNEL)).toBe('From 100 token addresses to one token program');
        expect(page.funnelTitle(funnelDb)).toBe(`From ${fmtNumber(funnelDb.columns[0].total)} token addresses to one token program`);
    });

    it('pluralises the heading rather than claiming one program when there are two', () => {
        const two = { columns: [{ key: 'tokens', total: 8, nodes: [] }, { key: 'programs', total: 8, nodes: [{ id: 'a', count: 5 }, { id: 'b', count: 3 }] }] };
        expect(page.funnelTitle(two)).toBe('From 8 token addresses to two token programs');
        expect(page.funnelTitle(null)).toBeNull();
        expect(page.funnelTitle({ columns: [] })).toBeNull();
    });

    it('keeps every circle inside the box it was given', () => {
        expect(layout.nodes.length).toBe(8);
        for (const node of layout.nodes) {
            expect(node.x - node.r).toBeGreaterThanOrEqual(0);
            expect(node.x + node.r).toBeLessThanOrEqual(layout.width);
            expect(node.y - node.r).toBeGreaterThanOrEqual(0);
            expect(node.y + node.r).toBeLessThanOrEqual(layout.height);
        }
    });

    it('keeps them inside even a box far too short for them', () => {
        const squashed = page.funnelLayout(FUNNEL, { width: 1000, height: 80 });
        for (const node of squashed.nodes) {
            expect(node.y - node.r).toBeGreaterThanOrEqual(0);
            expect(node.y + node.r).toBeLessThanOrEqual(80);
        }
    });

    it('lays the four columns out left to right, in reading order', () => {
        expect(layout.columns.map((column) => column.key)).toEqual(['tokens', 'issuers', 'recipes', 'programs']);
        const xs = layout.columns.map((column) => column.x);
        expect(xs).toEqual([...xs].sort((a, b) => a - b));
        expect(new Set(xs).size).toBe(4);
    });

    it('heads each column with the number that column is about: 100 mints, then 4, 1, 1', () => {
        expect(layout.columns.map((column) => column.headline)).toEqual([100, 4, 1, 1]);
    });

    it('makes a circle’s area follow its mint count, so radius rises with it', () => {
        const sorted = [...layout.nodes].sort((a, b) => a.count - b.count);
        for (let i = 1; i < sorted.length; i++) {
            expect(sorted[i].r).toBeGreaterThanOrEqual(sorted[i - 1].r);
        }
        // Area, not radius: four times the mints is twice the radius, within rounding.
        const quarter = page.funnelLayout({
            columns: [{ key: 'tokens', title: 'Mints', total: 500, nodes: [
                { id: 'a', label: 'a', count: 400 }, { id: 'b', label: 'b', count: 100 }
            ] }],
            edges: []
        }, { width: 1000, height: 400 });
        const [big, small] = quarter.nodes;
        expect(small.r / big.r).toBeCloseTo(0.5, 1);
    });

    it('floors the radius, so a one-mint programme is still a visible dot', () => {
        expect(nodeById.get('tiny').r).toBe(page.FUNNEL_MIN_R);
        expect(nodeById.get('gone').r).toBe(page.FUNNEL_MIN_R);
        expect(nodeById.get('big').r).toBeGreaterThan(page.FUNNEL_MIN_R);
        expect(nodeById.get('big').r).toBeLessThanOrEqual(page.FUNNEL_MAX_R);
    });

    it('draws a mint-less or defunct programme hollow, and only an issuer circle at all', () => {
        expect(nodeById.get('gone').hollow).toBe(true);
        expect(nodeById.get('soon').hollow).toBe(true);
        expect(nodeById.get('big').hollow).toBe(false);
        expect(nodeById.get('instrument:stock').hollow).toBe(false);
        expect(nodeById.get('program:token-2022').hollow).toBe(false);
    });

    it('gives only issuer circles a slug to open a dossier with', () => {
        expect(nodeById.get('big').slug).toBe('big');
        expect(nodeById.get('gone').slug).toBe('gone');
        expect(nodeById.get('instrument:stock').slug).toBeNull();
        expect(nodeById.get('recipe:token-2022 · pausable').slug).toBeNull();
        expect(nodeById.get('program:token-2022').slug).toBeNull();
    });

    it('labels a circle with its count, and drops the program a recipe label repeats', () => {
        expect(nodeById.get('big').text).toBe('Big Issuer · 99');
        expect(nodeById.get('recipe:token-2022 · pausable').text).toBe('pausable · 100');
        expect(nodeById.get('instrument:etf').text).toBe('ETFs · 1');
    });

    it('hovers the FULL label, the mint count and an issuer’s status', () => {
        expect(nodeById.get('recipe:token-2022 · pausable').title).toBe('token-2022 · pausable — 100 tokens');
        expect(nodeById.get('tiny').title).toBe('Tiny Issuer — 1 token, live');
        expect(nodeById.get('gone').title).toBe('Gone Issuer — 0 tokens, defunct');
    });

    it('draws every connector between two circles that exist', () => {
        expect(layout.edges).toHaveLength(FUNNEL.edges.length);
        for (const edge of layout.edges) {
            expect(nodeById.has(edge.from)).toBe(true);
            expect(nodeById.has(edge.to)).toBe(true);
            expect(edge.d).toMatch(/^M[\d.,-]+C[\d.,\s-]+$/);
            expect(edge.title).toContain('→');
        }
    });

    it('starts each connector at one circle’s edge and ends it at the other’s', () => {
        const edge = layout.edges.find((e) => e.from === 'big');
        const from = nodeById.get('big');
        const to = nodeById.get('recipe:token-2022 · pausable');
        expect(edge.d.startsWith(`M${from.x + from.r},${from.y}C`)).toBe(true);
        expect(edge.d.endsWith(`${to.x - to.r},${to.y}`)).toBe(true);
    });

    it('drops a connector whose endpoints are not both circles, rather than drawing to nowhere', () => {
        const dangling = page.funnelLayout({
            columns: FUNNEL.columns,
            edges: [...FUNNEL.edges, { from: 'big', to: 'no-such-node', count: 5 }, { from: 'ghost', to: 'tiny', count: 5 }]
        }, { width: 1000, height: 400 });
        expect(dangling.edges).toHaveLength(FUNNEL.edges.length);
    });

    it('scales the connector width with its count, with a floor', () => {
        const widest = layout.edges.find((e) => e.count === 100);
        const thinnest = layout.edges.find((e) => e.count === 1);
        expect(widest.strokeWidth).toBe(page.FUNNEL_EDGE_MAX_PX);
        expect(thinnest.strokeWidth).toBe(page.FUNNEL_EDGE_MIN_PX);
        expect(thinnest.strokeWidth).toBeLessThan(widest.strokeWidth);
    });

    it('draws nothing from nothing, instead of throwing', () => {
        for (const empty of [null, undefined, {}, { columns: [] }, { columns: [], edges: null }]) {
            const result = page.funnelLayout(empty, {});
            expect(result.nodes).toEqual([]);
            expect(result.edges).toEqual([]);
            expect(result.width).toBeGreaterThan(0);
            expect(result.height).toBeGreaterThan(0);
        }
    });

    it('grows the box with the tallest column, so twelve programmes are not squeezed', () => {
        const twelve = { columns: [{ key: 'issuers', title: 'Issuer programmes', total: 0, nodes: Array.from({ length: 12 }, (_, i) => ({ id: `i${i}`, label: `I${i}`, count: 1 })) }] };
        expect(page.funnelHeight(twelve)).toBeGreaterThan(page.funnelHeight({ columns: [] }));
        expect(page.funnelLayout(twelve, {}).height).toBe(page.funnelHeight(twelve));
    });

    it('lays out the real built funnel without a circle escaping the box', () => {
        const real = page.funnelLayout(funnelDb, {});
        expect(real.nodes.length).toBeGreaterThan(20);
        expect(real.edges).toHaveLength(funnelDb.edges.length);
        for (const node of real.nodes) {
            expect(node.x - node.r).toBeGreaterThanOrEqual(0);
            expect(node.x + node.r).toBeLessThanOrEqual(real.width);
            expect(node.y - node.r).toBeGreaterThanOrEqual(0);
            expect(node.y + node.r).toBeLessThanOrEqual(real.height);
        }
        expect(real.nodes.filter((node) => node.slug !== null).length)
            .toBe(funnelDb.columns.find((c) => c.key === 'issuers').nodes.length);
    });
});

describe('funnelSvg', () => {
    const { funnelLayout, funnelSvg } = require('./lib/funnel-layout.js');
    const funnel = {
        columns: [
            { key: 'tokens', title: 'Mints', total: 3, nodes: [{ id: 'i:stock', label: 'Stocks', count: 3 }] },
            { key: 'issuers', title: 'Issuers', total: 3, nodes: [
                { id: 'live', label: 'Live <Issuer>', count: 3, status: 'live' },
                { id: 'gone', label: 'Gone', count: 0, status: 'defunct' }
            ] }
        ],
        edges: [{ from: 'i:stock', to: 'live', count: 3 }]
    };
    const svg = funnelSvg(funnelLayout(funnel, { width: 600, height: 300 }));

    it('draws one circle per node and one path per connector, each with a hover title', () => {
        expect(svg.startsWith('<svg class="funnel-svg" viewBox="0 0 600 300" width="600" height="300"')).toBe(true);
        expect(svg.match(/<circle class="funnel-dot"/g)).toHaveLength(3);
        expect(svg.match(/<path class="funnel-edge"/g)).toHaveLength(1);
        expect(svg).toContain('<title>Stocks → Live &lt;Issuer&gt;: 3 tokens</title>');
        expect(svg.endsWith('</g></svg>')).toBe(true);
    });

    it('makes only issuer circles open a dossier, and marks a defunct one hollow', () => {
        expect(svg.match(/data-slug="/g)).toHaveLength(2);
        expect(svg).toContain('data-slug="live" role="button" tabindex="0"');
        expect(svg).toContain('funnel-node funnel-node-issuers funnel-node-hollow');
        expect(svg).not.toContain('<Issuer>');
    });
});
