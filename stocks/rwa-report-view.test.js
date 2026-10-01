const report = require('../rwa/lib/report-view.js');
const research = require('../rwa/lib/research.js');
const curated = require('../rwa/data/research.json');
const native = id => structuredClone(curated.products.find(p => p.id === id));
const dossier = require('./data/issuers/backpack-securities-spcx.json');
let backpack;
beforeAll(async () => {
    const { stockResearch } = await import('../rwa/lib/stock-research.mjs');
    backpack = stockResearch({issuers:[{slug:'backpack-securities',name:'Backpack Securities',evidence:dossier.evidence}]},
        {tokens:[{issuer:'backpack-securities',mint:'ExampleMint',symbol:'EXAMPLE',name:'Example deployment'}]},
        {'backpack-securities-spcx':dossier})[0];
});
test('all seven dimensions and existing finding links lead to their reading topic', () => {
    const p = native('paxg'), v = report.view(p, 'holder');
    expect(v.features.flatMap(f => f.findings.map(x => x.dimension)).sort()).toEqual(Object.keys(research.DIMENSIONS).sort());
    for (const feature of v.features) for (const f of feature.findings) {
        expect(report.topicForHash('#finding-' + f.dimension)).toBe(feature.id);
    }
    expect(report.topicForHash('#failureScenario')).toBe('failure');
    expect(report.topicForHash('#garbage')).toBe('overview');
});
test('overview is concise and each detailed finding retains its sources and full interpretation', () => {
    const p = native('paxg'), v = report.view(p, 'holder');
    const overview = report.render(v);
    expect(overview).toContain('report-arrangement');
    for (const f of v.features.flatMap(f => f.findings)) {
        const e = report.evidence(v, f.dimension);
        expect(e.sources.map(s => s.id)).toEqual(f.sourceIds);
        expect(e.finding.summary).toBe(f.summary);
        expect(overview).not.toContain(f.summary);
    }
    expect(report.render(report.view(p, 'holder', {hash:'#ownership'}))).toContain(p.assetModule.label);
    const fund = native('ustbl');
    expect(report.render(report.view(fund, fund.contexts[0].id, {hash:'#backing'}))).toContain(fund.assetModule.label);
});
test('programme facts and complete failure cases remain available without inheriting into exact tokens', () => {
    const v = report.view(backpack, 'programme');
    expect(v.facts.some(f => f.id === 'corporateActions' && f.summary.length > 100)).toBe(true);
    expect(v.cases).toHaveLength(dossier.whatIf.length);
    for (const c of v.cases) expect(report.evidence(v, 'case:' + c.id).sources.map(s=>s.id)).toEqual(c.sourceIds);
    expect(report.render(v)).toContain('Redeemable claim through an issuing vehicle');
    expect(report.render(v)).not.toContain('spv-claim-redeemable');
    const exact = report.view(backpack, 'programme', {deploymentId:backpack.deployments[0].id, hash:'#backing'});
    expect(exact.bound).toBe(false);
    expect(exact.facts).toEqual([]);
    expect(exact.cases).toEqual([]);
    expect(exact.exit).toEqual({});
    expect(exact.features.flatMap(f=>f.findings).every(f=>f.tone==='unknown')).toBe(true);
    expect(report.render(exact)).not.toContain('What the evidence measures');
    expect(report.evidence(exact,'profile:0').sources).toEqual([]);
    expect(report.evidence(exact,'case:'+v.cases[0].id).sources).toEqual([]);
});
test('source grouping retains each citation and search finds individual clauses', () => {
    const p = native('paxg');
    const groups = report.sourceGroups(p);
    expect(groups.flatMap(g=>g.sources).map(s=>s.id).sort()).toEqual(p.sources.map(s=>s.id).sort());
    expect(new Set(groups.map(g=>g.url)).size).toBe(groups.length);
    const s = p.sources.find(s=>s.locator);
    expect(report.sourceGroups(p,s.locator).flatMap(g=>g.sources).some(x=>x.id===s.id)).toBe(true);
    expect(report.sourceRows(p,'no-matching-document-ever')).toBe('<p>No sources match.</p>');
});
test('unknown selections fail closed and retained hostile prose is escaped', () => {
    expect(()=>report.view(native('paxg'),'wrong')).toThrow('Unknown report holder context');
    expect(()=>report.view(native('paxg'),'holder',{deploymentId:'wrong'})).toThrow('Unknown report deployment');
    const v = report.view(native('paxg'),'holder',{hash:'#ownership'});
    v.features[0].findings[0].summary='<img src=x onerror=alert(1)>';
    v.features[0].findings[0].note=null;
    expect(report.render(v)).toContain('&lt;img');
    expect(report.render(v)).not.toContain('<img');
    expect(report.renderEvidence(v,'rights')).not.toContain('<img');
});
test('bound addresses keep their observations but do not change holder context', () => {
    const p=native('usdc');
    const v=report.view(p,'eea',{deploymentId:p.deployments[0].id,hash:'#controls'});
    expect(v.bound).toBe(true);
    expect(v.context.id).toBe('eea');
    expect(report.render(v)).toContain(p.deployments[0].address);
    expect(report.render(v)).toContain('Token and network observations');
});
