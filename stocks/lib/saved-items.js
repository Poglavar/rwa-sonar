/*
 * What a reader keeps in this browser: saved stocks and issuers, the saved comparison snapshot
 * and what changed since it, and the "since your last visit" journal summary.
 *
 * Moved verbatim out of stocks.js (next-steps.md F11). No DOM, no fetch; the one clock read is the
 * snapshot's own savedAt stamp, which is the save time by definition. UMD like the
 * other stocks/lib/*.js files: the browser loads it as a classic script before stocks.js and reads
 * window.__rwaSavedItems; jest requires it. Tested in stocks/saved-items.test.js.
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./fmt.js'));
    else root.__rwaSavedItems = factory(root.__rwaFmt);
})(this, function (fmt) {
    const { isNum } = fmt;

    function comparisonSnapshot(ticker, models) {
        return {
            ticker,
            savedAt: new Date().toISOString(),
            products: Object.fromEntries((Array.isArray(models) ? models : []).map((model) => [model.issuerSlug, {
                cashRedemption: model.decision?.cashRedemption === true,
                confirmedCollateral: model.decision?.confirmedCollateral === true,
                autonomousLiquidation: model.decision?.autonomousLiquidation === true,
                exitRating: model.outcome?.exitQuality?.rating ?? 'unknown',
                protocols: (model.protocols ?? []).slice().sort(),
                liquidityUsd: isNum(model.liquidityUsd) ? model.liquidityUsd : null,
                evidencePending: model.review?.pending !== false
            }]))
        };
    }

    function comparisonSnapshotChanges(previous, current) {
        if (!previous?.products || !current?.products) return [];
        const changes = [];
        const slugs = new Set([...Object.keys(previous.products), ...Object.keys(current.products)]);
        for (const slug of slugs) {
            const before = previous.products[slug];
            const after = current.products[slug];
            if (!before) { changes.push(`${slug}: product added to this comparison`); continue; }
            if (!after) { changes.push(`${slug}: product no longer appears in this comparison`); continue; }
            if (before.confirmedCollateral !== after.confirmedCollateral) {
                changes.push(`${slug}: source-listed collateral support ${after.confirmedCollateral ? 'appeared' : 'disappeared'}`);
            }
            if (before.autonomousLiquidation !== after.autonomousLiquidation || before.exitRating !== after.exitRating) {
                changes.push(`${slug}: exit-after-default assessment changed from ${before.exitRating} to ${after.exitRating}`);
            }
            if (before.cashRedemption !== after.cashRedemption) {
                changes.push(`${slug}: cash-redemption conclusion changed`);
            }
            if (before.evidencePending !== after.evidencePending) {
                changes.push(`${slug}: legal-evidence review status changed`);
            }
            if (JSON.stringify(before.protocols) !== JSON.stringify(after.protocols)) {
                changes.push(`${slug}: source-listed protocol set changed`);
            }
            if (isNum(before.liquidityUsd) && isNum(after.liquidityUsd) && before.liquidityUsd > 0
                && after.liquidityUsd < before.liquidityUsd * 0.6) {
                changes.push(`${slug}: reported liquidity fell more than 40%`);
            }
        }
        return changes;
    }

    const SAVED_ITEM_LIMIT = 100;

    function normalizeSavedItems(value) {
        const source = value && typeof value === 'object' ? value : {};
        const clean = (rows, transform = (entry) => entry) => [...new Set((Array.isArray(rows) ? rows : [])
            .filter((entry) => typeof entry === 'string' && entry.trim())
            .map((entry) => transform(entry.trim())).filter(Boolean))].slice(0, SAVED_ITEM_LIMIT);
        return { tickers: clean(source.tickers, (ticker) => ticker.toUpperCase()), issuers: clean(source.issuers) };
    }

    function toggleSavedItem(value, kind, id) {
        const next = normalizeSavedItems(value);
        const key = kind === 'ticker' ? 'tickers' : kind === 'issuer' ? 'issuers' : null;
        const cleaned = typeof id === 'string' ? (kind === 'ticker' ? id.trim().toUpperCase() : id.trim()) : '';
        if (!key || !cleaned) return next;
        const current = new Set(next[key]);
        if (current.has(cleaned)) current.delete(cleaned);
        else current.add(cleaned);
        next[key] = [...current].slice(0, SAVED_ITEM_LIMIT);
        return next;
    }

    function personalJournalSummary(items, previous) {
        const rows = Array.isArray(items) ? items : [];
        const identity = (row) => typeof row?.id === 'string' && row.id
            ? row.id : [row?.date, row?.kind, row?.title].map((part) => String(part ?? '')).join('\u0000');
        const currentIdentities = rows.map(identity);
        const firstVisit = !previous || !Array.isArray(previous.identities);
        const seen = new Set(firstVisit ? [] : previous.identities.filter((item) => typeof item === 'string'));
        const unseen = firstVisit ? [] : rows.filter((row) => !seen.has(identity(row)));
        const isProtocol = (row) => row?.category === 'defi'
            || /^(protocol-(added|removed)|ltv-change|market-inactive|collateral-value-change)$/.test(String(row?.kind ?? ''));
        return {
            firstVisit,
            previousVisitedAt: typeof previous?.visitedAt === 'string' ? previous.visitedAt : null,
            unseen,
            newAssets: rows.filter((row) => row?.kind === 'asset-added'),
            protocolChanges: rows.filter(isProtocol),
            currentIdentities
        };
    }

    return {
        comparisonSnapshot,
        comparisonSnapshotChanges,
        SAVED_ITEM_LIMIT,
        normalizeSavedItems,
        toggleSavedItem,
        personalJournalSummary
    };
});
