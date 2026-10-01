// Shapes the broad catalogue without promoting historical flags to current legal findings.
// Programme research stays scoped to its dossier; exact deployments keep their own observations.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.__rwaCatalogue = factory();
})(this, function () {
    const CATEGORIES = { cash: 'Cash', treasuries: 'Treasuries & cash management', stocks: 'Stocks & equity exposure', credit: 'Credit', commodities: 'Commodities', other: 'Other private markets' };
    const COVERAGE = { reviewed: 'Public documents reviewed', dossier: 'Dossier available', historical: 'Refresh pending' };
    const FORMS = { 'registered-share': 'Registered company share', 'tracker-certificate': 'Tracker certificate', 'structured-note': 'Structured note', 'debt-note': 'Debt note', 'spv-synthetic': 'Synthetic exposure', 'spv-claim-redeemable': 'Contractual / trust claim', derivative: 'Derivative' };
    // Exact record-to-programme reconciliation, rather than guessing from issuer names or mints.
    const PROGRAMMES = {
        'Opening Bell by Superstate': 'superstate-opening-bell', 'Kraken xStocks': 'xstocks-backed',
        'Ondo Global Markets': 'ondo-global-markets', 'Remora Markets': 'remora-markets',
        'Ventuals Pre-IPO': 'ventuals', 'Backpack Securities': 'backpack-securities',
        'Bullish BLSH': 'bullish', 'Securitize SECZ': 'securitize', 'PreStocks': 'prestocks',
        Tessera: 'tessera', 'Shift leveraged tokens': 'shift'
    };
    const category = (a) => a.type.includes('Stablecoin') ? 'cash'
        : a.type.includes('Money Market') || a.type.includes('Yield-Bearing') ? 'treasuries'
            : a.type.includes('Commodity') ? 'commodities' : a.type.includes('Private Credit') ? 'credit' : 'other';
    const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    function buildCatalogue(assets, issuerDb, tokenDb, research = { products: [] }) {
        if (!Array.isArray(assets) || !Array.isArray(issuerDb?.issuers) || !Array.isArray(tokenDb?.tokens)) throw new Error('Catalogue requires assets, issuers and tokens');
        const issuers = new Map(issuerDb.issuers.map((i) => [i.slug, i]));
        const reconciled = [];
        const entries = assets.filter((a) => {
            const programme = PROGRAMMES[a.name];
            if (!programme) return true;
            if (!issuers.has(programme)) throw new Error(`Missing reconciled programme: ${programme}`);
            reconciled.push({ originalName: a.name, programmeId: programme, historicalNetwork: a.blockchain || null });
            return false;
        }).map((a) => ({
            id: `product:${slug(a.name)}`, kind: 'product', name: a.name, ticker: a.ticker || null,
            issuer: a.issuer || null, category: category(a), exposure: a.type,
            legalForm: null, holderClaim: null, coverage: 'historical',
            scope: 'Original catalogue entry; instrument and share-class identity await review.',
            legalReviewedAt: null, evidenceCheckedAt: null, statusCheckedAt: a.statusCheckedAt || null,
            recordedStatus: a.status || null, chains: a.blockchain ? [a.blockchain] : [],
            deployments: a.contractAddress ? [{ network: a.blockchain, address: a.contractAddress, symbol: a.ticker || a.name, observedAt: null, identity: 'Historical address; verification pending', report: null }] : [],
            access: null, exit: null, source: 'rwa-assets-db.json', sourceUrl: a.website || null,
            report: `assets.html?search=${encodeURIComponent(a.name)}`
        }));
        const seenMints = new Set();
        for (const token of tokenDb.tokens) {
            if (!issuers.has(token.issuer)) throw new Error(`Unknown token programme: ${token.issuer}`);
            if (!token.mint || seenMints.has(token.mint)) throw new Error(`Missing or duplicate mint: ${token.mint}`);
            seenMints.add(token.mint);
        }
        for (const i of issuerDb.issuers) {
            const deployments = tokenDb.tokens.filter((t) => t.issuer === i.slug).map((t) => ({
                network: 'Solana', address: t.mint, symbol: t.symbol, name: t.name,
                underlying: t.underlyingTicker || t.companyName || null,
                identity: t.identity?.status || 'Not established',
                observedAt: t.lastSeenAt || null, report: t.cardSlug ? `cards/${encodeURIComponent(t.cardSlug)}.html` : null
            }));
            entries.push({
                id: `programme:${i.slug}`, kind: 'programme', name: i.name, ticker: null, issuer: i.issuerText || i.name,
                category: 'stocks', exposure: 'Stocks, ETFs or pre-IPO equity exposure; see individual token.',
                legalForm: i.legalForm || null, holderClaim: i.holderClaim || null, coverage: 'dossier',
                scope: 'Programme dossier. Instrument-specific terms and exact-token findings remain in the linked reports.',
                legalReviewedAt: null, evidenceCheckedAt: i.evidence?.lastCheckedAt || null,
                statusCheckedAt: null, recordedStatus: i.status || null,
                // Only networks represented by exact indexed deployments: no cross-chain inheritance.
                chains: [...new Set(deployments.map((d) => d.network))], deployments,
                historicalNetworks: [...new Set(reconciled.filter((r) => r.programmeId === i.slug).map((r) => r.historicalNetwork).filter(Boolean))],
                access: i.redemption?.eligibility || null, exit: i.redemption?.rails || null,
                source: `stocks/data/issuers/${i.slug}.json`, sourceUrl: null, report: `issuers/${i.slug}.html`
            });
        }
        for (const p of research.products.filter((p) => p.kind !== 'programme')) {
            const entry = entries.find((e) => e.name === p.originalName && e.kind === 'product');
            if (!entry) throw new Error(`Missing explicit research mapping: ${p.originalName}`);
            const context = p.contexts[0];
            const claim = (dimension) => p.claims.find((c) => c.dimension === dimension && c.scope.contextId === context.id)?.summary || null;
            Object.assign(entry, { name: p.name, aliases: [p.originalName], coverage: 'reviewed', researchId: p.id, instrumentId: p.instrument.id,
                programmeId: p.programmeId, legalForm: p.instrument.legalForm, issuer: p.instrument.issuer,
                exposure: p.exposure.label, category: p.id === 'hlscope' || p.id === 'acred' ? 'credit' : p.id === 'usdhl' ? 'cash' : entry.category,
                holderClaim: claim('rights'), access: claim('access'), exit: claim('exit'),
                scope: p.instrument.scope, legalReviewedAt: p.reviewedAt, evidenceCheckedAt: p.reviewedAt,
                source: 'rwa/data/research.json', report: `report.html?product=${encodeURIComponent(p.id)}`,
                // Preserve separate historical status time; public review does not establish operational status.
                deployments: p.deployments.map((d) => ({ ...d, symbol: p.ticker, observedAt: null, report: null })),
                chains: [...new Set(p.deployments.map((d) => d.network))]
            });
        }
        for (const p of research.products.filter((p) => p.kind === 'programme')) {
            const entry = entries.find((e) => e.id === `programme:${p.programmeId}`);
            if (!entry) throw new Error(`Missing programme mapping: ${p.programmeId}`);
            Object.assign(entry, { researchId: p.id, report: `report.html?product=${encodeURIComponent(p.id)}`, scope: p.programme.scope });
        }
        const families = Object.keys(CATEGORIES);
        entries.sort((a, b) => families.indexOf(a.category) - families.indexOf(b.category) || a.name.localeCompare(b.name));
        if (new Set(entries.map((e) => e.id)).size !== entries.length) throw new Error('Duplicate catalogue identity');
        return { schemaVersion: 1, sources: { assets: 'rwa-assets-db.json', issuers: issuerDb.builtAt || null, tokens: tokenDb.builtAt || null }, reconciled, entries,
            counts: { ...research.counts, products: entries.filter((e) => e.kind === 'product').length, reviewedProducts: research.products.filter((p) => p.kind !== 'programme').length, programmes: issuers.size, indexedStockDeployments: seenMints.size, historicalAddresses: entries.filter((e) => e.coverage === 'historical').reduce((n, e) => n + e.deployments.length, 0) } };
    }
    function matchingDeployments(entry, search = '') {
        const q = search.trim().toLowerCase();
        return entry.deployments.filter((d) => !q || [d.address, d.symbol, d.name, d.underlying].some((v) => String(v || '').toLowerCase().includes(q)));
    }
    function filterEntries(entries, filters = {}) {
        const q = (filters.search || '').trim().toLowerCase();
        const matches = entries.filter((e) => (!filters.category || e.category === filters.category)
            && (!filters.chain || e.chains.includes(filters.chain) || (e.historicalNetworks || []).includes(filters.chain))
            && (!filters.coverage || e.coverage === filters.coverage)
            && (!filters.form || (e.legalForm || 'unknown') === filters.form)
            && (!q || [e.name, e.ticker, e.issuer, e.exposure, e.aliases].some((v) => String(v || '').toLowerCase().includes(q)) || matchingDeployments(e, q).length));
        // Product-name matches lead discovery; a stock programme containing a gold ETF is secondary.
        const rank = (e) => [e.name, e.ticker, e.issuer, e.exposure, e.aliases].findIndex((v) => String(v || '').toLowerCase().includes(q));
        return q ? matches.sort((a, b) => (rank(a) < 0 ? 4 : rank(a)) - (rank(b) < 0 ? 4 : rank(b))) : matches;
    }
    function groupEntries(entries) {
        return [...new Set(entries.map((e) => e.category))].map((key) => [CATEGORIES[key], entries.filter((e) => e.category === key)]);
    }
    function clusterMatches(entries, entryIds, search) {
        if (!search.trim()) return {symbols: [], count: 0};
        const matchedEntries = filterEntries(entries.filter(e => entryIds.includes(e.id)), {search});
        const deployments = matchedEntries.flatMap(e => matchingDeployments(e, search));
        const symbols = [...new Set(deployments.map(d => d.symbol).filter(Boolean))];
        if (!symbols.length) symbols.push(...matchedEntries.filter(e => e.kind === 'product' && e.ticker).map(e => e.ticker));
        return {symbols: [...new Set(symbols)], count: deployments.length};
    }
    function searchResults(entries, search, limit = 12) {
        if (!search.trim()) return {entryIds: [], links: [], total: 0};
        const matches = filterEntries(entries, {search});
        const links = matches.flatMap(e => [
            {label: e.name, detail: `${COVERAGE[e.coverage]} · ${e.kind === 'programme' ? 'Issuer programme' : 'Product'}`, href: `./${e.report}`},
            ...matchingDeployments(e, search).filter(d => d.report).map(d => ({label: d.symbol || d.name, detail: `${e.name} · ${d.network} · ${d.address}`, href: `./${d.report}`}))
        ]);
        return {entryIds: matches.map(e => e.id), links: links.slice(0, limit), total: links.length};
    }
    return { CATEGORIES, COVERAGE, FORMS, buildCatalogue, matchingDeployments, filterEntries, groupEntries, searchResults, clusterMatches };
});
