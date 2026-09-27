import test from 'node:test';
import assert from 'node:assert/strict';
import {filterRepeatedSequences} from '../repeated-sequences.mjs';

test('cross-episode ED copies are excluded even though source and shot IDs differ',()=>{
  const sources=[2,3,7].map(episode=>({id:'ep'+episode,shots:[
    {id:'ed'+episode,start:1391,end:1393,excluded:false},
    {id:'body'+episode,start:400,end:402,excluded:false},
  ]}));
  const metadata={sources:Object.fromEntries(sources.map(s=>[s.id,{intervals:[{start:1380,end:1420}]}]))};
  const result=filterRepeatedSequences(sources,metadata);
  assert.equal(result.excluded,3);
  for(const source of result.sources){assert.equal(source.shots[0].excluded,true);assert.equal(source.shots[1].excluded,false);}
  assert.equal(sources[0].shots[0].excluded,false);
});

test('OP/ED scenes stay out; composite cuts and low quality remain indexed for review',()=>{
  const source={id:'a',scenes:[{start:90,end:100,narrative_role:'片尾ED动画',summary:''}],shots:[
    {id:'credits',start:92,end:94},
    {id:'composite',start:10,end:12,semantic:{uncertainties:['镜头内部存在极其快速的抽帧和部件切换']}},
    {id:'action',start:20,end:23,excluded:true,semantic:{usable_quality:.2}},
  ]};
  const result=filterRepeatedSequences([source],{sources:{}});
  assert.deepEqual(result.sources[0].shots.filter(s=>s.excluded).map(s=>s.id),['credits']);
  assert.equal(result.sources[0].shots[1].needsBoundaryReview,true);
  assert.equal(result.sources[0].shots[2].qualityFlags.lowQuality,true);
  assert.equal(result.sources[0].shots[2].excluded,false);
});

test('partial OP/ED overlap preserves the ordinary footage and records only the repeated band',()=>{
  const source={id:'a',shots:[{id:'boundary',start:85,end:95,excluded:false}]};
  const result=filterRepeatedSequences([source],{sources:{a:{intervals:[{start:90,end:100},{start:91,end:100}]}}});
  assert.equal(result.sources[0].shots[0].excluded,false);
  assert.deepEqual(result.sources[0].shots[0].repeatedBands,[{start:90,end:95}]);
});
