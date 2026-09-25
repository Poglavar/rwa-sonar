/*
 * Small markup builders for the issuer cards and the issuer and token detail panels on stocks.html:
 * control badges, metric rows, the verification bar, the key-governance summary, detail sections
 * and lists (plain, or fold rows for the lists that grow), safe external links, the scoped redemption answer, a control flag's wording and the
 * saved-items list. They were inner functions of stocks.js's page closure that touched no page
 * state, so they moved here verbatim (next-steps.md F11). Pure: no DOM, no fetch, no clock.
 * UMD like the other stocks/lib/*.js files: the browser loads it as a classic script before
 * stocks.js and reads window.__rwaPanelMarkup, jest requires it. Tested in stocks/panel-markup.test.js.
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./fmt.js'), require('./issuer-labels.js'));
    else root.__rwaPanelMarkup = factory(root.__rwaFmt, root.__rwaIssuerLabels);
})(this, function (fmt, issuerLabels) {
    const { DASH, escapeHtml, humanizeSlug, isSafeUrl } = fmt;
    const { KEY_GOVERNANCE_LABELS, KEY_GOVERNANCE_ROLES } = issuerLabels;

    function badge(label, value, cls, tip) {
        return `<span class="ctl-badge ${cls}" title="${escapeHtml(tip)}">` +
            `<span class="ctl-badge-label">${escapeHtml(label)}</span>` +
            `<span class="ctl-badge-value">${escapeHtml(value)}</span></span>`;
    }

    function metric(label, value, tip) {
        return `<div class="metric"${tip ? ` title="${escapeHtml(tip)}"` : ''}>` +
            `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
    }

    function verificationBarHtml(strength) {
        const filled = Number.isInteger(strength) && strength >= 0 ? Math.min(strength, 5) : 0;
        const cells = [];
        for (let i = 0; i < 5; i++) {
            cells.push(`<span class="ver-cell${i < filled ? ' ver-cell-on' : ''}"></span>`);
        }
        return `<span class="ver-bar" role="img" aria-label="Verification strength ${Number.isInteger(strength) ? strength : 'unknown'} of 5">` +
            cells.join('') + `</span><span class="ver-number">${Number.isInteger(strength) ? strength : DASH}/5</span>`;
    }

    function keyGovernanceSummary(keyGovernance) {
        if (!keyGovernance || typeof keyGovernance !== 'object') return DASH;
        const roles = KEY_GOVERNANCE_ROLES
            .filter((role) => typeof keyGovernance[role] === 'string' && keyGovernance[role]);
        if (!roles.length) return DASH;
        const values = roles.map((role) => KEY_GOVERNANCE_LABELS[keyGovernance[role]] || keyGovernance[role]);
        // All four held the same way is the common case; say it once rather than four times.
        if (roles.length === KEY_GOVERNANCE_ROLES.length && new Set(values).size === 1) return values[0];
        // 'r' would collide with nothing today, but mint/freeze/delegate/rebase all start on a
        // distinct letter, so the one-letter prefix stays unambiguous.
        return roles.map((role, i) => `${role[0]}:${values[i]}`).join(' ');
    }

    function freezeExercisedLabel(value) {
        if (value === 'yes') return 'yes';
        if (value === 'unknown' || value === null || value === undefined) return 'unknown';
        return String(value);
    }

    function freezeExercisedClass(value) {
        if (value === 'yes') return 'cov-all';
        return 'cov-unknown';
    }

    function detailSection(title, fields) {
        const rows = fields.filter(Boolean).join('');
        if (!rows) return '';
        return `<section class="detail-section"><h4>${escapeHtml(title)}</h4><dl class="detail-fields">${rows}</dl></section>`;
    }

    /** Scope-aware redemption answer with its complete source qualification kept expandable. */
    function redemptionAnswerHtml(answer) {
        if (!answer) return '<strong>Unknown</strong><small class="evidence-state">Unknown</small>';
        const summary = answer.value === true ? 'Yes' : answer.value === false ? 'No'
            : answer.value === null || answer.value === undefined ? 'Unknown'
                : String(answer.summary ?? answer.value);
        const context = answer.scopeContext ?? {};
        const scopeNotes = [context.source ? `Source scope: ${context.source}` : null,
            context.holders ? `Holder scope: ${context.holders}` : null,
            context.jurisdictions ? `Jurisdiction scope: ${context.jurisdictions}` : null].filter(Boolean);
        const detail = typeof answer.completeText === 'string' && answer.completeText !== ''
            ? `<details class="redemption-term"><summary>${escapeHtml(summary)}</summary>`
                + `<p>${escapeHtml(answer.completeText)}</p>`
                + `${scopeNotes.length ? `<small>${escapeHtml(scopeNotes.join(' · '))}</small>` : ''}</details>`
            : `<strong>${escapeHtml(summary)}</strong>`;
        return `${detail}<small class="evidence-state">${escapeHtml(humanizeSlug(answer.evidence ?? 'unknown'))}</small>`;
    }

    function redemptionAnswer(model, id) {
        return model?.fields?.find((answer) => answer.id === id) ?? null;
    }

    function linkHtml(url) {
        if (!isSafeUrl(url)) return '';
        return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
    }

    function detailList(title, items, renderItem) {
        if (!Array.isArray(items) || !items.length) {
            return `<section class="detail-section"><h4>${escapeHtml(title)}</h4>` +
                `<p class="detail-empty">None recorded.</p></section>`;
        }
        const rendered = items
            .filter((item) => item !== null && item !== undefined && item !== '')
            .map((item) => `<li>${renderItem(item)}</li>`)
            .join('');
        return `<section class="detail-section"><h4>${escapeHtml(title)} <span class="detail-count">${items.length}</span></h4>` +
            `<ul class="detail-list">${rendered}</ul></section>`;
    }

    const FOLD_TONES = new Set(['critical', 'warning', 'caution', 'good', 'info']);

    /**
     * A detail-panel list that grows over time (findings, attestations) as a fold list
     * (app-shell.css): each item is one closed row that opens to the full item. `row(item)` returns
     * { tone, line1, line2, body } where line1, line2 and body are ALREADY-ESCAPED HTML; line 1 is
     * when, how serious and what, line 2 one plain line, and links belong in the body only.
     */
    function foldDetailList(title, items, row) {
        if (!Array.isArray(items) || !items.length) {
            return `<section class="detail-section"><h4>${escapeHtml(title)}</h4>` +
                `<p class="detail-empty">None recorded.</p></section>`;
        }
        const rendered = items
            .filter((item) => item !== null && item !== undefined && item !== '')
            .map((item) => {
                const { tone = null, line1 = '', line2 = '', body = '' } = row(item) ?? {};
                return `<li class="fold-row${FOLD_TONES.has(tone) ? ` fold-${tone}` : ''}"><details><summary>` +
                    `<span class="fold-line1">${line1}</span>${line2 ? `<span class="fold-line2">${line2}</span>` : ''}` +
                    `</summary><div class="fold-body">${body}</div></details></li>`;
            })
            .join('');
        return `<section class="detail-section"><h4>${escapeHtml(title)} <span class="detail-count">${items.length}</span></h4>` +
            `<ul class="fold-list detail-fold-list">${rendered}</ul></section>`;
    }

    /** A control flag: an address counts as "on" exactly as MODEL §3.3 reads it. */
    function controlValue(value) {
        if (value === true) return 'yes';
        if (value === false) return 'no';
        if (typeof value === 'string' && value.trim()) return `yes · ${value.trim()}`;
        return null;
    }

    function personalListHtml(rows, empty) {
        if (!rows.length) return `<p class="personal-empty">${escapeHtml(empty)}</p>`;
        return `<ul class="personal-list">${rows.join('')}</ul>`;
    }

    return {
        badge,
        metric,
        verificationBarHtml,
        keyGovernanceSummary,
        freezeExercisedLabel,
        freezeExercisedClass,
        detailSection,
        redemptionAnswerHtml,
        redemptionAnswer,
        linkHtml,
        detailList,
        foldDetailList,
        controlValue,
        personalListHtml
    };
});
