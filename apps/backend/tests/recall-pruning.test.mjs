import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeRecallLanes,pruneDecisionCandidates} from '../recall-pruning.mjs';
test('multi-lane recall retains evidence without requiring a narrative role or episode quota',()=>{
 const a={id:'a',episode:1},b={id:'b',episode:1};const pool=mergeRecallLanes([{name:'emotion',shots:[a,b]},{name:'sound',shots:[b]}]);
 assert.equal(pool[0].id,'b');assert.equal(pool[0].recallEvidence.length,2);assert.equal(pool.length,2);assert.equal(a.recallScore,undefined);
});
test('temporary pruning separates near-identical scene choices but allows intentional reuse and continuation',()=>{
 const candidates=[{id:'a',sourceId:'ep1',sceneId:'scene1',start:10,recallScore:1},{id:'b',sourceId:'ep1',sceneId:'scene1',start:11,recallScore:.99},{id:'c',sourceId:'ep4',sceneId:'scene2',start:300,recallScore:.95}];
 assert.deepEqual(pruneDecisionCandidates(candidates,{limit:2}).map(c=>c.id),['a','c']);
 assert.ok(!pruneDecisionCandidates(candidates,{recent:[candidates[0]]}).some(c=>c.id==='a'));
 assert.ok(pruneDecisionCandidates(candidates,{recent:[candidates[0]],allowReuse:['a']}).some(c=>c.id==='a'));
 assert.equal(candidates.length,3);
});
