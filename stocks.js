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
    mintSuffix
} = fmt;

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
    unknown: 'unknown'
};

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

/** Case-insensitive match of a query against a token's symbol, name and underlying ticker. */
function tokenMatchesQuery(token, query) {
    const q = String(query === null || query === undefined ? '' : query).trim().toLowerCase();
    if (!q) return true;
    if (!token) return false;
    const haystack = [token.symbol, token.name, token.underlyingTicker]
        .filter((part) => typeof part === 'string' && part)
        .join(' ')
        .toLowerCase();
    return haystack.includes(q);
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

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        DASH,
        CARDS_DIR,
        NEW_MINTS_WINDOW_DAYS,
        newMintChips,
        newMintsWindowDays,
        CLAIM_LABELS,
        VERIFICATION_LABELS,
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
        sortIssuersForDisplay,
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
        venueRows
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

        const BUILD_HINT = 'Build it with "npm run stocks:all && npm run stocks:build"';

        const state = {
            builtAt: null,
            issuers: [],
            issuersBySlug: new Map(),
            tokens: [],
            tokensByMint: new Map(),
            tokensLoaded: false,
            venuesByMint: null,
            venuesLoaded: false,
            openTokenMint: null,
            findingTypes: Object.create(null),
            attestationTypes: Object.create(null),
            filters: { issuer: '', instrumentType: '', query: '' },
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
            filterIssuer: document.getElementById('filterIssuer'),
            filterInstrument: document.getElementById('filterInstrument'),
            filterSearch: document.getElementById('filterSearch'),
            detail: document.getElementById('detailDialog'),
            detailBody: document.getElementById('detailBody'),
            detailTitle: document.getElementById('detailTitle'),
            detailClose: document.getElementById('detailClose')
        };

        // Reduced motion is an accessibility setting first and the test hook second: the only thing
        // that moves on this page is the "New on Solana" ticker, and the class turns it into a
        // static wrapping row (stocks.css). ?reduceMotion=1 forces the same for a driver that
        // cannot emulate the media query. Same class name live.js uses.
        const reduceMotion = new URLSearchParams(window.location.search).has('reduceMotion')
            || (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        if (reduceMotion) document.body.classList.add('reduce-motion');

        loadPage();

        /**
         * Two passes, in the order the page is read: the issuer file (grid, cards, issuer filter),
         * then the token file (the table). The second fetch only starts once the first has been
         * rendered, so the smaller file is never slowed down by the larger one.
         */
        async function loadPage() {
            const useSample = new URLSearchParams(window.location.search).get('db') === 'sample';
            const issuersPath = useSample ? SAMPLE_ISSUERS_PATH : ISSUERS_PATH;
            const tokensPath = useSample ? SAMPLE_TOKENS_PATH : TOKENS_PATH;

            tokenTableMessage('Loading mints…');
            els.tokenCount.textContent = 'loading…';

            // The change log and the funnel are two more small files (~30 kB and ~7 kB) feeding one
            // section each, so they are fetched alongside the issuers and their absence is not an
            // error — the section hides itself. Neither has a sample fixture, so ?db=sample skips
            // both rather than mixing three live mints into twelve fixture ones.
            const [issuerDb, findingTypes, attestationTypes, changes, funnel] = await Promise.all([
                fetchJson(issuersPath),
                fetchJson('./finding-types.json'),
                fetchJson('./attestation-types.json'),
                useSample ? Promise.resolve(null) : fetchJson(CHANGES_PATH),
                useSample ? Promise.resolve(null) : fetchJson(FUNNEL_PATH)
            ]);

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
            populateInstrumentFilter(state.tokens);
            renderTokenTable();
            renderStatus(`${state.tokens.length} mints`);
        }

        /** The one status line, written twice: once with the issuers, once when the mints land. */
        function renderStatus(mintsPhrase) {
            const live = state.issuers.filter((issuer) => issuer.status === 'live').length;
            els.status.textContent = `${state.issuers.length} issuer programmes (${live} live), ` +
                `${mintsPhrase}. Built ${fmtDateTime(state.builtAt)}.`;
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
                    'How the mint, freeze and delegate authorities are held: multisig, program, or a plain hot wallet'),
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
    <p class="holder-claim">${escapeHtml(firstSentences(issuer.holderClaim, 2))}</p>
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
            const roles = ['mint', 'freeze', 'delegate']
                .filter((role) => typeof keyGovernance[role] === 'string' && keyGovernance[role]);
            if (!roles.length) return DASH;
            const values = roles.map((role) => KEY_GOVERNANCE_LABELS[keyGovernance[role]] || keyGovernance[role]);
            // All three held the same way is the common case; say it once rather than three times.
            if (roles.length === 3 && new Set(values).size === 1) return values[0];
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
            els.detailTitle.textContent = issuer.name;
            els.detailBody.innerHTML = detailHtml(issuer);
            showDetail();
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

            sections.push(detailSection('Issuing entity', [
                field('Entity', issuer.issuingEntity),
                field('Jurisdiction', issuer.entityJurisdiction),
                field('Governing law', issuer.governingLaw),
                field('Regulatory status', issuer.regulatoryStatus),
                field('Legal form', issuer.legalForm),
                field('Claim depth', `rung ${Number.isInteger(grades.claimRung) ? grades.claimRung : DASH} — ${claimLabel(grades.claimRung, grades.claimLabel)}`),
                field('Chains', Array.isArray(issuer.chains) ? issuer.chains.join(', ') : null),
                field('Products', Array.isArray(issuer.products) ? issuer.products.join(' · ') : null),
                field('Confidence in this dossier', issuer.confidence)
            ]));

            const custody = issuer.custodyVerification || {};
            sections.push(detailSection('Custody and verification', [
                field('Underlying custodian', issuer.underlyingCustodian),
                field('Verification type', `${custody.type || DASH} — strength ${Number.isInteger(grades.verificationStrength) ? grades.verificationStrength : DASH}/5 (${verificationLabel(grades.verificationStrength, grades.verificationLabel)})`),
                field('Agent', custody.agent),
                field('Frequency', custody.frequency),
                field('Machine-readable', custody.machineReadable === true ? 'yes' : custody.machineReadable === false ? 'no' : null),
                field('Endpoint', custody.endpoint),
                field('Notes', custody.notes),
                field('Evidence', linkHtml(custody.link), true)
            ]));

            const collateral = issuer.collateral || {};
            const security = issuer.securityInterest || {};
            sections.push(detailSection('Collateral', [
                field('Ratio', collateral.ratio),
                field('Composition', collateral.composition),
                field('Rehypothecation', collateral.rehypothecation),
                field('On-loan amount disclosed', collateral.onLoanDisclosed === true ? 'yes' : collateral.onLoanDisclosed === false ? 'no' : null),
                field('Security interest', security.exists === true ? 'yes' : security.exists === false ? 'no' : null),
                field('Security holder', security.holder),
                field('Priority', security.priority),
                field('Bankruptcy remote', issuer.bankruptcyRemote === true ? 'yes' : issuer.bankruptcyRemote === false ? 'no' : null)
            ]));

            const redemption = issuer.redemption || {};
            sections.push(detailSection('Redemption', [
                field('Available', redemption.available === true ? 'yes' : redemption.available === false ? 'no' : null),
                field('Eligibility', redemption.eligibility),
                field('Rails', redemption.rails),
                field('Notes', redemption.notes)
            ]));

            const restrictions = issuer.transferRestrictions || {};
            sections.push(detailSection('Transfer restrictions', [
                field('Allowlist', restrictions.allowlist === true ? 'yes' : restrictions.allowlist === false ? 'no' : null),
                field('KYC to hold', restrictions.kycToHold === true ? 'yes' : restrictions.kycToHold === false ? 'no' : null),
                field('US persons excluded', restrictions.usPersonsExcluded === true ? 'yes' : restrictions.usPersonsExcluded === false ? 'no' : null),
                field('Mechanism', restrictions.mechanism)
            ]));

            sections.push(detailSection('Rights', [
                field('Dividends', issuer.dividends),
                field('Voting', issuer.voting),
                field('Corporate actions', issuer.corporateActions),
                field('Pricing reference', issuer.pricing && issuer.pricing.referenceMarket),
                field('Arbitrageable', issuer.pricing && issuer.pricing.arbitrageable === true ? 'yes' : issuer.pricing && issuer.pricing.arbitrageable === false ? 'no' : null),
                field('Pricing notes', issuer.pricing && issuer.pricing.notes),
                field('Venues', Array.isArray(issuer.venues) && issuer.venues.length ? issuer.venues.join(', ') : null)
            ]));

            const keyGovernance = issuer.keyGovernance || (issuer.control && issuer.control.keyGovernance) || {};
            sections.push(detailSection('Key governance', [
                field('Mint authority', keyGovernance.mint),
                field('Freeze authority', keyGovernance.freeze),
                field('Permanent delegate', keyGovernance.delegate),
                field('Evidence', keyGovernance.evidence)
            ]));

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

        /** One dt/dd pair, dropped entirely when the dossier has nothing for it. */
        function field(label, value, isHtml) {
            if (value === null || value === undefined || value === '' || value === DASH) return '';
            return `<div class="detail-field"><dt>${escapeHtml(label)}</dt>` +
                `<dd>${isHtml ? value : escapeHtml(String(value))}</dd></div>`;
        }

        /** Like field(), but keeps the row and prints a dash: for a field whose absence is news. */
        function fieldAlways(label, value, tip) {
            const text = value === null || value === undefined || value === '' ? DASH : String(value);
            return `<div class="detail-field"${tip ? ` title="${escapeHtml(tip)}"` : ''}>` +
                `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(text)}</dd></div>`;
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
            const market = token.market || {};
            const reference = token.reference || {};
            const control = token.control || {};
            const activity = token.activity || {};
            const issuer = state.issuersBySlug.get(token.issuer);
            const sections = [];

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

        function renderTokenTable() {
            renderSortIndicators();
            // Sorting or filtering before the token file lands keeps the loading line and is
            // applied for real by the render that follows it.
            if (!state.tokensLoaded) return;

            const rows = filterTokens(state.tokens, state.filters);
            const getValue = SORT_KEYS[state.sort.key];
            if (getValue) rows.sort(makeComparator(getValue, state.sort.ascending));

            els.tokenTableBody.innerHTML = rows.map(tokenRowHtml).join('');
            els.tokenCount.textContent = rows.length === state.tokens.length
                ? `${rows.length} mints`
                : `${rows.length} of ${state.tokens.length} mints`;
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
                `<td class="cell-flags">${flags.join('')}</td>` +
                `<td class="cell-detail"><button type="button" class="row-detail" data-mint="${escapeHtml(token.mint)}" ` +
                `aria-label="Details for ${escapeHtml(token.symbol || token.mint)}">Details</button></td>` +
                '</tr>';
        }

        // --- events --------------------------------------------------------

        function wireEvents() {
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
                    renderTokenTable();
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
                renderTokenTable();
            });
            els.filterInstrument.addEventListener('change', () => {
                state.filters.instrumentType = els.filterInstrument.value;
                renderTokenTable();
            });
            els.filterSearch.addEventListener('input', () => {
                state.filters.query = els.filterSearch.value;
                renderTokenTable();
            });
        }
    });
}
