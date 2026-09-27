import test from 'node:test';
import assert from 'node:assert/strict';
import {windowFacts,storyContext,connectionEvidence,continuationCandidates,actionWindowScore,candidateRejections,carryWindow} from '../story-continuity.mjs';
import {attachPhrases,validatePhrases} from '../music-phrases.mjs';
test('window evidence does not claim actions outside the actual source window',()=>{
 const shot={id:'a',description:'举枪然后开火',characters:['焰'],semantic:{actions:[{action:'举枪',start:0,end:1,confidence:.9},{action:'开火',start:2,end:3,peak:2.5,confidence:.9}]}};
 const facts=windowFacts(shot,{sourceStart:0,sourceEnd:24,sourceFps:24});assert.deepEqual(facts.actions.map(a=>a.action),['举枪']);
 assert.ok(actionWindowScore(shot,2,3,{accentFraction:.5})>actionWindowScore(shot,0,1));
});
test('forward same-scene continuation is evidence, never the next global pool',()=>{
 const shots=[{id:'a',sourceId:'ep',sceneId:'s',start:10,end:11,description:'举枪',characters:[],semanticStatus:'complete'},{id:'b',sourceId:'ep',sceneId:'s',start:11,end:12,description:'开火',characters:[],semanticStatus:'complete'},{id:'c',sourceId:'other',sceneId:'x',start:0,end:2,semanticStatus:'complete'}];
 const item={id:'now',type:'video',from:30},p={metadata:{fps:30},timeline:{items:[{id:'prev',type:'video',from:0,durationInFrames:30,sourceStart:240,sourceEnd:264,sourceFps:24,mad:{shotId:'a'}},item]}};
 const story=storyContext(p,item,shots);assert.deepEqual(continuationCandidates(shots,story,new Set(['a'])).map(s=>s.id),['b']);
 assert.equal(connectionEvidence(windowFacts(shots[1]),story).forwardInSource,true);assert.equal(shots.length,3);
});
test('phrase boundaries retain continuous timeline and do not create tiny cuts',()=>{
 const slots=Array.from({length:8},(_,i)=>({start:i*.5,end:(i+1)*.5}));
 const r=attachPhrases(slots,{phrases:[{start:0,end:4,breaks:[1.6],meaning:'保护',text:'test'}]},4);
 assert.equal(r.length,8);assert.equal(r[0].start,0);assert.equal(r.at(-1).end,4);
 r.forEach((s,i)=>{assert.ok(s.end-s.start>=.16);if(i)assert.equal(s.start,r[i-1].end);});
 assert.ok(r.some(s=>s.end===1.6));assert.ok(r.every(s=>s.phrase));
 assert.throws(()=>validatePhrases({phrases:[{start:1,end:2,breaks:[3]}]},4),/Invalid/);
});
test('credits stay in the library but are rejected for this insertion; explicit reprise can allow local reversal',()=>{
 const shot={id:'a',sourceId:'ep',sceneId:'s',end:10,semantic:{credits_or_logo:true}},story={history:[{sourceId:'ep',sceneId:'s',sourceRange:[12,13]}]};
 assert.deepEqual(candidateRejections(shot,story),['credits-or-logo','unmotivated-local-source-reversal']);
 assert.deepEqual(candidateRejections({...shot,semantic:{}},story,{repriseAllowed:true}),[]);assert.equal(shot.id,'a');
});
test('carrying an action uses fresh contiguous frames and never crosses a safe boundary',()=>{
 const prev={id:'p',from:0,durationInFrames:15,sourceStart:24,sourceEnd:36,sourceFps:24,mediaId:'ep',mad:{shotId:'s'}},item={id:'n',from:15,durationInFrames:15},project={metadata:{fps:30},timeline:{transitions:[]}},shot={id:'s',description:'挥枪',semantic:{actions:[{action:'挥枪',start:1,end:2,confidence:.9}]},safeRanges:[{startFrame:20,endFrame:60}]};
 const c=carryWindow(project,item,[prev],[shot]);assert.equal(c.item.sourceStart,36);assert.equal(c.item.sourceEnd,48);assert.equal(c.item.id,'n');
 assert.equal(carryWindow(project,item,[prev],[{...shot,safeRanges:[{startFrame:20,endFrame:44}]}]),null);
 assert.equal(carryWindow(project,item,[prev],[{...shot,semantic:{}}]),null);
});
