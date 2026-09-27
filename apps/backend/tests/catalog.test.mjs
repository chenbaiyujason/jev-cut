import test from 'node:test';
import assert from 'node:assert/strict';
import {chunksForSource,normalizeSemantics,validateSemantics,applyChunk} from '../catalog.mjs';
import {balancedCandidates,lexicalScore} from '../retrieval.mjs';
import {validatePlan,slotsFromPlan} from '../planning.mjs';
import {makeCandidates,transitionAllowed} from '../sequence.mjs';
import {validateMusicIntent} from '../music-intent.mjs';

test('music-first analysis works without a user screenplay and rejects invented out-of-range sections',()=>{
  const intent={summary:'稳定鼓点与暗色合成器',edit_direction:'让步伐与鼓点对应',retrieval_queries:['夜景 人物奔跑'],sections:[{start:0,end:30,energy:.7,heard:'稳定节拍'}],suggested_intensity:.7,dialogue_suitability:.2};
  assert.equal(validateMusicIntent(intent,30),intent);
  assert.throws(()=>validateMusicIntent({...intent,sections:[{start:0,end:40,energy:.5}]},30),/时间/);
  assert.throws(()=>validateMusicIntent({...intent,retrieval_queries:[]},30),/选片/);
});

const chunk={id:'ep1-0',start:98.5,end:107.5,shots:[{id:'a',start:100,end:103,cues:[]},{id:'b',start:103,end:106,cues:[]}]};
const semantic=()=>({scenes:[{id:'scene',start_seconds:0,end_seconds:9}],shots:[0,1].map(i=>({id:'s'+i,summary:'少女转身举起武器',subjects:['黑发少女'],usable_quality:.9,scene_id:'scene',actions:[],audio_events:[],uncertainties:[],visual_motifs:[],dialogue_meaning_zh:''}))});

test('chunking covers every detected shot exactly once without splitting a long shot',()=>{
  const source={episode:1,duration:180,shots:[{id:'a',start:0,end:20},{id:'b',start:20,end:150},{id:'c',start:150,end:180}]};
  const chunks=chunksForSource(source,{seconds:90,maxShots:24});
  assert.deepEqual(chunks.flatMap(c=>c.shots.map(s=>s.id)),['a','b','c']);
  assert.equal(chunks[1].shots[0].end,150);
  assert.equal(chunks[0].start,0);assert.equal(chunks.at(-1).end,180);
});

test('unknown, duplicate and missing model shot IDs never enter the catalog',()=>{
  const raw=semantic();assert.equal(validateSemantics(raw,chunk),raw);
  for(const ids of [['s0','s0'],['s0','s2'],['s0']]){
    const bad=semantic();bad.shots=ids.map(id=>({...bad.shots[0],id}));
    assert.throws(()=>validateSemantics(bad,chunk),/ID|覆盖/);
  }
});

test('out-of-shot model action peaks are discarded, not promoted to precise beat anchors',()=>{
  const raw=semantic();raw.shots[0].actions=[{action:'跳跃',start_seconds:0,end_seconds:3,peak_seconds:2,confidence:.9}];
  const normalized=normalizeSemantics(raw,chunk);
  assert.equal(normalized.result.shots[0].actions.length,0);assert.equal(normalized.warnings.length,1);
  assert.equal(raw.shots[0].actions.length,1,'keep raw response for audit');
  assert.equal(normalized.result.scenes[0].start_seconds,1.5);
  assert.equal(normalized.result.scenes[0].end_seconds,7.5);
  const source={episode:1,shots:structuredClone(chunk.shots)};
  applyChunk(source,{...chunk,shots:source.shots},{result:normalized.result,model:'test'});
  assert.equal(source.shots[0].anchor,undefined);
});

test('valid action timestamps become absolute source times once',()=>{
  const raw=semantic();raw.shots[0].actions=[{action:'抬手',start_seconds:2,end_seconds:4,peak_seconds:3,confidence:.9}];
  const result=validateSemantics(normalizeSemantics(raw,chunk).result,chunk);
  const source={episode:1,shots:structuredClone(chunk.shots)};
  applyChunk(source,{...chunk,shots:source.shots},{result,model:'test'});
  assert.equal(source.shots[0].anchor,101.5);
  assert.equal(source.shots[0].semantic.actions[0].start,100.5);
});

test('balanced recall cannot be monopolized by early episode results',()=>{
  const ranked=Array.from({length:11},(_,i)=>Array.from({length:100},(_,j)=>({episode:i+1,id:`${i}-${j}`}))).flat();
  const result=balancedCandidates(ranked);
  assert.equal(result.length,132);assert.equal(new Set(result.map(s=>s.episode)).size,11);
  assert.ok(lexicalScore({document:'黑发少女说 契約して 魔法少女になってよ'},'契約して')>0);
});

test('music plans reject unsupported footage and coverage gaps',()=>{
  const times=[0,1,2,3,4],plan={sections:[{from_beat:0,to_beat:4,energy:.5,cut_pattern:[2],preferred_shots:['a']}]};
  assert.equal(validatePlan(plan,times,new Set(['a'])),plan);
  assert.throws(()=>validatePlan(plan,times,new Set(['b'])),/不存在/);
  assert.throws(()=>validatePlan({sections:[{...plan.sections[0],from_beat:1}]},times,new Set(['a'])),/连续/);
});

test('locked clips survive beat planning exactly while other regions remain covered',()=>{
  const plan={beatTimes:[0,1,2,3,4,5,6],sections:[{from_beat:0,to_beat:6,cut_pattern:[2],energy:.5,preferred_shots:[]}]};
  const lock={id:'lock',start:1.4,end:3.3,locked:true};
  const slots=slotsFromPlan(plan,{accents:[]},6,[lock]);
  assert.deepEqual(slots.find(s=>s.lockedClip).lockedClip,lock);
  assert.equal(slots[0].start,0);assert.equal(slots.at(-1).end,6);
  for(let i=1;i<slots.length;i++)assert.equal(slots[i-1].end,slots[i].start);
});

test('sequence allows chronological continuation but rejects reversal, overlap and later scene reuse',()=>{
  const first={id:'1',shotId:'a',sourceId:'v',sceneId:'scene',sourceIn:10,start:0,end:2,rate:1};
  const next={shot:{id:'b',sourceId:'v',sceneId:'scene'},sourceIn:12,sourceOut:14};
  assert.equal(transitionAllowed([first],next),true);
  assert.equal(transitionAllowed([first],{...next,sourceIn:9,sourceOut:11}),false);
  assert.equal(transitionAllowed([first],{...next,shot:{...next.shot,id:'a'}}),false);
  const other={...first,id:'2',shotId:'c',sourceId:'other'};
  assert.equal(transitionAllowed([first,other],next),false);
  const second={...first,id:'2',shotId:'b',sourceIn:12,start:2,end:4};
  assert.equal(transitionAllowed([first,second],{shot:{id:'c',sourceId:'v',sceneId:'scene'},sourceIn:14,sourceOut:16}),true);
});

test('source SFX is eligible only when the full audible event is inside the edit and avoids dialogue',()=>{
  const slot={start:0,end:2,accent:1,energy:.8,preferred:[]};
  const shot={id:'s',sourceId:'v',episode:2,start:10,end:14,anchor:11,motion:.8,semanticStatus:'complete',cues:[],semantic:{usable_quality:.9,actions:[],audio_events:[{start:10.7,end:11.3,type:'音效',description:'枪响'}]}};
  const [candidate]=makeCandidates(slot,[shot],{keepDialogue:false});
  assert.equal(candidate.sfx.description,'枪响');
  assert.ok(candidate.sourceIn>=10&&candidate.sourceOut<=14);
  const [speech]=makeCandidates(slot,[{...shot,cues:[{start:10.5,end:12,text:'小圆 我会保护你'}]}],{keepDialogue:false});
  assert.equal(speech.sfx,undefined);
});
