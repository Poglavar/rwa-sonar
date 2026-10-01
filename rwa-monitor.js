// Displays cross-asset monitor coverage from the published report runtime without refreshing legal dates.
(async function () {
    const panel = document.getElementById('rwaDeploymentMonitor');
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    try {
        const response = await fetch('./rwa-research.json', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Research HTTP ${response.status}`);
        const data = await response.json(), records = data.monitoringRecords || {}, model = window.__rwaMonitor;
        const counts = model.counts(data.products, records, Date.now());
        const rows = data.products.flatMap((p) => p.deployments.filter((d) => records[d.id]?.configured).map((d) => ({ p, d, record: records[d.id] })));
        panel.innerHTML = `<h2>Cross-asset deployment observations</h2><p>${counts.recentSuccessfulMonitors} recent successful observations · ${counts.configuredMonitors} addresses in the configured watch scope · ${counts.indexedDeployments} total indexed deployments.</p><p>These counts describe retained read-only checks. They do not establish a running scheduler, current backing, legal validity or successful user execution. A fresh chain read does not refresh a legal review.</p>${rows.map(({ p, d, record }) => `<article class="research-card"><h3><a href="./report.html?${esc(new URLSearchParams({ product: p.id, deployment: d.id }))}">${esc(p.name)} · ${esc(d.network)}</a></h3><code>${esc(d.address)}</code><p>${esc(model.coverage(d, record).replaceAll('-', ' '))} · Last successful read: ${esc(record.lastSuccessAt || 'None')}<br>Latest attempt: ${esc(record.lastAttemptAt)} · ${esc(record.lastAttemptStatus)}</p>${record.lastError ? `<p>${esc(record.lastError)}</p>` : ''}<p class="muted">Legal review: ${esc(p.reviewedAt || 'Not recorded')} · Block / slot: ${esc(record.observation?.blockNumber || record.observation?.slot || 'Unknown')}</p></article>`).join('')}<p><a href="./rwa-research.json">Published observations and evidence scopes</a></p>`;
    } catch (error) {
        console.error(`[${new Date().toISOString()}] cross-asset monitor unavailable`, error);
        panel.textContent = 'Cross-asset monitoring data could not be loaded. Reload to retry.';
    }
})();
