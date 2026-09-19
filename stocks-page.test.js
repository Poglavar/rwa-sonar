// Unit tests for the pure formatters and placement helpers exported by stocks.js — the parts of
// the tokenized-stocks page that decide what a missing value looks like, where an issuer lands on
// the grid, and how a column sorts. No DOM: stocks.js only touches document in a browser. The last
// two suites check the two files the page loads (MODEL.md §10.1) instead: that they came from one
// build, and that the token file carries no dossier prose and stays under the byte budget.
const { readFileSync, statSync } = require('node:fs');
const { join } = require('node:path');
const { lenderExitQuality } = require('./stocks/lib/composability.mjs');
const {
    DASH,
    CHIP_MIN_PX,
    CHIP_MAX_PX,
    GRID_STAGES,
    GRID_FIRST_DATA_COLUMN,
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
    TOKEN_PAGE_SIZE,
    tokenPageMath,
    tokenApiParams,
    tokenFromApiRow,
    defiUsageIndex,
    defiUsageCompactHtml,
    defiUsageDetailHtml,
    defiSourceRows,
    composabilityTemplateForToken,
    lenderOutcomeModel,
    sameStockComparisonModels,
    sameStockComparisonHtml,
    sortIssuersForDisplay,
    laypersonVerdict,
    legalReviewStatus,
    globalSearch,
    sameUnderlyingGroups,
    collectorHealth,
    MATURITY_LEVEL_TOOLTIPS,
    CLAIM_RUNG_TOOLTIPS,
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
} = require('./stocks.js');

const NOTHINGS = [null, undefined, '', NaN, Infinity, -Infinity, 'n/a', {}];

describe('isNum', () => {
    it('accepts only real finite numbers', () => {
        expect(isNum(0)).toBe(true);
        expect(isNum(-2.5)).toBe(true);
        for (const bad of NOTHINGS) expect(isNum(bad)).toBe(false);
    });
});

describe('DeFi composability template table', () => {
    const S = require('./stocks.js');
    const tokenDb = JSON.parse(readFileSync(join(__dirname, 'stocks-tokens.json'), 'utf8'));
    const issuerDb = JSON.parse(readFileSync(join(__dirname, 'stocks-issuers.json'), 'utf8'));
    const composability = JSON.parse(readFileSync(join(__dirname, 'stocks/data/composability-templates.json'), 'utf8'));

    it('renders one row per used tech + legal template and accounts for every mint', () => {
        const rows = S.composabilityTemplateRows(composability, tokenDb.tokens, issuerDb.issuers);
        expect(rows).toHaveLength(9);
        expect(rows.reduce((sum, row) => sum + row.mints, 0)).toBe(tokenDb.tokens.length);
        expect(rows.find((row) => row.issuer === 'xstocks-backed').mints).toBe(165);
    });

    it('shows the four distinct failure cases and keeps their explanations expandable', () => {
        const html = S.composabilityTemplatesHtml(composability, tokenDb.tokens, issuerDb.issuers);
        for (const scenario of S.COMPOSABILITY_SCENARIOS) {
            expect(html).toContain(`data-scenario="${scenario.id}"`);
        }
        expect(html).toContain('data-label="Borrower default"');
        expect(html).toContain('<details class="comp-explain">');
        expect(html).toContain('The lender can seize the transferable claim');
        expect(html).toContain('Full legal template →');
        expect(html).toContain('templates/xstocks-backed--token-2022-pausable-clawback-rebase.html');
    });

    it('escapes reviewed prose before placing it in the table', () => {
        const hostile = {
            templates: [{
                ...composability.templates[0], issuer: 'evil', recipe: 'r', legalTemplate: '<img src=x>',
                summary: '<script>alert(1)</script>'
            }]
        };
        const html = S.composabilityTemplatesHtml(hostile,
            [{ issuer: 'evil', recipe: { label: 'r' } }], [{ slug: 'evil', name: '<b>Evil</b>' }]);
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;script&gt;');
    });
});

describe('confirmed DeFi usage', () => {
    const db = JSON.parse(readFileSync(join(__dirname, 'stocks/data/defi-usage.json'), 'utf8'));
    const index = defiUsageIndex(db);

    it('covers every mint and keeps no-result assets explicit', () => {
        const tokens = JSON.parse(readFileSync(join(__dirname, 'stocks-tokens.json'), 'utf8')).tokens;
        expect(index.size).toBe(tokens.length);
        expect(index.get('123mYEnRLM2LLYsJW3K6oyYh8uP1fngj732iG638ondo').integrations).toEqual([]);
        expect(defiUsageCompactHtml(null)).toContain('None confirmed');
    });

    it('renders exact protocols, actions, live metrics and evidence links for NVDAx', () => {
        const nvda = [...index.values()].find((item) => item.symbol === 'NVDAx');
        const compact = defiUsageCompactHtml(nvda);
        const detail = defiUsageDetailHtml(nvda, db.fetchedAt);
        for (const protocol of ['Jupiter Lend', 'Kamino', 'Nest', 'Veda xStocks Vault', 'Raydium']) {
            expect(compact).toContain(protocol);
            expect(detail).toContain(protocol);
        }
        expect(detail).toContain('max LTV');
        expect(detail).toContain('Open market / product');
        expect(detail).toContain('Evidence');
    });

    it('shows exactly which protocol sources were checked and whether each observation is current', () => {
        const now = Date.parse('2026-09-19T15:00:00Z');
        const rows = defiSourceRows(db.sources, now);
        expect(rows.map((row) => row.label)).toEqual([
            'Kamino', 'Jupiter Lend', 'Nest', 'Project 0', 'Save', 'DEX pools', 'Meteora', 'Reviewed products', 'Solana accounts'
        ]);
        expect(rows.find((row) => row.id === 'kamino')).toMatchObject({ fresh: true, rows: 139 });
        expect(rows.find((row) => row.id === 'dexPools').fresh).toBe(false);
    });

    it('connects a confirmed integration to the token template’s escrow and loss outcomes', () => {
        const tokens = JSON.parse(readFileSync(join(__dirname, 'stocks-tokens.json'), 'utf8')).tokens;
        const issuers = JSON.parse(readFileSync(join(__dirname, 'stocks-issuers.json'), 'utf8')).issuers;
        const templates = JSON.parse(readFileSync(join(__dirname, 'stocks/data/composability-templates.json'), 'utf8'));
        const nvdaToken = tokens.find((token) => token.symbol === 'NVDAx');
        const template = composabilityTemplateForToken(templates, nvdaToken);
        const issuer = issuers.find((row) => row.slug === nvdaToken.issuer);
        const html = defiUsageDetailHtml(index.get(nvdaToken.mint), db.fetchedAt, template, issuer);
        expect(template.issuer).toBe('xstocks-backed');
        expect(html).toContain('What protocol custody means for this token');
        expect(html).toContain('Programmatic collateral today');
        expect(html).toContain('Can seizure become cash?');
        expect(html).toContain('requires KYC/AML');
        for (const scenario of ['escrow', 'borrowerDefault', 'protocolHack', 'accessLoss']) {
            expect(html).toContain(`data-scenario="${scenario}"`);
        }
        expect(html).toContain('The lender can seize and sell; redemption is gated');
    });

    it('keeps the browser and card exit-after-default verdicts aligned', () => {
        const templates = JSON.parse(readFileSync(join(__dirname, 'stocks/data/composability-templates.json'), 'utf8'));
        const template = templates.templates.find((row) => row.issuer === 'xstocks-backed');
        const integrations = [
            { category: 'lending', protocolName: 'Kamino', actions: ['collateral', 'borrow'] },
            { category: 'dex', protocolName: 'Raydium', actions: ['swap'], metrics: { liquidityUsd: 100000 } }
        ];
        const issuer = { redemption: { available: true, kyc: true } };
        const browser = lenderOutcomeModel(template, issuer, { integrations }).exitQuality;
        const card = lenderExitQuality(template, integrations, issuer.redemption);
        expect(browser).toEqual({ rating: card.rating, label: card.label, reason: card.reason });
    });

    it('keeps structural lender outcomes visible when no current integration is confirmed', () => {
        const tokens = JSON.parse(readFileSync(join(__dirname, 'stocks-tokens.json'), 'utf8')).tokens;
        const issuers = JSON.parse(readFileSync(join(__dirname, 'stocks-issuers.json'), 'utf8')).issuers;
        const templates = JSON.parse(readFileSync(join(__dirname, 'stocks/data/composability-templates.json'), 'utf8'));
        const token = tokens.find((row) => row.issuer === 'ondo-global-markets' && index.get(row.mint)?.integrations.length === 0);
        const template = composabilityTemplateForToken(templates, token);
        const issuer = issuers.find((row) => row.slug === token.issuer);
        const html = defiUsageDetailHtml(index.get(token.mint), db.fetchedAt, template, issuer);
        expect(html).toContain('None confirmed');
        expect(html).toContain('What protocol custody means for this token');
        expect(html).toContain('No checked protocol currently lists this exact token as programmatic collateral');
    });

    it('compares the same stock across legal structure, live lending, market exit and loss outcomes', () => {
        const tokens = JSON.parse(readFileSync(join(__dirname, 'stocks-tokens.json'), 'utf8')).tokens;
        const issuers = JSON.parse(readFileSync(join(__dirname, 'stocks-issuers.json'), 'utf8')).issuers;
        const templates = JSON.parse(readFileSync(join(__dirname, 'stocks/data/composability-templates.json'), 'utf8'));
        const group = sameUnderlyingGroups(tokens).find((row) => row.ticker === 'NVDA');
        const models = sameStockComparisonModels(group, new Map(issuers.map((row) => [row.slug, row])), index, templates);
        expect(models).toHaveLength(2);
        expect(models.find((row) => row.issuerSlug === 'xstocks-backed').outcome.confirmedLending)
            .toContain('Confirmed for this exact token');
        expect(models.find((row) => row.issuerSlug === 'ondo-global-markets').outcome.confirmedLending)
            .toContain('No checked protocol');
        const html = sameStockComparisonHtml(group, models);
        for (const label of ['What do you own?', 'Redeem for cash', 'Smart-contract custody', 'Borrower default',
            'Confirmed lending now', 'Secondary-market exit', 'If the protocol is hacked', 'If access is lost']) {
            expect(html).toContain(label);
        }
        expect(html).toContain('exact-token support and legal outcomes shown separately');
    });

    it('escapes protocol-controlled and curated prose', () => {
        const html = defiUsageDetailHtml({ integrations: [{
            protocolName: '<img src=x>', status: 'live', actions: ['swap'], summary: '<script>x</script>',
            accessNote: '<b>no</b>', links: {}, evidence: []
        }] });
        expect(html).not.toContain('<img');
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
    });
});

describe('fmtNumber', () => {
    it('groups thousands', () => {
        expect(fmtNumber(1234567)).toBe('1,234,567');
        expect(fmtNumber(33612)).toBe('33,612');
        expect(fmtNumber(3)).toBe('3');
    });

    it('honours a digit count', () => {
        expect(fmtNumber(1234.567, 2)).toBe('1,234.57');
    });

    it('renders a real zero as 0 and a missing value as a dash', () => {
        expect(fmtNumber(0)).toBe('0');
        for (const bad of NOTHINGS) expect(fmtNumber(bad)).toBe(DASH);
    });
});

describe('fmtMoney', () => {
    it('scales to B/M/k and keeps cents below a thousand', () => {
        expect(fmtMoney(2_612_100.05)).toBe('$2.61M');
        expect(fmtMoney(1_240_000_000)).toBe('$1.24B');
        expect(fmtMoney(9420)).toBe('$9.4k');
        expect(fmtMoney(12.5)).toBe('$12.50');
    });

    it('keeps sub-dollar amounts readable', () => {
        expect(fmtMoney(0.05)).toBe('$0.050');
        expect(fmtMoney(0.00001)).toBe('<$0.001');
    });

    it('distinguishes a measured zero from a missing value', () => {
        expect(fmtMoney(0)).toBe('$0');
        for (const bad of NOTHINGS) expect(fmtMoney(bad)).toBe(DASH);
    });

    it('keeps the sign on a negative', () => {
        expect(fmtMoney(-4_500_000)).toBe('$-4.50M');
    });
});

describe('fmtPrice', () => {
    it('keeps full precision with thousands separators', () => {
        expect(fmtPrice(4491.2)).toBe('$4,491.20');
        expect(fmtPrice(421.77)).toBe('$421.77');
    });

    it('gives a sub-dollar price four decimals', () => {
        expect(fmtPrice(0.0512)).toBe('$0.0512');
    });

    it('dashes a missing price', () => {
        for (const bad of NOTHINGS) expect(fmtPrice(bad)).toBe(DASH);
    });
});

describe('fmtPct and fmtSignedPct', () => {
    it('renders one decimal by default', () => {
        expect(fmtPct(56.607)).toBe('56.6%');
        expect(fmtPct(100)).toBe('100.0%');
        expect(fmtPct(28.57, 2)).toBe('28.57%');
    });

    it('signs a premium but not a zero', () => {
        expect(fmtSignedPct(0.45)).toBe('+0.45%');
        expect(fmtSignedPct(-1.8)).toBe('-1.80%');
        expect(fmtSignedPct(0)).toBe('0.00%');
        expect(fmtSignedPct(6121.3)).toBe('+6121.30%');
    });

    it('renders a measured zero percent, and a dash for a missing one', () => {
        expect(fmtPct(0)).toBe('0.0%');
        for (const bad of NOTHINGS) {
            expect(fmtPct(bad)).toBe(DASH);
            expect(fmtSignedPct(bad)).toBe(DASH);
        }
    });
});

describe('date formatting', () => {
    it('formats in UTC, so the output does not depend on the host timezone', () => {
        expect(fmtDateTime('2026-09-16T13:02:44Z')).toBe('16 Sep 2026 13:02 UTC');
        expect(fmtDate('2026-05-08')).toBe('8 May 2026');
    });

    it('dashes an absent or unparseable date', () => {
        expect(fmtDateTime(null)).toBe(DASH);
        expect(fmtDateTime('')).toBe(DASH);
        expect(fmtDateTime('not a date')).toBe(DASH);
        expect(fmtDate(undefined)).toBe(DASH);
    });
});

describe('fetchedAtOf', () => {
    it('reads fetchedAt off a source record', () => {
        expect(fetchedAtOf({ file: 'x', fetchedAt: '2026-09-16T13:02:44Z' })).toBe('2026-09-16T13:02:44Z');
    });

    it('accepts a bare ISO string', () => {
        expect(fetchedAtOf('2026-09-16T13:02:44Z')).toBe('2026-09-16T13:02:44Z');
    });

    it('returns null when there is no timestamp to report', () => {
        expect(fetchedAtOf(null)).toBeNull();
        expect(fetchedAtOf(undefined)).toBeNull();
        expect(fetchedAtOf({})).toBeNull();
        expect(fetchedAtOf({ fetchedAt: '' })).toBeNull();
        expect(fetchedAtOf('')).toBeNull();
    });
});

describe('chipSize', () => {
    it('floors a null, zero or negative liquidity instead of collapsing the dot', () => {
        expect(chipSize(null)).toBe(CHIP_MIN_PX);
        expect(chipSize(0)).toBe(CHIP_MIN_PX);
        expect(chipSize(-5)).toBe(CHIP_MIN_PX);
        expect(chipSize(undefined)).toBe(CHIP_MIN_PX);
    });

    it('clamps both ends of the log range', () => {
        expect(chipSize(1)).toBe(CHIP_MIN_PX);
        expect(chipSize(1e3)).toBe(CHIP_MIN_PX);
        expect(chipSize(1e8)).toBe(CHIP_MAX_PX);
        expect(chipSize(1e12)).toBe(CHIP_MAX_PX);
    });

    it('scales by log10, so every decade is the same step apart from rounding', () => {
        const decades = [1e4, 1e5, 1e6, 1e7].map(chipSize);
        const steps = decades.slice(1).map((v, i) => v - decades[i]);
        const expected = (CHIP_MAX_PX - CHIP_MIN_PX) / 5;
        for (const step of steps) {
            expect(step).toBeGreaterThan(0);
            expect(Math.abs(step - expected)).toBeLessThanOrEqual(1);
        }
    });

    it('is monotonic and bounded', () => {
        expect(chipSize(1e6)).toBeGreaterThan(chipSize(1e4));
        expect(chipSize(2.6e6)).toBeLessThanOrEqual(CHIP_MAX_PX);
    });
});

describe('gridCell', () => {
    it('puts claim rung 0 in the first data column and rung 4 in the last', () => {
        expect(gridCell(0, 2).column).toBe(GRID_FIRST_DATA_COLUMN);
        expect(gridCell(4, 2).column).toBe(GRID_FIRST_DATA_COLUMN + 4);
    });

    it('puts maturity Level 4 at the top row and Level 0 at the bottom', () => {
        expect(gridCell(0, 4).row).toBe(1);
        expect(gridCell(0, 0).row).toBe(GRID_STAGES);
    });

    it('places the documented issuers where the model says', () => {
        // xStocks: Level 2, secured claim (rung 2) -> middle of the grid.
        expect(gridCell(2, 2)).toEqual({ column: 4, row: 3 });
        // Opening Bell: Level 0, registered share (rung 4) -> bottom right.
        expect(gridCell(4, 0)).toEqual({ column: 6, row: 5 });
    });

    it('refuses an unknown or out-of-range coordinate so the issuer lands in the legend', () => {
        expect(gridCell(null, 2)).toBeNull();
        expect(gridCell(2, null)).toBeNull();
        expect(gridCell(undefined, undefined)).toBeNull();
        expect(gridCell(5, 2)).toBeNull();
        expect(gridCell(-1, 2)).toBeNull();
        expect(gridCell(2, 5)).toBeNull();
        expect(gridCell(2.5, 2)).toBeNull();
        expect(gridCell('2', '2')).toBeNull();
    });
});

describe('claimAxisLabels', () => {
    it('prefers the label the data carries for each rung', () => {
        const labels = claimAxisLabels([
            { grades: { claimRung: 4, claimLabel: 'registered share' } },
            { grades: { claimRung: 0, claimLabel: 'synthetic exposure (perp)' } }
        ]);
        expect(labels[0]).toBe('synthetic exposure (perp)');
        expect(labels[4]).toBe('registered share');
    });

    it('falls back to the canonical label for an unoccupied rung', () => {
        const labels = claimAxisLabels([]);
        expect(labels).toHaveLength(5);
        expect(labels[2]).toBe('secured claim on collateral');
    });

    it('ignores issuers with no usable rung or label', () => {
        const labels = claimAxisLabels([
            { grades: { claimRung: null, claimLabel: null } },
            { grades: { claimRung: 3, claimLabel: '  ' } },
            null
        ]);
        expect(labels[3]).toBe('beneficial interest in the security');
    });
});

describe('claimLabel and verificationLabel', () => {
    it('uses the label from the data when it has one', () => {
        expect(claimLabel(2, 'secured claim on collateral')).toBe('secured claim on collateral');
        expect(verificationLabel(4, 'on-chain PoR')).toBe('on-chain PoR');
    });

    it('derives the canonical label from the number otherwise', () => {
        expect(claimLabel(4, null)).toBe('registered share');
        expect(verificationLabel(5, null)).toBe('transfer-agent register');
        expect(verificationLabel(0, '')).toBe('none');
    });

    it('dashes an unknown rung or strength rather than guessing', () => {
        expect(claimLabel(null, null)).toBe(DASH);
        expect(claimLabel(9, null)).toBe(DASH);
        expect(verificationLabel(null, null)).toBe(DASH);
        expect(verificationLabel(6, null)).toBe(DASH);
    });
});

describe('coverage and fee rendering', () => {
    it('labels the three coverage buckets and dashes anything else', () => {
        expect(coverageLabel('all')).toBe('All');
        expect(coverageLabel('some')).toBe('Some');
        expect(coverageLabel('none')).toBe('None');
        expect(coverageLabel(null)).toBe(DASH);
        expect(coverageLabel('unknown')).toBe(DASH);
    });

    it('gives each bucket its own class', () => {
        expect(coverageClass('all')).toBe('cov-all');
        expect(coverageClass('none')).toBe('cov-none');
        expect(coverageClass(undefined)).toBe('cov-unknown');
    });

    it('reads an authority address as a control in force, not just a boolean true', () => {
        // stocks-tokens.json carries control.freezeAuthority as the authority's own address on all
        // 441 mints; a `=== true` test would report that nobody can freeze anything.
        expect(isControlOn('51QVCuHfL1FeNjd8BDeffCKhCcAYoULnVB3yjNhShiuK')).toBe(true);
        expect(isControlOn(true)).toBe(true);
        expect(isControlOn(false)).toBe(false);
        expect(isControlOn(null)).toBe(false);
        expect(isControlOn(undefined)).toBe(false);
        expect(isControlOn('')).toBe(false);
        expect(isControlOn('   ')).toBe(false);
    });

    it('renders a 0 bps fee as a real value, and an empty list as a dash', () => {
        expect(fmtFeeBps([0])).toBe('0 bps');
        expect(fmtFeeBps([25, 0])).toBe('0 / 25 bps');
        expect(fmtFeeBps([])).toBe(DASH);
        expect(fmtFeeBps(null)).toBe(DASH);
        expect(fmtFeeBps([null, undefined])).toBe(DASH);
    });
});

describe('severity', () => {
    it('ranks info below caution below warning below critical', () => {
        expect(severityRank('info')).toBeLessThan(severityRank('caution'));
        expect(severityRank('caution')).toBeLessThan(severityRank('warning'));
        expect(severityRank('warning')).toBeLessThan(severityRank('critical'));
        expect(severityRank('nonsense')).toBe(-1);
        expect(severityRank(null)).toBe(-1);
    });

    it('reports the worst severity in a findings list', () => {
        expect(worstSeverity([{ severity: 'info' }, { severity: 'critical' }, { severity: 'caution' }]))
            .toBe('critical');
        expect(worstSeverity([{ severity: 'info' }])).toBe('info');
    });

    it('reports nothing for an empty or absent list', () => {
        expect(worstSeverity([])).toBeNull();
        expect(worstSeverity(null)).toBeNull();
    });
});

describe('humanizeSlug and labelForSchema', () => {
    it('turns a slug into a sentence', () => {
        expect(humanizeSlug('freeze-authority-has-been-exercised'))
            .toBe('Freeze authority has been exercised');
        expect(humanizeSlug('collateral_may_be_lent')).toBe('Collateral may be lent');
        expect(humanizeSlug('etf')).toBe('Etf');
    });

    it('dashes an absent slug', () => {
        expect(humanizeSlug(null)).toBe(DASH);
        expect(humanizeSlug('  ')).toBe(DASH);
        expect(humanizeSlug(7)).toBe(DASH);
    });

    it('prefers the type name when the types file defines the slug', () => {
        const index = indexTypes([
            { schema: 'issuer-has-wound-down', name: 'Issuer has wound down' },
            { name: 'no schema, ignored' },
            null
        ]);
        expect(labelForSchema('issuer-has-wound-down', index)).toBe('Issuer has wound down');
    });

    it('humanizes the slug when the types file is missing or does not know it', () => {
        expect(labelForSchema('no-token-terms-published', indexTypes(null)))
            .toBe('No token terms published');
        expect(labelForSchema('authority-key-is-hot-wallet', undefined))
            .toBe('Authority key is hot wallet');
    });
});

describe('sorting', () => {
    it('treats null, empty and non-finite values as missing', () => {
        expect(isMissing(null)).toBe(true);
        expect(isMissing(undefined)).toBe(true);
        expect(isMissing('')).toBe(true);
        expect(isMissing(NaN)).toBe(true);
        expect(isMissing(Infinity)).toBe(true);
        expect(isMissing(0)).toBe(false);
        expect(isMissing('0')).toBe(false);
    });

    it('puts missing values last in both directions', () => {
        expect(compareValues(null, 5, true)).toBeGreaterThan(0);
        expect(compareValues(null, 5, false)).toBeGreaterThan(0);
        expect(compareValues(5, null, true)).toBeLessThan(0);
        expect(compareValues(5, null, false)).toBeLessThan(0);
        expect(compareValues(null, undefined, true)).toBe(0);
    });

    it('compares numbers numerically and respects the direction', () => {
        expect(compareValues(2, 10, true)).toBeLessThan(0);
        expect(compareValues(2, 10, false)).toBeGreaterThan(0);
        expect(compareValues(0, -1, true)).toBeGreaterThan(0);
    });

    it('compares strings case-insensitively', () => {
        expect(compareValues('aaplx', 'TSLAx', true)).toBeLessThan(0);
        expect(compareValues('aaplx', 'TSLAx', false)).toBeGreaterThan(0);
    });

    it('sorts a token list descending with the nulls at the end', () => {
        const tokens = [
            { symbol: 'A', market: { liquidity: 500 } },
            { symbol: 'B', market: { liquidity: null } },
            { symbol: 'C', market: { liquidity: 1_200_000 } },
            { symbol: 'D', market: { liquidity: 0 } },
            { symbol: 'E', market: {} }
        ];
        const sorted = tokens.slice().sort(makeComparator((t) => t.market.liquidity, false));
        expect(sorted.map((t) => t.symbol)).toEqual(['C', 'A', 'D', 'B', 'E']);
    });

    it('keeps the nulls last when the same column is sorted ascending', () => {
        const tokens = [
            { symbol: 'A', reference: { premiumPct: 0.45 } },
            { symbol: 'B', reference: { premiumPct: null } },
            { symbol: 'C', reference: { premiumPct: -1.8 } }
        ];
        const sorted = tokens.slice().sort(makeComparator((t) => t.reference.premiumPct, true));
        expect(sorted.map((t) => t.symbol)).toEqual(['C', 'A', 'B']);
    });
});

describe('displayName', () => {
    it('leaves a real name alone', () => {
        expect(displayName('Kraken xStocks')).toBe('Kraken xStocks');
        expect(displayName('Tessera (Tessera Works Foundation)')).toBe('Tessera (Tessera Works Foundation)');
    });

    it('cuts the clause after an em dash', () => {
        // The name stocks-issuers.json actually carries for Bullish.
        const real = 'Bullish (NYSE: BLSH) — the securities issuer is the listed company itself, ' +
            'a Cayman Islands company (SEC CIK 0001872195, Commission File No. 001-42797)';
        expect(displayName(real)).toBe('Bullish (NYSE: BLSH)');
    });

    it('drops an overlong trailing parenthetical rather than truncating mid-word', () => {
        const real = 'Ondo Global Markets ("Ondo Stocks"; legacy "GM" prefix in APIs and contracts)';
        expect(displayName(real)).toBe('Ondo Global Markets');
    });

    it('drops a nested trailing parenthetical whole', () => {
        // stocks-issuers.json's name for xStocks; the inner "(JE)" defeats a non-greedy strip.
        expect(displayName('xStocks (Backed Finance / Backed Assets (JE) Limited)', 28)).toBe('xStocks');
    });

    it('keeps only the first sentence of a name that is really a paragraph', () => {
        const real = 'Backpack Securities (marketing name). The token issuer of record is Trek Nexus ' +
            'Markets Ltd (BVI) as bare trustee; Backpack Exchange is Trek Labs Ltd.';
        expect(displayName(real)).toBe('Backpack Securities (marketing name).');
    });

    it('does not cut at an abbreviation dot while the name still fits', () => {
        expect(displayName('Securitize Corp. (NYSE: SECZ)')).toBe('Securitize Corp. (NYSE: SECZ)');
    });

    it('hard-truncates with an ellipsis when nothing else shortens it', () => {
        const long = 'A'.repeat(80);
        const out = displayName(long, 20);
        expect(out).toHaveLength(20);
        expect(out.endsWith('…')).toBe(true);
    });

    it('respects a tighter limit for a chip label', () => {
        expect(displayName('Kraken xStocks', 28)).toBe('Kraken xStocks');
        expect(displayName('Opening Bell by Superstate Services LLC', 28).length).toBeLessThanOrEqual(28);
    });

    it('dashes an absent name', () => {
        expect(displayName(null)).toBe(DASH);
        expect(displayName('')).toBe(DASH);
        expect(displayName('   ')).toBe(DASH);
    });
});

describe('token filtering', () => {
    const tokens = [
        { symbol: 'TSLAx', name: 'Tesla xStock', issuer: 'xstocks-backed', underlyingTicker: 'TSLA', instrumentType: 'stock' },
        { symbol: 'SPYx', name: 'SP500 xStock', issuer: 'xstocks-backed', underlyingTicker: 'SPY', instrumentType: 'etf' },
        { symbol: 'GLXY', name: 'Galaxy Digital Class A', issuer: 'superstate-opening-bell', underlyingTicker: 'GLXY', instrumentType: 'stock' },
        { symbol: 'tOpenAI', name: 'Tessera OpenAI', issuer: 'tessera', underlyingTicker: null, instrumentType: 'private-company' }
    ];

    it('matches a query against symbol, name and underlying ticker', () => {
        expect(tokenMatchesQuery(tokens[0], 'tsla')).toBe(true);
        expect(tokenMatchesQuery(tokens[0], 'xstock')).toBe(true);
        expect(tokenMatchesQuery(tokens[0], 'SPY')).toBe(false);
        expect(tokenMatchesQuery(tokens[3], 'openai')).toBe(true);
    });

    it('matches everything on an empty query and survives a null ticker', () => {
        expect(tokenMatchesQuery(tokens[3], '')).toBe(true);
        expect(tokenMatchesQuery(tokens[3], '   ')).toBe(true);
        expect(tokenMatchesQuery(tokens[3], null)).toBe(true);
    });

    it('combines the issuer, instrument and search filters', () => {
        expect(filterTokens(tokens, { issuer: 'xstocks-backed' }).map((t) => t.symbol))
            .toEqual(['TSLAx', 'SPYx']);
        expect(filterTokens(tokens, { instrumentType: 'stock' }).map((t) => t.symbol))
            .toEqual(['TSLAx', 'GLXY']);
        expect(filterTokens(tokens, { issuer: 'xstocks-backed', instrumentType: 'etf' }).map((t) => t.symbol))
            .toEqual(['SPYx']);
        expect(filterTokens(tokens, { query: 'galaxy' }).map((t) => t.symbol)).toEqual(['GLXY']);
        expect(filterTokens(tokens, {})).toHaveLength(4);
        expect(filterTokens(null, {})).toEqual([]);
    });
});

describe('API-backed token paging', () => {
    it('turns a page into a bounded API request with the selected filters and sort', () => {
        expect(tokenApiParams(
            { issuer: 'xstocks-backed', instrumentType: 'stock', query: ' nvda ' },
            { key: 'trades24', ascending: false },
            3
        )).toEqual({
            issuer: 'xstocks-backed', instrument: 'stock', q: 'nvda', sort: 'trades24',
            order: 'desc', limit: TOKEN_PAGE_SIZE, offset: TOKEN_PAGE_SIZE * 2
        });
    });

    it('clamps the last page and reports its visible range', () => {
        expect(tokenPageMath(121, 9)).toEqual({
            page: 3, pages: 3, offset: 100, from: 101, to: 121, total: 121,
            hasPrev: true, hasNext: false
        });
    });

    it('adapts the API row without turning absent values into zero', () => {
        const token = tokenFromApiRow({
            mint: 'M', issuer_slug: 'issuer', usd_price: 12.5, trades24: 4,
            reference_source: 'pyth', clawback: true, top10_holder_pct: null
        });
        expect(token).toMatchObject({
            mint: 'M', issuer: 'issuer', market: { usdPrice: 12.5, top10HolderPct: null },
            activity: { trades24: 4 }, reference: { source: 'pyth' }, control: { clawback: true }
        });
        expect(token.market.liquidity).toBeNull();
    });
});

describe('layperson discovery helpers', () => {
    it('states legal ownership, redemption and issuer powers without grade jargon', () => {
        const verdict = laypersonVerdict({
            claimRung: 3,
            redemptionAvailable: true,
            control: { clawback: 'all', freezeAuthority: 'none', pausable: false }
        });
        expect(verdict.headline).toContain('beneficial interest');
        expect(verdict.headline).not.toContain('rung');
        expect(verdict.redemption).toContain('can redeem');
        expect(verdict.controlNote).toContain('reclaim');
    });

    it('marks evidence gaps as pending and fully sourced reviewed evidence as complete', () => {
        expect(legalReviewStatus({ evidence: { coverage: { sourced: 8, needed: 10 }, unverified: 1 } }))
            .toMatchObject({ pending: true, label: 'Legal review pending' });
        expect(legalReviewStatus({ evidence: { coverage: { sourced: 10, needed: 10 }, unverified: 0, inference: 0 } }))
            .toMatchObject({ pending: false, label: 'Legal evidence reviewed' });
    });

    it('searches issuer name and mint as well as token identity', () => {
        const issuers = [{ slug: 'backed', name: 'Backed Finance', issuingEntity: 'Backed Assets AG' }];
        const tokens = [{ symbol: 'AAPLx', name: 'Apple xStock', underlyingTicker: 'AAPL', issuer: 'backed', mint: 'MintABC123' }];
        expect(globalSearch(tokens, issuers, 'finance').tokens).toHaveLength(1);
        expect(globalSearch(tokens, issuers, 'MintABC').tokens).toHaveLength(1);
        expect(globalSearch(tokens, issuers, 'apple').issuers).toHaveLength(0);
    });

    it('only compares underlyings offered by at least two issuers', () => {
        const groups = sameUnderlyingGroups([
            { symbol: 'AAPLx', underlyingTicker: 'AAPL', issuer: 'a' },
            { symbol: 'AAPLon', underlyingTicker: 'aapl', issuer: 'b' },
            { symbol: 'TSLAx', underlyingTicker: 'TSLA', issuer: 'a' }
        ]);
        expect(groups).toHaveLength(1);
        expect(groups[0]).toMatchObject({ ticker: 'AAPL', issuerCount: 2, tokenCount: 2 });
    });

    it('reports collector freshness against a caller-provided clock', () => {
        const now = Date.parse('2026-09-18T12:00:00Z');
        const sources = Object.fromEntries(['universe', 'onchain', 'sponsorApis', 'referencePrices', 'venues', 'holders']
            .map((key) => [key, { fetchedAt: '2026-09-18T00:00:00Z' }]));
        expect(collectorHealth(sources, now)).toMatchObject({ fresh: 6, total: 6, healthy: true });
        sources.holders.fetchedAt = '2026-09-14T00:00:00Z';
        expect(collectorHealth(sources, now)).toMatchObject({ fresh: 5, healthy: false });
    });
});

describe('public indexing metadata', () => {
    it('allows crawling and gives every public static page one canonical URL', () => {
        expect(readFileSync(join(__dirname, 'robots.txt'), 'utf8')).toContain('Allow: /');
        for (const file of ['index.html', 'assets.html', 'stocks.html', 'graph.html', 'live.html', 'monitor.html', 'watch.html', 'whatif.html']) {
            const html = readFileSync(join(__dirname, file), 'utf8');
            expect(html).not.toContain('noindex');
            expect(html.match(/rel="canonical"/g)).toHaveLength(1);
        }
    });
});

describe('sortIssuersForDisplay', () => {
    it('puts live issuers first, by liquidity, and defunct ones last', () => {
        const issuers = [
            { slug: 'remora', name: 'Remora', status: 'defunct', market: { dexLiquidityUsd: 0 } },
            { slug: 'superstate', name: 'Opening Bell', status: 'live', market: { dexLiquidityUsd: 9420 } },
            { slug: 'xstocks', name: 'Kraken xStocks', status: 'live', market: { dexLiquidityUsd: 2_612_100 } }
        ];
        expect(sortIssuersForDisplay(issuers).map((i) => i.slug))
            .toEqual(['xstocks', 'superstate', 'remora']);
    });

    it('does not let a null liquidity outrank a real one', () => {
        const issuers = [
            { slug: 'unknown', name: 'Unknown', status: 'live', market: { dexLiquidityUsd: null } },
            { slug: 'small', name: 'Small', status: 'live', market: { dexLiquidityUsd: 1 } }
        ];
        expect(sortIssuersForDisplay(issuers).map((i) => i.slug)).toEqual(['small', 'unknown']);
    });
});

describe('escaping', () => {
    it('escapes quotes as well as angle brackets, so attribute values are safe', () => {
        expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
        expect(escapeHtml('a" onclick="x')).toBe('a&quot; onclick=&quot;x');
        expect(escapeHtml("it's")).toBe('it&#39;s');
        expect(escapeHtml('a & b')).toBe('a &amp; b');
    });

    it('renders an absent value as nothing at all', () => {
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
    });

    it('accepts only http(s), relative and mailto links', () => {
        expect(isSafeUrl('https://backed.fi/x.pdf')).toBe(true);
        expect(isSafeUrl('./index.html')).toBe(true);
        expect(isSafeUrl('mailto:a@b.c')).toBe(true);
        expect(isSafeUrl('javascript:alert(1)')).toBe(false);
        expect(isSafeUrl('data:text/html,<script>')).toBe(false);
        expect(isSafeUrl(null)).toBe(false);
        expect(isSafeUrl('rpc:getAccountInfo Abc')).toBe(false);
    });
});

// --- the ladder tooltips (MODEL §11.4, definitions from §2.2/§3.1/§3.2) --------------------------

describe('ladder tooltips', () => {
    it('has one definition per ledger-maturity level, naming the pillar that level adds', () => {
        expect(MATURITY_LEVEL_TOOLTIPS).toHaveLength(5);
        expect(maturityLevelTooltip(0)).toMatch(/none of the four pillars/i);
        expect(maturityLevelTooltip(1)).toMatch(/blockchainIsMainLedger/);
        expect(maturityLevelTooltip(2)).toMatch(/Tokenized/);
        expect(maturityLevelTooltip(2)).toMatch(/unconditionalTransfers/);
        expect(maturityLevelTooltip(3)).toMatch(/Issuer independent/);
        expect(maturityLevelTooltip(3)).toMatch(/bearerRedemption/);
        expect(maturityLevelTooltip(4)).toMatch(/Legally integrated/);
        expect(maturityLevelTooltip(4)).toMatch(/forcedTransfers/);
    });

    it('has one definition per claim-depth rung, naming what the holder owns', () => {
        expect(CLAIM_RUNG_TOOLTIPS).toHaveLength(5);
        expect(claimRungTooltip(0)).toMatch(/synthetic exposure/i);
        expect(claimRungTooltip(1)).toMatch(/unsecured creditor/i);
        expect(claimRungTooltip(2)).toMatch(/security interest/i);
        expect(claimRungTooltip(3)).toMatch(/beneficial interest/i);
        expect(claimRungTooltip(4)).toMatch(/registered/i);
    });

    it('returns nothing at all for a level or rung that is not one of the five', () => {
        for (const bad of [-1, 5, 9, null, undefined, 1.5, '2']) {
            expect(maturityLevelTooltip(bad)).toBe('');
            expect(claimRungTooltip(bad)).toBe('');
        }
    });
});

// --- time, relative and absolute ----------------------------------------------------------------

describe('isoToMillis', () => {
    it('parses an ISO timestamp, whatever the offset notation', () => {
        expect(isoToMillis('2026-09-16T19:08:30Z')).toBe(Date.parse('2026-09-16T19:08:30Z'));
        expect(isoToMillis('2026-09-16T19:08:30+00:00')).toBe(Date.parse('2026-09-16T19:08:30Z'));
    });

    it('is null for anything that is not a timestamp, so a sort puts it last', () => {
        for (const bad of [null, undefined, '', '   ', 'never', 42, {}]) {
            expect(isoToMillis(bad)).toBeNull();
        }
    });
});

describe('humanizeDuration', () => {
    it('picks the coarsest unit that still says something', () => {
        expect(humanizeDuration(8_000)).toBe('8 s');
        expect(humanizeDuration(11 * 60_000)).toBe('11 min');
        expect(humanizeDuration(3 * 3_600_000)).toBe('3 h');
        expect(humanizeDuration(2 * 86_400_000)).toBe('2 d');
        expect(humanizeDuration(120 * 86_400_000)).toBe('4 mo');
        expect(humanizeDuration(800 * 86_400_000)).toBe('2 y');
    });

    it('ignores the direction and never rounds a real span down to nothing', () => {
        expect(humanizeDuration(-3 * 3_600_000)).toBe('3 h');
        expect(humanizeDuration(200)).toBe('1 s');
    });

    it('is a dash when there is no duration', () => {
        for (const bad of NOTHINGS) expect(humanizeDuration(bad)).toBe(DASH);
    });
});

describe('fmtRelativeTime', () => {
    const now = Date.parse('2026-09-16T19:00:00Z');

    it('reads a recent past timestamp as an age', () => {
        expect(fmtRelativeTime('2026-09-16T16:00:00Z', now)).toBe('3 h ago');
        expect(fmtRelativeTime('2026-09-16T18:45:00Z', now)).toBe('15 min ago');
        expect(fmtRelativeTime('2026-09-14T19:00:00Z', now)).toBe('2 d ago');
    });

    it('says a stale timestamp is stale rather than dropping to a date', () => {
        expect(fmtRelativeTime('2026-05-16T19:00:00Z', now)).toBe('4 mo ago');
        expect(fmtRelativeTime('2024-09-16T19:00:00Z', now)).toBe('2 y ago');
    });

    it('never prints a future timestamp as an age, because that would invent a trade', () => {
        expect(fmtRelativeTime('2026-09-16T22:00:00Z', now)).toBe('in 3 h');
        expect(fmtRelativeTime('2026-09-17T19:00:00Z', now)).toBe('in 24 h');
        expect(fmtRelativeTime('2026-09-18T19:00:00Z', now)).toBe('in 2 d');
    });

    it('calls a few seconds either way "just now"', () => {
        expect(fmtRelativeTime('2026-09-16T18:59:40Z', now)).toBe('just now');
        expect(fmtRelativeTime('2026-09-16T19:00:20Z', now)).toBe('just now');
    });

    it('is a dash for a missing or unparseable timestamp, never "just now"', () => {
        for (const bad of [null, undefined, '', 'yesterday', 0, {}]) {
            expect(fmtRelativeTime(bad, now)).toBe(DASH);
        }
    });
});

describe('fmtAgeSeconds', () => {
    it('reads a reference price age in the unit that fits', () => {
        expect(fmtAgeSeconds(240)).toBe('4 min old');
        expect(fmtAgeSeconds(7_200)).toBe('2 h old');
    });

    it('is a dash for a missing age, never "0 s old"', () => {
        for (const bad of NOTHINGS) expect(fmtAgeSeconds(bad)).toBe(DASH);
    });
});

// --- trading activity (MODEL §11.1–§11.3) -------------------------------------------------------

describe('fmtTradesPerTrader', () => {
    it('keeps a decimal while the ratio is small and groups it once it is large', () => {
        expect(fmtTradesPerTrader(3.44)).toBe('3.4');
        expect(fmtTradesPerTrader(1)).toBe('1.0');
        expect(fmtTradesPerTrader(99.94)).toBe('99.9');
        expect(fmtTradesPerTrader(1204.5)).toBe('1,205');
    });

    it('is a dash when the ratio is unknown, so no mint looks like one trade per trader', () => {
        for (const bad of NOTHINGS) expect(fmtTradesPerTrader(bad)).toBe(DASH);
    });
});

describe('fmtCountOfTotal', () => {
    it('shows the traded count against the total', () => {
        expect(fmtCountOfTotal(3, 61)).toBe('3 / 61');
        expect(fmtCountOfTotal(0, 61)).toBe('0 / 61');
        expect(fmtCountOfTotal(null, 61)).toBe(`${DASH} / 61`);
        expect(fmtCountOfTotal(3, null)).toBe(`3 / ${DASH}`);
    });

    it('is one dash when neither side is known', () => {
        expect(fmtCountOfTotal(null, null)).toBe(DASH);
        expect(fmtCountOfTotal(undefined, NaN)).toBe(DASH);
    });
});

describe('venue spread', () => {
    it('reads a spread to two decimals, because tenths of a percent are the point', () => {
        expect(fmtVenueSpreadPct(0.5712)).toBe('0.57 %');
        expect(fmtVenueSpreadPct(0)).toBe('0.00 %');
        expect(fmtVenueSpreadPct(12.5)).toBe('12.50 %');
    });

    it('names the cheapest and dearest venue and how many were priced', () => {
        expect(fmtVenueSpread({
            venueSpreadPct: 0.5712,
            venueSpreadLow: 'Raydium',
            venueSpreadHigh: 'Kraken',
            venuesPriced: 5
        })).toBe('0.57 % (Raydium → Kraken, 5 venues priced)');
        expect(fmtVenueSpread({ venueSpreadPct: 2, venuesPriced: 1 })).toBe('2.00 % (1 venue priced)');
        expect(fmtVenueSpread({ venueSpreadPct: 2, venueSpreadHigh: 'MEXC' })).toBe('2.00 % (to MEXC)');
    });

    it('is a dash whenever the spread itself is missing', () => {
        expect(fmtVenueSpread({ venueSpreadPct: null, venueSpreadLow: 'Raydium', venuesPriced: 4 })).toBe(DASH);
        for (const bad of [null, undefined, {}, 'x']) expect(fmtVenueSpread(bad)).toBe(DASH);
        for (const bad of NOTHINGS) expect(fmtVenueSpreadPct(bad)).toBe(DASH);
    });
});

describe('activityFlags', () => {
    it('flags the wash-trading tell strictly above the threshold', () => {
        expect(activityFlags({ tradesPerTrader: ACTIVITY_FLAG_TRADES_PER_TRADER + 0.1 })
            .map((f) => f.code)).toEqual(['wash']);
        expect(activityFlags({ tradesPerTrader: ACTIVITY_FLAG_TRADES_PER_TRADER })).toEqual([]);
        expect(activityFlags({ tradesPerTrader: 3 })).toEqual([]);
    });

    it('flags an organic share strictly under the threshold', () => {
        expect(activityFlags({ organicSharePct: ACTIVITY_FLAG_ORGANIC_PCT - 0.1 })
            .map((f) => f.code)).toEqual(['inorganic']);
        expect(activityFlags({ organicSharePct: ACTIVITY_FLAG_ORGANIC_PCT })).toEqual([]);
        expect(activityFlags({ organicSharePct: 61 })).toEqual([]);
    });

    it('carries a label and an explanation, so the badge is never colour alone', () => {
        const [flag] = activityFlags({ tradesPerTrader: 42.3 });
        expect(flag.label).toBeTruthy();
        expect(flag.glyph).toBeTruthy();
        expect(flag.detail).toContain('42.3');
        expect(flag.detail).toContain(String(ACTIVITY_FLAG_TRADES_PER_TRADER));
    });

    it('never trips on a missing value — a null is not a zero organic share', () => {
        expect(activityFlags({ tradesPerTrader: null, organicSharePct: null })).toEqual([]);
        expect(activityFlags({})).toEqual([]);
        for (const bad of [null, undefined, 'x', 7]) expect(activityFlags(bad)).toEqual([]);
    });

    it('can raise both flags at once', () => {
        expect(activityFlags({ tradesPerTrader: 900, organicSharePct: 0.4 }).map((f) => f.code))
            .toEqual(['wash', 'inorganic']);
    });
});

describe('issuerActivityRow and activityRows', () => {
    const live = {
        slug: 'xstocks-backed',
        name: 'Kraken xStocks',
        status: 'live',
        market: { tokens: 61, organicSharePct: 44.2 },
        activity: {
            tokensTraded24: 57,
            trades24: 41_200,
            traders24: 1_030,
            tradesPerTrader: 40,
            organicSharePct: 12.5,
            venueCount: 9,
            venueSpreadMedianPct: 0.42,
            venuesTop: [{ name: 'Raydium', kind: 'dex', volume24Usd: 1e6, liquidityUsd: 2e6 }],
            lastTradedAt: '2026-09-16T19:08:30Z',
            lastTradedVenue: 'Kraken'
        }
    };

    it('copies the §11.3 aggregate straight through', () => {
        const row = issuerActivityRow(live);
        expect(row).toMatchObject({
            slug: 'xstocks-backed',
            tokens: 61,
            tokensTraded24: 57,
            trades24: 41_200,
            traders24: 1_030,
            tradesPerTrader: 40,
            organicSharePct: 12.5,
            venueCount: 9,
            venueSpreadMedianPct: 0.42,
            lastTradedAt: '2026-09-16T19:08:30Z',
            lastTradedVenue: 'Kraken'
        });
        expect(row.flags.map((f) => f.code)).toEqual(['wash']);
    });

    it('falls back to the market organic share, which is the same quantity from the same build', () => {
        const row = issuerActivityRow({ ...live, activity: { ...live.activity, organicSharePct: null } });
        expect(row.organicSharePct).toBe(44.2);
    });

    it('keeps every unbuilt field null rather than zero, and raises no flag on it', () => {
        const row = issuerActivityRow({ slug: 'bullish', name: 'Bullish', status: 'live' });
        expect(row.tokens).toBeNull();
        expect(row.trades24).toBeNull();
        expect(row.traders24).toBeNull();
        expect(row.tradesPerTrader).toBeNull();
        expect(row.organicSharePct).toBeNull();
        expect(row.venueCount).toBeNull();
        expect(row.venueSpreadMedianPct).toBeNull();
        expect(row.lastTradedAt).toBeNull();
        expect(row.venuesTop).toEqual([]);
        expect(row.flags).toEqual([]);
    });

    it('lists live issuers only — a defunct programme has no 24h activity to report', () => {
        const rows = activityRows([
            live,
            { slug: 'remora-markets', name: 'Remora', status: 'defunct', activity: { trades24: 5 } },
            { slug: 'ventuals', name: 'Ventuals', status: 'not-launched' }
        ]);
        expect(rows.map((r) => r.slug)).toEqual(['xstocks-backed']);
        expect(activityRows(null)).toEqual([]);
    });
});

describe('venueRows', () => {
    const venues = {
        dex: [
            { dexId: 'meteora', pairAddress: 'LaB4', quoteSymbol: 'USDC', liquidityUsd: 867, volume24Usd: 54.69, txns24: 12, priceUsd: 9.5, url: 'https://dexscreener.com/solana/lab4' },
            { dexId: 'raydium', quoteSymbol: 'SOL', liquidityUsd: 50_000, volume24Usd: 900_000, url: 'https://dexscreener.com/solana/ray' }
        ],
        cex: [
            { market: 'MEXC', base: 'MRNAON', target: 'USDT', volume24Usd: 104_327, priceUsd: 9.62, lastTradedAt: '2026-09-16T19:08:30+00:00', url: 'https://www.mexc.com/exchange/MRNAON_USDT' }
        ]
    };

    it('shapes a DEX pair and a CEX market into the same row', () => {
        const rows = venueRows(venues);
        const meteora = rows.find((r) => r.name === 'meteora');
        expect(meteora).toEqual({
            kind: 'dex',
            name: 'meteora',
            pair: '/USDC',
            pairFull: '/USDC',
            liquidityUsd: 867,
            volume24Usd: 54.69,
            priceUsd: 9.5,
            txns24: 12,
            lastTradedAt: null,
            url: 'https://dexscreener.com/solana/lab4'
        });
        expect(rows.find((r) => r.name === 'MEXC')).toEqual({
            kind: 'cex',
            name: 'MEXC',
            pair: 'MRNAON/USDT',
            pairFull: 'MRNAON/USDT',
            liquidityUsd: null,
            volume24Usd: 104_327,
            priceUsd: 9.62,
            txns24: null,
            lastTradedAt: '2026-09-16T19:08:30+00:00',
            url: 'https://www.mexc.com/exchange/MRNAON_USDT'
        });
    });

    it('orders the busiest venue first and keeps an unreported volume last', () => {
        const rows = venueRows({
            dex: [{ dexId: 'quiet', volume24Usd: null, liquidityUsd: 10 }],
            cex: [{ market: 'busy', volume24Usd: 5 }, { market: 'busier', volume24Usd: 50 }]
        });
        expect(rows.map((r) => r.name)).toEqual(['busier', 'busy', 'quiet']);
    });

    it('accepts one flat array too, inferring the kind from the fields', () => {
        const rows = venueRows([
            { pairAddress: 'abc', dexId: 'orca', volume24Usd: 2 },
            { market: 'Bybit', volume24Usd: 1 }
        ]);
        expect(rows.map((r) => `${r.kind}:${r.name}`)).toEqual(['dex:orca', 'cex:Bybit']);
    });

    it('shortens a mint address used as a pair leg, keeping the full pair alongside it', () => {
        const [row] = venueRows({
            cex: [{
                market: 'Raydium (CLMM)',
                base: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W',
                target: 'USDC'
            }]
        });
        expect(row.pair).toBe('XsoC…DF2W/USDC');
        expect(row.pairFull).toBe('XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W/USDC');
    });

    it('drops an unusable link rather than emitting it as an href', () => {
        const [row] = venueRows({ cex: [{ market: 'Evil', url: 'javascript:alert(1)' }] });
        expect(row.url).toBeNull();
    });

    it('is an empty list for anything that is not a venue set', () => {
        for (const bad of [null, undefined, {}, 'x', 7, { dex: 'no', cex: null }]) {
            expect(venueRows(bad)).toEqual([]);
        }
        expect(venueRows([null, {}, { nothing: true }])).toEqual([]);
    });
});

/**
 * Dossier prose lives in the issuer file only (MODEL.md §10.1). A copy of any of these in the token
 * file is what made the single database 1.4 MB, so the keys are checked by name, at any depth.
 */
const DOSSIER_KEYS = ['documents', 'attestations', 'findings', 'vocabulary'];

/** The six fields §10.1 allows on an issuerIndex entry, sorted for comparison. */
// The six display fields, plus the evidence SUMMARY added 2026-09-18 (EVIDENCE.md §4) — counts
// and coverage only, never the claims array with its verbatim quotes, which is what keeps this
// file inside the byte budget below.
const INDEX_FIELDS = ['claimRung', 'evidence', 'legalForm', 'maturityStageNum', 'name', 'slug',
    'status'];

/** Every object key anywhere inside a value, so a nested copy cannot hide from the check. */
function keysDeep(value, found = new Set()) {
    if (Array.isArray(value)) {
        for (const item of value) keysDeep(item, found);
    } else if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
            found.add(key);
            keysDeep(child, found);
        }
    }
    return found;
}

describe('the sample fixtures', () => {
    const issuerDb = require('./stocks/fixtures/stocks-issuers.sample.json');
    const tokenDb = require('./stocks/fixtures/stocks-tokens.sample.json');

    it('carries the fields each of the page’s two loads reads', () => {
        expect(fetchedAtOf(issuerDb.sources.universe)).toBeTruthy();
        expect(issuerDb.issuers.length).toBeGreaterThan(0);
        expect(fetchedAtOf(tokenDb.sources.universe)).toBeTruthy();
        expect(tokenDb.tokens.length).toBeGreaterThan(0);
        expect(tokenDb.issuerIndex).toHaveLength(issuerDb.issuers.length);
    });

    it('was split from one build, so the two halves cannot disagree on when or on whom', () => {
        expect(tokenDb.builtAt).toBe(issuerDb.builtAt);
        expect(tokenDb.issuerIndex.map((e) => e.slug)).toEqual(issuerDb.issuers.map((i) => i.slug));
    });

    it('places every live issuer on the grid or knowingly off it', () => {
        for (const issuer of issuerDb.issuers) {
            const cell = gridCell(issuer.grades.claimRung, issuer.grades.maturityStageNum);
            if (cell === null) expect(issuer.grades.claimRung).toBeNull();
            else expect(cell.column).toBeGreaterThanOrEqual(GRID_FIRST_DATA_COLUMN);
        }
    });

    it('references only tokens that exist, and only issuers that exist', () => {
        const mints = new Set(tokenDb.tokens.map((t) => t.mint));
        const slugs = new Set(issuerDb.issuers.map((i) => i.slug));
        for (const issuer of issuerDb.issuers) {
            for (const mint of issuer.tokenMints) expect(mints.has(mint)).toBe(true);
        }
        for (const token of tokenDb.tokens) expect(slugs.has(token.issuer)).toBe(true);
    });

    it('has at least one defunct issuer and one null-heavy token, which is the point of a fixture', () => {
        expect(issuerDb.issuers.some((i) => i.status === 'defunct')).toBe(true);
        expect(tokenDb.tokens.some((t) => t.market.usdPrice === null)).toBe(true);
        expect(tokenDb.tokens.some((t) => t.reference.premiumPct === null)).toBe(true);
    });

    it('keeps the dossier fields out of the token fixture', () => {
        const keys = keysDeep(tokenDb.tokens);
        const indexKeys = keysDeep(tokenDb.issuerIndex);
        for (const key of DOSSIER_KEYS) {
            expect([...keys]).not.toContain(key);
            expect([...indexKeys]).not.toContain(key);
        }
        // The issuer fixture is where they have to be, or the check above proves nothing.
        expect([...keysDeep(issuerDb.issuers)]).toEqual(expect.arrayContaining(DOSSIER_KEYS));
    });
});

describe('the built database', () => {
    const issuerDb = require('./stocks-issuers.json');
    const tokenDb = require('./stocks-tokens.json');

    it('splits one build into the file the page reads first and the file it reads second', () => {
        expect(issuerDb.issuers.length).toBeGreaterThan(0);
        expect(tokenDb.tokens.length).toBeGreaterThan(0);
        expect(tokenDb.builtAt).toBe(issuerDb.builtAt);
        expect(tokenDb.issuerIndex.map((e) => e.slug)).toEqual(issuerDb.issuers.map((i) => i.slug));
    });

    it('carries no dossier field on any token or index entry', () => {
        const keys = keysDeep(tokenDb.tokens);
        const indexKeys = keysDeep(tokenDb.issuerIndex);
        for (const key of DOSSIER_KEYS) {
            expect([...keys]).not.toContain(key);
            expect([...indexKeys]).not.toContain(key);
        }
    });

    it('gives an index entry exactly the six display fields plus the evidence summary', () => {
        for (const entry of tokenDb.issuerIndex) {
            expect(Object.keys(entry).sort()).toEqual(INDEX_FIELDS);
            expect(Object.keys(entry.evidence).sort()).toEqual([
                'claims', 'confirmed', 'corrected', 'coverage', 'inference', 'lastCheckedAt',
                'unverified'
            ]);
        }
    });

    /**
     * The ceiling was 1 MiB until 2026-09-16, when the §11.2 `activity` object landed on all 441
     * tokens and took the file to 1.05 MB. The budget exists to catch prose leaking back in, which
     * would add hundreds of kilobytes at once, so it is raised rather than removed — the split was
     * away from a 1.4 MB single database, and this must stay clearly the smaller half of two files.
     */
    it('keeps the token file inside its byte budget, which is why it was split off', () => {
        const bytes = statSync(join(__dirname, 'stocks-tokens.json')).size;
        expect(bytes).toBeLessThan(1.5 * 1024 * 1024);
    });
});

/**
 * The formatters moved out of this file into stocks/lib/fmt.js on 2026-09-17, so the browser table
 * and the server-rendered stock cards (stocks/build-cards.mjs) cannot drift apart in what a price,
 * a premium or a missing value looks like. These tests pin the move: one copy, the same function
 * objects on both sides, and the module loaded before stocks.js on the page.
 */
describe('the shared formatter module', () => {
    const fmt = require('./stocks/lib/fmt.js');
    const page = require('./stocks.js');
    const { readFileSync } = require('node:fs');

    const SHARED = [
        'DASH', 'isNum', 'escapeHtml', 'isSafeUrl', 'fmtNumber', 'fmtMoney', 'fmtPrice', 'fmtPct',
        'fmtSignedPct', 'fmtDateTime', 'fmtDate', 'fetchedAtOf', 'isoToMillis', 'humanizeDuration',
        'fmtRelativeTime', 'fmtAgeSeconds', 'fmtTradesPerTrader', 'fmtCountOfTotal',
        'fmtVenueSpreadPct', 'fmtVenueSpread', 'humanizeSlug', 'cardSlug', 'mintSuffix'
    ];

    it('exports every formatter both worlds use, plus the builders-only helpers', () => {
        for (const name of [...SHARED, 'roundSignificant']) {
            expect(fmt[name]).toBeDefined();
        }
        expect(typeof fmt.fmtMoney).toBe('function');
        expect(fmt.DASH).toBe('—');
    });

    it('is the one copy: stocks.js re-exports the very same objects', () => {
        for (const name of SHARED) {
            expect(page[name]).toBe(fmt[name]);
        }
    });

    it('leaves no second declaration of any of them in stocks.js', () => {
        const source = readFileSync(join(__dirname, 'stocks.js'), 'utf8');
        for (const name of SHARED.filter((key) => key !== 'DASH')) {
            expect(source).not.toMatch(new RegExp(`^\\s*function ${name}\\s*\\(`, 'm'));
        }
    });

    it('is loaded by stocks.html before stocks.js, both cache-busted', () => {
        const html = readFileSync(join(__dirname, 'stocks.html'), 'utf8');
        const fmtAt = html.indexOf('stocks/lib/fmt.js?v=');
        const pageAt = html.indexOf('stocks.js?v=');
        expect(fmtAt).toBeGreaterThan(-1);
        expect(pageAt).toBeGreaterThan(fmtAt);
    });

    it('builds the row and panel "Card" link from the computed slug', () => {
        const html = page.cardLinkHtml({ symbol: 'NVDAx', mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh' });
        expect(html).toContain('href="cards/NVDAx.html"');
        expect(html).toContain('class="card-link"');
        expect(page.cardLinkHtml({ symbol: '"><img src=x>', mint: 'M' })).not.toContain('<img');
        expect(page.cardLinkHtml({})).toBe('');
    });
});

describe('fmtMoney above a billion', () => {
    const { fmtMoney: money } = require('./stocks/lib/fmt.js');

    it('has a trillion band, because issuer valuations and market caps live there', () => {
        expect(money(1_921_371_313_796)).toBe('$1.92T');
        expect(money(4_864_750_990_300)).toBe('$4.86T');
        expect(money(999_999_999_999)).toBe('$1000.00B');
        expect(money(-2_500_000_000_000)).toBe('$-2.50T');
    });
});

// ------------------------------------------------- the "New on Solana" strip

describe('newMintChips', () => {
    const { readFileSync } = require('node:fs');
    const page = require('./stocks.js');
    const NOW = Date.parse('2026-09-17T11:50:27Z');

    /** A stocks-changes.json `newMints[]` row as build-changes.mjs writes it. */
    function feedRow(overrides = {}) {
        return {
            mint: 'AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES',
            symbol: 'AMD',
            name: 'Advanced Micro Devices - Backpack Securities',
            issuer: 'backpack-securities',
            issuerName: 'Backpack Securities SPCX',
            firstSeenAt: '2026-09-17T09:50:27Z',
            cardSlug: 'AMD',
            ...overrides
        };
    }

    it('shapes one chip per row, in the order the feed selected them', () => {
        const chips = page.newMintChips({
            newMints: [feedRow(), feedRow({ symbol: 'LUV', mint: 'LUV9', cardSlug: 'LUV', firstSeenAt: '2026-09-16T23:00:00Z' })]
        }, NOW);
        expect(chips.map((chip) => chip.symbol)).toEqual(['AMD', 'LUV']);
        expect(chips[0].issuer).toBe('Backpack Securities SPCX');
        expect(chips[0].href).toBe('./cards/AMD.html');
        expect(chips[0].firstSeen).toBe('2 h ago');
        expect(chips[0].title).toContain('first seen 17 Sep 2026 09:50 UTC');
    });

    it('takes its age from the instant passed in, so the same feed shapes the same way', () => {
        const [chip] = page.newMintChips({ newMints: [feedRow()] }, Date.parse('2026-09-19T09:50:27Z'));
        expect(chip.firstSeen).toBe('2 d ago');
    });

    it('leaves a missing first-seen time null rather than dating the mint now', () => {
        const [chip] = page.newMintChips({ newMints: [feedRow({ firstSeenAt: null })] }, NOW);
        expect(chip.firstSeen).toBeNull();
        expect(chip.title).not.toMatch(/first seen/);
    });

    it('never links to a card the build did not write', () => {
        const [chip] = page.newMintChips({ newMints: [feedRow({ cardSlug: null })] }, NOW);
        expect(chip.href).toBeNull();
        const [escaped] = page.newMintChips({ newMints: [feedRow({ cardSlug: 'a"><img src=x>' })] }, NOW);
        expect(escaped.href).not.toContain('<img');
    });

    it('falls back to the readable issuer slug when the build named no issuer', () => {
        const [chip] = page.newMintChips({ newMints: [feedRow({ issuerName: null, issuer: 'ondo-global-markets' })] }, NOW);
        expect(chip.issuer).toBe('Ondo global markets');
    });

    it('renders nothing at all when the file, the feed or the rows are unusable', () => {
        expect(page.newMintChips(null, NOW)).toEqual([]);
        expect(page.newMintChips({}, NOW)).toEqual([]);
        expect(page.newMintChips({ newMints: {} }, NOW)).toEqual([]);
        expect(page.newMintChips({ newMints: [null, 7, {}, { symbol: ' ' }] }, NOW)).toEqual([]);
    });

    it('reads the window off the feed and falls back to a fortnight', () => {
        expect(page.newMintsWindowDays({ newMintWindowDays: 30 })).toBe(30);
        expect(page.newMintsWindowDays(null)).toBe(14);
        expect(page.newMintsWindowDays({ newMintWindowDays: -1 })).toBe(page.NEW_MINTS_WINDOW_DAYS);
    });

    it('is wired into stocks.html: the strip is there and starts hidden', () => {
        const html = readFileSync(join(__dirname, 'stocks.html'), 'utf8');
        expect(html).toMatch(/<section id="newMints"[^>]*hidden/);
        expect(html).toContain('id="newMintsTrack"');
        expect(html).toMatch(/id="newMintsClone"[^>]*aria-hidden="true"/);
    });

    it('is fed by stocks-changes.json, which stocks.js fetches as its third file', () => {
        const source = readFileSync(join(__dirname, 'stocks.js'), 'utf8');
        expect(source).toContain("const CHANGES_PATH = './stocks-changes.json'");
        expect(source).toMatch(/fetchJson\(CHANGES_PATH\)/);
        expect(source).toContain("has('reduceMotion')");
        expect(source).toContain("classList.add('reduce-motion')");
    });
});

/**
 * The funnel graphic (stocks-funnel.json → funnelLayout → an inline SVG). The layout is the part
 * with arithmetic in it, so it is tested here rather than looked at: every circle inside the box,
 * radii that rise with the mint count and floor instead of vanishing, and connectors that only ever
 * join two circles that exist. The last two tests pin the wiring into stocks.html and stocks.js.
 */
describe('the funnel graphic', () => {
    const { readFileSync } = require('node:fs');
    const page = require('./stocks.js');
    const funnelDb = require('./stocks-funnel.json');

    /** A funnel small enough to reason about, with the same shape lib/funnel.mjs emits. */
    const FUNNEL = {
        columns: [
            {
                key: 'tokens', title: 'Mints', total: 100, nodes: [
                    { id: 'instrument:stock', label: 'Stocks', count: 99, kind: 'instrument' },
                    { id: 'instrument:etf', label: 'ETFs', count: 1, kind: 'instrument' }
                ]
            },
            {
                key: 'issuers', title: 'Issuer programmes', total: 100, nodes: [
                    { id: 'big', label: 'Big Issuer', count: 99, status: 'live' },
                    { id: 'tiny', label: 'Tiny Issuer', count: 1, status: 'live' },
                    { id: 'gone', label: 'Gone Issuer', count: 0, status: 'defunct' },
                    { id: 'soon', label: 'Soon Issuer', count: 0, status: 'live' }
                ]
            },
            {
                key: 'recipes', title: 'Recipes (program + extensions)', total: 100, nodes: [
                    { id: 'recipe:token-2022 · pausable', label: 'token-2022 · pausable', count: 100 }
                ]
            },
            {
                key: 'programs', title: 'Token program', total: 100, nodes: [
                    { id: 'program:token-2022', label: 'Token-2022', count: 100 }
                ]
            }
        ],
        edges: [
            { from: 'instrument:stock', to: 'big', count: 99 },
            { from: 'instrument:etf', to: 'tiny', count: 1 },
            { from: 'big', to: 'recipe:token-2022 · pausable', count: 99 },
            { from: 'tiny', to: 'recipe:token-2022 · pausable', count: 1 },
            { from: 'recipe:token-2022 · pausable', to: 'program:token-2022', count: 100 }
        ]
    };

    const layout = page.funnelLayout(FUNNEL, { width: 1000, height: 400 });
    const nodeById = new Map(layout.nodes.map((node) => [node.id, node]));

    it('heads the section with the real totals, spelled from the data', () => {
        expect(page.funnelTitle(FUNNEL)).toBe('From 100 mints to one token program');
        expect(page.funnelTitle(funnelDb)).toBe(`From ${fmtNumber(funnelDb.columns[0].total)} mints to one token program`);
    });

    it('pluralises the heading rather than claiming one program when there are two', () => {
        const two = { columns: [{ key: 'tokens', total: 8, nodes: [] }, { key: 'programs', total: 8, nodes: [{ id: 'a', count: 5 }, { id: 'b', count: 3 }] }] };
        expect(page.funnelTitle(two)).toBe('From 8 mints to two token programs');
        expect(page.funnelTitle(null)).toBeNull();
        expect(page.funnelTitle({ columns: [] })).toBeNull();
    });

    it('keeps every circle inside the box it was given', () => {
        expect(layout.nodes.length).toBe(8);
        for (const node of layout.nodes) {
            expect(node.x - node.r).toBeGreaterThanOrEqual(0);
            expect(node.x + node.r).toBeLessThanOrEqual(layout.width);
            expect(node.y - node.r).toBeGreaterThanOrEqual(0);
            expect(node.y + node.r).toBeLessThanOrEqual(layout.height);
        }
    });

    it('keeps them inside even a box far too short for them', () => {
        const squashed = page.funnelLayout(FUNNEL, { width: 1000, height: 80 });
        for (const node of squashed.nodes) {
            expect(node.y - node.r).toBeGreaterThanOrEqual(0);
            expect(node.y + node.r).toBeLessThanOrEqual(80);
        }
    });

    it('lays the four columns out left to right, in reading order', () => {
        expect(layout.columns.map((column) => column.key)).toEqual(['tokens', 'issuers', 'recipes', 'programs']);
        const xs = layout.columns.map((column) => column.x);
        expect(xs).toEqual([...xs].sort((a, b) => a - b));
        expect(new Set(xs).size).toBe(4);
    });

    it('heads each column with the number that column is about: 100 mints, then 4, 1, 1', () => {
        expect(layout.columns.map((column) => column.headline)).toEqual([100, 4, 1, 1]);
    });

    it('makes a circle’s area follow its mint count, so radius rises with it', () => {
        const sorted = [...layout.nodes].sort((a, b) => a.count - b.count);
        for (let i = 1; i < sorted.length; i++) {
            expect(sorted[i].r).toBeGreaterThanOrEqual(sorted[i - 1].r);
        }
        // Area, not radius: four times the mints is twice the radius, within rounding.
        const quarter = page.funnelLayout({
            columns: [{ key: 'tokens', title: 'Mints', total: 500, nodes: [
                { id: 'a', label: 'a', count: 400 }, { id: 'b', label: 'b', count: 100 }
            ] }],
            edges: []
        }, { width: 1000, height: 400 });
        const [big, small] = quarter.nodes;
        expect(small.r / big.r).toBeCloseTo(0.5, 1);
    });

    it('floors the radius, so a one-mint programme is still a visible dot', () => {
        expect(nodeById.get('tiny').r).toBe(page.FUNNEL_MIN_R);
        expect(nodeById.get('gone').r).toBe(page.FUNNEL_MIN_R);
        expect(nodeById.get('big').r).toBeGreaterThan(page.FUNNEL_MIN_R);
        expect(nodeById.get('big').r).toBeLessThanOrEqual(page.FUNNEL_MAX_R);
    });

    it('draws a mint-less or defunct programme hollow, and only an issuer circle at all', () => {
        expect(nodeById.get('gone').hollow).toBe(true);
        expect(nodeById.get('soon').hollow).toBe(true);
        expect(nodeById.get('big').hollow).toBe(false);
        expect(nodeById.get('instrument:stock').hollow).toBe(false);
        expect(nodeById.get('program:token-2022').hollow).toBe(false);
    });

    it('gives only issuer circles a slug to open a dossier with', () => {
        expect(nodeById.get('big').slug).toBe('big');
        expect(nodeById.get('gone').slug).toBe('gone');
        expect(nodeById.get('instrument:stock').slug).toBeNull();
        expect(nodeById.get('recipe:token-2022 · pausable').slug).toBeNull();
        expect(nodeById.get('program:token-2022').slug).toBeNull();
    });

    it('labels a circle with its count, and drops the program a recipe label repeats', () => {
        expect(nodeById.get('big').text).toBe('Big Issuer · 99');
        expect(nodeById.get('recipe:token-2022 · pausable').text).toBe('pausable · 100');
        expect(nodeById.get('instrument:etf').text).toBe('ETFs · 1');
    });

    it('hovers the FULL label, the mint count and an issuer’s status', () => {
        expect(nodeById.get('recipe:token-2022 · pausable').title).toBe('token-2022 · pausable — 100 mints');
        expect(nodeById.get('tiny').title).toBe('Tiny Issuer — 1 mint, live');
        expect(nodeById.get('gone').title).toBe('Gone Issuer — 0 mints, defunct');
    });

    it('draws every connector between two circles that exist', () => {
        expect(layout.edges).toHaveLength(FUNNEL.edges.length);
        for (const edge of layout.edges) {
            expect(nodeById.has(edge.from)).toBe(true);
            expect(nodeById.has(edge.to)).toBe(true);
            expect(edge.d).toMatch(/^M[\d.,-]+C[\d.,\s-]+$/);
            expect(edge.title).toContain('→');
        }
    });

    it('starts each connector at one circle’s edge and ends it at the other’s', () => {
        const edge = layout.edges.find((e) => e.from === 'big');
        const from = nodeById.get('big');
        const to = nodeById.get('recipe:token-2022 · pausable');
        expect(edge.d.startsWith(`M${from.x + from.r},${from.y}C`)).toBe(true);
        expect(edge.d.endsWith(`${to.x - to.r},${to.y}`)).toBe(true);
    });

    it('drops a connector whose endpoints are not both circles, rather than drawing to nowhere', () => {
        const dangling = page.funnelLayout({
            columns: FUNNEL.columns,
            edges: [...FUNNEL.edges, { from: 'big', to: 'no-such-node', count: 5 }, { from: 'ghost', to: 'tiny', count: 5 }]
        }, { width: 1000, height: 400 });
        expect(dangling.edges).toHaveLength(FUNNEL.edges.length);
    });

    it('scales the connector width with its count, with a floor', () => {
        const widest = layout.edges.find((e) => e.count === 100);
        const thinnest = layout.edges.find((e) => e.count === 1);
        expect(widest.strokeWidth).toBe(page.FUNNEL_EDGE_MAX_PX);
        expect(thinnest.strokeWidth).toBe(page.FUNNEL_EDGE_MIN_PX);
        expect(thinnest.strokeWidth).toBeLessThan(widest.strokeWidth);
    });

    it('draws nothing from nothing, instead of throwing', () => {
        for (const empty of [null, undefined, {}, { columns: [] }, { columns: [], edges: null }]) {
            const result = page.funnelLayout(empty, {});
            expect(result.nodes).toEqual([]);
            expect(result.edges).toEqual([]);
            expect(result.width).toBeGreaterThan(0);
            expect(result.height).toBeGreaterThan(0);
        }
    });

    it('grows the box with the tallest column, so twelve programmes are not squeezed', () => {
        const twelve = { columns: [{ key: 'issuers', title: 'Issuer programmes', total: 0, nodes: Array.from({ length: 12 }, (_, i) => ({ id: `i${i}`, label: `I${i}`, count: 1 })) }] };
        expect(page.funnelHeight(twelve)).toBeGreaterThan(page.funnelHeight({ columns: [] }));
        expect(page.funnelLayout(twelve, {}).height).toBe(page.funnelHeight(twelve));
    });

    it('lays out the real built funnel without a circle escaping the box', () => {
        const real = page.funnelLayout(funnelDb, {});
        expect(real.nodes.length).toBeGreaterThan(20);
        expect(real.edges).toHaveLength(funnelDb.edges.length);
        for (const node of real.nodes) {
            expect(node.x - node.r).toBeGreaterThanOrEqual(0);
            expect(node.x + node.r).toBeLessThanOrEqual(real.width);
            expect(node.y - node.r).toBeGreaterThanOrEqual(0);
            expect(node.y + node.r).toBeLessThanOrEqual(real.height);
        }
        expect(real.nodes.filter((node) => node.slug !== null).length)
            .toBe(funnelDb.columns.find((c) => c.key === 'issuers').nodes.length);
    });

    it('is wired into stocks.html above the grid, and starts hidden', () => {
        const html = readFileSync(join(__dirname, 'stocks.html'), 'utf8');
        expect(html).toMatch(/<section id="funnelSection"[^>]*hidden/);
        expect(html).toContain('id="funnelGraphic"');
        expect(html).toContain('class="funnel-scroll"');
        expect(html.indexOf('id="funnelSection"')).toBeLessThan(html.indexOf('id="gridSection"'));
        // The heading is written from the funnel's own totals, so it must not be spelled here.
        expect(html).not.toMatch(/<h2 id="funnelHeading">From/);
    });

    it('is fed by stocks-funnel.json, which stocks.js fetches with the issuers', () => {
        const source = readFileSync(join(__dirname, 'stocks.js'), 'utf8');
        expect(source).toContain("const FUNNEL_PATH = './stocks-funnel.json'");
        expect(source).toMatch(/fetchJson\(FUNNEL_PATH\)/);
        expect(source).toMatch(/renderFunnel\(funnel\)/);
    });

    it('takes its colours from the theme’s own variables, in both themes', () => {
        const css = readFileSync(join(__dirname, 'stocks.css'), 'utf8');
        const block = css.slice(css.indexOf('.funnel-scroll'), css.indexOf('.grid-scroll'));
        expect(block).toContain('overflow-x: auto');
        // No literal colour anywhere in the block: every fill and stroke is a theme custom
        // property, which is the only reason the graphic follows dark and light for free.
        expect(block).not.toMatch(/#[0-9a-fA-F]{3}/);
        expect(block).not.toMatch(/\brgba?\(/);
        expect(block).toMatch(/fill: var\(--page-text\)/);
        expect(block).toMatch(/stroke: var\(--muted-text\)/);
        expect(block).not.toContain('!important');
    });
});

/**
 * Evidence chips (stocks/EVIDENCE.md §4). The claim logic itself is tested in
 * stocks/evidence.test.js against the shared module; what is tested here is the page's own markup
 * and the two numbers a reader sees: that a chip escapes a quote instead of injecting it, that an
 * unsafe URL is never rendered as a link, that a field which needs a source but has none gets the
 * hollow form and says so, and that the evidence line reads the way it was specified.
 */
describe('evidence chips on the issuer panel', () => {
    const S = require('./stocks.js');
    const { readFileSync } = require('node:fs');
    const FIXTURE = JSON.parse(
        readFileSync(join(__dirname, 'stocks', 'fixtures', 'dossier-claims.sample.json'), 'utf8')
    );
    const evidence = require('./stocks/lib/evidence.js');
    const CLAIM_FIELDS = JSON.parse(
        readFileSync(join(__dirname, 'stocks', 'data', 'claim-fields.json'), 'utf8')
    ).fields;

    /** The panel's index, as detailHtml() builds it: claims by field plus the needed set. */
    function index(record = FIXTURE) {
        const built = S.evidenceIndex(
            { ...record, claims: evidence.dossierClaims('fixture', record) },
            CLAIM_FIELDS
        );
        built.documents = record.documents ?? [];
        return built;
    }

    it('draws a chip on a field that has a claim, with the quote and the locator', () => {
        const html = S.fieldChipHtml(index(), 'redemption.rails', 'Rails');
        expect(html).toContain('<details class="ev-chip ev-confirmed">');
        expect(html).toContain('USDC or another mutually agreed form of value');
        expect(html).toContain('s. 4.1.1');
        // Both claims on the field are shown, strongest first.
        expect(html).toContain('2 claims');
        expect(html.indexOf('confirmed')).toBeLessThan(html.indexOf('unverified'));
    });

    it('shows the source under the title the dossier gave it, as a safe link', () => {
        const html = S.fieldChipHtml(index(), 'redemption.rails', 'Rails');
        expect(html).toContain('href="https://fixture.example/tos"');
        expect(html).toContain('Terms of Service (2026-08)');
        expect(html).toContain('rel="noopener noreferrer"');
    });

    it('cuts a runaway document title visibly and keeps the whole of it in the attribute', () => {
        // One real dossier title runs past 700 characters; printed in full it turns the popover
        // into a wall of link text.
        const long = `Republic – rSPAX offering page. ${'READ the side-by-side offering panels '.repeat(20)}`;
        const record = {
            ...FIXTURE,
            documents: [{ title: long, url: 'https://fixture.example/tos' }],
            claims: [{ field: 'legalForm', quote: 'x', url: 'https://fixture.example/tos',
                accessedAt: '2026-09-18T10:00:00Z', status: 'confirmed' }]
        };
        const html = S.fieldChipHtml(index(record), 'legalForm', 'Legal form');
        const label = /rel="noopener noreferrer">([^<]*)</.exec(html)[1];
        expect(label.length).toBeLessThanOrEqual(S.SOURCE_LABEL_MAX + 1);
        expect(label.endsWith('…')).toBe(true);
        expect(html).toContain(`title="${S.escapeHtml(long.replace(/\s+/g, ' ').trim())}"`);
        expect(S.sourceLabel('short one')).toBe('short one');
        expect(S.sourceLabel(null)).toBeNull();
    });

    it('never renders an unsafe URL as a link', () => {
        const nasty = {
            ...FIXTURE,
            documents: [],
            claims: [{
                field: 'legalForm',
                quote: 'x',
                url: 'javascript:alert(1)',
                accessedAt: '2026-09-18T10:00:00Z',
                status: 'confirmed'
            }]
        };
        const html = S.fieldChipHtml(index(nasty), 'legalForm', 'Legal form');
        expect(html).not.toContain('href="javascript:');
        expect(html).not.toContain('<a ');
    });

    it('escapes a quote rather than letting it close the popover', () => {
        const nasty = {
            ...FIXTURE,
            claims: [{
                field: 'legalForm',
                quote: '</div><img src=x onerror=alert(1)>',
                url: 'https://fixture.example/tos',
                accessedAt: '2026-09-18T10:00:00Z',
                status: 'confirmed'
            }]
        };
        const html = S.fieldChipHtml(index(nasty), 'legalForm', 'Legal form');
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img');
    });

    it('gives a field that needs a source but has none the hollow chip, and says why', () => {
        const html = S.fieldChipHtml(index(), 'governingLaw', 'Governing law');
        expect(html).toContain('ev-chip-none');
        expect(html).toContain('§?');
        expect(html).toContain(S.NO_CLAIM_TEXT);
        expect(S.NO_CLAIM_TEXT).toBe('no source recorded yet');
    });

    it('draws NO chip on a field that neither has nor needs a claim', () => {
        expect(S.fieldChipHtml(index(), 'confidence', 'Confidence')).toBe('');
        expect(S.fieldChipHtml(index(), 'chains', 'Chains')).toBe('');
        // No index at all (the token panel) draws nothing either.
        expect(S.fieldChipHtml(null, 'redemption.rails', 'Rails')).toBe('');
    });

    it('colours the badge by status: caution for unverified, warning for corrected, muted for inference', () => {
        expect(S.claimStatusClass('confirmed')).toBe('ev-confirmed');
        expect(S.claimStatusClass('unverified')).toBe('ev-caution');
        expect(S.claimStatusClass('contradicted-corrected')).toBe('ev-warning');
        expect(S.claimStatusClass('inference')).toBe('ev-muted');
        expect(S.claimStatusClass('made-up')).toBe('ev-muted');
        expect(S.claimStatusLabel('contradicted-corrected')).toBe('contradicted — corrected');
    });

    it('marks an on-chain claim as one', () => {
        const html = S.fieldChipHtml(index(), 'keyGovernance.mint', 'Mint authority');
        expect(html).toContain('on-chain');
    });

    it('formats every timestamp and keeps the full ISO in a title', () => {
        expect(S.stampHtml('accessed', '2026-09-18T10:22:00Z'))
            .toBe('<span class="ev-stamp" title="2026-09-18T10:22:00Z">accessed 18 Sep 2026 10:22 UTC</span>');
        expect(S.stampHtml('accessed', null)).toBe('');
        expect(S.stampHtml('accessed', '')).toBe('');
    });

    it('reads the evidence line exactly as specified', () => {
        expect(S.evidenceLineText({
            claims: 40, confirmed: 34, unverified: 4, inference: 1, corrected: 1,
            lastCheckedAt: '2026-09-18T10:22:00Z',
            coverage: { sourced: 34, needed: 41 }
        })).toBe('Evidence: 34 of 41 fields sourced · last checked 18 Sep 2026 10:22 UTC');
    });

    it('says "never checked" rather than inventing a date when nothing has been read', () => {
        const line = S.evidenceLineText({
            claims: 0, confirmed: 0, unverified: 0, inference: 0, corrected: 0,
            lastCheckedAt: null, coverage: { sourced: 0, needed: 46 }
        });
        expect(line).toBe('Evidence: 0 of 46 fields sourced · never checked');
        expect(line).not.toContain('1970');
        expect(S.evidenceLineHtml(null)).toBe('');
    });

    it('prefers the build\'s own expanded need list over re-expanding in the browser', () => {
        // stocks-issuers.json carries `evidenceFields`; the fetched claim-fields.json is only the
        // fallback. Two different answers to "does this field need a source" would show one number
        // in the line and a different set of hollow chips beside it.
        const withList = S.evidenceIndex({ claims: [], evidenceFields: ['governingLaw'] }, CLAIM_FIELDS);
        expect([...withList.needed]).toEqual(['governingLaw']);
        const withoutList = S.evidenceIndex({ claims: [], governingLaw: 'BVI law' }, CLAIM_FIELDS);
        expect([...withoutList.needed]).toEqual(['governingLaw']);
    });

    it('is wired into the page: the module is loaded, the file is fetched, the panel is indexed', () => {
        const html = readFileSync(join(__dirname, 'stocks.html'), 'utf8');
        expect(html).toMatch(/<script src="stocks\/lib\/evidence\.js\?v=[^"]+"><\/script>/);
        // Before stocks.js, or window.__rwaEvidence would not exist when it reads it.
        expect(html.indexOf('stocks/lib/evidence.js')).toBeLessThan(html.indexOf('stocks.js?v='));
        const source = readFileSync(join(__dirname, 'stocks.js'), 'utf8');
        expect(source).toContain("const CLAIM_FIELDS_PATH = './stocks/data/claim-fields.json'");
        expect(source).toMatch(/fetchJson\(CLAIM_FIELDS_PATH\)/);
        expect(source).toMatch(/state\.detailEvidence = evidenceIndex\(issuer, state\.claimFields\)/);
        // The token panel must clear it, or it would draw the previous issuer's chips.
        expect(source).toMatch(/state\.detailEvidence = null;\n\s+const market/);
    });

    it('takes its colours from the theme\'s own variables, in both themes', () => {
        const css = readFileSync(join(__dirname, 'stocks.css'), 'utf8');
        // Bounded at both ends: the shared trust-chain block that follows carries the only literal
        // colours in the file (its own --tc-*/--wi-* token definitions, which a token has to be).
        const from = css.indexOf('/* --- evidence chips');
        const to = css.indexOf('/* =====', from);
        const block = css.slice(from, to < 0 ? undefined : to);
        expect(block.length).toBeGreaterThan(500);
        expect(block).not.toMatch(/#[0-9a-fA-F]{3}/);
        expect(block).not.toContain('!important');
        expect(block).toContain('var(--sev-caution)');
        expect(block).toContain('var(--sev-warning)');
        expect(block).toContain('var(--muted-text)');
        // Keyboard reachable: the summary gets a visible focus ring.
        expect(block).toContain(':focus-visible');
    });

    it('carries the summary on every built issuer and on every issuerIndex entry', () => {
        const issuers = JSON.parse(readFileSync(join(__dirname, 'stocks-issuers.json'), 'utf8'));
        for (const issuer of issuers.issuers) {
            expect(Array.isArray(issuer.claims)).toBe(true);
            expect(Array.isArray(issuer.evidenceFields)).toBe(true);
            expect(issuer.evidence.coverage.needed).toBeGreaterThan(0);
            expect(issuer.evidence.coverage.sourced)
                .toBeLessThanOrEqual(issuer.evidence.coverage.needed);
            expect(issuer.evidence.claims).toBe(issuer.claims.length);
        }
        const tokens = JSON.parse(readFileSync(join(__dirname, 'stocks-tokens.json'), 'utf8'));
        for (const entry of tokens.issuerIndex) {
            expect(entry.evidence.coverage.needed).toBeGreaterThan(0);
            // The SUMMARY only: the quotes must not be duplicated into the byte-budgeted file.
            expect(entry.claims).toBeUndefined();
        }
    });
});

// --- the fourth authority in the issuer panel (MODEL.md §2.7) ---------------------------------
// The panel's Key governance section and the Keys badge both read keyGovernance. The rebase key is
// the one whose omission is invisible — every other value still renders — so it is pinned here.

describe('the rebase authority in the issuer panel', () => {
    const { readFileSync } = require('node:fs');
    const S = require('./stocks.js');
    const source = readFileSync(join(__dirname, 'stocks.js'), 'utf8');

    it('reads all four authorities, in the §2.7 order', () => {
        expect(S.KEY_GOVERNANCE_ROLES).toEqual(['mint', 'freeze', 'delegate', 'rebase']);
    });

    it("labels 'none' rather than falling back to the raw slug", () => {
        // Only `rebase` can be genuinely absent, and 'none' must read as a fact about the mint.
        expect(S.KEY_GOVERNANCE_LABELS.none).toBe('none');
        expect(S.KEY_GOVERNANCE_LABELS['hot-key']).toBe('hot key');
    });

    it('gives the Key governance section a Rebase authority row bound to its claim field', () => {
        expect(source).toContain("field('Rebase authority', keyGovernance.rebase, false, 'keyGovernance.rebase')");
    });

    it('carries the value on every built issuer record, so the row is never empty', () => {
        const issuers = JSON.parse(readFileSync(join(__dirname, 'stocks-issuers.json'), 'utf8'));
        for (const issuer of issuers.issuers) {
            expect(typeof issuer.keyGovernance.rebase).toBe('string');
            expect(Object.keys(S.KEY_GOVERNANCE_LABELS)).toContain(issuer.keyGovernance.rebase);
            expect(issuer.control.keyGovernance.rebase).toBe(issuer.keyGovernance.rebase);
        }
    });
});

// --- the trust chain and the what-if answers on the issuer panel (EVIDENCE.md §6) -------------

describe('the trust-chain section on the issuer panel', () => {
    const { readFileSync } = require('node:fs');
    const S = require('./stocks.js');
    const source = readFileSync(join(__dirname, 'stocks.js'), 'utf8');
    const html = readFileSync(join(__dirname, 'stocks.html'), 'utf8');
    const issuers = JSON.parse(readFileSync(join(__dirname, 'stocks-issuers.json'), 'utf8')).issuers;
    const catalogue = JSON.parse(readFileSync(
        join(__dirname, 'stocks', 'data', 'trust-chain.json'), 'utf8'));
    const record = issuers.find((row) => row.slug === 'xstocks-backed');

    it('draws the record’s own chain: one node per actor, one lane per flow', () => {
        const section = S.chainSectionHtml(record);
        expect(section.match(/class="tc-node[ "]/g)).toHaveLength(catalogue.actors.length);
        // The space matters: `tc-lanes` is the container group, not a lane.
        const lanes = [...section.matchAll(/<g class="(tc-lane [^"]*)"/g)].map((m) => m[1].split(' '));
        expect(lanes).toHaveLength(catalogue.flows.length);
        for (const classes of lanes) {
            expect(classes.filter((c) => c.startsWith('tc-ev-'))).toHaveLength(1);
            expect(classes.filter((c) => c.startsWith('tc-vf-'))).toHaveLength(1);
        }
    });

    it('shows each flow’s summary and the fields it rests on, with their claim status', () => {
        const section = S.chainSectionHtml(record);
        // On the TEXT, not just the element: a <p class="tc-flow-summary"> holding nothing but an
        // ellipsis passed a `toContain('tc-flow-summary')` for a whole browser session.
        for (const link of record.chain.links) {
            if (link.summary === null) continue;
            expect(section).toContain(link.summary.slice(0, 40));
        }
        expect(section).not.toContain('<p class="tc-flow-summary">\u2026</p>');
        expect(section).toContain('tc-field-path');
        // The values the panel CAN afford, unlike a card.
        expect(section).toContain('tc-field-value');
        expect(section).toContain('tc-claim-confirmed');
    });

    it('keeps the empty seats: an actor nobody fills is a finding, not a gap in the drawing', () => {
        const section = S.chainSectionHtml(record);
        const empty = record.chain.nodes.filter((node) => node.parties.length === 0).length;
        expect(empty).toBeGreaterThan(0);
        expect(section.match(/tc-node tc-node-empty/g)).toHaveLength(empty);
        expect(section).toContain('no party named');
    });

    it('says so, rather than drawing an empty frame, when a record has no chain', () => {
        expect(S.chainSectionHtml({ slug: 'x', name: 'X' }))
            .toContain('No trust chain has been built for this issuer yet');
        expect(S.chainSectionHtml(null)).toContain('No trust chain has been built');
    });

    it('is a section of the panel, rendered from the record the panel already has', () => {
        expect(source).toContain('id="trustChainSection"');
        expect(source).toContain('chainSectionHtml(issuer)');
    });

    it('loads the drawing library and the API base before stocks.js, all cache-busted', () => {
        const order = [...html.matchAll(/<script src="([^"?]+)\?v=[^"]*"><\/script>/g)].map((m) => m[1]);
        expect(order).toEqual([
            'stocks/lib/fmt.js',
            'stocks/lib/discovery.js',
            'stocks/lib/evidence.js',
            'stocks/lib/api-base.js',
            'stocks/lib/trustchain-svg.js',
            'stocks/lib/whatif-render.js',
            'stocks.js'
        ]);
    });
});

describe('the what-if section on the issuer panel', () => {
    const { readFileSync } = require('node:fs');
    const S = require('./stocks.js');
    const catalogue = JSON.parse(readFileSync(
        join(__dirname, 'stocks', 'data', 'trust-chain.json'), 'utf8'));

    /** One answer-sheet row as /api/issuers/:slug/what-if returns it. */
    function row(over) {
        return {
            mode_id: 'keys-stolen',
            actor: 'holder',
            flow: 'transfer',
            question: 'My keys are stolen. Can the tokens be recovered?',
            look_for: 'Lost-token clauses.',
            ord: 0,
            status: 'documented',
            id: 'xstocks-backed:keys-stolen',
            issuer_slug: 'xstocks-backed',
            outcome: 'Nothing comes back as of right.',
            quote: 'the Issuer will not be capable of restoring the private key',
            url: 'https://example.com/prospectus.pdf',
            locator: 'p. 107',
            accessed_at: '2026-09-18T10:15:00.000Z',
            cases: [],
            searched: [],
            note: null,
            source_title: 'Base Prospectus',
            source_archive_url: null,
            actor_label: 'Holder',
            flow_label: 'Transfer and control',
            ...over
        };
    }

    const SHEET = {
        slug: 'xstocks-backed',
        name: 'Kraken xStocks',
        count: 5,
        summary: {},
        items: [
            row({}),
            row({ mode_id: 'court-order', ord: 1, status: 'inferred', quote: null, question: 'A court orders a seizure.' }),
            row({
                mode_id: 'custodian-insolvency', actor: 'custodian', actor_label: 'Custodian or prime broker',
                ord: 2, status: 'unknown', quote: null, searched: ['https://example.com/terms'],
                question: 'The custodian goes bankrupt.'
            }),
            row({
                mode_id: 'law-changes', actor: 'law', actor_label: 'Law, regulator and courts', ord: 3,
                status: 'missing', id: null, outcome: null, quote: null, url: null, locator: null,
                accessed_at: null, source_title: null, question: 'The law changes.'
            }),
            row({
                mode_id: 'dispute-forum', actor: 'law', actor_label: 'Law, regulator and courts', ord: 4,
                status: 'not-applicable', quote: null, url: null, note: 'No forum clause exists.',
                question: 'Where do I sue?'
            })
        ]
    };

    it('counts every status it shows, and leaves out the ones with nothing under them', () => {
        const html = S.whatIfSectionHtml(SHEET, catalogue);
        expect(html).toContain('<span class="wi-count-n">1</span> documented');
        expect(html).toContain('<span class="wi-count-n">1</span> inferred');
        expect(html).toContain('<span class="wi-count-n">1</span> unknown');
        expect(html).toContain('<span class="wi-count-n">1</span> n/a');
        expect(html).toContain('<span class="wi-count-n">1</span> missing');
        // Nothing is litigated here, so the counts line leaves that status out entirely rather
        // than printing a zero. (The word still appears in the note, which explains all five.)
        const counts = html.slice(0, html.indexOf('</p>'));
        expect(counts).not.toContain('litigated');
    });

    it('groups the answers by actor in the catalogue’s order, not the question order', () => {
        const heads = [...S.whatIfSectionHtml(SHEET, catalogue)
            .matchAll(/<h5 class="wi-actor-head">([^<]+)<\/h5>/g)].map((m) => m[1]);
        expect(heads).toEqual(['Holder', 'Custodian or prime broker', 'Law, regulator and courts']);
    });

    it('groups in the order the questions arrive when the catalogue did not load', () => {
        const heads = [...S.whatIfSectionHtml(SHEET, null)
            .matchAll(/<h5 class="wi-actor-head">([^<]+)<\/h5>/g)].map((m) => m[1]);
        expect(heads).toEqual(['Holder', 'Custodian or prime broker', 'Law, regulator and courts']);
    });

    it('shows the panel’s full evidence: the quote, the source with its locator and the read date', () => {
        const html = S.whatIfSectionHtml(SHEET, catalogue);
        expect(html).toContain('<blockquote class="wi-quote">');
        expect(html).toContain('the Issuer will not be capable of restoring the private key');
        expect(html).toContain('https://example.com/prospectus.pdf');
        expect(html).toContain('p. 107');
        expect(html).toContain('read 18 Sep 2026');
        // The panel names its sources in place: the footnote list is the card's economy, not this one's.
        expect(html).not.toContain('wi-ref');
    });

    it('shows where we looked for an unknown, because the gap is only evidence with it', () => {
        const html = S.whatIfSectionHtml(SHEET, catalogue);
        expect(html).toContain('Where we looked (1)');
        expect(html).toContain('https://example.com/terms');
    });

    it('shows the note that says why a not-applicable case cannot arise', () => {
        expect(S.whatIfSectionHtml(SHEET, catalogue)).toContain('No forum clause exists.');
    });

    it('draws a question nobody has answered as a gap, and never as an answer', () => {
        const html = S.whatIfSectionHtml(SHEET, catalogue);
        expect(html).toContain('wi-badge wi-s-missing');
        expect(html).toContain('Not answered yet for this issuer');
        expect(html).toContain('nobody has read the documents for it');
    });

    it('states the rule that an outcome is never invented', () => {
        expect(S.whatIfSectionHtml(SHEET, catalogue)).toContain('An outcome is never invented');
        expect(S.WHAT_IF_NOTE).toContain('never invented');
        expect(S.WHAT_IF_NOTE).toContain('38 questions');
    });

    it('says the API did not answer rather than showing a gap that is not one', () => {
        const html = S.whatIfSectionHtml(null, catalogue, { failure: 'HTTP 503' });
        expect(html).toContain('which did not answer: HTTP 503');
        expect(html).toContain('Nothing is shown rather than a partial sheet');
        // An unreachable API must never look like "this issuer has no answers".
        expect(html).not.toContain('wi-badge');
        expect(html).not.toContain('No what-if answers have been recorded');
    });

    it('says it is loading before the sheet has landed', () => {
        expect(S.whatIfSectionHtml(null, catalogue)).toContain('Loading the answer sheet');
    });

    it('says the server has no catalogue when the sheet comes back with no questions', () => {
        expect(S.whatIfSectionHtml({ items: [] }, catalogue))
            .toContain('did not load on the server');
    });

    it('escapes an answer, so a dossier cannot inject markup into the panel', () => {
        const html = S.whatIfSectionHtml(
            { items: [row({ outcome: '<img src=x onerror=1>' })] }, catalogue);
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img');
    });

    it('reads the actor order and labels from the catalogue file the builders read', () => {
        expect(S.chainActorOrder(catalogue)).toEqual(catalogue.actors.map((actor) => actor.id));
        expect(S.chainActorLabels(catalogue).holder).toBe('Holder');
        expect(S.chainActorOrder(null)).toEqual([]);
    });
});
