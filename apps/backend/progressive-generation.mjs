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
import {runScopedEdit} from './director-edit.mjs';
import {decide} from './winnow.mjs';

/** Serial consumer overlaps model planning; only complete validated sections enter this queue. */
export async function consumeSections(produce,consume,{signal}={}){
 const queue=[];let done=false,failure=null,wake=()=>{};
 const producer=Promise.resolve().then(()=>produce(s=>{queue.push(s);wake();})).then(r=>{done=true;wake();return r;},e=>{failure=e;done=true;wake();});
 try{while(true){if(signal?.aborted)throw Error('已停止生成');if(failure)throw failure;if(queue.length){await consume(queue.shift());continue;}if(done)break;await new Promise(resolve=>{wake=resolve;});}return await producer;}finally{producer.catch(()=>{});}
}
const jobs=new Map();
export function generationStatus(id,after=-1){const job=jobs.get(id);if(!job){const e=Error('生成任务不存在或服务已重启，已排入的镜头仍保留');e.status=404;throw e;}const {controller,ticket,...view}=job;return {...view,state:job.state?.revision>after?job.state:undefined};}
export function cancelGeneration(id){const job=jobs.get(id);if(job?.status==='running'){job.ticket.cancel();job.controller.abort();job.status='cancelled';job.phase='已停止，保留已排入镜头';}return generationStatus(id);}
export async function startGeneration(body,library,dependencies={}){
 const {getState=studioState,commit=mutateStudio,loadResources=globalResources,understandMusic=analyzeMusicIntent,loadEvents=musicEvents,makePlan=planEdit,choose=chooseGlobalShot,polish=runScopedEdit,askModel=decide,logRoot=path.join(studioStore,'generations')}=dependencies;
 const music=library.music.find(m=>m.id===body.musicId),duration=Number(body.duration||20);
 if(!music||!Number.isFinite(duration)||duration<5||duration>Math.min(300,music.duration))throw Error('请选择配乐及5–300秒范围内的有效时长');
 const current=await getState(library);if(current.revision!==body.baseRevision){const e=Error('工作台已有修改，请同步后生成');e.status=409;throw e;}
 if(current.project.timeline.items.some(i=>i.locked||i.isLocked)||current.project.timeline.tracks.some(t=>t.locked||t.isLocked))throw Error('当前时间轴有锁定内容，请先解锁再从头生成');
 for(const [id,job] of jobs)if(job.status==='running')cancelGeneration(id);
 while(jobs.size>=20){const old=[...jobs].find(([,j])=>j.status!=='running');if(!old)break;jobs.delete(old[0]);}
 const id=randomUUID(),started=performance.now(),ticket=beginEditEpoch(current.project.id),controller=new AbortController();
 const fresh=migrateLegacyProject({...library,project:{musicId:music.id,duration,clips:[],musicGain:.65}});fresh.name='从音乐生成 · '+music.name;fresh.description=String(body.prompt||'');
 const state=await commit(library,current.revision,()=>{if(!ticket.current())throw Error('生成已被新操作替代');return fresh;},'start progressive generation '+id);
 const job={id,status:'running',phase:'音乐轨已就绪，正在准备首段',clips:0,sectionsReady:0,state,controller,ticket,startedAt:new Date().toISOString(),timing:{musicTrackMs:performance.now()-started},trace:[]};jobs.set(id,job);
 const check=()=>{if(controller.signal.aborted||!ticket.current())throw Error('已停止生成，保留已排入镜头');};
 const publish=async(project,phase)=>{check();const next=await commit(library,job.state.revision,()=>{check();return structuredClone(project);},phase);job.state=next;job.phase=phase;job.clips=project.timeline.items.filter(i=>i.type==='video').length;if(job.clips&&!job.timing.firstClipMs)job.timing.firstClipMs=performance.now()-started;};
 const folder=path.join(logRoot,id);
 void (async()=>{
  try{
   await mkdir(folder,{recursive:true});const ask=request=>{check();return askModel(request,folder);};
   const [resources,intent,events]=await Promise.all([loadResources(),understandMusic(music),loadEvents(music)]);check();
   if(new Set(resources.shots.filter(s=>!s.excluded&&s.semanticStatus==='complete').map(s=>s.episode)).size<expectedSourceCount(library))throw Error('全量素材素材理解尚未就绪');
   const beat=60/music.bpm;events.firstEntry=firstRhythmicEntry(events,beat);let project=structuredClone(job.state.project);
   job.phase='Gemini 正在规划，首段就绪后立即选镜';
   const plan=await consumeSections(emit=>makePlan(music,[],{duration,prompt:String(body.prompt||intent.edit_direction),intensity:.85,keepDialogue:body.keepDialogue!==false&&intent.dialogue_suitability>=.5,events,globalScope:true,musicIntent:intent,signal:controller.signal,onSection:(section,times)=>{check();job.sectionsReady++;job.timing.firstSectionMs??=performance.now()-started;emit({section,times});}}),async({section,times})=>{
    check();const partial={sections:[section],beatTimes:times},scoped={...events,firstEntry:section.start===0?events.firstEntry:undefined,primaryAccents:events.primaryAccents.filter(a=>a.time>=section.start&&a.time<section.end)};
    const policies=await chooseAccentPolicies(scoped,intent,partial,{decide:ask,logDir:folder});
    const slots=shapeAroundAccents(slotsFromPlan(partial,music,section.end),policies.anchors,beat);
    for(const slot of slots){check();job.phase=`Winnow 正在选第 ${job.clips+1} 镜 · 已排入 ${job.clips} 镜`;
     const from=Math.round(slot.start*30),to=Math.round(slot.end*30);if(to<=from)continue;
     const item={id:randomUUID(),type:'video',trackId:'picture',from,durationInFrames:to-from,label:slot.phase,mediaId:'',src:'',sourceStart:0,sourceEnd:0,sourceFps:24,speed:1,volume:-60,embeddedAudioMuted:true,sourceWidth:960,sourceHeight:540,transform:{x:0,y:0,width:960,height:540,rotation:0,opacity:1,aspectRatioLocked:true}};
     const proposal=structuredClone(project);proposal.timeline.items.push(item);
     const choice=await choose({project:proposal,item,library,resources,goal:String(body.prompt||intent.edit_direction),intent:slot.phase,ask,allowKeep:false,reserveFrames:4,cancelled:()=>!ticket.current()||controller.signal.aborted});check();
     const selected=choice.selected.item;if(!selected.mediaId||!selected.src||!selected.mad?.shotId||selected.sourceEnd<=selected.sourceStart)throw Error('没有可播放的真实镜头，停止排布');
     project.timeline.items.push(selected);job.trace.push({occurrenceId:selected.id,traceUrl:choice.traceUrl,timing:choice.timing});
     await publish(project,`第 ${job.clips+1} 镜已排入`);
    }
   },{signal:controller.signal});
   check();job.phase='镜头已排好，Winnow 正在补原声、转场和效果';job.timing.roughCutMs=performance.now()-started;
   const polished=await polish({project,library,resources,ask,cancelled:()=>controller.signal.aborted||!ticket.current(),body:{scope:{mode:'all'},goal:String(body.prompt||intent.edit_direction),prompt:intent.edit_direction,audioMode:body.keepDialogue===false?'sfx':'auto',allowed:{shots:false,effects:true,transitions:true,grade:true}},onProgress:p=>{job.phase=p.phase||'正在补充镜头表现';}});
   await publish(polished.project,'生成完成 · 可以播放');job.timing.completeMs=performance.now()-started;job.status='complete';
   await writeFile(path.join(folder,'result.json'),JSON.stringify({plan,musicUnderstandingId:intent.id,trace:job.trace,timing:job.timing,revision:job.state.revision},null,2));
  }catch(e){controller.abort();job.status=controller.signal.aborted&&!ticket.current()?'cancelled':'error';job.error=e.message;job.phase=job.status==='cancelled'?'已停止，保留已排入镜头':'生成中止，保留已排入镜头';}
 })();return generationStatus(id);
}
