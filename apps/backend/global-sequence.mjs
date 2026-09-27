import {expectedSourceCount} from './release-runtime.mjs';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {globalResources} from './global-evidence.mjs';
import {chooseGlobalShot} from './global-director.mjs';
import {runScopedEdit} from './director-edit.mjs';
import {musicEvents,firstRhythmicEntry,chooseAccentPolicies,shapeAroundAccents} from './rhythm.mjs';
import {analyzeMusicIntent} from './music-intent.mjs';
import {planEdit,slotsFromPlan} from './planning.mjs';
import {migrateLegacyProject} from './studio-project.mjs';
import {validateProject} from './core.mjs';
export async function generateGlobalSequence(library,options,{decide,logDir,onProgress}){
  const started=performance.now(),music=library.music.find(m=>m.id===options.musicId);if(!music)throw Error('请先导入配乐');
  const duration=Math.min(Number(options.duration||20),music.duration);if(!Number.isFinite(duration)||duration<5||duration>300)throw Error('支持5–300秒');
  const resources=await globalResources(),scope=resources.shots.filter(s=>!s.excluded&&s.semanticStatus==='complete');
  if(new Set(scope.map(s=>s.episode)).size<expectedSourceCount(library))throw Error('全量素材语义尚未就绪');
  const progress=onProgress||(()=>{}),ask=body=>decide(body,logDir),events=await musicEvents(music),beat=60/music.bpm;events.firstEntry=firstRhythmicEntry(events,beat);
  progress({progress:.02,stage:'理解音乐与用户目标，不建立项目素材池'});
  const intent=await analyzeMusicIntent(music,{forceReanalyze:options.reanalyzeMusic===true});
  const goal=options.prompt||intent.edit_direction;
  const plan=await planEdit(music,[],{duration,prompt:goal+'\n'+intent.edit_direction,intensity:options.intensity??intent.suggested_intensity,keepDialogue:options.keepDialogue!==false&&intent.dialogue_suitability>=.5,events,globalScope:true,musicIntent:intent});
  const accent=await chooseAccentPolicies(events,intent,plan,{decide,logDir});
  const locked=(library.project?.clips||[]).filter(c=>c.locked),base=slotsFromPlan(plan,music,duration,locked),slots=locked.length?base:shapeAroundAccents(base,accent.anchors,beat);
  let project=migrateLegacyProject({...library,project:{musicId:music.id,duration,clips:[],musicGain:.65}});project.name='Winnow · 全库逐镜剪辑';project.description=goal;const traces=[];
  for(const [index,slot]of slots.entries()){
    if(slot.lockedClip){const imported=migrateLegacyProject({...library,project:{musicId:music.id,duration,clips:[slot.lockedClip]}});project.timeline.items.push(...imported.timeline.items.filter(i=>i.trackId!=='music'));continue;}
    const from=Math.round(slot.start*30),to=Math.round(slot.end*30);if(to<=from)continue;
    const placeholder={id:randomUUID(),type:'video',trackId:'picture',from,durationInFrames:to-from,label:slot.phase,mediaId:'',src:'',sourceStart:0,sourceEnd:0,sourceFps:24,speed:1,volume:-60,embeddedAudioMuted:true,sourceWidth:960,sourceHeight:540,transform:{x:0,y:0,width:960,height:540,rotation:0,opacity:1,aspectRatioLocked:true}};
    project.timeline.items.push(placeholder);progress({progress:.15+.7*index/slots.length,stage:`第${index+1}/${slots.length}镜：重新查询全部${scope.length}个镜头`});
    const result=await chooseGlobalShot({project,item:placeholder,library,resources,goal,prompt:options.prompt||'',intent:slot.phase,ask,allowKeep:false,reserveFrames:1});
    project.timeline.items=project.timeline.items.map(i=>i.id===placeholder.id?result.selected.item:i);traces.push({occurrenceId:placeholder.id,...result.trace,traceUrl:result.traceUrl});await mkdir(logDir,{recursive:true});await writeFile(path.join(logDir,'in-progress.json'),JSON.stringify({project,traces,completed:index+1,total:slots.length},null,2));
  }
  progress({progress:.9,stage:'Winnow按实际前后镜头决定原声、转场、效果和调色'});
  const polished=await runScopedEdit({project,library,resources,ask,body:{scope:{mode:'all'},goal,prompt:intent.edit_direction,audioMode:options.keepDialogue===false?'sfx':'auto',allowed:{shots:false,effects:true,transitions:true,grade:true}}});project=polished.project;
  const shots=new Map(resources.shots.map(s=>[s.id,s])),clips=project.timeline.items.filter(i=>i.type==='video').sort((a,b)=>a.from-b.from).map(i=>{const s=shots.get(i.mad.shotId),r=s.safeRanges.find(r=>r.startFrame<=i.sourceStart&&r.endFrame>=i.sourceEnd);if(!r)throw Error('源窗口校验失败');return{id:i.id,sourceId:i.mediaId,shotId:s.id,sceneId:s.sceneId,episode:s.episode,start:i.from/30,end:(i.from+i.durationInFrames)/30,sourceIn:i.sourceStart/i.sourceFps,rate:i.speed||1,gain:0,effect:'none',title:s.description,dialogue:'',safety:{start:r.startFrame/i.sourceFps,end:r.endFrame/i.sourceFps,guardFrames:2,method:'native boundary review'},decision:{source:'Winnow full corpus per decision'},locked:!!i.locked};});
  const result=validateProject({id:randomUUID(),musicId:music.id,duration,prompt:options.prompt||'',intensity:options.intensity??intent.suggested_intensity,keepDialogue:options.keepDialogue!==false,musicGain:.65,clips,nativeProject:project,insertionDecisions:polished.decisions,plan,musicIntent:intent,musicEvents:events,globalDecisions:traces,coverage:{episodesSearched:[...new Set(scope.map(s=>s.episode))],episodesUsed:[...new Set(clips.map(c=>c.episode))],catalogShots:resources.shots.length},metrics:{totalMs:performance.now()-started,calls:traces.reduce((n,t)=>n+t.calls.length,0)+polished.decisions.length+accent.calls,modelMs:traces.reduce((n,t)=>n+t.timing.modelMs,0)+polished.timing.modelMs+accent.ms},createdAt:new Date().toISOString()},library);
  await mkdir(logDir,{recursive:true});await writeFile(path.join(logDir,'global-production.json'),JSON.stringify(result,null,2));return result;
}
