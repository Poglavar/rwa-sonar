// Unit tests for the pure Meteora shaping (lib/meteora.mjs). Every fixture is a VERBATIM response
// read on 2026-09-16, trimmed to the fields the shapers touch and to nothing else — every fee,
// bin step, price and address below is the real one:
//
//   DLMM     GET https://dlmm.datapi.meteora.ag/pools/13MEx6gjRadJNUdmToaGSzgeWHLH7FzScUQS9Mc5nYF5
//            (MU-USDC, Backpack's Micron pool — the section's second-deepest Meteora pool)
//   DAMM v2  GET https://damm-v2.datapi.meteora.ag/pools/FTuVce8s6DcCb653kM2sz6c4vMgRAqdQNYNashyxrNHf
//            (SOL-SPIDERBRAI; no tokenized stock sits in a DAMM v2 pool yet, so the fixture is the
//            first pool the API's own listing returns — the shape is what matters)
//   DAMM v1  GET https://damm-api.meteora.ag/pools?address=EXpXkwcWDhjEYyC5pfNfxsu8fUtK4CDCYTZR4ApQNRzo&page=0&size=1
//            (META-USDC, the legacy shape: numbers as strings and created_at in seconds)
//   DBC      GET https://dbc.datapi.meteora.ag/pools/HzG4UEc8BgZj8ViNaKxDcvWYobZ2BwAqi6xv792DS4ua
//            (TSMon's bonding-curve pool — the response IS this short: identity and config only)
//
// The MU fixture is what makes the price handling checkable against something it never saw:
// current_price 933.6076 with MU as token_x, and MU's own USD price 934.1564 the same minute.

const {
    METEORA_DEX_IDS,
    METEORA_ENDPOINTS,
    DBC_PROGRAM_ID,
    endpointOrder,
    camelKey,
    camelizeFinite,
    tokenSides,
    shapeDlmmPair,
    shapeDammPool,
    shapeDbcPool,
    selectMeteoraPools
} = require('./lib/meteora.mjs');

const MU_MINT = 'MUxEsUKSMACyw5fZf68wxf5FLnZVhtU9CwH8uNNGay1';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const SPIDERBRAI_MINT = 'HNLULjHEq7SoW1zZTVBDVuJZKR1ebxRKwoYqKtykfs5Z';
const TSMON_MINT = 'keybg184d4vyXeQdFqs4o99YsMg7xBthxTJ6Ky3ondo';
const TSMON_PAIR = 'HzG4UEc8BgZj8ViNaKxDcvWYobZ2BwAqi6xv792DS4ua';
const MU_PAIR = '13MEx6gjRadJNUdmToaGSzgeWHLH7FzScUQS9Mc5nYF5';

const DLMM_MU = {
    address: MU_PAIR,
    name: 'MU-USDC',
    token_x: {
        address: MU_MINT,
        name: 'Micron Technology - Backpack Securities',
        symbol: 'MU',
        decimals: 6,
        is_verified: true,
        holders: 4828,
        total_supply: 7038.023974518345,
        price: 934.1563735606636,
        market_cap: 6574614.953069066
    },
    token_y: {
        address: USDC_MINT,
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6,
        is_verified: true,
        holders: 5248202,
        price: 0.999734750643028
    },
    token_x_amount: 3258.1300062348646,
    token_y_amount: 1418683.3615859998,
    created_at: 1782137569000,
    pool_config: { bin_step: 20, base_fee_pct: 0.2, max_fee_pct: 0.0, protocol_fee_pct: 10.0, collect_fee_mode: 1 },
    dynamic_fee_pct: 0.0007999999999999999,
    tvl: 4459262.267572275,
    current_price: 933.6076300861704,
    apr: 0.12042468196608012,
    apy: 55.159841966873515,
    has_farm: false,
    volume: { '1h': 40749.40000389838, '12h': 2526560.8426551484, '24h': 2969400.2428232725 },
    fees: { '1h': 73.41337271234333, '12h': 4571.581867985992, '24h': 5370.052403757325 },
    protocol_fees: { '24h': 592.7329044478881 },
    fee_tvl_ratio: { '1h': 0.0016463120648050884, '24h': 0.12042468196608012 },
    cumulative_metrics: { volume: 345169720.22097665, fees: 630289.5457761367 },
    is_blacklisted: false,
    launchpad: '',
    tags: []
};

const DAMM_V2_SPIDERBRAI = {
    address: 'FTuVce8s6DcCb653kM2sz6c4vMgRAqdQNYNashyxrNHf',
    name: 'SOL-SPIDERBRAI',
    token_x: { address: WSOL_MINT, name: 'Wrapped SOL', symbol: 'SOL', decimals: 9, holders: 3820662, price: 97.51186812635144 },
    token_y: { address: SPIDERBRAI_MINT, name: 'SPIDERBRAIN', symbol: 'SPIDERBRAI', decimals: 6, holders: 2071, price: 7.947967279408313e-05 },
    created_at: 1789598094000,
    pool_config: {
        collect_fee_mode: 1,
        base_fee_mode: 0,
        base_fee_pct: 0.01,
        protocol_fee_pct: 20,
        partner_fee_pct: 0,
        dynamic_fee_initialized: false,
        pool_type: 0,
        concentrated_liquidity: false,
        has_fee_scheduler: false
    },
    tvl: 46584.67162046593,
    current_price: 1293752.790621777,
    volume: { '24h': 1861066.1832141492 },
    fees: { '24h': 148.89280505595545 },
    fee_tvl_ratio: { '24h': 0.31961759067234197 },
    is_blacklisted: false
};

const DAMM_V1_META = {
    pool_address: 'EXpXkwcWDhjEYyC5pfNfxsu8fUtK4CDCYTZR4ApQNRzo',
    pool_token_mints: ['METAwkXcqyXKy1AtsSgJ8JiUHwGCafnZL38n3vYmeta', USDC_MINT],
    pool_name: 'META-USDC',
    pool_tvl: '299291.93482103286',
    trading_volume: 116247.98448258004,
    fee_volume: 348.743953447742,
    total_fee_pct: '0.3',
    apr: 42.81054646696131,
    accumulated_trading_volume: '240572952.362241',
    accumulated_fee_volume: '721718.857087',
    created_at: 1755282372,
    pool_version: 2,
    pool_type: 'volatile'
};

const DBC_TSMON = {
    address: TSMON_PAIR,
    token_x: { address: 'DiXZvAaHpezoAPd7bXivsDukdkiY6Ks9SEeyMxA1ELQZ', name: 'Autism Universe', symbol: 'AU', decimals: 6 },
    token_y: { address: TSMON_MINT, name: 'Taiwan Semiconductor Manufacturing (Ondo Tokenized)', symbol: 'TSMon', decimals: 9 },
    vault_x: '6r5RfrgVZEEmPkcXBypgXb1oKJqfqAEjLpr9rV17tXCn',
    vault_y: '4yjzv3RXmb3N9Vza9JmBibg4GneAEpRgpmsbqRrs3Xb3',
    created_at: 1789496451000,
    creator: '9cTkSMugKWRe9Vv9oTXxMdjuGQxe3tNZWDmHHQTvdzgJ',
    pool_config_address: 'ExBRb9hNJR88Dk8iZHsBQxdHnWnkcpjiqanwaqBUFCm2',
    pool_config: { pool_type: 0 }
};

// The real getAccountInfo on the DBC pool (2026-09-16): a live account under the DBC program.
const DBC_ACCOUNT = { exists: true, owner: DBC_PROGRAM_ID, dataLength: 424, lamports: 2804160, isDbcProgram: true };

// Four items shaped exactly like venues.json's: the MU DLMM pool, the TSMon bonding-curve pool, a
// token whose only pool is Raydium's, and one Meteora pair with no address at all.
const VENUES_ITEMS = [
    {
        mint: MU_MINT,
        symbol: 'MU',
        issuer: 'backpack-securities',
        dex: [{ dexId: 'meteora', pairAddress: MU_PAIR, quoteSymbol: 'USDC', quoteMint: USDC_MINT, priceUsd: 933.65, liquidityUsd: 4195853.64, volume24Usd: 1738500.68, txns24: 1404 }]
    },
    {
        mint: TSMON_MINT,
        symbol: 'TSMon',
        issuer: 'ondo-global-markets',
        dex: [{ dexId: 'meteoradbc', pairAddress: TSMON_PAIR, quoteSymbol: 'AU', quoteMint: 'DiXZvAaHpezoAPd7bXivsDukdkiY6Ks9SEeyMxA1ELQZ', priceUsd: null, liquidityUsd: null, volume24Usd: 0, txns24: 2 }]
    },
    {
        mint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp',
        symbol: 'AAPLx',
        issuer: 'xstocks-backed',
        dex: [{ dexId: 'raydium', pairAddress: 'CKwJZwm7oj3nu4653N1EpDrqXbXAYXoPFiPeEnLouF8y', quoteSymbol: 'USDC', liquidityUsd: 229556.28, volume24Usd: 105338.15, txns24: 444 }]
    },
    {
        mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB',
        symbol: 'TSLAx',
        issuer: 'xstocks-backed',
        dex: [{ dexId: 'meteora', pairAddress: null, quoteSymbol: 'USDC', liquidityUsd: 1000, volume24Usd: 99999999 }]
    }
];

describe('endpoint map', () => {
    test('names one route per product and both Meteora dexIds', () => {
        expect(METEORA_DEX_IDS).toEqual(['meteora', 'meteoradbc']);
        expect(Object.keys(METEORA_ENDPOINTS)).toEqual(['dlmm', 'damm-v2', 'damm-v1', 'dbc']);
        expect(METEORA_ENDPOINTS.dlmm(MU_PAIR)).toBe(`https://dlmm.datapi.meteora.ag/pools/${MU_PAIR}`);
        expect(METEORA_ENDPOINTS.dbc(TSMON_PAIR)).toBe(`https://dbc.datapi.meteora.ag/pools/${TSMON_PAIR}`);
        // The legacy DAMM v1 route refuses without BOTH params: no page is a 400, no address a 400.
        expect(METEORA_ENDPOINTS['damm-v1'](MU_PAIR)).toContain('address=');
        expect(METEORA_ENDPOINTS['damm-v1'](MU_PAIR)).toContain('page=0');
    });

    test('a meteoradbc pair is probed at dbc first, everything else at dlmm first', () => {
        expect(endpointOrder('meteoradbc')[0]).toBe('dbc');
        // DAMM v2 is still tried for a DBC pair: that is where a completed curve migrates to.
        expect(endpointOrder('meteoradbc')).toContain('damm-v2');
        expect(endpointOrder('meteora')[0]).toBe('dlmm');
        expect(endpointOrder(null)).toEqual(['dlmm', 'damm-v2', 'damm-v1', 'dbc']);
    });
});

describe('camelizeFinite', () => {
    test('renames snake keys without touching camel or single words', () => {
        expect(camelKey('pool_config_address')).toBe('poolConfigAddress');
        expect(camelKey('token_x')).toBe('tokenX');
        expect(camelKey('creator')).toBe('creator');
        expect(camelKey('poolType')).toBe('poolType');
    });

    test('keeps facts and drops what carries none', () => {
        const out = camelizeFinite({
            pool_type: 0,
            is_migrated: false,
            migration_threshold: null,
            broken_number: Number.NaN,
            infinite: Number.POSITIVE_INFINITY,
            empty_name: '   ',
            creator: 'abc',
            tags: ['a', 'b'],
            nested_config: { base_fee: 1.5, missing: null },
            empty_nested: { missing: null }
        });
        expect(out).toEqual({
            poolType: 0,
            isMigrated: false,
            creator: 'abc',
            nestedConfig: { baseFee: 1.5 }
        });
        // A boolean flag is the one thing a DBC response would carry about migration, so it must
        // survive; a null threshold must NOT come back as 0.
        expect(out.isMigrated).toBe(false);
        expect('migrationThreshold' in out).toBe(false);
    });

    test('a non-object carries nothing', () => {
        expect(camelizeFinite(null)).toBeUndefined();
        expect(camelizeFinite([1, 2])).toBeUndefined();
        expect(camelizeFinite('x')).toBeUndefined();
    });
});

describe('tokenSides', () => {
    test('finds the tracked mint on either side and reports which', () => {
        expect(tokenSides(DLMM_MU, MU_MINT).ownIsX).toBe(true);
        expect(tokenSides(DLMM_MU, MU_MINT).counter.symbol).toBe('USDC');
        expect(tokenSides(DLMM_MU, USDC_MINT).ownIsX).toBe(false);
        expect(tokenSides(DLMM_MU, USDC_MINT).counter.symbol).toBe('MU');
    });

    test('a mint on neither side resolves to nothing, so no price is borrowed from the counter', () => {
        expect(tokenSides(DLMM_MU, WSOL_MINT)).toEqual({ own: null, counter: null, ownIsX: null });
        expect(tokenSides(DLMM_MU, null).own).toBeNull();
    });
});

describe('shapeDlmmPair', () => {
    test('reports the real MU-USDC pool: bin step, fee tiers, 24 h fees, TVL and price', () => {
        const pool = shapeDlmmPair(DLMM_MU, { mint: MU_MINT });
        expect(pool.poolType).toBe('dlmm');
        expect(pool.pairAddress).toBe(MU_PAIR);
        expect(pool.poolName).toBe('MU-USDC');
        expect(pool.binStep).toBe(20);
        expect(pool.baseFeePct).toBe(0.2);
        expect(pool.protocolFeePct).toBe(10);
        expect(pool.dynamicFeePct).toBeCloseTo(0.0008, 6);
        expect(pool.fees24Usd).toBeCloseTo(5370.0524, 3);
        expect(pool.volume24Usd).toBeCloseTo(2969400.2428, 3);
        expect(pool.liquidityUsd).toBeCloseTo(4459262.2676, 3);
        expect(pool.feeTvlRatio24).toBeCloseTo(0.1204, 4);
        expect(pool.apr).toBeCloseTo(0.1204, 4);
        expect(pool.apy).toBeCloseTo(55.1598, 3);
        expect(pool.cumulativeVolumeUsd).toBeCloseTo(345169720.221, 2);
        expect(pool.cumulativeFeesUsd).toBeCloseTo(630289.5458, 3);
        expect(pool.createdAtMs).toBe(1782137569000);
        expect(pool.holders).toBe(4828);
        expect(pool.isBlacklisted).toBe(false);
        expect(pool.curve).toBeNull();
        // launchpad is '' on this pool — an empty string is not a launchpad name.
        expect(pool.launchpad).toBeNull();
    });

    test('max_fee_pct is passed through verbatim, including the 0 the source reports', () => {
        // Measured on all 21 tokenized-stock DLMM pools (2026-09-16): max_fee_pct is 0 while
        // base_fee_pct is 0.01–10. A cap below the base fee is impossible, so this 0 is the source
        // not populating the field — and it is kept as the source's own value, not turned into a
        // null we invented. If the API ever starts populating it, this test is what notices.
        expect(shapeDlmmPair(DLMM_MU, { mint: MU_MINT }).maxFeePct).toBe(0);
    });

    test('the price is the tracked side: USD from the token, quote units from current_price', () => {
        const asMu = shapeDlmmPair(DLMM_MU, { mint: MU_MINT });
        expect(asMu.priceUsd).toBeCloseTo(934.1564, 3);
        expect(asMu.priceQuote).toBeCloseTo(933.6076, 4);
        expect(asMu.quoteSymbol).toBe('USDC');
        expect(asMu.quoteMint).toBe(USDC_MINT);

        // Tracked from the other side, current_price must INVERT — it is token_y per token_x, so
        // reading it straight would price USDC at 933 USDC per MU.
        const asUsdc = shapeDlmmPair(DLMM_MU, { mint: USDC_MINT });
        expect(asUsdc.priceUsd).toBeCloseTo(0.9997, 4);
        expect(asUsdc.priceQuote).toBeCloseTo(1 / 933.6076300861704, 8);
        expect(asUsdc.priceQuote).toBeLessThan(0.01);
        expect(asUsdc.quoteSymbol).toBe('MU');
    });

    test('a mint on neither side gets no price and no quote asset, but still gets the pool facts', () => {
        const pool = shapeDlmmPair(DLMM_MU, { mint: WSOL_MINT });
        expect(pool.priceUsd).toBeNull();
        expect(pool.priceQuote).toBeNull();
        expect(pool.quoteSymbol).toBeNull();
        expect(pool.quoteMint).toBeNull();
        expect(pool.binStep).toBe(20);
    });

    test('an absent figure stays null instead of becoming 0', () => {
        const thin = { address: MU_PAIR, token_x: { address: MU_MINT, symbol: 'MU' }, token_y: { address: USDC_MINT, symbol: 'USDC' }, pool_config: {} };
        const pool = shapeDlmmPair(thin, { mint: MU_MINT });
        expect(pool.binStep).toBeNull();
        expect(pool.baseFeePct).toBeNull();
        expect(pool.fees24Usd).toBeNull();
        expect(pool.volume24Usd).toBeNull();
        expect(pool.liquidityUsd).toBeNull();
        expect(pool.priceUsd).toBeNull();
        expect(pool.priceQuote).toBeNull();
        expect(pool.apr).toBeNull();
        expect(pool.isBlacklisted).toBeNull();
    });

    test('a body with no pool address is not a pool', () => {
        expect(shapeDlmmPair(null)).toBeNull();
        expect(shapeDlmmPair({ message: 'Pool not found: 13MEx' })).toBeNull();
        expect(shapeDlmmPair('nope')).toBeNull();
    });
});

describe('shapeDammPool', () => {
    test('the datapi shape is DAMM v2 and has no bins', () => {
        const pool = shapeDammPool(DAMM_V2_SPIDERBRAI, { mint: WSOL_MINT });
        expect(pool.poolType).toBe('damm-v2');
        expect(pool.binStep).toBeNull();
        expect(pool.baseFeePct).toBe(0.01);
        // v2's pool_config has no max_fee_pct at all, which is a null, not a 0.
        expect(pool.maxFeePct).toBeNull();
        expect(pool.protocolFeePct).toBe(20);
        expect(pool.volume24Usd).toBeCloseTo(1861066.1832, 3);
        expect(pool.fees24Usd).toBeCloseTo(148.8928, 4);
        expect(pool.liquidityUsd).toBeCloseTo(46584.6716, 3);
        expect(pool.priceUsd).toBeCloseTo(97.5119, 4);
        expect(pool.priceQuote).toBeCloseTo(1293752.7906, 3);
        expect(pool.quoteSymbol).toBe('SPIDERBRAI');
        expect(pool.curve).toBeNull();
    });

    test('tracked from the y side, the v2 price inverts too', () => {
        const pool = shapeDammPool(DAMM_V2_SPIDERBRAI, { mint: SPIDERBRAI_MINT });
        expect(pool.priceUsd).toBeCloseTo(7.947967e-05, 10);
        expect(pool.priceQuote).toBeCloseTo(1 / 1293752.790621777, 12);
        expect(pool.quoteSymbol).toBe('SOL');
    });

    test('the legacy array shape is DAMM v1: strings parsed, seconds scaled, no token price', () => {
        const pool = shapeDammPool(DAMM_V1_META, { mint: USDC_MINT });
        expect(pool.poolType).toBe('damm-v1');
        expect(pool.pairAddress).toBe('EXpXkwcWDhjEYyC5pfNfxsu8fUtK4CDCYTZR4ApQNRzo');
        expect(pool.poolName).toBe('META-USDC');
        expect(pool.baseFeePct).toBe(0.3);
        expect(pool.liquidityUsd).toBeCloseTo(299291.9348, 3);
        expect(pool.volume24Usd).toBeCloseTo(116247.9845, 3);
        expect(pool.fees24Usd).toBeCloseTo(348.744, 3);
        expect(pool.cumulativeVolumeUsd).toBeCloseTo(240572952.3622, 2);
        expect(pool.cumulativeFeesUsd).toBeCloseTo(721718.8571, 3);
        // v1 reports created_at in SECONDS where every datapi shape reports milliseconds.
        expect(pool.createdAtMs).toBe(1755282372000);
        // The legacy shape carries LP prices, not token prices, so no price is invented from them.
        expect(pool.priceUsd).toBeNull();
        expect(pool.priceQuote).toBeNull();
        expect(pool.binStep).toBeNull();
    });

    test('a body with neither address is not a pool', () => {
        expect(shapeDammPool({ message: 'Pool not found: x' })).toBeNull();
        expect(shapeDammPool(null)).toBeNull();
    });
});

describe('shapeDbcPool', () => {
    test('the bonding-curve pool reports identity only — every trading figure stays null', () => {
        const pool = shapeDbcPool(DBC_TSMON, { account: DBC_ACCOUNT, note: 'layout not decoded' });
        expect(pool.poolType).toBe('dbc');
        expect(pool.pairAddress).toBe(TSMON_PAIR);
        expect(pool.createdAtMs).toBe(1789496451000);
        // The DBC endpoint has no volume, fees, TVL or price on it at all. A pool with two trades
        // to its name and one whose figures were never reported must not read the same, so these
        // are null and not 0 — the same rule the rest of the pipeline follows.
        for (const key of ['volume24Usd', 'fees24Usd', 'liquidityUsd', 'priceUsd', 'priceQuote', 'binStep', 'baseFeePct', 'maxFeePct', 'apr', 'apy', 'feeTvlRatio24']) {
            expect(pool[key]).toBeNull();
        }
    });

    test('curve holds the response camelised, with the curve state explicitly not decoded', () => {
        const pool = shapeDbcPool(DBC_TSMON, { account: DBC_ACCOUNT, note: 'layout not decoded' });
        expect(pool.curve.tokenY.symbol).toBe('TSMon');
        expect(pool.curve.tokenX.symbol).toBe('AU');
        expect(pool.curve.poolConfigAddress).toBe('ExBRb9hNJR88Dk8iZHsBQxdHnWnkcpjiqanwaqBUFCm2');
        expect(pool.curve.poolConfig).toEqual({ poolType: 0 });
        expect(pool.curve.vaultX).toBe('6r5RfrgVZEEmPkcXBypgXb1oKJqfqAEjLpr9rV17tXCn');
        expect(pool.curve.creator).toBe('9cTkSMugKWRe9Vv9oTXxMdjuGQxe3tNZWDmHHQTvdzgJ');
        // The two claims nobody may read a number out of: there is no migration state here.
        expect(pool.curve.curveState).toBeNull();
        expect(pool.curve.migrated).toBeNull();
        expect(pool.curve.note).toBe('layout not decoded');
        // What WAS measured on chain: a live account under the DBC program, 424 bytes, undecoded.
        expect(pool.curve.account).toEqual({ exists: true, owner: DBC_PROGRAM_ID, dataLength: 424, lamports: 2804160, isDbcProgram: true });
    });

    test('with no account read the account is null rather than a made-up absence', () => {
        const pool = shapeDbcPool(DBC_TSMON);
        expect(pool.curve.account).toBeNull();
        expect(pool.curve.note).toBeNull();
        expect(shapeDbcPool({ pool_config: {} })).toBeNull();
    });
});

describe('selectMeteoraPools', () => {
    test('picks both Meteora dexIds and nothing else, ranked by DexScreener 24 h volume', () => {
        const pools = selectMeteoraPools(VENUES_ITEMS);
        expect(pools.map((p) => p.symbol)).toEqual(['MU', 'TSMon']);
        expect(pools.map((p) => p.dexId)).toEqual(['meteora', 'meteoradbc']);
        expect(pools[0].pairAddress).toBe(MU_PAIR);
        expect(pools[0].mint).toBe(MU_MINT);
        expect(pools[0].issuer).toBe('backpack-securities');
    });

    test('carries the DexScreener figures along, so the two sources stay comparable', () => {
        const [mu, tsmon] = selectMeteoraPools(VENUES_ITEMS);
        expect(mu.dexscreener).toEqual({ liquidityUsd: 4195853.64, volume24Usd: 1738500.68, txns24: 1404 });
        // The DBC pool reports NO liquidity on DexScreener; that absence must stay an absence.
        expect(tsmon.dexscreener).toEqual({ liquidityUsd: null, volume24Usd: 0, txns24: 2 });
        expect(tsmon.quoteSymbol).toBe('AU');
    });

    test('a Meteora pair with no address is dropped however large its volume', () => {
        const pools = selectMeteoraPools(VENUES_ITEMS);
        expect(pools.some((p) => p.symbol === 'TSLAx')).toBe(false);
        expect(pools.some((p) => p.dexId === 'raydium')).toBe(false);
    });

    test('unreported volume sorts last and ties break on the pair address', () => {
        const items = [
            { mint: 'm1', symbol: 'QUIET', dex: [{ dexId: 'meteora', pairAddress: 'zzz1', volume24Usd: null }] },
            { mint: 'm2', symbol: 'TIEB', dex: [{ dexId: 'meteora', pairAddress: 'bbb', volume24Usd: 100 }] },
            { mint: 'm3', symbol: 'TIEA', dex: [{ dexId: 'meteora', pairAddress: 'aaa', volume24Usd: 100 }] }
        ];
        expect(selectMeteoraPools(items).map((p) => p.symbol)).toEqual(['TIEA', 'TIEB', 'QUIET']);
    });

    test('takes the venues document as well as its items, and survives a broken one', () => {
        expect(selectMeteoraPools({ items: VENUES_ITEMS }).map((p) => p.symbol)).toEqual(['MU', 'TSMon']);
        expect(selectMeteoraPools(null)).toEqual([]);
        expect(selectMeteoraPools({ items: [{ mint: null, dex: [{ dexId: 'meteora', pairAddress: 'x' }] }] })).toEqual([]);
        expect(selectMeteoraPools([{ mint: 'm', dex: 'not-an-array' }])).toEqual([]);
    });
});
