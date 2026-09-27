import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {decide,validateDecision} from '../apps/backend/decision-provider.mjs';
import {emptyProject,expectedSourceCount} from '../apps/backend/release-runtime.mjs';
const body={state:{goal:'test'},questions:{pick:{type:'choice',criteria:{a:null,b:null}},fit:{type:'score',criteria:['no','yes']}}};
test('provider validation rejects invented candidate IDs and score ranges',()=>{
 assert.throws(()=>validateDecision(body,{answers:{pick:{choice:'c'},fit:{score:1}}}),/候选/);
 assert.throws(()=>validateDecision(body,{answers:{pick:{choice:'a'},fit:{score:2}}}),/评分/);
 assert.throws(()=>validateDecision(body,{answers:{pick:{choice:'a'}}}),/缺少/);
 assert.equal(validateDecision(body,{answers:{pick:{choice:'a'},fit:{score:.7}}}).answers.fit.score,.7);
});
test('compatible jev endpoint receives model routing, returns actual result without invented probabilities',async()=>{
 let received;const server=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);received=JSON.parse(Buffer.concat(chunks));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({model:'test-compatible-jev',answers:{pick:{choice:'b'},fit:{score:.8}}}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const old={url:process.env.JEV_DECISION_URL,model:process.env.JEV_MODEL};process.env.JEV_DECISION_URL='http://127.0.0.1:'+server.address().port;process.env.JEV_MODEL='requested-test-model';
 try{const result=await decide(body);assert.equal(received.model,'requested-test-model');assert.equal(result.result.model,'test-compatible-jev');assert.equal(result.result.answers.pick.choice,'b');assert.equal(result.result.answers.pick.probabilities,undefined);}finally{for(const [key,value]of [['JEV_DECISION_URL',old.url],['JEV_MODEL',old.model]])if(value===undefined)delete process.env[key];else process.env[key]=value;await new Promise(r=>server.close(r));}
});
test('fresh clone can create an empty editable project without local media',()=>{const p=emptyProject();assert.equal(p.id,'mad-main');assert.deepEqual(p.timeline.items,[]);assert.equal(p.timeline.tracks.length,4);assert.equal(expectedSourceCount({sources:[{},{}]}),2);});
