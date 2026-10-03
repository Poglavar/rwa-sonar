#!/usr/bin/env node
// One-off recorded narration, checkpointed per clip. Credentials stay outside public assets.
import {readFile,writeFile,mkdir,stat,rename,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const args=process.argv.slice(2);
if(!args.includes('--run')){
    console.log('Usage: node --env-file=.env rwa/record-story.mjs --run [--voice-id=<id>]');
    process.exit(0);
}
const key=process.env.ELEVENLABS_API_KEY;
if(!key)throw new Error('Configure ELEVENLABS_API_KEY before generating narration');
const voiceId=args.find(a=>a.startsWith('--voice-id='))?.slice(11)||'JBFqnCBsd6RMkjVDRZzb';
const modelId='eleven_multilingual_v2';
const root=resolve(import.meta.dirname,'..');
const file=join(root,'rwa/data/stories/backpack.json');
const data=JSON.parse(await readFile(file,'utf8'));
const rows=[...data.chapters,...data.variants];
const settings={stability:0.5,similarity_boost:0.75,style:0,use_speaker_boost:true,speed:0.98};
const duration=path=>Number(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',path],{encoding:'utf8'}).trim());
const ts=()=>new Date().toISOString();
for(const [i,row] of rows.entries()){
    const fingerprint=createHash('sha256').update(JSON.stringify({text:row.text,voiceId,modelId,settings})).digest('hex');
    const target=join(root,row.audio.replace(/^\.\//,''));
    const present=await stat(target).catch(()=>null);
    if(present?.size&&row.recording?.fingerprint===fingerprint){
        const seconds=duration(target);
        if(Number.isFinite(seconds)&&seconds>0){console.log(`[${ts()}] ${i+1}/${rows.length} ${row.id}: retained verified recording`);continue;}
    }
    console.log(`[${ts()}] ${i+1}/${rows.length} ${row.id}: generating ElevenLabs narration`);
    const response=await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,{
        method:'POST',headers:{'xi-api-key':key,'Content-Type':'application/json'},
        body:JSON.stringify({text:row.text,model_id:modelId,language_code:'en',voice_settings:settings}),signal:AbortSignal.timeout(120000)
    });
    if(!response.ok)throw new Error(`ElevenLabs returned HTTP ${response.status}; completed clips are checkpointed`);
    const mp3=join(tmpdir(),`rwa-story-${process.pid}-${row.id}.mp3`), m4a=target+'.recording.m4a';
    await mkdir(join(root,'media/stories/backpack'),{recursive:true});
    try{
        await writeFile(mp3,Buffer.from(await response.arrayBuffer()));
        execFileSync('ffmpeg',['-y','-loglevel','error','-i',mp3,'-c:a','aac','-b:a','128k','-movflags','+faststart',m4a]);
        const seconds=duration(m4a);
        if(!Number.isFinite(seconds)||seconds<=0)throw new Error('Generated recording has no playable duration');
        await rename(m4a,target);
        row.duration=Math.round(seconds*100)/100;
        row.recording={provider:'ElevenLabs',voiceId,modelId,fingerprint,text:row.text};
        await writeFile(file,JSON.stringify(data,null,2)+'\n');
        console.log(`[${ts()}] ${i+1}/${rows.length} ${row.id}: verified ${row.duration}s`);
    }finally{await rm(mp3,{force:true});await rm(m4a,{force:true});}
}
data.voice=`ElevenLabs · ${voiceId==='JBFqnCBsd6RMkjVDRZzb'?'George':voiceId} · synthetic narration`;
await writeFile(file,JSON.stringify(data,null,2)+'\n');
console.log(`[${ts()}] ${rows.length}/${rows.length} recordings complete`);
