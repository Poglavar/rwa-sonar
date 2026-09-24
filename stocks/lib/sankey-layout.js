/*
 * The DeFi-usage Sankey on exits.html: issuer -> protocol -> action, one ribbon per proof stage.
 * Pure — no DOM, no fetch, no clock. aggregateFlows() turns stocks-exits.json `flows` rows into
 * nodes and links, layoutSankey() places them (node boxes and link centre-lines in SVG user units),
 * sankeySvg() writes the SVG string, and rankedPaths() is the readable list phones get instead.
 * A link whose rows report no USD is drawn at a fixed thin width with class `no-usd` and its label
 * says so; it is never treated as $0. UMD like the other stocks/lib/*.js files (window.__rwaSankey).
 * Tested in stocks/sankey-layout.test.js.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.__rwaSankey = factory();
})(this, function () {
    'use strict';

    /** Proof stages from strongest to weakest (stocks/lib/protocol-proof.js). */
    const STAGES = ['simulated', 'decoded', 'source-listed', 'observed-market', 'account-observed', 'not-established'];
    const STAGE_LABELS = {
        simulated: 'Simulated',
        decoded: 'Configuration-decoded',
        'source-listed': 'Source-listed',
        'observed-market': 'Market-observed',
        'account-observed': 'Account observed on-chain',
        'not-established': 'Not established'
    };
    const ACTIONS = ['collateral', 'loan', 'liquidity', 'vault'];
    const ACTION_LABELS = { collateral: 'Collateral', loan: 'Loan (observed position)', liquidity: 'DEX liquidity', vault: 'Yield vault' };
    const BASIS_LABELS = { 'pool-liquidity': 'pool liquidity', 'reported-market-size': 'reported market size' };

    function finite(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
    function esc(value) {
        return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function stageRank(stage) { const i = STAGES.indexOf(stage); return i < 0 ? STAGES.length : i; }
    function money(value) {
        if (finite(value) === null) return null;
        const abs = Math.abs(value);
        if (abs >= 1e9) return '$' + (value / 1e9).toFixed(2) + 'B';
        if (abs >= 1e6) return '$' + (value / 1e6).toFixed(2) + 'M';
        if (abs >= 1e3) return '$' + (value / 1e3).toFixed(1) + 'k';
        return '$' + value.toFixed(0);
    }

    function addRow(link, row) {
        link.rows.push({ symbol: row.symbol ?? null, mint: row.mint ?? null, dossier: row.dossier ?? null, usd: finite(row.usd), usdBasis: row.usdBasis ?? null, stageAsOf: row.stageAsOf ?? null, via: Array.isArray(row.via) ? row.via : [] });
        const usd = finite(row.usd);
        if (usd === null) link.noUsdRows += 1;
        else { link.usd = (link.usd ?? 0) + usd; link.usdRows += 1; }
        if (row.usdBasis) link.bases.add(row.usdBasis);
    }

    /**
     * Nodes (issuer, protocol, action) and links split by proof stage. `issuerNames` maps a slug to
     * its display name. Rows without an action column are skipped (they are not a DeFi use).
     */
    function aggregateFlows(flows, { issuerNames = {} } = {}) {
        const nodes = new Map();
        const links = new Map();
        const node = (id, column, label, extra = {}) => {
            if (!nodes.has(id)) nodes.set(id, { id, column, label, ...extra });
            return nodes.get(id);
        };
        for (const row of Array.isArray(flows) ? flows : []) {
            if (!row || !ACTIONS.includes(row.action) || !row.issuer || !row.protocolId) continue;
            const stage = STAGES.includes(row.stage) ? row.stage : 'not-established';
            const i = node(`i:${row.issuer}`, 0, issuerNames[row.issuer] ?? row.issuer, { key: row.issuer });
            const p = node(`p:${row.protocolId}`, 1, row.protocol ?? row.protocolId, { key: row.protocolId });
            const a = node(`a:${row.action}`, 2, ACTION_LABELS[row.action], { key: row.action });
            for (const [s, t] of [[i, p], [p, a]]) {
                const id = `${s.id}>${t.id}|${stage}`;
                if (!links.has(id)) links.set(id, { id, source: s.id, target: t.id, stage, usd: null, usdRows: 0, noUsdRows: 0, bases: new Set(), rows: [] });
                addRow(links.get(id), row);
            }
        }
        return {
            nodes: [...nodes.values()],
            links: [...links.values()].map((link) => ({ ...link, bases: [...link.bases].sort() }))
        };
    }

    /** Pixel width of one link at scale k (USD -> px). */
    function linkPx(link, k, minLinkPx, noUsdPx) {
        return finite(link.usd) !== null && link.usd > 0 ? Math.max(minLinkPx, link.usd * k) : noUsdPx;
    }

    function columnHeights(graph, k, o) {
        const heights = [0, 0, 0];
        const counts = [0, 0, 0];
        for (const n of graph.nodes) {
            let inPx = 0; let outPx = 0;
            for (const l of graph.links) {
                const w = linkPx(l, k, o.minLinkPx, o.noUsdPx);
                if (l.target === n.id) inPx += w;
                if (l.source === n.id) outPx += w;
            }
            heights[n.column] += Math.max(inPx, outPx, o.minNodePx);
            counts[n.column] += 1;
        }
        return heights.map((h, c) => h + Math.max(0, counts[c] - 1) * o.nodeGap);
    }

    /**
     * Positions for every node and link. The USD scale is the largest k for which the tallest
     * column still fits the inner height (binary search: heights grow monotonically with k).
     */
    function layoutSankey(graph, options = {}) {
        const o = {
            width: 900, height: 480, nodeWidth: 14, nodeGap: 12, minLinkPx: 1.5, noUsdPx: 2, minNodePx: 4,
            padTop: 10, padBottom: 10, labelLeft: 150, labelRight: 150, ...options
        };
        const inner = o.height - o.padTop - o.padBottom;
        const maxUsd = Math.max(1, ...graph.links.map((l) => finite(l.usd) ?? 0));
        let lo = 0; let hi = inner / maxUsd;
        for (let step = 0; step < 50; step += 1) {
            const mid = (lo + hi) / 2;
            if (Math.max(...columnHeights(graph, mid, o)) <= inner) lo = mid; else hi = mid;
        }
        const k = lo;
        const links = graph.links.map((l) => ({ ...l, w: linkPx(l, k, o.minLinkPx, o.noUsdPx) }));
        const xs = [o.labelLeft, (o.labelLeft + o.width - o.labelRight - o.nodeWidth) / 2, o.width - o.labelRight - o.nodeWidth];
        const nodes = graph.nodes.map((n) => {
            const inPx = links.filter((l) => l.target === n.id).reduce((t, l) => t + l.w, 0);
            const outPx = links.filter((l) => l.source === n.id).reduce((t, l) => t + l.w, 0);
            const usd = links.filter((l) => (n.column === 0 ? l.source : l.target) === n.id)
                .reduce((t, l) => (finite(l.usd) === null ? t : (t ?? 0) + l.usd), null);
            return { ...n, h: Math.max(inPx, outPx, o.minNodePx), x: xs[n.column], y: 0, usd };
        });
        const byId = new Map(nodes.map((n) => [n.id, n]));
        for (let c = 0; c < 3; c += 1) {
            const col = nodes.filter((n) => n.column === c);
            if (c === 2) col.sort((a, b) => ACTIONS.indexOf(a.key) - ACTIONS.indexOf(b.key));
            else col.sort((a, b) => b.h - a.h || String(a.label).localeCompare(String(b.label)));
            const total = col.reduce((t, n) => t + n.h, 0) + Math.max(0, col.length - 1) * o.nodeGap;
            let y = o.padTop + Math.max(0, (inner - total) / 2);
            col.forEach((n, i) => { n.order = i; n.y = y; y += n.h + o.nodeGap; });
        }
        // Stack links at each end in the order of the node at the other end, then by stage.
        const endOrder = (other) => (a, b) => byId.get(a[other]).order - byId.get(b[other]).order || stageRank(a.stage) - stageRank(b.stage);
        for (const n of nodes) {
            let sy = n.y + Math.max(0, (n.h - links.filter((l) => l.source === n.id).reduce((t, l) => t + l.w, 0)) / 2);
            for (const l of links.filter((x) => x.source === n.id).sort(endOrder('target'))) { l.sy = sy + l.w / 2; sy += l.w; }
            let ty = n.y + Math.max(0, (n.h - links.filter((l) => l.target === n.id).reduce((t, l) => t + l.w, 0)) / 2);
            for (const l of links.filter((x) => x.target === n.id).sort(endOrder('source'))) { l.ty = ty + l.w / 2; ty += l.w; }
        }
        for (const l of links) {
            const x0 = byId.get(l.source).x + o.nodeWidth; const x1 = byId.get(l.target).x; const xm = (x0 + x1) / 2;
            l.x0 = x0; l.x1 = x1;
            l.d = `M${x0.toFixed(1)},${l.sy.toFixed(1)}C${xm.toFixed(1)},${l.sy.toFixed(1)} ${xm.toFixed(1)},${l.ty.toFixed(1)} ${x1.toFixed(1)},${l.ty.toFixed(1)}`;
        }
        return { width: o.width, height: o.height, nodeWidth: o.nodeWidth, nodeGap: o.nodeGap, scale: k, nodes, links };
    }

    /** A height that gives every node of the busiest column room for a label. */
    function suggestHeight(graph, { perNode = 34, min = 320, max = 900 } = {}) {
        const counts = [0, 0, 0];
        for (const n of graph.nodes) counts[n.column] += 1;
        return Math.min(max, Math.max(min, Math.max(...counts) * perNode));
    }

    /**
     * Whether the diagram is readable at a container width: below minWidth the three columns and
     * their labels collide, and two node labels closer than minLabelGap overprint each other.
     */
    function sankeyLegible(layout, containerWidth, { minWidth = 640, minLabelGap = 12 } = {}) {
        if (!(finite(containerWidth) !== null && containerWidth >= minWidth)) return false;
        for (let c = 0; c < 3; c += 1) {
            const centres = layout.nodes.filter((n) => n.column === c).map((n) => n.y + n.h / 2).sort((a, b) => a - b);
            for (let i = 1; i < centres.length; i += 1) if (centres[i] - centres[i - 1] < minLabelGap) return false;
        }
        return true;
    }

    function linkLabel(link, nodesById) {
        const s = nodesById.get(link.source)?.label ?? link.source;
        const t = nodesById.get(link.target)?.label ?? link.target;
        const tokens = link.usdRows + link.noUsdRows;
        const usd = money(link.usd);
        const basis = link.bases.map((b) => BASIS_LABELS[b] ?? b).join(' + ');
        const amount = usd === null ? 'USD not reported' : `${usd} ${basis}${link.noUsdRows ? ` (+${link.noUsdRows} without USD)` : ''}`;
        return `${s} → ${t} · ${STAGE_LABELS[link.stage]} · ${amount} · ${tokens} exact-token integration${tokens === 1 ? '' : 's'}`;
    }

    /** The SVG string. Protocol nodes link to the dossier index; every link has a <title>. */
    function sankeySvg(layout, { protocolHref = null, title = 'DeFi usage by issuer, protocol and action' } = {}) {
        const byId = new Map(layout.nodes.map((n) => [n.id, n]));
        const links = layout.links.slice().sort((a, b) => b.w - a.w).map((l) => `<path class="sk-link stage-${esc(l.stage)}${finite(l.usd) === null ? ' no-usd' : ''}" d="${l.d}" stroke-width="${l.w.toFixed(2)}"><title>${esc(linkLabel(l, byId))}</title></path>`).join('');
        const nodes = layout.nodes.map((n) => {
            const usd = money(n.usd);
            const anchorRight = n.column === 0;
            const lx = anchorRight ? n.x - 6 : n.x + layout.nodeWidth + 6;
            const ly = n.y + n.h / 2;
            const label = `<text class="sk-label" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchorRight ? 'end' : 'start'}" dominant-baseline="middle">${esc(n.label)}${usd ? `<tspan class="sk-usd"> ${esc(usd)}</tspan>` : ''}</text>`;
            const rect = `<rect class="sk-node sk-col-${n.column}" x="${n.x.toFixed(1)}" y="${n.y.toFixed(1)}" width="${layout.nodeWidth}" height="${n.h.toFixed(1)}"><title>${esc(n.label)}${usd ? ` · ${esc(usd)} with reported USD` : ' · USD not reported'}</title></rect>`;
            const inner = rect + label;
            return n.column === 1 && protocolHref ? `<a href="${esc(protocolHref)}" class="sk-node-link">${inner}</a>` : `<g>${inner}</g>`;
        }).join('');
        return `<svg class="sk-svg" viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-label="${esc(title)}"><g class="sk-links">${links}</g><g class="sk-nodes">${nodes}</g></svg>`;
    }

    /**
     * The phone reading: full issuer -> protocol -> action paths, split by proof stage, ranked by
     * USD with unreported USD last (never as zero).
     */
    function rankedPaths(flows, { issuerNames = {} } = {}) {
        const paths = new Map();
        for (const row of Array.isArray(flows) ? flows : []) {
            if (!row || !ACTIONS.includes(row.action) || !row.issuer || !row.protocolId) continue;
            const stage = STAGES.includes(row.stage) ? row.stage : 'not-established';
            const id = `${row.issuer}|${row.protocolId}|${row.action}|${stage}`;
            if (!paths.has(id)) {
                paths.set(id, { id, issuer: row.issuer, issuerName: issuerNames[row.issuer] ?? row.issuer, protocolId: row.protocolId,
                    protocol: row.protocol ?? row.protocolId, action: row.action, actionLabel: ACTION_LABELS[row.action], stage,
                    stageLabel: STAGE_LABELS[stage], usd: null, usdRows: 0, noUsdRows: 0, bases: new Set(), rows: [] });
            }
            addRow(paths.get(id), row);
        }
        return [...paths.values()].map((p) => ({ ...p, bases: [...p.bases].sort(), rows: p.rows.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || String(a.symbol).localeCompare(String(b.symbol))) }))
            .sort((a, b) => {
                const au = finite(a.usd); const bu = finite(b.usd);
                if (au === null && bu !== null) return 1;
                if (bu === null && au !== null) return -1;
                return (bu ?? 0) - (au ?? 0) || (b.usdRows + b.noUsdRows) - (a.usdRows + a.noUsdRows) || a.id.localeCompare(b.id);
            });
    }

    return { STAGES, STAGE_LABELS, ACTIONS, ACTION_LABELS, BASIS_LABELS, aggregateFlows, layoutSankey, suggestHeight, sankeyLegible, sankeySvg, rankedPaths, linkLabel, money };
});
