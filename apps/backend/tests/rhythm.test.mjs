import test from 'node:test';
import assert from 'node:assert/strict';
import {slotsFromPlan} from '../planning.mjs';
import {firstRhythmicEntry,shapeAroundAccents} from '../rhythm.mjs';
import {makeCandidates} from '../sequence.mjs';
import {validateProject} from '../core.mjs';
import {sourceSoundCandidate} from '../source-sound.mjs';

test('short effect excerpts may accent dense cuts but never overlapping speech',()=>{
  const clip={sourceIn:10.1,start:0,end:.3,rate:1,gain:0};
  const shot={semantic:{audio_events:[{start:10,end:11,type:'sfx',description:'金属碰撞'}]},cues:[]};
  assert.deepEqual(sourceSoundCandidate(clip,shot),{start:10.1,end:10.4,description:'金属碰撞',type:'sfx',partial:true});
  assert.equal(sourceSoundCandidate(clip,{...shot,cues:[{start:10,end:11,text:'私はあなたを守りたい'}]}),null);
});

test('first sustained rhythm wins even when a much louder climax comes late',()=>{
  const events={events:[.55,1.05,1.55,2.05,40].map(time=>({time,low:1,mid:1,salience:time===40?10:1})),primaryAccents:[{time:40}]};
  assert.equal(firstRhythmicEntry(events,.5),.55);
});
test('half-beat phrasing produces varied frame-aligned cuts without gaps',()=>{
  const plan={beatTimes:[0,.5,1,1.5,2,2.5,3],sections:[{from_beat:0,to_beat:6,cut_pattern:[.5,1,2],energy:.8,preferred_shots:[]}]};
  const slots=slotsFromPlan(plan,{accents:[]},3);
  assert.equal(slots[0].start,0);assert.equal(slots.at(-1).end,3);
  assert.ok(slots.some(s=>s.end-s.start<.3));assert.ok(slots.some(s=>s.end-s.start>.8));
  for(let i=1;i<slots.length;i++)assert.equal(slots[i].start,slots[i-1].end);
});
test('streamed short opening and later sections keep both boundaries without black gaps or overlap',()=>{
  const first=shapeAroundAccents([{start:0,end:4/30,accent:0,energy:.5}],[],.5);
  assert.equal(first.length,1);assert.equal(first[0].start,0);assert.equal(first[0].end,4/30);
  const later=shapeAroundAccents([{start:1,end:1.3,accent:1.05,energy:.5},{start:1.3,end:2,accent:1.5,energy:.5}],[{time:1.05,policy:'breathe'}],.5);
  assert.equal(later[0].start,1);assert.equal(later.at(-1).end,2);
  for(let i=1;i<later.length;i++)assert.equal(later[i].start,later[i-1].end);
});
test('accent shaping supports both cut-on-hit and action-inside-shot with anticipation',()=>{
  const slots=Array.from({length:12},(_,i)=>({start:i*.25,end:(i+1)*.25,accent:i*.25,energy:.7}));
  const shaped=shapeAroundAccents(slots,[{time:.55,policy:'breathe',openingClimax:true},{time:2.05,policy:'carry'}],.5);
  assert.ok(shaped.some(s=>s.openingClimax&&Math.abs(s.start-.55)<1/30));
  assert.ok(shaped.some(s=>s.accentPolicy==='carry'&&s.start<2.05&&s.end>2.05));
  assert.ok(shaped.some(s=>s.accentRole==='anticipation'));
  for(let i=1;i<shaped.length;i++)assert.equal(shaped[i].start,shaped[i-1].end);
});
test('candidate cannot span a hidden cut inside an original indexed shot',()=>{
  const shot={id:'s',sourceId:'v',start:0,end:10,anchor:5,motion:1,semanticStatus:'complete',cues:[],semantic:{actions:[],audio_events:[],usable_quality:1},safeRanges:[{start:.12,end:2.4,anchor:1},{start:3,end:5,anchor:4}]};
  assert.equal(makeCandidates({start:0,end:3,accent:1,energy:1,preferred:[]},[shot]).length,0);
  const [candidate]=makeCandidates({start:0,end:.5,accent:.25,energy:1,preferred:[]},[shot]);
  assert.ok(shot.safeRanges.some(r=>candidate.sourceIn>=r.start&&candidate.sourceOut<=r.end));
});
test('export validation protects the refined source interval',()=>{
  const library={music:[{id:'m',duration:5}],sources:[{id:'v',duration:20}]};
  const clip={id:'c',sourceId:'v',start:0,end:2,sourceIn:10,rate:1,gain:0,effect:'none',safety:{start:10,end:11.8}};
  assert.throws(()=>validateProject({musicId:'m',duration:3,clips:[clip],musicGain:.7},library),/安全镜头/);
});
