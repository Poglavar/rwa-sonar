// Thin DOM controller for the shared structure map, its branch summary and bounded explanatory motion.
(function (root) {
    'use strict';
    const model = root.__rwaStructureMap, visual = root.__rwaVisualProfile, catalogueModel = root.__rwaCatalogue;
    const esc = visual.escape;
    let shared;
    function load() {
        if (!shared) shared = Promise.all(['rwa-structure-map.json', 'rwa-catalogue.json'].map(async (file) => {
            const response = await fetch(new URL(file, document.currentScript?.src || location.href), { cache: 'no-store' });
            if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
            return response.json();
        }));
        return shared;
    }
    const readSelection = () => { const p = new URLSearchParams(location.search); return { mode: p.get('mapMode') || 'legal', kind: p.get('mapKind') || '', id: p.get('mapId') || '', groupMode: p.get('mapGroupMode') || p.get('mapMode') || 'legal' }; };
    async function mount(el) {
        try {
            const [map, catalogue] = await load();
            const chains = model.chainCount(map);
            document.querySelectorAll('[data-map-totals]').forEach(node => { node.textContent = `${map.counts.deployments.toLocaleString()} indexed deployments · ${map.counts.programmes} issuer programmes · ${chains} chains`; });
            let selection = readSelection(), search = new URLSearchParams(location.search).get('search') || '', all = false, searchExpanded = false;
            const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
            const isStatic = () => reduced.matches || new URLSearchParams(location.search).has('reduceMotion');
            el.innerHTML = `<div class="structure-toolbar"><div class="structure-search-row"><input aria-label="Search assets, issuers or exact addresses" type="search" data-map-search name="search" placeholder="Try gold, AAPL, USDC or a token address"></div><div class="structure-modes" role="group" aria-label="Shared structure view"><button type="button" data-map-mode="legal">Legal structures</button><button type="button" data-map-mode="controls">Contract controls</button></div></div><div class="structure-search-results" data-map-search-results hidden></div><div class="structure-canvas"><svg class="structure-lines" aria-hidden="true"></svg><div class="structure-columns"></div></div><p class="structure-footnote">Shared categories do not establish identical rights or bind every token to reviewed terms.</p><div class="structure-bottom"><button type="button" class="button" data-map-more>Show all programmes</button><button type="button" class="button" data-map-reset>Show all</button></div><div class="structure-summary" data-map-summary></div>`;
            const columns = el.querySelector('.structure-columns'), summary = el.querySelector('[data-map-summary]');
            function url(push) {
                const p = new URLSearchParams(location.search);
                p.delete('search'); if (search.trim()) p.set('search', search.trim());
                for (const key of ['mapMode', 'mapKind', 'mapId', 'mapGroupMode']) p.delete(key);
                if (selection.mode === 'controls') p.set('mapMode', 'controls');
                if (selection.kind) { p.set('mapKind', selection.kind); p.set('mapId', selection.id); if (selection.kind === 'group') p.set('mapGroupMode', selection.groupMode || selection.mode); }
                history[push ? 'pushState' : 'replaceState'](null, '', `${location.pathname}${p.size ? '?' + p : ''}${location.hash}`);
            }
            function lines() {
                const canvas = el.querySelector('.structure-canvas'), svg = el.querySelector('.structure-lines');
                const rows = [...columns.querySelectorAll('[data-map-programme]')].map(node => ({node,cluster:columns.querySelector(`[data-map-cluster="${CSS.escape(node.dataset.mapProgramme)}"]`)}));
                for (const {node,cluster} of rows) { node.style.minHeight = ''; if (cluster) cluster.style.minHeight = ''; }
                const heights = rows.map(({node,cluster}) => Math.max(node.offsetHeight,cluster?.offsetHeight || 0));
                rows.forEach(({node,cluster},i) => { node.style.minHeight = `${heights[i]}px`; if (cluster) cluster.style.minHeight = `${heights[i]}px`; });
                const rect = canvas.getBoundingClientRect();
                svg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
                // Layout offsets stay stable while nodes animate from their previous positions.
                const point = (node, edge) => {
                    let x = node.offsetLeft, y = node.offsetTop;
                    for (let parent = node.offsetParent; parent && parent !== canvas; parent = parent.offsetParent) { x += parent.offsetLeft; y += parent.offsetTop; }
                    return { x: x + (edge === 'left' ? 0 : node.offsetWidth), y: y + node.offsetHeight / 2 };
                };
                const selected = model.select(map, selection);
                const paths = [];
                for (const node of columns.querySelectorAll('[data-map-programme]')) {
                    const p = map.programmes.find((p) => p.id === node.dataset.mapProgramme);
                    const cluster = columns.querySelector(`[data-map-cluster="${CSS.escape(p.id)}"]`);
                    const active = !selection.kind || selected.programmeIds.includes(p.id);
                    const connect = (a, b) => { paths.push(`<path class="${active && selection.kind ? 'is-traced' : ''}" data-muted="${!active}" style="--issuer-color:var(--issuer-${p.color})" d="${model.connectionPath(a,b)}"/>`); };
                    if (cluster) connect(point(cluster, 'right'), point(node, 'left'));
                    for (const id of selection.mode === 'controls' ? p.recipeIds : p.structureIds) {
                        const group = columns.querySelector(`[data-map-group="${CSS.escape(id)}"]`);
                        if (group) connect(point(node, 'right'), point(group, 'left'));
                    }
                }
                svg.innerHTML = paths.join('');
            }
            function notify() {
                el.dispatchEvent(new CustomEvent('rwa:map-selection', { bubbles: true, detail: { ...selection, ...model.select(map, selection), active: Boolean(selection.kind) } }));
            }
            let moving = [];
            const positions = () => Object.fromEntries([...columns.querySelectorAll('[data-map-programme], [data-map-group], [data-map-cluster]')].map((n) => { const r=n.getBoundingClientRect(); return [n.dataset.mapProgramme || n.dataset.mapGroup || 'cluster:'+n.dataset.mapCluster, {x:r.x,y:r.y}]; }));
            function render() {
                const before=positions();
                moving.forEach((a) => a.cancel()); moving=[];
                if (!model.select(map, selection).valid) selection = { mode: selection.mode, kind: '', id: '' };
                el.dataset.mapView = selection.mode;
                const state = model.select(map, selection);
                const selectedProgramme = selection.kind === 'programme' ? map.programmes.find(p => p.id === selection.id) : null;
                const traceColor = selectedProgramme ? `var(--issuer-${selectedProgramme.color})` : 'var(--map-accent)';
                const results = catalogueModel.searchResults(catalogue.entries, search, searchExpanded ? Infinity : 12);
                const resultsEl = el.querySelector('[data-map-search-results]');
                resultsEl.hidden = !search.trim();
                resultsEl.innerHTML = search.trim() ? `<p role="status">${results.total ? `${results.total} matching reports` : 'No assets, issuers or addresses match this search.'}</p><div class="structure-search-links">${results.links.map(item => `<a href="${esc(item.href)}"><strong>${esc(item.label)}</strong><small>${esc(item.detail)}</small></a>`).join('')}</div>${results.total > results.links.length ? `<button type="button" class="button" data-map-search-more>Show all ${results.total} matches</button>` : ''}` : '';
                const {pool,shown,groups} = model.overview(map, {entryIds:search.trim() ? results.entryIds : null,expanded:all || Boolean(search.trim()),mode:selection.mode,selection});
                columns.innerHTML = `<section class="structure-clusters"><h3>Token clusters</h3>${shown.map((p) => { const glyph = model.clusterGlyph(p.deployments.length); const match = catalogueModel.clusterMatches(catalogue.entries, p.products.map(product => product.entryId), search); return `<button type="button" class="structure-cluster" aria-label="${esc(p.label)}: ${match.symbols.length ? esc(match.symbols.join(', ')) + '; ' : ''}${p.deployments.length} indexed addresses" aria-pressed="${selection.kind === 'programme' && selection.id === p.id}" data-map-cluster="${esc(p.id)}" data-traced="${Boolean(selection.kind && state.programmeIds.includes(p.id))}" data-muted="${selection.kind && !state.programmeIds.includes(p.id)}" style="--issuer-color:var(--issuer-${p.color})"><span class="structure-dots" data-empty="${!glyph.dots}" style="--cluster-columns:${glyph.columns}" aria-hidden="true">${Array.from({ length: glyph.dots }, () => '<i></i>').join('')}</span><span>${match.symbols.length ? `<strong class="structure-cluster-tickers" title="${esc(match.symbols.join(', '))}">${esc(match.symbols.slice(0,3).join(', '))}${match.symbols.length > 3 ? ` +${match.symbols.length - 3}` : ''}</strong>${match.count ? `<small>${match.count.toLocaleString()} matching address${match.count === 1 ? '' : 'es'}</small>` : ''}<small>${p.deployments.length.toLocaleString()} programme addresses</small>` : `${p.deployments.length.toLocaleString()}<small>${p.deployments.length ? 'indexed addresses' : 'no address indexed'}</small>`}</span></button>`; }).join('')}</section><section class="structure-programmes"><h3>Issuer programmes</h3>${shown.map((p) => `<button type="button" data-map-programme="${esc(p.id)}" data-traced="${Boolean(selection.kind && state.programmeIds.includes(p.id))}" aria-pressed="${selection.kind === 'programme' && selection.id === p.id}" data-muted="${selection.kind && !state.programmeIds.includes(p.id)}" style="--issuer-color:var(--issuer-${p.color})"><span>${esc(p.label)}</span></button>`).join('')}</section><section class="structure-groups"><h3>${selection.mode === 'controls' ? 'Contract controls' : 'Legal structures'}</h3>${groups.map((g) => `<button type="button" data-map-group="${esc(g.id)}" data-traced="${Boolean(selection.kind && state.groupIds.includes(g.id))}" style="--trace-color:${traceColor}" aria-pressed="${selection.kind === 'group' && (selection.groupMode || selection.mode) === selection.mode && selection.id === g.id}" data-muted="${selection.kind && !state.groupIds.includes(g.id)}"><span>${esc(g.label)}</span><small>${g.programmes.length} programme${g.programmes.length === 1 ? '' : 's'}</small></button>`).join('')}</section>`;
                el.classList.toggle('motion-off', isStatic());
                for (const b of el.querySelectorAll('[data-map-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mapMode === selection.mode));
                el.querySelector('[data-map-more]').hidden = Boolean(search.trim()) || pool.length <= 7;
                el.querySelector('[data-map-more]').textContent = all ? 'Compact overview' : `Show all ${pool.length} programmes`;
                if (!pool.length) summary.innerHTML = '<p>No reviewed programmes match this search. Any matching catalogue reports appear above. Clear the search to return to the overview.</p>';
                else if (!selection.kind) summary.innerHTML = '<p>Trace a branch to see the products and the claim behind their tokens.</p>';
                else {
                    const groupMode = selection.groupMode || selection.mode;
                    const group = (groupMode === 'controls' ? map.recipes : map.structures).find((g) => g.id === selection.id);
                    const title = selection.kind === 'programme' ? map.programmes.find((p) => p.id === selection.id).label : group?.label;
                    const products = map.programmes.filter((p) => state.programmeIds.includes(p.id)).flatMap((p) => p.products);
                    summary.innerHTML = `${group ? `<p class="eyebrow">Selected ${groupMode === 'controls' ? 'control pattern' : 'legal structure'}</p>` : ''}<h3>${esc(title)}</h3>${group ? `<p>${groupMode === 'controls' ? group.id === 'recipe:Controls not classified' ? 'We have not classified the control pattern for these tokens. Open a product report to see its documented powers and evidence gaps.' : 'These tokens share a contract control pattern. This does not determine their legal rights.' : 'These products share a broad legal structure. Each has its own terms and holder context.'}</p>` : ''}<div class="structure-product-links">${products.map((p) => `<a class="button" href="./${esc(p.report)}" aria-label="See full report: ${esc(p.name)}">${products.length === 1 && selection.kind === 'programme' ? 'See full report' : esc(p.name)} →</a>`).join('')}</div>${products.filter(p => p.terms.length > 1).map(p => `<p class="structure-contexts">Holder contexts: ${p.terms.map(t => `<a href="./${esc(p.report)}&amp;context=${encodeURIComponent(t.contextId)}">${esc(t.label)}</a>`).join(' · ')}</p>`).join('')}${products.length === 1 ? (() => { return visual.render(products[0].profile, { compact: true, report: './' + products[0].report, featureHeading: 'Summary', summaryOnly: true }); })() : '<p>Choose a product for its individual visual profile.</p>'}`;
                }
                lines();
                if (!isStatic() && !document.hidden) {
                    const after=positions();
                    for (const n of columns.querySelectorAll('[data-map-programme], [data-map-group], [data-map-cluster]')) {
                        const id=n.dataset.mapProgramme || n.dataset.mapGroup || 'cluster:'+n.dataset.mapCluster;
                        const delta=model.movement(before[id],after[id]);
                        if (delta) moving.push(n.animate([{transform:`translate(${delta.x}px,${delta.y}px)`},{transform:'translate(0,0)'}], {duration:320,easing:'ease-out'}));
                    }
                }
            }
            el.addEventListener('click', (event) => {
                const b = event.target.closest('button'); if (!b) return;
                let change = true;
                if (b.dataset.mapProgramme) selection = { mode: selection.mode, kind: 'programme', id: b.dataset.mapProgramme };
                else if (b.dataset.mapCluster) selection = {mode: selection.mode,kind:'programme',id:b.dataset.mapCluster};
                else if (b.dataset.mapGroup) selection = { mode: selection.mode, groupMode: selection.mode, kind: 'group', id: b.dataset.mapGroup };
                else if (b.dataset.mapMode) selection = { ...selection, groupMode: selection.groupMode || selection.mode, mode: b.dataset.mapMode };
                else if (b.hasAttribute('data-map-reset')) { selection = { mode: selection.mode, kind: '', id: '' }; search = ''; el.querySelector('[data-map-search]').value = ''; searchExpanded = false; }
                else if (b.hasAttribute('data-map-search-more')) { searchExpanded = true; change = false; }
                else if (b.hasAttribute('data-map-more')) { all = !all; change = false; }
                else return;
                const focusId = b.dataset.mapProgramme || b.dataset.mapGroup || b.dataset.mapCluster;
                document.documentElement.classList.toggle('reduce-motion', isStatic());
                render(); if (change) { url(true); notify(); }
                if (b.dataset.mapCluster) columns.querySelector(`[data-map-cluster="${CSS.escape(focusId)}"]`)?.focus({preventScroll:true});
                else if (focusId) columns.querySelector(`[data-map-programme="${CSS.escape(focusId)}"], [data-map-group="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true });
            });
            el.querySelector('[data-map-search]').addEventListener('input', (e) => { search = e.target.value; all = false; searchExpanded = false; render(); url(false); });
            const observer = new ResizeObserver(lines); observer.observe(el.querySelector('.structure-canvas'));
            window.addEventListener('popstate', () => { selection = readSelection(); search = new URLSearchParams(location.search).get('search') || ''; el.querySelector('[data-map-search]').value = search; searchExpanded = false; render(); notify(); });
            reduced.addEventListener('change', render);
            document.addEventListener('visibilitychange', () => { el.classList.toggle('motion-suspended', document.hidden); if (document.hidden) moving.forEach((a) => a.cancel()); });
            const visibility=new IntersectionObserver((entries) => { el.classList.toggle('motion-suspended', !entries[0].isIntersecting); });
            visibility.observe(el);
            document.documentElement.classList.toggle('reduce-motion', isStatic());
            el.querySelector('[data-map-search]').value = search;
            render(); notify();
        } catch (error) {
            console.error(`[${new Date().toISOString()}] structure map unavailable`, error);
            el.innerHTML = '<p>The structure map could not be loaded. <a href="./explore.html">Search the catalogue</a> or <a href="./issuers/">read issuer dossiers</a>.</p>';
        }
    }
    root.__rwaMapUI = { mount };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => document.querySelectorAll('[data-structure-map]').forEach(mount));
    else document.querySelectorAll('[data-structure-map]').forEach(mount);
})(window);
