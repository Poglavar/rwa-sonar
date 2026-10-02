/*
 * The landing page's search-as-you-type: shapes one GET /api/search?q= response (api/src/routes/
 * search.js: slim token rows, biggest pool first, and issuer summaries) into the same three groups
 * the catalogue's search shows — underlying stocks, exact tokens, issuers — each row with its link.
 * The full grouped search (stocks/lib/search-results.js) needs the whole 8 MB catalogue; this needs
 * one small API answer, so the landing page can offer results without loading the catalogue.
 *
 * Pure: no DOM, no fetch. UMD like the other stocks/lib/*.js files: the browser reads
 * window.__rwaQuickSearch (after fmt.js); jest requires it. Tested in stocks/quick-search.test.js.
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./fmt.js'));
    else root.__rwaQuickSearch = factory(root.__rwaFmt);
})(this, function (fmt) {
    const { cardSlug } = fmt;

    function text(value) {
        return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
    }

    function cardHref(row) {
        return `./cards/${encodeURIComponent(text(row.card_slug) ?? cardSlug(row.symbol, row.mint))}.html`;
    }

    /**
     * {stocks, tokens, issuers, order, allHref}: each row {label, detail, href}. A stock appears only
     * when its own ticker contains the query (a token found by its name, "Apple (Ondo Tokenized)" for
     * "ondo", does not make SLV an answer). A stock several issuers wrap opens the wrapper comparison;
     * one with a single token opens that token's card. `order` is the order to show the groups in:
     * issuers first when an issuer's name starts with the query, else stocks, tokens, issuers.
     * `allHref` is the catalogue search for the query, for "see every result".
     */
    function quickSearchGroups(response, query, { stocks: stockLimit = 4, tokens: tokenLimit = 6, issuers: issuerLimit = 3 } = {}) {
        const q = String(query ?? '').trim();
        const tokens = Array.isArray(response?.tokens) ? response.tokens.filter((row) => text(row?.mint)) : [];
        const issuers = Array.isArray(response?.issuers) ? response.issuers.filter((row) => text(row?.slug)) : [];

        const byTicker = new Map();
        for (const row of tokens) {
            const ticker = text(row.underlying_ticker);
            if (!ticker) continue;
            if (!byTicker.has(ticker)) byTicker.set(ticker, []);
            byTicker.get(ticker).push(row);
        }
        const needle = q.toLowerCase();
        const stocks = [...byTicker].filter(([ticker]) => needle && ticker.toLowerCase().includes(needle)).map(([ticker, rows]) => {
            const wrappers = new Set(rows.map((row) => row.issuer_slug).filter(Boolean)).size;
            return {
                ticker,
                exact: ticker.toLowerCase() === needle,
                label: ticker,
                detail: `${wrappers} wrapper${wrappers === 1 ? '' : 's'} · ${rows.length} token${rows.length === 1 ? '' : 's'} found`,
                href: wrappers > 1 ? `./stocks.html?view=compare&compare=${encodeURIComponent(ticker)}` : cardHref(rows[0])
            };
        })
            // An exact ticker first; otherwise the API's order (biggest pool first) stands.
            .sort((a, b) => Number(b.exact) - Number(a.exact))
            .slice(0, stockLimit)
            .map(({ label, detail, href }) => ({ label, detail, href }));

        const issuerFirst = needle !== '' && issuers.some((row) => (text(row.name) ?? row.slug).toLowerCase().startsWith(needle));
        return {
            order: issuerFirst ? ['issuers', 'stocks', 'tokens'] : ['stocks', 'tokens', 'issuers'],
            stocks,
            tokens: tokens.slice(0, tokenLimit).map((row) => ({
                label: text(row.symbol) ?? `${row.mint.slice(0, 4)}…${row.mint.slice(-4)}`,
                detail: [text(row.underlying_ticker), text(row.issuer_name) ?? text(row.issuer_slug)].filter(Boolean).join(' · '),
                href: cardHref(row)
            })),
            issuers: issuers.slice(0, issuerLimit).map((row) => ({
                label: text(row.name) ?? row.slug,
                detail: text(row.legal_form) ? row.legal_form.replace(/[-_]+/g, ' ') : 'Issuer dossier',
                href: `./issuers/${encodeURIComponent(row.slug)}.html`
            })),
            allHref: `./stocks.html?view=assets&search=${encodeURIComponent(q)}`
        };
    }

    return { quickSearchGroups };
});
