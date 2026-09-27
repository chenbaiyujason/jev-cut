import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {embed,configuration} from './gemini.mjs';
import {catalogRoot} from './catalog.mjs';

// Cache only the base text query, never a context-blended vector or candidate pool.
export function createQueryVectors({directory=path.join(catalogRoot,'query-cache'),encode=embed,maxEntries=256}={}){
  const memory=new Map(),pending=new Map();
  const valid=(v,n)=>Array.isArray(v)&&v.length===n&&v.every(Number.isFinite)&&Math.hypot(...v)>0;
  return async function queryVector(query,{model='gemini-embedding-2',dimensions=768}={}){
    const started=performance.now(),key=createHash('sha256').update(model+'\n'+query).digest('hex');
    const memoKey=key+':'+dimensions;
    const reply=(vector,source)=>({vector,source,ms:performance.now()-started});
    if(memory.has(memoKey)){const v=memory.get(memoKey);memory.delete(memoKey);memory.set(memoKey,v);return reply(v,'memory');}
    if(pending.has(memoKey))return reply((await pending.get(memoKey)).vector,'in-flight');
    const task=(async()=>{
      const file=path.join(directory,key+'.json');let vector,source='disk';
      try{vector=JSON.parse(await readFile(file,'utf8'));if(!valid(vector,dimensions))throw Error('Invalid cached vector');}
      catch{source='network';vector=(await encode([{text:query}],{taskType:'RETRIEVAL_QUERY',model})).vector;
        if(!valid(vector,dimensions))throw Error('查询向量维度或数值无效');
        await mkdir(directory,{recursive:true});const tmp=file+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(vector));await rename(tmp,file);
      }
      Object.freeze(vector);memory.set(memoKey,vector);while(memory.size>maxEntries)memory.delete(memory.keys().next().value);
      return {vector,source};
    })();pending.set(memoKey,task);
    try{const r=await task;return reply(r.vector,r.source);}finally{pending.delete(memoKey);}
  };
}
export const queryVector=createQueryVectors();
export function shotQuery({goal='',prompt='',intent=''}){return [...new Set([goal,prompt,intent].filter(Boolean))].join('；').slice(0,1600)||'根据当前音乐选择有表现力且人物关系清楚的动漫画面';}
export async function prefetchShotQuery(args){
  const config=await configuration();if(config.MAD_EMBEDDING_ENABLED==='false')return {skipped:true};
  return queryVector(shotQuery(args),{model:config.GEMINI_EMBEDDING_MODEL||'gemini-embedding-2'});
}
