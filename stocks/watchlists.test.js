import { updateSql } from './build-watchlist-changes.mjs';
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

    test('an exact-token watch names the mint when support changes or the token disappears', () => {
        const mint = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
        const data = {
            tokens: [{ mint, symbol: 'NVDAx', issuer: 'xstocks-backed', supplyUi: 10,
                control: { paused: false }, market: { liquidity: 200_000 } }],
            issuers: [], composability: null,
            defiUsage: { items: [{ mint, symbol: 'NVDAx', integrations: [{ id: 'kamino:collateral' }] }] }
        };
        const watch = { watch_id: 'token-watch', watch_type: 'token', target: { mint }, baseline: null };
        const baseline = buildWatchSnapshot(watch, data, Date.parse('2026-09-22T06:00:00Z'));
        const changed = buildWatchSnapshot(watch, { ...data, defiUsage: { items: [{ mint, symbol: 'NVDAx', integrations: [] }] } }, Date.parse('2026-09-23T06:00:00Z'));
        const events = diffWatch({ ...watch, baseline }, changed);
        expect(events).toHaveLength(1);
        expect(events[0].summary).toContain(`NVDAx ${mint}: exact-token protocol support changed`);
        // Advancing the baseline deduplicates this state, while a later reversal alerts again.
        expect(diffWatch({ ...watch, baseline: changed }, changed)).toEqual([]);
        expect(diffWatch({ ...watch, baseline: changed }, baseline)[0].summary).toContain('protocol support changed');
        const removed = buildWatchSnapshot(watch, { ...data, tokens: [] }, Date.parse('2026-09-24T06:00:00Z'));
        expect(diffWatch({ ...watch, baseline }, removed)[0].summary).toContain(`exact token removed`);
    });

    test('an issuer watch reports every exact mint added or removed', () => {
        const watch = { watch_id: 'issuer-watch', watch_type: 'issuer', target: { issuerSlug: 'issuer' }, baseline: null };
        const issuer = { slug: 'issuer', name: 'Issuer', status: 'live', discrepancies: [], redemption: {} };
        const before = buildWatchSnapshot(watch, { issuers: [issuer], tokens: [
            { mint: 'Mint1111111111111111111111111111111111111', issuer: 'issuer' }
        ], defiUsage: null, composability: null });
        const after = buildWatchSnapshot(watch, { issuers: [issuer], tokens: [
            { mint: 'Mint2222222222222222222222222222222222222', issuer: 'issuer' }
        ], defiUsage: null, composability: null });
        const summaries = diffWatch({ ...watch, baseline: before }, after).map((row) => row.summary);
        expect(summaries).toEqual(expect.arrayContaining([
            expect.stringContaining('exact token added Mint222'),
            expect.stringContaining('exact token removed Mint111')
        ]));
    });

    test('a protocol-market watch scopes LTV, activity and collateral changes to one exact route', () => {
        const mint = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
        const target = { mint, integrationId: 'kamino:collateral', marketKey: 'Market111' };
        const watch = { watch_id: 'market-watch', watch_type: 'protocol-market', target, baseline: null };
        const data = {
            issuers: [], tokens: [], composability: null,
            defiUsage: { fetchedAt: '2026-09-22T00:00:00Z', items: [{ mint, symbol: 'NVDAx', integrations: [{
                id: 'kamino:collateral', protocolName: 'Kamino', status: 'live',
                metrics: { sizeUsd: 200_000, maxLtvMax: 0.55 }, markets: [{ name: 'xStocks Pool', marketAddress: 'Market111' }]
            }] }] }, protocolMarketResearch: { markets: [] }
        };
        const before = buildWatchSnapshot(watch, data);
        const changedData = structuredClone(data);
        const integration = changedData.defiUsage.items[0].integrations[0];
        integration.status = 'inactive';
        integration.metrics = { sizeUsd: 100_000, maxLtvMax: 0.45 };
        const after = buildWatchSnapshot(watch, changedData);
        const summaries = diffWatch({ ...watch, baseline: before }, after).map((row) => row.summary);
        expect(summaries).toHaveLength(3);
        expect(summaries.every((summary) => summary.includes(mint) && summary.includes('xStocks Pool'))).toBe(true);
        expect(summaries.join('\n')).toMatch(/became inactive/);
        expect(summaries.join('\n')).toMatch(/maximum LTV changed from 55% to 45%/);
        expect(summaries.join('\n')).toMatch(/collateral value fell at least 25%/);
    });

    test('token changes name the exact field or protocol with its before and after', () => {
        const mint = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
        const data = {
            tokens: [{ mint, symbol: 'NVDAx', issuer: 'xstocks-backed', supplyUi: 10,
                control: { freezeAuthority: 'FreezeA', paused: false }, market: { liquidity: 400_000 } }],
            issuers: [], composability: null,
            defiUsage: { items: [{ mint, symbol: 'NVDAx', integrations: [{ id: 'kamino:collateral' }] }] }
        };
        const watch = { watch_id: 'token-watch', watch_type: 'token', target: { mint }, baseline: null };
        const baseline = buildWatchSnapshot(watch, data, Date.parse('2026-09-22T06:00:00Z'));
        const after = buildWatchSnapshot(watch, {
            ...data,
            tokens: [{ ...data.tokens[0], control: { freezeAuthority: null, paused: true }, market: { liquidity: 100_000 } }],
            defiUsage: { items: [{ mint, symbol: 'NVDAx', integrations: [{ id: 'loopscale:collateral' }] }] }
        }, Date.parse('2026-09-23T06:00:00Z'));
        const summaries = diffWatch({ ...watch, baseline }, after).map((row) => row.summary);
        expect(summaries).toEqual([
            `NVDAx ${mint}: on-chain control configuration changed (freezeAuthority FreezeA → none; paused false → true)`,
            `NVDAx ${mint}: exact-token protocol support changed (added loopscale:collateral; removed kamino:collateral)`,
            `NVDAx ${mint}: reported liquidity fell at least 25%, from $400,000 to $100,000`
        ]);
    });

    test('every material change is also stored as an event for the personal digest, safely quoted', () => {
        const watch = { watch_id: '6c031d2f-1618-42c0-a2b7-66c2aa4d2c1a' };
        const sql = updateSql([
            { watch, snapshot: { type: 'issuer' }, changes: [{ summary: "Issuer's programme status changed" }] },
            { watch: { watch_id: '00000000-0000-4000-8000-000000000000' }, snapshot: { type: 'token' }, changes: [] }
        ], '2026-09-24T00:17:00Z');
        expect(sql.startsWith('BEGIN;')).toBe(true);
        expect(sql.trim().endsWith('COMMIT;')).toBe(true);
        expect(sql.match(/INSERT INTO sonar\.stock_watch_event/g)).toHaveLength(1);
        expect(sql).toContain("VALUES ('6c031d2f-1618-42c0-a2b7-66c2aa4d2c1a'::uuid, 'Issuer''s programme status changed', '2026-09-24T00:17:00Z'::timestamptz);");
        expect(sql.match(/UPDATE sonar\.stock_watchlist/g)).toHaveLength(2);
        expect(updateSql([], '2026-09-24T00:17:00Z')).toBe('');
    });
});
