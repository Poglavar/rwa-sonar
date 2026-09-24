/*
 * Exact-token DeFi usage and composability: the usage index, protocol-first directory rows,
 * source freshness, the lender-outcome and decision models, redemption usability, and the
 * compact, detail and template-table markup built from them.
 *
 * Moved verbatim out of stocks.js (next-steps.md F11). Pure: no DOM, no fetch; the clock only as a
 * default `now` a caller can override. UMD like the
 * other stocks/lib/*.js files: the browser loads it as a classic script before stocks.js and reads
 * window.__rwaDefiView; jest requires it. Tested in stocks/defi-view.test.js.
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./fmt.js'), require('./discovery.js'), require('./redemption-usability.js'), require('./token-view.js'), require('./protocol-proof.js'));
    else root.__rwaDefiView = factory(root.__rwaFmt, root.__rwaDiscovery, root.__rwaRedemptionUsability, root.__rwaTokenView, root.__rwaProtocolProof);
})(this, function (fmt, discovery, redemptionModel, tokenView, protocolProof) {
    const { cardSlug, escapeHtml, fmtMoney, fmtNumber, fmtPct, fmtRelativeTime, humanizeSlug, isNum, isSafeUrl, isoToMillis, mintSuffix } = fmt;
    const { legalReviewStatus } = discovery;
    const { dataStateHtml } = tokenView;

    const DEFI_ACTION_LABELS = {
        swap: 'swap',
        'provide-liquidity': 'provide liquidity',
        collateral: 'use as collateral',
        borrow: 'borrow against',
        lend: 'supply / lend',
        deposit: 'deposit in vault',
        'earn-yield': 'earn yield'
    };

    const DEFI_ACTION_ORDER = ['collateral', 'borrow', 'lend', 'deposit', 'earn-yield', 'swap', 'provide-liquidity'];

    /** Exact mint -> observed-use record. Empty/malformed files produce an empty map, never guesses. */
    function defiUsageIndex(db) {
        return new Map((Array.isArray(db?.items) ? db.items : [])
            .filter((item) => item && typeof item.mint === 'string')
            .map((item) => [item.mint, item]));
    }

    function defiActionText(actions) {
        return (Array.isArray(actions) ? actions : [])
            .map((action) => DEFI_ACTION_LABELS[action] || humanizeSlug(action))
            .join(' · ');
    }

    function protocolDossierSlug(item, integration, number = 0) {
        const core = [item?.symbol || 'token', integration?.protocolId || 'protocol', integration?.id || number]
            .join('-').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        return `${core}-${String(item?.mint || '').slice(0, 6).toLowerCase()}`;
    }

    function redemptionUsabilitySummary(issuer, token) {
        const redemption = issuer?.redemption ?? {};
        const claims = Array.isArray(issuer?.claims) ? issuer.claims : [];
        const successful = claims.some((claim) => {
            if (!String(claim?.field ?? '').startsWith('redemption.')) return false;
            return /transaction/.test(String(claim?.method ?? '').toLowerCase())
                || /observed (redemption|redeem)|transaction hash/.test(String(claim?.note ?? '').toLowerCase());
        });
        const dexPairs = token?.activity?.dexPairs;
        const cexMarkets = token?.activity?.cexMarkets;
        const marketMeasured = isNum(dexPairs) || isNum(cexMarkets);
        const hasMarket = (isNum(dexPairs) && dexPairs > 0) || (isNum(cexMarkets) && cexMarkets > 0)
            || (isNum(token?.market?.liquidity) && token.market.liquidity > 0);
        const reviewStatus = legalReviewStatus(issuer);
        const model = redemptionModel.shapeRedemptionUsability({
            redemption,
            productSymbol: token?.symbol ?? null,
            answerScope: token ? 'product' : 'programme',
            operationalRouteAvailable: redemption.operationalRouteAvailable,
            operationalRouteEvidence: redemption.operationalEvidence,
            successfulRedemptionObserved: successful ? true
                : typeof redemption.successfulRedemptionObserved === 'boolean' ? redemption.successfulRedemptionObserved : null,
            successfulRedemptionEvidence: redemption.successfulRedemptionEvidence ?? null,
            secondaryMarketAvailable: token === null || token === undefined ? null : hasMarket ? true : marketMeasured ? false : null,
            reviewStatus: { pending: reviewStatus.pending, label: reviewStatus.label, detail: reviewStatus.detail }
        });
        const value = (id) => model.fields.find((field) => field.id === id)?.value ?? null;
        return {
            model,
            operational: value('route-currently-available') === true
                ? model.fields.find((field) => field.id === 'route-currently-available')?.evidence === 'documented'
                    ? 'Current official route documented' : 'Independently observed available'
                : value('route-currently-available') === false ? 'Current source says unavailable'
                    : 'Unknown — not independently checked',
            successful: value('successful-redemption') === true ? 'Yes — a completed transaction is recorded'
                : 'Not recorded — documented terms are not execution proof',
            secondary: value('secondary-market-exit') === true ? 'Confirmed in the checked exact-token venues; executable size is not guaranteed'
                : value('secondary-market-exit') === false ? 'No exact-token market confirmed in the checked venues'
                    : 'Unknown — exact-token venue coverage is unavailable',
            // Programme-level recurring on-chain scan line (observed execution only), or null.
            feed: redemptionModel.describeObservationFeed(redemption.observationFeed ?? null)
        };
    }

    /** Compact per-asset list for the paginated token-address table. */
    function defiUsageCompactHtml(item) {
        const integrations = Array.isArray(item?.integrations) ? item.integrations : [];
        if (integrations.length === 0) {
            return '<span class="defi-none" title="No exact-token integration was found in the sources checked">None source-listed</span>';
        }
        return `<div class="defi-chips">${integrations.map((entry) => {
            const title = `${entry.protocolName || entry.protocolId || 'Protocol'}: ${defiActionText(entry.actions)}`;
            return `<span class="defi-chip defi-chip-${escapeHtml(entry.status || 'available')}" title="${escapeHtml(title)}">` +
                `<strong>${escapeHtml(entry.protocolName || entry.protocolId || 'Protocol')}</strong>` +
                `<small>${escapeHtml(defiActionText(entry.actions))}</small></span>`;
        }).join('')}</div>`;
    }

    function defiMetricText(entry) {
        const metrics = entry?.metrics ?? {};
        const parts = [];
        if (isNum(metrics.sizeUsd)) parts.push(`${fmtMoney(metrics.sizeUsd)} ${typeof metrics.sizeLabel === 'string' ? metrics.sizeLabel : 'market size'}`);
        if (isNum(metrics.maxLtvMin) || isNum(metrics.maxLtvMax)) {
            const low = isNum(metrics.maxLtvMin) ? metrics.maxLtvMin * 100 : null;
            const high = isNum(metrics.maxLtvMax) ? metrics.maxLtvMax * 100 : low;
            parts.push(`max LTV ${low === high ? fmtPct(low) : `${fmtPct(low)}–${fmtPct(high)}`}`);
        }
        if (isNum(metrics.liquidityUsd)) parts.push(`${fmtMoney(metrics.liquidityUsd)} pool liquidity`);
        if (isNum(metrics.volume24Usd)) parts.push(`${fmtMoney(metrics.volume24Usd)} 24h volume`);
        if (isNum(metrics.collateralWeightMin) || isNum(metrics.collateralWeightMax)) {
            const low = isNum(metrics.collateralWeightMin) ? metrics.collateralWeightMin * 100 : null;
            const high = isNum(metrics.collateralWeightMax) ? metrics.collateralWeightMax * 100 : low;
            parts.push(`collateral weight ${low === high ? fmtPct(low) : `${fmtPct(low)}–${fmtPct(high)}`}`);
        }
        if (isNum(metrics.liquidationLtvMin) || isNum(metrics.liquidationLtvMax)) {
            const low = isNum(metrics.liquidationLtvMin) ? metrics.liquidationLtvMin * 100 : metrics.liquidationLtvMax * 100;
            const high = isNum(metrics.liquidationLtvMax) ? metrics.liquidationLtvMax * 100 : low;
            parts.push(`liquidation LTV ${low === high ? fmtPct(low) : `${fmtPct(low)}–${fmtPct(high)}`}`);
        }
        if (isNum(metrics.liquidationPenaltyMin) || isNum(metrics.liquidationPenaltyMax)) {
            const low = isNum(metrics.liquidationPenaltyMin) ? metrics.liquidationPenaltyMin * 100 : metrics.liquidationPenaltyMax * 100;
            const high = isNum(metrics.liquidationPenaltyMax) ? metrics.liquidationPenaltyMax * 100 : low;
            parts.push(`liquidation penalty ${low === high ? fmtPct(low) : `${fmtPct(low)}–${fmtPct(high)}`}`);
        }
        if (Array.isArray(metrics.oracleProviders) && metrics.oracleProviders.length) parts.push(`oracle ${metrics.oracleProviders.join(', ')}`);
        if (isNum(metrics.maxOracleStalenessSeconds)) parts.push(`oracle max age ${fmtNumber(metrics.maxOracleStalenessSeconds)} s`);
        if (isNum(metrics.utilizationPct)) parts.push(`utilisation ${fmtPct(metrics.utilizationPct)}`);
        if (isNum(metrics.depositLimitUsd)) parts.push(`${fmtMoney(metrics.depositLimitUsd)} deposit cap`);
        if (isNum(metrics.borrowLimitUsd)) parts.push(`${fmtMoney(metrics.borrowLimitUsd)} borrow cap`);
        if (isNum(metrics.pools)) parts.push(`${fmtNumber(metrics.pools)} pool${metrics.pools === 1 ? '' : 's'}`);
        if (isNum(metrics.positions)) parts.push(`${fmtNumber(metrics.positions)} position${metrics.positions === 1 ? '' : 's'}`);
        // Only an integration that names its debt measure shows it (Loopscale: open loan principal).
        if (isNum(metrics.debtAgainstCollateralUsd) && typeof metrics.debtLabel === 'string') {
            parts.push(`${fmtMoney(metrics.debtAgainstCollateralUsd)} ${metrics.debtLabel}`);
        }
        if (isNum(metrics.loansPastEnd) && metrics.loansPastEnd > 0) parts.push(`${fmtNumber(metrics.loansPastEnd)} past end date`);
        return parts.join(' · ');
    }

    const DEFI_SOURCE_LABELS = {
        kamino: ['Kamino', 'direct lending registry'],
        jupiterLend: ['Jupiter Lend', 'direct lending registry'],
        nest: ['Nest', 'versioned deployment manifest'],
        project0: ['Project 0', 'live collateral-bank registry'],
        save: ['Save', 'official lending reserve registry'],
        loopscaleVaults: ['Loopscale vaults', 'lending-vault collateral terms'],
        dexPools: ['DEX pools', 'exact-token market discovery'],
        meteora: ['Meteora', 'direct pool verification'],
        curated: ['Reviewed products', 'asset-specific manual review'],
        solanaRpc: ['Solana accounts', 'on-chain existence corroboration']
    };

    /** Protocol-source coverage with explicit freshness; an unchecked protocol is never implied absent. */
    function defiSourceRows(sources, now = Date.now()) {
        return Object.entries(DEFI_SOURCE_LABELS).map(([id, [label, scope]]) => {
            const source = sources?.[id] ?? null;
            const observedAt = source?.fetchedAt ?? source?.reviewedAt ?? null;
            const observedMs = isoToMillis(observedAt);
            const ageHours = observedMs === null ? null : Math.max(0, (now - observedMs) / 3_600_000);
            const maxAgeHours = id === 'curated' ? 24 * 45 : 48;
            return {
                id, label, scope, observedAt, ageHours, maxAgeHours,
                fresh: ageHours !== null && ageHours <= maxAgeHours,
                rows: isNum(source?.rows) ? source.rows : null,
                url: source?.url ?? source?.source?.dexscreener?.url ?? null
            };
        });
    }

    /** Protocol-first view of exact-token integrations; generic token-standard support is excluded. */
    function defiProtocolRows(db) {
        const groups = new Map();
        for (const item of Array.isArray(db?.items) ? db.items : []) {
            if (!item || typeof item.mint !== 'string') continue;
            for (const entry of Array.isArray(item.integrations) ? item.integrations : []) {
                const id = entry?.protocolId || entry?.protocolName;
                if (!id) continue;
                if (!groups.has(id)) {
                    groups.set(id, {
                        id, name: entry.protocolName || humanizeSlug(id), statuses: new Set(), actions: new Set(),
                        categories: new Set(), assets: new Map(), collateralMints: new Set(), ltvValues: [],
                        liquidationValues: [], liquidityUsd: 0, volume24Usd: 0, sizeUsd: 0,
                        links: { protocol: null, use: null, evidence: null }
                    });
                }
                const group = groups.get(id);
                group.statuses.add(entry.status || 'available');
                group.categories.add(entry.category || 'other');
                const actions = Array.isArray(entry.actions) ? entry.actions : [];
                actions.forEach((action) => group.actions.add(action));
                if (actions.includes('collateral')) group.collateralMints.add(item.mint);
                const metrics = entry.metrics || {};
                for (const key of ['maxLtvMin', 'maxLtvMax']) if (isNum(metrics[key])) group.ltvValues.push(metrics[key]);
                for (const key of ['liquidationLtvMin', 'liquidationLtvMax']) if (isNum(metrics[key])) group.liquidationValues.push(metrics[key]);
                if (isNum(metrics.liquidityUsd)) group.liquidityUsd += metrics.liquidityUsd;
                if (isNum(metrics.volume24Usd)) group.volume24Usd += metrics.volume24Usd;
                if (isNum(metrics.sizeUsd)) group.sizeUsd += metrics.sizeUsd;
                group.links.protocol ||= isSafeUrl(entry.links?.protocol) ? entry.links.protocol : null;
                group.links.use ||= isSafeUrl(entry.links?.use) ? entry.links.use : null;
                const evidenceUrl = (Array.isArray(entry.evidence) ? entry.evidence : [])
                    .map((row) => row?.url).find(isSafeUrl);
                group.links.evidence ||= evidenceUrl || null;
                const asset = group.assets.get(item.mint) || {
                    mint: item.mint, symbol: item.symbol || null, issuer: item.issuer || null, actions: new Set()
                };
                actions.forEach((action) => asset.actions.add(action));
                group.assets.set(item.mint, asset);
            }
        }
        return [...groups.values()].map((group) => {
            const range = (values) => values.length ? [Math.min(...values), Math.max(...values)] : [null, null];
            const [ltvMin, ltvMax] = range(group.ltvValues);
            const [liquidationMin, liquidationMax] = range(group.liquidationValues);
            return {
                id: group.id, name: group.name,
                status: group.statuses.has('live') ? 'live' : [...group.statuses][0] || 'available',
                actions: DEFI_ACTION_ORDER.filter((action) => group.actions.has(action)),
                categories: [...group.categories].sort(), tokenCount: group.assets.size,
                collateralCount: group.collateralMints.size, ltvMin, ltvMax, liquidationMin, liquidationMax,
                liquidityUsd: group.liquidityUsd || null, volume24Usd: group.volume24Usd || null,
                sizeUsd: group.sizeUsd || null, links: group.links,
                assets: [...group.assets.values()].map((asset) => ({
                    ...asset, actions: DEFI_ACTION_ORDER.filter((action) => asset.actions.has(action))
                })).sort((a, b) => String(a.symbol || a.mint).localeCompare(String(b.symbol || b.mint)))
            };
        }).sort((a, b) => (b.collateralCount - a.collateralCount)
            || (b.tokenCount - a.tokenCount)
            || ((b.liquidityUsd || 0) - (a.liquidityUsd || 0))
            || a.name.localeCompare(b.name));
    }

    function filterDefiProtocols(rows, action) {
        const list = Array.isArray(rows) ? rows : [];
        if (!action || action === 'all') return list;
        return list.filter((row) => Array.isArray(row.actions) && row.actions.includes(action));
    }

    function defiRangeText(low, high, label) {
        if (!isNum(low) && !isNum(high)) return null;
        const a = (isNum(low) ? low : high) * 100;
        const b = (isNum(high) ? high : low) * 100;
        return `${label} ${a === b ? fmtPct(a) : `${fmtPct(a)}–${fmtPct(b)}`}`;
    }

    function defiProtocolDirectoryHtml(rows) {
        return (Array.isArray(rows) ? rows : []).map((row) => {
            const metrics = [
                row.collateralCount ? `${fmtNumber(row.collateralCount)} collateral token${row.collateralCount === 1 ? '' : 's'}` : null,
                defiRangeText(row.ltvMin, row.ltvMax, 'max LTV'),
                defiRangeText(row.liquidationMin, row.liquidationMax, 'liquidation LTV'),
                isNum(row.sizeUsd) ? `${fmtMoney(row.sizeUsd)} observed market size` : null,
                isNum(row.liquidityUsd) ? `${fmtMoney(row.liquidityUsd)} pool liquidity` : null
            ].filter(Boolean);
            const assetLink = (asset) => {
                const slug = cardSlug(asset.symbol, asset.mint);
                const label = asset.symbol || mintSuffix(asset.mint);
                return `<a href="./cards/${encodeURIComponent(slug)}.html" title="${escapeHtml(defiActionText(asset.actions))}">${escapeHtml(label)}</a>`;
            };
            const visible = row.assets.slice(0, 10);
            const hidden = row.assets.slice(10);
            const links = [
                row.links.use ? `<a href="${escapeHtml(row.links.use)}" target="_blank" rel="noopener noreferrer">Open product ↗</a>` : '',
                row.links.protocol ? `<a href="${escapeHtml(row.links.protocol)}" target="_blank" rel="noopener noreferrer">Protocol docs ↗</a>` : '',
                row.links.evidence ? `<a href="${escapeHtml(row.links.evidence)}" target="_blank" rel="noopener noreferrer">Evidence ↗</a>` : ''
            ].filter(Boolean).join('');
            return `<article class="defi-protocol-card" id="protocol-${escapeHtml(row.id)}" data-protocol-id="${escapeHtml(row.id)}">
            <header><div><span class="defi-protocol-status">${escapeHtml(row.status)}</span><h4>${escapeHtml(row.name)}</h4></div>
            <strong>${escapeHtml(fmtNumber(row.tokenCount))}<small> exact token${row.tokenCount === 1 ? '' : 's'}</small></strong></header>
            <p class="defi-protocol-actions">${escapeHtml(defiActionText(row.actions))}</p>
            ${metrics.length ? `<ul class="defi-protocol-metrics">${metrics.map((metric) => `<li>${escapeHtml(metric)}</li>`).join('')}</ul>` : ''}
            <div class="defi-protocol-assets">${visible.map(assetLink).join('')}
                ${hidden.length ? `<details><summary>+${hidden.length} more</summary><div>${hidden.map(assetLink).join('')}</div></details>` : ''}</div>
            ${links ? `<nav>${links}</nav>` : ''}
        </article>`;
        }).join('');
    }

    function composabilityTemplateForToken(db, token) {
        const issuer = token?.issuer;
        const recipe = token?.recipe?.label;
        return (Array.isArray(db?.templates) ? db.templates : [])
            .find((template) => template?.issuer === issuer && template?.recipe === recipe) ?? null;
    }

    function aggregateComposabilityTemplates(db, tokens) {
        const templates = [];
        const seen = new Set();
        for (const token of Array.isArray(tokens) ? tokens : []) {
            const template = composabilityTemplateForToken(db, token);
            if (!template) continue;
            const key = `${template.issuer ?? ''}\u0000${template.recipe ?? ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            templates.push(template);
        }
        if (templates.length === 0) return null;
        if (templates.length === 1) return templates[0];
        const statusRank = { unknown: 0, good: 1, caution: 2, warning: 3 };
        const scenarios = Object.fromEntries(COMPOSABILITY_SCENARIOS.map(({ id }) => {
            const values = templates.map((template) => template?.scenarios?.[id]).filter(Boolean);
            const outcomes = [...new Set(values.map((value) => value.outcome).filter(Boolean))];
            const headlines = [...new Set(values.map((value) => value.headline).filter(Boolean))];
            const explanations = [...new Set(values.map((value) => value.explanation).filter(Boolean))];
            return [id, {
                outcome: outcomes.length === 1 ? outcomes[0] : 'varies-by-token',
                headline: headlines.length === 1 ? headlines[0] : `Varies by token: ${headlines.join(' / ')}`,
                explanation: explanations.join(' ')
            }];
        }));
        return {
            issuer: templates[0].issuer,
            recipe: 'multiple token recipes',
            legalTemplate: 'multiple token templates',
            healthStatus: templates.slice().sort((a, b) =>
                (statusRank[b.healthStatus] ?? 0) - (statusRank[a.healthStatus] ?? 0))[0].healthStatus ?? 'unknown',
            summary: 'This issuer uses more than one technical template for this underlying; the outcomes below disclose every distinct result.',
            scenarios
        };
    }

    function lenderOutcomeModel(template, issuer, item) {
        const integrations = Array.isArray(item?.integrations) ? item.integrations : [];
        const collateral = integrations.filter((entry) => entry?.category === 'lending'
            && Array.isArray(entry.actions) && entry.actions.includes('collateral'));
        const dex = integrations.filter((entry) => entry?.category === 'dex');
        const names = (rows) => [...new Set(rows.map((entry) => entry.protocolName || entry.protocolId).filter(Boolean))];
        const scenario = (id) => template?.scenarios?.[id] ?? {
            outcome: 'unknown', headline: 'Not yet assessed', explanation: 'No reviewed technical and legal template is linked to this token.'
        };
        let cashExit;
        if (issuer?.redemption?.available === true && issuer?.redemption?.kyc === true) {
            cashExit = 'Conditional — issuer redemption exists, but requires KYC/AML and is not an autonomous smart-contract exit.';
        } else if (issuer?.redemption?.available === true) {
            cashExit = 'Recorded — eligible holders have an issuer redemption route, but its timing and eligibility remain contractual.';
        } else if (issuer?.redemption?.available === false) {
            cashExit = 'No holder redemption right is recorded; the lender depends on a secondary-market sale.';
        } else {
            cashExit = 'Unknown — no sufficiently established issuer redemption conclusion is recorded.';
        }
        const defaultOutcome = scenario('borrowerDefault').outcome;
        const hackOutcome = scenario('protocolHack').outcome;
        let exitRating = 'unknown';
        let exitLabel = 'Exit quality unknown';
        let exitReason = 'The legal/control template or an exit route has not been sufficiently established.';
        if (collateral.length === 0) {
            exitRating = 'unavailable';
            exitLabel = 'No source-listed collateral route';
            exitReason = 'No checked protocol source currently lists this exact token as programmatic collateral.';
        } else if (['issuer-mediated', 'weak-claim'].includes(defaultOutcome)) {
            exitRating = 'issuer-dependent';
            exitLabel = 'Issuer-dependent exit';
            exitReason = 'Code can hold the balance, but seizure or realisation still depends on issuer recognition, allowlisting, or a claim weaker than possession suggests.';
        } else if (defaultOutcome === 'onchain-enforceable' && dex.length > 0
            && !['issuer-can-freeze', 'issuer-may-recover'].includes(hackOutcome)) {
            exitRating = 'autonomous';
            exitLabel = 'Autonomous exit appears structurally available';
            exitReason = 'A source-listed lending market names the exact token, the reviewed template says seizure is onchain-enforceable, and an observed pool supplies a smart-contract sale route without a reviewed issuer override. Execution was not independently tested.';
        } else if (dex.length > 0) {
            exitRating = 'conditional';
            exitLabel = 'Conditional market exit';
            exitReason = 'A source-listed collateral market and observed on-chain pool indicate a possible route, but execution was not independently tested and issuer controls, transfer conditions, or thin liquidity may prevent full realisation.';
        } else if (issuer?.redemption?.available === true) {
            exitRating = 'issuer-dependent';
            exitLabel = 'Issuer-dependent exit';
            exitReason = issuer.redemption.kyc === true
                ? 'The remaining cash route is issuer redemption, which requires an eligible KYC/AML-approved holder.'
                : 'The remaining cash route is contractual issuer redemption rather than an autonomous smart-contract sale.';
        } else {
            exitRating = 'fragile';
            exitLabel = 'Fragile exit';
            exitReason = 'A checked protocol source lists the exact token as collateral, but no checked DEX sale route or holder redemption route is established.';
        }
        return {
            status: template?.healthStatus ?? 'unknown',
            custody: scenario('escrow'),
            default: scenario('borrowerDefault'),
            hack: scenario('protocolHack'),
            accessLoss: scenario('accessLoss'),
            cashExit,
            exitQuality: { rating: exitRating, label: exitLabel, reason: exitReason },
            confirmedLending: collateral.length
                ? `Source-listed for this exact token: ${names(collateral).join(', ')}. No successful borrow is independently evidenced.`
                : integrations.length
                    ? 'Trading or vault support is source-listed, but no checked protocol currently lists this exact token as programmatic collateral.'
                    : 'No checked protocol currently lists this exact token as programmatic collateral.',
            marketExit: dex.length
                ? `Observed exact-token pools: ${names(dex).join(', ')}. Pool presence does not guarantee enough liquidity for liquidation.`
                : 'No exact-token DEX pool is confirmed in the checked sources; an autonomous sale route is not established.'
        };
    }

    function controlExplicitlyOff(value) {
        if (value === false) return true;
        const clean = typeof value === 'string' ? value.trim().toLowerCase() : '';
        return clean === 'none' || clean === 'no';
    }

    /** Decision facts used by comparison filters and intent-aware search. Unknown never passes a filter. */
    function productDecisionProfile(issuer, token, integrations, template, nowMs = Date.now()) {
        const row = issuer ?? {};
        const control = row.control ?? {};
        const uses = Array.isArray(integrations) ? integrations : [];
        const outcome = lenderOutcomeModel(template, row, { integrations: uses });
        const checkedMs = isoToMillis(row.evidence?.lastCheckedAt);
        const eligibility = String(row.redemption?.eligibility ?? '').toLowerCase();
        const redemptionRails = String(row.redemption?.rails ?? '').toLowerCase();
        const cashRailStated = /\bcash\b|\busdc\b|\busdt\b|\bstablecoin\b|settlement currency/.test(redemptionRails);
        const cashRailExcluded = /does not trigger a cash payout|no cash payout|without (?:a )?cash payout/.test(redemptionRails);
        const rung = row.grades?.claimRung;
        return {
            cashRedemption: row.redemption?.available === true && cashRailStated && !cashRailExcluded,
            noDiscretionaryFreeze: controlExplicitlyOff(control.freezeAuthority)
                && controlExplicitlyOff(control.pausable) && controlExplicitlyOff(control.clawback),
            confirmedCollateral: uses.some((entry) => entry?.category === 'lending'
                && Array.isArray(entry.actions) && entry.actions.includes('collateral')),
            autonomousLiquidation: outcome.exitQuality.rating === 'autonomous',
            segregatedAssets: row.bankruptcyRemote === true || rung === 4,
            nonUsHolders: row.transferRestrictions?.usPersonsExcluded === true
                || /non[- ]?u\.?s\.?|outside (?:the )?u\.?s\.?|eligible investors globally/.test(eligibility),
            freshEvidence: checkedMs !== null && Number.isFinite(nowMs)
                && nowMs >= checkedMs && (nowMs - checkedMs) <= 45 * 86_400_000,
            tokenMint: token?.mint ?? null
        };
    }

    function defiCustodyHtml(template, item = null, issuer = null) {
        if (!template?.scenarios) return '';
        const model = lenderOutcomeModel(template, issuer, item);
        const rows = COMPOSABILITY_SCENARIOS.map(({ id, label }) => {
            const scenario = template.scenarios[id] ?? {};
            return `<div class="defi-custody-case" data-scenario="${id}"><strong>${escapeHtml(label)}</strong>` +
                `<span>${escapeHtml(scenario.headline ?? 'Unknown')}</span><p>${escapeHtml(scenario.explanation ?? '')}</p></div>`;
        }).join('');
        return `<div class="defi-custody"><h5>What protocol custody means for this token</h5>` +
            `<div class="exit-verdict exit-verdict-${escapeHtml(model.exitQuality.rating)}"><strong>${escapeHtml(model.exitQuality.label)}</strong><p>${escapeHtml(model.exitQuality.reason)}</p></div>` +
            `<p>${escapeHtml(template.summary ?? '')}</p><div class="lender-bottom-line">` +
            `<div><strong>Technical custody</strong><span>${escapeHtml(model.custody.headline)}</span></div>` +
            `<div><strong>Economic control after default</strong><span>${escapeHtml(model.default.headline)}</span></div>` +
            `<div><strong>Programmatic collateral listing</strong><span>${escapeHtml(model.confirmedLending)}</span></div>` +
            `<div><strong>Can seizure become cash?</strong><span>${escapeHtml(model.cashExit)}</span></div>` +
            `<div><strong>Autonomous market exit</strong><span>${escapeHtml(model.marketExit)}</span></div></div>` +
            `<div class="defi-custody-grid">${rows}</div></div>`;
    }

    /** Full evidence-bearing list for a token's detail dialog. */
    function defiUsageDetailHtml(item, fetchedAt = null, template = null, issuer = null) {
        const integrations = Array.isArray(item?.integrations) ? item.integrations : [];
        if (integrations.length === 0) {
            return '<section class="detail-section defi-usage-detail"><h4>Exact-token protocol support</h4>' +
                dataStateHtml('none-source-listed', 'No exact-token protocol support source-listed', 'The checked protocol registries, live pools and reviewed products contain no supported use for this token address. Private or unindexed contracts may still exist.', [
                    { label: 'Review DeFi coverage', href: './stocks.html?view=defi' }
                ]) +
                `${defiCustodyHtml(template, item, issuer)}</section>`;
        }
        const rows = integrations.map((entry, index) => {
            const useUrl = isSafeUrl(entry?.links?.use) ? entry.links.use : null;
            const evidence = (Array.isArray(entry.evidence) ? entry.evidence : [])
                .filter((row) => isSafeUrl(row?.url));
            const metrics = defiMetricText(entry);
            const marketNames = [...new Set((Array.isArray(entry.markets) ? entry.markets : [])
                .map((market) => market?.name).filter(Boolean))];
            const capabilities = (Array.isArray(entry.capabilities) ? entry.capabilities : []).map((capability) =>
                `<li><strong>${escapeHtml(capability.label || humanizeSlug(capability.action))}</strong>` +
                `<span>${escapeHtml(capability.custody || 'unknown')} custody · ${escapeHtml(capability.enforcement || 'unknown')} enforcement</span>` +
                `<small>${escapeHtml(capability.consequence || '')}</small></li>`).join('');
            const corroboration = entry.corroboration;
            const accounts = (Array.isArray(corroboration?.accounts) ? corroboration.accounts : [])
                .filter((account) => account?.address).slice(0, 4)
                .map((account) => `<a href="https://solscan.io/account/${escapeHtml(account.address)}" target="_blank" rel="noopener noreferrer">${escapeHtml(humanizeSlug(account.role))} ↗</a>`).join(' ');
            const proof = entry.proof || {};
            const proofModel = protocolProof.protocolProofModel({ integration: entry, proof, fetchedAt });
            const accountCheck = (proof.accountCount ?? corroboration?.accountCount) > 0
                ? `${proof.existingAccountCount ?? corroboration?.verifiedCount ?? 'unknown'}/${proof.accountCount ?? corroboration?.accountCount} published accounts existed; existence only`
                : 'No published Solana account address was available to check';
            const proofSteps = `${proofModel.detail} ${accountCheck}. ${proofModel.activityStatement}`;
            return `<article class="defi-use defi-use-${escapeHtml(entry.status || 'available')}">` +
                `<header><h5>${escapeHtml(entry.protocolName || entry.protocolId || 'Protocol')}</h5>` +
                `<span>Source reports: ${escapeHtml(entry.status || 'status not recorded')}</span></header>` +
                `<p class="defi-actions">${escapeHtml(defiActionText(entry.actions))}</p>` +
                `<p>${escapeHtml(proofModel.headline)}</p>` +
                `${metrics ? `<p class="defi-metrics">${escapeHtml(metrics)}</p>` : ''}` +
                `${marketNames.length ? `<p class="defi-metrics">Markets: ${escapeHtml(marketNames.join(', '))}</p>` : ''}` +
                `${capabilities ? `<ul class="defi-capabilities">${capabilities}</ul>` : ''}` +
                compositeRouteHtml(entry) +
                `<p class="defi-proof"><strong>What was actually checked:</strong> ${escapeHtml(proofSteps)}${accounts ? ` · ${accounts}` : ''}</p>` +
                `${entry.accessNote ? `<p class="defi-access"><strong>Access:</strong> ${escapeHtml(entry.accessNote)}</p>` : ''}` +
                `<p class="defi-links"><a href="./protocols/${encodeURIComponent(protocolDossierSlug(item, entry, index))}.html">Open RWA Sonar dossier →</a>${useUrl ? `<a href="${escapeHtml(useUrl)}" target="_blank" rel="noopener noreferrer">Open market / product ↗</a>` : ''}` +
                `${evidence.map((row, index) => `<a href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">Evidence${evidence.length > 1 ? ` ${index + 1}` : ''} ↗</a>`).join('')}</p>` +
                '</article>';
        }).join('');
        return `<section class="detail-section defi-usage-detail"><h4>Exact-token protocol support <span class="detail-count">${integrations.length}</span></h4>` +
            `<p class="detail-note">Observed for this exact token address${fetchedAt ? ` · checked ${escapeHtml(fmtRelativeTime(fetchedAt))}` : ''}. Structural compatibility is assessed separately.</p>` +
            `<div class="defi-use-grid">${rows}</div>${defiCustodyHtml(template, item, issuer)}</section>`;
    }


    const ROUTE_ROLE_LABELS = {
        'deposit-interface': 'Deposit', vault: 'Vault', bridge: 'Bridge', 'vault-manager': 'Vault manager', strategy: 'Strategy', collateral: 'Collateral',
        borrow: 'Borrow', yield: 'Yield', conversion: 'Back into the stock'
    };

    /**
     * A composite product (vault → strategy → lending market → …) as an ordered route: each leg names
     * the protocol, its program and the exact account, then what the holder actually holds, the live
     * leverage position when it was decoded, and the risks the route adds.
     */
    function compositeRouteHtml(entry) {
        if (!entry?.composite || !Array.isArray(entry.route) || entry.route.length === 0) return '';
        const account = (address) => typeof address !== 'string' ? ''
            : /^0x[0-9a-fA-F]{40}$/.test(address)
                ? `<a href="https://explorer.inkonchain.com/address/${escapeHtml(address)}" target="_blank" rel="noopener noreferrer"><code>${escapeHtml(`${address.slice(0, 6)}…${address.slice(-4)}`)}</code> ↗</a>`
                : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)
                    ? `<a href="https://solscan.io/account/${escapeHtml(address)}" target="_blank" rel="noopener noreferrer"><code>${escapeHtml(mintSuffix(address))}</code> ↗</a>` : '';
        const legs = entry.route.map((leg) => `<li><strong>${escapeHtml(ROUTE_ROLE_LABELS[leg.role] || humanizeSlug(leg.role))}</strong>` +
            `<span>${escapeHtml(leg.protocolName || leg.protocolId || '')}${leg.marketName ? ` · ${escapeHtml(leg.marketName)}` : ''}${leg.assetSymbol ? ` · ${escapeHtml(leg.assetSymbol)}` : ''}</span>` +
            `${account(leg.address)}${leg.detail ? `<small>${escapeHtml(leg.detail)}</small>` : ''}</li>`).join('');
        const holder = entry.holderReceives || {};
        const supply = holder.shareSupplyOnSolanaRaw;
        const holderText = [
            holder.shareSymbol ? `You receive ${holder.shareSymbol} vault shares${holder.shareChain && holder.shareChain !== 'solana' ? ` on ${holder.shareChain === 'ink' ? 'Ink' : holder.shareChain}` : ''}, not the stock token.` : (holder.instrument || ''),
            holder.legalNature || '',
            supply === '0' ? 'The Solana share mint had zero supply when read, so share balances are not held as Solana tokens.' : '',
            holder.fees || ''
        ].filter(Boolean).join(' ');
        const p = entry.position;
        const pctText = (value) => isNum(value) ? fmtPct(value * 100) : 'unknown';
        const position = p && isNum(p.loanToValue)
            ? `<p class="defi-route-position"><strong>Live strategy position:</strong> ${escapeHtml(pctText(p.loanToValue))} loan-to-value against a ${escapeHtml(pctText(p.liquidationLtv))} liquidation threshold` +
                `${isNum(p.priceDropToLiquidation) ? ` — a ${escapeHtml(pctText(p.priceDropToLiquidation))} fall in the stock price would make it liquidatable` : ''}` +
                `${isNum(p.depositedValueUsd) ? ` · ${escapeHtml(fmtMoney(p.depositedValueUsd))} collateral` : ''}${isNum(p.debtUsd) ? `, ${escapeHtml(fmtMoney(p.debtUsd))} ${escapeHtml(p.debtSymbol || 'debt')}` : ''}` +
                `${isNum(p.debtBorrowApy) && isNum(p.yieldVaultApy) ? ` · borrow ${escapeHtml(pctText(p.debtBorrowApy))} vs vault yield ${escapeHtml(pctText(p.yieldVaultApy))}` : ''}.` +
                ` <small>Decoded from the Kamino obligation at slot ${escapeHtml(String(p.observedSlot ?? 'unknown'))}; values as of its last refresh.</small></p>`
            : '';
        const risks = (Array.isArray(entry.risks) ? entry.risks : []).map((risk) =>
            `<li><strong>${escapeHtml(risk.title || humanizeSlug(risk.id))}</strong> ${escapeHtml(risk.detail || '')}</li>`).join('');
        return `<div class="defi-route"><p class="defi-route-label">Composite route — your token passes through ${entry.route.length} steps</p>` +
            `<ol class="defi-route-legs">${legs}</ol>` +
            `${holderText ? `<p class="defi-route-holder"><strong>What you hold:</strong> ${escapeHtml(holderText)}</p>` : ''}` +
            position +
            `${risks ? `<details class="defi-route-risks"><summary>Risks this route adds</summary><ul>${risks}</ul></details>` : ''}</div>`;
    }

    const NEW_CHANGE_LABELS = { added: 'Added', removed: 'Removed', candidate: 'Under review' };
    const DETECTED_LABELS = { registry: 'protocol registry', chain: 'on-chain holding' };

    /**
     * The "New in DeFi" strip: protocol additions and removals for exact tokens, newest first, with
     * DEX pool churn summarised rather than listed, and current review candidates marked as
     * unconfirmed. `feed` is stocks-defi-new.json.
     */
    function defiNewStripHtml(feed, { limit = 8 } = {}) {
        const items = Array.isArray(feed?.items) ? feed.items : [];
        const main = items.filter((row) => row.category !== 'dex' && row.change !== 'candidate');
        const dex = items.filter((row) => row.category === 'dex');
        // Non-DEX candidates first (a lending/vault/structured use is rarer and matters more), then by value.
        const candidates = (Array.isArray(feed?.candidates) ? feed.candidates : []).slice()
            .sort((a, b) => ((a.category === 'dex') - (b.category === 'dex')) || ((b.usd ?? 0) - (a.usd ?? 0)));
        if (main.length === 0 && dex.length === 0 && candidates.length === 0) {
            return dataStateHtml('none-source-listed', 'No protocol additions recorded yet',
                'Protocol support is compared day by day; the first stored day is a baseline, not a list of additions.', []);
        }
        const tokenLink = (row) => {
            const slug = row.cardSlug || cardSlug(row.symbol, row.mint);
            return `<a href="./cards/${encodeURIComponent(slug)}.html">${escapeHtml(row.symbol || mintSuffix(row.mint))}</a>`;
        };
        const rows = main.slice(0, limit).map((row) => `<li class="defi-new-${escapeHtml(row.change)}">` +
            `<span class="defi-new-badge">${escapeHtml(NEW_CHANGE_LABELS[row.change] || row.change)}</span>` +
            `<span class="defi-new-what">${tokenLink(row)} ${row.change === 'removed' ? 'left' : 'on'} <strong>${escapeHtml(row.protocolName || row.protocolId || 'protocol')}</strong>` +
            `${row.market?.name ? ` · ${escapeHtml(row.market.name)}` : ''}${row.category ? ` <small>${escapeHtml(humanizeSlug(row.category))}</small>` : ''}</span>` +
            `<small class="defi-new-meta">${escapeHtml(row.date)} · seen in ${escapeHtml((row.detectedBy || []).map((id) => DETECTED_LABELS[id] || id).join(' + '))}</small></li>`).join('');
        const dexAdded = dex.filter((row) => row.change === 'added').length;
        const dexRemoved = dex.filter((row) => row.change === 'removed').length;
        const dexLine = dex.length ? `<p class="defi-new-dex">DEX pools: ${fmtNumber(dexAdded)} exact-token pool listing${dexAdded === 1 ? '' : 's'} added, ${fmtNumber(dexRemoved)} removed over the same days (pool discovery churns; see each token's report).</p>` : '';
        const candidateRows = candidates.slice(0, 4).map((row) => `<li class="defi-new-candidate"><span class="defi-new-badge">Under review</span>` +
            `<span class="defi-new-what">${tokenLink(row)} held by <strong>${escapeHtml(row.protocolName || (row.programId ? `program ${mintSuffix(row.programId)}` : 'an unresolved program'))}</strong>` +
            `${row.market?.name ? ` · ${escapeHtml(row.market.name)}` : ''}${isNum(row.usd) ? ` <small>${escapeHtml(fmtMoney(row.usd))}</small>` : ''}</span>` +
            `<small class="defi-new-meta">${escapeHtml(row.reason === 'unlisted-integration' ? 'known protocol, use not yet in a collected registry' : 'program not yet attributed')} · unconfirmed</small></li>`).join('');
        const candidateLine = candidates.length > 4 ? `<p class="defi-new-dex">${fmtNumber(candidates.length)} on-chain holdings are under review in total (programs holding a tracked stock that no collected registry explains) — see the <a href="./review.html">evidence review queue</a>.</p>` : '';
        return `<ul class="defi-new-list">${rows}${candidateRows}</ul>${dexLine}${candidateLine}` +
            `<p class="defi-new-note">${escapeHtml(feed?.methodology || '')}</p>`;
    }

    const COMPOSABILITY_SCENARIOS = [
        { id: 'escrow', label: 'Smart-contract escrow' },
        { id: 'borrowerDefault', label: 'Borrower default' },
        { id: 'protocolHack', label: 'Protocol hacked' },
        { id: 'accessLoss', label: 'Access / key loss' }
    ];

    /** One reviewed tech + legal template, with the number of current mints that instantiate it. */
    function composabilityTemplateRows(db, tokens, issuers) {
        const profiles = Array.isArray(db?.templates) ? db.templates : [];
        const names = new Map((Array.isArray(issuers) ? issuers : [])
            .map((issuer) => [issuer?.slug, issuer?.name]).filter(([slug]) => typeof slug === 'string'));
        const counts = new Map();
        for (const token of Array.isArray(tokens) ? tokens : []) {
            const issuer = typeof token?.issuer === 'string' ? token.issuer : null;
            const recipe = typeof token?.recipe?.label === 'string' ? token.recipe.label : null;
            if (issuer === null || recipe === null) continue;
            const key = `${issuer}\u0000${recipe}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        return profiles.map((template) => ({
            ...template,
            issuerName: names.get(template.issuer) ?? humanizeSlug(template.issuer),
            mints: counts.get(`${template.issuer}\u0000${template.recipe}`) ?? 0
        })).filter((template) => template.mints > 0)
            .sort((a, b) => a.issuerName.localeCompare(b.issuerName) || a.recipe.localeCompare(b.recipe));
    }

    function composabilityScenarioHtml(scenario) {
        if (!scenario || typeof scenario !== 'object') return `<span class="comp-outcome">unknown</span>`;
        return `<span class="comp-outcome">${escapeHtml(scenario.outcome ?? 'unknown')}</span>`
            + `<span class="comp-scenario-headline">${escapeHtml(scenario.headline ?? '')}</span>`
            + `<details class="comp-explain"><summary>Why</summary><p>${escapeHtml(scenario.explanation ?? '')}</p></details>`;
    }

    function composabilityTemplatesHtml(db, tokens, issuers) {
        return composabilityTemplateRows(db, tokens, issuers).map((template) => {
            const status = ['good', 'caution', 'warning'].includes(template.healthStatus)
                ? template.healthStatus : 'unknown';
            const scenarios = COMPOSABILITY_SCENARIOS.map((scenario) =>
                `<td data-scenario="${scenario.id}" data-label="${escapeHtml(scenario.label)}">`
                + `${composabilityScenarioHtml(template.scenarios?.[scenario.id])}</td>`).join('');
            return `<tr><td><strong class="comp-template-name">${escapeHtml(template.issuerName)}</strong>`
                + `<span class="comp-template-legal">${escapeHtml(template.legalTemplate ?? '')}</span>`
                + `<code class="comp-template-recipe">${escapeHtml(template.recipe)}</code>`
                + `<span class="comp-template-summary">${escapeHtml(template.summary ?? '')}</span>`
                + `<a class="comp-template-link" href="templates/${encodeURIComponent(template.id)}.html">Full legal template →</a></td>`
                + `<td class="num">${escapeHtml(fmtNumber(template.mints))}</td>`
                + `<td><span class="comp-verdict comp-verdict-${status}">${status}</span></td>${scenarios}</tr>`;
        }).join('');
    }

    return {
        DEFI_ACTION_LABELS,
        DEFI_ACTION_ORDER,
        defiUsageIndex,
        defiActionText,
        protocolDossierSlug,
        redemptionUsabilitySummary,
        defiUsageCompactHtml,
        defiMetricText,
        DEFI_SOURCE_LABELS,
        defiSourceRows,
        defiProtocolRows,
        filterDefiProtocols,
        defiRangeText,
        defiProtocolDirectoryHtml,
        composabilityTemplateForToken,
        aggregateComposabilityTemplates,
        lenderOutcomeModel,
        controlExplicitlyOff,
        productDecisionProfile,
        defiCustodyHtml,
        defiUsageDetailHtml,
        compositeRouteHtml,
        defiNewStripHtml,
        COMPOSABILITY_SCENARIOS,
        composabilityTemplateRows,
        composabilityScenarioHtml,
        composabilityTemplatesHtml
    };
});
