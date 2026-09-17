// Unit tests for the per-token stock cards (lib/cards.mjs) and the promise the cards make: the slug
// rules hold over the REAL 441 symbols, a card carries all ten health rules, it never turns into a
// wallet dump, it stays inside its byte budget, its inlined JSON is exactly its .json record, and
// two builds from the same inputs differ only in the one `builtAt` stamp. The real built files are
// read, so a shape drift in any of the seven inputs fails here rather than on a shared card.

const fs = require('node:fs');
const path = require('node:path');

const {
    CARD_BYTE_BUDGET,
    CARD_CLAIM_FIELDS,
    NO_CLAIM_TEXT,
    OG_DESCRIPTION_MAX,
    HOLDER_ROWS,
    QUOTE_MAX,
    assignSlugs,
    buildCard,
    cardEvidence,
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
const fmt = require('./lib/fmt.js');

const REPO_ROOT = path.join(__dirname, '..');
const read = (...parts) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ...parts), 'utf8'));

const tokenDb = read('stocks-tokens.json');
const issuerDb = read('stocks-issuers.json');
const holderDb = read('stocks', 'data', 'holders.json');
const venueDb = read('stocks', 'data', 'venues.json');
const tradeDb = read('stocks-trades.json');
const afterhoursDb = read('stocks-afterhours.json');
const meteoraDb = read('stocks', 'data', 'meteora.json');

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
    meteora: meteoraDb.fetchedAt
};

const BUILT_AT = '2026-09-17T01:02:03Z';
const SLUGS = assignSlugs(tokenDb.tokens);

function cardFor(symbol, builtAt = BUILT_AT) {
    const token = tokenDb.tokens.find((row) => row.symbol === symbol);
    if (token === undefined) throw new Error(`no token with symbol ${symbol} in stocks-tokens.json`);
    return buildCard({
        token,
        issuer: issuers.get(token.issuer) ?? null,
        holdersItem: holders.get(token.mint) ?? null,
        venuesItem: venues.get(token.mint) ?? null,
        afterhoursItem: afterhours.get(token.mint) ?? null,
        meteoraByPair: meteora,
        pools: pools.get(token.mint) ?? null,
        slug: SLUGS.get(token.mint),
        builtAt,
        sources: SOURCES
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
     * The stocks page computes a row's card link with fmt.cardSlug alone, because fetching
     * cards/index.json to render a table would be absurd. That is only correct while no two symbols
     * collide — the day one does, this goes red and the link must switch to reading the index.
     */
    it('agrees with the slug the stocks page computes for every token', () => {
        for (const token of tokenDb.tokens) {
            expect(SLUGS.get(token.mint)).toBe(fmt.cardSlug(token.symbol, token.mint));
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

    it('renders every one of the ten health rules with its label, threshold, inputs and note', () => {
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

    it('renders all eleven sections in the order a reader needs them', () => {
        const order = ['own', 'reference', 'afterhours', 'depth', 'holders', 'control',
            'verification', 'venues', 'issuer-api', 'rules'];
        const prestocks = renderCard(cardFor('SPACEX'), { baseUrl: null, version: 'v' });
        let cursor = -1;
        for (const id of order) {
            const at = prestocks.indexOf(`<section id="${id}">`);
            expect(at).toBeGreaterThan(cursor);
            cursor = at;
        }
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

    it('is a complete page with the shared assets and the noindex the other pages carry', () => {
        expect(html.startsWith('<!doctype html>')).toBe(true);
        expect(html).toContain('<meta name="robots" content="noindex');
        expect(html).toContain('<link rel="stylesheet" href="../card.css?v=20260917a" />');
        expect(html).toContain('<script src="../card.js?v=20260917a"></script>');
        expect(html).toContain('<meta name="twitter:card" content="summary" />');
        for (const page of ['../stocks.html', '../graph.html', '../live.html', '../monitor.html']) {
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
            expect(Buffer.byteLength(html, 'utf8')).toBeLessThanOrEqual(CARD_BYTE_BUDGET);
            expect(card.slug.length).toBeGreaterThan(0);
        }
    });

    it('never shows more than five wallet addresses', () => {
        for (const { card, html } of rendered) {
            expect(walletsIn(card, html).length).toBeLessThanOrEqual(HOLDER_ROWS);
            const section = html.slice(html.indexOf('<section id="holders">'), html.indexOf('<section id="control">'));
            expect(new Set(section.match(BASE58_RUN) ?? []).size).toBeLessThanOrEqual(HOLDER_ROWS);
        }
    });

    it('inlines exactly the record the .json file carries, and it round-trips', () => {
        for (const { card, html } of rendered) {
            const inline = html.match(/<script type="application\/json" id="card-data">([\s\S]*?)<\/script>/);
            expect(inline).not.toBeNull();
            const parsed = JSON.parse(inline[1]);
            expect(parsed).toEqual(publicCard(card));
            expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
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
            // The stamp is allowed in exactly two places: one <time datetime> and the record.
            expect(first.split(BUILT_AT).length - 1).toBe(2);
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
 * inlined JSON, the quote is cut visibly rather than silently, and a card stays readable with
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
        expect(html).toContain(`<span class="ev-none" title="${NO_CLAIM_TEXT}">§?</span>`);
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

    it('inlines the evidence SUMMARY only — the claims are rendered above it', () => {
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
            + `${widest ? `${widest.symbol} ${widest.bytes} B` : 'none yet'} of ${CARD_BYTE_BUDGET}`);
        expect(fixture).toBeLessThan(CARD_BYTE_BUDGET);
        if (widest !== null) expect(widest.bytes).toBeLessThan(CARD_BYTE_BUDGET);
        expect(CARD_BYTE_BUDGET).toBe(34 * 1024);
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
        expect(html).toContain('<dt>Rebase authority</dt><dd>Hot key');
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
            .toContain('<dt>Rebase authority</dt><dd>None');
    });

    it('survives the public projection, so the .json record shows it too', () => {
        expect(publicCard(cardFor('TSLAx')).keyGovernance.rebase).toBe('hot-key');
    });
});
