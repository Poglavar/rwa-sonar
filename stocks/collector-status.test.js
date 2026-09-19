// Tests the public collector summary independently of filesystem timestamps and the live clock.

import { buildCollectorStatus, legalSourceCoverage } from './build-collector-status.mjs';

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

    test('keeps missing collector input unknown rather than converting it to zero', () => {
        const out = buildCollectorStatus({
            universe: { fetchedAt: '2026-09-19T00:00:00Z', items: [{}, {}] },
            chainWatch: { generatedAt: '2026-09-19T02:00:00Z', mintsRead: 471, failures: 0 },
            sourceState: {}
        }, '2026-09-19T04:00:00Z');
        expect(out.generatedAt).toBe('2026-09-19T04:00:00Z');
        expect(out.collectors.find((row) => row.id === 'catalogue')).toMatchObject({ coverage: 2, cadenceHours: 24 });
        expect(out.collectors.find((row) => row.id === 'chain')).toMatchObject({ observedAt: null, coverage: null });
        expect(out.collectors.find((row) => row.id === 'authority-watch')).toMatchObject({ coverage: 471, failures: 0 });
        expect(out.collectors.find((row) => row.id === 'legal-sources')).toMatchObject({ coverage: 0, unit: 'of 0 watched URLs checked' });
    });
});
