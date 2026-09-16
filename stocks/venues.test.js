// Unit tests for the pure venue helpers (lib/venues.mjs). Every fixture is a verbatim copy of a
// real response read on 2026-09-16: DexScreener pairs for the AAPLx, AMZNx and TSLAx mints and
// CoinGecko tickers from coins/apple-xstock/tickers, so a change in how a pair is shaped or a
// venue total is summed shows up as a value mismatch against real numbers rather than a made-up
// one. The aggregation tests assert the actual sums, so breaking a Σ turns them red.

const {
    finiteOrNull,
    stringOrNull,
    sumOrNull,
    shapeDexPair,
    shapeTicker,
    indexSolanaCoinIds,
    sortVenues,
    topVenues,
    aggregateVenues,
    aggregateByIssuer
} = require('./lib/venues.mjs');

const AAPLX_MINT = 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp';
const AMZNX_MINT = 'Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg';
const TSLAX_MINT = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// GET https://api.dexscreener.com/tokens/v1/solana/XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp
const AAPLX_PAIR = {
    chainId: 'solana',
    dexId: 'raydium',
    url: 'https://dexscreener.com/solana/ckwjzwm7oj3nu4653n1epdrqxbxayxopfipeenlouf8y',
    pairAddress: 'CKwJZwm7oj3nu4653N1EpDrqXbXAYXoPFiPeEnLouF8y',
    labels: ['CLMM'],
    baseToken: { address: AAPLX_MINT, name: 'Apple xStock', symbol: 'AAPLx' },
    quoteToken: { address: USDC_MINT, name: 'USD Coin', symbol: 'USDC' },
    priceNative: '334.1706',
    priceUsd: '334.17',
    txns: { m5: { buys: 0, sells: 0 }, h24: { buys: 323, sells: 121 } },
    volume: { h24: 105338.15, h6: 32683.06, h1: 1026.16, m5: 0 },
    priceChange: { h1: -0.04, h6: 0.54, h24: 1 },
    liquidity: { usd: 229556.28, base: 166.3956, quote: 173951 },
    fdv: 334171,
    marketCap: 334171,
    pairCreatedAt: 1751034866000
};

// GET .../tokens/v1/solana/Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg
const AMZNX_PAIR = {
    chainId: 'solana',
    dexId: 'raydium',
    url: 'https://dexscreener.com/solana/6qpuwrfvqtsxwolbedzjyxjk3uexzfqfmnbhjcylhkn8',
    pairAddress: '6QpUWrFVqTsxWoLBedZjyXjK3UEXZfQFMNBhjCyLHKn8',
    labels: ['CLMM'],
    baseToken: { address: AMZNX_MINT, name: 'Amazon xStock', symbol: 'AMZNx' },
    quoteToken: { address: USDC_MINT, name: 'USD Coin', symbol: 'USDC' },
    priceUsd: '229.69',
    volume: { h24: 68411.57 },
    liquidity: { usd: 297428.35, base: 690.7745, quote: 138739 }
};

// GET .../tokens/v1/solana/XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB — a different dexId, so the
// per-dex grouping is exercised against two real venues rather than one.
const TSLAX_PAIR = {
    chainId: 'solana',
    dexId: 'orca',
    url: 'https://dexscreener.com/solana/7gcihgdb8fe6knjn2mytkzzcrjqy3t9ghdc8uhymw2hr',
    pairAddress: '7gcihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
    labels: ['CLMM'],
    baseToken: { address: TSLAX_MINT, name: 'Tesla xStock', symbol: 'TSLAx' },
    quoteToken: { address: USDC_MINT, name: 'USD Coin', symbol: 'USDC' },
    priceUsd: '412.30',
    volume: { h24: 51204.9 },
    liquidity: { usd: 101268.72 }
};

// GET https://api.coingecko.com/api/v3/coins/apple-xstock/tickers — three of the 22 returned.
// trust_score is null on every one: the free tier no longer populates it (verified the same day
// against coins/bitcoin/tickers, 100/100 null), which is a fact about the source, not a parse loss.
const BIGONE_TICKER = {
    base: 'AAPLX',
    target: 'USDT',
    market: { name: 'BigONE', identifier: 'bigone', has_trading_incentive: false },
    last: 335.79,
    volume: 2249.88,
    converted_last: { btc: 0.00443766, eth: 0.14035992, usd: 335.55 },
    converted_volume: { btc: 9.984201, eth: 315.793, usd: 754951 },
    trust_score: null,
    bid_ask_spread_percentage: 0.432707,
    timestamp: '2026-09-16T18:03:50+00:00',
    last_traded_at: '2026-09-16T18:03:50+00:00',
    is_anomaly: false,
    is_stale: false,
    trade_url: 'https://big.one/trade/AAPLX-USDT',
    coin_id: 'apple-xstock',
    target_coin_id: 'tether'
};

const BYBIT_TICKER = {
    base: 'AAPLX',
    target: 'USDT',
    market: { name: 'Bybit', identifier: 'bybit_spot', has_trading_incentive: false },
    last: 335.26,
    volume: 467.494,
    converted_last: { usd: 335.02 },
    converted_volume: { btc: 2.071305, eth: 65.514, usd: 156621 },
    trust_score: null,
    last_traded_at: '2026-09-16T18:04:30+00:00',
    is_anomaly: false,
    is_stale: false,
    trade_url: 'https://www.bybit.com/trade/spot/AAPLX/USDT',
    coin_id: 'apple-xstock'
};

// CoinGecko lists DEX markets among the tickers too, with the mint itself as base/target. Kept so
// the cex[] array is known to contain them.
const RAYDIUM_CLMM_TICKER = {
    base: 'XSBEHLATCF6HDFPFZ5XEMDQW8NFAVCSP5BDUDRLJZJP',
    target: 'EPJFWDD5AUFQSSQEM2QN1XZYBAPC8G4WEGGKZWYTDT1V',
    market: { name: 'Raydium (CLMM)', identifier: 'raydium-clmm', has_trading_incentive: false },
    last: 333.8533697098,
    volume: 444.77180035,
    converted_last: { usd: 333.62 },
    converted_volume: { btc: 1.962362, eth: 62.068, usd: 148383 },
    trust_score: null,
    last_traded_at: '2026-09-16T16:50:58+00:00',
    trade_url: 'https://raydium.io/swap?inputCurrency=xsbehlatcf6hdfpfz5xemdqw8nfavcsp5bdudrljzjp&outputCurrency=epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v',
    coin_id: 'apple-xstock'
};

// Two coins from coins/list?include_platform=true, verbatim except for the trimmed platform maps.
const COIN_LIST = [
    { id: 'tesla-xstock', symbol: 'tslax', name: 'Tesla xStock', platforms: { solana: TSLAX_MINT, ethereum: '0x1234' } },
    { id: 'apple-xstock', symbol: 'aaplx', name: 'Apple xStock', platforms: { solana: AAPLX_MINT, ethereum: '0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a' } },
    { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', platforms: { '': '' } },
    { id: 'usd-coin', symbol: 'usdc', name: 'USDC', platforms: { solana: USDC_MINT } }
];

/** The three-token, five-venue corpus the aggregation assertions are computed from. */
function corpus() {
    return [
        {
            mint: AAPLX_MINT,
            symbol: 'AAPLx',
            issuer: 'xstocks-backed',
            coingeckoId: 'apple-xstock',
            dex: [shapeDexPair(AAPLX_PAIR, AAPLX_MINT)],
            cex: [shapeTicker(BIGONE_TICKER), shapeTicker(BYBIT_TICKER), shapeTicker(RAYDIUM_CLMM_TICKER)]
        },
        {
            mint: AMZNX_MINT,
            symbol: 'AMZNx',
            issuer: 'xstocks-backed',
            coingeckoId: 'amazon-xstock',
            dex: [shapeDexPair(AMZNX_PAIR, AMZNX_MINT)],
            cex: [shapeTicker(BYBIT_TICKER)]
        },
        {
            mint: TSLAX_MINT,
            symbol: 'TSLAx',
            issuer: 'ondo-global-markets',
            coingeckoId: 'tesla-xstock',
            dex: [shapeDexPair(TSLAX_PAIR, TSLAX_MINT)],
            cex: []
        }
    ];
}

describe('finiteOrNull / stringOrNull / sumOrNull', () => {
    test('a missing number never becomes 0', () => {
        expect(finiteOrNull(null)).toBeNull();
        expect(finiteOrNull(undefined)).toBeNull();
        expect(finiteOrNull('')).toBeNull();
        expect(finiteOrNull('   ')).toBeNull();
        expect(finiteOrNull([])).toBeNull();
        expect(finiteOrNull(NaN)).toBeNull();
        expect(finiteOrNull(Infinity)).toBeNull();
        expect(finiteOrNull('abc')).toBeNull();
    });

    test('numbers and numeric strings pass through, including a real priceUsd string', () => {
        expect(finiteOrNull(0)).toBe(0);
        expect(finiteOrNull(229556.28)).toBe(229556.28);
        expect(finiteOrNull('334.17')).toBe(334.17);
        expect(finiteOrNull(-1.5)).toBe(-1.5);
    });

    test('stringOrNull rejects empty and non-strings', () => {
        expect(stringOrNull('raydium')).toBe('raydium');
        expect(stringOrNull('')).toBeNull();
        expect(stringOrNull('  ')).toBeNull();
        expect(stringOrNull(null)).toBeNull();
        expect(stringOrNull(7)).toBeNull();
    });

    test('sumOrNull stays null when nothing is summable, and ignores nulls otherwise', () => {
        expect(sumOrNull([])).toBeNull();
        expect(sumOrNull([null, undefined, NaN])).toBeNull();
        expect(sumOrNull([null, 5, null])).toBe(5);
        expect(sumOrNull([229556.28, 297428.35, 101268.72])).toBeCloseTo(628253.35, 2);
        expect(sumOrNull([0, null])).toBe(0);
    });
});

describe('shapeDexPair', () => {
    test('shapes a real Raydium pair down to the venues.json fields', () => {
        expect(shapeDexPair(AAPLX_PAIR, AAPLX_MINT)).toEqual({
            dexId: 'raydium',
            pairAddress: 'CKwJZwm7oj3nu4653N1EpDrqXbXAYXoPFiPeEnLouF8y',
            quoteSymbol: 'USDC',
            liquidityUsd: 229556.28,
            volume24Usd: 105338.15,
            url: 'https://dexscreener.com/solana/ckwjzwm7oj3nu4653n1epdrqxbxayxopfipeenlouf8y'
        });
    });

    test('a missing liquidity or volume block stays null rather than 0', () => {
        const bare = { ...AAPLX_PAIR, liquidity: undefined, volume: {} };
        const shaped = shapeDexPair(bare, AAPLX_MINT);
        expect(shaped.liquidityUsd).toBeNull();
        expect(shaped.volume24Usd).toBeNull();
        expect(shaped.dexId).toBe('raydium');
    });

    test('drops a pair that names the mint on neither side', () => {
        expect(shapeDexPair(AAPLX_PAIR, TSLAX_MINT)).toBeNull();
    });

    test('keeps a pair where the mint is the quote side, with the base as counter-asset', () => {
        const flipped = {
            ...AAPLX_PAIR,
            baseToken: { address: USDC_MINT, symbol: 'USDC' },
            quoteToken: { address: AAPLX_MINT, symbol: 'AAPLx' }
        };
        expect(shapeDexPair(flipped, AAPLX_MINT).quoteSymbol).toBe('USDC');
    });

    test('drops another chain, a pair with no dexId or pairAddress, and non-objects', () => {
        expect(shapeDexPair({ ...AAPLX_PAIR, chainId: 'bsc' }, AAPLX_MINT)).toBeNull();
        expect(shapeDexPair({ ...AAPLX_PAIR, dexId: '' }, AAPLX_MINT)).toBeNull();
        expect(shapeDexPair({ ...AAPLX_PAIR, pairAddress: null }, AAPLX_MINT)).toBeNull();
        expect(shapeDexPair(null, AAPLX_MINT)).toBeNull();
        expect(shapeDexPair('nope', AAPLX_MINT)).toBeNull();
    });

    test('without a mint the side check is skipped', () => {
        expect(shapeDexPair(AAPLX_PAIR).dexId).toBe('raydium');
    });
});

describe('shapeTicker', () => {
    test('shapes a real BigONE ticker, taking volume from converted_volume.usd', () => {
        expect(shapeTicker(BIGONE_TICKER)).toEqual({
            market: 'BigONE',
            marketId: 'bigone',
            base: 'AAPLX',
            target: 'USDT',
            volume24Usd: 754951,
            trustScore: null,
            url: 'https://big.one/trade/AAPLX-USDT',
            lastTradedAt: '2026-09-16T18:03:50+00:00'
        });
    });

    test('a populated trust_score is carried through', () => {
        expect(shapeTicker({ ...BIGONE_TICKER, trust_score: 'green' }).trustScore).toBe('green');
    });

    test('never reads the base-unit volume field as USD', () => {
        const noConverted = { ...BIGONE_TICKER, converted_volume: undefined };
        expect(shapeTicker(noConverted).volume24Usd).toBeNull();
        expect(shapeTicker(noConverted).volume24Usd).not.toBe(BIGONE_TICKER.volume);
    });

    test('drops a ticker with no market name', () => {
        expect(shapeTicker({ ...BIGONE_TICKER, market: { identifier: 'bigone' } })).toBeNull();
        expect(shapeTicker(null)).toBeNull();
    });
});

describe('indexSolanaCoinIds', () => {
    test('maps the Solana platform address to the coin id and ignores coins without one', () => {
        const { byAddress, duplicates } = indexSolanaCoinIds(COIN_LIST);
        expect(byAddress.get(AAPLX_MINT)).toBe('apple-xstock');
        expect(byAddress.get(TSLAX_MINT)).toBe('tesla-xstock');
        expect(byAddress.has('bitcoin')).toBe(false);
        expect(byAddress.size).toBe(3);
        expect(duplicates).toEqual([]);
    });

    test('the match is case-sensitive, so a lowercased mint does not resolve', () => {
        const { byAddress } = indexSolanaCoinIds(COIN_LIST);
        expect(byAddress.get(AAPLX_MINT.toLowerCase())).toBeUndefined();
    });

    test('a contested address resolves the same whatever order the list arrives in', () => {
        const rival = { id: 'apple-xstock-old', symbol: 'aaplx', name: 'Apple xStock', platforms: { solana: AAPLX_MINT } };
        const forward = indexSolanaCoinIds([...COIN_LIST, rival]);
        const reversed = indexSolanaCoinIds([rival, ...COIN_LIST]);
        expect(forward.byAddress.get(AAPLX_MINT)).toBe('apple-xstock');
        expect(reversed.byAddress.get(AAPLX_MINT)).toBe('apple-xstock');
        expect(forward.duplicates).toEqual([{ address: AAPLX_MINT, ids: ['apple-xstock', 'apple-xstock-old'], chosen: 'apple-xstock' }]);
        expect(reversed.duplicates).toEqual(forward.duplicates);
    });

    test('a non-array is empty, not a throw', () => {
        expect(indexSolanaCoinIds(null).byAddress.size).toBe(0);
    });
});

describe('aggregateVenues', () => {
    test('sums liquidity and volume per dexId across the three tokens', () => {
        const { dex } = aggregateVenues(corpus());
        expect(dex.map((v) => v.venue)).toEqual(['raydium', 'orca']);

        const raydium = dex.find((v) => v.venue === 'raydium');
        expect(raydium.kind).toBe('dex');
        expect(raydium.mints).toBe(2);
        expect(raydium.entries).toBe(2);
        // 229556.28 (AAPLx) + 297428.35 (AMZNx)
        expect(raydium.liquidityUsd).toBeCloseTo(526984.63, 2);
        // 105338.15 + 68411.57
        expect(raydium.volume24Usd).toBeCloseTo(173749.72, 2);

        const orca = dex.find((v) => v.venue === 'orca');
        expect(orca.mints).toBe(1);
        expect(orca.liquidityUsd).toBeCloseTo(101268.72, 2);
        expect(orca.volume24Usd).toBeCloseTo(51204.9, 2);
    });

    test('sums CoinGecko market volume per market name, Bybit over two mints', () => {
        const { cex } = aggregateVenues(corpus());
        expect(cex.map((v) => v.venue)).toEqual(['BigONE', 'Bybit', 'Raydium (CLMM)']);

        const bybit = cex.find((v) => v.venue === 'Bybit');
        expect(bybit.kind).toBe('cex');
        expect(bybit.mints).toBe(2);
        expect(bybit.volume24Usd).toBe(156621 * 2);
        // A CoinGecko ticker carries no liquidity at all — that must stay null, not become 0.
        expect(bybit.liquidityUsd).toBeNull();
        expect(cex.find((v) => v.venue === 'BigONE').volume24Usd).toBe(754951);
    });

    test('dex venues are ordered by liquidity and cex venues by volume, descending', () => {
        const { dex, cex } = aggregateVenues(corpus());
        expect(dex[0].venue).toBe('raydium');
        expect(dex[0].liquidityUsd).toBeGreaterThan(dex[1].liquidityUsd);
        expect(cex[0].venue).toBe('BigONE');
        expect(cex[0].volume24Usd).toBeGreaterThan(cex[1].volume24Usd);
    });

    test('a token with no venues contributes nothing and does not throw', () => {
        const empty = aggregateVenues([{ mint: AAPLX_MINT, issuer: 'x', dex: [], cex: [] }, { mint: 'm2', issuer: 'x' }]);
        expect(empty.dex).toEqual([]);
        expect(empty.cex).toEqual([]);
        expect(aggregateVenues(null).dex).toEqual([]);
    });
});

describe('sortVenues / topVenues', () => {
    const list = [
        { venue: 'b', volume24Usd: 10 },
        { venue: 'a', volume24Usd: 10 },
        { venue: 'c', volume24Usd: null },
        { venue: 'd', volume24Usd: 99 }
    ];

    test('descending, nulls last, ties broken by name', () => {
        expect(sortVenues(list, 'volume24Usd').map((v) => v.venue)).toEqual(['d', 'a', 'b', 'c']);
    });

    test('topVenues takes the head and does not mutate the input', () => {
        expect(topVenues(list, 2, 'volume24Usd').map((v) => v.venue)).toEqual(['d', 'a']);
        expect(list[0].venue).toBe('b');
    });
});

describe('aggregateByIssuer', () => {
    test('rolls the corpus up per issuer, keeping DEX liquidity and CEX volume apart', () => {
        const rows = aggregateByIssuer(corpus());
        expect(rows.map((r) => r.issuer)).toEqual(['ondo-global-markets', 'xstocks-backed']);

        const xstocks = rows.find((r) => r.issuer === 'xstocks-backed');
        expect(xstocks.tokens).toBe(2);
        expect(xstocks.tokensWithDex).toBe(2);
        expect(xstocks.tokensWithCex).toBe(2);
        expect(xstocks.dexLiquidityUsd).toBeCloseTo(526984.63, 2);
        expect(xstocks.dexVolume24Usd).toBeCloseTo(173749.72, 2);
        // 754951 BigONE + 156621*2 Bybit + 148383 Raydium (CLMM)
        expect(xstocks.cexVolume24Usd).toBe(754951 + 156621 * 2 + 148383);

        const ondo = rows.find((r) => r.issuer === 'ondo-global-markets');
        expect(ondo.tokens).toBe(1);
        expect(ondo.tokensWithCex).toBe(0);
        expect(ondo.cexVolume24Usd).toBeNull();
        expect(ondo.dexLiquidityUsd).toBeCloseTo(101268.72, 2);
    });

    test('topVenue ranks by 24h volume, the one measure both sources report', () => {
        const rows = aggregateByIssuer(corpus());
        const xstocks = rows.find((r) => r.issuer === 'xstocks-backed');
        expect(xstocks.topVenue.venue).toBe('BigONE');
        expect(xstocks.topVenue.kind).toBe('cex');
        expect(xstocks.topVenue.volume24Usd).toBe(754951);
        // The separate per-source picks never mix liquidity with volume.
        expect(xstocks.topDexVenue.venue).toBe('raydium');
        expect(xstocks.topCexVenue.venue).toBe('BigONE');
    });

    test('falls back to liquidity when no venue reports a volume', () => {
        const noVolume = [{
            mint: AAPLX_MINT,
            issuer: 'xstocks-backed',
            dex: [shapeDexPair({ ...AAPLX_PAIR, volume: {} }, AAPLX_MINT)],
            cex: []
        }];
        const row = aggregateByIssuer(noVolume)[0];
        expect(row.topVenue.venue).toBe('raydium');
        expect(row.topVenue.volume24Usd).toBeNull();
        expect(row.topVenue.liquidityUsd).toBeCloseTo(229556.28, 2);
    });

    test('an issuer with no venues at all reports null totals and no top venue', () => {
        const row = aggregateByIssuer([{ mint: 'm', issuer: 'shift', dex: [], cex: [] }])[0];
        expect(row.issuer).toBe('shift');
        expect(row.dexLiquidityUsd).toBeNull();
        expect(row.cexVolume24Usd).toBeNull();
        expect(row.topVenue).toBeNull();
        expect(row.topDexVenue).toBeNull();
    });

    test('a token with no issuer is grouped as unknown rather than dropped', () => {
        const rows = aggregateByIssuer([{ mint: 'm', issuer: null, dex: [shapeDexPair(AAPLX_PAIR)], cex: [] }]);
        expect(rows).toHaveLength(1);
        expect(rows[0].issuer).toBe('unknown');
        expect(rows[0].dexLiquidityUsd).toBeCloseTo(229556.28, 2);
    });
});
