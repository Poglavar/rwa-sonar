/* The observatory UI: render the retained monitoring inventory and animate a labelled schedule simulation. */
(function () {
    'use strict';
    const M = window.__rwaMonitoringMap;
    const F = window.__rwaResearchFleet;
    const $ = (id) => document.getElementById(id);
    const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const format = (number) => number.toLocaleString('en');
    const category = (id) => M.CATEGORIES.find((row) => row.id === id) || M.CATEGORIES[0];
    const params = new URLSearchParams(location.search);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let data, view, groups = [], layout, flights = [], selectedSource = null, directorySource = null;
    let filters = { issuer: params.get('issuer') || 'all', category: params.get('category') || 'all' };
    let directoryMode = 'sources', directoryLimit = 24, paused = reducedMotion.matches || params.has('reduceMotion');
    let secondsPerHour = 4, elapsed = 0, lastFrame = null, frameId = null, inView = true;
    const canvas = $('shipsCanvas'), ctx = canvas.getContext('2d');
    const shipSprite = new Image();
    shipSprite.addEventListener('load', () => drawShips(elapsed));
    shipSprite.src = F.ASSETS.ship;
    const defaultInspector = $('missionInspector').innerHTML;

    function updateUrl() {
        const url = new URL(location.href);
        for (const key of ['issuer', 'category']) {
            if (filters[key] === 'all') url.searchParams.delete(key); else url.searchParams.set(key, filters[key]);
        }
        history.replaceState(null, '', url);
    }
    function updateMotion() {
        $('motionToggle').setAttribute('aria-pressed', String(paused));
        $('motionToggle').setAttribute('aria-label', paused ? 'Play animation' : 'Pause animation');
        $('motionIcon').textContent = paused ? '▶' : 'Ⅱ';
        if (frameId !== null) cancelAnimationFrame(frameId);
        frameId = null; lastFrame = null;
        if (data && !paused && inView && document.visibilityState !== 'hidden') frameId = requestAnimationFrame(animate);
        else if (ctx && layout) drawShips(elapsed);
    }
    function renderOptions() {
        const options = (kind) => data.issuers.filter((i) => i.kind === kind).map((i) => `<option value="${escape(i.id)}">${escape(i.label)}</option>`).join('');
        $('issuerSelect').innerHTML = '<option value="all">All issuers & products</option>'
            + `<optgroup label="Across real-world assets">${options('product')}</optgroup><optgroup label="Stock programmes">${options('programme')}</optgroup>`;
        if (!data.issuers.some((i) => i.id === filters.issuer)) filters.issuer = 'all';
        if (!M.CATEGORIES.some((c) => c.id === filters.category)) filters.category = 'all';
        $('issuerSelect').value = filters.issuer; $('issuerSelect').disabled = false;
        $('sourceSearch').disabled = false; $('stateSelect').disabled = false;
        document.querySelectorAll('[data-view]').forEach((button) => { button.disabled = false; });
        $('categoryFilters').innerHTML = '<button type="button" data-category="all">All missions</button>' + M.CATEGORIES.map((c) =>
            `<button type="button" data-category="${c.id}" style="--category-color:${c.color}"><span class="category-dot" aria-hidden="true"></span>${c.label}</button>`).join('');
    }
    function refresh() {
        view = M.selectInventory(data, filters);
        groups = M.groupRoutes(view);
        $('mapEmpty').hidden = groups.length > 0;
        for (const [id, key] of [['countIssuers', 'issuers'], ['countSources', 'sources'], ['countJobs', 'jobs'], ['countRoutes', 'routes']]) {
            $(id).textContent = format(key === 'issuers' ? view.issuers.length : view.counts[key]);
        }
        for (const button of $('categoryFilters').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.category === filters.category));
        const subject = data.issuers.find((i) => i.id === filters.issuer);
        $('mapScope').textContent = subject ? `${subject.shortLabel || subject.label} · ${view.counts.prepared ? 'INCLUDES PREPARED ROUTES' : 'MONITORING SCOPE'}` : 'ALL ASSETS · ALL CHAINS IN OUR COVERAGE';
        if (selectedSource && !groups.some((s) => s.id === selectedSource)) selectedSource = null;
        if (directorySource && !groups.some((s) => s.id === directorySource)) directorySource = null;
        directoryLimit = 24;
        renderMap(); renderInspector(); renderDirectory(); renderGaps(); updateUrl(); updateMotion();
    }
    function showTooltip(node, x, y, isIssuer = false) {
        const tooltip = $('sourceTooltip');
        tooltip.innerHTML = isIssuer ? `${escape(node.label)}<small>Select this issuer / product</small>`
            : `${escape(node.label)}<small>${format(node.routes.length)} routes · ${node.issuerIds.length} issuer/product scopes</small>`;
        tooltip.hidden = false;
        const bounds = $('mapStage').getBoundingClientRect();
        tooltip.style.left = `${Math.max(8, Math.min(bounds.width - tooltip.offsetWidth - 8, x + 13))}px`;
        tooltip.style.top = `${Math.max(8, Math.min(bounds.height - tooltip.offsetHeight - 8, y - 22))}px`;
    }
    function renderMap() {
        const width = $('mapStage').clientWidth, height = $('mapStage').clientHeight;
        if (!width || !height) return;
        const focus = document.activeElement?.closest('[data-source], [data-issuer]')?.dataset;
        const focusId = focus?.source || focus?.issuer, focusKind = focus?.source ? 'source' : 'issuer';
        layout = F.buildFleet(groups, width, height);
        const { center, nodes } = layout;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = width * dpr; canvas.height = height * dpr;
        if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const svg = $('networkSvg'); svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        const grad = M.CATEGORIES.map((c) => `<radialGradient id="planet-${c.id}" cx="28%" cy="25%" r="78%"><stop offset="0" stop-color="#f2f0e3"/><stop offset=".2" stop-color="${c.color}"/><stop offset=".8" stop-color="${c.color}" stop-opacity=".25"/><stop offset="1" stop-color="#14202f"/></radialGradient>`).join('');
        const paths = nodes.map((node) => {
            const color = category(node.category).color;
            const { start, bend } = node;
            const mid = M.curvePoint(start, node, bend, 0.5);
            const control = { x: 2 * mid.x - (start.x + node.x) / 2, y: 2 * mid.y - (start.y + node.y) / 2 };
            const cls = `route-line${selectedSource === node.id ? ' is-highlighted' : ''}${node.configured ? '' : ' is-prepared'}`;
            return `<path class="${cls}" stroke="${color}" d="M${start.x},${start.y} Q${control.x},${control.y} ${node.x},${node.y}"/>`;
        }).join('');
        const labels = new Map(M.labelSources(nodes, width, height, selectedSource).map((label) => [label.id, label]));
        const sourceNodes = nodes.map((node) => {
            const selected = selectedSource === node.id;
            return `<g class="source-node${selected ? ' is-selected' : ''}" data-source="${escape(node.id)}" transform="translate(${node.x} ${node.y})" role="button" tabindex="0" aria-label="${escape(node.label)}, ${node.routes.length} routes, ${node.issuerIds.length} issuer or product scopes" aria-pressed="${selected}">`
                + `<circle class="node-hit" r="${Math.max(node.radius + 8, 13)}"/><circle class="node-halo" r="${node.radius + 5}" stroke="${category(node.category).color}"/>`
                + `<circle r="${node.radius}" fill="url(#planet-${node.category})" stroke="${category(node.category).color}" stroke-opacity=".3" stroke-width=".7"/></g>`;
        }).join('');
        const sourceLabels = nodes.filter((node) => labels.has(node.id)).map((node) => {
            const label = labels.get(node.id);
            return `<g class="source-node source-label${selectedSource === node.id ? ' is-selected' : ''}" aria-hidden="true"><text x="${label.x}" y="${label.y}">${escape(label.text)}</text><text class="node-sublabel" x="${label.x}" y="${label.y + 12}">${node.routes.length} ${node.routes.length === 1 ? 'ROUTE' : 'ROUTES'}</text></g>`;
        }).join('');
        const orbitRadius = width < 600 ? 70 : 91;
        const issuerNodes = view.issuers.map((issuer, index) => {
            const angle = index / Math.max(1, view.issuers.length) * Math.PI * 2 - Math.PI / 2;
            const x = center.x + Math.cos(angle) * orbitRadius, y = center.y + Math.sin(angle) * orbitRadius * 0.77;
            return `<g class="issuer-node${filters.issuer === issuer.id ? ' is-selected' : ''}" data-issuer="${escape(issuer.id)}" transform="translate(${x} ${y})" role="button" tabindex="0" aria-label="Follow ${escape(issuer.label)}"><circle class="node-hit" r="9" style="fill:transparent;stroke:none"/><circle r="${filters.issuer === issuer.id ? 4.5 : 2.7}"/></g>`;
        }).join('');
        const station = F.stationSvg(layout);
        svg.innerHTML = `<defs>${grad}<radialGradient id="station-glow"><stop stop-color="#76c5d6" stop-opacity=".2"/><stop offset="1" stop-color="#76c5d6" stop-opacity="0"/></radialGradient></defs>`
            + `<ellipse class="orbit-ring" cx="${center.x}" cy="${center.y}" rx="${Math.max(90, width / 2 - 75)}" ry="${height / 2 - 63}"/>`
            + `<ellipse class="orbit-ring" cx="${center.x}" cy="${center.y}" rx="${orbitRadius}" ry="${orbitRadius * .77}"/>${paths}${sourceNodes}${issuerNodes}${station}${sourceLabels}`;
        if (focusId) svg.querySelector(`[data-${focusKind}="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true });
        flights = layout.flights;
        drawShips(elapsed);
    }
    function drawShips(time) {
        if (!ctx || !layout) return;
        ctx.clearRect(0, 0, $('mapStage').clientWidth, $('mapStage').clientHeight);
        if (!shipSprite.complete || !shipSprite.naturalWidth) return;
        for (const flight of flights) {
            if (selectedSource && flight.node.id !== selectedSource) continue;
            const pose = F.shipPose(flight, time, secondsPerHour);
            if (!pose) continue;
            ctx.save(); ctx.translate(pose.x, pose.y); ctx.rotate(pose.angle);
            ctx.globalAlpha = selectedSource ? .8 : .42; ctx.strokeStyle = flight.color; ctx.lineWidth = .85;
            ctx.beginPath(); ctx.moveTo(-9, 0); ctx.lineTo(-20, 0); ctx.stroke();
            ctx.globalAlpha = selectedSource ? 1 : .88;
            const shipWidth = selectedSource ? 25 : 22, shipHeight = shipWidth * shipSprite.naturalHeight / shipSprite.naturalWidth;
            ctx.drawImage(shipSprite, -shipWidth / 2, -shipHeight / 2, shipWidth, shipHeight);
            ctx.restore();
        }
    }
    function animate(timestamp) {
        if (lastFrame !== null) elapsed += Math.min((timestamp - lastFrame) / 1000, .1);
        lastFrame = timestamp;
        drawShips(elapsed);
        frameId = requestAnimationFrame(animate);
    }
    function renderInspector() {
        const node = groups.find((s) => s.id === selectedSource);
        if (!node) { $('missionInspector').innerHTML = defaultInspector; return; }
        const jobs = node.jobIds.map((id) => data.jobs.find((j) => j.id === id));
        const names = node.issuerIds.map((id) => data.issuers.find((i) => i.id === id)?.shortLabel || data.issuers.find((i) => i.id === id)?.label);
        $('missionInspector').innerHTML = '<button type="button" class="inspector-close" data-action="close-source" aria-label="Close source brief">×</button>'
            + `<p class="mission-eyebrow">Source brief / ${escape(category(node.category).label)}</p><h3 id="inspectorTitle">${escape(node.label)}</h3>`
            + `<p class="inspector-lead">${escape(names.length ? names.slice(0, 4).join(', ') + (names.length > 4 ? ` and ${names.length - 4} more.` : '.') : 'Shared research infrastructure.')} ${node.configured ? '' : 'These routes are prepared or conditional.'}</p>`
            + `<div class="inspector-stats"><div><strong>${format(node.routes.length)}</strong><span>scoped routes</span></div><div><strong>${node.endpoints.length}</strong><span>URLs / endpoints</span></div><div><strong>${node.issuerIds.length}</strong><span>issuer/product scopes</span></div><div><strong>${jobs.length}</strong><span>bot missions</span></div></div>`
            + '<ul class="inspector-jobs">' + jobs.slice(0, 6).map((job) => {
                const routes = node.routes.filter((r) => r.jobId === job.id);
                const state = routes.every((r) => r.state === 'prepared') ? 'Prepared' : routes.every((r) => r.state === 'conditional') ? 'Conditional' : 'Configured';
                const cadences = [...new Set(routes.map((route) => route.cadenceHours))].sort((a, b) => a - b);
                const schedule = job.id === 'rwa-sonar-api' ? 'On request' : cadences.map(M.cadenceLabel).join(' / ');
                return `<li><strong>${escape(job.label)}</strong><small>${escape(schedule)} · ${state} · ${routes.length} ${routes.length === 1 ? 'route' : 'routes'}</small></li>`;
            }).join('') + '</ul>'
            + `<div class="inspector-note"><p>Routes retain separate queries and collection steps. A shared read can support more than one issuer. Counts are scopes, not HTTP request totals.</p></div>`
            + `<button class="inspector-cta" type="button" data-action="source-routes">Inspect all ${format(node.routes.length)} routes ↓</button>`;
    }
    function routeHtml(route) {
        const job = data.jobs.find((j) => j.id === route.jobId);
        const names = route.issuerIds.map((id) => data.issuers.find((i) => i.id === id)?.label).filter(Boolean);
        const url = M.safeUrl(route.url);
        const label = route.cadenceHours ? M.cadenceLabel(route.cadenceHours) : job.id === 'rwa-sonar-api' ? 'On request' : 'On demand';
        const observed = route.observedAt || job.observedAt;
        return `<div class="route-detail"><div><strong>${escape(route.label)}</strong>${url ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(url.length > 100 ? url.slice(0, 97) + '…' : url)} ↗</a>` : ''}
            <small class="route-note">${escape(route.note || job.description)}</small></div><div><strong>${escape(job.label)}</strong><small>${escape(M.scopeLabel(route))}</small><small>${escape(names.length ? names.join(' · ') : 'No issuer-specific attribution in this snapshot')}</small>
            ${route.units !== null ? `<small>${format(route.units)} ${escape(route.unit || 'items')} in retained input</small>` : ''}</div>
            <div class="route-schedule"><span class="route-state ${route.state}">${escape(route.state)}</span><strong>${escape(label)}</strong>
            ${job.cron ? `<small>${route.cadenceHours !== job.cadenceHours ? 'Parent job: ' : ''}${escape(job.cron)} · UTC</small>` : job.parentId ? '<small>Within the report refresh</small>' : ''}
            <small>${observed && Number.isFinite(Date.parse(observed)) ? `${route.observedAt ? 'Source checked' : 'Job recorded'} ${new Date(observed).toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })} UTC${route.outcome || job.outcome ? ' · ' + escape(route.outcome || job.outcome) : ''}` : 'No run record in this snapshot'}</small></div></div>`;
    }
    function populateRoutes(details) {
        const kind = details.dataset.kind, id = details.dataset.id;
        const list = details.querySelector('.route-list');
        const selected = directoryRoutes().filter((r) => kind === 'source' ? r.sourceId === id : r.jobId === id);
        const limit = Number(details.dataset.limit) || 30;
        list.innerHTML = selected.slice(0, limit).map(routeHtml).join('');
        if (selected.length > limit) list.insertAdjacentHTML('beforeend', `<button type="button" class="route-more" data-action="more-routes">Show next ${Math.min(50, selected.length - limit)} of ${format(selected.length - limit)} remaining routes</button>`);
    }
    function directoryRoutes() {
        const scoped = M.selectInventory(data, { ...filters, query: $('sourceSearch').value, state: $('stateSelect').value });
        return directorySource ? scoped.routes.filter((r) => r.sourceId === directorySource) : scoped.routes;
    }
    function renderDirectory() {
        const routes = directoryRoutes();
        const filteredView = { ...view, routes, sources: view.sources.filter((s) => routes.some((r) => r.sourceId === s.id)) };
        const sourceGroups = M.groupRoutes(filteredView);
        const jobs = view.jobs.filter((j) => routes.some((r) => r.jobId === j.id));
        const rows = directoryMode === 'sources' ? sourceGroups : jobs.map((job) => ({ ...job, routes: routes.filter((r) => r.jobId === job.id) }));
        $('sourceTabCount').textContent = format(sourceGroups.length); $('jobTabCount').textContent = format(jobs.length);
        for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', String(button.dataset.view === directoryMode));
        const subject = data.issuers.find((i) => i.id === filters.issuer)?.label || 'All issuers & products';
        const sourceName = data.sources.find((s) => s.id === directorySource)?.label;
        $('directoryScope').innerHTML = `<span>${escape(subject)}${sourceName ? ' / ' + escape(sourceName) : ''} · ${format(routes.length)} scoped routes</span>`
            + (directorySource ? '<button type="button" class="clear-filter" data-action="clear-directory-source">Clear source ×</button>' : '');
        $('directoryResults').innerHTML = rows.slice(0, directoryLimit).map((row) => {
            const kind = directoryMode === 'sources' ? 'source' : 'job';
            const ids = [...new Set(row.routes.flatMap((r) => r.issuerIds))];
            const configured = row.routes.filter((r) => r.state === 'configured').length;
            const state = configured ? `${configured} configured` : row.routes.every((r) => r.state === 'prepared') ? 'Prepared' : 'Conditional / prepared';
            const sourceCaption = row.id.startsWith('sonar:') ? 'RWA Sonar · internal service' : row.id.startsWith('chain:') ? 'Blockchain RPC' : row.host;
            return `<details class="source-row" data-kind="${kind}" data-id="${escape(row.id)}"><summary>
                <span class="source-name"><i class="source-orb" style="--category-color:${category(row.category).color}" aria-hidden="true"></i><span><strong>${escape(row.label)}</strong><small>${escape(kind === 'source' ? sourceCaption : row.parentId ? 'Collection step · report refresh' : row.description)}</small></span></span>
                <span class="source-metric">${format(row.routes.length)}<small>scoped routes</small></span><span class="source-metric">${ids.length}<small>issuer/product scopes</small></span><span class="source-metric">${state}<small>${kind === 'source' ? `${row.jobIds.length} bot missions` : M.cadenceLabel(row.cadenceHours)}</small></span><span class="expand-indicator" aria-hidden="true">+</span>
                </summary><div class="route-list"></div></details>`;
        }).join('') || '<div class="empty-state">No routes match these filters. Try a different source, issuer or schedule state.</div>';
        for (const details of $('directoryResults').querySelectorAll('details')) details.addEventListener('toggle', () => {
            if (details.open && !details.querySelector('.route-list').children.length) populateRoutes(details);
        });
        $('showMore').hidden = directoryLimit >= rows.length;
        $('showMore').innerHTML = `Show ${Math.min(24, rows.length - directoryLimit)} more ${directoryMode === 'sources' ? 'sources' : 'missions'} <span aria-hidden="true">↓</span>`;
    }
    function renderGaps() {
        const gaps = data.gaps.filter((gap) => filters.issuer === 'all' || gap.issuerIds.includes(filters.issuer));
        $('gapCount').textContent = `(${gaps.length})`;
        $('coverageGaps').innerHTML = '<p class="inspector-lead">Prepared jobs have not been activated by this page. Unsupported networks, unresolved identities and retired sources remain visible below.</p>'
            + gaps.map((gap) => `<div class="gap-item"><strong>${escape(gap.label)}</strong><p>${escape(gap.reason)}</p></div>`).join('');
    }
    async function load() {
        $('loadError').hidden = true; $('mapLoading').hidden = false;
        try {
            const response = await fetch('./monitoring-map.json', { cache: 'no-store' });
            if (!response.ok) throw new Error(`Inventory HTTP ${response.status}`);
            const result = await response.json();
            if (result.schemaVersion !== 1 || !['issuers', 'sources', 'jobs', 'routes', 'gaps'].every((key) => Array.isArray(result[key]))) throw new Error('Unsupported monitoring inventory');
            data = result;
            renderOptions(); refresh();
            $('inventoryDate').textContent = `Inventory built ${new Date(data.generatedAt).toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })} UTC from collector definitions and research registries. ${data.basis} A scheduled route is not proof of a successful read; source observations retain their own dates.`;
            $('mapLoading').hidden = true;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] Monitoring map unavailable:`, error);
            $('mapLoading').hidden = true; $('loadError').hidden = false;
        }
    }

    $('issuerSelect').addEventListener('change', () => { filters.issuer = $('issuerSelect').value; selectedSource = null; directorySource = null; refresh(); });
    $('categoryFilters').addEventListener('click', (event) => {
        const button = event.target.closest('[data-category]'); if (!button) return;
        filters.category = button.dataset.category; selectedSource = null; directorySource = null; refresh();
    });
    $('motionToggle').addEventListener('click', () => { paused = !paused; updateMotion(); });
    $('speedSelect').addEventListener('change', () => { secondsPerHour = Number($('speedSelect').value); });
    $('retryButton').addEventListener('click', load);
    $('sourceSearch').addEventListener('input', () => { directoryLimit = 24; renderDirectory(); });
    $('stateSelect').addEventListener('change', () => { directoryLimit = 24; renderDirectory(); });
    $('showMore').addEventListener('click', () => { directoryLimit += 24; renderDirectory(); });
    document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => { directoryMode = button.dataset.view; directoryLimit = 24; renderDirectory(); }));
    function selectNode(event) {
        const source = event.target.closest('[data-source]'), issuer = event.target.closest('[data-issuer]');
        $('sourceTooltip').hidden = true;
        if (source) { selectedSource = selectedSource === source.dataset.source ? null : source.dataset.source; renderMap(); renderInspector(); }
        else if (issuer) { filters.issuer = issuer.dataset.issuer; $('issuerSelect').value = filters.issuer; selectedSource = null; directorySource = null; refresh(); }
    }
    $('networkSvg').addEventListener('click', selectNode);
    $('networkSvg').addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectNode(event); } });
    $('networkSvg').addEventListener('pointerover', (event) => {
        const source = event.target.closest('[data-source]'), issuer = event.target.closest('[data-issuer]');
        const node = source ? groups.find((s) => s.id === source.dataset.source) : issuer ? data.issuers.find((i) => i.id === issuer.dataset.issuer) : null;
        if (!node) return;
        const bounds = $('mapStage').getBoundingClientRect(); showTooltip(node, event.clientX - bounds.left, event.clientY - bounds.top, Boolean(issuer));
    });
    $('networkSvg').addEventListener('pointerout', () => { $('sourceTooltip').hidden = true; });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && selectedSource) { selectedSource = null; renderMap(); renderInspector(); } });
    document.addEventListener('click', (event) => {
        const button = event.target.closest('[data-action]'); if (!button) return;
        if (button.dataset.action === 'close-source') { selectedSource = null; renderMap(); renderInspector(); }
        if (button.dataset.action === 'source-routes') {
            directorySource = selectedSource; directoryMode = 'sources'; directoryLimit = 24; $('sourceSearch').value = ''; $('stateSelect').value = 'all'; renderDirectory();
            const first = $('directoryResults').querySelector('details'); if (first) first.open = true;
            $('sourceDirectory').scrollIntoView({ behavior: paused ? 'instant' : 'smooth', block: 'start' });
        }
        if (button.dataset.action === 'clear-directory-source') { directorySource = null; renderDirectory(); }
        if (button.dataset.action === 'more-routes') { const details = button.closest('details'); details.dataset.limit = (Number(details.dataset.limit) || 30) + 50; populateRoutes(details); }
    });
    new ResizeObserver(() => { if (data) renderMap(); }).observe($('mapStage'));
    new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; updateMotion(); }, { threshold: 0 }).observe($('mapStage'));
    document.addEventListener('visibilitychange', updateMotion);
    reducedMotion.addEventListener('change', () => { paused = reducedMotion.matches; updateMotion(); });
    updateMotion(); load();
})();
