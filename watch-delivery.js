/*
 * Private Telegram morning digest controls on each saved focused-watch card (watch.html). Kept out
 * of watch.js on purpose: it only decorates the cards watch.js renders, using the owner key watch.js
 * keeps in localStorage, and calls the owner-only /api/watchlists/:id/delivery and /digest routes.
 * A card without an owner key in this browser gets no controls. The chat id never reaches the page.
 */
(function () {
    'use strict';

    const STORAGE_KEY = 'rwa-sonar-focused-watches-v1';
    const list = document.getElementById('savedWatchList');
    const apiLib = typeof window.__rwaApi !== 'undefined' ? window.__rwaApi : null;
    if (!list || !apiLib) return;
    const base = apiLib.apiBase();
    const statuses = new Map();
    const links = new Map();

    function ownerKey(watchId) {
        try {
            const rows = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]');
            const row = Array.isArray(rows) ? rows.find((entry) => entry?.watchId === watchId) : null;
            return row?.watchKey || null;
        } catch (_) {
            return null;
        }
    }

    async function request(method, path, key, body) {
        const headers = { Accept: 'application/json', 'X-Watch-Key': key };
        if (body) headers['Content-Type'] = 'application/json';
        const res = await fetch(apiLib.apiUrl(`/api${path}`, {}, base), {
            method, headers, cache: 'no-store', body: body ? JSON.stringify(body) : undefined
        });
        const payload = res.status === 204 ? null : await res.json().catch(() => null);
        if (!res.ok) throw new Error(payload?.error?.message || `HTTP ${res.status}`);
        return payload;
    }

    function el(tag, attrs, text) {
        const node = document.createElement(tag);
        for (const [name, value] of Object.entries(attrs || {})) node.setAttribute(name, value);
        if (text) node.textContent = text;
        return node;
    }

    function hourSelect(selected) {
        const select = el('select', { 'data-digest-hour': '', 'aria-label': 'Digest hour (UTC)' });
        for (let hour = 0; hour < 24; hour += 1) {
            const option = el('option', { value: String(hour) }, `${String(hour).padStart(2, '0')}:00 UTC`);
            if (hour === selected) option.selected = true;
            select.append(option);
        }
        return select;
    }

    function render(card, watchId) {
        card.querySelector('[data-delivery]')?.remove();
        const status = statuses.get(watchId);
        const box = el('div', { 'data-delivery': '', class: 'wat-saved-actions' });
        const note = el('p', { class: 'wat-muted', 'aria-live': 'polite' });
        if (!status) {
            note.textContent = 'Checking private digest delivery…';
        } else if (status.error && status.available === undefined) {
            note.textContent = `Digest delivery: ${status.error}`;
        } else if (!status.available) {
            note.textContent = 'A private Telegram morning digest is not available on this server yet.';
        } else if (!status.bound) {
            note.textContent = `Morning digest: connect a private Telegram chat with ${status.bot} first. `
                + 'The link works once and expires after 15 minutes.';
            box.append(el('button', { type: 'button', 'data-delivery-bind': '' }, 'Connect Telegram'));
            const link = links.get(watchId);
            if (link) {
                const anchor = el('a', { href: link, target: '_blank', rel: 'noopener' }, 'Open Telegram and press Start');
                box.append(anchor, el('button', { type: 'button', 'data-delivery-check': '' }, 'I pressed Start, check'));
            }
        } else {
            note.textContent = status.digest.enabled
                ? `Morning digest on: one Telegram message at ${String(status.digest.hour).padStart(2, '0')}:00 ${status.digest.timezone}, only on days with a material change.`
                : 'Telegram connected. The morning digest is off.';
            box.append(hourSelect(status.digest.hour),
                el('button', { type: 'button', 'data-digest-toggle': status.digest.enabled ? 'off' : 'on' },
                    status.digest.enabled ? 'Turn digest off' : 'Turn digest on'),
                el('button', { type: 'button', 'data-delivery-unbind': '' }, 'Disconnect Telegram'));
        }
        if (status?.error && status.available !== undefined) note.textContent += ` Last action failed: ${status.error}`;
        box.prepend(note);
        card.append(box);
    }

    async function refresh(card, watchId, key) {
        try {
            statuses.set(watchId, await request('GET', `/watchlists/${watchId}/delivery`, key));
        } catch (err) {
            statuses.set(watchId, { error: err.message });
        }
        if (card.isConnected) render(card, watchId);
    }

    function decorate() {
        for (const card of list.querySelectorAll('[data-watch-id]')) {
            if (card.querySelector('[data-delivery]')) continue;
            const watchId = card.dataset.watchId;
            const key = ownerKey(watchId);
            if (!key) continue;
            render(card, watchId);
            if (!statuses.has(watchId)) refresh(card, watchId, key);
        }
    }

    list.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-delivery] button');
        const card = event.target.closest('[data-watch-id]');
        if (!button || !card) return;
        const watchId = card.dataset.watchId;
        const key = ownerKey(watchId);
        if (!key) return;
        button.disabled = true;
        try {
            if (button.hasAttribute('data-delivery-bind')) {
                const created = await request('POST', `/watchlists/${watchId}/delivery/telegram`, key);
                links.set(watchId, created.url);
            } else if (button.hasAttribute('data-delivery-unbind')) {
                await request('DELETE', `/watchlists/${watchId}/delivery`, key);
                links.delete(watchId);
            } else if (button.hasAttribute('data-digest-toggle')) {
                const hour = Number(card.querySelector('[data-digest-hour]')?.value ?? 6);
                await request('PUT', `/watchlists/${watchId}/digest`, key,
                    { enabled: button.dataset.digestToggle === 'on', hour, timezone: 'UTC' });
            }
            await refresh(card, watchId, key);
        } catch (err) {
            statuses.set(watchId, { ...statuses.get(watchId), error: err.message });
            render(card, watchId);
        }
    });

    list.addEventListener('change', async (event) => {
        const select = event.target.closest('[data-digest-hour]');
        const card = event.target.closest('[data-watch-id]');
        if (!select || !card) return;
        const watchId = card.dataset.watchId;
        const status = statuses.get(watchId);
        const key = ownerKey(watchId);
        if (!key || !status?.digest?.enabled) return;
        try {
            await request('PUT', `/watchlists/${watchId}/digest`, key, { enabled: true, hour: Number(select.value), timezone: 'UTC' });
            await refresh(card, watchId, key);
        } catch (err) {
            statuses.set(watchId, { ...status, error: err.message });
            render(card, watchId);
        }
    });

    // watch.js replaces the list's markup whenever it re-renders; re-decorate each time it does.
    new MutationObserver(decorate).observe(list, { childList: true });
    decorate();
}());
