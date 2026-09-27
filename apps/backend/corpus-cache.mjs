import {readFile,readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {atomicJson,root,catalogRoot} from './catalog.mjs';
import {filterRepeatedSequences} from './repeated-sequences.mjs';
export const corpusFile=path.join(catalogRoot,'full-corpus.json');
let cache=null;
export function assembleCorpus(library,{duplicates={sources:{}},vectors={entries:[]},safety=new Map()}={}){
  const cleaned=filterRepeatedSequences(library.sources,duplicates),embedded=new Set(vectors.entries.map(e=>e.id));
  const shots=cleaned.sources.flatMap(source=>source.shots.map(shot=>{
    const inspected=safety.get(shot.id),ranges=inspected?.safeRanges||[];
    return {...shot,episode:source.episode,sourceId:source.id,cacheState:{semantic:shot.semanticStatus==='complete'?'ready':'pending',embedding:embedded.has(shot.id)?'ready':'pending',boundaries:!inspected?'pending':ranges.length?'reviewed':'no-safe-range',preview:'indexed'},safeRanges:ranges};
  }));
  return {version:2,policy:'all shots retained; only repeated OP/ED fully covered shots omitted from default selection; all other labels are evidence, not corpus gates',builtAt:new Date().toISOString(),sources:library.sources.map(s=>({id:s.id,episode:s.episode,duration:s.duration,fps:s.fps,dir:s.dir,original:s.original})),shots,
    stats:{total:shots.length,defaultSelectable:shots.filter(s=>!s.excluded).length,repeatedOpeningEnding:shots.filter(s=>s.excluded).length,semanticsReady:shots.filter(s=>s.cacheState.semantic==='ready').length,embeddingsReady:shots.filter(s=>s.cacheState.embedding==='ready').length,searchableEmbeddingReady:shots.filter(s=>!s.excluded&&s.cacheState.embedding==='ready').length,boundariesReviewed:shots.filter(s=>s.cacheState.boundaries!=='pending').length,withSafeRanges:shots.filter(s=>s.safeRanges.length).length,safeRangeCount:shots.reduce((n,s)=>n+s.safeRanges.length,0),legacyExclusionsRecovered:shots.filter(s=>s.legacyExcluded&&!s.excluded).length}};
}
export async function rebuildCorpusCache(){
  const [library,duplicates,vectors,files]=await Promise.all([readFile(path.join(root,'.local/library.json'),'utf8').then(JSON.parse),readFile(path.join(catalogRoot,'repeated-sequences.json'),'utf8').then(JSON.parse),readFile(path.join(catalogRoot,'vector-index.json'),'utf8').then(JSON.parse),readdir(path.join(root,'.local/cut-safety-v1'))]);
  const known=new Set(files),safety=new Map();
  await Promise.all(library.sources.flatMap(s=>s.shots).filter(s=>known.has(s.id+'.json')).map(async s=>safety.set(s.id,JSON.parse(await readFile(path.join(root,'.local/cut-safety-v1',s.id+'.json'),'utf8')))));
  const corpus=assembleCorpus(library,{duplicates,vectors,safety});await atomicJson(corpusFile,corpus);cache=null;return corpus;
}
export async function fullCorpus(){
  const info=await stat(corpusFile);if(cache?.mtime===info.mtimeMs)return cache.value;
  const value=JSON.parse(await readFile(corpusFile,'utf8'));cache={mtime:info.mtimeMs,value};return value;
}
