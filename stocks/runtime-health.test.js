import { assessRuntimeHealth } from './check-runtime-health.mjs';

const health = (tokens, build = '2026-09-21T10:00:00Z') => ({
    ok: true,
    status: 200,
    json: { ok: true, counts: { tokens }, latestBuildAt: build }
});
const status = (generatedAt = '2026-09-21T11:00:00Z') => ({
    ok: true,
    status: 200,
    json: { generatedAt, collectors: Array.from({ length: 10 }, () => ({ status: 'current' })) }
});

describe('runtime health probe', () => {
    const now = new Date('2026-09-21T12:00:00Z');

    test('passes only when local, public and static surfaces agree and are current', () => {
        expect(assessRuntimeHealth({ localApi: health(1182), publicApi: health(1182), collectorStatus: status() }, now))
            .toMatchObject({ runtimeStatus: 'ok', tokens: 1182, collectors: 10, failures: 0 });
    });

    test('fails a stale collector artifact even when both APIs answer', () => {
        const out = assessRuntimeHealth({
            localApi: health(1182), publicApi: health(1182), collectorStatus: status('2026-09-21T08:00:00Z')
        }, now);
        expect(out.runtimeStatus).toBe('failed');
        expect(out.failureReasons.join(' ')).toContain('collector status is 240 minutes old');
    });

    test('fails count drift and stale builds with explicit reasons', () => {
        const out = assessRuntimeHealth({
            localApi: health(1182, '2026-09-20T20:00:00Z'),
            publicApi: health(1100, '2026-09-20T20:00:00Z'),
            collectorStatus: status()
        }, now);
        expect(out.runtimeStatus).toBe('failed');
        expect(out.failureReasons.join(' ')).toContain('local/public token counts differ');
        expect(out.failureReasons.join(' ')).toContain('maximum 720');
    });
});
