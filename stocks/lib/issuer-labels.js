/*
 * What an issuer, its grades and its tokens are called and where they sit: the claim-depth x
 * ledger-maturity grid geometry and chip size, the rung/level/verification/coverage/severity
 * labels and ladder tooltips, short display names, the issuer sort order, card and dossier
 * links, the "New on Solana" chips and the issuer-section headline.
 *
 * Moved verbatim out of stocks.js (next-steps.md F11). Pure: no DOM, no fetch, no clock. UMD like the
 * other stocks/lib/*.js files: the browser loads it as a classic script before stocks.js and reads
 * window.__rwaIssuerLabels; jest requires it. Tested in stocks/issuer-labels.test.js.
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./fmt.js'), require('./sort-values.js'), require('./catalogue-counts.js'));
    else root.__rwaIssuerLabels = factory(root.__rwaFmt, root.__rwaSortValues, root.__rwaCatalogueCounts);
})(this, function (fmt, sortValues, catalogueCounts) {
    const { DASH, SLUG_SAFE, cardSlug, escapeHtml, fmtDateTime, fmtNumber, fmtRelativeTime, humanizeSlug, isNum } = fmt;
    const { compareValues } = sortValues;

    /** Claim-depth rungs (MODEL §3.2), used as axis labels when the data does not name one. */
    const CLAIM_LABELS = [
        'synthetic exposure',
        'unsecured claim on the issuer',
        'secured claim on collateral',
        'beneficial interest in the security',
        'registered share'
    ];

    /** Verification strength (MODEL §3.4). */
    const VERIFICATION_LABELS = [
        'none',
        'issuer statement',
        'auditor attestation',
        'daily verification agent',
        'on-chain proof of reserve',
        'transfer-agent register'
    ];

    /** Grid geometry: column 1 holds the maturity labels, row 6 holds the claim labels. */
    const GRID_STAGES = 5;
    const GRID_RUNGS = 5;
    const GRID_FIRST_DATA_COLUMN = 2;
    const GRID_LABEL_ROW = GRID_STAGES + 1;

    /** Chip dot diameter in px, scaled by log10 of DEX liquidity with a floor. */
    const CHIP_MIN_PX = 12;
    const CHIP_MAX_PX = 46;
    const CHIP_LOG_MIN = 3; // $1k and below all render at the floor
    const CHIP_LOG_MAX = 8; // $100m and above all render at the ceiling


    const SEVERITY_RANKS = { info: 0, caution: 1, warning: 2, critical: 3 };

    const COVERAGE_LABELS = { all: 'All', some: 'Some', none: 'None' };

    const KEY_GOVERNANCE_LABELS = {
        multisig: 'multisig',
        program: 'program',
        'hot-key': 'hot key',
        none: 'none',
        unknown: 'unknown'
    };

    /** The four authorities of MODEL.md §2.7, in the order the badge and the panel both read them. */
    const KEY_GOVERNANCE_ROLES = ['mint', 'freeze', 'delegate', 'rebase'];

    /** Dot diameter for an issuer chip: log10(liquidity), clamped, with a floor for null/0. */
    function chipSize(liquidityUsd) {
        if (!isNum(liquidityUsd) || liquidityUsd <= 0) return CHIP_MIN_PX;
        const t = (Math.log10(liquidityUsd) - CHIP_LOG_MIN) / (CHIP_LOG_MAX - CHIP_LOG_MIN);
        const clamped = Math.min(1, Math.max(0, t));
        return Math.round(CHIP_MIN_PX + clamped * (CHIP_MAX_PX - CHIP_MIN_PX));
    }

    /**
     * Where an issuer sits on the 5x5 grid: x = claim rung 0..4, y = maturity stage 4 (top) .. 0.
     * Returns null when either coordinate is unknown — those issuers belong in the legend, not a cell.
     */
    function gridCell(rung, stage) {
        if (!Number.isInteger(rung) || rung < 0 || rung >= GRID_RUNGS) return null;
        if (!Number.isInteger(stage) || stage < 0 || stage >= GRID_STAGES) return null;
        return {
            column: rung + GRID_FIRST_DATA_COLUMN,
            row: GRID_STAGES - stage
        };
    }

    /** The x-axis labels, preferring each rung's own claimLabel from the data. */
    function claimAxisLabels(issuers) {
        const labels = CLAIM_LABELS.slice();
        if (!Array.isArray(issuers)) return labels;
        for (const issuer of issuers) {
            const grades = issuer && issuer.grades;
            if (!grades) continue;
            const rung = grades.claimRung;
            const label = grades.claimLabel;
            if (Number.isInteger(rung) && rung >= 0 && rung < labels.length &&
                typeof label === 'string' && label.trim()) {
                labels[rung] = label.trim();
            }
        }
        return labels;
    }

    /** Canonical label for a claim rung, for cards and detail panels. */
    function claimLabel(rung, given) {
        if (typeof given === 'string' && given.trim()) return given.trim();
        if (Number.isInteger(rung) && rung >= 0 && rung < CLAIM_LABELS.length) return CLAIM_LABELS[rung];
        return DASH;
    }

    /** Canonical label for a 0–5 verification strength. */
    function verificationLabel(strength, given) {
        if (typeof given === 'string' && given.trim()) return given.trim();
        if (Number.isInteger(strength) && strength >= 0 && strength < VERIFICATION_LABELS.length) {
            return VERIFICATION_LABELS[strength];
        }
        return DASH;
    }

    /** "all" | "some" | "none" -> "All" | "Some" | "None"; anything else -> "—". */
    function coverageLabel(value) {
        const key = String(value === null || value === undefined ? '' : value).toLowerCase();
        return Object.prototype.hasOwnProperty.call(COVERAGE_LABELS, key) ? COVERAGE_LABELS[key] : DASH;
    }

    /** A CSS class per coverage bucket, so "all clawback" can look different from "none". */
    function coverageClass(value) {
        const key = String(value === null || value === undefined ? '' : value).toLowerCase();
        return Object.prototype.hasOwnProperty.call(COVERAGE_LABELS, key) ? `cov-${key}` : 'cov-unknown';
    }

    /**
     * Whether a per-token control is in force. Some flags are booleans (clawback, pausable) and some
     * carry the authority's address instead (freezeAuthority), which MODEL §3.3 reads as "non-null" —
     * so an address counts as on and a `=== true` test would silently miss every one of them.
     */
    function isControlOn(value) {
        if (value === true) return true;
        return typeof value === 'string' && value.trim() !== '';
    }

    /** Sorted distinct fee values -> "0 bps" / "0 / 25 bps" / "—". */
    function fmtFeeBps(list) {
        if (!Array.isArray(list)) return DASH;
        const nums = list.filter(isNum);
        if (!nums.length) return DASH;
        return nums.slice().sort((a, b) => a - b).join(' / ') + ' bps';
    }

    /** Current rate and retained fee-setting power are separate facts. Zero bps is not "no fee". */
    function transferFeeCapabilityLabel(control = {}) {
        const hasAuthority = [control.transferFeeConfigAuthority, control.transferFeeWithdrawAuthority]
            .some((value) => typeof value === 'string' && value.trim() !== '');
        const installed = control.transferFee === true || isNum(control.transferFeeBps) || hasAuthority;
        if (!installed) return null;
        return isNum(control.transferFeeBps)
            ? `${control.transferFeeBps} bps currently · fee-setting capability installed`
            : 'Fee-setting capability installed · current rate not established';
    }

    /** Higher is worse. -1 for an unrecognised severity. */
    function severityRank(severity) {
        const key = String(severity === null || severity === undefined ? '' : severity).toLowerCase();
        return Object.prototype.hasOwnProperty.call(SEVERITY_RANKS, key) ? SEVERITY_RANKS[key] : -1;
    }

    function severityClass(severity) {
        const key = String(severity === null || severity === undefined ? '' : severity).toLowerCase();
        return Object.prototype.hasOwnProperty.call(SEVERITY_RANKS, key) ? `sev-${key}` : 'sev-unknown';
    }

    /** The worst severity in a findings list, or null when there is nothing to rank. */
    function worstSeverity(findings) {
        if (!Array.isArray(findings) || !findings.length) return null;
        let worst = null;
        let worstRank = -1;
        for (const finding of findings) {
            const rank = severityRank(finding && finding.severity);
            if (rank > worstRank) {
                worstRank = rank;
                worst = finding && finding.severity ? String(finding.severity).toLowerCase() : null;
            }
        }
        return worst;
    }

    /** Indexes a *-types.json array by its schema slug. */
    function indexTypes(list) {
        const index = Object.create(null);
        if (!Array.isArray(list)) return index;
        for (const type of list) {
            if (type && typeof type.schema === 'string' && type.schema) index[type.schema] = type;
        }
        return index;
    }

    /** The type's own name when the types file knows the slug, else the humanized slug. */
    function labelForSchema(slug, typeIndex) {
        const def = typeIndex && typeIndex[slug];
        if (def && typeof def.name === 'string' && def.name.trim()) return def.name.trim();
        return humanizeSlug(slug);
    }

    /**
     * A name short enough to label a grid chip or head a card. Issuer names in stocks-issuers.json are
     * sometimes a whole clause ("Bullish (NYSE: BLSH) — the securities issuer is the listed company
     * itself, a Cayman Islands company (SEC CIK ...)"), which would break any layout, so the trailing
     * dash clause and then an overlong parenthetical are dropped. The full name always stays in the
     * title attribute, so nothing is hidden.
     */
    function displayName(name, maxLength) {
        if (typeof name !== 'string' || !name.trim()) return DASH;
        const limit = isNum(maxLength) ? maxLength : 44;
        // A clause after a dash is never part of the name, so it always goes.
        let short = name.trim().split(/\s+[—–-]\s+/)[0].trim();
        // The rest only apply while the name is still too long, so a short name is never mangled.
        if (short.length > limit) short = short.replace(/\s*\(.*\)\s*$/, '').trim() || short;
        if (short.length > limit) {
            const sentence = short.match(/^.*?[.!?](?=\s|$)/);
            if (sentence) short = sentence[0].trim();
        }
        if (short.length > limit) short = short.slice(0, limit - 1).trimEnd() + '…';
        return short || DASH;
    }

    /** Live issuers first (ordered by DEX liquidity), everything else after, by name. */
    function sortIssuersForDisplay(issuers) {
        if (!Array.isArray(issuers)) return [];
        return issuers.slice().sort((a, b) => {
            const aLive = (a && a.status) === 'live';
            const bLive = (b && b.status) === 'live';
            if (aLive !== bLive) return aLive ? -1 : 1;
            const aLiq = a && a.market ? a.market.dexLiquidityUsd : null;
            const bLiq = b && b.market ? b.market.dexLiquidityUsd : null;
            const byLiquidity = compareValues(aLiq, bLiq, false);
            if (byLiquidity !== 0) return byLiquidity;
            return String((a && a.name) || '').localeCompare(String((b && b.name) || ''));
        });
    }

    // ---------------------------------------------------------------------------
    // Ladder wording (vocabulary.md, MODEL §2.2 and §3.1/§3.2) — the grid's axis tooltips. The grid
    // shows "Level 2" and "2 secured claim on collateral" and nothing else fits in a cell, so the
    // definition itself lives in the title/aria-label of the label, next to the axis captions that
    // already explain the two axes in prose.
    // ---------------------------------------------------------------------------

    /** Ledger maturity, indexed by stage 0–4 (MODEL §3.1, vocabulary.md "Maturity Stage"). */
    const MATURITY_LEVEL_TOOLTIPS = [
        'Level 0: none of the four pillars. The blockchain is not the main ledger of ownership, so the ' +
        'authoritative record is somewhere else (a share register, a transfer agent, a broker’s books).',
        'Level 1: the blockchain is the main ledger of ownership (blockchainIsMainLedger). There is no ' +
        'other authoritative record of who owns the asset.',
        'Level 2, Tokenized: Level 1 plus unconditional transfers (unconditionalTransfers). The token ' +
        'moves to any address without approval from the issuer, a platform or a regulator.',
        'Level 3, Issuer independent: Level 2 plus bearer redemption (bearerRedemption). Presenting the ' +
        'token is enough to redeem the underlying from the custodian, so the issuer is not a required party.',
        'Level 4, Legally integrated: Level 3 plus a forced-transfer mechanism (forcedTransfers). Tokens ' +
        'can be moved without the holder’s consent, so a court order, a theft or a lost key can be ' +
        'corrected on the ledger.'
    ];

    /** Claim depth, indexed by rung 0–4 (MODEL §3.2). */
    const CLAIM_RUNG_TOOLTIPS = [
        'Rung 0, synthetic exposure: the holder has price exposure only (a derivative or a synthetic SPV ' +
        'position), with no claim on the security.',
        'Rung 1, unsecured claim on the issuer: a structured note, tracker certificate or debt note with ' +
        'no security interest. If the issuer fails, the holder is an unsecured creditor.',
        'Rung 2, secured claim on collateral: the same note, but a security interest over the collateral ' +
        'exists and is granted to a named security holder.',
        'Rung 3, beneficial interest in the security: an SPV holds the share and the token is a claim on ' +
        'that share, redeemable against it.',
        'Rung 4, registered share: the holder is the registered owner of the share itself, the same class ' +
        'as the listed security.'
    ];

    /** The definition of each market word, for the headers that cannot spell it out (MODEL §11.1). */
    const MARKET_TOOLTIPS = {
        liquidity: 'Liquidity: the USD value of the reserves in this token’s DEX pools (Jupiter’s ' +
            'aggregate over Raydium, Orca and Meteora). This is pool depth; trade counts are a ' +
            'separate column. A CEX venue never reports it.',
        trades24: 'Trades 24h: number of buys plus sells in the last 24 hours (Jupiter). Empty (null, not zero) ' +
            'when the source does not report it.',
        traders24: 'Traders 24h: distinct trading wallets in the last 24 hours (Jupiter). Summed across a ' +
            'programme’s token addresses, so one wallet trading two tokens counts twice.',
        tradesPerTrader: 'Trades per trader: trades 24h / traders 24h. A high value suggests wash trading, with a few ' +
            'wallets producing thousands of trades.',
        organic: 'Organic share: the part of 24h volume Jupiter classifies as non-bot flow, over total ' +
            '24h volume.',
        venues: 'Venues: distinct DEX ids (DexScreener) plus exchange markets (CoinGecko) where the token ' +
            'has a pair.',
        lastTrade: 'Last trade: the most recent per-venue timestamp across CoinGecko tickers. No on-chain ' +
            'per-trade history is collected, so a DEX-only token has none.',
        venueSpread: 'Venue spread: the gap between the lowest and highest price for the same token across ' +
            'venues that traded in the last two hours with enough depth (DEX pools ≥ $10k liquidity, ' +
            'exchange markets ≥ $5k 24h volume); a persistent gap is an arbitrage opportunity, a ' +
            'one-off gap is usually a stale quote.'
    };

    /** The definition of a ledger-maturity level, or "" when the stage is not one of 0–4. */
    function maturityLevelTooltip(stage) {
        if (!Number.isInteger(stage) || stage < 0 || stage >= MATURITY_LEVEL_TOOLTIPS.length) return '';
        return MATURITY_LEVEL_TOOLTIPS[stage];
    }

    /** The definition of a claim-depth rung, or "" when the rung is not one of 0–4. */
    function claimRungTooltip(rung) {
        if (!Number.isInteger(rung) || rung < 0 || rung >= CLAIM_RUNG_TOOLTIPS.length) return '';
        return CLAIM_RUNG_TOOLTIPS[rung];
    }

    /**
     * The "Card ↗" link for one token: the shareable page stocks/build-cards.mjs generates. The slug is
     * supplied by the build/API when symbols collide case-insensitively, with the ordinary cardSlug
     * rule as a fallback for old or sample data.
     */
    function cardLinkHtml(token) {
        const slug = (token && token.cardSlug) || cardSlug(token && token.symbol, token && token.mint);
        if (!slug) return '';
        const label = (token && (token.symbol || token.mint)) || 'this token';
        return `<a class="card-link" href="cards/${encodeURIComponent(slug)}.html" ` +
            `title="Shareable card for ${escapeHtml(label)}">Card &#8599;</a>`;
    }

    /** Stable issuer dossier URL; unlike a modal state this can be indexed, shared and revisited. */
    function issuerDossierHref(slug, prefix = './') {
        if (typeof slug !== 'string' || !SLUG_SAFE.test(slug)) return null;
        return `${prefix}issuers/${encodeURIComponent(slug)}.html`;
    }

    /** Where the per-token cards live, relative to this page. */
    const CARDS_DIR = './cards/';

    /** How long the "New on Solana" strip looks back when the feed does not say. */
    const NEW_MINTS_WINDOW_DAYS = 14;

    /**
     * The chips of the "New on Solana" strip, from stocks-changes.json's `newMints` feed: one row per
     * mint the universe crawl first saw inside the feed's window, already in the order it was selected
     * (newest first). `firstSeen` is a RELATIVE age against `nowMs`, which the caller passes so this
     * stays pure and the same feed always shapes the same way.
     *
     * A mint with no `firstSeenAt` keeps a null age rather than being dated now, and a mint with no
     * `cardSlug` gets a null href and renders as plain text — a chip never links to a card that the
     * build did not write. An absent file, an absent `newMints` or a row without a symbol and a mint
     * simply yields nothing: an empty strip is hidden, not an error.
     */
    function newMintChips(changes, nowMs) {
        const feed = changes && Array.isArray(changes.newMints) ? changes.newMints : [];
        const chips = [];
        for (const row of feed) {
            if (!row || typeof row !== 'object') continue;
            const mint = typeof row.mint === 'string' && row.mint.trim() ? row.mint.trim() : null;
            const symbol = typeof row.symbol === 'string' && row.symbol.trim() ? row.symbol.trim() : mint;
            if (!symbol) continue;
            const slug = typeof row.cardSlug === 'string' && row.cardSlug.trim() ? row.cardSlug.trim() : null;
            const firstSeenAt = typeof row.firstSeenAt === 'string' && row.firstSeenAt.trim() ? row.firstSeenAt.trim() : null;
            const issuerName = typeof row.issuerName === 'string' && row.issuerName.trim() ? row.issuerName.trim() : null;
            const issuer = typeof row.issuer === 'string' && row.issuer.trim() ? row.issuer.trim() : null;
            const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : null;
            chips.push({
                mint,
                symbol,
                issuer: issuerName || (issuer === null ? null : humanizeSlug(issuer)),
                firstSeenAt,
                firstSeen: firstSeenAt === null ? null : fmtRelativeTime(firstSeenAt, nowMs),
                href: slug === null ? null : `${CARDS_DIR}${encodeURIComponent(slug)}.html`,
                title: `${name === null ? symbol : `${symbol} — ${name}`}${firstSeenAt === null ? '' : ` · first seen ${fmtDateTime(firstSeenAt)}`}`
            });
        }
        return chips;
    }

    /**
     * The issuer-section headline, derived from the issuer file rather than typed: the programme total,
     * why some have no live token (defunct, no mint yet), and the largest programme's token count.
     */
    function issuerHeadline(issuers, tokens) {
        const summary = catalogueCounts.issuerProgrammeSummary(issuers, tokens);
        return {
            count: String(summary.total),
            qualifier: summary.total > summary.withTokens ? catalogueCounts.programmeQualifier(summary) : '',
            largest: summary.largest === null ? ''
                : ` (the largest, ${summary.largest.name}, has ${fmtNumber(summary.largest.tokens)})`
        };
    }

    /** How many days the feed looked back, as the strip's note should say it. */
    function newMintsWindowDays(changes) {
        const days = changes && changes.newMintWindowDays;
        return isNum(days) && days > 0 ? days : NEW_MINTS_WINDOW_DAYS;
    }

    /** One chip: a link when the card exists, plain text when it does not. */
    function newMintChipHtml(chip) {
        const parts = [`<span class="new-mint-symbol">${escapeHtml(chip.symbol)}</span>`];
        if (chip.issuer !== null) parts.push(`<span class="new-mint-issuer">${escapeHtml(chip.issuer)}</span>`);
        if (chip.firstSeen !== null) parts.push(`<span class="new-mint-age">first seen ${escapeHtml(chip.firstSeen)}</span>`);
        const inner = parts.join('<span aria-hidden="true">·</span>');
        const title = ` title="${escapeHtml(chip.title)}"`;
        if (chip.href === null) return `<li class="new-mint-chip"><span${title}>${inner}</span></li>`;
        return `<li class="new-mint-chip"><a href="${escapeHtml(chip.href)}"${title}>${inner}</a></li>`;
    }

    return {
        CLAIM_LABELS,
        VERIFICATION_LABELS,
        GRID_STAGES,
        GRID_RUNGS,
        GRID_FIRST_DATA_COLUMN,
        GRID_LABEL_ROW,
        CHIP_MIN_PX,
        CHIP_MAX_PX,
        CHIP_LOG_MIN,
        CHIP_LOG_MAX,
        SEVERITY_RANKS,
        COVERAGE_LABELS,
        KEY_GOVERNANCE_LABELS,
        KEY_GOVERNANCE_ROLES,
        chipSize,
        gridCell,
        claimAxisLabels,
        claimLabel,
        verificationLabel,
        coverageLabel,
        coverageClass,
        isControlOn,
        fmtFeeBps,
        transferFeeCapabilityLabel,
        severityRank,
        severityClass,
        worstSeverity,
        indexTypes,
        labelForSchema,
        displayName,
        sortIssuersForDisplay,
        MATURITY_LEVEL_TOOLTIPS,
        CLAIM_RUNG_TOOLTIPS,
        MARKET_TOOLTIPS,
        maturityLevelTooltip,
        claimRungTooltip,
        cardLinkHtml,
        issuerDossierHref,
        CARDS_DIR,
        NEW_MINTS_WINDOW_DAYS,
        newMintChips,
        issuerHeadline,
        newMintsWindowDays,
        newMintChipHtml
    };
});
