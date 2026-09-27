import test from 'node:test';
import assert from 'node:assert/strict';
import {assembleCorpus} from '../corpus-cache.mjs';
test('full cache retains quiet, low quality, unknown-role and very short shots including duplicate records',()=>{
 const shots=[{id:'quiet',start:0,end:2,excluded:true,semantic:{usable_quality:.1},semanticStatus:'complete'},{id:'short',start:5,end:5.08,semanticStatus:'complete'},{id:'ed',start:90,end:95,semanticStatus:'complete'}];
 const corpus=assembleCorpus({sources:[{id:'ep',episode:1,shots}]},{duplicates:{sources:{ep:{intervals:[{start:90,end:100}]}}},vectors:{entries:[{id:'quiet'}]}});
 assert.equal(corpus.shots.length,3);assert.deepEqual(corpus.shots.filter(s=>!s.excluded).map(s=>s.id),['quiet','short']);assert.equal(corpus.stats.legacyExclusionsRecovered,1);
 assert.equal(corpus.shots[0].cacheState.boundaries,'pending');assert.equal(corpus.shots[0].cacheState.embedding,'ready');assert.equal(corpus.shots[1].cacheState.embedding,'pending');assert.equal(shots[0].excluded,true,'source remains untouched');
});
