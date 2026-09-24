/*
 * The home page's "Latest events" box. The build wrote the newest rows into index.html; this swaps
 * in the live feed (GET /api/events, falling back to stocks-events.json), keeps the relative times
 * current and, when motion is allowed, scrolls the list slowly upward with a time-based
 * requestAnimationFrame step. The scroll pauses on hover, on keyboard focus and with the Pause
 * button, and stops while the tab is hidden or the box is off screen. With reduced motion (the media
 * query, `?reduceMotion` or the .reduce-motion hook) it is a static list of the newest six. Rows come
 * from stocks/lib/events-view.js, shared with the build-time snapshot.
 */
(function () {
    'use strict';
    if (typeof document === 'undefined') return;

    const view = window.__rwaEventsView;
    const api = window.__rwaApi ?? null;
    const section = document.getElementById('latestEvents');
    const list = document.getElementById('latestEventsList');
    const viewport = document.getElementById('latestEventsViewport');
    const toggle = document.getElementById('latestEventsToggle');
    const updated = document.getElementById('latestEventsUpdated');
    if (!view || !section || !list || !viewport) return;

    /** Rows in the scrolling list, rows in the static (reduced-motion) list. */
    const SCROLL_ROWS = 20;
    const STATIC_ROWS = 6;
    const AGE_REFRESH_MS = 60000;
    /** After the reader scrolls the box by hand, the automatic scroll follows rather than fights. */
    const HAND_SCROLL_QUIET_MS = 1500;
    /** The newest rows stay put this long after they arrive before the list starts to move. */
    const HOLD_AT_TOP_MS = 4000;

    const state = {
        motion: false, position: 0, last: null, frame: null, handScrollAt: -Infinity, holdUntil: 0,
        hover: false, focus: false, paused: false, hidden: document.hidden, onScreen: true
    };

    function logError(message, detail) {
        console.error(`[${new Date().toISOString()}] latest events: ${message}`, detail ?? '');
    }

    function reducedMotion() {
        return document.documentElement.classList.contains('reduce-motion')
            || new URLSearchParams(window.location.search).has('reduceMotion')
            || (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    function running() {
        return state.motion && !state.hover && !state.focus && !state.paused && !state.hidden && state.onScreen;
    }

    /** One copy of the list is this tall; the second copy starts where the first one ends. */
    function loopHeight() {
        const copy = list.querySelector('.event-row[aria-hidden="true"]');
        return copy ? copy.offsetTop - list.firstElementChild.offsetTop : 0;
    }

    function step(now) {
        state.frame = null;
        if (!running()) return;
        if (now - state.handScrollAt < HAND_SCROLL_QUIET_MS) {
            state.position = viewport.scrollTop;
        } else if (state.last !== null && now >= state.holdUntil) {
            state.position = view.nextScroll(state.position, now - state.last, loopHeight());
            viewport.scrollTop = state.position;
        }
        state.last = now;
        state.frame = window.requestAnimationFrame(step);
    }

    /** Starts or stops the frame loop to match the state; a stopped loop costs nothing. */
    function sync() {
        const on = running();
        section.classList.toggle('is-paused', state.motion && !on);
        if (on && state.frame === null) {
            state.last = null;
            state.frame = window.requestAnimationFrame(step);
        } else if (!on && state.frame !== null) {
            window.cancelAnimationFrame(state.frame);
            state.frame = null;
        }
    }

    function refreshAges() {
        const now = Date.now();
        for (const time of section.querySelectorAll('time[data-at]')) time.textContent = view.whenLabel(time.dataset.at, now);
    }

    function render(feed) {
        const motion = !reducedMotion();
        const rows = view.listEvents(feed, motion ? SCROLL_ROWS : STATIC_ROWS);
        const now = Date.now();
        state.motion = false;
        section.classList.remove('is-scrolling');
        section.classList.toggle('is-static', !motion);
        list.innerHTML = rows.length > 0
            ? rows.map((event) => view.eventRowHtml(event, { nowMs: now })).join('')
            : '<li class="event-row event-empty">No events recorded in the last 30 days.</li>';
        if (updated) updated.innerHTML = view.updatedLineHtml(feed, now);
        viewport.scrollTop = 0;
        state.position = 0;
        state.holdUntil = performance.now() + HOLD_AT_TOP_MS;
        // Scroll only a list longer than its box, as two identical copies so the loop has no seam.
        if (motion && rows.length > 0 && list.scrollHeight > viewport.clientHeight + 4) {
            list.insertAdjacentHTML('beforeend', rows.map((event) => view.eventRowHtml(event, { nowMs: now, copy: true })).join(''));
            state.motion = true;
            section.classList.add('is-scrolling');
        }
        sync();
    }

    async function getJson(url) {
        const response = await fetch(url, { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        return response.json();
    }

    /** The live feed, else the release's file; null when neither answers (the built rows then stay). */
    async function loadFeed() {
        if (api) {
            try {
                return await getJson(api.apiUrl('/api/events', { limit: SCROLL_ROWS }, api.apiBase(document, window.location)));
            } catch (error) {
                logError('/api/events did not answer; reading stocks-events.json', error.message);
            }
        }
        try {
            return await getJson('./stocks-events.json');
        } catch (error) {
            logError('stocks-events.json did not answer; keeping the rows written at build time', error.message);
            return null;
        }
    }

    function wire() {
        viewport.addEventListener('mouseenter', () => { state.hover = true; sync(); });
        viewport.addEventListener('mouseleave', () => { state.hover = false; sync(); });
        viewport.addEventListener('focusin', () => { state.focus = true; sync(); });
        viewport.addEventListener('focusout', (event) => {
            state.focus = viewport.contains(event.relatedTarget);
            sync();
        });
        // A scroll that is not ours (a finger, a wheel, the browser bringing a focused row into view)
        // moves the list; the loop picks up from wherever it left the list.
        viewport.addEventListener('scroll', () => {
            if (Math.abs(viewport.scrollTop - Math.round(state.position)) <= 2) return;
            state.handScrollAt = performance.now();
            state.position = viewport.scrollTop;
        }, { passive: true });
        document.addEventListener('visibilitychange', () => { state.hidden = document.hidden; sync(); });
        if (typeof window.IntersectionObserver === 'function') {
            new window.IntersectionObserver((entries) => {
                state.onScreen = entries.some((entry) => entry.isIntersecting);
                sync();
            }).observe(section);
        }
        if (toggle) {
            toggle.addEventListener('click', () => {
                state.paused = !state.paused;
                toggle.setAttribute('aria-pressed', state.paused ? 'true' : 'false');
                toggle.textContent = state.paused ? 'Play' : 'Pause';
                sync();
            });
        }
        window.setInterval(refreshAges, AGE_REFRESH_MS);
    }

    let feed = null;
    wire();
    refreshAges();
    if (typeof window.matchMedia === 'function') {
        window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => { if (feed) render(feed); });
    }
    loadFeed().then((loaded) => {
        feed = loaded;
        if (feed) render(feed);
    });
})();
