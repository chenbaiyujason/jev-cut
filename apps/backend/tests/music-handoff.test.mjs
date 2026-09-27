import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,copyFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {analyzeMusicIntent,readMusicIntent,cachedMusicContext} from '../music-intent.mjs';
import {planEdit} from '../planning.mjs';
import {semanticKey} from '../semantic-decision-cache.mjs';
const understanding=()=>({summary:'明亮旋律逐步张紧',mood:'轻盈',texture:'电子',has_intelligible_lyrics:true,lyrics_theme:'无法确认',sections:[{start:0,end:10,energy:.5,heard:'持续演唱，末尾留白',emotion:'期待',tension:.7,vocal_density:.8,development:'旋律逐步抬升',visual_response:'延续眼神再释放动作'}],edit_direction:'视觉延续后释放',retrieval_queries:['眼神','奔跑','伸手'],suggested_intensity:.7,dialogue_suitability:.2,source_audio_reason:'人声占用高，避免叠对白',uncertainties:['词义不清']});
test('music perception reads audio once, ignores story and edit length, and invalidates changed audio',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'mad-music-context-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'input.m4a');await writeFile(source,'audio');let calls=0;const requests=[];
 const deps={directory:path.join(dir,'cache'),model:'test-model',transcode:async(_,args)=>copyFile(source,args.at(-1)),understandFn:async(parts)=>{calls++;requests.push(parts);return {result:understanding(),model:'test-model',metrics:{ms:10}};}};
 const music={id:'m',duration:10,original:source};
 const first=await analyzeMusicIntent(music,{duration:5,userPreference:'忧郁晓美焰'},deps);
 const again=await analyzeMusicIntent(music,{duration:8,userPreference:'热血胜利'},deps);
 assert.equal(calls,1);assert.equal(again.cached,true);assert.equal(again.requestMetrics.modelMs,0);assert.equal(first.duration,10);
 assert.ok(requests[0].some(p=>p.inlineData?.mimeType==='audio/mp4'));
 assert.doesNotMatch(requests[0].find(p=>p.text).text,/忧郁晓美焰|热血胜利/);
 await writeFile(source,'different source audio');assert.equal(await readMusicIntent(music,deps),null);
 const changed=await analyzeMusicIntent(music,{},deps);assert.equal(calls,2);assert.notEqual(changed.id,first.id);
 await analyzeMusicIntent(music,{forceReanalyze:true},deps);assert.equal(calls,3);
});
test('planner receives full musical development plus user goal, without resending audio',async()=>{
 const music={beats:[.5,1,1.5,2,2.5,3,3.5,4,4.5],duration:10};let request;
 const intent={...understanding(),id:'u1'};
 const result=await planEdit(music,[],{duration:5,prompt:'晓美焰忧郁拯救',intensity:.8,keepDialogue:false,globalScope:true,musicIntent:intent},{understandFn:async(parts)=>{request=parts;return {model:'test',result:{title:'测试',premise:'声画反差',sections:[{from_beat:0,to_beat:10,energy:.5,cut_pattern:[.5,1,2],preferred_shots:[],intent:'拯救',audio_intent:'不叠对白',music_basis:'旋律逐步抬升',visual_strategy:'眼神延续后动作释放'}]}};}});
 assert.ok(request.every(p=>!p.inlineData));assert.match(request[0].text,/晓美焰忧郁拯救/);assert.match(request[0].text,/旋律逐步抬升/);assert.match(request[0].text,/vocal_density/);
 assert.equal(result.musicUnderstandingId,'u1');assert.equal(result.inputs.rawAudio,false);
});
test('local Winnow music context maps trimmed and retimed music to source sections without inference',async()=>{
 const music={id:'m'},project={metadata:{fps:30},timeline:{items:[{trackId:'music',mediaId:'m',from:30,durationInFrames:150,sourceStart:60,sourceFps:30,speed:2}]}};
 const context=await cachedMusicContext(project,{from:60,durationInFrames:30},music,async()=>({...understanding(),id:'u2',sections:[{start:0,end:4,emotion:'intro'},{start:4,end:6,emotion:'release'},{start:6,end:10,emotion:'outro'}]}));
 assert.deepEqual(context.sourceRange,[4,6]);assert.deepEqual(context.sections.map(s=>s.emotion),['release']);
 assert.equal((await cachedMusicContext(project,{from:0,durationInFrames:15},music,()=>{throw Error('must not load');})).available,false);
});
test('Winnow semantic cache cannot reuse a score from a different music section',()=>{
 const base={goal:'保护',prompt:'',intent:'动作',shot:{id:'s',description:'向前奔跑'}};
 assert.notEqual(semanticKey({...base,musicContext:{id:'m',sections:['quiet']}}),semanticKey({...base,musicContext:{id:'m',sections:['release']}}));
});
