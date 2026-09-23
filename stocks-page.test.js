// Tests for the tokenized-stocks page itself: the shared formatters (stocks/lib/fmt.js) and discovery
// helpers (stocks/lib/discovery.js) it reads, how stocks.html and stocks.js wire the pure modules in,
// and the two files the page loads (MODEL.md §10.1) — that they came from one build, and that the
// token file carries no dossier prose and stays under the byte budget. The pure helpers split out
// of stocks.js (next-steps.md F11) are tested beside their modules, in stocks/<module>.test.js.
const { readFileSync, statSync } = require('node:fs');
const { join } = require('node:path');

const NOTHINGS = [null, undefined, '', NaN, Infinity, -Infinity, 'n/a', {}];

/**
 * Dossier prose lives in the issuer file only (MODEL.md §10.1). A copy of any of these in the token
 * file is what made the single database 1.4 MB, so the keys are checked by name, at any depth.
 */
const DOSSIER_KEYS = ['documents', 'attestations', 'findings', 'vocabulary', 'discrepancies'];

/** The six fields §10.1 allows on an issuerIndex entry, sorted for comparison. */
// The six display fields, plus the evidence SUMMARY added 2026-09-18 (EVIDENCE.md §4) — counts
// and coverage only, never the claims array with its verbatim quotes, which is what keeps this
// file inside the byte budget below.
const INDEX_FIELDS = ['claimRung', 'discrepancyCount', 'evidence', 'legalForm', 'maturityStageNum', 'name', 'slug',
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
    humanizeSlug,
    isoToMillis,
    humanizeDuration,
    fmtRelativeTime,
    fmtAgeSeconds,
    fmtTradesPerTrader,
    fmtCountOfTotal,
    fmtVenueSpreadPct,
    fmtVenueSpread
} = require('./stocks/lib/fmt.js');
const {
    laypersonVerdict,
    legalReviewStatus,
    parseStockSearch,
    globalSearch,
    sameUnderlyingGroups,
    collectorHealth
} = require('./stocks/lib/discovery.js');

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

describe('humanizeSlug', () => {
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
});

describe('layperson discovery helpers', () => {
    it('keeps missing control observations distinct from confirmed absence', () => {
        for (const control of [{}, { freezeAuthority: 'unknown', clawback: 'none', pausable: false }]) {
            const verdict = laypersonVerdict({ control });
            expect(verdict.controlNote).toContain('not fully established');
            expect(verdict.controlNote).not.toContain('can freeze');
            expect(verdict.controlNote).not.toContain('No freeze');
        }
        expect(laypersonVerdict({ control: { clawback: false, freezeAuthority: 'none', pausable: false } }).controlNote)
            .toContain('No freeze, pause or clawback power was detected');
        expect(laypersonVerdict({ control: { freezeAuthority: 'controller-address' } }).controlNote)
            .toContain('can freeze tokens on-chain. Other control powers are not fully established.');
    });
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
        expect(verdict.cooperation).toContain('issuer');
        expect(verdict.mainFailure).toContain('issuer intervention');
    });

    it('marks evidence gaps as pending and fully sourced reviewed evidence as complete', () => {
        expect(legalReviewStatus({ evidence: { coverage: { sourced: 8, needed: 10 }, unverified: 1 } }))
            .toMatchObject({ pending: true, label: 'Legal review pending' });
        expect(legalReviewStatus({ evidence: { coverage: { sourced: 10, needed: 10 }, unverified: 0, inference: 0 } }))
            .toMatchObject({ pending: false, label: 'Legal evidence reviewed' });
    });

    it('does not present a structured reviewed inference as pending, but keeps legacy inference pending', () => {
        expect(legalReviewStatus({ evidence: { coverage: { sourced: 10, needed: 10 }, unverified: 0,
            inference: 1, inferenceReviewed: 1, inferenceUnreviewed: 0 } }))
            .toMatchObject({ pending: false, label: 'Legal evidence reviewed' });
        expect(legalReviewStatus({ evidence: { coverage: { sourced: 10, needed: 10 }, unverified: 0, inference: 1 } }))
            .toMatchObject({ pending: true, label: 'Legal review pending' });
    });

    it('searches issuer name and mint as well as token identity', () => {
        const issuers = [{ slug: 'backed', name: 'Backed Finance', issuingEntity: 'Backed Assets AG' }];
        const tokens = [{ symbol: 'AAPLx', name: 'Apple xStock', underlyingTicker: 'AAPL', issuer: 'backed', mint: 'MintABC123' }];
        expect(globalSearch(tokens, issuers, 'finance').tokens).toHaveLength(1);
        expect(globalSearch(tokens, issuers, 'MintABC').tokens).toHaveLength(1);
        expect(globalSearch(tokens, issuers, 'apple').issuers).toHaveLength(0);
    });

    it('understands a natural-language collateral search and applies the confirmed-use fact', () => {
        const issuers = [{ slug: 'backed', name: 'Backed Finance' }];
        const tokens = [
            { symbol: 'NVDAx', name: 'NVIDIA xStock', underlyingTicker: 'NVDA', issuer: 'backed', mint: 'live' },
            { symbol: 'NVDAy', name: 'NVIDIA token', underlyingTicker: 'NVDA', issuer: 'backed', mint: 'idle' }
        ];
        const profiles = new Map([
            ['live', { confirmedCollateral: true }],
            ['idle', { confirmedCollateral: false }]
        ]);
        const parsed = parseStockSearch('tokenized NVIDIA usable as collateral');
        expect(parsed).toMatchObject({ terms: ['nvidia'], hasIntent: true });
        expect(globalSearch(tokens, issuers, 'tokenized NVIDIA usable as collateral', 8, profiles).tokens)
            .toEqual([tokens[0]]);
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
        for (const file of [
            'index.html', 'assets.html', 'stocks.html', 'graph.html', 'live.html', 'monitor.html',
            'watch.html', 'whatif.html', 'methodology.html', 'review.html', 'learn/index.html',
            'learn/beneficial-ownership.html', 'learn/bankruptcy-remoteness.html',
            'learn/redemption.html', 'learn/issuer-control.html', 'learn/oracle-risk.html',
            'learn/defi-custody.html'
        ]) {
            const html = readFileSync(join(__dirname, file), 'utf8');
            expect(html).not.toContain('noindex');
            expect(html.match(/rel="canonical"/g)).toHaveLength(1);
        }
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

    it('publishes only the current understanding, never our editorial correction history', () => {
        const claims = issuerDb.issuers.flatMap((issuer) => issuer.claims ?? []);
        expect(claims.some((claim) => claim.status === 'contradicted-corrected')).toBe(false);
        expect(claims.some((claim) => /^(CORRECTION|CHANGED)[.:]/.test(claim.note ?? ''))).toBe(false);
        expect(issuerDb.issuers.some((issuer) => Object.hasOwn(issuer.evidence ?? {}, 'corrected'))).toBe(false);
        expect(JSON.stringify(issuerDb)).not.toMatch(/dossier previously|earlier reading|Statement amended|previously stated absence/i);
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
                'claims', 'confirmed', 'coverage', 'inference', 'inferenceReviewed', 'inferenceUnreviewed', 'lastCheckedAt',
                'unverified'
            ]);
        }
    });

    /**
     * The ceiling is per mint because genuine issuer-registry admission can expand the catalogue by
     * hundreds of addresses at once. It still catches dossier prose leaking into every row, without
     * pretending the file can remain below its old fixed-size limit as the verified universe grows.
     */
    it('keeps the token file inside its byte budget, which is why it was split off', () => {
        const bytes = statSync(join(__dirname, 'stocks-tokens.json')).size;
        // Genuine catalogue growth scales this file. Keep a per-mint ceiling so schema bloat still
        // fails without treating 1,183 confirmed assets as though there were still ~500.
        expect(bytes).toBeLessThan(tokenDb.tokens.length * 3 * 1024);
    });
});

/**
 * The formatters moved out of this file into stocks/lib/fmt.js on 2026-09-17, so the browser table
 * and the server-rendered stock cards (stocks/build-cards.mjs) cannot drift apart in what a price,
 * a premium or a missing value looks like. These tests pin the move: one copy, every name the page
 * layer takes from a module actually exported by it, and the modules loaded before stocks.js.
 */
describe('the shared formatter module', () => {
    const fmt = require('./stocks/lib/fmt.js');
    const { readFileSync } = require('node:fs');
    /** The pure modules split out of stocks.js (next-steps.md F11), each with its own test file. */
    const PAGE_MODULES = ['sort-values', 'issuer-labels', 'token-view', 'activity-rows', 'funnel-layout',
        'evidence-view', 'discrepancy-view', 'trustchain-section', 'defi-view', 'comparison-shape',
        'saved-items', 'search-results', 'panel-markup'].map((name) => `stocks/lib/${name}.js`);

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

    it('is the one copy: stocks.js takes every name it uses from a module that exports it', () => {
        // stocks.js reads each pure module once (window.__rwa* in the browser, require here) and
        // destructures the names the page layer calls. A name the module does not export would be
        // `undefined` at the first click, with no error until then — so each one is checked.
        const source = readFileSync(join(__dirname, 'stocks.js'), 'utf8');
        const files = new Map([...source.matchAll(/^const (\w+) = \(typeof (__rwa\w+) !== 'undefined'\)\s*\?\s*\2 : require\('\.\/(stocks\/lib\/[\w-]+\.js)'\);$/gm)]
            .map((m) => [m[1], m[3]]));
        expect(files.get('fmt')).toBe('stocks/lib/fmt.js');
        const taken = [...source.matchAll(/^const \{([^}]+)\} = (\w+);$/gm)];
        expect(taken.length).toBeGreaterThanOrEqual(10);
        for (const [, names, lib] of taken) {
            expect(files.has(lib)).toBe(true);
            const exported = require(`./${files.get(lib)}`);
            for (const name of names.split(',').map((n) => n.trim()).filter(Boolean)) {
                expect(`${lib}.${name}: ${typeof exported[name]}`).not.toBe(`${lib}.${name}: undefined`);
            }
        }
    });

    it('leaves no second declaration of any of them in stocks.js or the modules split out of it', () => {
        for (const file of ['stocks.js', ...PAGE_MODULES]) {
            const source = readFileSync(join(__dirname, file), 'utf8');
            for (const name of SHARED.filter((key) => key !== 'DASH')) {
                expect(source).not.toMatch(new RegExp(`^\\s*function ${name}\\s*\\(`, 'm'));
            }
            expect(source).not.toMatch(/^\s*const DASH\s*=/m);
        }
    });

    it('is loaded by stocks.html before stocks.js, both cache-busted', () => {
        const html = readFileSync(join(__dirname, 'stocks.html'), 'utf8');
        const fmtAt = html.indexOf('stocks/lib/fmt.js?v=');
        const pageAt = html.indexOf('stocks.js?v=');
        expect(fmtAt).toBeGreaterThan(-1);
        expect(pageAt).toBeGreaterThan(fmtAt);
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
    const page = require('./stocks/lib/issuer-labels.js');

    it('derives the issuer headline from the issuer file, qualified by live, defunct and no-mint programmes', () => {
        const headline = page.issuerHeadline([
            { name: 'Kraken xStocks', status: 'live', market: { tokens: 927 } },
            { name: 'Remora Markets', status: 'defunct', market: { tokens: 0 } },
            { name: 'Republic Mirror', status: 'live', market: { tokens: 0 } }
        ]);
        expect(headline).toEqual({
            count: '3',
            qualifier: '1 with live tokens · Remora Markets defunct · Republic Mirror: no mint yet',
            largest: ' (the largest, Kraken xStocks, has 927)'
        });
        expect(page.issuerHeadline([{ name: 'A', status: 'live', market: { tokens: 2 } }]).qualifier).toBe('');
        // The compact discovery index has no market block: the token rows are counted instead.
        const compact = page.issuerHeadline(
            [{ slug: 'x', name: 'X', status: 'live' }, { slug: 'r', name: 'R', status: 'live' }],
            [{ mint: 'A', issuer: 'x' }, { mint: 'B', issuer: 'x' }]);
        expect(compact.qualifier).toBe('1 with live tokens · R: no mint yet');
        expect(compact.largest).toBe(' (the largest, X, has 2)');
        const html = readFileSync(join(__dirname, 'stocks.html'), 'utf8');
        expect(html).toMatch(/catalogue-counts\.js\?v=[^"]+"><\/script>\s*(?:<script[^>]*><\/script>\s*)*<script src="stocks\.js/);
    });

    it('is wired into stocks.html: the strip is there and starts hidden', () => {
        const html = readFileSync(join(__dirname, 'stocks.html'), 'utf8');
        expect(html).toMatch(/<section id="newMints"[^>]*hidden/);
        expect(html).toContain('id="newMintsTrack"');
        expect(html).toContain('Show every recent addition');
        expect(html).not.toContain('new-mints-marquee');
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
    const page = ({  });

    it('is wired into stocks.html above the grid, and starts hidden', () => {
        const html = readFileSync(join(__dirname, 'stocks.html'), 'utf8');
        expect(html).toMatch(/<details id="funnelSection"[^>]*hidden/);
        expect(html).toContain('id="funnelGraphic"');
        expect(html).toContain('class="funnel-scroll"');
        expect(html.indexOf('id="funnelSection"')).toBeLessThan(html.indexOf('id="gridSection"'));
        // The heading is written from the funnel's own totals, so it must not be spelled here.
        expect(html).not.toMatch(/<h2 id="funnelHeading">From/);
    });

    it('uses task views and progressive disclosure instead of one continuous analytics report', () => {
        const html = readFileSync(join(__dirname, 'stocks.html'), 'utf8');
        expect(html).toContain('data-workspace-view="overview"');
        for (const view of ['overview', 'assets', 'compare', 'discrepancies', 'issuers', 'defi']) {
            expect(html).toContain(`data-workspace-view="${view}"`);
        }
        for (const id of ['discrepanciesSection', 'discrepancyIssuer', 'discrepancyAsset',
            'discrepancyImpact', 'discrepancyStatus', 'discrepancyGrid']) {
            expect(html).toContain(`id="${id}"`);
        }
        for (const id of ['personalHome', 'personalVisit', 'personalStocks', 'personalIssuers',
            'personalComparisons', 'personalNewAssets', 'personalProtocolChanges']) {
            expect(html).toContain(`id="${id}"`);
        }
        expect(html).toContain('id="activitySection" data-view="assets" class="analysis-disclosure"');
        expect(html).toContain('id="composabilitySection" data-view="defi" class="analysis-disclosure"');
        expect(html).toContain('id="tokenTable" data-preset="overview"');
        expect(html).toContain('id="tokenColumnPresets"');
        for (const preset of ['legal', 'market', 'control', 'defi', 'all']) {
            expect(html).toContain(`data-token-preset="${preset}"`);
        }
        expect(html).toContain('href="#workspaceMain"');
        expect(html).toContain('aria-controls="globalSearchResults"');
        expect(html).toMatch(/<details class="comparison-settings">/);
        expect(html).not.toMatch(/<details class="comparison-settings"[^>]*\bopen\b/);
        expect(html).toContain('<caption class="visually-hidden">Paginated exact Solana token addresses.');
        expect(html).toContain('aria-describedby="detailDialogDescription"');
        expect(html).toContain('id="comparisonSelectionSummary"');
        expect(html).toContain('id="selectAllComparison"');
        expect(html).toContain('data-view="overview assets compare discrepancies issuers defi"');
        const css = readFileSync(join(__dirname, 'stocks.css'), 'utf8');
        expect(css).toContain('body:not([data-workspace-view="overview"]) .workspace-intro');
        expect(css).toContain('.global-search-results { max-height: min(58dvh, 520px);');
        expect(css).toContain('.comparison-save-row { align-items: stretch; flex-direction: column; }');
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

describe('claim-versus-reality discrepancies', () => {
    const issuerDb = require('./stocks-issuers.json');

    it('publishes only discrepancies with evidence on both sides', () => {
        const rows = issuerDb.issuers.flatMap((issuer) => issuer.discrepancies ?? []);
        expect(rows.length).toBeGreaterThanOrEqual(5);
        for (const row of rows) {
            expect(typeof row.title).toBe('string');
            expect(row.title.length).toBeGreaterThan(10);
            expect(Array.isArray(row.claim?.sources)).toBe(true);
            expect(Array.isArray(row.reality?.sources)).toBe(true);
            expect(row.claim.sources.length).toBeGreaterThan(0);
            expect(row.reality.sources.length).toBeGreaterThan(0);
            for (const source of [...row.claim.sources, ...row.reality.sources]) {
                expect(source.url).toMatch(/^https:\/\//);
                expect(source.locator).toBeTruthy();
                expect(source.accessedAt).toBeTruthy();
            }
        }
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
    const { readFileSync } = require('node:fs');

    const evidence = require('./stocks/lib/evidence.js');

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

    const source = readFileSync(join(__dirname, 'stocks.js'), 'utf8');

    it('gives the Key governance section a Rebase authority row bound to its claim field', () => {
        expect(source).toContain("field('Rebase authority', keyGovernance.rebase, false, 'keyGovernance.rebase')");
    });
});

// --- the trust chain and the what-if answers on the issuer panel (EVIDENCE.md §6) -------------
describe('the trust-chain section on the issuer panel', () => {
    const { readFileSync } = require('node:fs');

    const source = readFileSync(join(__dirname, 'stocks.js'), 'utf8');
    const html = readFileSync(join(__dirname, 'stocks.html'), 'utf8');
    const issuers = JSON.parse(readFileSync(join(__dirname, 'stocks-issuers.json'), 'utf8')).issuers;
    const catalogue = JSON.parse(readFileSync(
        join(__dirname, 'stocks', 'data', 'trust-chain.json'), 'utf8'));
    const record = issuers.find((row) => row.slug === 'xstocks-backed');

    it('is a section of the panel, rendered from the record the panel already has', () => {
        expect(source).toContain('id="trustChainSection"');
        expect(source).toContain('chainSectionHtml(issuer)');
    });

    it('loads the drawing library, the API base and the pure modules before stocks.js, all cache-busted', () => {
        // A module reads the ones it depends on off window when it loads, so this order is a
        // dependency order: each module comes after everything it takes, stocks.js after all.
        const order = [...html.matchAll(/<script src="([^"?]+)\?v=[^"]*"><\/script>/g)].map((m) => m[1]);
        expect(order).toEqual([
            'stocks/lib/fmt.js',
            'stocks/lib/discovery.js',
            'stocks/lib/evidence.js',
            'stocks/lib/protocol-proof.js',
            'stocks/lib/redemption-usability.js',
            'stocks/lib/catalogue-counts.js',
            'stocks/lib/api-base.js',
            'stocks/lib/history-charts.js',
            'stocks/lib/trustchain-svg.js',
            'stocks/lib/whatif-render.js',
            'stocks/lib/sort-values.js',
            'stocks/lib/issuer-labels.js',
            'stocks/lib/token-view.js',
            'stocks/lib/activity-rows.js',
            'stocks/lib/funnel-layout.js',
            'stocks/lib/evidence-view.js',
            'stocks/lib/discrepancy-view.js',
            'stocks/lib/trustchain-section.js',
            'stocks/lib/defi-view.js',
            'stocks/lib/comparison-shape.js',
            'stocks/lib/saved-items.js',
            'stocks/lib/search-results.js',
            'stocks/lib/panel-markup.js',
            'stocks.js'
        ]);
        // And every root.__rwa* a module reads is set by a script loaded before it.
        const setBy = new Map();
        for (const [at, file] of order.entries()) {
            if (file === 'stocks.js') continue;
            const src = readFileSync(join(__dirname, file), 'utf8');
            for (const m of src.matchAll(/root\.(__rwa\w+) = /g)) setBy.set(m[1], at);
            for (const m of src.matchAll(/root\.(__rwa\w+)/g)) {
                expect(`${file} reads ${m[1]}: ${setBy.has(m[1]) && setBy.get(m[1]) <= at}`).toBe(`${file} reads ${m[1]}: true`);
            }
        }
    });
});
