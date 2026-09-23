/*
 * Claims-versus-reality discrepancies: the public directory rows, their filters, and the
 * directory, panel and callout markup that keeps both sides and their sources visible.
 *
 * Moved verbatim out of stocks.js (next-steps.md F11). Pure: no DOM, no fetch, no clock. UMD like the
 * other stocks/lib/*.js files: the browser loads it as a classic script before stocks.js and reads
 * window.__rwaDiscrepancyView; jest requires it. Tested in stocks/discrepancy-view.test.js.
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./fmt.js'), require('./evidence-view.js'), require('./issuer-labels.js'));
    else root.__rwaDiscrepancyView = factory(root.__rwaFmt, root.__rwaEvidenceView, root.__rwaIssuerLabels);
})(this, function (fmt, evidenceView, issuerLabels) {
    const { escapeHtml, fmtDate, fmtNumber, humanizeSlug, isSafeUrl } = fmt;
    const { provenanceSummary } = evidenceView;
    const { issuerDossierHref, severityClass, severityRank } = issuerLabels;

    const DISCREPANCY_SEVERITIES = new Set(['critical', 'warning', 'caution', 'info']);

    function discrepancySeverity(value) {
        return DISCREPANCY_SEVERITIES.has(value) ? value : 'caution';
    }

    function discrepancyImpact(value) {
        const severity = discrepancySeverity(value);
        if (severity === 'critical' || severity === 'warning') return 'high';
        if (severity === 'caution') return 'medium';
        return 'low';
    }

    /** One public claims-versus-reality row, preserving both sources and programme-wide scope. */
    function discrepancyRows(issuers, tokens = []) {
        const tokenRows = Array.isArray(tokens) ? tokens : [];
        const countByIssuer = new Map();
        for (const token of tokenRows) countByIssuer.set(token.issuer, (countByIssuer.get(token.issuer) ?? 0) + 1);
        return (Array.isArray(issuers) ? issuers : []).flatMap((issuer) =>
            (Array.isArray(issuer?.discrepancies) ? issuer.discrepancies : []).map((row) => {
                const affectedMints = Array.isArray(row?.affectedMints) ? row.affectedMints.filter(Boolean) : [];
                const issuerTokens = tokenRows.filter((token) => token?.issuer === issuer.slug);
                const affectedTokens = affectedMints.length
                    ? issuerTokens.filter((token) => affectedMints.includes(token.mint)) : issuerTokens;
                const resolved = row?.status === 'resolved' || Boolean(row?.resolvedAt);
                return {
                    ...row,
                    issuerSlug: issuer.slug,
                    issuerName: issuer.name ?? humanizeSlug(issuer.slug),
                    severity: discrepancySeverity(row?.severity),
                    holderImpact: discrepancyImpact(row?.severity),
                    status: resolved ? 'resolved' : 'open',
                    affectedCount: affectedTokens.length || countByIssuer.get(issuer.slug) || 0,
                    scope: row?.classification || (affectedMints.length ? 'named token addresses' : 'issuer programme'),
                    jurisdiction: provenanceSummary(issuer).jurisdiction,
                    checkedAt: [row?.claim?.sources, row?.reality?.sources].flat()
                        .map((source) => source?.accessedAt).filter(Boolean).sort().at(-1) ?? null,
                    affectedMints,
                    affectedTokens: affectedTokens.map((token) => ({
                        mint: token.mint, symbol: token.symbol, ticker: token.underlyingTicker
                    }))
                };
            })).sort((a, b) => severityRank(b.severity) - severityRank(a.severity)
                || String(b.observedAt ?? '').localeCompare(String(a.observedAt ?? '')));
    }

    function filterDiscrepancyRows(rows, filters = {}) {
        return (Array.isArray(rows) ? rows : []).filter((row) =>
            (!filters.issuer || row.issuerSlug === filters.issuer)
            && (!filters.impact || row.holderImpact === filters.impact)
            && (!filters.status || row.status === filters.status)
            && (!filters.asset || [row.issuerName, row.issuerSlug, ...(row.affectedTokens ?? []).flatMap((token) =>
                [token.symbol, token.ticker, token.mint])].filter(Boolean).some((value) =>
                String(value).toLowerCase().includes(String(filters.asset).toLowerCase()))));
    }

    function discrepancyDirectoryHtml(rows) {
        const list = Array.isArray(rows) ? rows : [];
        if (!list.length) return '<div class="comparison-empty"><strong>No discrepancy matches these filters.</strong><p>Clear a filter to return to the current source-backed record.</p></div>';
        return list.map((row) => `<article class="reality-card discrepancy-${escapeHtml(row.severity)}">`
            + `<header><div><span class="sev-chip ${severityClass(row.severity)}">${escapeHtml(row.severity)}</span>`
            + `<span class="reality-status reality-status-${escapeHtml(row.status)}">${escapeHtml(row.status)}</span></div>`
            + `<a href="${escapeHtml(issuerDossierHref(row.issuerSlug))}">${escapeHtml(row.issuerName)}</a></header>`
            + `<h3>${escapeHtml(row.title || 'Published claim differs from observed reality')}</h3>`
            + `<p class="reality-meta">${escapeHtml(row.holderImpact)} holder impact · ${escapeHtml(row.scope)} · ${fmtNumber(row.affectedCount)} current token${row.affectedCount === 1 ? '' : 's'} affected${row.observedAt ? ` · first observed ${escapeHtml(fmtDate(row.observedAt))}` : ''}</p>`
            + discrepancyProvenanceHtml(row)
            + '<div class="discrepancy-sides">'
            + discrepancySideHtml('Published claim', row.claim, 'claim')
            + discrepancySideHtml('Observed reality', row.reality, 'reality') + '</div>'
            + (row.impact ? `<p class="discrepancy-impact"><strong>Why it matters</strong>${escapeHtml(row.impact)}</p>` : '')
            + (row.resolutionCondition ? `<p class="discrepancy-impact"><strong>What resolves it</strong>${escapeHtml(row.resolutionCondition)}</p>` : '')
            + `<footer><a href="${escapeHtml(issuerDossierHref(row.issuerSlug))}">Open issuer dossier →</a><a href="./watch.html">See external changes →</a></footer></article>`).join('');
    }

    function discrepancyProvenanceHtml(row) {
        const checked = row?.checkedAt ? fmtDate(row.checkedAt) : 'not recorded';
        return `<div class="provenance-compact discrepancy-provenance"><span>Direct source comparison</span>`
            + `<span>linked claim + observed evidence</span><span>checked ${escapeHtml(checked)}</span>`
            + `<small>Scope: ${escapeHtml(row?.jurisdiction || 'jurisdiction not established')} · ${escapeHtml(row?.scope || 'scope not established')}</small></div>`;
    }

    function discrepancySourceHtml(source) {
        if (!source || typeof source !== 'object') return '<span class="discrepancy-no-source">No source recorded</span>';
        const label = source.label || source.type || source.url || 'Source';
        const linked = isSafeUrl(source.url)
            ? `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)} ↗</a>`
            : `<span>${escapeHtml(label)}</span>`;
        const locator = source.locator ? `<code>${escapeHtml(source.locator)}</code>` : '';
        const observed = source.accessedAt
            ? `<time datetime="${escapeHtml(source.accessedAt)}">checked ${escapeHtml(fmtDate(source.accessedAt))}</time>`
            : '';
        return `<span class="discrepancy-source">${linked}${locator}${observed}</span>`;
    }

    function discrepancySideHtml(label, side, kind) {
        const sources = (Array.isArray(side?.sources) ? side.sources : [])
            .map(discrepancySourceHtml).join('');
        return `<section class="discrepancy-side discrepancy-side-${kind}">`
            + `<h6>${escapeHtml(label)}</h6>`
            + `<p>${escapeHtml(side?.text || 'Not recorded.')}</p>`
            + `<div class="discrepancy-sources">${sources || '<span class="discrepancy-no-source">No source recorded</span>'}</div>`
            + '</section>';
    }

    function discrepancyItemHtml(row) {
        const severity = discrepancySeverity(row?.severity);
        return `<article class="discrepancy-item discrepancy-${severity}">`
            + `<header><span class="sev-chip ${severityClass(severity)}">${escapeHtml(severity)}</span>`
            + `<h5>${escapeHtml(row?.title || 'Published claim differs from observed reality')}</h5></header>`
            + '<div class="discrepancy-sides">'
            + discrepancySideHtml('Published claim', row?.claim, 'claim')
            + discrepancySideHtml('Observed reality', row?.reality, 'reality')
            + '</div>'
            + (row?.impact ? `<p class="discrepancy-impact"><strong>Why it matters</strong>${escapeHtml(row.impact)}</p>` : '')
            + (row?.observedAt ? `<p class="discrepancy-observed">Observed ${escapeHtml(fmtDate(row.observedAt))}</p>` : '')
            + '</article>';
    }

    function discrepanciesHtml(issuer) {
        const rows = Array.isArray(issuer?.discrepancies) ? issuer.discrepancies : [];
        if (!rows.length) return '';
        return `<details class="discrepancy-panel"><summary><span>Claim ≠ observed reality</span>`
            + `<strong>${rows.length} documented discrepanc${rows.length === 1 ? 'y' : 'ies'}</strong></summary>`
            + '<p class="discrepancy-note">We keep both sides visible. “Published claim” is what a document, page or API says; '
            + '“observed reality” is the stronger or later evidence we found. Each side links to its own source.</p>'
            + `<div class="discrepancy-list">${rows.map(discrepancyItemHtml).join('')}</div></details>`;
    }

    function discrepancyCalloutHtml(issuer) {
        const rows = Array.isArray(issuer?.discrepancies) ? issuer.discrepancies : [];
        if (!rows.length) return '';
        const worst = rows.reduce((current, row) => severityRank(row?.severity) > severityRank(current)
            ? discrepancySeverity(row?.severity) : current, 'info');
        return `<button type="button" class="discrepancy-callout ${severityClass(worst)}" data-slug="${escapeHtml(issuer.slug)}">`
            + '<span><strong>Claim ≠ reality</strong><small>documented and source-backed</small></span>'
            + `<b>${rows.length}</b><span aria-hidden="true">→</span></button>`;
    }

    return {
        DISCREPANCY_SEVERITIES,
        discrepancySeverity,
        discrepancyImpact,
        discrepancyRows,
        filterDiscrepancyRows,
        discrepancyDirectoryHtml,
        discrepancyProvenanceHtml,
        discrepancySourceHtml,
        discrepancySideHtml,
        discrepancyItemHtml,
        discrepanciesHtml,
        discrepancyCalloutHtml
    };
});
