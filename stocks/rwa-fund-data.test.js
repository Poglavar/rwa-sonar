import { superstateFund, decodeNav } from '../rwa/lib/fund-data.mjs';
const word = n => BigInt(n).toString(16).padStart(64, '0');
const round = values => '0x' + values.map(word).join('');
const fixture = () => ({ USTB: { instrument_symbol: 'USTB', instrument_name: 'Fund', total_supply: '123.456', current_price: null, features: { updated_at: '2026-01-01' }, deploy_status_by_chain: { by_chain: { '1': { type: 'Completed', token_address: '0xabc' } } } } });
test('registry null price and configuration timestamp never become a live NAV', () => {
    const parsed = superstateFund(fixture());
    expect(parsed.fields.price).toEqual({ state: 'unknown', value: null });
    expect(parsed.sourcePeriod).toBeNull();
});
test('missing registry supply fails rather than becoming zero', () => {
    const body = fixture(); body.USTB.total_supply = null;
    expect(() => superstateFund(body)).toThrow('Malformed');
});
test('NAV source period and evidence freshness use the round timestamp', () => {
    const result = decodeNav(round([1, 1001000, 100, 100, 1]), '0x' + word(6), 100 + 8 * 86400);
    expect(result.evidenceStatus).toBe('stale');
    expect(result.sourcePeriod).toBe('1970-01-01T00:01:40.000Z');
});
test.each([[1, 0, 100, 100, 1], [2, 100, 100, 100, 1], [1, 2n ** 255n, 100, 100, 1], [1, 100, 100, 1000, 1]])('rejects invalid NAV round %j', (...values) => {
    expect(() => decodeNav(round(values), '0x' + word(6), 200)).toThrow('Invalid');
});

import { failedSourceReads, runFailed } from './lib/watch.mjs';
test('research sources require substantive readable content, not just reachability', () => {
    const results = [{ status: 'ok' }, { status: 'reachable-unverified' }, { status: 'blocked' }];
    expect(runFailed(results)).toBe(false);
    expect(runFailed(results, { requireContent: true })).toBe(true);
    expect(failedSourceReads(results, { requireContent: true })).toHaveLength(2);
});
