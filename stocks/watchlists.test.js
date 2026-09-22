import { buildWatchSnapshot, diffWatch, formatWatchNoticeLines } from './lib/watchlists.mjs';

const before = {
    ticker: 'NVDA',
    savedAt: '2026-09-18T06:00:00Z',
    products: {
        'xstocks-backed': {
            cashRedemption: true, confirmedCollateral: true, autonomousLiquidation: false,
            exitRating: 'conditional', protocols: ['Kamino'], liquidityUsd: 200_000,
            evidencePending: false
        }
    }
};

describe('persistent watchlist change shaping', () => {
    test('retains a lone wrapper instead of silently producing an empty watch', () => {
        const snapshot = buildWatchSnapshot({ underlying_ticker: 'FGDL', issuer_slugs: ['xstocks-backed'] }, {
            tokens: [{ mint: 'gold', symbol: 'FGDLx', issuer: 'xstocks-backed', underlyingTicker: 'FGDL' }],
            issuers: [{ slug: 'xstocks-backed' }], defiUsage: null, composability: null
        });
        expect(Object.keys(snapshot.products)).toEqual(['xstocks-backed']);
        expect(snapshot.products['xstocks-backed'].liquidityUsd).toBeNull();
    });
    test('a missing baseline is a baseline, not an alert', () => {
        expect(diffWatch({ watch_id: 'w', underlying_ticker: 'NVDA', baseline: null }, before)).toEqual([]);
    });

    test('material changes retain watch identity but bounded Telegram lines do not expose keys', () => {
        const current = structuredClone(before);
        current.products['xstocks-backed'].confirmedCollateral = false;
        current.products['xstocks-backed'].protocols = [];
        current.products['xstocks-backed'].liquidityUsd = 50_000;
        const events = diffWatch({
            watch_id: '3a83adbe-d9ec-4f41-9167-4e295e62daf6', title: 'My NVIDIA wrappers',
            underlying_ticker: 'NVDA', baseline: before
        }, current);
        expect(events).toHaveLength(3);
        expect(events[0]).toMatchObject({ ticker: 'NVDA', title: 'My NVIDIA wrappers' });
        const lines = formatWatchNoticeLines(events, 3);
        expect(lines).toHaveLength(3);
        expect(lines.join('\n')).toContain('My NVIDIA wrappers');
        expect(lines.join('\n')).not.toContain('3a83adbe');
    });
});
