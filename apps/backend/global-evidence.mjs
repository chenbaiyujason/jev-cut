import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
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
export async function windowEvidence(items,library){
  const folder=path.join(root,'.local/studio/global-windows');await mkdir(folder,{recursive:true});const tasks=[],files=[];
  for(const item of items){const frames=[Math.floor(item.sourceStart),Math.floor((item.sourceStart+item.sourceEnd-1)/2),Math.ceil(item.sourceEnd)-1],source=library.sources.find(s=>s.id===item.mediaId);if(!source)throw Error('缺少源素材');const hash=createHash('sha256').update(JSON.stringify({id:source.id,frames,version:1})).digest('hex').slice(0,24),file=path.join(folder,hash+'.jpg');files.push({file,url:'/studio-assets/global-windows/'+hash+'.jpg'});try{await access(file);}catch{tasks.push({video:path.join(source.dir,'edit-preview-v2.mp4'),frames,output:file});}}
  await pythonTasks(tasks);return Promise.all(files.map(async f=>({...f,data:'data:image/jpeg;base64,'+(await readFile(f.file)).toString('base64')})));
}
