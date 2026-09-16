// Unit tests for the pure formatters and placement helpers exported by stocks.js — the parts of
// the tokenized-stocks page that decide what a missing value looks like, where an issuer lands on
// the grid, and how a column sorts. No DOM: stocks.js only touches document in a browser.
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
    sortIssuersForDisplay
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
        // stocks-db.json carries control.freezeAuthority as the authority's own address on all
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
        // The name stocks-db.json actually carries for Bullish.
        const real = 'Bullish (NYSE: BLSH) — the securities issuer is the listed company itself, ' +
            'a Cayman Islands company (SEC CIK 0001872195, Commission File No. 001-42797)';
        expect(displayName(real)).toBe('Bullish (NYSE: BLSH)');
    });

    it('drops an overlong trailing parenthetical rather than truncating mid-word', () => {
        const real = 'Ondo Global Markets ("Ondo Stocks"; legacy "GM" prefix in APIs and contracts)';
        expect(displayName(real)).toBe('Ondo Global Markets');
    });

    it('drops a nested trailing parenthetical whole', () => {
        // stocks-db.json's name for xStocks; the inner "(JE)" defeats a non-greedy strip.
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

describe('the sample fixture', () => {
    const db = require('./stocks/fixtures/stocks-db.sample.json');

    it('carries the fields the page reads', () => {
        expect(fetchedAtOf(db.sources.universe)).toBeTruthy();
        expect(db.issuers.length).toBeGreaterThan(0);
        expect(db.tokens.length).toBeGreaterThan(0);
    });

    it('places every live issuer on the grid or knowingly off it', () => {
        for (const issuer of db.issuers) {
            const cell = gridCell(issuer.grades.claimRung, issuer.grades.maturityStageNum);
            if (cell === null) expect(issuer.grades.claimRung).toBeNull();
            else expect(cell.column).toBeGreaterThanOrEqual(GRID_FIRST_DATA_COLUMN);
        }
    });

    it('references only tokens that exist, and only issuers that exist', () => {
        const mints = new Set(db.tokens.map((t) => t.mint));
        const slugs = new Set(db.issuers.map((i) => i.slug));
        for (const issuer of db.issuers) {
            for (const mint of issuer.tokenMints) expect(mints.has(mint)).toBe(true);
        }
        for (const token of db.tokens) expect(slugs.has(token.issuer)).toBe(true);
    });

    it('has at least one defunct issuer and one null-heavy token, which is the point of a fixture', () => {
        expect(db.issuers.some((i) => i.status === 'defunct')).toBe(true);
        expect(db.tokens.some((t) => t.market.usdPrice === null)).toBe(true);
        expect(db.tokens.some((t) => t.reference.premiumPct === null)).toBe(true);
    });
});
