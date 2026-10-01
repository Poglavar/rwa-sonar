// Public descriptions of the existing collectors. Schedules come from PM2; refresh entries retain
// their checkpoint cadence. No endpoint is read from an environment variable or secret file.
export const JOBS = {
    'rwa-watch': ['Document scout', 'documents', 'Re-read cited documents, compare text and re-check quotations.', 'stocks/watch-sources.mjs', '.last-source-watch-stats.json'],
    'rwa-watch-chain': ['Chain patrol', 'chain', 'Read mint authorities, extensions, supply, metadata and labelled wallets.', 'stocks/watch-chain.mjs', '.last-chain-watch-stats.json'],
    'rwa-watch-powers': ['Authority tracker', 'chain', 'Find uses of issuer powers and changes to the multisigs behind them.', 'stocks/watch-powers.mjs', '.last-powers-watch-stats.json'],
    'rwa-trades': ['Trade recorder', 'markets', 'Decode swaps from a bounded sample of the busiest Solana pools.', 'stocks/fetch-recent-trades.mjs', '.last-trade-watch-stats.json'],
    'rwa-watch-lending': ['Lending patrol', 'defi', 'Observe collateral liquidations and price freezes at four lending protocols.', 'stocks/watch-lending.mjs', '.last-lending-watch-stats.json'],
    'rwa-redemptions': ['Redemption observer', 'chain', 'Scan Ondo burns, xStocks de-activation deposits and Superstate conversions.', 'stocks/observe-redemptions.mjs'],
    'rwa-watch-caselaw': ['Court scout', 'public', 'Search legal names and known dockets; send possible matches to review.', 'stocks/watch-caselaw.mjs', '.last-caselaw-watch-stats.json'],
    'rwa-watch-entities': ['Entity scout', 'public', 'Check accepted company and LEI identifiers, parent records and insolvency notices.', 'stocks/watch-entities.mjs', '.last-entities-watch-stats.json'],
    'rwa-watch-corporate-actions': ['Corporate-action tracker', 'markets', 'Compare share splits and dividends with token multiplier changes.', 'stocks/watch-corporate-actions.mjs', '.last-corporate-actions-watch-stats.json'],
    'rwa-watch-regulators': ['Regulator scout', 'public', 'Read daily regulator feeds and search watched legal names.', 'stocks/watch-regulators.mjs', '.last-regulators-watch-stats.json'],
    'rwa-watch-regulators-fca': ['FCA warning patrol', 'public', 'Read the short FCA warning feed hourly before older notices disappear.', 'stocks/watch-regulators.mjs', '.last-regulators-watch-stats-fca-warnings.json'],
    'rwa-watch-reserves': ['Reserve observer', 'issuer', 'Compare published xStocks and Superstate figures with observed Solana supply.', 'stocks/watch-reserves.mjs', '.last-reserves-watch-stats.json'],
    'rwa-judge': ['Change analyst', 'processing', 'Batch-assess changed documents, retain the diff and record cost per item.', 'stocks/judge-changes.mjs'],
    'rwa-watch-digest': ['Watch courier', 'processing', 'Deliver material changes to opted-in saved watches at their chosen hour.', 'api/src/jobs/run-watch-digests.js', '.last-watch-digest-stats.json'],
    'rwa-refresh': ['Report builder', 'processing', 'Collect, join, validate and publish the catalogue, reports and change feeds.', 'stocks/refresh-on-server.sh', '.last-refresh-stats.json'],
    'rwa-sonar-api': ['Website & API', 'processing', 'Serve retained research, observations and change history from RWA Sonar.', 'api/src/server.js'],
    'rwa-watch-deployments': ['Cross-asset chain patrol', 'chain', 'Read source-identified Ethereum and Solana deployments at finalized blocks.', 'rwa/watch-deployments.mjs', '.last-rwa-deployment-watch-stats.json'],
    'rwa-watch-sources': ['Cross-asset document scout', 'documents', 'Re-read cross-asset sources with stricter checks for substantive content.', 'stocks/watch-sources.mjs', '.last-source-watch-stats-rwa.json'],
    'rwa-watch-fund-data': ['Fund-data observer', 'issuer', 'Read the USTB instrument registry and the identified USTBL NAV oracle.', 'rwa/watch-fund-data.mjs', '.last-rwa-fund-watch-stats.json']
};

// A sub-mission is a distinct collection step inside rwa-refresh, not an extra scheduled daemon.
export const REFRESH = [
    { id: 'sponsor-registries', label: 'Issuer registry scout', category: 'issuer', script: 'stocks/fetch-sponsor-apis.mjs', hours: 24, description: 'Official issuer registries; daily checkpoints are reused in the other refreshes.' },
    { id: 'token-discovery', label: 'Token discovery', category: 'markets', script: 'stocks/fetch-universe.mjs', hours: 24, description: 'Search Jupiter for candidates and admit only issuer-corroborated token identities.' },
    { id: 'mint-snapshot', label: 'Mint snapshot', category: 'chain', script: 'stocks/fetch-onchain.mjs', hours: 24, description: 'Read the discovered catalogue’s mint state with daily checkpoints.' },
    { id: 'identity-snapshot', label: 'Identity corroboration', category: 'chain', script: 'stocks/fetch-onchain.mjs', hours: 24, description: 'A separate chain pass over exact addresses from issuer identity registries.' },
    { id: 'cex-venues', label: 'Exchange scout', category: 'markets', script: 'stocks/fetch-venues.mjs', hours: 24, description: 'A quota-capped midnight CoinGecko pass; tail tokens rotate across days.' },
    { id: 'dex-venues', label: 'DEX scout', category: 'markets', script: 'stocks/fetch-venues.mjs', hours: 6, description: 'Pool liquidity, volume and venue activity from DexScreener.' },
    { id: 'holder-snapshot', label: 'Holder sampler', category: 'chain', script: 'stocks/fetch-holders.mjs', hours: 24, description: 'Top-20 token accounts, their owners and concentration; accounts are not people.' },
    { id: 'xstocks-float', label: 'Float observer', category: 'chain', script: 'stocks/fetch-xstocks-float.mjs', hours: 6, description: 'Separate labelled issuer inventory from the upper bound on public float.' },
    { id: 'reference-prices', label: 'Price observer', category: 'markets', script: 'stocks/fetch-reference-prices.mjs', hours: 6, description: 'Pyth reference feeds, with retained issuer data where applicable; latest Pyth prices require entitlement.' },
    { id: 'cross-chain-market', label: 'Cross-chain market scout', category: 'markets', script: 'stocks/fetch-cmc-tokenized.mjs', hours: 6, description: 'CoinMarketCap tokenized-stock listings across chains; requires an API key.' },
    { id: 'pyth-chain', label: 'Oracle reader', category: 'chain', script: 'stocks/fetch-pyth-onchain.mjs', hours: 6, description: 'Read Pyth push-oracle accounts directly on Solana.' },
    { id: 'meteora-pools', label: 'Meteora scout', category: 'defi', script: 'stocks/fetch-meteora.mjs', hours: 6, description: 'Read Meteora pool state on chain.' },
    { id: 'lender-history', label: 'Lender price historian', category: 'defi', script: 'stocks/fetch-lender-price-history.mjs', hours: 6, description: 'Read Kamino’s hourly reserve history to measure closed-market price gaps.' },
    { id: 'solana-depth', label: 'Market-depth probe', category: 'markets', script: 'stocks/fetch-solana-depth.mjs', hours: 6, description: 'Ask Jupiter for quotes to measure depth for lender-accepted tokens; no trades are sent.' },
    { id: 'defi-registries', label: 'DeFi scout', category: 'defi', script: 'stocks/fetch-defi-usage.mjs', hours: 6, description: 'Read protocol registries and corroborate exact-token integrations on chain.' },
    { id: 'defi-footprint', label: 'DeFi footprint scout', category: 'defi', script: 'stocks/fetch-defi-footprint.mjs', hours: 24, description: 'A bounded midnight scan for programs holding tracked mints beyond listed integrations.' },
    { id: 'mint-created', label: 'Mint origin scout', category: 'chain', script: 'stocks/fetch-mint-created.mjs', hours: 6, description: 'Resolve creation times for newly seen mints, then cache the result; runs only where evidence is missing.' }
];

export const SPONSOR_SOURCES = [
    ['prestocks', 'PreStocks', 'https://prestocks.com/api/prestocks'],
    ['tessera', 'Tessera', 'https://rest-api.tessera.pe/v1/public/token-details'],
    ['ondo-global-markets', 'Ondo', 'https://app.ondo.finance/api/v2/assets'],
    ['superstate-opening-bell', 'Superstate', 'https://api.superstate.com/v2/instruments'],
    ['xstocks-backed', 'xStocks', 'https://api.xstocks.fi/api/v2/public/assets'],
    ['xstocks-backed', 'xStocks reserves', 'https://api.xstocks.fi/api/v2/public/proof-of-reserves'],
    ['backpack-securities', 'Backpack', 'https://api.backpack.exchange/api/v1/assets']
];
export const DEFI_SOURCES = [
    ['kamino', 'Kamino', 'https://api.kamino.finance/markets/collateral-reserves'],
    ['kamino', 'Kamino markets', 'https://api.kamino.finance/v2/kamino-market'],
    ['jupiterLend', 'Jupiter Lend', 'https://api.jup.ag/lend/v1/borrow/vaults'],
    ['nest', 'Nest', 'https://docs.nestusd.com/deployments/mainnet.json'],
    ['project0', 'Project 0', 'https://ai.0.xyz/v1/banks'],
    ['save', 'Save', 'https://api.save.finance/v1/reserves?scope=all'],
    ['loopscale', 'Loopscale', 'https://tars.loopscale.com/v1/markets/lending_vaults/info']
];

export function cronHours(cron) {
    if (!cron) return null;
    const [minute, hour, day, month, weekday] = cron.split(/\s+/);
    if (day !== '*' || month !== '*' || weekday !== '*') throw new Error(`Describe this monitoring schedule explicitly: ${cron}`);
    if (hour === '*' && /^\d+$/.test(minute)) return 1;
    if (/^\*\/\d+$/.test(hour)) return Number(hour.slice(2));
    if (/^\d+$/.test(hour)) return 24;
    throw new Error(`Describe this monitoring schedule explicitly: ${cron}`);
}
