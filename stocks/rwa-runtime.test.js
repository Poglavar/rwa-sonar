// Runtime joins must keep source dates and legal scope independent from recent deployment reads.
let buildResearch, curated;
beforeAll(async () => {
    ({ buildResearch } = await import('../rwa/lib/build-research.mjs'));
    curated = JSON.parse(await readFile(new URL('../rwa/data/research.json', import.meta.url), 'utf8'));
});
import model from '../rwa/lib/research.js';
import { readFile } from 'node:fs/promises';
const getUsdc = () => curated.products.find((p) => p.id === 'usdc');
test('a fresh chain read changes only its exact deployment; legal findings and source checks stay unchanged', () => {
    const usdc = getUsdc();
    const id = usdc.deployments[0].id, now = '2026-10-01T00:00:00Z';
    const records = { [id]: { configured: true, cadenceSeconds: 3600, lastSuccessAt: now, lastAttemptAt: now, lastAttemptStatus: 'successful', observation: { decoderVersion: 2, network: 'Ethereum', blockNumber: '123', blockTimestamp: now, fields: { owner: { state: 'observed', value: '0xowner' } } } } };
    const runtime = buildResearch(curated, { issuers: [] }, { tokens: [] }, {}, { records }, now);
    const fresh = runtime.products.find((p) => p.id === 'usdc');
    expect(fresh.reviewedAt).toBe(usdc.reviewedAt);
    expect(fresh.sources).toEqual(usdc.sources);
    expect(fresh.claims).toEqual(usdc.claims);
    expect(fresh.deployments[0]).toMatchObject({ chainCheckedAt: now, controls: { state: 'supported' }, monitoring: { coverage: 'recent-observation' } });
    expect(fresh.deployments[1].chainCheckedAt).toBeNull();
    expect(runtime.counts.recentSuccessfulMonitors).toBe(1);
    const later = buildResearch(curated, { issuers: [] }, { tokens: [] }, {}, { records }, '2026-10-01T03:00:00Z');
    expect(later.counts.recentSuccessfulMonitors).toBe(0);
    expect(later.products.find((p) => p.id === 'usdc').reviewedAt).toBe(usdc.reviewedAt);
    expect(buildResearch(curated, { issuers: [] }, { tokens: [] }, {}, { records }, now)).toEqual(runtime);
});
test('comparison modes follow explicitly selected identities and do not assign a score', () => {
    const p = structuredClone(getUsdc()), q = structuredClone(getUsdc());
    expect(model.compare(p, 'non-eea', q, 'eea', { deploymentId: p.deployments[0].id }, { deploymentId: q.deployments[1].id }).mode).toBe('instrument-networks');
    q.instrument.id = 'instrument:other'; q.deployments[0].underlying = 'AAPL'; p.deployments[0].underlying = 'AAPL';
    const view = model.compare(p, 'non-eea', q, 'eea', { deploymentId: p.deployments[0].id }, { deploymentId: q.deployments[0].id });
    expect(view.mode).toBe('underlying-products');
    expect(view).not.toHaveProperty('score');
    expect(model.compare(p, 'non-eea', curated.products.find((p) => p.id === 'paxg'), 'holder').mode).toBe('similar-exposure');
});
