// Thin browser layer for the scoped all-RWA catalogue: filters, shareable selection and reports.
(async function () {
    const model = window.__rwaCatalogue;
    const $ = (id) => document.getElementById(id);
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const date = (value) => value ? esc(value.replace(/^(\d{4}-\d{2}-\d{2})T(?=\d{2}:)/, '$1 ').replace(/Z$/, ' UTC')) : 'Not recorded';
    const fields = { search: $('catalogueSearch'), category: $('catalogueCategory'), chain: $('catalogueChain'), coverage: $('catalogueCoverage'), form: $('catalogueForm') };
    let data, selected, expanded = false;
    const filters = () => Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value]));
    function writeUrl() {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(filters())) if (value) params.set(key, value);
        if (selected) params.set('entry', selected);
        history.replaceState(null, '', `explore.html${params.size ? '?' + params : ''}`);
    }
    function detail(entry) {
        const panel = $('catalogueDetail');
        if (!entry) { panel.hidden = true; return; }
        if (entry.coverage === 'reviewed') {
            panel.innerHTML = `<span class="catalogue-tag">Public documents reviewed</span><h2 tabindex="-1">${esc(entry.name)}</h2><p>${esc(entry.scope)}</p><p><strong>${esc(entry.legalForm)}</strong></p><p>${esc(entry.holderClaim)}</p><p class="catalogue-notice">Open the report for the holder context, evidence states and unresolved terms. A document review does not verify live backing or chain controls.</p><p><a class="button button-primary" href="./${esc(entry.report)}">Read holder-rights report →</a> <a class="button" href="./compare.html?left=${esc(entry.researchId)}">Compare →</a></p><p class="catalogue-meta">Public-document review: ${date(entry.legalReviewedAt)}<br>Operational status check: ${date(entry.statusCheckedAt)} (separate historical observation)</p>`;
            panel.hidden = false;
            return;
        }
        const matching = model.matchingDeployments(entry, fields.search.value);
        const deployments = matching.length ? matching : entry.deployments;
        const shown = expanded ? deployments : deployments.slice(0, 8);
        panel.innerHTML = `<span class="catalogue-tag">${esc(model.COVERAGE[entry.coverage])}</span><span class="catalogue-tag">${esc(entry.kind)}</span>
            <h2 tabindex="-1">${esc(entry.name)}</h2><p><a href="#catalogueResults">Back to results ↑</a></p><p class="catalogue-meta">${esc(entry.scope)}</p>
            ${entry.coverage === 'historical' ? '<p class="catalogue-notice">This older record has not been re-reviewed under the shared framework. Its historical classification and address are retained for discovery. Rights, controls and exit routes await verification.</p>' : ''}
            <h3>What do I own?</h3><p><strong>${esc(model.FORMS[entry.legalForm] || entry.legalForm || 'Legal claim not yet reviewed')}</strong></p>
            ${entry.holderClaim ? `<details open><summary>Programme answer and qualifications</summary><p>${esc(entry.holderClaim)}</p></details>` : `<p>Original category: ${esc(entry.exposure)}. This label does not establish the holder’s legal interest.</p>`}
            <h3>Access and exit</h3><p>${esc(entry.access || 'Eligibility and the exit route need a fresh review.')}</p>
            ${entry.exit ? `<details><summary>Documented route and limitations</summary><p>${esc(entry.exit)}</p></details>` : ''}
            <h3>Controls and failure outcomes</h3><p>${entry.coverage === 'dossier' ? 'Open the programme dossier for legal powers and failure scenarios. Use an exact-token report for its observed chain controls.' : 'Current evidence is not yet established in the unified catalogue.'}</p>
            <p><a class="button button-primary" href="./${esc(entry.report)}">${entry.coverage === 'dossier' ? 'Read the programme dossier' : 'Open the historical record'} →</a></p>
            <h3>Evidence and dates</h3><p class="catalogue-meta">Formal legal-review date: ${date(entry.legalReviewedAt)}<br>Dossier evidence checked: ${date(entry.evidenceCheckedAt)}<br>Original status check: ${date(entry.statusCheckedAt)}<br>Recorded status: ${esc(entry.recordedStatus || 'Unknown')} (from source)</p>
            <p class="catalogue-meta">An index build or token discovery does not refresh legal research. Dossier coverage does not mean every claim is confirmed. <a href="./${esc(entry.source)}">Read source record</a>${entry.sourceUrl ? ` · <a href="${esc(entry.sourceUrl)}">Product website</a>` : ''}</p>
            <h3>${entry.kind === 'programme' ? 'Indexed Solana deployments' : 'Address in original catalogue'} (${entry.deployments.length})</h3>
            ${entry.historicalNetworks?.length ? `<p class="catalogue-meta">Historical catalogue networks: ${esc(entry.historicalNetworks.join(', '))}. These labels do not establish an exact deployment or current chain controls.</p>` : ''}
            <p class="catalogue-meta">${entry.kind === 'programme' ? 'Discovery observations are shown below. Read each report for chain-check dates and instrument-specific evidence.' : 'Other deployments may exist. A listed network without an address is not a verified deployment.'}</p>
            ${shown.map((d) => `<article class="catalogue-deployment"><strong>${esc(d.symbol)} · ${esc(d.network)}</strong>${d.name ? `<small>${esc(d.name)}</small>` : ''}<code>${esc(d.address)}</code><small>Identity: ${esc(d.identity)}<br>Last seen in discovery: ${date(d.observedAt)}</small>${d.report ? `<a href="./${esc(d.report)}">Exact-token report →</a>` : '<small>Address verification pending</small>'}</article>`).join('')}
            ${deployments.length > shown.length ? `<button id="catalogueMore" class="button catalogue-more" type="button">Show all ${deployments.length} matching deployments</button>` : ''}
            ${entry.deployments.length === 0 ? '<p>No exact deployment indexed here.</p>' : ''}`;
        panel.hidden = false;
        $('catalogueMore')?.addEventListener('click', () => { expanded = true; detail(entry); });
    }
    function render() {
        const entries = model.filterEntries(data.entries, filters());
        if (!entries.some((e) => e.id === selected)) selected = entries[0]?.id || null;
        $('catalogueStatus').textContent = `${entries.length} matching entries. Product entries and issuer programmes are counted separately.`;
        $('catalogueResults').innerHTML = model.groupEntries(entries).map(([label, rows]) => {
            return rows.length ? `<section class="catalogue-family"><h2>${esc(label)} · ${rows.length}</h2>${rows.map((e) => `<button type="button" class="catalogue-row" data-entry="${esc(e.id)}" aria-pressed="${e.id === selected}"><strong>${esc(e.name)}</strong>${e.recordedStatus && e.recordedStatus !== 'live' ? `<span class="catalogue-meta">Recorded status: ${esc(e.recordedStatus)}</span>` : ''}<span>${esc(model.FORMS[e.legalForm] || e.legalForm || 'Legal claim awaiting review')}</span><small><span class="catalogue-tag">${esc(model.COVERAGE[e.coverage])}</span>${esc(e.kind)} · ${esc(e.chains.join(', ') || (e.historicalNetworks?.length ? e.historicalNetworks.join(', ') + ' (historical)' : 'No exact network indexed'))}${e.kind === 'programme' ? ` · ${e.deployments.length} indexed addresses` : ''}</small>${fields.search.value && e.kind === 'programme' && model.matchingDeployments(e, fields.search.value).length ? `<small>Matching tokens: ${esc(model.matchingDeployments(e, fields.search.value).slice(0, 4).map((d) => d.symbol).join(', '))}</small>` : ''}</button>`).join('')}</section>` : '';
        }).join('') || '<p>No matches. Change the filters or reset the search.</p>';
        detail(entries.find((e) => e.id === selected));
        writeUrl();
    }
    try {
        const response = await fetch('./rwa-catalogue.json', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Catalogue HTTP ${response.status}`);
        data = await response.json();
        const option = (value, label) => `<option value="${esc(value)}">${esc(label)}</option>`;
        fields.category.innerHTML += Object.entries(model.CATEGORIES).map(([k, v]) => option(k, v)).join('');
        fields.chain.innerHTML += [...new Set(data.entries.flatMap((e) => [...e.chains, ...(e.historicalNetworks || [])]))].sort().map((c) => option(c, c)).join('');
        fields.form.innerHTML += [...new Set(data.entries.map((e) => e.legalForm).filter(Boolean))].sort().map((f) => option(f, model.FORMS[f] || f)).join('');
        const params = new URLSearchParams(location.search);
        for (const [key, field] of Object.entries(fields)) field.value = params.get(key) || '';
        $('catalogueAdvanced').open = ['chain', 'coverage', 'form'].some((key) => fields[key].value);
        selected = params.get('entry');
        const c = data.counts;
        $('catalogueCounts').textContent = `${c.products} product entries (${c.reviewedProducts} public reviews) · ${c.programmes} stock programme dossiers · ${(c.indexedDeployments || c.indexedStockDeployments).toLocaleString()} indexed deployments · ${c.instrumentResearchSubjects || 0} instrument research identities · ${c.configuredMonitors || 0} configured cross-asset monitors`;
        $('catalogueResults').addEventListener('click', (event) => {
            const button = event.target.closest('[data-entry]');
            if (!button) return;
            selected = button.dataset.entry; expanded = false; render();
            $('catalogueDetail').scrollIntoView({ block: 'start' });
            $('catalogueDetail').querySelector('h2').focus({ preventScroll: true });
        });
        $('catalogueFilters').addEventListener('submit', (event) => event.preventDefault());
        for (const event of ['input', 'change']) $('catalogueFilters').addEventListener(event, () => { expanded = false; render(); });
        $('catalogueFilters').addEventListener('reset', (event) => { event.preventDefault(); Object.values(fields).forEach((f) => { f.value = ''; }); selected = null; expanded = false; render(); });
        render();
    } catch (error) {
        console.error(`[${new Date().toISOString()}] catalogue unavailable`, error);
        $('catalogueStatus').textContent = 'The catalogue could not be loaded. Reload to retry, or use the linked Solana workspace and historical catalogue.';
    }
})();
