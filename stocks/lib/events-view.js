/*
 * The latest-events rows, shared by the home page's scrolling box (latest-events.js) and the
 * build-time snapshot that writes the newest rows into index.html (lib/static-snapshot.mjs), so the
 * static list and the live one cannot drift apart. Pure: no DOM, no fetch, and no clock unless a
 * caller passes one — without `nowMs` a time is printed as a date, which stays true forever.
 * UMD-wrapped like fmt.js, exposing window.__rwaEventsView. Tested in ../events-view.test.js.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./fmt.js'));
    else root.__rwaEventsView = factory(root.__rwaFmt);
})(this, function (fmt) {
    'use strict';

    const { escapeHtml, fmtRelativeTime, MONTHS } = fmt;

    const CATEGORY_LABELS = { catalogue: 'Universe', terms: 'Terms', keys: 'Keys', defi: 'DeFi', lending: 'Lending', market: 'Market', legal: 'Legal' };
    const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
    const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;
    const DAY_MS = 86400000;

    /** A usable event time: an ISO UTC instant or a bare date. Anything else is not shown. */
    function validAt(at) {
        return typeof at === 'string' && (DATE_ONLY.test(at) || INSTANT.test(at)) && Number.isFinite(Date.parse(DATE_ONLY.test(at) ? `${at}T00:00:00Z` : at));
    }

    /** "24 Sep, 14:07 UTC" for an instant, "24 Sep" for a date the source records only to the day. */
    function absoluteLabel(at) {
        const d = new Date(DATE_ONLY.test(at) ? `${at}T00:00:00Z` : at);
        const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
        if (DATE_ONLY.test(at)) return day;
        return `${day}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
    }

    /**
     * How long ago, when the caller knows the time: "2 h ago" for an instant; "today", "yesterday" or
     * "3 d ago" for a date-only event, counted in UTC days so a day is never given an invented hour.
     */
    function whenLabel(at, nowMs) {
        if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return absoluteLabel(at);
        if (!DATE_ONLY.test(at)) return fmtRelativeTime(at, nowMs);
        const days = Math.round((Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00Z`) - Date.parse(`${at}T00:00:00Z`)) / DAY_MS);
        if (days <= 0) return 'today';
        if (days === 1) return 'yesterday';
        return `${days} d ago`;
    }

    /** Only the site's own relative links (and https) are followed; anything else goes to the watch page. */
    function safeHref(href) {
        return typeof href === 'string' && (/^\.\/[A-Za-z0-9._~/?#=&%-]*$/.test(href) || /^https:\/\/[^\s"'<>]+$/.test(href)) ? href : './watch.html';
    }

    /** The events a list can show, newest first as the feed already is, at most `limit`. */
    function listEvents(feed, limit) {
        const events = Array.isArray(feed?.events) ? feed.events : [];
        return events.filter((event) => event && typeof event.title === 'string' && event.title.trim() && validAt(event.at)).slice(0, limit);
    }

    /**
     * Whether `event` concerns the token `{mint, issuer}` (issuer = the programme slug): it names the
     * mint, or it names no token at all and is about the token's programme (a court case, a fee or
     * document change). A protocol event that names no token concerns no token page.
     */
    function eventConcernsToken(event, token) {
        if (!event || !token || typeof token.mint !== 'string') return false;
        if (Array.isArray(event.mints) && event.mints.length > 0) return event.mints.includes(token.mint);
        if (event.subject?.type === 'token') return event.subject.id === token.mint;
        return event.subject?.type === 'issuer' && typeof token.issuer === 'string' && event.subject.id === token.issuer;
    }

    /** The events of `feed` that concern `token`, newest first, at most `limit`. */
    function eventsForToken(feed, token, limit) {
        const events = Array.isArray(feed?.events) ? feed.events : [];
        return listEvents({ events: events.filter((event) => eventConcernsToken(event, token)) }, limit);
    }

    /**
     * One row: when (a <time> whose title is the source's own ISO time), the category tag, the title
     * as a link and the source label — plus the model's rating, labelled as a model assessment, on a
     * document change. `copy` marks the second copy a seamless scroll needs: hidden from assistive
     * technology and out of the tab order, so a reader meets each event once.
     */
    function eventRowHtml(event, { nowMs = null, copy = false, root = './' } = {}) {
        // Feed links are relative to the site root; a page one folder down (a card) passes root '../'.
        const href = safeHref(event.href);
        const category = Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, event.category) ? event.category : 'terms';
        const severity = ['info', 'caution', 'warning', 'critical'].includes(event.severity) ? event.severity : 'info';
        const assessment = event.assessment && typeof event.assessment.severity === 'string'
            ? ` · model assessment: ${escapeHtml(event.assessment.severity)}` : '';
        return `<li class="event-row" data-category="${category}" data-severity="${severity}"${copy ? ' aria-hidden="true"' : ''}>`
            + `<span class="event-meta"><time datetime="${escapeHtml(event.at)}" title="${escapeHtml(event.at)}" data-at="${escapeHtml(event.at)}">${escapeHtml(whenLabel(event.at, nowMs))}</time>`
            + `<span class="event-tag">${CATEGORY_LABELS[category]}</span>`
            + `<span class="event-source">${escapeHtml(event.source ?? '')}${assessment}</span></span>`
            + `<a class="event-title" href="${escapeHtml(href.startsWith('./') ? root + href.slice(2) : href)}"${copy ? ' tabindex="-1"' : ''}>${escapeHtml(event.title)}</a></li>`;
    }

    /**
     * The items of a card's horizontal marquee: each event's category tag, title and age, as one
     * link. `copy` marks the second run a seamless loop needs (out of the tab order; its container is
     * hidden from assistive technology). Links are rebased with `root` as in eventRowHtml.
     */
    function eventMarqueeHtml(events, { nowMs = null, root = './', copy = false } = {}) {
        return (Array.isArray(events) ? events : []).map((event) => {
            const category = Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, event.category) ? event.category : 'terms';
            const href = safeHref(event.href);
            return `<a class="event-marquee-item" data-category="${category}" href="${escapeHtml(href.startsWith('./') ? root + href.slice(2) : href)}"${copy ? ' tabindex="-1"' : ''}>`
                + `<span class="event-tag">${CATEGORY_LABELS[category]}</span>${escapeHtml(event.title)}`
                + `<span class="event-marquee-when">${escapeHtml(whenLabel(event.at, nowMs))}</span></a>`;
        }).join('');
    }

    /** The line under the list: the cadence and the newest event's own time. */
    function updatedLineHtml(feed, nowMs = null) {
        const newest = listEvents(feed, 1)[0]?.at ?? null;
        if (newest === null) return 'Updated hourly · no events in the last 30 days';
        return `Updated hourly · newest <time datetime="${escapeHtml(newest)}" title="${escapeHtml(newest)}" data-at="${escapeHtml(newest)}">${escapeHtml(whenLabel(newest, nowMs))}</time>`;
    }

    /** Pixels per second for the scroll: slow enough to read a row as it passes. */
    const SCROLL_PX_PER_S = 14;

    /**
     * The scroll position after `elapsedMs` at `pxPerS`, wrapped at `loopPx` (the height of one copy
     * of the list), so a time-based step moves at the same speed at any frame rate.
     */
    function nextScroll(position, elapsedMs, loopPx, pxPerS = SCROLL_PX_PER_S) {
        if (!(loopPx > 0) || !(elapsedMs > 0)) return position;
        const next = position + (pxPerS * Math.min(elapsedMs, 250)) / 1000;
        return next >= loopPx ? next - loopPx : next;
    }

    return { CATEGORY_LABELS, SCROLL_PX_PER_S, validAt, absoluteLabel, whenLabel, safeHref, listEvents, eventConcernsToken, eventsForToken, eventRowHtml, eventMarqueeHtml, updatedLineHtml, nextScroll };
});
