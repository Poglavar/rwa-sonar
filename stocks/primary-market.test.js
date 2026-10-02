// The primary-market record (stocks/data/primary-market.json) and its reading
// (stocks/lib/primary-market.mjs): every issuer with tokens has an entry, every entry is well formed,
// the verdict follows from who can create and redeem and how fast, Ondo's six 24/7 tokens read
// differently from its others, and the HTML carries the verdict and the facts.
import { readFileSync } from 'node:fs';

import { fixture } from '../test-fixtures/catalogue.js';
import {
    HOURS, MECHANISMS, SETTLEMENTS, VERDICTS, WHO, anchorObservation, hoursFor, priceAnchor, primaryMarketHtml,
    shapePrimaryMarket, validatePrimaryMarket
} from './lib/primary-market.mjs';

const DOC = JSON.parse(readFileSync(new URL('./data/primary-market.json', import.meta.url), 'utf8'));
const TOKENS = JSON.parse(readFileSync(fixture('stocks-tokens.json'), 'utf8')).tokens;

describe('the record', () => {
    test('validates, and covers every issuer that has tokens', () => {
        expect(validatePrimaryMarket(DOC)).toEqual([]);
        const issuers = new Set(TOKENS.map((token) => token.issuer));
        for (const slug of issuers) expect(Object.keys(DOC.issuers)).toContain(slug);
    });

    test('every entry names an issuer dossier', () => {
        for (const slug of Object.keys(DOC.issuers)) {
            const files = ['', '-spcx', '-blsh', '-secz'].map((suffix) => `./data/issuers/${slug}${suffix}.json`);
            expect(files.some((file) => { try { readFileSync(new URL(file, import.meta.url)); return true; } catch { return false; } })).toBe(true);
        }
    });

    test('a malformed entry is named, not accepted', () => {
        const problems = validatePrimaryMarket({ issuers: { x: { ...DOC.issuers.prestocks, who: 'friends', hoursText: '', checkedAt: 'yesterday' } } });
        expect(problems).toEqual(expect.arrayContaining([
            expect.stringMatching(/^x: who must be one of/), 'x: hoursText must be a non-empty string', 'x: checkedAt must be a YYYY-MM-DD date'
        ]));
        expect(validatePrimaryMarket({ issuers: { y: { ...DOC.issuers.tessera, who: 'onboarded' } } })).toContain('y: who "nobody" and mechanism "none" go together');
        expect(validatePrimaryMarket({})).toEqual(['issuers: missing']);
    });

    test('the vocabularies are what the verdict reads', () => {
        expect(WHO).toContain('nobody');
        expect(MECHANISMS).toContain('none');
        expect(SETTLEMENTS).toContain('instant');
        expect(HOURS).toContain('24/7');
        expect(VERDICTS).toEqual(['anchored', 'anchored-by-few', 'anchored-slowly', 'floats', 'no-open-market']);
    });
});

describe('the verdict', () => {
    const ondo = DOC.issuers['ondo-global-markets'];

    test('open to many and instant: anchored, with the token’s own hours', () => {
        expect(priceAnchor(ondo, 'AAPLon')).toMatchObject({ verdict: 'anchored', tone: 'good', words: 'arbitrage open to onboarded wallets' });
        expect(priceAnchor(ondo, 'AAPLon').sentence).toBe('Arbitrage is open to wallets the issuer has onboarded while the rail is open, so the price should track the share in US market hours; outside them it floats.');
        expect(priceAnchor(ondo, 'NVDAon').sentence).toBe('Arbitrage is open to wallets the issuer has onboarded, instantly and around the clock, so the price should stay close to the share.');
        expect(hoursFor(ondo, 'NVDAon')).toEqual({ hours: '24/7', hoursText: ondo.hoursExceptions.hoursText });
        expect(hoursFor(ondo, 'AAPLon').hours).toBe('market-hours');
        expect(priceAnchor(DOC.issuers['backpack-securities'], 'SPCX')).toMatchObject({ verdict: 'anchored', words: 'arbitrage open to verified exchange users' });
    });

    test('a few authorized participants or market makers: anchored by few', () => {
        expect(priceAnchor(DOC.issuers['xstocks-backed'], 'NVDAx')).toMatchObject({ verdict: 'anchored-by-few', tone: 'good', words: 'only authorized participants can arbitrage' });
        expect(priceAnchor(DOC.issuers.shift, 'SPYs')).toMatchObject({ verdict: 'anchored-by-few', words: 'only professional market makers can arbitrage' });
    });

    test('no one can create or redeem: the price floats', () => {
        for (const slug of ['prestocks', 'tessera', 'remora-markets', 'republic-mirror']) {
            expect(priceAnchor(DOC.issuers[slug], 'X')).toMatchObject({ verdict: 'floats', tone: 'warning', words: 'no one can create or redeem: the price floats' });
        }
    });

    test('allowlisted holders with no open market: nothing to keep honest', () => {
        for (const slug of ['superstate-opening-bell', 'securitize', 'bullish']) {
            expect(priceAnchor(DOC.issuers[slug], 'X')).toMatchObject({ verdict: 'no-open-market', tone: 'unknown' });
        }
    });

    test('open to many but slow: anchored slowly', () => {
        expect(priceAnchor({ ...ondo, settlement: 'days' }, 'AAPLon')).toMatchObject({ verdict: 'anchored-slowly', tone: 'caution' });
    });

    test('shape resolves the hours and drops the exception list; no entry gives null', () => {
        const shaped = shapePrimaryMarket(ondo, 'TSLAon');
        expect(shaped.hours).toBe('24/7');
        expect(shaped.hoursExceptions).toBeUndefined();
        expect(shaped.anchor.verdict).toBe('anchored');
        expect(shapePrimaryMarket(null, 'X')).toBeNull();
    });
});

describe('the HTML', () => {
    test('opens with the verdict, lists the facts, and links the full terms', () => {
        const html = primaryMarketHtml(shapePrimaryMarket(DOC.issuers['xstocks-backed'], 'NVDAx'), { seenOnChain: '3 redemptions in 30 days', termsHref: '#rights' });
        expect(html).toContain('<p class="price-anchor price-anchor-good"><strong>Only authorized participants can create and redeem');
        expect(html).toContain('<dt>Who can create and redeem</dt>');
        expect(html).toContain('<dt>Minimum</dt><dd>$5,000 direct with the issuer</dd>');
        expect(html).toContain('<dt>Shares or cash</dt><dd>Yes, through xPort');
        expect(html).toContain('<dt>Seen on chain</dt><dd>3 redemptions in 30 days</dd>');
        expect(html).toContain('Read on 2026-09-30 from the issuer’s redemption terms');
        expect(html).toContain('<a href="#rights">Can a holder redeem?</a>');
    });

    test('a note after the verdict, escaped text, and nothing without an entry', () => {
        const html = primaryMarketHtml(shapePrimaryMarket({ ...DOC.issuers.bullish, anchorNote: 'A <b>note</b>' }, 'BLSH'));
        expect(html).toContain('there is no price to keep honest.</strong> A &lt;b&gt;note&lt;/b&gt;</p>');
        expect(html).not.toContain('<dt>Seen on chain</dt>');
        expect(primaryMarketHtml(null)).toBe('');
    });
});

describe('the verdict against today’s market', () => {
    test('a wide premium in a tiny pool is nobody bothering, not a failed rail', () => {
        expect(anchorObservation({ verdict: 'anchored', hours: 'market-hours', premiumPct: 13.28, liquidityUsd: 911.93, marketOpen: true }))
            .toBe('Today’s DEX price is +13.3% off the share, in a pool holding $912: too small for anyone to bother arbitraging, not a sign the rail failed.');
    });

    test('a wide premium with real liquidity means an idle rail or a stale reference; after hours, a shut rail', () => {
        expect(anchorObservation({ verdict: 'anchored-by-few', hours: '24/5', premiumPct: -4.2, liquidityUsd: 2234601, marketOpen: true }))
            .toBe('Yet today’s DEX price is −4.2% off the share with $2.2M of liquidity: the rail is not being used right now, or the reference price is stale.');
        expect(anchorObservation({ verdict: 'anchored', hours: 'market-hours', premiumPct: 5, liquidityUsd: 50000, marketOpen: false }))
            .toBe('Today’s DEX price is +5.0% off the share while US markets are closed and the rail is shut; the gap floats until they open.');
        expect(anchorObservation({ verdict: 'anchored', hours: '24/7', premiumPct: 5, liquidityUsd: 50000, marketOpen: false }))
            .toMatch(/^Yet today’s DEX price is \+5\.0% off the share/);
    });

    test('a small premium adds nothing while the rail is open; a shut rail is named; a missing measurement never reads as 0', () => {
        expect(anchorObservation({ verdict: 'anchored', hours: 'market-hours', premiumPct: 0.4, liquidityUsd: 500, marketOpen: true })).toBeNull();
        expect(anchorObservation({ verdict: 'anchored', hours: 'market-hours', premiumPct: 0.4, liquidityUsd: 500, marketOpen: false }))
            .toBe('US markets are closed now, so the rail is shut and the price floats until they open.');
        expect(anchorObservation({ verdict: 'anchored', hours: 'market-hours', premiumPct: null, liquidityUsd: null, marketOpen: true })).toBeNull();
        expect(anchorObservation({ verdict: 'anchored', hours: 'market-hours', premiumPct: 9, liquidityUsd: null, marketOpen: true }))
            .toBe('Yet today’s DEX price is +9.0% off the share: the rail is not being used right now, or the reference price is stale.');
        for (const verdict of ['floats', 'no-open-market', 'anchored-slowly']) {
            expect(anchorObservation({ verdict, hours: 'none', premiumPct: 30, liquidityUsd: 100, marketOpen: true })).toBeNull();
        }
    });

    test('the sentence follows the verdict in the same paragraph', () => {
        const html = primaryMarketHtml(shapePrimaryMarket(DOC.issuers['ondo-global-markets'], 'AAPLon'), { observation: 'Today’s DEX price is +13.3% off.' });
        expect(html).toContain('outside them it floats.</strong> Today’s DEX price is +13.3% off.</p>');
    });
});
