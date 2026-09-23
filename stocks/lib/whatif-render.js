/*
 * Renders the what-if answers (stocks/EVIDENCE.md §6.3) — one shape in, one block of HTML out —
 * for all three places they are shown: the issuer panel on stocks.html (rows from
 * /api/issuers/:slug/what-if), the static cards (entries straight out of a dossier at build time)
 * and the answer panel on whatif.html. Pure: no DOM, no fetch, no clock.
 *
 * Two input shapes reach normaliseAnswer(): the API's snake_case row, which already carries its
 * mode's question and actor and the joined source, and a dossier's own `whatIf[]` entry, which
 * carries neither and is matched to its catalogue mode by the caller. Both come out as the same
 * object, so nothing downstream has to know which it was given.
 *
 * The one rule this file exists to hold: `missing` is NOT an answer. A mode nobody has answered is
 * rendered as a gap, never as a `not-applicable` and never dropped from the list — the catalogue's
 * whole point is that every issuer faces the same 38 questions, so an absent answer has to be as
 * visible as a present one. The six statuses and their colours are .wi-s-* in trustchain.css,
 * painted with the --wi-* tokens of stocks.css and card.css; nothing here picks a colour.
 *
 * UMD-wrapped like fmt.js, so one copy serves the classic scripts (window.__rwaWhatIf, needs
 * fmt.js first), the ESM card builder (import) and jest (require). Its grouping and counts are
 * tested through the callers, in ../stocks-page.test.js, ../whatif-page.test.js and ../cards.test.js.
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./fmt.js'));
    else root.__rwaWhatIf = factory(root.__rwaFmt);
})(this, function (fmt) {
    'use strict';

    const { escapeHtml, isSafeUrl, fmtDate } = fmt;

    /** The five statuses a stored answer may carry, in the catalogue's own order. */
    const ANSWER_STATUSES = ['documented', 'inferred', 'litigated', 'unknown', 'not-applicable'];

    /** What the absence of an answer is called. Never stored — the table's CHECK rejects it. */
    const MISSING_STATUS = 'missing';

    /** All six, which is what every count set and every filter runs over. */
    const WHATIF_STATUSES = [...ANSWER_STATUSES, MISSING_STATUS];

    /** The short form each status prints in a counts line; `not-applicable` is too long for one. */
    const STATUS_SHORT = {
        documented: 'documented',
        inferred: 'inferred',
        litigated: 'litigated',
        unknown: 'unknown',
        'not-applicable': 'n/a',
        missing: 'missing'
    };

    /**
     * One clause per status, used by the page headers. Deliberately the same claim the catalogue's
     * own `answerStatuses` makes, shortened: an outcome is never invented, so each status says
     * exactly what licenses it.
     */
    const STATUS_MEANING = {
        documented: 'the issuer’s or a regulator’s own document addresses this case, and the quote is shown',
        inferred: 'the documents do not address it; the structure implies the answer and we say so',
        litigated: 'a court, tribunal or regulator decided this or a materially identical case',
        unknown: 'we looked and the documents do not say — where we looked is listed',
        'not-applicable': 'the case cannot arise for this structure, and the note says why',
        missing: 'nobody has answered this question for this issuer yet'
    };

    function str(value) {
        if (typeof value !== 'string') return null;
        const text = value.trim();
        return text === '' ? null : text;
    }

    function list(value) {
        return Array.isArray(value) ? value : [];
    }

    /** Prose cut at a word boundary with a visible ellipsis; blank stays null. */
    function cut(value, max) {
        const text = str(value);
        if (text === null || !(max > 0) || text.length <= max) return text;
        const head = text.slice(0, max);
        const space = head.lastIndexOf(' ');
        return `${(space > max * 0.6 ? head.slice(0, space) : head).replace(/[\s,;:.]+$/, '')}…`;
    }

    /** The CSS class for a status; anything unrecognised is treated as a gap, never as an answer. */
    function statusClass(status) {
        return `wi-s-${WHATIF_STATUSES.includes(status) ? status : MISSING_STATUS}`;
    }

    /** A status string that is one of the six, or `missing`. */
    function normaliseStatus(status) {
        const text = str(status);
        return text !== null && WHATIF_STATUSES.includes(text) ? text : MISSING_STATUS;
    }

    /**
     * The catalogue's own actor order, which is the order the groups are shown in — top of the
     * chain (the holder) first. It is a display concern the API's rows cannot carry, so every
     * caller reads it from stocks/data/trust-chain.json: the page fetches the file, the card
     * builder imports it.
     */
    function actorOrder(catalogue) {
        return list(catalogue?.actors).map((actor) => str(actor?.id)).filter((id) => id !== null);
    }

    /** `{actorId: label}` from the catalogue, for the callers whose rows carry no label. */
    function actorLabels(catalogue) {
        const labels = Object.create(null);
        for (const actor of list(catalogue?.actors)) {
            const id = str(actor?.id);
            if (id !== null) labels[id] = str(actor?.label) ?? id;
        }
        return labels;
    }

    /**
     * One answer in the shape everything below renders. `row` may be an API row (snake_case, with
     * its mode and source joined on) or a dossier `whatIf[]` entry; `mode` is the catalogue entry
     * that names the question, needed only for the dossier case. An entry with neither keeps a
     * null question rather than inventing one.
     */
    function normaliseAnswer(row, mode = null, { archives = null } = {}) {
        const id = str(row?.mode_id) ?? str(row?.mode) ?? str(mode?.id);
        const url = str(row?.url);
        const archive = str(row?.source_archive_url)
            ?? (archives && url !== null ? str(archives[url]) : null);
        return {
            mode: id,
            actor: str(row?.actor) ?? str(mode?.actor),
            actorLabel: str(row?.actor_label),
            flow: str(row?.flow) ?? str(mode?.flow),
            flowLabel: str(row?.flow_label),
            question: str(row?.question) ?? str(mode?.question),
            lookFor: str(row?.look_for) ?? str(mode?.lookFor),
            ord: Number.isFinite(row?.ord) ? row.ord : (Number.isFinite(mode?.ord) ? mode.ord : null),
            status: normaliseStatus(row?.status),
            outcome: str(row?.outcome),
            quote: str(row?.quote),
            url,
            locator: str(row?.locator),
            accessedAt: str(row?.accessed_at) ?? str(row?.accessedAt),
            sourceTitle: str(row?.source_title),
            archiveUrl: archive,
            cases: list(row?.cases).map((entry) => ({
                name: str(entry?.name),
                court: str(entry?.court),
                date: str(entry?.date),
                url: str(entry?.url),
                holding: str(entry?.holding)
            })),
            searched: list(row?.searched).map((entry) => str(entry)).filter((entry) => entry !== null),
            note: str(row?.note)
        };
    }

    /** The answer sheet /api/issuers/:slug/what-if returns, normalised in the order it arrived. */
    function answersFromApi(items) {
        return list(items).map((row) => normaliseAnswer(row));
    }

    /**
     * A dossier's `whatIf[]` against the catalogue: every mode in catalogue order, the ones with no
     * entry carrying `status: 'missing'`. The gap is produced here rather than left to the caller,
     * because a caller that forgot would render a short list that looks complete.
     */
    function answersFromDossier(whatIf, catalogue, { archives = null } = {}) {
        const byMode = Object.create(null);
        for (const entry of list(whatIf)) {
            const id = str(entry?.mode);
            if (id !== null && !byMode[id]) byMode[id] = entry;
        }
        return list(catalogue?.failureModes).map((mode, index) => {
            const id = str(mode?.id);
            const entry = id === null ? null : byMode[id] ?? null;
            return normaliseAnswer(entry ?? { mode: id }, { ...mode, ord: index }, { archives });
        });
    }

    /** Per-status counts, every one of the six keys always present. */
    function countAnswers(answers) {
        const counts = {};
        for (const status of WHATIF_STATUSES) counts[status] = 0;
        for (const answer of list(answers)) {
            const status = normaliseStatus(answer?.status);
            counts[status] += 1;
        }
        return counts;
    }

    /**
     * "26 documented · 8 inferred · 1 unknown · 3 n/a" — the statuses with none of them left out,
     * so the line is the shape of this issuer's answer sheet rather than a fixed six-part template.
     * A sheet with nothing in it says so instead of printing an empty line.
     */
    function countsLine(counts) {
        const parts = WHATIF_STATUSES
            .filter((status) => Number.isFinite(counts?.[status]) && counts[status] > 0)
            .map((status) => `<span class="wi-count ${statusClass(status)}">`
                + `<span class="wi-count-n">${counts[status]}</span> ${escapeHtml(STATUS_SHORT[status])}</span>`);
        if (parts.length === 0) return '<p class="wi-counts">No answers recorded yet.</p>';
        return `<p class="wi-counts">${parts.join('')}</p>`;
    }

    /**
     * The answers grouped by actor. `order` is the catalogue's actor order (a display concern the
     * API does not carry); without it, actors group in the order the questions first name them.
     * `labels` maps an actor id to its label, for the callers whose rows do not carry one.
     */
    function groupByActor(answers, { order = null, labels = null } = {}) {
        const groups = new Map();
        for (const answer of list(answers)) {
            const actor = str(answer?.actor) ?? '—';
            if (!groups.has(actor)) {
                groups.set(actor, {
                    actor,
                    label: str(answer?.actorLabel) ?? str(labels?.[actor]) ?? actor,
                    answers: []
                });
            }
            groups.get(actor).answers.push(answer);
        }
        if (!Array.isArray(order)) return [...groups.values()];
        const sorted = [];
        for (const actor of order) {
            if (groups.has(actor)) {
                sorted.push(groups.get(actor));
                groups.delete(actor);
            }
        }
        // An actor the order does not mention still gets its group, at the end: the catalogue may
        // have moved on, and dropping the group would drop its questions with it.
        return [...sorted, ...groups.values()];
    }

    /** `read 18 Sep 2026`, or '' when nothing was read — which only `not-applicable` licenses. */
    function readLine(accessedAt) {
        const date = fmtDate(accessedAt);
        return date === null || date === undefined || date === '' || date === '—'
            ? ''
            : `read ${escapeHtml(date)}`;
    }

    function linkHtml(url, label) {
        if (!isSafeUrl(url)) return '';
        return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
    }

    /** What identifies one source across a sheet: its URL, or its title when it has no URL. */
    function sourceKey(answer) {
        return str(answer?.url) ?? str(answer?.sourceTitle);
    }

    /**
     * The distinct sources of one answer sheet, numbered in the order they are first cited. A sheet
     * of 38 answers usually rests on a handful of documents — one prospectus, one terms page — and
     * the panel can afford to repeat the title and the URL on every row while a byte-capped card
     * cannot: 38 copies of one 150-character URL is 5.7 kB of the same string. So a card cites
     * `[1]` and prints the source once at the foot of the section, which is what a footnote is for.
     */
    function sourceIndex(answers) {
        const byKey = new Map();
        for (const answer of list(answers)) {
            const key = sourceKey(answer);
            if (key === null || byKey.has(key)) continue;
            byKey.set(key, {
                n: byKey.size + 1,
                url: str(answer?.url),
                title: str(answer?.sourceTitle),
                archiveUrl: str(answer?.archiveUrl)
            });
        }
        return byKey;
    }

    /**
     * Source, locator, read date and the archived copy, as one meta line. With `refs` (a
     * sourceIndex) the source becomes its footnote number; without one it is named in full.
     */
    function sourceHtml(answer, refs = null) {
        const parts = [];
        const key = sourceKey(answer);
        const ref = refs === null || key === null ? null : refs.get(key) ?? null;
        if (ref !== null) {
            parts.push(`<a class="wi-ref" href="#wi-src-${ref.n}">[${ref.n}]</a>`);
        } else {
            const title = answer.sourceTitle ?? answer.url;
            if (isSafeUrl(answer.url)) parts.push(linkHtml(answer.url, cut(title, 90) ?? answer.url));
            else if (title !== null && title !== undefined) parts.push(escapeHtml(cut(title, 90)));
            // The archived copy is what survives the source moving, so it is offered beside the
            // live link rather than instead of it.
            if (isSafeUrl(answer.archiveUrl)) parts.push(linkHtml(answer.archiveUrl, 'archived copy'));
        }
        if (answer.locator !== null && answer.locator !== undefined) parts.push(escapeHtml(answer.locator));
        const read = readLine(answer.accessedAt);
        if (read !== '') parts.push(read);
        if (parts.length === 0) return '';
        return `<p class="wi-meta">${parts.join(' · ')}</p>`;
    }

    /** The numbered source list a `refs` sheet points at, with each archived copy beside its live URL. */
    function sourcesHtml(refs) {
        if (refs === null || refs.size === 0) return '';
        const items = [...refs.values()].map((ref) => {
            const label = cut(ref.title ?? ref.url, 140) ?? 'source';
            const head = isSafeUrl(ref.url) ? linkHtml(ref.url, label) : escapeHtml(label);
            const archive = isSafeUrl(ref.archiveUrl) ? ` · ${linkHtml(ref.archiveUrl, 'archived copy')}` : '';
            return `<li id="wi-src-${ref.n}">${head}${archive}</li>`;
        }).join('');
        return `<h5 class="wi-actor-head">Sources</h5><ol class="wi-sources">${items}</ol>`;
    }

    function casesHtml(cases) {
        if (cases.length === 0) return '';
        const items = cases.map((entry) => {
            const name = entry.name ?? 'unnamed case';
            const head = isSafeUrl(entry.url) ? linkHtml(entry.url, name) : escapeHtml(name);
            const where = [entry.court, entry.date].filter((v) => v !== null).map(escapeHtml).join(', ');
            return `<li>${head}${where === '' ? '' : ` — ${where}`}`
                + `${entry.holding === null ? '' : `<br /><em>${escapeHtml(entry.holding)}</em>`}</li>`;
        }).join('');
        return `<p class="wi-sub">Decided:</p><ul class="wi-cases">${items}</ul>`;
    }

    /**
     * Where we looked, collapsed. Shown for `unknown` and `inferred`, the two statuses whose
     * honesty depends on it: a gap is only evidence if the search behind it is on the record.
     */
    /**
     * One "where we looked" entry. Most are `<url> — <what was found>`: only the leading URL is
     * the link and the rest is text; the whole line as an href was a dead link (2026-09-23).
     */
    function searchedEntryHtml(entry) {
        const text = String(entry ?? '');
        const match = /^(\S+)(\s[\s\S]*)?$/.exec(text.trim());
        if (!match || !isSafeUrl(match[1])) return escapeHtml(text);
        return linkHtml(match[1], match[1]) + (match[2] ? escapeHtml(match[2]) : '');
    }

    function searchedHtml(searched) {
        if (searched.length === 0) return '';
        const items = searched.map((entry) => `<li>${searchedEntryHtml(entry)}</li>`).join('');
        return `<details class="wi-searched"><summary>Where we looked (${searched.length})</summary>`
            + `<ul>${items}</ul></details>`;
    }

    /**
     * One answer as a collapsible row. The options exist for the cards, which are byte-capped:
     * `quote`, `note`, `cases` and `searched` can each be left off and the outcome cut, and
     * `href` then links out to the issuer panel that carries all of it.
     */
    function answerHtml(answer, options = {}) {
        const {
            quote = true, note = true, cases = true, searched = true,
            maxOutcome = 0, maxQuote = 0, open = false, refs = null
        } = options;
        const status = normaliseStatus(answer?.status);
        const body = [];
        // The gap says what a gap is. Only `missing` gets those words: an answer that carries a
        // status but no outcome is a malformed answer, and printing the gap's prose over it would
        // hide that instead of showing it.
        const outcome = status === MISSING_STATUS
            ? (cut(answer?.outcome, maxOutcome)
                ?? 'Not answered yet for this issuer. The question stands; nobody has read the documents for it.')
            : cut(answer?.outcome, maxOutcome);
        if (outcome !== null) body.push(`<p class="wi-outcome">${escapeHtml(outcome)}</p>`);
        if (quote && answer?.quote !== null && answer?.quote !== undefined) {
            body.push(`<blockquote class="wi-quote">${escapeHtml(cut(answer.quote, maxQuote))}</blockquote>`);
        }
        body.push(sourceHtml(answer, refs));
        if (cases) body.push(casesHtml(list(answer?.cases)));
        if (searched && (status === 'unknown' || status === 'inferred')) {
            body.push(searchedHtml(list(answer?.searched)));
        }
        if (note && answer?.note !== null && answer?.note !== undefined) {
            body.push(`<p class="wi-sub">${escapeHtml(answer.note)}</p>`);
        }
        const inner = body.filter((part) => part !== '').join('');
        // No data-status: the badge's wi-s-<status> class already carries it, nothing read the
        // attribute, and 38 copies per card were ~1 kB of the 96 kB card budget (2026-09-23).
        return `<li><details class="wi-item" data-mode="${escapeHtml(answer?.mode ?? '')}"`
            + `${open ? ' open' : ''}>`
            + '<summary>'
            + `<span class="wi-badge ${statusClass(status)}">${escapeHtml(STATUS_SHORT[status])}</span>`
            + `<span class="wi-q">${escapeHtml(answer?.question ?? answer?.mode ?? 'question')}</span>`
            + '</summary>'
            + `<div class="wi-body">${inner}</div>`
            + '</details></li>';
    }

    /**
     * The whole what-if block: the counts line, then the answers grouped by actor. `intro` is the
     * paragraph the caller wants under the counts (the panel's differs from the card's); everything
     * else is passed through to answerHtml(), whose own `note` switch is a row-level toggle — which
     * is why the paragraph is not called `note` here.
     */
    function whatIfHtml(answers, options = {}) {
        const { order = null, labels = null, intro = null, footnoteSources = false, ...rowOptions } = options;
        const rows = list(answers);
        if (rows.length === 0) {
            return '<p class="wi-empty">No what-if answers have been recorded for this issuer yet.</p>';
        }
        const refs = footnoteSources ? sourceIndex(rows) : null;
        const groups = groupByActor(rows, { order, labels }).map((group) =>
            `<li><h5 class="wi-actor-head">${escapeHtml(group.label)}</h5>`
            + `<ul class="wi-list">${group.answers.map((answer) => answerHtml(answer, { ...rowOptions, refs })).join('')}</ul>`
            + '</li>').join('');
        const lead = str(intro);
        return countsLine(countAnswers(rows))
            + (lead === null ? '' : `<p class="wi-note">${escapeHtml(lead)}</p>`)
            + `<ul class="wi-groups">${groups}</ul>`
            + sourcesHtml(refs);
    }

    return {
        ANSWER_STATUSES,
        MISSING_STATUS,
        WHATIF_STATUSES,
        STATUS_SHORT,
        STATUS_MEANING,
        cut,
        statusClass,
        normaliseStatus,
        actorOrder,
        actorLabels,
        normaliseAnswer,
        answersFromApi,
        answersFromDossier,
        countAnswers,
        countsLine,
        groupByActor,
        readLine,
        sourceKey,
        sourceIndex,
        sourcesHtml,
        sourceHtml,
        casesHtml,
        searchedHtml,
        answerHtml,
        whatIfHtml
    };
});
