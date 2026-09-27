import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {neutralCandidateOrder,modelRankedCandidates,semanticPages,scoreSemanticPages,windowMenu,usageEvidence} from '../candidate-selection.mjs';
import {semanticKey} from '../semantic-decision-cache.mjs';
import {chooseGlobalShot} from '../global-director.mjs';

test('all eligible candidates reach jev, including an explicitly allowed low-RAG reprise without action tags',async()=>{
 const shots=Array.from({length:80},(_,n)=>({id:'s'+n,sourceId:'ep',episode:1,sceneId:'same-scene',description:'candidate-'+n,start:n*100/24,end:(n*100+80)/24,startFrame:n*100,endFrame:n*100+80,cacheState:{boundaries:'reviewed'},safeRanges:[{startFrame:n*100+5,endFrame:n*100+75}],semantic:{},characters:[],recallScore:80-n}));
 const previous={id:'previous',type:'video',trackId:'picture',from:0,durationInFrames:30,mediaId:'ep',src:'proxy',sourceStart:7905,sourceEnd:7929,sourceFps:24,speed:1,mad:{shotId:'s79'}};
 const item={id:'new',type:'video',trackId:'picture',from:30,durationInFrames:30,mediaId:'',sourceStart:0,sourceEnd:0,sourceFps:24,speed:1,mad:{requiresPhysicalAction:true,repriseAllowed:true}};
 const project={duration:2,metadata:{fps:30,width:960,height:540},timeline:{tracks:[{id:'picture'}],items:[previous,item],transitions:[],keyframes:[]}},before=structuredClone(project);
 const resources={shots,motion:Object.fromEntries(shots.map(s=>[s.id,{ranges:[{startFrame:s.startFrame+5,endFrame:s.startFrame+75,delta:Array(70).fill(2),brightness:Array(70).fill(100),detail:Array(70).fill(20)}]}]))};
 const requests=[],goal='coverage-test-'+randomUUID();
 const candidate=q=>JSON.parse(q.instructions.split('候选证据：')[1].split('\n')[0]);
 const options={project,item,resources,library:{sources:[{id:'ep',duration:1000,fps:24,episode:1}],music:[]},goal,allowKeep:false,visionEnabled:false,ask:async input=>{
  requests.push(input);return {ms:1,result:{answers:Object.fromEntries(Object.entries(input.questions).map(([id,q])=>[id,q.type==='choice'?{choice:input.state.candidates.find(c=>c.visual==='candidate-79')?.id||'c0'}:{score:candidate(q).visual==='candidate-79'?3:0}]))}};
 }};
 const dependencies={recall:async()=>({contextHash:'fixed-test-context',candidates:shots,lanes:[],scope:{eligible:80},ms:1}),prepare:async()=>{},evidence:async()=>{throw Error('text decision must not decode images');},events:async()=>({events:[]})};
 const result=await chooseGlobalShot(options,dependencies);
 const semantic=requests.filter(r=>!r.questions.pick),candidates=semantic.flatMap(r=>Object.values(r.questions).map(candidate));
 assert.equal(candidates.length,80);assert.equal(new Set(candidates.map(c=>c.visual)).size,80);
 const final=requests.find(r=>r.questions.pick);assert.equal(Object.keys(final.questions).length,1);
 assert.equal(final.state.candidates.find(c=>c.visual==='candidate-79').usage.count,1);
 assert.equal(result.trace.rounds[0].finalists[0].shotId,'s79');assert.equal(result.selected.shotId,'s79');
 assert.equal(result.trace.rounds[0].preModelRanking,'none');assert.deepEqual(project,before);
 assert.deepEqual(neutralCandidateOrder(shots,'seed').map(c=>c.id),neutralCandidateOrder([...shots].reverse(),'seed').map(c=>c.id));
 assert.equal(modelRankedCandidates([{id:'high-rag',recallScore:999,winnowScore:1},{id:'low-rag',recallScore:0,winnowScore:3}],{limit:1})[0].id,'low-rag');
 const changed=structuredClone(project);Object.assign(changed.timeline.items[0],{label:'changed previous',sourceStart:5,sourceEnd:29,mad:{shotId:'s0'}});
 const callCount=requests.length;
 const reused=await chooseGlobalShot({...options,project:changed},dependencies);
 assert.equal(reused.trace.rounds[0].semanticCache.hits,80);
 assert.equal(requests.length-callCount,1);
 assert.equal(requests.at(-1).state.candidates.find(c=>c.visual==='candidate-79').usage.count,0);
 assert.deepEqual(requests.at(-1).state.previous,['changed previous']);
});

test('token paging and server-overflow fallback never discard candidates; unrelated errors propagate',async()=>{
 const entries=Array.from({length:59},(_,id)=>({id,visual:'普通镜头'}));
 const request=page=>({state:{candidates:page},questions:{score:{type:'score',criteria:['差','好']}}});
 assert.equal(semanticPages(entries,request).length,1);
 const seen=[];
 await scoreSemanticPages(entries,{makeRequest:request,compare:async(_,body)=>{if(body.state.candidates.length>20)throw Error('maximum context exceeded');return body.state.candidates;},onScores:async(_,scores)=>seen.push(...scores.map(s=>s.id))});
 assert.deepEqual(seen,entries.map(s=>s.id));
 await assert.rejects(scoreSemanticPages(entries,{makeRequest:request,compare:async()=>{throw Error('service offline');},onScores:async()=>{}}),/offline/);
 const base={shot:{id:'s',description:'同一镜头'},decisionContext:{usage:{count:0}}};
 assert.notEqual(semanticKey(base),semanticKey({...base,decisionContext:{usage:{count:1}}}));
 const menu=windowMenu([{shotId:'a',duration:1},{shotId:'a',duration:2},{shotId:'b',duration:1}],{limit:2});
 assert.deepEqual(menu.map(c=>c.shotId),['a','b']);
});

test('replay evidence measures source-frame overlap without banning reuse or counting future frames',()=>{
 const make=(id,from,start,end)=>({id,type:'video',mediaId:'ep',from,durationInFrames:30,sourceStart:start,sourceEnd:end,sourceFps:24,mad:{shotId:id}});
 const project={metadata:{fps:30},timeline:{items:[make('a',0,0,24),make('alias',30,12,36),make('future',120,0,48)]}};
 const item=make('target',60,0,48),shot={id:'a',sourceId:'ep',start:0,end:2};
 const evidence=usageEvidence(shot,project,item,{},item);
 assert.equal(evidence.replayedFraction,.75);assert.equal(evidence.previousWindowOverlap,.5);
 assert.equal(usageEvidence(shot,project,item,{},make('next',60,36,48)).replayedFraction,0);
});
