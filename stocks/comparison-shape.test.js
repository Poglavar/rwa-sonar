// Unit tests for stocks/lib/comparison-shape.js: the same-stock comparison models, differences,
// filters and bundle checks. Moved with the code out of stocks-page.test.js (next-steps.md F11),
// which still tests the page wiring that calls it.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const REPO = join(__dirname, '..');

const {
    defiUsageIndex,
    redemptionUsabilitySummary,
    productDecisionProfile
} = require('./lib/defi-view.js');
const {
    sameStockComparisonModels,
    comparisonDifferenceRows,
    sameStockComparisonHtml,
    filterComparisonModels,
    COMPARISON_REQUIREMENTS,
    parseComparisonRequirements,
    comparisonRequirementsParam,
    comparisonTickerFromParams
} = require('./lib/comparison-shape.js');
const {
    sameUnderlyingGroups
} = require('./lib/discovery.js');

describe('confirmed DeFi usage', () => {
    const db = JSON.parse(readFileSync(join(REPO, 'stocks/data/defi-usage.json'), 'utf8'));
    const index = defiUsageIndex(db);

    it('uses the shared scoped fee answer in token details and comparison bundles', () => {
        const issuer = {
            slug: 'xstocks-backed', name: 'xStocks',
            redemption: { fees: 'TSLAx fee up to 0.50%.', termScopes: {
                fees: { kind: 'product-example', products: ['TSLAx'], source: 'TSLAx product page' }
            } }
        };
        const token = { symbol: 'FGDLx', mint: 'mint-fgdl', issuer: issuer.slug, underlyingTicker: 'FGLD' };
        const summary = redemptionUsabilitySummary(issuer, token);
        expect(summary.model.fields.find((field) => field.id === 'fees')).toMatchObject({
            summary: 'No FGDLx-specific fee is confirmed; TSLAx is a programme example only.',
            applicable: false, evidence: 'unknown'
        });
        const models = sameStockComparisonModels({ ticker: 'FGLD', rows: [{ issuer: issuer.slug, tokens: [token] }] },
            new Map([[issuer.slug, issuer]]), new Map(), null);
        expect(models[0].redemptionUsability.fields.find((field) => field.id === 'fees').summary)
            .toBe('No FGDLx-specific fee is confirmed; TSLAx is a programme example only.');
    });

    it('compares the same stock across legal structure, live lending, market exit and loss outcomes', () => {
        const tokens = JSON.parse(readFileSync(join(REPO, 'stocks-tokens.json'), 'utf8')).tokens;
        const issuers = JSON.parse(readFileSync(join(REPO, 'stocks-issuers.json'), 'utf8')).issuers;
        const templates = JSON.parse(readFileSync(join(REPO, 'stocks/data/composability-templates.json'), 'utf8'));
        const group = sameUnderlyingGroups(tokens).find((row) => row.ticker === 'NVDA');
        const models = sameStockComparisonModels(group, new Map(issuers.map((row) => [row.slug, row])), index, templates);
        expect(models).toHaveLength(2);
        expect(models.find((row) => row.issuerSlug === 'xstocks-backed').outcome.confirmedLending)
            .toContain('Source-listed for this exact token');
        expect(models.find((row) => row.issuerSlug === 'ondo-global-markets').outcome.confirmedLending)
            .toContain('No checked protocol');
        const html = sameStockComparisonHtml(group, models);
        for (const label of ['What do you own?', 'Redeem for cash', 'Smart-contract custody', 'Borrower default',
            'Exact-token lending listing', 'Secondary-market exit', 'If the protocol is hacked', 'If access is lost']) {
            expect(html).toContain(label);
        }
        expect(html).toContain('exact-token support and legal outcomes shown separately');
        expect(html).toContain('Decision summary');
        expect(html).toContain('What actually differs');
        expect(html).toContain('What does this mean?');
        expect(html).toContain('Open the full research matrix');
        const differences = comparisonDifferenceRows(models);
        expect(differences.length).toBeGreaterThan(0);
        expect(differences.every((row) => new Set(row.values.map((entry) => entry.value)).size > 1)).toBe(true);
    });
});

describe('shareholder rights in the comparison', () => {
    const rights = JSON.parse(readFileSync(join(REPO, 'stocks/data/holder-rights.json'), 'utf8')).issuers;
    const tokens = [
        { mint: 'mint-x', symbol: 'AAPLx', underlyingTicker: 'AAPL', issuer: 'xstocks-backed' },
        { mint: 'mint-o', symbol: 'AAPLon', underlyingTicker: 'AAPL', issuer: 'ondo-global-markets' }
    ];
    const issuers = new Map(tokens.map((token) => [token.issuer, { slug: token.issuer, name: token.issuer, holderRights: rights[token.issuer] }]));
    const group = sameUnderlyingGroups(tokens)[0];
    const models = sameStockComparisonModels(group, issuers, new Map(), null);

    it('shows the rights strip per wrapper, linking to the card for the details', () => {
        const html = sameStockComparisonHtml(group, models);
        expect(html).toContain('<strong>Shareholder rights</strong>');
        expect(html).toContain('href="./cards/AAPLx.html#holder-rights"');
        expect(html.match(/class="rights-strip"/g).length).toBeGreaterThanOrEqual(2);
    });

    it('names only the rights that differ, and never leads the decision summary', () => {
        const row = comparisonDifferenceRows(models).find((entry) => entry.label === 'Shareholder rights');
        expect(Object.fromEntries(row.values.map((entry) => [entry.issuer, entry.value]))).toEqual({
            'xstocks-backed': 'Voting: no · Splits: passed through by the issuer',
            'ondo-global-markets': 'Voting: only if the issuer decides · Splits: not stated'
        });
        expect(comparisonDifferenceRows(models).at(-1).label).toBe('Shareholder rights');
    });
});

describe('decision comparison and saved-watch helpers', () => {
    it.each([1, 2, 3, 16])('renders a useful decision for %i wrappers without silently limiting the selection', (count) => {
        const tokens = Array.from({ length: count }, (_, index) => ({
            mint: `mint-${index}`, symbol: `AAPL-${index}`, underlyingTicker: 'AAPL', issuer: `issuer-${index}`
        }));
        const issuers = new Map(tokens.map((token, index) => [token.issuer, {
            slug: token.issuer, name: `Tokenizer ${index}`, grades: { claimRung: index % 3 },
            redemption: { available: index % 2 === 0 }, control: { freezeAuthority: index % 2 ? 'all' : 'none' }
        }]));
        const group = sameUnderlyingGroups(tokens, { includeSingle: true })[0];
        const models = sameStockComparisonModels(group, issuers, new Map(), null);
        const html = sameStockComparisonHtml(group, models);
        expect(models).toHaveLength(count);
        for (const model of models) expect(html).toContain(model.issuerName);
        expect(html).toContain(count === 1 ? 'Standalone answer' : 'Decision summary');
        expect(html).not.toContain('Select at least two');
        expect(html).not.toMatch(/class="comparison-question" open/);
        expect(filterComparisonModels(models, new Set(), new Set())).toEqual([]);
        expect(filterComparisonModels(models, new Set([models[0].issuerSlug]), new Set())).toEqual([models[0]]);
        expect(filterComparisonModels(models, undefined, new Set())).toHaveLength(count);
    });

    const now = Date.parse('2026-09-19T12:00:00Z');
    const issuer = {
        redemption: { available: true, eligibility: 'Available to non-US investors', rails: 'Cash settlement in USDC' },
        transferRestrictions: { usPersonsExcluded: true },
        bankruptcyRemote: true,
        grades: { claimRung: 3 },
        control: { freezeAuthority: 'none', pausable: 'none', clawback: 'none' },
        evidence: { lastCheckedAt: '2026-09-18T12:00:00Z' }
    };
    const integrations = [{ category: 'lending', protocolName: 'Lend', actions: ['collateral'] }];

    it('passes decision filters only on established facts and keeps unknown controls out', () => {
        const profile = productDecisionProfile(issuer, { mint: 'm' }, integrations, null, now);
        expect(profile).toMatchObject({
            cashRedemption: true, noDiscretionaryFreeze: true, confirmedCollateral: true,
            segregatedAssets: true, nonUsHolders: true, freshEvidence: true
        });
        expect(productDecisionProfile({ ...issuer, control: {} }, {}, [], null, now).noDiscretionaryFreeze).toBe(false);
        const models = [
            { issuerSlug: 'a', decision: profile },
            { issuerSlug: 'b', decision: { ...profile, confirmedCollateral: false } }
        ];
        expect(filterComparisonModels(models, new Set(['a', 'b']), new Set(['confirmedCollateral'])))
            .toEqual([models[0]]);
    });
});

describe('compare URL state: requirements and the underlying', () => {
    test('the requirement list is exactly the checkboxes stocks.html offers', () => {
        const html = readFileSync(join(REPO, 'stocks.html'), 'utf8');
        const section = html.slice(html.indexOf('id="comparisonFilters"'), html.indexOf('</fieldset>', html.indexOf('id="comparisonFilters"')));
        expect([...section.matchAll(/value="([^"]+)"/g)].map((m) => m[1])).toEqual(COMPARISON_REQUIREMENTS);
    });

    test('`requires=` round-trips in page order and drops unknown keys', () => {
        const parsed = parseComparisonRequirements('freshEvidence, cashRedemption,bogus,cashRedemption');
        expect([...parsed]).toEqual(['cashRedemption', 'freshEvidence']);
        expect(comparisonRequirementsParam(parsed)).toBe('cashRedemption,freshEvidence');
        expect(parseComparisonRequirements(comparisonRequirementsParam(new Set(COMPARISON_REQUIREMENTS))))
            .toEqual(new Set(COMPARISON_REQUIREMENTS));
        expect(parseComparisonRequirements(null).size).toBe(0);
        expect(comparisonRequirementsParam(new Set())).toBe('');
    });

    test('`compare=` wins, else a `search=` that is exactly a known ticker, else the caller default', () => {
        const tickers = ['SPCX', 'NVDA', 'TSLA'];
        expect(comparisonTickerFromParams(new URLSearchParams('view=compare&search=nvda'), tickers)).toBe('NVDA');
        expect(comparisonTickerFromParams(new URLSearchParams('compare=TSLA&search=NVDA'), tickers)).toBe('TSLA');
        expect(comparisonTickerFromParams(new URLSearchParams('compare=ZZZZ&search=NVDA'), tickers)).toBe('NVDA');
        expect(comparisonTickerFromParams(new URLSearchParams('search=nvidia'), tickers)).toBeNull();
        expect(comparisonTickerFromParams(new URLSearchParams(''), tickers)).toBeNull();
    });

    test('stocks.js writes the requirements to the URL and shows a loading state for a new underlying', () => {
        const js = readFileSync(join(REPO, 'stocks.js'), 'utf8');
        expect(js).toContain("state.comparisonFilters = parseComparisonRequirements(params.get('requires'));");
        expect((js.match(/writeComparisonRequirements\(\);/g) || []).length).toBeGreaterThanOrEqual(3);
        const loadingAt = js.indexOf('showComparisonLoading(group.ticker);');
        expect(loadingAt).toBeGreaterThan(-1);
        expect(loadingAt).toBeLessThan(js.indexOf('bundle = await fetchJson(`./comparisons/'));
    });
});
