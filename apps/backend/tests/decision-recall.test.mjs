import test from 'node:test';
import assert from 'node:assert/strict';
import {recallForDecision} from '../decision-recall.mjs';

const corpus={builtAt:'test',sources:[{id:'ep1'},{id:'ep11'}],shots:[
 {id:'a',sourceId:'ep1',episode:1,semanticStatus:'complete'},
 {id:'b',sourceId:'ep11',episode:11,semanticStatus:'complete'},
 {id:'ed',sourceId:'ep11',episode:11,semanticStatus:'complete',excluded:true},
]};
test('next decision can choose an episode/shot absent from every previous shortlist',async()=>{
 const searches=[];const deps={loadCorpus:async()=>corpus,search:async(library,query,options)=>{
   searches.push(library.sources.flatMap(s=>s.shots).filter(s=>!s.excluded).map(s=>s.id));
   assert.equal(options.episodeIds,undefined);assert.equal(options.perEpisode,Number.MAX_SAFE_INTEGER);
   return {shots:[corpus.shots[query==='first'?0:1]],totalEligible:2,episodesSearched:[1,11],method:'test'};
 }};
 const a=await recallForDecision({decisionId:'cut1',context:{previous:[]},queries:[{name:'theme',query:'first'}],limit:1},deps);
 const b=await recallForDecision({decisionId:'cut2',context:{previous:['a'],previousCandidates:['a']},queries:[{name:'action',query:'second'}],limit:1},deps);
 assert.deepEqual(searches,[['a','b'],['a','b']]);assert.equal(a.candidates[0].id,'a');assert.equal(b.candidates[0].id,'b');
 assert.equal(a.scope.scopeHash,b.scope.scopeHash);assert.notEqual(a.contextHash,b.contextHash);
});
test('silently narrowed search scope is rejected instead of masquerading as global recall',async()=>{
 await assert.rejects(()=>recallForDecision({decisionId:'cut',context:{},queries:[{name:'theme',query:'test'}]},{loadCorpus:async()=>corpus,search:async()=>({shots:[corpus.shots[0]],totalEligible:1,episodesSearched:[1]})}),/范围意外缩小/);
});
