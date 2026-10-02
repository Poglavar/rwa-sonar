/*
 * Which rights of the underlying share reach the token holder: five rights, one status each, from
 * the curated stocks/data/holder-rights.json (per issuer programme, each with its source). Renders
 * the compact "rights strip" shown at the top of cards and in the comparison, and the detail table
 * shown on the card's rights section and the issuer page.
 *
 * Pure: no DOM, no fetch. UMD like the other stocks/lib/*.js files: the browser loads it as a
 * classic script and reads window.__rwaHolderRights; node requires it. Tested in
 * stocks/holder-rights.test.js.
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./fmt.js'));
    else root.__rwaHolderRights = factory(root.__rwaFmt);
})(this, function (fmt) {
    const { escapeHtml } = fmt;

    /** The shareholder rights we track, in display order. */
    const RIGHTS = [
        { id: 'dividends', label: 'Dividends' },
        { id: 'voting', label: 'Voting' },
        { id: 'information', label: 'Reports & meetings' },
        { id: 'splits', label: 'Splits' },
        { id: 'takeovers', label: 'Takeovers' }
    ];

    /**
     * `yes` is reserved for the shareholder's own right (the holder is on the register or holds the
     * same share class). An issuer passing the economic effect through under its own terms is
     * `value`, however faithfully; a promise it may or may not keep is `discretion`.
     */
    const STATUSES = {
        yes: { mark: '✓', label: 'Yes, as a shareholder' },
        value: { mark: '◐', label: 'Passed through by the issuer' },
        discretion: { mark: '◌', label: 'Only if the issuer decides' },
        no: { mark: '✕', label: 'No' },
        na: { mark: '–', label: 'Does not apply' },
        unknown: { mark: '?', label: 'Not stated' }
    };

    function text(value) {
        return typeof value === 'string' && value.trim() ? value.trim() : null;
    }

    /** One issuer's rights as five display rows; anything missing or malformed reads as unknown. */
    function holderRightsRows(entry) {
        return RIGHTS.map((right) => {
            const raw = entry && typeof entry === 'object' ? entry[right.id] : null;
            const status = raw && Object.prototype.hasOwnProperty.call(STATUSES, raw.status) ? raw.status : 'unknown';
            const source = raw?.source && text(raw.source.url) ? {
                url: raw.source.url.trim(),
                locator: text(raw.source.locator),
                quote: text(raw.source.quote)
            } : null;
            return {
                id: right.id,
                label: right.label,
                status,
                mark: STATUSES[status].mark,
                statusLabel: STATUSES[status].label,
                summary: text(raw?.summary),
                source
            };
        });
    }

    /** A short sentence for the strip's accessible name and for comparisons ("2 of 5 …"). */
    function holderRightsHeadline(rows) {
        const list = Array.isArray(rows) ? rows : [];
        const named = (status) => list.filter((row) => row.status === status).map((row) => row.label.toLowerCase());
        const yes = named('yes');
        const passed = named('value');
        if (list.length && list.every((row) => row.status === 'unknown')) return 'Shareholder rights: not stated';
        if (yes.length === list.length && list.length) return 'All five shareholder rights';
        if (yes.length) return `${yes.length} of ${list.length} shareholder rights`;
        return passed.length
            ? `No shareholder rights; the issuer passes through ${joinWords(passed)}`
            : 'No shareholder rights';
    }

    function joinWords(words) {
        if (words.length <= 1) return words.join('');
        return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
    }

    /**
     * The compact indicator: one chip per right with its mark. The status and the reason sit in
     * the title (hover) and in visually hidden text, so the strip reads the same without colour.
     */
    function holderRightsStripHtml(rows, { href = null, legend = false } = {}) {
        const list = Array.isArray(rows) ? rows : [];
        if (!list.length) return '';
        // Phones have no hover: the legend spells out the marks this strip actually uses.
        const used = Object.keys(STATUSES).filter((status) => list.some((row) => row.status === status));
        const key = legend ? `<p class="rights-legend">${used.map((status) => `${escapeHtml(STATUSES[status].mark)} ${escapeHtml(STATUSES[status].label.toLowerCase())}`).join(' · ')}</p>` : '';
        const items = list.map((row) => `<li class="rights-chip rights-${escapeHtml(row.status)}" title="${escapeHtml(`${row.label}: ${row.statusLabel}${row.summary ? `. ${row.summary}` : ''}`)}">`
            + `<span class="rights-mark" aria-hidden="true">${escapeHtml(row.mark)}</span>${escapeHtml(row.label)}`
            + `<span class="rights-sr">: ${escapeHtml(row.statusLabel)}</span></li>`).join('');
        const more = href ? `<a class="rights-more" href="${escapeHtml(href)}">What each means →</a>` : '';
        return `<div class="rights-strip"><ul aria-label="${escapeHtml(holderRightsHeadline(list))}">${items}</ul>${more}${key}</div>`;
    }

    function hostOf(url) {
        try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
    }

    /** The detail table: each right, its status, one plain sentence and the source it rests on. */
    function holderRightsDetailHtml(rows, { id = 'holder-rights' } = {}) {
        const list = Array.isArray(rows) ? rows : [];
        if (!list.length) return '';
        const body = list.map((row) => {
            const source = row.source
                ? `<small class="rights-source">Source: <a href="${escapeHtml(row.source.url)}" rel="noopener noreferrer" target="_blank">${escapeHtml(hostOf(row.source.url))}</a>`
                    + `${row.source.locator ? ` · ${escapeHtml(row.source.locator)}` : ''}`
                    + `${row.source.quote ? ` · “${escapeHtml(row.source.quote)}”` : ''}</small>`
                : '';
            return `<tr><th scope="row">${escapeHtml(row.label)}</th>`
                + `<td><span class="rights-chip rights-${escapeHtml(row.status)}"><span class="rights-mark" aria-hidden="true">${escapeHtml(row.mark)}</span>${escapeHtml(row.statusLabel)}</span></td>`
                + `<td>${escapeHtml(row.summary ?? 'Not stated in the documents we read.')}${source}</td></tr>`;
        }).join('');
        return `<table class="rights-detail"${id ? ` id="${escapeHtml(id)}"` : ''}><caption>Which rights of the share reach the token holder</caption>`
            + `<thead><tr><th scope="col">Right</th><th scope="col">For the token holder</th><th scope="col">Why</th></tr></thead><tbody>${body}</tbody></table>`;
    }

    /** Problems in the curated file, for its test: every issuer, every right, a status and a source. */
    function validateHolderRights(doc, issuerSlugs = []) {
        const problems = [];
        const issuers = doc && typeof doc.issuers === 'object' ? doc.issuers : {};
        for (const slug of issuerSlugs) if (!(slug in issuers)) problems.push(`${slug}: missing`);
        for (const [slug, entry] of Object.entries(issuers)) {
            for (const right of RIGHTS) {
                const raw = entry?.[right.id];
                if (!raw) { problems.push(`${slug}.${right.id}: missing`); continue; }
                if (!Object.prototype.hasOwnProperty.call(STATUSES, raw.status)) problems.push(`${slug}.${right.id}: status ${raw.status}`);
                if (!text(raw.summary)) problems.push(`${slug}.${right.id}: no summary`);
                if (!/^https:\/\//.test(raw.source?.url ?? '')) problems.push(`${slug}.${right.id}: no https source`);
                if (!text(raw.source?.locator)) problems.push(`${slug}.${right.id}: no locator`);
                // A definite answer must quote its source; "not stated" may point at where we looked.
                if (!['unknown'].includes(raw.status) && !text(raw.source?.quote)) problems.push(`${slug}.${right.id}: ${raw.status} without a quote`);
            }
        }
        return problems;
    }

    return { RIGHTS, STATUSES, holderRightsRows, holderRightsHeadline, holderRightsStripHtml, holderRightsDetailHtml, validateHolderRights };
});
