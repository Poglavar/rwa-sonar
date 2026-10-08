// Keeps the reviewed CET catalogue separate from SECZ shares and checks that its evidence is discoverable.
const fs = require('node:fs');
const path = require('node:path');
const { underlyingTicker, issuerLabel, summarizeExtensions, controlFromOnchain } = require('./lib/classify.mjs');
const { claimRung, instrumentType } = require('./lib/grade.mjs');
const { assessDiscovery } = require('./lib/discovery-candidates.mjs');
const { buildRegistry } = require('./lib/sources.mjs');
const { holderRightsRows, holderRightsHeadline } = require('./lib/holder-rights.js');

const read = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8'));
const observation = read('research/securitize-stocks-2026-10-08.observations.json');
const dossier = read('data/issuers/securitize-stocks.json');
const manual = read('data/manual-mints.json');

test('reviewed catalogue admits all 12 CET mints under their own programme and share-class ticker', () => {
    const rows = observation.items.filter((row) => row.issuer === 'securitize-stocks');
    const manualMints = new Map(manual.map((row) => [row.mint, row]));
    expect(rows).toHaveLength(12);
    expect(rows.map((row) => row.symbol).sort()).toEqual([
        'AAPL', 'AMZN', 'CRCL', 'GOOGL', 'META', 'MSFT', 'MSTR', 'NFLX', 'NVDA', 'PLTR', 'SPCX', 'TSLA'
    ]);
    for (const row of rows) {
        expect(manualMints.get(row.mint)).toMatchObject({ symbol: row.symbol, issuer: 'securitize-stocks' });
        expect(assessDiscovery({ mint: row.mint, symbol: row.symbol }, { manualMints }))
            .toMatchObject({ decision: 'admit', proposedIssuer: 'securitize-stocks', signals: { underlyingTicker: row.symbol } });
        expect(underlyingTicker(row.symbol, 'securitize-stocks')).toBe(row.symbol);
        expect(instrumentType({ ...row, underlyingTicker: row.symbol })).toBe('stock');
    }
    expect(issuerLabel('securitize-stocks')).toBe('Securitize Stocks');
    expect(manualMints.get('5VzwKkvynPJzcgwhBe7ESEyNgqMbo15yBu7Sehssd9ED').issuer).toBe('securitize');
    expect(claimRung(dossier).rung).toBe(3);
    expect(claimRung(read('data/issuers/securitize-secz.json')).rung).toBe(4);
});

test('actual mint observations expose the common administrative controls without inventing a hook', () => {
    for (const row of observation.items.filter((item) => item.issuer === 'securitize-stocks')) {
        const state = summarizeExtensions({ owner: row.tokenProgram, info: row });
        expect(state).toMatchObject({
            permanentDelegate: true, pausable: true, paused: false, defaultAccountStateFrozen: true,
            permanentDelegateAddress: 'Ui3bQKRdTzNRv21sPuXTgmzuz4dLh3sH3B9Y5sxapSR', transferHookProgram: null
        });
    }
});

test('broker-delivered voting and dividends are not presented as an absence of rights', () => {
    const rows = holderRightsRows(read('data/holder-rights.json').issuers['securitize-stocks']);
    expect(rows.find((row) => row.id === 'voting').status).toBe('value');
    expect(rows.some((row) => row.status === 'yes')).toBe(false);
    expect(holderRightsHeadline(rows)).toBe('Rights passed through: dividends, voting, splits and takeovers');
});

test('source extraction discovers the new agreements and both protocol merger FAQs', () => {
    const registry = buildRegistry([
        { slug: 'securitize-stocks', doc: dossier },
        { slug: null, doc: read('data/protocol-organizations.json') }
    ], { generatedAt: observation.reviewedAt });
    const urls = new Set(registry.items.map((row) => row.url));
    for (const row of observation.documentFingerprints) expect(urls.has(row.url)).toBe(true);
    expect(urls.has('https://docs.orca.so/formation/faqs')).toBe(true);
    expect(urls.has('https://docs.loopscale.com/resources/formation')).toBe(true);
    expect(registry.truncated).toEqual([]);
});


test('CET reports include documented in-kind exit and a distinct template for the observed controls', () => {
    const { validatePrimaryMarket, shapePrimaryMarket, primaryMarketHtml } = require('./lib/primary-market.mjs');
    const { indexComposabilityTemplates, composabilityTemplateFor } = require('./lib/composability.mjs');
    const { controlRecipe } = require('./lib/recipe.mjs');
    const market = read('data/primary-market.json');
    expect(validatePrimaryMarket(market)).toEqual([]);
    const entry = market.issuers['securitize-stocks'];
    expect(entry).toMatchObject({ mechanism: 'broker-conversion', inKind: true, settlement: 'unknown' });
    const html = primaryMarketHtml(shapePrimaryMarket(entry, 'AAPL'));
    expect(html).toContain('CET cash redemption is excluded');
    expect(html).toContain('DRS transfer-out $30');
    const index = indexComposabilityTemplates(read('data/composability-templates.json').templates);
    for (const row of observation.items.filter(item => item.issuer === 'securitize-stocks')) {
        const state = summarizeExtensions({ owner: row.tokenProgram, info: row });
        const recipe = controlRecipe({ tokenProgram: row.tokenProgram, control: controlFromOnchain(state) });
        const template = composabilityTemplateFor({ ...row, recipe }, index);
        expect(template?.issuer).toBe('securitize-stocks');
        expect(template?.scenarios.borrowerDefault.outcome).toBe('issuer-mediated');
        expect(template?.legalTemplate).toContain('Article 8');
    }
});
