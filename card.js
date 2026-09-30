/*
 * The only script a generated card loads (stocks/build-cards.mjs renders everything else at build
 * time, so a card is complete with JavaScript off). Its jobs are all additive: turn every absolute
 * <time> into "… (3 h ago)", which cannot be baked in without making two builds differ, put a
 * copy button behind the mint address, draw the history chart, list the token's latest events, and
 * open what a deep link targets.
 * Nothing here is needed to read the page.
 */

(function () {
    var SECOND_MS = 1000;
    var MINUTE_MS = 60 * SECOND_MS;
    var HOUR_MS = 60 * MINUTE_MS;
    var DAY_MS = 24 * HOUR_MS;
    var MONTH_MS = 30 * DAY_MS;
    var YEAR_MS = 365 * DAY_MS;

    /** Same wording as stocks/lib/fmt.js humanizeDuration; a future stamp keeps its direction. */
    function relative(ms) {
        var abs = Math.abs(ms);
        var magnitude;
        if (abs < 45 * SECOND_MS) return 'just now';
        if (abs < 90 * MINUTE_MS) magnitude = Math.round(abs / MINUTE_MS) + ' min';
        else if (abs < 36 * HOUR_MS) magnitude = Math.round(abs / HOUR_MS) + ' h';
        else if (abs < 30 * DAY_MS) magnitude = Math.round(abs / DAY_MS) + ' d';
        else if (abs < YEAR_MS) magnitude = Math.round(abs / MONTH_MS) + ' mo';
        else magnitude = Math.round(abs / YEAR_MS) + ' y';
        return ms < 0 ? 'in ' + magnitude : magnitude + ' ago';
    }

    function addAges() {
        var now = Date.now();
        var stamps = document.querySelectorAll('time[datetime]');
        for (var i = 0; i < stamps.length; i += 1) {
            var then = new Date(stamps[i].getAttribute('datetime')).getTime();
            if (!isFinite(then)) continue;
            var age = document.createElement('span');
            age.className = 'age';
            age.textContent = ' (' + relative(now - then) + ')';
            stamps[i].insertAdjacentElement('afterend', age);
        }
    }

    function wireCopy() {
        var button = document.getElementById('copy-mint');
        if (button === null) return;
        button.addEventListener('click', function () {
            var mint = button.getAttribute('data-mint') || '';
            if (!mint || !navigator.clipboard) {
                button.textContent = 'Select it';
                return;
            }
            // The label only changes once the clipboard write has actually resolved — a button that
            // says "Copied" because it was clicked is a lie the user finds out about later.
            navigator.clipboard.writeText(mint).then(function () {
                button.textContent = 'Copied';
            }, function () {
                button.textContent = 'Copy failed';
            });
        });
    }

    function wireHistory() {
        var panel = document.getElementById('history');
        var charts = globalThis.__rwaHistoryCharts;
        var api = globalThis.__rwaApi;
        if (!panel || !charts || !api) return;
        var select = panel.querySelector('.history-metric');
        var output = panel.querySelector('.history-chart');
        select.innerHTML = charts.optionsHtml('premium_pct');
        var data = null;
        function draw() { if (data) output.innerHTML = charts.render(data.items, data.events, select.value, { key: function () { return 'This token'; } }); }
        select.addEventListener('change', draw);
        var path = api.apiUrl('/api/tokens/' + encodeURIComponent(panel.getAttribute('data-mint')) + '/history', { days: 365 }, api.apiBase());
        fetch(path, { headers: { accept: 'application/json' } }).then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
        }).then(function (body) { data = body; draw(); }, function () {
            output.innerHTML = '<p class="history-empty">History is temporarily unavailable.</p>';
        });
    }

    /**
     * The token's latest events (#events): the live feed filtered to this token and its programme,
     * else the release's stocks-events.json filtered the same way (lib/events-view.js), else a note.
     */
    function wireEvents() {
        var section = document.getElementById('events');
        var view = globalThis.__rwaEventsView;
        var fmt = globalThis.__rwaFmt;
        var api = globalThis.__rwaApi;
        if (!section || !view || !fmt) return;
        var list = section.querySelector('.token-events-list');
        var token = { mint: section.getAttribute('data-mint'), issuer: section.getAttribute('data-issuer') || null };
        var LIMIT = 20;
        function getJson(url) {
            return fetch(url, { headers: { accept: 'application/json' } }).then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            });
        }
        function draw(events) {
            var now = Date.now();
            drawMarquee(events, now);
            // The collapsed block's hint says how many there are, so it need not be opened to find out.
            var hint = section.querySelector('summary small');
            if (hint) hint.textContent = events.length === 0 ? 'None in the last 30 days'
                : events.length + (events.length === LIMIT ? '+' : '') + ' in the last 30 days';
            list.innerHTML = events.length === 0
                ? '<li class="event-empty">No events for ' + fmt.escapeHtml(section.getAttribute('data-symbol') || 'this token') + ' in the last 30 days.</li>'
                : events.map(function (event) { return view.eventRowHtml(event, { nowMs: now, root: '../' }); }).join('');
        }
        var live = api
            ? getJson(api.apiUrl('/api/events', { mint: token.mint, issuer: token.issuer, limit: LIMIT }, api.apiBase()))
                .then(function (body) { return view.listEvents(body, LIMIT); })
            : Promise.reject(new Error('no API base'));
        live.catch(function () {
            return getJson('../stocks-events.json').then(function (feed) { return view.eventsForToken(feed, token, LIMIT); });
        }).then(draw, function () {
            list.innerHTML = '<li class="event-empty">Events are temporarily unavailable.</li>';
        });
    }

    /** Pixels per second the marquee moves: slow enough to read a title as it passes. */
    var MARQUEE_PX_PER_S = 45;

    /**
     * A one-line horizontal marquee of the token's events under its ticker, looping two copies of
     * the run. Hover or focus pauses it; with reduced motion it is a still row the reader can scroll
     * (card.css). No events, no marquee.
     */
    function drawMarquee(events, now) {
        var view = globalThis.__rwaEventsView;
        var heading = document.querySelector('.card-head h1');
        if (!heading || events.length === 0) return;
        var box = document.createElement('div');
        box.className = 'event-marquee';
        box.setAttribute('role', 'region');
        box.setAttribute('aria-label', 'Latest events');
        box.innerHTML = '<div class="event-marquee-track"><span class="event-marquee-run">'
            + view.eventMarqueeHtml(events, { nowMs: now, root: '../' })
            + '</span><span class="event-marquee-run" aria-hidden="true">'
            + view.eventMarqueeHtml(events, { nowMs: now, root: '../', copy: true }) + '</span></div>';
        heading.insertAdjacentElement('afterend', box);
        var run = box.querySelector('.event-marquee-run');
        box.style.setProperty('--marquee-s', Math.max(8, run.offsetWidth / MARQUEE_PX_PER_S).toFixed(1) + 's');
    }

    /**
     * A deep link into a collapsed disclosure must reveal its target before scrolling to it. A fold
     * row (one item of a growing list: a discrepancy, a finding, a change) that a link targets also
     * opens itself and is marked, so the reader lands on the item in full.
     */
    function revealHashTarget() {
        if (!location.hash) return;
        var target = document.getElementById(location.hash.slice(1));
        if (!target) return;
        openAncestors(target);
        var marked = document.querySelectorAll('.fold-target');
        for (var i = 0; i < marked.length; i += 1) marked[i].classList.remove('fold-target');
        if (target.classList.contains('fold-row')) {
            var row = target.querySelector('details');
            if (row) row.open = true;
            target.classList.add('fold-target');
        }
    }

    /** Opens every collapsed block that contains `node`, so a target nested two levels deep is visible. */
    function openAncestors(node) {
        for (var d = node && node.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) d.open = true;
    }

    /**
     * Any in-page link (the local nav, the five facts, the banners) opens the blocks around its
     * target, including when the hash is already set and no hashchange fires.
     */
    function wireLocalNav() {
        document.addEventListener('click', function (event) {
            var link = event.target.closest && event.target.closest('a[href^="#"]');
            if (!link || link.getAttribute('href').length < 2) return;
            openAncestors(document.getElementById(link.getAttribute('href').slice(1)));
        });
        window.addEventListener('hashchange', revealHashTarget);
        revealHashTarget();
    }

    if (typeof document !== 'undefined') {
        // The site's ?reduceMotion hook (as landing.js): the marquee then stands still.
        if (/[?&]reduceMotion(=1|=true)?(&|$)/.test(location.search)) document.documentElement.classList.add('reduce-motion');
        addAges();
        wireCopy();
        wireHistory();
        wireEvents();
        wireLocalNav();
    }
})();
