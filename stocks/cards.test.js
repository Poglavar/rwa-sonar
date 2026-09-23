// Unit tests for the per-token stock cards (lib/cards.mjs) and the promise the cards make: the slug
// rules hold over the real symbols, a card carries all eleven health rules, it never turns into a
// wallet dump, it stays inside its byte budget, it links to its exact .json record, and
// two builds from the same inputs differ only in the one `builtAt` stamp. The real built files are
// read, so a shape drift in any of the seven inputs fails here rather than on a shared card.

const fs = require('node:fs');
const path = require('node:path');

const {
    CARD_BYTE_LIMIT,
    CARD_BYTE_TARGET,
    CARD_CLAIM_FIELDS,
    NO_CLAIM_TEXT,
    OG_DESCRIPTION_MAX,
    OUTCOME_MAX,
    HOLDER_ROWS,
    MATERIAL_CHANGE_TITLE,
    QUOTE_MAX,
    assignSlugs,
    assetDecisionFacts,
    buildCard,
    cardDiscrepancies,
    cardEvidence,
    cardMaterialChanges,
    discrepanciesBody,
    evidenceLine,
    indexEntry,
    ogDescription,
    ogTitle,
    publicCard,
    renderCard,
    shortAddress,
    truncate
} = require('./lib/cards.mjs');
const evidenceLib = require('./lib/evidence.js');
const { HEALTH_RULES } = require('./lib/health.mjs');
const { composabilityTemplateFor, indexComposabilityTemplates } = require('./lib/composability.mjs');
const fmt = require('./lib/fmt.js');

const REPO_ROOT = path.join(__dirname, '..');
const read = (...parts) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ...parts), 'utf8'));
const trustChainSvg = require('./lib/trustchain-svg.js');
const whatIfLib = require('./lib/whatif-render.js');

const tokenDb = read('stocks-tokens.json');
const issuerDb = read('stocks-issuers.json');
const holderDb = read('stocks', 'data', 'holders.json');
const venueDb = read('stocks', 'data', 'venues.json');
const tradeDb = read('stocks', 'fixtures', 'stocks-trades.sample.json');
const afterhoursDb = read('stocks-afterhours.json');
const meteoraDb = read('stocks', 'data', 'meteora.json');
const catalogue = read('stocks', 'data', 'trust-chain.json');
const composabilityDb = read('stocks', 'data', 'composability-templates.json');
const composability = indexComposabilityTemplates(composabilityDb.templates);
const defiUsageDb = read('stocks', 'data', 'defi-usage.json');
const defiUsage = new Map(defiUsageDb.items.map((row) => [row.mint, row]));

/**
 * Each issuer's dossier `whatIf[]`, resolved exactly the way build-cards.mjs resolves it: the file
 * named after the slug, else the one file whose name is the slug plus a token suffix
 * (`bullish-blsh.json` for `bullish`). Derived, so a thirteenth issuer needs no map entry here
 * either — and if the rule ever stopped resolving, the answer-sheet tests below would see 38 gaps.
 */
const DOSSIER_DIR = path.join(REPO_ROOT, 'stocks', 'data', 'issuers');
const DOSSIER_FILES = fs.readdirSync(DOSSIER_DIR).filter((name) => name.endsWith('.json'));

function dossierFileFor(slug) {
    if (DOSSIER_FILES.includes(`${slug}.json`)) return `${slug}.json`;
    const prefixed = DOSSIER_FILES.filter((name) => name.startsWith(`${slug}-`));
    return prefixed.length === 1 ? prefixed[0] : null;
}

const whatIfBySlug = new Map();
for (const row of issuerDb.issuers) {
    const file = dossierFileFor(row.slug);
    if (file === null) continue;
    const dossier = JSON.parse(fs.readFileSync(path.join(DOSSIER_DIR, file), 'utf8'));
    whatIfBySlug.set(row.slug, Array.isArray(dossier.whatIf) ? dossier.whatIf : []);
}

const issuers = new Map(issuerDb.issuers.map((row) => [row.slug, row]));
const holders = new Map(holderDb.items.map((row) => [row.mint, row]));
const venues = new Map(venueDb.items.map((row) => [row.mint, row]));
const afterhours = new Map((afterhoursDb.items ?? []).map((row) => [row.mint, row]));
const meteora = new Map((meteoraDb.items ?? []).map((row) => [row.pairAddress, row]));
const pools = new Map();
for (const pool of tradeDb.pools ?? []) {
    if (typeof pool?.mint !== 'string') continue;
    if (!pools.has(pool.mint)) pools.set(pool.mint, []);
    pools.get(pool.mint).push(pool);
}

const SOURCES = {
    tokens: tokenDb.builtAt,
    issuers: issuerDb.builtAt,
    holders: holderDb.fetchedAt,
    venues: venueDb.fetchedAt,
    trades: tradeDb.generatedAt,
    afterhours: afterhoursDb.generatedAt,
    meteora: meteoraDb.fetchedAt,
    defiUsage: defiUsageDb.fetchedAt
};

const BUILT_AT = '2026-09-17T01:02:03Z';
const SLUGS = assignSlugs(tokenDb.tokens);

function cardFor(symbol, builtAt = BUILT_AT, materialChanges = null, issuerOverride = null) {
    const token = tokenDb.tokens.find((row) => row.symbol === symbol);
    if (token === undefined) throw new Error(`no token with symbol ${symbol} in stocks-tokens.json`);
    return buildCard({
        materialChanges,
        token,
        issuer: issuerOverride ?? issuers.get(token.issuer) ?? null,
        holdersItem: holders.get(token.mint) ?? null,
        venuesItem: venues.get(token.mint) ?? null,
        afterhoursItem: afterhours.get(token.mint) ?? null,
        meteoraByPair: meteora,
        pools: pools.get(token.mint) ?? null,
        slug: SLUGS.get(token.mint),
        builtAt,
        sources: SOURCES,
        catalogue,
        whatIf: whatIfBySlug.get(token.issuer) ?? null,
        archives: null,
        composabilityTemplate: composabilityTemplateFor(token, composability),
        defiUsageItem: defiUsage.get(token.mint) ?? null
    });
}

/** Every string anywhere in a record, so a test can tell a wallet from a pair address. */
function collectStrings(value, out = []) {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) for (const inner of value) collectStrings(inner, out);
    else if (value && typeof value === 'object') for (const inner of Object.values(value)) collectStrings(inner, out);
    return out;
}

const BASE58_RUN = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

/**
 * The base58 addresses a rendered card shows that are not accounted for: not the mint, not an
 * authority, not a pool, and not a key quoted inside the dossier evidence prose. What is left is
 * the holder list, which is the thing that must never turn into a wallet dump.
 */
function walletsIn(card, html) {
    const owners = new Set(card.holders.top.map((row) => row.owner));
    const known = new Set();
    for (const value of collectStrings(card)) {
        if (owners.has(value)) continue;
        for (const run of value.match(BASE58_RUN) ?? []) {
            known.add(run);
            known.add(run.toLowerCase());
        }
    }
    return [...new Set(html.match(BASE58_RUN) ?? [])].filter((address) => !known.has(address));
}

const REAL_SYMBOLS = ['NVDAx', 'SPACEX', 'AAPLon', 'GLXY', 'tKalshi'];

// --- slugs ------------------------------------------------------------------------------------

describe('cardSlug', () => {
    it('keeps a path-safe symbol exactly as it is, case included', () => {
        expect(fmt.cardSlug('NVDAx', 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh')).toBe('NVDAx');
        expect(fmt.cardSlug('BRK.Bx', 'Mint')).toBe('BRK.Bx');
        expect(fmt.cardSlug('T-Kalshi', 'Mint')).toBe('T-Kalshi');
    });

    it('turns every unsafe run into a single hyphen', () => {
        expect(fmt.cardSlug('Apple (Ondo)', 'Mint')).toBe('Apple-Ondo');
        expect(fmt.cardSlug('a/b\\c', 'Mint')).toBe('a-b-c');
        expect(fmt.cardSlug('../../etc/passwd', 'Mint')).toBe('etc-passwd');
    });

    it('falls back to the mint when nothing of the symbol survives, and never to an empty name', () => {
        expect(fmt.cardSlug('', 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh')).toBe('mint-Xsc9qvGR');
        expect(fmt.cardSlug('***', 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh')).toBe('mint-Xsc9qvGR');
        expect(fmt.cardSlug(null, '')).toBe('');
    });
});

describe('assignSlugs over the real token file', () => {
    it('gives all 441 mints a path-safe slug', () => {
        expect(SLUGS.size).toBe(tokenDb.tokens.length);
        for (const slug of SLUGS.values()) {
            expect(slug).toMatch(/^[A-Za-z0-9._-]+$/);
            expect(slug.length).toBeGreaterThan(0);
        }
    });

    it('never gives two mints the same file name, case-insensitively', () => {
        const seen = new Map();
        for (const [mint, slug] of SLUGS) {
            const key = slug.toLowerCase();
            expect(seen.has(key)).toBe(false);
            seen.set(key, mint);
        }
    });

    /**
     * The built record carries the collision-safe slug used by the cards builder and API list.
     */
    it('agrees with the slug the stocks page computes for every token', () => {
        for (const token of tokenDb.tokens) {
            expect(token.cardSlug).toBe(SLUGS.get(token.mint));
        }
    });

    it('appends the mint prefix to every member of a colliding group', () => {
        const slugs = assignSlugs([
            { mint: 'AaaaMint111111111111111111111111111111111111', symbol: 'TSLAx' },
            { mint: 'BbbbMint222222222222222222222222222222222222', symbol: 'tslax' },
            { mint: 'CcccMint333333333333333333333333333333333333', symbol: 'SOLO' }
        ]);
        expect(slugs.get('AaaaMint111111111111111111111111111111111111')).toBe('TSLAx-AaaaMi');
        expect(slugs.get('BbbbMint222222222222222222222222222222222222')).toBe('tslax-BbbbMi');
        expect(slugs.get('CcccMint333333333333333333333333333333333333')).toBe('SOLO');
    });

    it('does not depend on the order the tokens arrive in', () => {
        const tokens = tokenDb.tokens.slice(0, 40);
        const forwards = assignSlugs(tokens);
        const backwards = assignSlugs(tokens.slice().reverse());
        expect([...backwards.entries()].sort()).toEqual([...forwards.entries()].sort());
    });
});

// --- prose and addresses ----------------------------------------------------------------------

describe('truncate and shortAddress', () => {
    it('cuts prose at a word boundary and marks the cut', () => {
        expect(truncate('a short line', 40)).toBe('a short line');
        expect(truncate('the quick brown fox jumped over it', 20)).toBe('the quick brown fox…');
        expect(truncate('  collapses\n  whitespace  ', 40)).toBe('collapses whitespace');
    });

    it('keeps a missing value missing rather than inventing an empty quotation', () => {
        expect(truncate(null)).toBeNull();
        expect(truncate('   ')).toBeNull();
        expect(truncate(42)).toBeNull();
    });

    it('shortens a Solana address and leaves anything else alone', () => {
        expect(shortAddress('Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh')).toBe('Xsc9qv…9qEh');
        expect(shortAddress('multisig')).toBe('multisig');
    });
});

// --- OpenGraph --------------------------------------------------------------------------------

describe('ogDescription', () => {
    it('stays inside the OpenGraph limit on every real token', () => {
        for (const token of tokenDb.tokens) {
            const card = cardFor(token.symbol);
            const description = ogDescription(card);
            expect(description.length).toBeLessThanOrEqual(OG_DESCRIPTION_MAX);
            expect(description).not.toMatch(/[<>]/);
        }
    });

    it('names the issuer, the claim, the premium and the depth', () => {
        const description = ogDescription(cardFor('NVDAx'));
        expect(description).toMatch(/xStocks/i);
        expect(description).toMatch(/holder claim/);
        expect(description).toMatch(/liquidity/);
    });

    it('escapes the description and the title into their meta tags', () => {
        const card = cardFor('NVDAx');
        const hostile = { ...card, name: 'Evil <script>alert("x")</script> & co', symbol: 'A"B<C' };
        const html = renderCard(hostile, { baseUrl: null, version: 'test' });
        const head = html.slice(0, html.indexOf('</head>'));
        expect(head).not.toContain('<script');
        expect(head).toContain('&lt;script&gt;');
        expect(head).toContain('&quot;');
        expect(ogTitle(hostile)).toContain('A"B<C');
    });
});

// --- the rendered card ------------------------------------------------------------------------

describe('renderCard', () => {
    const card = cardFor('NVDAx');
    const html = renderCard(card, { baseUrl: 'https://rwasonar.com', version: '20260917a' });

    it('renders every one of the eleven health rules with its label, threshold, inputs and note', () => {
        for (const rule of HEALTH_RULES) {
            expect(html).toContain(rule.label);
            expect(card.health.rules.some((row) => row.id === rule.id)).toBe(true);
            expect(publicCard(card).health.rules.some((row) => row.id === rule.id)).toBe(true);
        }
        for (const rule of card.health.rules) {
            expect(html).toContain(fmt.escapeHtml(rule.threshold));
            if (rule.note !== null) expect(html).toContain(fmt.escapeHtml(rule.note).slice(0, 24));
        }
    });

    it('shows all four dimensions as separate verdicts above the overall result', () => {
        expect(html).toContain('aria-label="Health by dimension"');
        expect(html).toContain('Market');
        expect(html).toContain('Control');
        expect(html).toContain('Legal / evidence');
        expect(html).toContain('DeFi composability');
        expect(publicCard(card).health.dimensions).toEqual(card.health.dimensions);
    });

    it('starts with the five holder decisions and keeps each explanation one click away', () => {
        const facts = assetDecisionFacts(card);
        expect(facts.map((row) => row.id)).toEqual(['ownership', 'control', 'exit', 'defi', 'risk']);
        expect(facts.every((row) => row.value && row.href && row.link)).toBe(true);
        expect(html).toContain('The five things to know first');
        expect(html).toContain('../learn/beneficial-ownership.html');
        expect(html).toContain('../learn/issuer-control.html');
        expect(html).toContain('../learn/redemption.html');
        expect(html).toContain('../learn/defi-custody.html');
        expect(html).toContain('class="decision-health"');
        expect(html).toContain('Exact-token support is source-listed.');
        expect(html).toContain('No configuration decoding or read-only execution simulation was performed');
    });

    it('propagates an issuer P0 review to the token record and above-the-fold card', () => {
        const token = tokenDb.tokens.find((row) => row.symbol === 'NVDAx');
        const flagged = buildCard({ token, issuer: issuers.get(token.issuer), reviewItems: [{
            id: 'review-1', priority: 'P0', issuerSlug: token.issuer, area: 'control',
            title: 'Authority changed', claimImpact: 'Control may differ.'
        }] });
        expect(flagged.underReview).toHaveLength(1);
        expect(publicCard(flagged).underReview).toHaveLength(1);
        expect(renderCard(flagged)).toContain('Legal conclusions under review');
    });

    it('highlights issuer claims that conflict with observed reality and cites both sides', () => {
        const xstocks = cardFor('FGDLx');
        const xstocksHtml = renderCard(xstocks);
        expect(xstocks.discrepancies).toHaveLength(1);
        expect(assetDecisionFacts(xstocks).find((row) => row.id === 'exit').value)
            .toContain('No confirmed secondary-market exit');
        expect(assetDecisionFacts(xstocks).find((row) => row.id === 'exit').value)
            .toContain('Coverage checked');
        expect(cardDiscrepancies(issuers.get('xstocks-backed'), tokenDb.tokens.find((row) => row.symbol === 'FGDLx'))).toEqual(xstocks.discrepancies);
        expect(cardFor('NVDAx').discrepancies).toHaveLength(0);
        expect(xstocksHtml).toContain('Claim ≠ observed reality');
        expect(xstocksHtml).toContain('<section id="discrepancies">');
        expect(xstocksHtml).toContain('Published claim');
        expect(xstocksHtml).toContain('Observed reality');
        expect(xstocksHtml).toContain('xStocks proof-of-reserves API');
        expect(xstocksHtml).toContain('xStocks asset registry API');
        expect(xstocksHtml).toContain('Why it matters');
        expect(xstocksHtml).toContain('What resolves it');
        expect(publicCard(xstocks).discrepancies).toEqual([{
            id: 'proof-of-reserves-coverage',
            severity: 'warning',
            classification: 'asset-specific evidence-coverage gap',
            affectedMints: ['XspurdrAqbRJMQfAUEfh88QxE3XbSWxQGu3GneJR6e3', 'XsVXnJqySwKVHq3stnK9EKc7criyv5oTtrid7UJQot7']
        }]);
        expect(publicCard(xstocks).discrepancies[0]).not.toHaveProperty('claim');
    });

    it('escapes discrepancy prose and does not link an unsafe evidence URL', () => {
        const body = discrepanciesBody({ discrepancies: [{
            id: 'hostile', title: '<img src=x onerror=alert(1)>', severity: 'warning', observedAt: '2026-09-20',
            claim: { text: '<script>alert(1)</script>', sources: [{ label: '<b>claim</b>', url: 'javascript:alert(1)', locator: 'line <1>', accessedAt: null }] },
            reality: { text: 'Observed & checked', sources: [{ label: 'Safe', url: 'https://example.com/evidence', locator: 's. 1', accessedAt: '2026-09-20T00:00:00Z' }] },
            impact: 'Important <now>'
        }] });
        expect(body).not.toContain('<script>');
        expect(body).not.toContain('<img');
        expect(body).not.toContain('href="javascript:');
        expect(body).toContain('&lt;script&gt;');
        expect(body).toContain('href="https://example.com/evidence"');
    });

    it('renders all sections in the order a reader needs them', () => {
        const order = ['own', 'reference', 'afterhours', 'depth', 'holders', 'control',
            'defi-usage', 'composability', 'verification', 'venues', 'issuer-api', 'rules'];
        const prestocks = renderCard(cardFor('SPACEX'), { baseUrl: null, version: 'v' });
        let cursor = -1;
        for (const id of order) {
            const at = prestocks.indexOf(`<section id="${id}">`);
            expect(at).toBeGreaterThan(cursor);
            cursor = at;
        }
    });

    it('separates confirmed exact-mint usage from structural composability', () => {
        expect(card.defiUsage.protocols).toEqual(expect.arrayContaining([
            'Jupiter Lend', 'Kamino', 'Nest', 'Raydium', 'Veda xStocks Vault'
        ]));
        expect(html).toContain('<section id="defi-usage">');
        expect(html).toContain('Use as collateral');
        expect(html).toContain('Earn yield');
        expect(html.indexOf('<section id="defi-usage">')).toBeLessThan(html.indexOf('<section id="composability">'));
        expect(publicCard(card).defiUsage.confirmedUseCount).toBe(5);
        expect(publicCard(card).defiUsage.integrations[0]).not.toHaveProperty('summary');
        expect(html).toContain('Open RWA Sonar dossier');
        expect(html).toContain('../protocols/');

        // Shared proof wording is printed once in the key, never once per integration, while each
        // integration keeps its own stage and account check (the 96 kB target, 2026-09-23).
        const usage = html.slice(html.indexOf('<section id="defi-usage">'), html.indexOf('</section>', html.indexOf('<section id="defi-usage">')));
        const count = (needle) => usage.split(needle).length - 1;
        expect(count('No configuration decoding or read-only execution simulation was performed.')).toBe(new Set(card.defiUsage.integrations
            .map((entry) => entry.proof?.sourceStatus === 'observed-market' ? 'market' : 'listed')).size);
        expect(count('<p class="defi-proof"><strong>')).toBe(card.defiUsage.integrations.length);
        expect(count('published accounts existed') + count('No published Solana account address')).toBe(card.defiUsage.integrations.length);
        expect(count('Issuer eligibility and the protocol’s geographic restrictions apply')).toBe(1);
        expect(usage).toContain('<strong>Access:</strong> as for Kamino above.');

        const emptyUsage = [...defiUsage.values()].find((item) => item.integrations.length === 0
            && tokenDb.tokens.filter((token) => token.symbol === item.symbol).length === 1);
        expect(emptyUsage).toBeDefined();
        const none = cardFor(emptyUsage.symbol);
        expect(none.defiUsage.integrations).toEqual([]);
        expect(renderCard(none, { version: 'test' })).toContain('None source-listed.');
    });

    it('separates documented redemption terms from route and successful-use evidence', () => {
        expect(card.ownership.redemptionUsability.documentedButNotIndependentlyObserved).toBe(true);
        expect(html).toContain('Can a holder actually redeem?');
        expect(html).toContain('Documented, but not independently observed.');
        expect(html).toContain('Successful redemption independently observed');
        expect(publicCard(card).ownership.redemptionUsability.fields).toHaveLength(9);
    });

    it('keeps product-scoped redemption terms scoped on FGDLx and exposes complete qualifications', () => {
        const token = tokenDb.tokens.find((row) => row.symbol === 'FGDLx');
        const issuer = { ...issuers.get(token.issuer), redemption: {
            ...issuers.get(token.issuer).redemption,
            termScopes: { fees: { kind: 'product-example', products: ['TSLAx'] } }
        } };
        const fgdlx = buildCard({ token, issuer });
        const fgdlxHtml = renderCard(fgdlx, { version: 'test' });
        const fee = fgdlx.ownership.redemptionUsability.fields.find((field) => field.id === 'fees');
        expect(fee).toMatchObject({
            value: 'No FGDLx-specific fee is confirmed; TSLAx is a programme example only.',
            scope: 'other-product-example', applicable: false, exampleProduct: 'TSLAx'
        });
        expect(fgdlxHtml).toContain('No FGDLx-specific fee is confirmed; TSLAx is a programme example only.');
        expect(fgdlxHtml).toContain('<details class="redemption-term">');
        expect(fgdlxHtml).toContain('Primary-market access requires onboarding with the issuer');
        expect(fgdlx.ownership.redemptionUsability.fields.find((field) => field.id === 'route-currently-available'))
            .toMatchObject({ value: true, evidence: 'documented' });
        expect(fgdlx.ownership.redemptionUsability.fields.find((field) => field.id === 'successful-redemption'))
            .toMatchObject({ value: false, evidence: 'not-recorded' });
    });

    it('keeps redemption scope metadata in the adjacent machine record', () => {
        const published = publicCard(card).ownership.redemptionUsability.fields;
        const eligibility = published.find((field) => field.id === 'eligibility-and-place');
        const fee = published.find((field) => field.id === 'fees');
        expect(eligibility).toHaveProperty('value');
        expect(eligibility).toMatchObject({
            summary: 'Programme term expressly applies across the product set, including NVDAx.',
            scope: 'programme-all-products', evidence: 'documented'
        });
        // A scope-aware conclusion is not a duplicate of the visible source text and remains
        // machine-readable for comparison consumers.
        const scoped = { ...card, ownership: { ...card.ownership, redemptionUsability: {
            ...card.ownership.redemptionUsability,
            fields: card.ownership.redemptionUsability.fields.map((field) => field.id === 'fees'
                ? { ...field, value: 'No NVDAx-specific fee is confirmed.', completeText: 'TSLAx price.' } : field)
        } } };
        expect(publicCard(scoped).ownership.redemptionUsability.fields.find((field) => field.id === 'fees').value)
            .toBe('No NVDAx-specific fee is confirmed.');
        expect(fee).not.toHaveProperty('completeText');
    });

    it('does not promote issuer redemption prose or flags into an independently observed outcome', () => {
        const token = tokenDb.tokens.find((row) => row.symbol === 'FGDLx');
        const issuer = { ...issuers.get(token.issuer), redemption: {
            ...issuers.get(token.issuer).redemption,
            operationalRouteAvailable: true,
            operationalEvidence: null,
            successfulRedemptionObserved: true
        } };
        const usability = buildCard({ token, issuer }).ownership.redemptionUsability;
        expect(usability.fields.find((field) => field.id === 'route-currently-available'))
            .toMatchObject({ value: null, evidence: 'unknown' });
        expect(usability.fields.find((field) => field.id === 'successful-redemption'))
            .toMatchObject({ value: null, evidence: 'unknown' });
    });

    it('labels a current official route as documented while keeping successful execution unobserved', () => {
        const token = tokenDb.tokens.find((row) => row.symbol === 'FGDLx');
        const base = issuers.get(token.issuer);
        const { successfulRedemptionEvidence, ...terms } = base.redemption;
        const issuer = { ...base, redemption: { ...terms, successfulRedemptionObserved: false } };
        const usability = buildCard({ token, issuer }).ownership.redemptionUsability;
        expect(usability.fields.find((field) => field.id === 'route-currently-available'))
            .toMatchObject({ value: true, evidence: 'documented' });
        expect(usability.fields.find((field) => field.id === 'successful-redemption'))
            .toMatchObject({ value: false, evidence: 'not-recorded' });
    });

    it('scopes a recorded on-chain redemption to the products actually observed', () => {
        const token = tokenDb.tokens.find((row) => row.symbol === 'FGDLx');
        const base = issuers.get(token.issuer);
        const issuer = { ...base, redemption: { ...base.redemption, successfulRedemptionObserved: true,
            successfulRedemptionEvidence: { status: 'observed-onchain-transaction', chain: 'solana',
                accepted: [{ symbol: 'METAx' }, { symbol: 'SPCXx' }] } } };
        const card = buildCard({ token, issuer });
        const usability = card.ownership.redemptionUsability;
        expect(usability.documentedButNotIndependentlyObserved).toBe(false);
        expect(usability.fields.find((field) => field.id === 'successful-redemption')).toMatchObject({
            value: true, evidence: 'observed', exactProductObserved: false,
            summary: 'Observed on-chain for the programme route (METAx, SPCXx), not for FGDLx itself.'
        });
    });

    it('renders the observed product scoping on the static card, not a bare "Yes"', () => {
        const token = tokenDb.tokens.find((row) => row.symbol === 'FGDLx');
        const base = issuers.get(token.issuer);
        const issuer = { ...base, redemption: { ...base.redemption, successfulRedemptionObserved: true,
            successfulRedemptionEvidence: { status: 'observed-onchain-transaction', chain: 'solana',
                accepted: [{ symbol: 'METAx' }, { symbol: 'SPCXx' }] } } };
        const html = renderCard(buildCard({ token, issuer }), { version: 'test' });
        expect(html).toContain('<summary>Observed on-chain for the programme route (METAx, SPCXx), not for FGDLx itself.</summary>');
    });

    describe('recurring on-chain scan line', () => {
        const { publicFeed } = require('./lib/redemption-feed.mjs');
        const NOW = '2026-09-23T21:00:00Z';
        const scanned = (extra = {}) => publicFeed({
            observable: true, mechanism: 'three-leg-transfer-redemption',
            coverage: [{ from: '2026-09-23T01:27:46Z', to: '2026-09-23T20:22:10Z' }],
            daily: { '2026-09-23': { redemptions: 6 } }, lastObserved: { blockTime: '2026-09-23T15:48:28Z' },
            lastScan: { at: '2026-09-23T20:23:10Z', status: 'ok', backlog: 0 }, ...extra
        }, { now: NOW });
        const withFeed = (symbol, feed) => {
            const base = issuers.get(tokenDb.tokens.find((row) => row.symbol === symbol).issuer);
            const issuer = { ...base, redemption: { ...base.redemption, observationFeed: feed } };
            return renderCard(cardFor(symbol, BUILT_AT, null, issuer), { version: 'test' });
        };
        const row = (html) => html.match(/<div class="redemption-feed">.*?<\/div>/)?.[0] ?? null;

        it('sits right after the observed-execution row, labelled programme-wide, for every state', () => {
            const cases = [
                [scanned(), 'Redemptions observed on-chain: last on 2026-09-23 (6 in the last 19 h, recurring scan).'],
                [scanned({ lastObserved: null, daily: {} }), 'No redemption observed in 0.8 days of continuous coverage.'],
                [scanned({ lastScan: { at: '2026-09-23T20:23:10Z', status: 'failed', error: 'RPC 429' } }), 'Scan failed on 2026-09-23 — not the same as no redemptions.'],
                [scanned({ coverage: [{ from: '2026-09-01T00:00:00Z', to: '2026-09-18T12:00:00Z' }] }), 'Scan stale since 2026-09-18 — not a statement that redemptions stopped.'],
                [scanned({ coverage: [], lastObserved: null }), 'Not yet covered by the recurring scan.'],
                [publicFeed({ observable: false, whyNotObservable: 'No redemption address is published. The rest is detail.' }, { now: NOW }), 'Not observable on-chain: No redemption address is published.']
            ];
            for (const [feed, text] of cases) {
                const html = withFeed('TSLAx', feed);
                expect(row(html)).toContain('<dt>Recurring on-chain scan (programme)</dt>');
                expect(row(html)).toContain(`<b>${text.replace(/"/g, '&quot;')}</b>`);
                expect(html.indexOf('Successful redemption independently observed')).toBeLessThan(html.indexOf('redemption-feed'));
                expect(html.indexOf('redemption-feed')).toBeLessThan(html.indexOf('<dt>Secondary-market exit</dt>'));
                // Documented route and operational availability keep their own rows.
                expect(html).toContain('<dt>Eligible holder and route</dt>');
                expect(html).toContain('<dt>Route currently available</dt>');
            }
            expect(row(renderCard(cardFor('TSLAx'), { version: 'test' }))).toBeNull();
        });

        it('Superstate reads as an on-chain conversion leg, never as a redemption observed', () => {
            const symbol = tokenDb.tokens.find((row) => row.issuer === 'superstate-opening-bell')?.symbol;
            if (!symbol) return;
            const html = withFeed(symbol, scanned({ mechanism: 'burn-to-book-entry-conversion', completionObservable: false }));
            expect(row(html)).toContain('On-chain leg only: burn-to-book-entry conversion last seen on 2026-09-23');
            expect(row(html)).toContain('happens off-chain and is not observed');
            expect(row(html)).not.toMatch(/Redemptions observed/);
        });

        it('costs a few hundred bytes and keeps the widest real card inside the hard limit', () => {
            const why = 'Redemption is terminal and contingent: holders burn T-Tokens to the Tessera smart contracts only during a Redemption Period, which opens after a Liquidity Event, receipt of the proceeds in full and a Redemption Start Date announced by TWF; per the Terms no Liquidity Event Proceeds have been received and no Redemption Period has commenced. Second sentence.';
            const feed = publicFeed({ observable: false, whyNotObservable: why }, { now: NOW });
            const widest = tokenDb.tokens.map((t) => ({ symbol: t.symbol, bytes: Buffer.byteLength(renderCard(cardFor(t.symbol), { version: 'test' }), 'utf8') }))
                .sort((a, b) => b.bytes - a.bytes)[0];
            const withLine = Buffer.byteLength(withFeed(widest.symbol, feed), 'utf8');
            expect(withLine - widest.bytes).toBeGreaterThan(0);
            expect(withLine - widest.bytes).toBeLessThan(600);
            expect(withLine).toBeLessThanOrEqual(CARD_BYTE_LIMIT);
        });

        it('is deterministic: the same feed renders byte-identically', () => {
            expect(withFeed('TSLAx', scanned())).toBe(withFeed('TSLAx', scanned()));
        });
    });

    it('separates technical authority capabilities from attribution and lawful-use limits', () => {
        expect(card.authorityAttribution.authorities).toHaveLength(10);
        expect(html).toContain('Capability is not permission');
        expect(html).toContain('Controller / threshold / rotation');
        expect(html).toContain('Contractual circumstances');
        expect(html).toContain('Technical control notes');
        expect(html).toContain('Technical observations');
        expect(publicCard(card).control).toEqual(card.control);
        expect(html).toContain('<dt>Freeze authority</dt>');
        expect(html).toContain(`title="${card.control.freezeAuthority}"`);
    });

    it('groups identical technical notes without dropping their distinct authority roles', () => {
        const note = 'Shared technical fact used by both authority roles.';
        const local = cardFor('NVDAx');
        for (const row of local.authorityAttribution.authorities.filter((row) => ['freeze', 'pause'].includes(row.id))) {
            row.governance.technicalNotes = note;
            row.governance.observedAt = '2026-09-20';
            row.governance.source = 'https://fixture.example/control';
        }
        const rendered = renderCard(local);
        expect(rendered.split(note)).toHaveLength(2);
        expect(rendered).toContain('Freeze accounts, Pause transfers:');
        expect(rendered).toContain('observed 2026-09-20');
    });

    it('does not promote source-listed DeFi support into a successful user action', () => {
        const defi = assetDecisionFacts(card).find((row) => row.id === 'defi');
        expect(defi.value).toContain('Exact-token support:');
        expect(defi.value).toContain('source-described');
        expect(defi.value).toContain('Evidence checked');
        expect(defi.value).toContain('Execution is not independently evidenced.');
        expect(defi.value).not.toContain('Confirmed with');
    });

    it('shows each health dimension’s judged and unknown coverage beside its status', () => {
        expect(html).toMatch(/Market<\/span><b[^>]*>[^<]+<\/b><small>[^<]+ · \d+\/\d+ checks judged; \d+ unknown<\/small>/);
        expect(html).toContain('checks judged;');
        expect(html).toContain('unknown</small>');
    });

    it('explains escrow, borrower default, protocol hack and access loss from the matched template', () => {
        expect(card.composability.id).toMatch(/^xstocks-backed--/);
        for (const phrase of ['Smart-contract escrow', 'Borrower default', 'Protocol hacked', 'Access or key loss']) {
            expect(html).toContain(phrase);
        }
        expect(html).toContain('Programmatic collateral listing');
        expect(html).toContain('Can seizure become cash?');
        expect(html).toContain('issuer redemption requires KYC/AML');
        expect(html).toContain('Pool presence does not guarantee executable liquidation size');
        expect(html).toContain('capability, not a duty');
        expect(html).toContain(`../templates/${card.composability.id}.html`);
        expect(publicCard(card).composability).toEqual({
            id: card.composability.id,
            healthStatus: 'caution',
            scenarios: {
                escrow: { outcome: 'conditional' },
                borrowerDefault: { outcome: 'conditional' },
                protocolHack: { outcome: 'issuer-may-recover' },
                accessLoss: { outcome: 'discretionary-recovery' }
            }
        });
    });

    it('shows at most five wallet addresses, each truncated with the full one in a title', () => {
        expect(card.holders.top.length).toBeLessThanOrEqual(HOLDER_ROWS);
        const wallets = walletsIn(card, html);
        expect(wallets.length).toBeLessThanOrEqual(HOLDER_ROWS);
        const section = html.slice(html.indexOf('<section id="holders">'), html.indexOf('<section id="control">'));
        expect(new Set(section.match(BASE58_RUN) ?? []).size).toBeLessThanOrEqual(HOLDER_ROWS);
        for (const owner of card.holders.top.map((row) => row.owner)) {
            expect(html).toContain(`title="${owner}"`);
            expect(html).toContain(shortAddress(owner));
        }
    });

    it('emits og:url and the canonical link only when a base URL was given', () => {
        expect(html).toContain('<meta property="og:url" content="https://rwasonar.com/cards/NVDAx.html" />');
        expect(html).toContain('<link rel="canonical" href="https://rwasonar.com/cards/NVDAx.html" />');
        const anonymous = renderCard(card, { baseUrl: null, version: 'v' });
        expect(anonymous).not.toContain('og:url');
        expect(anonymous).not.toContain('canonical');
    });

    it('shares the site preview image as a large card, keeping its own token title', () => {
        expect(html).toContain('<meta property="og:image" content="https://rwasonar.com/images/og-rwasonar.png?v=20260923" />');
        expect(html).toContain('<meta name="twitter:image" content="https://rwasonar.com/images/og-rwasonar.png?v=20260923" />');
        expect(html).toContain('<meta property="og:image:width" content="1200" />');
        expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
        expect(html).toMatch(/<meta property="og:title" content="[^"]*NVDAx/);
        const anonymous = renderCard(card, { baseUrl: null, version: 'v' });
        expect(anonymous).not.toContain('og:image');
        expect(anonymous).toContain('<meta name="twitter:card" content="summary" />');
    });

    it('is a complete, indexable page with the shared assets', () => {
        expect(html.startsWith('<!doctype html>')).toBe(true);
        expect(html).not.toContain('noindex');
        expect(html).toContain('<meta name="description"');
        expect(html).toContain('class="asset-decision"');
        expect(html).toContain('<link rel="stylesheet" href="../card.css?v=20260917a" />');
        // The trust-chain/what-if rules are one shared sheet, after card.css (next-steps.md F11).
        expect(html).toContain('<link rel="stylesheet" href="../card.css?v=20260917a" /><link rel="stylesheet" href="../trustchain.css?v=20260917a" />');
        expect(html).toContain('<script src="../card.js?v=20260917a"></script>');
        expect(html).toContain('<meta name="twitter:site" content="@RWASonar" />');
        expect(html).toContain('href="https://x.com/RWASonar"');
        for (const page of ['../stocks.html?view=assets', '../stocks.html?view=compare', '../watch.html', '../learn/']) {
            expect(html).toContain(`href="${page}"`);
        }
    });

    it('labels the issuer API as the issuer\'s own numbers and omits the section otherwise', () => {
        const prestocks = renderCard(cardFor('SPACEX'), { baseUrl: null, version: 'v' });
        expect(prestocks).toContain('own numbers, not an independent price');
        expect(prestocks).toContain('Mark price');
        expect(renderCard(cardFor('NVDAx'), { baseUrl: null, version: 'v' })).not.toContain('Issuer API');
    });

    it('carries the per-source data timestamps and the mint', () => {
        for (const value of Object.values(SOURCES)) {
            if (value) expect(html).toContain(`datetime="${value}"`);
        }
        expect(html).toContain(card.mint);
    });
});

// --- budget, determinism, round-trip ----------------------------------------------------------

describe('every real card', () => {
    const rendered = tokenDb.tokens.map((token) => {
        const card = cardFor(token.symbol);
        return { card, html: renderCard(card, { baseUrl: 'https://rwasonar.com', version: 'v' }) };
    });

    it('stays inside the per-card byte budget', () => {
        for (const { card, html } of rendered) {
            expect(Buffer.byteLength(html, 'utf8')).toBeLessThanOrEqual(CARD_BYTE_LIMIT);
            expect(card.slug.length).toBeGreaterThan(0);
        }
    });

    it('renders the shared application header exactly once', () => {
        for (const { html } of rendered) {
            expect((html.match(/<header class="app-header">/g) ?? [])).toHaveLength(1);
        }
    });

    it('never shows more than five wallet addresses', () => {
        for (const { card, html } of rendered) {
            expect(walletsIn(card, html).length).toBeLessThanOrEqual(HOLDER_ROWS);
            const section = html.slice(html.indexOf('<section id="holders">'), html.indexOf('<section id="control">'));
            expect(new Set(section.match(BASE58_RUN) ?? []).size).toBeLessThanOrEqual(HOLDER_ROWS);
        }
    });

    it('links to the separate machine-readable record, which round-trips exactly', () => {
        for (const { card, html } of rendered) {
            expect(html).toContain(`<link rel="alternate" type="application/json" href="./${card.slug}.json" />`);
            expect(html).not.toContain('id="card-data"');
            const parsed = JSON.parse(JSON.stringify(publicCard(card)));
            expect(parsed).toEqual(publicCard(card));
            expect(Object.keys(parsed)).toEqual(Object.keys(publicCard(card)));
        }
    });

    it('lists itself in cards/index.json with exactly the five index fields', () => {
        for (const { card } of rendered) {
            expect(Object.keys(indexEntry(card))).toEqual(['slug', 'symbol', 'mint', 'issuer', 'status']);
            expect(indexEntry(card).status).toBe(card.health.status);
        }
    });

    it('rounds every number in the published record to six significant figures', () => {
        for (const { card } of rendered) {
            for (const value of JSON.stringify(publicCard(card)).match(/-?\d+\.\d+/g) ?? []) {
                expect(Number(value)).toBe(Number(Number(value).toPrecision(6)));
            }
        }
    });
});

describe('two builds from the same inputs', () => {
    it('are byte-identical', () => {
        const options = { baseUrl: 'https://rwasonar.com', version: 'v' };
        for (const symbol of REAL_SYMBOLS) {
            expect(renderCard(cardFor(symbol), options)).toBe(renderCard(cardFor(symbol), options));
        }
    });

    it('differ only in the one builtAt stamp when the clock has moved', () => {
        const later = '2026-09-18T09:08:07Z';
        const options = { baseUrl: 'https://rwasonar.com', version: 'v' };
        for (const symbol of REAL_SYMBOLS) {
            const first = renderCard(cardFor(symbol, BUILT_AT), options);
            const second = renderCard(cardFor(symbol, later), options);
            expect(first).not.toBe(second);
            // The HTML carries one visible stamp; the linked JSON record carries its own copy.
            expect(first.split(BUILT_AT).length - 1).toBe(1);
            const normalise = (html, stamp) => html
                .split(stamp).join('STAMP')
                .split(fmt.fmtDateTime(stamp)).join('WHEN');
            expect(normalise(first, BUILT_AT)).toBe(normalise(second, later));
        }
    });
});

/**
 * Evidence chips on a card (stocks/EVIDENCE.md §4). The claim logic is tested once in
 * stocks/evidence.test.js; what is tested here is the card's own promises: only the fields the
 * three issuer-derived sections show can put bytes on a card, a hollow chip costs nothing in the
 * published JSON, the quote is cut visibly rather than silently, and a card stays readable with
 * JavaScript off — no script of ours opens these popovers.
 */
describe('evidence chips on a card', () => {
    const FIXTURE = JSON.parse(fs.readFileSync(
        path.join(__dirname, 'fixtures', 'dossier-claims.sample.json'), 'utf8'
    ));
    const CLAIM_FIELDS = JSON.parse(fs.readFileSync(
        path.join(__dirname, 'data', 'claim-fields.json'), 'utf8'
    )).fields;

    /** The fixture dossier dressed as a built issuer record, the way build-stocks-db.mjs writes it. */
    function fixtureIssuer() {
        const claims = evidenceLib.dossierClaims('fixture', FIXTURE);
        return {
            ...FIXTURE,
            slug: 'fixture',
            name: 'Fixture',
            grades: { claimRung: 1, claimLabel: 'unsecured claim on the issuer' },
            claims,
            evidenceFields: evidenceLib.neededFields(FIXTURE, CLAIM_FIELDS),
            evidence: evidenceLib.evidenceSummary(FIXTURE, claims, CLAIM_FIELDS)
        };
    }

    function fixtureCard() {
        const token = tokenDb.tokens.find((row) => row.symbol === 'TSLAon') ?? tokenDb.tokens[0];
        return buildCard({
            token,
            issuer: fixtureIssuer(),
            holdersItem: holders.get(token.mint) ?? null,
            venuesItem: venues.get(token.mint) ?? null,
            afterhoursItem: null,
            meteoraByPair: meteora,
            pools: null,
            slug: 'FIXTURE',
            builtAt: BUILT_AT,
            sources: SOURCES
        });
    }

    it('carries only the fields the three issuer-derived sections render', () => {
        const ev = cardEvidence(fixtureIssuer());
        for (const field of Object.keys(ev.fields)) expect(CARD_CLAIM_FIELDS).toContain(field);
        // The fixture quotes a finding and products[0]; neither is on a card, so neither is carried.
        expect(ev.fields['findings[0]']).toBeUndefined();
        expect(ev.fields['products[0]']).toBeUndefined();
        expect(ev.fields['redemption.rails'].claims).toHaveLength(1);
    });

    it('takes the coverage numbers from the issuer, so a card cannot disagree with the panel', () => {
        const issuer = fixtureIssuer();
        expect(cardEvidence(issuer).coverage).toEqual(issuer.evidence.coverage);
        expect(cardEvidence(issuer).lastCheckedAt).toBe(issuer.evidence.lastCheckedAt);
    });

    it('retains reviewed and unreviewed inference counts from issuer evidence', () => {
        const issuer = fixtureIssuer();
        issuer.evidence = { ...issuer.evidence, inferenceReviewed: 2, inferenceUnreviewed: 3 };
        expect(cardEvidence(issuer)).toMatchObject({ inferenceReviewed: 2, inferenceUnreviewed: 3 });
    });

    it('cuts a long quote VISIBLY rather than silently', () => {
        const long = 'word '.repeat(80).trim();
        const issuer = {
            ...fixtureIssuer(),
            claims: [{ field: 'legalForm', quote: long, url: 'https://x/tos', status: 'confirmed',
                locator: 'p. 1', accessedAt: '2026-09-18T10:00:00Z', method: 'manual', note: null }]
        };
        const quote = cardEvidence(issuer).fields.legalForm.claims[0].quote;
        expect(quote.length).toBeLessThanOrEqual(QUOTE_MAX + 1);
        expect(quote.endsWith('…')).toBe(true);
    });

    it('renders a chip with the quote and an escaped, safe link', () => {
        const html = renderCard(fixtureCard(), { version: 'test' });
        expect(html).toContain('<details class="ev-chip">');
        expect(html).toContain('USDC or another mutually agreed form of value');
        expect(html).toContain('href="https://fixture.example/tos"');
        expect(html).toContain('rel="nofollow noopener"');
    });

    it('gives a needed-but-unsourced field the hollow chip with its one sentence', () => {
        const html = renderCard(fixtureCard(), { version: 'test' });
        expect(html).toContain(`<span class="ev-none" title="${NO_CLAIM_TEXT}">No source</span>`);
        expect(NO_CLAIM_TEXT).toBe('no source recorded yet');
    });

    it('needs no JavaScript: nothing in card.js opens a chip', () => {
        const js = fs.readFileSync(path.join(REPO_ROOT, 'card.js'), 'utf8');
        expect(js).not.toContain('ev-chip');
        expect(js).not.toContain('ev-pop');
        const css = fs.readFileSync(path.join(REPO_ROOT, 'card.css'), 'utf8');
        const block = css.slice(css.indexOf('/* --- evidence chips'));
        expect(block).toContain('.ev-pop');
        expect(block).not.toContain('!important');
        expect(block).not.toMatch(/#[0-9a-fA-F]{3}\b/);
    });

    it('puts the evidence line in the footer, worded as specified', () => {
        expect(evidenceLine({ coverage: { sourced: 34, needed: 41 }, lastCheckedAt: '2026-09-18T10:22:00Z' }))
            .toBe('Evidence: 34 of 41 fields sourced · last checked 18 Sep 2026 10:22 UTC');
        expect(evidenceLine({ coverage: { sourced: 0, needed: 46 }, lastCheckedAt: null }))
            .toBe('Evidence: 0 of 46 fields sourced · never checked');
        expect(evidenceLine(null)).toBe('');
        const html = renderCard(fixtureCard(), { version: 'test' });
        expect(html).toMatch(/<p class="ev-line">Evidence: \d+ of \d+ fields sourced/);
    });

    it('publishes the evidence SUMMARY only — the claims are rendered above it', () => {
        // 9.3 kB of the widest card was a second copy of the popovers the reader is looking at.
        // The full set is in stocks-issuers.json and /api/issuers/:slug/claims.
        const card = fixtureCard();
        const published = publicCard(card);
        expect(published.evidence.fields).toBeUndefined();
        expect(published.evidence.coverage).toEqual(card.evidence.coverage);
        expect(published.evidence.lastCheckedAt).toBe(card.evidence.lastCheckedAt);
        expect(Object.keys(card.evidence.fields).length).toBeGreaterThan(0);
    });

    it('does not repeat the quote in the summary title that the popover shows', () => {
        const html = renderCard(fixtureCard(), { version: 'test' });
        const chips = [...html.matchAll(/<details class="ev-chip">[\s\S]*?<\/details>/g)]
            .map((m) => m[0]);
        expect(chips.length).toBeGreaterThan(0);
        for (const chip of chips) {
            const title = /<summary class="[^"]*" title="([^"]*)"/.exec(chip)[1];
            expect(title.length).toBeLessThan(30);
            expect(title).not.toContain('“');
        }
        // The source prints as its host, not as the whole URL a second time.
        expect(html).toContain('>fixture.example<');
    });

    it('costs a bounded number of bytes on a REAL fully-sourced issuer', () => {
        // The chips are what moved the ceiling on 2026-09-18, so this is the test that catches them
        // growing again — and it measures the real widest card, not the fixture, because the
        // fixture is only as dense as it was written to be. The numbers are printed rather than
        // just asserted: a silent pass would hide the maximum creeping towards the limit.
        const sourced = issuerDb.issuers
            .filter((i) => (i.evidence?.claims ?? 0) > 0).map((i) => i.slug);
        const widest = tokenDb.tokens
            .filter((t) => sourced.includes(t.issuer))
            .map((t) => ({ symbol: t.symbol, bytes: Buffer.byteLength(
                renderCard(cardFor(t.symbol), { version: 'test' }), 'utf8') }))
            .sort((a, b) => b.bytes - a.bytes)[0] ?? null;
        const fixture = Buffer.byteLength(renderCard(fixtureCard(), { version: 'test' }), 'utf8');
        console.log(`[cards] fixture card ${fixture} B; widest sourced card `
            + `${widest ? `${widest.symbol} ${widest.bytes} B` : 'none yet'}; target ${CARD_BYTE_TARGET}, limit ${CARD_BYTE_LIMIT}`);
        expect(fixture).toBeLessThan(CARD_BYTE_TARGET);
        if (widest !== null) expect(widest.bytes).toBeLessThan(CARD_BYTE_TARGET);
        expect(CARD_BYTE_TARGET).toBe(96 * 1024);
        expect(CARD_BYTE_LIMIT).toBe(112 * 1024);
    });

    it('every issuer-derived card field path is one the dossiers can actually carry', () => {
        // A path nobody can write a claim against would show a hollow chip for ever.
        for (const field of CARD_CLAIM_FIELDS) {
            const reachable = CLAIM_FIELDS.some((pattern) => pattern === field
                || (pattern.includes('*') && field.startsWith(pattern.split('.*')[0])));
            expect({ field, reachable }).toEqual({ field, reachable: true });
        }
    });
});

// --- the fourth authority row (MODEL.md §2.7) -------------------------------------------------

describe('the rebase authority on a card', () => {
    it('is carried on the record and rendered as its own row, with its evidence chip', () => {
        const card = cardFor('TSLAx');
        expect(card.keyGovernance.rebase).toBe('hot-key');
        const html = renderCard(card, { baseUrl: 'https://rwasonar.com' });
        expect(html).toContain('<dt>Rebase-authority governance</dt><dd>Hot key');
        // The row's evidence chip must carry the dossier's own rebase claim, not the delegate one
        // it used to be filed under — that is what the field path on CARD_CLAIM_FIELDS buys.
        expect(CARD_CLAIM_FIELDS).toContain('keyGovernance.rebase');
        expect(cardEvidence(issuers.get('xstocks-backed')).fields['keyGovernance.rebase'].claims.length)
            .toBeGreaterThanOrEqual(1);
        expect(html).toContain('S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS');
    });

    it("renders 'none' rather than an em dash where the extension does not exist", () => {
        // Tessera's three mints are the only ones with no scaledUiAmountConfig at all, and that
        // absence is a fact about the mint — it must not render as a missing value.
        const card = cardFor('tOpenAI');
        expect(card.keyGovernance.rebase).toBe('none');
        expect(renderCard(card, { baseUrl: 'https://rwasonar.com' }))
            .toContain('<dt>Rebase-authority governance</dt><dd>None');
    });

    it('survives the public projection, so the .json record shows it too', () => {
        expect(publicCard(cardFor('TSLAx')).keyGovernance.rebase).toBe('hot-key');
    });
});

// --- the trust chain and the what-if answers (stocks/EVIDENCE.md §6) --------------------------

describe('the trust-chain diagram on a card', () => {
    it('is the record’s own graded chain, copied rather than re-derived', () => {
        const card = cardFor('NVDAx');
        const record = issuers.get('xstocks-backed');
        expect(card.trustChain.nodes).toHaveLength(catalogue.actors.length);
        expect(card.trustChain.links).toHaveLength(catalogue.flows.length);
        // Byte-identical to what the builder wrote into stocks-issuers.json: a card and the issuer
        // panel drawing two differently graded chains would be the worst failure this page has.
        expect(JSON.stringify(card.trustChain)).toBe(JSON.stringify(record.chain));
    });

    it('draws every actor and every flow, with one evidence class and one verification class each', () => {
        const html = renderCard(cardFor('NVDAx'), { version: 'test' });
        expect(html).toContain('<section id="trust-chain">');
        expect(html.match(/class="tc-node[ "]/g)).toHaveLength(catalogue.actors.length);
        expect(html.match(/data-flow="/g).length).toBeGreaterThanOrEqual(catalogue.flows.length);
        // The space matters: `tc-lanes` is the container group, not a lane.
        for (const lane of html.matchAll(/<g class="(tc-lane [^"]*)"/g)) {
            const classes = lane[1].split(' ');
            expect(classes.filter((c) => c.startsWith('tc-ev-'))).toHaveLength(1);
            expect(classes.filter((c) => c.startsWith('tc-vf-'))).toHaveLength(1);
        }
    });

    it('has the legend, so a colour and a line style are never unexplained', () => {
        const html = renderCard(cardFor('NVDAx'), { version: 'test' });
        for (const grade of trustChainSvg.EVIDENCE_GRADES) {
            expect(html).toContain(`tc-key-swatch tc-ev-${grade}`);
        }
        for (const grade of trustChainSvg.VERIFICATION_GRADES) {
            expect(html).toContain(`tc-key-line tc-vf-${grade}`);
        }
    });

    it('names the fields behind each grade but not their values, and links out for them', () => {
        const html = renderCard(cardFor('NVDAx'), { version: 'test' });
        expect(html).toContain('tc-field-path');
        // The values are 9.4 kB of dossier prose; the API serves them. See CARD_BYTE_TARGET.
        expect(html).not.toContain('tc-field-value');
        expect(html).toContain('on the issuer panel');
    });

    it('carries the chain’s shape in the published record, never its prose', () => {
        const record = publicCard(cardFor('NVDAx'));
        expect(record.trustChain.nodes).toHaveLength(catalogue.actors.length);
        expect(record.trustChain.links[0]).toEqual({
            flow: expect.any(String), evidence: expect.any(String), verification: expect.any(String)
        });
        // No field values, no summaries: they are rendered above and served by the API.
        expect(JSON.stringify(record.trustChain)).not.toContain('claimStatus');
        expect(JSON.stringify(record.trustChain)).not.toContain('summary');
    });

    it('says so, rather than drawing an empty frame, when the issuer has no chain', () => {
        const token = tokenDb.tokens.find((row) => row.symbol === 'NVDAx');
        const card = buildCard({
            token, issuer: null, slug: 'test', builtAt: BUILT_AT, sources: SOURCES, catalogue
        });
        expect(card.trustChain).toBeNull();
        expect(renderCard(card, { version: 'test' })).toContain('No trust chain has been built');
    });
});

describe('the what-if answers on a card', () => {
    const MODES = catalogue.failureModes.length;

    it('asks all 38 questions of every issuer, whatever has been answered', () => {
        for (const symbol of ['NVDAx', 'GLXY', 'SPACEX']) {
            const card = cardFor(symbol);
            expect(card.whatIf.answers).toHaveLength(MODES);
            expect(card.whatIf.answers.map((a) => a.mode))
                .toEqual(catalogue.failureModes.map((m) => m.id));
        }
    });

    it('counts the six statuses, and they add up to the catalogue’s own mode count', () => {
        const counts = cardFor('NVDAx').whatIf.counts;
        expect(Object.keys(counts).sort()).toEqual([
            'documented', 'inferred', 'litigated', 'missing', 'not-applicable', 'unknown'
        ]);
        expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(MODES);
    });

    it('groups the answers by actor in the catalogue’s order, not the question order', () => {
        const html = renderCard(cardFor('NVDAx'), { version: 'test' });
        const heads = [...html.matchAll(/<h5 class="wi-actor-head">([^<]+)<\/h5>/g)].map((m) => m[1]);
        const labels = catalogue.actors.map((actor) => actor.label);
        const seen = heads.filter((head) => labels.includes(head));
        expect(seen.length).toBeGreaterThan(3);
        // The catalogue asks about `law` at mode 16 and again at 36; one group, in actor order.
        expect(new Set(seen).size).toBe(seen.length);
        expect(seen).toEqual(labels.filter((label) => seen.includes(label)));
    });

    it('prints the counts line as counts of what it shows', () => {
        const card = cardFor('NVDAx');
        const html = renderCard(card, { version: 'test' });
        for (const [status, n] of Object.entries(card.whatIf.counts)) {
            if (n === 0) continue;
            expect(html).toContain(`<span class="wi-count-n">${n}</span> ${whatIfLib.STATUS_SHORT[status]}`);
        }
        // A status with nothing under it is left out rather than printed as a zero.
        const zero = Object.entries(card.whatIf.counts).find(([, n]) => n === 0);
        if (zero !== undefined) {
            expect(html).not.toContain(`<span class="wi-count-n">0</span> ${whatIfLib.STATUS_SHORT[zero[0]]}`);
        }
    });

    it('carries the outcome, the status and the source, and NOT the quote or the search record', () => {
        const card = cardFor('NVDAx');
        const answered = card.whatIf.answers.find((a) => a.status === 'documented');
        expect(answered.outcome).not.toBeNull();
        expect(answered.url).not.toBeNull();
        // The three things the byte policy bought (see CARD_BYTE_TARGET): they are on the panel.
        expect(answered.quote).toBeNull();
        expect(answered.note).toBeNull();
        expect(answered.searched).toEqual([]);
        const html = renderCard(card, { version: 'test' });
        expect(html).not.toContain('wi-quote');
        expect(html).not.toContain('Where we looked');
        expect(html).toContain('Full answers, with the quotes');
    });

    it('cuts the outcome visibly and never mid-word', () => {
        const card = cardFor('NVDAx');
        for (const answer of card.whatIf.answers) {
            if (answer.outcome === null) continue;
            expect(answer.outcome.length).toBeLessThanOrEqual(OUTCOME_MAX + 1);
        }
        expect(card.whatIf.answers.some((a) => a.outcome !== null && a.outcome.endsWith('…'))).toBe(true);
    });

    it('cites one numbered source list instead of repeating a URL on every row', () => {
        const html = renderCard(cardFor('NVDAx'), { version: 'test' });
        const section = html.slice(html.indexOf('<section id="what-if">'), html.indexOf('<section id="rules">'));
        expect(section).toContain('<ol class="wi-sources">');
        const refs = [...section.matchAll(/class="wi-ref" href="#wi-src-(\d+)"/g)].map((m) => Number(m[1]));
        const entries = [...section.matchAll(/<li id="wi-src-(\d+)"/g)].map((m) => Number(m[1]));
        expect(refs.length).toBeGreaterThan(5);
        // Far fewer distinct documents than answers, which is the whole saving.
        expect(entries.length).toBeLessThan(refs.length);
        for (const ref of refs) expect(entries).toContain(ref);
    });

    it('draws a question nobody has answered as a gap, and says it is one', () => {
        const token = tokenDb.tokens.find((row) => row.symbol === 'NVDAx');
        const card = buildCard({
            token,
            issuer: issuers.get('xstocks-backed'),
            slug: 'test',
            builtAt: BUILT_AT,
            sources: SOURCES,
            catalogue,
            whatIf: []
        });
        expect(card.whatIf.counts.missing).toBe(MODES);
        const html = renderCard(card, { version: 'test' });
        expect(html.match(/wi-badge wi-s-missing/g)).toHaveLength(MODES);
        expect(html).toContain('Not answered yet for this issuer');
        // And never softened into the one status that would read as "nothing to answer".
        expect(html).not.toContain('wi-badge wi-s-not-applicable');
    });

    it('carries the counts in the published record, never the answers', () => {
        const record = publicCard(cardFor('NVDAx'));
        expect(record.whatIf.counts).toEqual(cardFor('NVDAx').whatIf.counts);
        expect(record.whatIf.version).toBe(catalogue.version);
        expect(record.whatIf.answers).toBeUndefined();
    });

    it('offers the archived copy of a source when the registry has one', () => {
        const token = tokenDb.tokens.find((row) => row.symbol === 'NVDAx');
        const answers = whatIfBySlug.get('xstocks-backed') ?? [];
        const withUrl = answers.find((entry) => typeof entry.url === 'string');
        const card = buildCard({
            token,
            issuer: issuers.get('xstocks-backed'),
            slug: 'test',
            builtAt: BUILT_AT,
            sources: SOURCES,
            catalogue,
            whatIf: answers,
            archives: { [withUrl.url]: 'https://web.archive.org/web/2026/test' }
        });
        expect(renderCard(card, { version: 'test' })).toContain('https://web.archive.org/web/2026/test');
    });

    it('says the catalogue did not load rather than claiming the questions are answered', () => {
        const token = tokenDb.tokens.find((row) => row.symbol === 'NVDAx');
        const card = buildCard({
            token, issuer: issuers.get('xstocks-backed'), slug: 'test', builtAt: BUILT_AT, sources: SOURCES
        });
        expect(card.whatIf).toBeNull();
        expect(renderCard(card, { version: 'test' })).toContain('catalogue did not load at build time');
    });
});

/**
 * The change judge's material verdicts on a card (stocks/EVIDENCE.md §2.3): shown only when one
 * concerns the token, always headed as a model assessment, linked to the change feed where each
 * reading sits beside its diff, and a pure function of the verdict export (never the clock).
 */
describe('model-assessed material changes on a card', () => {
    const token = tokenDb.tokens.find((row) => row.symbol === 'NVDAx');
    const AS_OF = '2026-09-23T12:00:00Z';
    const row = (overrides = {}) => ({
        id: '139', detectedAt: '2026-09-22T16:47:12Z', kind: 'legal-term', severity: 'caution',
        summary: `${token.issuer}:sources[6]: +1 -1 line(s) · keywords: fee`, subjectType: 'source', subjectId: 'abc',
        issuerSlug: token.issuer, judgmentId: '52', representative: true, material: true,
        assessmentSeverity: 'caution', assessmentSummary: 'A redemption fee now applies to every holder.', ...overrides
    });
    const exportOf = (...items) => ({ asOf: AS_OF, items });

    it('is absent from a card with no material verdict, and from every card built without the export', () => {
        const none = renderCard(cardFor('NVDAx'), { version: 'v' });
        expect(none).not.toContain('model-changes');
        expect(none).not.toContain(MATERIAL_CHANGE_TITLE);
        expect(publicCard(cardFor('NVDAx')).materialChanges).toBeNull();
        for (const items of [[row({ material: false })], [row({ issuerSlug: 'someone-else' })],
            [row({ detectedAt: '2026-07-01T00:00:00Z' })], [row({ detectedAt: '2026-09-24T00:00:00Z' })],
            [row({ assessmentSummary: '' })], []]) {
            const card = cardFor('NVDAx', BUILT_AT, exportOf(...items));
            expect(card.materialChanges).toBeNull();
            expect(renderCard(card, { version: 'v' })).not.toContain('model-changes');
        }
    });

    it('is present with a material verdict, labelled as a model assessment and linked to the filtered feed', () => {
        const card = cardFor('NVDAx', BUILT_AT, exportOf(row()));
        const html = renderCard(card, { version: 'v' });
        expect(MATERIAL_CHANGE_TITLE).toContain('model assessment');
        expect(html).toContain(`<strong>${MATERIAL_CHANGE_TITLE}</strong>`);
        expect(html).toContain('A redemption fee now applies to every holder.');
        expect(html).toContain('not a legal conclusion');
        expect(html).toContain(`../watch.html?type=issuer&amp;issuerSlug=${encodeURIComponent(token.issuer)}&amp;material=true`);
        expect(publicCard(card).materialChanges).toEqual({ basis: 'model assessment', asOf: AS_OF, windowDays: 30, count: 1, ids: ['139'] });
    });

    it('matches an event on the token itself, whatever issuer it names', () => {
        const card = cardFor('NVDAx', BUILT_AT, exportOf(row({ issuerSlug: null, subjectType: 'token', subjectId: token.mint })));
        expect(card.materialChanges.count).toBe(1);
    });

    it('counts one change once, shown by the event the judge read', () => {
        const quoteLost = row({ id: '140', detectedAt: '2026-09-22T16:47:29Z', kind: 'quote-lost', representative: false,
            summary: 'quoted words lost' });
        const block = cardMaterialChanges([quoteLost, row()], token, { asOf: AS_OF });
        expect(block.count).toBe(1);
        expect(block.items[0].id).toBe('139');
        expect(cardMaterialChanges([row(), quoteLost], token, { asOf: AS_OF })).toEqual(block);
    });

    it('names at most two, newest first, and still counts the rest', () => {
        const items = [1, 2, 3].map((n) => row({ id: String(n), judgmentId: String(n), detectedAt: `2026-09-2${n - 1}T00:00:00Z` }));
        const block = cardMaterialChanges(items, token, { asOf: AS_OF });
        expect(block.count).toBe(3);
        expect(block.items.map((item) => item.id)).toEqual(['3', '2']);
    });

    it('rebuilds byte-identically from the same export, and the builtAt stamp does not move the window', () => {
        const options = { baseUrl: 'https://rwasonar.com', version: 'v' };
        const first = renderCard(cardFor('NVDAx', BUILT_AT, exportOf(row())), options);
        expect(renderCard(cardFor('NVDAx', BUILT_AT, exportOf(row())), options)).toBe(first);
        const later = renderCard(cardFor('NVDAx', '2026-12-01T00:00:00Z', exportOf(row())), options);
        expect(later).toContain('A redemption fee now applies to every holder.');
    });

    it('costs well under a kilobyte, so the widest card stays inside its hard limit', () => {
        const long = 'x '.repeat(400);
        const items = [1, 2, 3].map((n) => row({ id: String(n), judgmentId: String(n), summary: long, assessmentSummary: long }));
        const bare = Buffer.byteLength(renderCard(cardFor('QQQx'), { version: 'v' }), 'utf8');
        const withBlock = Buffer.byteLength(renderCard(cardFor('QQQx', BUILT_AT, exportOf(...items)), { version: 'v' }), 'utf8');
        expect(withBlock - bare).toBeLessThan(1024);
        expect(withBlock).toBeLessThanOrEqual(CARD_BYTE_LIMIT);
    });
});
