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
            'Listed as loan collateral', 'Secondary-market exit', 'If the protocol is hacked', 'If access is lost']) {
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

describe('the buyer table at the top of the compare view', () => {
    const {
        buyerRows, buyerTableHtml, buyerPowers, shortJurisdiction
    } = require('./lib/comparison-shape.js');
    const rights = JSON.parse(readFileSync(join(REPO, 'stocks/data/holder-rights.json'), 'utf8')).issuers;
    const issuers = new Map([
        ['xstocks-backed', {
            slug: 'xstocks-backed', name: 'Kraken xStocks', legalForm: 'tracker-certificate',
            entityJurisdiction: 'Jersey (Channel Islands)', grades: { claimRung: 2, claimLabel: 'secured claim on collateral' },
            transferRestrictions: { usPersonsExcluded: true }, holderRights: rights['xstocks-backed'],
            redemption: {
                available: true, kyc: true, rails: 'Cash settlement in the Settlement Currency',
                minimum: 'USD 5,000 per transaction when issuing or redeeming directly with the Issuer (xStocks FAQ).',
                fees: 'Per-product (TSLAx product page): issuance/redemption up to 0.50% of the amount.',
                termScopes: { minimum: { kind: 'programme-all-products' }, fees: { kind: 'product-example', products: ['TSLAx'] } }
            }
        }],
        ['ondo-global-markets', {
            slug: 'ondo-global-markets', name: 'Ondo Global Markets', legalForm: 'structured-note',
            entityJurisdiction: 'British Virgin Islands', grades: { claimRung: 2, claimLabel: 'secured claim on collateral' },
            transferRestrictions: { usPersonsExcluded: true }, holderRights: rights['ondo-global-markets'],
            redemption: {
                available: true, kyc: true, rails: 'USDC',
                minimum: '$1.00 USD to invest or redeem',
                fees: 'Purchaser Fees for issuance AND redemption of up to 0.1% of the market price; 30% withholding on dividends.',
                termScopes: { minimum: { kind: 'programme-all-products' }, fees: { kind: 'programme-all-products' } }
            }
        }],
        ['superstate-opening-bell', {
            slug: 'superstate-opening-bell', name: 'Opening Bell', legalForm: 'registered-share',
            entityJurisdiction: 'Delaware LLC, principal offices New York', grades: { claimRung: 4, claimLabel: 'registered share' },
            redemption: { available: false }
        }]
    ]);
    const tokens = [
        { mint: 'mint-x', symbol: 'AAPLx', underlyingTicker: 'AAPL', issuer: 'xstocks-backed', cardSlug: 'AAPLx',
            market: { usdPrice: 333.99, liquidity: 591667.6, vol24: 418789 },
            reference: { price: 333.335, premiumPct: -0.1757, source: 'pyth' },
            activity: { dexPairs: 1, cexMarkets: 20 },
            control: { freezeAuthority: 'JDq14', permanentDelegate: '5aMNN', clawback: true, pausable: true, transferFeeBps: null } },
        { mint: 'mint-o', symbol: 'AAPLon', underlyingTicker: 'AAPL', issuer: 'ondo-global-markets', cardSlug: 'AAPLon',
            market: { usdPrice: 334.1, liquidity: 1612.4, vol24: 4.2 },
            reference: { price: 333.335, premiumPct: null, source: 'pyth' },
            activity: { dexPairs: 1, cexMarkets: 15 },
            control: { freezeAuthority: '51QVC', permanentDelegate: false, clawback: false, pausable: true, transferFeeBps: null } }
    ];
    const powerRow = (cells) => ({ cells: Object.entries(cells).map(([power, [kind, signerThreshold, seconds]]) => ({
        power, kind, signerThreshold, timelock: seconds === null ? null : { seconds, phrase: 'x' }
    })) });
    const powersByIssuer = new Map([
        ['xstocks-backed', buyerPowers(powerRow({ freeze: ['multisig', '2 of 4', 0], pause: ['multisig', '2 of 4', 0], moveBurn: ['multisig', '2 of 3', 0], mint: ['single-key', null, null] }))],
        ['ondo-global-markets', buyerPowers(powerRow({ freeze: ['multisig', '3 of 8', 0], pause: ['single-key', '1 of 9', 0], moveBurn: ['none', null, null] }))]
    ]);
    const group = sameUnderlyingGroups(tokens)[0];
    const withPowers = sameStockComparisonModels(group, issuers, new Map(), null, Date.parse('2026-09-25T00:00:00Z'), { powersByIssuer });
    const cellsOf = (rows, id) => rows.find((row) => row.id === id).cells;
    const byIssuer = (models, rows, id) => Object.fromEntries(models.map((model, i) => [model.issuerSlug, cellsOf(rows, id)[i]]));

    test('shortens an issuer jurisdiction to the place, and drops an undisclosed one', () => {
        expect(shortJurisdiction('Jersey (Channel Islands)')).toBe('Jersey');
        expect(shortJurisdiction('British Virgin Islands (token issuer and the recognised beneficiary); New Zealand')).toBe('BVI');
        expect(shortJurisdiction('Republic of the Marshall Islands. Formed under the DAO Act 2022')).toBe('Marshall Islands');
        expect(shortJurisdiction('Delaware corporation, principal operations United States.')).toBe('Delaware');
        expect(shortJurisdiction('unknown - undisclosed. ToS states components may be operated anywhere')).toBeNull();
        expect(shortJurisdiction(null)).toBeNull();
    });

    test('rows answer the buyer questions in plain words, one short cell per wrapper linking to its card', () => {
        const rows = buyerRows(withPowers);
        expect(rows.map((row) => row.id)).toEqual(['own', 'powers', 'rights', 'price', 'liquidity', 'redeem', 'borrow']);
        const own = byIssuer(withPowers, rows, 'own');
        expect(own['xstocks-backed']).toMatchObject({ text: 'Secured debt note tracking the share (Jersey)', href: './cards/AAPLx.html#own' });
        expect(own['ondo-global-markets'].text).toBe('Secured debt note tracking the share (BVI)');
        for (const row of rows) {
            for (const cell of row.cells) {
                expect(cell.href).toMatch(/^\.\/cards\/AAPL(x|on)\.html#[a-z-]+$/);
                expect(cell.text.split(/\s+/).length).toBeLessThanOrEqual(12);
            }
        }
    });

    test('says who can freeze, pause or take the tokens, with the key that holds each power', () => {
        const powers = byIssuer(withPowers, buyerRows(withPowers), 'powers');
        expect(powers['xstocks-backed']).toMatchObject({
            text: 'Yes: freeze, pause and take', tone: 'caution', href: './cards/AAPLx.html#control',
            note: 'Freeze and pause: 2-of-4 multisig · take: 2-of-3 multisig · no time lock'
        });
        expect(powers['ondo-global-markets']).toMatchObject({
            text: 'Yes: freeze and pause; cannot take',
            note: 'Freeze: 3-of-8 multisig · pause: one key (any 1 of 9) · no time lock'
        });
        // Without the power map (the page's no-bundle path) the powers still show, without holders.
        const bare = sameStockComparisonModels(group, issuers, new Map(), null);
        const cell = byIssuer(bare, buyerRows(bare), 'powers')['xstocks-backed'];
        expect(cell).toMatchObject({ text: 'Yes: freeze, pause and take', note: null });
        // No power installed is a plain No; an unread token is not a No.
        const none = [{ ...withPowers[0], tokens: [{ ...tokens[0], control: { freezeAuthority: null, permanentDelegate: false, clawback: false, pausable: false } }] }];
        expect(cellsOf(buyerRows(none), 'powers')[0]).toMatchObject({ text: 'No', tone: 'good' });
        const unread = [{ ...withPowers[0], tokens: [{ ...tokens[0], control: undefined }] }];
        expect(cellsOf(buyerRows(unread), 'powers')[0]).toMatchObject({ text: 'Not read', tone: 'muted' });
    });

    test('puts the price, the premium, the liquidity with its source and the volume side by side', () => {
        const rows = buyerRows(withPowers);
        const price = byIssuer(withPowers, rows, 'price');
        expect(price['xstocks-backed']).toMatchObject({ text: '-0.18% vs AAPL', note: '$333.99 on Jupiter', href: './cards/AAPLx.html#reference' });
        expect(price['ondo-global-markets']).toMatchObject({ text: 'Premium not measured', note: '$334.10 on Jupiter', tone: 'muted' });
        const liquidity = byIssuer(withPowers, rows, 'liquidity');
        expect(liquidity['xstocks-backed']).toMatchObject({ text: '$591.7k liquidity · $418.8k traded 24 h', note: 'DexScreener: 1 pool · CoinGecko: 20 exchange markets' });
        expect(liquidity['ondo-global-markets'].text).toBe('$1.6k liquidity · $4.20 traded 24 h');
        expect(rows.find((row) => row.id === 'liquidity').help).toContain('Jupiter, all pools');
        // A missing observation stays missing: never $0, never "0 pools".
        const unmeasured = [{ ...withPowers[0], liquidityUsd: null, volume24Usd: null, tokens: [{ ...tokens[0], market: {}, reference: {}, activity: {} }] }];
        const u = buyerRows(unmeasured);
        expect(cellsOf(u, 'liquidity')[0]).toMatchObject({ text: 'Not measured', note: null, tone: 'muted' });
        expect(cellsOf(u, 'price')[0]).toMatchObject({ text: 'Not measured', note: null });
        // One side measured: the other says so in words, never a dash inside the sentence.
        const half = [{ ...withPowers[0], liquidityUsd: null, volume24Usd: 12.66 }, { ...withPowers[1], liquidityUsd: 0.26, volume24Usd: null }];
        expect(cellsOf(buyerRows(half), 'liquidity').map((cell) => cell.text))
            .toEqual(['Liquidity not measured · $12.66 traded 24 h', '$0.26 liquidity · volume not measured']);
    });

    test('names who may redeem with the issuer, the minimum and a fee only where the term covers this token', () => {
        const redeem = byIssuer(withPowers, buyerRows(withPowers), 'redeem');
        expect(redeem['xstocks-backed']).toMatchObject({ text: 'Yes: KYC’d non-US holders', note: 'Min $5,000', href: './cards/AAPLx.html#own' });
        expect(redeem['ondo-global-markets']).toMatchObject({ text: 'Yes: KYC’d non-US holders', note: 'Min $1 · fee up to 0.1%' });
        const share = sameStockComparisonModels(sameUnderlyingGroups([{ ...tokens[0], issuer: 'superstate-opening-bell' }], { includeSingle: true })[0], issuers, new Map(), null);
        const rows = buyerRows(share);
        expect(cellsOf(rows, 'redeem')[0]).toMatchObject({ text: 'No', tone: 'caution' });
        expect(cellsOf(rows, 'own')[0].text).toBe('The registered share itself');
    });

    test('lists each lender’s closed-market price label, and never turns an unread file into “no lender”', () => {
        const lent = withPowers.map((model) => ({ ...model, tokens: model.tokens.map((token) => ({ ...token,
            closedMarket: token.symbol === 'AAPLx' ? [
                { protocolName: 'Kamino', label: 'frozen at close', labelKind: 'frozen-at-close' },
                { protocolName: 'Nest', label: '24/7 token price', labelKind: 'token-24x7' },
                { protocolName: 'Loopscale', label: 'stale since 26 Aug', labelKind: 'stale' }
            ] : [] })) }));
        const borrow = byIssuer(lent, buyerRows(lent), 'borrow');
        expect(borrow['xstocks-backed']).toMatchObject({
            text: 'Kamino: frozen at close · Nest: 24/7 token price · Loopscale: stale since 26 Aug',
            href: './cards/AAPLx.html#closed-market'
        });
        expect(borrow['ondo-global-markets']).toMatchObject({ text: 'No lender we track takes it', tone: 'muted' });
        // Catalogue tokens (no bundle) carry no closed-market read at all.
        expect(byIssuer(withPowers, buyerRows(withPowers), 'borrow')['xstocks-backed']).toMatchObject({ text: 'Not checked here', tone: 'muted' });
    });

    test('adds a transfer-fee row only when some wrapper charges one, scheduled rises included', () => {
        expect(buyerRows(withPowers).some((row) => row.id === 'fee')).toBe(false);
        const fee = [withPowers[0], { ...withPowers[1], tokens: [{ ...tokens[1], control: { ...tokens[1].control, transferFeeBps: 100, transferFeeScheduled: { bps: 300, epoch: 1043 } } }] }];
        const cells = cellsOf(buyerRows(fee), 'fee');
        expect(cells.map((cell) => cell.text)).toEqual(['None', '1.00% now; 3.00% scheduled']);
    });

    test('renders the table before the Decision summary, one column per wrapper headed by issuer and card links', () => {
        const html = sameStockComparisonHtml(group, withPowers, { sources: { marketFetchedAt: '2026-09-24T20:00:00Z' } });
        const tableAt = html.indexOf('class="buyer-table"');
        expect(tableAt).toBeGreaterThan(-1);
        expect(tableAt).toBeLessThan(html.indexOf('Decision summary'));
        const table = html.slice(tableAt, html.indexOf('</section>', tableAt));
        expect(table).toContain('style="--buyer-cols:2"');
        expect(table.match(/<th scope="col">/g)).toHaveLength(2);
        expect(table).toContain('<a href="./cards/AAPLx.html">AAPLx</a>');
        expect(table).toContain('Kraken xStocks');
        expect(table).toContain('class="rights-strip"');
        expect(table).toContain('Market read 24 Sep 2026 20:00 UTC');
        expect(table).not.toMatch(/<details/);
        // Everything that was there stays.
        for (const label of ['Decision summary', 'Ownership and exit for each wrapper', 'Open the full research matrix']) expect(html).toContain(label);
        expect(buyerTableHtml([])).toBe('');
    });

    test('tells a phone reader to scroll sideways only when the wrappers cannot all fit', () => {
        const many = (n) => Array.from({ length: n }, (_, i) => ({ ...withPowers[i % 2], issuerSlug: `w-${i}` }));
        expect(buyerTableHtml(many(2))).not.toContain('buyer-hint');
        expect(buyerTableHtml(many(3))).toContain('<small class="buyer-hint">Scroll the table sideways to see all 3 wrappers.</small>');
        expect(buyerTableHtml(many(6))).toContain('<small class="buyer-hint buyer-hint-wide">Scroll the table sideways to see all 6 wrappers.</small>');
    });
});

describe('the buyer table for pre-IPO tokens (OpenAI: PreStocks OPENAI vs Tessera tOpenAI)', () => {
    const { buyerRows, buyerTableHtml } = require('./lib/comparison-shape.js');
    const rights = JSON.parse(readFileSync(join(REPO, 'stocks/data/holder-rights.json'), 'utf8')).issuers;
    const built = JSON.parse(readFileSync(join(REPO, 'stocks-issuers.json'), 'utf8')).issuers;
    const issuers = new Map(['prestocks', 'tessera', 'backpack-securities'].map((slug) =>
        [slug, { ...built.find((row) => row.slug === slug), holderRights: rights[slug] }]));
    const PRE = { instrumentType: 'private-company', underlyingTicker: null, closedMarket: [] };
    // The catalogue's records on 2026-09-23 (stocks-tokens.json), trimmed to what the table reads.
    const openai = { ...PRE, mint: 'PreweJ', symbol: 'OPENAI', issuer: 'prestocks', companyKey: 'OPENAI', companyName: 'OpenAI', cardSlug: 'OPENAI',
        market: { usdPrice: 1149.8108, liquidity: 822306.44, vol24: 1330283.83 },
        reference: { source: 'issuer-mark', price: 966.2411, premiumPct: 2.4737 },
        activity: { dexPairs: 1, cexMarkets: 13 },
        control: { freezeAuthority: 'WV9P', permanentDelegate: 'WV9P', clawback: true, pausable: true,
            transferFeeBps: 100, transferFeeScheduled: { bps: 300, epoch: 1043, capped: false } },
        issuerApi: { markPrice: 966.2411, markValuation: 1197105437719 } };
    const topenai = { ...PRE, mint: 'oPAiAi', symbol: 'tOpenAI', issuer: 'tessera', companyKey: 'OPENAI', companyName: 'OpenAI', cardSlug: 'tOpenAI',
        market: { usdPrice: 974.0442, liquidity: 390511.4, vol24: 1235978.74 },
        reference: { source: 'issuer-mark', price: 812.79, premiumPct: 13.3363 },
        activity: { dexPairs: 1, cexMarkets: 4 },
        control: { freezeAuthority: '7n2P', permanentDelegate: false, clawback: false, pausable: false, transferFeeBps: 20 },
        issuerApi: { markPrice: 812.79, markValuation: 950000000000 } };
    const group = sameUnderlyingGroups([openai, topenai])[0];
    const models = sameStockComparisonModels(group, issuers, new Map(), null, Date.parse('2026-09-25T00:00:00Z'));
    const rows = buyerRows(models);
    const row = (id, list = rows) => list.find((entry) => entry.id === id);
    const cellsOf = (list, id) => row(id, list).cells;
    const cells = (id, list = rows) => Object.fromEntries(models.map((model, i) => [model.issuerSlug, row(id, list).cells[i]]));

    test('the pair is one group, one column per issuer, titled by the company', () => {
        const { comparisonGroupTitle } = require('./lib/comparison-shape.js');
        expect(group).toMatchObject({ ticker: 'OPENAI', name: 'OpenAI', preIpo: true });
        expect(comparisonGroupTitle(group)).toBe('OpenAI (pre-IPO)');
        expect(comparisonGroupTitle({ ticker: 'SPCX', name: 'SpaceX', preIpo: false })).toBe('SPCX');
        expect(comparisonGroupTitle({ ticker: 'OPENAI', preIpo: true })).toBe('OPENAI (pre-IPO)');
        expect(models.map((model) => model.issuerSlug)).toEqual(['prestocks', 'tessera']);
        expect(models.every((model) => model.buyer.preIpo)).toBe(true);
    });

    test('what you own: no shares at all, in each issuer’s own legal terms', () => {
        const own = cells('own');
        expect(own.prestocks).toMatchObject({ text: 'No shares: a token referencing the company’s value', href: './cards/OPENAI.html#own' });
        expect(own.tessera.text).toBe('Unsecured loan participation, repaid from sale proceeds (Panama)');
        // Both phrasings are the dossiers' own holder claims, shortened; the dossiers must still say so.
        expect(issuers.get('prestocks').holderClaim).toMatch(/reference\[s\] economic exposure to designated pre-IPO companies/);
        expect(issuers.get('prestocks').holderClaim).toMatch(/no ownership/);
        expect(issuers.get('tessera').holderClaim).toMatch(/loan participation right/);
        expect(issuers.get('tessera').holderClaim).toMatch(/repayable only out of Liquidity Event Proceeds/);
    });

    test('price is measured against each issuer’s own mark, with the valuation that mark implies', () => {
        expect(row('price')).toMatchObject({ label: 'Price vs the issuer’s mark' });
        expect(row('price').help).toContain('no share price');
        const price = cells('price');
        expect(price.prestocks).toMatchObject({ text: '+2.47% vs PreStocks’ own mark', tone: 'caution',
            note: '$1,149.81 on Jupiter · mark $966.24 · values OpenAI at $1.20T', href: './cards/OPENAI.html#reference' });
        expect(price.tessera).toMatchObject({ text: '+13.34% vs Tessera’s own mark',
            note: '$974.04 on Jupiter · mark $812.79 · values OpenAI at $950.00B' });
        // A valuation from a different mark reading is left out rather than paired with this mark.
        const moved = [{ ...models[1], tokens: [{ ...topenai, issuerApi: { markPrice: 830, markValuation: 970000000000 } }] }];
        expect(cellsOf(buyerRows(moved), 'price')[0].note).toBe('$974.04 on Jupiter · mark $812.79');
        // No mark read: said in words, never a premium against nothing.
        const bare = [{ ...models[1], tokens: [{ ...topenai, reference: { source: null, price: null, premiumPct: null }, issuerApi: null }] }];
        expect(cellsOf(buyerRows(bare), 'price')).toEqual([expect.objectContaining({ text: 'Premium to the mark not measured', note: '$974.04 on Jupiter', tone: 'muted' })]);
    });

    test('redemption: PreStocks only on request at its discretion, Tessera only after a liquidity event', () => {
        const redeem = cells('redeem');
        expect(redeem.prestocks).toMatchObject({ text: 'On request, at the issuer’s discretion', note: 'Not an entitlement; exit by selling', tone: 'caution' });
        expect(redeem.tessera).toMatchObject({ text: 'Only after a liquidity event', note: 'Paid when the issuer sells its whole stake; exit by selling until then', tone: 'caution' });
    });

    test('transfer fee: PreStocks 1.00% with 3.00% scheduled from epoch 1043, Tessera 0.20%', () => {
        const fee = cells('fee');
        expect(fee.prestocks).toMatchObject({ text: '1.00% now; 3.00% scheduled', note: 'The rise starts at Solana fee epoch 1043', tone: 'caution', href: './cards/OPENAI.html#control' });
        expect(fee.tessera).toMatchObject({ text: '0.20% now', note: null });
    });

    test('rights, powers, liquidity and lending read the same sources as for any stock', () => {
        expect(cells('rights').prestocks.text).toBe('No shareholder rights');
        expect(cells('rights').tessera.text).toBe('No shareholder rights; the issuer passes through takeovers');
        expect(cells('powers').prestocks.text).toBe('Yes: freeze, pause and take');
        expect(cells('powers').tessera.text).toBe('Yes: freeze; cannot take');
        expect(cells('liquidity').tessera.text).toBe('$390.5k liquidity · $1.24M traded 24 h');
        // No market closes for a private company: the lending row drops "when the market is closed".
        expect(row('borrow')).toMatchObject({ label: 'Borrow against it' });
        expect(cells('borrow').tessera.text).toBe('No lender we track takes it');
    });

    test('every column is marked pre-IPO in the rendered table', () => {
        const html = buyerTableHtml(models);
        expect(html.match(/<span class="buyer-kind">Pre-IPO<\/span>/g)).toHaveLength(2);
        expect(html).toContain('Price vs the issuer’s mark');
        expect(html).not.toContain('when the market is closed');
    });

    test('SpaceX: listed wrappers against the share, pre-IPO wrappers against their mark, in one table', () => {
        const spacex = { ...openai, mint: 'PreANx', symbol: 'SPACEX', companyKey: 'SPCX', companyName: 'SpaceX', cardSlug: 'SPACEX',
            market: { usdPrice: 119.82, liquidity: 113298.22, vol24: 39234.36 },
            reference: { source: 'issuer-mark', price: 146.5453, premiumPct: -23.6351 },
            issuerApi: { markPrice: 146.5453, markValuation: 1921371313796 } };
        const spcx = { mint: 'SPCXxc', symbol: 'SPCX', issuer: 'backpack-securities', underlyingTicker: 'SPCX', instrumentType: 'stock', cardSlug: 'SPCX',
            market: { usdPrice: 152.89, liquidity: 969027.65, vol24: 9304656 }, closedMarket: [],
            reference: { source: 'ondo-implied', price: 146.0088, premiumPct: -1.0929 },
            control: { freezeAuthority: '2cVY', permanentDelegate: '2cVY', clawback: true, pausable: true, transferFeeBps: null } };
        const mixedGroup = sameUnderlyingGroups([spcx, spacex])[0];
        expect(mixedGroup).toMatchObject({ ticker: 'SPCX', name: 'SpaceX', preIpo: false });
        const mixed = sameStockComparisonModels(mixedGroup, issuers, new Map(), null);
        const mixedRows = buyerRows(mixed);
        expect(row('price', mixedRows)).toMatchObject({ label: 'Price vs the stock or the issuer’s mark' });
        expect(row('price', mixedRows).cells.map((cell) => cell.text)).toEqual(['-1.09% vs SPCX', '-23.64% vs PreStocks’ own mark']);
        expect(row('price', mixedRows).cells[1].note).toBe('$119.82 on Jupiter · mark $146.55 · values SpaceX at $1.92T');
        expect(row('borrow', mixedRows).label).toBe('Borrow against it when the market is closed');
        expect(row('own', mixedRows).cells.map((cell) => cell.text)).toEqual(['Beneficial interest in pooled shares (BVI)', 'No shares: a token referencing the company’s value']);
        expect(buyerTableHtml(mixed).match(/buyer-kind/g)).toHaveLength(1);
        // A table with no pre-IPO column keeps its stock wording.
        const listedOnly = buyerRows([mixed[0]]);
        expect(row('price', listedOnly).label).toBe('Price vs the stock');
    });
});
