// Each token's share of its underlying's tokenized shares on Solana (lib/solana-share.mjs), counted
// on outstanding supply, and the line a card prints from it (lib/cards.mjs solanaShareHtml).
import { outstandingOf, solanaShares } from './lib/solana-share.mjs';
import { solanaShareHtml } from './lib/cards.mjs';

describe('outstanding supply', () => {
    test('the issuer’s published float wins; otherwise supply minus the top-20 wallets labelled as the issuer’s', () => {
        expect(outstandingOf({ supplyUi: 154265, publicFloat: { floatUi: 27280 } })).toEqual({ units: 27280, basis: 'float' });
        const labelled = outstandingOf({ supplyUi: 1000, top20: [
            { ownerLabel: 'issuer-authority', sharePct: 70 }, { ownerLabel: 'issuer-inventory', sharePct: 5 }, { ownerLabel: null, sharePct: 10 }
        ] });
        expect(labelled).toMatchObject({ units: 250, basis: 'labelled', issuerHeldPct: 75 });
    });

    test('an unknown supply is unknown, never 0', () => {
        expect(outstandingOf({ supplyUi: null })).toBeNull();
        expect(outstandingOf({ supplyUi: undefined, top20: [] })).toBeNull();
    });
});

describe('shares of an underlying on Solana', () => {
    const row = (mint, symbol, units, extra = {}) => ({ mint, symbol, underlyingTicker: 'AAPL', instrumentType: 'stock', outstanding: units === null ? null : { units, basis: 'labelled' }, ...extra });

    test('each token’s share of the total across issuers, with the others named, largest first', () => {
        const shares = solanaShares([row('X', 'AAPLx', 27280), row('O', 'AAPLon', 373), row('B', 'AAPL', 1)]);
        expect(shares.get('X').sharePct).toBeCloseTo(98.65, 1);
        expect(shares.get('O')).toMatchObject({ tokens: 3, totalUnits: 27654, others: [{ symbol: 'AAPLx', units: 27280 }, { symbol: 'AAPL', units: 1 }] });
    });

    test('no share at all when any token of the ticker has an unknown supply, or units are not shares', () => {
        expect(solanaShares([row('X', 'AAPLx', 100), row('O', 'AAPLon', null)]).size).toBe(0);
        expect(solanaShares([row('L', 'TSL2L', 5, { instrumentType: 'leveraged' })]).size).toBe(0);
        expect(solanaShares([row('P', 'OPENAI', 5, { instrumentType: 'private-company' })]).size).toBe(0);
        expect(solanaShares([row('N', 'SECZ', 5, { underlyingTicker: null })]).size).toBe(0);
    });
});

describe('the card line', () => {
    test('names the share, the held shares and the other tokens; the only token says so; nothing without a share', () => {
        const [x] = [...solanaShares([{ mint: 'X', symbol: 'AAPLx', underlyingTicker: 'AAPL', instrumentType: 'stock', outstanding: { units: 27280, basis: 'float' } },
            { mint: 'O', symbol: 'AAPLon', underlyingTicker: 'AAPL', instrumentType: 'stock', outstanding: { units: 373, basis: 'labelled' } }]).values()];
        const html = solanaShareHtml({ symbol: 'AAPLx', solanaShare: x });
        expect(html).toMatch(/<b>98\.[0-9]%<\/b> of the AAPL tokenized on Solana \(2 tokens in total\)<\/p>$/);
        // The counts stay in the hover title.
        expect(html).toContain('the issuer’s published float');
        expect(html).toContain('AAPLx: 27,280 of 27,653 shares held by investors; also AAPLon.');
        const only = solanaShareHtml({ symbol: 'PFEx', solanaShare: { ticker: 'PFE', sharePct: 100, tokens: 1, units: 12.5, totalUnits: 12.5, basis: 'labelled', others: [] } });
        expect(only).toMatch(/>The only tokenized PFE on Solana<\/p>$/);
        expect(solanaShareHtml({ symbol: 'OPENAI', solanaShare: null })).toBe('');
    });
});
