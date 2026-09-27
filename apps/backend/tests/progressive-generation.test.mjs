import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {completedSections} from '../gemini-stream.mjs';
import {consumeSections,startGeneration,generationStatus,cancelGeneration} from '../progressive-generation.mjs';
import {normalizeStreamingSection} from '../planning.mjs';
test('streamed fractional beats stay bounded and invalid model values are never executed',()=>{
 const r=normalizeStreamingSection({cut_pattern:[.25,1.5,3,12]});
 assert.deepEqual(r.cut_pattern,[.5,1.5,3,4]);assert.deepEqual(r.requested_cut_pattern,[.25,1.5,3,12]);
 assert.throws(()=>normalizeStreamingSection({cut_pattern:[0]}));assert.throws(()=>normalizeStreamingSection({cut_pattern:[NaN]}));
});
test('partial JSON releases only closed section objects, including nested arrays and escaped braces',()=>{
 const one={intent:'brace } and "quoted"',cut_pattern:[.5,1],nested:{x:[1,2]}};
 const prefix='{"premise":"x","sections":['+JSON.stringify(one);
 assert.deepEqual(completedSections(prefix),[one]);assert.deepEqual(completedSections(prefix+',{"intent":"unfinished'),[one]);
 for(let i=0;i<prefix.length;i++)assert.equal(completedSections(prefix.slice(0,i)).length,0);
});
test('first section is consumed before the planner finishes subsequent sections',async()=>{
 let release;const hold=new Promise(r=>release=r);const seen=[];
 const result=await consumeSections(async emit=>{emit(1);await hold;emit(2);return 'done';},async x=>{seen.push(x);if(x===1)release();});
 assert.deepEqual(seen,[1,2]);assert.equal(result,'done');
});
async function fixture(t){
 const temp=await mkdtemp(path.join(os.tmpdir(),'mad-progressive-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 const library={music:[{id:'m',name:'song',duration:6,bpm:120,beats:[0,1,2,3,4,5,6],accents:[]}],sources:[]};
 let state={revision:1,project:{id:'mad-main',timeline:{items:[],tracks:[]}},media:[]};const snapshots=[];
 const deps={logRoot:temp,getState:async()=>structuredClone(state),commit:async(_,base,fn)=>{assert.equal(base,state.revision);const project=await fn();state={...state,revision:state.revision+1,project:structuredClone(project)};snapshots.push(structuredClone(state));return structuredClone(state);},loadResources:async()=>({shots:Array.from({length:11},(_,i)=>({episode:i+1,semanticStatus:'complete'}))}),understandMusic:async()=>({id:'u',summary:'song',edit_direction:'act',dialogue_suitability:0}),loadEvents:async()=>({events:[],primaryAccents:[]}),askModel:async()=>({ms:0,result:{answers:{}}}),choose:async({item})=>({selected:{item:{...item,mediaId:'real',src:'/real.mp4',sourceStart:0,sourceEnd:24,mad:{shotId:'shot'}}},traceUrl:'trace',timing:{totalMs:1}}),polish:async({project})=>({project})};
 const section={id:'s',from_beat:0,to_beat:6,start:0,end:6,intent:'act',energy:.5,cut_pattern:[2],preferred_shots:[],audio_intent:'none',visual_strategy:'move'};
 return {library,deps,section,snapshots};
}
test('from zero publishes music immediately then real clips before full planning completes',async t=>{
 const f=await fixture(t);let release;const hold=new Promise(r=>release=r);let producerDone=false;
 f.deps.makePlan=async(_,__,options)=>{options.onSection(f.section,[0,1,2,3,4,5,6]);await hold;producerDone=true;return {sections:[f.section]};};
 const originalChoose=f.deps.choose;f.deps.choose=async args=>{assert.equal(producerDone,false);const result=await originalChoose(args);release();return result;};
 // Only first selection is required to overlap planning.
 const first=f.deps.choose;let chosen=0;f.deps.choose=async args=>++chosen===1?first(args):originalChoose(args);
 const job=await startGeneration({musicId:'m',duration:6,baseRevision:1},f.library,f.deps);
 assert.equal(job.state.project.timeline.items.filter(i=>i.type==='video').length,0);assert.equal(job.state.project.timeline.items[0].trackId,'music');
 while(generationStatus(job.id).status==='running')await new Promise(r=>setTimeout(r,5));
 const final=generationStatus(job.id);assert.equal(final.status,'complete',final.error);assert.ok(final.clips>0);
 assert.ok(f.snapshots.every(s=>s.project.timeline.items.every(i=>i.type!=='video'||i.mediaId==='real')));
 assert.equal(f.snapshots[0].project.timeline.items.length,1);
});
test('cancel keeps the music-only prefix and rejects an in-flight first clip',async t=>{
 const f=await fixture(t);let release,entered;const hold=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
 f.deps.makePlan=async(_,__,o)=>{o.onSection(f.section,[0,1,2,3,4,5,6]);return {};};
 const choose=f.deps.choose;f.deps.choose=async args=>{entered();await hold;return choose(args);};
 const job=await startGeneration({musicId:'m',duration:6,baseRevision:1},f.library,f.deps);await ready;cancelGeneration(job.id);release();await new Promise(r=>setTimeout(r,20));
 assert.equal(generationStatus(job.id).status,'cancelled');assert.equal(f.snapshots.length,1);assert.equal(generationStatus(job.id).clips,0);
});
