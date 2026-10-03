// Media wiring stays separate from the scoped story model and authored narration.
(function(root){
    const model=root.__rwaTokenStory;
    root.__rwaTokenStoryUI={mount:async function(host,view){
        let disposed=false, audio=null;
        const dispose=()=>{disposed=true;if(audio){audio.pause();audio.removeAttribute('src');audio.load();}};
        host.innerHTML='<p role="status">Loading the illustrated story…</p>';
        try{
            const response=await fetch('./rwa/data/stories/backpack.json',{cache:'no-store'});
            if(!response.ok)throw new Error('Story could not load');
            const data=model.build(view,await response.json());
            if(disposed||!host.isConnected)return dispose;
            host.innerHTML=model.render(data);
            audio=host.querySelector('[data-story-audio]');
            const q=s=>host.querySelector(s),qa=s=>host.querySelectorAll(s);
            let state={index:0,scenario:null,time:0,playing:false,muted:false,error:null};
            let recording=null, generation=0;
            function paint(){
                const c=model.segment(data,state),scene=model.scene(data,state);
                paintScene();
                qa('[data-story-chapter]').forEach(b=>b.setAttribute('aria-pressed',Number(b.dataset.storyChapter)===state.index));
                qa('[data-story-scenario]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.storyScenario===state.scenario));
                q('.story-scene-caption').textContent=scene.caption;
                q('.story-scenarios').hidden=state.index!==4;
                q('.story-chapter-number').textContent=`Chapter ${state.index+1} of ${data.chapters.length}${state.scenario?' · '+c.label:''}`;
                q('.story-chapter-title').textContent=scene.title;
                q('.story-caption-text').textContent=c.text;
                q('[data-story-evidence]').dataset.reportEvidence=c.caseId?'case:'+c.caseId:c.dimension;
                q('[data-story-play]').textContent=state.playing?'Ⅱ Pause':state.index===5&&state.time>=c.duration?'↻ Replay story':'▶ Play story';
                q('[data-story-mute]').textContent=state.muted?'Sound off':'Sound on';q('[data-story-mute]').setAttribute('aria-pressed',state.muted);
                q('[data-story-prev]').disabled=state.index===0;q('[data-story-next]').disabled=state.index===data.chapters.length-1;
                q('.story-error').hidden=!state.error;q('.story-error').textContent=state.error||'';
                audio.muted=state.muted;
                const next=c.id;
                if(recording!==next){generation++;recording=next;audio.src=c.audio+'?v='+c.recording.fingerprint.slice(0,12);audio.load();if(state.playing)play();}
                progress();
            }
            function paintScene(){
                const scene=model.scene(data,state),stage=q('.story-scene');
                stage.dataset.chapter=state.index;stage.dataset.playing=state.playing;stage.dataset.failed=scene.failed||'';stage.dataset.conditional=scene.conditional;
                qa('[data-story-node]').forEach(n=>{n.dataset.focus=scene.focus.includes(n.dataset.storyNode);n.dataset.failed=scene.failed===n.dataset.storyNode;});
            }
            function progress(){const c=model.segment(data,state),seek=q('[data-story-seek]');seek.max=c.duration;seek.value=state.time;seek.setAttribute('aria-valuetext',model.clock(state.time));q('.story-clock').textContent=`${model.clock(state.time)} / ${model.clock(c.duration)}`;}
            function dispatch(event){state=model.transition(data,state,event);if((event.type==='chapter'||event.type==='scenario')&&recording===model.segment(data,state).id)audio.currentTime=0;paint();}
            function play(){const current=generation;audio.play().catch(()=>{if(!disposed&&current===generation){dispatch({type:'error'});}});}
            function pause(){audio.pause();dispatch({type:'pause'});}
            host.addEventListener('click',event=>{
                const b=event.target.closest('button');if(!b)return;
                if(b.hasAttribute('data-report-evidence')){pause();return;}
                if(b.hasAttribute('data-story-play')){if(state.playing)pause();else{if(state.index===5&&state.time>=model.segment(data,state).duration)dispatch({type:'chapter',index:0});dispatch({type:'play'});play();}}
                else if(b.hasAttribute('data-story-chapter'))dispatch({type:'chapter',index:Number(b.dataset.storyChapter)});
                else if(b.hasAttribute('data-story-scenario'))dispatch({type:'scenario',id:b.dataset.storyScenario});
                else if(b.hasAttribute('data-story-mute'))dispatch({type:'mute'});
                else if(b.hasAttribute('data-story-prev'))dispatch({type:'chapter',index:state.index-1});
                else if(b.hasAttribute('data-story-next'))dispatch({type:'chapter',index:state.index+1});
            });
            q('[data-story-seek]').addEventListener('input',event=>{audio.currentTime=Number(event.target.value);state=model.transition(data,state,{type:'tick',time:audio.currentTime});progress();paintScene();});
            audio.addEventListener('timeupdate',()=>{state=model.transition(data,state,{type:'tick',time:audio.currentTime});progress();paintScene();});
            audio.addEventListener('ended',()=>dispatch({type:'ended'}));
            audio.addEventListener('error',()=>{if(!disposed)dispatch({type:'error'});});
            document.addEventListener('visibilitychange',onVisibility);
            function onVisibility(){if(document.hidden&&!disposed)pause();}
            const remove=dispose;
            host.__storyDispose=()=>{document.removeEventListener('visibilitychange',onVisibility);remove();};
            paint();
            host.scrollIntoView({block:'start'});
        }catch(error){if(!disposed)host.innerHTML=`<p role="status">${model.available(view)?'The story is unavailable or needs review against changed evidence.':'This story does not cover the selected position.'}</p><a href="#overview">Return to the overview →</a>`;}
        return dispose;
    }};
})(window);
