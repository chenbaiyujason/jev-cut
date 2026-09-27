import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fullCorpus} from '../corpus-cache.mjs';
import {encodeLocal,localEmbeddingFolder,localIndexFile} from '../local-embeddings.mjs';
import {atomicJson} from '../catalog.mjs';
const corpus=await fullCorpus(),shots=corpus.shots.filter(s=>!s.excluded&&s.semanticStatus==='complete'),vectors=new Float32Array(shots.length*512),started=performance.now();
const documents=shots.map(s=>[s.description,'人物：'+(s.characters||[]).join('、'),'情绪：'+(s.semantic?.emotion||''),'动作：'+(s.semantic?.actions||[]).map(a=>a.action).join('；'),'对白含义：'+(s.semantic?.dialogue_meaning_zh||''),'声音：'+(s.semantic?.audio_events||[]).map(a=>a.description).join('；')].join('\n'));
for(let offset=0;offset<shots.length;offset+=16){const batch=documents.slice(offset,offset+16),values=await encodeLocal(batch);vectors.set(values,offset*512);if(offset%256===0)console.log(JSON.stringify({done:offset+batch.length,total:shots.length,seconds:(performance.now()-started)/1000}));}
const bytes=Buffer.from(vectors.buffer),vectorFile='text-vectors-'+createHash('sha256').update(bytes).digest('hex').slice(0,16)+'.f32';await writeFile(path.join(localEmbeddingFolder,vectorFile),bytes);const model=JSON.parse(await readFile(path.join(localEmbeddingFolder,'model.json'),'utf8'));
await atomicJson(localIndexFile,{...model,model:model.repo,dimensions:512,modality:'text',templateVersion:1,vectorFile,builtAt:new Date().toISOString(),entries:shots.map((s,i)=>({id:s.id,sourceId:s.sourceId,episode:s.episode,documentHash:createHash('sha256').update(documents[i]).digest('hex')}))});console.log(JSON.stringify({complete:true,entries:shots.length,seconds:(performance.now()-started)/1000,bytes:bytes.length}));
