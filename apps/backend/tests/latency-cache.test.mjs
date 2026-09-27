import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createQueryVectors} from '../query-vectors.mjs';
import {semanticKey,semanticMusicContext} from '../semantic-decision-cache.mjs';
import {createWindowEvidence} from '../global-evidence.mjs';
import {resolveVisionSetting} from '../decision-settings.mjs';
test('vision defaults off; explicit false wins over saved and environment settings',()=>{
 assert.equal(resolveVisionSetting(),false);assert.equal(resolveVisionSetting({environment:'true'}),true);
 assert.equal(resolveVisionSetting({saved:false,environment:'true'}),false);assert.equal(resolveVisionSetting({override:false,saved:true}),false);assert.equal(resolveVisionSetting({override:true,saved:false}),true);
});

async function temp(t){const dir=await mkdtemp(path.join(os.tmpdir(),'mad-cache-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('two cold recall lanes share one text embedding; failures remain retryable',async t=>{
 const directory=await temp(t);let calls=0;
 const query=createQueryVectors({directory,encode:async(parts,options)=>{calls++;assert.deepEqual(parts,[{text:'新的拯救主题'}]);assert.equal(options.taskType,'RETRIEVAL_QUERY');await new Promise(r=>setTimeout(r,5));return {vector:[1,0]};}});
 const results=await Promise.all(Array.from({length:4},()=>query('新的拯救主题',{dimensions:2})));
 assert.equal(calls,1);assert.equal(results.filter(r=>r.source==='network').length,1);assert.equal(results.filter(r=>r.source==='in-flight').length,3);
 assert.throws(()=>{results[0].vector[0]=.85;},TypeError);
 const disk=createQueryVectors({directory,encode:()=>{throw Error('should use disk');}});assert.equal((await disk('新的拯救主题',{dimensions:2})).source,'disk');
 let attempts=0;const retry=createQueryVectors({directory,encode:async()=>{if(++attempts===1)throw Error('temporary');return {vector:[0,1]};}});
 const failed=await Promise.allSettled([retry('retry',{dimensions:2}),retry('retry',{dimensions:2})]);assert.ok(failed.every(r=>r.status==='rejected'));assert.equal(attempts,1);await retry('retry',{dimensions:2});assert.equal(attempts,2);
});
test('basic fit reuses a music section while changed theme, music or asset invalidates it',()=>{
 const base={goal:'拯救',prompt:'',intent:'守护',shot:{id:'s',description:'伸手',semantic:{dialogue_meaning_zh:'别放弃'}},musicContext:{id:'song-v1',summary:'悲伤',sections:[{start:0,end:4,emotion:'悲伤'}],sourceRange:[0,1]}};
 const key=semanticKey(base);assert.equal(key,semanticKey({...base,musicContext:{...base.musicContext,sourceRange:[2,3]}}));
 assert.equal(semanticMusicContext(base.musicContext).sourceRange,undefined);
 for(const patch of [{goal:'战斗'},{prompt:'快乐'},{intent:'失败'},{model:'new-model'},{shot:{...base.shot,description:'挥手告别'}},{musicContext:{...base.musicContext,id:'song-v2'}},{musicContext:{...base.musicContext,sections:[{start:4,end:8,emotion:'爆发'}]}}])assert.notEqual(key,semanticKey({...base,...patch}));
});
test('exact-window evidence shares concurrent work, preserving order and source invalidation',async t=>{
 const directory=await temp(t),source=path.join(directory,'source');await mkdir(source);await writeFile(path.join(source,'edit-preview-v2.mp4'),'fake-proxy');let tasks=0;
 const evidence=createWindowEvidence({folder:path.join(directory,'images'),runTasks:async batch=>{tasks+=batch.length;await new Promise(r=>setTimeout(r,5));await Promise.all(batch.map(b=>writeFile(b.output,JSON.stringify(b.frames))));}});
 const library={sources:[{id:'ep',dir:source}]},a={mediaId:'ep',sourceStart:10,sourceEnd:20},b={...a,sourceStart:20,sourceEnd:30};
 const [one,two]=await Promise.all([evidence([a,b],library),evidence([b,a],library)]);assert.equal(tasks,2);assert.equal(one[0].url,two[1].url);assert.equal(one[1].url,two[0].url);
 assert.equal(Buffer.from(one[0].data.split(',')[1],'base64').toString(),'[10,14,19]');
 await evidence([a],library);assert.equal(tasks,2);
 await writeFile(path.join(source,'edit-preview-v2.mp4'),'changed-proxy-content');const changed=await evidence([a],library);assert.equal(tasks,3);assert.notEqual(changed[0].url,one[0].url);
});
