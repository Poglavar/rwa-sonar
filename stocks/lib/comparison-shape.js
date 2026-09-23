/*
 * The same-stock comparison: one model per wrapper, the rows that genuinely differ, the
 * comparison markup with its concept guides, the decision filters, and the checks that a
 * prebuilt comparison bundle belongs to the loaded catalogue.
 *
 * Moved verbatim out of stocks.js (next-steps.md F11). Pure: no DOM, no fetch; the clock only as a
 * default `now` a caller can override. UMD like the
 * other stocks/lib/*.js files: the browser loads it as a classic script before stocks.js and reads
 * window.__rwaComparisonShape; jest requires it. Tested in stocks/comparison-shape.test.js.
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./defi-view.js'), require('./discovery.js'), require('./fmt.js'), require('./evidence-view.js'), require('./issuer-labels.js'));
    else root.__rwaComparisonShape = factory(root.__rwaDefiView, root.__rwaDiscovery, root.__rwaFmt, root.__rwaEvidenceView, root.__rwaIssuerLabels);
})(this, function (defiView, discovery, fmt, evidenceView, issuerLabels) {
    const { aggregateComposabilityTemplates, lenderOutcomeModel, productDecisionProfile, redemptionUsabilitySummary } = defiView;
    const { laypersonVerdict, legalReviewStatus } = discovery;
    const { cardSlug, escapeHtml, fmtMoney, humanizeSlug, isNum, mintSuffix } = fmt;
    const { provenanceHtml, provenanceSummary } = evidenceView;
    const { issuerDossierHref } = issuerLabels;

    function sameStockComparisonModels(group, issuersBySlug, defiByMint, composability, nowMs = Date.now()) {
        const issuerMap = issuersBySlug instanceof Map ? issuersBySlug : new Map();
        const usageMap = defiByMint instanceof Map ? defiByMint : new Map();
        return (Array.isArray(group?.rows) ? group.rows : []).map((row) => {
            const issuer = issuerMap.get(row.issuer) ?? {};
            const tokens = Array.isArray(row.tokens) ? row.tokens : [];
            const integrations = tokens.flatMap((token) => usageMap.get(token.mint)?.integrations ?? []);
            const template = aggregateComposabilityTemplates(composability, tokens);
            const outcome = lenderOutcomeModel(template, issuer, { integrations });
            const grades = issuer.grades ?? {};
            const verdict = laypersonVerdict({
                claimRung: grades.claimRung,
                redemptionAvailable: issuer.redemption?.available,
                control: issuer.control ?? {}
            });
            const review = legalReviewStatus(issuer);
            const observedSum = (field) => {
                const values = tokens.map((token) => token?.market?.[field]).filter(isNum);
                return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
            };
            const liquidityUsd = observedSum('liquidity');
            const volume24Usd = observedSum('vol24');
            const protocols = [...new Set(integrations.map((entry) => entry.protocolName || entry.protocolId).filter(Boolean))].sort();
            const decision = productDecisionProfile(issuer, tokens[0], integrations, template, nowMs);
            const redemptionUsability = redemptionUsabilitySummary(issuer, tokens[0] ?? null).model;
            return {
                issuerSlug: row.issuer,
                issuerName: issuer.name ?? humanizeSlug(row.issuer),
                tokens,
                verdict,
                review,
                outcome,
                protocols,
                decision,
                redemptionUsability,
                provenance: provenanceSummary(issuer),
                provenanceHtml: provenanceHtml(issuer, { compact: true }),
                liquidityUsd,
                volume24Usd
            };
        });
    }

    const CONCEPT_GUIDES = {
        claim: { href: './learn/beneficial-ownership.html', label: 'How the claim-depth ladder works' },
        ownership: { href: './learn/beneficial-ownership.html', label: 'How token ownership differs from owning the share' },
        insolvency: { href: './learn/bankruptcy-remoteness.html', label: 'How the claim behaves if an issuer fails' },
        redemption: { href: './learn/redemption.html', label: 'What makes a redemption route usable' },
        control: { href: './learn/issuer-control.html', label: 'How freeze and forced-transfer powers work' },
        defi: { href: './learn/defi-custody.html', label: 'Why custody may not create enforceable collateral' }
    };

    function conceptHelpHtml(id, prefix = 'What does this mean?') {
        const guide = CONCEPT_GUIDES[id];
        if (!guide) return '';
        return `<a class="context-help" href="${escapeHtml(guide.href)}"><span>${escapeHtml(prefix)}</span>${escapeHtml(guide.label)} →</a>`;
    }

    function conceptGuideRowHtml(ids) {
        return `<nav class="concept-guide-row" aria-label="Explain these concepts">${(Array.isArray(ids) ? ids : [])
            .map((id) => conceptHelpHtml(id, 'Learn')).join('')}</nav>`;
    }

    /** Only the decision-relevant fields whose values genuinely differ across same-stock wrappers. */
    function comparisonDifferenceRows(models) {
        const rows = Array.isArray(models) ? models : [];
        const fields = [
            ['ownership', 'Legal claim', (model) => model.verdict?.ownership],
            ['redemption', 'Cash exit', (model) => model.outcome?.cashExit],
            ['control', 'Issuer intervention', (model) => model.verdict?.controlNote],
            ['defi', 'Collateral exit', (model) => `${model.outcome?.exitQuality?.label}: ${model.outcome?.exitQuality?.reason}`],
            ['defi', 'Source-listed DeFi use', (model) => model.outcome?.confirmedLending],
            ['insolvency', 'Evidence status', (model) => `${model.review?.label}: ${model.review?.detail}`]
        ];
        return fields.map(([concept, label, value]) => ({
            concept, label,
            values: rows.map((model) => ({ issuer: model.issuerName, value: String(value(model) ?? 'Unknown') }))
        })).filter((row) => new Set(row.values.map((entry) => entry.value)).size > 1);
    }

    function sameStockComparisonHtml(group, models) {
        const columns = Array.isArray(models) ? models : [];
        if (!group || columns.length === 0) return '';
        const outcome = (entry, status) => `<span class="comparison-verdict comparison-verdict-${escapeHtml(status)}">${escapeHtml(entry?.headline ?? 'Unknown')}</span>` +
            `<small>${escapeHtml(entry?.explanation ?? '')}</small>`;
        const questions = [
            ['What do you own?', 'The legal claim—not the ticker on the token.', 'legal-conclusion', (model) => `<strong>${escapeHtml(model.verdict.ownership)}</strong><small>${escapeHtml(model.verdict.cooperation)}</small>`, 'ownership'],
            ['Primary dependency', 'The structural dependency that could make the token diverge from the stock.', 'legal-conclusion', (model) => `<strong>${escapeHtml(model.verdict.mainFailure)}</strong>`, 'insolvency'],
            ['Redeem for cash', 'Whether seizure can become money without finding another buyer.', 'legal-conclusion', (model) => `<span class="comparison-verdict comparison-verdict-${escapeHtml(model.outcome.status)}">${escapeHtml(model.outcome.cashExit)}</span>`, 'redemption'],
            ['Smart-contract custody', 'Can an unstaffed protocol account hold and later release it?', 'analysis', (model) => outcome(model.outcome.custody, model.outcome.status), 'defi'],
            ['Borrower default', 'Can the lender seize and dispose of the collateral by code?', 'analysis', (model) => outcome(model.outcome.default, model.outcome.status), 'defi'],
            ['Exit after default', 'Bottom line: can seized collateral become usable value?', 'analysis', (model) => `<span class="comparison-verdict comparison-exit-${escapeHtml(model.outcome.exitQuality.rating)}">${escapeHtml(model.outcome.exitQuality.label)}</span><small>${escapeHtml(model.outcome.exitQuality.reason)}</small>`, 'defi'],
            ['Exact-token lending listing', 'Exact token address in a checked live collateral registry; listing is not execution proof.', 'source-listing', (model) => `<strong>${escapeHtml(model.outcome.confirmedLending)}</strong>${model.protocols.length ? `<small>All source-listed uses: ${escapeHtml(model.protocols.join(', '))}</small>` : ''}`, 'defi'],
            ['Secondary-market exit', 'A pool is an exit path, not a promise of executable size.', 'confirmed-fact', (model) => `<strong>${escapeHtml(fmtMoney(model.liquidityUsd))} reported liquidity</strong><small>${escapeHtml(fmtMoney(model.volume24Usd))} reported 24 h volume. ${escapeHtml(model.outcome.marketExit)}</small>`, 'redemption'],
            ['If the protocol is hacked', 'Whether issuer powers may help—and may override finality.', 'analysis', (model) => outcome(model.outcome.hack, model.outcome.status), 'control'],
            ['If access is lost', 'What happens when the contract or controlling key is inaccessible?', 'analysis', (model) => outcome(model.outcome.accessLoss, model.outcome.status), 'defi'],
            ['Evidence status', 'A conclusion is only as good as the documents behind it.', 'evidence-status', (model) => `<span class="review-status ${model.review.pending ? 'review-pending' : 'review-complete'}">${escapeHtml(model.review.label)}</span><small>${escapeHtml(model.review.detail)}</small>`, 'insolvency']
        ];
        const tokenLinks = (model) => model.tokens.map((token) => `<a href="./cards/${encodeURIComponent(token.cardSlug || cardSlug(token.symbol, token.mint))}.html">${escapeHtml(token.symbol || mintSuffix(token.mint))}</a>`).join(' · ');
        const header = columns.map((model) => `<th scope="col"><a class="issuer-link" href="${escapeHtml(issuerDossierHref(model.issuerSlug))}">${escapeHtml(model.issuerName)}</a>` +
            `<span class="comparison-token-links">${tokenLinks(model)}</span></th>`).join('');
        const body = questions.map(([label, help, kind, render]) => `<tr data-evidence-kind="${escapeHtml(kind)}"><th scope="row"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(help)}</span><em class="evidence-kind evidence-kind-${escapeHtml(kind)}">${escapeHtml(humanizeSlug(kind))}</em></th>`
            + columns.map((model) => `<td>${render(model)}</td>`).join('') + '</tr>').join('');
        const ownerships = new Set(columns.map((model) => model.verdict.ownership));
        const differences = comparisonDifferenceRows(columns);
        const standalone = columns.length === 1;
        const decision = standalone ? columns[0].verdict.ownership
            : differences.length ? `${differences[0].label}: what changes between wrappers`
                : 'No headline difference is established in the selected evidence. That does not make these wrappers interchangeable.';
        const productCards = columns.map((model) => `<article class="comparison-product-card"><header><a class="issuer-link" href="${escapeHtml(issuerDossierHref(model.issuerSlug))}">${escapeHtml(model.issuerName)}</a><span>${model.tokens.length} token${model.tokens.length === 1 ? '' : 's'}</span></header>`
            + `<p><strong>Own</strong>${escapeHtml(model.verdict.ownership)}</p><p><strong>Cash exit</strong>${escapeHtml(model.outcome.cashExit)}</p>`
            + `<p><strong>DeFi now</strong>${escapeHtml(model.outcome.confirmedLending)}</p><p><strong>Main dependency</strong>${escapeHtml(model.verdict.mainFailure)}</p>`
            + `<nav class="comparison-token-links" aria-label="Exact token reports">${tokenLinks(model)}</nav>${model.provenanceHtml}</article>`).join('');
        const questionCards = questions.map(([label, help, kind, render, concept]) => `<details class="comparison-question"><summary><span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(help)}</small></span><em class="evidence-kind evidence-kind-${escapeHtml(kind)}">${escapeHtml(humanizeSlug(kind))}</em></summary><div>`
            + columns.map((model) => `<article><h4>${escapeHtml(model.issuerName)}</h4>${render(model)}</article>`).join('') + `</div>${conceptHelpHtml(concept)}</details>`).join('');
        const renderDifferenceValues = (row) => {
            // Group genuinely identical answers once, even when many tokenizers offer the stock.
            const values = new Map();
            for (const entry of row.values) values.set(entry.value, [...(values.get(entry.value) ?? []), entry.issuer]);
            return `<dl>${[...values].map(([value, names]) => `<div><dt>${names.length > 3 ? `<details><summary>${names.length} wrappers</summary>${escapeHtml(names.join(' · '))}</details>` : escapeHtml(names.join(' · '))}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>`;
        };
        const renderDifference = (row) => `<article><div><h3>${escapeHtml(row.label)}</h3>${conceptHelpHtml(row.concept)}</div>${renderDifferenceValues(row)}</article>`;
        const differenceHtml = !standalone && differences.length > 1
            ? `<details class="comparison-differences"><summary>What actually differs · ${differences.length - 1} more difference${differences.length === 2 ? '' : 's'}</summary>${differences.slice(1).map(renderDifference).join('')}</details>` : '';
        return `<div class="comparison-summary"><span>${columns.length} issuer structure${standalone ? '' : 's'} · exact-token support and legal outcomes shown separately</span></div>` +
            `<div class="comparison-decision"><span>${standalone ? 'Standalone answer' : 'Decision summary'}</span><strong>${escapeHtml(decision)}</strong>${!standalone && differences.length ? renderDifferenceValues(differences[0]) : ''}${!standalone && ownerships.size === 1 ? `<details class="comparison-shared-claim"><summary>Shared legal claim</summary><p>${escapeHtml(columns[0].verdict.ownership)}</p></details>` : ''}<small>${standalone ? 'This report remains useful without a competing wrapper.' : 'No universally “best” product is implied.'} Eligibility and intended use still matter.</small></div>` +
            differenceHtml + `<details class="comparison-research"${standalone ? ' open' : ''}><summary>Ownership and exit for ${standalone ? 'this wrapper' : 'each wrapper'}</summary><div class="comparison-product-grid">${productCards}</div></details>` +
            `<details class="comparison-research"><summary>Explore custody, default and evidence questions</summary><div class="comparison-question-list">${questionCards}</div></details>` +
            `<details class="full-comparison"><summary>Open the full research matrix</summary><p>Every selected wrapper is included. Scroll across the table for larger comparisons.</p><div class="table-wrap comparison-wrap" tabindex="0" role="region" aria-label="All selected wrapper research"><table class="comparison-table comparison-matrix"><thead><tr><th>Question</th>${header}</tr></thead><tbody>${body}</tbody></table></div></details>` +
            '<details class="comparison-research"><summary>How to read the evidence labels</summary><p class="comparison-note"><span class="evidence-kind evidence-kind-confirmed-fact">Confirmed fact</span> identifies the specific registry, account or market observation—not proof of a successful transaction. <span class="evidence-kind evidence-kind-issuer-claim">Issuer claim</span> is attributed but not independently established. <span class="evidence-kind evidence-kind-legal-conclusion">Legal conclusion</span> applies the reviewed documents. <span class="evidence-kind evidence-kind-analysis">Analysis / inference</span> combines those facts. <span class="evidence-kind evidence-kind-unknown">Unknown</span> never means “no”.</p></details>';
    }

    function filterComparisonModels(models, selectedIssuers, activeFilters) {
        // An explicit empty selection means none, not all. Omitting selection means every wrapper.
        const selected = selectedIssuers instanceof Set ? selectedIssuers : null;
        const filters = activeFilters instanceof Set ? activeFilters : new Set();
        return (Array.isArray(models) ? models : []).filter((model) => {
            if (selected && !selected.has(model.issuerSlug)) return false;
            return [...filters].every((key) => model.decision?.[key] === true);
        });
    }

    /** The requirement checkboxes stocks.html offers, in their on-page order — the order a URL writes them in. */
    const COMPARISON_REQUIREMENTS = ['cashRedemption', 'noDiscretionaryFreeze', 'confirmedCollateral',
        'autonomousLiquidation', 'segregatedAssets', 'nonUsHolders', 'freshEvidence'];

    /** `?requires=a,b` -> Set of known requirement keys. Unknown or repeated keys are dropped, so a typo filters nothing. */
    function parseComparisonRequirements(value) {
        const wanted = new Set(String(value ?? '').split(',').map((piece) => piece.trim()));
        return new Set(COMPARISON_REQUIREMENTS.filter((key) => wanted.has(key)));
    }

    /** The `requires` value that reproduces a set of requirements, in page order; '' when none is active. */
    function comparisonRequirementsParam(active) {
        const set = active instanceof Set ? active : new Set(Array.isArray(active) ? active : []);
        return COMPARISON_REQUIREMENTS.filter((key) => set.has(key)).join(',');
    }

    /**
     * Which underlying a compare URL asks for: `compare=` first, else a `search=` that is exactly a
     * ticker in the list (so `?view=compare&search=NVDA` opens NVDA, not the first group), else null
     * for the caller's default. Case-insensitive, and never a ticker the list does not contain.
     */
    function comparisonTickerFromParams(params, tickers) {
        const known = new Set((Array.isArray(tickers) ? tickers : []).map((ticker) => String(ticker)));
        for (const key of ['compare', 'search']) {
            const value = params?.get?.(key)?.trim().toUpperCase();
            if (value && known.has(value)) return value;
        }
        return null;
    }

    /** Stable URL-safe filename shared with the scoped builder; ticker punctuation cannot escape it. */
    function comparisonBundleFilename(ticker) {
        const value = String(ticker ?? '').trim().toUpperCase();
        return value ? `u-${Array.from(value).map((letter) => letter.codePointAt(0).toString(16)).join('-')}.json` : null;
    }

    /** Reject mixed-release bundles instead of showing a convincing but incomplete comparison. */
    function comparisonBundleMatches(bundle, group, catalogueBuiltAt = null) {
        if (bundle?.schemaVersion !== 1 || bundle.ticker !== group?.ticker || !Array.isArray(bundle.models)) return false;
        if (catalogueBuiltAt && bundle.builtAt !== catalogueBuiltAt) return false;
        const expected = (group.rows ?? []).flatMap((row) => (row.tokens ?? []).map((token) => `${row.issuer}:${token.mint}`)).sort();
        const actual = bundle.models.flatMap((model) => (model.tokens ?? []).map((token) => `${model.issuerSlug}:${token.mint}`)).sort();
        return expected.length > 0 && expected.length === actual.length && expected.every((key, index) => key === actual[index]);
    }

    return {
        sameStockComparisonModels,
        CONCEPT_GUIDES,
        conceptHelpHtml,
        conceptGuideRowHtml,
        comparisonDifferenceRows,
        sameStockComparisonHtml,
        filterComparisonModels,
        COMPARISON_REQUIREMENTS,
        parseComparisonRequirements,
        comparisonRequirementsParam,
        comparisonTickerFromParams,
        comparisonBundleFilename,
        comparisonBundleMatches
    };
});
