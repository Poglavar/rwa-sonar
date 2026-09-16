// Unit tests for the pure formatters and placement helpers exported by stocks.js — the parts of
// the tokenized-stocks page that decide what a missing value looks like, where an issuer lands on
// the grid, and how a column sorts. No DOM: stocks.js only touches document in a browser. The last
// two suites check the two files the page loads (MODEL.md §10.1) instead: that they came from one
// build, and that the token file carries no dossier prose and stays under the byte budget.
const { statSync } = require('node:fs');
const { join } = require('node:path');
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
    sortIssuersForDisplay,
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
const INDEX_FIELDS = ['claimRung', 'legalForm', 'maturityStageNum', 'name', 'slug', 'status'];

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

    it('gives an index entry exactly the six display fields the token table needs', () => {
        for (const entry of tokenDb.issuerIndex) {
            expect(Object.keys(entry).sort()).toEqual(INDEX_FIELDS);
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
