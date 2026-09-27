import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
const queues=new Map();
function fileFor(directory,identity){return path.join(directory,createHash('sha256').update(JSON.stringify({version:1,...identity})).digest('hex')+'.json');}
export function bufferPlanningSection(directory,identity,section,window){
 const file=fileFor(directory,identity),task=(queues.get(file)||Promise.resolve()).catch(()=>{}).then(async()=>{
  let stored={identity,sections:[]};try{stored=JSON.parse(await readFile(file,'utf8'));}catch{}
  const entry={...section,sourceStart:window.sourceStart+section.start*window.rate,sourceEnd:window.sourceStart+section.end*window.rate,basisOrigin:window.sourceStart};
  stored.sections=stored.sections.filter(s=>s.sourceEnd<=entry.sourceStart+.01||s.sourceStart>=entry.sourceEnd-.01);stored.sections.push(entry);stored.sections.sort((a,b)=>a.sourceStart-b.sourceStart);
  await mkdir(directory,{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(stored));await rename(temp,file);
 });queues.set(file,task);return task.finally(()=>{if(queues.get(file)===task)queues.delete(file);});
}
export async function bufferedPlan(directory,identity,window,music){
 let stored;try{stored=JSON.parse(await readFile(fileFor(directory,identity),'utf8'));}catch{return null;}
 const start=window.sourceStart,end=start+window.duration*window.rate,rows=stored.sections.filter(s=>s.sourceStart<end-.01&&s.sourceEnd>start+.01).sort((a,b)=>a.sourceStart-b.sourceStart);
 let cursor=start;for(const row of rows){if(row.sourceStart>cursor+.05)return null;cursor=Math.max(cursor,row.sourceEnd);}if(cursor<end-.05)return null;
 const times=[0,...music.beats.filter(t=>t>.08&&t<window.duration-.08),window.duration];let beat=0;
 const sections=[];for(const [i,row]of rows.entries()){
  const endpoint=(Math.min(end,row.sourceEnd)-start)/window.rate;let to=times.length-1;
  if(i<rows.length-1){to=times.reduce((best,t,n)=>Math.abs(t-endpoint)<Math.abs(times[best]-endpoint)?n:best,beat);}
  if(to<=beat)continue;
  sections.push({...row,id:'buffer-'+sections.length,from_beat:beat,to_beat:to,start:times[beat],end:times[to],preferred_shots:[],music_basis:row.music_basis+'（复用已有规划；原始时间依据起点 '+row.basisOrigin.toFixed(2)+' 秒）'});beat=to;
 }
 if(!sections.length||beat!==times.length-1)return null;
 return {title:'复用已缓冲的音乐规划',premise:identity.goal,sections,beatTimes:times,cached:true,planningSource:'buffer',musicUnderstandingId:identity.understandingId};
}
