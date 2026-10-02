// Build the public mission inventory from local scheduler, research and watcher registries.
// Routes describe independently scoped work, not measured HTTP request totals or live flights.
import { createHash } from 'node:crypto';
import { buildRegistry, addResearchSources, applyRetirements, isDocumentWatchable, normaliseUrl } from '../../stocks/lib/sources.mjs';
import { deriveQueries, courtListenerUrl, SEC_FEEDS } from '../../stocks/lib/caselaw.mjs';
import { deriveEntities, watchTasks, GLEIF_API, ZEFIX_API, COMPANIES_HOUSE_API, GAZETTE } from '../../stocks/lib/entities.mjs';
import { SOURCES as REGULATORS, NOT_FEASIBLE, deriveWatchNames, brokerCheckNames } from '../../stocks/lib/regulators.mjs';
import { yahooSymbolFor } from '../../stocks/lib/corporate-actions.mjs';
import { METADATA_LIMIT } from '../../stocks/lib/chainwatch.mjs';
import { METEORA_ENDPOINTS, selectMeteoraPools } from '../../stocks/lib/meteora.mjs';
import { buildWatchList, LIST_EVERY_HOURS } from '../../stocks/lib/lending-events.mjs';
import { kaminoReserves } from '../../stocks/lib/lender-gaps.mjs';
import { lenderMints } from '../../stocks/lib/solana-depth.mjs';
import { selectPools } from '../../stocks/lib/trades.mjs';
import { equitySymbolForTicker } from '../../stocks/lib/pyth.mjs';
import { JOBS, REFRESH, SPONSOR_SOURCES, DEFI_SOURCES, cronHours } from './monitoring-jobs.mjs';

const aliases = { 'backpack-securities-spcx': 'backpack-securities', 'bullish-blsh': 'bullish', 'securitize-secz': 'securitize' };
const issuerId = (id) => aliases[id] || id;
const unique = (values) => [...new Set(values.filter(Boolean))].sort();
const keyOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const num = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const SHORT_NAMES = {
    'backpack-securities': 'Backpack', bullish: 'Bullish', 'ondo-global-markets': 'Ondo Global Markets', prestocks: 'PreStocks',
    'remora-markets': 'Remora', 'republic-mirror': 'Republic Mirror', securitize: 'Securitize SECZ', shift: 'Shift',
    'superstate-opening-bell': 'Superstate Opening Bell', tessera: 'Tessera', ventuals: 'Ventuals', 'xstocks-backed': 'xStocks'
};
const HOST_LABELS = {
    'sec.gov': 'SEC', 'efts.sec.gov': 'SEC EDGAR', 'courtlistener.com': 'CourtListener', 'api.gleif.org': 'GLEIF',
    'zefix.ch': 'Zefix', 'thegazette.co.uk': 'The Gazette', 'api.company-information.service.gov.uk': 'Companies House',
    'api.brokercheck.finra.org': 'FINRA BrokerCheck', 'finra.org': 'FINRA', 'fca.org.uk': 'FCA', 'finma.ch': 'FINMA',
    'api.xstocks.fi': 'xStocks', 'api.superstate.com': 'Superstate', 'app.ondo.finance': 'Ondo',
    'api.backpack.exchange': 'Backpack', 'prestocks.com': 'PreStocks', 'rest-api.tessera.pe': 'Tessera',
    'hermes.pyth.network': 'Pyth', 'api.coingecko.com': 'CoinGecko', 'api.dexscreener.com': 'DexScreener',
    'pro-api.coinmarketcap.com': 'CoinMarketCap', 'query1.finance.yahoo.com': 'Yahoo Finance',
    'api.kamino.finance': 'Kamino', 'api.jup.ag': 'Jupiter', 'lite-api.jup.ag': 'Jupiter quotes',
    'docs.nestusd.com': 'Nest', 'ai.0.xyz': 'Project 0', 'api.save.finance': 'Save', 'tars.loopscale.com': 'Loopscale',
    'dlmm.datapi.meteora.ag': 'Meteora', 'web.archive.org': 'Internet Archive', 'api.anthropic.com': 'Anthropic', 'api.telegram.org': 'Telegram',
    'xstocks-metadata.backed.fi': 'xStocks metadata', 'metadata.backpack.exchange': 'Backpack metadata', 'notion.so': 'Notion API', 'archive.ph': 'Archive.today index'
};

export function buildMonitoringInventory(input, generatedAt) {
    if (!generatedAt || !Number.isFinite(Date.parse(generatedAt))) throw new Error('A valid inventory build time is required');
    const { apps, dossiers, research, canonical = [], retirements = { items: [] }, extra = {},
        entityRegistry = { entities: [] }, tokens = [], defi = { items: [] }, registration = { entries: [] },
        protocolResearch = null, venues = null, referencePrices = null, pythOnchain = null,
        monitorPlan = null, sourceState = {}, sourceAudit = null, stats = {}, refreshScript = '' } = input;
    if (!dossiers?.length || !research?.products?.length) throw new Error('Issuer dossiers and cross-asset research are required');
    const issuers = dossiers.map(({ slug, dossier }) => ({ id: issuerId(slug), label: SHORT_NAMES[issuerId(slug)] || dossier.issuer.split(/[;(]/)[0].trim(),
        kind: 'programme', assetClass: 'Tokenized stocks', href: `issuers/${issuerId(slug)}.html` }));
    for (const product of research.products) issuers.push({ id: `product:${product.id}`, label: product.name, shortLabel: product.ticker || product.name,
        kind: 'product', assetClass: product.exposure?.label || 'Real-world asset', href: 'assets.html' });
    const stockIds = issuers.filter((i) => i.kind === 'programme').map((i) => i.id);
    const allIds = issuers.map((i) => i.id), issuerSet = new Set(allIds);
    const mapIds = (ids) => unique(ids.map(issuerId)).filter((id) => issuerSet.has(id));
    const jobs = [], routes = [], sources = new Map(), gaps = [];
    const preparedScripts = new Set(registration.entries.filter((e) => e.active === false || registration.active === false).map((e) => e.entrypoint.split(' ')[0]));
    const addJob = (id, opts = {}) => {
        if (jobs.some((j) => j.id === id)) return jobs.find((j) => j.id === id);
        const metadata = JOBS[id], app = apps.find((a) => a.name === id);
        if (!metadata && !opts.label) throw new Error(`Missing mission description for ${id}`);
        const [label, category, description, script, statsFile] = metadata || [];
        const record = stats[statsFile] || null;
        const digest = id === 'rwa-watch-digest';
        const observedAt = digest ? record?.finishedAt : record?.lastRunEndedAt;
        const outcome = digest ? !record ? null : record.configured === false ? 'delivery not configured' : record.ok === true ? 'ok' : record.ok === false ? 'failed' : null
            : record?.watchStatus || record?.refreshStatus;
        const job = { id, label, category, description, script, cadenceHours: app?.cron_restart ? cronHours(app.cron_restart) :
            id === 'rwa-trades' ? Number(app?.args?.match(/--every=(\d+)/)?.[1] || 0) / 3600 || null : null,
            cron: app?.cron_restart || null, state: 'configured', parentId: null, observedAt: observedAt || null,
            outcome: outcome || null, failures: num(digest ? record?.failed : record?.failures), ...opts };
        if (id === 'rwa-watch-deployments') job.state = preparedScripts.has(script) || registration.active !== true ? 'prepared' : 'configured';
        if (id === 'rwa-watch-digest') job.state = 'conditional';
        jobs.push(job); return job;
    };
    for (const app of apps) addJob(app.name);
    for (const spec of REFRESH) addJob(spec.id, { ...spec, cadenceHours: spec.hours, parentId: 'rwa-refresh', cron: null });
    // A new collector in the refresh must be given a mission; silently dropping it would make the map misleading.
    const coveredScripts = new Set(REFRESH.map((s) => s.script));
    for (const [, script] of refreshScript.matchAll(/node (stocks\/fetch-[\w-]+\.mjs)/g)) {
        if (!coveredScripts.has(script)) throw new Error(`Refresh collector missing from mission map: ${script}`);
    }
    const preparedSchedule = (part, fallback) => registration.entries.find((e) => e.entrypoint.includes(part))?.schedule?.cron || fallback;
    if (!jobs.some((job) => job.id === 'rwa-watch-deployments') && research.products.some((product) =>
        product.deployments?.some((deployment) => deployment.identityCheckedAt && ['Ethereum', 'Solana'].includes(deployment.network)))) addJob('rwa-watch-deployments', {
        state: 'prepared', cron: preparedSchedule('watch-deployments', null), cadenceHours: cronHours(preparedSchedule('watch-deployments', null))
    });
    addJob('rwa-watch-sources', { state: 'prepared', cron: preparedSchedule('--rwa', null), cadenceHours: registration.entries.some((e) => e.entrypoint.includes('--rwa')) ? cronHours(preparedSchedule('--rwa')) : null });
    if (monitorPlan?.products?.some((p) => p.fundData)) addJob('rwa-watch-fund-data', {
        state: 'prepared', cron: preparedSchedule('watch-fund-data', null), cadenceHours: preparedSchedule('watch-fund-data', null) ? cronHours(preparedSchedule('watch-fund-data')) : null
    });

    function addRoute(jobId, url, label, issuerIds, opts = {}) {
        const job = jobs.find((j) => j.id === jobId);
        if (!job) throw new Error(`Unknown mission ${jobId}`);
        let host, normalized = url ? normaliseUrl(url) : null;
        if (url && !normalized) throw new Error(`Invalid public source URL for ${jobId}`);
        host = normalized ? new URL(normalized).hostname.replace(/^www\./, '') : opts.sourceId;
        const sourceId = opts.sourceId || host;
        if (!sourceId) throw new Error(`Missing source identity for ${jobId}`);
        const category = opts.category || job.category;
        if (!sources.has(sourceId)) sources.set(sourceId, { id: sourceId, host, label: opts.sourceLabel || HOST_LABELS[host] || host, category });
        const route = { id: keyOf(`${jobId}|${sourceId}|${opts.key || normalized || label}`), jobId, sourceId, url: normalized,
            label, category, issuerIds: mapIds(issuerIds), cadenceHours: job.cadenceHours, state: job.state,
            scope: 'shared', units: null, unit: null, note: null, observedAt: null, outcome: null, ...opts };
        delete route.key; delete route.sourceLabel;
        if (routes.some((r) => r.id === route.id)) throw new Error(`Duplicate mission route: ${jobId} ${label}`);
        routes.push(route); return route;
    }
    const chain = (job, ids, options = {}) => addRoute(job, null, options.label || 'Solana RPC', ids, {
        sourceId: 'chain:solana', sourceLabel: 'Solana', scope: 'per-token', note: 'A read-only collection scope; RPC calls may batch several accounts.', ...options
    });

    const registry = buildRegistry([...dossiers.map((d) => ({ slug: d.slug, doc: d.dossier })), { slug: null, doc: canonical }], { generatedAt });
    const combined = addResearchSources(registry.items, research, { generatedAt });
    const { items } = applyRetirements(combined.items, retirements.items);
    const auditRows = (sourceAudit?.products || []).flatMap((p) => p.sources || []);
    for (const source of items) {
        const stockScope = mapIds(source.foundIn.filter((s) => !s.startsWith('product=')).map((s) => s.split(':')[0]));
        const productScope = unique(source.foundIn.filter((s) => s.startsWith('product=')).map((s) => `product:${decodeURIComponent(s.slice(8).split('|')[0])}`));
        if (source.retired || !isDocumentWatchable(source.url)) {
            gaps.push({ kind: source.retired ? 'retired' : 'chain-locator', label: source.title, url: source.url,
                issuerIds: [...stockScope, ...productScope], reason: source.retired?.reason || 'An on-chain locator, not fetched by the document watcher.' });
            continue;
        }
        const state = sourceState[source.url], audit = auditRows.find((r) => normaliseUrl(r.url) === source.url);
        const common = { observedAt: state?.lastCheckedAt || audit?.checkedAt || null,
            outcome: state?.status || audit?.status || null, units: 1, unit: 'document',
            note: 'One task per normalized source URL, retaining all citations. Retries, pagination and publisher or archive readers can make additional requests.' };
        // The broad product plan is explicitly inactive; shared stock citations still retain the
        // daily mission. The additional cross-asset scope remains a separate, prepared mission.
        if (stockScope.length || !productScope.length) addRoute('rwa-watch', source.url, source.title, stockScope, common);
        if (productScope.length) addRoute('rwa-watch-sources', source.url, source.title, productScope, { ...common, state: 'prepared' });
    }
    const tokenCounts = new Map(stockIds.map((id) => [id, tokens.filter((t) => issuerId(t.issuer) === id).length]));
    const stocked = stockIds.filter((id) => tokenCounts.get(id) > 0);
    const stockScope = tokens.length ? stocked : stockIds;
    const tokenByMint = new Map(tokens.filter((t) => t.mint).map((t) => [t.mint, t]));
    const mintIssuers = (rows) => mapIds((rows || []).map((row) => tokenByMint.get(row.mint)?.issuer || row.issuer));
    const lendingAccounts = buildWatchList({ research: protocolResearch, defiUsage: defi, tokens }).accounts;
    const lendingIds = mintIssuers(lendingAccounts);
    const reserves = kaminoReserves(protocolResearch?.oraclePricing);
    const depthTargets = lenderMints(protocolResearch?.oraclePricing, defi);
    const depthIds = mintIssuers(depthTargets), reserveIds = mintIssuers(reserves);
    const meteoraPools = selectMeteoraPools(venues), meteoraIds = mintIssuers(meteoraPools);
    const tradeArgs = apps.find((app) => app.name === 'rwa-trades')?.args || '';
    const tradePools = selectPools(venues, Number(tradeArgs.match(/--pools=(\d+)/)?.[1] || 15),
        { pin: [...tradeArgs.matchAll(/--pin=([^\s]+)/g)].map((match) => match[1]) });
    const tradeIds = mintIssuers(tradePools);
    const pythTargets = [...(referencePrices?.items || []).filter((row) => row.pythFeedId && equitySymbolForTicker(row.underlyingTicker)),
        ...(pythOnchain?.tokens || []).filter((row) => row.stockFeedId || row.tokenFeedId)];
    for (const jobId of ['rwa-watch-chain', 'rwa-watch-powers', 'mint-snapshot', 'identity-snapshot', 'holder-snapshot', 'defi-footprint', 'mint-created']) {
        chain(jobId, stockScope, { label: jobs.find((j) => j.id === jobId).description,
            units: ['rwa-watch-chain', 'mint-snapshot', 'holder-snapshot'].includes(jobId) && tokens.length ? tokens.length : null,
            unit: 'catalogued mints', ...(jobId === 'mint-created' ? { state: 'conditional' } : {}),
            note: jobId === 'defi-footprint' ? 'Fresh holder snapshots are reused. Direct RPC scans rotate through nonzero-supply tokens within the run budget to find previously unlisted integrations.' : jobs.find((j) => j.id === jobId).description });
    }
    const emptyTargets = (jobId, note) => chain(jobId, [], { state: 'conditional', note,
        label: `${jobs.find((j) => j.id === jobId).label}: target inventory unavailable or empty` });
    if (!lendingAccounts.length) emptyTargets('rwa-watch-lending', 'No eligible lending accounts are identifiable in the retained token, market and DeFi inputs.');
    for (const account of lendingAccounts) chain('rwa-watch-lending', account.mint ? mintIssuers([account]) : lendingIds, {
        key: account.account, label: `${account.protocol} · ${account.role} · ${account.account}`, scope: account.mint ? 'per-account' : 'shared',
        cadenceHours: LIST_EVERY_HOURS[account.role] || jobs.find((j) => j.id === 'rwa-watch-lending').cadenceHours,
        units: 1, unit: 'watched account', note: 'Account selected by the lending watcher’s own registry. Quiet Nest and Loopscale accounts are listed every six hours; transaction reads depend on new signatures and the run budget.'
    });
    if (!tradePools.length) emptyTargets('rwa-trades', 'No eligible pools are identifiable without a retained venue inventory. The job samples the busiest pools plus configured pins.');
    for (const pool of tradePools) chain('rwa-trades', mintIssuers([pool]), { key: pool.pair, scope: 'per-pool',
        label: `${pool.symbol || pool.mint} · ${pool.dex || 'DEX'} · ${pool.pair}`, units: 1, unit: 'sampled pool',
        note: 'In the sample selected from retained 24-hour volume and configured pins. Ranking is recalculated each run; signature and transaction reads are bounded.' });
    chain('meteora-pools', meteoraIds, { label: 'Read candidate Meteora pool state', state: 'conditional', scope: 'per-pool',
        units: venues ? meteoraPools.length : null, unit: 'candidate pools', note: 'Only Meteora pools in the retained venue registry qualify. Direct chain reads are used when the pool type requires them.' });
    chain('pyth-chain', mintIssuers(pythTargets), { label: 'Read matched Pyth push-oracle accounts', scope: 'per-feed', state: 'conditional',
        units: referencePrices || pythOnchain ? new Set(pythTargets.map((row) => row.mint)).size : null, unit: 'tokens with retained feed matches',
        note: 'Issuer scope comes from retained equity feed matches and the last token-feed match set. The shared daily crypto directory may identify new matches on a later run.' });
    // Metadata reads are conditional: the hourly watcher selects un-hashed or changed URIs.
    const metadata = new Map();
    for (const token of tokens) if (token.metadataUri && normaliseUrl(token.metadataUri)) {
        const ids = metadata.get(token.metadataUri) || []; ids.push(token.issuer); metadata.set(token.metadataUri, ids);
    }
    for (const [url, ids] of metadata) addRoute('rwa-watch-chain', url, 'Token metadata candidate', ids, { scope: 'per-token', state: 'conditional', category: 'documents',
        note: `Fetched only when never hashed or when the metadata URI changes; the hourly job reads at most ${METADATA_LIMIT} metadata documents per run.` });
    chain('rwa-redemptions', ['ondo-global-markets'], { key: 'ondo', label: 'Ondo creations and redemption burns' });
    chain('rwa-redemptions', ['xstocks-backed'], { key: 'xstocks', label: 'xStocks de-activation deposits' });
    chain('rwa-redemptions', ['superstate-opening-bell'], { key: 'superstate', label: 'Superstate token-to-book conversions' });
    chain('xstocks-float', ['xstocks-backed'], { label: 'Labelled xStocks issuer inventory' });
    addRoute('rwa-trades', 'https://api.dexscreener.com/latest/dex/pairs/solana/', 'Price non-stable quote assets for sampled trades', tradeIds,
        { category: 'markets', state: 'conditional', scope: 'per-pool', note: 'A pair lookup is needed only when a sampled pool’s quote asset is not a stablecoin.' });
    for (const [id, label, url] of SPONSOR_SOURCES) addRoute('sponsor-registries', url, `${label} official token registry`, [id], { scope: 'issuer-specific' });
    for (const [id, label, url] of SPONSOR_SOURCES.filter((s) => s[2].includes('proof-of-reserves') || s[0] === 'superstate-opening-bell')) {
        addRoute('rwa-watch-reserves', url, `${label} published reserves / register`, [id], { scope: 'issuer-specific' });
        chain('rwa-watch-reserves', [id], { key: id, label: `${label}: chain supply reconciliation` });
    }
    const publicQuery = (job, url, label, ids, opts = {}) => addRoute(job, url, label, ids, { scope: 'per-entity', ...opts });
    const queries = deriveQueries(dossiers, { extra }).queries;
    for (const query of queries) {
        if (query.kind === 'docket') publicQuery('rwa-watch-caselaw', courtListenerUrl(query), `Known docket: ${query.name || query.docketNumber}`, query.issuers);
        else for (const type of ['r', 'o']) publicQuery('rwa-watch-caselaw', courtListenerUrl({ kind: 'search', type, phrase: query.phrase }),
            `${query.phrase} · ${type === 'r' ? 'court dockets' : 'opinions'}`, query.issuers,
            { note: 'Each distinct legal-name query is searched separately; a name shared by issuers is deduplicated.' });
    }
    for (const feed of SEC_FEEDS) addRoute('rwa-watch-caselaw', feed.url, feed.label, stockIds, { note: 'Read once; match the feed locally against all watched names.' });
    addRoute('rwa-watch-caselaw', 'https://www.courtlistener.com/api/rest/v4/search/?type=rd', 'Follow-up docket entries', stockIds,
        { key: 'entry-checks', state: 'conditional', scope: 'per-docket', note: 'Up to 30 retained dockets per run, including confirmed cases; actual targets depend on prior results.' });
    const names = deriveWatchNames(dossiers, { extra });
    for (const source of REGULATORS) {
        const jobId = source.cadence === 'hourly' ? 'rwa-watch-regulators-fca' : 'rwa-watch-regulators';
        if (source.requests) {
            for (const req of source.requests({ names, today: generatedAt.slice(0, 10), windowDays: 30 })) publicQuery(jobId, req.url, `${source.regulator}: ${req.name.phrase}`, req.name.issuers);
        } else if (source.twoStage) {
            for (const name of brokerCheckNames(names)) publicQuery(jobId, source.url, `${source.regulator}: ${name.phrase}`, name.issuers,
                { key: name.canonical, note: 'One name search; matching firm CRDs are then read once each across the run.' });
        } else addRoute(jobId, source.url, source.label, stockIds, { note: 'Shared feed or paginated list, fetched once then matched locally to watched legal names.' });
    }
    const entries = new Map(entityRegistry.entities.map((e) => [e.key, e]));
    const entityProviders = { gleif: [GLEIF_API, 'GLEIF'], zefix: [ZEFIX_API, 'Zefix'], gazette: [GAZETTE, 'The Gazette'], 'companies-house': [COMPANIES_HOUSE_API, 'Companies House'] };
    for (const entity of deriveEntities(dossiers, { canonical }).entities) {
        const entry = entries.get(entity.key);
        const tasks = watchTasks({ ...entry, issuers: entity.issuers }, { companiesHouseKey: true });
        if (!tasks.length) gaps.push({ kind: 'unresolved-entity', label: entity.name, issuerIds: mapIds(entity.issuers), reason: 'No accepted registry identifier is available for this entity.' });
        for (const task of tasks) publicQuery('rwa-watch-entities', entityProviders[task.source][0], `${entity.name} · ${entityProviders[task.source][1]}`, entity.issuers,
            { key: task.id, state: task.source === 'companies-house' ? 'conditional' : 'configured',
                note: task.source === 'companies-house' ? 'Requires a Companies House API key; key availability is not exposed by this inventory.' : `Accepted identifier ${task.identifier}. Additional parent / filing reads depend on provider results.` });
    }
    const tickers = new Map();
    for (const token of tokens) if (token.underlyingTicker && token.instrumentType !== 'leveraged') {
        const ticker = yahooSymbolFor(token).symbol;
        if (!ticker) continue;
        const ids = tickers.get(ticker) || []; ids.push(token.issuer); tickers.set(ticker, ids);
    }
    for (const [ticker, ids] of tickers) addRoute('rwa-watch-corporate-actions', `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`, `${ticker} splits & dividends`, ids,
        { scope: 'per-underlying', state: 'conditional', note: 'Candidate listing symbol. A run requires retained chain history and skips idle tokens unless their multiplier moved; a shared symbol is fetched once across wrappers.' });
    addRoute('rwa-watch-corporate-actions', 'https://query1.finance.yahoo.com/v8/finance/chart/', 'Splits & dividends for eligible underlying listings', stockIds,
        { scope: 'batch', note: 'The daily run selects listing symbols using stored multiplier history and circulation state. Individual candidate symbols below are conditional, not an observed run plan.' });

    const providerRoutes = [
        ['token-discovery', 'https://lite-api.jup.ag/tokens/v2/search', 'Jupiter token search'],
        ['cex-venues', 'https://api.coingecko.com/api/v3/coins/list?include_platform=true', 'CoinGecko coin directory'],
        ['dex-venues', 'https://api.dexscreener.com/tokens/v1/solana/', 'DexScreener token pools'],
        ['reference-prices', 'https://hermes.pyth.network/v2/price_feeds?asset_type=equity', 'Pyth equity feed directory'],
        ['reference-prices', 'https://hermes.pyth.network/v2/updates/price/latest', 'Pyth latest prices (entitlement required)'],
        ['cross-chain-market', 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/category', 'CoinMarketCap tokenized stocks (API key required)'],
        ['lender-history', 'https://api.kamino.finance/', 'Hourly reserve history for lender-accepted tokens'],
        ['solana-depth', 'https://lite-api.jup.ag/swap/v1/quote', 'Jupiter depth quotes per supported token'],
        ['solana-depth', 'https://lite-api.jup.ag/price/v3', 'Jupiter token prices'],
        ['pyth-chain', 'https://hermes.pyth.network/v2/price_feeds?asset_type=crypto', 'Pyth token feed directory (daily cache)']
    ];
    for (const [job, url, label] of providerRoutes) addRoute(job, url, label, job === 'lender-history' ? reserveIds : job === 'solana-depth' ? depthIds : stockScope, { scope: 'batch',
        ...(job === 'lender-history' ? { scope: 'per-reserve', units: protocolResearch ? reserves.length : null, unit: 'configured Kamino reserves' } : {}),
        ...(job === 'solana-depth' ? { state: 'conditional', scope: url.includes('/quote') ? 'per-token' : 'batch',
            units: protocolResearch ? depthTargets.length : null, unit: 'lender-accepted tokens' } : {}),
        ...(job === 'pyth-chain' ? { cadenceHours: 24 } : {}), note: jobs.find((j) => j.id === job).description });
    addRoute('cex-venues', 'https://api.coingecko.com/api/v3/', 'CoinGecko /coins/{id}/tickers', stockScope,
        { key: 'rotating-tickers', scope: 'per-token', note: 'The midnight pass allows at most 250 coin ticker lookups. Priority coins refresh daily; the remainder rotate across days.' });
    for (const [kind, endpoint] of Object.entries(METEORA_ENDPOINTS)) addRoute('meteora-pools', new URL(endpoint('')).origin, `Meteora ${kind} pool lookup`, meteoraIds,
        { state: 'conditional', scope: 'per-pool', note: 'The pool-type lookup ladder chooses this API only for candidate Meteora pools; addresses come from the retained pool registry.' });
    for (const [, label, url] of DEFI_SOURCES) addRoute('defi-registries', url, `${label} exact-token market registry`, stockScope,
        { note: 'A shared registry is scanned for catalogue mints; being checked does not mean a token is accepted by this protocol.' });
    for (const [key, label] of [['market-reserves', 'Kamino /kamino-market/{market}/reserves/metrics'], ['vault-metrics', 'Kamino /kvaults/{vault}/metrics']]) {
        addRoute('defi-registries', 'https://api.kamino.finance/', label, stockScope, { key, state: 'conditional', scope: 'per-market',
            note: 'A separate lookup for each relevant market or configured composite vault discovered by the registry pass.' });
    }
    addRoute('defi-footprint', 'https://api.kamino.finance/v2/kamino-market', 'Kamino market identities for footprint attribution', stockScope);
    addRoute('defi-footprint', 'https://lite-api.jup.ag/swap/v1/program-id-to-label', 'Jupiter program labels for footprint attribution', stockScope);
    chain('defi-registries', stockScope, { label: 'Corroborate DeFi registry matches on chain' });
    addRoute('rwa-watch', 'https://web.archive.org/', 'Archive changed documents / recover retained copies', stockIds,
        { key: 'archive', state: 'conditional', note: 'The configured document job enables archival. Capture / retrieval happens when needed, not once for every source every day.' });
    for (const jobId of ['rwa-watch', 'rwa-watch-sources']) {
        const documentRoutes = routes.filter((r) => r.jobId === jobId && r.scope === 'shared');
        const documentIds = unique(documentRoutes.flatMap((r) => r.issuerIds));
        const notionIds = unique(documentRoutes.filter((r) => r.url && /notion\.(site|so)/.test(new URL(r.url).hostname)).flatMap((r) => r.issuerIds));
        if (notionIds.length) addRoute(jobId, 'https://www.notion.so/api/v3/loadPageChunk', 'Read public Notion document blocks', notionIds,
            { state: jobId === 'rwa-watch-sources' ? 'prepared' : 'conditional', note: 'Secondary reader for public Notion pages, with cursor pagination when needed.' });
        addRoute(jobId, 'https://archive.ph/', 'Find a retained archive capture through its timemap', documentIds,
            { key: 'archive-timemap', state: jobId === 'rwa-watch-sources' ? 'prepared' : 'conditional',
                note: 'Optional archive timemap lookup when the primary document cannot be read. Archive.today content is linked rather than treated as a primary source.' });
    }
    const companionIds = unique(routes.filter((r) => r.jobId === 'rwa-watch' && r.url && /solscan\.io\/tx\//.test(r.url)).flatMap((r) => r.issuerIds));
    if (companionIds.length) chain('rwa-watch', companionIds, { key: 'document-transaction-reader', category: 'chain', state: 'conditional',
        label: 'Read transactions cited by explorer pages', note: 'The document companion reader can resolve cited Solscan transactions through read-only RPC.' });
    addRoute('rwa-judge', 'https://api.anthropic.com/v1/messages/batches', 'Model assessment of changed source text', allIds,
        { scope: 'batch', note: 'Only changed, unjudged documents are sent. A model assessment never decides whether evidence is included.' });
    addRoute('rwa-watch-digest', 'https://api.telegram.org/', 'Opted-in private watch digests', allIds,
        { note: 'Optional delivery service; only verified, enabled watches receive material-change digests.' });
    for (const id of ['rwa-watch', 'rwa-watch-caselaw', 'rwa-watch-entities', 'rwa-watch-corporate-actions', 'rwa-watch-regulators', 'rwa-watch-regulators-fca', 'rwa-watch-reserves', 'rwa-watch-powers']) {
        const app = apps.find((a) => a.name === id);
        if (!app || app.args?.includes('--no-telegram')) continue;
        const ids = unique(routes.filter((r) => r.jobId === id).flatMap((r) => r.issuerIds));
        addRoute(id, 'https://api.telegram.org/', 'Monitoring outcome summary', ids,
            { category: 'processing', key: 'outcome-summary', state: 'conditional', note: 'An optional run summary on relevant findings or failures, only when notification credentials are configured.' });
    }
    addRoute('rwa-refresh', null, 'Normalize → compare → validate → publish', allIds,
        { sourceId: 'sonar:reports', sourceLabel: 'Research & reports', scope: 'internal', note: 'Retained observations, explicit gaps and source links become reports and change feeds.' });
    addRoute('rwa-sonar-api', null, 'Website and read-only JSON API', allIds,
        { sourceId: 'sonar:website', sourceLabel: 'Website & API', scope: 'internal', note: 'Always available service; it serves retained data. A browser visit does not trigger external collection.' });

    const plans = new Map((monitorPlan?.products || []).map((p) => [p.productId, p]));
    for (const product of research.products) {
        const plan = plans.get(product.id), scope = [`product:${product.id}`];
        for (const deployment of product.deployments || []) {
            const supported = ['Ethereum', 'Solana'].includes(deployment.network) && deployment.identityCheckedAt;
            if (!supported) {
                gaps.push({ kind: 'deployment', label: `${product.name} · ${deployment.network}`, issuerIds: scope,
                    reason: !deployment.identityCheckedAt ? 'The exact deployment identity is not verified.' : 'No prepared observer for this network.' });
                continue;
            }
            addRoute('rwa-watch-deployments', null, `${product.ticker || product.name} · ${deployment.address}`, scope,
                { key: `${product.id}:${deployment.network}:${deployment.address}`, sourceId: `chain:${deployment.network.toLowerCase()}`,
                    sourceLabel: deployment.network, scope: 'per-deployment', units: 1, unit: 'identified deployment',
                    note: 'Prepared read-only observer. Conventional authority reads do not establish reserves, legal title or every governance power.' });
        }
        if (!(product.deployments || []).some((d) => d.identityCheckedAt && ['Ethereum', 'Solana'].includes(d.network))) gaps.push({
            kind: 'coverage', label: product.name, issuerIds: scope, reason: 'Document research is available; no identified deployment has a prepared chain observer.' });
        if (plan?.fundData) {
            const url = product.id === 'ustb' ? 'https://api.superstate.com/v2/instruments' : null;
            addRoute('rwa-watch-fund-data', url, `${product.ticker} ${product.id === 'ustb' ? 'official instrument registry' : 'Chainlink NAV oracle'}`, scope,
                { key: product.id, ...(url ? {} : { sourceId: 'chain:ethereum', sourceLabel: 'Ethereum' }),
                    scope: 'issuer-specific', note: 'Prepared, inactive read. NAV and supply observations do not verify reserves or guarantee liquidity.' });
        }
    }
    for (const row of NOT_FEASIBLE.filter((r) => !r.reason.includes('already polled'))) gaps.push({ kind: 'unpolled', label: row.regulator, issuerIds: stockIds, reason: row.reason });
    const output = { schemaVersion: 1, generatedAt, basis: 'Repository configuration and retained local observations; production scheduler state has not been verified.',
        issuers: issuers.sort((a, b) => a.label.localeCompare(b.label)), jobs, sources: [...sources.values()], routes, gaps,
        registry: { citedUrls: items.length, documentUrls: items.filter((s) => isDocumentWatchable(s.url) && !s.retired).length,
            retiredUrls: items.filter((s) => s.retired).length, chainLocators: items.filter((s) => !isDocumentWatchable(s.url)).length },
        provenance: ['ecosystem.config.cjs', 'stocks/refresh-on-server.sh', 'stocks/data/issuers/', 'rwa/data/research.json',
            'stocks/data/entity-registry-ids.json', 'stocks/lib/regulators.mjs', 'rwa/monitor-registration.json'] };
    validateMonitoringInventory(output);
    return output;
}

export function validateMonitoringInventory(data) {
    for (const key of ['issuers', 'jobs', 'sources', 'routes']) {
        if (!Array.isArray(data[key])) throw new Error(`Missing ${key}`);
        if (new Set(data[key].map((row) => row.id)).size !== data[key].length) throw new Error(`Duplicate ${key} IDs`);
    }
    const jobs = new Set(data.jobs.map((r) => r.id)), sources = new Set(data.sources.map((r) => r.id)), issuers = new Set(data.issuers.map((r) => r.id));
    for (const route of data.routes) {
        if (!jobs.has(route.jobId) || !sources.has(route.sourceId) || route.issuerIds.some((id) => !issuers.has(id))) throw new Error(`Unresolved route ${route.id}`);
        if (!['configured', 'conditional', 'prepared'].includes(route.state)) throw new Error(`Invalid route state ${route.state}`);
        if (route.cadenceHours !== null && (!(route.cadenceHours > 0) || !Number.isFinite(route.cadenceHours))) throw new Error(`Invalid cadence ${route.id}`);
    }
    for (const job of data.jobs) if (!data.routes.some((r) => r.jobId === job.id)) throw new Error(`Mission has no source or internal route: ${job.id}`);
    return true;
}
