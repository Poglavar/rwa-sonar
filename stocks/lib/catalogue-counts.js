/*
 * Headline counts derived from the built issuer file, so no page types "12 issuers" or "up to 212
 * tokens" by hand. Shared by stocks.js (browser, window.__rwaCatalogueCounts) and the static-snapshot
 * builder (stocks/build-static-snapshot.mjs), so the static HTML and the live page qualify the issuer
 * total in the same words. Pure, UMD-wrapped. Tested in ../static-snapshot.test.js.
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.__rwaCatalogueCounts = factory();
})(this, function () {
    'use strict';

    function finiteCount(value) {
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    }

    /**
     * Token addresses attributed to one issuer programme, or null when nothing says. The full issuer
     * file carries market.tokens; the compact discovery index does not, so a caller holding the token
     * rows passes them as `tokens` and they are counted by issuer slug.
     */
    function programmeTokenCount(issuer, tokens) {
        const counted = finiteCount(issuer?.market?.tokens);
        if (counted !== null) return counted;
        if (Array.isArray(issuer?.tokenMints)) return issuer.tokenMints.length;
        if (Array.isArray(tokens) && typeof issuer?.slug === 'string') {
            return tokens.filter((token) => token?.issuer === issuer.slug).length;
        }
        return null;
    }

    /** "A", "A and B", "A, B and C". */
    function listNames(names) {
        const list = names.filter((name) => typeof name === 'string' && name.trim());
        if (list.length <= 1) return list.join('');
        return `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
    }

    /**
     * Splits the tracked programmes into those with live token addresses, defunct ones and live
     * ones with no mint observed yet. A programme whose count is missing is `unmeasured`, never
     * silently counted as zero.
     */
    function issuerProgrammeSummary(issuers, tokens) {
        const rows = (Array.isArray(issuers) ? issuers : []).filter((row) => row && typeof row === 'object');
        const summary = { total: rows.length, withTokens: 0, tokens: 0, defunct: [], noMint: [], unmeasured: [], largest: null };
        for (const issuer of rows) {
            const name = issuer.name ?? issuer.slug ?? 'Unnamed programme';
            const count = programmeTokenCount(issuer, tokens);
            if (issuer.status === 'defunct') {
                summary.defunct.push(name);
                continue;
            }
            if (count === null) summary.unmeasured.push(name);
            else if (count === 0) summary.noMint.push(name);
            else {
                summary.withTokens += 1;
                summary.tokens += count;
                if (summary.largest === null || count > summary.largest.tokens) summary.largest = { name, tokens: count };
            }
        }
        return summary;
    }

    /** Why some tracked programmes have no live token: ["Remora Markets and Ventuals defunct", …]. */
    function programmeExceptions(summary) {
        if (!summary) return [];
        const parts = [];
        if (summary.defunct.length) parts.push(`${listNames(summary.defunct)} defunct`);
        if (summary.noMint.length) parts.push(`${listNames(summary.noMint)}: no mint yet`);
        if (summary.unmeasured.length) parts.push(`${listNames(summary.unmeasured)}: token count not measured`);
        return parts;
    }

    /** "9 with live tokens · Remora Markets and Ventuals defunct · Republic Mirror: no mint yet". */
    function programmeQualifier(summary) {
        if (!summary || summary.total === 0) return '';
        return [`${summary.withTokens} with live tokens`, ...programmeExceptions(summary)].join(' · ');
    }

    return { programmeTokenCount, listNames, issuerProgrammeSummary, programmeExceptions, programmeQualifier };
});
