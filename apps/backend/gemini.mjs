import {readFile,writeFile,appendFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const root=path.dirname(fileURLToPath(import.meta.url));
export async function configuration(){
  const values={};
  try{for(const line of (await readFile(path.join(root,'localdevenv/.env'),'utf8')).split(/\r?\n/)){const i=line.indexOf('=');if(i>0&&!line.trim().startsWith('#'))values[line.slice(0,i).trim()]=line.slice(i+1).trim();}}catch{}
  // Explicit task-local configuration takes precedence over unrelated global keys.
  return {...process.env,...values};
}
export async function geminiRequest(method,body,{timeoutMs=180000,retries=2}={}){
  const config=await configuration(),key=config.GEMINI_API_KEY;
  if(!key)throw Error('请在 localdevenv/.env 配置 GEMINI_API_KEY');
  const base=config.GEMINI_BASE_URL||'https://generativelanguage.googleapis.com/v1beta';
  for(let attempt=0;;attempt++){
    const started=performance.now();
    let response,data;
    try{
      response=await fetch(`${base}/${method}`,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':key},body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
      data=await response.json();
    }catch(error){
      const dir=path.join(root,'.local/gemini');await mkdir(dir,{recursive:true});
      await appendFile(path.join(dir,'request-errors.jsonl'),JSON.stringify({at:new Date().toISOString(),endpoint:method,attempt:attempt+1,outcome:'response-not-received; usage-unknown',code:error.cause?.code||error.name})+'\n');
      if(attempt<retries){await new Promise(r=>setTimeout(r,2000*2**attempt));continue;}
      throw Error(`Gemini 网络请求失败 (${error.cause?.code||error.name})，已保留已完成结果`);
    }
    if(response.ok){
      const metrics={at:new Date().toISOString(),endpoint:method,ms:performance.now()-started,usage:data.usageMetadata||null};
      const dir=path.join(root,'.local/gemini');await mkdir(dir,{recursive:true});await appendFile(path.join(dir,'usage.jsonl'),JSON.stringify(metrics)+'\n');
      return {data,metrics};
    }
    if([429,500,502,503,504].includes(response.status)&&attempt<retries){await new Promise(r=>setTimeout(r,Math.min(15000,2000*2**attempt)));continue;}
    const message=String(data.error?.message||response.statusText).replaceAll(key,'[redacted]');
    throw Error(`Gemini HTTP ${response.status}: ${message.slice(0,1200)}`);
  }
}
export async function understand(parts,{schema,maxTokens=8192,cacheKey,thinkingLevel='LOW'}={}){
  const config=await configuration(),model=config.GEMINI_MODEL||'gemini-3.8-flash';
  thinkingLevel=String(thinkingLevel).toUpperCase();
  if(!['LOW','MEDIUM','HIGH'].includes(thinkingLevel))throw Error('Gemini thinkingLevel must be LOW, MEDIUM, or HIGH');
  // Gemini 3 recommends temperature 1; output shape is controlled by responseSchema.
  const body={contents:[{role:'user',parts}],generationConfig:{temperature:1,maxOutputTokens:maxTokens,responseMimeType:'application/json',thinkingConfig:{thinkingLevel}}};
  if(schema)body.generationConfig.responseSchema=schema;
  const hash=createHash('sha256').update(JSON.stringify({model,body,cacheKey})).digest('hex');
  const file=path.join(root,'.local/gemini/cache',hash+'.json');
  try{return {...JSON.parse(await readFile(file,'utf8')),cached:true};}catch{}
  const {data,metrics}=await geminiRequest(`models/${model}:generateContent`,body);
  const candidate=data.candidates?.[0];
  if(candidate?.finishReason!=='STOP')throw Error(`Gemini output incomplete (${candidate?.finishReason||data.promptFeedback?.blockReason||'no candidate'})`);
  const text=(candidate.content?.parts||[]).filter(p=>!p.thought).map(p=>p.text||'').join('');
  let result;try{result=JSON.parse(text);}catch{throw Error('Gemini 未返回有效 JSON，未写入语义索引');}
  const record={result,metrics,model,responseId:data.responseId,createdAt:new Date().toISOString()};
  await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(record,null,2));
  return record;
}
export async function videoPart(file,fps=4){return {inlineData:{mimeType:'video/mp4',data:(await readFile(file)).toString('base64')},videoMetadata:{fps}};}
export async function embed(parts,{taskType='RETRIEVAL_DOCUMENT',model}={}){
  const config=await configuration();model??=config.GEMINI_EMBEDDING_MODEL||'gemini-embedding-2';
  const {data,metrics}=await geminiRequest(`models/${model}:embedContent`,{model:`models/${model}`,content:{parts},taskType,outputDimensionality:768},{timeoutMs:90000});
  const vector=data.embedding?.values;if(!Array.isArray(vector)||vector.length!==768||vector.some(x=>!Number.isFinite(x)))throw Error('Embedding 返回无效向量');
  const norm=Math.hypot(...vector);return {vector:vector.map(x=>x/Math.max(norm,1e-12)),metrics,model};
}
export async function embedBatch(contents){
  const config=await configuration(),model=config.GEMINI_EMBEDDING_MODEL||'gemini-embedding-2';
  const {data,metrics}=await geminiRequest(`models/${model}:batchEmbedContents`,{requests:contents.map(parts=>({model:`models/${model}`,content:{parts},taskType:'RETRIEVAL_DOCUMENT',outputDimensionality:768}))},{timeoutMs:180000});
  if(!Array.isArray(data.embeddings)||data.embeddings.length!==contents.length)throw Error('批量 Embedding 数量不匹配');
  const vectors=data.embeddings.map(e=>{if(!Array.isArray(e.values)||e.values.length!==768||e.values.some(x=>!Number.isFinite(x)))throw Error('批量 Embedding 向量无效');const norm=Math.hypot(...e.values);return e.values.map(x=>x/Math.max(norm,1e-12));});
  return {vectors,metrics,model};
}
