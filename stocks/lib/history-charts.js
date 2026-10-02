(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.__rwaHistoryCharts = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const METRICS = {
        premium_pct: { label: 'Premium / discount', unit: '%', source: 'premium_pct' },
        liquidity: { label: 'DEX liquidity', unit: '$', source: 'liquidity' },
        vol24: { label: 'Rolling 24h volume', unit: '$', source: 'vol24' },
        holder_count: { label: 'Holder accounts', unit: '', source: 'holder_count' },
        supply_ui: { label: 'Displayed token supply', unit: '', source: 'supply_ui' },
        market_value_usd: { label: 'Observed market value', unit: '$', source: 'market_value_usd' }
    };
    const COLORS = ['#7c3aed', '#0284c7', '#16a34a', '#ea580c', '#dc2626', '#0f766e', '#a21caf'];

    function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    function n(value) { if (value === null || value === undefined || value === '') return null; const out = Number(value); return Number.isFinite(out) ? out : null; }
    function dateOf(row) { return String(row.snapshot_date ?? row.date ?? '').slice(0, 10); }
    function series(rows, metric, key = (row) => row.issuer ?? row.symbol ?? row.mint ?? 'Token') {
        const groups = new Map();
        for (const row of Array.isArray(rows) ? rows : []) {
            const value = n(row[metric]); const date = dateOf(row); const label = String(key(row) ?? 'Token');
            if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
            if (!groups.has(label)) groups.set(label, []);
            groups.get(label).push({ date, value });
        }
        return [...groups].map(([label, points]) => ({ label, points: points.sort((a, b) => a.date.localeCompare(b.date)) }));
    }
    function format(value, metric) {
        if (!Number.isFinite(value)) return '—';
        const unit = METRICS[metric]?.unit;
        if (unit === '$') return '$' + Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
        if (unit === '%') return value.toFixed(2) + '%';
        return Intl.NumberFormat('en', { notation: Math.abs(value) >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
    }
    function render(rows, events, metric, options = {}) {
        const sets = series(rows, metric, options.key);
        const points = sets.flatMap((set) => set.points);
        if (!points.length) return '<p class="history-empty">No measured observations for this metric yet.</p>';
        const dates = [...new Set(points.map((point) => point.date))].sort();
        let min = Math.min(...points.map((point) => point.value)); let max = Math.max(...points.map((point) => point.value));
        if (min === max) { const pad = Math.abs(min || 1) * .08; min -= pad; max += pad; }
        const W = 760, H = 250, L = 58, R = 16, T = 18, B = 38;
        const x = (date) => L + (dates.length === 1 ? (W - L - R) / 2 : dates.indexOf(date) / (dates.length - 1) * (W - L - R));
        const y = (value) => T + (max - value) / (max - min) * (H - T - B);
        const grid = [0, .5, 1].map((fraction) => { const value = max - (max - min) * fraction; const yy = T + fraction * (H - T - B); return `<line x1="${L}" y1="${yy}" x2="${W - R}" y2="${yy}"/><text x="${L - 7}" y="${yy + 4}" text-anchor="end">${esc(format(value, metric))}</text>`; }).join('');
        const lines = sets.map((set, i) => `<g style="--series:${COLORS[i % COLORS.length]}"><path d="${set.points.map((point, j) => `${j ? 'L' : 'M'}${x(point.date).toFixed(1)},${y(point.value).toFixed(1)}`).join(' ')}"/>${set.points.map((point) => `<circle cx="${x(point.date).toFixed(1)}" cy="${y(point.value).toFixed(1)}" r="3"><title>${esc(set.label)} · ${point.date} · ${esc(format(point.value, metric))}</title></circle>`).join('')}</g>`).join('');
        const start = dates[0], end = dates[dates.length - 1];
        const markers = (Array.isArray(events) ? events : []).map((event) => {
            const date = String(event.detected_at ?? '').slice(0, 10); if (date < start || date > end || !dates.includes(date)) return '';
            return `<line class="history-event history-event-${esc(event.severity)}" x1="${x(date)}" y1="${T}" x2="${x(date)}" y2="${H - B}"><title>${esc(date)} · ${esc(event.summary ?? event.kind)}</title></line>`;
        }).join('');
        const legend = sets.map((set, i) => `<span><i style="--series:${COLORS[i % COLORS.length]}"></i>${esc(set.label)}</span>`).join('');
        return `<div class="history-legend">${legend}<span class="history-event-key"><i></i>evidence/control change</span></div><svg class="history-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(METRICS[metric]?.label ?? metric)} history"><g class="history-grid">${grid}</g>${markers}<g class="history-lines">${lines}</g><text x="${L}" y="${H - 10}">${start}</text><text x="${W - R}" y="${H - 10}" text-anchor="end">${end}</text></svg>`;
    }
    function optionsHtml(selected = 'premium_pct') {
        return Object.entries(METRICS).map(([id, value]) => `<option value="${id}"${id === selected ? ' selected' : ''}>${esc(value.label)}</option>`).join('');
    }
    return { METRICS, series, format, render, optionsHtml };
}));
