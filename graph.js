/**
 * Renders the parties graph (stocks/MODEL.md §10.5) from stocks-graph.json into one SVG: nodes
 * coloured by type, edges widened by the log of their weight, relation filter chips, a focus
 * programme that dims everything beyond two hops, a search box and a side panel of one node's
 * connections. Every piece of maths — the layout, the two-hop walk, the widths, the grouping —
 * lives in graph-layout.js and is unit-tested there; this file only builds DOM and wires events.
 * It is wrapped in an IIFE and declares no globals, so it cannot shadow anything in another script.
 */
(function () {
    'use strict';

    const GRAPH_PATH = './stocks-graph.json';
    const SAMPLE_GRAPH_PATH = './stocks/fixtures/graph.sample.json';
    const DASH = '—';
    /**
     * The layout runs in its own coordinate box and fit-to-view maps it onto the SVG, so these are
     * not pixels on screen. 1360x940 was measured against the real 87-node graph as the box that
     * keeps the three type rings visibly separated (mean radii 115 / 258 / 307) while leaving the
     * twelve programme labels in the centre almost collision-free.
     */
    const LAYOUT = { width: 1360, height: 940, seed: 20260916, iterations: 420, padding: 56 };
    const ZOOM_MIN = 0.2;
    const ZOOM_MAX = 4;
    /** How far a pointer may travel and still count as a tap on a node rather than a pan. */
    const TAP_SLOP_PX = 5;
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

    const GL = typeof globalThis !== 'undefined' ? globalThis.__graphLayout : null;

    function isNum(value) {
        return typeof value === 'number' && Number.isFinite(value);
    }

    /** Escapes text for interpolation into HTML, attribute values included. */
    function escapeHtml(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
    }

    /** Only http(s), same-origin and mailto links are ever emitted as hrefs. */
    function isSafeUrl(url) {
        if (!url || typeof url !== 'string') return false;
        const trimmed = url.trim().toLowerCase();
        return trimmed.startsWith('http://') || trimmed.startsWith('https://') ||
            trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../') ||
            trimmed.startsWith('mailto:');
    }

    /** Compact USD: $1.23B / $4.56M / $78.9k / $12.34 / $0 / "—". */
    function fmtMoney(value) {
        if (!isNum(value)) return DASH;
        const abs = Math.abs(value);
        if (abs >= 1e9) return '$' + (value / 1e9).toFixed(2) + 'B';
        if (abs >= 1e6) return '$' + (value / 1e6).toFixed(2) + 'M';
        if (abs >= 1e3) return '$' + (value / 1e3).toFixed(1) + 'k';
        if (abs >= 1) return '$' + value.toFixed(2);
        if (value === 0) return '$0';
        return '<$1';
    }

    function fmtNumber(value) {
        return isNum(value) ? value.toLocaleString('en-US') : DASH;
    }

    function fmtDateTime(value) {
        if (!value) return DASH;
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return DASH;
        return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
    }

    /** How an edge weight reads: a USD sum for a venue, a programme count for a relation. */
    function fmtWeight(weight, family) {
        if (!isNum(weight)) return DASH;
        if (family === 'usd') return fmtMoney(weight);
        return `${fmtNumber(weight)} programme${weight === 1 ? '' : 's'}`;
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function svgEl(name, attrs) {
        const el = document.createElementNS(SVG_NS, name);
        for (const key of Object.keys(attrs || {})) el.setAttribute(key, attrs[key]);
        return el;
    }

    if (typeof document === 'undefined') return;

    document.addEventListener('DOMContentLoaded', () => {
        const els = {
            status: document.getElementById('status'),
            sampleBanner: document.getElementById('sampleBanner'),
            focus: document.getElementById('focusProgramme'),
            search: document.getElementById('searchNodes'),
            toggleLabels: document.getElementById('toggleLabels'),
            fitView: document.getElementById('fitView'),
            resetView: document.getElementById('resetView'),
            chips: document.getElementById('edgeChips'),
            chipsAll: document.getElementById('chipsAll'),
            chipsNone: document.getElementById('chipsNone'),
            stage: document.getElementById('graphStage'),
            svg: document.getElementById('graphSvg'),
            root: document.getElementById('graphRoot'),
            edgeLayer: document.getElementById('graphEdges'),
            nodeLayer: document.getElementById('graphNodes'),
            legend: document.getElementById('nodeLegend'),
            panel: document.getElementById('nodePanel'),
            panelTitle: document.getElementById('panelTitle'),
            panelType: document.getElementById('panelType'),
            panelBody: document.getElementById('panelBody'),
            panelClose: document.getElementById('panelClose')
        };

        const state = {
            graph: { nodes: [], edges: [] },
            nodesById: new Map(),
            positions: {},
            degrees: {},
            ranges: { usd: { min: null, max: null }, relation: { min: null, max: null } },
            adjacency: new Map(),
            enabled: new Set(),
            focusId: '',
            query: '',
            selectedId: null,
            view: { scale: 1, x: 0, y: 0 },
            nodeEls: new Map(),
            edgeEls: []
        };

        // Active pointers, so one finger pans and two fingers pinch without a library.
        const pointers = new Map();
        let pinchStart = null;
        let panStart = null;
        let tapStart = null;

        if (!GL) {
            els.status.textContent = 'graph-layout.js did not load, so nothing can be drawn. ' +
                'Check the script tag and reload.';
            els.status.classList.add('status-error');
            return;
        }

        state.enabled = new Set(GL.EDGE_TYPES);

        loadGraph();

        async function loadGraph() {
            const useSample = new URLSearchParams(window.location.search).get('db') === 'sample';
            const path = useSample ? SAMPLE_GRAPH_PATH : GRAPH_PATH;
            const graph = await fetchJson(path);

            if (!graph || !Array.isArray(graph.nodes) || !graph.nodes.length) {
                els.status.textContent = `No data: ${path} could not be loaded or has no nodes. ` +
                    'Build it with "npm run stocks:build && npm run stocks:venues && npm run stocks:graph", ' +
                    'or append ?db=sample to this URL to view the bundled sample fixture.';
                els.status.classList.add('status-error');
                return;
            }

            if (useSample && els.sampleBanner) els.sampleBanner.hidden = false;

            state.graph = { nodes: graph.nodes, edges: Array.isArray(graph.edges) ? graph.edges : [] };
            state.nodesById = new Map(state.graph.nodes.map((node) => [node.id, node]));
            state.degrees = GL.degreeMap(state.graph.nodes, state.graph.edges);
            state.ranges = GL.weightRanges(state.graph.edges);
            state.adjacency = GL.adjacency(state.graph.edges);
            state.positions = GL.layout(state.graph, LAYOUT).positions;

            renderStatus(graph);
            renderLegend();
            renderChips();
            renderFocusOptions();
            renderGraph();
            initialViewToStage();
            applyVisualState();
            wireEvents();
        }

        async function fetchJson(path) {
            try {
                const res = await fetch(path, { cache: 'no-store' });
                if (!res.ok) return null;
                return await res.json();
            } catch (err) {
                return null;
            }
        }

        // --- static rendering -------------------------------------------------

        function renderStatus(graph) {
            const programmes = state.graph.nodes.filter((node) => node.type === 'programme').length;
            const byType = {};
            for (const node of state.graph.nodes) byType[node.type] = (byType[node.type] || 0) + 1;
            const venues = (byType.dex || 0) + (byType.distributor || 0) + (byType.lending || 0);
            els.status.textContent = `${state.graph.nodes.length} nodes and ${state.graph.edges.length} edges: ` +
                `${programmes} programme${programmes === 1 ? '' : 's'}, ` +
                `${state.graph.nodes.length - programmes - venues} named parties, ${venues} venues. ` +
                `Built ${fmtDateTime(graph.builtAt)}.`;
        }

        function renderLegend() {
            const present = new Set(state.graph.nodes.map((node) => node.type));
            els.legend.innerHTML = GL.NODE_TYPES
                .filter((type) => present.has(type))
                .map((type) => {
                    const count = state.graph.nodes.filter((node) => node.type === type).length;
                    return `<span class="legend-item">` +
                        `<span class="legend-dot${type === 'audience' ? ' legend-dot-square' : ''} ` +
                        `type-${escapeHtml(type)}"></span>` +
                        `${escapeHtml(GL.TYPE_LABELS[type] || type)} <span class="legend-count">${count}</span></span>`;
                })
                .join('');
        }

        function renderChips() {
            const counts = {};
            for (const edge of state.graph.edges) counts[edge.type] = (counts[edge.type] || 0) + 1;
            els.chips.innerHTML = GL.EDGE_TYPES
                .filter((type) => counts[type])
                .map((type) => `<button type="button" class="chip edge-${escapeHtml(type)}" data-edge-type="${escapeHtml(type)}" ` +
                    `aria-pressed="true">${escapeHtml(GL.RELATION_LABELS[type] ? GL.RELATION_LABELS[type][0] : type)} ` +
                    `<span class="chip-count">${counts[type]}</span></button>`)
                .join('');
        }

        function renderFocusOptions() {
            const options = GL.programmeOptions(state.graph.nodes);
            els.focus.innerHTML = '<option value="">All programmes</option>' + options
                .map((option) => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.label)}` +
                    `${option.status && option.status !== 'live' ? ` (${escapeHtml(option.status)})` : ''}</option>`)
                .join('');
        }

        function renderGraph() {
            els.edgeLayer.textContent = '';
            els.nodeLayer.textContent = '';
            state.edgeEls = [];
            state.nodeEls = new Map();

            for (const edge of state.graph.edges) {
                const a = state.positions[edge.from];
                const b = state.positions[edge.to];
                if (!a || !b) continue;
                const family = GL.edgeFamily(edge.type);
                const line = svgEl('line', {
                    x1: a.x.toFixed(2),
                    y1: a.y.toFixed(2),
                    x2: b.x.toFixed(2),
                    y2: b.y.toFixed(2),
                    class: `edge edge-${edge.type}`,
                    'stroke-width': GL.edgeWidthPx(edge.weight, state.ranges[family], { minPx: 1, maxPx: 7 }).toFixed(2),
                    'vector-effect': 'non-scaling-stroke'
                });
                els.edgeLayer.appendChild(line);
                state.edgeEls.push({ edge, line });
            }

            for (const node of state.graph.nodes) {
                const position = state.positions[node.id];
                if (!position) continue;
                const radius = GL.nodeRadiusPx(state.degrees[node.id], node.type);
                const group = svgEl('g', {
                    class: `node type-${node.type}${node.type === 'programme' ? ' node-programme' : ''}`,
                    transform: `translate(${position.x.toFixed(2)} ${position.y.toFixed(2)})`,
                    'data-id': node.id,
                    tabindex: '0',
                    role: 'button',
                    'aria-label': `${node.label} — ${GL.TYPE_LABELS[node.type] || node.type}`
                });
                // An audience is a class of people, not a company, so it gets a square glyph —
                // a hue alone did not separate it from the regulator grey.
                group.appendChild(node.type === 'audience'
                    ? svgEl('rect', {
                        x: (-radius * 0.86).toFixed(2),
                        y: (-radius * 0.86).toFixed(2),
                        width: (radius * 1.72).toFixed(2),
                        height: (radius * 1.72).toFixed(2),
                        rx: '2',
                        class: 'node-dot'
                    })
                    : svgEl('circle', { r: radius.toFixed(2), class: 'node-dot' }));
                // The label sits on the far side of the dot from the graph centre, so the labels
                // of a cluster of nodes fan outwards instead of stacking on one another.
                const below = position.y > LAYOUT.height / 2;
                const label = svgEl('text', {
                    class: 'node-label',
                    x: '0',
                    y: (below ? radius + 13 : -radius - 6).toFixed(2),
                    'text-anchor': 'middle'
                });
                label.textContent = node.label;
                group.appendChild(label);
                els.nodeLayer.appendChild(group);
                state.nodeEls.set(node.id, { group, label });
            }
        }

        // --- visual state -----------------------------------------------------

        function applyVisualState() {
            const focusReach = state.focusId
                ? GL.nodesWithinHops(state.focusId, state.adjacency, 2)
                : null;
            const matches = state.query ? new Set(GL.searchMatches(state.graph.nodes, state.query)) : null;
            const selectedNeighbours = state.selectedId
                ? GL.nodesWithinHops(state.selectedId, state.adjacency, 1)
                : null;

            for (const [id, refs] of state.nodeEls) {
                const group = refs.group;
                group.classList.toggle('is-dimmed', Boolean(focusReach && !focusReach.has(id)));
                group.classList.toggle('is-match', Boolean(matches && matches.has(id)));
                group.classList.toggle('is-faded', Boolean(matches && !matches.has(id)));
                group.classList.toggle('is-selected', id === state.selectedId);
                group.classList.toggle('is-neighbour', Boolean(selectedNeighbours && id !== state.selectedId && selectedNeighbours.has(id)));
            }

            for (const { edge, line } of state.edgeEls) {
                const off = !state.enabled.has(edge.type);
                const dimmed = Boolean(focusReach && (!focusReach.has(edge.from) || !focusReach.has(edge.to)));
                const incident = Boolean(state.selectedId && (edge.from === state.selectedId || edge.to === state.selectedId));
                line.classList.toggle('is-off', off);
                line.classList.toggle('is-dimmed', dimmed);
                line.classList.toggle('is-incident', incident);
            }

            els.root.classList.toggle('show-all-labels', Boolean(els.toggleLabels.checked));
        }

        function setView(view) {
            state.view = {
                scale: clamp(view.scale, ZOOM_MIN, ZOOM_MAX),
                x: view.x,
                y: view.y
            };
            els.root.setAttribute('transform',
                `translate(${state.view.x.toFixed(2)} ${state.view.y.toFixed(2)}) scale(${state.view.scale.toFixed(4)})`);
        }

        function stageSize() {
            const rect = els.svg.getBoundingClientRect();
            return {
                width: rect.width || els.stage.clientWidth || LAYOUT.width,
                height: rect.height || els.stage.clientHeight || LAYOUT.height
            };
        }

        function viewport() {
            const size = stageSize();
            return {
                width: size.width,
                height: size.height,
                padding: size.width < 520 ? 16 : 34,
                minScale: ZOOM_MIN,
                maxScale: ZOOM_MAX
            };
        }

        /** The Fit button: every node on screen, however small that makes it. */
        function fitToView() {
            setView(GL.fitTransform(state.positions, viewport()));
        }

        /** The first view, Reset and a resize: whole graph when readable, else the programmes. */
        function initialViewToStage() {
            setView(GL.initialView(state.positions, state.graph.nodes, viewport()));
        }

        function zoomAt(px, py, factor) {
            const next = clamp(state.view.scale * factor, ZOOM_MIN, ZOOM_MAX);
            const ratio = next / state.view.scale;
            setView({
                scale: next,
                x: px - (px - state.view.x) * ratio,
                y: py - (py - state.view.y) * ratio
            });
        }

        function stagePoint(event) {
            const rect = els.svg.getBoundingClientRect();
            return { x: event.clientX - rect.left, y: event.clientY - rect.top };
        }

        // --- the side panel ---------------------------------------------------

        function selectNode(id) {
            const node = state.nodesById.get(id);
            if (!node) return;
            state.selectedId = id;
            els.panel.hidden = false;
            els.panelTitle.textContent = node.label || node.id;
            els.panelType.textContent = GL.TYPE_LABELS[node.type] || node.type;
            els.panelBody.innerHTML = panelHtml(node);
            applyVisualState();
        }

        function closePanel() {
            state.selectedId = null;
            els.panel.hidden = true;
            applyVisualState();
        }

        function panelHtml(node) {
            const meta = node.meta || {};
            const facts = [];
            if (meta.status) facts.push(['Status', meta.status]);
            if (meta.legalForm) facts.push(['Legal form', meta.legalForm]);
            if (meta.jurisdiction) facts.push(['Jurisdiction', meta.jurisdiction]);
            if (meta.identifier) facts.push(['Identifier', meta.identifier]);
            if (isNum(meta.mints)) facts.push(['Mints', fmtNumber(meta.mints)]);
            if (isNum(meta.liquidityUsd)) facts.push(['Pool liquidity', fmtMoney(meta.liquidityUsd)]);
            if (isNum(meta.volume24Usd)) facts.push(['Volume 24h', fmtMoney(meta.volume24Usd)]);
            if (isNum(meta.pairs)) facts.push(['Pairs / tickers', fmtNumber(meta.pairs)]);
            if (Array.isArray(meta.roles) && meta.roles.length) facts.push(['Named as', meta.roles.join(', ')]);

            const grades = meta.grades || null;
            if (grades) {
                if (grades.maturityStage) facts.push(['Ledger maturity', grades.maturityStage]);
                if (isNum(grades.claimRung)) {
                    facts.push(['Claim depth', `rung ${grades.claimRung}${grades.claimLabel ? ` · ${grades.claimLabel}` : ''}`]);
                }
                if (isNum(grades.verificationStrength)) {
                    facts.push(['Verification', `${grades.verificationStrength}${grades.verificationLabel ? ` · ${grades.verificationLabel}` : ''}`]);
                }
            }

            const parts = [];
            if (facts.length) {
                parts.push('<dl class="panel-facts">' + facts
                    .map(([key, value]) => `<div class="panel-fact"><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`)
                    .join('') + '</dl>');
            }
            if (meta.note) parts.push(`<p class="panel-note">${escapeHtml(meta.note)}</p>`);
            if (isSafeUrl(meta.website)) {
                parts.push(`<p class="panel-link"><a href="${escapeHtml(meta.website)}" target="_blank" ` +
                    `rel="noopener noreferrer">${escapeHtml(meta.website)}</a></p>`);
            }
            if (meta.slug) {
                parts.push(`<p class="panel-link"><a href="./issuers/${escapeHtml(meta.slug)}.html">` +
                    'Open this issuer’s dossier</a></p>');
            }

            const groups = GL.groupConnections(node.id, state.graph);
            if (!groups.length) {
                parts.push('<p class="panel-empty">No relation in the graph names this node.</p>');
                return parts.join('');
            }

            const hiddenTypes = groups.filter((group) => !state.enabled.has(group.type)).length;
            parts.push(`<h3 class="panel-subhead">Connections <span class="panel-count">${groups
                .reduce((acc, group) => acc + group.connections.length, 0)}</span></h3>`);
            if (hiddenTypes) {
                parts.push('<p class="panel-hint">Some relations below are switched off in the chips above and are ' +
                    'not drawn on the graph.</p>');
            }

            for (const group of groups) {
                parts.push(`<section class="panel-group${state.enabled.has(group.type) ? '' : ' panel-group-off'}">` +
                    `<h4><span class="group-swatch edge-${escapeHtml(group.type)}"></span>` +
                    `${escapeHtml(group.label)} <span class="panel-count">${group.connections.length}</span></h4>` +
                    '<ul class="panel-list">' +
                    group.connections.map((connection) => connectionHtml(connection, group, node.id)).join('') +
                    '</ul></section>');
            }
            return parts.join('');
        }

        function connectionHtml(connection, group, ownId) {
            // `via` is the programme the relation was read from. Printing it when it is one of the
            // two ends of the edge repeats a name already on the row, so only a third programme
            // is worth showing.
            const viaLabels = connection.via
                .filter((slug) => slug !== ownId && slug !== connection.id)
                .map((slug) => {
                    const programme = state.nodesById.get(slug);
                    return programme ? programme.label : slug;
                })
                .filter(Boolean);
            const type = connection.type ? GL.TYPE_LABELS[connection.type] || connection.type : '';
            return '<li>' +
                `<button type="button" class="panel-jump" data-id="${escapeHtml(connection.id)}">` +
                `${escapeHtml(connection.label)}</button>` +
                (type ? ` <span class="panel-chip type-${escapeHtml(connection.type)}">${escapeHtml(type)}</span>` : '') +
                `<span class="panel-weight">${escapeHtml(fmtWeight(connection.weight, group.family))}</span>` +
                (viaLabels.length ? `<span class="panel-via">via ${escapeHtml(viaLabels.join(', '))}</span>` : '') +
                (connection.note ? `<span class="panel-connection-note">${escapeHtml(connection.note)}</span>` : '') +
                '</li>';
        }

        // --- events -----------------------------------------------------------

        function wireEvents() {
            els.chips.addEventListener('click', (event) => {
                const chip = event.target.closest('[data-edge-type]');
                if (!chip) return;
                const type = chip.getAttribute('data-edge-type');
                if (state.enabled.has(type)) state.enabled.delete(type);
                else state.enabled.add(type);
                chip.setAttribute('aria-pressed', String(state.enabled.has(type)));
                applyVisualState();
                if (state.selectedId) selectNode(state.selectedId);
            });

            els.chipsAll.addEventListener('click', () => setAllChips(true));
            els.chipsNone.addEventListener('click', () => setAllChips(false));

            els.focus.addEventListener('change', () => {
                state.focusId = els.focus.value;
                applyVisualState();
            });

            els.search.addEventListener('input', () => {
                state.query = els.search.value;
                applyVisualState();
            });

            els.toggleLabels.addEventListener('change', applyVisualState);
            els.fitView.addEventListener('click', fitToView);
            els.resetView.addEventListener('click', () => {
                state.focusId = '';
                state.query = '';
                els.focus.value = '';
                els.search.value = '';
                setAllChips(true);
                // Reset means the page as it opened, and "Show all labels" opens unticked.
                els.toggleLabels.checked = false;
                closePanel();
                initialViewToStage();
            });

            els.panelClose.addEventListener('click', closePanel);
            els.panelBody.addEventListener('click', (event) => {
                const jump = event.target.closest('[data-id]');
                if (jump) selectNode(jump.getAttribute('data-id'));
            });

            // A node is selected from the pointerdown/pointerup pair, not from `click`: the pan
            // gesture captures the pointer on the <svg>, and pointer capture retargets the
            // compatibility click event to the capturing element, so a click listener on the
            // nodes never fires. Requiring the pointer to stay put also means a drag that starts
            // on a node pans instead of selecting it.
            els.nodeLayer.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                const group = event.target.closest('[data-id]');
                if (!group) return;
                event.preventDefault();
                selectNode(group.getAttribute('data-id'));
            });

            document.addEventListener('keydown', (event) => {
                if (event.key === 'Escape' && !els.panel.hidden) closePanel();
            });

            els.svg.addEventListener('wheel', (event) => {
                event.preventDefault();
                const point = stagePoint(event);
                zoomAt(point.x, point.y, Math.exp(-event.deltaY * 0.0015));
            }, { passive: false });

            els.svg.addEventListener('pointerdown', (event) => {
                pointers.set(event.pointerId, stagePoint(event));
                const group = event.target.closest && event.target.closest('[data-id]');
                tapStart = pointers.size === 1 && group
                    ? { id: group.getAttribute('data-id'), pointer: stagePoint(event) }
                    : null;
                if (pointers.size === 1) {
                    panStart = { pointer: stagePoint(event), view: { ...state.view } };
                } else if (pointers.size === 2) {
                    panStart = null;
                    pinchStart = { distance: pointerDistance(), center: pointerCenter(), view: { ...state.view } };
                }
                // Capture keeps a drag alive when the pointer leaves the SVG, but it throws for a
                // pointer the browser no longer considers active (a very fast tap, a synthetic
                // event). That must not abort the gesture, so it is the last thing done here.
                try {
                    els.svg.setPointerCapture(event.pointerId);
                } catch (err) {
                    /* the gesture still works, it just stops updating outside the element */
                }
            });

            els.svg.addEventListener('pointermove', (event) => {
                if (!pointers.has(event.pointerId)) return;
                pointers.set(event.pointerId, stagePoint(event));
                if (pointers.size >= 2 && pinchStart) {
                    const distance = pointerDistance();
                    if (!distance || !pinchStart.distance) return;
                    const scale = clamp(pinchStart.view.scale * (distance / pinchStart.distance), ZOOM_MIN, ZOOM_MAX);
                    const ratio = scale / pinchStart.view.scale;
                    const center = pinchStart.center;
                    setView({
                        scale,
                        x: center.x - (center.x - pinchStart.view.x) * ratio,
                        y: center.y - (center.y - pinchStart.view.y) * ratio
                    });
                    els.stage.classList.add('is-grabbing');
                    return;
                }
                if (!panStart) return;
                const point = stagePoint(event);
                const dx = point.x - panStart.pointer.x;
                const dy = point.y - panStart.pointer.y;
                if (Math.abs(dx) + Math.abs(dy) > 2) els.stage.classList.add('is-grabbing');
                setView({ scale: panStart.view.scale, x: panStart.view.x + dx, y: panStart.view.y + dy });
            });

            function endPointer(event) {
                if (tapStart && pointers.size === 1) {
                    const end = stagePoint(event);
                    const moved = Math.abs(end.x - tapStart.pointer.x) + Math.abs(end.y - tapStart.pointer.y);
                    if (moved <= TAP_SLOP_PX) selectNode(tapStart.id);
                }
                tapStart = null;
                pointers.delete(event.pointerId);
                if (pointers.size < 2) pinchStart = null;
                if (pointers.size === 0) {
                    panStart = null;
                    els.stage.classList.remove('is-grabbing');
                } else if (pointers.size === 1) {
                    const only = [...pointers.values()][0];
                    panStart = { pointer: only, view: { ...state.view } };
                }
            }
            els.svg.addEventListener('pointerup', endPointer);
            els.svg.addEventListener('pointercancel', endPointer);

            window.addEventListener('resize', initialViewToStage);
        }

        function setAllChips(on) {
            state.enabled = on ? new Set(GL.EDGE_TYPES) : new Set();
            for (const chip of els.chips.querySelectorAll('[data-edge-type]')) {
                chip.setAttribute('aria-pressed', String(on));
            }
            applyVisualState();
            if (state.selectedId) selectNode(state.selectedId);
        }

        function pointerDistance() {
            const list = [...pointers.values()];
            if (list.length < 2) return 0;
            return Math.sqrt((list[0].x - list[1].x) ** 2 + (list[0].y - list[1].y) ** 2);
        }

        function pointerCenter() {
            const list = [...pointers.values()];
            if (!list.length) return { x: 0, y: 0 };
            if (list.length === 1) return list[0];
            return { x: (list[0].x + list[1].x) / 2, y: (list[0].y + list[1].y) / 2 };
        }
    });
}());
