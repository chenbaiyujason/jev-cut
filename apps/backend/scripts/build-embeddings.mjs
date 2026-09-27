import {readFile,writeFile,mkdir,readdir,rename} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {embedBatch,configuration} from '../gemini.mjs';
import {catalogRoot,atomicJson} from '../catalog.mjs';
import {filterRepeatedSequences} from '../repeated-sequences.mjs';

const watch=process.argv.includes('--watch'),config=await configuration(),model=config.GEMINI_EMBEDDING_MODEL||'gemini-embedding-2';
const done=new Map();
const duplicateMetadata=JSON.parse(await readFile(path.join(catalogRoot,'repeated-sequences.json'),'utf8'));
await mkdir(catalogRoot,{recursive:true});
async function saveIndex(){
  const rows=[...done.values()].flatMap(x=>x.rows);const values=new Float32Array(rows.length*768);
  rows.forEach((r,i)=>values.set(r.vector,i*768));
  const bytes=Buffer.from(values.buffer),vectorFile='vectors-'+createHash('sha256').update(bytes).digest('hex').slice(0,16)+'.f32';
  const file=path.join(catalogRoot,vectorFile);await writeFile(file+'.tmp',bytes);await rename(file+'.tmp',file);
  await atomicJson(path.join(catalogRoot,'vector-index.json'),{model,dimensions:768,vectorFile,modality:'text+image',sourceCount:done.size,updatedAt:new Date().toISOString(),entries:rows.map(({vector,...r})=>r)});
}
for(;;){
  for(const directory of (await readdir(catalogRoot)).filter(n=>/^episode-\d+$/.test(n)).sort()){
    let source;try{source=JSON.parse(await readFile(path.join(catalogRoot,directory,'enriched.json'),'utf8'));}catch{continue;}
    try{const prepared=JSON.parse(await readFile(path.join(catalogRoot,directory,'source.json'),'utf8'));source.thumbVersion=prepared.thumbVersion;}catch{}
    if(source.semanticStatus!=='complete'||source.thumbVersion!==2||done.has(source.id))continue;
    source=filterRepeatedSequences([source],duplicateMetadata).sources[0];
    const file=path.join(catalogRoot,directory,'embeddings.json');let cached={rows:[]};
    try{const old=JSON.parse(await readFile(file,'utf8'));if(old.model===model)cached=old;}catch{}
    const rows=[],todo=[];const known=new Map(cached.rows.map(r=>[r.id,r]));
    for(const shot of source.shots){
      if(shot.excluded)continue;
      const image=await readFile(path.join(source.dir,shot.thumb));
      const text=shot.document||shot.description;const hash=createHash('sha256').update(model).update(text).update(image).digest('hex');
      const old=known.get(shot.id);if(old?.hash===hash){rows.push(old);continue;}
      todo.push({shot,hash,parts:[{text},{inlineData:{mimeType:'image/jpeg',data:image.toString('base64')}}]});
    }
    for(let offset=0;offset<todo.length;offset+=16){
      const batch=todo.slice(offset,offset+16);const result=await embedBatch(batch.map(r=>r.parts));
      batch.forEach((r,i)=>rows.push({id:r.shot.id,sourceId:source.id,episode:source.episode,hash:r.hash,vector:result.vectors[i]}));
      await atomicJson(file,{model,dimensions:768,rows});
      const status={stage:'多模态 Embedding',episode:source.episode,completed:Math.min(offset+16,todo.length),pending:todo.length,completedEpisodes:done.size,at:new Date().toISOString()};
      await atomicJson(path.join(catalogRoot,'embedding-status.json'),status);console.log(JSON.stringify(status));
    }
    done.set(source.id,{rows});
  }
  if(done.size>=11||!watch)break;
  await new Promise(r=>setTimeout(r,5000));
}
// Do not replace a complete searchable index with a partially refreshed one.
if(done.size>=11)await saveIndex();
await atomicJson(path.join(catalogRoot,'embedding-status.json'),{stage:done.size>=11?'Embedding 完成':'等待全库完成，保留已有索引',completedEpisodes:done.size,at:new Date().toISOString()});
