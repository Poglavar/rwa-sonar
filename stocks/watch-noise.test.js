// The document watcher's noise rules (lib/watch.mjs `HTML_WIDGET_PATTERNS`, `stripInlineWidgets`,
// `VOLATILE_JSON_KEY`): two reads of an unchanged document must hash the same, and a real change
// must not. The samples are cut from consecutive prod versions of the sources that recorded a new
// version every day between 2026-10-08 and 2026-11-23 (91-181 versions a day); each pair below is
// the whole difference those two versions had, unless the test says it adds a genuine change.

import { htmlToText, jsonToText, sha256Hex } from './lib/watch.mjs';

const sameHash = (a, b) => sha256Hex(a) === sha256Hex(b);
const page = (lines) => `<html><body><main><h1>Doc</h1>${lines.map((l) => `<p>${l}</p>`).join('')}<p>The terms of this document.</p></main></body></html>`;
const html = (lines) => htmlToText(page(lines));
const json = (value) => jsonToText(JSON.stringify(value));

describe('HTML: live widgets do not make a new version', () => {
    test.each([
        ['an amount with a magnitude (kraken.com, bnbchain.org)', ['$1.20T', '$203.79B', '4.533M'], ['$1.22T', '$209.23B', '4.240M']],
        ['a price with a space after the sign (ondo.finance)', ['$ 1.1540'], ['$ 1.1541']],
        ['a price move with its window (ondo.finance/global-markets)', ['$15.18 (10.44%) 24H'], ['$4.14 (3.18%) 24H']],
        ['a change from 30 days ago and a data stamp (app.rwa.xyz)', ['▲ + 206.28 % from 30d ago', 'as of 11/22/2026'], ['▲ + 194.35 % from 30d ago', 'as of 11/23/2026']],
        ['a supply in the token\'s unit (superstate.com/assets)', ['60,335,319 USTB'], ['60,317,557 USTB']],
        ['a relative "last updated" (terms.tessera.pe, docs.superstate.com)', ['Last updated 23 days ago'], ['Last updated 24 days ago']],
        ['a follower count with a verb (x.com)', ['Join 3,835 followers'], ['Join 3,856 followers']],
        ['a render time (app.companiesoffice.govt.nz)', ['Generated on Sunday, 22 November 2026 15:42:43 NZDT'], ['Generated on Monday, 23 November 2026 15:42:10 NZDT']],
        ['a market strip (cryptobriefing.com)',
            ['Fear &amp; Greed 12 Extreme Fear', 'Crypto market $2.10T +0.9% 24h breadth 135 up 114 down Bitcoin $59,796 +0.8%'],
            ['Fear &amp; Greed 11 Extreme Fear', 'Crypto market $2.13T +1.1% 24h breadth 149 up 92 down Bitcoin $60,959 +1.3%']],
        ['a staking banner (solanacompass.com)', ['Earn 5.26% APY natively staking SOL with Solana Compass', 'Earn 5.26%'], ['Earn 5.19% APY natively staking SOL with Solana Compass', 'Earn 5.19%']],
        ['a price chip in article prose (solanacompass.com)',
            ['Shift RWA has listed its products on Jupiter JUP $0.218 -2.8% , making them tradeable.'],
            ['Shift RWA has listed its products on Jupiter JUP $0.232 +2.8% , making them tradeable.']],
        ['a post\'s view counter (x.com)', ['13:00 · 8 Oct 2026 · 799.9k'], ['13:00 · 8 Oct 2026 · 800.4k']],
        ['a session label (app.ondo.finance)', ['( Off-Hours )'], []],
        ['the docs agent hint in its two wordings (docs.tessera.pe)',
            ['For the complete documentation index, see llms.txt . This page is also available as Markdown .'],
            ['For the complete documentation index, see llms.txt . Markdown versions of documentation pages are available by appending .md to page URLs.']],
        ['a code block with and without spaces before punctuation (docs.ondo.finance)', ['"symbol": "AAPLon",'], ['"symbol" : "AAPLon" ,']]
    ])('%s', (_name, before, after) => {
        expect(sameHash(html(before), html(after))).toBe(true);
    });

    test('a real change still changes the hash, and a document date with a label stays', () => {
        expect(sameHash(html(['Redemption fee 0.50%']), html(['Redemption fee 0.75%']))).toBe(false);
        expect(sameHash(html(['Last updated 2026-09-08']), html(['Last updated 2026-11-20']))).toBe(false);
        expect(sameHash(html(['Mint authority: 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU']), html(['Mint authority: 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM']))).toBe(false);
        // A sentence that only mentions a market is prose, not the strip.
        expect(html(['Crypto market makers withdrew liquidity.'])).toContain('Crypto market makers withdrew liquidity.');
    });

    test('the quote reading keeps every widget (a quote may cite a price)', () => {
        expect(htmlToText(page(['Jupiter JUP $0.218 -2.8% , making', '$1.20T']), { forQuotes: true })).toMatch(/JUP \$0\.218 -2\.8% , making[\s\S]*\$1\.20T/);
    });
});

describe('JSON: market and request fields do not make a new version', () => {
    test('Jupiter token search: price, holders, stats, organic score and stamps move; the token does not', () => {
        const token = (price, holders, organic, at) => ({
            id: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', name: 'Tesla xStock', symbol: 'TSLAx', decimals: 8,
            usdPrice: price, holderCount: holders, organicScore: organic, organicScoreLabel: 'medium', fdv: price * 1e5, mcap: price * 9e4, liquidity: 812345.1,
            stats24h: { priceChange: 1.2, buyVolume: 1000 }, audit: { mintAuthorityDisabled: false, freezeAuthorityDisabled: false }, updatedAt: at
        });
        expect(sameHash(json([token(431.2, 14547, 61.3, '2026-11-22T04:08:51Z')]), json([token(437.9, 14526, 58.0, '2026-11-23T04:10:54Z')]))).toBe(true);
        // A token newly matching the search is a genuine change.
        const spam = { ...token(0.001, 3, 0, 'x'), id: 'So1aNaSpaMMint1111111111111111111111111111', name: 'TSLAx' };
        expect(sameHash(json([token(431.2, 1, 1, 'x')]), json([token(431.2, 1, 1, 'x'), spam]))).toBe(false);
        // An authority change is a genuine change.
        const frozen = token(431.2, 1, 1, 'x');
        frozen.audit.freezeAuthorityDisabled = true;
        expect(sameHash(json([token(431.2, 1, 1, 'x')]), json([frozen]))).toBe(false);
    });

    test('Backpack ticker, SEC full-text search, GLEIF and Raydium: response metadata only', () => {
        const ticker = (last, trades) => ({ symbol: 'SPCX.US_USDC', firstPrice: '128.24', high: '131.03', low: '127.72', lastPrice: last, priceChange: '2.69', priceChangePercent: '0.020976', quoteVolume: '22428.1907', volume: '172.5', trades });
        expect(sameHash(json(ticker('130.93', '119')), json(ticker('131.46', '40')))).toBe(true);
        const efts = (took, score) => ({ took, hits: { hits: [{ _id: '0001-26-000123', _score: score, _source: { display_names: ['RepublicX LLC'] } }] } });
        expect(sameHash(json(efts(450, 11.009872)), json(efts(39, 11.010035)))).toBe(true);
        const gleif = (at) => ({ meta: { goldenCopy: { publishDate: at } }, data: [{ id: '5493001KJTIIGC8Y1R12', attributes: { entity: { legalName: { name: 'Step Labs LLC' } } } }] });
        expect(sameHash(json(gleif('2026-11-21T16:00:00Z')), json(gleif('2026-11-22T16:00:00Z')))).toBe(true);
        const raydium = (id) => ({ id, success: true, data: [{ id: '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2', tvl: 1 }] });
        expect(sameHash(json(raydium('bb4fd992-746a-4429-a80e-ee4ba3383a44')), json(raydium('b672314c-f54d-4c44-b9ff-ba340a40bd38')))).toBe(true);
        // A pool id inside the data is compared.
        const otherPool = { id: 'x', success: true, data: [{ id: '7XawhbbxtsRcQA8KTkHT9f9nc6d69UwqCDh6U5EEbEmX', tvl: 1 }] };
        expect(sameHash(json(raydium('x')), json(otherPool))).toBe(false);
    });

    test('a reshuffled list is the same list (api.xstocks.fi assets)', () => {
        const a = { network: 'solana', address: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', symbol: 'AAPLx' };
        const b = { network: 'ethereum', address: '0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a', symbol: 'AAPLx' };
        expect(sameHash(json({ assets: [a, b] }), json({ assets: [b, a] }))).toBe(true);
        expect(sameHash(json({ assets: [a, b] }), json({ assets: [a] }))).toBe(false);
    });

    test('Ondo assets: the session and the vendor\'s market block follow the clock; a real halt does not', () => {
        const asset = (session, paused, reason, shares) => ({
            symbol: 'NVDAon', ticker: 'NVDA', isTradingPaused: paused, primaryMarket: { price: '181.2', priceHistory24h: [{ timestamp: 1, price: '180' }] },
            underlyingMarket: { ticker: 'NVDA', sharesOutstanding: shares, marketCap: '4.4e12' },
            assetTradingStatus: { isAssetTradeable: !paused, assetPauseReason: reason, isMarketOpen: session !== 'closed', currentSession: session, nextMarketOpen: '2026-11-23T09:01:00Z' }
        });
        expect(sameHash(json({ assets: [asset('closed', true, 'unavailable_in_session', '31900000')] }),
            json({ assets: [asset('overnight', false, null, '31600000')] }))).toBe(true);
        expect(sameHash(json({ assets: [asset('regular', false, null, '1')] }), json({ assets: [asset('regular', true, 'corporate_action_halt', '1')] }))).toBe(false);
    });

    test('supplies, reserves and fees are compared as served', () => {
        expect(sameHash(json({ circulating_supply: '60335319.357451' }), json({ circulating_supply: '60317556.857231' }))).toBe(false);
        expect(sameHash(json({ symbol: 'ETH', withdrawalFee: '0.026' }), json({ symbol: 'ETH', withdrawalFee: '0.027' }))).toBe(false);
        expect(sameHash(json({ holdings: [{ provider: 'Alpaca', quantity: '295' }] }), json({ holdings: [{ provider: 'Alpaca', quantity: '296' }] }))).toBe(false);
        // A priced field appearing (null -> value) is still a change: the key keeps null apart from the mask.
        expect(sameHash(json({ tokenPrice: null }), json({ tokenPrice: '12.5' }))).toBe(false);
    });

    test('the quote reading keeps every value in the served order', () => {
        const text = jsonToText(JSON.stringify({ b: [2, 1], usdPrice: 431.2 }), { keepChurn: true });
        expect(text).toContain('431.2');
        expect(text.indexOf('2')).toBeLessThan(text.indexOf('1,') === -1 ? text.lastIndexOf('1') : text.indexOf('1,'));
    });
});
