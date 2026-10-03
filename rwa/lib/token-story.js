// Authored narration must remain bound to the reviewed programme and cited findings.
(function(root,factory){
    if(typeof module==='object'&&module.exports)module.exports=factory(require('./visual-profile.js'));
    else root.__rwaTokenStory=factory(root.__rwaVisualProfile);
})(this,function(visual){
    'use strict';
    const esc=visual.escape;
    const NODES=[
        {id:'wallet',label:'Your wallet',detail:'On-chain token',icon:'document',dimension:'rights'},
        {id:'exchange',label:'Backpack Exchange',detail:'Account and conversion',icon:'door',dimension:'exit'},
        {id:'trustee',label:'Trek Nexus',detail:'Issuer · bare trustee',icon:'vault',dimension:'rights'},
        {id:'brokerage',label:'Your brokerage holding',detail:'Off-chain security entitlement',icon:'document',dimension:'exit'},
        {id:'forge',label:'Trek Forge',detail:'Recognised beneficiary',icon:'document',dimension:'rights'},
        {id:'pool',label:'Underlying share pool',detail:'Token-pool custodian unverified',icon:'vault',dimension:'backing'}
    ];
    function available(v){return Boolean(v.bound&&v.product.id==='stock:backpack-securities'&&v.context.id==='programme');}
    function caseBasis(p,c){return JSON.stringify({outcome:c.outcome,sourceIds:c.sourceIds,sources:c.sourceIds.map(id=>p.sources.find(s=>s.id===id))});}
    function build(v,data){
        if(!available(v)||data.productId!==v.product.id||data.contextId!==v.context.id||data.termsId!==v.context.termsId)throw new Error('Story does not cover this holder position');
        for(const [dim,basis] of Object.entries(data.basis)){
            const claim=v.product.claims.find(c=>c.dimension===dim&&c.scope.contextId===v.context.id);
            if(!claim||visual.signature(claim,v.product)!==basis)throw new Error('Story needs review after evidence changed');
        }
        for(const [id,basis] of Object.entries(data.caseBasis)){
            const c=v.cases.find(c=>c.id===id);
            if(!c||caseBasis(v.product,c)!==basis)throw new Error('Story scenario needs review after evidence changed');
        }
        if(data.chapters.length!==6||Object.keys(data.basis).length!==7)throw new Error('Incomplete story review');
        const all=[...data.chapters,...data.variants];
        for(const c of all)if(c.recording?.provider!=='ElevenLabs'||c.recording.text!==c.text||!c.recording.fingerprint||!c.text||!Number.isFinite(c.duration)||c.duration<=0||c.audio!==`./media/stories/backpack/${c.id}.m4a`)throw new Error('Invalid story recording');
        return data;
    }
    function duration(data){return data.chapters.reduce((n,c)=>n+c.duration,0);}
    function clock(seconds){const s=Math.max(0,Math.floor(seconds));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');}
    function segment(data,state){return state.index===4&&state.scenario?data.variants.find(v=>v.id===state.scenario)||data.chapters[4]:data.chapters[state.index];}
    function transition(data,state,event){
        const last=data.chapters.length-1;
        switch(event.type){
            case 'play': return {...state,playing:true,error:null};
            case 'pause': return {...state,playing:false};
            case 'chapter': return {...state,index:Math.max(0,Math.min(last,event.index)),time:0,scenario:null,error:null};
            case 'scenario': if(!data.variants.some(v=>v.id===event.id))throw new Error('Unknown story scenario');return {...state,index:4,scenario:event.id,time:0,error:null};
            case 'tick': return {...state,time:Math.max(0,Math.min(segment(data,state).duration,event.time))};
            case 'ended': return state.index===last?{...state,playing:false,time:segment(data,state).duration}:{...state,index:state.index+1,time:0,scenario:null};
            case 'mute': return {...state,muted:!state.muted};
            case 'error': return {...state,playing:false,error:'Recording could not play. You can still explore each chapter and read its narration.'};
            default: throw new Error('Unknown story event');
        }
    }
    function scene(data,state){
        const c=segment(data,state), failed=state.index===4?c.affected:null;
        const progress=state.time/c.duration;
        const cues={0:[['wallet'],['wallet','exchange'],['wallet','exchange','brokerage']],1:[['trustee','pool'],['forge','trustee','pool'],['wallet','forge','trustee','pool']],3:[['wallet'],['wallet','exchange'],['exchange','brokerage']]};
        const focus=cues[state.index]?.[Math.min(2,Math.floor(progress*3))]||c.focus||data.chapters[state.index].focus;
        return {focus,failed,control:state.index===2,exit:state.index===3,conditional:state.index===4&&state.scenario==='exchange',title:c.title,caption:state.index===2?'Administrator powers shown for the reviewed SPCX sample.':state.index===3?'Documented conversion steps · no completed conversion asserted.':state.index===4?'Hypothetical failure · conditional routes are not assured recovery.':'Programme structure · sampled product terms may differ.'};
    }
    function edges(mobile){
        const paths=mobile?{
            conversion:'M100 110H300',account:'M300 110L100 290',affiliate:'M300 110V290',beneficiary:'M300 290V450',assets:'M300 450H100',direct:'M100 110V30H385V450H300'
        }:{conversion:'M120 110H400',account:'M400 110L120 290',affiliate:'M400 110V290',beneficiary:'M400 290L660 110',assets:'M660 110V290',direct:'M120 110V30H660V110'};
        return `<svg class="story-edges ${mobile?'story-edges-mobile':'story-edges-desktop'}" viewBox="0 0 ${mobile?'400 550':'800 380'}" preserveAspectRatio="none" aria-hidden="true">${Object.entries(paths).map(([id,d])=>`<path class="story-edge story-edge-${id}" d="${d}"/>`).join('')}</svg>`;
    }
    function render(data){
        return `<section class="token-story" aria-label="Narrated token story"><div class="story-intro"><p class="eyebrow">An illustrated explanation</p><h2>${esc(data.title)}</h2><p>Follow the claim, the keys and the route out.</p></div><div class="story-chapters" role="group" aria-label="Story chapters">${data.chapters.map((c,i)=>`<button type="button" data-story-chapter="${i}" aria-pressed="${i===0}"><span>${String(i+1).padStart(2,'0')}</span>${esc(c.label)}</button>`).join('')}</div><div class="story-player"><button type="button" class="story-play" data-story-play>▶ Play story</button><button type="button" data-story-mute aria-pressed="false">Sound on</button><span class="story-clock">0:00 / ${clock(data.chapters[0].duration)}</span><label class="story-scrubber-label"><span class="sr-only">Seek within the current chapter</span><input type="range" data-story-seek min="0" max="${data.chapters[0].duration}" step="0.1" value="0"></label><div class="story-step-controls"><button type="button" data-story-prev aria-label="Previous chapter">←</button><button type="button" data-story-next aria-label="Next chapter">→</button></div></div><div class="story-scene" data-chapter="0" data-playing="false">${edges(false)}${edges(true)}<p class="story-direct-label">Ordinary direct trust rights <span>×</span></p>${NODES.map(n=>`<button type="button" class="story-node story-node-${n.id}" data-story-node="${n.id}" data-report-evidence="${n.dimension}">${visual.icon(n.icon)}<strong>${esc(n.label)}</strong><small>${esc(n.detail)}</small></button>`).join('')}<div class="story-key-callout">${visual.icon('key')}<span>Pause · transfer · burn<small>Recorded administrator powers</small></span></div><div class="story-route-label">Token burned → account entitlement</div><div class="story-recovery-label">Contingency + trustee registration required</div></div><p class="story-scene-caption"></p><div class="story-scenarios" hidden role="group" aria-label="Choose a failure"><span>Remove a party</span>${data.variants.map(v=>`<button type="button" data-story-scenario="${v.id}" aria-pressed="false">${esc(v.label)}</button>`).join('')}</div><div class="story-narration"><p class="story-chapter-number">Chapter 1 of 6</p><h3 class="story-chapter-title"></h3><p class="story-caption-text" aria-live="polite"></p><button type="button" class="report-evidence-button" data-story-evidence data-report-evidence="rights">Inspect the evidence ↗</button></div><p class="story-error" role="status" hidden></p><details class="story-transcript"><summary>Read the full narration · ${clock(duration(data))} main story</summary>${data.chapters.map(c=>`<h4>${esc(c.label)}</h4><p>${esc(c.text)}</p>`).join('')}<h4>Failure branches</h4>${data.variants.map(c=>`<h4>${esc(c.label)}</h4><p>${esc(c.text)}</p>`).join('')}<p class="report-caption">${esc(data.voice)}. Research reviewed ${esc(data.reviewedAt?.slice(0,10)||'date not recorded')}. Programme research; individual token terms require their own review.</p></details><audio data-story-audio preload="metadata"></audio></section>`;
    }
    return {NODES,available,caseBasis,build,duration,clock,segment,transition,scene,render};
});
