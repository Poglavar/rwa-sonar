/**
 * Renders the live collector inventory on methodology.html. Freshness is evaluated against a
 * caller-provided clock in the pure section, so tests never depend on when they happen to run.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.__methodology = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const escapeHtml = (value) => String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    function ageHours(timestamp, now) {
        const then = Date.parse(timestamp);
        if (!Number.isFinite(then) || !Number.isFinite(now)) return null;
        return Math.max(0, (now - then) / 3_600_000);
    }

    function freshness(row, now) {
        const age = ageHours(row?.observedAt, now);
        const cadence = Number(row?.cadenceHours);
        if (age === null || !Number.isFinite(cadence) || cadence <= 0) {
            return { status: 'unknown', label: 'Not available', ageHours: age };
        }
        // The public summary is rebuilt every six hours even when a collector runs hourly.
        const currentWindow = Math.max(cadence * 2, 12);
        const delayedWindow = Math.max(cadence * 4, 24);
        if (age <= currentWindow) return { status: 'current', label: 'Within reporting window', ageHours: age };
        if (age <= delayedWindow) return { status: 'delayed', label: 'Delayed', ageHours: age };
        return { status: 'stale', label: 'Stale', ageHours: age };
    }

    function ageLabel(hours) {
        if (!Number.isFinite(hours)) return 'time unavailable';
        if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min ago`;
        if (hours < 48) return `${Math.round(hours)} h ago`;
        return `${Math.round(hours / 24)} d ago`;
    }

    function cadenceLabel(hours) {
        if (hours === 1) return 'hourly';
        if (hours === 3) return 'every 3 hours';
        if (hours === 6) return 'every 6 hours';
        if (hours === 24) return 'daily';
        return `every ${hours} hours`;
    }

    function collectorCardHtml(row, now) {
        const state = freshness(row, now);
        const coverage = Number.isFinite(Number(row?.coverage))
            ? `${Number(row.coverage).toLocaleString('en-US')} ${row.unit ?? 'records'}` : 'coverage unavailable';
        const failures = Number(row?.failures);
        const failureText = Number.isFinite(failures) && failures > 0 ? ` · ${failures} failures` : '';
        return `<article class="collector-card collector-${state.status}">`
            + `<div class="collector-card-head"><h3>${escapeHtml(row?.label)}</h3>`
            + `<span>${escapeHtml(state.label)}</span></div>`
            + `<p class="collector-time"><strong>${escapeHtml(ageLabel(state.ageHours))}</strong> · expected ${escapeHtml(cadenceLabel(Number(row?.cadenceHours)))}</p>`
            + `<p>${escapeHtml(row?.source)}</p>`
            + `<p class="collector-coverage">${escapeHtml(coverage + failureText)}</p></article>`;
    }

    function apiHealthHtml(health) {
        if (!health?.ok) return '<strong>API status unavailable.</strong> The static methodology remains valid; live database freshness could not be read.';
        const tokens = Number(health.counts?.tokens);
        const built = health.latestBuildAt ? new Date(health.latestBuildAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) : 'unknown';
        return `<strong>Database API online.</strong> ${Number.isFinite(tokens) ? tokens.toLocaleString('en-US') : 'Unknown number of'} token records; latest loaded build ${escapeHtml(built)} UTC. API availability is reported separately from collector freshness above.`;
    }

    async function fetchJson(url) {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`${response.status} ${url}`);
        return response.json();
    }

    async function boot() {
        const grid = document.getElementById('collectorGrid');
        const summary = document.getElementById('collectorSummary');
        const apiLine = document.getElementById('apiHealth');
        const api = typeof __rwaApi !== 'undefined' ? __rwaApi : null;
        try {
            const artifact = await fetchJson('./stocks-collector-status.json');
            const now = Date.now();
            const rows = Array.isArray(artifact.collectors) ? artifact.collectors : [];
            grid.innerHTML = rows.map((row) => collectorCardHtml(row, now)).join('');
            const states = rows.map((row) => freshness(row, now).status);
            const current = states.filter((status) => status === 'current').length;
            summary.textContent = `${current}/${rows.length} collectors are within their public reporting window. “Delayed” and “stale” are data states, not hidden as passes.`;
        } catch (error) {
            grid.innerHTML = '<p class="load-error">Collector status could not be loaded. The cadence and limitations below remain the authoritative methodology.</p>';
            summary.textContent = `Live status unavailable: ${error.message}`;
        }
        if (!apiLine) return;
        try {
            const health = await fetchJson(api ? api.apiUrl('/api/health') : '/api/health');
            apiLine.innerHTML = apiHealthHtml(health);
        } catch {
            apiLine.innerHTML = apiHealthHtml(null);
        }
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
        else boot();
    }

    return { ageHours, freshness, ageLabel, cadenceLabel, collectorCardHtml, apiHealthHtml };
}));
