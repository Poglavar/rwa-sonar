// Thin shared report/comparison controller; applicability and evidence rules live in the pure model.
(async function () {
    const model = window.__rwaResearch, monitor = window.__rwaMonitor;
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
    const validDeployment = (p, id) => p.deployments.some((d) => d.id === id) ? id : '';
    function context(p, id) { return p.contexts.find((c) => c.id === id) || p.contexts[0]; }
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
    function report(p, ctx) {
        $('researchTitle').textContent = p.name;
        document.title = `${p.name}: holder rights — RWA Sonar`;
        $('researchScope').textContent = subject(p).scope;
        const exitLabels = { obligor: 'Legal obligor', processor: 'Route operator', onboarding: 'Onboarding', entitlementOnTransfer: 'Entitlement on transfer', settlement: 'Settlement and timetable', minimumAndFees: 'Minimum and fees', independentRoute: 'Route without issuer', availability: 'Operational evidence' };
        $('researchContent').innerHTML = `<section class="research-card research-wide"><h2>What this review covers</h2>${identity(p, ctx)}${p.kind === 'programme' || (p.deployments.find((d) => d.id === $('reportDeployment').value)?.instrumentId === null) ? '<p class="research-notice">The answers below cover the stated programme or product review. The selected address has no verified binding to individual instrument terms; inspect its separate observations below.</p>' : ''}<details><summary>Instrument, programme and terms identifiers</summary><p class="muted">${esc(subject(p).id)} · ${esc(p.programmeId)}<br>${esc(ctx.termsId)}</p><p>${esc(subject(p).shareClass || 'Share class not specified by this review.')} ${esc(subject(p).issuanceVintage || '')}</p></details><p><a href="./compare.html?left=${esc(p.id)}&leftContext=${esc(ctx.id)}">Compare this interest →</a>${p.legacyReport ? ` · <a href="./${esc(p.legacyReport)}">Detailed stock dossier</a>` : ''}</p></section>
            ${Object.entries(model.DIMENSIONS).map(([key, label]) => `<section class="research-card"><h2>${esc(label)}</h2>${finding(p, model.resolveClaim(p, ctx.id, key))}</section>`).join('')}
            <section class="research-card"><h2>Exit route in this context</h2><dl>${Object.entries(p.exitDetails[ctx.id] || {}).map(([key, value]) => `<dt>${esc(exitLabels[key] || key)}</dt><dd>${esc(value)}</dd>`).join('')}</dl></section>
            ${p.assetModule ? `<section class="research-card research-wide"><h2>${esc(p.assetModule.label)}</h2><p>${esc(p.assetModule.summary)}</p><small>${sources(p, p.assetModule.sourceIds)}</small></section>` : ''}
            <section class="research-card research-wide"><h2>Evidence profile</h2><p class="muted">Evidence methods answer different questions. Availability, scope and measurement dates are shown separately.</p>${p.evidenceProfiles.map((e) => `<article><h3>${esc(e.method)} · ${esc(e.availability.replaceAll('-', ' '))}</h3><p>${esc(e.scope)}. ${esc(e.limit)}</p><small>Measurement period: ${date(e.sourcePeriod)} · Reviewed: ${date(e.checkedAt)}${e.sourceIds.length ? '<br>' + sources(p, e.sourceIds) : ''}</small></article>`).join('<hr>')}</section>
            ${p.relationships?.length ? `<section class="research-card research-wide"><h2>Wrapper and portfolio dependencies</h2>${p.relationships.map((r) => `<p><strong>${esc(r.kind)}: ${esc(r.target)}</strong><br>${esc(r.backingCountPolicy)}</p>`).join('')}</section>` : ''}
            <section class="research-card research-wide"><h2>Exact deployment observations</h2><p class="muted">Fresh chain evidence leaves the legal review date unchanged. ${p.deployments.length} indexed deployment(s); select an address above.</p>${exact(p, $('reportDeployment').value)}</section>
            <section class="research-card research-wide"><h2>Sources and dates</h2><ol>${p.sources.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a><br><small>${esc(s.locator)}${s.quote ? `<details><summary>Retained quotation</summary><blockquote>${esc(s.quote)}</blockquote></details>` : ''}<br>Document date: ${date(s.documentDate)} · Effective: ${date(s.effectiveDate)} · Checked: ${date(s.checkedAt)}</small></li>`).join('')}</ol><p><a href="./rwa-research.json">Download scoped research data</a></p></section>`;
    }
    function comparison(left, lc, right, rc) {
        const ld = $('leftDeployment').value, rd = $('rightDeployment').value;
        const view = model.compare(left, lc.id, right, rc.id, ld ? { deploymentId: ld } : {}, rd ? { deploymentId: rd } : {});
        $('comparisonScope').textContent = view.mode === 'instrument-networks' ? 'Same instrument, different deployments. Exact chain controls and dates are compared separately below; legal terms and holder contexts must still match.' : view.mode === 'underlying-products' ? 'Same underlying, different products. Programme findings remain in their own scope; exact-token terms are unresolved unless expressly bound.' : view.differentExposure ? 'These products provide different exposures. Compare the legal interests and dependencies in their stated contexts; the rows do not imply equivalent risk or value.' : 'These products provide a similar exposure. Instrument identity, holder context and terms still differ; evaluate each row with its evidence.';
        $('researchContent').innerHTML = `<section class="compare-grid"><div class="compare-row"><h2>Identity and scope</h2>${[[left, lc], [right, rc]].map(([p, c]) => `<div class="compare-cell"><h3>${esc(p.name)}</h3>${identity(p, c)}<p>${esc(subject(p).scope)}</p><a href="./report.html?product=${esc(p.id)}&context=${esc(c.id)}">Full report and sources →</a></div>`).join('')}</div>${view.rows.map((r) => `<div class="compare-row"><h2>${esc(r.label)}</h2><div class="compare-cell">${left.kind === 'programme' ? '<small>Programme finding only; individual terms unresolved.</small>' : ''}${finding(left, left.kind === 'programme' ? model.resolveClaim(left, lc.id, r.key) : r.left)}</div><div class="compare-cell">${right.kind === 'programme' ? '<small>Programme finding only; individual terms unresolved.</small>' : ''}${finding(right, right.kind === 'programme' ? model.resolveClaim(right, rc.id, r.key) : r.right)}</div></div>`).join('')}<div class="compare-row"><h2>Exact deployments: controls and use</h2><div class="compare-cell">${exact(left, ld)}</div><div class="compare-cell">${exact(right, rd)}</div></div><div class="compare-row"><h2>Evidence limits</h2>${[left, right].map((p) => `<div class="compare-cell">${p.evidenceProfiles.map((e) => `<p><strong>${esc(e.method)}: ${esc(e.availability.replaceAll('-', ' '))}</strong><br>${esc(e.limit)}</p>`).join('')}</div>`).join('')}</div></section>`;
    }
    try {
        const response = await fetch('./rwa-research.json', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Research HTTP ${response.status}`);
        const data = model.validateResearch(await response.json());
        const lookup = (id, fallback) => data.products.find((p) => p.id === id) || data.products[fallback];
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
                history.replaceState(null, '', `report.html?${new URLSearchParams({ product: p.id, context: ctx.id, ...(selectedDeployment ? { deployment: selectedDeployment } : {}) })}`);
            }
            $('reportProduct').addEventListener('change', () => { p = lookup($('reportProduct').value, 0); ctx = p.contexts[0]; selectedDeployment = ''; render(); });
            $('reportDeployment').addEventListener('change', () => { selectedDeployment = $('reportDeployment').value; render(); });
            $('reportContext').addEventListener('change', () => { ctx = context(p, $('reportContext').value); render(); });
            render();
        }
        $('researchStatus').textContent = 'Public-source research and chain observations retain separate scopes and dates. Unknown evidence remains open; source statements do not establish observed execution.';
    } catch (error) {
        console.error(`[${new Date().toISOString()}] research unavailable`, error);
        $('researchStatus').textContent = 'Research could not be loaded. Reload to retry.';
    }
})();
