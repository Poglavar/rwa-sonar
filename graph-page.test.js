// Unit tests for graph-layout.js — the pure module behind graph.html. The layout is asserted on
// its outcome, not on its motion: every node inside the bounds, nothing coincident, springs near
// their rest length, and each type ring measurably further from the centre than the one inside it.
// Those all go red if a force is removed, which a "positions are finite" test would not. The graph
// under test is the committed fixture, so a change to it that breaks the page fails here first.

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const GL = require('./graph-layout.js');

const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'stocks', 'fixtures', 'graph.sample.json'), 'utf8'));
const VIEW = { width: 1100, height: 760, seed: 20260916 };

/** A deterministic ring graph of `n` nodes, for the ~100-node case MODEL §10.5 sizes the page for. */
function syntheticGraph(n) {
    const types = GL.NODE_TYPES;
    const nodes = [];
    const edges = [];
    for (let i = 0; i < n; i++) {
        const id = `n${String(i).padStart(3, '0')}`;
        nodes.push({ id, label: `Node ${i}`, type: types[i % types.length], meta: {} });
        if (i > 0) edges.push({ from: `n${String(i - 1).padStart(3, '0')}`, to: id, type: GL.EDGE_TYPES[i % GL.EDGE_TYPES.length], weight: i, via: [] });
    }
    return { nodes, edges };
}

function distance(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

// ---------------------------------------------------------------- the seeded PRNG

describe('mulberry32', () => {
    test('same seed, same stream', () => {
        const a = GL.mulberry32(42);
        const b = GL.mulberry32(42);
        expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    });

    test('different seeds diverge', () => {
        expect(GL.mulberry32(1)()).not.toBe(GL.mulberry32(2)());
    });

    test('stays in [0,1)', () => {
        const rng = GL.mulberry32(7);
        for (let i = 0; i < 500; i++) {
            const value = rng();
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThan(1);
        }
    });
});

// ---------------------------------------------------------------- rings

describe('ringFor', () => {
    test('programmes are the centre, parties the middle, venues and regulators the rim', () => {
        expect(GL.ringFor('programme')).toBe(0);
        for (const type of ['token-issuer', 'custodian', 'transfer-agent', 'verification-agent', 'parent', 'security-issuer', 'tokenization-provider']) {
            expect(GL.ringFor(type)).toBe(1);
        }
        for (const type of ['dex', 'distributor', 'lending', 'regulator', 'audience']) {
            expect(GL.ringFor(type)).toBe(2);
        }
    });

    test('an unknown type lands on the outer ring instead of the centre', () => {
        expect(GL.ringFor('mystery')).toBe(2);
        expect(GL.ringFor(undefined)).toBe(2);
    });

    test('every node type MODEL §10.4 allows has a ring', () => {
        for (const type of GL.NODE_TYPES) expect(GL.RING_BY_TYPE[type]).toBeDefined();
    });
});

// ---------------------------------------------------------------- initial positions

describe('initialPositions', () => {
    test('one finite position per node', () => {
        const positions = GL.initialPositions(FIXTURE.nodes, VIEW);
        expect(Object.keys(positions)).toHaveLength(FIXTURE.nodes.length);
        for (const node of FIXTURE.nodes) {
            expect(Number.isFinite(positions[node.id].x)).toBe(true);
            expect(Number.isFinite(positions[node.id].y)).toBe(true);
        }
    });

    test('identical for a seed, different for another', () => {
        const a = GL.initialPositions(FIXTURE.nodes, { ...VIEW, seed: 5 });
        const b = GL.initialPositions(FIXTURE.nodes, { ...VIEW, seed: 5 });
        const c = GL.initialPositions(FIXTURE.nodes, { ...VIEW, seed: 6 });
        expect(a).toEqual(b);
        expect(a).not.toEqual(c);
    });

    test('input order does not change the result', () => {
        const a = GL.initialPositions(FIXTURE.nodes, VIEW);
        const b = GL.initialPositions([...FIXTURE.nodes].reverse(), VIEW);
        expect(a).toEqual(b);
    });
});

// ---------------------------------------------------------------- the layout

describe('layout', () => {
    const result = GL.layout(FIXTURE, VIEW);

    test('never produces a NaN or an Infinity', () => {
        for (const id of Object.keys(result.positions)) {
            const p = result.positions[id];
            expect(Number.isFinite(p.x)).toBe(true);
            expect(Number.isFinite(p.y)).toBe(true);
        }
    });

    test('every node lands inside the bounds', () => {
        const { bounds } = result;
        for (const id of Object.keys(result.positions)) {
            const p = result.positions[id];
            expect(p.x).toBeGreaterThanOrEqual(bounds.minX);
            expect(p.x).toBeLessThanOrEqual(bounds.maxX);
            expect(p.y).toBeGreaterThanOrEqual(bounds.minY);
            expect(p.y).toBeLessThanOrEqual(bounds.maxY);
        }
    });

    test('repulsion separates every pair — nothing is stacked', () => {
        const ids = Object.keys(result.positions);
        let min = Infinity;
        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                min = Math.min(min, distance(result.positions[ids[i]], result.positions[ids[j]]));
            }
        }
        expect(min).toBeGreaterThan(20);
    });

    test('springs hold connected nodes near the rest length', () => {
        const lengths = FIXTURE.edges.map((edge) => distance(result.positions[edge.from], result.positions[edge.to]));
        const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
        expect(mean).toBeGreaterThan(GL.DEFAULTS.springLength * 0.6);
        // Tight enough to go red without the springs: the same graph laid out with
        // springStrength 0 settles at ~2.2x the rest length, this at ~1.4x.
        expect(mean).toBeLessThan(GL.DEFAULTS.springLength * 1.8);
    });

    test('ring gravity orders the types outwards from the centre', () => {
        const cx = VIEW.width / 2;
        const cy = VIEW.height / 2;
        const means = [0, 1, 2].map((ring) => {
            const members = FIXTURE.nodes.filter((node) => GL.ringFor(node.type) === ring);
            const sum = members.reduce((acc, node) => acc + distance(result.positions[node.id], { x: cx, y: cy }), 0);
            return sum / members.length;
        });
        expect(means[0]).toBeLessThan(means[1]);
        expect(means[1]).toBeLessThan(means[2]);
    });

    test('it has settled: the last step moves far less than the first', () => {
        const first = GL.layout(FIXTURE, { ...VIEW, iterations: 1 });
        expect(result.movement).toBeLessThan(first.movement / 10);
    });

    test('deterministic for a seed, and the input order is irrelevant', () => {
        expect(GL.layout(FIXTURE, VIEW).positions).toEqual(result.positions);
        const reversed = GL.layout({ nodes: [...FIXTURE.nodes].reverse(), edges: [...FIXTURE.edges].reverse() }, VIEW);
        expect(reversed.positions).toEqual(result.positions);
    });

    test('another seed gives another layout', () => {
        expect(GL.layout(FIXTURE, { ...VIEW, seed: 99 }).positions).not.toEqual(result.positions);
    });

    test('iterations are bounded by the option and reported', () => {
        expect(result.iterations).toBe(GL.DEFAULTS.iterations);
        expect(GL.layout(FIXTURE, { ...VIEW, iterations: 12 }).iterations).toBe(12);
    });

    test('an edge naming an unknown node does not break the run', () => {
        const broken = { nodes: FIXTURE.nodes, edges: [...FIXTURE.edges, { from: 'ghost', to: 'kraken', type: 'wraps' }] };
        const out = GL.layout(broken, VIEW);
        expect(Object.keys(out.positions)).toHaveLength(FIXTURE.nodes.length);
        expect(Object.keys(out.positions).every((id) => Number.isFinite(out.positions[id].x))).toBe(true);
    });

    test('a self-edge is ignored rather than dividing by zero', () => {
        const out = GL.layout({ nodes: [{ id: 'a', type: 'programme' }], edges: [{ from: 'a', to: 'a', type: 'wraps' }] }, VIEW);
        expect(Number.isFinite(out.positions.a.x)).toBe(true);
    });

    test('coincident starts are pushed apart, not divided by zero', () => {
        const nodes = [
            { id: 'a', type: 'programme' },
            { id: 'b', type: 'programme' },
            { id: 'c', type: 'programme' }
        ];
        const out = GL.layout({ nodes, edges: [] }, { ...VIEW, iterations: 60 });
        expect(distance(out.positions.a, out.positions.b)).toBeGreaterThan(1);
        expect(Number.isFinite(out.positions.c.x)).toBe(true);
    });

    test('an empty graph is an empty layout', () => {
        expect(GL.layout({ nodes: [], edges: [] }, VIEW).positions).toEqual({});
        expect(GL.layout(null, VIEW).positions).toEqual({});
    });

    test('a single node sits inside the bounds', () => {
        const out = GL.layout({ nodes: [{ id: 'only', type: 'programme' }], edges: [] }, VIEW);
        expect(out.positions.only.x).toBeGreaterThanOrEqual(out.bounds.minX);
        expect(out.positions.only.x).toBeLessThanOrEqual(out.bounds.maxX);
    });

    test('a 100-node graph stays finite, bounded and quick', () => {
        const graph = syntheticGraph(100);
        const started = Date.now();
        const out = GL.layout(graph, VIEW);
        expect(Date.now() - started).toBeLessThan(4000);
        for (const node of graph.nodes) {
            expect(Number.isFinite(out.positions[node.id].x)).toBe(true);
            expect(out.positions[node.id].y).toBeLessThanOrEqual(out.bounds.maxY);
        }
    });
});

// ---------------------------------------------------------------- degree

describe('degreeMap', () => {
    test('counts both directions', () => {
        const degrees = GL.degreeMap(
            [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
            [{ from: 'a', to: 'b' }, { from: 'c', to: 'a' }]
        );
        expect(degrees).toEqual({ a: 2, b: 1, c: 1 });
    });

    test('an unconnected node is 0, not missing', () => {
        expect(GL.degreeMap([{ id: 'lonely' }], [])).toEqual({ lonely: 0 });
    });

    test('the fixture\'s busiest node is a programme', () => {
        const degrees = GL.degreeMap(FIXTURE.nodes, FIXTURE.edges);
        const top = Object.keys(degrees).sort((a, b) => degrees[b] - degrees[a])[0];
        expect(FIXTURE.nodes.find((node) => node.id === top).type).toBe('programme');
    });

    test('degrees sum to twice the edge count', () => {
        const degrees = GL.degreeMap(FIXTURE.nodes, FIXTURE.edges);
        const sum = Object.keys(degrees).reduce((acc, id) => acc + degrees[id], 0);
        expect(sum).toBe(FIXTURE.edges.length * 2);
    });
});

describe('nodeRadiusPx', () => {
    test('a hub is bigger than a leaf, and a programme bigger than a party of the same degree', () => {
        expect(GL.nodeRadiusPx(12, 'dex')).toBeGreaterThan(GL.nodeRadiusPx(1, 'dex'));
        expect(GL.nodeRadiusPx(4, 'programme')).toBeGreaterThan(GL.nodeRadiusPx(4, 'dex'));
    });

    test('bounded at both ends, and a missing degree is the floor', () => {
        expect(GL.nodeRadiusPx(0, 'dex')).toBe(6);
        expect(GL.nodeRadiusPx(null, 'dex')).toBe(6);
        expect(GL.nodeRadiusPx(1e6, 'programme')).toBeLessThanOrEqual(24);
    });
});

// ---------------------------------------------------------------- two hops

describe('adjacency and nodesWithinHops', () => {
    const edges = [
        { from: 'a', to: 'b', type: 'wraps' },
        { from: 'b', to: 'c', type: 'custodies' },
        { from: 'c', to: 'd', type: 'verifies' },
        { from: 'x', to: 'y', type: 'wraps' }
    ];

    test('adjacency is undirected', () => {
        const adj = GL.adjacency(edges);
        expect([...adj.get('b')].sort()).toEqual(['a', 'c']);
        expect(adj.get('a').has('b')).toBe(true);
    });

    test('two hops reaches exactly two edges out, and stops', () => {
        const reach = GL.nodesWithinHops('a', edges, 2);
        expect([...reach].sort()).toEqual(['a', 'b', 'c']);
        expect(reach.has('d')).toBe(false);
    });

    test('one hop is the neighbours only', () => {
        expect([...GL.nodesWithinHops('b', edges, 1)].sort()).toEqual(['a', 'b', 'c']);
    });

    test('zero hops is just the node', () => {
        expect([...GL.nodesWithinHops('a', edges, 0)]).toEqual(['a']);
    });

    test('a disconnected component is never reached', () => {
        expect(GL.nodesWithinHops('a', edges, 5).has('x')).toBe(false);
    });

    test('an unknown start is itself and nothing else; no start is nothing', () => {
        expect([...GL.nodesWithinHops('ghost', edges, 2)]).toEqual(['ghost']);
        expect(GL.nodesWithinHops(null, edges, 2).size).toBe(0);
    });

    test('a prebuilt adjacency map can be passed in', () => {
        const adj = GL.adjacency(edges);
        expect([...GL.nodesWithinHops('a', adj, 2)].sort()).toEqual(['a', 'b', 'c']);
    });

    test('on the fixture, focusing a programme reaches its parties but not another programme\'s custodian', () => {
        const reach = GL.nodesWithinHops('xstocks-backed', FIXTURE.edges, 2);
        expect(reach.has('backed-assets-je-limited')).toBe(true);
        expect(reach.has('kraken')).toBe(true);
        expect(reach.has('equity-stock-transfer')).toBe(false);
    });
});

// ---------------------------------------------------------------- filters

describe('filterEdges', () => {
    test('keeps only the enabled types', () => {
        const kept = GL.filterEdges(FIXTURE.edges, ['traded-on']);
        expect(kept.length).toBeGreaterThan(0);
        expect(kept.every((edge) => edge.type === 'traded-on')).toBe(true);
    });

    test('a Set works as well as an array', () => {
        expect(GL.filterEdges(FIXTURE.edges, new Set(['wraps'])).length)
            .toBe(FIXTURE.edges.filter((edge) => edge.type === 'wraps').length);
    });

    test('nothing enabled is no edges; every type enabled is every edge', () => {
        expect(GL.filterEdges(FIXTURE.edges, [])).toEqual([]);
        expect(GL.filterEdges(FIXTURE.edges, GL.EDGE_TYPES)).toHaveLength(FIXTURE.edges.length);
    });

    test('every edge type in the fixture is one the chips offer', () => {
        for (const edge of FIXTURE.edges) expect(GL.EDGE_TYPES).toContain(edge.type);
    });
});

// ---------------------------------------------------------------- weights and widths

describe('weightRanges and edgeWidthPx', () => {
    test('USD edges and relation edges are measured on separate scales', () => {
        const ranges = GL.weightRanges(FIXTURE.edges);
        expect(ranges.usd.max).toBeGreaterThan(1e6);
        expect(ranges.relation.max).toBeLessThan(100);
    });

    test('edgeFamily splits traded-on and lends-on from the rest', () => {
        expect(GL.edgeFamily('traded-on')).toBe('usd');
        expect(GL.edgeFamily('lends-on')).toBe('usd');
        expect(GL.edgeFamily('custodies')).toBe('relation');
    });

    test('a heavier weight is a wider line, monotonically', () => {
        const range = { min: 1000, max: 10000000 };
        const widths = [1000, 10000, 100000, 1000000, 10000000].map((w) => GL.edgeWidthPx(w, range));
        for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeGreaterThan(widths[i - 1]);
    });

    test('the ends of the scale are the configured pixel bounds', () => {
        const range = { min: 100, max: 100000 };
        expect(GL.edgeWidthPx(100, range, { minPx: 1, maxPx: 6 })).toBeCloseTo(1, 6);
        expect(GL.edgeWidthPx(100000, range, { minPx: 1, maxPx: 6 })).toBeCloseTo(6, 6);
    });

    test('a missing or zero weight is a hairline, never zero-width', () => {
        const range = { min: 100, max: 100000 };
        expect(GL.edgeWidthPx(null, range, { minPx: 1.2, maxPx: 6 })).toBe(1.2);
        expect(GL.edgeWidthPx(0, range, { minPx: 1.2, maxPx: 6 })).toBe(1.2);
        expect(GL.edgeWidthPx(NaN, range)).toBe(1);
        expect(GL.edgeWidthPx(5, null)).toBe(1);
    });

    test('a family with no variation draws at the base width, not a fake middle', () => {
        // Every relation edge weighs 1 programme, so its width must not imply a measurement.
        expect(GL.edgeWidthPx(500, { min: 500, max: 500 }, { minPx: 1, maxPx: 5 })).toBe(1);
        expect(GL.edgeWidthPx(1, { min: 1, max: 1 }, { minPx: 1.2, maxPx: 7 })).toBe(1.2);
    });

    test('a weight outside the range is clamped, not extrapolated', () => {
        const range = { min: 100, max: 1000 };
        expect(GL.edgeWidthPx(1e9, range, { minPx: 1, maxPx: 6 })).toBe(6);
        expect(GL.edgeWidthPx(1, range, { minPx: 1, maxPx: 6 })).toBe(1);
    });

    test('a graph with no weights yields empty ranges rather than zeros', () => {
        const ranges = GL.weightRanges([{ type: 'lends-on', weight: null }]);
        expect(ranges.usd.min).toBeNull();
        expect(ranges.usd.max).toBeNull();
    });
});

// ---------------------------------------------------------------- fit to view

describe('fitTransform', () => {
    test('centres the graph in the viewport', () => {
        const positions = { a: { x: 0, y: 0 }, b: { x: 100, y: 100 } };
        const t = GL.fitTransform(positions, { width: 400, height: 400, padding: 20 });
        expect(0 * t.scale + t.x).toBeCloseTo(200 - 50 * t.scale, 6);
        expect(t.scale).toBeGreaterThan(1);
    });

    test('a wide graph is scaled down to fit', () => {
        const t = GL.fitTransform({ a: { x: 0, y: 0 }, b: { x: 4000, y: 10 } }, { width: 400, height: 400, padding: 20 });
        expect(t.scale).toBeLessThan(0.2);
    });

    test('scale stays inside its bounds', () => {
        const t = GL.fitTransform({ a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }, { width: 400, height: 400, padding: 20, maxScale: 2 });
        expect(t.scale).toBe(2);
    });

    test('no positions is the identity transform, not a NaN', () => {
        expect(GL.fitTransform({}, { width: 400, height: 400 })).toEqual({ scale: 1, x: 0, y: 0 });
        expect(GL.fitTransform({ a: { x: NaN, y: 1 } }, { width: 400, height: 400 })).toEqual({ scale: 1, x: 0, y: 0 });
    });

    test('a single node still yields a finite transform', () => {
        const t = GL.fitTransform({ a: { x: 700, y: 30 } }, { width: 400, height: 400, padding: 20 });
        expect(Number.isFinite(t.scale)).toBe(true);
        expect(Number.isFinite(t.x)).toBe(true);
    });

    test('the fitted fixture lands inside the viewport', () => {
        const { positions } = GL.layout(FIXTURE, VIEW);
        const view = { width: 900, height: 600, padding: 40 };
        const t = GL.fitTransform(positions, view);
        for (const id of Object.keys(positions)) {
            const x = positions[id].x * t.scale + t.x;
            const y = positions[id].y * t.scale + t.y;
            expect(x).toBeGreaterThanOrEqual(-1);
            expect(x).toBeLessThanOrEqual(view.width + 1);
            expect(y).toBeGreaterThanOrEqual(-1);
            expect(y).toBeLessThanOrEqual(view.height + 1);
        }
    });
});

// ---------------------------------------------------------------- initial view

describe('initialView (the first view, Reset and a resize)', () => {
    // The real 136-node graph in the page's own layout box, the case the phone QA pass measured.
    const REAL = JSON.parse(readFileSync(join(__dirname, 'stocks-graph.json'), 'utf8'));
    const PAGE_LAYOUT = { width: 1360, height: 940, seed: 20260916, iterations: 420, padding: 56 };
    const { positions } = GL.layout(REAL, PAGE_LAYOUT);
    const phone = { width: 375, height: 520, padding: 16, minScale: 0.2, maxScale: 4 };

    test('a phone opens at a readable scale centred on the programmes, not the 0.3 whole-graph fit', () => {
        expect(GL.fitTransform(positions, phone).scale).toBeLessThan(0.4);
        const view = GL.initialView(positions, REAL.nodes, phone);
        expect(view.whole).toBe(false);
        // 11 px labels at >= 0.8 are >= 8.8 px on screen.
        expect(view.scale).toBeGreaterThanOrEqual(0.8);
        const programmes = REAL.nodes.filter((node) => node.type === 'programme').map((node) => positions[node.id]);
        const xs = programmes.map((p) => p.x);
        const ys = programmes.map((p) => p.y);
        const centre = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
        expect(centre.x * view.scale + view.x).toBeCloseTo(phone.width / 2, 6);
        expect(centre.y * view.scale + view.y).toBeCloseTo(phone.height / 2, 6);
    });

    test('a desktop keeps the whole-graph fit, even when it is below the readable scale', () => {
        const desktop = { width: 1200, height: 700, padding: 34, minScale: 0.2, maxScale: 4 };
        const { whole, ...view } = GL.initialView(positions, REAL.nodes, desktop);
        expect(whole).toBe(true);
        expect(view).toEqual(GL.fitTransform(positions, desktop));
    });

    test('a phone whose whole-graph fit is already readable gets that fit', () => {
        const small = { a: { x: 0, y: 0 }, b: { x: 100, y: 100 } };
        const view = GL.initialView(small, [{ id: 'a', type: 'programme' }], phone);
        expect(view.whole).toBe(true);
    });

    test('with no programme placed it centres the whole graph at the readable scale', () => {
        const view = GL.initialView(positions, [], phone);
        expect(view.whole).toBe(false);
        expect(view.scale).toBe(0.8);
    });

    test('Reset unticks "Show all labels" and returns to this view; Fit still shows every node', () => {
        const js = readFileSync(join(__dirname, 'graph.js'), 'utf8');
        const reset = js.slice(js.indexOf("els.resetView.addEventListener('click'"), js.indexOf('els.panelClose.addEventListener'));
        expect(reset).toContain('els.toggleLabels.checked = false;');
        expect(reset).toContain('initialViewToStage();');
        expect(js).toContain("els.fitView.addEventListener('click', fitToView);");
    });
});

// ---------------------------------------------------------------- search

describe('matchesQuery and searchMatches', () => {
    test('matches a label, case-insensitively and mid-word', () => {
        const node = FIXTURE.nodes.find((n) => n.id === 'fma-liechtenstein');
        expect(GL.matchesQuery(node, 'liechten')).toBe(true);
        expect(GL.matchesQuery(node, 'FMA')).toBe(true);
    });

    test('matches the type, its human label and the jurisdiction', () => {
        const node = FIXTURE.nodes.find((n) => n.id === 'dekabank');
        expect(GL.matchesQuery(node, 'custodian')).toBe(true);
        expect(GL.matchesQuery(node, 'germany')).toBe(true);
        expect(GL.matchesQuery(FIXTURE.nodes.find((n) => n.id === 'raydium'), 'DEX')).toBe(true);
    });

    test('an empty query matches nothing, so the page does not light up on focus', () => {
        expect(GL.matchesQuery(FIXTURE.nodes[0], '')).toBe(false);
        expect(GL.matchesQuery(FIXTURE.nodes[0], '   ')).toBe(false);
        expect(GL.searchMatches(FIXTURE.nodes, '')).toEqual([]);
    });

    test('a query nothing matches returns no ids', () => {
        expect(GL.searchMatches(FIXTURE.nodes, 'zzzzz')).toEqual([]);
    });

    test('searching "kraken" finds the exchange, its parent and the programme it owns', () => {
        expect(GL.searchMatches(FIXTURE.nodes, 'kraken').sort())
            .toEqual(['kraken', 'payward-europe-kraken', 'xstocks-backed']);
    });

    test('a null node or query never throws', () => {
        expect(GL.matchesQuery(null, 'x')).toBe(false);
        expect(GL.matchesQuery({ label: 'x' }, null)).toBe(false);
    });
});

// ---------------------------------------------------------------- the side panel

describe('groupConnections', () => {
    const groups = GL.groupConnections('xstocks-backed', FIXTURE);

    test('groups by relation and direction, with the human phrasing of each', () => {
        const wrapped = groups.find((group) => group.type === 'wraps');
        expect(wrapped.direction).toBe('in');
        expect(wrapped.label).toBe('wrapped by');
        expect(wrapped.connections[0].label).toBe('Backed Assets (JE) Limited');
        const traded = groups.find((group) => group.type === 'traded-on');
        expect(traded.direction).toBe('out');
        expect(traded.label).toBe('traded on');
    });

    test('every relation label covers both directions', () => {
        for (const type of GL.EDGE_TYPES) {
            expect(GL.RELATION_LABELS[type]).toHaveLength(2);
            expect(GL.RELATION_LABELS[type][0]).not.toBe(GL.RELATION_LABELS[type][1]);
        }
    });

    test('connections carry the weight and the via programmes', () => {
        const traded = groups.find((group) => group.type === 'traded-on');
        const kraken = traded.connections.find((c) => c.id === 'kraken');
        expect(kraken.weight).toBe(5300000);
        expect(kraken.via).toEqual(['xstocks-backed']);
        expect(kraken.type).toBe('distributor');
    });

    test('the heaviest connection is listed first', () => {
        const weights = groups.find((group) => group.type === 'traded-on').connections.map((c) => c.weight);
        expect(weights).toEqual([...weights].sort((a, b) => b - a));
    });

    test('groups come out in the declared edge-type order', () => {
        const order = groups.map((group) => GL.EDGE_TYPES.indexOf(group.type));
        expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    test('a null weight is carried through as null, not 0', () => {
        const lends = GL.groupConnections('superstate-opening-bell', FIXTURE).find((group) => group.type === 'lends-on');
        expect(lends.connections[0].weight).toBeNull();
    });

    test('every edge touching the node appears exactly once', () => {
        const touching = FIXTURE.edges.filter((edge) => edge.from === 'xstocks-backed' || edge.to === 'xstocks-backed');
        const listed = groups.reduce((acc, group) => acc + group.connections.length, 0);
        expect(listed).toBe(touching.length);
    });

    test('a venue sees its programmes from the other end', () => {
        const venue = GL.groupConnections('kraken', FIXTURE).find((group) => group.type === 'traded-on');
        expect(venue.direction).toBe('in');
        expect(venue.label).toBe('trading venue for');
    });

    test('a node with no edges, or no graph, has no groups', () => {
        expect(GL.groupConnections('ghost', FIXTURE)).toEqual([]);
        expect(GL.groupConnections('kraken', null)).toEqual([]);
    });
});

describe('programmeOptions', () => {
    test('one option per programme, sorted by label, carrying status', () => {
        const options = GL.programmeOptions(FIXTURE.nodes);
        expect(options).toHaveLength(FIXTURE.nodes.filter((node) => node.type === 'programme').length);
        expect(options.map((option) => option.label)).toEqual([...options.map((option) => option.label)].sort());
        expect(options.find((option) => option.id === 'remora-markets').status).toBe('defunct');
    });

    test('no nodes is no options', () => {
        expect(GL.programmeOptions(null)).toEqual([]);
    });
});

describe('type labels', () => {
    test('every node type has a legend label, and every fixture node a known type', () => {
        for (const type of GL.NODE_TYPES) expect(typeof GL.TYPE_LABELS[type]).toBe('string');
        for (const node of FIXTURE.nodes) expect(GL.NODE_TYPES).toContain(node.type);
    });
});

// ---------------------------------------------------------------- tap targets

describe('phone tap targets on the checkbox, radio and chip controls', () => {
    /** The declarations of the first rule whose selector list is exactly `selector`. */
    function rule(css, selector) {
        const at = css.indexOf(`\n${selector} {`);
        return at === -1 ? '' : css.slice(at, css.indexOf('}', at));
    }
    const px = (block, prop) => Number((block.match(new RegExp(`\\n\\s*${prop}:\\s*(\\d+)px`)) || [])[1]);
    const read = (file) => readFileSync(join(__dirname, file), 'utf8');

    test('graph and live: the toggle label is >= 32px tall and the all/none chips >= 32px', () => {
        for (const file of ['graph.css', 'live.css']) {
            const css = read(file);
            expect(px(rule(css, '.toggle'), 'min-height')).toBeGreaterThanOrEqual(32);
            expect(px(rule(css, '.toggle input'), 'width')).toBeGreaterThanOrEqual(18);
            expect(px(rule(css, '.ghost-button-small'), 'min-height')).toBeGreaterThanOrEqual(32);
        }
    });

    test('stocks compare: every product and requirement label is >= 32px tall', () => {
        const css = read('stocks.css');
        expect(px(rule(css, '.comparison-products label,\n.decision-filters label'), 'min-height')).toBeGreaterThanOrEqual(32);
    });
});
