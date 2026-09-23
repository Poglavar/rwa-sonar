/*
 * Global search results grouped into stocks, tokens, issuers and protocols, each with the reason
 * it matched, plus the underlying-stock directory cards.
 *
 * Moved verbatim out of stocks.js (next-steps.md F11). Pure: no DOM, no fetch, no clock. UMD like the
 * other stocks/lib/*.js files: the browser loads it as a classic script before stocks.js and reads
 * window.__rwaSearchResults; jest requires it. Tested in stocks/search-results.test.js.
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./fmt.js'), require('./discovery.js'));
    else root.__rwaSearchResults = factory(root.__rwaFmt, root.__rwaDiscovery);
})(this, function (fmt, discovery) {
    const { cardSlug, escapeHtml, fmtMoney, fmtNumber, humanizeSlug, mintSuffix } = fmt;
    const { globalSearch, parseStockSearch, underlyingGroups } = discovery;

    function underlyingDirectoryHtml(groups, issuersBySlug, limit = 48, savedTickers = new Set()) {
        const rows = (Array.isArray(groups) ? groups : []).slice(0, Math.max(0, limit));
        const names = issuersBySlug instanceof Map ? issuersBySlug : new Map();
        const saved = savedTickers instanceof Set ? savedTickers : new Set();
        return rows.map((group) => {
            const issuerNames = (group.issuers ?? []).map((slug) => names.get(slug)?.name ?? humanizeSlug(slug));
            const first = group.tokens?.[0];
            const firstSlug = first?.cardSlug || cardSlug(first?.symbol, first?.mint);
            const href = group.issuerCount > 1
                ? `./stocks.html?view=compare&compare=${encodeURIComponent(group.ticker)}`
                : (firstSlug ? `./cards/${encodeURIComponent(firstSlug)}.html` : `./stocks.html?view=assets`);
            const isSaved = saved.has(group.ticker);
            return `<article class="underlying-card" data-underlying="${escapeHtml(group.ticker)}"><a class="underlying-card-link" href="${escapeHtml(href)}">`
                + `<span class="underlying-card-kicker">${escapeHtml(group.ticker)}</span>`
                + `<strong>${escapeHtml(group.name || group.ticker)}</strong>`
                + `<small>${escapeHtml(issuerNames.slice(0, 3).join(' · '))}${issuerNames.length > 3 ? ` · +${issuerNames.length - 3}` : ''}</small>`
                + `<dl><div><dt>Wrappers</dt><dd>${escapeHtml(fmtNumber(group.issuerCount))}</dd></div>`
                + `<div><dt>Tokens</dt><dd>${escapeHtml(fmtNumber(group.tokenCount))}</dd></div>`
                + `<div><dt>Liquidity</dt><dd>${escapeHtml(fmtMoney(group.liquidityUsd))}</dd></div></dl>`
                + `<b>${group.issuerCount > 1 ? 'Compare wrappers →' : 'Open token →'}</b></a>`
                + `<button type="button" class="save-item" data-save-ticker="${escapeHtml(group.ticker)}" aria-pressed="${isSaved ? 'true' : 'false'}">${isSaved ? 'Saved stock' : 'Save stock'}</button></article>`;
        }).join('');
    }

    function searchIntentLabels(intent) {
        const filters = intent?.filters ?? {};
        return [
            filters.collateral && 'source-listed collateral',
            filters.redeemable && 'cash redemption',
            filters.noFreeze && 'no freeze, pause or clawback power',
            filters.autonomous && 'autonomous liquidation',
            filters.segregated && 'segregated assets or a direct share',
            filters.nonUs && 'non-US availability',
            filters.freshEvidence && 'fresh evidence'
        ].filter(Boolean);
    }

    function groupedSearchResults(tokens, issuers, protocols, query, limit = 6, profiles = null) {
        const parsed = parseStockSearch(query);
        if (!parsed.query) return { stocks: [], tokens: [], issuers: [], protocols: [], intent: parsed };
        const raw = globalSearch(tokens, issuers, query, Math.max(limit * 6, 24), profiles);
        const issuerMap = new Map((Array.isArray(issuers) ? issuers : []).map((issuer) => [issuer.slug, issuer]));
        const intentLabels = searchIntentLabels(parsed);
        const reasonSuffix = intentLabels.length ? ` · meets ${intentLabels.join(', ')}` : '';
        const exact = parsed.query.replace(/\s+/g, ' ');
        const includesTerms = (value) => parsed.terms.length === 0
            || parsed.terms.every((term) => String(value ?? '').toLowerCase().includes(term));
        const reasonForToken = (token) => {
            if (String(token?.mint ?? '').toLowerCase() === exact) return `Exact Solana token address${reasonSuffix}`;
            if (String(token?.symbol ?? '').toLowerCase() === exact) return `Exact token symbol${reasonSuffix}`;
            if (String(token?.underlyingTicker ?? '').toLowerCase() === exact) return `Underlying ticker${reasonSuffix}`;
            if (includesTerms(token?.name)) return `Token name${reasonSuffix}`;
            const issuer = issuerMap.get(token?.issuer);
            if (includesTerms([issuer?.name, issuer?.issuingEntity, token?.issuer].filter(Boolean).join(' '))) return `Issuer identity${reasonSuffix}`;
            return intentLabels.length ? `Meets ${intentLabels.join(', ')}` : 'Related token identity';
        };
        const stocks = underlyingGroups(raw.tokens).slice(0, limit).map((group) => ({
            record: group,
            reason: String(group.ticker).toLowerCase() === exact
                ? `Exact underlying ticker${reasonSuffix}`
                : (includesTerms(group.name) ? `Underlying company name${reasonSuffix}` : `Contains a matching token${reasonSuffix}`)
        }));
        const tokenRows = raw.tokens.slice(0, limit).map((token) => ({ record: token, reason: reasonForToken(token) }));
        const issuerRows = raw.issuers.slice(0, limit).map((issuer) => ({
            record: issuer,
            reason: String(issuer.slug ?? '').toLowerCase() === exact || String(issuer.name ?? '').toLowerCase() === exact
                ? `Exact issuer identity${reasonSuffix}` : `Issuer name, entity or legal form${reasonSuffix}`
        }));
        const protocolRows = (Array.isArray(protocols) ? protocols : []).filter((protocol) => {
            const text = [protocol.name, protocol.id, ...(protocol.actions ?? []), ...(protocol.categories ?? []),
                ...(protocol.assets ?? []).flatMap((asset) => [asset.symbol, asset.mint, asset.issuer])]
                .filter(Boolean).join(' ').toLowerCase();
            if (parsed.terms.length && !parsed.terms.every((term) => text.includes(term))) return false;
            if (parsed.filters.collateral && !(protocol.actions ?? []).includes('collateral')) return false;
            return true;
        }).slice(0, limit).map((protocol) => {
            const matchingAsset = (protocol.assets ?? []).find((asset) =>
                [asset.symbol, asset.mint, asset.issuer].some((value) => String(value ?? '').toLowerCase().includes(exact)));
            const actionMatch = (protocol.actions ?? []).find((action) => parsed.query.includes(String(action).replace(/-/g, ' ')));
            const reason = String(protocol.name ?? '').toLowerCase().includes(exact)
                ? 'Protocol name'
                : matchingAsset ? `Supports matching token ${matchingAsset.symbol || mintSuffix(matchingAsset.mint)}`
                    : actionMatch ? `Confirmed action: ${humanizeSlug(actionMatch)}`
                        : (intentLabels.length ? `Provides ${intentLabels.join(', ')}` : 'Protocol, action or supported token');
            return { record: protocol, reason };
        });
        return { stocks, tokens: tokenRows, issuers: issuerRows, protocols: protocolRows, intent: parsed };
    }

    return {
        underlyingDirectoryHtml,
        searchIntentLabels,
        groupedSearchResults
    };
});
