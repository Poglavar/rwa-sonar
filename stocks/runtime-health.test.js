import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessRuntimeHealth, deriveFreshnessPolicy, loadFreshnessPolicy } from './check-runtime-health.mjs';

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

const publisherNames = {
    chain: 'RWA Sonar Chain Watcher',
    lending: 'RWA Sonar Lending Watcher',
    trade: 'RWA Sonar Trade Collector',
    sixHour: 'RWA Sonar Six-hour Refresh',
    documents: 'RWA Sonar Document Watcher'
};
const activePublisher = (name) => ({ name, active: true });
const pausedPublisher = (name) => ({ name, active: false,
    mutedReason: 'Paused by owner while RWA Sonar is on the backburner.',
    unmuteWhen: 'Only when the owner explicitly resumes this job.' });
function registryFixture(states = {}) {
    return Object.entries(publisherNames).map(([key, name]) => states[key] === 'paused'
        ? pausedPublisher(name)
        : states[key] === 'undocumented' ? { name, active: false }
        : states[key] === 'active' ? activePublisher(name) : { name });
}
const goodSurfaces = (build = '2026-09-21T10:00:00Z', generatedAt = '2026-09-21T11:00:00Z') => ({
    localApi: health(1182), publicApi: health(1182, build), collectorStatus: status(generatedAt)
});

describe('runtime health probe', () => {
    const now = new Date('2026-09-21T12:00:00Z');

    test('passes only when local, public and static surfaces agree and are current', () => {
        expect(assessRuntimeHealth({ localApi: health(1182), publicApi: health(1182), collectorStatus: status() }, now))
            .toMatchObject({ runtimeStatus: 'ok', tokens: 1182, collectors: 10, failures: 0 });
    });

    test('fails a stale collector artifact under the strict default policy', () => {
        const out = assessRuntimeHealth({
            localApi: health(1182), publicApi: health(1182), collectorStatus: status('2026-09-21T08:00:00Z')
        }, now);
        expect(out.runtimeStatus).toBe('failed');
        expect(out.failureReasons.join(' ')).toContain('collector status is 240 minutes old, maximum 150');
    });

    test('fails count drift and stale builds under the strict default policy', () => {
        const out = assessRuntimeHealth({
            localApi: health(1182, '2026-09-20T20:00:00Z'),
            publicApi: health(1100, '2026-09-20T20:00:00Z'),
            collectorStatus: status()
        }, now);
        expect(out.runtimeStatus).toBe('failed');
        expect(out.failureReasons.join(' ')).toContain('local/public token counts differ');
        expect(out.failureReasons.join(' ')).toContain('maximum 720');
    });

    test('loads pause-aware policy from the optional central registry path', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'rwa-runtime-health-'));
        try {
            const path = join(dir, 'bot-list.json');
            await writeFile(path, JSON.stringify(registryFixture({
                chain: 'paused', lending: 'paused', trade: 'paused', sixHour: 'paused'
            })));
            expect(await loadFreshnessPolicy(path)).toEqual({
                latestBuildMaxAgeMinutes: null,
                collectorStatusMaxAgeMinutes: 27 * 60
            });
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test('allows an old build and six-hour collector artifact under the real paused-job policy', () => {
        const policy = deriveFreshnessPolicy(registryFixture({
            chain: 'paused', lending: 'paused', trade: 'paused', sixHour: 'paused'
        }));
        const out = assessRuntimeHealth(goodSurfaces('2026-09-20T18:00:00Z', '2026-09-21T06:00:00Z'), now, policy);
        expect(out).toMatchObject({ runtimeStatus: 'ok', failures: 0, latestBuildAgeMinutes: 1080,
            collectorStatusAgeMinutes: 360, buildFreshnessRequired: false, latestBuildMaxAgeMinutes: null,
            collectorFreshnessRequired: true, collectorMaxAgeMinutes: 1620 });
    });

    test('still fails a daily collector artifact older than 27 hours', () => {
        const policy = deriveFreshnessPolicy(registryFixture({
            chain: 'paused', lending: 'paused', trade: 'paused', sixHour: 'paused'
        }));
        const out = assessRuntimeHealth(goodSurfaces('2026-09-21T10:00:00Z', '2026-09-20T08:00:00Z'), now, policy);
        expect(out.runtimeStatus).toBe('failed');
        expect(out.failureReasons.join(' ')).toContain('collector status is 1680 minutes old, maximum 1620');
    });

    test.each([
        ['hourly chain publisher resumes', registryFixture({ chain: 'active', lending: 'paused', trade: 'paused', sixHour: 'active', documents: 'active' })],
        ['hourly publisher is undocumented', registryFixture({ chain: 'undocumented', lending: 'paused', trade: 'paused', sixHour: 'active', documents: 'active' })],
        ['hourly publisher is absent', registryFixture({ chain: 'paused', lending: 'paused', trade: 'paused', sixHour: 'active' })
            .filter((entry) => entry.name !== publisherNames.chain)],
        ['daily publisher is absent', registryFixture({ chain: 'paused', lending: 'paused', trade: 'paused', sixHour: 'paused' })
            .filter((entry) => entry.name !== publisherNames.documents)]
    ])('%s restores strict collector freshness', (_label, registry) => {
        const policy = deriveFreshnessPolicy(registry);
        expect(policy.collectorStatusMaxAgeMinutes).toBe(150);
        if (registry.find((entry) => entry.name === publisherNames.sixHour)?.active === false) {
            expect(policy.latestBuildMaxAgeMinutes).toBeNull();
        } else {
            expect(policy.latestBuildMaxAgeMinutes).toBe(720);
        }
        const out = assessRuntimeHealth(goodSurfaces('2026-09-21T10:00:00Z', '2026-09-21T08:00:00Z'), now, policy);
        expect(out.failureReasons.join(' ')).toContain('maximum 150');
    });

    test('resuming Six-hour Refresh restores the 720-minute build and 420-minute collector bounds', () => {
        const policy = deriveFreshnessPolicy(registryFixture({
            chain: 'paused', lending: 'paused', trade: 'paused', sixHour: 'active', documents: 'active'
        }));
        expect(policy).toEqual({ latestBuildMaxAgeMinutes: 720, collectorStatusMaxAgeMinutes: 420 });
        const out = assessRuntimeHealth(goodSurfaces('2026-09-20T23:59:00Z', '2026-09-21T05:00:00Z'), now, policy);
        expect(out).toMatchObject({ latestBuildMaxAgeMinutes: 720, collectorMaxAgeMinutes: 420,
            buildFreshnessRequired: true, collectorFreshnessRequired: true });
        expect(out.failureReasons.join(' ')).toContain('latest API build is 721 minutes old, maximum 720');
        expect(out.failureReasons.join(' ')).not.toContain('collector status');
    });

    test('when every publisher is explicitly paused only age checks are skipped', () => {
        const policy = deriveFreshnessPolicy(registryFixture({
            chain: 'paused', lending: 'paused', trade: 'paused', sixHour: 'paused', documents: 'paused'
        }));
        expect(policy).toEqual({ latestBuildMaxAgeMinutes: null, collectorStatusMaxAgeMinutes: null });
        const old = assessRuntimeHealth(goodSurfaces('2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'), now, policy);
        expect(old).toMatchObject({ runtimeStatus: 'ok', buildFreshnessRequired: false,
            latestBuildMaxAgeMinutes: null, collectorFreshnessRequired: false, collectorMaxAgeMinutes: null });
        const invalid = assessRuntimeHealth(goodSurfaces('not-a-date', 'not-a-date'), now, policy);
        expect(invalid.runtimeStatus).toBe('failed');
        expect(invalid.failureReasons.join(' ')).toMatch(/timestamp is missing or invalid/);
    });

    test('pause-aware freshness never hides HTTP, count, or generation timestamp failures', () => {
        const policy = deriveFreshnessPolicy(registryFixture({
            chain: 'paused', lending: 'paused', trade: 'paused', sixHour: 'paused'
        }));
        const unavailable = assessRuntimeHealth({
            ...goodSurfaces('2026-09-20T18:00:00Z', '2026-09-21T06:00:00Z'),
            publicApi: { ok: false, status: 503, json: null }
        }, now, policy);
        expect(unavailable.failureReasons.join(' ')).toContain('public API unavailable');

        const countMismatch = assessRuntimeHealth({
            ...goodSurfaces('2026-09-20T18:00:00Z', '2026-09-21T06:00:00Z'),
            publicApi: health(1100, '2026-09-20T18:00:00Z')
        }, now, policy);
        expect(countMismatch.failureReasons.join(' ')).toContain('local/public token counts differ');

        const badTimestamp = assessRuntimeHealth(goodSurfaces('2026-09-20T18:00:00Z', 'invalid'), now, policy);
        expect(badTimestamp.failureReasons.join(' ')).toContain('collector status timestamp is missing or invalid');
        const badBuildTimestamp = assessRuntimeHealth(goodSurfaces('invalid', '2026-09-21T06:00:00Z'), now, policy);
        expect(badBuildTimestamp.failureReasons.join(' ')).toContain('latest API build timestamp is missing or invalid');
    });
});
