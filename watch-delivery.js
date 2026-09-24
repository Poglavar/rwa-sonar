/*
 * "Get this on Telegram" on each saved watch the visitor OWNS: the focused-watch cards watch.js renders
 * into #savedWatchList (watch.html) and the saved comparisons stocks.js renders into
 * #personalComparisons (stocks.html). Request a one-time binding link, open the watch bot, poll until
 * the private chat is verified, then set the daily digest (on/off, hour, browser IANA timezone) or stop
 * it. Kept out of watch.js and stocks.js on purpose: it only decorates rows carrying data-watch-id,
 * using the owner key the page keeps in localStorage, and calls the owner-only
 * /api/watchlists/:id/delivery and /digest routes (a comparison is a watchlist like any other). A row
 * without an owner key in this browser, and the read-only shared views, get no controls at all.
 *
 * The pure half (deep-link parsing, the binding-flow state machine, digest settings validation,
 * the owner-key lookup per page, the poll plan and the copy) has no DOM, no fetch and no clock; it is exported for
 * watch-delivery-ui.test.js. UMD-wrapped (window.__watchDelivery) so it declares no globals.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.__watchDelivery = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const STORAGE_KEY = 'rwa-sonar-focused-watches-v1';
    /** stocks.js keeps comparison owner keys as { [ticker]: { watchId, watchKey, … } }. */
    const COMPARISON_STORAGE_KEY = 'rwa-sonar-server-watches-v1';
    /** The server's binding-link lifetime (api/src/lib/watch-delivery.js BINDING_TTL_MS). */
    const BINDING_TTL_MS = 15 * 60 * 1000;
    const POLL_INTERVAL_MS = 3000;
    const DEFAULT_HOUR = 6;
    const BOT_PATTERN = /^[A-Za-z0-9_]{5,32}$/;
    const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;

    // -----------------------------------------------------------------------
    // Pure section
    // -----------------------------------------------------------------------

    /** Only a watch the visitor owns (its owner key is stored here) may manage delivery. */
    function canManageDelivery(credential) {
        return Boolean(credential && typeof credential.watchKey === 'string' && credential.watchKey !== ''
            && typeof credential.watchId === 'string' && credential.watchId !== '');
    }

    /**
     * The stored owner credential for one watch, or null. watch.js stores an array of rows and
     * stocks.js an object keyed by ticker; both rows carry { watchId, watchKey }.
     */
    function storedCredential(stored, watchId) {
        if (!stored || typeof stored !== 'object' || typeof watchId !== 'string' || watchId === '') return null;
        const rows = Array.isArray(stored) ? stored : Object.values(stored);
        const row = rows.find((entry) => entry?.watchId === watchId) ?? null;
        return canManageDelivery(row) ? row : null;
    }

    /** `https://t.me/<bot>?start=<token>`, or null when either part is not what Telegram accepts. */
    function telegramDeepLink(botUsername, token) {
        const bot = typeof botUsername === 'string' ? botUsername.replace(/^@/, '') : '';
        if (!BOT_PATTERN.test(bot) || typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
        return `https://t.me/${bot}?start=${token}`;
    }

    /**
     * The bot and token of a binding URL the API returned, or null. Only an exact t.me deep link is
     * accepted, so a malformed or hostile response can never become an arbitrary link on the page.
     */
    function parseBindingUrl(raw) {
        if (typeof raw !== 'string') return null;
        const match = raw.match(/^https:\/\/t\.me\/([A-Za-z0-9_]{5,32})\?start=([A-Za-z0-9_-]{32,64})$/);
        if (!match) return null;
        return { bot: match[1], token: match[2], url: telegramDeepLink(match[1], match[2]) };
    }

    function isValidTimezone(zone) {
        if (typeof zone !== 'string' || zone.trim() === '') return false;
        try {
            new Intl.DateTimeFormat('en', { timeZone: zone }).format(0);
            return true;
        } catch (_) {
            return false;
        }
    }

    /** The browser's IANA zone (from Intl), or UTC when it reports nothing usable. */
    function browserTimezone(intl) {
        try {
            const zone = (intl ?? Intl).DateTimeFormat().resolvedOptions().timeZone;
            return isValidTimezone(zone) ? zone : 'UTC';
        } catch (_) {
            return 'UTC';
        }
    }

    /** The PUT /digest body, validated the way the API will: `{ ok, value }` or `{ ok:false, error }`. */
    function validateDigestSettings(input) {
        const enabled = input?.enabled;
        const hour = typeof input?.hour === 'string' && /^\d{1,2}$/.test(input.hour) ? Number(input.hour) : input?.hour;
        const timezone = typeof input?.timezone === 'string' ? input.timezone.trim() : input?.timezone;
        if (typeof enabled !== 'boolean') return { ok: false, error: 'Choose whether the digest is on or off.' };
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) return { ok: false, error: 'The digest hour must be 0–23.' };
        if (!isValidTimezone(timezone)) return { ok: false, error: 'The timezone must be an IANA zone such as Europe/Zagreb.' };
        return { ok: true, value: { enabled, hour, timezone } };
    }

    function formatHour(hour) {
        return `${String(hour).padStart(2, '0')}:00`;
    }

    /** One line for a verified chat: what arrives, and when. */
    function connectedLabel(digest) {
        if (!digest || digest.enabled !== true) return 'Connected. Daily digest is off.';
        return `Connected. Daily digest at ${formatHour(digest.hour)} ${digest.timezone}.`;
    }

    /**
     * The binding flow per watch. States:
     *   loading     — the first status request is in flight
     *   unavailable — the server has no watch bot configured
     *   idle        — no chat connected; offer "Get this on Telegram"
     *   requesting  — the link request is in flight
     *   pending     — a link exists; polling until the chat is verified or the link expires
     *   expired     — the link lapsed unused; offer a new one
     *   connected   — a private chat is verified; digest settings apply
     * Every state may carry `error` (the last failed action) without leaving the state.
     */
    function initialState() {
        return { phase: 'loading', status: null, link: null, error: null };
    }

    function fromStatus(state, status, nowMs) {
        if (!status || status.available !== true) return { ...state, phase: 'unavailable', status: status ?? null, error: null };
        if (status.bound === true) return { phase: 'connected', status, link: null, error: null };
        if (state.link && nowMs < state.link.deadlineMs) return { ...state, phase: 'pending', status, error: null };
        if (state.link) return { phase: 'expired', status, link: null, error: null };
        return { phase: 'idle', status, link: null, error: null };
    }

    function reduce(state, event) {
        switch (event.type) {
        case 'status':
            return fromStatus(state, event.status, event.nowMs);
        case 'request':
            return { ...state, phase: 'requesting', error: null };
        case 'link': {
            const parsed = parseBindingUrl(event.created?.url);
            if (!parsed) return { ...state, phase: 'idle', link: null, error: 'The server returned an unusable Telegram link.' };
            const expiresMs = Date.parse(event.created?.expiresAt);
            const cap = event.nowMs + BINDING_TTL_MS;
            const deadlineMs = Number.isFinite(expiresMs) ? Math.min(expiresMs, cap) : cap;
            return { ...state, phase: 'pending', link: { url: parsed.url, bot: parsed.bot, startedMs: event.nowMs, deadlineMs }, error: null };
        }
        case 'tick':
            return state.phase === 'pending' && event.nowMs >= state.link.deadlineMs
                ? { ...state, phase: 'expired', link: null } : state;
        case 'unbound':
            return { phase: 'idle', status: state.status ? { ...state.status, bound: false, digest: { ...state.status.digest, enabled: false } } : null, link: null, error: null };
        case 'fail':
            return { ...state, phase: state.phase === 'requesting' ? 'idle' : state.phase === 'loading' ? 'unavailable' : state.phase, error: event.message };
        default:
            return state;
        }
    }

    /** Whether to poll again, and when: only while a link is pending and before its deadline. */
    function nextPoll(state, nowMs) {
        if (state.phase !== 'pending' || !state.link) return null;
        const at = nowMs + POLL_INTERVAL_MS;
        return at <= state.link.deadlineMs ? at : null;
    }

    /** True exactly once: the poll that first sees the chat verified, after this page asked for a link. */
    function justConnected(previous, next) {
        return previous.phase === 'pending' && next.phase === 'connected';
    }

    /** Whether two states draw the same card, so a poll that changes nothing re-renders (and re-announces) nothing. */
    function sameView(a, b) {
        const view = (s) => JSON.stringify([s.phase, s.error, s.link, s.status?.available, s.status?.bot,
            s.status?.bound, s.status?.digest]);
        return view(a) === view(b);
    }

    const COPY = {
        heading: 'Daily digest on Telegram',
        contents: 'Once a day, one private Telegram message with this watch’s changes and the document or on-chain '
            + 'changes recorded for its target, each with its model assessment where a model has read it. A model '
            + 'assessment is not a legal conclusion. Nothing is sent on a day with no change.',
        comparisonContents: 'Once a day, one private Telegram message with this comparison’s material changes and the '
            + 'document or on-chain changes recorded for its compared issuers, each with its model assessment where a '
            + 'model has read it. A model assessment is not a legal conclusion. Nothing is sent on a day with no change.',
        privacy: 'We store only an encrypted Telegram chat id for this watch. We do not store your name, number or messages. '
            + 'Stop at any time here, or send /stop to the bot.',
        pending: 'Open Telegram and press Start in the chat with the bot. This page updates once you have. '
            + 'The link works once and expires after 15 minutes.',
        expired: 'That link expired unused. Request a new one.',
        unavailable: 'Telegram digests are not available on this server yet.'
    };

    /** The pages this control decorates: the owned list's id, where its owner keys live, and its copy. */
    const HOSTS = [
        { listId: 'savedWatchList', storageKey: STORAGE_KEY, subject: 'this watch', contents: COPY.contents },
        { listId: 'personalComparisons', storageKey: COMPARISON_STORAGE_KEY, subject: 'this comparison', contents: COPY.comparisonContents }
    ];

    const api = {
        STORAGE_KEY, COMPARISON_STORAGE_KEY, BINDING_TTL_MS, POLL_INTERVAL_MS, DEFAULT_HOUR, COPY, HOSTS,
        canManageDelivery, storedCredential, telegramDeepLink, parseBindingUrl, isValidTimezone, browserTimezone,
        validateDigestSettings, formatHour, connectedLabel, initialState, reduce, nextPoll, justConnected, sameView
    };

    // -----------------------------------------------------------------------
    // DOM section — only runs in a browser on watch.html or stocks.html.
    // -----------------------------------------------------------------------

    if (typeof document === 'undefined') return api;
    const host = HOSTS.find((entry) => document.getElementById(entry.listId)) ?? null;
    const list = host ? document.getElementById(host.listId) : null;
    const apiLib = typeof __rwaApi !== 'undefined' ? __rwaApi : null;
    if (!list || !apiLib) return api;

    const base = apiLib.apiBase();
    const zone = browserTimezone();
    const states = new Map();
    const timers = new Map();
    let leaving = false;

    function logError(message, detail) {
        console.error(`[${new Date().toISOString()}] watch-delivery: ${message}`, detail ?? '');
    }

    function credentialFor(watchId) {
        try {
            return storedCredential(JSON.parse(window.localStorage.getItem(host.storageKey) || 'null'), watchId);
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

    function cardFor(watchId) {
        return [...list.querySelectorAll('[data-watch-id]')].find((card) => card.dataset.watchId === watchId) ?? null;
    }

    function settingsControls(watchId, digest) {
        const wrap = el('div', { class: 'wat-tg-settings' });
        const enabledId = `tg-enabled-${watchId}`;
        const hourId = `tg-hour-${watchId}`;
        const toggle = el('label', { class: 'wat-tg-toggle', for: enabledId });
        const box = el('input', { type: 'checkbox', id: enabledId, 'data-tg-enabled': '' });
        box.checked = digest.enabled === true;
        toggle.append(box, document.createTextNode(' Send the daily digest'));
        const hourLabel = el('label', { for: hourId }, `Hour (${zone})`);
        const select = el('select', { id: hourId, 'data-tg-hour': '' });
        for (let hour = 0; hour < 24; hour += 1) {
            const option = el('option', { value: String(hour) }, formatHour(hour));
            if (hour === digest.hour) option.selected = true;
            select.append(option);
        }
        const hourField = el('span', { class: 'wat-tg-hour' });
        hourField.append(hourLabel, select);
        wrap.append(toggle, hourField);
        return wrap;
    }

    function render(watchId) {
        const card = cardFor(watchId);
        if (!card) return;
        const state = states.get(watchId) ?? initialState();
        const focused = document.activeElement && card.contains(document.activeElement)
            ? document.activeElement.getAttribute('data-tg-focus') : null;
        card.querySelector('[data-delivery]')?.remove();
        const box = el('section', { 'data-delivery': '', class: 'wat-tg', 'data-phase': state.phase, 'aria-label': COPY.heading });
        const line = el('p', { class: 'wat-tg-line', role: 'status' });
        const actions = el('div', { class: 'wat-tg-actions' });

        if (state.phase === 'loading') {
            line.textContent = 'Checking Telegram digest…';
        } else if (state.phase === 'unavailable') {
            line.textContent = state.error ? `Telegram digest status unavailable: ${state.error}` : COPY.unavailable;
        } else if (state.phase === 'idle' || state.phase === 'requesting' || state.phase === 'expired') {
            line.textContent = state.phase === 'expired' ? COPY.expired : `Get a daily digest of ${host.subject} from ${state.status?.bot ?? 'our bot'}.`;
            const button = el('button', { type: 'button', 'data-tg-bind': '', 'data-tg-focus': 'bind' },
                state.phase === 'requesting' ? 'Creating link…' : 'Get this on Telegram');
            if (state.phase === 'requesting') button.disabled = true;
            actions.append(button);
        } else if (state.phase === 'pending') {
            line.textContent = COPY.pending;
            actions.append(
                el('a', { class: 'wat-tg-open', href: state.link.url, target: '_blank', rel: 'noopener noreferrer', 'data-tg-open': '', 'data-tg-focus': 'open' },
                    `Open @${state.link.bot} in Telegram`),
                el('button', { type: 'button', 'data-tg-bind': '', 'data-tg-focus': 'bind' }, 'New link'));
            const until = new Date(state.link.deadlineMs);
            line.append(' ', el('span', { class: 'wat-muted' }, `Waiting until ${until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}…`));
        } else if (state.phase === 'connected') {
            line.textContent = connectedLabel(state.status.digest);
            box.append(line, settingsControls(watchId, state.status.digest));
            actions.append(el('button', { type: 'button', 'data-tg-unbind': '', 'data-tg-focus': 'unbind' }, 'Stop Telegram digests'));
        }
        if (state.phase !== 'connected') box.append(line);
        if (state.error && state.phase !== 'unavailable') box.append(el('p', { class: 'wat-tg-error', role: 'alert' }, state.error));
        if (actions.childNodes.length) box.append(actions);
        if (state.phase !== 'unavailable' && state.phase !== 'loading') {
            const about = el('details', { class: 'wat-tg-about' });
            about.append(el('summary', {}, 'What arrives, and what we store'), el('p', {}, host.contents), el('p', {}, COPY.privacy));
            box.append(about);
        }
        card.append(box);
        if (focused) box.querySelector(`[data-tg-focus="${focused}"]`)?.focus();
    }

    function dispatch(watchId, event) {
        const previous = states.get(watchId) ?? initialState();
        const next = reduce(previous, event);
        states.set(watchId, next);
        if (!sameView(previous, next) || !cardFor(watchId)?.querySelector('[data-delivery]')) render(watchId);
        return { previous, next };
    }

    function stopPolling(watchId) {
        clearTimeout(timers.get(watchId));
        timers.delete(watchId);
    }

    /** Polling a pending link is the one timer here: every 3 s, until verified, expired or navigated away. */
    function schedulePoll(watchId) {
        stopPolling(watchId);
        const state = states.get(watchId);
        const at = state ? nextPoll(state, Date.now()) : null;
        if (at === null) {
            if (state?.phase === 'pending') dispatch(watchId, { type: 'tick', nowMs: state.link.deadlineMs });
            return;
        }
        timers.set(watchId, setTimeout(() => poll(watchId), at - Date.now()));
    }

    async function poll(watchId) {
        timers.delete(watchId);
        const credential = credentialFor(watchId);
        if (leaving || !credential || !cardFor(watchId)) return; // deleted, or the page is going away
        try {
            const status = await request('GET', `/watchlists/${watchId}/delivery`, credential.watchKey);
            const { previous, next } = dispatch(watchId, { type: 'status', status, nowMs: Date.now() });
            if (justConnected(previous, next)) await enableAfterBinding(watchId, credential, next.status.digest);
        } catch (err) {
            logError(`status poll for ${watchId} failed`, err.message); // transient: keep polling to the deadline
        }
        schedulePoll(watchId);
    }

    /** The visitor asked for the digest by connecting, so turn it on in their own timezone. */
    async function enableAfterBinding(watchId, credential, digest) {
        await saveSettings(watchId, credential, { enabled: true, hour: digest?.hour ?? DEFAULT_HOUR, timezone: zone });
    }

    async function saveSettings(watchId, credential, input) {
        const checked = validateDigestSettings(input);
        if (!checked.ok) {
            dispatch(watchId, { type: 'fail', message: checked.error });
            return;
        }
        try {
            const status = await request('PUT', `/watchlists/${watchId}/digest`, credential.watchKey, checked.value);
            dispatch(watchId, { type: 'status', status, nowMs: Date.now() });
        } catch (err) {
            dispatch(watchId, { type: 'fail', message: err.message });
        }
    }

    async function load(watchId, credential) {
        try {
            const status = await request('GET', `/watchlists/${watchId}/delivery`, credential.watchKey);
            dispatch(watchId, { type: 'status', status, nowMs: Date.now() });
        } catch (err) {
            logError(`delivery status for ${watchId} failed`, err.message);
            dispatch(watchId, { type: 'fail', message: err.message });
        }
    }

    function decorate() {
        for (const card of list.querySelectorAll('[data-watch-id]')) {
            if (card.querySelector('[data-delivery]')) continue;
            const watchId = card.dataset.watchId;
            const credential = credentialFor(watchId);
            if (!credential) continue;
            render(watchId);
            if (!states.has(watchId)) {
                states.set(watchId, initialState());
                load(watchId, credential);
            }
        }
        for (const watchId of timers.keys()) if (!cardFor(watchId)) stopPolling(watchId); // deleted watch
    }

    list.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-delivery] button');
        const card = event.target.closest('[data-watch-id]');
        if (!button || !card) return;
        const watchId = card.dataset.watchId;
        const credential = credentialFor(watchId);
        if (!credential) return;
        if (button.hasAttribute('data-tg-bind')) {
            stopPolling(watchId);
            dispatch(watchId, { type: 'request' });
            try {
                const created = await request('POST', `/watchlists/${watchId}/delivery/telegram`, credential.watchKey);
                dispatch(watchId, { type: 'link', created, nowMs: Date.now() });
                cardFor(watchId)?.querySelector('[data-tg-open]')?.focus();
                schedulePoll(watchId);
            } catch (err) {
                dispatch(watchId, { type: 'fail', message: err.message });
            }
        } else if (button.hasAttribute('data-tg-unbind')) {
            button.disabled = true;
            try {
                await request('DELETE', `/watchlists/${watchId}/delivery`, credential.watchKey);
                dispatch(watchId, { type: 'unbound' });
            } catch (err) {
                dispatch(watchId, { type: 'fail', message: err.message });
            }
        }
    });

    list.addEventListener('change', (event) => {
        const control = event.target.closest('[data-tg-enabled], [data-tg-hour]');
        const card = event.target.closest('[data-watch-id]');
        if (!control || !card) return;
        const watchId = card.dataset.watchId;
        const credential = credentialFor(watchId);
        if (!credential || states.get(watchId)?.phase !== 'connected') return;
        const box = card.querySelector('[data-delivery]');
        saveSettings(watchId, credential, {
            enabled: box.querySelector('[data-tg-enabled]').checked,
            hour: box.querySelector('[data-tg-hour]').value,
            timezone: zone
        });
    });

    // Stop every poll when the page is left; a bfcache restore picks up again from the status.
    window.addEventListener('pagehide', () => {
        leaving = true;
        for (const watchId of [...timers.keys()]) stopPolling(watchId);
    });
    window.addEventListener('pageshow', (event) => {
        leaving = false;
        if (!event.persisted) return;
        for (const [watchId, state] of states) if (state.phase === 'pending') schedulePoll(watchId);
    });

    // watch.js and stocks.js replace the list's markup whenever it re-renders; re-decorate each time it does.
    new MutationObserver(decorate).observe(list, { childList: true });
    decorate();
    return api;
}));
