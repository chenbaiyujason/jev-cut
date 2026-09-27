import test from 'node:test';
import assert from 'node:assert/strict';
import {migrateLegacyProject,validateStudioProject,gainDb} from '../studio-project.mjs';

test('migration preserves repeats as separate instances and separates source audio',()=>{
  const source={id:'v',episode:1,kind:'video',fps:'24/1',duration:100};
  const a={id:'a',sourceId:'v',shotId:'same',start:0,end:1,sourceIn:10,rate:1,gain:.5,audioWindow:{start:10.2,end:10.7},title:'A'};
  const l={sources:[source],music:[{id:'m',name:'song',duration:10}],project:{musicId:'m',duration:2,musicGain:.7,clips:[a,{...a,id:'b',start:1,end:2,gain:0}]}};
  const p=migrateLegacyProject(l),v=p.timeline.items.filter(x=>x.type==='video');
  assert.equal(v.length,2);assert.equal(v[0].sourceStart,240);assert.equal(v[1].from,30);assert.equal(v[0].volume,-60);
  const audio=p.timeline.items.find(x=>x.id==='sound-a');assert.equal(audio.from,6);assert.equal(audio.durationInFrames,15);
  assert.equal(validateStudioProject(p),p);assert.equal(gainDb(0),-60);assert.equal(gainDb(1),0);
});
test('project validation rejects duplicate occurrences, fractional frames and expressions',()=>{
  const item={id:'a',type:'text',from:0,durationInFrames:10};const p={id:'mad-main',metadata:{fps:30},timeline:{tracks:[],items:[item]}};
  assert.throws(()=>validateStudioProject({...p,timeline:{...p.timeline,items:[item,item]}}),/唯一/);
  assert.throws(()=>validateStudioProject({...p,timeline:{...p.timeline,items:[{...item,from:.5}]}}),/整数/);
  assert.throws(()=>validateStudioProject({...p,timeline:{...p.timeline,items:[{...item,expressions:['bad']}]}}),/表达式/);
});
