import {emptyProject} from './release-runtime.mjs';
import path from 'node:path';
import {readFile,writeFile,mkdir,rename,stat,link,copyFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {existsSync} from 'node:fs';
import {removeRepeatedSequences} from './repeated-sequences.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
export const studioRoot=process.env.MAD_STUDIO_ROOT||path.resolve(root,'../editor');
export const studioWorkspace=path.join(studioRoot,'.mad-workspace');
export const studioStore=path.join(root,'.local/studio');
const stateFile=path.join(studioStore,'state.json');
export const engineUrl=process.env.MAD_ENGINE_URL||'http://127.0.0.1:8787';
export const fpsOf=value=>typeof value==='number'?value:String(value||'30').split('/').map(Number).reduce((a,b)=>a/b);
export const gainDb=gain=>gain<=0?-60:Math.max(-60,Math.min(12,20*Math.log10(gain)));
const track=(id,name,kind,order)=>({id,name,kind,height:64,locked:false,visible:true,muted:false,solo:false,order});
const frame=(seconds,fps)=>Math.round(seconds*fps);
const editorVideoName=id=>existsSync(path.join(root,'.local/media',id,'edit-preview-v2.mp4'))?'edit-preview-v2.mp4':'preview.mp4';
const mediaUrl=id=>`/mad-media/${id}/${editorVideoName(id)}`;

export function migrateLegacyProject(library){
  const old=library.project;if(!old)throw Error('尚无可迁移的剪辑项目');const fps=30,now=Date.now(),width=960,height=540;
  const sourceMap=new Map(library.sources.map(s=>[s.id,s])),items=[];
  for(const clip of old.clips){
    const source=sourceMap.get(clip.sourceId);if(!source)throw Error('来源素材缺失');const sfps=fpsOf(source.fps),from=frame(clip.start,fps),durationInFrames=frame(clip.end,fps)-from;
    const needed=Math.ceil(durationInFrames*sfps*clip.rate/fps-1e-9),safeStart=clip.safety?Math.ceil(clip.safety.start*sfps):0,safeEnd=clip.safety?Math.floor(clip.safety.end*sfps):Math.floor(source.duration*sfps);
    const sourceStart=Math.max(safeStart,Math.min(Math.round(clip.sourceIn*sfps),safeEnd-needed)),sourceEnd=sourceStart+needed;
    items.push({id:clip.id,type:'video',trackId:'picture',from,durationInFrames,label:`EP${source.episode} · ${clip.title||'镜头'}`,mediaId:source.id,src:mediaUrl(source.id),sourceStart,sourceEnd,
      sourceDuration:Math.floor(source.duration*sfps),sourceFps:sfps,speed:clip.rate,volume:-60,embeddedAudioMuted:true,sourceWidth:960,sourceHeight:540,originId:clip.id,mad:{assetId:source.id,shotId:clip.shotId,occurrenceId:clip.id},transform:{x:0,y:0,width,height,rotation:0,opacity:1,aspectRatioLocked:true}});
    if(clip.gain>0){
      const window=clip.audioWindow||{start:clip.sourceIn,end:clip.sourceIn+(clip.end-clip.start)*clip.rate};const a=Math.max(clip.sourceIn,window.start),b=Math.min(window.end,clip.sourceIn+(clip.end-clip.start)*clip.rate);
      if(b>a)items.push({id:'sound-'+clip.id,type:'audio',trackId:'source-audio',from:frame(clip.start+(a-clip.sourceIn)/clip.rate,fps),durationInFrames:Math.max(1,frame((b-a)/clip.rate,fps)),label:clip.dialogue||clip.sourceAudioDescription||'原声音效',mediaId:source.id,src:mediaUrl(source.id),sourceStart:frame(a,sfps),sourceEnd:frame(b,sfps),sourceDuration:Math.floor(source.duration*sfps),sourceFps:sfps,speed:clip.rate,volume:gainDb(clip.gain),audioFadeIn:.025,audioFadeOut:.025,
        ...(clip.dialogue?{audioDucking:{duckOthersDb:-10.46,attackSec:.025,releaseSec:.08,targetTrackIds:['music']}}:{})});
    }
  }
  const music=library.music.find(m=>m.id===old.musicId);if(!music)throw Error('主配乐不存在');
  items.push({id:'main-music',type:'audio',trackId:'music',from:0,durationInFrames:frame(old.duration,fps),label:music.name,mediaId:music.id,src:`/mad-media/${music.id}/preview.m4a`,sourceStart:0,sourceEnd:frame(old.duration,fps),sourceDuration:frame(music.duration,fps),sourceFps:fps,speed:1,volume:gainDb(old.musicGain??.7),audioFadeIn:.03,audioFadeOut:.4});
  return {id:'mad-main',name:'Winnow MAD · 夜间巡航',description:'音乐驱动动漫剪辑 · Freecut + JIZURA',createdAt:now,updatedAt:now,duration:old.duration,metadata:{width,height,fps},timeline:{tracks:[track('text-pv','文字 PV','video',0),track('picture','画面','video',1),track('source-audio','原声与对白','audio',2),track('music','主配乐','audio',3)],items,transitions:[],keyframes:[],compositions:[],masterBusDb:0}};
}

export async function prepareStudioMedia(library){
  const media=[];
  for(const item of [...library.sources,...library.music]){
    const video=item.kind!=='music',file=path.join(item.dir,video?'preview.mp4':'preview.m4a'),info=await stat(file),fps=video?fpsOf(item.fps):30;
    const url=`/mad-media/${item.id}/${path.basename(file)}`;
    const metadata={id:item.id,storageType:'workspace',fileName:video?`episode-${String(item.episode).padStart(2,'0')}.mp4`:item.name,fileSize:info.size,mimeType:video?'video/mp4':'audio/mp4',duration:item.duration,width:video?960:0,height:video?540:0,fps,codec:video?'avc1.64001f':'mp4a.40.2',bitrate:0,audioCodec:'aac',audioCodecSupported:true,videoCodecSupported:true,tags:video?['动漫',`EP${item.episode}`]:['主配乐'],createdAt:info.birthtimeMs,updatedAt:info.mtimeMs,remoteUrl:url};
    const dir=path.join(studioWorkspace,'media',item.id);await mkdir(dir,{recursive:true});const target=path.join(dir,path.basename(file));
    try{await stat(target);}catch{try{await link(file,target);}catch{await copyFile(file,target);}}
    await writeFile(path.join(dir,'metadata.json'),JSON.stringify(metadata));
    // Keep the export source untouched; use a short-GOP, 8-bit preview for interactive seeks.
    const editorName=video?editorVideoName(item.id):path.basename(file);
    const editorInfo=editorName===path.basename(file)?info:await stat(path.join(item.dir,editorName));
    const editorUrl=`/mad-media/${item.id}/${editorName}`;
    media.push({mediaId:item.id,url:editorUrl,metadata:{...metadata,remoteUrl:editorUrl,fileSize:editorInfo.size,updatedAt:editorInfo.mtimeMs,...(editorName==='edit-preview-v2.mp4'?{codec:'avc1.4d401f'}:{})}});
  }
  return media;
}

let queue=Promise.resolve(),prepared=null,preparedKey='';
async function atomic(file,value){
  await mkdir(path.dirname(file),{recursive:true});await writeFile(file+'.tmp',JSON.stringify(value,null,2));
  // Windows readers/virus scanners can briefly hold the destination. Keep the old
  // complete file until rename succeeds; never delete it to force a replacement.
  for(let attempt=0;;attempt++){try{await rename(file+'.tmp',file);return;}catch(e){if(!['EPERM','EBUSY','EACCES'].includes(e.code)||attempt>=6)throw e;await new Promise(r=>setTimeout(r,15*2**attempt));}}
}
export async function studioState(library){
  const key=[...library.sources,...library.music].map(i=>i.id).join(',');if(key!==preparedKey){prepared=null;preparedKey=key;}
  prepared??=prepareStudioMedia(library).catch(e=>{prepared=null;throw e;});const media=await prepared;
  let state;try{state=JSON.parse(await readFile(stateFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;state={revision:1,project:library.project?migrateLegacyProject(library):emptyProject(),legacyRevision:library.project.revision};await atomic(stateFile,state);}
  return {...state,media};
}
export function validateStudioProject(project){
  if(!project||project.id!=='mad-main'||!project.timeline||!Array.isArray(project.timeline.items)||!Array.isArray(project.timeline.tracks))throw Error('Freecut 项目结构无效');
  const fps=project.metadata?.fps;if(!Number.isFinite(fps)||fps<1||fps>120)throw Error('项目帧率无效');
  const ids=new Set();for(const item of project.timeline.items){
    if(!item.id||ids.has(item.id))throw Error('出现实例 ID 必须唯一');ids.add(item.id);
    if(!Number.isInteger(item.from)||item.from<0||!Number.isInteger(item.durationInFrames)||item.durationInFrames<1)throw Error('时间轴必须使用非负起点和正整数帧长');
    if(!['video','audio','image','text','shape','composition','adjustment','controller'].includes(item.type))throw Error('不支持的片段类型');
    if(item.expressions?.length)throw Error('Agent 项目不接受任意执行表达式');
  }return project;
}
export function mutateStudio(library,baseRevision,fn,label='edit'){
  const task=queue.catch(()=>{}).then(async()=>{
    const state=await studioState(library);if(baseRevision!==state.revision){const e=Error('工作台已有新修改，请重新读取版本');e.status=409;throw e;}
    const project=validateStudioProject(await fn(structuredClone(state.project),state));project.updatedAt=Date.now();
    await atomic(path.join(studioStore,'history',String(state.revision)+'.json'),{revision:state.revision,project:state.project});
    const next={revision:state.revision+1,project,legacyRevision:state.legacyRevision};await atomic(stateFile,next);
    await appendFile(path.join(studioStore,'operations.jsonl'),JSON.stringify({at:new Date().toISOString(),revision:next.revision,label})+'\n');return {...next,media:state.media};
  });queue=task;return task;
}
export async function engineRequest(route,body,{binary=false}={}){
  let response;try{response=await fetch(engineUrl+route,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(180000)});}catch(e){throw Error('Freecut 合成服务未连接：'+(e.cause?.code||e.message));}
  if(!response.ok){const error=await response.text();throw Error('Freecut '+response.status+': '+error.slice(0,700));}
  return binary?Buffer.from(await response.arrayBuffer()):response.json();
}
export async function nativeEdit(project,ops){
  if(!Array.isArray(ops)||!ops.length||ops.length>1000)throw Error('操作数组必须包含1–1000项');
  const inspect=value=>{if(!value||typeof value!=='object')return;for(const [key,entry] of Object.entries(value)){if(['expressions','script','shaderCode','code'].includes(key))throw Error('Agent 操作不能包含执行代码');inspect(entry);}};inspect(ops);
  const result=await engineRequest('/edit',{projectObject:project,ops});if(result.results?.some(r=>!r.ok))throw Error('部分原生编辑操作失败，未提交工程');return restoreItemMetadata(result.project,project,ops);
}
export function restoreItemMetadata(next,previous,ops=[]){
  const metadata=new Map((previous.timeline?.items||[]).filter(i=>i.mad).map(i=>[i.id,i.mad]));
  for(const op of ops)if(op.op==='addItem'&&op.item?.mad)metadata.set(op.item.id,op.item.mad);
  for(const item of next.timeline?.items||[]){const mad=item.mad||metadata.get(item.id)||metadata.get(item.originId);if(mad)item.mad={...mad,occurrenceId:item.id};}
  return next;
}
let catalogCache=null;
export async function studioCatalog(library){
  if(catalogCache)return catalogCache;
  const cleaned=await removeRepeatedSequences(library.sources);
  const shots=cleaned.sources.flatMap(s=>s.shots.filter(x=>!x.excluded).map(x=>({shotId:x.id,assetId:s.id,sourceIn:x.startFrame,sourceOut:x.endFrame,description:x.description,episode:s.episode,safeRanges:[{sourceIn:x.startFrame+3,sourceOut:x.endFrame-3}]})));
  await Promise.all(shots.map(async shot=>{try{const safe=JSON.parse(await readFile(path.join(root,'.local/cut-safety-v1',shot.shotId+'.json'),'utf8'));shot.safeRanges=safe.safeRanges.map(r=>({sourceIn:r.startFrame,sourceOut:r.endFrame}));}catch{}}));
  catalogCache={assets:library.sources.map(s=>({assetId:s.id,mediaId:s.id,sourceFps:fpsOf(s.fps),sourceDurationFrames:Math.floor(s.duration*fpsOf(s.fps)),src:mediaUrl(s.id),width:960,height:540})),shots:shots.filter(s=>s.safeRanges.some(r=>r.sourceOut>r.sourceIn))};return catalogCache;
}
