// Unit tests for stocks/lib/defi-view.js: exact-token DeFi usage, the protocol directory,
// composability templates and the lender-outcome model. Moved with the code out of
// stocks-page.test.js (next-steps.md F11), which still tests the page wiring that calls it.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const REPO = join(__dirname, '..');
const { lenderExitQuality } = require('./lib/composability.mjs');
const {
    defiUsageIndex,
    redemptionUsabilitySummary,
    defiUsageCompactHtml,
    defiUsageDetailHtml,
    defiSourceRows,
    defiProtocolRows,
    filterDefiProtocols,
    defiProtocolDirectoryHtml,
    composabilityTemplateForToken,
    lenderOutcomeModel
} = require('./lib/defi-view.js');

describe('DeFi composability template table', () => {
    const S = require('./lib/defi-view.js');
    const tokenDb = JSON.parse(readFileSync(join(REPO, 'stocks-tokens.json'), 'utf8'));
    const issuerDb = JSON.parse(readFileSync(join(REPO, 'stocks-issuers.json'), 'utf8'));
    const composability = JSON.parse(readFileSync(join(REPO, 'stocks/data/composability-templates.json'), 'utf8'));

    it('renders one row per used tech + legal template and accounts for every mint', () => {
        const rows = S.composabilityTemplateRows(composability, tokenDb.tokens, issuerDb.issuers);
        expect(rows).toHaveLength(9);
        expect(rows.reduce((sum, row) => sum + row.mints, 0)).toBe(tokenDb.tokens.length);
        expect(rows.find((row) => row.issuer === 'xstocks-backed').mints)
            .toBe(tokenDb.tokens.filter((token) => token.issuer === 'xstocks-backed').length);
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
    const db = JSON.parse(readFileSync(join(REPO, 'stocks/data/defi-usage.json'), 'utf8'));
    const index = defiUsageIndex(db);

    it('covers every mint and keeps no-result assets explicit', () => {
        const tokens = JSON.parse(readFileSync(join(REPO, 'stocks-tokens.json'), 'utf8')).tokens;
        expect(index.size).toBe(tokens.length);
        const noResult = [...index.values()].find((item) => item.integrations.length === 0);
        expect(noResult).toBeDefined();
        expect(defiUsageCompactHtml(null)).toContain('None source-listed');
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
        expect(detail).toContain('Open RWA Sonar dossier');
        expect(detail).toContain('./protocols/');
        expect(detail).toContain('Evidence');
    });

    it('shows exactly which protocol sources were checked and whether each observation is current', () => {
        const now = Date.parse('2026-09-20T12:00:00Z');
        const rows = defiSourceRows(db.sources, now);
        expect(rows.map((row) => row.label)).toEqual([
            'Kamino', 'Jupiter Lend', 'Nest', 'Project 0', 'Save', 'DEX pools', 'Meteora', 'Reviewed products', 'Solana accounts'
        ]);
        expect(rows.find((row) => row.id === 'kamino')).toMatchObject({ fresh: true, rows: 139 });
        expect(rows.find((row) => row.id === 'dexPools').fresh).toBe(true);
        expect(rows.find((row) => row.id === 'meteora').fresh).toBe(false);
    });

    it('supports protocol-first discovery without losing exact-mint scope', () => {
        const protocols = defiProtocolRows(db);
        const kamino = protocols.find((row) => row.name === 'Kamino');
        expect(kamino.tokenCount).toBeGreaterThan(0);
        expect(kamino.collateralCount).toBeGreaterThan(0);
        expect(kamino.actions).toEqual(expect.arrayContaining(['collateral', 'borrow']));
        expect(kamino.assets.every((asset) => asset.mint && Array.isArray(asset.actions))).toBe(true);
        expect(filterDefiProtocols(protocols, 'collateral')).toContain(kamino);
        expect(filterDefiProtocols(protocols, 'earn-yield').every((row) => row.actions.includes('earn-yield'))).toBe(true);
        const html = defiProtocolDirectoryHtml([kamino]);
        expect(html).toContain('exact token');
        expect(html).toContain('use as collateral');
        expect(html).toContain('./cards/');
    });

    it('connects a confirmed integration to the token template’s escrow and loss outcomes', () => {
        const tokens = JSON.parse(readFileSync(join(REPO, 'stocks-tokens.json'), 'utf8')).tokens;
        const issuers = JSON.parse(readFileSync(join(REPO, 'stocks-issuers.json'), 'utf8')).issuers;
        const templates = JSON.parse(readFileSync(join(REPO, 'stocks/data/composability-templates.json'), 'utf8'));
        const nvdaToken = tokens.find((token) => token.symbol === 'NVDAx');
        const template = composabilityTemplateForToken(templates, nvdaToken);
        const issuer = issuers.find((row) => row.slug === nvdaToken.issuer);
        const html = defiUsageDetailHtml(index.get(nvdaToken.mint), db.fetchedAt, template, issuer);
        expect(template.issuer).toBe('xstocks-backed');
        expect(html).toContain('What protocol custody means for this token');
        expect(html).toContain('Programmatic collateral listing');
        expect(html).toContain('Can seizure become cash?');
        expect(html).toContain('requires KYC/AML');
        for (const scenario of ['escrow', 'borrowerDefault', 'protocolHack', 'accessLoss']) {
            expect(html).toContain(`data-scenario="${scenario}"`);
        }
        expect(html).toContain('The lender can seize and sell; redemption is gated');
    });

    it('keeps the browser and card exit-after-default verdicts aligned', () => {
        const templates = JSON.parse(readFileSync(join(REPO, 'stocks/data/composability-templates.json'), 'utf8'));
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

    it('keeps redemption documentation, observed execution and exact-token market exit separate', () => {
        const summary = redemptionUsabilitySummary({
            redemption: { available: true },
            claims: [{ field: 'redemption.rails', method: 'manual', note: 'Documented terms only' }]
        }, { activity: { dexPairs: 1, cexMarkets: 0 }, market: { liquidity: 1000 } });
        expect(summary.operational).toContain('Unknown');
        expect(summary.successful).toContain('Not recorded');
        expect(summary.secondary).toContain('Confirmed');
    });

    it('carries the recurring-scan line for the explorer panels without touching documented or operational answers', () => {
        const feed = { observable: true, state: 'scan-failed', lastScanAt: '2026-09-22T06:00:00Z' };
        const summary = redemptionUsabilitySummary({ redemption: { available: true, observationFeed: feed } }, null);
        expect(summary.feed).toEqual({ state: 'scan-failed', text: 'Scan failed on 2026-09-22 — not the same as no redemptions.' });
        expect(summary.operational).toContain('Unknown');
        expect(summary.successful).toContain('Not recorded');
        expect(redemptionUsabilitySummary({ redemption: { available: true } }, null).feed).toBeNull();
    });

    it('keeps structural lender outcomes visible when no current integration is confirmed', () => {
        const tokens = JSON.parse(readFileSync(join(REPO, 'stocks-tokens.json'), 'utf8')).tokens;
        const issuers = JSON.parse(readFileSync(join(REPO, 'stocks-issuers.json'), 'utf8')).issuers;
        const templates = JSON.parse(readFileSync(join(REPO, 'stocks/data/composability-templates.json'), 'utf8'));
        const token = tokens.find((row) => row.issuer === 'ondo-global-markets' && index.get(row.mint)?.integrations.length === 0);
        const template = composabilityTemplateForToken(templates, token);
        const issuer = issuers.find((row) => row.slug === token.issuer);
        const html = defiUsageDetailHtml(index.get(token.mint), db.fetchedAt, template, issuer);
        expect(html).toContain('None source listed');
        expect(html).toContain('What protocol custody means for this token');
        expect(html).toContain('No checked protocol currently lists this exact token as programmatic collateral');
    });

    it('escapes protocol-controlled and curated prose', () => {
        const html = defiUsageDetailHtml({ integrations: [{
            protocolName: '<img src=x>', status: 'live', actions: ['swap'], summary: '<script>x</script>',
            accessNote: '<b>no</b>', links: {}, evidence: []
        }] });
        expect(html).not.toContain('<img');
        expect(html).not.toContain('<script>');
        expect(html).toContain('No exact-token support was established');
        expect(html).toContain('&lt;b&gt;no&lt;/b&gt;');
    });
});
