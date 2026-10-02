// Unit tests for stocks/lib/activity-rows.js: trading-activity rows, their flags, and a token's
// venue rows. Moved with the code out of stocks-page.test.js (next-steps.md F11), which still tests
// the page wiring that calls it.

const {
    ACTIVITY_FLAG_TRADES_PER_TRADER,
    ACTIVITY_FLAG_ORGANIC_PCT,
    activityFlags,
    issuerActivityRow,
    activityRows,
    pairLegLabel,
    quoteSymbolIndex,
    venueRows
} = require('./lib/activity-rows.js');

describe('activityFlags', () => {
    it('flags the wash-trading tell strictly above the threshold', () => {
        expect(activityFlags({ tradesPerTrader: ACTIVITY_FLAG_TRADES_PER_TRADER + 0.1 })
            .map((f) => f.code)).toEqual(['wash']);
        expect(activityFlags({ tradesPerTrader: ACTIVITY_FLAG_TRADES_PER_TRADER })).toEqual([]);
        expect(activityFlags({ tradesPerTrader: 3 })).toEqual([]);
    });

    it('flags an organic share strictly under the threshold', () => {
        expect(activityFlags({ organicSharePct: ACTIVITY_FLAG_ORGANIC_PCT - 0.1 })
            .map((f) => f.code)).toEqual(['inorganic']);
        expect(activityFlags({ organicSharePct: ACTIVITY_FLAG_ORGANIC_PCT })).toEqual([]);
        expect(activityFlags({ organicSharePct: 61 })).toEqual([]);
    });

    it('carries a label and an explanation, so the badge is never colour alone', () => {
        const [flag] = activityFlags({ tradesPerTrader: 42.3 });
        expect(flag.label).toBeTruthy();
        expect(flag.glyph).toBeTruthy();
        expect(flag.detail).toContain('42.3');
        expect(flag.detail).toContain(String(ACTIVITY_FLAG_TRADES_PER_TRADER));
    });

    it('never trips on a missing value — a null is not a zero organic share', () => {
        expect(activityFlags({ tradesPerTrader: null, organicSharePct: null })).toEqual([]);
        expect(activityFlags({})).toEqual([]);
        for (const bad of [null, undefined, 'x', 7]) expect(activityFlags(bad)).toEqual([]);
    });

    it('can raise both flags at once', () => {
        expect(activityFlags({ tradesPerTrader: 900, organicSharePct: 0.4 }).map((f) => f.code))
            .toEqual(['wash', 'inorganic']);
    });
});

describe('issuerActivityRow and activityRows', () => {
    const live = {
        slug: 'xstocks-backed',
        name: 'Kraken xStocks',
        status: 'live',
        market: { tokens: 61, organicSharePct: 44.2 },
        activity: {
            tokensTraded24: 57,
            trades24: 41_200,
            traders24: 1_030,
            tradesPerTrader: 40,
            organicSharePct: 12.5,
            venueCount: 9,
            venueSpreadMedianPct: 0.42,
            venuesTop: [{ name: 'Raydium', kind: 'dex', volume24Usd: 1e6, liquidityUsd: 2e6 }],
            lastTradedAt: '2026-09-16T19:08:30Z',
            lastTradedVenue: 'Kraken'
        }
    };

    it('copies the §11.3 aggregate straight through', () => {
        const row = issuerActivityRow(live);
        expect(row).toMatchObject({
            slug: 'xstocks-backed',
            tokens: 61,
            tokensTraded24: 57,
            trades24: 41_200,
            traders24: 1_030,
            tradesPerTrader: 40,
            organicSharePct: 12.5,
            venueCount: 9,
            venueSpreadMedianPct: 0.42,
            lastTradedAt: '2026-09-16T19:08:30Z',
            lastTradedVenue: 'Kraken'
        });
        expect(row.flags.map((f) => f.code)).toEqual(['wash']);
    });

    it('falls back to the market organic share, which is the same quantity from the same build', () => {
        const row = issuerActivityRow({ ...live, activity: { ...live.activity, organicSharePct: null } });
        expect(row.organicSharePct).toBe(44.2);
    });

    it('keeps every unbuilt field null rather than zero, and raises no flag on it', () => {
        const row = issuerActivityRow({ slug: 'bullish', name: 'Bullish', status: 'live' });
        expect(row.tokens).toBeNull();
        expect(row.trades24).toBeNull();
        expect(row.traders24).toBeNull();
        expect(row.tradesPerTrader).toBeNull();
        expect(row.organicSharePct).toBeNull();
        expect(row.venueCount).toBeNull();
        expect(row.venueSpreadMedianPct).toBeNull();
        expect(row.lastTradedAt).toBeNull();
        expect(row.venuesTop).toEqual([]);
        expect(row.flags).toEqual([]);
    });

    it('lists live issuers only — a defunct programme has no 24h activity to report', () => {
        const rows = activityRows([
            live,
            { slug: 'remora-markets', name: 'Remora', status: 'defunct', activity: { trades24: 5 } },
            { slug: 'ventuals', name: 'Ventuals', status: 'not-launched' }
        ]);
        expect(rows.map((r) => r.slug)).toEqual(['xstocks-backed']);
        expect(activityRows(null)).toEqual([]);
    });
});

describe('venueRows', () => {
    const venues = {
        dex: [
            { dexId: 'meteora', pairAddress: 'LaB4', quoteSymbol: 'USDC', liquidityUsd: 867, volume24Usd: 54.69, txns24: 12, priceUsd: 9.5, url: 'https://dexscreener.com/solana/lab4' },
            { dexId: 'raydium', quoteSymbol: 'SOL', liquidityUsd: 50_000, volume24Usd: 900_000, url: 'https://dexscreener.com/solana/ray' }
        ],
        cex: [
            { market: 'MEXC', base: 'MRNAON', target: 'USDT', volume24Usd: 104_327, priceUsd: 9.62, lastTradedAt: '2026-09-16T19:08:30+00:00', url: 'https://www.mexc.com/exchange/MRNAON_USDT' }
        ]
    };

    it('shapes a DEX pair and a CEX market into the same row', () => {
        const rows = venueRows(venues);
        const meteora = rows.find((r) => r.name === 'meteora');
        expect(meteora).toEqual({
            kind: 'dex',
            name: 'meteora',
            pair: '/USDC',
            pairFull: '/USDC',
            liquidityUsd: 867,
            volume24Usd: 54.69,
            priceUsd: 9.5,
            txns24: 12,
            lastTradedAt: null,
            url: 'https://dexscreener.com/solana/lab4'
        });
        expect(rows.find((r) => r.name === 'MEXC')).toEqual({
            kind: 'cex',
            name: 'MEXC',
            pair: 'MRNAON/USDT',
            pairFull: 'MRNAON/USDT',
            liquidityUsd: null,
            volume24Usd: 104_327,
            priceUsd: 9.62,
            txns24: null,
            lastTradedAt: '2026-09-16T19:08:30+00:00',
            url: 'https://www.mexc.com/exchange/MRNAON_USDT'
        });
    });

    it('orders the busiest venue first and keeps an unreported volume last', () => {
        const rows = venueRows({
            dex: [{ dexId: 'quiet', volume24Usd: null, liquidityUsd: 10 }],
            cex: [{ market: 'busy', volume24Usd: 5 }, { market: 'busier', volume24Usd: 50 }]
        });
        expect(rows.map((r) => r.name)).toEqual(['busier', 'busy', 'quiet']);
    });

    it('accepts one flat array too, inferring the kind from the fields', () => {
        const rows = venueRows([
            { pairAddress: 'abc', dexId: 'orca', volume24Usd: 2 },
            { market: 'Bybit', volume24Usd: 1 }
        ]);
        expect(rows.map((r) => `${r.kind}:${r.name}`)).toEqual(['dex:orca', 'cex:Bybit']);
    });

    it('shortens a mint address used as a pair leg, keeping the full pair alongside it', () => {
        const [row] = venueRows({
            cex: [{
                market: 'Raydium (CLMM)',
                base: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W',
                target: 'USDC'
            }]
        });
        expect(row.pair).toBe('XsoC…DF2W/USDC');
        expect(row.pairFull).toBe('XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W/USDC');
    });

    it('names a quote asset CoinGecko reports as an uppercased address instead of printing it', () => {
        // Verbatim from coins/apple-xstock/tickers (Raydium CLMM), 2026-09-22.
        const [row] = venueRows({ cex: [{
            market: 'Raydium (CLMM)',
            base: 'XSBEHLATCF6HDFPFZ5XEMDQW8NFAVCSP5BDUDRLJZJP',
            target: 'EPJFWDD5AUFQSSQEM2QN1XZYBAPC8G4WEGGKZWYTDT1V'
        }] }, quoteSymbolIndex([{ mint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', symbol: 'AAPLx' }]));
        expect(row.pair).toBe('AAPLx/USDC');
        expect(row.pairFull).toBe('XSBEHLATCF6HDFPFZ5XEMDQW8NFAVCSP5BDUDRLJZJP/EPJFWDD5AUFQSSQEM2QN1XZYBAPC8G4WEGGKZWYTDT1V');
    });

    it('drops an unusable link rather than emitting it as an href', () => {
        const [row] = venueRows({ cex: [{ market: 'Evil', url: 'javascript:alert(1)' }] });
        expect(row.url).toBeNull();
    });

    it('is an empty list for anything that is not a venue set', () => {
        for (const bad of [null, undefined, {}, 'x', 7, { dex: 'no', cex: null }]) {
            expect(venueRows(bad)).toEqual([]);
        }
        expect(venueRows([null, {}, { nothing: true }])).toEqual([]);
    });
});

describe('pairLegLabel / quoteSymbolIndex', () => {
    const index = quoteSymbolIndex([
        { mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', symbol: 'SPYx' },
        // Two mints that uppercase alike are ambiguous: neither name is used.
        { mint: 'AbCdEfGhJkLmNpQrStUvWxYz123456789abcdefghij', symbol: 'ONE' },
        { mint: 'ABCDEFGHJKLMNPQRSTUVWXYZ123456789ABCDEFGHIJ', symbol: 'TWO' }
    ]);

    it('names USDC, USDT and SOL from their Solana mints in any case', () => {
        expect(pairLegLabel('EPJFWDD5AUFQSSQEM2QN1XZYBAPC8G4WEGGKZWYTDT1V')).toBe('USDC');
        expect(pairLegLabel('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe('USDC');
        expect(pairLegLabel('ES9VMFRZACERMJFRF4H2FYD4KCONKY11MCCE8BENWNYB')).toBe('USDT');
        expect(pairLegLabel('SO11111111111111111111111111111111111111112')).toBe('SOL');
        expect(pairLegLabel('0X55D398326F99059FF775485246999027B3197955')).toBe('USDT');
    });

    it('names our own mints from the token index and shortens an address nobody names', () => {
        expect(pairLegLabel('XSOCS1TFEYFFHFVJ8ETZ528L3CAKBDBRQRAPNBBDF2W', index)).toBe('SPYx');
        expect(pairLegLabel('XSOCS1TFEYFFHFVJ8ETZ528L3CAKBDBRQRAPNBBDF2W')).toBe('XSOC…DF2W');
        expect(pairLegLabel('ABCDEFGHJKLMNPQRSTUVWXYZ123456789ABCDEFGHIJ', index)).toBe('ABCD…GHIJ');
        expect(pairLegLabel('BJCRMWM8E25RGJKYAFE56FC7BXRGGPW96JUKXRJFEROT', index)).toBe('BJCR…EROT');
    });

    it('leaves a symbol alone and keeps a missing leg null', () => {
        expect(pairLegLabel('USDT')).toBe('USDT');
        expect(pairLegLabel('USDON', index)).toBe('USDON');
        expect(pairLegLabel(null)).toBeNull();
        expect(pairLegLabel('  ')).toBeNull();
    });
});
