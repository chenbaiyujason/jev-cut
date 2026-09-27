import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {liveDirectorResources,buildLiveReplacements} from './director-live.mjs';
import {compileTechnique} from './studio-techniques.mjs';
import {fpsOf,studioState,mutateStudio,studioStore} from './studio-project.mjs';
import {root} from './catalog.mjs';
import {decide} from './winnow.mjs';
import {chooseGlobalShot} from './global-director.mjs';
import {beginEditEpoch} from './edit-epochs.mjs';
import {isSpeechCue} from './core.mjs';
import {cachedMusicContext} from './music-intent.mjs';

const jobs=new Map();
const waiters=new Map();
function notifyJob(id){const list=waiters.get(id)||[];waiters.delete(id);for(const resolve of list)resolve();}
export async function waitEditJob(id){const job=getEditJob(id);if(!['running','committing'].includes(job.status))return job;await new Promise(resolve=>{const done=()=>{clearTimeout(timer);resolve();};const timer=setTimeout(()=>{const list=waiters.get(id)||[];waiters.set(id,list.filter(f=>f!==done));resolve();},1000);waiters.set(id,[...(waiters.get(id)||[]),done]);});return getEditJob(id);}
const end=i=>i.from+i.durationInFrames;
const overlap=(a,b)=>a[0]<b[1]&&b[0]<a[1];
const fail=(message,status=422)=>{const e=Error(message);e.status=status;throw e;};
const locked=(p,i)=>i.locked||i.isLocked||p.timeline.tracks.find(t=>t.id===i.trackId)?.locked||p.timeline.tracks.find(t=>t.id===i.trackId)?.isLocked;
export function resolveEditScope(project,scope){
  const videos=project.timeline.items.filter(i=>i.type==='video'),last=Math.max(0,...project.timeline.items.map(end));
  if(!scope||!['selection','range','intersection','all','after'].includes(scope.mode))fail('请选择明确的修改范围');
  const selected=new Set(scope.selectedIds||[]),useRange=['range','intersection','after'].includes(scope.mode);
  const start=scope.mode==='after'?scope.cursor:scope.in,endFrame=scope.mode==='after'?last:scope.out;
  if(useRange&&(!Number.isInteger(start)||!Number.isInteger(endFrame)||start<0||endFrame<=start||endFrame>last))fail('入出点必须是工程范围内的有效帧区间');
  if(['selection','intersection'].includes(scope.mode)&&!selected.size)fail('尚未选中画面片段，不会自动修改全片');
  const targets=videos.filter(i=>(!['selection','intersection'].includes(scope.mode)||selected.has(i.id))&&(!useRange||overlap([i.from,end(i)],[start,endFrame]))).map(i=>({id:i.id,from:useRange?Math.max(start,i.from):i.from,to:useRange?Math.min(endFrame,end(i)):end(i)}));
  if(!targets.length)fail('范围内没有画面片段');
  return {targets,intervals:targets.map(t=>[t.from,t.to]),from:Math.min(...targets.map(t=>t.from)),to:Math.max(...targets.map(t=>t.to))};
}
export function isolateEditTargets(project,scope){
  const p=structuredClone(project),ids=[],notes=[],parts=new Map();
  for(const t of scope.targets){const i=p.timeline.items.find(i=>i.id===t.id);if(locked(p,i)){notes.push({id:i.id,reason:'镜头或轨道已锁定'});continue;}
    if(t.from===i.from&&t.to===end(i)){ids.push(i.id);continue;}
    const cutsTransition=(p.timeline.transitions||[]).some(tr=>{const right=p.timeline.items.find(x=>x.id===tr.rightClipId);if(!right)return false;const start=right.from-Math.floor(tr.durationInFrames*(tr.alignment??.5)),finish=start+tr.durationInFrames;return [t.from,t.to].some(c=>c>start&&c<finish);});
    if(cutsTransition){notes.push({id:i.id,reason:'范围边界位于现有转场内部，已保护该镜头'});continue;}
    if(i.isReversed||p.timeline.keyframes?.some(k=>k.itemId===i.id)||i.motionLayers?.length||i.motionModifiers?.length||i.fadeIn||i.fadeOut||i.expressions?.length){notes.push({id:i.id,reason:'范围边界落在带动画或淡变的镜头内，保护其外侧；可选中完整镜头再修改'});continue;}
    const points=[i.from,t.from,t.to,end(i)].filter((n,j,a)=>a.indexOf(n)===j).sort((a,b)=>a-b),children=[];
    for(let n=0;n<points.length-1;n++){const a=points[n],b=points[n+1],id=n===0?i.id:randomUUID(),rate=(i.sourceFps||p.metadata.fps)*(i.speed??1)/p.metadata.fps;const c={...i,id,from:a,durationInFrames:b-a,sourceStart:i.sourceStart+(a-i.from)*rate,sourceEnd:b===end(i)?i.sourceEnd:Math.ceil(i.sourceStart+(b-i.from)*rate),mad:{...i.mad,occurrenceId:id,preserveSourcePhase:true}};children.push(c);if(a>=t.from&&b<=t.to)ids.push(id);}
    p.timeline.items=p.timeline.items.flatMap(x=>x.id===i.id?children:[x]);parts.set(i.id,children);
    p.timeline.transitions=(p.timeline.transitions||[]).map(tr=>({...tr,...(tr.leftClipId===i.id?{leftClipId:children.at(-1).id}:{}),...(tr.rightClipId===i.id?{rightClipId:children[0].id}:{})}));
  }
  return {project:p,ids,notes,parts};
}
/** Apply only compiler-produced operations; no renderer or full-project serialization in the edit path. */
export function applyDirectorOps(project,ops){
 const p=structuredClone(project);p.timeline.keyframes??=[];p.timeline.transitions??=[];
 for(const op of ops){const item=p.timeline.items.find(i=>i.id===(op.itemId||op.id));
  if(op.op==='updateItem')Object.assign(item,op.updates);
  else if(op.op==='addEffect'){item.effects??=[];item.effects.push({id:randomUUID(),enabled:true,effect:{type:'gpu-effect',gpuEffectType:op.gpuEffectType,params:op.params}});}
  else if(op.op==='addTransition'){const {op:_,...data}=op;p.timeline.transitions.push({id:randomUUID(),trackId:p.timeline.items.find(i=>i.id===op.leftClipId).trackId,...data});}
  else if(op.op==='addKeyframe'){let k=p.timeline.keyframes.find(k=>k.itemId===op.itemId);if(!k){k={itemId:op.itemId,animationVersion:2,properties:[]};p.timeline.keyframes.push(k);}let prop=k.properties.find(p=>p.property===op.property);if(!prop){prop={property:op.property,keyframes:[]};k.properties.push(prop);}prop.keyframes=prop.keyframes.filter(f=>f.frame!==op.frame);prop.keyframes.push({id:randomUUID(),frame:op.frame,value:op.value,easing:op.easing||'linear'});prop.keyframes.sort((a,b)=>a.frame-b.frame);}
  else fail('不支持的编译动作 '+op.op);
 }return p;
}
const presets={neutral:[],cool:[{gpuEffectType:'gpu-temperature',params:{temperature:-.09,tint:0}},{gpuEffectType:'gpu-saturation',params:{amount:.86}}],warm:[{gpuEffectType:'gpu-temperature',params:{temperature:.07,tint:0}},{gpuEffectType:'gpu-saturation',params:{amount:1.05}}]};
export async function runScopedEdit({project,body,library,resources,ask,chooseShot=chooseGlobalShot,onProgress=()=>{},cancelled=()=>false}){
 const started=performance.now(),scope=resolveEditScope(project,body.scope),isolated=isolateEditTargets(project,scope);let p=isolated.project;const targets=new Set(isolated.ids),notes=isolated.notes,decisions=[];
 if(!targets.size)fail('范围内镜头均被保护：请选择未锁定的完整镜头');
 const audioMode=body.audioMode||'preserve';if(!['preserve','mute','auto','original','sfx'].includes(audioMode))fail('人声分离尚未就绪，不能把混合原声当作纯人声');
 const allowed=body.allowed||{},goal=String(body.goal||'').trim().slice(0,1000),prompt=String(body.prompt||'').trim().slice(0,1000),query=goal+' '+prompt;
 const shotMap=new Map(resources.shots.map(s=>[s.id,s])),sourceMap=new Map(library.sources.map(s=>[s.id,s]));
 const catalog=()=>({assets:library.sources.map(s=>({assetId:s.id,mediaId:s.id,sourceFps:fpsOf(s.fps),sourceDurationFrames:Math.floor(s.duration*fpsOf(s.fps)),src:s.url,width:960,height:540})),shots:resources.shots.map(s=>({shotId:s.id,assetId:s.sourceId,sourceIn:s.startFrame,sourceOut:s.endFrame,safeRanges:s.safeRanges.map(r=>({sourceIn:r.startFrame,sourceOut:r.endFrame}))}))});
 const compile=(request,project=p)=>compileTechnique(request,{...project,madCatalog:catalog()}).ops;
 const boundaryProtected=new Set();for(const t of p.timeline.transitions||[])if(targets.has(t.leftClipId)!==targets.has(t.rightClipId)){const id=targets.has(t.leftClipId)?t.leftClipId:t.rightClipId;boundaryProtected.add(id);notes.push({id,reason:'现有转场跨越选区边界，保护边界画面；可将相邻镜头一并选中'});}
 const order=p.timeline.items.filter(i=>targets.has(i.id)).sort((a,b)=>a.from-b.from);let modelMs=0,addedEffects=0,lastEffect=-Infinity;const effectBudget=Math.max(1,Math.ceil((scope.to-scope.from)/p.metadata.fps/4));
 const compare=async(stage,input)=>{if(cancelled())fail('已取消，时间轴未修改',499);const r=await ask(input);modelMs+=r.ms;decisions.push({stage,input,output:r.result,ms:r.ms});return r.result.answers;};
 for(let n=0;n<order.length;n++){
  if(cancelled())fail('已取消，时间轴未修改',499);let item=p.timeline.items.find(i=>i.id===order[n].id);onProgress({done:n,total:order.length,phase:`Winnow ${n+1}/${order.length} · ${item.label||'镜头'}`});
  if(boundaryProtected.has(item.id))continue;
  const current=shotMap.get(item.mad?.shotId),role=current?.directorRole||String(item.label||'').split(' · ')[0];
  const all=p.timeline.items.filter(i=>i.type==='video').sort((a,b)=>a.from-b.from),pos=all.findIndex(i=>i.id===item.id),previous=all.slice(Math.max(0,pos-3),pos),next=all.slice(pos+1,pos+3);
  const linked=p.timeline.items.filter(i=>i.type==='audio'&&i.trackId==='source-audio'&&overlap([i.from,end(i)],[item.from,end(item)]));
  const audioProtected=linked.some(a=>locked(p,a)||a.from<item.from||end(a)>end(item)||!/^sfx-|^director-audio-/.test(a.id));
  let canReplace=allowed.shots!==false&&!audioProtected&&(audioMode!=='preserve'||!linked.length&&((item.volume??0)<=-55||item.embeddedAudioMuted));
  if(allowed.shots!==false&&(!canReplace))notes.push({id:item.id,reason:'保留关联声音或跨界完整台词，本次只优化镜头表现'});
  const context={goal,prompt,position:{from:item.from/p.metadata.fps,to:end(item)/p.metadata.fps,role},previous:previous.map(i=>i.label),next:next.map(i=>i.label),music:{name:library.music.find(m=>p.timeline.items.some(i=>i.trackId==='music'&&i.mediaId===m.id))?.name,understanding:await cachedMusicContext(p,item,library.music.find(m=>p.timeline.items.some(i=>i.trackId==='music'&&i.mediaId===m.id)))}};
  if(canReplace){const intent=body.plan?.sections?.find(s=>s.start<=item.from/p.metadata.fps&&s.end>item.from/p.metadata.fps)?.intent||item.mad?.intent||'';const result=await chooseShot({project:p,item,goal,prompt,intent,library,resources,ask,cancelled,manageAudio:true,reserveFrames:1});modelMs+=result.timing.modelMs;
    decisions.push({stage:'全库选镜 '+(n+1),input:result.trace.context,output:{answers:{pick:{choice:result.trace.selected.shotId}},scope:result.trace.rounds.at(-1)?.scope},ms:result.timing.modelMs,traceUrl:result.traceUrl,searchScope:result.trace.rounds.at(-1)?.scope,timing:result.timing});
    if(result.trace.noSuitableCandidate)notes.push({id:item.id,reason:'全库两轮候选仍未满足，保留当前画面'});
    item=result.selected.item;p.timeline.items=p.timeline.items.map(i=>i.id===item.id?item:i);
  }
  const shot=shotMap.get(item.mad?.shotId),sfps=item.sourceFps||p.metadata.fps,sourceStart=item.sourceStart/sfps,sourceEnd=item.sourceEnd/sfps;
  const speech=(shot?.cues||[]).filter(c=>isSpeechCue(c)&&c.start<sourceEnd&&c.end>sourceStart),sound=(shot?.semantic?.audio_events||[]).find(e=>e.start<sourceEnd&&e.end>sourceStart&&!/对白|旁白|speech|dialogue|音乐|music/i.test(e.type));
  const choices={},effectOps={},transitionOps={},edge=previous.at(-1),existingEdge=(p.timeline.transitions||[]).find(t=>t.leftClipId===edge?.id&&t.rightClipId===item.id);
  if(allowed.effects&&addedEffects<effectBudget&&item.from-lastEffect>=p.metadata.fps*1.5){effectOps.keep=[];for(const [key,scale,rgb]of [['push',1.06,0],['impact',1.13,.004]])try{effectOps[key]=compile({technique:'impact',requestId:'live-'+randomUUID().slice(0,8),occurrenceId:item.id,localFrame:0,durationInFrames:Math.min(8,item.durationInFrames-1),scale,rgbAmount:rgb});}catch{}if(Object.keys(effectOps).length>1)choices.effect={type:'choice',instructions:'选择是否加强当前动作或情绪重音。持续性效果密度要克制，不需要时保留。',criteria:Object.fromEntries(Object.keys(effectOps).map(k=>[k,{keep:'保持效果',push:'短促6%推近',impact:'13%重音推近与轻微色差'}[k]]))};}
  if(allowed.grade)choices.grade={type:'choice',instructions:'结合全片目标与刚修改的前文选择色调，保留原有其他效果。',criteria:{keep:'保持调色',neutral:'去除当前冷暖/饱和度调色，回到原色',cool:'冷峻、饱和度0.86',warm:'轻暖、饱和度1.05'}};
  if(allowed.transitions&&edge&&targets.has(edge.id)&&end(edge)===item.from){transitionOps.keep=null;transitionOps.hard=[];const temp={...p,timeline:{...p.timeline,transitions:(p.timeline.transitions||[]).filter(t=>t!==existingEdge)}};for(const kind of ['dissolve','dipToColorDissolve','blurDissolve','chromatic','glitch','lensWarpZoom'])try{transitionOps[kind]=compile({technique:'transition',requestId:'edge-'+randomUUID().slice(0,8),leftOccurrenceId:edge.id,rightOccurrenceId:item.id,durationInFrames:Math.min(6,edge.durationInFrames-1,item.durationInFrames-1),presentation:kind},temp);}catch{}if(Object.keys(transitionOps).length>2||existingEdge)choices.entry={type:'choice',instructions:'比较当前两镜的视觉和情绪衔接；只有有表达作用才选择转场。这里所有选项都已校验源镜头余量。',criteria:Object.fromEntries(Object.keys(transitionOps).map(k=>[k,{keep:'保持现有衔接',hard:'硬切',dissolve:'短叠化',dipToColorDissolve:'短压暗，循环重启',blurDissolve:'短模糊叠化',chromatic:'短色差错位',glitch:'短故障跳切',lensWarpZoom:'短镜头推拉衔接'}[k]]))};}
  const audioCanManage=!audioProtected&&audioMode!=='preserve';
  if(audioCanManage&&['auto','sfx'].includes(audioMode)){const hasSound=!!sound&&!speech.length,hasSpeech=audioMode==='auto'&&speech.length&&speech.every(c=>c.start>=sourceStart&&c.end<=sourceEnd);if(hasSound||hasSpeech)choices.audio={type:'choice',instructions:'原声是原片混音，不是分离人声。优先保留清楚完整的有效声音，不能与歌曲人声争抢。',criteria:{mute:'关闭这段原声',...(hasSound?{sfx:'保留动作原声并稍压低配乐'}:{}),...(hasSpeech?{dialogue:'保留完整原声台词并压低配乐'}:{})}};}
  const answers=Object.keys(choices).length?await compare('镜头表现 '+(n+1),{state:{...context,current:item.label,previous:edge?.label,sourceSpeech:speech,sourceSound:sound,recentDecisions:decisions.slice(-3).map(d=>d.output.answers)},questions:choices}):{};
  if(answers.effect&&answers.effect.choice!=='keep'){p=applyDirectorOps(p,effectOps[answers.effect.choice]||[]);addedEffects++;lastEffect=item.from;}
  if(answers.grade&&answers.grade.choice!=='keep'){const target=p.timeline.items.find(i=>i.id===item.id),removed=new Set((target.effects||[]).filter(e=>['gpu-temperature','gpu-saturation'].includes(e.effect?.gpuEffectType)).map(e=>e.id));const animated=p.timeline.keyframes?.find(k=>k.itemId===item.id)?.properties?.some(prop=>[...removed].some(id=>prop.property.includes(':'+id+':')));if(!animated){target.effects=(target.effects||[]).filter(e=>!removed.has(e.id));const effects=presets[answers.grade.choice];if(effects?.length)p=applyDirectorOps(p,compile({technique:'grade',requestId:'grade-'+randomUUID().slice(0,8),occurrenceIds:[item.id],effects}));}else notes.push({id:item.id,reason:'现有调色带关键帧，已保留'});}
  if(answers.entry&&answers.entry.choice!=='keep'){p.timeline.transitions=(p.timeline.transitions||[]).filter(t=>t!==existingEdge&&t.id!==existingEdge?.id);p=applyDirectorOps(p,transitionOps[answers.entry.choice]||[]);}
  if(audioCanManage){p.timeline.items=p.timeline.items.filter(i=>!linked.some(a=>a.id===i.id));const target=p.timeline.items.find(i=>i.id===item.id);target.volume=-60;target.embeddedAudioMuted=true;let pick=audioMode==='original'?'original':answers.audio?.choice;
   if(pick&&pick!=='mute'){const a=pick==='sfx'?Math.max(sourceStart,sound.start):sourceStart,b=pick==='sfx'?Math.min(sourceEnd,sound.end):sourceEnd,from=item.from+Math.round((a-sourceStart)*p.metadata.fps/(item.speed||1)),duration=Math.min(end(item)-from,Math.max(1,Math.round((b-a)*p.metadata.fps/(item.speed||1))));p.timeline.items.push({id:'director-audio-'+randomUUID(),type:'audio',trackId:'source-audio',from,durationInFrames:duration,label:pick==='sfx'?sound.description:pick==='dialogue'?speech.map(c=>c.text).join(' '):'保留原片混音',mediaId:item.mediaId,src:item.src,sourceStart:Math.round(a*sfps),sourceEnd:Math.round(b*sfps),sourceFps:sfps,sourceDuration:item.sourceDuration,speed:item.speed||1,volume:pick==='dialogue'?9:pick==='sfx'?-3:-6,audioFadeIn:0,audioFadeOut:0,mad:{audioFor:item.id},...(pick==='dialogue'?{audioDucking:{duckOthersDb:-20,attackSec:0,releaseSec:0,targetTrackIds:['music']}}:{})});}}
 }
 if(audioMode==='mute'){
   const intervals=scope.intervals.sort((a,b)=>a[0]-b[0]).reduce((a,r)=>{if(a.length&&r[0]<=a.at(-1)[1])a.at(-1)[1]=Math.max(a.at(-1)[1],r[1]);else a.push([...r]);return a;},[]);
   for(const audio of p.timeline.items.filter(i=>i.type==='audio'&&i.trackId==='source-audio')){
    if(locked(p,audio))continue;const padBefore=(audio.audioDucking?.attackSec||0)*p.metadata.fps,padAfter=(audio.audioDucking?.releaseSec||0)*p.metadata.fps;
    if(intervals.some(r=>r[0]<=Math.max(0,audio.from-padBefore)&&r[1]>=Math.min(project.duration*p.metadata.fps,end(audio)+padAfter)))p.timeline.items=p.timeline.items.filter(i=>i.id!==audio.id);
    else if(intervals.some(r=>overlap(r,[audio.from,end(audio)])))notes.push({id:audio.id,reason:'原声或配乐压低包络跨越选区边界，已保护；扩大选区可关闭整段声音'});
   }
   for(const item of p.timeline.items.filter(i=>targets.has(i.id))){item.volume=-60;item.embeddedAudioMuted=true;}
 }
 if(cancelled())fail('已取消，时间轴未修改',499);
 const changedVideoIds=p.timeline.items.filter(i=>targets.has(i.id)&&JSON.stringify(i)!==JSON.stringify(project.timeline.items.find(x=>x.id===i.id))).map(i=>i.id);
 return {project:p,scope,decisions,notes,changedVideoIds,timelineChanged:JSON.stringify(p.timeline)!==JSON.stringify(project.timeline),timing:{modelMs,computeMs:performance.now()-started},targetIds:[...targets]};
}
export function getEditJob(id){const job=jobs.get(id);if(!job)fail('任务不存在或服务已重启',404);return job;}
export async function startEditJob(body,library){const state=await studioState(library);if(body.baseRevision!==state.revision)fail('工程已有新版本',409);resolveEditScope(state.project,body.scope);const ticket=beginEditEpoch(state.project.id),id=randomUUID(),job={id,status:'running',done:0,total:0,phase:'准备选区',cancelRequested:false,startedAt:Date.now()};jobs.set(id,job);
 void (async()=>{try{let plan;try{const r=JSON.parse(await readFile(path.join(studioStore,'director','latest.json'),'utf8'));if(state.project.timeline.items.some(i=>i.trackId==='music'&&i.mediaId===r.plan?.musicId))plan=r.plan;}catch{}const resources=await liveDirectorResources(root),result=await runScopedEdit({project:state.project,body:{...body,plan},library,resources,ask:b=>decide(b,path.join(studioStore,'scope-edits',id)),onProgress:p=>{Object.assign(job,p);notifyJob(id);},cancelled:()=>job.cancelRequested||!ticket.current()});if(job.cancelRequested||!ticket.current())fail('已取消或被新请求替代，时间轴未修改',499);job.status='committing';const saved=result.timelineChanged?await mutateStudio(library,state.revision,()=>{if(!ticket.current())fail('请求已失效',499);return result.project;},'Winnow scoped '+body.operation):await studioState(library);if(!result.timelineChanged&&saved.revision!==state.revision)fail('工程已有新修改，请重试',409);const {project:_,...detail}=result;job.result={...detail,state:saved,timing:{...detail.timing,totalMs:Date.now()-job.startedAt}};job.status='complete';job.done=job.total;job.phase='已应用，可撤销';notifyJob(id);await mkdir(path.join(studioStore,'scope-edits',id),{recursive:true});await writeFile(path.join(studioStore,'scope-edits',id,'result.json'),JSON.stringify({...detail,revision:saved.revision},null,2));}catch(e){job.status=e.status===499?'cancelled':'error';job.error=e.message;job.phase=e.message;notifyJob(id);}})();
 return {id,status:job.status};}
export function cancelEditJob(id){const job=getEditJob(id);if(job.status==='running')job.cancelRequested=true;return {id,status:job.status,cancelRequested:job.cancelRequested};}
