/* The public overview. Data shaping and chart geometry stay pure so the daily-series semantics can
 * be tested without a browser; the DOM layer only fetches, renders and links into the workspace. */
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.__landing = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const fmt = (typeof __rwaFmt !== 'undefined') ? __rwaFmt : require('./stocks/lib/fmt.js');
    const { escapeHtml, fmtDate, fmtMoney, fmtNumber, humanizeSlug, cardSlug } = fmt;

    function finite(value) {
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    function orderedRows(document) {
        return (Array.isArray(document?.items) ? document.items : [])
            .filter((row) => row && typeof row.date === 'string')
            .map((row) => ({ ...row }))
            .sort((a, b) => a.date.localeCompare(b.date));
    }

    function metricDelta(rows, key) {
        const usable = orderedRows({ items: rows }).filter((row) => finite(row[key]) !== null);
        if (usable.length === 0) return { latest: null, previous: null, delta: null, totalDelta: null };
        const latest = finite(usable.at(-1)[key]);
        const previous = usable.length > 1 ? finite(usable.at(-2)[key]) : null;
        const first = finite(usable[0][key]);
        return {
            latest,
            previous,
            delta: previous === null ? null : latest - previous,
            totalDelta: first === null ? null : latest - first
        };
    }

    function issuerDeltas(rows) {
        const ordered = orderedRows({ items: rows });
        if (ordered.length < 2) return [];
        const before = new Map((ordered.at(-2).issuerCounts ?? []).map((row) => [row.issuer, finite(row.tokenCount) ?? 0]));
        const after = new Map((ordered.at(-1).issuerCounts ?? []).map((row) => [row.issuer, finite(row.tokenCount) ?? 0]));
        return [...new Set([...before.keys(), ...after.keys()])]
            .map((issuer) => ({ issuer, delta: (after.get(issuer) ?? 0) - (before.get(issuer) ?? 0) }))
            .filter((row) => row.delta !== 0)
            .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.issuer.localeCompare(b.issuer));
    }

    function chartModel(rows, key, width = 520, height = 220) {
        const padding = { top: 24, right: 16, bottom: 30, left: 16 };
        const usable = orderedRows({ items: rows }).filter((row) => finite(row[key]) !== null);
        if (usable.length === 0) return { points: [], width, height, max: 0 };
        const values = usable.map((row) => row[key]);
        const max = Math.max(1, ...values);
        const innerW = width - padding.left - padding.right;
        const innerH = height - padding.top - padding.bottom;
        const points = usable.map((row, index) => ({
            date: row.date,
            value: row[key],
            x: padding.left + (usable.length === 1 ? innerW / 2 : index * innerW / (usable.length - 1)),
            y: padding.top + innerH - (row[key] / max) * innerH
        }));
        return { points, width, height, max, padding };
    }

    function recentUpdates(changes, defi, limit = 6) {
        const items = [];
        for (const event of Array.isArray(defi?.latest?.events) ? defi.latest.events : []) {
            items.push({
                date: defi.latest.to ?? defi.generatedAt ?? null,
                type: 'DeFi watch',
                title: event.summary ?? `${event.symbol ?? 'Token'} protocol status changed`,
                detail: `${event.protocolName ?? event.protocolId ?? 'Protocol'} · exact token ${event.mint ?? 'not recorded'}`,
                href: './monitor.html#defiChangesSection'
            });
        }
        for (const mint of Array.isArray(changes?.newMints) ? changes.newMints : []) {
            items.push({
                date: mint.firstSeenAt ?? null,
                type: 'Newly observed',
                title: `${mint.symbol ?? mint.name ?? 'Token'} entered the catalogue`,
                detail: `${mint.issuerName ?? humanizeSlug(mint.issuer) ?? 'Unknown issuer'} · newly observed, not necessarily newly issued`,
                href: mint.cardSlug ? `./cards/${mint.cardSlug}.html` : `./cards/${cardSlug(mint.symbol, mint.mint)}.html`
            });
        }
        for (const event of Array.isArray(changes?.events) ? changes.events : []) {
            items.push({
                date: event.date ?? null,
                type: humanizeSlug(event.kind) ?? 'Issuer event',
                title: event.summary ?? event.title ?? 'Issuer event recorded',
                detail: humanizeSlug(event.issuer) ?? 'Issuer dossier',
                href: event.issuer ? `./stocks.html#issuer-${encodeURIComponent(event.issuer)}` : './monitor.html#eventsSection'
            });
        }
        return items.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? ''))).slice(0, limit);
    }

    const exported = { finite, orderedRows, metricDelta, issuerDeltas, chartModel, recentUpdates };
    if (typeof document === 'undefined') return exported;

    function signed(value) {
        if (value === null) return '—';
        return `${value >= 0 ? '+' : '−'}${fmtNumber(Math.abs(value))}`;
    }

    function svgChart(rows, key, { hero = false, label = '' } = {}) {
        const model = chartModel(rows, key, hero ? 560 : 340, hero ? 230 : 112);
        if (model.points.length === 0) return '<p class="empty-state">No daily observations yet.</p>';
        const line = model.points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
        const first = model.points[0];
        const last = model.points.at(-1);
        const floor = model.height - model.padding.bottom;
        const area = `${first.x},${floor} ${line} ${last.x},${floor}`;
        const labels = model.points.map((point, index) => {
            const show = hero || index === 0 || index === model.points.length - 1;
            return show ? `<g><circle class="chart-dot" cx="${point.x}" cy="${point.y}" r="4" />`
                + `<text class="chart-axis" x="${point.x}" y="${model.height - 7}" text-anchor="middle">${escapeHtml(fmtDate(point.date))}</text>`
                + `${hero ? `<text class="chart-value" x="${point.x}" y="${Math.max(13, point.y - 11)}" text-anchor="middle">${escapeHtml(fmtNumber(point.value))}</text>` : ''}</g>` : '';
        }).join('');
        return `<svg class="chart-svg" viewBox="0 0 ${model.width} ${model.height}" role="img" aria-label="${escapeHtml(label)}">
            <defs><linearGradient id="chartWash" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--violet)" stop-opacity=".22"/><stop offset="1" stop-color="var(--violet)" stop-opacity="0"/></linearGradient></defs>
            <line class="chart-grid" x1="${model.padding.left}" y1="${floor}" x2="${model.width - model.padding.right}" y2="${floor}" />
            <polygon class="chart-area" points="${area}"/><polyline class="chart-line" points="${line}"/>${labels}</svg>`;
    }

    function setText(id, value) {
        const element = document.getElementById(id);
        if (element) element.textContent = value;
    }

    async function getJson(url) {
        const response = await fetch(url, { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        return response.json();
    }

    function renderOverview(overview, health) {
        const rows = orderedRows(overview);
        const tokens = metricDelta(rows, 'tokenCount');
        const holders = metricDelta(rows, 'holderAccounts');
        const volume = metricDelta(rows, 'volume24Usd');
        const latest = rows.at(-1);
        setText('tokenTotal', fmtNumber(tokens.latest));
        setText('tokenDelta', tokens.delta === null ? 'First observation' : `${signed(tokens.delta)} since previous snapshot`);
        setText('catalogueValue', fmtNumber(tokens.latest));
        setText('holdersValue', fmtNumber(holders.latest));
        setText('volumeValue', fmtMoney(volume.latest));
        setText('holdersCoverage', latest ? `${fmtNumber(latest.holderCoverage)} / ${fmtNumber(latest.tokenCount)} mints measured` : '—');
        setText('volumeCoverage', latest ? `${fmtNumber(latest.volumeCoverage)} / ${fmtNumber(latest.tokenCount)} mints measured` : '—');
        setText('freshnessLine', latest ? `Latest daily observation ${fmtDate(latest.date)} · API build ${fmtDate(health?.latestBuildAt)}` : 'No daily observation available');
        document.getElementById('tokenChart').innerHTML = svgChart(rows, 'tokenCount', { hero: true, label: 'Catalogued Solana token addresses by daily observation' });
        document.getElementById('catalogueChart').innerHTML = svgChart(rows, 'tokenCount', { label: 'Catalogue size by day' });
        document.getElementById('holdersChart').innerHTML = svgChart(rows, 'holderAccounts', { label: 'Summed token holding accounts by day' });
        document.getElementById('volumeChart').innerHTML = svgChart(rows, 'volume24Usd', { label: 'Reported rolling 24-hour volume by day' });
        const deltas = issuerDeltas(rows);
        document.getElementById('issuerDelta').innerHTML = deltas.length === 0
            ? '<span class="delta-pill">No issuer-level catalogue change</span>'
            : deltas.map((row) => `<span class="delta-pill"><strong>${escapeHtml(humanizeSlug(row.issuer))}</strong> ${escapeHtml(signed(row.delta))}</span>`).join('');
        const methodology = overview?.methodology ?? {};
        document.getElementById('methodologyText').innerHTML = Object.values(methodology)
            .map((text) => `<p>${escapeHtml(text)}</p>`).join('');
    }

    function renderUpdates(items) {
        const target = document.getElementById('updateFeed');
        if (items.length === 0) {
            target.innerHTML = '<p class="empty-state">No dated observations are published yet.</p>';
            return;
        }
        target.innerHTML = items.map((item) => `<article class="update-item">
            <div class="update-meta"><span>${escapeHtml(item.type)}</span><time>${escapeHtml(fmtDate(item.date))}</time></div>
            <h3><a href="${escapeHtml(item.href)}">${escapeHtml(item.title)}</a></h3><p>${escapeHtml(item.detail)}</p>
        </article>`).join('');
    }

    async function boot() {
        const api = (typeof __rwaApi !== 'undefined') ? __rwaApi : null;
        try {
            const base = api ? api.apiBase(document, window.location) : '';
            const [overview, health, changes, defi] = await Promise.all([
                getJson(api ? api.apiUrl('/api/history/overview', null, base) : '/api/history/overview'),
                getJson(api ? api.apiUrl('/api/health', null, base) : '/api/health'),
                getJson('./stocks-changes.json'),
                getJson('./stocks-defi-changes.json')
            ]);
            renderOverview(overview, health);
            renderUpdates(recentUpdates(changes, defi));
        } catch (error) {
            console.error(`[${new Date().toISOString()}] landing: data unavailable`, error);
            setText('freshnessLine', 'Live data is temporarily unavailable; the analytics workspace remains accessible.');
            setText('tokenDelta', 'Data unavailable');
            renderUpdates([]);
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
    return exported;
}));
