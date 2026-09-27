import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {preparedSources,chunksForSource,enrichChunk,applyChunk,atomicJson,catalogRoot} from '../catalog.mjs';
import {configuration} from '../gemini.mjs';

const pilot=process.argv.includes('--pilot'),watch=process.argv.includes('--watch'),config=await configuration();
const limit=pilot?1:Number(config.MAD_GEMINI_CONCURRENCY||2),done=new Set();
await mkdir(catalogRoot,{recursive:true});
const state={stage:'准备 Gemini 索引',completedEpisodes:0,completedChunks:0,totalChunks:0,errors:[],usage:{input:0,output:0},startedAt:new Date().toISOString()};
let statusWrites=Promise.resolve(),lastPrinted=0;
async function publish(){const snapshot=structuredClone(state);statusWrites=statusWrites.then(()=>atomicJson(path.join(catalogRoot,'semantic-status.json'),snapshot));await statusWrites;if(Date.now()-lastPrinted>5000||/失败|完成|修复/.test(snapshot.stage)){console.log(JSON.stringify({...snapshot,errors:snapshot.errors.slice(-2)}));lastPrinted=Date.now();}}
async function sourceWork(source){
  const chunks=chunksForSource(source,{seconds:Number(config.MAD_GEMINI_CHUNK_SECONDS||90)});
  state.totalChunks+=pilot?1:chunks.length;await publish();
  const selected=pilot?[chunks.find(c=>c.start<1200&&c.end>1200)||chunks[0]]:chunks;
  let next=0;const records=[];
  const outcomes=await Promise.allSettled(Array.from({length:Math.min(limit,selected.length)},async()=>{
    while(next<selected.length){const chunk=selected[next++];state.stage=`Gemini 读取第 ${source.episode} 集 ${chunk.start.toFixed(0)}–${chunk.end.toFixed(0)} 秒`;await publish();
      const record=await enrichChunk(source,chunk,{pilot});records.push({chunk,record});state.completedChunks++;
      if(!record.cached){state.usage.input+=record.metrics.usage?.promptTokenCount||0;state.usage.output+=(record.metrics.usage?.candidatesTokenCount||0)+(record.metrics.usage?.thoughtsTokenCount||0);}await publish();
    }
  }));
  for(const {chunk,record} of records.sort((a,b)=>a.chunk.start-b.chunk.start))applyChunk(source,chunk,record);
  source.semanticStatus=pilot?'partial':source.shots.every(s=>s.semanticStatus==='complete')?'complete':'partial';
  await atomicJson(path.join(catalogRoot,`episode-${String(source.episode).padStart(2,'0')}`,pilot?'pilot-enriched.json':'enriched.json'),source);
  const failure=outcomes.find(o=>o.status==='rejected');
  if(failure)throw failure.reason;
  if(!pilot){done.add(source.episode);state.completedEpisodes=done.size;}
  await publish();
}
for(;;){
  const sources=await preparedSources();
  for(const source of sources){if(done.has(source.episode))continue;
    if(!pilot){try{const old=JSON.parse(await readFile(path.join(catalogRoot,`episode-${String(source.episode).padStart(2,'0')}`,'enriched.json'),'utf8'));if(old.semanticStatus==='complete'){done.add(source.episode);state.completedEpisodes=done.size;continue;}}catch{}}
    try{await sourceWork(source);}catch(e){state.errors.push({episode:source.episode,message:e.message});state.stage='分析失败，已保留缓存与进度';await publish();process.exitCode=1;break;}
    if(pilot)break;
  }
  if(process.exitCode||pilot||done.size>=11||!watch)break;
  await new Promise(r=>setTimeout(r,4000));
}
state.stage=process.exitCode?'需要修复后续跑':pilot?'小样本完成':done.size>=11?'11 集 Gemini 理解完成':'已准备素材理解完成';await publish();
