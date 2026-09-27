import {readFile,mkdir,access,stat} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {fullCorpus} from './corpus-cache.mjs';
import {root,execFile} from './catalog.mjs';
import {refineCandidates} from './cut-safety.mjs';
import {prepareEvidenceTasks} from './evidence-worker.mjs';
let loaded;
export async function globalResources(){const corpus=await fullCorpus();if(loaded?.version===corpus.builtAt)return loaded;loaded={version:corpus.builtAt,shots:structuredClone(corpus.shots),motion:{},sources:corpus.sources};return loaded;}
const pythonTasks=prepareEvidenceTasks;
let preparation=Promise.resolve();
export function prepareGlobalShots(ids,library,resources){const next=preparation.catch(()=>{}).then(async()=>{
  const shots=resources.shots.filter(s=>ids.includes(s.id));const pending=[];
  for(const s of shots){if(s.cacheState?.boundaries==='reviewed'||s.cacheState?.boundaries==='no-safe-range')continue;try{const cached=JSON.parse(await readFile(path.join(root,'.local/cut-safety-v1',s.id+'.json'),'utf8'));s.safeRanges=cached.safeRanges;s.cacheState={...s.cacheState,boundaries:s.safeRanges.length?'reviewed':'no-safe-range'};}catch{pending.push(s);}}
  if(pending.length){await pythonTasks(pending.map(s=>({kind:'safety',shot:s,source:{...library.sources.find(x=>x.id===s.sourceId),shots:undefined,scenes:undefined}})));for(const s of pending){const checked=JSON.parse(await readFile(path.join(root,'.local/cut-safety-v1',s.id+'.json'),'utf8'));s.safeRanges=checked.safeRanges||[];s.cacheState={...s.cacheState,boundaries:s.safeRanges.length?'reviewed':'no-safe-range'};}}
  const tasks=[];for(const s of shots){if(resources.motion[s.id]||!s.safeRanges?.length)continue;try{resources.motion[s.id]=JSON.parse(await readFile(path.join(root,'.local/director-motion-v1',s.id+'.json'),'utf8'));}catch{tasks.push({id:s.id,video:path.join(library.sources.find(x=>x.id===s.sourceId).dir,'edit-preview-v2.mp4'),ranges:s.safeRanges});}}
  await pythonTasks(tasks);for(const t of tasks)resources.motion[t.id]=JSON.parse(await readFile(path.join(root,'.local/director-motion-v1',t.id+'.json'),'utf8'));
});preparation=next;return next;}
export function createWindowEvidence({folder=path.join(root,'.local/studio/global-windows'),runTasks=pythonTasks,maxEntries=128}={}){
 const memory=new Map(),pending=new Map();
 return async function windowEvidence(items,library){
  const sources=new Map(library.sources.map(s=>[s.id,s])),stamps=new Map();
  await Promise.all([...new Set(items.map(i=>i.mediaId))].map(async id=>{const source=sources.get(id);if(!source)throw Error('缺少源素材');const video=path.join(source.dir,'edit-preview-v2.mp4'),info=await stat(video);stamps.set(id,{video,size:info.size,mtimeMs:info.mtimeMs});}));
  const created=[],promises=items.map(item=>{
   const frames=[Math.floor(item.sourceStart),Math.floor((item.sourceStart+item.sourceEnd-1)/2),Math.ceil(item.sourceEnd)-1],stamp=stamps.get(item.mediaId);
   const key=createHash('sha256').update(JSON.stringify({id:item.mediaId,...stamp,frames,version:2})).digest('hex').slice(0,24);
   if(memory.has(key)){const result=memory.get(key);memory.delete(key);memory.set(key,result);return Promise.resolve(result);}
   if(pending.has(key))return pending.get(key);
   let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});pending.set(key,promise);
   created.push({key,frames,video:stamp.video,file:path.join(folder,key+'.jpg'),resolve,reject});return promise;
  });
  if(created.length)void(async()=>{try{
   await mkdir(folder,{recursive:true});const tasks=[];
   await Promise.all(created.map(async f=>{try{await access(f.file);}catch{tasks.push({video:f.video,frames:f.frames,output:f.file});}}));
   await runTasks(tasks);
   await Promise.all(created.map(async f=>{const result={file:f.file,url:'/studio-assets/global-windows/'+f.key+'.jpg',data:'data:image/jpeg;base64,'+(await readFile(f.file)).toString('base64')};memory.set(f.key,result);while(memory.size>maxEntries)memory.delete(memory.keys().next().value);f.resolve(result);}));
  }catch(e){for(const f of created)f.reject(e);}finally{for(const f of created)pending.delete(f.key);}})();
  return Promise.all(promises);
 };
}
export const windowEvidence=createWindowEvidence();
