/*
 * The only script a generated card loads (stocks/build-cards.mjs renders everything else at build
 * time, so a card is complete with JavaScript off). Two jobs, both additive: turn every absolute
 * <time> into "… (3 h ago)", which cannot be baked in without making two builds differ, and put a
 * copy button behind the mint address. Nothing here is needed to read the page.
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

    if (typeof document !== 'undefined') {
        addAges();
        wireCopy();
    }
})();
