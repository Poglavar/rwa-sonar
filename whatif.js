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
 * The status filter and the actor filter live in the query string exactly as monitor.html's facets
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

    const { escapeHtml, humanizeSlug } = fmt;
    const {
        WHATIF_STATUSES, MISSING_STATUS, STATUS_SHORT, STATUS_MEANING,
        actorOrder, actorLabels, countAnswers, normaliseAnswer, normaliseStatus, statusClass
    } = whatIfLib;

    // -----------------------------------------------------------------------
    // Pure section — no DOM, no fetch, no Date.now(). Exported for jest.
    // -----------------------------------------------------------------------

    /** The two things a URL may filter on. Nothing else is read, so the page's own `api` and
     *  `reduceMotion` can never be forwarded to the API, which would 400 them. */
    const FILTER_NAMES = ['status', 'actor'];

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
     * The two filters do different things on purpose. `actor` hides ROWS — the questions about a
     * custodian are a readable subset on their own. `status` cannot hide cells (a matrix with holes
     * is not a matrix), so it hides the rows in which NO cell has one of the wanted statuses and
     * marks the cells that do, which is how "show me every unknown" reads without lying about the
     * rest of the row.
     *
     * A mode with no answer row for an issuer gets a cell with `status: 'missing'`. That is the
     * whole point of the page: the gap is a finding, so it is drawn rather than left blank.
     */
    function buildMatrix({ modes = [], issuers = [], answers = null, order = null, labels = null, filters = null } = {}) {
        const columns = issuerColumns(issuers);
        const wantedActors = Array.isArray(filters?.actor) ? filters.actor : [];
        const wantedStatuses = Array.isArray(filters?.status) ? filters.status : [];
        const index = answers instanceof Map ? answers : indexAnswers(answers);

        const rows = (Array.isArray(modes) ? modes : []).map((mode) => {
            const id = typeof mode?.id === 'string' ? mode.id : null;
            const actor = typeof mode?.actor === 'string' ? mode.actor : '—';
            const cells = columns.map((column) => {
                const answer = id === null ? null : index.get(answerKey(column.slug, id)) ?? null;
                const status = answer === null ? MISSING_STATUS : normaliseStatus(answer.status);
                return {
                    issuer: column.slug,
                    short: column.short,
                    name: column.name,
                    status,
                    marked: wantedStatuses.length > 0 && wantedStatuses.includes(status),
                    answer
                };
            });
            return {
                mode: id,
                actor,
                actorLabel: typeof mode?.actor_label === 'string' ? mode.actor_label : null,
                flow: typeof mode?.flow === 'string' ? mode.flow : null,
                flowLabel: typeof mode?.flow_label === 'string' ? mode.flow_label : null,
                question: typeof mode?.question === 'string' ? mode.question : id,
                lookFor: typeof mode?.look_for === 'string' ? mode.look_for : null,
                cells,
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
            groups,
            rows: kept,
            total: rows.length,
            shown: kept.length,
            // Over every cell in the whole matrix, filtered or not: the page's headline numbers must
            // not change when a filter narrows what is on screen.
            counts: countAnswers(rows.flatMap((row) => row.cells))
        };
    }

    /** "456 answers · 38 questions · 12 issuers" — what the matrix is, before any filter. */
    function scopeLine(matrix) {
        const answered = matrix.counts === null ? 0 : (matrix.total * matrix.columns.length) - matrix.counts[MISSING_STATUS];
        return {
            cells: matrix.total * matrix.columns.length,
            answered,
            missing: matrix.counts[MISSING_STATUS],
            questions: matrix.total,
            issuers: matrix.columns.length
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

    /** One row: the question, then its twelve cells. */
    function rowHtml(row) {
        const cells = row.cells.map((cell) =>
            `<button type="button" class="wm-cell ${statusClass(cell.status)}${cell.marked ? ' wm-marked' : ''}" `
            + `data-mode="${escapeHtml(row.mode ?? '')}" data-issuer="${escapeHtml(cell.issuer ?? '')}" `
            + `title="${escapeHtml(cellTitle(row, cell))}" `
            + `aria-label="${escapeHtml(cellTitle(row, cell))}">`
            + `<span class="wm-cell-i">${escapeHtml(cell.short)}</span></button>`).join('');
        return `<div class="wm-row" data-mode="${escapeHtml(row.mode ?? '')}">`
            + `<p class="wm-q">${escapeHtml(row.question ?? '')}</p>`
            + `<div class="wm-cells">${cells}</div></div>`;
    }

    /** The whole matrix, or the fact that the filters left nothing in it. */
    function matrixHtml(matrix) {
        if (matrix.groups.length === 0) {
            return '<p class="wm-empty">No question matches these filters. '
                + 'The questions are still there — clear a filter to see them.</p>';
        }
        const groups = matrix.groups.map((group) =>
            `<section class="wm-actor" aria-label="${escapeHtml(group.label)}">`
            + `<h3 class="wm-actor-head">${escapeHtml(group.label)}`
            + `<span class="wm-actor-n">${group.rows.length}</span></h3>`
            + group.rows.map(rowHtml).join('')
            + '</section>').join('');
        return headHtml(matrix.columns) + groups;
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
    function answerPanelHtml(row, cell) {
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
                + 'The question stands and the gap is the finding — no outcome is guessed at here.</p>');
            if (row.lookFor !== null) {
                parts.push(`<p class="wi-sub">What has to be read for it: ${escapeHtml(row.lookFor)}</p>`);
            }
            return parts.join('');
        }
        if (answer.outcome !== null) parts.push(`<p class="wi-outcome">${escapeHtml(answer.outcome)}</p>`);
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
        return parts.filter((part) => part !== '').join('');
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
        columnKeyHtml,
        statusKeyHtml,
        answerPanelHtml
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
        filters: { status: [], actor: [] },
        matrix: null
    };

    const els = {};
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
            els.matrix.innerHTML = matrixHtml(state.matrix);
        }
        if (els.colKey) els.colKey.innerHTML = columnKeyHtml(state.matrix.columns);
        renderFilters();
    }

    /** Opens the answer panel for one cell. */
    function openAnswer(modeId, issuerSlug) {
        if (state.matrix === null) return;
        const row = state.matrix.rows.find((candidate) => candidate.mode === modeId);
        if (!row) return;
        const cell = row.cells.find((candidate) => candidate.issuer === issuerSlug);
        if (!cell) return;
        els.answerTitle.textContent = row.question ?? modeId;
        els.answerBody.innerHTML = answerPanelHtml(row, cell);
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
            if (event.target.closest('#clearFilters')) {
                state.filters = { status: [], actor: [] };
                syncUrl();
                render();
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
        els.answer = document.getElementById('answerPanel');
        els.answerTitle = document.getElementById('answerTitle');
        els.answerBody = document.getElementById('answerBody');
        els.answerClose = document.getElementById('answerClose');

        // Reduced motion is an accessibility setting first and the test hook second; nothing on
        // this page animates, so the class only exists to keep the parameter meaningful in a link.
        const reduceMotion = new URLSearchParams(window.location.search).has('reduceMotion')
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
                setStatus('The API answered, but with no questions or no issuers — nothing to draw.', true);
                return;
            }
            render();
            setStatus(null, false);
        } catch (err) {
            logError('the what-if surface did not answer', err.api ? JSON.stringify(err.api) : err.message);
            setStatus(`${err.message}. Nothing is shown rather than a partial matrix.`, true);
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

    return api;
}));
