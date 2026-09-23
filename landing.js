/* The public overview. Data shaping and chart geometry stay pure so the daily-series semantics can
 * be tested without a browser; the DOM layer only fetches, renders and links into the workspace. */
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.__landing = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const fmt = (typeof __rwaFmt !== 'undefined') ? __rwaFmt : require('./stocks/lib/fmt.js');
    const { escapeHtml, fmtDate, fmtMoney, fmtNumber, fmtPrice, humanizeSlug, cardSlug } = fmt;

    function finite(value) {
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    function orderedRows(document) {
        return (Array.isArray(document?.items) ? document.items : [])
            .filter((row) => row && typeof row.date === 'string')
            .map((row) => ({ ...row }))
            .sort((a, b) => a.date.localeCompare(b.date));
    }

    function metricDelta(rows, key) {
        const usable = orderedRows({ items: rows }).filter((row) => finite(row[key]) !== null);
        if (usable.length === 0) return { latest: null, previous: null, delta: null, totalDelta: null };
        const latest = finite(usable.at(-1)[key]);
        const previous = usable.length > 1 ? finite(usable.at(-2)[key]) : null;
        const first = finite(usable[0][key]);
        return {
            latest,
            previous,
            delta: previous === null ? null : latest - previous,
            totalDelta: first === null ? null : latest - first
        };
    }

    function issuerDeltas(rows) {
        const ordered = orderedRows({ items: rows });
        if (ordered.length < 2) return [];
        const before = new Map((ordered.at(-2).issuerCounts ?? []).map((row) => [row.issuer, finite(row.tokenCount) ?? 0]));
        const after = new Map((ordered.at(-1).issuerCounts ?? []).map((row) => [row.issuer, finite(row.tokenCount) ?? 0]));
        return [...new Set([...before.keys(), ...after.keys()])]
            .map((issuer) => ({ issuer, delta: (after.get(issuer) ?? 0) - (before.get(issuer) ?? 0) }))
            .filter((row) => row.delta !== 0)
            .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.issuer.localeCompare(b.issuer));
    }

    const DAY_MS = 24 * 60 * 60 * 1000;

    /** Days covered by the series, first to last observation inclusive; 0 when there is none. */
    function historySpanDays(rows) {
        const ordered = orderedRows({ items: rows });
        if (ordered.length === 0) return 0;
        const first = Date.parse(`${ordered[0].date}T00:00:00Z`);
        const last = Date.parse(`${ordered.at(-1).date}T00:00:00Z`);
        if (!Number.isFinite(first) || !Number.isFinite(last)) return 0;
        return Math.round((last - first) / DAY_MS) + 1;
    }

    /** A range toggle is offered only when the history is at least that long; "all" always is. */
    function availableRanges(rows, ranges) {
        const span = historySpanDays(rows);
        return (Array.isArray(ranges) ? ranges : []).filter((range) => range === 'all' || Number(range) <= span);
    }

    /**
     * What the live overview changes in the static hero line (index.html's snapshot region): the
     * newest observed token count and its date. Null when the API has no usable row, so the
     * build-time numbers stay rather than being replaced by a dash.
     */
    function snapshotRefinement(rows) {
        const latest = orderedRows({ items: rows }).filter((row) => finite(row.tokenCount) !== null).at(-1);
        if (!latest) return null;
        return { tokens: fmtNumber(latest.tokenCount), date: latest.date, label: 'latest daily observation' };
    }

    function rangeRows(rows, range = 'all') {
        const ordered = orderedRows({ items: rows });
        if (range === 'all' || ordered.length === 0) return ordered;
        const days = Number(range);
        if (!Number.isFinite(days) || days < 1) return ordered;
        const latest = Date.parse(`${ordered.at(-1).date}T00:00:00Z`);
        if (!Number.isFinite(latest)) return ordered;
        const cutoff = latest - (days - 1) * DAY_MS;
        return ordered.filter((row) => Date.parse(`${row.date}T00:00:00Z`) >= cutoff);
    }

    function chartModel(rows, key, width = 520, height = 220, { range = 'all', annotations = [] } = {}) {
        const padding = { top: 24, right: 16, bottom: 30, left: 16 };
        const usable = rangeRows(rows, range).filter((row) => finite(row[key]) !== null);
        if (usable.length === 0) return { points: [], width, height, max: 0 };
        const byDate = new Map((Array.isArray(annotations) ? annotations : [])
            .filter((row) => typeof row?.date === 'string')
            .map((row) => [row.date, row]));
        const values = usable.map((row) => row[key]);
        const max = Math.max(1, ...values);
        const innerW = width - padding.left - padding.right;
        const innerH = height - padding.top - padding.bottom;
        const points = usable.map((row, index) => ({
            date: row.date,
            value: row[key],
            annotation: byDate.get(row.date) ?? null,
            x: padding.left + (usable.length === 1 ? innerW / 2 : index * innerW / (usable.length - 1)),
            y: padding.top + innerH - (row[key] / max) * innerH
        }));
        return { points, width, height, max, padding };
    }

    function catalogueUpdates(changes) {
        const latest = changes?.latest;
        const rows = Array.isArray(latest?.changes) ? latest.changes : [];
        const output = [];
        for (const kind of ['new-mint', 'removed-mint']) {
            const matching = rows.filter((row) => row?.kind === kind);
            if (matching.length === 0) continue;
            const byIssuer = new Map();
            for (const row of matching) {
                const issuer = row.issuer ?? 'unknown issuer';
                byIssuer.set(issuer, (byIssuer.get(issuer) ?? 0) + 1);
            }
            const issuerText = [...byIssuer.entries()]
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .slice(0, 4)
                .map(([issuer, count]) => `${humanizeSlug(issuer)} ${kind === 'new-mint' ? '+' : '−'}${count}`)
                .join(' · ');
            const entered = kind === 'new-mint';
            output.push({
                date: latest.to ?? null,
                type: entered ? 'Catalogue discovery' : 'Catalogue removal',
                title: `${matching.length} token address${matching.length === 1 ? '' : 'es'} ${entered ? 'entered' : 'left'} the catalogue`,
                detail: `${issuerText} · snapshots ${latest.from ?? '?'} → ${latest.to ?? '?'} · ${entered ? 'newly discovered; issuance may predate discovery' : 'no longer present in the built universe'}`,
                href: './monitor.html#changesSection'
            });
        }
        return output;
    }

    function recentUpdates(changes, defi, limit = 6) {
        const items = catalogueUpdates(changes);
        for (const event of Array.isArray(defi?.latest?.events) ? defi.latest.events : []) {
            items.push({
                date: defi.latest.to ?? defi.generatedAt ?? null,
                type: 'DeFi watch',
                title: event.summary ?? `${event.symbol ?? 'Token'} protocol status changed`,
                detail: `${event.protocolName ?? event.protocolId ?? 'Protocol'} · exact token ${event.mint ?? 'not recorded'}`,
                href: './monitor.html#defiChangesSection'
            });
        }
        const exactChanges = new Set((Array.isArray(changes?.latest?.changes) ? changes.latest.changes : [])
            .filter((event) => event?.kind === 'new-mint')
            .map((event) => event.mint));
        for (const mint of Array.isArray(changes?.newMints) ? changes.newMints : []) {
            if (exactChanges.has(mint.mint)) continue;
            items.push({
                date: mint.firstSeenAt ?? null,
                type: 'Newly observed',
                title: `${mint.symbol ?? mint.name ?? 'Token'} entered the catalogue`,
                detail: `${mint.issuerName ?? humanizeSlug(mint.issuer) ?? 'Unknown issuer'} · newly observed; issuance may predate discovery`,
                href: mint.cardSlug ? `./cards/${mint.cardSlug}.html` : `./cards/${cardSlug(mint.symbol, mint.mint)}.html`
            });
        }
        for (const event of Array.isArray(changes?.events) ? changes.events : []) {
            items.push({
                date: event.date ?? null,
                type: humanizeSlug(event.kind) ?? 'Issuer event',
                title: event.summary ?? event.title ?? 'Issuer event recorded',
                detail: humanizeSlug(event.issuer) ?? 'Issuer dossier',
                href: event.issuer ? `./issuers/${encodeURIComponent(event.issuer)}.html` : './monitor.html#eventsSection'
            });
        }
        return items.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? ''))).slice(0, limit);
    }

    function journalUpdates(journal, limit = 6) {
        const severityRank = { critical: 4, warning: 3, caution: 2, info: 1 };
        return (Array.isArray(journal?.items) ? journal.items : [])
            .map((row) => ({
                date: row.effectiveAt ?? row.eventAt ?? row.firstObservedAt ?? row.date ?? null,
                severity: row.severity ?? 'info',
                type: row.category === 'catalogue' ? 'Catalogue observation' : humanizeSlug(row.kind) ?? 'Recorded change',
                title: row.title ?? 'Recorded change',
                detail: row.whyItMatters ?? row.summary ?? 'Open the public journal for evidence and affected assets.',
                href: row.id
                    ? `./watch.html?journal=${encodeURIComponent(row.id)}#journalSection`
                    : './watch.html#journalSection'
            }))
            .sort((a, b) => (severityRank[b.severity] ?? 0) - (severityRank[a.severity] ?? 0)
                || String(b.date ?? '').localeCompare(String(a.date ?? '')))
            .slice(0, limit);
    }

    /**
     * One frame of a count-up: `finalText` with its leading number scaled by `progress` (0 … 1,
     * eased out) and printed in the same shape — the same prefix and suffix ("$", "M"), the same
     * decimals and the same thousands grouping. Progress 1 (or more) returns `finalText` itself, so
     * the end state is byte-identical to what the page rendered. Text with no number in it ("—")
     * never counts: it is returned unchanged at every progress.
     */
    function countUpText(finalText, progress) {
        const text = typeof finalText === 'string' ? finalText : '';
        const match = text.match(/^(\D*?)(\d[\d,]*(?:\.\d+)?)(.*)$/s);
        if (!match || !(progress < 1)) return text;
        const [, prefix, digits, suffix] = match;
        const target = Number(digits.replace(/,/g, ''));
        if (!Number.isFinite(target)) return text;
        const decimals = digits.includes('.') ? digits.split('.')[1].length : 0;
        const p = Math.max(0, progress);
        const eased = 1 - Math.pow(1 - p, 3);
        const value = target * eased;
        const printed = digits.includes(',')
            ? value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
            : value.toFixed(decimals);
        return `${prefix}${printed}${suffix}`;
    }

    // --- the live trade ticker ----------------------------------------------------------------

    /** The ticker shows at most this many trades, and none older than this. */
    const TICKER_LIMIT = 12;
    const TICKER_MAX_AGE_MS = DAY_MS;

    /** The distinct mints of an /api/trades/recent page, in order: the card lookups the ticker needs. */
    function tickerMints(rows) {
        const out = [];
        for (const row of Array.isArray(rows) ? rows : []) {
            const mint = typeof row?.mint === 'string' ? row.mint.trim() : '';
            if (mint && !out.includes(mint)) out.push(mint);
        }
        return out;
    }

    /** "40 s ago" / "3 min ago" / "2 h ago"; a trade stamped ahead of our clock is "just now". */
    function tickerAge(timeMs, nowMs) {
        if (finite(timeMs) === null || finite(nowMs) === null) return null;
        const diff = Math.max(0, nowMs - timeMs);
        if (diff < 60 * 1000) return `${Math.max(1, Math.floor(diff / 1000))} s ago`;
        if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} min ago`;
        return `${Math.floor(diff / 3600000)} h ago`;
    }

    /**
     * The ticker's items from /api/trades/recent rows (snake_case, as the API sends them), newest
     * first. A row is dropped rather than shown half-true: no symbol, no parseable time, no USD
     * price, a `suspect` decode (its price is not reliable), or older than TICKER_MAX_AGE_MS. The
     * card link comes from `slugs` (mint -> the builder's cardSlug) and is null when the lookup did
     * not answer — a symbol alone can collide, so a guessed link could open another token's card.
     * An empty result means the strip stays hidden.
     */
    function tickerItems(rows, slugs, nowMs, { limit = TICKER_LIMIT, maxAgeMs = TICKER_MAX_AGE_MS } = {}) {
        const lookup = slugs instanceof Map ? slugs : new Map();
        const out = [];
        const seen = new Set();
        for (const row of Array.isArray(rows) ? rows : []) {
            const symbol = typeof row?.symbol === 'string' ? row.symbol.trim() : '';
            const timeMs = typeof row?.time === 'string' ? Date.parse(row.time) : NaN;
            const price = row?.price_usd === null || row?.price_usd === undefined || row?.price_usd === '' ? null : Number(row.price_usd);
            if (!symbol || !Number.isFinite(timeMs) || price === null || !Number.isFinite(price) || price <= 0) continue;
            if (typeof row.suspect === 'string' && row.suspect.trim()) continue;
            if (finite(nowMs) !== null && nowMs - timeMs > maxAgeMs) continue;
            if (typeof row.sig === 'string' && row.sig) {
                if (seen.has(row.sig)) continue;
                seen.add(row.sig);
            }
            const side = row.side === 'buy' || row.side === 'sell' ? row.side : null;
            const slug = lookup.get(row.mint) ?? null;
            out.push({
                sig: typeof row.sig === 'string' ? row.sig : null,
                mint: typeof row.mint === 'string' ? row.mint : null,
                symbol,
                side,
                glyph: side === 'buy' ? '▲' : side === 'sell' ? '▼' : '·',
                price: fmtPrice(price),
                venue: typeof row.dex === 'string' && row.dex.trim() ? humanizeSlug(row.dex) : null,
                timeMs,
                age: tickerAge(timeMs, nowMs),
                href: typeof slug === 'string' && slug ? `./cards/${encodeURIComponent(slug)}.html` : null
            });
        }
        return out.sort((a, b) => b.timeMs - a.timeMs).slice(0, limit);
    }

    /**
     * One ticker entry. `copy` marks the marquee's second copy of the list: hidden from assistive
     * tech and out of the tab order, so a reader meets each trade once.
     */
    function tickerItemHtml(item, copy) {
        const side = item.side === null ? '' : `<span class="sr-only"> ${item.side}</span>`;
        const label = `<strong>${escapeHtml(item.symbol)}</strong> <span class="ticker-side ticker-${item.side ?? 'unknown'}" aria-hidden="true">${item.glyph}</span>${side} ${escapeHtml(item.price)}`;
        const focus = copy ? ' tabindex="-1"' : '';
        const head = item.href === null ? `<span>${label}</span>` : `<a href="${escapeHtml(item.href)}"${focus}>${label}</a>`;
        const venue = item.venue === null ? '' : ` · ${escapeHtml(item.venue)}`;
        return `<li class="ticker-item${copy ? ' ticker-copy' : ''}"${copy ? ' aria-hidden="true"' : ''}>${head}${venue}`
            + ` · <time datetime="${new Date(item.timeMs).toISOString()}" data-time="${item.timeMs}">${escapeHtml(item.age ?? '')}</time></li>`;
    }

    /** Marquee seconds for one lap of `widthPx` of track: a slow, readable ~32 px/s, never under 24 s. */
    function tickerDurationSeconds(widthPx, pxPerSecond = 32) {
        if (finite(widthPx) === null || widthPx <= 0) return 24;
        return Math.max(24, Math.round(widthPx / pxPerSecond));
    }

    const exported = {
        finite, orderedRows, metricDelta, issuerDeltas, rangeRows, historySpanDays, availableRanges, snapshotRefinement, chartModel,
        catalogueUpdates, recentUpdates, journalUpdates, countUpText,
        TICKER_LIMIT, TICKER_MAX_AGE_MS, tickerMints, tickerAge, tickerItems, tickerItemHtml, tickerDurationSeconds
    };
    if (typeof document === 'undefined') return exported;

    function signed(value) {
        if (value === null) return '—';
        return `${value >= 0 ? '+' : '−'}${fmtNumber(Math.abs(value))}`;
    }

    function svgChart(rows, key, { hero = false, label = '', range = 'all', annotations = [] } = {}) {
        const model = chartModel(rows, key, hero ? 560 : 340, hero ? 230 : 112, { range, annotations });
        if (model.points.length === 0) return '<p class="empty-state">No daily observations yet.</p>';
        const line = model.points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
        const first = model.points[0];
        const last = model.points.at(-1);
        const floor = model.height - model.padding.bottom;
        const area = `${first.x},${floor} ${line} ${last.x},${floor}`;
        const labels = model.points.map((point, index) => {
            const show = index === 0 || index === model.points.length - 1 || (hero && point.annotation !== null);
            const anchor = index === 0 ? 'start' : index === model.points.length - 1 ? 'end' : 'middle';
            const changeText = point.annotation === null ? ''
                : ` · +${point.annotation.added ?? 0} / −${point.annotation.removed ?? 0} catalogue addresses`;
            const marker = point.annotation === null || ((point.annotation.added ?? 0) === 0 && (point.annotation.removed ?? 0) === 0)
                ? ''
                : `<line class="chart-event-line" x1="${point.x}" y1="${model.padding.top}" x2="${point.x}" y2="${floor}" />`;
            return `${marker}<g><circle class="chart-dot${point.annotation ? ' chart-dot-event' : ''}" cx="${point.x}" cy="${point.y}" r="4"><title>${escapeHtml(`${fmtDate(point.date)}: ${fmtNumber(point.value)}${changeText}`)}</title></circle>`
                + `${show ? `<text class="chart-axis" x="${point.x}" y="${model.height - 7}" text-anchor="${anchor}">${escapeHtml(fmtDate(point.date))}</text>` : ''}`
                + `${hero && show ? `<text class="chart-value" x="${point.x}" y="${Math.max(13, point.y - 11)}" text-anchor="${anchor}">${escapeHtml(fmtNumber(point.value))}</text>` : ''}</g>`;
        }).join('');
        return `<svg class="chart-svg" viewBox="0 0 ${model.width} ${model.height}" role="img" aria-label="${escapeHtml(label)}">
            <defs><linearGradient id="chartWash" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--violet)" stop-opacity=".22"/><stop offset="1" stop-color="var(--violet)" stop-opacity="0"/></linearGradient></defs>
            <line class="chart-grid" x1="${model.padding.left}" y1="${floor}" x2="${model.width - model.padding.right}" y2="${floor}" />
            <polygon class="chart-area" points="${area}"/><polyline class="chart-line" points="${line}"/>${labels}</svg>`;
    }

    // Reduced motion is honoured from the media query and from `?reduceMotion`, the site's URL hook
    // for drivers that cannot emulate media (see AGENTS.md): with either, nothing counts or scrolls.
    const reduceMotion = new URLSearchParams(window.location.search).has('reduceMotion')
        || (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (reduceMotion) document.documentElement.classList.add('reduce-motion');

    /** Elements that have had (or are having) their one count-up, and the cancel of a running one. */
    const counted = new WeakSet();
    const counting = new WeakMap();
    const COUNT_UP_MS = 900;

    function setText(id, value) {
        const element = document.getElementById(id);
        if (!element) return;
        // A real value arriving mid-count wins at once: the count-up never overwrites data.
        counting.get(element)?.();
        element.textContent = value;
    }

    /** Counts the element's current number up from 0, once, over COUNT_UP_MS; ends on its exact text. */
    function runCountUp(element) {
        const finalText = element.textContent;
        if (countUpText(finalText, 0) === finalText) return;
        let frame = null;
        let start = null;
        const finish = () => {
            if (frame !== null) window.cancelAnimationFrame(frame);
            frame = null;
            counting.delete(element);
            element.removeAttribute('data-counting');
        };
        const step = (now) => {
            if (start === null) start = now;
            const progress = (now - start) / COUNT_UP_MS;
            element.textContent = countUpText(finalText, progress);
            if (progress >= 1) finish();
            else frame = window.requestAnimationFrame(step);
        };
        counting.set(element, finish);
        element.setAttribute('data-counting', '');
        element.textContent = countUpText(finalText, 0);
        frame = window.requestAnimationFrame(step);
    }

    /**
     * The count-up starts the first time the element is on screen. When it already is, it starts in
     * this same task, so the painted number never flashes its final value before dropping to 0.
     */
    function countUpWhenSeen(element) {
        if (reduceMotion || !element || counted.has(element) || typeof window.IntersectionObserver !== 'function') return;
        counted.add(element);
        const rect = element.getBoundingClientRect();
        if (rect.bottom > 0 && rect.top < window.innerHeight) {
            runCountUp(element);
            return;
        }
        const observer = new window.IntersectionObserver((entries) => {
            if (!entries.some((entry) => entry.isIntersecting)) return;
            observer.disconnect();
            runCountUp(element);
        }, { threshold: 0.6 });
        observer.observe(element);
    }

    async function getJson(url) {
        const response = await fetch(url, { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        return response.json();
    }

    let overviewState = null;
    let chartRange = 'all';

    function renderOverviewCharts() {
        const rows = orderedRows(overviewState);
        const annotations = overviewState?.annotations ?? [];
        const buttons = [...document.querySelectorAll('[data-chart-range]')];
        const offered = new Set(availableRanges(rows, buttons.map((button) => button.dataset.chartRange)));
        if (!offered.has(chartRange)) chartRange = 'all';
        const charts = [
            ['catalogueChart', 'tokenCount', 'Catalogue size by day'],
            ['holdersChart', 'holderAccounts', 'Summed token holding accounts by day'],
            ['volumeChart', 'volume24Usd', 'Reported rolling 24-hour volume by day']
        ];
        for (const [id, key, label] of charts) {
            const target = document.getElementById(id);
            if (target) target.innerHTML = svgChart(rows, key, { label, range: chartRange, annotations });
        }
        for (const button of buttons) button.hidden = !offered.has(button.dataset.chartRange);
        const group = document.querySelector('.chart-ranges');
        if (group) group.hidden = offered.size <= 1;
        for (const button of buttons) {
            const active = button.dataset.chartRange === chartRange;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
        }
    }

    function renderOverview(overview) {
        overviewState = overview;
        const rows = orderedRows(overview);
        const tokens = metricDelta(rows, 'tokenCount');
        const holders = metricDelta(rows, 'holderAccounts');
        const volume = metricDelta(rows, 'volume24Usd');
        const latest = rows.at(-1);
        setText('tokenTotal', fmtNumber(tokens.latest));
        setText('tokenDelta', tokens.delta === null ? 'First observation' : `${signed(tokens.delta)} since previous snapshot`);
        setText('catalogueValue', fmtNumber(tokens.latest));
        setText('holdersValue', fmtNumber(holders.latest));
        setText('volumeValue', fmtMoney(volume.latest));
        setText('holdersCoverage', latest ? `${fmtNumber(latest.holderCoverage)} / ${fmtNumber(latest.tokenCount)} mints measured` : '—');
        setText('volumeCoverage', latest ? `${fmtNumber(latest.volumeCoverage)} / ${fmtNumber(latest.tokenCount)} mints measured` : '—');
        for (const id of ['catalogueValue', 'holdersValue', 'volumeValue']) countUpWhenSeen(document.getElementById(id));
        const refined = snapshotRefinement(rows);
        if (refined) {
            setText('snapshotTokens', refined.tokens);
            setText('snapshotDateLabel', refined.label);
            setText('snapshotDate', fmtDate(refined.date));
            document.getElementById('snapshotDate')?.setAttribute('datetime', refined.date);
        }
        setText('historyRange', rows.length ? `Available history: ${fmtDate(rows[0].date)}–${fmtDate(rows.at(-1).date)}` : 'No history available');
        renderOverviewCharts();
        const deltas = issuerDeltas(rows);
        const issuerDelta = document.getElementById('issuerDelta');
        if (issuerDelta) issuerDelta.innerHTML = deltas.length === 0
            ? '<span class="delta-pill">No issuer-level catalogue change</span>'
            : deltas.map((row) => `<span class="delta-pill"><strong>${escapeHtml(humanizeSlug(row.issuer))}</strong> ${escapeHtml(signed(row.delta))}</span>`).join('');
        const methodology = overview?.methodology ?? {};
        document.getElementById('methodologyText').innerHTML = Object.values(methodology)
            .map((text) => `<p>${escapeHtml(text)}</p>`).join('');
    }

    function wireChartRanges() {
        for (const button of document.querySelectorAll('[data-chart-range]')) {
            button.addEventListener('click', () => {
                chartRange = button.dataset.chartRange ?? 'all';
                renderOverviewCharts();
            });
        }
    }

    function renderUpdates(items) {
        const target = document.getElementById('updateFeed');
        if (items.length === 0) {
            target.innerHTML = '<p class="empty-state">No dated observations are published yet.</p>';
            return;
        }
        target.innerHTML = items.map((item) => `<article class="update-item">
            <div class="update-meta"><span>${escapeHtml(item.type)}</span><time>${escapeHtml(fmtDate(item.date))}</time></div>
            <h3><a href="${escapeHtml(item.href)}">${escapeHtml(item.title)}</a></h3><p>${escapeHtml(item.detail)}</p>
        </article>`).join('');
    }

    // --- the live trade ticker -------------------------------------------------------------

    const TICKER_AGE_REFRESH_MS = 30000;

    /**
     * Fills and shows the strip. The list is written twice so a CSS translate of -50% loops without
     * a seam; the second copy is hidden from assistive tech and the tab order, and is not displayed
     * at all without motion (landing.css), where the strip is a static row of the newest few.
     */
    function renderTicker(items) {
        const section = document.getElementById('tradeTicker');
        const track = document.getElementById('tickerTrack');
        if (!section || !track) return;
        if (items.length === 0) {
            section.hidden = true;
            return;
        }
        track.innerHTML = items.map((item) => tickerItemHtml(item, false)).join('')
            + items.map((item) => tickerItemHtml(item, true)).join('');
        section.hidden = false;
        track.style.setProperty('--ticker-duration', `${tickerDurationSeconds(track.scrollWidth / 2)}s`);
        const toggle = document.getElementById('tickerToggle');
        if (toggle && !toggle.dataset.wired) {
            toggle.dataset.wired = '1';
            toggle.addEventListener('click', () => {
                const paused = section.classList.toggle('ticker-paused');
                toggle.setAttribute('aria-pressed', paused ? 'true' : 'false');
                toggle.textContent = paused ? 'Play' : 'Pause';
            });
        }
        window.setInterval(() => {
            const now = Date.now();
            for (const time of track.querySelectorAll('time[data-time]')) {
                time.textContent = tickerAge(Number(time.dataset.time), now) ?? '';
            }
        }, TICKER_AGE_REFRESH_MS);
    }

    /**
     * The newest real trades from the same API page live.html reads, each linked to its card through
     * the builder's cardSlug (one small /api/tokens lookup per distinct mint). Any failure hides the
     * strip: it never shows an empty or invented tape.
     */
    async function loadTicker(api, base) {
        try {
            const page = await getJson(api.apiUrl('/api/trades/recent', { limit: 40 }, base));
            const rows = Array.isArray(page?.items) ? page.items : [];
            const shown = tickerItems(rows, new Map(), Date.now());
            if (shown.length === 0) {
                renderTicker([]);
                return;
            }
            const slugs = new Map();
            await Promise.all(tickerMints(shown).map(async (mint) => {
                try {
                    const hit = await getJson(api.apiUrl('/api/tokens', { q: mint, limit: 1 }, base));
                    const token = (Array.isArray(hit?.items) ? hit.items : []).find((row) => row?.mint === mint);
                    if (typeof token?.card_slug === 'string' && token.card_slug) slugs.set(mint, token.card_slug);
                } catch (error) {
                    console.error(`[${new Date().toISOString()}] landing: no card slug for ${mint}`, error);
                }
            }));
            renderTicker(tickerItems(rows, slugs, Date.now()));
        } catch (error) {
            console.error(`[${new Date().toISOString()}] landing: trade ticker unavailable`, error);
            renderTicker([]);
        }
    }

    /** Runs `task` once the page's own load has finished, so the ticker never competes with first paint. */
    function afterLoad(task) {
        if (document.readyState === 'complete') task();
        else window.addEventListener('load', task, { once: true });
    }

    // The hero count is server-rendered, so it can count up from the first frame.
    countUpWhenSeen(document.getElementById('snapshotTokens'));

    async function boot() {
        const api = (typeof __rwaApi !== 'undefined') ? __rwaApi : null;
        wireChartRanges();
        const base = api ? api.apiBase(document, window.location) : '';
        if (api) afterLoad(() => loadTicker(api, base));
        try {
            const [overview, journal] = await Promise.all([
                getJson(api ? api.apiUrl('/api/history/overview', null, base) : '/api/history/overview'),
                getJson('./stocks-change-journal.json')
            ]);
            renderOverview(overview);
            renderUpdates(journalUpdates(journal));
        } catch (error) {
            console.error(`[${new Date().toISOString()}] landing: data unavailable`, error);
            // The build-time snapshot in the hero stays: it is dated, so it remains true without the API.
            setText('tokenDelta', 'Data unavailable');
            renderUpdates([]);
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
    return exported;
}));
