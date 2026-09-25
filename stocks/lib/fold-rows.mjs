// Fold rows for the server-generated pages (token cards, issuer and template dossiers, the weekly
// digest, protocol dossiers): a list that grows over time shows each item as ONE compact row — a
// short "when · how serious · what" line and one line of consequence — that opens to the full item.
// Markup matches the shared .fold-* styles in app-shell.css (first used on watch.html). A <details>
// needs no script, so the pages stay complete with JavaScript off. Pure: strings in, HTML out.

import fmt from './fmt.js';

const { escapeHtml, fmtDate } = fmt;

/** Severity words that map to a row tone (the coloured left edge and the chip). */
export const FOLD_TONES = ['critical', 'warning', 'caution', 'good', 'info'];

/** The tone class for a severity word, '' for anything else (a plain row). */
export function foldToneClass(severity) {
    return FOLD_TONES.includes(severity) ? ` fold-${severity}` : '';
}

/** A fragment id for one row: `${prefix}-${id}` with anything outside [A-Za-z0-9_-] replaced. Null without an id. */
export function foldAnchor(prefix, id) {
    if (id === null || id === undefined || String(id).trim() === '') return null;
    return `${prefix}-${String(id).trim().replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

/** "23 Sep 2026" for a timestamp or a date, null when there is none (the row then starts with its chip). */
export function foldWhen(iso) {
    const text = typeof iso === 'string' && iso.trim() ? fmtDate(iso) : null;
    return text === null || text === '—' ? null : text;
}

/**
 * One row. Plain-text fields are escaped here; `body` is trusted HTML built by the caller and holds
 * every link, because a click anywhere on the summary only toggles the row.
 *
 * @param {object} row
 * @param {string|null} [row.id] fragment id on the <li>; a URL that targets it opens the row (the page script or the reader)
 * @param {string|null} [row.tone] severity word (critical | warning | caution | good | info) for the edge and chip colour
 * @param {string|null} [row.when] short date text, e.g. "23 Sep 2026"
 * @param {string|null} [row.chip] the chip's word, e.g. the severity
 * @param {string|null} [row.chipHtml] a page's own chip markup instead (trusted HTML), e.g. a lender's label
 * @param {string} row.title bold title on line 1
 * @param {string|null} [row.meta] a short plain-text tail after the title on line 1
 * @param {string|null} [row.line2] one plain line of consequence, clamped to one line and hidden when open
 * @param {string|null} [row.line2Html] the same line as trusted, already-escaped HTML without links
 * @param {string} row.body the full item
 * @param {boolean} [row.open] render opened
 */
export function foldRowHtml({ id = null, tone = null, when = null, chip = null, chipHtml = null, title, meta = null, line2 = null, line2Html = null, body, open = false }) {
    const toneClass = foldToneClass(tone);
    const line1 = [
        when ? `${escapeHtml(when)} · ` : '',
        chipHtml ? `${chipHtml} ` : chip ? `<b class="fold-chip">${escapeHtml(chip)}</b> ` : '',
        `<strong class="fold-title">${escapeHtml(title ?? '')}</strong>`,
        meta ? ` · ${escapeHtml(meta)}` : ''
    ].join('');
    const plain = typeof line2 === 'string' && line2.trim() ? escapeHtml(line2.trim()) : null;
    const second = plain ?? (typeof line2Html === 'string' && line2Html.trim() ? line2Html.trim() : null);
    const line2Part = second === null ? '' : `<span class="fold-line2">${second}</span>`;
    return `<li${id ? ` id="${escapeHtml(id)}"` : ''} class="fold-row${toneClass}"><details${open ? ' open' : ''}><summary>`
        + `<span class="fold-line1">${line1}</span>${line2Part}</summary><div class="fold-body">${body ?? ''}</div></details></li>`;
}

/** Text of already-escaped HTML with its tags removed (entities stay escaped), for a summary line. */
export function foldPlain(html) {
    return typeof html === 'string' ? html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '';
}

/** The list around the rows; `className` adds a page-specific hook next to fold-list. */
export function foldListHtml(rows, { className = '' } = {}) {
    const items = (Array.isArray(rows) ? rows : []).map(foldRowHtml).join('');
    return items === '' ? '' : `<ul class="fold-list${className ? ` ${escapeHtml(className)}` : ''}">${items}</ul>`;
}
