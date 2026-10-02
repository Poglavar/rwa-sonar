// Tests the public collector summary independently of filesystem timestamps and the live clock.

import { buildCollectorStatus, legalSourceCoverage, legalSourceFailureTolerance } from './build-collector-status.mjs';

describe('collector status artifact', () => {
    test('summarizes legal sources without publishing their URLs or raw content', () => {
        const coverage = legalSourceCoverage({
            'https://one.test': { status: 'ok', lastCheckedAt: '2026-09-19T01:00:00Z', archiveUrl: 'https://web.archive.org/one' },
            'https://two.test': { status: 'blocked', lastCheckedAt: '2026-09-19T03:00:00Z', archiveUrl: null }
        });
        expect(coverage).toEqual({
            total: 2,
            checked: 2,
            archived: 1,
            statuses: { ok: 1, blocked: 1 },
            oldestCheckedAt: '2026-09-19T01:00:00.000Z',
            newestCheckedAt: '2026-09-19T03:00:00.000Z'
        });
        expect(JSON.stringify(coverage)).not.toContain('one.test');
    });

    test('counts only URLs in the current source registry', () => {
        const coverage = legalSourceCoverage({
            'https://active.test': { status: 'ok', lastCheckedAt: '2026-09-21T01:00:00Z' },
            'https://retired.test': { status: 'error', lastCheckedAt: '2026-09-01T01:00:00Z' }
        }, { items: [{ url: 'https://active.test' }] });
        expect(coverage).toMatchObject({ total: 1, checked: 1, statuses: { ok: 1 } });
        expect(legalSourceCoverage({
            'https://retired.test': { status: 'ok', lastCheckedAt: '2026-09-01T01:00:00Z' }
        }, { items: [] })).toMatchObject({ total: 0, checked: 0, statuses: {} });
    });

    test('keeps missing collector input unknown rather than converting it to zero', () => {
        const out = buildCollectorStatus({
            universe: { fetchedAt: '2026-09-19T00:00:00Z', items: [{}, {}] },
            identities: { fetchedAt: '2026-09-19T01:00:00Z', items: [{}, {}, {}] },
            chainWatch: { generatedAt: '2026-09-19T02:00:00Z', mintsRead: 471, failures: 0 },
            sourceState: {}
        }, '2026-09-19T04:00:00Z');
        expect(out.generatedAt).toBe('2026-09-19T04:00:00Z');
        expect(out.collectors.find((row) => row.id === 'catalogue')).toMatchObject({ coverage: 2, cadenceHours: 24 });
        expect(out.collectors.find((row) => row.id === 'chain')).toMatchObject({ observedAt: null, coverage: null });
        expect(out.collectors.find((row) => row.id === 'identity-chain')).toMatchObject({ coverage: 3, cadenceHours: 24 });
        expect(out.collectors.find((row) => row.id === 'authority-watch')).toMatchObject({ coverage: 471, failures: 0 });
        expect(out.collectors.find((row) => row.id === 'legal-sources')).toMatchObject({ coverage: 0, unit: 'of 0 watched URLs checked' });
    });

    test('uses watcher completion state and cadence to distinguish degraded from stale', () => {
        const out = buildCollectorStatus({
            tradeWatch: {
                watchStatus: 'partial', lastRunEndedAt: '2026-09-21T11:00:00Z',
                windowTrades: 365, failures: 1
            },
            chainWatch: {
                watchStatus: 'ok', lastRunEndedAt: '2026-09-21T08:00:00Z',
                mintsRead: 1182, failures: 0
            },
            sourceState: {}
        }, '2026-09-21T12:00:00Z');
        expect(out.collectors.find((row) => row.id === 'trade-tape')).toMatchObject({
            status: 'degraded', coverage: 365, failures: 1
        });
        expect(out.collectors.find((row) => row.id === 'authority-watch')).toMatchObject({
            status: 'stale', coverage: 1182
        });
    });

    test('ignores on-chain locators the document watcher never reads', () => {
        const coverage = legalSourceCoverage({
            'https://docs.test/terms': { status: 'ok', lastCheckedAt: '2026-09-22T01:00:00Z' },
            'https://api-v3.raydium.io/pools/info/mint': { status: 'error', lastCheckedAt: '2026-09-22T12:15:18Z' }
        }, { items: [{ url: 'https://docs.test/terms' }, { url: 'https://api-v3.raydium.io/pools/info/mint' }] });
        expect(coverage).toMatchObject({ total: 1, checked: 1, statuses: { ok: 1 } });
    });

    test('legal sources tolerate a few third-party host failures but not a broken reader', () => {
        const run = (failures) => buildCollectorStatus({
            sourceWatch: {
                watchStatus: failures ? 'partial' : 'ok', lastRunEndedAt: '2026-09-23T10:52:29Z',
                sourcesEvaluated: 545, failures
            },
            sourceState: {}
        }, '2026-09-23T11:00:00Z').collectors.find((row) => row.id === 'legal-sources');
        expect(legalSourceFailureTolerance(545)).toBe(5);
        expect(legalSourceFailureTolerance(null)).toBe(0);
        expect(run(1)).toMatchObject({ status: 'current', failures: 1, watchStatus: 'partial', failureTolerance: 5 });
        expect(run(5)).toMatchObject({ status: 'current' });
        expect(run(6)).toMatchObject({ status: 'degraded' });
        // A crashed run and a run without an evaluated count keep failing closed.
        const crashed = buildCollectorStatus({
            sourceWatch: { watchStatus: 'failed', lastRunEndedAt: '2026-09-23T10:52:29Z', sourcesEvaluated: null, failures: 1 },
            sourceState: {}
        }, '2026-09-23T11:00:00Z').collectors.find((row) => row.id === 'legal-sources');
        expect(crashed).toMatchObject({ status: 'degraded', failureTolerance: 0 });
    });
});
