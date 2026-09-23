// Fast tests for the xStocks public-float arithmetic (stocks/lib/xstocks-float.mjs): raw-unit
// subtraction, the multiple-token-account treasury, null-not-zero on a missing mint, the
// inconsistent-read guard, the previous-day baseline and the dossier citation check.
const {
    XSTOCKS_ISSUER_WALLETS, aggregate, dossierCitations, floatRow, mintFacts, pushHistory, rollPrevious, sumInventory, toUnits
} = require('./lib/xstocks-float.mjs');
const dossier = require('./data/issuers/xstocks-backed.json');

const TREASURY = 'S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS';
const REDEEM = 'CgyuW2dWDJzWW2H1XTjPRkbg9Y41dW2Fjj69KWsiir8C';
const mintAccount = (supply, decimals, scaled = null) => ({ data: { parsed: { type: 'mint', info: {
    supply, decimals, extensions: scaled ? [{ extension: 'scaledUiAmountConfig', state: scaled }] : [] } } } });

describe('issuer-attributed wallets', () => {
    test('every wallet is cited in the xStocks dossier', () => {
        const cites = dossierCitations(dossier, XSTOCKS_ISSUER_WALLETS.map((w) => w.address));
        for (const w of XSTOCKS_ISSUER_WALLETS) expect([w.address, cites[w.address].length > 0]).toEqual([w.address, true]);
    });
    test('an address the dossier does not mention has no citations', () => {
        expect(dossierCitations(dossier, ['11111111111111111111111111111112'])['11111111111111111111111111111112']).toEqual([]);
    });
});

describe('mintFacts', () => {
    test('reads supply/decimals and the multiplier in force', () => {
        expect(mintFacts(mintAccount('100', 2, { multiplier: '1.5', newMultiplier: '2', newMultiplierEffectiveTimestamp: 50 }), 100))
            .toEqual({ supplyRaw: '100', decimals: 2, uiMultiplier: '2' });
        expect(mintFacts(mintAccount('100', 2, { multiplier: '1.5', newMultiplier: '2', newMultiplierEffectiveTimestamp: 500 }), 100).uiMultiplier).toBe('1.5');
        expect(mintFacts(mintAccount('100', 2), 100).uiMultiplier).toBe('1');
    });
    test('a missing account gives nulls, not zeros', () => {
        expect(mintFacts(null, 1)).toEqual({ supplyRaw: null, decimals: null, uiMultiplier: null });
    });
});

describe('float rows', () => {
    const mints = new Set(['M']);
    const inventory = sumInventory({
        [TREASURY]: [{ mint: 'M', amount: '600' }, { mint: 'M', amount: '100' }, { mint: 'OTHER', amount: '999' }],
        [REDEEM]: [{ mint: 'M', amount: '50' }, { mint: 'M', amount: '0' }]
    }, mints);

    test('sums every token account of every wallet, only for catalogued mints', () => {
        expect(inventory.get('M').total).toBe(750n);
        expect(inventory.get('M').byWallet).toEqual({ [TREASURY]: '700', [REDEEM]: '50' });
        expect(inventory.has('OTHER')).toBe(false);
    });
    test('float = supply − inventory in raw units, share of supply', () => {
        const row = floatRow({ mint: 'M', symbol: 'MX', facts: { supplyRaw: '1000', decimals: 2, uiMultiplier: '1.1' }, inventory: inventory.get('M') });
        expect(row).toMatchObject({ status: 'ok', floatRaw: '250', inventoryRaw: '750', inventorySharePct: 75 });
        expect(toUnits(row.floatRaw, 2, '1.1')).toBeCloseTo(2.75, 10);
    });
    test('no supply read → nulls; inventory above supply → inconsistent, never negative', () => {
        expect(floatRow({ mint: 'M', facts: { supplyRaw: null, decimals: null, uiMultiplier: null }, inventory: inventory.get('M') }))
            .toMatchObject({ status: 'no-supply', floatRaw: null, inventorySharePct: null });
        expect(floatRow({ mint: 'M', facts: { supplyRaw: '700', decimals: 2, uiMultiplier: '1' }, inventory: inventory.get('M') }))
            .toMatchObject({ status: 'inconsistent-read', floatRaw: null });
    });
    test('zero supply has no inventory share (0/0 is not 0 %)', () => {
        expect(floatRow({ mint: 'Z', facts: { supplyRaw: '0', decimals: 2, uiMultiplier: '1' }, inventory: undefined }).inventorySharePct).toBeNull();
    });
});

describe('aggregate, baseline and history', () => {
    const items = [
        { mint: 'A', status: 'ok', supplyRaw: '1000', inventoryRaw: '600', floatRaw: '400', decimals: 0, uiMultiplier: '1' },
        { mint: 'B', status: 'ok', supplyRaw: '10', inventoryRaw: '0', floatRaw: '10', decimals: 0, uiMultiplier: '1' },
        { mint: 'C', status: 'inconsistent-read', supplyRaw: '5', inventoryRaw: '9', floatRaw: null, decimals: 0, uiMultiplier: '1' }
    ];
    test('prices only what has a price and counts the rest', () => {
        expect(aggregate(items, (m) => (m === 'A' ? 2 : null))).toMatchObject({
            supplyUsd: 2000, inventoryUsd: 1200, floatUsd: 800, pricedMints: 1, unpricedMints: 1, inconsistentMints: 1, inventorySharePct: 60 });
    });
    test('the baseline rolls only on a new UTC day', () => {
        const existing = { readAt: '2026-09-22T10:00:00Z', items, previous: { readAt: 'older', floats: {} } };
        expect(rollPrevious(existing, '2026-09-23T01:00:00Z')).toEqual({ readAt: '2026-09-22T10:00:00Z', floats: { A: '400', B: '10' } });
        expect(rollPrevious(existing, '2026-09-22T18:00:00Z')).toEqual({ readAt: 'older', floats: {} });
        expect(rollPrevious(null, '2026-09-22T18:00:00Z')).toBeNull();
    });
    test('history keeps one row per day, newest last', () => {
        const h = pushHistory([{ date: '2026-09-21', v: 1 }, { date: '2026-09-22', v: 2 }], { date: '2026-09-22', v: 3 }, 2);
        expect(h).toEqual([{ date: '2026-09-21', v: 1 }, { date: '2026-09-22', v: 3 }]);
    });
});

describe('the xStocks card row', () => {
    const { buildCard, renderCard } = require('./lib/cards.mjs');
    const { cardFloatItem } = require('./lib/xstocks-float.mjs');
    const tokens = require('../stocks-tokens.json').tokens;
    const issuers = require('../stocks-issuers.json').issuers;
    const token = tokens.find((t) => t.issuer === 'xstocks-backed' && t.symbol === 'NVDAx') ?? tokens.find((t) => t.issuer === 'xstocks-backed');
    const issuer = issuers.find((i) => i.slug === 'xstocks-backed') ?? null;
    const floatFile = { readAt: '2026-09-23T22:31:59Z', items: [{ mint: token.mint, status: 'ok', floatRaw: '14252376954788', decimals: 8, uiMultiplier: '1', inventorySharePct: 55.7133 }] };
    const render = (floatItem) => renderCard(buildCard({ token, issuer, floatItem, slug: 'x', builtAt: 'b' }), { version: 'test' });

    test('cardFloatItem converts the read; a missing or inconsistent mint gives null', () => {
        expect(cardFloatItem(floatFile, token.mint)).toEqual({ floatUi: 142523.76954788, inventorySharePct: 55.7133, readAt: '2026-09-23T22:31:59Z' });
        expect(cardFloatItem(floatFile, 'other')).toBeNull();
        expect(cardFloatItem({ items: [{ mint: 'm', status: 'inconsistent-read', floatRaw: null }] }, 'm')).toBeNull();
    });
    test('adds one compact row (< 150 B) linking to the method, and nothing without a read', () => {
        const without = render(null);
        const withRow = render(cardFloatItem(floatFile, token.mint));
        expect(withRow).toContain('142,524 <span class="t">55.7% in issuer wallets</span> <a href="../flows.html#float">how</a>');
        expect(without).not.toContain('flows.html#float');
        expect(Buffer.byteLength(withRow) - Buffer.byteLength(without)).toBeLessThan(150);
    });
});
