/**
 * Renders whatif.html: the 38 shared failure modes against every issuer, as one matrix
 * (stocks/EVIDENCE.md §6). Rows are the questions grouped by the actor they are about, columns are
 * the issuers, and a cell is one answer's status — clicking it opens the answer itself.
 *
 * Read live from the read-only JSON API and from one static file:
 *   1. the catalogue's questions   /api/failure-modes   (38 rows, with per-status counts)
 *   2. every answer                /api/what-if          (paged, 500 per call; 38 x 12 = 456 max)
 *   3. the issuer names            /api/issuers          (the columns)
 *   4. the actor ORDER and labels  ./stocks/data/trust-chain.json — a display concern the API's
 *      rows cannot carry, read from the same file the builders and the API read. Its absence only
 *      costs the group order, which then follows the order the questions first name each actor.
 *
 * Same origin in production (nginx proxies /api/ to 127.0.0.1:3300); `?api=http://localhost:3300`
 * when this page is served from a dev server, or a <meta name="rwa-api-base"> a deployment plants.
 *
 * The status, actor and issuer filters live in the query string exactly as monitor.html's facets
 * do, so a filtered matrix is a link someone can send. Everything above the DOM section is pure —
 * no DOM, no fetch, no clock — and is exported for jest (whatif-page.test.js). The answer bodies
 * are rendered by stocks/lib/whatif-render.js, the copy the issuer panel and the cards use, so an
 * answer cannot read differently here. Wrapped in a UMD factory so it declares no globals.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.__whatif = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const fmt = (typeof __rwaFmt !== 'undefined') ? __rwaFmt : require('./stocks/lib/fmt.js');
    const whatIfLib = (typeof __rwaWhatIf !== 'undefined')
        ? __rwaWhatIf
        : require('./stocks/lib/whatif-render.js');
    // The schematic kit and the what-if sequence shaper; either may be absent (an older cached
    // page), in which case the answer panel simply has no drawing.
    const flowDiagram = (typeof __rwaFlowDiagram !== 'undefined') ? __rwaFlowDiagram
        : (typeof module !== 'undefined' ? require('./stocks/lib/flow-diagram.js') : null);
    const schematicsLib = (typeof __rwaSchematics !== 'undefined') ? __rwaSchematics
        : (typeof module !== 'undefined' ? require('./stocks/lib/schematics.js') : null);

    const { escapeHtml, humanizeSlug } = fmt;
    const {
        WHATIF_STATUSES, MISSING_STATUS, STATUS_SHORT, STATUS_MEANING,
        actorOrder, actorLabels, countAnswers, normaliseAnswer, normaliseStatus, statusClass
    } = whatIfLib;

    // -----------------------------------------------------------------------
    // Pure section — no DOM, no fetch, no Date.now(). Exported for jest.
    // -----------------------------------------------------------------------

    /** The three things a URL may filter on. Nothing else is read, so the page's own `api` and
     *  `reduceMotion` can never be forwarded to the API, which would 400 them. `issuer` is the
     *  landing an issuer dossier links to (issuers/<slug>.html -> whatif.html?issuer=<slug>). */
    const FILTER_NAMES = ['status', 'actor', 'issuer'];

    /** How many answers one /api/what-if call asks for. The route's own ceiling is 500. */
    const PAGE_SIZE = 500;

    /**
     * A programme's short name for a column header, DERIVED rather than typed, so a thirteenth
     * issuer needs no map entry: the first segment of its slug, spelled the way the issuer's own
     * name spells it. `superstate-opening-bell` + "Opening Bell by Superstate" gives "Superstate"
     * (the name's own capitalisation), `xstocks-backed` + "Kraken xStocks" gives "xStocks".
     *
     * Taking the slug's first segment rather than the name's first word matters: the name's first
     * word is sometimes the product ("Opening Bell") and sometimes a venue ("Kraken"), while the
     * slug is the identifier the API, the dossier and the URL all agree on.
     */
    function shortName(slug, name) {
        const id = typeof slug === 'string' ? slug.trim() : '';
        const full = typeof name === 'string' ? name.trim() : '';
        const head = id.split('-')[0] ?? '';
        if (head === '') return full === '' ? '—' : full;
        for (const word of full.split(/[\s(),.]+/)) {
            if (word.toLowerCase() === head.toLowerCase()) return word;
        }
        return head.charAt(0).toUpperCase() + head.slice(1);
    }

    /** The columns, in the order they are drawn: alphabetical by short name, so it is findable. */
    function issuerColumns(issuers) {
        return (Array.isArray(issuers) ? issuers : [])
            .map((row) => ({
                slug: typeof row?.slug === 'string' ? row.slug : null,
                name: typeof row?.name === 'string' ? row.name : null
            }))
            .filter((row) => row.slug !== null)
            .map((row) => ({ ...row, short: shortName(row.slug, row.name) }))
            .sort((a, b) => a.short.localeCompare(b.short, 'en'));
    }

    /** `<issuer>:<mode>`, which is also the id sonar.what_if gives the row. */
    function answerKey(issuer, mode) {
        return `${issuer}:${mode}`;
    }

    /** Every answer by `<issuer>:<mode>`, normalised once so a cell never re-shapes a row. */
    function indexAnswers(items) {
        const index = new Map();
        for (const row of Array.isArray(items) ? items : []) {
            const issuer = typeof row?.issuer_slug === 'string' ? row.issuer_slug : null;
            const mode = typeof row?.mode_id === 'string' ? row.mode_id : null;
            if (issuer === null || mode === null) continue;
            index.set(answerKey(issuer, mode), normaliseAnswer(row));
        }
        return index;
    }

    /**
     * The filter state a URL asks for. A comma list and a repeated parameter both mean OR, and
     * duplicates collapse — the same reading monitor.html gives its facets. A value that is not one
     * of the six statuses is dropped rather than sent on, so a typo shows the whole matrix instead
     * of an empty one.
     */
    function parseFilterState(search) {
        const params = new URLSearchParams(typeof search === 'string' ? search : '');
        const state = {};
        for (const name of FILTER_NAMES) {
            const values = [];
            for (const raw of params.getAll(name)) {
                for (const piece of String(raw).split(',')) {
                    const value = piece.trim();
                    if (value === '' || values.includes(value)) continue;
                    if (name === 'status' && !WHATIF_STATUSES.includes(value)) continue;
                    values.push(value);
                }
            }
            state[name] = values;
        }
        return state;
    }

    /**
     * The query string that reproduces a state, `extras` (the page's own `api`, `reduceMotion`)
     * first so a shared link keeps pointing at the same API. An empty filter is left out, so an
     * unfiltered matrix has a clean URL; the comma stays literal so it reads as the API's own syntax.
     */
    function filterStateToSearch(state, extras = {}) {
        const parts = [];
        for (const [name, value] of Object.entries(extras && typeof extras === 'object' ? extras : {})) {
            if (value === null || value === undefined || value === '') continue;
            parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
        }
        for (const name of FILTER_NAMES) {
            const values = Array.isArray(state?.[name]) ? state[name].filter((v) => typeof v === 'string' && v !== '') : [];
            if (values.length === 0) continue;
            parts.push(`${encodeURIComponent(name)}=${values.map(encodeURIComponent).join(',')}`);
        }
        return parts.join('&');
    }

    /**
     * The whole matrix: every catalogue question as a row with one cell per issuer, grouped by the
     * actor the question is about.
     *
     * The filters do different things on purpose. `actor` hides ROWS — the questions about a
     * custodian are a readable subset on their own. `issuer` hides COLUMNS: twelve columns do not
     * fit a phone, and one issuer's 38 answers down the page do. A slug that names no column is
     * ignored rather than drawing an empty matrix, the same forgiveness a mistyped status gets. `status` cannot hide cells (a matrix with holes
     * is not a matrix), so it hides the rows in which NO cell has one of the wanted statuses and
     * marks the cells that do, which is how "show me every unknown" reads without lying about the
     * rest of the row.
     *
     * A mode with no answer row for an issuer gets a cell with `status: 'missing'`. That is the
     * whole point of the page: the gap is a finding, so it is drawn rather than left blank.
     */
    function buildMatrix({ modes = [], issuers = [], answers = null, order = null, labels = null, filters = null } = {}) {
        const allColumns = issuerColumns(issuers);
        const wantedIssuers = (Array.isArray(filters?.issuer) ? filters.issuer : [])
            .filter((slug) => allColumns.some((column) => column.slug === slug));
        const columns = wantedIssuers.length === 0 ? allColumns
            : allColumns.filter((column) => wantedIssuers.includes(column.slug));
        const wantedActors = Array.isArray(filters?.actor) ? filters.actor : [];
        const wantedStatuses = Array.isArray(filters?.status) ? filters.status : [];
        const index = answers instanceof Map ? answers : indexAnswers(answers);

        const rows = (Array.isArray(modes) ? modes : []).map((mode) => {
            const id = typeof mode?.id === 'string' ? mode.id : null;
            const actor = typeof mode?.actor === 'string' ? mode.actor : '—';
            const allCells = allColumns.map((column) => {
                const answer = id === null ? null : index.get(answerKey(column.slug, id)) ?? null;
                const status = answer === null ? MISSING_STATUS : normaliseStatus(answer.status);
                const shown = columns.includes(column);
                return {
                    issuer: column.slug,
                    short: column.short,
                    name: column.name,
                    status,
                    marked: shown && wantedStatuses.length > 0 && wantedStatuses.includes(status),
                    answer
                };
            });
            const cells = allCells.filter((cell) => wantedIssuers.length === 0 || wantedIssuers.includes(cell.issuer));
            return {
                mode: id,
                actor,
                actorLabel: typeof mode?.actor_label === 'string' ? mode.actor_label : null,
                flow: typeof mode?.flow === 'string' ? mode.flow : null,
                flowLabel: typeof mode?.flow_label === 'string' ? mode.flow_label : null,
                question: typeof mode?.question === 'string' ? mode.question : id,
                lookFor: typeof mode?.look_for === 'string' ? mode.look_for : null,
                cells,
                allCells,
                counts: countAnswers(cells)
            };
        });

        const kept = rows.filter((row) => {
            if (wantedActors.length > 0 && !wantedActors.includes(row.actor)) return false;
            if (wantedStatuses.length > 0 && !row.cells.some((cell) => cell.marked)) return false;
            return true;
        });

        const groups = [];
        const byActor = new Map();
        for (const row of kept) {
            if (!byActor.has(row.actor)) {
                const group = {
                    actor: row.actor,
                    label: row.actorLabel ?? (typeof labels?.[row.actor] === 'string' ? labels[row.actor] : humanizeSlug(row.actor)),
                    rows: []
                };
                byActor.set(row.actor, group);
                groups.push(group);
            }
            byActor.get(row.actor).rows.push(row);
        }
        if (Array.isArray(order) && order.length > 0) {
            // An actor the catalogue's order does not mention keeps its group, at the end: the
            // catalogue may have moved on, and dropping the group would drop its questions.
            groups.sort((a, b) => {
                const ai = order.indexOf(a.actor);
                const bi = order.indexOf(b.actor);
                return (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi);
            });
        }

        return {
            columns,
            allColumns,
            // The columns an issuer filter narrowed to (empty when none), and the answer counts over
            // just those columns, so the page can say what the narrowed view holds.
            issuerFilter: wantedIssuers.length === 0 ? [] : columns,
            issuerCounts: wantedIssuers.length === 0 ? null : countAnswers(rows.flatMap((row) => row.cells)),
            groups,
            rows: kept,
            total: rows.length,
            shown: kept.length,
            // Over every cell in the whole matrix, filtered or not: the page's headline numbers must
            // not change when a filter narrows what is on screen.
            counts: countAnswers(rows.flatMap((row) => row.allCells))
        };
    }

    /** "456 answers · 38 questions · 12 issuers" — what the matrix is, before any filter. */
    function scopeLine(matrix) {
        const columns = (matrix.allColumns ?? matrix.columns).length;
        const answered = matrix.counts === null ? 0 : (matrix.total * columns) - matrix.counts[MISSING_STATUS];
        return {
            cells: matrix.total * columns,
            answered,
            missing: matrix.counts[MISSING_STATUS],
            questions: matrix.total,
            issuers: columns
        };
    }

    /** The counts line over the whole matrix, reusing the shared chips the panel and cards use. */
    function countsHtml(matrix) {
        return whatIfLib.countsLine(matrix.counts);
    }

    /** What one cell says on hover and to a screen reader — never a colour alone. */
    function cellTitle(row, cell) {
        return `${cell.name ?? cell.short}: ${STATUS_SHORT[cell.status]} — ${row.question}`;
    }

    /** The column header strip: the question column, then one cell per issuer. */
    function headHtml(columns) {
        const cells = columns.map((column) =>
            `<div class="wm-head-i" title="${escapeHtml(column.name ?? column.slug)}">`
            + `${escapeHtml(column.short)}</div>`).join('');
        return `<div class="wm-head" role="row"><div class="wm-head-q">Failure mode</div>${cells}</div>`;
    }

    /**
     * One row: the question, then its twelve cells. With a single column (an issuer filter) the
     * cell also spells its status, because one chip per question has room for the word and a lone
     * colour would otherwise be the only thing saying it.
     */
    function rowHtml(row) {
        const single = row.cells.length === 1;
        const cells = row.cells.map((cell) =>
            `<button type="button" class="wm-cell ${statusClass(cell.status)}${cell.marked ? ' wm-marked' : ''}" `
            + `data-mode="${escapeHtml(row.mode ?? '')}" data-issuer="${escapeHtml(cell.issuer ?? '')}" `
            + `title="${escapeHtml(cellTitle(row, cell))}" `
            + `aria-label="${escapeHtml(cellTitle(row, cell))}">`
            + `<span class="wm-cell-i">${escapeHtml(cell.short)}</span>`
            + `${single ? `<span class="wm-cell-s">${escapeHtml(STATUS_SHORT[cell.status])}</span>` : ''}</button>`).join('');
        return `<div class="wm-row" data-mode="${escapeHtml(row.mode ?? '')}">`
            + `<p class="wm-q">${escapeHtml(row.question ?? '')}</p>`
            + `<div class="wm-cells">${cells}</div></div>`;
    }

    /** The whole matrix, or the fact that the filters left nothing in it. */
    function matrixHtml(matrix) {
        if (matrix.groups.length === 0) {
            return '<p class="wm-empty">No question matches these filters. '
                + 'Clear a filter to see the questions.</p>';
        }
        const groups = matrix.groups.map((group) =>
            `<section class="wm-actor" aria-label="${escapeHtml(group.label)}">`
            + `<h3 class="wm-actor-head">${escapeHtml(group.label)}`
            + `<span class="wm-actor-n">${group.rows.length}</span></h3>`
            + group.rows.map(rowHtml).join('')
            + '</section>').join('');
        return headHtml(matrix.columns) + groups;
    }

    /** Where an issuer's dossier page lives, relative to whatif.html. */
    function dossierHref(slug) {
        return `./issuers/${encodeURIComponent(slug)}.html`;
    }

    /**
     * The banner over an issuer-narrowed matrix: whose answers these are, their counts, the way
     * back to every issuer (a button the page clears the filter with) and the dossier link. Empty
     * when no issuer filter is active.
     */
    function issuerBannerHtml(matrix) {
        const columns = Array.isArray(matrix?.issuerFilter) ? matrix.issuerFilter : [];
        if (columns.length === 0) return '';
        const names = columns.map((column) => `<strong>${escapeHtml(column.name ?? column.short)}</strong>`).join(', ');
        const dossiers = columns.map((column) =>
            `<a href="${escapeHtml(dossierHref(column.slug))}">${escapeHtml(column.short)} dossier →</a>`).join('');
        return `<p class="wm-issuer-who">Showing only ${names}</p>`
            + whatIfLib.countsLine(matrix.issuerCounts)
            + `<p class="wm-issuer-actions"><button type="button" class="wm-clear" data-clear-filter="issuer">Show all issuers</button>${dossiers}</p>`;
    }

    /** The column key, so a short name is never the only thing identifying an issuer. */
    function columnKeyHtml(columns) {
        if (columns.length === 0) return '';
        const items = columns.map((column) =>
            `<li><strong>${escapeHtml(column.short)}</strong> — `
            + `${escapeHtml(column.name ?? column.slug)}</li>`).join('');
        return `<ul class="wm-colkey">${items}</ul>`;
    }

    /** The status legend, each status with the claim it licenses. One paragraph, six rows. */
    function statusKeyHtml() {
        const items = WHATIF_STATUSES.map((status) =>
            `<li class="wm-key-item"><span class="wm-key-swatch ${statusClass(status)}"></span>`
            + `<strong>${escapeHtml(STATUS_SHORT[status])}</strong> — `
            + `${escapeHtml(STATUS_MEANING[status])}</li>`).join('');
        return `<ul class="wm-key">${items}</ul>`;
    }

    /**
     * One answer, flat, for the side panel — the same pieces the issuer panel and the cards render,
     * assembled without the collapsible around them because the panel IS the expansion.
     *
     * A `missing` cell shows what would have to be read for the question to be answered
     * (the catalogue's `lookFor`), because "nobody has looked" is more useful with the search in it.
     */
    function answerPanelHtml(row, cell, catalogue = null) {
        const answer = cell.answer;
        const status = cell.status;
        const parts = [
            `<p class="wm-panel-who"><span class="wi-badge ${statusClass(status)}">`
            + `${escapeHtml(STATUS_SHORT[status])}</span> ${escapeHtml(cell.name ?? cell.short)}`
            + `${row.actorLabel === null ? '' : ` · ${escapeHtml(row.actorLabel)}`}`
            + `${row.flowLabel === null ? '' : ` · ${escapeHtml(row.flowLabel)}`}</p>`
        ];
        if (answer === null || status === MISSING_STATUS) {
            parts.push('<p class="wi-outcome">Nobody has answered this question for this issuer yet. '
                + 'We do not guess an outcome.</p>');
            if (row.lookFor !== null) {
                parts.push(`<p class="wi-sub">What has to be read for it: ${escapeHtml(row.lookFor)}</p>`);
            }
            parts.push(dossierLinkHtml(cell));
            return parts.filter((part) => part !== '').join('');
        }
        // The drawn sequence carries the outcome sentence by sentence; the paragraph is the fallback
        // when there is nothing to draw, so the same words are never printed twice.
        const drawn = answerSequenceHtml(row, cell, catalogue);
        if (drawn !== '') parts.push(drawn);
        else if (answer.outcome !== null) parts.push(`<p class="wi-outcome">${escapeHtml(answer.outcome)}</p>`);
        if (answer.quote !== null) parts.push(`<blockquote class="wi-quote">${escapeHtml(answer.quote)}</blockquote>`);
        parts.push(whatIfLib.sourceHtml(answer));
        parts.push(whatIfLib.casesHtml(answer.cases));
        if (status === 'unknown' || status === 'inferred') {
            parts.push(whatIfLib.searchedHtml(answer.searched));
        }
        if (answer.note !== null) parts.push(`<p class="wi-sub">${escapeHtml(answer.note)}</p>`);
        if (row.lookFor !== null) {
            parts.push(`<details class="wi-searched"><summary>What we look for</summary>`
                + `<p class="wi-sub">${escapeHtml(row.lookFor)}</p></details>`);
        }
        parts.push(dossierLinkHtml(cell));
        return parts.filter((part) => part !== '').join('');
    }

    /**
     * The answer drawn as a sequence (stocks/lib/schematics.js whatIfSpec): the catalogue's trigger
     * at the failing actor, its path to the holder, then the outcome in the answer's own status.
     * Nothing when the catalogue did not load or the answer is not drawable (not-applicable).
     */
    function answerSequenceHtml(row, cell, catalogue) {
        if (!flowDiagram || !schematicsLib || !catalogue || !cell?.answer) return '';
        const spec = schematicsLib.whatIfSpec({
            mode: row.mode ?? cell.answer.mode, answer: cell.answer, catalogue,
            issuerName: cell.name ?? cell.short ?? null, issuerSlug: cell.issuer ?? null
        });
        return spec === null ? '' : flowDiagram.figureHtml(spec, { id: 'wm-seq' });
    }

    /** The panel's way to the whole programme: its dossier page, named so the link reads alone. */
    function dossierLinkHtml(cell) {
        if (typeof cell?.issuer !== 'string' || cell.issuer === '') return '';
        return `<p class="wm-panel-dossier"><a href="${escapeHtml(dossierHref(cell.issuer))}">`
            + `Open the ${escapeHtml(cell.name ?? cell.short)} issuer dossier →</a></p>`;
    }

    /** The order a scoreboard bar stacks its segments: evidence strength first, the gap last. */
    const BOARD_ORDER = ['documented', 'litigated', 'inferred', 'unknown', 'not-applicable', MISSING_STATUS];

    /**
     * The documented-answer scoreboard: per issuer, how its answers to EVERY catalogue question
     * split by status — always over all questions, never the filtered view, so a bar does not
     * shrink when a filter is clicked. A question with no answer row counts as `missing`, so every
     * bar sums to the number of questions. Sorted by documented, then litigated, then name. Each row
     * carries the span of `accessed_at` dates its answers were read on (null when none records one).
     */
    function buildScoreboard({ modes = [], issuers = [], answers = null } = {}) {
        const index = answers instanceof Map ? answers : indexAnswers(answers);
        const ids = (Array.isArray(modes) ? modes : []).map((mode) => (typeof mode?.id === 'string' ? mode.id : null));
        const rows = issuerColumns(issuers).map((column) => {
            const counts = {};
            for (const status of WHATIF_STATUSES) counts[status] = 0;
            const read = [];
            for (const id of ids) {
                const answer = id === null ? null : index.get(answerKey(column.slug, id)) ?? null;
                const status = answer === null ? MISSING_STATUS : normaliseStatus(answer.status);
                counts[status] += 1;
                if (answer !== null && typeof answer.accessedAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(answer.accessedAt)) {
                    read.push(answer.accessedAt.slice(0, 10));
                }
            }
            read.sort();
            return {
                ...column,
                counts,
                total: ids.length,
                readFrom: read.length ? read[0] : null,
                readTo: read.length ? read[read.length - 1] : null
            };
        });
        return rows.sort((a, b) => b.counts.documented - a.counts.documented
            || b.counts.litigated - a.counts.litigated
            || a.short.localeCompare(b.short, 'en'));
    }

    /** "12 documented · 3 litigated · …", only the statuses present, in stacking order. */
    function scoreboardCountsText(row) {
        return BOARD_ORDER.filter((status) => row.counts[status] > 0)
            .map((status) => `${row.counts[status]} ${STATUS_SHORT[status]}`).join(' · ');
    }

    /**
     * The scoreboard as a list of links, one per issuer, each with an inline-SVG stacked bar. The
     * bar's viewBox is the question count wide, so a segment's width IS its count; the counts are
     * also printed, so colour is never the only carrier. `extras` keeps `api`/`reduceMotion` in the
     * link, exactly as the filters' own URLs do.
     */
    function scoreboardHtml(board, extras = {}) {
        if (!Array.isArray(board) || board.length === 0) return '';
        const items = board.map((row) => {
            let x = 0;
            const rects = BOARD_ORDER.filter((status) => row.counts[status] > 0).map((status) => {
                const rect = `<rect class="${statusClass(status)}" x="${x}" y="0" width="${row.counts[status]}" height="1"></rect>`;
                x += row.counts[status];
                return rect;
            }).join('');
            const href = `?${filterStateToSearch({ issuer: [row.slug] }, extras)}`;
            const read = row.readFrom === null ? 'no read date recorded'
                : row.readFrom === row.readTo ? `read ${row.readFrom}` : `read ${row.readFrom} – ${row.readTo}`;
            const label = `${row.name ?? row.short}: ${row.counts.documented} of ${row.total} documented — ${scoreboardCountsText(row)}`;
            return `<li><a class="wm-board-row" href="${escapeHtml(href)}" data-board-issuer="${escapeHtml(row.slug)}" aria-label="${escapeHtml(label)}">`
                + `<span class="wm-board-name">${escapeHtml(row.short)}</span>`
                + `<span class="wm-board-doc">${row.counts.documented}<small>/${row.total}</small></span>`
                + `<svg class="wm-board-bar" viewBox="0 0 ${Math.max(row.total, 1)} 1" preserveAspectRatio="none" aria-hidden="true" focusable="false">${rects}</svg>`
                + `<span class="wm-board-counts">${escapeHtml(scoreboardCountsText(row))} · ${escapeHtml(read)}</span>`
                + '</a></li>';
        }).join('');
        return `<ol class="wm-board">${items}</ol>`;
    }

    /**
     * Start delays (ms) for the one-time row-by-row reveal of `count` rows: `stepMs` apart, but
     * squeezed so the last row starts by `maxMs` however many rows there are — the whole reveal
     * stays short. Whole milliseconds, non-decreasing, the first row at 0.
     */
    function revealDelays(count, { stepMs = 18, maxMs = 480 } = {}) {
        const n = Number.isInteger(count) && count > 0 ? count : 0;
        if (n === 0) return [];
        const step = n === 1 ? 0 : Math.min(stepMs, maxMs / (n - 1));
        return Array.from({ length: n }, (_, i) => Math.round(i * step));
    }

    const api = {
        FILTER_NAMES,
        PAGE_SIZE,
        WHATIF_STATUSES,
        MISSING_STATUS,
        STATUS_SHORT,
        STATUS_MEANING,
        shortName,
        issuerColumns,
        answerKey,
        indexAnswers,
        parseFilterState,
        filterStateToSearch,
        buildMatrix,
        scopeLine,
        countsHtml,
        cellTitle,
        headHtml,
        rowHtml,
        matrixHtml,
        dossierHref,
        issuerBannerHtml,
        columnKeyHtml,
        statusKeyHtml,
        answerPanelHtml,
        BOARD_ORDER,
        buildScoreboard,
        scoreboardCountsText,
        scoreboardHtml,
        revealDelays
    };

    // -----------------------------------------------------------------------
    // Page
    // -----------------------------------------------------------------------

    if (typeof document === 'undefined') return api;

    const apiLib = (typeof __rwaApi !== 'undefined') ? __rwaApi : null;
    const CATALOGUE_PATH = './stocks/data/trust-chain.json';

    const state = {
        modes: [],
        issuers: [],
        answers: new Map(),
        catalogue: null,
        filters: { status: [], actor: [], issuer: [] },
        matrix: null,
        /** 'waiting' until the matrix is first drawn, then 'pending' / 'revealing' / 'done'. */
        reveal: 'waiting'
    };

    const els = {};
    let reduceMotion = false;
    let base = '';

    function logError(what, detail) {
        console.error(`[${new Date().toISOString()}] ${what}${detail ? `: ${detail}` : ''}`);
    }

    function setStatus(message, isError) {
        if (!els.status) return;
        els.status.textContent = message ?? '';
        els.status.hidden = message === null || message === undefined || message === '';
        els.status.classList.toggle('status-error', Boolean(isError));
    }

    async function getJson(path, params) {
        const url = apiLib === null ? path : apiLib.apiUrl(path, params, base);
        const res = await fetch(url, { headers: { accept: 'application/json' } });
        if (!res.ok) {
            const err = new Error(`${url} answered HTTP ${res.status}`);
            err.api = { path: url, status: res.status };
            throw err;
        }
        return res.json();
    }

    /** Every answer, page by page, because 38 x 12 is 456 rows and the route caps a call at 500. */
    async function loadAnswers() {
        const items = [];
        let offset = 0;
        let total = null;
        do {
            const page = await getJson('/api/what-if', { limit: PAGE_SIZE, offset });
            const rows = Array.isArray(page?.items) ? page.items : [];
            items.push(...rows);
            total = Number.isFinite(page?.total) ? page.total : items.length;
            offset += PAGE_SIZE;
            if (rows.length === 0) break;
        } while (items.length < total);
        return items;
    }

    /** The page's own parameters, kept in the URL so a shared link reaches the same API. */
    function urlExtras() {
        const params = new URLSearchParams(window.location.search);
        const extras = {};
        if (params.has('api')) extras.api = params.get('api');
        if (params.has('reduceMotion')) extras.reduceMotion = params.get('reduceMotion') || '1';
        return extras;
    }

    function syncUrl() {
        const search = filterStateToSearch(state.filters, urlExtras());
        window.history.replaceState(null, '', `${window.location.pathname}${search === '' ? '' : `?${search}`}`);
    }

    /** The status and actor chips, each one a toggle, checked against the state the URL asked for. */
    function renderFilters() {
        if (els.statusFilter) {
            els.statusFilter.innerHTML = WHATIF_STATUSES.map((status) =>
                `<button type="button" class="wm-chip ${statusClass(status)}`
                + `${state.filters.status.includes(status) ? ' wm-chip-on' : ''}" `
                + `data-filter="status" data-value="${escapeHtml(status)}" `
                + `aria-pressed="${state.filters.status.includes(status) ? 'true' : 'false'}">`
                + `${escapeHtml(STATUS_SHORT[status])}`
                + `<span class="wm-chip-n">${state.matrix === null ? '' : state.matrix.counts[status]}</span>`
                + '</button>').join('');
        }
        if (els.actorFilter) {
            const order = actorOrder(state.catalogue);
            const labels = actorLabels(state.catalogue);
            const present = [];
            for (const mode of state.modes) {
                if (typeof mode?.actor === 'string' && !present.includes(mode.actor)) present.push(mode.actor);
            }
            present.sort((a, b) => {
                const ai = order.indexOf(a);
                const bi = order.indexOf(b);
                return (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi);
            });
            els.actorFilter.innerHTML = present.map((actor) =>
                `<button type="button" class="wm-chip`
                + `${state.filters.actor.includes(actor) ? ' wm-chip-on' : ''}" `
                + `data-filter="actor" data-value="${escapeHtml(actor)}" `
                + `aria-pressed="${state.filters.actor.includes(actor) ? 'true' : 'false'}">`
                + `${escapeHtml(labels[actor] ?? humanizeSlug(actor))}</button>`).join('');
        }
    }

    function render() {
        state.matrix = buildMatrix({
            modes: state.modes,
            issuers: state.issuers,
            answers: state.answers,
            order: actorOrder(state.catalogue),
            labels: actorLabels(state.catalogue),
            filters: state.filters
        });
        const scope = scopeLine(state.matrix);
        if (els.scope) {
            els.scope.textContent = `${scope.questions} questions × ${scope.issuers} issuers = `
                + `${scope.cells} cells · ${scope.answered} answered · ${scope.missing} not yet asked of anyone`;
        }
        if (els.counts) els.counts.innerHTML = countsHtml(state.matrix);
        if (els.shown) {
            els.shown.textContent = state.matrix.shown === state.matrix.total
                ? `all ${state.matrix.total}`
                : `${state.matrix.shown} of ${state.matrix.total}`;
        }
        if (els.matrix) {
            els.matrix.style.setProperty('--wm-cols', String(state.matrix.columns.length));
            // A re-render mid-reveal (a filter clicked) shows the new rows at once.
            if (state.reveal === 'revealing' || state.reveal === 'pending') finishReveal();
            els.matrix.innerHTML = matrixHtml(state.matrix);
            if (state.reveal === 'waiting') startRevealOnView();
        }
        if (els.colKey) els.colKey.innerHTML = columnKeyHtml(state.matrix.columns);
        if (els.board) {
            els.board.innerHTML = scoreboardHtml(buildScoreboard({
                modes: state.modes, issuers: state.issuers, answers: state.answers
            }), urlExtras());
            for (const link of els.board.querySelectorAll('[data-board-issuer]')) {
                const on = state.filters.issuer.includes(link.getAttribute('data-board-issuer'));
                if (on) link.setAttribute('aria-current', 'true');
                else link.removeAttribute('aria-current');
            }
        }
        if (els.issuerBanner) {
            els.issuerBanner.innerHTML = issuerBannerHtml(state.matrix);
            els.issuerBanner.hidden = state.matrix.issuerFilter.length === 0;
        }
        renderFilters();
    }

    /**
     * The first time the drawn matrix is on screen its rows fade in top to bottom (whatif.css,
     * .wm-revealing), once and briefly. Already on screen when drawn: it starts in the same task, so
     * the rows never paint before they fade. Reduced motion, or no IntersectionObserver: no reveal.
     */
    function startRevealOnView() {
        if (reduceMotion || typeof window.IntersectionObserver !== 'function' || !els.matrix.querySelector('.wm-row')) {
            state.reveal = 'done';
            return;
        }
        state.reveal = 'pending';
        const rect = els.matrix.getBoundingClientRect();
        if (rect.top < window.innerHeight && rect.bottom > 0) {
            runReveal();
            return;
        }
        state.revealObserver = new window.IntersectionObserver((entries) => {
            if (!entries.some((entry) => entry.isIntersecting)) return;
            runReveal();
        }, { rootMargin: '0px 0px 120px 0px' });
        state.revealObserver.observe(els.matrix);
    }

    function runReveal() {
        state.revealObserver?.disconnect();
        state.revealObserver = null;
        const rows = [...els.matrix.querySelectorAll('.wm-row')];
        const delays = revealDelays(rows.length);
        rows.forEach((row, index) => row.style.setProperty('--wm-reveal-delay', `${delays[index]}ms`));
        state.reveal = 'revealing';
        els.matrix.classList.add('wm-revealing');
        // Done when the last row's fade ends; animationcancel covers a row removed mid-fade.
        const last = rows.at(-1);
        const end = (event) => {
            if (event.target === last) finishReveal();
        };
        els.matrix.addEventListener('animationend', end);
        els.matrix.addEventListener('animationcancel', end);
        state.revealEnd = end;
    }

    function finishReveal() {
        state.revealObserver?.disconnect();
        state.revealObserver = null;
        if (state.revealEnd) {
            els.matrix.removeEventListener('animationend', state.revealEnd);
            els.matrix.removeEventListener('animationcancel', state.revealEnd);
            state.revealEnd = null;
        }
        els.matrix.classList.remove('wm-revealing');
        els.matrix.classList.add('wm-revealed');
        state.reveal = 'done';
    }

    /** Opens the answer panel for one cell. */
    function openAnswer(modeId, issuerSlug) {
        if (state.matrix === null) return;
        const row = state.matrix.rows.find((candidate) => candidate.mode === modeId);
        if (!row) return;
        const cell = row.cells.find((candidate) => candidate.issuer === issuerSlug);
        if (!cell) return;
        els.answerTitle.textContent = row.question ?? modeId;
        els.answerBody.innerHTML = answerPanelHtml(row, cell, state.catalogue);
        els.answerBody.scrollTop = 0;
        if (typeof els.answer.showModal === 'function') els.answer.showModal();
        else els.answer.setAttribute('open', '');
    }

    function closeAnswer() {
        if (typeof els.answer.close === 'function') els.answer.close();
        else els.answer.removeAttribute('open');
    }

    function wireEvents() {
        document.addEventListener('click', (event) => {
            const chip = event.target.closest('button[data-filter]');
            if (chip) {
                const name = chip.getAttribute('data-filter');
                const value = chip.getAttribute('data-value');
                const values = state.filters[name] ?? [];
                state.filters[name] = values.includes(value)
                    ? values.filter((entry) => entry !== value)
                    : [...values, value];
                syncUrl();
                render();
                return;
            }
            const clearOne = event.target.closest('button[data-clear-filter]');
            if (clearOne) {
                state.filters[clearOne.getAttribute('data-clear-filter')] = [];
                syncUrl();
                render();
                return;
            }
            if (event.target.closest('#clearFilters')) {
                state.filters = { status: [], actor: [], issuer: [] };
                syncUrl();
                render();
                return;
            }
            const boardLink = event.target.closest('a[data-board-issuer]');
            if (boardLink && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) {
                event.preventDefault();
                state.filters.issuer = [boardLink.getAttribute('data-board-issuer')];
                syncUrl();
                render();
                document.getElementById('matrixSection')?.scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
                return;
            }
            const cell = event.target.closest('button.wm-cell');
            if (cell) {
                openAnswer(cell.getAttribute('data-mode'), cell.getAttribute('data-issuer'));
            }
        });
        els.answerClose.addEventListener('click', closeAnswer);
        // Clicking the backdrop: the dialog element itself is the only hit target outside the panel.
        els.answer.addEventListener('click', (event) => {
            if (event.target === els.answer) closeAnswer();
        });
    }

    async function boot() {
        els.status = document.getElementById('status');
        els.scope = document.getElementById('scope');
        els.counts = document.getElementById('counts');
        els.shown = document.getElementById('shown');
        els.statusFilter = document.getElementById('statusFilter');
        els.actorFilter = document.getElementById('actorFilter');
        els.statusKey = document.getElementById('statusKey');
        els.matrix = document.getElementById('matrix');
        els.colKey = document.getElementById('colKey');
        els.board = document.getElementById('scoreboard');
        els.issuerBanner = document.getElementById('issuerBanner');
        els.answer = document.getElementById('answerPanel');
        els.answerTitle = document.getElementById('answerTitle');
        els.answerBody = document.getElementById('answerBody');
        els.answerClose = document.getElementById('answerClose');

        // Reduced motion is an accessibility setting first and the test hook second: with it, the
        // matrix's one-time row reveal is skipped and the rows are simply there.
        reduceMotion = new URLSearchParams(window.location.search).has('reduceMotion')
            || (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        if (reduceMotion) document.body.classList.add('reduce-motion');

        if (els.statusKey) els.statusKey.innerHTML = statusKeyHtml();
        state.filters = parseFilterState(window.location.search);

        if (apiLib === null) {
            setStatus('stocks/lib/api-base.js did not load, so this page cannot find the API.', true);
            logError('stocks/lib/api-base.js is missing', null);
            return;
        }
        base = apiLib.apiBase();
        wireEvents();
        setStatus('Loading the catalogue and every answer…', false);

        // The catalogue file is fetched from the page's own origin, not the API, and its absence is
        // not an error: it only supplies the group ORDER and the actor labels.
        const catalogue = await fetch(CATALOGUE_PATH)
            .then((res) => (res.ok ? res.json() : null))
            .catch(() => null);
        if (catalogue === null) logError(`${CATALOGUE_PATH} did not load; actors group in question order`);
        state.catalogue = catalogue;

        try {
            const [modes, issuers, answers] = await Promise.all([
                getJson('/api/failure-modes', null),
                getJson('/api/issuers', null),
                loadAnswers()
            ]);
            state.modes = Array.isArray(modes?.items) ? modes.items : [];
            state.issuers = Array.isArray(issuers?.items) ? issuers.items : [];
            state.answers = indexAnswers(answers);
            if (state.modes.length === 0 || state.issuers.length === 0) {
                setStatus('The API answered, but returned no questions or no issuers, so there is nothing to draw.', true);
                return;
            }
            render();
            setStatus(null, false);
        } catch (err) {
            logError('the what-if surface did not answer', err.api ? JSON.stringify(err.api) : err.message);
            setStatus(`${err.message}. We show nothing instead of a partial matrix.`, true);
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

    return api;
}));
