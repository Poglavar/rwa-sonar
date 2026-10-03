const story=require('../rwa/lib/token-story.js');
const report=require('../rwa/lib/report-view.js');
const authored=require('../rwa/data/stories/backpack.json');
const visual=require('../rwa/lib/visual-profile.js');
let data;
const dossier=require('./data/issuers/backpack-securities-spcx.json');
let view;
const initial=()=>({index:0,scenario:null,time:0,playing:false,muted:false,error:null});
beforeAll(async()=>{
    const {stockResearch}=await import('../rwa/lib/stock-research.mjs');
    const p=stockResearch({issuers:[{slug:'backpack-securities',name:'Backpack Securities',evidence:dossier.evidence}]},{tokens:[{issuer:'backpack-securities',mint:'ExampleMint',symbol:'EXAMPLE'}]},{'backpack-securities-spcx':dossier})[0];
    view=report.view(p,'programme',{hash:'#story'});
    data=structuredClone(authored);
    data.basis=Object.fromEntries(p.claims.map(c=>[c.dimension,visual.signature(c,p)]));
    data.caseBasis=Object.fromEntries(data.variants.map(v=>[v.caseId,story.caseBasis(p,p.reportDetails.cases.find(c=>c.id===v.caseId))]));
});
test('story is tied to its reviewed context, all findings and each failure case',()=>{
    expect(story.build(view,data)).toBe(data);
    for(const dim of Object.keys(data.basis)){
        const v=structuredClone(view);v.product.claims.find(c=>c.dimension===dim).summary+=' Changed terms.';
        expect(()=>story.build(v,data)).toThrow('Story needs review');
    }
    const changed=structuredClone(view);changed.cases.find(c=>c.id==='issuer-insolvency').outcome+=' Different outcome.';
    expect(()=>story.build(changed,data)).toThrow('Story scenario needs review');
});
test('an unbound address and another product cannot inherit the authored story',()=>{
    const v=report.view(view.product,'programme',{hash:'#story',deploymentId:'solana:ExampleMint'});
    expect(v.topic).toBe('overview');expect(story.available(v)).toBe(false);
    expect(()=>story.build(v,data)).toThrow('Story does not cover');
    const native=require('../rwa/data/research.json').products.find(p=>p.id==='paxg');
    expect(report.view(native,'holder',{hash:'#story'}).topic).toBe('overview');
});
test('the three failures affect different parties and recovery never becomes guaranteed',()=>{
    const s={...initial(),index:4};
    const exchange=story.transition(data,s,{type:'scenario',id:'exchange'});
    expect(story.scene(data,exchange)).toMatchObject({failed:'exchange',conditional:true});
    const trustee=story.transition(data,s,{type:'scenario',id:'trustee'});
    expect(story.scene(data,trustee)).toMatchObject({failed:'trustee',conditional:false});
    const custody=story.transition(data,s,{type:'scenario',id:'custody'});
    expect(story.scene(data,custody)).toMatchObject({failed:'pool',conditional:false});
    expect(story.segment(data,trustee).caseId).toBe('issuer-insolvency');
    expect(story.segment(data,custody).caseId).toBe('custodian-insolvency');
    expect(()=>story.transition(data,s,{type:'scenario',id:'fiction'})).toThrow('Unknown story scenario');
});
test('playback advances from branches, pauses on completion and preserves mute across chapters',()=>{
    let s=story.transition(data,initial(),{type:'play'});
    s=story.transition(data,s,{type:'mute'});
    s=story.transition(data,s,{type:'chapter',index:4});
    s=story.transition(data,s,{type:'scenario',id:'exchange'});
    expect(s).toMatchObject({playing:true,muted:true,time:0,scenario:'exchange'});
    s=story.transition(data,s,{type:'ended'});
    expect(s).toMatchObject({index:5,scenario:null,playing:true,muted:true});
    s=story.transition(data,s,{type:'ended'});
    expect(s).toMatchObject({index:5,playing:false,time:data.chapters[5].duration});
    expect(story.transition(data,s,{type:'chapter',index:-2}).index).toBe(0);
    expect(story.transition(data,s,{type:'chapter',index:99}).index).toBe(5);
});
test('progress follows the selected recording and media failure leaves readable narration',()=>{
    const branch=story.transition(data,initial(),{type:'scenario',id:'trustee'});
    expect(story.transition(data,branch,{type:'tick',time:999}).time).toBe(data.variants.find(v=>v.id==='trustee').duration);
    expect(story.transition(data,{...branch,playing:true},{type:'error'})).toMatchObject({playing:false,index:4,scenario:'trustee'});
    expect(story.duration(data)).toBeGreaterThan(90);
    expect(story.clock(110)).toBe('1:50');
    const hostile=structuredClone(data);hostile.title='<img onerror=alert(1)>';
    expect(story.render(hostile)).toContain('&lt;img');expect(story.render(hostile)).not.toContain('<img');
});

test('the illustrated focus follows the current narration time',()=>{
    const start=story.scene(data,initial());
    expect(start.focus).toEqual(['wallet']);
    const later=story.scene(data,{...initial(),time:data.chapters[0].duration*.9});
    expect(later.focus).toEqual(['wallet','exchange','brokerage']);
});

test('edited narration cannot reuse an old recording',()=>{
    const changed=structuredClone(data);changed.chapters[0].text+=' Changed explanation.';
    expect(()=>story.build(view,changed)).toThrow('Invalid story recording');
});
