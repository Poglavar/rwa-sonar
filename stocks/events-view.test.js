// Tests the latest-events rows shared by the landing page and its build-time snapshot
// (lib/events-view.js), and how index.html and landing.css wire the box: where it sits, that its
// scripts are deferred, and that without motion it is a static list with no scroll controls.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const view = require('./lib/events-view.js');

const ROOT = join(__dirname, '..');
const NOW = Date.parse('2026-09-24T14:30:00Z');
const EVENT = {
    id: 'doc-x', at: '2026-09-24T12:29:11Z', category: 'terms', severity: 'warning', source: 'document watcher',
    title: 'Kraken xStocks changed its <Terms> page', href: './watch.html?material=true#change-835',
    assessment: { by: 'model', material: true, severity: 'critical' }
};

describe('latest-events rows', () => {
    test('an instant reads as an age when the clock is known, and as a UTC date and time when it is not', () => {
        expect(view.whenLabel('2026-09-24T12:29:11Z', NOW)).toBe('2 h ago');
        expect(view.whenLabel('2026-09-24T12:29:11Z', null)).toBe('24 Sep, 12:29 UTC');
    });

    test('a date-only event is counted in whole UTC days, never given an hour', () => {
        expect(view.whenLabel('2026-09-24', NOW)).toBe('today');
        expect(view.whenLabel('2026-09-23', NOW)).toBe('yesterday');
        expect(view.whenLabel('2026-09-19', NOW)).toBe('5 d ago');
        expect(view.whenLabel('2026-09-19', null)).toBe('19 Sep');
    });

    test('a row has the time with its ISO title, the category tag, the source, the model assessment and the linked title', () => {
        const html = view.eventRowHtml(EVENT, { nowMs: NOW });
        expect(html).toBe('<li class="event-row" data-category="terms" data-severity="warning">'
            + '<span class="event-meta"><time datetime="2026-09-24T12:29:11Z" title="2026-09-24T12:29:11Z" data-at="2026-09-24T12:29:11Z">2 h ago</time>'
            + '<span class="event-tag">Terms</span><span class="event-source">document watcher · model assessment: critical</span></span>'
            + '<a class="event-title" href="./watch.html?material=true#change-835">Kraken xStocks changed its &lt;Terms&gt; page</a></li>');
        expect(view.eventRowHtml({ ...EVENT, assessment: undefined })).not.toContain('model assessment');
    });

    test('the scroll copy is hidden from screen readers and the tab order', () => {
        const copy = view.eventRowHtml(EVENT, { copy: true });
        expect(copy).toMatch(/^<li class="event-row"[^>]* aria-hidden="true">/);
        expect(copy).toContain('tabindex="-1"');
        expect(view.eventRowHtml(EVENT)).not.toContain('aria-hidden');
    });

    test('only the site\'s own links are followed, and an unknown category is shown as terms', () => {
        expect(view.eventRowHtml({ ...EVENT, href: 'javascript:alert(1)' })).toContain('href="./watch.html"');
        expect(view.eventRowHtml({ ...EVENT, category: 'gossip' })).toContain('data-category="terms"');
    });

    test('lists only dated, titled events, at most the limit', () => {
        const feed = { events: [EVENT, { ...EVENT, id: 'b', at: 'soon' }, { ...EVENT, id: 'c', title: ' ' }, { ...EVENT, id: 'd', at: '2026-09-23' }, { ...EVENT, id: 'e' }] };
        expect(view.listEvents(feed, 10).map((e) => e.id)).toEqual(['doc-x', 'd', 'e']);
        expect(view.listEvents(feed, 1).map((e) => e.id)).toEqual(['doc-x']);
        expect(view.listEvents(null, 5)).toEqual([]);
    });

    test('the updated line names the cadence and the newest event\'s own time', () => {
        expect(view.updatedLineHtml({ events: [EVENT] }, NOW)).toContain('Updated hourly · newest <time datetime="2026-09-24T12:29:11Z"');
        expect(view.updatedLineHtml({ events: [EVENT] }, NOW)).toContain('>2 h ago</time>');
        expect(view.updatedLineHtml({ events: [] })).toBe('Updated hourly · no events in the last 30 days');
    });

    test('the scroll step is time-based, wraps at one copy of the list, and ignores a long gap', () => {
        // 14 px/s: a 60 Hz frame and a 30 Hz frame move the list by the same distance per second.
        expect(view.nextScroll(0, 1000 / 60, 500, 14) * 60).toBeCloseTo(14);
        expect(view.nextScroll(0, 1000 / 30, 500, 14) * 30).toBeCloseTo(14);
        expect(view.nextScroll(499.9, 50, 500, 14)).toBeCloseTo(0.6);
        // A tab coming back after a minute moves at most a quarter-second's worth, never a jump.
        expect(view.nextScroll(10, 60000, 500, 14)).toBeCloseTo(13.5);
        expect(view.nextScroll(10, 16, 0)).toBe(10);
    });
});

describe('the landing page box', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    const css = readFileSync(join(ROOT, 'landing.css'), 'utf8');

    test('sits in the hero right after the comparison card and its search, on a phone and on a wide screen', () => {
        const hero = html.slice(html.indexOf('<section class="hero"'), html.indexOf('id="tradeTicker"'));
        expect(hero.indexOf('id="heroSearch"')).toBeGreaterThan(-1);
        expect(hero.indexOf('id="latestEvents"')).toBeGreaterThan(hero.indexOf('id="heroSearch"'));
        // The search is its own hero area (25 Sep): under the card on a wide screen, before it below 900 px.
        expect(css).toContain('grid-template-areas: "copy preview" "copy search" "copy events"');
        expect(css).toMatch(/@media \(max-width: 900px\) \{\s*\.hero \{ grid-template-areas: "copy" "search" "preview" "events"; \}/);
    });

    test('is a plain list with a visible pause control and a link to every change; no live region', () => {
        const box = html.slice(html.indexOf('id="latestEvents"'), html.indexOf('</section>', html.indexOf('id="latestEvents"')));
        expect(box).toContain('<ul id="latestEventsList" class="latest-events-list">');
        expect(box).toContain('<button type="button" id="latestEventsToggle" class="latest-events-toggle" aria-pressed="false" aria-controls="latestEventsList">Pause</button>');
        expect(box).toContain('<a href="./watch.html">All changes →</a>');
        expect(box).not.toContain('aria-live');
    });

    test('loads its scripts deferred, after the formatters and the API base they read', () => {
        const at = (src) => html.indexOf(`src="${src}`);
        expect(html).toMatch(/<script src="stocks\/lib\/events-view\.js\?v=\w+" defer><\/script>/);
        expect(html).toMatch(/<script src="latest-events\.js\?v=\w+" defer><\/script>/);
        expect(at('stocks/lib/events-view.js')).toBeGreaterThan(at('stocks/lib/fmt.js'));
        expect(at('latest-events.js')).toBeGreaterThan(at('stocks/lib/events-view.js'));
        expect(at('latest-events.js')).toBeGreaterThan(at('stocks/lib/api-base.js'));
    });

    test('without motion it is a static list of six: no inner scroll, no pause button, no copy', () => {
        expect(css).toMatch(/\.latest-events-toggle \{ display: none;/);
        expect(css).toMatch(/\.latest-events\.is-scrolling \.latest-events-toggle \{ display: inline-flex;/);
        expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.latest-events-viewport \{ max-height: none; overflow: visible; \}\s*\.event-row:nth-child\(n\+7\) \{ display: none; \}/);
        expect(css).toContain(':root.reduce-motion .latest-events-viewport { max-height: none; overflow: visible; }');
        // The static rules come after the width rules, or a phone's max-height would win.
        expect(css.lastIndexOf('.latest-events.is-static .latest-events-viewport')).toBeGreaterThan(css.indexOf('@media (max-width: 560px) {\n    .latest-events {'));
        const js = readFileSync(join(ROOT, 'latest-events.js'), 'utf8');
        expect(js).toContain("new URLSearchParams(window.location.search).has('reduceMotion')");
        expect(js).toContain("classList.contains('reduce-motion')");
        expect(js).toMatch(/document\.addEventListener\('visibilitychange'/);
        expect(js).toContain('new window.IntersectionObserver(');
        expect(js).not.toMatch(/setTimeout/);
    });
});
