// Unit tests for the pure Pyth reference-price helpers (lib/pyth.mjs) and the .env reader
// (lib/env.mjs). Fixtures are verbatim copies of real responses read on 2026-09-16: three entries
// from the public Hermes equity feed list and the parsed price block Hermes returned for TSLA, so
// a change in how a price is decoded or a ticker is matched shows up as a value mismatch.

const { mkdtemp, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const {
    equitySymbolForTicker,
    indexFeedsBySymbol,
    findFeedForTicker,
    feedSummary,
    decodePythPrice,
    ageSeconds,
    premiumPct
} = require('./lib/pyth.mjs');
const { parseEnv, readEnvFile } = require('./lib/env.mjs');

const TSLA_FEED = {
    id: '16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1',
    market_hours: { is_open: true, next_open: 1789651800, next_close: 1789588800 },
    attributes: {
        asset_type: 'Equity',
        description: 'TESLA INC / US DOLLAR',
        display_symbol: 'TSLA',
        nasdaq_symbol: 'TSLA',
        quote_currency: 'USD',
        symbol: 'Equity.US.TSLA/USD'
    }
};

const QQQ_FEED = {
    id: '9695e2b96ea7b3859da9ed25b7a46a920a776e2fdae19a7bcfdf2b219230452d',
    market_hours: { is_open: true, next_open: 1789651800, next_close: 1789588800 },
    attributes: {
        asset_type: 'Equity',
        description: 'INVESCO QQQ TRUST SERIES 1 / US DOLLAR',
        display_symbol: 'QQQ',
        nasdaq_symbol: 'QQQ',
        quote_currency: 'USD',
        symbol: 'Equity.US.QQQ/USD'
    }
};

// Heico class A — the one US ticker in the list whose symbol carries a dot, the shape a BRK.B
// style ticker would take. Kept so the exact-match rule is exercised against it.
const HEI_A_FEED = {
    id: '63177e3222a0a162829f2a53b2ea3861546ce54184fb2e85b8bf0e59ef1b73ef',
    market_hours: { is_open: true, next_open: 1789651800, next_close: 1789588800 },
    attributes: {
        asset_type: 'Equity',
        description: 'HEICO CORP NEW CLS A / US DOLLAR',
        display_symbol: 'HEI.A',
        nasdaq_symbol: 'HEI.A',
        quote_currency: 'USD',
        symbol: 'Equity.US.HEI.A/USD'
    }
};

// Hong Kong feed: the same endpoint carries non-US equities, which must never satisfy a US ticker.
const HK_FEED = {
    id: 'b360fcd1e6f90694e6d20640c90f20b09fb76b6dcd4fd890b4c7361b8b93ce82',
    market_hours: { is_open: false, next_open: 1789608600, next_close: 1789617600 },
    attributes: { asset_type: 'Equity', display_symbol: 'CLP HOLDINGS', nasdaq_symbol: '0002', quote_currency: 'HKD', symbol: 'Equity.HK.0002/HKD' }
};

const FEEDS = [TSLA_FEED, QQQ_FEED, HEI_A_FEED, HK_FEED];

// Verbatim `parsed[0]` for TSLA from GET /v2/updates/price/latest on 2026-09-16.
const TSLA_PARSED = {
    ema_price: { conf: '6862', expo: -5, price: '35848342', publish_time: 1789567666 },
    id: '16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1',
    metadata: { prev_publish_time: 1789567665, proof_available_time: 1789567666, slot: 35791353320 },
    price: { conf: '4500', expo: -5, price: '36062500', publish_time: 1789567666 }
};

describe('equity feed matching', () => {
    it('builds the Hermes symbol for a ticker', () => {
        expect(equitySymbolForTicker('TSLA')).toBe('Equity.US.TSLA/USD');
        expect(equitySymbolForTicker(' TSLA ')).toBe('Equity.US.TSLA/USD');
        expect(equitySymbolForTicker('')).toBe(null);
        expect(equitySymbolForTicker(null)).toBe(null);
        expect(equitySymbolForTicker(undefined)).toBe(null);
    });

    it('matches Equity.US.TSLA/USD for ticker TSLA', () => {
        const feed = findFeedForTicker(FEEDS, 'TSLA');
        expect(feed).not.toBe(null);
        expect(feed.id).toBe(TSLA_FEED.id);
        expect(feed.attributes.symbol).toBe('Equity.US.TSLA/USD');
    });

    it('does NOT match TSLA for the Shift-truncated ticker TSL', () => {
        // Shift's TSL2L reduces to TSL, which is not a listed US ticker. A prefix match here would
        // silently price a 2x token against Tesla spot.
        expect(findFeedForTicker(FEEDS, 'TSL')).toBe(null);
        expect(findFeedForTicker(FEEDS, 'TSLAX')).toBe(null);
        expect(findFeedForTicker(FEEDS, 'tsla')).toBe(null);
    });

    it('returns null for an unmatched ticker and for an empty one', () => {
        expect(findFeedForTicker(FEEDS, 'SPCX')).toBe(null);
        expect(findFeedForTicker(FEEDS, 'BRK.B')).toBe(null);
        expect(findFeedForTicker(FEEDS, '')).toBe(null);
        expect(findFeedForTicker(FEEDS, null)).toBe(null);
        expect(findFeedForTicker([], 'TSLA')).toBe(null);
    });

    it('matches a dotted US ticker exactly, and never a non-US listing', () => {
        expect(findFeedForTicker(FEEDS, 'HEI.A').id).toBe(HEI_A_FEED.id);
        expect(findFeedForTicker(FEEDS, 'HEI')).toBe(null);
        expect(findFeedForTicker(FEEDS, '0002')).toBe(null);
    });

    it('accepts a prebuilt index as well as the raw array', () => {
        const index = indexFeedsBySymbol(FEEDS);
        expect(index.size).toBe(4);
        expect(findFeedForTicker(index, 'QQQ').id).toBe(QQQ_FEED.id);
    });

    it('keeps the feed id and the market-open flag off a matched feed', () => {
        expect(feedSummary(TSLA_FEED)).toEqual({
            feedId: TSLA_FEED.id,
            marketOpen: true,
            displaySymbol: 'TSLA',
            description: 'TESLA INC / US DOLLAR'
        });
        expect(feedSummary(HK_FEED).marketOpen).toBe(false);
        expect(feedSummary(null).marketOpen).toBe(null);
        expect(feedSummary({ id: 'x' }).marketOpen).toBe(null);
    });
});

describe('price decoding', () => {
    it('applies the exponent to the integer price and conf', () => {
        const decoded = decodePythPrice({ price: '35681581012', conf: '17840790', expo: -8, publish_time: 1789567666 });
        expect(decoded.price).toBe(356.81581012);
        expect(decoded.conf).toBe(0.1784079);
        expect(decoded.expo).toBe(-8);
        expect(decoded.publishTime).toBe(1789567666);
    });

    it('decodes the real TSLA block', () => {
        const decoded = decodePythPrice(TSLA_PARSED.price);
        expect(decoded.price).toBeCloseTo(360.625, 6);
        expect(decoded.conf).toBeCloseTo(0.045, 6);
        expect(decoded.publishTime).toBe(1789567666);
    });

    it('handles a positive and a zero exponent', () => {
        expect(decodePythPrice({ price: '42', expo: 0 }).price).toBe(42);
        expect(decodePythPrice({ price: '42', expo: 2 }).price).toBe(4200);
    });

    it('returns null rather than 0 for a missing price, conf or exponent', () => {
        expect(decodePythPrice({ price: null, conf: null, expo: -8 })).toEqual({ price: null, conf: null, expo: -8, publishTime: null });
        expect(decodePythPrice({ price: '35681581012' }).price).toBe(null);
        expect(decodePythPrice({ price: 'not-a-number', expo: -8 }).price).toBe(null);
        expect(decodePythPrice({}).price).toBe(null);
        expect(decodePythPrice(null).price).toBe(null);
        expect(decodePythPrice({ price: '1', conf: '', expo: -2 }).conf).toBe(null);
    });

    it('computes the age of a publish time and nothing else', () => {
        expect(ageSeconds(1789567666, 1789567696000)).toBe(30);
        expect(ageSeconds(null)).toBe(null);
        expect(ageSeconds('1789567666')).toBe(null);
        expect(ageSeconds(undefined)).toBe(null);
    });
});

describe('premium', () => {
    it('measures the token price against the reference in percent', () => {
        expect(premiumPct(356.82, 356.71)).toBeCloseTo(0.03, 2);
        expect(premiumPct(356.71, 356.82)).toBeCloseTo(-0.03, 2);
        expect(premiumPct(100, 50)).toBeCloseTo(100, 10);
        expect(premiumPct(50, 50)).toBe(0);
    });

    it('is null, never 0, when either side is missing or non-positive', () => {
        expect(premiumPct(356.82, 0)).toBe(null);
        expect(premiumPct(356.82, null)).toBe(null);
        expect(premiumPct(356.82, NaN)).toBe(null);
        expect(premiumPct(356.82, undefined)).toBe(null);
        expect(premiumPct(356.82, -12)).toBe(null);
        expect(premiumPct(null, 356.71)).toBe(null);
        expect(premiumPct(0, 356.71)).toBe(null);
        expect(premiumPct(NaN, 356.71)).toBe(null);
        expect(premiumPct('', 356.71)).toBe(null);
    });
});

describe('.env parsing', () => {
    it('reads KEY=value lines, ignoring comments and blanks', () => {
        const parsed = parseEnv([
            '# a comment',
            '',
            'PYTH_API_KEY=abc123',
            '   SPACED = value with spaces  ',
            'export EXPORTED=ok'
        ].join('\n'));
        expect(parsed).toEqual({ PYTH_API_KEY: 'abc123', SPACED: 'value with spaces', EXPORTED: 'ok' });
    });

    it('strips matching quotes and keeps = inside a value', () => {
        const parsed = parseEnv('A="quoted"\nB=\'single\'\nC=base64==\nD="un-matched\nE=');
        expect(parsed.A).toBe('quoted');
        expect(parsed.B).toBe('single');
        expect(parsed.C).toBe('base64==');
        expect(parsed.D).toBe('"un-matched');
        expect(parsed.E).toBe('');
    });

    it('skips lines that are not assignments', () => {
        expect(parseEnv('just a line\n=novalue\n1BAD=x\nOK=1')).toEqual({ OK: '1' });
        expect(parseEnv(null)).toEqual({});
        expect(parseEnv('')).toEqual({});
    });

    it('returns {} for a missing file and the parsed contents for a present one', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'stocks-env-'));
        await expect(readEnvFile(join(dir, 'nope.env'))).resolves.toEqual({});
        const path = join(dir, '.env');
        await writeFile(path, '# secret\nPYTH_API_KEY="k-123"\n', 'utf8');
        await expect(readEnvFile(path)).resolves.toEqual({ PYTH_API_KEY: 'k-123' });
    });
});
