// Tests the universe view's data: which shared values (moons) a token has (tokenMoons), the tables the
// builder writes (stocks/lib/universe-view.mjs), the lookups and group-by over them (tableIndex), and
// the orbit layout (stocks/lib/universe-view-model.js). The scene (universe.js) only draws these.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import model from './lib/universe-view-model.js';
import { buildUniverseIndex, keyInfoFromPowerMap } from './lib/universe-view.mjs';

const ROOT = join(import.meta.dirname, '..');
const RIGHTS_DOC = JSON.parse(readFileSync(join(ROOT, 'stocks/data/holder-rights.json'), 'utf8'));
const TEMPLATES_DOC = JSON.parse(readFileSync(join(ROOT, 'stocks/data/composability-templates.json'), 'utf8'));

const POWER_MAP = { issuers: [{ slug: 'xstocks-backed', cells: [
    { power: 'freeze', kind: 'multisig', signerThreshold: null, addresses: { shown: [{ address: 'FREEZEKEY11111111' }] } },
    { power: 'pause', kind: 'multisig', signerThreshold: '2 of 4', timelock: { phrase: 'zero execution timelock' }, addresses: { shown: [{ address: 'FREEZEKEY11111111' }] } },
    { power: 'mint', kind: 'single-key', signerThreshold: null, addresses: { shown: [{ address: 'MINTKEY1111111111' }] } }
] }] };

/** A card shaped like cards/<slug>.json, trimmed to the fields tokenMoons reads. */
function card(slug, overrides = {}) {
    return {
        slug, symbol: slug, underlyingTicker: 'AAPL', issuer: { slug: 'xstocks-backed', name: 'Kraken xStocks' },
        ownership: { claimRung: 2, claimLabel: 'secured claim on collateral', legalForm: 'tracker-certificate', transferRestrictions: { allowlist: false } },
        verification: { type: 'chainlink-por', label: 'on-chain PoR', strength: 4 },
        trustChain: { nodes: [{ actor: 'custodian', parties: ['InCore Bank AG', 'Alpaca Securities'] }, { actor: 'attestor', parties: ['Chainlink'] }, { actor: 'law', parties: ['Jersey'] }] },
        control: { mintAuthority: 'MINTKEY1111111111', freezeAuthority: 'FREEZEKEY11111111', permanentDelegate: 'DELEGATEKEY111111', allowlist: false, transferFeeBps: null },
        keyGovernance: { mint: 'hot-key', freeze: 'multisig', delegate: 'multisig' },
        defiUsage: { integrations: [{ protocolId: 'kamino', protocolName: 'Kamino', actions: ['collateral', 'borrow'], metrics: { liquidationLtvMin: 0.5, sizeUsd: 454210 } }] },
        closedMarket: { lenders: [{ protocolId: 'nest', protocolName: 'Nest', labelKind: 'token-24x7', label: '24/7 token price', liquidationLtvPct: 60, sentence: 'Valued at the token’s own 24/7 price.' }] },
        health: { levels: { token: { status: 'good' } }, rules: [{ id: 'tracking', status: 'good' }, { id: 'concentration', status: 'warning' }, { id: 'keyControl', status: 'caution' }] },
        composability: { id: 'tpl' },
        ...overrides
    };
}

const TOKENS_DOC = { builtAt: '2026-09-25T06:00:00Z', tokens: [
    { mint: 'M1', symbol: 'AAPLx', name: 'Apple xStock', underlyingTicker: 'AAPL', issuer: 'xstocks-backed', market: { usdPrice: 336, liquidity: 546200 } },
    { mint: 'M2', symbol: 'AAPLon', name: 'Apple (Ondo)', underlyingTicker: 'AAPL', issuer: 'ondo-global-markets', market: { liquidity: 987 } },
    { mint: 'M3', symbol: 'NVDAx', name: 'NVIDIA xStock', underlyingTicker: 'NVDA', issuer: 'xstocks-backed', market: { liquidity: 2166017 } },
    { mint: 'M4', symbol: 'DEADx', issuer: 'xstocks-backed', market: {} },
    { mint: 'M5', symbol: 'NOCARD', issuer: 'xstocks-backed', market: { liquidity: 9e9 } }
] };
const ISSUERS_DOC = { issuers: [
    { slug: 'xstocks-backed', name: 'Kraken xStocks', entityJurisdiction: 'Jersey (Channel Islands)', issuingEntity: 'Backed Assets (JE) Limited' },
    { slug: 'ondo-global-markets', name: 'Ondo Global Markets', entityJurisdiction: 'British Virgin Islands' }
] };
const CARD_INDEX = [{ slug: 'AAPLx', mint: 'M1' }, { slug: 'AAPLon', mint: 'M2' }, { slug: 'NVDAx', mint: 'M3' }, { slug: 'DEADx', mint: 'M4' }];
const CARDS = new Map([
    ['AAPLx', card('AAPLx')],
    ['AAPLon', card('AAPLon', {
        issuer: { slug: 'ondo-global-markets' }, ownership: { claimRung: 2, claimLabel: 'secured claim on collateral', legalForm: 'structured-note' },
        trustChain: { nodes: [{ actor: 'custodian', parties: ['Alpaca Securities'] }] }, defiUsage: { integrations: [] }, closedMarket: { lenders: [] },
        control: { mintAuthority: 'ONDOMINT11111111', freezeAuthority: null, permanentDelegate: null }, keyGovernance: { mint: 'program' },
        health: { rules: [{ id: 'liquidity', status: 'warning' }] }
    })],
    ['NVDAx', card('NVDAx', { underlyingTicker: 'NVDA', closedMarket: { lenders: [] } })],
    ['DEADx', card('DEADx', { underlyingTicker: null, defiUsage: {}, closedMarket: {}, trustChain: {}, health: {} })]
]);
const DATA = buildUniverseIndex({
    tokensDoc: TOKENS_DOC, issuersDoc: ISSUERS_DOC, rightsDoc: RIGHTS_DOC, templatesDoc: TEMPLATES_DOC, powerMap: POWER_MAP,
    cardIndex: CARD_INDEX, cards: CARDS, generatedAt: '2026-09-26T06:00:00Z'
});
const IX = model.tableIndex(DATA);
const tokenOf = (symbol) => IX.tokens.findIndex((t) => t.symbol === symbol);
const valuesOf = (symbol) => IX.byToken[tokenOf(symbol)].map((v) => IX.values[v].id);

describe('which moons a token has', () => {
    const moons = model.tokenMoons(CARDS.get('AAPLx'), {
        planet: { symbol: 'AAPLx' }, issuer: DATA.issuers.find((i) => i.slug === 'xstocks-backed'), keyInfo: keyInfoFromPowerMap(POWER_MAP)
    });
    const byId = new Map(moons.map((m) => [m.id, m]));

    it('names each shared thing by attribute and value, so the same custodian or key on two tokens is one moon', () => {
        for (const id of ['stock:AAPL', 'issuer:xstocks-backed', 'form:tracker-certificate', 'claim:2', 'jurisdiction:Jersey (Channel Islands)',
            'verification:chainlink-por', 'custodian:InCore Bank AG', 'custodian:Alpaca Securities', 'attestor:Chainlink',
            'key:MINTKEY1111111111', 'key:FREEZEKEY11111111', 'key:DELEGATEKEY111111', 'defi:kamino', 'defi:nest', 'health:concentration:warning']) {
            expect(byId.has(id)).toBe(true);
        }
        // A passing check is not a warning moon; the law is not a custodian.
        expect(byId.has('health:tracking:good')).toBe(false);
        expect([...byId.keys()].some((id) => id.includes('Jersey') && !id.startsWith('jurisdiction:'))).toBe(false);
        for (const moon of moons) expect(model.ATTRIBUTES.map((a) => a.id)).toContain(moon.attribute);
    });

    it('gives every shareholder right one moon per status, so "Voting: yours" gathers every token that votes', () => {
        const rights = moons.filter((m) => m.dimension === 'rights');
        expect(rights.map((m) => m.attribute)).toEqual(['right-dividends', 'right-voting', 'right-information', 'right-splits', 'right-takeovers']);
        const voting = rights.find((m) => m.attribute === 'right-voting');
        expect(voting.id).toBe(`right-voting:${RIGHTS_DOC.issuers['xstocks-backed'].voting.status}`);
    });

    it('merges what the power map says about an address under several powers, whichever power comes first', () => {
        const reversed = { issuers: [{ cells: [...POWER_MAP.issuers[0].cells].reverse() }] };
        for (const map of [POWER_MAP, reversed]) {
            expect(keyInfoFromPowerMap(map).get('FREEZEKEY11111111')).toEqual({ kind: 'multisig', threshold: '2 of 4', timelock: 'zero execution timelock' });
        }
    });

    it('labels a key by who holds it, merging what the power map knows, and says what it can do to this token', () => {
        expect(byId.get('key:FREEZEKEY11111111')).toMatchObject({ label: '2-of-4 multisig FREE…1111', tone: 'caution' });
        expect(byId.get('key:FREEZEKEY11111111').relation.details).toContainEqual(['Time lock', 'zero execution timelock']);
        expect(byId.get('key:MINTKEY1111111111')).toMatchObject({ label: 'One key MINT…1111', tone: 'warning' });
        expect(byId.get('key:MINTKEY1111111111').relation.summary).toBe('On AAPLx it can mint.');
        expect(byId.get('key:DELEGATEKEY111111').relation.summary).toBe('On AAPLx it can move or burn.');
    });

    it('keeps what a protocol does with this token as the relation, not the moon', () => {
        expect(byId.get('defi:kamino').relation.summary).toBe('Takes AAPLx for collateral, borrow.');
        expect(byId.get('defi:kamino').relation.details).toContainEqual(['Liquidation at', '50%']);
        expect(byId.get('defi:nest').relation.summary).toContain('24/7 token price');
    });

    it('never prints a missing value as text', () => {
        const sparse = model.tokenMoons(CARDS.get('DEADx'), { planet: { symbol: 'DEADx' } });
        for (const moon of [...moons, ...sparse]) {
            expect(JSON.stringify([moon.label, moon.relation])).not.toMatch(/\bnull\b|undefined|NaN/);
        }
    });
});

describe('the tables', () => {
    it('lists tokens with a card, biggest pool first, a missing pool last and never as zero', () => {
        expect(IX.tokens.map((t) => t.symbol)).toEqual(['NVDAx', 'AAPLx', 'AAPLon', 'DEADx']);
        expect(IX.tokens[3].liquidityUsd).toBeNull();
        expect(DATA.tables.tokens.columns).toContain('liquidityUsd');
    });

    it('stores each shared value once, tagged with its attribute, and links it to every token that has it', () => {
        const ids = IX.values.map((v) => v.id);
        expect(new Set(ids).size).toBe(ids.length);
        const alpaca = IX.valueById.get('custodian:Alpaca Securities');
        expect(IX.values[alpaca].attribute).toBe('custodian');
        expect(IX.byValue[alpaca].map((t) => IX.tokens[t].symbol)).toEqual(['NVDAx', 'AAPLx', 'AAPLon']);
        // The links read the same both ways.
        IX.byToken.forEach((list, t) => list.forEach((v) => expect(IX.byValue[v]).toContain(t)));
    });

    it('refuses to build from missing inputs instead of writing an empty universe', () => {
        expect(() => buildUniverseIndex({ tokensDoc: {}, cardIndex: CARD_INDEX, cards: CARDS })).toThrow('no tokens array');
        expect(() => buildUniverseIndex({ tokensDoc: TOKENS_DOC, cardIndex: null, cards: CARDS })).toThrow('cards/index.json');
        expect(() => buildUniverseIndex({ tokensDoc: TOKENS_DOC, cardIndex: CARD_INDEX, cards: null })).toThrow('cards were not read');
        expect(() => model.tableIndex({ tables: { ...DATA.tables, tokenValues: { columns: ['token', 'value'], rows: [[99, 0]] } } })).toThrow('outside the tables');
    });
});

describe('grouping on any attribute', () => {
    const all = IX.tokensWhere([]);

    it('groups every token on any attribute, largest group first, with the tokens that have no value kept apart', () => {
        const byIssuer = IX.groupBy(all, 'issuer');
        expect(byIssuer.groups.map((g) => IX.values[g.value].label)).toEqual(['Kraken xStocks', 'Ondo Global Markets']);
        expect(byIssuer.groups[0].tokens.map((t) => IX.tokens[t].symbol)).toEqual(['NVDAx', 'AAPLx', 'DEADx']);
        const byProtocol = IX.groupBy(all, 'defi');
        expect(byProtocol.none.map((t) => IX.tokens[t].symbol)).toEqual(['AAPLon', 'DEADx']);
        for (const attribute of model.ATTRIBUTES) {
            const { groups, none } = IX.groupBy(all, attribute.id);
            const covered = new Set([...groups.flatMap((g) => g.tokens), ...none]);
            expect(covered.size).toBe(all.length);
        }
    });

    it('narrows to the tokens sharing several values, and groups that set again', () => {
        const kamino = IX.valueById.get('defi:kamino');
        const alpaca = IX.valueById.get('custodian:Alpaca Securities');
        const xstocks = IX.valueById.get('issuer:xstocks-backed');
        const ondo = IX.valueById.get('issuer:ondo-global-markets');
        expect(IX.tokensWhere([alpaca]).map((t) => IX.tokens[t].symbol)).toEqual(['NVDAx', 'AAPLx', 'AAPLon']);
        expect(IX.tokensWhere([alpaca, xstocks]).map((t) => IX.tokens[t].symbol)).toEqual(['NVDAx', 'AAPLx']);
        expect(IX.tokensWhere([alpaca, ondo]).map((t) => IX.tokens[t].symbol)).toEqual(['AAPLon']);
        expect(IX.tokensWhere([kamino, ondo])).toEqual([]);
        const stocks = IX.groupBy(IX.tokensWhere([kamino]), 'stock');
        expect(stocks.groups.map((g) => IX.values[g.value].label)).toEqual(['AAPL', 'NVDA']);
    });

    it('draws only what a token shares: a value only it has is listed, not orbited', () => {
        const aaplx = IX.sharedValues(tokenOf('AAPLx'));
        const ids = (list) => list.map((v) => IX.values[v].id);
        expect(ids(aaplx.shared)).toContain('stock:AAPL');
        expect(ids(aaplx.shared)).toContain('key:MINTKEY1111111111');
        expect(ids(aaplx.single)).toEqual(['defi:nest']); // only AAPLx is taken by Nest here
        const nvdax = IX.sharedValues(tokenOf('NVDAx'));
        expect(ids(nvdax.single)).toEqual(['stock:NVDA']);
        expect(ids(nvdax.shared)).not.toContain('stock:NVDA');
        const aaplon = IX.sharedValues(tokenOf('AAPLon'));
        expect(ids(aaplon.single)).toEqual(expect.arrayContaining(['issuer:ondo-global-markets', 'key:ONDOMINT11111111', 'health:liquidity:warning']));
        // Every value lands on exactly one side.
        for (let t = 0; t < IX.tokens.length; t += 1) {
            const { shared, single } = IX.sharedValues(t);
            expect([...shared, ...single].sort((a, b) => a - b)).toEqual([...IX.byToken[t]].sort((a, b) => a - b));
        }
    });

    it('draws only groups of two or more tokens; a group of one is listed and opens its token', () => {
        const { groups, none } = IX.groupBy(IX.tokensWhere([]), 'stock');
        const { multi, single } = model.splitSingles(groups);
        expect(multi.map((g) => IX.values[g.value].label)).toEqual(['AAPL']);
        expect(single.map((g) => IX.values[g.value].label)).toEqual(['NVDA']);
        expect(none.map((t) => IX.tokens[t].symbol)).toEqual(['DEADx']);
        expect(model.splitSingles(null)).toEqual({ multi: [], single: [] });
    });

    it('puts two wrappers of one stock on the same moon', () => {
        expect(valuesOf('AAPLx')).toContain('stock:AAPL');
        expect(valuesOf('AAPLon')).toContain('stock:AAPL');
        expect(IX.byValue[IX.valueById.get('stock:AAPL')].length).toBe(2);
    });
});

describe('sizes and orbits', () => {
    it('sizes planets by liquidity on a log scale, with a floor for tokens with no measured pool', () => {
        const sizes = [null, undefined, NaN, -5, 0, 1e3, 1e5, 1e7, 1e12].map(model.planetRadius);
        for (const size of sizes) expect(Number.isFinite(size)).toBe(true);
        expect(sizes.slice(0, 5)).toEqual([0.35, 0.35, 0.35, 0.35, 0.35]);
        expect(sizes[5]).toBeLessThan(sizes[6]);
        expect(sizes[6]).toBeLessThan(sizes[7]);
        expect(sizes[8]).toBeLessThan(2);
    });

    it('puts a planet’s moons on one ring per dimension, inner to outer, with no two moons touching', () => {
        const moons = model.tokenMoons(CARDS.get('AAPLx'), { issuer: DATA.issuers[0] });
        const { size, rings } = model.moonRings(moons, 1.2);
        const order = model.DIMENSIONS.map((d) => d.id);
        expect(rings.map((r) => order.indexOf(r.dimension))).toEqual([...rings.map((r) => order.indexOf(r.dimension))].sort((a, b) => a - b));
        expect(rings[0].radius - size).toBeGreaterThan(1.2);
        for (let i = 1; i < rings.length; i += 1) expect(rings[i].radius - rings[i - 1].radius).toBeGreaterThan(size * 2);
        for (const ring of rings) {
            const chord = 2 * ring.radius * Math.sin(Math.PI / Math.max(2, ring.orbits.length));
            if (ring.orbits.length > 1) expect(chord).toBeGreaterThan(size * 2);
        }
        expect(rings.flatMap((r) => r.orbits).length).toBe(moons.length);
    });

    it('rings planets round any centre further out by rank, clear of the centre, in the same place every visit', () => {
        const first = model.planetOrbit(0, 'AAPLx', 1);
        expect(first.radius - 1.8).toBeGreaterThan(1);
        expect(model.planetOrbit(3, 'AAPLx', 5).radius).toBeGreaterThan(model.planetOrbit(2, 'AAPLx', 5).radius);
        expect(model.planetOrbit(3, 'AAPLx', 5)).toEqual(model.planetOrbit(3, 'AAPLx', 5));
        const { shown, rest } = model.splitForView([0, 1, 2, 3], 3);
        expect(shown).toEqual([0, 1, 2]);
        expect(rest).toEqual([3]);
    });

    it('stands the camera back far enough, and further on a phone held upright', () => {
        expect(model.frameDistance(1, 10)).toBeGreaterThan(20);
        expect(model.frameDistance(1, 10, 0.5)).toBeCloseTo(model.frameDistance(1, 10) * 2, 9);
    });

    it('gives every issuer programme its own colour', () => {
        const colors = Object.keys(model.ISSUER_COLORS).map((slug) => model.issuerColor([], slug));
        expect(new Set(colors).size).toBe(colors.length);
    });
});
