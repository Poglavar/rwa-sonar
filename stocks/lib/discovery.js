/*
 * Pure discovery and explanation helpers shared by stocks.html and its unit tests. UMD keeps the
 * browser path dependency-free while letting Jest require the exact same code. No DOM or clock is
 * read here: callers pass records and, for freshness, the time they want to judge against.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.__rwaDiscovery = factory();
})(this, function () {
    const CLAIMS = [
        'price exposure only — not ownership of the share',
        'an unsecured claim against the token issuer — not a share in the company',
        'a claim secured over collateral — not the underlying share itself',
        'a beneficial interest in shares held through an intermediary',
        'the registered share itself, subject to the official shareholder register'
    ];

    function clean(value) {
        return typeof value === 'string' ? value.trim() : '';
    }

    function controlIsOn(value) {
        if (value === true) return true;
        const v = clean(value).toLowerCase();
        return v !== '' && !['none', 'no', 'unknown', 'unavailable', 'not checked'].includes(v);
    }

    function laypersonVerdict({ claimRung = null, redemptionAvailable = null, control = {} } = {}) {
        const rung = Number.isInteger(claimRung) && claimRung >= 0 && claimRung <= 4 ? claimRung : null;
        const headline = rung === null ? 'The legal claim is not established yet.' : `You own ${CLAIMS[rung]}.`;
        const redemption = redemptionAvailable === true
            ? 'Eligible holders can redeem through the issuer.'
            : redemptionAvailable === false
                ? 'There is no holder redemption right recorded.'
                : 'Redemption rights are not established.';
        const powers = [];
        if (controlIsOn(control.clawback)) powers.push('reclaim');
        if (controlIsOn(control.freezeAuthority)) powers.push('freeze');
        if (controlIsOn(control.pausable)) powers.push('pause');
        const unknownPowers = [control.clawback, control.freezeAuthority, control.pausable]
            .some((value) => !controlIsOn(value) && value !== false && !['none', 'no'].includes(clean(value).toLowerCase()));
        const controlNote = powers.length === 0
            ? unknownPowers ? 'Freeze, pause or clawback powers are not fully established in this record.'
                : 'No freeze, pause or clawback power was detected in this record.'
            : `The issuer or its operator can ${powers.join(', ').replace(/, ([^,]*)$/, ' or $1')} tokens on-chain.${unknownPowers ? ' Other control powers are not fully established.' : ''}`;
        let cooperation;
        if (redemptionAvailable === true) {
            cooperation = rung === 4
                ? 'The transfer agent and issuer must recognise the holder and process conversion or redemption.'
                : 'The issuer, and usually its custodian or transfer agent, must cooperate for redemption.';
        } else if (rung === 4) {
            cooperation = 'The official share register or transfer agent must continue to recognise the token-form holding.';
        } else if (rung === null) {
            cooperation = 'The required parties cannot be stated confidently until the legal claim is established.';
        } else {
            cooperation = 'The issuer remains necessary to honour the claim; an on-chain transfer alone does not settle it.';
        }
        let mainFailure;
        if (powers.length > 0) {
            mainFailure = `The practical failure mode is issuer intervention: it can ${powers.join(', ').replace(/, ([^,]*)$/, ' or $1')} the token even after a valid on-chain transfer.`;
        } else if (rung === null) {
            mainFailure = 'The primary dependency is legal clarity: the token may move while the holder’s enforceable rights remain unclear.';
        } else if (rung <= 1) {
            mainFailure = 'The primary dependency is the issuer: the token holder may be only a general creditor, not an owner of ring-fenced shares.';
        } else if (rung === 2) {
            mainFailure = 'The primary dependency is enforcement: value depends on a valid, perfected and practically enforceable security interest.';
        } else if (rung === 3) {
            mainFailure = 'The primary dependencies are the intermediaries: the beneficial interest depends on custody, segregation and the claim chain.';
        } else {
            mainFailure = 'The primary dependency is registry alignment: the official register, transfer agent and token ledger must remain aligned.';
        }
        return {
            headline,
            ownership: headline,
            cooperation,
            mainFailure,
            redemption,
            controlNote,
            text: `${headline} ${cooperation} ${mainFailure} ${redemption} ${controlNote}`
        };
    }

    function legalReviewStatus(issuer) {
        const evidence = issuer && issuer.evidence && typeof issuer.evidence === 'object' ? issuer.evidence : {};
        const coverage = evidence.coverage && typeof evidence.coverage === 'object' ? evidence.coverage : {};
        const needed = Number.isFinite(coverage.needed) ? coverage.needed : 0;
        const sourced = Number.isFinite(coverage.sourced) ? coverage.sourced : 0;
        const unverified = Number.isFinite(evidence.unverified) ? evidence.unverified : 0;
        const inference = Number.isFinite(evidence.inference) ? evidence.inference : 0;
        // Legacy summaries did not split inference review state. Treat all of those as
        // unreviewed: an old prose note must never gain a review badge by omission.
        const reviewedInference = Number.isFinite(evidence.inferenceReviewed)
            ? Math.max(0, Math.min(inference, evidence.inferenceReviewed)) : 0;
        const unreviewedInference = Number.isFinite(evidence.inferenceUnreviewed)
            ? Math.max(0, Math.min(inference - reviewedInference, evidence.inferenceUnreviewed))
            : inference - reviewedInference;
        const missing = Math.max(0, needed - sourced);
        const pending = needed === 0 || missing > 0 || unverified > 0 || unreviewedInference > 0;
        const reasons = [];
        if (needed === 0) reasons.push('coverage has not been measured');
        else if (missing > 0) reasons.push(`${missing} required field${missing === 1 ? ' lacks' : 's lack'} sourced evidence`);
        if (unverified > 0) reasons.push(`${unverified} claim${unverified === 1 ? '' : 's'} await re-checking`);
        if (unreviewedInference > 0) reasons.push(`${unreviewedInference} conclusion${unreviewedInference === 1 ? '' : 's'} ${unreviewedInference === 1 ? 'is' : 'are'} inferential and await review`);
        if (reviewedInference > 0) reasons.push(`${reviewedInference} conclusion${reviewedInference === 1 ? '' : 's'} ${reviewedInference === 1 ? 'is' : 'are'} reviewed inference${reviewedInference === 1 ? '' : 's'} (not source-confirmed)`);
        return {
            pending,
            label: pending ? 'Legal review pending' : 'Legal evidence reviewed',
            detail: reasons.length ? reasons.join('; ') : `${sourced}/${needed} required fields sourced`
        };
    }

    function tokenSearchText(token, issuer) {
        return [
            token && token.symbol, token && token.name, token && token.underlyingTicker,
            token && token.mint, token && token.issuer,
            issuer && issuer.name, issuer && issuer.slug, issuer && issuer.issuingEntity
        ].map(clean).filter(Boolean).join(' ').toLowerCase();
    }

    const SEARCH_STOP_WORDS = new Set([
        'a', 'an', 'and', 'as', 'can', 'find', 'for', 'i', 'is', 'me', 'of', 'on', 'or', 'show',
        'stock', 'stocks', 'that', 'the', 'to', 'token', 'tokenized', 'tokens', 'usable', 'used', 'with'
    ]);

    function parseStockSearch(query) {
        const q = clean(query).toLowerCase();
        const filters = {
            collateral: /\bcollateral\b|\bborrow(?:ing)?\b|\blending\b/.test(q),
            redeemable: /\bredeem|\bcash exit\b/.test(q),
            noFreeze: /\bno freeze\b|\bwithout freeze\b|\bcannot freeze\b/.test(q),
            autonomous: /\bautonomous\b|\bliquidat(?:e|ion)\b/.test(q),
            segregated: /\bsegregat|\bring[- ]?fenc|\bdirect share\b/.test(q),
            nonUs: /\bnon[- ]?us\b|\boutside (?:the )?us\b|\bnon[- ]?american\b/.test(q),
            freshEvidence: /\bfresh evidence\b|\bcurrent evidence\b|\brecent evidence\b/.test(q)
        };
        const intentWords = new Set([
            'autonomous', 'borrow', 'borrowing', 'cash', 'collateral', 'current', 'direct', 'evidence',
            'exit', 'fresh', 'freeze', 'lending', 'liquidate', 'liquidation', 'non', 'outside', 'recent',
            'redeem', 'redeemable', 'redemption', 'segregated', 'share', 'shares', 'us', 'without'
        ]);
        const terms = q.match(/[a-z0-9]+/g) || [];
        return {
            query: q,
            terms: terms.filter((word) => !SEARCH_STOP_WORDS.has(word) && !intentWords.has(word)),
            filters,
            hasIntent: Object.values(filters).some(Boolean)
        };
    }

    function profileMatchesIntent(profile, filters) {
        if (!profile || !filters) return !Object.values(filters || {}).some(Boolean);
        return (!filters.collateral || profile.confirmedCollateral === true)
            && (!filters.redeemable || profile.cashRedemption === true)
            && (!filters.noFreeze || profile.noDiscretionaryFreeze === true)
            && (!filters.autonomous || profile.autonomousLiquidation === true)
            && (!filters.segregated || profile.segregatedAssets === true)
            && (!filters.nonUs || profile.nonUsHolders === true)
            && (!filters.freshEvidence || profile.freshEvidence === true);
    }

    function globalSearch(tokens, issuers, query, limit = 12, profiles = null) {
        const parsed = parseStockSearch(query);
        if (!parsed.query) return { issuers: [], tokens: [], intent: parsed };
        const issuerList = Array.isArray(issuers) ? issuers : [];
        const tokenList = Array.isArray(tokens) ? tokens : [];
        const bySlug = new Map(issuerList.map((issuer) => [issuer.slug, issuer]));
        const matchesTerms = (text) => parsed.terms.length === 0 || parsed.terms.every((term) => text.includes(term));
        const profileFor = (token) => profiles instanceof Map ? profiles.get(token.mint) : null;
        const issuerMatches = issuerList.filter((issuer) => {
            const text = [issuer.name, issuer.slug, issuer.issuingEntity, issuer.legalForm].map(clean).join(' ').toLowerCase();
            if (!matchesTerms(text)) return false;
            if (!parsed.hasIntent) return true;
            return tokenList.some((token) => token.issuer === issuer.slug && profileMatchesIntent(profileFor(token), parsed.filters));
        });
        const tokenMatches = tokenList.filter((token) => matchesTerms(tokenSearchText(token, bySlug.get(token.issuer)))
            && (!parsed.hasIntent || profileMatchesIntent(profileFor(token), parsed.filters)));
        return { issuers: issuerMatches.slice(0, limit), tokens: tokenMatches.slice(0, limit), intent: parsed };
    }

    function sameUnderlyingGroups(tokens, { includeSingle = false } = {}) {
        const groups = new Map();
        for (const token of Array.isArray(tokens) ? tokens : []) {
            const ticker = clean(token && token.underlyingTicker).toUpperCase();
            const issuer = clean(token && token.issuer);
            if (!ticker || !issuer) continue;
            if (!groups.has(ticker)) groups.set(ticker, new Map());
            const byIssuer = groups.get(ticker);
            if (!byIssuer.has(issuer)) byIssuer.set(issuer, []);
            byIssuer.get(issuer).push(token);
        }
        return [...groups.entries()]
            .filter(([, byIssuer]) => includeSingle || byIssuer.size >= 2)
            .map(([ticker, byIssuer]) => ({
                ticker,
                issuerCount: byIssuer.size,
                tokenCount: [...byIssuer.values()].reduce((sum, list) => sum + list.length, 0),
                rows: [...byIssuer.entries()].map(([issuer, list]) => ({
                    issuer,
                    tokens: list.slice().sort((a, b) => ((b.market && b.market.liquidity) || 0) - ((a.market && a.market.liquidity) || 0))
                })).sort((a, b) => a.issuer.localeCompare(b.issuer))
            }))
            .sort((a, b) => b.issuerCount - a.issuerCount || b.tokenCount - a.tokenCount || a.ticker.localeCompare(b.ticker));
    }

    /**
     * Discovery groups for the catalogue. The stock is the thing a reader recognizes; issuer
     * wrappers and exact token addresses sit underneath it. Unlike sameUnderlyingGroups(), this
     * includes single-wrapper stocks as well as stocks that can be compared.
     */
    function underlyingGroups(tokens) {
        const groups = new Map();
        for (const token of Array.isArray(tokens) ? tokens : []) {
            const ticker = clean(token && token.underlyingTicker).toUpperCase();
            const issuer = clean(token && token.issuer);
            if (!ticker || !issuer) continue;
            if (!groups.has(ticker)) groups.set(ticker, []);
            groups.get(ticker).push(token);
        }
        return [...groups.entries()].map(([ticker, list]) => {
            const issuers = [...new Set(list.map((token) => clean(token.issuer)).filter(Boolean))].sort();
            const name = clean(list.find((token) => clean(token?.issuerApi?.underlying?.name))?.issuerApi?.underlying?.name)
                || clean(list.find((token) => clean(token?.name))?.name).replace(/\s*\([^)]*(?:tokenized|stock|ondo|xstock)[^)]*\)\s*$/i, '')
                || ticker;
            return {
                ticker,
                name,
                issuerCount: issuers.length,
                tokenCount: list.length,
                issuers,
                liquidityUsd: list.reduce((sum, token) => sum + (Number.isFinite(token?.market?.liquidity) ? token.market.liquidity : 0), 0),
                volume24Usd: list.reduce((sum, token) => sum + (Number.isFinite(token?.market?.vol24) ? token.market.vol24 : 0), 0),
                holderCount: list.reduce((sum, token) => sum + (Number.isFinite(token?.market?.holderCount) ? token.market.holderCount : 0), 0),
                tokens: list.slice().sort((a, b) => ((b.market && b.market.liquidity) || 0) - ((a.market && a.market.liquidity) || 0))
            };
        }).sort((a, b) => b.issuerCount - a.issuerCount || b.liquidityUsd - a.liquidityUsd || a.ticker.localeCompare(b.ticker));
    }

    function collectorHealth(sources, nowMs, maxAgeHours = 48) {
        const labels = {
            universe: 'Asset universe', onchain: 'On-chain state', sponsorApis: 'Issuer APIs',
            referencePrices: 'Reference prices', venues: 'Trading venues', holders: 'Holders'
        };
        const rows = Object.entries(labels).map(([key, label]) => {
            const raw = sources && sources[key];
            const stamp = typeof raw === 'string' ? raw : raw && raw.fetchedAt;
            const time = typeof stamp === 'string' ? Date.parse(stamp) : NaN;
            const ageHours = Number.isFinite(time) && Number.isFinite(nowMs) ? Math.max(0, (nowMs - time) / 3600000) : null;
            return { key, label, fetchedAt: Number.isFinite(time) ? stamp : null, ageHours, fresh: ageHours !== null && ageHours <= maxAgeHours };
        });
        const fresh = rows.filter((row) => row.fresh).length;
        return { rows, fresh, total: rows.length, healthy: fresh === rows.length };
    }

    return {
        controlIsOn, laypersonVerdict, legalReviewStatus, tokenSearchText, parseStockSearch,
        profileMatchesIntent, globalSearch, sameUnderlyingGroups, underlyingGroups, collectorHealth
    };
});
