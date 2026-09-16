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

/** What a missing value renders as. Never 0, never "null". */
const DASH = '—';

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
    unknown: 'unknown'
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** True only for a real, finite number — so a null never becomes 0 downstream. */
function isNum(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

/** Escapes text for interpolation into HTML, attribute values included. */
function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/** Only http(s), same-origin and mailto links are ever emitted as hrefs. */
function isSafeUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const trimmed = url.trim().toLowerCase();
    return trimmed.startsWith('http://') ||
        trimmed.startsWith('https://') ||
        trimmed.startsWith('/') ||
        trimmed.startsWith('./') ||
        trimmed.startsWith('../') ||
        trimmed.startsWith('mailto:');
}

/** 1234567 -> "1,234,567"; null/NaN -> "—". */
function fmtNumber(value, digits) {
    if (!isNum(value)) return DASH;
    const d = isNum(digits) ? digits : 0;
    return value.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** Compact USD for aggregates: $1.23B / $4.56M / $78.9k / $12.34 / $0 (a real zero) / "—". */
function fmtMoney(value) {
    if (!isNum(value)) return DASH;
    const abs = Math.abs(value);
    if (abs >= 1e9) return '$' + (value / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return '$' + (value / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return '$' + (value / 1e3).toFixed(1) + 'k';
    if (abs >= 1) return '$' + value.toFixed(2);
    if (value === 0) return '$0';
    if (abs < 0.0001) return '<$0.001';
    return '$' + value.toPrecision(2);
}

/** Full-precision USD for a single price: $4,491.20 / "—". */
function fmtPrice(value) {
    if (!isNum(value)) return DASH;
    const abs = Math.abs(value);
    const digits = abs > 0 && abs < 1 ? 4 : 2;
    return '$' + value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 56.61 -> "56.6%"; null -> "—". */
function fmtPct(value, digits) {
    if (!isNum(value)) return DASH;
    return value.toFixed(isNum(digits) ? digits : 1) + '%';
}

/** A premium: "+0.45%" / "-1.80%" / "0.00%" / "—". */
function fmtSignedPct(value, digits) {
    if (!isNum(value)) return DASH;
    const d = isNum(digits) ? digits : 2;
    return (value > 0 ? '+' : '') + value.toFixed(d) + '%';
}

/** "2026-09-16T13:02:44Z" -> "16 Sep 2026 13:02 UTC". Always UTC, so it never drifts by host. */
function fmtDateTime(iso) {
    if (typeof iso !== 'string' || !iso.trim()) return DASH;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return DASH;
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${hh}:${mm} UTC`;
}

/** "2026-05-08" -> "8 May 2026". */
function fmtDate(iso) {
    if (typeof iso !== 'string' || !iso.trim()) return DASH;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return DASH;
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** A sources entry is either an ISO string or a record carrying fetchedAt. */
function fetchedAtOf(source) {
    if (typeof source === 'string') return source.trim() ? source : null;
    if (source && typeof source === 'object' && typeof source.fetchedAt === 'string') {
        return source.fetchedAt.trim() ? source.fetchedAt : null;
    }
    return null;
}

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

/** "freeze-authority-has-been-exercised" -> "Freeze authority has been exercised". */
function humanizeSlug(slug) {
    if (typeof slug !== 'string' || !slug.trim()) return DASH;
    const words = slug.trim().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
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

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        DASH,
        CLAIM_LABELS,
        VERIFICATION_LABELS,
        CHIP_MIN_PX,
        CHIP_MAX_PX,
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
        indexTypes,
        labelForSchema,
        isMissing,
        compareValues,
        makeComparator,
        displayName,
        tokenMatchesQuery,
        filterTokens,
        sortIssuersForDisplay
    };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        const ISSUERS_PATH = './stocks-issuers.json';
        const TOKENS_PATH = './stocks-tokens.json';
        const SAMPLE_ISSUERS_PATH = './stocks/fixtures/stocks-issuers.sample.json';
        const SAMPLE_TOKENS_PATH = './stocks/fixtures/stocks-tokens.sample.json';

        const BUILD_HINT = 'Build it with "npm run stocks:all && npm run stocks:build"';

        const state = {
            builtAt: null,
            issuers: [],
            issuersBySlug: new Map(),
            tokens: [],
            tokensLoaded: false,
            findingTypes: Object.create(null),
            attestationTypes: Object.create(null),
            filters: { issuer: '', instrumentType: '', query: '' },
            sort: { key: 'liquidity', ascending: false }
        };

        // Which token-table columns can be sorted, and what each one reads.
        const SORT_KEYS = {
            price: (t) => t.market && t.market.usdPrice,
            premium: (t) => t.reference && t.reference.premiumPct,
            liquidity: (t) => t.market && t.market.liquidity,
            vol24: (t) => t.market && t.market.vol24,
            holders: (t) => t.market && t.market.holderCount
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
            grid: document.getElementById('claimGrid'),
            gridLegend: document.getElementById('gridLegend'),
            issuerCards: document.getElementById('issuerCards'),
            issuerCount: document.getElementById('issuerCount'),
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

            const [issuerDb, findingTypes, attestationTypes] = await Promise.all([
                fetchJson(issuersPath),
                fetchJson('./finding-types.json'),
                fetchJson('./attestation-types.json')
            ]);

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

        // --- the grid ------------------------------------------------------

        function renderGrid(issuers) {
            const labels = claimAxisLabels(issuers);
            const parts = [];

            for (let stage = GRID_STAGES - 1; stage >= 0; stage--) {
                parts.push(
                    `<div class="grid-axis grid-axis-y" style="grid-column:1;grid-row:${GRID_STAGES - stage}">` +
                    `<span class="maturity-pill level-${stage}">Level ${stage}</span></div>`
                );
            }

            for (let rung = 0; rung < GRID_RUNGS; rung++) {
                parts.push(
                    `<div class="grid-axis grid-axis-x" style="grid-column:${rung + GRID_FIRST_DATA_COLUMN};grid-row:${GRID_LABEL_ROW}">` +
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

            return `<tr${defunct ? ' class="asset-defunct"' : ''}>` +
                `<td class="cell-token"><span class="token-symbol">${escapeHtml(token.symbol || DASH)}</span>` +
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
                `<td class="num">${escapeHtml(fmtNumber(market.holderCount))}</td>` +
                `<td class="num">${escapeHtml(fmtPct(market.top10HolderPct))}</td>` +
                `<td class="cell-flags">${flags.join('')}</td>` +
                '</tr>';
        }

        // --- events --------------------------------------------------------

        function wireEvents() {
            document.addEventListener('click', (event) => {
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
                }
            });

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
