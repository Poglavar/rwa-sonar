/*
 * The issuer panel's trust-chain and what-if sections (stocks/EVIDENCE.md §6): the notes under
 * each and the section bodies, drawn by the same pure libraries the static cards use.
 *
 * Moved verbatim out of stocks.js (next-steps.md F11). Pure: no DOM, no fetch, no clock. UMD like the
 * other stocks/lib/*.js files: the browser loads it as a classic script before stocks.js and reads
 * window.__rwaTrustChainSection; jest requires it. Tested in stocks/trustchain-section.test.js.
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./whatif-render.js'), require('./fmt.js'), require('./trustchain-svg.js'));
    else root.__rwaTrustChainSection = factory(root.__rwaWhatIf, root.__rwaFmt, root.__rwaTrustChainSvg);
})(this, function (whatIfLib, fmt, trustChainSvg) {
    const { escapeHtml } = fmt;

    // ---------------------------------------------------------------------------
    // Trust chain and what-if (stocks/EVIDENCE.md §6)
    // ---------------------------------------------------------------------------

    /**
     * Both are drawn by pure libraries the card builder uses too, so the panel and a static card can
     * never show a differently graded chain or a differently counted answer sheet:
     * stocks/lib/trustchain-svg.js draws the diagram from the record's own `chain`, and
     * stocks/lib/whatif-render.js renders the answers the API serves.
     */

    /** What the panel says under the diagram, once, rather than in the HTML. */
    const CHAIN_NOTE = 'Thirteen actors stand between a holder and the company; nine rights flows run '
        + 'between them. A lane’s colour is how well the link is evidenced and its line style is how '
        + 'it was verified — neither is typed by hand, both are computed from this dossier’s claims, '
        + 'so a link cannot look firmer than what is under it. An actor nobody fills keeps its seat: an '
        + 'empty one is the finding.';

    /** And under the what-if counts. The rule, in the one sentence it needs. */
    const WHAT_IF_NOTE = 'The same 38 questions are put to every issuer, so a gap is visible as a gap. '
        + 'An outcome is never invented: it is documented only with the source’s own words, inferred '
        + 'when the structure implies it and we say so, litigated when a court or regulator decided it, '
        + 'and unknown when we looked and the documents do not say.';

    /** The actor order and labels the groups read, from the catalogue file the page fetches. */
    const { actorOrder: chainActorOrder, actorLabels: chainActorLabels } = whatIfLib;

    /** The diagram section's body for one issuer record, or the honest absence of one. */
    function chainSectionHtml(issuer) {
        const chain = issuer?.chain;
        if (!chain || !Array.isArray(chain.nodes) || chain.nodes.length === 0) {
            return '<p class="tc-empty">No trust chain has been built for this issuer yet — it needs '
                + 'the dossier’s <code>parties</code>, which this record does not carry.</p>';
        }
        return `<p class="wi-note">${escapeHtml(CHAIN_NOTE)}</p>`
            + trustChainSvg.diagramHtml(chain, {
                id: `chain-${typeof issuer.slug === 'string' ? issuer.slug : 'issuer'}`,
                title: `Trust chain — ${issuer.name ?? issuer.slug ?? 'issuer'}`
            });
    }

    /**
     * The what-if section's body from an answer sheet. `sheet` is what /api/issuers/:slug/what-if
     * returns; `null` means the call has not landed and `false` means it failed, which is said out
     * loud rather than shown as "no answers" — an unreachable API and a researched gap are different
     * findings and must not look alike.
     */
    function whatIfSectionHtml(sheet, catalogue, { failure = null } = {}) {
        if (failure !== null) {
            return `<p class="wi-fail">The answers live in the API, which did not answer: ${escapeHtml(failure)}. `
                + 'Nothing is shown rather than a partial sheet.</p>';
        }
        if (sheet === null) return '<p class="wi-empty">Loading the answer sheet…</p>';
        const answers = whatIfLib.answersFromApi(sheet.items);
        if (answers.length === 0) {
            return '<p class="wi-empty">The API returned no questions at all, which means the catalogue '
                + 'did not load on the server.</p>';
        }
        return whatIfLib.whatIfHtml(answers, {
            order: chainActorOrder(catalogue),
            labels: chainActorLabels(catalogue),
            intro: WHAT_IF_NOTE
        });
    }

    return {
        CHAIN_NOTE,
        WHAT_IF_NOTE,
        chainActorOrder,
        chainActorLabels,
        chainSectionHtml,
        whatIfSectionHtml
    };
});
