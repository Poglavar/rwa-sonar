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
        'discovery-candidate': 'Candidate asset', 'defi-integration-candidate': 'Possible DeFi integration', 'reviewed-inference': 'Reviewed inference'
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

    function resolutionFormHtml(entry, history = []) {
        const rows = history.map((row) => `<li><strong>${escapeHtml(row.resolution)}</strong> · ${escapeHtml(row.reviewer)} · ${escapeHtml(new Date(row.createdAt).toLocaleString())}<br>${escapeHtml(row.note)}</li>`).join('');
        return `<form class="resolution-form" data-item-id="${escapeHtml(entry.id)}">` +
            `<label>Decision<select name="resolution"><option value="confirmed">Confirmed</option><option value="corrected">Corrected</option><option value="superseded">Superseded</option><option value="false-alarm">False alarm</option><option value="deferred">Defer</option></select></label>` +
            `<label>Reviewer<input name="reviewer" maxlength="120" required></label>` +
            `<label>Decision note<textarea name="note" minlength="3" maxlength="4000" required></textarea></label><button type="submit">Record</button></form>` +
            (rows ? `<ol class="resolution-history">${rows}</ol>` : '');
    }

    function evidenceStateHtml(entry) {
        const states = [
            ['Retrieval', entry.retrievalState],
            ['Content comparison', entry.contentComparisonState],
            ['Analyst review', entry.analystReviewState],
            ['Conclusion validity', entry.conclusionValidityState]
        ];
        return `<dl class="review-state">${states.map(([label, value]) =>
            `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || 'unknown')}</dd></div>`).join('')}</dl>`;
    }

    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const PRIORITY_TONES = { P0: 'critical', P1: 'caution', P2: 'info' };

    /** "23 Sep 2026" from an ISO date or instant (UTC calendar day); null when there is none. */
    function shortDate(value) {
        const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
        if (!match || !MONTHS[Number(match[2]) - 1]) return null;
        return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
    }

    /** The id a row carries, so #review-<id> opens it. */
    function itemAnchor(entry) {
        return entry?.id ? `review-${String(entry.id).replace(/[^A-Za-z0-9_-]/g, '-')}` : null;
    }

    // One row per item: line 1 is when, how serious and what; line 2 whose programme and what it
    // could change. The full item (evidence states, diff, next step, links, editor form) opens below;
    // links live in the opened part, so a click on the row only toggles.
    function itemHtml(entry, options = {}) {
        const href = safeUrl(entry.href);
        const source = safeUrl(entry.sourceUrl);
        const observed = entry.observedAt ? `<time datetime="${escapeHtml(entry.observedAt)}">${escapeHtml(entry.observedAt.slice(0, 10))}</time>` : 'No check date';
        const affected = Array.isArray(entry.affectedConclusions) && entry.affectedConclusions.length
            ? `<p class="review-affected"><strong>Affected conclusions:</strong> ${escapeHtml(entry.affectedConclusions.join(' · '))}</p>` : '';
        const anchor = itemAnchor(entry);
        const tone = PRIORITY_TONES[entry.priority];
        const consequence = [entry.issuerName, entry.claimImpact || entry.detail].filter(Boolean).join(' · ');
        return `<li${anchor ? ` id="${escapeHtml(anchor)}"` : ''} class="fold-row review-item${tone ? ` fold-${tone}` : ''}${options.target ? ' fold-target' : ''}" data-priority="${escapeHtml(entry.priority)}">` +
            `<details${options.open || options.target ? ' open' : ''}><summary>` +
            `<span class="fold-line1">${escapeHtml(shortDate(entry.observedAt) ?? 'No check date')} · <span class="review-priority">${escapeHtml(entry.priority)}</span> ` +
            `<strong class="fold-title">${escapeHtml(entry.title)}</strong></span>` +
            `${consequence ? `<span class="fold-line2">${escapeHtml(consequence)}</span>` : ''}</summary>` +
            `<div class="fold-body review-body"><div class="review-copy">` +
            `<div class="review-tags"><span>${escapeHtml(entry.area)}</span><span>${escapeHtml(ISSUE_LABELS[entry.issue] ?? entry.issue)}</span></div>` +
            `<p>${escapeHtml(entry.detail)}</p>` +
            `${entry.claimImpact ? `<p class="review-impact"><strong>Claim impact:</strong> ${escapeHtml(entry.claimImpact)}</p>` : ''}` +
            affected +
            evidenceStateHtml(entry) +
            `${entry.previousText || entry.currentText ? `<div class="review-diff"><div><strong>Previous recorded value</strong>${escapeHtml(entry.previousText ?? 'Not recorded')}</div><div><strong>Current recorded value</strong>${escapeHtml(entry.currentText ?? 'Not recorded')}</div></div>` : ''}` +
            `<p class="review-action"><strong>Next:</strong> ${escapeHtml(entry.action)}</p>` +
            `${entry.resolutionCriteria ? `<p class="review-resolution"><strong>Resolution criteria:</strong> ${escapeHtml(entry.resolutionCriteria)}</p>` : ''}</div>` +
            `<div class="review-meta"><strong>${escapeHtml(entry.issuerName)}</strong>${observed}` +
            `${href ? `<a href="${escapeHtml(href)}">Open dossier →</a>` : ''}${source ? `<a href="${escapeHtml(source)}" rel="noreferrer">Open source ↗</a>` : ''}</div>` +
            `${options.editor ? resolutionFormHtml(entry, options.history ?? []) : ''}</div></details></li>`;
    }

    function summaryHtml(summary) {
        return PRIORITIES.map((priority) => `<article data-priority="${priority}"><strong>${Number(summary?.byPriority?.[priority] ?? 0).toLocaleString()}</strong><span>${priority} items</span></article>`).join('');
    }

    function optionHtml(value, label = value) { return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`; }

    async function boot() {
        const status = document.getElementById('queueStatus');
        let editor = false;
        let token = sessionStorage.getItem('rwa-review-token') || '';
        let reviewer = sessionStorage.getItem('rwa-reviewer') || '';
        let history = [];
        let targetShown = false;
        const api = typeof globalThis !== 'undefined' ? globalThis.__rwaApi : null;
        const apiUrl = (path) => api ? api.apiUrl(path, null, api.apiBase()) : path;
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
            const requested = new URLSearchParams(location.search);
            for (const name of ['priority', 'area', 'issue', 'issuer']) {
                const value = requested.get(name);
                if (value && [...controls[name].options].some((option) => option.value === value)) controls[name].value = value;
            }
            const render = () => {
                const selected = { priority: controls.priority.value, area: controls.area.value, issue: controls.issue.value, issuer: controls.issuer.value, query: controls.query.value };
                const visible = items.filter((entry) => matches(entry, selected));
                const byItem = new Map();
                for (const row of history) {
                    if (!byItem.has(row.itemId)) byItem.set(row.itemId, []);
                    byItem.get(row.itemId).push(row);
                }
                const queue = document.getElementById('reviewQueue');
                // A filter keystroke or a recorded decision re-renders the list; rows the reader opened stay open.
                const opened = new Set([...queue.querySelectorAll('li.fold-row > details[open]')].map((details) => details.parentElement.id));
                // The row a #review-<id> link names opens (and scrolls into view) once; later renders keep the reader's choice.
                const target = targetShown ? '' : location.hash.slice(1);
                queue.innerHTML = visible.map((entry) => itemHtml(entry, {
                    editor, history: byItem.get(entry.id) ?? [], open: opened.has(itemAnchor(entry)), target: target !== '' && target === itemAnchor(entry)
                })).join('');
                if (target && !targetShown) {
                    const row = document.getElementById(target);
                    if (row) { targetShown = true; row.scrollIntoView({ block: 'center' }); }
                }
                if (editor) {
                    document.querySelectorAll('.resolution-form').forEach((form) => {
                        form.elements.reviewer.value = reviewer;
                        form.addEventListener('submit', async (event) => {
                            event.preventDefault();
                            const submit = form.querySelector('button');
                            submit.disabled = true; submit.textContent = 'Saving…';
                            try {
                                const response = await fetch(apiUrl('/api/review/resolutions'), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ itemId: form.dataset.itemId, resolution: form.elements.resolution.value, reviewer: form.elements.reviewer.value, note: form.elements.note.value }) });
                                const body = await response.json();
                                if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
                                history.unshift(body.item); reviewer = form.elements.reviewer.value.trim(); sessionStorage.setItem('rwa-reviewer', reviewer); render();
                            } catch (error) { submit.disabled = false; submit.textContent = error.message; }
                        });
                    });
                }
                document.getElementById('visibleCount').textContent = `${visible.length} of ${items.length} open items`;
                document.getElementById('queueEmpty').hidden = visible.length !== 0;
            };
            for (const control of Object.values(controls)) control.addEventListener(control.tagName === 'INPUT' ? 'input' : 'change', render);
            render();
            status.textContent = `${items.length} open items · generated ${artifact.generatedAt ? new Date(artifact.generatedAt).toLocaleString() : 'at an unknown time'}.`;

            const panel = document.getElementById('editorPanel');
            const editorStatus = document.getElementById('editorStatus');
            const unlock = async (candidate, name) => {
                const response = await fetch(apiUrl('/api/review/resolutions'), { headers: { authorization: `Bearer ${candidate}` }, cache: 'no-store' });
                const body = await response.json();
                if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
                token = candidate; reviewer = name; history = body.items ?? []; editor = true;
                sessionStorage.setItem('rwa-review-token', token); sessionStorage.setItem('rwa-reviewer', reviewer);
                editorStatus.textContent = `Workbench unlocked · ${history.length} recorded decisions loaded.`; render();
            };
            document.getElementById('editorToggle').addEventListener('click', (event) => { panel.hidden = !panel.hidden; event.currentTarget.setAttribute('aria-expanded', String(!panel.hidden)); });
            document.getElementById('editorLogin').addEventListener('submit', async (event) => {
                event.preventDefault(); editorStatus.textContent = 'Checking access…';
                try { await unlock(document.getElementById('editorToken').value, document.getElementById('editorName').value.trim()); }
                catch (error) { editorStatus.textContent = error.message; }
            });
            if (new URLSearchParams(location.search).has('editor')) panel.hidden = false;
            if (token && reviewer) { panel.hidden = false; unlock(token, reviewer).catch(() => { sessionStorage.removeItem('rwa-review-token'); }); }
        } catch (error) {
            status.textContent = `The review queue could not be loaded: ${error.message}`;
        }
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
        else boot();
    }
    return { PRIORITIES, AREAS, ISSUE_LABELS, escapeHtml, safeUrl, matches, shortDate, itemAnchor, itemHtml, evidenceStateHtml, resolutionFormHtml, summaryHtml };
}));
