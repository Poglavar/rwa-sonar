// Evidence inheritance must fail closed across instruments, terms, holder contexts and deployments.
const fs = require('fs');
const path = require('path');
const model = require('../rwa/lib/research.js');
const data = require('../rwa/data/research.json');
const { buildCatalogue } = require('./lib/rwa-catalogue.js');
const p = (id) => data.products.find((p) => p.id === id);
test('curated records bind every dimension to an explicit instrument, holder context and source set', () => {
    expect(model.validateResearch(data)).toBe(data);
    expect(data.products).toHaveLength(21);
    expect(new Set(data.products.map((p) => p.originalName)).size).toBe(21);
    expect(model.resolveClaim(p('usdy'), 'unresolved', 'rights').state).toBe('conflicting');
    expect(model.resolveClaim(p('buidl'), 'fund', 'exit').state).toBe('unknown');
    expect(model.resolveClaim(p('hlscope'), 'feeder', 'exit').state).toBe('stale');
});
test('native-token rights do not apply to another instrument, terms epoch, holder context or chain observation', () => {
    const scope = { instrumentId: 'usdc', contextId: 'eea', termsId: 'v2', deploymentId: 'solana:native', from: '2026-01-01', through: '2026-06-30' };
    const target = { ...scope, asOf: '2026-03-01' };
    expect(model.applies(scope, target)).toBe(true);
    for (const [key, value] of [['instrumentId', 'wrapped-usdc'], ['contextId', 'non-eea'], ['termsId', 'v1'], ['deploymentId', 'ethereum:native'], ['asOf', '2025-12-31'], ['asOf', '2026-07-01'], ['asOf', undefined]]) {
        expect(model.applies(scope, { ...target, [key]: value })).toBe(false);
    }
    expect(model.applies({ programmeId: 'circle' }, target)).toBe(false);
});
test('holder context changes USDC direct redemption without promoting a conditional route into observed execution', () => {
    const usdc = p('usdc');
    expect(model.resolveClaim(usdc, 'non-eea', 'access').summary).toMatch(/Mint account/);
    expect(model.resolveClaim(usdc, 'eea', 'access').summary).toMatch(/Retail uses a verified web request/);
    expect(model.resolveClaim(usdc, 'invalid', 'exit').state).toBe('unknown');
    expect(usdc.exitDetails.eea.availability).toMatch(/no completed redemption observed/);
    expect(usdc.deployments.every((d) => d.chainCheckedAt === null && d.controls.state === 'unknown')).toBe(true);
});
test('conflicting applicable findings remain unresolved rather than silently picking a winner', () => {
    const changed = structuredClone(p('usdc'));
    changed.claims.push({ ...changed.claims[0], summary: 'A different result' });
    expect(model.resolveClaim(changed, 'non-eea', 'rights').state).toBe('conflicting');
});
test('fund and feeder identities do not give tokenholders direct portfolio asset rights', () => {
    expect(p('acred').instrument.issuer).toMatch(/Securitize Tokenized Apollo/);
    expect(p('hlscope').instrument.legalForm).toMatch(/partnership/);
    expect(p('buidl').deployments[0].instrumentId).toBeNull();
    expect(p('usdy').deployments[0].instrumentId).toBeNull();
    expect(model.resolveClaim(p('buidl'), 'fund', 'rights', { deploymentId: p('buidl').deployments[0].id }).state).toBe('unknown');
    expect(model.resolveClaim(p('usdc'), 'eea', 'rights', { deploymentId: p('usdc').deployments[0].id }).state).toBe('supported');
    expect(model.resolveClaim(p('usdc'), 'eea', 'rights', { termsId: 'old-terms' }).state).toBe('unknown');
    const comparison = model.compare(p('usdc'), 'non-eea', p('paxg'), 'holder');
    expect(comparison.differentExposure).toBe(true);
    expect(comparison.rows).toHaveLength(7);
    expect(comparison).not.toHaveProperty('score');
    expect(model.compare(p('buidl'), 'fund', p('fobxx'), 'fund').differentExposure).toBe(false);
});
test('validator rejects unsupported promotion, missing sources and unbound chain observations', () => {
    const mutated = (change) => { const copy = structuredClone(data); change(copy.products[0]); return () => model.validateResearch(copy); };
    expect(mutated((p) => { p.claims[0].scope.instrumentId = 'other'; })).toThrow('Unbound claim');
    expect(mutated((p) => { p.claims[0].sourceIds = []; })).toThrow('Missing claim evidence');
    expect(mutated((p) => { p.claims[0].basis = 'observed'; })).toThrow('Observation lacks deployment');
    expect(mutated((p) => { p.deployments[0].controls.state = 'supported'; })).toThrow('Controls lack chain check');
});
test('review catalogue mapping is explicit and does not refresh historical operational status or claim chain checks', () => {
    const assets = JSON.parse(fs.readFileSync(path.join(__dirname, '../rwa-assets-db.json'), 'utf8')).filter((a) => data.products.some((p) => p.originalName === a.name));
    const catalogue = buildCatalogue(assets, { issuers: [] }, { tokens: [] }, data);
    expect(catalogue.counts.reviewedProducts).toBe(21);
    const gold = catalogue.entries.find((e) => e.ticker === 'PAXG');
    expect(gold).toMatchObject({ coverage: 'reviewed', instrumentId: 'instrument:paxg', report: 'report.html?product=paxg' });
    expect(gold.statusCheckedAt).toBe(assets.find((a) => a.ticker === 'PAXG').statusCheckedAt || null);
    expect(gold.deployments[0].chainCheckedAt).toBeNull();
    expect(catalogue.entries.find((e) => e.ticker === 'HLSCOPE').category).toBe('credit');
    expect(() => buildCatalogue([], { issuers: [] }, { tokens: [] }, data)).toThrow('Missing explicit research mapping');
});
