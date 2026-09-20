/**
 * Renders the "Tokenized stocks on Solana" page from the two built files (stocks/MODEL.md §10.1):
 * stocks-issuers.json feeds the claim-depth x ledger-maturity grid, the issuer cards and their
 * detail dialogs, and stocks-tokens.json feeds the token table with its filters and sorting. The
 * issuer file is fetched and rendered first, because the grid and the cards are the top of the
 * page and need nothing from the larger token file. The pure formatters at the top carry no DOM
 * and are exported for jest; the rendering below runs only in a browser.
 */

// ---------------------------------------------------------------------------
// Pure helpers — no DOM, no fetch. Everything below the CommonJS tail is the page.
// ---------------------------------------------------------------------------

/**
 * The display formatters live in stocks/lib/fmt.js, because the server-rendered stock cards
 * (stocks/build-cards.mjs) must spell a price, a premium and a missing value exactly as this table
 * does. The browser gets them from the classic script loaded before this one; jest gets them by
 * require. Either way there is one copy, and the names below are re-exported unchanged.
 */
const fmt = (typeof __rwaFmt !== 'undefined') ? __rwaFmt : require('./stocks/lib/fmt.js');
const discovery = (typeof __rwaDiscovery !== 'undefined') ? __rwaDiscovery : require('./stocks/lib/discovery.js');

const {
    DASH,
    isNum,
    escapeHtml,
    isSafeUrl,
    fmtNumber,
    fmtMoney,
    fmtPrice,
    fmtPct,
    fmtSignedPct,
    fmtDateTime,
    fmtDate,
    fetchedAtOf,
    isoToMillis,
    humanizeDuration,
    fmtRelativeTime,
    fmtAgeSeconds,
    fmtTradesPerTrader,
    fmtCountOfTotal,
    fmtVenueSpreadPct,
    fmtVenueSpread,
    humanizeSlug,
    cardSlug,
    mintSuffix,
    SLUG_SAFE
} = fmt;

const {
    laypersonVerdict,
    legalReviewStatus,
    tokenSearchText,
    parseStockSearch,
    globalSearch,
    sameUnderlyingGroups,
    collectorHealth
} = discovery;

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

/**
 * Funnel graphic geometry (stocks-funnel.json → funnelLayout). Circle AREA is proportional to the
 * mint count, so r follows sqrt, with a floor that keeps a one-mint programme visible; the column
 * weights are shares of the drawing width, widest where the labels are longest (the recipes).
 */
const FUNNEL_WIDTH = 1100;
const FUNNEL_MIN_R = 5;
const FUNNEL_MAX_R = 30;
const FUNNEL_ROW_PX = 50;
const FUNNEL_TOP_PAD = 36;
const FUNNEL_BOTTOM_PAD = 12;
const FUNNEL_MIN_HEIGHT = 340;
const FUNNEL_EDGE_MIN_PX = 1;
const FUNNEL_EDGE_MAX_PX = 9;
const FUNNEL_COLUMN_WEIGHTS = [0.2, 0.26, 0.32, 0.22];
const FUNNEL_COLUMN_GAP = 16;
const FUNNEL_LABEL_GAP = 8;
/** Rough width of one character at the label font size, for deciding where to truncate. */
const FUNNEL_LABEL_CHAR_PX = 6.2;

/** Counts under ten read as words in the section heading: "to one token program". */
const SMALL_NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

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

/** Treats null, "", undefined and non-finite numbers alike: they sort last, both directions. */
function isMissing(value) {
    if (value === null || value === undefined || value === '') return true;
    return typeof value === 'number' && !Number.isFinite(value);
}

/** Compares two cell values, missing ones always last whatever the direction. */
function compareValues(a, b, ascending) {
    const aMissing = isMissing(a);
    const bMissing = isMissing(b);
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    if (isNum(a) && isNum(b)) return ascending ? a - b : b - a;
    const cmp = String(a).toLowerCase().localeCompare(String(b).toLowerCase());
    return ascending ? cmp : -cmp;
}

/** Builds an Array#sort comparator from a value getter. */
function makeComparator(getValue, ascending) {
    return (a, b) => compareValues(getValue(a), getValue(b), ascending);
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

/** Case-insensitive match of a query against token identity, underlying, issuer slug and mint. */
function tokenMatchesQuery(token, query) {
    const q = String(query === null || query === undefined ? '' : query).trim().toLowerCase();
    if (!q) return true;
    if (!token) return false;
    return tokenSearchText(token, null).includes(q);
}

/** Applies the issuer / instrument / search controls to the token list. */
function filterTokens(tokens, filters) {
    if (!Array.isArray(tokens)) return [];
    const f = filters || {};
    return tokens.filter((token) => {
        if (f.issuer && token.issuer !== f.issuer) return false;
        if (f.instrumentType && token.instrumentType !== f.instrumentType) return false;
        return tokenMatchesQuery(token, f.query);
    });
}

const TOKEN_PAGE_SIZE = 50;
const TOKEN_API_SORTS = {
    price: 'usd_price',
    premium: 'premium_pct',
    liquidity: 'liquidity_usd',
    vol24: 'volume24_usd',
    trades24: 'trades24',
    traders24: 'traders24',
    spread: 'venue_spread_pct',
    holders: 'holder_count',
    lastTrade: 'last_traded_at'
};

function tokenPageMath(total, page, perPage = TOKEN_PAGE_SIZE) {
    const count = isNum(total) && total > 0 ? Math.floor(total) : 0;
    const size = isNum(perPage) && perPage > 0 ? Math.floor(perPage) : TOKEN_PAGE_SIZE;
    const pages = Math.max(1, Math.ceil(count / size));
    const current = Math.min(Math.max(isNum(page) ? Math.floor(page) : 1, 1), pages);
    const from = count === 0 ? null : (current - 1) * size + 1;
    const to = count === 0 ? null : Math.min(current * size, count);
    return {
        page: current,
        pages,
        offset: (current - 1) * size,
        from,
        to,
        total: count,
        hasPrev: current > 1,
        hasNext: current < pages
    };
}

function tokenApiParams(filters, sort, page) {
    const paging = tokenPageMath(Number.MAX_SAFE_INTEGER, page);
    return {
        issuer: filters?.issuer || null,
        instrument: filters?.instrumentType || null,
        q: filters?.query?.trim() || null,
        sort: TOKEN_API_SORTS[sort?.key] ?? 'liquidity_usd',
        order: sort?.ascending ? 'asc' : 'desc',
        limit: TOKEN_PAGE_SIZE,
        offset: paging.offset
    };
}

/** Adapt the API's typed, snake_case list row to the existing table renderer's token shape. */
function tokenFromApiRow(row) {
    const r = row ?? {};
    return {
        mint: r.mint ?? null,
        symbol: r.symbol ?? null,
        name: r.name ?? null,
        issuer: r.issuer_slug ?? null,
        underlyingTicker: r.underlying_ticker ?? null,
        instrumentType: r.instrument_type ?? null,
        market: {
            usdPrice: r.usd_price ?? null,
            liquidity: r.liquidity_usd ?? null,
            vol24: r.volume24_usd ?? null,
            organicSharePct: r.organic_share_pct ?? null,
            holderCount: r.holder_count ?? null,
            top10HolderPct: r.top10_holder_pct ?? null
        },
        reference: {
            source: r.reference_source ?? null,
            price: r.reference_price ?? null,
            premiumPct: r.premium_pct ?? null
        },
        activity: {
            trades24: r.trades24 ?? null,
            traders24: r.traders24 ?? null,
            venueSpreadPct: r.venue_spread_pct ?? null,
            lastTradedAt: r.last_traded_at ?? null
        },
        control: {
            clawback: r.clawback ?? null,
            freezeAuthority: r.freeze_authority ?? null,
            pausable: r.pausable ?? null,
            paused: r.paused ?? null,
            allowlist: r.allowlist ?? null,
            transferFeeBps: r.transfer_fee_bps ?? null,
            hookActive: r.hook_active ?? null
        }
    };
}

const DEFI_ACTION_LABELS = {
    swap: 'swap',
    'provide-liquidity': 'provide liquidity',
    collateral: 'use as collateral',
    borrow: 'borrow against',
    lend: 'supply / lend',
    deposit: 'deposit in vault',
    'earn-yield': 'earn yield'
};

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

/** Compact per-asset list for the paginated mint table. */
function defiUsageCompactHtml(item) {
    const integrations = Array.isArray(item?.integrations) ? item.integrations : [];
    if (integrations.length === 0) {
        return '<span class="defi-none" title="No exact-mint integration was confirmed in the sources checked">None confirmed</span>';
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
    if (isNum(metrics.sizeUsd)) parts.push(`${fmtMoney(metrics.sizeUsd)} market size`);
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
    return parts.join(' · ');
}

const DEFI_SOURCE_LABELS = {
    kamino: ['Kamino', 'direct lending registry'],
    jupiterLend: ['Jupiter Lend', 'direct lending registry'],
    nest: ['Nest', 'versioned deployment manifest'],
    project0: ['Project 0', 'live collateral-bank registry'],
    save: ['Save', 'official lending reserve registry'],
    dexPools: ['DEX pools', 'exact-mint market discovery'],
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
        exitLabel = 'No confirmed collateral route';
        exitReason = 'No checked protocol currently accepts this exact token as programmatic collateral.';
    } else if (['issuer-mediated', 'weak-claim'].includes(defaultOutcome)) {
        exitRating = 'issuer-dependent';
        exitLabel = 'Issuer-dependent exit';
        exitReason = 'Code can hold the balance, but seizure or realisation still depends on issuer recognition, allowlisting, or a claim weaker than possession suggests.';
    } else if (defaultOutcome === 'onchain-enforceable' && dex.length > 0
        && !['issuer-can-freeze', 'issuer-may-recover'].includes(hackOutcome)) {
        exitRating = 'autonomous';
        exitLabel = 'Autonomous exit established';
        exitReason = 'A checked lending market can seize the token and a checked pool offers a smart-contract sale route without a reviewed issuer override.';
    } else if (dex.length > 0) {
        exitRating = 'conditional';
        exitLabel = 'Conditional market exit';
        exitReason = 'The lender can use a checked on-chain sale route, but issuer controls, transfer conditions, or thin liquidity may prevent full realisation.';
    } else if (issuer?.redemption?.available === true) {
        exitRating = 'issuer-dependent';
        exitLabel = 'Issuer-dependent exit';
        exitReason = issuer.redemption.kyc === true
            ? 'The remaining cash route is issuer redemption, which requires an eligible KYC/AML-approved holder.'
            : 'The remaining cash route is contractual issuer redemption rather than an autonomous smart-contract sale.';
    } else {
        exitRating = 'fragile';
        exitLabel = 'Fragile exit';
        exitReason = 'A checked protocol can take collateral, but no checked DEX sale route or holder redemption route is established.';
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
            ? `Confirmed for this exact token: ${names(collateral).join(', ')}.`
            : integrations.length
                ? 'Trading or vault use is confirmed, but no checked protocol currently lists this exact token as programmatic collateral.'
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
        `<div><strong>Programmatic collateral today</strong><span>${escapeHtml(model.confirmedLending)}</span></div>` +
        `<div><strong>Can seizure become cash?</strong><span>${escapeHtml(model.cashExit)}</span></div>` +
        `<div><strong>Autonomous market exit</strong><span>${escapeHtml(model.marketExit)}</span></div></div>` +
        `<div class="defi-custody-grid">${rows}</div></div>`;
}

/** Full evidence-bearing list for a mint's detail dialog. */
function defiUsageDetailHtml(item, fetchedAt = null, template = null, issuer = null) {
    const integrations = Array.isArray(item?.integrations) ? item.integrations : [];
    if (integrations.length === 0) {
        return '<section class="detail-section defi-usage-detail"><h4>Confirmed DeFi use</h4>' +
            '<p class="detail-empty"><strong>None confirmed.</strong> This means no exact-mint integration was found in the protocol registries, live pools and reviewed products checked; it does not prove that private or unindexed contracts do not use the token.</p>' +
            `${defiCustodyHtml(template, item, issuer)}</section>`;
    }
    const rows = integrations.map((entry) => {
        const useUrl = isSafeUrl(entry?.links?.use) ? entry.links.use : null;
        const evidence = (Array.isArray(entry.evidence) ? entry.evidence : [])
            .filter((row) => isSafeUrl(row?.url));
        const metrics = defiMetricText(entry);
        const marketNames = (Array.isArray(entry.markets) ? entry.markets : [])
            .map((market) => market?.name).filter(Boolean);
        const capabilities = (Array.isArray(entry.capabilities) ? entry.capabilities : []).map((capability) =>
            `<li><strong>${escapeHtml(capability.label || humanizeSlug(capability.action))}</strong>` +
            `<span>${escapeHtml(capability.custody || 'unknown')} custody · ${escapeHtml(capability.enforcement || 'unknown')} enforcement</span>` +
            `<small>${escapeHtml(capability.consequence || '')}</small></li>`).join('');
        const corroboration = entry.corroboration;
        const accounts = (Array.isArray(corroboration?.accounts) ? corroboration.accounts : [])
            .filter((account) => account?.address).slice(0, 4)
            .map((account) => `<a href="https://solscan.io/account/${escapeHtml(account.address)}" target="_blank" rel="noopener noreferrer">${escapeHtml(humanizeSlug(account.role))} ↗</a>`).join(' ');
        const evidenceStrength = corroboration?.accountCount > 0
            ? `${corroboration.verifiedCount}/${corroboration.accountCount} published Solana accounts existed when checked`
            : 'The source did not expose a Solana account address that this watcher can corroborate';
        return `<article class="defi-use defi-use-${escapeHtml(entry.status || 'available')}">` +
            `<header><h5>${escapeHtml(entry.protocolName || entry.protocolId || 'Protocol')}</h5>` +
            `<span>${escapeHtml(entry.status || 'available')}</span></header>` +
            `<p class="defi-actions">${escapeHtml(defiActionText(entry.actions))}</p>` +
            `<p>${escapeHtml(entry.summary || '')}</p>` +
            `${metrics ? `<p class="defi-metrics">${escapeHtml(metrics)}</p>` : ''}` +
            `${marketNames.length ? `<p class="defi-metrics">Markets: ${escapeHtml(marketNames.join(', '))}</p>` : ''}` +
            `${capabilities ? `<ul class="defi-capabilities">${capabilities}</ul>` : ''}` +
            `<p class="defi-proof"><strong>Evidence strength:</strong> ${escapeHtml(humanizeSlug(entry.evidenceTier || 'unknown'))}. ${escapeHtml(evidenceStrength)}${accounts ? ` · ${accounts}` : ''}</p>` +
            `${entry.accessNote ? `<p class="defi-access"><strong>Access:</strong> ${escapeHtml(entry.accessNote)}</p>` : ''}` +
            `<p class="defi-links">${useUrl ? `<a href="${escapeHtml(useUrl)}" target="_blank" rel="noopener noreferrer">Open market / product ↗</a>` : ''}` +
            `${evidence.map((row, index) => `<a href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">Evidence${evidence.length > 1 ? ` ${index + 1}` : ''} ↗</a>`).join('')}</p>` +
            '</article>';
    }).join('');
    return `<section class="detail-section defi-usage-detail"><h4>Confirmed DeFi use <span class="detail-count">${integrations.length}</span></h4>` +
        `<p class="detail-note">Observed for this exact mint${fetchedAt ? ` · checked ${escapeHtml(fmtRelativeTime(fetchedAt))}` : ''}. Structural compatibility is assessed separately.</p>` +
        `<div class="defi-use-grid">${rows}</div>${defiCustodyHtml(template, item, issuer)}</section>`;
}

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
        const liquidityUsd = tokens.reduce((sum, token) => sum + (isNum(token?.market?.liquidity) ? token.market.liquidity : 0), 0);
        const volume24Usd = tokens.reduce((sum, token) => sum + (isNum(token?.market?.vol24) ? token.market.vol24 : 0), 0);
        const protocols = [...new Set(integrations.map((entry) => entry.protocolName || entry.protocolId).filter(Boolean))].sort();
        const decision = productDecisionProfile(issuer, tokens[0], integrations, template, nowMs);
        return {
            issuerSlug: row.issuer,
            issuerName: issuer.name ?? humanizeSlug(row.issuer),
            tokens,
            verdict,
            review,
            outcome,
            protocols,
            decision,
            liquidityUsd,
            volume24Usd
        };
    });
}

function sameStockComparisonHtml(group, models) {
    const columns = Array.isArray(models) ? models : [];
    if (!group || columns.length === 0) return '';
    const header = columns.map((model) => `<th scope="col"><button type="button" class="issuer-link" data-slug="${escapeHtml(model.issuerSlug)}">${escapeHtml(model.issuerName)}</button>` +
        `<span class="comparison-token-links">${model.tokens.map((token) => `<button type="button" data-mint="${escapeHtml(token.mint)}">${escapeHtml(token.symbol || mintSuffix(token.mint))}</button>`).join('')}</span></th>`).join('');
    const row = (label, help, kind, render) => `<tr data-evidence-kind="${escapeHtml(kind)}"><th scope="row"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(help)}</span><em class="evidence-kind evidence-kind-${escapeHtml(kind)}">${escapeHtml(humanizeSlug(kind))}</em></th>` +
        columns.map((model) => `<td>${render(model)}</td>`).join('') + '</tr>';
    const outcome = (entry, status) => `<span class="comparison-verdict comparison-verdict-${escapeHtml(status)}">${escapeHtml(entry?.headline ?? 'Unknown')}</span>` +
        `<small>${escapeHtml(entry?.explanation ?? '')}</small>`;
    const body = [
        row('What do you own?', 'The legal claim—not the ticker on the token.', 'legal-conclusion', (model) =>
            `<strong>${escapeHtml(model.verdict.ownership)}</strong><small>${escapeHtml(model.verdict.cooperation)}</small>`),
        row('Main failure mode', 'The dependency most likely to make the token diverge from the stock.', 'legal-conclusion', (model) =>
            `<strong>${escapeHtml(model.verdict.mainFailure)}</strong>`),
        row('Redeem for cash', 'Whether seizure can become money without finding another buyer.', 'legal-conclusion', (model) =>
            `<span class="comparison-verdict comparison-verdict-${escapeHtml(model.outcome.status)}">${escapeHtml(model.outcome.cashExit)}</span>`),
        row('Smart-contract custody', 'Can an unstaffed protocol account hold and later release it?', 'analysis', (model) => outcome(model.outcome.custody, model.outcome.status)),
        row('Borrower default', 'Can the lender seize and dispose of the collateral by code?', 'analysis', (model) => outcome(model.outcome.default, model.outcome.status)),
        row('Exit after default', 'Bottom line: can seized collateral become usable value?', 'analysis', (model) =>
            `<span class="comparison-verdict comparison-exit-${escapeHtml(model.outcome.exitQuality.rating)}">${escapeHtml(model.outcome.exitQuality.label)}</span><small>${escapeHtml(model.outcome.exitQuality.reason)}</small>`),
        row('Confirmed lending now', 'Exact token address in a checked live collateral registry.', 'confirmed-fact', (model) =>
            `<strong>${escapeHtml(model.outcome.confirmedLending)}</strong>${model.protocols.length ? `<small>All confirmed uses: ${escapeHtml(model.protocols.join(', '))}</small>` : ''}`),
        row('Secondary-market exit', 'A pool is an exit path, not a promise of executable size.', 'confirmed-fact', (model) =>
            `<strong>${escapeHtml(fmtMoney(model.liquidityUsd))} reported liquidity</strong><small>${escapeHtml(fmtMoney(model.volume24Usd))} reported 24 h volume. ${escapeHtml(model.outcome.marketExit)}</small>`),
        row('If the protocol is hacked', 'Whether issuer powers may help—and may override finality.', 'analysis', (model) => outcome(model.outcome.hack, model.outcome.status)),
        row('If access is lost', 'What happens when the contract or controlling key is inaccessible?', 'analysis', (model) => outcome(model.outcome.accessLoss, model.outcome.status)),
        row('Evidence status', 'A conclusion is only as good as the documents behind it.', 'evidence-status', (model) =>
            `<span class="review-status ${model.review.pending ? 'review-pending' : 'review-complete'}">${escapeHtml(model.review.label)}</span><small>${escapeHtml(model.review.detail)}</small>`)
    ].join('');
    return `<div class="comparison-summary"><strong>${escapeHtml(group.ticker)}</strong><span>${columns.length} issuer structures · exact-token support and legal outcomes shown separately</span></div>` +
        `<p class="comparison-swipe-hint">Swipe horizontally to compare every issuer →</p>` +
        `<div class="table-wrap comparison-wrap"><table class="comparison-table comparison-matrix"><thead><tr><th>Question</th>${header}</tr></thead><tbody>${body}</tbody></table></div>` +
        '<p class="comparison-note"><span class="evidence-kind evidence-kind-confirmed-fact">Confirmed fact</span> comes from an observed registry, account or market. <span class="evidence-kind evidence-kind-issuer-claim">Issuer claim</span> is attributed but not independently established. <span class="evidence-kind evidence-kind-legal-conclusion">Legal conclusion</span> applies the reviewed documents. <span class="evidence-kind evidence-kind-analysis">Analysis / inference</span> combines those facts. <span class="evidence-kind evidence-kind-unknown">Unknown</span> means the evidence is insufficient; it never means “no”.</p>';
}

function filterComparisonModels(models, selectedIssuers, activeFilters) {
    const selected = selectedIssuers instanceof Set ? selectedIssuers : new Set();
    const filters = activeFilters instanceof Set ? activeFilters : new Set();
    return (Array.isArray(models) ? models : []).filter((model) => {
        if (selected.size > 0 && !selected.has(model.issuerSlug)) return false;
        return [...filters].every((key) => model.decision?.[key] === true);
    });
}

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
            changes.push(`${slug}: confirmed collateral use ${after.confirmedCollateral ? 'appeared' : 'disappeared'}`);
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
            changes.push(`${slug}: confirmed protocol list changed`);
        }
        if (isNum(before.liquidityUsd) && isNum(after.liquidityUsd) && before.liquidityUsd > 0
            && after.liquidityUsd < before.liquidityUsd * 0.6) {
            changes.push(`${slug}: reported liquidity fell more than 40%`);
        }
    }
    return changes;
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
    'Level 0 — none of the four pillars: the blockchain is not the main ledger of ownership, so an ' +
    'authoritative record sits somewhere else (a share register, a transfer agent, a broker’s books).',
    'Level 1 — the blockchain is the main ledger of ownership (blockchainIsMainLedger): there is no ' +
    'other authoritative record of who owns the asset.',
    'Level 2, Tokenized — Level 1 plus unconditional transfers (unconditionalTransfers): the token ' +
    'moves to any address without a gatekeeper — issuer, platform or regulator — approving it first.',
    'Level 3, Issuer independent — Level 2 plus bearer redemption (bearerRedemption): presenting the ' +
    'token is enough to redeem the underlying from the custodian, so the issuer is not a required party.',
    'Level 4, Legally integrated — Level 3 plus a forced-transfer mechanism (forcedTransfers): tokens ' +
    'can be moved without the holder’s consent, so a court order, a theft or a lost key can be ' +
    'corrected on the ledger.'
];

/** Claim depth, indexed by rung 0–4 (MODEL §3.2). */
const CLAIM_RUNG_TOOLTIPS = [
    'Rung 0, synthetic exposure — the holder owns a bet on the price (a derivative or a synthetic SPV ' +
    'position), not the security and not a claim on one.',
    'Rung 1, unsecured claim on the issuer — a structured note, tracker certificate or debt note with ' +
    'no security interest: if the issuer fails, the holder is an unsecured creditor.',
    'Rung 2, secured claim on collateral — the same note, but a security interest over the collateral ' +
    'exists and is granted to a named security holder.',
    'Rung 3, beneficial interest in the security — an SPV holds the share and the token is a claim on ' +
    'that share, redeemable against it.',
    'Rung 4, registered share — the holder is the registered owner of the share itself, the same class ' +
    'as the listed security.'
];

/** The definition of each market word, for the headers that cannot spell it out (MODEL §11.1). */
const MARKET_TOOLTIPS = {
    liquidity: 'Liquidity — the USD value of the reserves in this token’s DEX pools (Jupiter’s ' +
        'aggregate over Raydium, Orca and Meteora): depth that can absorb a trade, not a count of ' +
        'trades. A CEX venue never reports it.',
    trades24: 'Trades 24h — number of buys plus sells in the last 24 hours (Jupiter). Null, not zero, ' +
        'when the source does not report it.',
    traders24: 'Traders 24h — distinct trading wallets in the last 24 hours (Jupiter). Summed across a ' +
        'programme’s mints, so one wallet trading two mints counts twice.',
    tradesPerTrader: 'Trades per trader — trades 24h / traders 24h. The wash-trading tell: a few ' +
        'wallets producing thousands of trades.',
    organic: 'Organic share — the part of 24h volume Jupiter classifies as non-bot flow, over total ' +
        '24h volume.',
    venues: 'Venues — distinct DEX ids (DexScreener) plus exchange markets (CoinGecko) where the token ' +
        'has a pair.',
    lastTrade: 'Last trade — the most recent per-venue timestamp across CoinGecko tickers. No on-chain ' +
        'per-trade history is collected, so a DEX-only mint has none.',
    venueSpread: 'Venue spread — the gap between the lowest and highest price for the same mint across ' +
        'venues that traded in the last two hours with real depth (DEX pools ≥ $10k liquidity, ' +
        'exchange markets ≥ $5k 24h volume); a persistent gap is an arbitrage opportunity, a ' +
        'one-off gap is usually a stale quote.'
};

/** Above this many trades per trader, a row is flagged (MODEL §11.1, the wash-trading tell). */
const ACTIVITY_FLAG_TRADES_PER_TRADER = 25;

/** Below this organic share, in percent, a row is flagged. */
const ACTIVITY_FLAG_ORGANIC_PCT = 5;

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
 * Which warnings a row earns (MODEL §11.1): too many trades per trader is the wash-trading tell,
 * and a tiny organic share means Jupiter classified almost all of the volume as bot flow. A null
 * never trips a flag — a mint nobody reports on is not a mint with zero organic volume.
 */
function activityFlags(activity) {
    const flags = [];
    if (!activity || typeof activity !== 'object') return flags;
    const perTrader = activity.tradesPerTrader;
    if (isNum(perTrader) && perTrader > ACTIVITY_FLAG_TRADES_PER_TRADER) {
        flags.push({
            code: 'wash',
            label: 'wash?',
            glyph: '↻',
            detail: `${fmtTradesPerTrader(perTrader)} trades per trader, over the ` +
                `${ACTIVITY_FLAG_TRADES_PER_TRADER} threshold: a few wallets are producing most of the trades.`
        });
    }
    const organic = activity.organicSharePct;
    if (isNum(organic) && organic < ACTIVITY_FLAG_ORGANIC_PCT) {
        flags.push({
            code: 'inorganic',
            label: 'bot flow',
            glyph: '⚠',
            detail: `${fmtPct(organic)} of 24h volume is classified as organic, under the ` +
                `${ACTIVITY_FLAG_ORGANIC_PCT}% threshold: almost all of it is bot flow.`
        });
    }
    return flags;
}

/**
 * One issuer as a Trading-activity row (MODEL §11.3). Every number stays null when the build has
 * not produced it; organic share falls back to the §3.5 market aggregate, which is the same
 * quantity (Σ organic / Σ total × 100) computed in the same build.
 */
function issuerActivityRow(issuer) {
    const activity = (issuer && issuer.activity) || {};
    const market = (issuer && issuer.market) || {};
    const num = (value) => (isNum(value) ? value : null);
    const organicSharePct = isNum(activity.organicSharePct)
        ? activity.organicSharePct
        : num(market.organicSharePct);
    const tradesPerTrader = num(activity.tradesPerTrader);
    return {
        slug: (issuer && issuer.slug) || '',
        name: (issuer && issuer.name) || '',
        status: (issuer && issuer.status) || '',
        // The aggregate's own denominator when the build states it, so "traded / mints" compares
        // like with like; the §3.5 market count is the fallback.
        tokens: isNum(activity.tokens) ? activity.tokens : num(market.tokens),
        tokensTraded24: num(activity.tokensTraded24),
        trades24: num(activity.trades24),
        traders24: num(activity.traders24),
        tradesPerTrader,
        organicSharePct,
        venueCount: num(activity.venueCount),
        venueSpreadMedianPct: num(activity.venueSpreadMedianPct),
        venuesTop: Array.isArray(activity.venuesTop) ? activity.venuesTop : [],
        lastTradedAt: typeof activity.lastTradedAt === 'string' && activity.lastTradedAt.trim()
            ? activity.lastTradedAt
            : null,
        lastTradedVenue: typeof activity.lastTradedVenue === 'string' && activity.lastTradedVenue.trim()
            ? activity.lastTradedVenue
            : null,
        flags: activityFlags({ tradesPerTrader, organicSharePct })
    };
}

/** The Trading-activity table's rows: live issuers only (§11.3), defunct ones are omitted. */
function activityRows(issuers) {
    if (!Array.isArray(issuers)) return [];
    return issuers.filter((issuer) => issuer && issuer.status === 'live').map(issuerActivityRow);
}

/**
 * A pair leg as something readable. CoinGecko reports a DEX ticker's base and target as raw mint
 * addresses, which would make the pair column of the venue table wider than a phone, so an address
 * is shortened to its ends; a real symbol (USDC, SOL) is never touched.
 */
function shortenPairLeg(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const leg = value.trim();
    if (leg.length <= 12 || /[^A-Za-z0-9]/.test(leg)) return leg;
    return `${leg.slice(0, 4)}…${leg.slice(-4)}`;
}

/**
 * The venues of one token as uniform rows for the detail panel, busiest first. Accepts either the
 * `{dex: [...], cex: [...]}` shape of venues.json or one flat array, and infers the kind from the
 * fields when an item does not name it, so a pair keeps rendering if the builder reshapes it.
 */
function venueRows(source) {
    const items = [];
    if (Array.isArray(source)) {
        items.push(...source);
    } else if (source && typeof source === 'object') {
        if (Array.isArray(source.dex)) items.push(...source.dex.map((v) => ({ kind: 'dex', ...v })));
        if (Array.isArray(source.cex)) items.push(...source.cex.map((v) => ({ kind: 'cex', ...v })));
    }
    const rows = [];
    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const kind = item.kind === 'dex' || item.kind === 'cex'
            ? item.kind
            : (item.dexId || item.pairAddress) ? 'dex' : item.market ? 'cex' : null;
        if (!kind) continue;
        const name = kind === 'dex'
            ? (item.dexId || item.name || null)
            : (item.market || item.name || null);
        const pairFull = kind === 'dex'
            ? (item.quoteSymbol ? `/${item.quoteSymbol}` : null)
            : (item.base && item.target ? `${item.base}/${item.target}` : null);
        const pair = kind === 'dex'
            ? pairFull
            : (item.base && item.target ? `${shortenPairLeg(item.base)}/${shortenPairLeg(item.target)}` : null);
        rows.push({
            kind,
            name: typeof name === 'string' && name.trim() ? name.trim() : DASH,
            pair,
            pairFull,
            liquidityUsd: isNum(item.liquidityUsd) ? item.liquidityUsd : null,
            volume24Usd: isNum(item.volume24Usd) ? item.volume24Usd : null,
            priceUsd: isNum(item.priceUsd) ? item.priceUsd : null,
            txns24: isNum(item.txns24) ? item.txns24 : null,
            lastTradedAt: typeof item.lastTradedAt === 'string' && item.lastTradedAt.trim()
                ? item.lastTradedAt
                : null,
            url: isSafeUrl(item.url) ? item.url : null
        });
    }
    rows.sort((a, b) => compareValues(a.volume24Usd, b.volume24Usd, false) ||
        compareValues(a.liquidityUsd, b.liquidityUsd, false) ||
        compareValues(a.name, b.name, true));
    return rows;
}

/**
 * The "Card ↗" link for one token: the shareable page stocks/build-cards.mjs generates. The slug is
 * computed with the same helper the builder uses (fmt.cardSlug) rather than fetched from
 * cards/index.json, so a row link costs nothing. The builder appends a mint suffix when two tokens
 * want one slug; no two of the 441 symbols collide case-insensitively today, and a test in
 * stocks/cards.test.js goes red the day one does.
 */
function cardLinkHtml(token) {
    const slug = cardSlug(token && token.symbol, token && token.mint);
    if (!slug) return '';
    const label = (token && (token.symbol || token.mint)) || 'this token';
    return `<a class="card-link" href="cards/${encodeURIComponent(slug)}.html" ` +
        `title="Shareable card for ${escapeHtml(label)}">Card &#8599;</a>`;
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

/** How many days the feed looked back, as the strip's note should say it. */
function newMintsWindowDays(changes) {
    const days = changes && changes.newMintWindowDays;
    return isNum(days) && days > 0 ? days : NEW_MINTS_WINDOW_DAYS;
}

// --- the funnel graphic ----------------------------------------------------

/** One column of stocks-funnel.json, or null. */
function funnelColumn(funnel, key) {
    const columns = funnel && Array.isArray(funnel.columns) ? funnel.columns : [];
    return columns.find((column) => column && column.key === key) || null;
}

function numberWord(count) {
    if (Number.isInteger(count) && count >= 0 && count < SMALL_NUMBER_WORDS.length) return SMALL_NUMBER_WORDS[count];
    return fmtNumber(count);
}

/**
 * The section heading, built from the funnel's own totals rather than written down: "From 471 mints
 * to one token program". Null when there is no funnel to count, in which case the section is hidden
 * rather than headed with a number nobody measured.
 */
function funnelTitle(funnel) {
    const mints = funnelColumn(funnel, 'tokens');
    const programs = funnelColumn(funnel, 'programs');
    if (!mints || !programs || !isNum(mints.total) || !Array.isArray(programs.nodes)) return null;
    const count = programs.nodes.length;
    return `From ${fmtNumber(mints.total)} mints to ${numberWord(count)} token program${count === 1 ? '' : 's'}`;
}

/**
 * The text drawn beside a circle: the node's label with its mint count. A recipe label already
 * names its program ("token-2022 · pausable + clawback") and the program is the very next column,
 * so the prefix is dropped here — the full label stays in the node's <title>.
 */
function funnelNodeText(node, columnKey, maxLength) {
    const raw = node && typeof node.label === 'string' ? node.label : '';
    const label = columnKey === 'recipes' ? raw.replace(/^[^·]*·\s*/, '') : raw;
    const short = displayName(label, isNum(maxLength) ? maxLength : 40);
    return `${short} · ${fmtNumber(node && node.count)}`;
}

/** The node's hover text: always the FULL label, the count, and an issuer's lifecycle status. */
function funnelNodeTitle(node, columnKey) {
    const label = node && typeof node.label === 'string' ? node.label : DASH;
    const count = node && isNum(node.count) ? node.count : null;
    const mints = count === null ? DASH : `${fmtNumber(count)} mint${count === 1 ? '' : 's'}`;
    const status = columnKey === 'issuers' && node && typeof node.status === 'string' ? `, ${node.status}` : '';
    return `${label} — ${mints}${status}`;
}

/** Drawing height: enough rows for the tallest column, never below the minimum. */
function funnelHeight(funnel) {
    const columns = funnel && Array.isArray(funnel.columns) ? funnel.columns : [];
    const tallest = columns.reduce((most, column) => Math.max(most, (column.nodes || []).length), 0);
    return Math.max(FUNNEL_MIN_HEIGHT, tallest * FUNNEL_ROW_PX + FUNNEL_TOP_PAD + FUNNEL_BOTTOM_PAD);
}

function round1(value) {
    return Math.round(value * 10) / 10;
}

/**
 * Pure layout for the funnel SVG: node positions, radii and connector path strings, from
 * stocks-funnel.json. Circle area is proportional to the mint count (r ∝ √count) against the
 * biggest count anywhere in the funnel, so a circle is comparable across columns, with a floor so a
 * one-mint programme is still a dot rather than nothing. Every y is clamped inside the box, so a
 * caller that asks for a short box gets overlapping circles rather than circles off the canvas.
 * Connector width follows the edge's mint count, also with a floor, and an edge whose endpoints are
 * not both nodes is dropped rather than drawn to nowhere.
 */
function funnelLayout(funnel, options) {
    const opts = options || {};
    const columns = (funnel && Array.isArray(funnel.columns) ? funnel.columns : [])
        .filter((column) => column && Array.isArray(column.nodes));
    const width = isNum(opts.width) && opts.width > 0 ? opts.width : FUNNEL_WIDTH;
    const height = isNum(opts.height) && opts.height > 0 ? opts.height : funnelHeight(funnel);
    if (columns.length === 0) return { width, height, columns: [], nodes: [], edges: [] };

    const counts = columns.flatMap((column) => column.nodes.map((node) => node.count)).filter(isNum);
    const maxCount = Math.max(1, ...counts);
    const radius = (count) => (isNum(count) && count > 0
        ? Math.max(FUNNEL_MIN_R, Math.min(FUNNEL_MAX_R, FUNNEL_MAX_R * Math.sqrt(count / maxCount)))
        : FUNNEL_MIN_R);

    const usable = Math.max(1, width - FUNNEL_COLUMN_GAP * (columns.length - 1));
    const laidOutColumns = [];
    const nodes = [];
    let bandStart = 0;

    for (let index = 0; index < columns.length; index++) {
        const column = columns[index];
        const weight = isNum(FUNNEL_COLUMN_WEIGHTS[index]) ? FUNNEL_COLUMN_WEIGHTS[index] : 1 / columns.length;
        const bandWidth = usable * weight;
        const x = bandStart + FUNNEL_MAX_R;
        const labelRoom = Math.max(6, Math.floor((bandWidth - FUNNEL_MAX_R - FUNNEL_LABEL_GAP) / FUNNEL_LABEL_CHAR_PX));

        laidOutColumns.push({
            key: column.key,
            title: typeof column.title === 'string' ? column.title : '',
            total: isNum(column.total) ? column.total : null,
            count: column.nodes.length,
            // The number the column heading prints, and the funnel's own story: the first column is
            // read as the mints it holds (its circles are instrument types), every later one as how
            // many distinct things those mints collapse into — 471 → 12 → 6 → 1.
            headline: column.key === 'tokens' && isNum(column.total) ? column.total : column.nodes.length,
            x: round1(x),
            labelX: round1(bandStart),
            titleY: round1(FUNNEL_TOP_PAD / 2)
        });

        const step = (height - FUNNEL_TOP_PAD - FUNNEL_BOTTOM_PAD) / Math.max(1, column.nodes.length);
        for (let row = 0; row < column.nodes.length; row++) {
            const node = column.nodes[row];
            const r = radius(node.count);
            const centre = FUNNEL_TOP_PAD + step * (row + 0.5);
            const y = Math.min(Math.max(centre, r), height - r);
            nodes.push({
                id: node.id,
                column: column.key,
                kind: typeof node.kind === 'string' ? node.kind : column.key,
                label: typeof node.label === 'string' ? node.label : DASH,
                count: isNum(node.count) ? node.count : null,
                status: typeof node.status === 'string' ? node.status : null,
                // Only an issuer circle opens a dossier; the other three columns are not records.
                slug: column.key === 'issuers' && typeof node.id === 'string' ? node.id : null,
                // Hollow = nothing flowing through it: a defunct programme, or one with no mints.
                hollow: column.key === 'issuers' && (node.count === 0 || node.status !== 'live'),
                text: funnelNodeText(node, column.key, labelRoom),
                title: funnelNodeTitle(node, column.key),
                x: round1(x),
                y: round1(y),
                textX: round1(x + r + FUNNEL_LABEL_GAP),
                r: round1(r)
            });
        }

        bandStart += bandWidth + FUNNEL_COLUMN_GAP;
    }

    const byId = new Map(nodes.map((node) => [node.id, node]));
    const rawEdges = (funnel && Array.isArray(funnel.edges) ? funnel.edges : [])
        .filter((edge) => edge && byId.has(edge.from) && byId.has(edge.to));
    const maxEdge = Math.max(1, ...rawEdges.map((edge) => (isNum(edge.count) ? edge.count : 0)));

    const edges = rawEdges.map((edge) => {
        const from = byId.get(edge.from);
        const to = byId.get(edge.to);
        const x1 = round1(from.x + from.r);
        const x2 = round1(to.x - to.r);
        const bend = round1((x2 - x1) / 2);
        const share = isNum(edge.count) ? edge.count / maxEdge : 0;
        return {
            from: edge.from,
            to: edge.to,
            count: isNum(edge.count) ? edge.count : null,
            d: `M${x1},${from.y}C${round1(x1 + bend)},${from.y} ${round1(x2 - bend)},${to.y} ${x2},${to.y}`,
            strokeWidth: round1(Math.max(FUNNEL_EDGE_MIN_PX, FUNNEL_EDGE_MAX_PX * share)),
            title: `${from.label} → ${to.label}: ${fmtNumber(edge.count)} mint${edge.count === 1 ? '' : 's'}`
        };
    });

    return { width, height, columns: laidOutColumns, nodes, edges };
}

// ---------------------------------------------------------------------------
// Evidence chips (stocks/EVIDENCE.md §4)
// ---------------------------------------------------------------------------

/**
 * The claim logic itself is stocks/lib/evidence.js — the same UMD file the ESM builders use
 * through evidence.mjs — so what the panel says about a field cannot drift from what the build
 * counted or what a card prints. Only the markup below is the page's own.
 */
const evidenceLib = (typeof __rwaEvidence !== 'undefined')
    ? __rwaEvidence
    : require('./stocks/lib/evidence.js');

const { claimsByField, chipFor, neededFields, normaliseField } = evidenceLib;

/** Status -> the class that colours the badge, and the word shown on it. */
const CLAIM_STATUS_CLASS = {
    confirmed: 'ev-confirmed',
    unverified: 'ev-caution',
    'contradicted-corrected': 'ev-warning',
    inference: 'ev-muted',
    changed: 'ev-warning',
    'source-gone': 'ev-warning'
};

const CLAIM_STATUS_LABEL = {
    confirmed: 'confirmed',
    unverified: 'unverified',
    'contradicted-corrected': 'contradicted — corrected',
    inference: 'inference',
    changed: 'source changed',
    'source-gone': 'source gone'
};

/** What the hollow chip says, in one place, because the tooltip and the popover both use it. */
const NO_CLAIM_TEXT = 'no source recorded yet';

function claimStatusClass(status) {
    return CLAIM_STATUS_CLASS[status] || 'ev-muted';
}

function claimStatusLabel(status) {
    return CLAIM_STATUS_LABEL[status] || (typeof status === 'string' && status ? status : 'unknown');
}

/**
 * The chip index for one issuer: its claims grouped by field, and the set of fields that need a
 * claim. The need list is stocks/data/claim-fields.json — fetched once by the page, so the same
 * file drives the builders and the browser — but the build already expanded it against this very
 * record (`evidenceFields`), so that list wins when it is there and the fetch is only the fallback.
 */
function evidenceIndex(issuer, fieldPatterns) {
    const byField = claimsByField(Array.isArray(issuer && issuer.claims) ? issuer.claims : []);
    const expanded = Array.isArray(issuer && issuer.evidenceFields)
        ? issuer.evidenceFields
        : neededFields(issuer || {}, Array.isArray(fieldPatterns) ? fieldPatterns : []);
    return { byField, needed: new Set(expanded.map(normaliseField)) };
}

/** "Evidence: 34 of 41 fields sourced · last checked 18 Sep 2026 10:22 UTC". */
function evidenceLineText(summary) {
    if (!summary || !summary.coverage) return '';
    const { sourced, needed } = summary.coverage;
    const checked = summary.lastCheckedAt
        ? ` · last checked ${fmtDateTime(summary.lastCheckedAt)}`
        : ' · never checked';
    return `Evidence: ${fmtNumber(sourced)} of ${fmtNumber(needed)} fields sourced${checked}`;
}

function evidenceLineHtml(summary) {
    const text = evidenceLineText(summary);
    if (!text) return '';
    const counts = summary.claims
        ? ` <span class="ev-counts">${fmtNumber(summary.claims)} claim${summary.claims === 1 ? '' : 's'}` +
          ` · ${fmtNumber(summary.confirmed)} confirmed · ${fmtNumber(summary.unverified)} unverified` +
          ` · ${fmtNumber(summary.inference)} inference · ${fmtNumber(summary.corrected)} corrected</span>`
        : '';
    return `<p class="ev-line">${escapeHtml(text)}${counts}</p>`;
}

/**
 * How much of a source's title the chip prints. A dossier `documents[]` title is free prose and one
 * of them runs past 700 characters — printed in full it turns the popover into a wall of link text,
 * so the label is cut and the whole title goes in the element's `title` attribute instead.
 */
const SOURCE_LABEL_MAX = 72;

/** A source's own title when the dossier names it, else the URL without its scheme. */
function sourceTitle(url, documents) {
    if (typeof url !== 'string' || !url) return null;
    const docs = Array.isArray(documents) ? documents : [];
    for (const doc of docs) {
        if (doc && doc.url === url && typeof doc.title === 'string' && doc.title.trim()) {
            return doc.title.trim();
        }
    }
    return url.replace(/^https?:\/\//, '');
}

/** The title cut to one line at a word boundary, with an ellipsis so the cut is visible. */
function sourceLabel(title) {
    if (typeof title !== 'string' || !title.trim()) return null;
    const text = title.replace(/\s+/g, ' ').trim();
    if (text.length <= SOURCE_LABEL_MAX) return text;
    const cut = text.slice(0, SOURCE_LABEL_MAX);
    const space = cut.lastIndexOf(' ');
    return `${(space > SOURCE_LABEL_MAX * 0.6 ? cut.slice(0, space) : cut).replace(/[.,;:\s]+$/, '')}…`;
}

/** One timestamp row of the popover: formatted, with the full ISO in the title attribute. */
function stampHtml(label, iso) {
    if (typeof iso !== 'string' || !iso.trim()) return '';
    return `<span class="ev-stamp" title="${escapeHtml(iso)}">${escapeHtml(label)} ` +
        `${escapeHtml(fmtDateTime(iso))}</span>`;
}

/** One claim inside the popover: the quote, the source, the locator, the stamps and the note. */
function claimHtml(claim, documents) {
    const status = `<span class="ev-badge ${claimStatusClass(claim.status)}">` +
        `${escapeHtml(claimStatusLabel(claim.status))}</span>`;
    const title = sourceTitle(claim.url, documents);
    const label = sourceLabel(title);
    // The full title rides in the `title` attribute, so nothing is lost by the cut.
    const long = label !== title ? ` title="${escapeHtml(title)}"` : '';
    const source = isSafeUrl(claim.url)
        ? `<a href="${escapeHtml(claim.url)}"${long} target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
        : label ? `<span${long}>${escapeHtml(label)}</span>` : '<span class="ev-nosource">no URL recorded</span>';
    const stamps = [
        stampHtml('recorded', claim.recordedAt),
        stampHtml('last checked', claim.lastCheckedAt),
        stampHtml('accessed', claim.accessedAt)
    ].filter(Boolean).join(' · ');
    return '<div class="ev-claim">' +
        `<div class="ev-claim-head">${status}` +
        `${claim.method === 'onchain' ? '<span class="ev-badge ev-muted">on-chain</span>' : ''}</div>` +
        (claim.quote ? `<blockquote class="ev-quote">${escapeHtml(claim.quote)}</blockquote>` : '') +
        `<div class="ev-meta">${source}` +
        `${claim.locator ? ` · <code>${escapeHtml(claim.locator)}</code>` : ''}</div>` +
        (stamps ? `<div class="ev-meta ev-stamps">${stamps}</div>` : '') +
        (claim.note ? `<p class="ev-note">${escapeHtml(claim.note)}</p>` : '') +
        '</div>';
}

/**
 * The "§" chip after a field's value. A `<details>` element rather than a hover-only tooltip:
 * that is tappable on a phone, reachable and openable from the keyboard with no script of our own,
 * and the `title` still gives the one-line summary on hover. A field with no claim but on the need
 * list gets the hollow "§?" form; a field that neither has nor needs one gets no chip at all.
 */
function chipHtml(chip, label, documents) {
    if (!chip) return '';
    const name = typeof label === 'string' && label ? label : chip.field;
    if (chip.claims.length === 0) {
        return `<details class="ev-chip ev-chip-none"><summary title="${escapeHtml(NO_CLAIM_TEXT)}" ` +
            `aria-label="${escapeHtml(`Evidence for ${name}: ${NO_CLAIM_TEXT}`)}">§?</summary>` +
            `<div class="ev-pop"><p class="ev-none">${escapeHtml(NO_CLAIM_TEXT)}</p>` +
            `<p class="ev-field"><code>${escapeHtml(chip.field)}</code></p></div></details>`;
    }
    const best = chip.best || chip.claims[0];
    const hover = `${claimStatusLabel(best.status)}${best.quote ? ` — “${best.quote.slice(0, 120)}”` : ''}`;
    const body = chip.claims.map((claim) => claimHtml(claim, documents)).join('');
    return `<details class="ev-chip ${claimStatusClass(best.status)}">` +
        `<summary title="${escapeHtml(hover)}" ` +
        `aria-label="${escapeHtml(`Evidence for ${name}: ${claimStatusLabel(best.status)}`)}">§</summary>` +
        `<div class="ev-pop"><p class="ev-field"><code>${escapeHtml(chip.field)}</code>` +
        `${chip.claims.length > 1 ? ` · ${chip.claims.length} claims` : ''}</p>${body}</div></details>`;
}

/** The chip for one field path, given an index from evidenceIndex(). */
function fieldChipHtml(index, field, label) {
    if (!index || typeof field !== 'string' || !field) return '';
    return chipHtml(chipFor(field, index.byField, index.needed), label, index.documents);
}

// ---------------------------------------------------------------------------
// Trust chain and what-if (stocks/EVIDENCE.md §6)
// ---------------------------------------------------------------------------

/**
 * Both are drawn by pure libraries the card builder uses too, so the panel and a static card can
 * never show a differently graded chain or a differently counted answer sheet:
 * stocks/lib/trustchain-svg.js draws the diagram from the record's own `chain`, and
 * stocks/lib/whatif-render.js renders the answers the API serves.
 */
const trustChainSvg = (typeof __rwaTrustChainSvg !== 'undefined')
    ? __rwaTrustChainSvg
    : require('./stocks/lib/trustchain-svg.js');

const whatIfLib = (typeof __rwaWhatIf !== 'undefined')
    ? __rwaWhatIf
    : require('./stocks/lib/whatif-render.js');

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

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        DASH,
        CARDS_DIR,
        NEW_MINTS_WINDOW_DAYS,
        newMintChips,
        newMintsWindowDays,
        CLAIM_LABELS,
        VERIFICATION_LABELS,
        KEY_GOVERNANCE_LABELS,
        KEY_GOVERNANCE_ROLES,
        CHIP_MIN_PX,
        CHIP_MAX_PX,
        FUNNEL_WIDTH,
        FUNNEL_MIN_R,
        FUNNEL_MAX_R,
        FUNNEL_EDGE_MIN_PX,
        FUNNEL_EDGE_MAX_PX,
        funnelColumn,
        funnelTitle,
        funnelNodeText,
        funnelNodeTitle,
        funnelHeight,
        funnelLayout,
        GRID_STAGES,
        GRID_RUNGS,
        GRID_FIRST_DATA_COLUMN,
        GRID_LABEL_ROW,
        isNum,
        escapeHtml,
        isSafeUrl,
        fmtNumber,
        fmtMoney,
        fmtPrice,
        fmtPct,
        fmtSignedPct,
        fmtDateTime,
        fmtDate,
        fetchedAtOf,
        chipSize,
        gridCell,
        claimAxisLabels,
        claimLabel,
        verificationLabel,
        coverageLabel,
        coverageClass,
        isControlOn,
        fmtFeeBps,
        severityRank,
        severityClass,
        worstSeverity,
        humanizeSlug,
        cardSlug,
        mintSuffix,
        cardLinkHtml,
        indexTypes,
        labelForSchema,
        isMissing,
        compareValues,
        makeComparator,
        displayName,
        tokenMatchesQuery,
        filterTokens,
        TOKEN_PAGE_SIZE,
        TOKEN_API_SORTS,
        tokenPageMath,
        tokenApiParams,
        tokenFromApiRow,
        defiUsageIndex,
        defiActionText,
        defiUsageCompactHtml,
        defiMetricText,
        defiUsageDetailHtml,
        defiSourceRows,
        composabilityTemplateForToken,
        aggregateComposabilityTemplates,
        lenderOutcomeModel,
        productDecisionProfile,
        defiCustodyHtml,
        sameStockComparisonModels,
        sameStockComparisonHtml,
        filterComparisonModels,
        comparisonSnapshot,
        comparisonSnapshotChanges,
        sortIssuersForDisplay,
        laypersonVerdict,
        legalReviewStatus,
        parseStockSearch,
        globalSearch,
        sameUnderlyingGroups,
        collectorHealth,
        MATURITY_LEVEL_TOOLTIPS,
        CLAIM_RUNG_TOOLTIPS,
        MARKET_TOOLTIPS,
        ACTIVITY_FLAG_TRADES_PER_TRADER,
        ACTIVITY_FLAG_ORGANIC_PCT,
        maturityLevelTooltip,
        claimRungTooltip,
        isoToMillis,
        humanizeDuration,
        fmtRelativeTime,
        fmtAgeSeconds,
        fmtTradesPerTrader,
        fmtCountOfTotal,
        fmtVenueSpreadPct,
        fmtVenueSpread,
        activityFlags,
        issuerActivityRow,
        activityRows,
        venueRows,
        CLAIM_STATUS_CLASS,
        CLAIM_STATUS_LABEL,
        NO_CLAIM_TEXT,
        claimStatusClass,
        claimStatusLabel,
        claimsByField,
        chipFor,
        evidenceIndex,
        evidenceLineText,
        evidenceLineHtml,
        SOURCE_LABEL_MAX,
        sourceTitle,
        sourceLabel,
        stampHtml,
        claimHtml,
        chipHtml,
        fieldChipHtml,
        CHAIN_NOTE,
        WHAT_IF_NOTE,
        chainActorOrder,
        chainActorLabels,
        chainSectionHtml,
        whatIfSectionHtml,
        COMPOSABILITY_SCENARIOS,
        composabilityTemplateRows,
        composabilityTemplatesHtml
    };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        const ISSUERS_PATH = './stocks-issuers.json';
        const TOKENS_PATH = './stocks-tokens.json';
        const CHANGES_PATH = './stocks-changes.json';
        const FUNNEL_PATH = './stocks-funnel.json';
        const SAMPLE_ISSUERS_PATH = './stocks/fixtures/stocks-issuers.sample.json';
        const SAMPLE_TOKENS_PATH = './stocks/fixtures/stocks-tokens.sample.json';
        const VENUES_PATH = './stocks/data/venues.json';
        // The field-need list behind the hollow "§?" chip. One file, shared with the builders
        // (stocks/lib/evidence.mjs reads the same path), so the page can never disagree with the
        // coverage number the build wrote. Its absence only costs the fallback expansion.
        const CLAIM_FIELDS_PATH = './stocks/data/claim-fields.json';
        // The trust-chain catalogue, fetched for the same reason: the actor order and labels the
        // what-if groups read are in the file the builders and the API read, not in the API's rows.
        const TRUST_CHAIN_PATH = './stocks/data/trust-chain.json';
        const COMPOSABILITY_PATH = './stocks/data/composability-templates.json';
        const DEFI_USAGE_PATH = './stocks/data/defi-usage.json';
        const REVIEW_QUEUE_PATH = './stocks-review-queue.json';

        const BUILD_HINT = 'Build it with "npm run stocks:all && npm run stocks:build"';

        const state = {
            builtAt: null,
            issuers: [],
            issuersBySlug: new Map(),
            tokens: [],
            tokensByMint: new Map(),
            tokensLoaded: false,
            useSample: false,
            tokenPage: 1,
            tokenTotal: 0,
            tokenRows: [],
            tokenRequestSeq: 0,
            venuesByMint: null,
            venuesLoaded: false,
            claimFields: [],
            // The trust-chain catalogue (stocks/data/trust-chain.json), fetched like the claim-field
            // list beside it: the page needs its ACTOR ORDER and labels to group the what-if
            // answers, which the API's per-row `actor_label` cannot give.
            catalogue: null,
            composability: null,
            defiUsage: null,
            defiUsageByMint: new Map(),
            // One answer sheet per issuer slug, kept so reopening a panel does not re-fetch:
            // an object is the sheet, a string is the failure that must be shown instead of it.
            whatIfBySlug: new Map(),
            // Which issuer's panel is open, so a sheet that lands after the reader has moved on is
            // dropped rather than written into whatever panel is showing now.
            openIssuerSlug: null,
            // The open issuer panel's chip index, set by detailHtml() and cleared by the token
            // panel, which renders on-chain facts rather than dossier claims.
            detailEvidence: null,
            openTokenMint: null,
            findingTypes: Object.create(null),
            attestationTypes: Object.create(null),
            filters: { issuer: '', instrumentType: '', query: '' },
            comparisonGroups: [],
            comparisonModels: [],
            comparisonTicker: null,
            comparisonSelected: new Set(),
            comparisonFilters: new Set(),
            reviewP0ByIssuer: new Map(),
            historyRequest: 0,
            serverWatch: null,
            sort: { key: 'liquidity', ascending: false },
            activitySort: { key: 'trades24', ascending: false }
        };

        // Which token-table columns can be sorted, and what each one reads.
        const SORT_KEYS = {
            price: (t) => t.market && t.market.usdPrice,
            premium: (t) => t.reference && t.reference.premiumPct,
            liquidity: (t) => t.market && t.market.liquidity,
            vol24: (t) => t.market && t.market.vol24,
            trades24: (t) => t.activity && t.activity.trades24,
            traders24: (t) => t.activity && t.activity.traders24,
            spread: (t) => t.activity && t.activity.venueSpreadPct,
            holders: (t) => t.market && t.market.holderCount,
            lastTrade: (t) => isoToMillis(t.activity && t.activity.lastTradedAt)
        };

        // The Trading-activity table reads its already-shaped rows (issuerActivityRow), so a
        // column sorts on the same value the cell shows.
        const ACTIVITY_SORT_KEYS = {
            issuer: (row) => row.name,
            tokensTraded: (row) => row.tokensTraded24,
            trades24: (row) => row.trades24,
            traders24: (row) => row.traders24,
            tradesPerTrader: (row) => row.tradesPerTrader,
            organic: (row) => row.organicSharePct,
            venues: (row) => row.venueCount,
            venueSpread: (row) => row.venueSpreadMedianPct,
            lastTrade: (row) => isoToMillis(row.lastTradedAt)
        };

        // Compact per-token flag glyphs: [property, glyph, tooltip].
        const TOKEN_FLAGS = [
            ['clawback', 'C', 'Clawback: a permanent delegate can move this token out of any wallet'],
            ['freezeAuthority', 'F', 'Freeze authority is live: the issuer can freeze any account'],
            ['pausable', 'P', 'Pausable: the whole mint can be halted'],
            ['allowlist', 'A', 'Allowlist: new accounts start frozen and must be onboarded'],
            ['hookActive', 'H', 'Transfer hook installed: a program runs on every transfer']
        ];

        const els = {
            status: document.getElementById('status'),
            dataAsOf: document.getElementById('dataAsOf'),
            sampleBanner: document.getElementById('sampleBanner'),
            newMints: document.getElementById('newMints'),
            newMintsTrack: document.getElementById('newMintsTrack'),
            newMintsClone: document.getElementById('newMintsClone'),
            newMintsWindow: document.getElementById('newMintsWindow'),
            funnelSection: document.getElementById('funnelSection'),
            funnelHeading: document.getElementById('funnelHeading'),
            funnelGraphic: document.getElementById('funnelGraphic'),
            grid: document.getElementById('claimGrid'),
            gridLegend: document.getElementById('gridLegend'),
            issuerCards: document.getElementById('issuerCards'),
            issuerCount: document.getElementById('issuerCount'),
            activityTableBody: document.querySelector('#activityTable tbody'),
            activityTableHead: document.querySelector('#activityTable thead'),
            activityHint: document.getElementById('activityHint'),
            tokenTableBody: document.querySelector('#tokenTable tbody'),
            tokenTableHead: document.querySelector('#tokenTable thead'),
            tokenCount: document.getElementById('tokenCount'),
            tokenPager: document.getElementById('tokenPager'),
            tokenPageLabel: document.getElementById('tokenPageLabel'),
            tokenPrev: document.getElementById('tokenPrev'),
            tokenNext: document.getElementById('tokenNext'),
            tokenTable: document.getElementById('tokenTable'),
            toggleTokenColumns: document.getElementById('toggleTokenColumns'),
            filterIssuer: document.getElementById('filterIssuer'),
            filterInstrument: document.getElementById('filterInstrument'),
            globalSearch: document.getElementById('globalSearch'),
            globalSearchResults: document.getElementById('globalSearchResults'),
            collectorHealth: document.getElementById('collectorHealth'),
            comparisonSection: document.getElementById('comparisonSection'),
            comparisonUnderlying: document.getElementById('comparisonUnderlying'),
            comparisonProducts: document.getElementById('comparisonProducts'),
            comparisonFilters: document.getElementById('comparisonFilters'),
            comparisonSelectionCount: document.getElementById('comparisonSelectionCount'),
            saveComparison: document.getElementById('saveComparison'),
            clearComparisonFilters: document.getElementById('clearComparisonFilters'),
            shareComparison: document.getElementById('shareComparison'),
            comparisonWatchStatus: document.getElementById('comparisonWatchStatus'),
            comparisonView: document.getElementById('comparisonView'),
            composabilitySection: document.getElementById('composabilitySection'),
            composabilityBody: document.getElementById('composabilityBody'),
            composabilityMethod: document.getElementById('composabilityMethod'),
            defiUsageSection: document.getElementById('defiUsageSection'),
            defiUsageStats: document.getElementById('defiUsageStats'),
            defiSourceCoverage: document.getElementById('defiSourceCoverage'),
            defiUsageMethod: document.getElementById('defiUsageMethod'),
            detail: document.getElementById('detailDialog'),
            detailBody: document.getElementById('detailBody'),
            detailTitle: document.getElementById('detailTitle'),
            detailClose: document.getElementById('detailClose')
        };

        const WORKSPACE_VIEWS = new Set(['overview', 'assets', 'compare', 'issuers', 'defi']);
        const LEGACY_VIEW_BY_HASH = {
            '#tokensSection': 'assets',
            '#activitySection': 'assets',
            '#comparisonSection': 'compare',
            '#issuersSection': 'issuers',
            '#gridSection': 'issuers',
            '#funnelSection': 'issuers',
            '#defiUsageSection': 'defi',
            '#composabilitySection': 'defi'
        };

        function requestedWorkspaceView() {
            const url = new URL(window.location.href);
            const requested = url.searchParams.get('view');
            if (WORKSPACE_VIEWS.has(requested)) return requested;
            if (LEGACY_VIEW_BY_HASH[url.hash]) return LEGACY_VIEW_BY_HASH[url.hash];
            if (url.searchParams.has('compare')) return 'compare';
            return 'overview';
        }

        function setWorkspaceView(view, { writeUrl = false, scroll = false } = {}) {
            const next = WORKSPACE_VIEWS.has(view) ? view : 'overview';
            document.body.dataset.workspaceView = next;
            document.querySelectorAll('[data-workspace-view]').forEach((button) => {
                const selected = button.dataset.workspaceView === next;
                button.setAttribute('aria-selected', selected ? 'true' : 'false');
                button.tabIndex = selected ? 0 : -1;
            });
            if (writeUrl) {
                const url = new URL(window.location.href);
                url.searchParams.set('view', next);
                url.hash = '';
                window.history.pushState(null, '', url);
            }
            if (scroll) document.querySelector('.workspace-tabs')?.scrollIntoView({ block: 'start' });
        }

        function initWorkspaceNavigation() {
            const tabs = Array.from(document.querySelectorAll('[data-workspace-view]'));
            setWorkspaceView(requestedWorkspaceView());
            tabs.forEach((button, index) => {
                button.addEventListener('click', () => setWorkspaceView(button.dataset.workspaceView, { writeUrl: true, scroll: true }));
                button.addEventListener('keydown', (event) => {
                    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                    event.preventDefault();
                    const direction = event.key === 'ArrowRight' ? 1 : -1;
                    tabs[(index + direction + tabs.length) % tabs.length].focus();
                });
            });
            document.querySelectorAll('[data-open-view]').forEach((button) => {
                button.addEventListener('click', () => setWorkspaceView(button.dataset.openView, { writeUrl: true, scroll: true }));
            });
            window.addEventListener('popstate', () => setWorkspaceView(requestedWorkspaceView()));
        }

        // Reduced motion is an accessibility setting first and the test hook second: the only thing
        // that moves on this page is the "New on Solana" ticker, and the class turns it into a
        // static wrapping row (stocks.css). ?reduceMotion=1 forces the same for a driver that
        // cannot emulate the media query. Same class name live.js uses.
        const reduceMotion = new URLSearchParams(window.location.search).has('reduceMotion')
            || (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        if (reduceMotion) document.body.classList.add('reduce-motion');

        // Where the read-only API lives: same origin in production, `?api=<origin>` from a dev
        // server. Only the what-if answers are fetched from it — everything else on this page comes
        // from the built files — so its absence costs that one section and nothing more.
        const apiLib = (typeof __rwaApi !== 'undefined') ? __rwaApi : null;
        const apiBase = apiLib === null ? '' : apiLib.apiBase();
        let tokenSearchTimer = null;

        initWorkspaceNavigation();
        loadPage();

        /**
         * Two passes, in the order the page is read: the issuer file (grid, cards, issuer filter),
         * then the token file (the table). The second fetch only starts once the first has been
         * rendered, so the smaller file is never slowed down by the larger one.
         */
        async function loadPage() {
            const useSample = new URLSearchParams(window.location.search).get('db') === 'sample';
            state.useSample = useSample;
            const issuersPath = useSample ? SAMPLE_ISSUERS_PATH : ISSUERS_PATH;
            const tokensPath = useSample ? SAMPLE_TOKENS_PATH : TOKENS_PATH;

            tokenTableMessage('Loading mints…');
            els.tokenCount.textContent = 'loading…';

            // The change log and the funnel are two more small files (~30 kB and ~7 kB) feeding one
            // section each, so they are fetched alongside the issuers and their absence is not an
            // error — the section hides itself. Neither has a sample fixture, so ?db=sample skips
            // both rather than mixing three live mints into twelve fixture ones.
            const [issuerDb, findingTypes, attestationTypes, changes, funnel, claimFields, catalogue, composability, defiUsage, reviewQueue] =
                await Promise.all([
                    fetchJson(issuersPath),
                    fetchJson('./finding-types.json'),
                    fetchJson('./attestation-types.json'),
                    useSample ? Promise.resolve(null) : fetchJson(CHANGES_PATH),
                    useSample ? Promise.resolve(null) : fetchJson(FUNNEL_PATH),
                    fetchJson(CLAIM_FIELDS_PATH),
                    fetchJson(TRUST_CHAIN_PATH),
                    useSample ? Promise.resolve(null) : fetchJson(COMPOSABILITY_PATH),
                    useSample ? Promise.resolve(null) : fetchJson(DEFI_USAGE_PATH),
                    useSample ? Promise.resolve(null) : fetchJson(REVIEW_QUEUE_PATH)
                ]);

            state.claimFields = claimFields && Array.isArray(claimFields.fields) ? claimFields.fields : [];
            state.catalogue = catalogue;
            state.composability = composability;
            state.defiUsage = defiUsage;
            state.defiUsageByMint = defiUsageIndex(defiUsage);
            state.reviewP0ByIssuer = new Map();
            for (const item of reviewQueue?.items ?? []) {
                if (item.priority !== 'P0' || !item.issuerSlug) continue;
                if (!state.reviewP0ByIssuer.has(item.issuerSlug)) state.reviewP0ByIssuer.set(item.issuerSlug, []);
                state.reviewP0ByIssuer.get(item.issuerSlug).push(item);
            }

            renderNewMints(changes);
            renderFunnel(funnel);

            state.findingTypes = indexTypes(findingTypes);
            state.attestationTypes = indexTypes(attestationTypes);

            if (!issuerDb || !Array.isArray(issuerDb.issuers)) {
                els.status.textContent = `No data: ${issuersPath} could not be loaded or has no issuers. ` +
                    `${BUILD_HINT}, or append ?db=sample to this URL to view the bundled sample fixture.`;
                els.status.classList.add('status-error');
                els.tokenCount.textContent = DASH;
                tokenTableMessage(`No mints: ${issuersPath} could not be loaded.`);
                return;
            }

            state.issuers = issuerDb.issuers;
            state.issuersBySlug = new Map(state.issuers.map((issuer) => [issuer.slug, issuer]));
            state.builtAt = issuerDb.builtAt;

            if (useSample && els.sampleBanner) els.sampleBanner.hidden = false;

            const fetchedAt = fetchedAtOf(issuerDb.sources && issuerDb.sources.universe);
            els.dataAsOf.textContent = fmtDateTime(fetchedAt);
            els.dataAsOf.setAttribute('datetime', fetchedAt || '');

            renderStatus('mints loading…');
            renderCollectorHealth(issuerDb.sources);
            renderGrid(state.issuers);
            renderActivityTable();
            renderIssuerCards(state.issuers);
            populateIssuerFilter(state.issuers);
            wireEvents();

            const tokenDb = await fetchJson(tokensPath);
            if (!tokenDb || !Array.isArray(tokenDb.tokens)) {
                els.tokenCount.textContent = DASH;
                tokenTableMessage(`No mints: ${tokensPath} could not be loaded. ${BUILD_HINT}.`);
                renderStatus('mints unavailable');
                return;
            }

            state.tokens = tokenDb.tokens;
            state.tokensByMint = new Map(state.tokens.map((token) => [token.mint, token]));
            state.tokensLoaded = true;
            // Re-render issuer dashboards now that confirmed exact-token DeFi use is available.
            renderIssuerCards(state.issuers);
            populateInstrumentFilter(state.tokens);
            renderComparison();
            await restoreSharedWatchFromHash();
            renderGlobalSearch();
            renderDefiUsage();
            renderComposability();
            await loadTokenPage();
            renderStatus(`${state.tokens.length} mints`);
        }

        /** The one status line, written twice: once with the issuers, once when the mints land. */
        function renderStatus(mintsPhrase) {
            const live = state.issuers.filter((issuer) => issuer.status === 'live').length;
            els.status.textContent = `${state.issuers.length} issuer programmes (${live} live), ` +
                `${mintsPhrase}. Built ${fmtDateTime(state.builtAt)}.`;
        }

        function renderComposability() {
            if (!state.composability || !Array.isArray(state.composability.templates)) return;
            const html = composabilityTemplatesHtml(state.composability, state.tokens, state.issuers);
            if (html === '') return;
            els.composabilityBody.innerHTML = html;
            const reviewed = state.composability.reviewedAt
                ? `Reviewed ${fmtDate(state.composability.reviewedAt)}. `
                : '';
            els.composabilityMethod.textContent = reviewed + (state.composability.methodology ?? '');
            els.composabilitySection.hidden = false;
        }

        function renderDefiUsage() {
            const counts = state.defiUsage?.counts;
            if (!counts || !els.defiUsageSection) return;
            const tiles = [
                ['Any confirmed use', counts.withAnyConfirmedUse],
                ['Lending / collateral', counts.withLending],
                ['Yield vault', counts.withYieldVault],
                ['DEX pool', counts.withDexPool],
                ['On-chain corroborated', counts.withOnchainCorroboration],
                ['None confirmed', counts.withNoneConfirmed]
            ];
            els.defiUsageStats.innerHTML = tiles.map(([label, value]) =>
                `<div><strong>${escapeHtml(fmtNumber(value))}</strong><span>${escapeHtml(label)}</span></div>`).join('');
            const sourceRows = defiSourceRows(state.defiUsage.sources, Date.now());
            const fresh = sourceRows.filter((row) => row.fresh).length;
            els.defiSourceCoverage.innerHTML = `<p><strong>Sources checked:</strong> ${fresh}/${sourceRows.length} current</p><ul>` +
                sourceRows.map((row) => `<li class="defi-source-${row.fresh ? 'fresh' : 'stale'}">` +
                    `<span><strong>${escapeHtml(row.label)}</strong> · ${escapeHtml(row.scope)}</span>` +
                    `<span>${row.rows === null ? '' : `${escapeHtml(fmtNumber(row.rows))} registry rows · `}` +
                    `${row.ageHours === null ? 'not collected' : escapeHtml(fmtAgeSeconds(row.ageHours * 3600))}</span></li>`).join('') +
                `</ul><p class="defi-source-note">Coverage means these sources were checked. It does not imply that unlisted protocols were checked and found empty.</p>`;
            els.defiUsageMethod.textContent = `Checked ${fmtDateTime(state.defiUsage.fetchedAt)}. ${state.defiUsage.methodology || ''}`;
            els.defiUsageSection.hidden = false;
        }

        function renderCollectorHealth(sources) {
            if (!els.collectorHealth) return;
            const health = collectorHealth(sources, Date.now());
            const rows = health.rows.map((row) => `<li class="collector-${row.fresh ? 'fresh' : 'stale'}">` +
                `<span>${escapeHtml(row.label)}</span><span>${row.ageHours === null ? 'not collected' : escapeHtml(fmtAgeSeconds(row.ageHours * 3600))}</span></li>`).join('');
            els.collectorHealth.innerHTML = `<details><summary><strong>Collector health:</strong> ` +
                `${health.fresh}/${health.total} core feeds refreshed within 48 hours` +
                `${health.healthy ? '' : ' · attention needed'}</summary><ul>${rows}</ul>` +
                `<p><a href="./monitor.html">Open the full health monitor</a></p></details>`;
        }

        function renderGlobalSearch() {
            if (!els.globalSearchResults || !els.globalSearch) return;
            const query = els.globalSearch.value;
            const profiles = new Map(state.tokens.map((token) => {
                const issuer = state.issuersBySlug.get(token.issuer) ?? {};
                const usage = state.defiUsageByMint.get(token.mint);
                const integrations = usage?.integrations ?? [];
                const template = composabilityTemplateForToken(state.composability, token);
                return [token.mint, productDecisionProfile(issuer, token, integrations, template)];
            }));
            const results = globalSearch(state.tokens, state.issuers, query, 8, profiles);
            if (!query.trim()) {
                els.globalSearchResults.innerHTML = '';
                return;
            }
            const intentLabels = [];
            if (results.intent?.filters.collateral) intentLabels.push('confirmed collateral');
            if (results.intent?.filters.redeemable) intentLabels.push('cash redemption');
            if (results.intent?.filters.noFreeze) intentLabels.push('no freeze/pause/clawback');
            if (results.intent?.filters.autonomous) intentLabels.push('autonomous liquidation');
            if (results.intent?.filters.segregated) intentLabels.push('segregated assets/direct share');
            if (results.intent?.filters.nonUs) intentLabels.push('non-US availability');
            if (results.intent?.filters.freshEvidence) intentLabels.push('fresh evidence');
            const issuerRows = results.issuers.map((issuer) => `<button type="button" data-slug="${escapeHtml(issuer.slug)}">` +
                `<strong>${escapeHtml(issuer.name)}</strong><span>issuer · ${escapeHtml(issuer.legalForm || 'legal form unknown')}</span></button>`);
            const tokenRows = results.tokens.map((token) => `<button type="button" data-mint="${escapeHtml(token.mint)}">` +
                `<strong>${escapeHtml(token.symbol || token.name || token.mint)}</strong>` +
                `<span>${escapeHtml(token.underlyingTicker || 'underlying unknown')} · ${escapeHtml((state.issuersBySlug.get(token.issuer) || {}).name || token.issuer || 'issuer unknown')}</span></button>`);
            const rows = issuerRows.concat(tokenRows);
            const intent = intentLabels.length
                ? `<p class="search-intent"><strong>Interpreted requirement:</strong> ${escapeHtml(intentLabels.join(' · '))}</p>`
                : '';
            els.globalSearchResults.innerHTML = intent + (rows.length
                ? rows.join('')
                : '<p>No product meets both the named stock/issuer and those requirements.</p>');
        }

        function renderComparison() {
            if (!els.comparisonSection || !els.comparisonUnderlying || !els.comparisonView) return;
            state.comparisonGroups = sameUnderlyingGroups(state.tokens);
            if (!state.comparisonGroups.length) {
                els.comparisonSection.hidden = true;
                return;
            }
            els.comparisonSection.hidden = false;
            els.comparisonUnderlying.innerHTML = state.comparisonGroups.map((group) =>
                `<option value="${escapeHtml(group.ticker)}">${escapeHtml(group.ticker)} · ${group.issuerCount} issuers · ${group.tokenCount} tokens</option>`
            ).join('');
            const requested = new URLSearchParams(window.location.search).get('compare')?.trim().toUpperCase();
            if (requested && state.comparisonGroups.some((group) => group.ticker === requested)) {
                els.comparisonUnderlying.value = requested;
            }
            renderComparisonTable();
        }

        function renderComparisonTable() {
            const group = state.comparisonGroups.find((item) => item.ticker === els.comparisonUnderlying.value)
                || state.comparisonGroups[0];
            if (!group) return;
            const allModels = sameStockComparisonModels(group, state.issuersBySlug, state.defiUsageByMint, state.composability);
            if (state.comparisonTicker !== group.ticker) {
                state.comparisonTicker = group.ticker;
                state.comparisonSelected = new Set(allModels.map((model) => model.issuerSlug));
            }
            state.comparisonModels = allModels;
            if (els.comparisonProducts) {
                els.comparisonProducts.innerHTML = allModels.map((model) =>
                    `<label><input type="checkbox" value="${escapeHtml(model.issuerSlug)}" ${state.comparisonSelected.has(model.issuerSlug) ? 'checked' : ''}>` +
                    `<span><strong>${escapeHtml(model.issuerName)}</strong><small>${model.tokens.length} token${model.tokens.length === 1 ? '' : 's'} · ${escapeHtml(fmtMoney(model.liquidityUsd))} liquidity</small></span></label>`
                ).join('');
            }
            if (els.comparisonFilters) {
                els.comparisonFilters.querySelectorAll('input[type="checkbox"]').forEach((input) => {
                    input.checked = state.comparisonFilters.has(input.value);
                });
            }
            const models = filterComparisonModels(allModels, state.comparisonSelected, state.comparisonFilters);
            if (els.comparisonSelectionCount) {
                els.comparisonSelectionCount.textContent = `(${models.length} shown of ${allModels.length})`;
            }
            const affected = models.filter((model) => state.reviewP0ByIssuer.has(model.issuerSlug));
            const reviewBanner = affected.length ? `<div class="comparison-review-warning"><strong>Comparison inputs under review</strong><span>${escapeHtml(affected.map((model) => model.issuerName).join(', '))} ${affected.length === 1 ? 'has' : 'have'} priority-zero evidence changes. Marked legal conclusions are provisional.</span><a href="./review.html?priority=P0">Open review queue →</a></div>` : '';
            els.comparisonView.innerHTML = reviewBanner + (models.length >= 2
                ? sameStockComparisonHtml(group, models)
                : `<div class="comparison-empty"><strong>Select at least two qualifying products.</strong><p>${models.length === 0 ? 'No product meets every active filter.' : 'Only one product remains; clear a filter or select another issuer to compare.'}</p></div>`) +
                `<section class="comparison-history"><header><div><strong>${escapeHtml(group.ticker)} observed history</strong><small>Daily measurements; gaps mean not measured. Vertical markers are evidence or control changes.</small></div><label>Metric<select class="history-metric"></select></label></header><div class="history-chart" role="status">Loading history…</div></section>`;
            loadComparisonHistory(group.ticker, new Set(models.map((model) => model.issuerSlug)));
            renderComparisonWatch(group, allModels);
        }

        async function loadComparisonHistory(ticker, selectedIssuers) {
            const panel = els.comparisonView.querySelector('.comparison-history');
            const charts = globalThis.__rwaHistoryCharts;
            if (!panel || !charts) return;
            const request = ++state.historyRequest;
            const select = panel.querySelector('.history-metric');
            const output = panel.querySelector('.history-chart');
            select.innerHTML = charts.optionsHtml('premium_pct');
            try {
                const url = apiLib.apiUrl(`/api/history/underlyings/${encodeURIComponent(ticker)}`, { days: 365 }, apiBase);
                const response = await fetch(url, { headers: { accept: 'application/json' } });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.json();
                if (request !== state.historyRequest || !panel.isConnected) return;
                const rows = (data.items ?? []).filter((row) => selectedIssuers.has(row.issuer));
                const draw = () => { output.innerHTML = charts.render(rows, data.events, select.value, { key: (row) => `${row.issuer} · ${row.symbol ?? row.mint.slice(0, 6)}` }); };
                select.addEventListener('change', draw); draw();
            } catch (_) {
                if (request === state.historyRequest && panel.isConnected) output.innerHTML = '<p class="history-empty">History is temporarily unavailable.</p>';
            }
        }

        function readComparisonWatchlist() {
            try {
                const value = JSON.parse(window.localStorage.getItem('rwa-sonar-comparisons-v1') || '{}');
                return value && typeof value === 'object' ? value : {};
            } catch (_) {
                return {};
            }
        }

        function readServerWatchCredentials() {
            try {
                const value = JSON.parse(window.localStorage.getItem('rwa-sonar-server-watches-v1') || '{}');
                return value && typeof value === 'object' ? value : {};
            } catch (_) {
                return {};
            }
        }

        function storeServerWatchCredential(ticker, credential) {
            const saved = readServerWatchCredentials();
            saved[ticker] = credential;
            window.localStorage.setItem('rwa-sonar-server-watches-v1', JSON.stringify(saved));
        }

        function sharedWatchUrl(watchId, watchKey, ticker) {
            const url = new URL(window.location.href);
            url.searchParams.set('compare', ticker);
            url.hash = `watch=${watchId}.${watchKey}`;
            return url.toString();
        }

        function showShareLink(watchId, watchKey, ticker) {
            if (!els.shareComparison) return;
            els.shareComparison.href = sharedWatchUrl(watchId, watchKey, ticker);
            els.shareComparison.hidden = false;
        }

        async function watchApi(method, path, watchKey = null, body = null) {
            if (!apiLib) throw new Error('API URL helper unavailable');
            const headers = { Accept: 'application/json' };
            if (watchKey) headers['X-Watch-Key'] = watchKey;
            if (body !== null) headers['Content-Type'] = 'application/json';
            const res = await fetch(apiLib.apiUrl(`/api${path}`, {}, apiBase), {
                method, headers, body: body === null ? undefined : JSON.stringify(body), cache: 'no-store'
            });
            const payload = res.status === 204 ? null : await res.json().catch(() => null);
            if (!res.ok) {
                const error = new Error(payload?.error?.message || `watch API returned HTTP ${res.status}`);
                error.status = res.status;
                throw error;
            }
            return payload;
        }

        function applyServerWatch(watch, watchKey) {
            if (!watch || !state.comparisonGroups.some((group) => group.ticker === watch.ticker)) return false;
            els.comparisonUnderlying.value = watch.ticker;
            state.comparisonTicker = watch.ticker;
            state.comparisonSelected = new Set(watch.issuers ?? []);
            state.comparisonFilters = new Set(watch.filters ?? []);
            state.serverWatch = { ...watch, watchKey };
            storeServerWatchCredential(watch.ticker, { watchId: watch.watchId, watchKey });
            showShareLink(watch.watchId, watchKey, watch.ticker);
            renderComparisonTable();
            return true;
        }

        async function restoreSharedWatchFromHash() {
            const match = window.location.hash.match(/^#watch=([0-9a-f-]{36})\.([A-Za-z0-9_-]{24,80})$/i);
            if (!match) return;
            try {
                const watch = await watchApi('GET', `/watchlists/${match[1]}`, match[2]);
                if (!applyServerWatch(watch, match[2])) throw new Error('the watched ticker is no longer comparable');
                els.comparisonWatchStatus.textContent = watch.changes?.length
                    ? `${watch.changes.length} material change${watch.changes.length === 1 ? '' : 's'} in the latest daily check.`
                    : watch.baselineRecorded ? 'Server watch active · no material change in the latest daily check.'
                        : 'Server watch active · its first daily baseline is pending.';
            } catch (err) {
                els.comparisonWatchStatus.className = 'watch-changed';
                els.comparisonWatchStatus.textContent = `Could not open the shared watch: ${err.message}`;
            }
        }

        function renderComparisonWatch(group, allModels) {
            if (!els.comparisonWatchStatus) return;
            if (state.serverWatch?.ticker === group.ticker) {
                const changes = state.serverWatch.changes ?? [];
                els.comparisonWatchStatus.className = changes.length ? 'watch-changed' : 'watch-current';
                els.comparisonWatchStatus.textContent = changes.length
                    ? `${changes.length} material change${changes.length === 1 ? '' : 's'} in the latest daily server check.`
                    : state.serverWatch.baselineRecorded ? 'Server watch active · no material change in the latest daily check.'
                        : 'Server watch active · its first daily baseline is pending.';
                return;
            }
            if (els.shareComparison) els.shareComparison.hidden = true;
            const saved = readComparisonWatchlist()[group.ticker];
            if (!saved) {
                els.comparisonWatchStatus.textContent = 'Not saved in this browser.';
                els.comparisonWatchStatus.className = '';
                return;
            }
            const selected = new Set(Array.isArray(saved.selected) ? saved.selected : []);
            const current = comparisonSnapshot(group.ticker, allModels.filter((model) => selected.has(model.issuerSlug)));
            const changes = comparisonSnapshotChanges(saved.snapshot, current);
            els.comparisonWatchStatus.className = changes.length ? 'watch-changed' : 'watch-current';
            els.comparisonWatchStatus.textContent = changes.length
                ? `${changes.length} material change${changes.length === 1 ? '' : 's'} since saved: ${changes.slice(0, 3).join('; ')}`
                : `Saved ${fmtRelativeTime(saved.snapshot?.savedAt)} · no material change detected.`;
        }

        async function saveCurrentComparison() {
            const ticker = state.comparisonTicker;
            if (!ticker || state.comparisonSelected.size < 2) return;
            const watchlist = readComparisonWatchlist();
            const selectedModels = state.comparisonModels.filter((model) => state.comparisonSelected.has(model.issuerSlug));
            watchlist[ticker] = {
                selected: [...state.comparisonSelected],
                snapshot: comparisonSnapshot(ticker, selectedModels)
            };
            try {
                window.localStorage.setItem('rwa-sonar-comparisons-v1', JSON.stringify(watchlist));
                renderComparisonWatch({ ticker }, state.comparisonModels);
            } catch (_) {
                els.comparisonWatchStatus.textContent = 'This browser blocked local saving.';
            }
            const body = {
                ticker,
                issuers: [...state.comparisonSelected],
                filters: [...state.comparisonFilters],
                title: `${ticker} comparison`
            };
            const existing = readServerWatchCredentials()[ticker];
            els.saveComparison.disabled = true;
            els.comparisonWatchStatus.textContent = 'Saving the cross-device watch…';
            try {
                let watch;
                let watchKey;
                if (existing?.watchId && existing?.watchKey) {
                    try {
                        watch = await watchApi('PUT', `/watchlists/${existing.watchId}`, existing.watchKey, body);
                        watchKey = existing.watchKey;
                    } catch (err) {
                        if (err.status !== 404) throw err;
                        watch = await watchApi('POST', '/watchlists', null, body);
                        watchKey = watch.watchKey;
                    }
                } else {
                    watch = await watchApi('POST', '/watchlists', null, body);
                    watchKey = watch.watchKey;
                }
                applyServerWatch(watch, watchKey);
                els.comparisonWatchStatus.textContent = watch.baselineRecorded
                    ? 'Saved on the server · included in the daily morning change check.'
                    : 'Saved on the server · the next daily check will record its baseline.';
            } catch (err) {
                els.comparisonWatchStatus.className = 'watch-changed';
                els.comparisonWatchStatus.textContent = `Saved in this browser only; server watch failed: ${err.message}`;
            } finally {
                els.saveComparison.disabled = false;
            }
        }

        async function fetchJson(path) {
            try {
                const res = await fetch(path, { cache: 'no-store' });
                if (!res.ok) return null;
                return await res.json();
            } catch (err) {
                return null;
            }
        }

        /** One chip: a link when the card exists, plain text when it does not. */
        function newMintChipHtml(chip, clone) {
            const parts = [`<span class="new-mint-symbol">${escapeHtml(chip.symbol)}</span>`];
            if (chip.issuer !== null) parts.push(`<span class="new-mint-issuer">${escapeHtml(chip.issuer)}</span>`);
            if (chip.firstSeen !== null) parts.push(`<span class="new-mint-age">first seen ${escapeHtml(chip.firstSeen)}</span>`);
            const inner = parts.join('<span aria-hidden="true">·</span>');
            const title = ` title="${escapeHtml(chip.title)}"`;
            if (chip.href === null) return `<li class="new-mint-chip"><span${title}>${inner}</span></li>`;
            // The clone exists only to make the loop seamless: it is aria-hidden, and its links are
            // taken out of the tab order so every chip is reached exactly once by keyboard.
            const tab = clone ? ' tabindex="-1"' : '';
            return `<li class="new-mint-chip"><a href="${escapeHtml(chip.href)}"${tab}${title}>${inner}</a></li>`;
        }

        /**
         * The "New on Solana" strip. Nothing to show — no file, no feed, no rows — leaves it hidden
         * and says nothing: it is a bonus on this page, not a fact it owes the reader.
         */
        function renderNewMints(changes) {
            if (!els.newMints || !els.newMintsTrack || !els.newMintsClone) return;
            const chips = newMintChips(changes, Date.now());
            if (chips.length === 0) {
                els.newMints.hidden = true;
                return;
            }
            els.newMintsTrack.innerHTML = chips.map((chip) => newMintChipHtml(chip, false)).join('');
            els.newMintsClone.innerHTML = chips.map((chip) => newMintChipHtml(chip, true)).join('');
            if (els.newMintsWindow) els.newMintsWindow.textContent = String(newMintsWindowDays(changes));
            els.newMints.hidden = false;
        }

        // --- the funnel ----------------------------------------------------

        /**
         * The funnel SVG, from the layout funnelLayout() computed. Colours come from the CSS
         * custom properties (stocks.css), so the same markup reads in both themes; every circle and
         * every connector carries a <title> for hover, and an issuer circle carries data-slug, which
         * is what the page's one click handler already turns into a dossier.
         */
        function funnelSvg(layout) {
            const parts = [
                `<svg class="funnel-svg" viewBox="0 0 ${layout.width} ${layout.height}" ` +
                `width="${layout.width}" height="${layout.height}" role="group" ` +
                'aria-label="Funnel: mints by instrument type, the issuer programmes behind them, ' +
                'the control recipes those programmes run, and the token programs holding them">'
            ];

            parts.push('<g class="funnel-edges" aria-hidden="true">');
            for (const edge of layout.edges) {
                parts.push(
                    `<path class="funnel-edge" d="${escapeHtml(edge.d)}" stroke-width="${edge.strokeWidth}">` +
                    `<title>${escapeHtml(edge.title)}</title></path>`
                );
            }
            parts.push('</g>');

            parts.push('<g class="funnel-columns">');
            for (const column of layout.columns) {
                parts.push(
                    `<text class="funnel-column-title" x="${column.labelX}" y="${column.titleY}">` +
                    `${escapeHtml(column.title)} <tspan class="funnel-column-count">${escapeHtml(fmtNumber(column.headline))}</tspan></text>`
                );
            }
            parts.push('</g>');

            parts.push('<g class="funnel-nodes">');
            for (const node of layout.nodes) {
                const classes = `funnel-node funnel-node-${escapeHtml(node.column)}${node.hollow ? ' funnel-node-hollow' : ''}`;
                const interactive = node.slug === null
                    ? ''
                    : ` class="funnel-node-link" data-slug="${escapeHtml(node.slug)}" role="button" tabindex="0"` +
                      ` aria-label="${escapeHtml(`${node.title} — open the dossier`)}"`;
                parts.push(
                    `<g class="${classes}"><g${interactive}>` +
                    `<title>${escapeHtml(node.title)}</title>` +
                    `<circle class="funnel-dot" cx="${node.x}" cy="${node.y}" r="${node.r}" />` +
                    `<text class="funnel-node-text" x="${node.textX}" y="${node.y}">${escapeHtml(node.text)}</text>` +
                    '</g></g>'
                );
            }
            parts.push('</g></svg>');

            return parts.join('');
        }

        /**
         * Nothing to draw — no funnel file, or a funnel with no nodes — hides the section instead of
         * heading an empty box with a number nobody measured. The heading itself is written from the
         * funnel's totals, never hard-coded.
         */
        function renderFunnel(funnel) {
            if (!els.funnelSection || !els.funnelGraphic) return;
            const title = funnelTitle(funnel);
            const layout = funnelLayout(funnel, {});
            if (title === null || layout.nodes.length === 0) {
                els.funnelSection.hidden = true;
                return;
            }
            if (els.funnelHeading) els.funnelHeading.textContent = title;
            els.funnelGraphic.innerHTML = funnelSvg(layout);
            els.funnelSection.hidden = false;
        }

        // --- the grid ------------------------------------------------------

        function renderGrid(issuers) {
            const labels = claimAxisLabels(issuers);
            const parts = [];

            // The row and column labels carry the ladder definition itself: role="img" plus
            // aria-label so a screen reader reads the definition rather than the bare "Level 2",
            // and the same string in title for a hover.
            for (let stage = GRID_STAGES - 1; stage >= 0; stage--) {
                const tip = escapeHtml(maturityLevelTooltip(stage));
                parts.push(
                    `<div class="grid-axis grid-axis-y" style="grid-column:1;grid-row:${GRID_STAGES - stage}">` +
                    `<span class="maturity-pill level-${stage}" role="img" title="${tip}" aria-label="${tip}">` +
                    `Level ${stage}</span></div>`
                );
            }

            for (let rung = 0; rung < GRID_RUNGS; rung++) {
                const tip = escapeHtml(claimRungTooltip(rung));
                parts.push(
                    `<div class="grid-axis grid-axis-x" style="grid-column:${rung + GRID_FIRST_DATA_COLUMN};grid-row:${GRID_LABEL_ROW}" ` +
                    `role="img" title="${tip}" aria-label="${tip}">` +
                    `<span class="grid-axis-rung">${rung}</span> ${escapeHtml(labels[rung])}</div>`
                );
            }

            const placed = new Map();
            const unplaced = [];
            for (const issuer of issuers) {
                if (issuer.status !== 'live') continue;
                const grades = issuer.grades || {};
                const cell = gridCell(grades.claimRung, grades.maturityStageNum);
                if (!cell) {
                    unplaced.push(issuer);
                    continue;
                }
                const key = `${cell.column}:${cell.row}`;
                if (!placed.has(key)) placed.set(key, { cell, issuers: [] });
                placed.get(key).issuers.push(issuer);
            }

            for (let rung = 0; rung < GRID_RUNGS; rung++) {
                for (let stage = GRID_STAGES - 1; stage >= 0; stage--) {
                    const cell = gridCell(rung, stage);
                    const key = `${cell.column}:${cell.row}`;
                    const bucket = placed.get(key);
                    const chips = bucket ? bucket.issuers.map(chipHtml).join('') : '';
                    parts.push(
                        `<div class="grid-cell${bucket ? ' grid-cell-filled' : ''}" ` +
                        `style="grid-column:${cell.column};grid-row:${cell.row}" ` +
                        `title="Claim depth ${rung} · Ledger maturity Level ${stage}">${chips}</div>`
                    );
                }
            }

            els.grid.innerHTML = parts.join('');
            renderGridLegend(issuers.filter((issuer) => issuer.status !== 'live'), unplaced);
        }

        function chipHtml(issuer) {
            const liquidity = issuer.market ? issuer.market.dexLiquidityUsd : null;
            const size = chipSize(liquidity);
            const tip = `${issuer.name} · DEX liquidity ${fmtMoney(liquidity)} · ` +
                `${fmtNumber(issuer.market && issuer.market.tokens)} mints`;
            return `<button type="button" class="grid-chip" data-slug="${escapeHtml(issuer.slug)}" ` +
                `title="${escapeHtml(tip)}">` +
                `<span class="grid-chip-dot" style="width:${size}px;height:${size}px"></span>` +
                `<span class="grid-chip-name">${escapeHtml(displayName(issuer.name, 28))}</span></button>`;
        }

        function renderGridLegend(offGrid, unplaced) {
            const items = [];
            for (const issuer of unplaced) {
                items.push(
                    `<button type="button" class="legend-chip" data-slug="${escapeHtml(issuer.slug)}" ` +
                    `title="${escapeHtml(issuer.name)} \u2014 claim depth could not be established from the documents">` +
                    `${escapeHtml(displayName(issuer.name, 32))} <span class="legend-note">claim depth unknown</span></button>`
                );
            }
            for (const issuer of offGrid) {
                items.push(
                    `<button type="button" class="legend-chip legend-chip-defunct" data-slug="${escapeHtml(issuer.slug)}" ` +
                    `title="${escapeHtml(issuer.name)} — ${escapeHtml(issuer.status)}, excluded from the grid and from every headline total">` +
                    `${escapeHtml(displayName(issuer.name, 32))} <span class="legend-note">${escapeHtml(issuer.status)}</span></button>`
                );
            }
            els.gridLegend.innerHTML = items.length
                ? `<span class="legend-label">Off the grid:</span> ${items.join('')}`
                : '';
        }

        // --- trading activity ----------------------------------------------

        /**
         * One row per live programme (MODEL §11.3). Defunct issuers are not in `activityRows` at
         * all, and a field the build has not produced renders as a dash — so the shape of the
         * table is honest about what is missing instead of printing a zero.
         */
        function renderActivityTable() {
            if (!els.activityTableBody) return;
            const rows = activityRows(state.issuers);
            const getValue = ACTIVITY_SORT_KEYS[state.activitySort.key];
            if (getValue) rows.sort(makeComparator(getValue, state.activitySort.ascending));

            renderActivitySortIndicators();
            els.activityTableBody.innerHTML = rows.length
                ? rows.map(activityRowHtml).join('')
                : '<tr><td class="token-table-message" colspan="10">No live programmes to report on.</td></tr>';

            // A build from before §11.2/§11.3 has no activity object at all; say so once rather
            // than leaving a table of dashes looking like a rendering fault.
            if (els.activityHint) {
                const anyActivity = state.issuers.some((issuer) => issuer && issuer.status === 'live' && issuer.activity);
                els.activityHint.hidden = anyActivity;
            }
        }

        function activityRowHtml(row) {
            const flagged = row.flags.length > 0;
            const badges = row.flags
                .map((flag) => `<span class="act-badge act-badge-${escapeHtml(flag.code)}" ` +
                    `title="${escapeHtml(flag.detail)}" aria-label="${escapeHtml(flag.label + ': ' + flag.detail)}">` +
                    `<span aria-hidden="true">${escapeHtml(flag.glyph)}</span> ${escapeHtml(flag.label)}</span>`)
                .join('');
            const venueTip = row.venuesTop.length
                ? row.venuesTop
                    .map((venue) => `${venue && venue.name ? venue.name : DASH} (${venue && venue.kind ? venue.kind : '?'}, ${fmtMoney(venue && venue.volume24Usd)} 24h)`)
                    .join(' · ')
                : MARKET_TOOLTIPS.venues;

            return `<tr${flagged ? ' class="activity-flagged"' : ''}>` +
                `<td class="cell-issuer"><button type="button" class="issuer-link" data-slug="${escapeHtml(row.slug)}" ` +
                `title="${escapeHtml(row.name)} — open the dossier">${escapeHtml(displayName(row.name, 30))}</button></td>` +
                `<td class="num" title="Mints with at least one trade in 24h, out of the programme’s mints">` +
                `${escapeHtml(fmtCountOfTotal(row.tokensTraded24, row.tokens))}</td>` +
                `<td class="num">${escapeHtml(fmtNumber(row.trades24))}</td>` +
                `<td class="num">${escapeHtml(fmtNumber(row.traders24))}</td>` +
                `<td class="num">${escapeHtml(fmtTradesPerTrader(row.tradesPerTrader))}</td>` +
                `<td class="num">${escapeHtml(fmtPct(row.organicSharePct))}</td>` +
                `<td class="num" title="${escapeHtml(venueTip)}">${escapeHtml(fmtNumber(row.venueCount))}</td>` +
                `<td class="num" title="${escapeHtml(MARKET_TOOLTIPS.venueSpread)}">${escapeHtml(fmtVenueSpreadPct(row.venueSpreadMedianPct))}</td>` +
                `<td title="${escapeHtml(row.lastTradedAt ? row.lastTradedAt + (row.lastTradedVenue ? ' · ' + row.lastTradedVenue : '') : MARKET_TOOLTIPS.lastTrade)}">` +
                `${escapeHtml(fmtRelativeTime(row.lastTradedAt))}</td>` +
                `<td class="cell-act-flags">${badges}</td>` +
                '</tr>';
        }

        function renderActivitySortIndicators() {
            if (!els.activityTableHead) return;
            els.activityTableHead.querySelectorAll('th[data-sort]').forEach((th) => {
                const isActive = th.getAttribute('data-sort') === state.activitySort.key;
                th.classList.toggle('sort-active', isActive);
                th.setAttribute('aria-sort', isActive ? (state.activitySort.ascending ? 'ascending' : 'descending') : 'none');
                const indicator = th.querySelector('.sort-indicator');
                if (indicator) indicator.textContent = isActive ? (state.activitySort.ascending ? ' ↑' : ' ↓') : '';
            });
        }

        // --- issuer cards --------------------------------------------------

        function renderIssuerCards(issuers) {
            const ordered = sortIssuersForDisplay(issuers);
            els.issuerCards.innerHTML = ordered.map(issuerCardHtml).join('');
            els.issuerCount.textContent = String(ordered.length);
        }

        function issuerCardHtml(issuer) {
            const grades = issuer.grades || {};
            const market = issuer.market || {};
            const control = issuer.control || {};
            const findings = Array.isArray(issuer.findings) ? issuer.findings : [];
            const attestations = Array.isArray(issuer.attestations) ? issuer.attestations : [];
            const defunct = issuer.status !== 'live';
            const stage = Number.isInteger(grades.maturityStageNum) ? grades.maturityStageNum : null;
            const worst = worstSeverity(findings);
            const verdict = laypersonVerdict({
                claimRung: grades.claimRung,
                redemptionAvailable: issuer.redemption && issuer.redemption.available,
                control
            });
            const review = legalReviewStatus(issuer);
            const p0Review = state.reviewP0ByIssuer.get(issuer.slug) ?? [];
            const issuerTokens = state.tokens.filter((token) => token.issuer === issuer.slug);
            const issuerIntegrations = issuerTokens.flatMap((token) => state.defiUsageByMint.get(token.mint)?.integrations ?? []);
            const hasCollateral = issuerIntegrations.some((entry) => entry?.category === 'lending'
                && Array.isArray(entry.actions) && entry.actions.includes('collateral'));
            const controlValues = [control.freezeAuthority, control.pausable, control.clawback];
            const hasOverride = controlValues.some(isControlOn);
            const controlsKnownOff = controlValues.every(controlExplicitlyOff);
            const health = [
                ['Market', isNum(market.dexLiquidityUsd) ? market.dexLiquidityUsd >= 50_000 ? 'healthy' : market.dexLiquidityUsd > 0 ? 'thin' : 'no depth' : 'unknown', market.dexLiquidityUsd >= 50_000 ? 'good' : isNum(market.dexLiquidityUsd) ? 'caution' : 'unknown'],
                ['Control', hasOverride ? 'issuer powers' : controlsKnownOff ? 'no override found' : 'not established', hasOverride ? 'caution' : controlsKnownOff ? 'good' : 'unknown'],
                ['Legal', p0Review.length ? 'under review' : review.pending ? 'review pending' : 'reviewed', p0Review.length || review.pending ? 'caution' : 'good'],
                ['DeFi', hasCollateral ? 'collateral live' : issuerIntegrations.length ? 'other use only' : 'none confirmed', hasCollateral ? 'good' : 'unknown']
            ];
            const healthHtml = health.map(([label, value, status]) =>
                `<span class="issuer-health issuer-health-${status}"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></span>`).join('');

            const controlBadges = [
                badge('Clawback', coverageLabel(control.clawback), coverageClass(control.clawback),
                    'A permanent delegate can move the token out of any wallet without the holder'),
                badge('Freeze', coverageLabel(control.freezeAuthority), coverageClass(control.freezeAuthority),
                    'A live freeze authority can immobilise any account'),
                badge('Pause', coverageLabel(control.pausable), coverageClass(control.pausable),
                    'The mint can be halted wholesale'),
                badge('Allowlist', coverageLabel(control.allowlist), coverageClass(control.allowlist),
                    'New accounts start frozen; a holder must be onboarded before receiving'),
                badge('Fee', fmtFeeBps(control.transferFeeBps), 'cov-neutral',
                    'Transfer-fee extension values configured on the mints (0 bps still reserves the right to charge)'),
                badge('Hook', coverageLabel(control.hookActive), coverageClass(control.hookActive),
                    'A transfer-hook program actually installed and running on transfers'),
                badge('Keys', keyGovernanceSummary(control.keyGovernance || issuer.keyGovernance), 'cov-neutral',
                    'How the mint, freeze, delegate and rebase authorities are held: multisig, program, or a plain hot wallet'),
                badge('Freeze used', freezeExercisedLabel(control.freezeExercised), freezeExercisedClass(control.freezeExercised),
                    'Whether the freeze authority has actually been exercised. "Unknown" is never "no".')
            ].join('');

            const metrics = [
                metric('Mints', fmtNumber(market.tokens)),
                metric('DEX liquidity', fmtMoney(market.dexLiquidityUsd)),
                metric('Volume 24h', fmtMoney(market.vol24Usd)),
                metric('Organic', fmtPct(market.organicSharePct)),
                metric('Holders', fmtNumber(market.holdersSum)),
                metric('Median top-10', fmtPct(market.medianTop10Pct)),
                metric('Median premium', fmtSignedPct(market.premiumMedianPct),
                    `over ${fmtNumber(market.premiumSampleSize)} mints above $50k liquidity`)
            ].join('');

            return `<article class="issuer-card${defunct ? ' issuer-card-defunct' : ''}" id="issuer-${escapeHtml(issuer.slug)}">
    <header class="issuer-card-head">
        <h3 class="issuer-name" title="${escapeHtml(issuer.name)}">${escapeHtml(displayName(issuer.name, 52))}</h3>
        ${defunct ? `<span class="status-chip">${escapeHtml(issuer.status)}</span>` : ''}
        <span class="legal-form">${escapeHtml(issuer.legalForm || 'unknown')}</span>
    </header>
    <div class="lay-verdict issuer-card-verdict">
        <span><small>What do you own?</small><strong>${escapeHtml(verdict.ownership)}</strong></span>
    </div>
    <div class="issuer-health-row" aria-label="Issuer health by dimension">${healthHtml}</div>
    ${p0Review.length ? `<p class="review-status review-p0"><strong>Under review:</strong> ${p0Review.length} priority-zero evidence change${p0Review.length === 1 ? '' : 's'} may affect these conclusions. <a href="./review.html?priority=P0&issuer=${encodeURIComponent(issuer.slug)}">Inspect them →</a></p>` : ''}
    <details class="issuer-card-more">
        <summary>Claim, evidence, controls and metrics</summary>
    <div class="lay-verdict lay-verdict-more">
        <span><small>Who must cooperate?</small>${escapeHtml(verdict.cooperation)}</span>
        <span><small>Main failure mode</small>${escapeHtml(verdict.mainFailure)}</span>
    </div>
    <p class="review-status ${review.pending ? 'review-pending' : 'review-complete'}" title="${escapeHtml(review.detail)}">${escapeHtml(review.label)} · ${escapeHtml(review.detail)}</p>
    <div class="grade-row">
        <span class="maturity-pill level-${stage === null ? 0 : stage}">${escapeHtml(grades.maturityStage || (stage === null ? DASH : 'Level ' + stage))}</span>
        <span class="grade-score" title="Sum over the ten site booleans: +1 yes, -1 no">score ${isNum(grades.maturityScore) ? (grades.maturityScore > 0 ? '+' : '') + grades.maturityScore : DASH}</span>
        <span class="claim-rung" title="What the holder legally owns (claim depth 0-4)">rung ${Number.isInteger(grades.claimRung) ? grades.claimRung : DASH} · ${escapeHtml(claimLabel(grades.claimRung, grades.claimLabel))}</span>
    </div>
    <div class="verification-row">
        ${verificationBarHtml(grades.verificationStrength)}
        <span class="verification-label">${escapeHtml(verificationLabel(grades.verificationStrength, grades.verificationLabel))}</span>
        ${grades.machineReadableVerification ? '<span class="tag-machine" title="The verification is published in a machine-readable form">machine-readable</span>' : ''}
    </div>
    <div class="badge-row">${controlBadges}</div>
    <dl class="metric-grid">${metrics}</dl>
    </details>
    <footer class="issuer-card-foot">
        <span class="count-chip" title="Positive statements by a named attestor">${attestations.length} attestation${attestations.length === 1 ? '' : 's'}</span>
        <span class="count-chip ${worst ? severityClass(worst) : 'sev-none'}" title="Observed facts, negative or neutral, recorded by rwa-sonar">${findings.length} finding${findings.length === 1 ? '' : 's'}${worst ? ' · worst: ' + escapeHtml(worst) : ''}</span>
        <button type="button" class="detail-button" data-slug="${escapeHtml(issuer.slug)}">Details</button>
    </footer>
</article>`;
        }

        function badge(label, value, cls, tip) {
            return `<span class="ctl-badge ${cls}" title="${escapeHtml(tip)}">` +
                `<span class="ctl-badge-label">${escapeHtml(label)}</span>` +
                `<span class="ctl-badge-value">${escapeHtml(value)}</span></span>`;
        }

        function metric(label, value, tip) {
            return `<div class="metric"${tip ? ` title="${escapeHtml(tip)}"` : ''}>` +
                `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
        }

        function verificationBarHtml(strength) {
            const filled = Number.isInteger(strength) && strength >= 0 ? Math.min(strength, 5) : 0;
            const cells = [];
            for (let i = 0; i < 5; i++) {
                cells.push(`<span class="ver-cell${i < filled ? ' ver-cell-on' : ''}"></span>`);
            }
            return `<span class="ver-bar" role="img" aria-label="Verification strength ${Number.isInteger(strength) ? strength : 'unknown'} of 5">` +
                cells.join('') + `</span><span class="ver-number">${Number.isInteger(strength) ? strength : DASH}/5</span>`;
        }

        function keyGovernanceSummary(keyGovernance) {
            if (!keyGovernance || typeof keyGovernance !== 'object') return DASH;
            const roles = KEY_GOVERNANCE_ROLES
                .filter((role) => typeof keyGovernance[role] === 'string' && keyGovernance[role]);
            if (!roles.length) return DASH;
            const values = roles.map((role) => KEY_GOVERNANCE_LABELS[keyGovernance[role]] || keyGovernance[role]);
            // All four held the same way is the common case; say it once rather than four times.
            if (roles.length === KEY_GOVERNANCE_ROLES.length && new Set(values).size === 1) return values[0];
            // 'r' would collide with nothing today, but mint/freeze/delegate/rebase all start on a
            // distinct letter, so the one-letter prefix stays unambiguous.
            return roles.map((role, i) => `${role[0]}:${values[i]}`).join(' ');
        }

        function freezeExercisedLabel(value) {
            if (value === 'yes') return 'yes';
            if (value === 'unknown' || value === null || value === undefined) return 'unknown';
            return String(value);
        }

        function freezeExercisedClass(value) {
            if (value === 'yes') return 'cov-all';
            return 'cov-unknown';
        }

        /** First n sentences of a long dossier field, so a card stays a card. */
        function firstSentences(text, n) {
            if (typeof text !== 'string' || !text.trim()) return 'Not documented.';
            const matches = text.trim().match(/[^.!?]+[.!?]+(\s|$)/g);
            if (!matches) return text.trim();
            return matches.slice(0, n).join('').trim();
        }

        // --- detail dialog -------------------------------------------------

        function openDetail(slug) {
            const issuer = state.issuersBySlug.get(slug);
            if (!issuer) return;
            state.openIssuerSlug = slug;
            els.detailTitle.textContent = issuer.name;
            els.detailBody.innerHTML = detailHtml(issuer);
            showDetail();
            loadWhatIf(slug);
        }

        /**
         * The what-if answers for the open panel. They are the one thing on this panel that is NOT
         * in stocks-issuers.json — 38 answers with their quotes, case citations and search records
         * are prose, and inlining them for twelve issuers would multiply the built file — so they
         * come from /api/issuers/:slug/what-if and are cached per slug for the session.
         *
         * A failure is written into the section in words. It must never look like "this issuer has
         * no answers": the API being unreachable and a researched gap are different findings.
         */
        async function loadWhatIf(slug) {
            const known = state.whatIfBySlug.get(slug);
            if (known !== undefined) {
                fillWhatIf(slug, known);
                return;
            }
            if (apiLib === null) {
                const failure = 'stocks/lib/api-base.js did not load, so this page cannot find the API';
                state.whatIfBySlug.set(slug, failure);
                fillWhatIf(slug, failure);
                return;
            }
            const url = apiLib.apiUrl(`/api/issuers/${encodeURIComponent(slug)}/what-if`, null, apiBase);
            try {
                const res = await fetch(url, { headers: { accept: 'application/json' } });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const sheet = await res.json();
                state.whatIfBySlug.set(slug, sheet);
                fillWhatIf(slug, sheet);
            } catch (err) {
                const failure = `${url} — ${err.message}`;
                console.error(`[${new Date().toISOString()}] what-if sheet for ${slug} failed: ${failure}`);
                state.whatIfBySlug.set(slug, failure);
                fillWhatIf(slug, failure);
            }
        }

        /** Writes a sheet (or a failure string) into the open panel, if that panel is still open. */
        function fillWhatIf(slug, sheet) {
            if (state.openIssuerSlug !== slug) return;
            const host = els.detailBody.querySelector('#whatIfBody');
            if (!host) return;
            host.innerHTML = typeof sheet === 'string'
                ? whatIfSectionHtml(null, state.catalogue, { failure: sheet })
                : whatIfSectionHtml(sheet, state.catalogue);
        }

        /**
         * The same dialog serves both panels, so the token detail inherits the issuer panel's
         * behaviour for free: showModal() traps focus, closes on Escape, and returns focus to the
         * row's Details button when it closes.
         */
        function showDetail() {
            els.detailBody.scrollTop = 0;
            if (typeof els.detail.showModal === 'function') els.detail.showModal();
            else els.detail.setAttribute('open', '');
        }

        function closeDetail() {
            if (typeof els.detail.close === 'function') els.detail.close();
            else els.detail.removeAttribute('open');
        }

        function detailHtml(issuer) {
            const grades = issuer.grades || {};
            const sections = [];
            const verdict = laypersonVerdict({
                claimRung: grades.claimRung,
                redemptionAvailable: issuer.redemption && issuer.redemption.available,
                control: issuer.control || {}
            });
            const review = legalReviewStatus(issuer);
            // The chip index for this panel. `documents` rides along so a claim's URL can be shown
            // under the title the dossier gave it rather than as a bare link.
            state.detailEvidence = evidenceIndex(issuer, state.claimFields);
            state.detailEvidence.documents = Array.isArray(issuer.documents) ? issuer.documents : [];
            sections.push(`<div class="lay-verdict detail-verdict"><strong>${escapeHtml(verdict.headline)}</strong>` +
                `<span>${escapeHtml(verdict.redemption)} ${escapeHtml(verdict.controlNote)}</span>` +
                `<span class="review-status ${review.pending ? 'review-pending' : 'review-complete'}">${escapeHtml(review.label)} · ${escapeHtml(review.detail)}</span></div>`);
            sections.push(evidenceLineHtml(issuer.evidence));

            const legalTemplates = (state.composability?.templates ?? [])
                .filter((template) => template?.issuer === issuer.slug);
            if (legalTemplates.length) {
                sections.push('<section class="detail-section"><h4>Technology + legal template</h4><ul class="detail-list">' +
                    legalTemplates.map((template) => `<li><a href="templates/${encodeURIComponent(template.id)}.html">` +
                        `${escapeHtml(template.legalTemplate ?? template.id)}</a>` +
                        `<div class="item-meta">${escapeHtml(template.recipe ?? '')}</div></li>`).join('') +
                    '</ul></section>');
            }

            sections.push(detailSection('Issuing entity', [
                field('Lifecycle status', issuer.status, false, 'status'),
                field('Entity', issuer.issuingEntity, false, 'issuingEntity'),
                field('Jurisdiction', issuer.entityJurisdiction, false, 'entityJurisdiction'),
                field('Governing law', issuer.governingLaw, false, 'governingLaw'),
                field('Regulatory status', issuer.regulatoryStatus, false, 'regulatoryStatus'),
                field('Legal form', issuer.legalForm, false, 'legalForm'),
                field('Claim depth', `rung ${Number.isInteger(grades.claimRung) ? grades.claimRung : DASH} — ${claimLabel(grades.claimRung, grades.claimLabel)}`),
                field('What the holder owns', issuer.holderClaim, false, 'holderClaim'),
                field('Token program (as the issuer states it)', issuer.tokenProgram, false, 'tokenProgram'),
                field('Chains', Array.isArray(issuer.chains) ? issuer.chains.join(', ') : null),
                field('Products', Array.isArray(issuer.products) ? issuer.products.join(' · ') : null),
                field('Confidence in this dossier', issuer.confidence)
            ]));

            const custody = issuer.custodyVerification || {};
            sections.push(detailSection('Custody and verification', [
                field('Underlying custodian', issuer.underlyingCustodian, false, 'underlyingCustodian'),
                field('Verification type', `${custody.type || DASH} — strength ${Number.isInteger(grades.verificationStrength) ? grades.verificationStrength : DASH}/5 (${verificationLabel(grades.verificationStrength, grades.verificationLabel)})`, false, 'custodyVerification.type'),
                field('Agent', custody.agent, false, 'custodyVerification.agent'),
                field('Frequency', custody.frequency, false, 'custodyVerification.frequency'),
                field('Machine-readable', custody.machineReadable === true ? 'yes' : custody.machineReadable === false ? 'no' : null),
                field('Endpoint', custody.endpoint),
                field('Notes', custody.notes),
                field('Evidence', linkHtml(custody.link), true)
            ]));

            const collateral = issuer.collateral || {};
            const security = issuer.securityInterest || {};
            sections.push(detailSection('Collateral', [
                field('Ratio', collateral.ratio, false, 'collateral.ratio'),
                field('Composition', collateral.composition, false, 'collateral.composition'),
                field('Rehypothecation', collateral.rehypothecation, false, 'collateral.rehypothecation'),
                field('On-loan amount disclosed', collateral.onLoanDisclosed === true ? 'yes' : collateral.onLoanDisclosed === false ? 'no' : null, false, 'collateral.onLoanDisclosed'),
                field('Security interest', security.exists === true ? 'yes' : security.exists === false ? 'no' : null, false, 'securityInterest.exists'),
                field('Security holder', security.holder, false, 'securityInterest.holder'),
                field('Priority', security.priority, false, 'securityInterest.priority'),
                field('Bankruptcy remote', issuer.bankruptcyRemote === true ? 'yes' : issuer.bankruptcyRemote === false ? 'no' : null, false, 'bankruptcyRemote')
            ]));

            const redemption = issuer.redemption || {};
            sections.push(detailSection('Redemption', [
                field('Available', redemption.available === true ? 'yes' : redemption.available === false ? 'no' : null, false, 'redemption.available'),
                field('Eligibility', redemption.eligibility, false, 'redemption.eligibility'),
                field('Rails', redemption.rails, false, 'redemption.rails'),
                field('Fees', redemption.fees, false, 'redemption.fees'),
                field('KYC', redemption.kyc, false, 'redemption.kyc'),
                field('Minimum', redemption.minimum, false, 'redemption.minimum'),
                field('Notes', redemption.notes, false, 'redemption.notes')
            ]));

            const restrictions = issuer.transferRestrictions || {};
            sections.push(detailSection('Transfer restrictions', [
                field('Allowlist', restrictions.allowlist === true ? 'yes' : restrictions.allowlist === false ? 'no' : null, false, 'transferRestrictions.allowlist'),
                field('KYC to hold', restrictions.kycToHold === true ? 'yes' : restrictions.kycToHold === false ? 'no' : null, false, 'transferRestrictions.kycToHold'),
                field('US persons excluded', restrictions.usPersonsExcluded === true ? 'yes' : restrictions.usPersonsExcluded === false ? 'no' : null, false, 'transferRestrictions.usPersonsExcluded'),
                field('Mechanism', restrictions.mechanism, false, 'transferRestrictions.mechanism')
            ]));

            sections.push(detailSection('Rights', [
                field('Dividends', issuer.dividends, false, 'dividends'),
                field('Voting', issuer.voting, false, 'voting'),
                field('Corporate actions', issuer.corporateActions, false, 'corporateActions'),
                field('Pricing reference', issuer.pricing && issuer.pricing.referenceMarket, false, 'pricing.referenceMarket'),
                field('Arbitrageable', issuer.pricing && issuer.pricing.arbitrageable === true ? 'yes' : issuer.pricing && issuer.pricing.arbitrageable === false ? 'no' : null, false, 'pricing.arbitrageable'),
                field('Pricing notes', issuer.pricing && issuer.pricing.notes, false, 'pricing.notes'),
                field('Venues', Array.isArray(issuer.venues) && issuer.venues.length ? issuer.venues.join(', ') : null)
            ]));

            const keyGovernance = issuer.keyGovernance || (issuer.control && issuer.control.keyGovernance) || {};
            sections.push(detailSection('Key governance', [
                field('Mint authority', keyGovernance.mint, false, 'keyGovernance.mint'),
                field('Freeze authority', keyGovernance.freeze, false, 'keyGovernance.freeze'),
                field('Permanent delegate', keyGovernance.delegate, false, 'keyGovernance.delegate'),
                // The fourth authority (MODEL.md §2.7): the Token-2022 scaled-UI-amount key, one
                // signature from which restates every holder's displayed balance.
                field('Rebase authority', keyGovernance.rebase, false, 'keyGovernance.rebase'),
                field('Evidence', keyGovernance.evidence)
            ]));

            // The twelve maturity questions (MODEL §3.1). They drive the grid's stage and every one
            // of them is on the claim-field list, so without this section a third of what needs a
            // source would have nowhere to show a chip. The `reason` prose rides along as the row's
            // hover title; the chip carries the quote that backs the answer.
            const vocabulary = issuer.vocabulary && typeof issuer.vocabulary === 'object'
                ? issuer.vocabulary
                : {};
            sections.push(detailSection('Ledger maturity vocabulary',
                Object.keys(vocabulary).sort().map((key) => {
                    const entry = vocabulary[key] || {};
                    const value = entry.value === null || entry.value === undefined || entry.value === ''
                        ? DASH
                        : String(entry.value);
                    return `<div class="detail-field"${entry.reason ? ` title="${escapeHtml(String(entry.reason))}"` : ''}>` +
                        `<dt>${escapeHtml(humanizeSlug(key))}</dt>` +
                        `<dd>${escapeHtml(value)}${chipFor_(`vocabulary.${key}.value`, humanizeSlug(key))}</dd></div>`;
                })));

            // The trust chain and the what-if answers (stocks/EVIDENCE.md §6). The diagram is drawn
            // from the record's own `chain`, so it is there the moment the panel opens; the answers
            // are fetched (loadWhatIf) into #whatIfBody, because 38 answers with their quotes are
            // prose the built file deliberately does not carry.
            sections.push(`<section class="detail-section" id="trustChainSection">`
                + '<h4>Trust chain</h4>'
                + `${chainSectionHtml(issuer)}</section>`);
            const modeCount = Array.isArray(state.catalogue?.failureModes)
                ? state.catalogue.failureModes.length
                : null;
            sections.push('<section class="detail-section" id="whatIfSection">'
                + `<h4>What if…${modeCount === null ? '' : ` <span class="detail-count">${modeCount}</span>`}</h4>`
                + '<div id="whatIfBody">'
                + `${whatIfSectionHtml(null, state.catalogue)}</div></section>`);

            sections.push(detailList('Documents', issuer.documents, (doc) => {
                const label = escapeHtml(doc.title || doc.url || DASH);
                const type = doc.type ? ` <span class="doc-type">${escapeHtml(doc.type)}</span>` : '';
                return isSafeUrl(doc.url)
                    ? `<a href="${escapeHtml(doc.url)}" target="_blank" rel="noopener noreferrer">${label}</a>${type}`
                    : `${label}${type}`;
            }));

            sections.push(detailList('Incidents', issuer.incidents, (incident) =>
                `<span class="item-date">${escapeHtml(fmtDate(incident.date))}</span> ${escapeHtml(incident.summary)}` +
                (isSafeUrl(incident.source) ? ` <a href="${escapeHtml(incident.source)}" target="_blank" rel="noopener noreferrer">source</a>` : '')
            ));

            sections.push(detailList('Open questions', issuer.openQuestions, (q) => escapeHtml(q)));

            sections.push(detailList('Attestations', issuer.attestations, (att) => {
                const name = escapeHtml(labelForSchema(att.schema, state.attestationTypes));
                const status = att.status ? `<span class="att-status att-status-${escapeHtml(String(att.status).toLowerCase())}">${escapeHtml(att.status)}</span>` : '';
                const link = isSafeUrl(att.link)
                    ? ` <a href="${escapeHtml(att.link)}" target="_blank" rel="noopener noreferrer">evidence</a>`
                    : '';
                return `<div class="item-head"><strong>${name}</strong> ${status}</div>` +
                    `<div class="item-meta">${escapeHtml(att.attestor || DASH)} · ${escapeHtml(fmtDate(att.attestationDate))}` +
                    `${att.onchain ? ' · on-chain' : ''}${link}</div>` +
                    (att.statement ? `<div class="item-body">${escapeHtml(att.statement)}</div>` : '');
            }));

            sections.push(detailList('Findings', issuer.findings, (finding) => {
                const name = escapeHtml(labelForSchema(finding.schema, state.findingTypes));
                const sev = `<span class="sev-chip ${severityClass(finding.severity)}">${escapeHtml(finding.severity || 'unknown')}</span>`;
                const evidence = isSafeUrl(finding.evidence)
                    ? ` <a href="${escapeHtml(finding.evidence)}" target="_blank" rel="noopener noreferrer">evidence</a>`
                    : finding.evidence ? ` <code>${escapeHtml(finding.evidence)}</code>` : '';
                return `<div class="item-head">${sev} <strong>${name}</strong></div>` +
                    (finding.statement ? `<div class="item-body">${escapeHtml(finding.statement)}</div>` : '') +
                    `<div class="item-meta">${escapeHtml(finding.observer || DASH)} · ${escapeHtml(fmtDate(finding.observedAt))}${evidence}</div>`;
            }));

            sections.push(detailList('Sources', issuer.sources, (src) =>
                isSafeUrl(src)
                    ? `<a href="${escapeHtml(src)}" target="_blank" rel="noopener noreferrer">${escapeHtml(src)}</a>`
                    : escapeHtml(src)
            ));

            return sections.filter(Boolean).join('');
        }

        function detailSection(title, fields) {
            const rows = fields.filter(Boolean).join('');
            if (!rows) return '';
            return `<section class="detail-section"><h4>${escapeHtml(title)}</h4><dl class="detail-fields">${rows}</dl></section>`;
        }

        /**
         * The evidence chip for one dossier field path, or '' when the open panel has no chip index
         * (the token panel) or the field neither carries nor needs a claim. `path` is the dotted
         * dossier path, e.g. `redemption.rails` — the same string a claim names.
         */
        function chipFor_(path, label) {
            if (!path || !state.detailEvidence) return '';
            return fieldChipHtml(state.detailEvidence, path, label);
        }

        /** One dt/dd pair, dropped entirely when the dossier has nothing for it. */
        function field(label, value, isHtml, path) {
            if (value === null || value === undefined || value === '' || value === DASH) return '';
            return `<div class="detail-field"><dt>${escapeHtml(label)}</dt>` +
                `<dd>${isHtml ? value : escapeHtml(String(value))}${chipFor_(path, label)}</dd></div>`;
        }

        /** Like field(), but keeps the row and prints a dash: for a field whose absence is news. */
        function fieldAlways(label, value, tip, path) {
            const text = value === null || value === undefined || value === '' ? DASH : String(value);
            return `<div class="detail-field"${tip ? ` title="${escapeHtml(tip)}"` : ''}>` +
                `<dt>${escapeHtml(label)}</dt>` +
                `<dd>${escapeHtml(text)}${chipFor_(path, label)}</dd></div>`;
        }

        function linkHtml(url) {
            if (!isSafeUrl(url)) return '';
            return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
        }

        function detailList(title, items, renderItem) {
            if (!Array.isArray(items) || !items.length) {
                return `<section class="detail-section"><h4>${escapeHtml(title)}</h4>` +
                    `<p class="detail-empty">None recorded.</p></section>`;
            }
            const rendered = items
                .filter((item) => item !== null && item !== undefined && item !== '')
                .map((item) => `<li>${renderItem(item)}</li>`)
                .join('');
            return `<section class="detail-section"><h4>${escapeHtml(title)} <span class="detail-count">${items.length}</span></h4>` +
                `<ul class="detail-list">${rendered}</ul></section>`;
        }

        // --- token detail dialog -------------------------------------------

        async function openTokenDetail(mint) {
            const token = state.tokensByMint.get(mint);
            if (!token) return;
            const title = token.symbol
                ? `${token.symbol}${token.name ? ' — ' + token.name : ''}`
                : (token.name || token.mint);
            els.detailTitle.innerHTML = `${escapeHtml(title)} ${cardLinkHtml(token)}`;
            state.openTokenMint = mint;
            // This panel shows on-chain and market readings, not a dossier, so no issuer's answer
            // sheet belongs in it — and a sheet still in flight must not be written over it.
            state.openIssuerSlug = null;
            els.detailBody.innerHTML = tokenDetailHtml(token);
            showDetail();

            // Per-mint venue detail is its own 700 kB file (MODEL §10.3) and only the panel needs
            // it, so it is fetched on the first panel open and the body is re-rendered when it
            // lands — unless the token record already carries its venues inline.
            if (!tokenVenueSource(token) && !state.venuesLoaded) {
                await loadVenues();
                if (state.openTokenMint === mint && els.detail.open) {
                    els.detailBody.innerHTML = tokenDetailHtml(token);
                }
            }
        }

        /** Venues from the token record when the build embeds them, else from venues.json. */
        function tokenVenueSource(token) {
            if (token.venues) return token.venues;
            if (token.venueDetail) return token.venueDetail;
            if (token.activity && token.activity.venues) return token.activity.venues;
            return state.venuesByMint ? state.venuesByMint.get(token.mint) || null : null;
        }

        async function loadVenues() {
            state.venuesLoaded = true;
            const db = await fetchJson(VENUES_PATH);
            const items = db && Array.isArray(db.items) ? db.items : [];
            state.venuesByMint = new Map(items
                .filter((item) => item && typeof item.mint === 'string')
                .map((item) => [item.mint, item]));
        }

        /** A control flag: an address counts as "on" exactly as MODEL §3.3 reads it. */
        function controlValue(value) {
            if (value === true) return 'yes';
            if (value === false) return 'no';
            if (typeof value === 'string' && value.trim()) return `yes · ${value.trim()}`;
            return null;
        }

        function tokenDetailHtml(token) {
            // A token panel shows on-chain and market readings, not dossier claims, so no chip is
            // drawn here — and leaving a stale index in place would draw the previous ISSUER's.
            state.detailEvidence = null;
            const market = token.market || {};
            const reference = token.reference || {};
            const control = token.control || {};
            const activity = token.activity || {};
            const issuer = state.issuersBySlug.get(token.issuer);
            const sections = [];

            if (issuer) {
                const verdict = laypersonVerdict({
                    claimRung: issuer.grades && issuer.grades.claimRung,
                    redemptionAvailable: issuer.redemption && issuer.redemption.available,
                    control: token.control || issuer.control || {}
                });
                const review = legalReviewStatus(issuer);
                sections.push(`<div class="lay-verdict detail-verdict"><strong>${escapeHtml(verdict.headline)}</strong>` +
                    `<span>${escapeHtml(verdict.redemption)} ${escapeHtml(verdict.controlNote)}</span>` +
                    `<span class="review-status ${review.pending ? 'review-pending' : 'review-complete'}">${escapeHtml(review.label)} · ${escapeHtml(review.detail)}</span></div>`);
            }

            sections.push(detailSection('Identity & on-chain', [
                field('Mint', `<code>${escapeHtml(token.mint)}</code>`, true),
                field('Symbol', token.symbol),
                field('Name', token.name),
                field('Issuer programme', issuer ? issuer.name : token.issuer),
                field('Underlying ticker', token.underlyingTicker),
                field('Instrument', token.instrumentType ? humanizeSlug(token.instrumentType) : null),
                field('Token program', token.tokenProgram ? `<code>${escapeHtml(token.tokenProgram)}</code>` : null, true),
                field('Decimals', isNum(token.decimals) ? String(token.decimals) : null),
                field('Supply (UI-adjusted)', isNum(token.supplyUi)
                    ? `${fmtNumber(token.supplyUi, 2)}${isNum(token.uiMultiplier) && token.uiMultiplier !== 1 ? ` · scaled-UI multiplier ${fmtNumber(token.uiMultiplier, 2)}` : ''}`
                    : null),
                field('Listed on Jupiter', token.listedOnJupiter === true ? 'yes' : token.listedOnJupiter === false ? 'no' : null),
                field('Clawback (permanent delegate)', controlValue(control.clawback)),
                field('Freeze authority', controlValue(control.freezeAuthority)),
                field('Pausable', controlValue(control.pausable)),
                field('Paused now', controlValue(control.paused)),
                field('Allowlist (default frozen)', controlValue(control.allowlist)),
                field('Transfer fee', isNum(control.transferFeeBps) ? `${control.transferFeeBps} bps` : null),
                field('Transfer hook', controlValue(control.hookActive)),
                field('Metadata URI', linkHtml(token.metadataUri), true)
            ]));

            sections.push(detailSection('Market', [
                field('Price', fmtPrice(market.usdPrice)),
                field('Market cap', fmtMoney(market.mcap)),
                field('Liquidity (DEX pool reserves)', fmtMoney(market.liquidity)),
                field('Volume 24h', fmtMoney(market.vol24)),
                field('Organic volume 24h', fmtMoney(market.organicVol24)),
                field('Organic share', fmtPct(market.organicSharePct)),
                field('Holders', fmtNumber(market.holderCount)),
                field('Top-10 share of supply', fmtPct(market.top10HolderPct)),
                field('First pool', fmtDateTime(market.firstPoolAt))
            ]));

            const flagBadges = activityFlags({
                tradesPerTrader: activity.tradesPerTrader,
                organicSharePct: isNum(activity.organicSharePct) ? activity.organicSharePct : market.organicSharePct
            });
            // No activity record at all is its own statement, and a section of dashes would hide it.
            sections.push(!token.activity ? detailSection('Trading activity (24h)', [
                field('Collected', 'Nothing yet — this mint has no activity record in the build.')
            ]) : detailSection('Trading activity (24h)', [
                field('Buys', fmtNumber(activity.buys24)),
                field('Sells', fmtNumber(activity.sells24)),
                field('Trades', fmtNumber(activity.trades24)),
                field('Traders', fmtNumber(activity.traders24)),
                field('Organic buyers', fmtNumber(activity.organicBuyers24)),
                field('Trades per trader', fmtTradesPerTrader(activity.tradesPerTrader)),
                field('DEX pairs', fmtNumber(activity.dexPairs)),
                field('DEX transactions', fmtNumber(activity.dexTxns24)),
                field('CEX markets', fmtNumber(activity.cexMarkets)),
                field('Venues', fmtNumber(activity.venueCount)),
                fieldAlways('Venue spread', fmtVenueSpread(activity), MARKET_TOOLTIPS.venueSpread),
                field('Last trade', activity.lastTradedAt
                    ? `${fmtRelativeTime(activity.lastTradedAt)} · ${escapeHtml(activity.lastTradedAt)}${activity.lastTradedVenue ? ' · ' + escapeHtml(activity.lastTradedVenue) : ''}`
                    : null, true),
                flagBadges.length
                    ? field('Flags', flagBadges.map((flag) =>
                        `<span class="act-badge act-badge-${escapeHtml(flag.code)}" title="${escapeHtml(flag.detail)}">` +
                        `<span aria-hidden="true">${escapeHtml(flag.glyph)}</span> ${escapeHtml(flag.label)}</span>`).join(' '), true)
                    : ''
            ]));

            sections.push(defiUsageDetailHtml(
                state.defiUsageByMint.get(token.mint) ?? null,
                state.defiUsage?.fetchedAt ?? null,
                composabilityTemplateForToken(state.composability, token),
                issuer
            ));

            sections.push(venuesSectionHtml(token));

            sections.push(detailSection('Reference', [
                field('Source', reference.source),
                field('Reference price', fmtPrice(reference.price)),
                field('Premium', fmtSignedPct(reference.premiumPct)),
                field('Underlying market', reference.marketOpen === true ? 'open' : reference.marketOpen === false ? 'closed' : null),
                field('Reference age', fmtAgeSeconds(reference.ageSeconds)),
                field('Note', reference.note)
            ]));

            return sections.filter(Boolean).join('');
        }

        /** Every DEX pair and CEX market this mint trades on, busiest first, each one linked. */
        function venuesSectionHtml(token) {
            const rows = venueRows(tokenVenueSource(token));
            if (!rows.length) {
                return '<section class="detail-section"><h4>Venues</h4>' +
                    `<p class="detail-empty">${state.venuesLoaded
                        ? 'None collected. Venues come from DexScreener pairs and CoinGecko tickers; a mint ' +
                        'with no pool and no exchange listing has neither.'
                        : 'Loading venue detail…'}</p></section>`;
            }
            const body = rows.map((row) => {
                const name = escapeHtml(row.name);
                const label = row.url
                    ? `<a href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">${name}</a>`
                    : name;
                return '<tr>' +
                    `<td><span class="venue-kind venue-kind-${row.kind}">${row.kind}</span> ${label}</td>` +
                    `<td${row.pairFull && row.pairFull !== row.pair ? ` title="${escapeHtml(row.pairFull)}"` : ''}>` +
                    `${escapeHtml(row.pair || DASH)}</td>` +
                    `<td class="num">${escapeHtml(fmtPrice(row.priceUsd))}</td>` +
                    `<td class="num">${escapeHtml(fmtMoney(row.liquidityUsd))}</td>` +
                    `<td class="num">${escapeHtml(fmtMoney(row.volume24Usd))}</td>` +
                    `<td class="num">${escapeHtml(fmtNumber(row.txns24))}</td>` +
                    `<td title="${escapeHtml(row.lastTradedAt || '')}">${escapeHtml(fmtRelativeTime(row.lastTradedAt))}</td>` +
                    '</tr>';
            }).join('');
            return `<section class="detail-section"><h4>Venues <span class="detail-count">${rows.length}</span></h4>` +
                '<div class="venue-wrap"><table class="venue-table"><thead><tr>' +
                '<th scope="col">Venue</th><th scope="col">Pair</th><th scope="col">Price</th>' +
                '<th scope="col">Liquidity</th>' +
                '<th scope="col">Vol 24h</th><th scope="col">Trades 24h</th><th scope="col">Last trade</th>' +
                `</tr></thead><tbody>${body}</tbody></table></div></section>`;
        }

        // --- token table ---------------------------------------------------

        /** From the issuer file: one option per programme, in the card order. */
        function populateIssuerFilter(issuers) {
            els.filterIssuer.insertAdjacentHTML('beforeend', sortIssuersForDisplay(issuers)
                .map((issuer) => `<option value="${escapeHtml(issuer.slug)}">${escapeHtml(displayName(issuer.name, 40))}</option>`)
                .join(''));
        }

        /** From the token file: the instrument types actually present in the mints. */
        function populateInstrumentFilter(tokens) {
            const types = [...new Set(tokens.map((t) => t.instrumentType).filter(Boolean))].sort();
            els.filterInstrument.insertAdjacentHTML('beforeend', types
                .map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(humanizeSlug(type))}</option>`)
                .join(''));
        }

        /** A loading or error line in place of the rows, spanning the table's own column count. */
        function tokenTableMessage(text) {
            const columns = els.tokenTableHead.querySelectorAll('th').length || 1;
            els.tokenTableBody.innerHTML =
                `<tr><td class="token-table-message" colspan="${columns}">${escapeHtml(text)}</td></tr>`;
        }

        function localTokenPage() {
            const rows = filterTokens(state.tokens, state.filters);
            const getValue = SORT_KEYS[state.sort.key];
            if (getValue) rows.sort(makeComparator(getValue, state.sort.ascending));
            const paging = tokenPageMath(rows.length, state.tokenPage);
            state.tokenPage = paging.page;
            return { rows: rows.slice(paging.offset, paging.offset + TOKEN_PAGE_SIZE), total: rows.length };
        }

        async function loadTokenPage() {
            renderSortIndicators();
            if (!state.tokensLoaded) return;
            const request = ++state.tokenRequestSeq;
            tokenTableMessage('Loading this page of mints…');

            if (state.useSample) {
                const local = localTokenPage();
                state.tokenRows = local.rows;
                state.tokenTotal = local.total;
                renderTokenTable();
                return;
            }

            try {
                if (apiLib === null) throw new Error('API URL helper unavailable');
                const params = tokenApiParams(state.filters, state.sort, state.tokenPage);
                const url = apiLib.apiUrl('/api/tokens', params, apiBase);
                const res = await fetch(url, { cache: 'no-store' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const body = await res.json();
                if (request !== state.tokenRequestSeq) return;
                state.tokenRows = (Array.isArray(body?.items) ? body.items : []).map(tokenFromApiRow);
                state.tokenTotal = Number(body?.total) || 0;
            } catch (err) {
                if (request !== state.tokenRequestSeq) return;
                console.error(`[${new Date().toISOString()}] stocks: /api/tokens unavailable`, err);
                state.tokenRows = [];
                state.tokenTotal = 0;
                tokenTableMessage('The mint table is unavailable because the API request failed.');
                els.tokenCount.textContent = 'Mint API unavailable';
                els.tokenPager.hidden = true;
                els.tokenPageLabel.textContent = 'Unavailable';
                els.tokenPrev.disabled = true;
                els.tokenNext.disabled = true;
                return;
            }
            renderTokenTable();
        }

        function renderTokenTable() {
            renderSortIndicators();
            if (!state.tokensLoaded) return;
            const paging = tokenPageMath(state.tokenTotal, state.tokenPage);
            state.tokenPage = paging.page;
            els.tokenTableBody.innerHTML = state.tokenRows.length
                ? state.tokenRows.map(tokenRowHtml).join('')
                : `<tr><td class="token-table-message" colspan="${els.tokenTableHead.querySelectorAll('th').length}">No mints match these filters.</td></tr>`;
            els.tokenCount.textContent = state.useSample
                ? `${paging.total} mints · bundled sample`
                : `${paging.total} mints · API-backed`;
            els.tokenPager.hidden = paging.total <= TOKEN_PAGE_SIZE;
            els.tokenPageLabel.textContent = paging.total === 0
                ? 'No matches'
                : `${paging.from}–${paging.to} of ${paging.total} · page ${paging.page} of ${paging.pages}`;
            els.tokenPrev.disabled = !paging.hasPrev;
            els.tokenNext.disabled = !paging.hasNext;
        }

        function renderSortIndicators() {
            els.tokenTableHead.querySelectorAll('th[data-sort]').forEach((th) => {
                const isActive = th.getAttribute('data-sort') === state.sort.key;
                th.classList.toggle('sort-active', isActive);
                const indicator = th.querySelector('.sort-indicator');
                if (indicator) indicator.textContent = isActive ? (state.sort.ascending ? ' ↑' : ' ↓') : '';
            });
        }

        function tokenRowHtml(token) {
            const market = token.market || {};
            const reference = token.reference || {};
            const control = token.control || {};
            const issuer = state.issuersBySlug.get(token.issuer);
            const defunct = issuer && issuer.status !== 'live';
            const premium = reference.premiumPct;
            const premiumClass = !isNum(premium) ? '' : premium > 0 ? ' num-up' : premium < 0 ? ' num-down' : '';

            const flags = TOKEN_FLAGS
                .filter(([prop]) => isControlOn(control[prop]))
                .map(([, glyph, tip]) => `<abbr class="flag" title="${escapeHtml(tip)}">${glyph}</abbr>`);
            if (isNum(control.transferFeeBps) && control.transferFeeBps > 0) {
                flags.push(`<abbr class="flag" title="Transfer fee of ${control.transferFeeBps} bps charged on chain">%</abbr>`);
            }
            if (control.paused === true) {
                flags.push('<abbr class="flag flag-alert" title="This mint is paused right now: transfers are halted">||</abbr>');
            }

            const activity = token.activity || {};

            return `<tr class="token-row${defunct ? ' asset-defunct' : ''}" data-mint="${escapeHtml(token.mint)}">` +
                `<td class="cell-token"><span class="token-symbol">${escapeHtml(token.symbol || DASH)}</span>` +
                cardLinkHtml(token) +
                `<span class="token-name">${escapeHtml(token.name || '')}</span></td>` +
                `<td title="${escapeHtml(issuer ? issuer.name : '')}">${escapeHtml(issuer ? displayName(issuer.name, 28) : token.issuer || DASH)}</td>` +
                `<td>${escapeHtml(token.underlyingTicker || DASH)}</td>` +
                `<td>${escapeHtml(humanizeSlug(token.instrumentType))}</td>` +
                `<td class="num">${escapeHtml(fmtPrice(market.usdPrice))}</td>` +
                `<td class="cell-ref"><span class="ref-source">${escapeHtml(reference.source || 'none')}</span>` +
                `<span class="ref-price">${escapeHtml(fmtPrice(reference.price))}</span></td>` +
                `<td class="num${premiumClass}">${escapeHtml(fmtSignedPct(premium))}</td>` +
                `<td class="num">${escapeHtml(fmtMoney(market.liquidity))}</td>` +
                `<td class="num">${escapeHtml(fmtMoney(market.vol24))}</td>` +
                `<td class="num">${escapeHtml(fmtPct(market.organicSharePct))}</td>` +
                `<td class="num">${escapeHtml(fmtNumber(activity.trades24))}</td>` +
                `<td class="num">${escapeHtml(fmtNumber(activity.traders24))}</td>` +
                `<td class="num" title="${escapeHtml(fmtVenueSpread(activity) === DASH ? MARKET_TOOLTIPS.venueSpread : fmtVenueSpread(activity))}">` +
                `${escapeHtml(fmtVenueSpreadPct(activity.venueSpreadPct))}</td>` +
                `<td class="num">${escapeHtml(fmtNumber(market.holderCount))}</td>` +
                `<td class="num">${escapeHtml(fmtPct(market.top10HolderPct))}</td>` +
                `<td title="${escapeHtml(activity.lastTradedAt || MARKET_TOOLTIPS.lastTrade)}">` +
                `${escapeHtml(fmtRelativeTime(activity.lastTradedAt))}</td>` +
                `<td class="cell-defi">${defiUsageCompactHtml(state.defiUsageByMint.get(token.mint) ?? null)}</td>` +
                `<td class="cell-flags">${flags.join('')}</td>` +
                `<td class="cell-detail"><button type="button" class="row-detail" data-mint="${escapeHtml(token.mint)}" ` +
                `aria-label="Details for ${escapeHtml(token.symbol || token.mint)}">Details</button></td>` +
                '</tr>';
        }

        // --- events --------------------------------------------------------

        function wireEvents() {
            // Evidence chips. `toggle` does not bubble, so the listener is CAPTURING — which does
            // reach a non-bubbling event on a descendant, and survives every re-render of the
            // panel body (an element-level listener would not). Two jobs: keep one popover open at
            // a time, and scroll it into view, because the panel body is a scroll container and a
            // popover on a field near its bottom edge would otherwise be clipped by it.
            els.detailBody.addEventListener('toggle', (event) => {
                const chip = event.target;
                if (!chip.classList || !chip.classList.contains('ev-chip') || !chip.open) return;
                for (const other of els.detailBody.querySelectorAll('details.ev-chip[open]')) {
                    if (other !== chip) other.open = false;
                }
                const pop = chip.querySelector('.ev-pop');
                // Instant, not smooth: an agent (or a test) cannot observe a scroll animation,
                // and there is nothing here worth animating.
                if (pop) pop.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }, true);

            // Tapping a lane in the trust-chain diagram opens that flow's row in the list below it,
            // which is where its summary and fields are. The list is the accessible copy and works
            // on its own, so this only shortens the journey; the lane's own <title> still gives the
            // one-line hover.
            els.detailBody.addEventListener('click', (event) => {
                const lane = event.target.closest ? event.target.closest('g.tc-lane[data-flow]') : null;
                if (!lane) return;
                const flow = lane.getAttribute('data-flow');
                // Catalogue ids are slugs; anything else is not looked up rather than interpolated
                // into a selector.
                if (!SLUG_SAFE.test(flow || '')) return;
                const row = els.detailBody.querySelector(`details.tc-flow[data-flow="${flow}"]`);
                if (!row) return;
                row.open = true;
                row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            });

            document.addEventListener('click', (event) => {
                // A "Card ↗" link sits inside a row that is itself a [data-mint] trigger, so the
                // link has to be let through or the dialog opens over the navigation.
                if (event.target.closest('a.card-link')) return;
                // data-mint before data-slug: a token row's Details button sits inside a table
                // whose issuer column carries no slug, but the order makes the intent explicit.
                const mintTrigger = event.target.closest('[data-mint]');
                if (mintTrigger) {
                    openTokenDetail(mintTrigger.getAttribute('data-mint'));
                    return;
                }
                const trigger = event.target.closest('[data-slug]');
                if (trigger) {
                    openDetail(trigger.getAttribute('data-slug'));
                    return;
                }
                const th = event.target.closest('#tokenTable th[data-sort]');
                if (th) {
                    const key = th.getAttribute('data-sort');
                    if (state.sort.key === key) state.sort.ascending = !state.sort.ascending;
                    else state.sort = { key, ascending: false };
                    state.tokenPage = 1;
                    loadTokenPage();
                    return;
                }
                const activityTh = event.target.closest('#activityTable th[data-sort]');
                if (activityTh) {
                    const key = activityTh.getAttribute('data-sort');
                    if (state.activitySort.key === key) state.activitySort.ascending = !state.activitySort.ascending;
                    else state.activitySort = { key, ascending: key !== 'issuer' ? false : true };
                    renderActivityTable();
                }
            });

            // The funnel's issuer circles are SVG groups, not buttons, so Enter and Space have to be
            // wired by hand; the click itself is already handled by the [data-slug] delegate above.
            if (els.funnelGraphic) {
                els.funnelGraphic.addEventListener('keydown', (event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    const trigger = event.target.closest('[data-slug]');
                    if (!trigger) return;
                    event.preventDefault();
                    openDetail(trigger.getAttribute('data-slug'));
                });
            }

            els.detailClose.addEventListener('click', closeDetail);
            // Clicking the backdrop: the dialog element itself is the only hit target outside the panel.
            els.detail.addEventListener('click', (event) => {
                if (event.target === els.detail) closeDetail();
            });

            els.filterIssuer.addEventListener('change', () => {
                state.filters.issuer = els.filterIssuer.value;
                state.tokenPage = 1;
                loadTokenPage();
            });
            els.filterInstrument.addEventListener('change', () => {
                state.filters.instrumentType = els.filterInstrument.value;
                state.tokenPage = 1;
                loadTokenPage();
            });
            els.globalSearch.addEventListener('input', () => {
                const parsed = parseStockSearch(els.globalSearch.value);
                // The global results apply capability intent. The paged API receives only the
                // identity words it understands, so “NVIDIA usable as collateral” still opens the
                // NVIDIA rows instead of trying to match that whole sentence literally.
                state.filters.query = parsed.terms.join(' ');
                renderGlobalSearch();
                state.tokenPage = 1;
                if (tokenSearchTimer !== null) clearTimeout(tokenSearchTimer);
                tokenSearchTimer = setTimeout(() => {
                    tokenSearchTimer = null;
                    loadTokenPage();
                }, 150);
            });
            els.tokenPrev.addEventListener('click', () => {
                state.tokenPage = Math.max(1, state.tokenPage - 1);
                loadTokenPage();
            });
            els.tokenNext.addEventListener('click', () => {
                state.tokenPage += 1;
                loadTokenPage();
            });
            if (els.toggleTokenColumns && els.tokenTable) {
                els.toggleTokenColumns.addEventListener('click', () => {
                    const simple = els.tokenTable.classList.toggle('token-table-simple');
                    els.toggleTokenColumns.setAttribute('aria-pressed', simple ? 'false' : 'true');
                    els.toggleTokenColumns.textContent = simple ? 'Show full market detail' : 'Show simpler table';
                });
            }
            els.comparisonUnderlying.addEventListener('change', () => {
                const url = new URL(window.location.href);
                url.searchParams.set('compare', els.comparisonUnderlying.value);
                window.history.replaceState(null, '', url);
                renderComparisonTable();
            });
            if (els.comparisonProducts) {
                els.comparisonProducts.addEventListener('change', (event) => {
                    const input = event.target.closest('input[type="checkbox"]');
                    if (!input) return;
                    if (input.checked) state.comparisonSelected.add(input.value);
                    else state.comparisonSelected.delete(input.value);
                    renderComparisonTable();
                });
            }
            if (els.comparisonFilters) {
                els.comparisonFilters.addEventListener('change', (event) => {
                    const input = event.target.closest('input[type="checkbox"]');
                    if (!input) return;
                    if (input.checked) state.comparisonFilters.add(input.value);
                    else state.comparisonFilters.delete(input.value);
                    renderComparisonTable();
                });
            }
            if (els.clearComparisonFilters) {
                els.clearComparisonFilters.addEventListener('click', () => {
                    state.comparisonFilters.clear();
                    els.comparisonFilters.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = false; });
                    renderComparisonTable();
                });
            }
            if (els.saveComparison) els.saveComparison.addEventListener('click', saveCurrentComparison);
            if (els.shareComparison) {
                els.shareComparison.addEventListener('click', async (event) => {
                    event.preventDefault();
                    try {
                        await navigator.clipboard.writeText(els.shareComparison.href);
                        els.comparisonWatchStatus.textContent = 'Cross-device watch link copied. Anyone with this link can edit the watch.';
                    } catch (_) {
                        window.prompt('Copy this cross-device watch link:', els.shareComparison.href);
                    }
                });
            }
        }
    });
}
