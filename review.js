(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.__reviewQueue = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
    const AREAS = ['ownership', 'insolvency', 'redemption', 'control', 'defi', 'other'];
    const ISSUE_LABELS = {
        changed: 'Changed source', 'source-gone': 'Source gone', conflict: 'Conflict', missing: 'Missing',
        unsupported: 'Unsupported', stale: 'Stale', 'open-question': 'Open question',
        'discovery-candidate': 'Candidate asset'
    };

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }

    function safeUrl(value) {
        if (typeof value !== 'string') return null;
        if (value.startsWith('./')) return value;
        try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? value : null; } catch { return null; }
    }

    function matches(entry, filters = {}) {
        if (filters.priority && entry.priority !== filters.priority) return false;
        if (filters.area && entry.area !== filters.area) return false;
        if (filters.issue && entry.issue !== filters.issue) return false;
        if (filters.issuer && entry.issuerSlug !== filters.issuer) return false;
        const query = String(filters.query ?? '').trim().toLowerCase();
        if (!query) return true;
        return [entry.title, entry.detail, entry.action, entry.issuerName, entry.field]
            .some((value) => String(value ?? '').toLowerCase().includes(query));
    }

    function itemHtml(entry) {
        const href = safeUrl(entry.href);
        const source = safeUrl(entry.sourceUrl);
        const observed = entry.observedAt ? `<time datetime="${escapeHtml(entry.observedAt)}">${escapeHtml(entry.observedAt.slice(0, 10))}</time>` : 'No check date';
        return `<li class="review-item" data-priority="${escapeHtml(entry.priority)}">` +
            `<span class="review-priority">${escapeHtml(entry.priority)}</span><div class="review-copy">` +
            `<div class="review-tags"><span>${escapeHtml(entry.area)}</span><span>${escapeHtml(ISSUE_LABELS[entry.issue] ?? entry.issue)}</span></div>` +
            `<h3>${escapeHtml(entry.title)}</h3><p>${escapeHtml(entry.detail)}</p>` +
            `<p class="review-action"><strong>Next:</strong> ${escapeHtml(entry.action)}</p></div>` +
            `<div class="review-meta"><strong>${escapeHtml(entry.issuerName)}</strong>${observed}` +
            `${href ? `<a href="${escapeHtml(href)}">Open dossier →</a>` : ''}${source ? `<a href="${escapeHtml(source)}" rel="noreferrer">Open source ↗</a>` : ''}</div></li>`;
    }

    function summaryHtml(summary) {
        return PRIORITIES.map((priority) => `<article data-priority="${priority}"><strong>${Number(summary?.byPriority?.[priority] ?? 0).toLocaleString()}</strong><span>${priority} items</span></article>`).join('');
    }

    function optionHtml(value, label = value) { return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`; }

    async function boot() {
        const status = document.getElementById('queueStatus');
        try {
            const response = await fetch('./stocks-review-queue.json');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const artifact = await response.json();
            const items = Array.isArray(artifact.items) ? artifact.items : [];
            document.getElementById('prioritySummary').innerHTML = summaryHtml(artifact.summary);
            const controls = {
                priority: document.getElementById('priorityFilter'), area: document.getElementById('areaFilter'),
                issue: document.getElementById('issueFilter'), issuer: document.getElementById('issuerFilter'),
                query: document.getElementById('queueSearch')
            };
            controls.priority.insertAdjacentHTML('beforeend', PRIORITIES.map((value) => optionHtml(value)).join(''));
            controls.area.insertAdjacentHTML('beforeend', AREAS.map((value) => optionHtml(value)).join(''));
            const issues = [...new Set(items.map((entry) => entry.issue))].sort();
            controls.issue.insertAdjacentHTML('beforeend', issues.map((value) => optionHtml(value, ISSUE_LABELS[value] ?? value)).join(''));
            const issuers = [...new Map(items.map((entry) => [entry.issuerSlug, entry.issuerName])).entries()].filter(([slug]) => slug).sort((a, b) => a[1].localeCompare(b[1]));
            controls.issuer.insertAdjacentHTML('beforeend', issuers.map(([value, label]) => optionHtml(value, label)).join(''));
            const render = () => {
                const selected = { priority: controls.priority.value, area: controls.area.value, issue: controls.issue.value, issuer: controls.issuer.value, query: controls.query.value };
                const visible = items.filter((entry) => matches(entry, selected));
                document.getElementById('reviewQueue').innerHTML = visible.map(itemHtml).join('');
                document.getElementById('visibleCount').textContent = `${visible.length} of ${items.length} open items`;
                document.getElementById('queueEmpty').hidden = visible.length !== 0;
            };
            for (const control of Object.values(controls)) control.addEventListener(control.tagName === 'INPUT' ? 'input' : 'change', render);
            render();
            status.textContent = `${items.length} open items · generated ${artifact.generatedAt ? new Date(artifact.generatedAt).toLocaleString() : 'at an unknown time'}.`;
        } catch (error) {
            status.textContent = `The review queue could not be loaded: ${error.message}`;
        }
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
        else boot();
    }
    return { PRIORITIES, AREAS, ISSUE_LABELS, escapeHtml, safeUrl, matches, itemHtml, summaryHtml };
}));
