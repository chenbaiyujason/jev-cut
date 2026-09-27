import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {configuration} from './gemini.mjs';
import {queryVector as encodeQuery} from './query-vectors.mjs';
import {catalogRoot} from './catalog.mjs';
let loadedIndex=null,indexLoading;const searchCache=new WeakMap();
async function loadIndex(){
  if(indexLoading)return indexLoading;
  indexLoading=readIndex();try{return await indexLoading;}finally{indexLoading=null;}
}
async function readIndex(){
  try{
    const file=path.join(catalogRoot,'vector-index.json'),info=await stat(file);
    if(loadedIndex?.mtime===info.mtimeMs)return loadedIndex;
    const metadata=JSON.parse(await readFile(file,'utf8')),buffer=await readFile(path.join(catalogRoot,metadata.vectorFile||'vectors.f32'));
    const vectors=new Float32Array(buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength));
    if(vectors.length!==metadata.entries.length*metadata.dimensions)throw Error('向量索引尚未完成写入');
    loadedIndex={metadata,vectors,mtime:info.mtimeMs};return loadedIndex;
  }catch{return null;}
}
const normalize=s=>String(s||'').normalize('NFKC').toLowerCase();
export function lexicalScore(shot,query){
  const text=normalize(shot.document||[shot.description,...(shot.cues||[]).map(c=>c.text)].join(' '));
  const q=normalize(query),words=q.match(/[a-z0-9]+|[\u3040-\u30ff\u3400-\u9fff]{2,}/g)||[];
  let score=0;
  for(const word of words){if(text.includes(word))score+=3;for(let i=0;i<word.length-1;i++)if(text.includes(word.slice(i,i+2)))score+=.15;}
  return score;
}
export function balancedCandidates(ranked,{perEpisode=12,total=132}={}){
  const count=new Map(),out=[];
  for(const row of ranked){const ep=row.episode??row.sourceId,n=count.get(ep)||0;if(n>=perEpisode)continue;out.push(row);count.set(ep,n+1);if(out.length>=total)break;}
  return out;
}
export async function retrieve(library,query,{episodeIds,perEpisode=12,limit=132,contextShotIds=[]}={}){
  // Only the immutable authoritative corpus facade is memoized. Mutable legacy libraries are not.
  let cached=!episodeIds?.length&&Object.isFrozen(library)?searchCache.get(library):null;
  let shots=cached?.shots||library.sources.filter(s=>!episodeIds?.length||episodeIds.includes(s.episode)).flatMap(s=>s.shots.map(shot=>({...shot,episode:s.episode,sourceName:s.name}))).filter(s=>!s.excluded&&s.semanticStatus==='complete');
  if(!cached&&!episodeIds?.length&&Object.isFrozen(library)){cached={shots,lex:new Map()};searchCache.set(library,cached);}
  if(!shots.length)throw Error('尚无完成 Gemini 理解的镜头，请先建立全库索引');
  const lex=cached?.lex.get(query)||shots.map(shot=>({shot,score:lexicalScore(shot,query)})).sort((a,b)=>b.score-a.score),ranks=new Map(lex.map((r,i)=>[r.shot.id,{lexical:i+1}]));
  if(cached){cached.lex.set(query,lex);while(cached.lex.size>24)cached.lex.delete(cached.lex.keys().next().value);}
  const index=await loadIndex();let method='lexical',warning=null,queryEncoding;
  const config=await configuration();
  if(index&&config.MAD_EMBEDDING_ENABLED!=='false'){
    try{
      const model=config.GEMINI_EMBEDDING_MODEL||'gemini-embedding-2';
      if(index.metadata.model!==model)throw Error('Embedding 模型与现有索引不一致，需要重建');
      const encoded=await encodeQuery(query,{model,dimensions:index.metadata.dimensions});let queryVector=encoded.vector;queryEncoding={source:encoded.source,ms:encoded.ms};
      const valid=new Set(shots.map(s=>s.id)),scores=[],dimensions=index.metadata.dimensions;
      if(queryVector.length!==dimensions||queryVector.some(x=>!Number.isFinite(x)))throw Error('查询向量维度或数值无效');
      if(contextShotIds.length){const seeds=index.metadata.entries.map((e,i)=>contextShotIds.includes(e.id)?i:-1).filter(i=>i>=0);if(seeds.length){queryVector=queryVector.map((v,j)=>.85*v+.15*seeds.reduce((n,i)=>n+index.vectors[i*dimensions+j],0)/seeds.length);const norm=Math.hypot(...queryVector);queryVector=queryVector.map(v=>v/norm);}}
      index.metadata.entries.forEach((entry,i)=>{if(!valid.has(entry.id))return;let similarity=0;const offset=i*dimensions;for(let j=0;j<dimensions;j++)similarity+=queryVector[j]*index.vectors[offset+j];scores.push({id:entry.id,similarity});});
      scores.sort((a,b)=>b.similarity-a.similarity).forEach((s,i)=>Object.assign(ranks.get(s.id),{dense:i+1,similarity:s.similarity}));method='multimodal-embedding+lexical';
    }catch(e){warning=e.message;method='lexical-fallback';}
  }
  shots=shots.map(s=>{const rank=ranks.get(s.id);return {...s,retrievalScore:1/(60+rank.lexical)+(rank.dense?1.5/(60+rank.dense):0),embeddingSimilarity:rank.similarity};}).sort((a,b)=>b.retrievalScore-a.retrievalScore);
  return {shots:balancedCandidates(shots,{perEpisode,total:limit}),method,warning,queryEncoding,totalEligible:shots.length,episodesSearched:[...new Set(shots.map(s=>s.episode))]};
}
