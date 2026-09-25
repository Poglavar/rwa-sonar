/*
 * The only script a generated card loads (stocks/build-cards.mjs renders everything else at build
 * time, so a card is complete with JavaScript off). Its jobs are all additive: turn every absolute
 * <time> into "… (3 h ago)", which cannot be baked in without making two builds differ, put a
 * copy button behind the mint address, draw the history chart, and open what a deep link targets.
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
     * A deep link into a collapsed disclosure must reveal its target before scrolling to it. A fold
     * row (one item of a growing list: a discrepancy, a finding, a change) that a link targets also
     * opens itself and is marked, so the reader lands on the item in full.
     */
    function revealHashTarget() {
        if (!location.hash) return;
        var target = document.getElementById(location.hash.slice(1));
        if (!target) return;
        var disclosure = target.closest('details');
        if (disclosure) disclosure.open = true;
        var marked = document.querySelectorAll('.fold-target');
        for (var i = 0; i < marked.length; i += 1) marked[i].classList.remove('fold-target');
        if (target.classList.contains('fold-row')) {
            var row = target.querySelector('details');
            if (row) row.open = true;
            target.classList.add('fold-target');
        }
    }

    function wireLocalNav() {
        var nav = document.querySelector('.card-local-nav');
        if (!nav) return;
        nav.addEventListener('click', function (event) {
            var link = event.target.closest('a[href^="#"]');
            if (!link) return;
            var target = document.getElementById(link.getAttribute('href').slice(1));
            var disclosure = target && target.closest('details');
            if (disclosure) disclosure.open = true;
        });
        window.addEventListener('hashchange', revealHashTarget);
        revealHashTarget();
    }

    if (typeof document !== 'undefined') {
        addAges();
        wireCopy();
        wireHistory();
        wireLocalNav();
    }
})();
