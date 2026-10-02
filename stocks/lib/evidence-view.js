/*
 * The markup of the evidence chips (stocks/EVIDENCE.md §4) and the provenance summary: claim
 * status badges, the "§" popovers with their sources and timestamps, the evidence line.
 *
 * Moved verbatim out of stocks.js (next-steps.md F11). Pure: no DOM, no fetch, no clock. UMD like the
 * other stocks/lib/*.js files: the browser loads it as a classic script before stocks.js and reads
 * window.__rwaEvidenceView; jest requires it. Tested in stocks/evidence-view.test.js.
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./evidence.js'), require('./fmt.js'), require('./issuer-labels.js'));
    else root.__rwaEvidenceView = factory(root.__rwaEvidence, root.__rwaFmt, root.__rwaIssuerLabels);
})(this, function (evidenceLib, fmt, issuerLabels) {
    const { chipFor, claimsByField, neededFields, normaliseField, publicClaims } = evidenceLib;
    const { escapeHtml, fmtDate, fmtDateTime, fmtNumber, isSafeUrl } = fmt;
    const { displayName } = issuerLabels;

    // ---------------------------------------------------------------------------
    // Evidence chips (stocks/EVIDENCE.md §4)
    // ---------------------------------------------------------------------------

    /**
     * The claim logic itself is stocks/lib/evidence.js — the same UMD file the ESM builders use
     * through evidence.mjs — so what the panel says about a field cannot drift from what the build
     * counted or what a card prints. Only the markup below is the page's own.
     */

    /** Status -> the class that colours the badge, and the word shown on it. */
    const CLAIM_STATUS_CLASS = {
        confirmed: 'ev-confirmed',
        unverified: 'ev-caution',
        inference: 'ev-muted',
        changed: 'ev-warning',
        'source-gone': 'ev-warning'
    };

    const CLAIM_STATUS_LABEL = {
        confirmed: 'confirmed',
        unverified: 'unverified',
        inference: 'inference',
        changed: 'source changed',
        'source-gone': 'source gone'
    };

    /** What the hollow chip says, in one place, because the tooltip and the popover both use it. */
    const NO_CLAIM_TEXT = 'no source recorded yet';

    function claimStatusClass(status) {
        return CLAIM_STATUS_CLASS[status] || 'ev-muted';
    }

    function claimStatusLabel(status) {
        return CLAIM_STATUS_LABEL[status] || (typeof status === 'string' && status ? status : 'unknown');
    }

    /**
     * The chip index for one issuer: its claims grouped by field, and the set of fields that need a
     * claim. The need list is stocks/data/claim-fields.json — fetched once by the page, so the same
     * file drives the builders and the browser — but the build already expanded it against this very
     * record (`evidenceFields`), so that list wins when it is there and the fetch is only the fallback.
     */
    function evidenceIndex(issuer, fieldPatterns) {
        const byField = claimsByField(publicClaims(Array.isArray(issuer && issuer.claims) ? issuer.claims : []));
        const expanded = Array.isArray(issuer && issuer.evidenceFields)
            ? issuer.evidenceFields
            : neededFields(issuer || {}, Array.isArray(fieldPatterns) ? fieldPatterns : []);
        return { byField, needed: new Set(expanded.map(normaliseField)) };
    }

    /** "Evidence: 34 of 41 fields sourced · last checked 18 Sep 2026 10:22 UTC". */
    function evidenceLineText(summary) {
        if (!summary || !summary.coverage) return '';
        const { sourced, needed } = summary.coverage;
        const checked = summary.lastCheckedAt
            ? ` · last checked ${fmtDateTime(summary.lastCheckedAt)}`
            : ' · never checked';
        return `Evidence: ${fmtNumber(sourced)} of ${fmtNumber(needed)} fields sourced${checked}`;
    }

    function evidenceLineHtml(summary) {
        const text = evidenceLineText(summary);
        if (!text) return '';
        const counts = summary.claims
            ? ` <span class="ev-counts">${fmtNumber(summary.claims)} claim${summary.claims === 1 ? '' : 's'}` +
              ` · ${fmtNumber(summary.confirmed)} confirmed · ${fmtNumber(summary.unverified)} unverified` +
              ` · ${fmtNumber(summary.inference)} inference</span>`
            : '';
        return `<p class="ev-line">${escapeHtml(text)}${counts}</p>`;
    }

    function provenanceSummary(issuer) {
        const record = issuer ?? {};
        const evidence = record.evidence ?? {};
        const coverage = evidence.coverage ?? {};
        const confirmed = Number(evidence.confirmed) || 0;
        const inferred = Number(evidence.inference) || 0;
        const unverified = Number(evidence.unverified) || 0;
        const documents = Array.isArray(record.documents) ? record.documents.length : 0;
        const openConflicts = (Array.isArray(record.discrepancies) ? record.discrepancies : [])
            .filter((row) => row?.status !== 'resolved' && !row?.resolvedAt).length;
        const holderParts = [];
        if (record.transferRestrictions?.kycToHold === true) holderParts.push('KYC required to hold');
        else if (record.transferRestrictions?.kycToHold === false) holderParts.push('wallet holding not KYC-gated');
        if (record.transferRestrictions?.usPersonsExcluded === true) holderParts.push('US persons excluded');
        if (record.transferRestrictions?.allowlist === true) holderParts.push('allowlisted holders only');
        const eligibility = record.redemption?.eligibility;
        const holderScope = eligibility
            ? displayName(String(eligibility).replace(/\s+/g, ' '), 180)
            : (holderParts.join(' · ') || 'Holder class not established');
        const evidenceType = confirmed > 0 && inferred > 0
            ? 'Direct evidence + analysis'
            : inferred > 0 ? 'Analysis / inference'
                : confirmed > 0 ? 'Direct evidence' : 'Unverified source record';
        const authority = documents > 0
            ? `${fmtNumber(documents)} linked issuer or legal document${documents === 1 ? '' : 's'}, plus direct observations`
            : confirmed > 0 ? 'Directly checked linked sources' : 'Source authority not yet established';
        return {
            authority,
            checkedAt: evidence.lastCheckedAt ?? null,
            evidenceType,
            jurisdiction: record.entityJurisdiction
                ? displayName(String(record.entityJurisdiction).replace(/\s+/g, ' '), 180)
                : (record.governingLaw ? displayName(String(record.governingLaw).replace(/\s+/g, ' '), 180) : 'Not established'),
            holderScope,
            conflicts: openConflicts,
            sourced: Number(coverage.sourced) || 0,
            needed: Number(coverage.needed) || 0,
            confirmed,
            unverified,
            inferred
        };
    }

    function provenanceHtml(issuer, { compact = false } = {}) {
        const item = provenanceSummary(issuer);
        const checked = item.checkedAt ? fmtDate(item.checkedAt) : 'never';
        const coverage = item.needed ? `${fmtNumber(item.sourced)}/${fmtNumber(item.needed)} fields sourced` : 'coverage unknown';
        const conflictLabel = `${fmtNumber(item.conflicts)} open conflict${item.conflicts === 1 ? '' : 's'}`;
        if (compact) {
            return `<div class="provenance-compact"><span>${escapeHtml(item.evidenceType)}</span>`
                + `<span>${escapeHtml(coverage)}</span><span>checked ${escapeHtml(checked)}</span>`
                + `<span>${escapeHtml(conflictLabel)}</span><small>Scope: ${escapeHtml(item.jurisdiction)}</small></div>`;
        }
        return `<details class="provenance-panel"><summary><span>Evidence behind this conclusion</span>`
            + `<strong>${escapeHtml(item.evidenceType)} · ${escapeHtml(coverage)} · checked ${escapeHtml(checked)}</strong></summary>`
            + '<dl>'
            + `<div><dt>Source authority</dt><dd>${escapeHtml(item.authority)}</dd></div>`
            + `<div><dt>Claim vs inference</dt><dd>${fmtNumber(item.confirmed)} confirmed · ${fmtNumber(item.unverified)} unverified · ${fmtNumber(item.inferred)} inference</dd></div>`
            + `<div><dt>Jurisdiction scope</dt><dd>${escapeHtml(item.jurisdiction)}</dd></div>`
            + `<div><dt>Holder scope</dt><dd>${escapeHtml(item.holderScope)}</dd></div>`
            + `<div><dt>Conflicting evidence</dt><dd>${escapeHtml(conflictLabel)}</dd></div>`
            + '</dl></details>';
    }

    /**
     * How much of a source's title the chip prints. A dossier `documents[]` title is free prose and one
     * of them runs past 700 characters — printed in full it turns the popover into a wall of link text,
     * so the label is cut and the whole title goes in the element's `title` attribute instead.
     */
    const SOURCE_LABEL_MAX = 72;

    /** A source's own title when the dossier names it, else the URL without its scheme. */
    function sourceTitle(url, documents) {
        if (typeof url !== 'string' || !url) return null;
        const docs = Array.isArray(documents) ? documents : [];
        for (const doc of docs) {
            if (doc && doc.url === url && typeof doc.title === 'string' && doc.title.trim()) {
                return doc.title.trim();
            }
        }
        return url.replace(/^https?:\/\//, '');
    }

    /** The title cut to one line at a word boundary, with an ellipsis so the cut is visible. */
    function sourceLabel(title) {
        if (typeof title !== 'string' || !title.trim()) return null;
        const text = title.replace(/\s+/g, ' ').trim();
        if (text.length <= SOURCE_LABEL_MAX) return text;
        const cut = text.slice(0, SOURCE_LABEL_MAX);
        const space = cut.lastIndexOf(' ');
        return `${(space > SOURCE_LABEL_MAX * 0.6 ? cut.slice(0, space) : cut).replace(/[.,;:\s]+$/, '')}…`;
    }

    /** One timestamp row of the popover: formatted, with the full ISO in the title attribute. */
    function stampHtml(label, iso) {
        if (typeof iso !== 'string' || !iso.trim()) return '';
        return `<span class="ev-stamp" title="${escapeHtml(iso)}">${escapeHtml(label)} ` +
            `${escapeHtml(fmtDateTime(iso))}</span>`;
    }

    /** One claim inside the popover: the quote, the source, the locator, the stamps and the note. */
    function claimHtml(claim, documents) {
        const status = `<span class="ev-badge ${claimStatusClass(claim.status)}">` +
            `${escapeHtml(claimStatusLabel(claim.status))}</span>`;
        const title = sourceTitle(claim.url, documents);
        const label = sourceLabel(title);
        // The full title rides in the `title` attribute, so nothing is lost by the cut.
        const long = label !== title ? ` title="${escapeHtml(title)}"` : '';
        const source = isSafeUrl(claim.url)
            ? `<a href="${escapeHtml(claim.url)}"${long} target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
            : label ? `<span${long}>${escapeHtml(label)}</span>` : '<span class="ev-nosource">no URL recorded</span>';
        const stamps = [
            stampHtml('recorded', claim.recordedAt),
            stampHtml('last checked', claim.lastCheckedAt),
            stampHtml('accessed', claim.accessedAt)
        ].filter(Boolean).join(' · ');
        return '<div class="ev-claim">' +
            `<div class="ev-claim-head">${status}` +
            `${claim.method === 'onchain' ? '<span class="ev-badge ev-muted">on-chain</span>' : ''}</div>` +
            (claim.quote ? `<blockquote class="ev-quote">${escapeHtml(claim.quote)}</blockquote>` : '') +
            `<div class="ev-meta">${source}` +
            `${claim.locator ? ` · <code>${escapeHtml(claim.locator)}</code>` : ''}</div>` +
            (stamps ? `<div class="ev-meta ev-stamps">${stamps}</div>` : '') +
            (claim.note ? `<p class="ev-note">${escapeHtml(claim.note)}</p>` : '') +
            '</div>';
    }

    /**
     * The "§" chip after a field's value. A `<details>` element rather than a hover-only tooltip:
     * that is tappable on a phone, reachable and openable from the keyboard with no script of our own,
     * and the `title` still gives the one-line summary on hover. A field with no claim but on the need
     * list gets the hollow "§?" form; a field that neither has nor needs one gets no chip at all.
     */
    function chipHtml(chip, label, documents) {
        if (!chip) return '';
        const name = typeof label === 'string' && label ? label : chip.field;
        if (chip.claims.length === 0) {
            return `<details class="ev-chip ev-chip-none"><summary title="${escapeHtml(NO_CLAIM_TEXT)}" ` +
                `aria-label="${escapeHtml(`Evidence for ${name}: ${NO_CLAIM_TEXT}`)}">§?</summary>` +
                `<div class="ev-pop"><p class="ev-none">${escapeHtml(NO_CLAIM_TEXT)}</p>` +
                `<p class="ev-field"><code>${escapeHtml(chip.field)}</code></p></div></details>`;
        }
        const best = chip.best || chip.claims[0];
        const hover = `${claimStatusLabel(best.status)}${best.quote ? ` — “${best.quote.slice(0, 120)}”` : ''}`;
        const body = chip.claims.map((claim) => claimHtml(claim, documents)).join('');
        return `<details class="ev-chip ${claimStatusClass(best.status)}">` +
            `<summary title="${escapeHtml(hover)}" ` +
            `aria-label="${escapeHtml(`Evidence for ${name}: ${claimStatusLabel(best.status)}`)}">§</summary>` +
            `<div class="ev-pop"><p class="ev-field"><code>${escapeHtml(chip.field)}</code>` +
            `${chip.claims.length > 1 ? ` · ${chip.claims.length} claims` : ''}</p>${body}</div></details>`;
    }

    /** The chip for one field path, given an index from evidenceIndex(). */
    function fieldChipHtml(index, field, label) {
        if (!index || typeof field !== 'string' || !field) return '';
        return chipHtml(chipFor(field, index.byField, index.needed), label, index.documents);
    }

    return {
        CLAIM_STATUS_CLASS,
        CLAIM_STATUS_LABEL,
        NO_CLAIM_TEXT,
        claimStatusClass,
        claimStatusLabel,
        evidenceIndex,
        evidenceLineText,
        evidenceLineHtml,
        provenanceSummary,
        provenanceHtml,
        SOURCE_LABEL_MAX,
        sourceTitle,
        sourceLabel,
        stampHtml,
        claimHtml,
        chipHtml,
        fieldChipHtml
    };
});
