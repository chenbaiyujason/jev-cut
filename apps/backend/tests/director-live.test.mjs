import test from 'node:test';
import assert from 'node:assert/strict';
import {buildLiveReplacements,applyLiveReplacement} from '../director-live.mjs';

function fixture(){
  const item={id:'clip',type:'video',trackId:'video',from:30,durationInFrames:30,speed:1,mediaId:'ep',sourceStart:20,sourceEnd:44,sourceFps:24,volume:-60,transform:{scale:1.04},effects:[{type:'grade'}],mad:{shotId:'a'}};
  const shots=['a','b'].map((id,n)=>({id,sourceId:'ep',description:id,startFrame:n*100,endFrame:n*100+80,safeRanges:[{startFrame:n*100+5,endFrame:n*100+75}]}));
  return {project:{metadata:{fps:30},timeline:{tracks:[{id:'video'}],items:[item,{id:'music',type:'audio',trackId:'music',from:0,durationInFrames:120}],transitions:[],keyframes:[{itemId:'clip',value:1}]}},row:{id:'clip',role:'bond',alternatives:shots.map(s=>({shotId:s.id,visual:s.description}))},library:{sources:[{id:'ep',episode:1,fps:'24/1',duration:100}]},shots,motion:Object.fromEntries(shots.map(s=>[s.id,{ranges:[{startFrame:s.startFrame+5,delta:Array(70).fill(2),brightness:Array(70).fill(100),detail:Array(70).fill(20)}]}]))};
}
test('replacement changes one source, preserving timing, styling, keyframes and music',()=>{
  const f=fixture(),before=structuredClone(f.project),{candidates}=buildLiveReplacements(f);
  assert.deepEqual(candidates.find(c=>c.keep).item,before.timeline.items[0]);
  const replacement=candidates.find(c=>!c.keep).item,after=applyLiveReplacement(f.project,replacement);
  assert.equal(replacement.mad.shotId,'b');
  assert.ok(replacement.sourceStart>=106&&replacement.sourceEnd<=174);
  for(const key of ['from','durationInFrames','speed','transform','effects','volume'])assert.deepEqual(replacement[key],before.timeline.items[0][key]);
  assert.deepEqual(after.timeline.items[1],before.timeline.items[1]);
  assert.deepEqual(after.timeline.keyframes,before.timeline.keyframes);
  assert.deepEqual(f.project,before);
});
test('protected source audio, locked tracks and impossible source windows reject',()=>{
  const audio=fixture();audio.project.timeline.items.push({id:'voice',type:'audio',trackId:'dialogue',from:40,durationInFrames:10});
  assert.throws(()=>buildLiveReplacements(audio),/原声或台词/);
  const locked=fixture();locked.project.timeline.tracks[0].locked=true;
  assert.throws(()=>buildLiveReplacements(locked),/锁定/);
  const short=fixture();short.project.timeline.items[0].durationInFrames=300;
  assert.throws(()=>buildLiveReplacements(short),/没有足够替代/);
});
test('replacement retains a validated transition and enough hidden source handles',()=>{
  const f=fixture();f.project.timeline.items.unshift({...f.project.timeline.items[0],id:'previous',from:0});
  f.project.timeline.transitions=[{id:'edge',leftClipId:'previous',rightClipId:'clip',durationInFrames:6,presentation:'dissolve'}];
  const {candidates}=buildLiveReplacements(f),replacement=candidates.find(c=>!c.keep).item;
  assert.ok(replacement.sourceStart>=109);
  assert.deepEqual(applyLiveReplacement(f.project,replacement).timeline.transitions,f.project.timeline.transitions);
});
