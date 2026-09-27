import {expectedSourceCount} from './release-runtime.mjs';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {studioState,mutateStudio,migrateLegacyProject,studioStore} from './studio-project.mjs';
import {beginEditEpoch} from './edit-epochs.mjs';
import {globalResources} from './global-evidence.mjs';
import {analyzeMusicIntent} from './music-intent.mjs';
import {planEdit,slotsFromPlan} from './planning.mjs';
import {musicEvents,firstRhythmicEntry,chooseAccentPolicies,shapeAroundAccents} from './rhythm.mjs';
import {chooseGlobalShot} from './global-director.mjs';
import {runScopedEdit,isolateEditTargets} from './director-edit.mjs';
import {decide} from './winnow.mjs';
import {prefetchShotQuery} from './query-vectors.mjs';
import {warmEvidenceWorker} from './evidence-worker.mjs';
import {visionSelectionEnabled} from './decision-settings.mjs';
import {generationWindow,musicForWindow,generationRanges} from './generation-window.mjs';
import {durationChoices,applyShotDecision} from './shot-pacing.mjs';
import {musicPhrases} from './music-phrases.mjs';

/** Serial consumer overlaps model planning; only complete validated sections enter this queue. */
export async function consumeSections(produce,consume,{signal}={}){
 const queue=[];let done=false,failure=null,wake=()=>{};
 const producer=Promise.resolve().then(()=>produce(s=>{queue.push(s);wake();})).then(r=>{done=true;wake();return r;},e=>{failure=e;done=true;wake();});
 try{while(true){if(signal?.aborted)throw Error('已停止生成');if(failure)throw failure;if(queue.length){await consume(queue.shift());continue;}if(done)break;await new Promise(resolve=>{wake=resolve;});}return await producer;}finally{producer.catch(()=>{});}
}
const jobs=new Map();
const listeners=new Map();
function notify(id){for(const wake of listeners.get(id)||[])wake();}
function progress(job,patch){Object.assign(job,patch);job.eventVersion=(job.eventVersion||0)+1;notify(job.id);}
export async function waitGeneration(id,after=-1,{timeoutMs=15000,afterEvent}={}){
 const current=generationStatus(id,after);if(current.status!=='running'||current.state||Number.isFinite(afterEvent)&&current.eventVersion>afterEvent)return current;
 await new Promise(resolve=>{let timer;const wake=()=>{clearTimeout(timer);const set=listeners.get(id);set?.delete(wake);if(!set?.size)listeners.delete(id);resolve();};
  if(!listeners.has(id))listeners.set(id,new Set());listeners.get(id).add(wake);timer=setTimeout(wake,timeoutMs);
 });return generationStatus(id,after);
}
export function generationStatus(id,after=-1){const job=jobs.get(id);if(!job){const e=Error('生成任务不存在或服务已重启，已排入的镜头仍保留');e.status=404;throw e;}const {controller,ticket,...view}=job;return {...view,state:job.state?.revision>after?job.state:undefined};}
export function cancelGeneration(id){const job=jobs.get(id);if(job?.status==='running'){job.ticket.cancel();job.controller.abort();progress(job,{status:'cancelled',phase:'已停止，保留已排入镜头',pendingClip:null});}return generationStatus(id);}
export async function startGeneration(body,library,dependencies={}){
 const {getState=studioState,commit=mutateStudio,loadResources=globalResources,understandMusic=analyzeMusicIntent,loadEvents=musicEvents,makePlan=planEdit,choose=chooseGlobalShot,polish=runScopedEdit,askModel=decide,prefetch=prefetchShotQuery,warmEvidence=warmEvidenceWorker,logRoot=path.join(studioStore,'generations')}=dependencies;
 const mode=body.mode||'new';if(!['new','append','rebuild'].includes(mode))throw Error('未知生成模式');
 const music=library.music.find(m=>m.id===body.musicId);let duration=Number(body.duration||20);
 if(!music)throw Error('请选择有效配乐');
 if(mode==='new'&&(!Number.isFinite(duration)||duration<5||duration>300))throw Error('请选择配乐及5–300秒范围内的有效时长');
 const current=await getState(library);if(current.revision!==body.baseRevision){const e=Error('工作台已有修改，请同步后生成');e.status=409;throw e;}
 if(mode==='new'&&(current.project.timeline.items.some(i=>i.locked||i.isLocked)||current.project.timeline.tracks.some(t=>t.locked||t.isLocked)))throw Error('当前时间轴有锁定内容，请先解锁再从头生成');
 for(const [id,job] of jobs)if(job.status==='running')cancelGeneration(id);
 while(jobs.size>=20){const old=[...jobs].find(([,j])=>j.status!=='running');if(!old)break;jobs.delete(old[0]);}
 const id=randomUUID(),started=performance.now(),ticket=beginEditEpoch(current.project.id),controller=new AbortController();
 let fresh=mode==='new'?migrateLegacyProject({...library,project:{musicId:music.id,duration,clips:[],musicGain:.65}}):structuredClone(current.project);
 if(mode==='new'){fresh.name='从音乐生成 · '+music.name;fresh.description=String(body.prompt||'');const track=fresh.timeline.items.find(i=>i.trackId==='music');const offset=Number(body.musicStart||0);if(!Number.isFinite(offset)||offset<0)throw Error('音乐起点无效');track.sourceStart=Math.round(offset*(track.sourceFps||fresh.metadata.fps));track.sourceEnd=track.sourceStart+Math.round(duration*(track.sourceFps||fresh.metadata.fps));}
 else if(body.prompt!==undefined)fresh.description=String(body.prompt);
 if(mode==='new'){
  const track=fresh.timeline.items.find(i=>i.trackId==='music'),rate=Number(body.musicRate??1),from=Number(body.musicFrom??0);
  if(!Number.isFinite(rate)||rate<=0||!Number.isFinite(from)||from<0)throw Error('主音轨位置或速度无效');
  track.from=Math.round(from*fresh.metadata.fps);track.speed=rate;track.sourceEnd=track.sourceStart+Math.ceil(duration*(track.sourceFps||fresh.metadata.fps)*rate);
  if(body.musicVolume!==undefined){const volume=Number(body.musicVolume);if(!Number.isFinite(volume)||volume< -60||volume>12)throw Error('音轨音量无效');track.volume=volume;}
  fresh.duration=(track.from+track.durationInFrames)/fresh.metadata.fps;
 }
 const window=generationWindow(fresh,music);duration=window.duration;
 if(mode==='rebuild'){
  const targets=fresh.timeline.items.filter(i=>i.type==='video'&&i.trackId==='picture'&&i.from<window.to&&i.from+i.durationInFrames>window.from).map(i=>({id:i.id,from:Math.max(i.from,window.from),to:Math.min(i.from+i.durationInFrames,window.to)}));
  const isolated=isolateEditTargets(fresh,{targets});fresh=isolated.project;const removed=new Set(isolated.ids);
  fresh.timeline.items=fresh.timeline.items.filter(i=>!removed.has(i.id)&&!(i.trackId==='source-audio'&&!i.locked&&!i.isLocked&&/^sfx-|^director-audio-/.test(i.id)&&i.from>=window.from&&i.from+i.durationInFrames<=window.to));
  fresh.timeline.transitions=(fresh.timeline.transitions||[]).filter(t=>!removed.has(t.leftClipId)&&!removed.has(t.rightClipId));fresh.timeline.keyframes=(fresh.timeline.keyframes||[]).filter(k=>!removed.has(k.itemId));
 }
 const ranges=generationRanges(fresh,window,mode),goal=String(body.prompt??fresh.description??'');
 const state=await commit(library,current.revision,()=>{if(!ticket.current())throw Error('生成已被新操作替代');return fresh;},'start progressive generation '+id);
 const job={id,mode,status:'running',phase:mode==='append'?'正在补齐主音轨后的画面':'音乐轨已就绪，正在准备首段',eventVersion:0,pendingClip:null,clips:fresh.timeline.items.filter(i=>i.type==='video').length,sectionsReady:0,state,controller,ticket,startedAt:new Date().toISOString(),timing:{musicTrackMs:performance.now()-started},trace:[]};jobs.set(id,job);
 const check=()=>{if(controller.signal.aborted||!ticket.current())throw Error('已停止生成，保留已排入镜头');};
 const publish=async(project,phase)=>{check();const next=await commit(library,job.state.revision,()=>{check();return structuredClone(project);},phase);job.state=next;job.clips=project.timeline.items.filter(i=>i.type==='video').length;if(job.clips&&!job.timing.firstClipMs)job.timing.firstClipMs=performance.now()-started;progress(job,{phase,pendingClip:null});};
 const folder=path.join(logRoot,id);
 void (async()=>{
  try{
   await mkdir(folder,{recursive:true});const ask=request=>{check();return askModel(request,folder);};
   const visionEnabled=await visionSelectionEnabled(body.visionEnabled);
   if(visionEnabled)void warmEvidence().catch(()=>{});
   if(!ranges.length){progress(job,{status:'complete',phase:'主音轨范围已有画面覆盖',pendingClip:null});return;}
   progress(job,{phase:'正在理解主音轨与节拍'});
   const [resources,rawIntent,rawEvents]=await Promise.all([loadResources(),understandMusic(music),loadEvents(music)]);check();
   const {music:planningMusic,intent,events}=musicForWindow(music,rawIntent,rawEvents,window);const effectiveGoal=goal||intent.edit_direction;
   const rawPhrases=rawIntent.has_intelligible_lyrics?await musicPhrases(music):{phrases:[]};
   const mapPhraseTime=t=>(t-window.sourceStart)/window.rate;
   const phrases={phrases:rawPhrases.phrases.filter(p=>mapPhraseTime(p.end)>0&&mapPhraseTime(p.start)<duration).map(p=>({...p,start:Math.max(0,mapPhraseTime(p.start)),end:Math.min(duration,mapPhraseTime(p.end)),breaks:p.breaks.map(mapPhraseTime).filter(t=>t>0&&t<duration)}))};
   if(new Set(resources.shots.filter(s=>!s.excluded&&s.semanticStatus==='complete').map(s=>s.episode)).size<expectedSourceCount(library))throw Error('全量素材素材理解尚未就绪');
   const beat=60/planningMusic.bpm;events.firstEntry=firstRhythmicEntry(events,beat);let project=structuredClone(job.state.project);const generatedIds=[];
   progress(job,{phase:'Gemini 正在规划，首段就绪后立即选镜'});
   const plan=await consumeSections(emit=>makePlan(planningMusic,[],{duration,prompt:effectiveGoal,intensity:.85,keepDialogue:body.keepDialogue!==false&&intent.dialogue_suitability>=.5,events,globalScope:true,musicIntent:intent,signal:controller.signal,onSection:(section,times)=>{check();job.sectionsReady++;job.timing.firstSectionMs??=performance.now()-started;
    // Warm only the query vector; each actual selection still scans the entire corpus.
    if(ranges.some(([a,b])=>window.from+section.start*window.fps<b&&window.from+section.end*window.fps>a))void prefetch({goal:effectiveGoal,intent:[section.intent,section.visual_strategy].filter(Boolean).join('；')}).catch(()=>{});emit({section,times});}}),async({section,times})=>{
    check();const partial={sections:[section],beatTimes:times},scoped={...events,firstEntry:section.start===0?events.firstEntry:undefined,primaryAccents:events.primaryAccents.filter(a=>a.time>=section.start&&a.time<section.end)};
    if(!ranges.some(([a,b])=>window.from+section.start*window.fps<b&&window.from+section.end*window.fps>a))return;
    const policies=await chooseAccentPolicies(scoped,intent,partial,{decide:ask,logDir:folder});
    const slots=shapeAroundAccents(slotsFromPlan(partial,planningMusic,section.end),policies.anchors,beat).flatMap(slot=>ranges.map(([a,b])=>({...slot,from:Math.max(a,window.from+Math.round(slot.start*window.fps)),to:Math.min(b,window.from+Math.round(slot.end*window.fps))})).filter(s=>s.to>s.from));
    let selectedUntil=-1;
    for(const slot of slots){check();
     const from=Math.max(slot.from,selectedUntil);if(slot.to<=from)continue;
     const range=ranges.find(([a,b])=>a<=from&&b>from);if(!range)continue;
     const cap=Math.min(range[1],window.from+Math.round(section.end*window.fps));
     const durationOptions=durationChoices({from:from-window.from,totalFrames:cap-window.from,fps:window.fps,music:planningMusic,events,phrases,ending:cap===window.to&&from>cap-3*window.fps});
     const to=from+durationOptions[0].frames;
     const item={id:randomUUID(),type:'video',trackId:'picture',from,durationInFrames:to-from,label:slot.phase,mediaId:'',src:'',sourceStart:0,sourceEnd:0,sourceFps:24,speed:1,volume:-60,embeddedAudioMuted:true,sourceWidth:960,sourceHeight:540,transform:{x:0,y:0,width:960,height:540,rotation:0,opacity:1,aspectRatioLocked:true}};
     const proposal=structuredClone(project);proposal.timeline.items.push(item);
     progress(job,{phase:`第 ${job.clips+1} 镜 · 正在全库选镜`,pendingClip:{id:item.id,trackId:'picture',from,to,index:job.clips+1}});
     const choice=await choose({project:proposal,item,library,resources,goal:effectiveGoal,intent:slot.phase,ask,allowKeep:false,reserveFrames:4,visionEnabled,durationOptions,onStage:stage=>progress(job,{phase:`第 ${job.clips+1} 镜 · ${{recall:'全库召回',semantic:'语义适配判断',window:'比较动作窗口与时长',visual:'视觉选镜','window-text':'联合选择镜头与结束点'}[stage]||stage}`}),cancelled:()=>!ticket.current()||controller.signal.aborted});check();
     const selected=choice.selected.item;if(!selected.mediaId||!selected.src||!selected.mad?.shotId||selected.sourceEnd<=selected.sourceStart)throw Error('没有可播放的真实镜头，停止排布');
     const applied=applyShotDecision(project,choice.selected,resources.shots);project=applied.project;selectedUntil=selected.from+selected.durationInFrames;if(!generatedIds.includes(applied.occurrenceId))generatedIds.push(applied.occurrenceId);job.trace.push({occurrenceId:applied.occurrenceId,editAction:applied.action,selectedDurationFrames:selected.durationInFrames,durationOptions,traceUrl:choice.traceUrl,timing:choice.timing});
     await publish(project,applied.action==='extend'?'当前镜头已延长，动作继续':`第 ${job.clips+1} 镜已排入`);
    }
   },{signal:controller.signal});
   check();
   progress(job,{phase:'镜头已排好，正在补原声、转场和效果',pendingClip:null});job.timing.roughCutMs=performance.now()-started;
   const polished=generatedIds.length?await polish({project,library,resources,ask,cancelled:()=>controller.signal.aborted||!ticket.current(),body:{scope:{mode:'selection',selectedIds:generatedIds},goal:effectiveGoal,prompt:intent.edit_direction,audioMode:body.keepDialogue===false?'sfx':'auto',allowed:{shots:false,effects:true,transitions:true,grade:true}},onProgress:p=>progress(job,{phase:p.phase||'正在补充镜头表现'})}):{project};
   await publish(polished.project,'生成完成 · 可以播放');job.timing.completeMs=performance.now()-started;progress(job,{status:'complete',pendingClip:null});
   await writeFile(path.join(folder,'result.json'),JSON.stringify({plan,musicUnderstandingId:intent.id,trace:job.trace,timing:job.timing,revision:job.state.revision},null,2));
  }catch(e){controller.abort();job.status=controller.signal.aborted&&!ticket.current()?'cancelled':'error';job.error=e.message;progress(job,{phase:job.status==='cancelled'?'已停止，保留已排入镜头':'生成中止，保留已排入镜头',pendingClip:null});}
 })();return generationStatus(id);
}
