// Inventory-builder contract checks, independent of the full data bundle and scheduler host.
const { buildMonitoringInventory } = require('../rwa/lib/monitoring-inventory.mjs');
const { JOBS } = require('../rwa/lib/monitoring-jobs.mjs');
const { SEC_FEEDS } = require('../stocks/lib/caselaw.mjs');

const alphaRetired = 'https://alpha.example/old-terms.pdf';
const alphaChain = 'https://explorer.solana.com/address/So11111111111111111111111111111111111111112';

function fixture(overrides = {}) {
    const dossiers = [
        { slug: 'prestocks', dossier: { issuer: 'Alpha Holdings LLC', issuingEntity: 'Alpha Holdings LLC',
            documents: [{ title: 'Current terms', url: 'https://alpha.example/terms.pdf' },
                { title: 'Old terms', url: alphaRetired }, { title: 'Mint', url: alphaChain }],
            parties: { custodians: [{ name: 'Shared Custody LLC' }] }, whatIf: [] } },
        { slug: 'tessera', dossier: { issuer: 'Beta Holdings LLC', issuingEntity: 'Beta Holdings LLC',
            documents: [{ title: 'Beta terms', url: 'https://beta.example/terms.pdf' }],
            parties: { custodians: [{ name: 'Shared Custody LLC' }] }, whatIf: [] } }
    ];
    const products = [{ id: 'ustb', name: 'USTB', ticker: 'USTB', instrument: { id: 'ustb' },
        contexts: [{ id: 'fund', termsId: 'fund-terms' }], sources: [{ id: 'fund-doc', title: 'Fund filing', url: 'https://fund.example/filing.pdf' }],
        deployments: [] }];
    const apps = Object.keys(JOBS).filter((id) => !['rwa-watch-sources', 'rwa-watch-fund-data', 'rwa-watch-deployments'].includes(id))
        .map((name) => ({ name, cron_restart: '0 2 * * *', args: name === 'rwa-trades' ? '--every=3600' : '' }));
    return { apps, dossiers, research: { products }, canonical: [], extra: {}, entityRegistry: { entities: [] }, tokens: [],
        defi: { items: [] }, registration: { active: false, entries: [] }, monitorPlan: { products: [{ productId: 'ustb', fundData: { enabled: true } }] },
        retirements: { items: [{ url: alphaRetired, retiredAt: '2026-01-01', reason: 'Superseded' }] },
        refreshScript: '', ...overrides };
}

const build = (input = fixture()) => buildMonitoringInventory(input, '2026-10-01T00:00:00.000Z');

test('shared legal-name searches are deduplicated, while issuer-specific names retain their scope', () => {
    const { routes } = build();
    const shared = routes.filter((r) => r.jobId === 'rwa-watch-caselaw' && r.label.startsWith('Shared Custody LLC ·'));
    expect(shared).toHaveLength(2); // docket and opinion searches, each fetched once for both issuers
    expect(shared.map((r) => r.issuerIds)).toEqual([['prestocks', 'tessera'], ['prestocks', 'tessera']]);
    expect(routes.some((r) => r.jobId === 'rwa-watch-caselaw' && r.label.startsWith('Alpha Holdings LLC ·') && r.issuerIds.includes('prestocks'))).toBe(true);
    expect(routes.some((r) => r.jobId === 'rwa-watch-caselaw' && r.label.startsWith('Beta Holdings LLC ·') && r.issuerIds.includes('tessera'))).toBe(true);
    for (const feed of SEC_FEEDS) {
        const feedRoutes = routes.filter((r) => r.jobId === 'rwa-watch-caselaw' && r.url === feed.url);
        expect(feedRoutes).toHaveLength(1);
        expect(feedRoutes[0]).toMatchObject({ label: feed.label, scope: 'shared', issuerIds: ['prestocks', 'tessera'] });
    }
});

test('prepared fund and document monitors are explicit and retired or chain-locator citations are gaps', () => {
    const data = build();
    expect(data.jobs.find((j) => j.id === 'rwa-watch-sources').state).toBe('prepared');
    expect(data.jobs.find((j) => j.id === 'rwa-watch-fund-data').state).toBe('prepared');
    expect(data.routes.some((r) => r.jobId === 'rwa-watch-fund-data' && r.state === 'prepared')).toBe(true);
    expect(data.routes.find((r) => r.jobId === 'rwa-watch-sources' && r.url === 'https://fund.example/filing.pdf')).toMatchObject({
        state: 'prepared', issuerIds: ['product:ustb']
    });
    expect(data.gaps).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'retired', url: alphaRetired }),
        expect.objectContaining({ kind: 'chain-locator', url: alphaChain })
    ]));
    expect(data.routes.some((r) => r.url === alphaRetired || r.url === alphaChain)).toBe(false);
});
test('a planned deployment observer is visible without adding it to the live scheduler', () => {
    const input = fixture();
    input.research.products[0].deployments = [{ network: 'Ethereum', address: '0x1111111111111111111111111111111111111111', identityCheckedAt: '2026-09-30' }];
    input.registration.entries.push({ entrypoint: 'rwa/watch-deployments.mjs', active: false, schedule: { cron: '11 * * * *' } });
    const data = build(input);
    expect(data.jobs.find((job) => job.id === 'rwa-watch-deployments')).toMatchObject({ state: 'prepared', cadenceHours: 1 });
    expect(data.routes.find((route) => route.jobId === 'rwa-watch-deployments')).toMatchObject({ state: 'prepared', issuerIds: ['product:ustb'] });
    expect(input.apps.some((app) => app.name === 'rwa-watch-deployments')).toBe(false);
});

test('document observations retain source-specific timestamps and outcomes', () => {
    const sourceUrl = 'https://alpha.example/terms.pdf';
    const observedAt = '2026-09-29T18:42:00.000Z';
    const data = build(fixture({ sourceState: { [sourceUrl]: { lastCheckedAt: observedAt, status: 'reachable' } } }));
    expect(data.routes.find((r) => r.jobId === 'rwa-watch' && r.url === sourceUrl)).toMatchObject({ observedAt, outcome: 'reachable' });
});

test('metadata fetches are conditional and corporate actions use listing-aware Yahoo symbols', () => {
    const data = build(fixture({ tokens: [
        { issuer: 'prestocks', underlyingTicker: 'BRK.B', instrumentType: 'equity', metadataUri: 'https://meta.example/a.json' },
        { issuer: 'tessera', underlyingTicker: '0700', instrumentType: 'equity', issuerApi: { listingCountry: 'HK' }, metadataUri: 'https://meta.example/a.json' },
        { issuer: 'prestocks', underlyingTicker: 'BAD!', instrumentType: 'equity' },
        { issuer: 'prestocks', underlyingTicker: 'NVDA', instrumentType: 'leveraged' }
    ] }));
    const metadata = data.routes.filter((r) => r.label === 'Token metadata candidate');
    expect(metadata).toHaveLength(1);
    expect(metadata[0]).toMatchObject({ state: 'conditional', issuerIds: ['prestocks', 'tessera'], cadenceHours: 24 });
    expect(metadata[0].note).toContain('at most');
    expect(data.routes.find((r) => r.label === 'BRK-B splits & dividends')).toBeDefined();
    expect(data.routes.find((r) => r.label === '0700.HK splits & dividends')).toBeDefined();
    expect(data.routes.some((r) => r.label === 'BAD! splits & dividends' || r.label === 'NVDA splits & dividends')).toBe(false);
});

test('unknown PM2 missions and refresh collectors fail closed; inventory never serializes process secrets', () => {
    expect(() => build(fixture({ apps: [...fixture().apps, { name: 'mystery-worker' }] }))).toThrow('Missing mission description for mystery-worker');
    expect(() => build(fixture({ refreshScript: 'node stocks/fetch-unlisted.mjs' }))).toThrow('Refresh collector missing from mission map: stocks/fetch-unlisted.mjs');
    const data = build(fixture({ apps: fixture().apps.map((a) => ({ ...a, node_args: '--env-file=/private/keys/prod.env', env: { API_KEY: 'do-not-publish' } })) }));
    expect(JSON.stringify(data)).not.toContain('prod.env');
    expect(JSON.stringify(data)).not.toContain('do-not-publish');
});

test('collector scopes follow retained eligible targets and preserve account cadence and pinned pools', () => {
    const alphaMint = 'MintAlpha';
    const betaMint = 'MintBeta';
    const input = fixture({
        tokens: [
            { issuer: 'prestocks', mint: alphaMint, symbol: 'ALPHA', underlyingTicker: 'AAA' },
            { issuer: 'tessera', mint: betaMint, symbol: 'BETA', underlyingTicker: 'BBB' }
        ],
        protocolResearch: { oraclePricing: { markets: [
            { id: 'kamino-main:oracle', protocolId: 'kamino', marketAddress: 'market-alpha', collateral: [
                { mint: alphaMint, symbol: 'ALPHA', reserve: 'reserve-alpha' }
            ] },
            { id: 'nest-main', protocolId: 'nest', collateral: [
                { mint: alphaMint, collateralConfig: 'nest-config-alpha' }
            ] }
        ] } },
        defi: { items: [{ mint: alphaMint, symbol: 'ALPHA', integrations: [{ protocolId: 'loopscale', category: 'lending', markets: [
            { loanAddress: 'loopscale-loan-alpha', configuration: { marketInformation: 'loop-market' } }
        ] }] }] },
        venues: { items: [
            { mint: alphaMint, symbol: 'ALPHA', issuer: 'prestocks', dex: [
                { pairAddress: 'pool-alpha-top', dexId: 'raydium', volume24Usd: 1000, quoteSymbol: 'USDC' },
                { pairAddress: 'meteora-alpha', dexId: 'meteora', volume24Usd: 20, quoteSymbol: 'USDC' }
            ] },
            { mint: betaMint, symbol: 'BETA', issuer: 'tessera', dex: [
                { pairAddress: 'pool-beta-pinned', dexId: 'raydium', volume24Usd: 1, quoteSymbol: 'USDC' },
                { pairAddress: 'meteora-beta', dexId: 'raydium', volume24Usd: 2, quoteSymbol: 'USDC' }
            ] }
        ] },
        apps: fixture().apps.map((app) => app.name === 'rwa-trades'
            ? { ...app, args: '--every=3600 --pools=1 --pin=pool-beta-pinned' }
            : app.name === 'rwa-watch-lending' ? { ...app, cron_restart: '0 * * * *' } : app)
    });
    const data = build(input);
    const routesFor = (jobId) => data.routes.filter((route) => route.jobId === jobId);

    for (const jobId of ['rwa-watch-lending', 'lender-history', 'solana-depth', 'meteora-pools']) {
        expect(routesFor(jobId).length).toBeGreaterThan(0);
        expect(routesFor(jobId).every((route) => route.issuerIds.includes('prestocks'))).toBe(true);
        expect(routesFor(jobId).some((route) => route.issuerIds.includes('tessera'))).toBe(false);
    }
    expect(routesFor('lender-history').find((route) => route.label === 'Hourly reserve history for lender-accepted tokens'))
        .toMatchObject({ scope: 'per-reserve', issuerIds: ['prestocks'], units: 1 });
    expect(routesFor('solana-depth').find((route) => route.label === 'Jupiter depth quotes per supported token'))
        .toMatchObject({ scope: 'per-token', state: 'conditional', issuerIds: ['prestocks'], units: 1 });
    expect(routesFor('meteora-pools').find((route) => route.label === 'Read candidate Meteora pool state'))
        .toMatchObject({ scope: 'per-pool', state: 'conditional', issuerIds: ['prestocks'], units: 1 });

    const nest = routesFor('rwa-watch-lending').find((route) => route.label.includes('nest-config-alpha'));
    const loopscale = routesFor('rwa-watch-lending').find((route) => route.label.includes('loopscale-loan-alpha'));
    expect(nest).toMatchObject({ cadenceHours: 6, issuerIds: ['prestocks'] });
    expect(loopscale).toMatchObject({ cadenceHours: 6, issuerIds: ['prestocks'] });
    expect(routesFor('rwa-watch-lending').every((route) => route.cadenceHours === 1 || route.cadenceHours === 6)).toBe(true);

    const sampledTradePools = routesFor('rwa-trades').filter((route) => route.unit === 'sampled pool');
    expect(sampledTradePools.map((route) => route.label)).toEqual([
        'ALPHA · raydium · pool-alpha-top', 'BETA · raydium · pool-beta-pinned'
    ]);
    expect(sampledTradePools.map((route) => route.issuerIds)).toEqual([
        ['prestocks'], ['tessera']
    ]);
});

test('digest run fields map to job outcome and preserve missing completion times', () => {
    const statsFile = '.last-watch-digest-stats.json';
    const completedAt = '2026-09-30T22:50:00.000Z';
    const completed = build(fixture({ stats: { [statsFile]: { startedAt: '2026-09-30T22:49:00.000Z', finishedAt: completedAt,
        ok: false, failed: 2, configured: true } } })).jobs.find((job) => job.id === 'rwa-watch-digest');
    expect(completed).toMatchObject({ observedAt: completedAt, outcome: 'failed', failures: 2 });

    const notConfigured = build(fixture({ stats: { [statsFile]: { startedAt: '2026-09-30T22:49:00.000Z', finishedAt: null,
        ok: true, failed: 0, configured: false } } })).jobs.find((job) => job.id === 'rwa-watch-digest');
    expect(notConfigured).toMatchObject({ observedAt: null, outcome: 'delivery not configured', failures: 0 });
});
