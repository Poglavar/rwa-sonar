// Unit tests for the pure parts of build-graph.mjs (MODEL.md §10.4): how a canonical name becomes
// a node id, which edge each `parties` role produces and which way it points, how venues.json is
// aggregated per programme, and how duplicate nodes and edges merge. Importing the module runs no
// I/O — the CLI is guarded — so nothing here reads or writes a file except the committed fixture.

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const {
    ROLE_EDGES,
    NODE_TYPE_PRECEDENCE,
    EDGE_TYPES,
    aggregateVenues,
    canonicalIndex,
    applyCanonicalMeta,
    buildGraph,
    compactMeta,
    countsByType,
    danglingEdges,
    dexIdForMarket,
    dedupeEdges,
    dedupeNodes,
    isNum,
    lendingGraph,
    partyGraph,
    preferNodeType,
    programmeNodes,
    securitiesEdge,
    slugify,
    sortEdges,
    sortNodes,
    venueEntries
} = require('./build-graph.mjs');

const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'graph.sample.json'), 'utf8'));

// ---------------------------------------------------------------- slugify

describe('slugify', () => {
    test.each([
        ['Backed Assets (JE) Limited', 'backed-assets-je-limited'],
        ['Payward Europe (Kraken)', 'payward-europe-kraken'],
        ['FMA Liechtenstein', 'fma-liechtenstein'],
        ['non-US persons', 'non-us-persons'],
        ['everyone (no KYC)', 'everyone-no-kyc'],
        ['Equiniti Trust Company', 'equiniti-trust-company'],
        ['raydium-clmm', 'raydium-clmm'],
        ['  Kraken  ', 'kraken'],
        ['Qube Research & Technologies', 'qube-research-and-technologies'],
        ['Société Générale', 'societe-generale']
    ])('%s -> %s', (input, expected) => {
        expect(slugify(input)).toBe(expected);
    });

    test('a missing name is the empty id, never "null"', () => {
        expect(slugify(null)).toBe('');
        expect(slugify(undefined)).toBe('');
        expect(slugify('')).toBe('');
        expect(slugify('---')).toBe('');
    });

    test('two spellings of one name collide deliberately, so the nodes merge', () => {
        expect(slugify('Kraken')).toBe(slugify('kraken'));
        expect(slugify('Trek Labs')).toBe(slugify('trek labs'));
    });
});

describe('isNum', () => {
    test('only a finite number passes, so a null never becomes 0', () => {
        expect(isNum(0)).toBe(true);
        expect(isNum(-1.5)).toBe(true);
        expect(isNum(null)).toBe(false);
        expect(isNum(undefined)).toBe(false);
        expect(isNum(NaN)).toBe(false);
        expect(isNum(Infinity)).toBe(false);
        expect(isNum('12')).toBe(false);
    });
});

// ---------------------------------------------------------------- node types

describe('preferNodeType', () => {
    test('the more specific type wins whichever order it arrives in', () => {
        expect(preferNodeType('distributor', 'dex')).toBe('dex');
        expect(preferNodeType('dex', 'distributor')).toBe('dex');
        expect(preferNodeType('parent', 'tokenization-provider')).toBe('tokenization-provider');
        expect(preferNodeType('audience', 'regulator')).toBe('regulator');
    });

    test('programme outranks every party type', () => {
        for (const type of NODE_TYPE_PRECEDENCE.slice(1)) {
            expect(preferNodeType('programme', type)).toBe('programme');
            expect(preferNodeType(type, 'programme')).toBe('programme');
        }
    });

    test('an unknown type never displaces a known one', () => {
        expect(preferNodeType('custodian', 'nonsense')).toBe('custodian');
        expect(preferNodeType('nonsense', 'custodian')).toBe('custodian');
    });
});

describe('compactMeta', () => {
    test('drops nulls, empty strings, empty arrays and empty objects', () => {
        expect(compactMeta({ a: 1, b: null, c: '', d: [], e: {}, f: 'x' })).toEqual({ a: 1, f: 'x' });
    });

    test('keeps a real zero — a zero liquidity is a fact', () => {
        expect(compactMeta({ liquidityUsd: 0 })).toEqual({ liquidityUsd: 0 });
    });

    test('keys come out sorted, so the file is byte-stable', () => {
        expect(Object.keys(compactMeta({ z: 1, a: 2, m: 3 }))).toEqual(['a', 'm', 'z']);
    });
});

// ---------------------------------------------------------------- programmes

describe('programmeNodes', () => {
    const issuers = [
        { slug: 'xstocks-backed', name: 'xStocks', status: 'live', grades: { claimRung: 2 }, tokenMints: ['A', 'B'] },
        { slug: 'remora-markets', name: 'Remora Markets', status: 'defunct', grades: { claimRung: 1 }, tokenMints: [] },
        { name: 'no slug at all' }
    ];

    test('one node per issuer record, carrying status and grades', () => {
        const nodes = programmeNodes(issuers);
        expect(nodes).toHaveLength(2);
        expect(nodes[0]).toMatchObject({ id: 'xstocks-backed', label: 'xStocks', type: 'programme' });
        expect(nodes[0].meta.status).toBe('live');
        expect(nodes[0].meta.grades).toEqual({ claimRung: 2 });
        expect(nodes[0].meta.mints).toBe(2);
        expect(nodes[1].meta.status).toBe('defunct');
    });

    test('a record without a slug is skipped, not given an empty id', () => {
        expect(programmeNodes(issuers).some((node) => node.id === '')).toBe(false);
    });

    test('no issuers is no nodes, not a throw', () => {
        expect(programmeNodes(null)).toEqual([]);
        expect(programmeNodes([])).toEqual([]);
    });
});

// ---------------------------------------------------------------- party edges

describe('partyGraph', () => {
    const parties = {
        securitiesIssuers: [{ name: 'Galaxy Digital Inc.', role: 'securitiesIssuer', jurisdiction: 'Delaware', identifier: 'CIK 1' }],
        tokenIssuers: [{ name: 'Backed Assets (JE) Limited' }],
        tokenizationProviders: [{ name: 'Superstate' }],
        transferAgents: [{ name: 'Equity Stock Transfer' }],
        custodians: [{ name: 'DekaBank' }],
        verificationAgents: [{ name: 'The Network Firm' }, { name: 'Chainlink' }],
        distributors: [{ name: 'Kraken' }],
        regulators: [{ name: 'FMA Liechtenstein' }],
        parents: [{ name: 'Payward Europe (Kraken)' }],
        audience: [{ name: 'non-US persons', note: 'US persons excluded' }]
    };

    // A register-mirrored programme, so the listed company really issues the tokenized share.
    const { nodes, edges } = partyGraph(parties, 'xstocks-backed', 'xstocks-backed', 'registered-share');

    test('every role produces its own edge type', () => {
        const byType = new Map(edges.map((edge) => [edge.type, edge]));
        expect([...byType.keys()].sort()).toEqual([
            'custodies', 'distributes', 'issues', 'keeps-register', 'offered-to',
            'owned-by', 'regulated-by', 'tokenizes-for', 'verifies', 'wraps'
        ]);
    });

    test('each parties key in MODEL §10.2 is covered by exactly one row', () => {
        expect(ROLE_EDGES.map((row) => row.key).sort()).toEqual(Object.keys(parties).sort());
        expect(new Set(ROLE_EDGES.map((row) => row.edgeType)).size).toBe(ROLE_EDGES.length);
    });

    test('issues points security-issuer -> programme', () => {
        const edge = edges.find((e) => e.type === 'issues');
        expect(edge.from).toBe('galaxy-digital-inc');
        expect(edge.to).toBe('xstocks-backed');
    });

    test('a programme that only references the listed company gets a reversed references edge', () => {
        const result = partyGraph(parties, 'backpack-securities', 'backpack-securities', 'spv-claim-redeemable');
        const edge = result.edges.find((e) => e.type === 'references');
        expect(edge.from).toBe('backpack-securities');
        expect(edge.to).toBe('galaxy-digital-inc');
        expect(result.edges.some((e) => e.type === 'issues')).toBe(false);
        // The node is still a security-issuer — what changes is the relation, not the party.
        expect(result.nodes.find((node) => node.id === 'galaxy-digital-inc').type).toBe('security-issuer');
    });

    test('an unknown or missing legal form is treated as referenced, never as issued', () => {
        for (const legalForm of [undefined, null, '', 'derivative', 'structured-note']) {
            const result = partyGraph(parties, 'p', 'p', legalForm);
            expect(result.edges.some((e) => e.type === 'references')).toBe(true);
            expect(result.edges.some((e) => e.type === 'issues')).toBe(false);
        }
    });

    test('wraps, tokenizes-for, keeps-register, custodies, verifies and distributes all point at the programme', () => {
        for (const type of ['wraps', 'tokenizes-for', 'keeps-register', 'custodies', 'verifies', 'distributes']) {
            expect(edges.find((e) => e.type === type).to).toBe('xstocks-backed');
        }
    });

    test('regulated-by, owned-by and offered-to point away from the programme', () => {
        for (const type of ['regulated-by', 'owned-by', 'offered-to']) {
            const edge = edges.find((e) => e.type === type);
            expect(edge.from).toBe('xstocks-backed');
            expect(edge.to).not.toBe('xstocks-backed');
        }
    });

    test('every edge type is one MODEL §10.4 allows', () => {
        for (const edge of edges) expect(EDGE_TYPES.has(edge.type)).toBe(true);
    });

    test('node types follow the role, and party meta is carried over', () => {
        const galaxy = nodes.find((node) => node.id === 'galaxy-digital-inc');
        expect(galaxy.type).toBe('security-issuer');
        expect(galaxy.meta.jurisdiction).toBe('Delaware');
        expect(galaxy.meta.identifier).toBe('CIK 1');
        expect(galaxy.meta.roles).toEqual(['securitiesIssuers']);
        expect(nodes.find((node) => node.id === 'non-us-persons').type).toBe('audience');
        expect(nodes.find((node) => node.id === 'kraken').type).toBe('distributor');
    });

    test('every edge records the programme it was read from', () => {
        for (const edge of edges) expect(edge.via).toEqual(['xstocks-backed']);
    });

    test('a party with no name is skipped rather than becoming an empty node', () => {
        const result = partyGraph({ custodians: [{ note: 'unnamed' }, null, { name: '' }] }, 'p', 'p');
        expect(result.nodes).toEqual([]);
        expect(result.edges).toEqual([]);
    });

    test('a missing parties object is an empty graph', () => {
        expect(partyGraph(null, 'p', 'p', 'registered-share')).toEqual({ nodes: [], edges: [] });
        expect(partyGraph({}, 'p', 'p', 'registered-share')).toEqual({ nodes: [], edges: [] });
        expect(partyGraph(parties, '', '', 'registered-share')).toEqual({ nodes: [], edges: [] });
    });

    test('an unknown parties key is ignored, not turned into an edge type', () => {
        const result = partyGraph({ auditors: [{ name: 'Someone LLP' }] }, 'p', 'p', 'registered-share');
        expect(result.edges).toEqual([]);
    });
});

describe('securitiesEdge', () => {
    test('only a registered-share programme gets issues, pointing at the programme', () => {
        expect(securitiesEdge('registered-share')).toEqual({ edgeType: 'issues', direction: 'party-to-programme' });
    });

    test('every other legal form gets references, pointing away from the programme', () => {
        for (const legalForm of ['tracker-certificate', 'structured-note', 'spv-claim-redeemable',
            'spv-synthetic', 'debt-note', 'derivative', null, undefined]) {
            expect(securitiesEdge(legalForm)).toEqual({ edgeType: 'references', direction: 'programme-to-party' });
        }
    });

    test('both relations are types MODEL §10.4 allows', () => {
        expect(EDGE_TYPES.has('issues')).toBe(true);
        expect(EDGE_TYPES.has('references')).toBe(true);
    });
});

// ---------------------------------------------------------------- venues

describe('venueEntries', () => {
    test('reads the fetcher\'s items[] shape and keeps the issuer slug', () => {
        const rows = venueEntries({
            fetchedAt: 'x',
            source: 'y',
            items: [
                { mint: 'm2', symbol: 'B', issuer: 'ondo-global-markets', dex: [{ dexId: 'orca' }], cex: [] },
                { mint: 'm1', symbol: 'A', issuer: 'xstocks-backed', dex: [], cex: [{ market: 'Kraken' }] }
            ]
        });
        expect(rows.map((row) => row.mint)).toEqual(['m1', 'm2']);
        expect(rows[0].issuer).toBe('xstocks-backed');
        expect(rows[1].dex).toHaveLength(1);
    });

    test('a mint the fetcher found no venue for is dropped', () => {
        const rows = venueEntries({ items: [{ mint: 'm', issuer: 'p', dex: [], cex: [] }] });
        expect(rows).toEqual([]);
    });

    test('an item with no issuer is kept, so the build can report it as skipped', () => {
        const rows = venueEntries({ items: [{ mint: 'm', dex: [{ dexId: 'orca' }] }] });
        expect(rows).toEqual([{ mint: 'm', issuer: null, dex: [{ dexId: 'orca' }], cex: [] }]);
    });

    test('a missing or malformed file is no rows, not a throw', () => {
        expect(venueEntries(null)).toEqual([]);
        expect(venueEntries({ fetchedAt: 'x' })).toEqual([]);
        expect(venueEntries({ items: 'nonsense' })).toEqual([]);
        expect(venueEntries({ items: [null, { symbol: 'no mint' }] })).toEqual([]);
    });
});

describe('dexIdForMarket', () => {
    const known = new Set(['raydium', 'orca', 'meteora', 'jupiter']);

    test('an exact CoinGecko market id is that DEX', () => {
        expect(dexIdForMarket('orca', known)).toBe('orca');
        expect(dexIdForMarket('meteora', known)).toBe('meteora');
    });

    test('CoinGecko\'s pool flavours fold into the base DEX', () => {
        expect(dexIdForMarket('raydium-clmm', known)).toBe('raydium');
        expect(dexIdForMarket('raydium2', known)).toBe('raydium');
        expect(dexIdForMarket('meteora-damm-v2', known)).toBe('meteora');
    });

    test('a letter after the id is a different venue, not a flavour', () => {
        // meteoradbc is its own DexScreener venue and must not be merged into Meteora.
        expect(dexIdForMarket('meteoradbc', known)).toBeNull();
        expect(dexIdForMarket('orcanaut', known)).toBeNull();
    });

    test('a CEX is not a DEX', () => {
        expect(dexIdForMarket('kraken', known)).toBeNull();
        expect(dexIdForMarket('mxc', known)).toBeNull();
    });

    test('a missing id or no known DEX is null, never a guess', () => {
        expect(dexIdForMarket(null, known)).toBeNull();
        expect(dexIdForMarket('raydium-clmm', null)).toBeNull();
        expect(dexIdForMarket('', known)).toBeNull();
    });
});

describe('canonicalIndex', () => {
    test('indexes the table by the slug of its name', () => {
        const index = canonicalIndex([{ name: 'Raydium', type: 'dex' }, { name: 'Backpack Exchange', type: 'distributor' }]);
        expect(index.get('raydium').type).toBe('dex');
        expect(index.get('backpack-exchange').type).toBe('distributor');
    });

    test('a missing table is an empty index', () => {
        expect(canonicalIndex(null).size).toBe(0);
        expect(canonicalIndex([null, { type: 'dex' }]).size).toBe(0);
    });
});

describe('aggregateVenues', () => {
    const entries = [
        {
            mint: 'm1',
            issuer: 'prog-a',
            dex: [
                { dexId: 'raydium', liquidityUsd: 100, volume24Usd: 10 },
                { dexId: 'raydium', liquidityUsd: 50, volume24Usd: 5 },
                { dexId: 'orca', liquidityUsd: 25, volume24Usd: 3 }
            ],
            cex: [
                { market: 'Kraken', marketId: 'kraken', volume24Usd: 900, trustScore: null },
                { market: 'Raydium (CLMM)', marketId: 'raydium-clmm', volume24Usd: 700, trustScore: null }
            ]
        },
        { mint: 'm2', issuer: 'prog-a', dex: [{ dexId: 'raydium', liquidityUsd: 400, volume24Usd: 40 }], cex: [] },
        { mint: 'm3', issuer: 'prog-b', dex: [{ dexId: 'orca', liquidityUsd: 7 }], cex: [] },
        { mint: 'm4', issuer: 'prog-b', dex: [], cex: [{ market: 'MEXC', marketId: 'mxc', volume24Usd: 5000 }] },
        { mint: 'm5', issuer: 'not-a-programme', dex: [{ dexId: 'raydium', liquidityUsd: 1e9 }], cex: [] }
    ];
    const programmes = new Set(['prog-a', 'prog-b']);
    const canonical = canonicalIndex([
        { name: 'Raydium', type: 'dex' },
        { name: 'Orca', type: 'dex' },
        { name: 'Kraken', type: 'distributor' },
        { name: 'Jupiter', type: 'dex' }
    ]);
    const { nodes, edges, skipped, knownDexIds } = aggregateVenues(entries, programmes, canonical);

    test('one edge per programme and venue, weight = Σ liquidity', () => {
        const ray = edges.find((e) => e.from === 'prog-a' && e.to === 'raydium');
        expect(ray.type).toBe('traded-on');
        expect(ray.weight).toBe(550);
        expect(ray.meta.weightBasis).toBe('liquidity');
        expect(ray.meta.liquidityUsd).toBe(550);
        expect(ray.meta.mints).toBe(2);
        expect(ray.note).toContain('2 mints');
        expect(ray.note).toContain('3 pools');
    });

    test('a CEX-only venue weighs volume and says so in meta and note', () => {
        const kraken = edges.find((e) => e.to === 'kraken');
        expect(kraken.weight).toBe(900);
        expect(kraken.meta.weightBasis).toBe('volume');
        expect(kraken.meta.liquidityUsd).toBeUndefined();
        expect(kraken.note).toContain('weight is 24h volume');
        expect(nodes.find((node) => node.id === 'kraken').type).toBe('distributor');
    });

    test('a CoinGecko market that is really a DEX merges into the DEX node', () => {
        // "Raydium (CLMM)" must not become a second, distributor-typed Raydium.
        expect(nodes.some((node) => node.id === 'raydium-clmm')).toBe(false);
        expect(nodes.filter((node) => node.id === 'raydium')).toHaveLength(1);
        expect(nodes.find((node) => node.id === 'raydium').type).toBe('dex');
        const ray = edges.find((e) => e.from === 'prog-a' && e.to === 'raydium');
        expect(ray.meta.volume24Usd).toBe(755); // 10 + 5 + 40 pools, plus the 700 ticker
        expect(ray.weight).toBe(550); // still liquidity: merging a ticker must not change the basis
    });

    test('venue labels come from the canonical table', () => {
        expect(nodes.find((node) => node.id === 'raydium').label).toBe('Raydium');
        expect(nodes.find((node) => node.id === 'orca').label).toBe('Orca');
        expect(nodes.find((node) => node.id === 'kraken').label).toBe('Kraken');
    });

    test('a venue absent from the table keeps the source\'s own string, never an invented name', () => {
        expect(nodes.find((node) => node.id === 'mexc').label).toBe('MEXC');
        expect(nodes.find((node) => node.id === 'mexc').type).toBe('distributor');
    });

    test('a DEX the canonical table knows counts as one even with no pool of its own', () => {
        expect(knownDexIds).toContain('jupiter');
        expect(knownDexIds).toContain('raydium');
    });

    test('venue node meta sums over every programme and counts them', () => {
        const orca = nodes.find((node) => node.id === 'orca');
        expect(orca.meta.liquidityUsd).toBe(32);
        expect(orca.meta.pools).toBe(2);
        expect(orca.meta.programmes).toBe(2);
    });

    test('two programmes on one venue are two edges, one node', () => {
        expect(edges.filter((e) => e.to === 'orca')).toHaveLength(2);
        expect(nodes.filter((node) => node.id === 'orca')).toHaveLength(1);
    });

    test('a mint naming no known programme is skipped and reported, never guessed', () => {
        expect(skipped).toEqual([{ mint: 'm5', issuer: 'not-a-programme' }]);
        expect(edges.every((edge) => edge.weight < 1e9)).toBe(true);
    });

    test('a null liquidity falls back to volume instead of becoming a zero weight', () => {
        const result = aggregateVenues(
            [{ mint: 'm', issuer: 'p', dex: [{ dexId: 'orca', liquidityUsd: null, volume24Usd: 12 }], cex: [] }],
            new Set(['p']), canonical
        );
        expect(result.edges[0].weight).toBe(12);
        expect(result.edges[0].meta.weightBasis).toBe('volume');
        expect(result.nodes[0].meta.liquidityUsd).toBeUndefined();
    });

    test('a zero liquidity is a fallback too, not a liquidity weight of zero', () => {
        const result = aggregateVenues(
            [{ mint: 'm', issuer: 'p', dex: [{ dexId: 'orca', liquidityUsd: 0, volume24Usd: 30 }], cex: [] }],
            new Set(['p']), canonical
        );
        expect(result.edges[0].weight).toBe(30);
        expect(result.edges[0].meta.weightBasis).toBe('volume');
    });

    test('one pool with liquidity sets the basis even when another reports none', () => {
        const result = aggregateVenues(
            [{ mint: 'm', issuer: 'p', dex: [{ dexId: 'orca', liquidityUsd: null, volume24Usd: 99 }, { dexId: 'orca', liquidityUsd: 5 }], cex: [] }],
            new Set(['p']), canonical
        );
        expect(result.edges[0].weight).toBe(5);
        expect(result.edges[0].meta.weightBasis).toBe('liquidity');
    });

    test('a pool with no numbers at all weighs 0 by volume rather than claiming liquidity', () => {
        const result = aggregateVenues(
            [{ mint: 'm', issuer: 'p', dex: [{ dexId: 'orca' }], cex: [] }],
            new Set(['p']), canonical
        );
        expect(result.edges[0].weight).toBe(0);
        expect(result.edges[0].meta.weightBasis).toBe('volume');
    });

    test('a pool or ticker with no venue name is skipped', () => {
        const result = aggregateVenues(
            [{ mint: 'm', issuer: 'p', dex: [{ liquidityUsd: 5 }], cex: [{ volume24Usd: 5 }] }],
            new Set(['p']), canonical
        );
        expect(result.edges).toEqual([]);
    });

    test('an empty input is an empty aggregation', () => {
        expect(aggregateVenues([], new Set(), new Map()))
            .toEqual({ nodes: [], edges: [], skipped: [], knownDexIds: [] });
        expect(aggregateVenues(null, null, null).edges).toEqual([]);
    });
});

// ---------------------------------------------------------------- lending

describe('lendingGraph', () => {
    test('Kamino named in the dossier venues becomes a lends-on edge with a null weight', () => {
        const dossier = { venues: ['Jupiter (primary)', 'Kamino (named as a lending integration)'] };
        const { nodes, edges } = lendingGraph(dossier, 'shift', 'shift');
        expect(nodes).toEqual([{ id: 'kamino', label: 'Kamino', type: 'lending', meta: {} }]);
        expect(edges[0]).toMatchObject({ from: 'shift', to: 'kamino', type: 'lends-on', weight: null, via: ['shift'] });
        expect(edges[0].note).toContain('Kamino');
    });

    test('a dossier that never names it gets no edge', () => {
        expect(lendingGraph({ venues: ['Jupiter', 'Raydium'] }, 'p', 'p')).toEqual({ nodes: [], edges: [] });
    });

    test('prose in an object field is searched too', () => {
        const { edges } = lendingGraph({ collateral: { composition: 'usable on Kamino as collateral' } }, 'p', 'p');
        expect(edges).toHaveLength(1);
    });

    test('a long sentence is truncated rather than dumped into the note', () => {
        const long = `Kamino ${'x'.repeat(400)}`;
        const { edges } = lendingGraph({ venues: [long] }, 'p', 'p');
        expect(edges[0].note.length).toBeLessThanOrEqual(220);
        expect(edges[0].note.endsWith('...')).toBe(true);
    });

    test('a missing dossier is an empty graph', () => {
        expect(lendingGraph(null, 'p', 'p')).toEqual({ nodes: [], edges: [] });
        expect(lendingGraph({ venues: ['Kamino'] }, '', '')).toEqual({ nodes: [], edges: [] });
    });
});

// ---------------------------------------------------------------- dedupe and sort

describe('dedupeNodes', () => {
    test('one id is one node, and the more specific type wins', () => {
        const nodes = dedupeNodes([
            { id: 'kraken', label: 'Kraken', type: 'distributor', meta: { roles: ['distributors'] } },
            { id: 'kraken', label: 'Kraken', type: 'distributor', meta: { roles: ['parents'], jurisdiction: 'Ireland' } }
        ]);
        expect(nodes).toHaveLength(1);
        expect(nodes[0].meta.roles).toEqual(['distributors', 'parents']);
        expect(nodes[0].meta.jurisdiction).toBe('Ireland');
    });

    test('a party arriving as two different roles keeps the more specific node type', () => {
        const nodes = dedupeNodes([
            { id: 'trek-labs', label: 'Trek Labs', type: 'parent', meta: { roles: ['parents'] } },
            { id: 'trek-labs', label: 'Trek Labs', type: 'tokenization-provider', meta: { roles: ['tokenizationProviders'] } }
        ]);
        expect(nodes[0].type).toBe('tokenization-provider');
        expect(nodes[0].meta.roles).toEqual(['parents', 'tokenizationProviders']);
    });

    test('the first non-empty value for a key is kept', () => {
        const nodes = dedupeNodes([
            { id: 'a', label: 'A', type: 'custodian', meta: { note: 'first' } },
            { id: 'a', label: 'A', type: 'custodian', meta: { note: 'second' } }
        ]);
        expect(nodes[0].meta.note).toBe('first');
    });

    test('a node without an id is dropped', () => {
        expect(dedupeNodes([{ label: 'no id' }, null])).toEqual([]);
    });
});

describe('dedupeEdges', () => {
    test('one (from,to,type) is one edge, weights sum and via unions', () => {
        const edges = dedupeEdges([
            { from: 'a', to: 'b', type: 'traded-on', weight: 100, via: ['p1'] },
            { from: 'a', to: 'b', type: 'traded-on', weight: 50, via: ['p2'] }
        ]);
        expect(edges).toHaveLength(1);
        expect(edges[0].weight).toBe(150);
        expect(edges[0].via).toEqual(['p1', 'p2']);
    });

    test('the same pair with a different type stays two edges', () => {
        const edges = dedupeEdges([
            { from: 'a', to: 'b', type: 'distributes', weight: 1, via: ['p'] },
            { from: 'a', to: 'b', type: 'traded-on', weight: 1, via: ['p'] }
        ]);
        expect(edges).toHaveLength(2);
    });

    test('a null weight stays null instead of becoming 0', () => {
        const edges = dedupeEdges([{ from: 'a', to: 'b', type: 'lends-on', weight: null, via: ['p'] }]);
        expect(edges[0].weight).toBeNull();
    });

    test('a null weight merged with a real one takes the real one', () => {
        const edges = dedupeEdges([
            { from: 'a', to: 'b', type: 'lends-on', weight: null, via: ['p'] },
            { from: 'a', to: 'b', type: 'lends-on', weight: 7, via: ['q'] }
        ]);
        expect(edges[0].weight).toBe(7);
    });

    test('an edge missing an endpoint is dropped', () => {
        expect(dedupeEdges([{ from: 'a', type: 'wraps' }, { to: 'b', type: 'wraps' }, null])).toEqual([]);
    });
});

describe('sorting', () => {
    test('nodes sort by id', () => {
        expect(sortNodes([{ id: 'b' }, { id: 'a' }, { id: 'c' }]).map((n) => n.id)).toEqual(['a', 'b', 'c']);
    });

    test('edges sort by from, then to, then type', () => {
        const sorted = sortEdges([
            { from: 'b', to: 'a', type: 'wraps' },
            { from: 'a', to: 'b', type: 'wraps' },
            { from: 'a', to: 'b', type: 'issues' },
            { from: 'a', to: 'a', type: 'wraps' }
        ]);
        expect(sorted.map((e) => `${e.from}/${e.to}/${e.type}`)).toEqual([
            'a/a/wraps', 'a/b/issues', 'a/b/wraps', 'b/a/wraps'
        ]);
    });

    test('sorting does not mutate the input', () => {
        const nodes = [{ id: 'b' }, { id: 'a' }];
        sortNodes(nodes);
        expect(nodes[0].id).toBe('b');
    });
});

describe('countsByType', () => {
    test('counts in the declared order, then anything unexpected', () => {
        const counts = countsByType(
            [{ type: 'dex' }, { type: 'programme' }, { type: 'dex' }, { type: 'mystery' }],
            NODE_TYPE_PRECEDENCE
        );
        expect(Object.keys(counts)).toEqual(['programme', 'dex', 'mystery']);
        expect(counts).toEqual({ programme: 1, dex: 2, mystery: 1 });
    });
});

describe('danglingEdges', () => {
    test('an edge pointing at an unknown node is reported', () => {
        const dangling = danglingEdges([{ id: 'a' }], [{ from: 'a', to: 'b', type: 'wraps' }]);
        expect(dangling).toHaveLength(1);
    });

    test('the committed fixture has none', () => {
        expect(danglingEdges(FIXTURE.nodes, FIXTURE.edges)).toEqual([]);
    });
});

// ---------------------------------------------------------------- canonical meta

describe('applyCanonicalMeta', () => {
    const canonical = [
        { name: 'Kraken', type: 'distributor', jurisdiction: 'United States', identifier: 'x', website: 'https://kraken.com', note: 'canonical note', alsoRoles: ['parents'] }
    ];

    test('jurisdiction, identifier, website and note land on the node', () => {
        const nodes = applyCanonicalMeta([{ id: 'kraken', label: 'Kraken', type: 'distributor', meta: {} }], canonical);
        expect(nodes[0].meta).toMatchObject({
            jurisdiction: 'United States', identifier: 'x', website: 'https://kraken.com', note: 'canonical note'
        });
        expect(nodes[0].meta.alsoRoles).toEqual(['parents']);
    });

    test('the canonical type wins over the type the dossier role implied', () => {
        const nodes = applyCanonicalMeta(
            [{ id: 'kraken', label: 'Kraken', type: 'tokenization-provider', meta: { roles: ['tokenizationProviders'] } }],
            canonical
        );
        expect(nodes[0].type).toBe('distributor');
        // The role the dossier recorded is still visible — it is just not the node's type.
        expect(nodes[0].meta.roles).toEqual(['tokenizationProviders']);
    });

    test('an unrecognised canonical type does not overwrite a good one', () => {
        const nodes = applyCanonicalMeta(
            [{ id: 'kraken', label: 'Kraken', type: 'distributor', meta: {} }],
            [{ name: 'Kraken', type: 'not-a-node-type' }]
        );
        expect(nodes[0].type).toBe('distributor');
    });

    test('what the dossier said wins over the canonical table', () => {
        const nodes = applyCanonicalMeta(
            [{ id: 'kraken', label: 'Kraken', type: 'distributor', meta: { jurisdiction: 'Ireland' } }],
            canonical
        );
        expect(nodes[0].meta.jurisdiction).toBe('Ireland');
    });

    test('a programme is never retyped by a same-named canonical party', () => {
        const nodes = applyCanonicalMeta(
            [{ id: 'kraken', label: 'Kraken', type: 'programme', meta: {} }],
            canonical
        );
        expect(nodes[0].type).toBe('programme');
    });

    test('a node with no canonical row is untouched', () => {
        const input = [{ id: 'unknown', label: 'U', type: 'custodian', meta: { note: 'n' } }];
        expect(applyCanonicalMeta(input, canonical)).toEqual(input);
    });

    test('a missing canonical table is not an error', () => {
        const input = [{ id: 'a', label: 'A', type: 'custodian', meta: {} }];
        expect(applyCanonicalMeta(input, null)).toEqual(input);
    });
});

// ---------------------------------------------------------------- whole build

describe('buildGraph', () => {
    const issuers = [
        { slug: 'xstocks-backed', name: 'xStocks', status: 'live', legalForm: 'tracker-certificate', grades: { claimRung: 2 }, tokenMints: ['m1'] },
        { slug: 'superstate-opening-bell', name: 'Superstate Opening Bell', status: 'live', legalForm: 'registered-share', grades: { claimRung: 4 }, tokenMints: ['m2'] }
    ];
    const dossiers = [
        {
            slug: 'xstocks-backed',
            dossier: {
                parties: {
                    securitiesIssuers: [{ name: 'Tesla, Inc.' }],
                    tokenIssuers: [{ name: 'Backed Assets (JE) Limited' }],
                    distributors: [{ name: 'Kraken' }],
                    parents: [{ name: 'Payward Europe (Kraken)' }]
                }
            }
        },
        {
            slug: 'superstate-opening-bell',
            dossier: {
                venues: ['Kamino Finance (Solana) — borrowing/lending'],
                parties: {
                    securitiesIssuers: [{ name: 'Forward Industries' }],
                    tokenizationProviders: [{ name: 'Superstate' }]
                }
            }
        },
        { slug: 'not-an-issuer', dossier: { parties: { custodians: [{ name: 'Nowhere Bank' }] } } }
    ];
    const venues = {
        fetchedAt: '2026-09-16T19:00:00Z',
        source: 'dexscreener + coingecko',
        items: [
            {
                mint: 'm1',
                issuer: 'xstocks-backed',
                dex: [{ dexId: 'raydium', liquidityUsd: 1000, volume24Usd: 120 }],
                cex: [{ market: 'Kraken', marketId: 'kraken', volume24Usd: 5000 }]
            },
            { mint: 'm2', issuer: 'superstate-opening-bell', dex: [], cex: [] },
            { mint: 'm9', issuer: 'a-programme-that-does-not-exist', dex: [{ dexId: 'orca', liquidityUsd: 99 }], cex: [] }
        ]
    };
    const graph = buildGraph({ issuers, dossiers, canonicalParties: [{ name: 'Kraken', website: 'https://kraken.com' }], venues, builtAt: 'fixed' });

    test('programmes, parties and venues all become nodes', () => {
        const byId = new Map(graph.nodes.map((node) => [node.id, node]));
        expect(byId.get('xstocks-backed').type).toBe('programme');
        expect(byId.get('backed-assets-je-limited').type).toBe('token-issuer');
        expect(byId.get('raydium').type).toBe('dex');
        expect(byId.get('kamino').type).toBe('lending');
    });

    test('a dossier with no matching issuer record contributes nothing', () => {
        expect(graph.nodes.some((node) => node.id === 'nowhere-bank')).toBe(false);
    });

    test('the legal form of each programme decides issues versus references', () => {
        const issues = graph.edges.find((edge) => edge.type === 'issues');
        expect(issues).toMatchObject({ from: 'forward-industries', to: 'superstate-opening-bell' });
        const references = graph.edges.find((edge) => edge.type === 'references');
        expect(references).toMatchObject({ from: 'xstocks-backed', to: 'tesla-inc' });
    });

    test('a party that is also a venue is one node carrying both', () => {
        const kraken = graph.nodes.filter((node) => node.id === 'kraken');
        expect(kraken).toHaveLength(1);
        expect(kraken[0].meta.website).toBe('https://kraken.com');
        expect(graph.edges.filter((edge) => edge.to === 'kraken' || edge.from === 'kraken').map((e) => e.type).sort())
            .toEqual(['distributes', 'traded-on']);
    });

    test('output is sorted and has no dangling edge', () => {
        expect(graph.nodes.map((n) => n.id)).toEqual([...graph.nodes.map((n) => n.id)].sort());
        expect(danglingEdges(graph.nodes, graph.edges)).toEqual([]);
    });

    test('mints of no known programme are reported, and their venues never reach the graph', () => {
        expect(graph.venueStats.skipped).toEqual([{ mint: 'm9', issuer: 'a-programme-that-does-not-exist' }]);
        expect(graph.nodes.some((node) => node.id === 'orca')).toBe(false);
    });

    test('venueStats counts what the venue join actually produced', () => {
        expect(graph.venueStats.mintsWithVenues).toBe(2); // m2 had no venue at all
        expect(graph.venueStats.tradedOnEdges).toBe(2);
        expect(graph.venueStats.dexNodes).toBe(1);
        expect(graph.venueStats.cexNodes).toBe(1);
    });

    test('a traded-on edge carries its weight basis through the whole build', () => {
        const ray = graph.edges.find((edge) => edge.to === 'raydium' && edge.type === 'traded-on');
        expect(ray.weight).toBe(1000);
        expect(ray.meta).toEqual({ liquidityUsd: 1000, mints: 1, volume24Usd: 120, weightBasis: 'liquidity' });
        const kraken = graph.edges.find((edge) => edge.to === 'kraken' && edge.type === 'traded-on');
        expect(kraken.meta.weightBasis).toBe('volume');
    });

    test('builtAt is the caller\'s, so the build is reproducible in a test', () => {
        expect(graph.builtAt).toBe('fixed');
    });

    test('building twice from the same inputs gives the same bytes', () => {
        const again = buildGraph({ issuers, dossiers, canonicalParties: [{ name: 'Kraken', website: 'https://kraken.com' }], venues, builtAt: 'fixed' });
        expect(JSON.stringify(again)).toBe(JSON.stringify(graph));
    });

    test('no inputs at all is an empty graph, not a throw', () => {
        const empty = buildGraph({});
        expect(empty.nodes).toEqual([]);
        expect(empty.edges).toEqual([]);
    });
});

// ---------------------------------------------------------------- the fixture itself

describe('graph.sample.json', () => {
    test('matches the §10.4 envelope', () => {
        expect(typeof FIXTURE.builtAt).toBe('string');
        expect(Array.isArray(FIXTURE.nodes)).toBe(true);
        expect(Array.isArray(FIXTURE.edges)).toBe(true);
    });

    test('every node type and edge type is one MODEL §10.4 allows', () => {
        for (const node of FIXTURE.nodes) expect(NODE_TYPE_PRECEDENCE).toContain(node.type);
        for (const edge of FIXTURE.edges) expect(EDGE_TYPES.has(edge.type)).toBe(true);
    });

    test('ids are slugs of their own labels or of a venue id', () => {
        for (const node of FIXTURE.nodes) {
            expect(node.id).toBe(slugify(node.id));
            expect(node.id.length).toBeGreaterThan(0);
        }
    });

    test('it is sorted the way the build sorts, so it is a drop-in replacement', () => {
        expect(FIXTURE.nodes.map((n) => n.id)).toEqual(sortNodes(FIXTURE.nodes).map((n) => n.id));
        expect(FIXTURE.edges.map((e) => `${e.from}/${e.to}/${e.type}`))
            .toEqual(sortEdges(FIXTURE.edges).map((e) => `${e.from}/${e.to}/${e.type}`));
    });

    test('it exercises every node type and every edge type', () => {
        expect(new Set(FIXTURE.nodes.map((n) => n.type)).size).toBe(NODE_TYPE_PRECEDENCE.length);
        expect(new Set(FIXTURE.edges.map((e) => e.type)).size).toBe(EDGE_TYPES.size);
    });

    test('every via names a programme in the file', () => {
        const programmes = new Set(FIXTURE.nodes.filter((n) => n.type === 'programme').map((n) => n.id));
        for (const edge of FIXTURE.edges) {
            expect(Array.isArray(edge.via)).toBe(true);
            for (const slug of edge.via) expect(programmes.has(slug)).toBe(true);
        }
    });

    test('no node is isolated, so the page has nothing to render off in a corner', () => {
        const touched = new Set();
        for (const edge of FIXTURE.edges) {
            touched.add(edge.from);
            touched.add(edge.to);
        }
        expect(FIXTURE.nodes.filter((node) => !touched.has(node.id))).toEqual([]);
    });
});
