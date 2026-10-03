// Thin shared report/comparison controller; applicability and evidence rules live in the pure model.
(async function () {
    const reportView = window.__rwaReportView;
    let activeReportView;
    const model = window.__rwaResearch, monitor = window.__rwaMonitor, visual = window.__rwaVisualProfile, structure = window.__rwaStructureMap, scenarios = window.__rwaFailureScenario;
    let scenarioMode = new URLSearchParams(location.search).get('scenario') || 'normal';
    if (!scenarios.MODES[scenarioMode]) scenarioMode = 'normal';
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || new URLSearchParams(location.search).has('reduceMotion')) document.documentElement.classList.add('reduce-motion');
    const subject = (p) => p.instrument || p.programme;
    const $ = (id) => document.getElementById(id);
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const date = (v) => v ? esc(v.replace(/^(\d{4}-\d{2}-\d{2})T(?=\d{2}:)/, '$1 ').replace(/Z$/, ' UTC')) : 'Not recorded';
    const isCompare = document.body.dataset.researchPage === 'compare';
    const params = new URLSearchParams(location.search);
    const badge = (state) => `<span class="research-badge" data-state="${esc(state)}">${esc(model.STATES[state])}</span>`;
    function sources(p, ids) {
        return ids.map((id) => { const s = p.sources.find((s) => s.id === id); return `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`; }).join(' · ');
    }
    const finding = (p, c) => `${badge(c.state)}<p>${esc(c.summary)}</p><small>${esc(model.BASES[c.basis])}${c.sourceIds.length ? ' · ' + sources(p, c.sourceIds) : ''}</small>`;
    const options = (list, chosen, label = 'label') => list.map((p) => `<option value="${esc(p.id)}"${p.id === chosen ? ' selected' : ''}>${esc(p[label])}</option>`).join('');
    const validDeployment = (p, id) => { if (id && !p.deployments.some((d) => d.id === id)) throw new Error('Unknown deployment'); return id || ''; };
    function context(p, id) { const c=p.contexts.find((c) => c.id === id); if (id && !c) throw new Error('Unknown holder context'); return c || p.contexts[0]; }
    function deploymentOptions(p, chosen) {
        return '<option value="">' + (p.kind === 'programme' ? 'Programme scope; select exact token' : 'Instrument scope; select exact network') + '</option>' + p.deployments.map((d) => `<option value="${esc(d.id)}"${d.id === chosen ? ' selected' : ''}>${esc(d.symbol || p.ticker || p.name)} · ${esc(d.network)} · ${esc(d.address.slice(0, 10))}…</option>`).join('');
    }
    function exact(p, id) {
        const d = p.deployments.find((d) => d.id === id);
        if (!d) return '<p>Select an exact deployment to inspect its controls, evidence and observation dates.</p>';
        const o = d.observation, coverage = monitor.coverage(d, d.monitoring);
        return `<h3>${esc(d.symbol || p.ticker)} · ${esc(d.network)}</h3><code>${esc(d.address)}</code><p>${esc(d.identity)}</p><p class="muted">Instrument binding: ${esc(d.instrumentId || 'Unresolved; no individual legal findings inherited')}<br>Identity checked: ${date(d.identityCheckedAt)} · Chain checked: ${date(d.chainCheckedAt)}<br>Monitor: ${esc(coverage.replaceAll('-', ' '))}</p>${badge(d.controls.state)}<p>${esc(d.controls.summary)}</p>${o ? `<details><summary>Observed fields, block / slot and limits</summary><p>Block or slot: ${esc(o.blockNumber || o.slot)} · Chain timestamp: ${date(o.blockTimestamp)}</p>${o.blockHash ? `<code>${esc(o.blockHash)}</code>` : ''}<dl>${Object.entries(o.fields).map(([key, v]) => `<dt>${esc(key)}</dt><dd>${v.state === 'unknown' ? 'Unknown: ' + esc(v.reason) : esc(v.value === null ? 'None in this observed field' : typeof v.value === 'object' ? JSON.stringify(v.value) : String(v.value))}</dd>`).join('')}</dl><p>${esc(o.limitations)}</p></details>` : ''}${d.legacy ? `<details><summary>Retained stock controls, market and protocol observations</summary><p>These source snapshots were not refreshed by the adapter. Chain input: ${date(d.legacy.sourceDates?.chain)} · Venues: ${date(d.legacy.sourceDates?.venues)} · Reference prices: ${date(d.legacy.sourceDates?.referencePrices)}</p><h3>Recorded controls</h3><dl>${Object.entries(d.legacy.control || {}).map(([k,v]) => `<dt>${esc(k)}</dt><dd>${esc(v === null ? 'Unknown' : String(v))}</dd>`).join('')}</dl><h3>Market and protocol data</h3><p>${esc(JSON.stringify({ market:d.legacy.market, protocol:d.legacy.protocol }))}</p><p>A pool, holding or configured protocol observation does not prove a successful trade or redemption. The existing exact-token report supplies its interpretation.</p></details>` : ''}${d.report ? `<p><a href="./${esc(d.report)}">Existing exact-token report →</a></p>` : ''}<small>${sources(p, d.sourceIds)}</small>`;
    }
    function identity(p, ctx) {
        return `<dl><dt>Holder context</dt><dd>${esc(ctx.label)}</dd><dt>Legal interest</dt><dd>${esc(subject(p).legalForm)}</dd><dt>Issuer</dt><dd>${esc(subject(p).issuer)}</dd><dt>Identity coverage</dt><dd>${esc(subject(p).identity)}</dd><dt>Exposure</dt><dd>${esc(p.exposure.label)}</dd><dt>Legal review</dt><dd>${date(p.reviewedAt)}</dd>${p.evidenceCheckedAt ? `<dt>Dossier evidence</dt><dd>${date(p.evidenceCheckedAt)}</dd>` : ''}<dt>Review scope</dt><dd>${p.kind === 'programme' || ($('reportDeployment')?.value && !p.deployments.find((d) => d.id === $('reportDeployment').value)?.instrumentId) ? 'Programme only; individual terms unresolved' : 'Instrument / product'}</dd></dl>`;
    }
    function profileMarkup(p, ctx, deployment, prefix = 'finding-') {
        return `<div style="--issuer-color:var(--issuer-${structure.colorSlot(p.programmeId)})">${visual.render(visual.profile(p, ctx.id, deployment ? { deploymentId: deployment } : {}), { prefix, compact: prefix !== 'finding-', summaryOnly: true })}</div>`;
    }
    function report(p, ctx) {
        $('researchContent').querySelector('[data-token-story]')?.__storyDispose?.();
        const deploymentLabel = $('reportDeployment').closest('label');
        // Move the persistent picker out before replacing topic content; its listeners survive.
        $('reportPickers').append(deploymentLabel);
        deploymentLabel.hidden = true;
        const deploymentId = $('reportDeployment').value;
        activeReportView = reportView.view(p, ctx.id, { deploymentId, hash: location.hash, scenarioMode });
        $('researchTitle').textContent = p.name;
        document.title = `${p.name}: holder rights — RWA Sonar`;
        $('researchScope').textContent = `${activeReportView.scope} · ${p.deployments.length} indexed ${p.kind === 'programme' ? (p.deployments.length === 1 ? 'token' : 'tokens') : (p.deployments.length === 1 ? 'address' : 'addresses')}${activeReportView.deployment ? ' · ' + (activeReportView.deployment.symbol || activeReportView.deployment.network) : ''}`;
        $('reportContext').closest('label').hidden = p.contexts.length === 1;
        $('researchContent').innerHTML = reportView.render(activeReportView);
        const storyHost = $('researchContent').querySelector('[data-token-story]');
        if (storyHost) window.__rwaTokenStoryUI.mount(storyHost, activeReportView);
        const slot = $('researchContent').querySelector('[data-report-deployment-slot]');
        if (slot) { slot.append(deploymentLabel); deploymentLabel.hidden = false; }
        if (!p.deployments.length && slot) deploymentLabel.hidden = true;
    }
    function comparison(left, lc, right, rc) {
        const ld = $('leftDeployment').value, rd = $('rightDeployment').value;
        const view = model.compare(left, lc.id, right, rc.id, ld ? { deploymentId: ld } : {}, rd ? { deploymentId: rd } : {});
        $('comparisonScope').textContent = view.mode === 'instrument-networks' ? 'Same instrument, different deployments. Exact chain controls and dates are compared separately below; legal terms and holder contexts must still match.' : view.mode === 'underlying-products' ? 'Same underlying, different products. Programme findings remain in their own scope; exact-token terms are unresolved unless expressly bound.' : view.differentExposure ? 'These products provide different exposures. Compare the legal interests and dependencies in their stated contexts; the rows do not imply equivalent risk or value.' : 'These products provide a similar exposure. Instrument identity, holder context and terms still differ; evaluate each row with its evidence.';
        $('researchContent').innerHTML = `<section class="compare-grid"><div class="compare-row"><h2>Strengths and limits in each context</h2><div class="compare-cell">${profileMarkup(left,lc,ld,'left-finding-')}</div><div class="compare-cell">${profileMarkup(right,rc,rd,'right-finding-')}</div></div><div class="compare-row"><h2>Identity and scope</h2>${[[left, lc], [right, rc]].map(([p, c]) => `<div class="compare-cell"><h3>${esc(p.name)}</h3>${identity(p, c)}<p>${esc(subject(p).scope)}</p><a href="./report.html?product=${esc(p.id)}&context=${esc(c.id)}">Full report and sources →</a></div>`).join('')}</div>${view.rows.map((r) => `<div class="compare-row"><h2>${esc(r.label)}</h2><div class="compare-cell" id="left-finding-${esc(r.key)}" tabindex="-1">${left.kind === 'programme' ? '<small>Programme finding only; individual terms unresolved.</small>' : ''}${finding(left, left.kind === 'programme' ? model.resolveClaim(left, lc.id, r.key) : r.left)}</div><div class="compare-cell" id="right-finding-${esc(r.key)}" tabindex="-1">${right.kind === 'programme' ? '<small>Programme finding only; individual terms unresolved.</small>' : ''}${finding(right, right.kind === 'programme' ? model.resolveClaim(right, rc.id, r.key) : r.right)}</div></div>`).join('')}<div class="compare-row"><h2>Exact deployments: controls and use</h2><div class="compare-cell">${exact(left, ld)}</div><div class="compare-cell">${exact(right, rd)}</div></div><div class="compare-row"><h2>Evidence limits</h2>${[left, right].map((p) => `<div class="compare-cell">${p.evidenceProfiles.map((e) => `<p><strong>${esc(e.method)}: ${esc(e.availability.replaceAll('-', ' '))}</strong><br>${esc(e.limit)}</p>`).join('')}</div>`).join('')}</div></section>`;
    }
    try {
        const response = await fetch('./rwa-research.json', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Research HTTP ${response.status}`);
        const data = model.validateResearch(await response.json());
        const lookup = (id, fallback) => { const product=data.products.find((p) => p.id === id); if (id && !product) throw new Error('Unknown research product'); return product || data.products[fallback]; };
        if (isCompare) {
            let left = lookup(params.get('left'), 0), right = lookup(params.get('right'), 1);
            let lc = context(left, params.get('leftContext')), rc = context(right, params.get('rightContext'));
            let leftDeployment = params.get('leftDeployment') || '', rightDeployment = params.get('rightDeployment') || '';
            $('leftProduct').innerHTML = options(data.products, left.id, 'name');
            $('rightProduct').innerHTML = options(data.products, right.id, 'name');
            function render() {
                leftDeployment = validDeployment(left, leftDeployment); rightDeployment = validDeployment(right, rightDeployment);
                $('leftContext').innerHTML = options(left.contexts, lc.id);
                $('rightContext').innerHTML = options(right.contexts, rc.id);
                $('leftDeployment').innerHTML = deploymentOptions(left, leftDeployment);
                $('rightDeployment').innerHTML = deploymentOptions(right, rightDeployment);
                comparison(left, lc, right, rc);
                history.replaceState(null, '', `compare.html?${new URLSearchParams({ left: left.id, leftContext: lc.id, right: right.id, rightContext: rc.id, ...(leftDeployment ? { leftDeployment } : {}), ...(rightDeployment ? { rightDeployment } : {}) })}`);
            }
            for (const side of ['left', 'right']) {
                $(side + 'Deployment').addEventListener('change', () => { if (side === 'left') leftDeployment = $('leftDeployment').value; else rightDeployment = $('rightDeployment').value; render(); });
                $(side + 'Product').addEventListener('change', () => { const p = lookup($(side + 'Product').value, 0); if (side === 'left') { left = p; lc = p.contexts[0]; leftDeployment = ''; } else { right = p; rc = p.contexts[0]; rightDeployment = ''; } render(); });
                $(side + 'Context').addEventListener('change', () => { if (side === 'left') lc = context(left, $('leftContext').value); else rc = context(right, $('rightContext').value); render(); });
            }
            render();
        } else {
            let p = lookup(params.get('product'), 0), ctx = context(p, params.get('context')), selectedDeployment = params.get('deployment') || '';
            $('reportProduct').innerHTML = options(data.products, p.id, 'name');
            function render() {
                selectedDeployment = validDeployment(p, selectedDeployment);
                $('reportContext').innerHTML = options(p.contexts, ctx.id);
                $('reportDeployment').innerHTML = deploymentOptions(p, selectedDeployment);
                report(p, ctx);
                history.replaceState(null, '', `report.html?${new URLSearchParams({ product: p.id, context: ctx.id, ...(selectedDeployment ? { deployment: selectedDeployment } : {}), ...(scenarioMode !== 'normal' ? {scenario: scenarioMode} : {}), ...(new URLSearchParams(location.search).has('reduceMotion') ? {reduceMotion:'1'} : {}) })}${location.hash}`);
            }
            $('researchContent').addEventListener('click', (event) => {
                const b = event.target.closest('button'); if (!b) return;
                if (b.dataset.reportEvidence) {
                    const dialog = $('reportEvidence');
                    dialog.innerHTML = reportView.renderEvidence(activeReportView, b.dataset.reportEvidence);
                    dialog.showModal();
                } else if (b.hasAttribute('data-report-programme')) { selectedDeployment = ''; render(); }
                else if (b.dataset.scenario) {
                    scenarioMode = b.dataset.scenario; render();
                    if (!document.documentElement.classList.contains('reduce-motion')) $('researchContent').querySelector('[data-affected="true"]')?.animate([{opacity:1},{opacity:.55}], {duration:350,easing:'ease-out'});
                    $('researchContent').querySelector(`[data-scenario="${scenarioMode}"]`)?.focus({preventScroll:true});
                }
            });
            $('researchContent').addEventListener('change', event => {
                if (event.target.hasAttribute('data-report-topic-picker')) location.hash = event.target.value;
            });
            $('researchContent').addEventListener('input', event => {
                if (event.target.hasAttribute('data-report-source-search')) $('researchContent').querySelector('[data-report-source-list]').innerHTML = reportView.sourceRows(p, event.target.value);
                if (event.target.hasAttribute('data-report-case-search')) $('researchContent').querySelector('[data-report-cases]').innerHTML = reportView.casesMarkup(activeReportView, event.target.value);
            });
            $('reportEvidence').addEventListener('click', event => {
                const dialog = $('reportEvidence'), bounds = dialog.getBoundingClientRect();
                const backdrop = event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom);
                if (event.target.closest('[data-report-close]') || backdrop) dialog.close();
            });
            window.addEventListener('pagehide', () => $('researchContent').querySelector('[data-token-story]')?.__storyDispose?.());
            window.addEventListener('hashchange', () => {
                render();
                $('researchContent').querySelector('.report-topic-title')?.focus({preventScroll:true});
                $('reportPanel').scrollIntoView({block:'start'});
            });
            window.addEventListener('popstate', () => {
                const current = new URLSearchParams(location.search);
                p = lookup(current.get('product'), 0); ctx = context(p, current.get('context'));
                selectedDeployment = current.get('deployment') || ''; scenarioMode = current.get('scenario') || 'normal';
                $('reportProduct').value = p.id; render();
            });
            $('reportProduct').addEventListener('change', () => { p = lookup($('reportProduct').value, 0); ctx = p.contexts[0]; selectedDeployment = ''; scenarioMode = 'normal'; render(); $('reportSwitcher').open = false; window.scrollTo({top:0}); });
            $('reportDeployment').addEventListener('change', () => { selectedDeployment = $('reportDeployment').value; render(); });
            $('reportContext').addEventListener('change', () => { ctx = context(p, $('reportContext').value); render(); });
            render();
        }
        $('researchStatus').textContent = '';
        $('researchStatus').hidden = true;
    } catch (error) {
        console.error(`[${new Date().toISOString()}] research unavailable`, error);
        $('researchStatus').textContent = error.message.startsWith('Unknown ') ? 'The selected product, holder context or deployment is not in this research scope.' : 'Research could not be loaded. Reload to retry.';
        $('researchContent').innerHTML = '<p><a href="./explore.html">Choose a product from Explore →</a></p>';
    }
})();
