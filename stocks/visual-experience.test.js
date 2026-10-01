// Observable behavior for profiles, membership selection and hypothetical failure consequences.
const visual = require('../rwa/lib/visual-profile.js');
const structure = require('../rwa/lib/structure-map.js');
const scenarios = require('../rwa/lib/failure-scenario.js');
const curated = require('../rwa/data/research.json');
const get = (id) => structuredClone(curated.products.find((p) => p.id === id));
const feature = (p, context, id, options = {}) => visual.profile(p, context, options).features.find((f) => f.id === id);
test('ownership can be established while authoritative register precedence remains unknown', () => {
    const f = feature(get('usdc'), 'non-eea', 'ownership');
    expect(f.findings.map((f) => f.tone)).toEqual(['strength', 'unknown']);
    expect(f.findings[0].label).toBe('Dollar claim defined');
    expect(f.findings[1].label).toBe('Which record prevails is unclear');
});
test('documented intervention and conditional exit are never automatically green', () => {
    expect(feature(get('paxg'), 'holder', 'controls').findings[0].tone).toBe('condition');
    expect(feature(get('paxg'), 'holder', 'exit').findings[0].label).toBe('Physical delivery requires 430 PAXG');
    expect(feature(get('usdc'), 'eea', 'exit').findings[0].label).toBe('Five-day target; discrepancies can delay payment');
});
test('unknown, historical and conflicting findings remain distinct and have no score', () => {
    expect(feature(get('usdy'), 'unresolved', 'ownership').findings[0]).toMatchObject({ tone: 'unknown', state: 'conflicting', label: 'Sources conflict' });
    expect(feature(get('hlscope'), 'feeder', 'exit').findings[0]).toMatchObject({ tone: 'unknown', state: 'stale', label: 'Historical evidence only' });
    expect(visual.profile(get('buidl'), 'fund')).not.toHaveProperty('score');
});
test.each(['summary', 'state', 'scope', 'source'])('changing the %s invalidates an old positive summary', (key) => {
    const p = get('paxg');
    const claim = p.claims.find((c) => c.dimension === 'rights');
    if (key === 'summary') claim.summary = 'Different terms';
    if (key === 'state') claim.state = 'unknown';
    if (key === 'scope') claim.scope.termsId = 'different-terms';
    if (key === 'source') p.sources.find((s) => s.id === claim.sourceIds[0]).checkedAt = '2026-10-02';
    expect(feature(p, 'holder', 'ownership').findings[0].tone).toBe('unknown');
});
test('index build timestamps do not invalidate or refresh legal findings', () => {
    const p = get('paxg'), before = visual.profile(p, 'holder');
    p.builtAt = '2099-01-01';
    expect(visual.profile(p, 'holder')).toEqual(before);
});
test('unbound deployment and wrong holder context receive no inherited positive findings', () => {
    const p = get('buidl');
    const v = visual.profile(p, 'fund', { deploymentId: p.deployments[0].id });
    expect(v.features.flatMap((f) => f.findings).every((f) => f.tone === 'unknown')).toBe(true);
    expect(visual.profile(get('paxg'), 'wrong').features.flatMap((f) => f.findings).every((f) => f.tone === 'unknown')).toBe(true);
});
test('source references, evidence basis and original dates remain on each presentation finding', () => {
    const p = get('paxg'), f = feature(p, 'holder', 'backing').findings[0];
    expect(f.sourceIds).toEqual(p.claims.find((c) => c.dimension === 'backing').sourceIds);
    expect(f.basis).toBe('source-statement');
    expect(f.checkedAt).toBe(p.reviewedAt);
});
test('unannotated documentation is unknown rather than an inferred green finding', () => {
    const p=get('paxg'); delete p.claims[0].display;
    expect(feature(p,'holder','ownership').findings[0].tone).toBe('unknown');
});
function mapFixture() {
    const products=[get('usdc'),get('paxg'),get('buidl')];
    return { research: {products}, catalogue:{entries:products.map(p=>({id:'entry:'+p.id,researchId:p.id}))} };
}
test('map counts reconcile to deduplicated network/address identities, not product totals', () => {
    const {research,catalogue}=mapFixture();
    const p=research.products[0];p.deployments.push({...p.deployments[0],address:p.deployments[0].address.toUpperCase()});
    const m=structure.buildMap(research,catalogue);
    expect(m.counts.deployments).toBe(new Set(research.products.flatMap(p=>p.deployments.map(structure.addressKey))).size);
    expect(m.counts.subjects).toBe(3);
    expect(m.programmes.find(p=>p.id==='circle-usdc').deployments).toHaveLength(2);
});
test('selecting a shared structure traces members; selecting an issuer traces only its branch', () => {
    const {research,catalogue}=mapFixture(),m=structure.buildMap(research,catalogue);
    expect(structure.select(m,{kind:'group',id:'gold',mode:'legal'})).toMatchObject({valid:true,productIds:['paxg'],entryIds:['entry:paxg']});
    expect(structure.select(m,{kind:'programme',id:'circle-usdc'}).productIds).toEqual(['usdc']);
    expect(structure.select(m,{kind:'programme',id:'missing'}).valid).toBe(false);
});
test('empty deployments remain a programme with unknown technical controls', () => {
    const {research,catalogue}=mapFixture();research.products[1].deployments=[];
    const m=structure.buildMap(research,catalogue);
    expect(m.programmes.find(p=>p.id==='paxos-gold').deployments).toEqual([]);
    expect(m.recipes.find(p=>p.label==='Control pattern unknown').programmes).toContain('paxos-gold');
});
test('membership and identity colors are stable when inputs are reordered', () => {
    const {research,catalogue}=mapFixture(),m=structure.buildMap(research,catalogue);
    const reordered=structure.buildMap({products:[...research.products].reverse()},catalogue);
    expect(reordered.programmes).toEqual(m.programmes);
    expect(structure.colorSlot('circle-usdc')).toBe(m.programmes.find(p=>p.id==='circle-usdc').color);
    expect(structure.addressKey({network:'Solana',address:'Abc'})).not.toEqual(structure.addressKey({network:'Solana',address:'abc'}));
});
test('missing catalogue joins fail rather than dropping a reviewed subject', () => {
    const {research}=mapFixture(); expect(()=>structure.buildMap(research,{entries:[]})).toThrow('no catalogue entry');
});
test('operational issuer outage does not inherit an insolvency answer', () => {
    const p=get('paxg');const v=scenarios.scenario(p,'holder','issuer-unavailable');
    expect(v.hypothetical).toBe(true);expect(v.state).toBe('unknown');expect(v.routes.exit).toBe('unknown');
    expect(v.summary).toMatch(/not insolvency/);
});
test('documented alternatives and unknown routes survive separately; normal state restores', () => {
    const p=get('paxg');p.scenarios=[{mode:'issuer-unavailable',contextId:'holder',termsId:p.contexts[0].termsId,status:'documented',outcome:'Independent procedure with conditions.',sourceIds:['terms'],routes:{claim:'conditional',custody:'unknown',exit:'conditional'}}];
    const v=scenarios.scenario(p,'holder','issuer-unavailable');
    expect(v.routes).toEqual({claim:'conditional',custody:'unknown',exit:'conditional'});
    expect(scenarios.scenario(p,'holder','normal')).toMatchObject({hypothetical:false,affected:null,routes:{claim:'described',custody:'described',exit:'described'}});
    expect(scenarios.scenario(p,'wrong','issuer-unavailable').state).toBe('unknown');
});
test('rendered finding links target evidence and do not depend on color alone', () => {
    const html=visual.render(visual.profile(get('paxg'),'holder'),{report:'report.html?product=paxg'});
    expect(html).toContain('report.html?product=paxg#finding-rights');
    expect(html).toContain('aria-label="Strength"');expect(html).toContain('aria-label="Caution"');
    expect(html).toContain('Physical delivery requires 430 PAXG');
});

test('duplicate deployment observations do not inflate a recipe edge', () => {
    const {research,catalogue}=mapFixture(); const p=research.products[0];
    p.deployments.push({...p.deployments[0],address:p.deployments[0].address.toUpperCase()});
    const m=structure.buildMap(research,catalogue);
    expect(m.edges.filter(e=>e.productId===p.id && e.kind==='control-recipe').reduce((n,e)=>n+e.count,0)).toBe(2);
});
test('conflicting programme membership fails rather than assigning by input order', () => {
    const {research,catalogue}=mapFixture();
    research.products[1].deployments=[{...research.products[0].deployments[0]}];
    expect(()=>structure.buildMap(research,catalogue)).toThrow('Conflicting programme membership');
});
test('normal scenario leaves unbound exact-token routes and actors unresolved', () => {
    const p=get('buidl'); p.scenarioActors=[{name:'Programme custodian'}];
    expect(scenarios.scenario(p,'fund','normal',{deploymentId:p.deployments[0].id})).toMatchObject({custodyActors:[],routes:{claim:'unknown',custody:'unknown',exit:'unknown'}});
});
test('scenario validation rejects wrong terms, missing evidence and invented routes', () => {
    const model=require('../rwa/lib/research.js');
    const p=get('paxg'); const a={mode:'custodian-fails',contextId:'holder',termsId:p.contexts[0].termsId,status:'documented',outcome:'A sourced condition.',sourceIds:[p.sources[0].id],routes:{claim:'conditional',custody:'unknown',exit:'unknown'}};
    p.scenarios=[a]; expect(()=>model.validateResearch({schemaVersion:1,products:[p]})).not.toThrow();
    a.termsId='different'; expect(()=>model.validateResearch({schemaVersion:1,products:[p]})).toThrow('Unbound');
    a.termsId=p.contexts[0].termsId; a.sourceIds=[]; expect(()=>model.validateResearch({schemaVersion:1,products:[p]})).toThrow('evidence');
    a.sourceIds=[p.sources[0].id]; a.routes.exit='guaranteed'; expect(()=>model.validateResearch({schemaVersion:1,products:[p]})).toThrow('route');
});
test('movement offsets and connection geometry reach the intended stable identities', () => {
    expect(structure.movement({x:10,y:20},{x:30,y:5})).toEqual({x:-20,y:15});
    expect(structure.movement({x:10,y:20},{x:10,y:20})).toBeNull();
    expect(structure.movement(null,{x:10,y:20})).toBeNull();
    expect(structure.movement({x:null,y:20},{x:10,y:20})).toBeNull();
    expect(structure.connectionPath({x:10,y:20},{x:30,y:5})).toBe('M10,20C20,20 20,5 30,5');
});

test('reviewed terms nodes preserve holder contexts without claiming shared exact templates', () => {
    const {research,catalogue}=mapFixture(),m=structure.buildMap(research,catalogue);
    const terms=m.terms.filter(t=>t.productId==='usdc');
    expect(terms.map(t=>t.contextId).sort()).toEqual(['eea','non-eea']);
    expect(terms.every(t=>t.binding.includes('No shared exact template'))).toBe(true);
    expect(m.edges.filter(e=>e.kind==='terms-snapshot'&&e.productId==='usdc')).toHaveLength(2);
});

test('overview promotes the selected branch while preserving explicit filters and view membership', () => {
    const {research,catalogue}=mapFixture(),map=structure.buildMap(research,catalogue);
    const before=structure.overview(map);
    expect(before.shown.map(p=>p.id)).toEqual(['circle-usdc','blackrock-buidl','paxos-gold']);
    const promoted = structure.overview(map,{selection:{kind:'programme',id:'paxos-gold'}});
    expect(promoted.shown.map(p=>p.id)).toEqual(['paxos-gold','circle-usdc','blackrock-buidl']);
    expect(promoted.groups[0].id).toBe('gold');
    expect(structure.overview(map)).toEqual(before);
    expect(structure.overview(map,{mode:'controls'}).shown).toEqual(before.shown);
    expect(structure.overview(map,{search:'Paxos'}).shown.map(p=>p.id)).toEqual(['paxos-gold']);
    expect(structure.overview(map,{entryIds:[]}).shown).toEqual([]);
});

test('a selected group keeps its programme cohort when the displayed view changes', () => {
    const {research,catalogue}=mapFixture(),map=structure.buildMap(research,catalogue);
    const legal=structure.select(map,{mode:'legal',groupMode:'legal',kind:'group',id:'gold'});
    const technical=structure.select(map,{mode:'controls',groupMode:'legal',kind:'group',id:'gold'});
    expect(technical.valid).toBe(true); expect(technical.programmeIds).toEqual(legal.programmeIds);
    expect(technical.groupIds).toEqual(map.programmes.find(p=>p.id==='paxos-gold').recipeIds);
    const recipe=map.recipes[0];
    const controls=structure.select(map,{mode:'controls',groupMode:'controls',kind:'group',id:recipe.id});
    const back=structure.select(map,{mode:'legal',groupMode:'controls',kind:'group',id:recipe.id});
    expect(back.valid).toBe(true); expect(back.programmeIds).toEqual(controls.programmeIds);
});
test('the headline summarizes the feature cards without introducing separate clickable findings', () => {
    const view=visual.profile(get('acred'),'feeder');
    expect(view.context).toBe('ACRED feeder investor');
    expect(view.scopeNote).toContain('offering documents have not been reviewed');
    const html=visual.render(view,{featureHeading:'Summary'});
    expect(html.match(/class="profile-conclusion">(.*?)<\/p>/)[1]).not.toContain('<a');
    expect(html).not.toContain('At a glance'); expect(html).toContain('<h4 class="profile-features-heading">Summary</h4>'); expect(html).toContain('class="profile-feature"');
});

test('an issuer portfolio description is an evidence gap, not a caution by itself', () => {
    const f=feature(get('ustb'),'public-holder','backing').findings[0];
    expect(f).toMatchObject({tone:'unknown',label:'Current holdings not checked'});
    expect(f.note).toContain('did not independently verify');
});
test('every native caution or problem has a visible explanation', () => {
    for(const p of curated.products) for(const c of p.claims) if(['condition','problem'].includes(c.display?.tone)) {
        expect(c.display.note?.trim().length).toBeGreaterThan(0);
        const html=visual.render(visual.profile(p,c.scope.contextId));
        expect(html).toContain(visual.escape(c.display.note));
    }
});
test('a caution without an explanation fails validation', () => {
    const p=get('paxg'); delete p.claims.find(c=>c.dimension==='controls').display.note;
    expect(()=>require('../rwa/lib/research.js').validateResearch({schemaVersion:1,products:[p]})).toThrow('Caution lacks explanation');
});

test('chain count reflects distinct indexed networks, including multi-word chain names', () => {
    expect(structure.chainCount({programmes:[{deployments:['Solana:one','Solana:two','BNB Smart Chain:three']},{deployments:['Ethereum:four','Solana:five']},{deployments:[]}]})).toBe(3);
});

test('summary-only profiles omit the repeated scope and headline while keeping evidence cards', () => {
    const html=visual.render(visual.profile(get('paxg'),'holder'),{summaryOnly:true,featureHeading:'Summary'});
    expect(html).not.toContain('class="profile-scope"');
    expect(html).not.toContain('class="profile-conclusion"');
    expect(html).toContain('>Summary</h4>');
    expect(html).toContain('class="profile-feature"');
});
test('cluster density distinguishes small and large inventories without drawing hundreds of nodes', () => {
    expect(structure.clusterGlyph(0)).toEqual({dots:0,columns:1});
    expect(structure.clusterGlyph(9)).toEqual({dots:9,columns:3});
    expect(structure.clusterGlyph(833).dots).toBeGreaterThan(structure.clusterGlyph(268).dots);
    expect(structure.clusterGlyph(268).dots).toBeGreaterThan(structure.clusterGlyph(9).dots);
    expect(structure.clusterGlyph(100000).dots).toBe(100);
});

test('compact overview expands to show every connected programme and leaves other visible rows clickable', () => {
    const programmes=Array.from({length:12},(_,i)=>({id:`p${i}`,label:`Programme ${i}`,entity:'issuer',products:[{entryId:`e${i}`}],structureIds:[i<9?'fund':'gold'],recipeIds:[],deployments:[]}));
    const map={programmes,structures:[{id:'gold',programmes:['p9','p10','p11']},{id:'fund',programmes:programmes.slice(0,9).map(p=>p.id)}],recipes:[]};
    const selected={kind:'group',id:'fund',mode:'legal'};
    const view=structure.overview(map,{selection:selected});
    expect(view.shown.map(p=>p.id)).toEqual(programmes.slice(0,9).map(p=>p.id));
    expect(view.groups[0].id).toBe('fund');
    expect(structure.overview(map,{expanded:true,selection:selected}).shown).toHaveLength(12);
    const small=structure.overview(map,{selection:{kind:'programme',id:'p11'}});
    expect(small.shown[0].id).toBe('p11'); expect(small.shown).toHaveLength(7);
    expect(structure.select(map,{kind:'programme',id:small.shown[1].id}).valid).toBe(true);
    expect(structure.overview(map,{selection:selected,entryIds:['e2','e3','e11']}).shown.map(p=>p.id)).toEqual(['p2','p3','p11']);
});
