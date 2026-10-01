// Discovery contracts: identity, source scope, missing evidence and independent observation dates.
const { buildCatalogue, filterEntries, matchingDeployments, groupEntries, searchResults, clusterMatches } = require('./lib/rwa-catalogue.js');
const assets = [
    { name: 'Paxos Gold', ticker: 'PAXG', issuer: 'Paxos', type: 'Tokenized Commodity (Gold)', blockchain: 'Ethereum', contractAddress: '0xGold', statusCheckedAt: '2026-09-16', titleDeed: 'yes' },
    { name: 'Kraken xStocks', type: 'Tokenized Equity', blockchain: 'Solana', contractAddress: 'programme-example' },
    { name: 'Treasury Fund', ticker: 'TBILL', type: 'Tokenized Money Market Fund', blockchain: 'Ethereum', contractAddress: '' }
];
const issuers = { builtAt: '2026-09-28', issuers: [{ slug: 'xstocks-backed', name: 'Kraken xStocks', legalForm: 'tracker-certificate', chains: ['Solana', 'Ethereum'], holderClaim: 'A claim against the issuer, not an Apple share.', evidence: { lastCheckedAt: '2026-09-24' } }] };
const tokens = { builtAt: '2026-09-30', tokens: [
    { issuer: 'xstocks-backed', mint: 'exact-apple-mint', symbol: 'AAPLx', name: 'Apple xStock', underlyingTicker: 'AAPL', cardSlug: 'AAPLx', lastSeenAt: '2026-09-28', control: { clawback: true } },
    { issuer: 'xstocks-backed', mint: 'second-apple-mint', symbol: 'AAPLx', underlyingTicker: 'AAPL', cardSlug: 'AAPLx-2', lastSeenAt: '2026-09-29' }
] };
const build = () => buildCatalogue(assets, issuers, tokens);
test('reconciles programme examples instead of counting them as independent products or deployments', () => {
    const data = build();
    expect(data.counts).toEqual({ products: 2, reviewedProducts: 0, programmes: 1, indexedStockDeployments: 2, historicalAddresses: 1 });
    expect(data.entries.find((e) => e.kind === 'programme').deployments.map((d) => d.address)).toEqual(['exact-apple-mint', 'second-apple-mint']);
    expect(data.reconciled).toEqual([{ originalName: 'Kraken xStocks', programmeId: 'xstocks-backed', historicalNetwork: 'Solana' }]);
});
test('does not turn a historical category or title-deed flag into a current legal conclusion', () => {
    const gold = build().entries.find((e) => e.ticker === 'PAXG');
    expect(gold).toMatchObject({ legalForm: null, holderClaim: null, coverage: 'historical', evidenceCheckedAt: null, legalReviewedAt: null, statusCheckedAt: '2026-09-16' });
    expect(gold.deployments[0].observedAt).toBeNull();
    expect(build().entries.find((e) => e.ticker === 'TBILL').deployments).toEqual([]);
});
test('does not inherit programme chain coverage or mint controls across networks', () => {
    const programme = build().entries.find((e) => e.kind === 'programme');
    expect(programme.chains).toEqual(['Solana']);
    expect(programme.deployments[0]).not.toHaveProperty('control');
    expect(filterEntries([programme], { chain: 'Ethereum' })).toEqual([]);
});
test('an index refresh and discovery observation cannot refresh dossier or formal legal-review dates', () => {
    const newer = buildCatalogue(assets, issuers, { ...tokens, builtAt: '2026-10-01', tokens: tokens.tokens.map((t) => ({ ...t, lastSeenAt: '2026-10-01' })) });
    const programme = newer.entries.find((e) => e.kind === 'programme');
    expect(programme.evidenceCheckedAt).toBe('2026-09-24');
    expect(programme.legalReviewedAt).toBeNull();
    expect(programme.deployments[0].observedAt).toBe('2026-10-01');
});
test('searches products, issuer names, underlyings and exact addresses while combining filters', () => {
    const entries = build().entries;
    expect(filterEntries(entries, { search: 'gold', category: 'commodities', coverage: 'historical' }).map((e) => e.name)).toEqual(['Paxos Gold']);
    expect(filterEntries(entries, { search: 'AAPL', form: 'tracker-certificate' }).map((e) => e.id)).toEqual(['programme:xstocks-backed']);
    const programme = filterEntries(entries, { search: 'exact-apple-mint' })[0];
    expect(matchingDeployments(programme, 'exact-apple-mint').map((d) => d.symbol)).toEqual(['AAPLx']);
    expect(filterEntries(entries, { search: 'AAPL', coverage: 'historical' })).toEqual([]);
    expect(searchResults(entries, 'gold').links[0].href).toBe('./assets.html?search=Paxos%20Gold');
    expect(searchResults(entries, 'exact-apple-mint').links[1].href).toBe('./cards/AAPLx.html');
});
test('fails on missing reconciled dossiers, orphan tokens and duplicate exact mints', () => {
    expect(() => buildCatalogue(assets, { issuers: [] }, tokens)).toThrow('Missing reconciled programme');
    expect(() => buildCatalogue([], issuers, { tokens: [{ mint: 'x', issuer: 'unknown' }] })).toThrow('Unknown token programme');
    expect(() => buildCatalogue([], issuers, { tokens: [tokens.tokens[0], tokens.tokens[0]] })).toThrow('duplicate mint');
});
test('keeps stock-address scale from displacing asset discovery and ranks named products ahead of nested matches', () => {
    const data = buildCatalogue(assets, issuers, { ...tokens, tokens: [...tokens.tokens, { issuer: 'xstocks-backed', mint: 'gold-etf', name: 'Gold ETF', symbol: 'GLDx' }] });
    const matches = filterEntries(data.entries, { search: 'gold' });
    expect(matches.map((e) => e.name)).toEqual(['Paxos Gold', 'Kraken xStocks']);
    expect(groupEntries(matches).map(([label]) => label)).toEqual(['Commodities', 'Stocks & equity exposure']);
    expect(data.entries.filter((e) => e.kind === 'programme')).toHaveLength(1);
});
test('retains historical network discovery for a reconciled programme without inventing a deployment or inheriting chain findings', () => {
    const data = buildCatalogue([{ name: 'Ventuals Pre-IPO', type: 'Derivative', blockchain: 'Hyperliquid' }],
        { issuers: [{ slug: 'ventuals', name: 'Ventuals Pre-IPO', chains: ['Solana', 'Hyperliquid'] }] }, { tokens: [] });
    const entry = filterEntries(data.entries, { chain: 'Hyperliquid' })[0];
    expect(entry).toMatchObject({ chains: [], historicalNetworks: ['Hyperliquid'], deployments: [] });
    expect(filterEntries(data.entries, { chain: 'Solana' })).toEqual([]);
});

test('unified search filters map entries while linking directly to product and exact-token reports', () => {
    const entries = build().entries;
    const results = searchResults(entries, 'AAPL', 2);
    expect(results.entryIds).toEqual(['programme:xstocks-backed']);
    expect(results.total).toBe(3);
    expect(results.links.map(l => l.href)).toEqual(['./issuers/xstocks-backed.html', './cards/AAPLx.html']);
    expect(searchResults(entries, 'AAPL', Infinity).links).toHaveLength(3);
    expect(searchResults(entries, 'does-not-exist')).toEqual({entryIds: [], links: [], total: 0});
    expect(searchResults(entries, ' ')).toEqual({entryIds: [], links: [], total: 0});
});

test('cluster labels name matching tickers and deduplicate multiple deployments of one ticker', () => {
    const entries = build().entries, ids = ['programme:xstocks-backed'];
    expect(clusterMatches(entries, ids, 'aapl')).toEqual({symbols: ['AAPLx'], count: 2});
    expect(clusterMatches(entries, ids, 'exact-apple-mint')).toEqual({symbols: ['AAPLx'], count: 1});
    expect(clusterMatches(entries, ['product:paxos-gold'], 'gold')).toEqual({symbols: ['PAXG'], count: 1});
    expect(clusterMatches(entries, ids, '')).toEqual({symbols: [], count: 0});
    expect(clusterMatches(entries, ids, 'does-not-exist')).toEqual({symbols: [], count: 0});
});
