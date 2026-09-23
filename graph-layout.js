/**
 * Pure graph maths for graph.html: a seeded force-directed layout (repulsion, springs, a ring
 * gravity per node type and a light pull to the centre), plus the degree, two-hop, filter,
 * edge-width and connection-grouping helpers the page needs. No DOM, no libraries, no globals of
 * its own — the browser gets window.__graphLayout, jest gets module.exports, so nothing here can
 * shadow a top-level name in another classic script.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.__graphLayout = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /** Node types (MODEL §10.4) in the order the legend lists them. */
    const NODE_TYPES = [
        'programme',
        'security-issuer',
        'token-issuer',
        'tokenization-provider',
        'transfer-agent',
        'custodian',
        'verification-agent',
        'parent',
        'regulator',
        'distributor',
        'dex',
        'lending',
        'audience'
    ];

    /** Human labels for the legend and the side panel. */
    const TYPE_LABELS = {
        programme: 'issuer programme',
        'security-issuer': 'securities issuer',
        'token-issuer': 'token issuer',
        'tokenization-provider': 'tokenization provider',
        'transfer-agent': 'transfer agent',
        custodian: 'custodian',
        'verification-agent': 'verification agent',
        distributor: 'distributor / CEX',
        dex: 'DEX',
        lending: 'lending market',
        regulator: 'regulator',
        parent: 'parent / owner',
        audience: 'who may hold'
    };

    /** Edge types (MODEL §10.4) in the order the filter chips appear. */
    const EDGE_TYPES = [
        'issues',
        'references',
        'wraps',
        'tokenizes-for',
        'keeps-register',
        'custodies',
        'verifies',
        'distributes',
        'traded-on',
        'lends-on',
        'regulated-by',
        'owned-by',
        'offered-to'
    ];

    /** How an edge reads from each end: [outgoing phrasing, incoming phrasing]. */
    const RELATION_LABELS = {
        issues: ['issues the share behind', 'share issued by'],
        references: ['references the share of', 'share referenced by'],
        wraps: ['wraps', 'wrapped by'],
        'tokenizes-for': ['tokenizes for', 'tokenized by'],
        'keeps-register': ['keeps the register for', 'register kept by'],
        custodies: ['custodies the underlying of', 'underlying custodied by'],
        verifies: ['verifies', 'verified by'],
        distributes: ['distributes', 'distributed by'],
        'traded-on': ['traded on', 'trading venue for'],
        'lends-on': ['lends on', 'lending venue for'],
        'regulated-by': ['regulated by', 'regulates'],
        'owned-by': ['owned by', 'owns'],
        'offered-to': ['offered to', 'may hold']
    };

    /** Edge types whose weight is a USD sum; every other weight is a count of programmes. */
    const USD_EDGE_TYPES = ['traded-on', 'lends-on'];

    /** Ring 0 is the centre, ring 2 the rim. Venues, regulators and the audience sit outside. */
    const RING_BY_TYPE = {
        programme: 0,
        'security-issuer': 1,
        'token-issuer': 1,
        'tokenization-provider': 1,
        'transfer-agent': 1,
        custodian: 1,
        'verification-agent': 1,
        parent: 1,
        distributor: 2,
        dex: 2,
        lending: 2,
        regulator: 2,
        audience: 2
    };

    /**
     * Ring radius as a fraction of the half-diagonal available inside the padding. Ring 0 is a
     * small ring rather than a point: twelve programme nodes pulled to one spot pile their labels
     * on top of each other, and spreading them around a short circumference fixes that without
     * blurring the boundary with ring 1.
     */
    const RING_RADIUS = [0.24, 0.6, 0.96];

    const DEFAULTS = {
        width: 1100,
        height: 760,
        padding: 48,
        seed: 20260916,
        iterations: 420,
        repulsion: 9000,
        springLength: 140,
        springStrength: 0.035,
        ringGravity: 0.022,
        centerGravity: 0.004,
        maxStep: 28,
        minDistance: 14
    };

    /** True only for a real, finite number, so a missing weight never becomes 0. */
    function isNum(value) {
        return typeof value === 'number' && Number.isFinite(value);
    }

    function ringFor(type) {
        const ring = RING_BY_TYPE[type];
        return isNum(ring) ? ring : 2;
    }

    function isUsdEdge(type) {
        return USD_EDGE_TYPES.indexOf(type) !== -1;
    }

    function edgeFamily(type) {
        return isUsdEdge(type) ? 'usd' : 'relation';
    }

    /** Small, fast, seeded PRNG — the only randomness in the layout, so a seed fixes the result. */
    function mulberry32(seed) {
        let a = (seed >>> 0) || 1;
        return function next() {
            a = (a + 0x6d2b79f5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function sortedNodes(nodes) {
        return (Array.isArray(nodes) ? nodes.slice() : []).sort((a, b) => {
            const ida = String(a && a.id);
            const idb = String(b && b.id);
            return ida < idb ? -1 : ida > idb ? 1 : 0;
        });
    }

    /**
     * Seeded start: each node is dropped on its own ring at an angle spread over that ring's
     * members, with a seeded jitter so identical nodes do not start on top of one another.
     */
    function initialPositions(nodes, options) {
        const opts = Object.assign({}, DEFAULTS, options || {});
        const list = sortedNodes(nodes);
        const cx = opts.width / 2;
        const cy = opts.height / 2;
        const maxR = Math.max(10, Math.min(opts.width, opts.height) / 2 - opts.padding);
        const rng = mulberry32(opts.seed);

        const byRing = new Map();
        for (const node of list) {
            const ring = ringFor(node.type);
            if (!byRing.has(ring)) byRing.set(ring, []);
            byRing.get(ring).push(node);
        }

        const positions = {};
        for (const [ring, members] of [...byRing.entries()].sort((a, b) => a[0] - b[0])) {
            const radius = maxR * (RING_RADIUS[ring] === undefined ? RING_RADIUS[RING_RADIUS.length - 1] : RING_RADIUS[ring]);
            members.forEach((node, index) => {
                const angle = (2 * Math.PI * index) / Math.max(1, members.length) + ring * 0.6;
                const jitter = (rng() - 0.5) * 24;
                const r = ring === 0 ? maxR * 0.14 + jitter * 0.4 : radius + jitter;
                positions[node.id] = {
                    x: cx + Math.cos(angle) * r,
                    y: cy + Math.sin(angle) * r
                };
            });
        }
        return positions;
    }

    /**
     * The layout. Deterministic for a given seed and node/edge set: the only randomness is the
     * seeded start, every force is plain arithmetic and nodes are always visited in id order.
     * Returns the positions, the iterations actually run, the clamp bounds and the total movement
     * of the last step so a test can assert it has settled.
     */
    function layout(graph, options) {
        const opts = Object.assign({}, DEFAULTS, options || {});
        const nodes = sortedNodes(graph && graph.nodes);
        const edges = Array.isArray(graph && graph.edges) ? graph.edges : [];
        const bounds = {
            minX: opts.padding,
            minY: opts.padding,
            maxX: Math.max(opts.padding + 1, opts.width - opts.padding),
            maxY: Math.max(opts.padding + 1, opts.height - opts.padding)
        };
        if (!nodes.length) return { positions: {}, iterations: 0, bounds, movement: 0 };

        const positions = initialPositions(nodes, opts);
        const ids = nodes.map((node) => node.id);
        const index = new Map(ids.map((id, i) => [id, i]));
        const xs = ids.map((id) => positions[id].x);
        const ys = ids.map((id) => positions[id].y);
        const rings = nodes.map((node) => ringFor(node.type));
        const cx = opts.width / 2;
        const cy = opts.height / 2;
        const maxR = Math.max(10, Math.min(opts.width, opts.height) / 2 - opts.padding);
        const links = [];
        for (const edge of edges) {
            const a = index.get(edge && edge.from);
            const b = index.get(edge && edge.to);
            if (a === undefined || b === undefined || a === b) continue;
            links.push([Math.min(a, b), Math.max(a, b)]);
        }
        // Springs are accumulated in a fixed order, so the same graph given in a different edge
        // order produces bit-identical positions rather than a float-order difference.
        links.sort((p, q) => p[0] - q[0] || p[1] - q[1]);

        const n = ids.length;
        const fx = new Float64Array(n);
        const fy = new Float64Array(n);
        const minD2 = opts.minDistance * opts.minDistance;
        let movement = 0;

        for (let step = 0; step < opts.iterations; step++) {
            fx.fill(0);
            fy.fill(0);

            // Repulsion — every pair, O(n^2) at ~100 nodes.
            for (let i = 0; i < n; i++) {
                for (let j = i + 1; j < n; j++) {
                    let dx = xs[i] - xs[j];
                    let dy = ys[i] - ys[j];
                    let d2 = dx * dx + dy * dy;
                    if (d2 < 1e-6) {
                        // Deterministic nudge: coincident nodes must not produce a division by zero.
                        dx = (i - j) * 0.01 + 0.01;
                        dy = (j - i) * 0.007 + 0.013;
                        d2 = dx * dx + dy * dy;
                    }
                    const d = Math.sqrt(d2);
                    const force = opts.repulsion / Math.max(d2, minD2);
                    const ux = dx / d;
                    const uy = dy / d;
                    fx[i] += ux * force;
                    fy[i] += uy * force;
                    fx[j] -= ux * force;
                    fy[j] -= uy * force;
                }
            }

            // Springs along the edges.
            for (const [a, b] of links) {
                let dx = xs[b] - xs[a];
                let dy = ys[b] - ys[a];
                let d = Math.sqrt(dx * dx + dy * dy);
                if (d < 1e-6) {
                    dx = 0.01;
                    dy = 0.013;
                    d = Math.sqrt(dx * dx + dy * dy);
                }
                const force = opts.springStrength * (d - opts.springLength);
                const ux = (dx / d) * force;
                const uy = (dy / d) * force;
                fx[a] += ux;
                fy[a] += uy;
                fx[b] -= ux;
                fy[b] -= uy;
            }

            // Ring gravity by node type, plus a light pull to the centre so nothing drifts away.
            for (let i = 0; i < n; i++) {
                const dx = xs[i] - cx;
                const dy = ys[i] - cy;
                const d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
                const target = maxR * RING_RADIUS[rings[i]];
                const pull = (target - d) * opts.ringGravity;
                fx[i] += (dx / d) * pull;
                fy[i] += (dy / d) * pull;
                fx[i] -= dx * opts.centerGravity;
                fy[i] -= dy * opts.centerGravity;
            }

            // Cooling: the step shrinks linearly, so late iterations only polish.
            const temp = opts.maxStep * (1 - step / opts.iterations) + 0.5;
            movement = 0;
            for (let i = 0; i < n; i++) {
                let dx = fx[i];
                let dy = fy[i];
                if (!Number.isFinite(dx)) dx = 0;
                if (!Number.isFinite(dy)) dy = 0;
                const mag = Math.sqrt(dx * dx + dy * dy);
                if (mag > temp) {
                    dx = (dx / mag) * temp;
                    dy = (dy / mag) * temp;
                }
                xs[i] = Math.min(bounds.maxX, Math.max(bounds.minX, xs[i] + dx));
                ys[i] = Math.min(bounds.maxY, Math.max(bounds.minY, ys[i] + dy));
                movement += Math.abs(dx) + Math.abs(dy);
            }
        }

        const out = {};
        for (let i = 0; i < n; i++) out[ids[i]] = { x: xs[i], y: ys[i] };
        return { positions: out, iterations: opts.iterations, bounds, movement };
    }

    /** id -> how many edges touch it, counting both directions. */
    function degreeMap(nodes, edges) {
        const degrees = Object.create(null);
        for (const node of Array.isArray(nodes) ? nodes : []) {
            if (node && node.id) degrees[node.id] = 0;
        }
        for (const edge of Array.isArray(edges) ? edges : []) {
            if (!edge) continue;
            if (edge.from in degrees) degrees[edge.from] += 1;
            else if (edge.from) degrees[edge.from] = 1;
            if (edge.to in degrees) degrees[edge.to] += 1;
            else if (edge.to) degrees[edge.to] = 1;
        }
        return degrees;
    }

    /** Undirected neighbour sets, so a walk can cross an edge either way. */
    function adjacency(edges) {
        const adj = new Map();
        function add(a, b) {
            if (!adj.has(a)) adj.set(a, new Set());
            adj.get(a).add(b);
        }
        for (const edge of Array.isArray(edges) ? edges : []) {
            if (!edge || !edge.from || !edge.to) continue;
            add(edge.from, edge.to);
            add(edge.to, edge.from);
        }
        return adj;
    }

    /** Breadth-first: the start id plus everything reachable in `hops` edges or fewer. */
    function nodesWithinHops(startId, edges, hops) {
        const reach = new Set();
        if (!startId) return reach;
        const limit = isNum(hops) ? hops : 2;
        const adj = edges instanceof Map ? edges : adjacency(edges);
        reach.add(startId);
        let frontier = [startId];
        for (let depth = 0; depth < limit; depth++) {
            const next = [];
            for (const id of frontier) {
                for (const neighbour of adj.get(id) || []) {
                    if (reach.has(neighbour)) continue;
                    reach.add(neighbour);
                    next.push(neighbour);
                }
            }
            if (!next.length) break;
            frontier = next.sort();
        }
        return reach;
    }

    /** Edges whose type is switched on. `enabled` may be a Set or an array. */
    function filterEdges(edges, enabled) {
        const set = enabled instanceof Set ? enabled : new Set(Array.isArray(enabled) ? enabled : []);
        return (Array.isArray(edges) ? edges : []).filter((edge) => edge && set.has(edge.type));
    }

    /** {usd:{min,max}, relation:{min,max}} over the positive weights actually present. */
    function weightRanges(edges) {
        const ranges = { usd: { min: null, max: null }, relation: { min: null, max: null } };
        for (const edge of Array.isArray(edges) ? edges : []) {
            if (!edge || !isNum(edge.weight) || edge.weight <= 0) continue;
            const family = ranges[edgeFamily(edge.type)];
            family.min = family.min === null ? edge.weight : Math.min(family.min, edge.weight);
            family.max = family.max === null ? edge.weight : Math.max(family.max, edge.weight);
        }
        return ranges;
    }

    /**
     * Edge stroke width from the log of its weight, scaled inside its own family — a $5m venue
     * edge and a 3-programme custodian edge are not on one scale. A missing weight is a hairline,
     * never a zero-width line, and a family whose weights are all identical carries no width
     * signal at all, so every line in it draws at the base width rather than at some middle value
     * that would look like a measurement.
     */
    function edgeWidthPx(weight, range, options) {
        const opts = Object.assign({ minPx: 1, maxPx: 6 }, options || {});
        if (!isNum(weight) || weight <= 0) return opts.minPx;
        if (!range || !isNum(range.min) || !isNum(range.max)) return opts.minPx;
        const lo = Math.log10(Math.max(1, range.min));
        const hi = Math.log10(Math.max(1, range.max));
        if (hi - lo < 1e-9) return opts.minPx;
        const t = (Math.log10(Math.max(1, weight)) - lo) / (hi - lo);
        return opts.minPx + Math.min(1, Math.max(0, t)) * (opts.maxPx - opts.minPx);
    }

    /** Node radius from its degree, so a hub reads as a hub. Bounded both ends. */
    function nodeRadiusPx(degree, type, options) {
        const opts = Object.assign({ minPx: 6, maxPx: 20, programmeBonus: 4 }, options || {});
        const d = isNum(degree) ? Math.max(0, degree) : 0;
        const base = opts.minPx + Math.min(1, Math.log10(d + 1) / Math.log10(24)) * (opts.maxPx - opts.minPx);
        return type === 'programme' ? Math.min(opts.maxPx + opts.programmeBonus, base + opts.programmeBonus) : base;
    }

    /** The scale and translation that fit every position into a viewport. */
    function fitTransform(positions, viewport) {
        const view = Object.assign({ width: 1100, height: 760, padding: 40, maxScale: 3, minScale: 0.15 }, viewport || {});
        const points = Object.keys(positions || {}).map((id) => positions[id]).filter((p) => p && isNum(p.x) && isNum(p.y));
        if (!points.length) return { scale: 1, x: 0, y: 0 };
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const p of points) {
            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
        }
        const spanX = Math.max(1, maxX - minX);
        const spanY = Math.max(1, maxY - minY);
        const usableW = Math.max(1, view.width - view.padding * 2);
        const usableH = Math.max(1, view.height - view.padding * 2);
        const scale = Math.min(view.maxScale, Math.max(view.minScale, Math.min(usableW / spanX, usableH / spanY)));
        return {
            scale,
            x: view.width / 2 - ((minX + maxX) / 2) * scale,
            y: view.height / 2 - ((minY + maxY) / 2) * scale
        };
    }

    /**
     * The first view of the graph. Fitting all 87 nodes into a 375 px phone gives a scale near 0.3,
     * at which an 11 px label is 3 px tall — a picture of a graph nobody can read. So when the
     * whole-graph fit falls below `readableScale`, the view instead fits the programmes (ring 0,
     * the centre everything else is arranged around) and never goes below `readableScale`; the
     * rest of the graph is a pan or the Fit button away. Only a narrow stage (below
     * `narrowWidth`) is treated this way: a desktop's whole-graph fit (~0.76 at 1200 px) is small
     * but legible, and there the overview is the point. Returns `{scale, x, y, whole}`, where
     * `whole` says which of the two it chose.
     */
    function initialView(positions, nodes, viewport) {
        const view = Object.assign({ readableScale: 0.8, focusMaxScale: 1.3, narrowWidth: 720 }, viewport || {});
        const whole = fitTransform(positions, view);
        if (whole.scale >= view.readableScale || !(view.width < view.narrowWidth)) {
            return Object.assign({}, whole, { whole: true });
        }
        const focus = {};
        for (const node of Array.isArray(nodes) ? nodes : []) {
            const p = node && positions ? positions[node.id] : null;
            if (ringFor(node && node.type) === 0 && p && isNum(p.x) && isNum(p.y)) focus[node.id] = p;
        }
        // No programme placed: centre the whole graph at the readable scale rather than fail.
        const target = Object.keys(focus).length ? focus : positions;
        const fit = fitTransform(target, Object.assign({}, view, { minScale: 0, maxScale: Infinity }));
        const scale = Math.min(Math.max(fit.scale, view.readableScale),
            Math.max(view.readableScale, Math.min(view.focusMaxScale, isNum(view.maxScale) ? view.maxScale : Infinity)));
        // fitTransform centres the target's bounding box; keep that centre at the new scale.
        const cx = (view.width / 2 - fit.x) / fit.scale;
        const cy = (view.height / 2 - fit.y) / fit.scale;
        return { scale, x: view.width / 2 - cx * scale, y: view.height / 2 - cy * scale, whole: false };
    }

    /** Case-insensitive substring match over a node's label, id, type and jurisdiction. */
    function matchesQuery(node, query) {
        const q = String(query === null || query === undefined ? '' : query).trim().toLowerCase();
        if (!q) return false;
        if (!node) return false;
        const meta = node.meta || {};
        const haystack = [node.label, node.id, node.type, TYPE_LABELS[node.type], meta.jurisdiction, meta.identifier, meta.slug]
            .filter((part) => typeof part === 'string')
            .join(' ')
            .toLowerCase();
        return haystack.indexOf(q) !== -1;
    }

    function searchMatches(nodes, query) {
        return (Array.isArray(nodes) ? nodes : []).filter((node) => matchesQuery(node, query)).map((node) => node.id);
    }

    /**
     * Every edge touching `nodeId`, grouped by relation and direction and sorted heaviest first,
     * for the side panel. `via` is carried through untouched: it is the programme the relation was
     * read from, and it is the only provenance the panel can show.
     */
    function groupConnections(nodeId, graph) {
        const nodes = Array.isArray(graph && graph.nodes) ? graph.nodes : [];
        const edges = Array.isArray(graph && graph.edges) ? graph.edges : [];
        const byId = new Map(nodes.map((node) => [node.id, node]));
        const groups = new Map();

        for (const edge of edges) {
            if (!edge || (edge.from !== nodeId && edge.to !== nodeId)) continue;
            const outgoing = edge.from === nodeId;
            const otherId = outgoing ? edge.to : edge.from;
            const other = byId.get(otherId);
            const labels = RELATION_LABELS[edge.type] || [edge.type, edge.type];
            const key = `${edge.type}:${outgoing ? 'out' : 'in'}`;
            if (!groups.has(key)) {
                groups.set(key, {
                    key,
                    type: edge.type,
                    direction: outgoing ? 'out' : 'in',
                    label: labels[outgoing ? 0 : 1],
                    family: edgeFamily(edge.type),
                    connections: []
                });
            }
            groups.get(key).connections.push({
                id: otherId,
                label: other ? other.label : otherId,
                type: other ? other.type : null,
                weight: isNum(edge.weight) ? edge.weight : null,
                via: Array.isArray(edge.via) ? edge.via.slice() : [],
                note: edge.note || null
            });
        }

        for (const group of groups.values()) {
            group.connections.sort((a, b) => {
                const wa = isNum(a.weight) ? a.weight : -1;
                const wb = isNum(b.weight) ? b.weight : -1;
                if (wa !== wb) return wb - wa;
                return String(a.label).localeCompare(String(b.label));
            });
        }

        return [...groups.values()].sort((a, b) => {
            const ta = EDGE_TYPES.indexOf(a.type);
            const tb = EDGE_TYPES.indexOf(b.type);
            if (ta !== tb) return ta - tb;
            return a.direction === b.direction ? 0 : a.direction === 'out' ? -1 : 1;
        });
    }

    /** Every programme node, sorted for the focus select. */
    function programmeOptions(nodes) {
        return (Array.isArray(nodes) ? nodes : [])
            .filter((node) => node && node.type === 'programme')
            .map((node) => ({ id: node.id, label: node.label || node.id, status: (node.meta || {}).status || null }))
            .sort((a, b) => String(a.label).localeCompare(String(b.label)));
    }

    return {
        NODE_TYPES,
        TYPE_LABELS,
        EDGE_TYPES,
        RELATION_LABELS,
        USD_EDGE_TYPES,
        RING_BY_TYPE,
        RING_RADIUS,
        DEFAULTS,
        isNum,
        ringFor,
        isUsdEdge,
        edgeFamily,
        mulberry32,
        initialPositions,
        layout,
        degreeMap,
        adjacency,
        nodesWithinHops,
        filterEdges,
        weightRanges,
        edgeWidthPx,
        nodeRadiusPx,
        fitTransform,
        initialView,
        matchesQuery,
        searchMatches,
        groupConnections,
        programmeOptions
    };
}));
