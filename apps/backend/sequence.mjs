import {expectedSourceCount} from './release-runtime.mjs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {planEdit,slotsFromPlan} from './planning.mjs';
import {analyzeMusicIntent} from './music-intent.mjs';
import {refineCandidates} from './cut-safety.mjs';
import {musicEvents,firstRhythmicEntry,chooseAccentPolicies,shapeAroundAccents} from './rhythm.mjs';
import {selectSourceSound} from './source-sound.mjs';
import {removeRepeatedSequences} from './repeated-sequences.mjs';
import {clamp,dialogueUnits,isSpeechCue,validateProject} from './core.mjs';

export function makeCandidates(slot,shots,{keepDialogue=true,max=220}={}){
  const length=slot.end-slot.start,out=[];
  for(const shot of shots){
    if(shot.excluded||shot.semanticStatus!=='complete')continue;
    let best=null;
    for(const range of shot.safeRanges||[{start:shot.start,end:shot.end,anchor:shot.anchor,thumb:shot.thumb}]){
      const low=range.start+.002,high=range.end-.002;
      if(high-low<length)continue;
      const cue=keepDialogue?dialogueUnits(shot.contextCues||shot.cues||[]).filter(c=>c.start>=low&&c.end<=high&&c.end-c.start<=length-.12&&!/[・、,→➡]\s*$/.test(c.text)).sort((a,b)=>b.text.length-a.text.length)[0]:null;
      const action=cue?null:(shot.semantic?.actions||[]).filter(a=>a.peak!==null&&a.confidence>=.65&&a.peak>=low&&a.peak<high).sort((a,b)=>b.confidence-a.confidence)[0];
      for(const rate of cue?[1]:[1,1.15,1.35]){
      if(length*rate>high-low)continue;
      const anchor=cue?cue.start:action?.peak??clamp(range.anchor??shot.anchor??(low+high)/2,low,high-.02);
      let sourceIn=clamp(anchor-(slot.accent-slot.start)*rate,low,high-length*rate);
      if(cue)sourceIn=clamp(cue.start-.08,Math.max(low,cue.end-length),Math.min(cue.start,high-length));
      const sourceOut=sourceIn+length*rate;
      if((shot.repeatedBands||[]).some(b=>sourceIn<b.end&&sourceOut>b.start))continue;
      const actionCoverage=action?Math.max(0,Math.min(sourceOut,action.end)-Math.max(sourceIn,action.start))/Math.max(.01,action.end-action.start):1;
      // Dense MAD may show an impact phase, but must include its estimated peak.
      if(action&&(anchor<sourceIn||anchor>=sourceOut||actionCoverage<(length<1.1?.18:.5)))continue;
      const anchorOutput=slot.start+(anchor-sourceIn)/rate,anchorError=Math.abs(anchorOutput-slot.accent);
      const fit=slot.energy*shot.motion+(1-slot.energy)*(1-shot.motion),preferred=slot.preferred.includes(shot.id)?1:0;
      const release=slot.accentRole==='primary',impact=action&&/命中|爆|击|挥|发动|释放|跃|射|impact|release/i.test(action.phase+' '+action.action);
      const localScore=(shot.semanticScore||0)/3*.55+preferred*.5+fit*.25+(shot.semantic?.usable_quality||0)*.2+Math.min(1,actionCoverage)*.12-Math.min(anchorError,1)*.35-Math.abs(1-rate)*.08+(release?(impact?.55:0)+shot.motion*.45:0);
      const sfx=cue?null:(shot.semantic?.audio_events||[]).find(e=>/音效|撞击|枪|爆|脚步|破空|impact|effect|sfx/i.test(e.type+' '+e.description)&&!/(对白|speech|dialogue)/i.test(e.type)&&e.start>=sourceIn&&e.end<=sourceOut&&!(shot.cues||[]).some(c=>isSpeechCue(c)&&c.start<e.end&&c.end>e.start));
      const candidate={shot,range,sourceIn,sourceOut,rate,anchor,anchorOutput,anchorError,cue,sfx,localScore};
      if(!best||candidate.localScore>best.localScore)best=candidate;
      }
    }
    if(best)out.push(best);
  }
  out.sort((a,b)=>b.localScore-a.localScore);
  return out.slice(0,max);
}

export function transitionAllowed(history,candidate){
  const shot=candidate.shot,last=history.at(-1);
  for(const [index,c] of history.entries()){
    if(c.shotId===shot.id)return false;
    if(c.sourceId!==shot.sourceId)continue;
    const out=c.sourceIn+(c.end-c.start)*c.rate;
    if(candidate.sourceIn<out-.02&&candidate.sourceOut>c.sourceIn+.02)return false;
    const nearby=Math.abs(candidate.sourceIn-c.sourceIn)<12||c.sceneId&&c.sceneId===shot.sceneId;
    const continuedRun=history.slice(index).every(item=>item.sourceId===shot.sourceId&&(item.sceneId===shot.sceneId||Math.abs(item.sourceIn-candidate.sourceIn)<12));
    if(nearby&&(!continuedRun||candidate.sourceIn<out-.04))return false;
  }
  return true;
}
export function toClip(slot,c,decision){const voice=c.cue,sfx=c.sfx;return {id:randomUUID(),sourceId:c.shot.sourceId,shotId:c.shot.id,sceneId:c.shot.sceneId,episode:c.shot.episode,
  start:slot.start,end:slot.end,sourceIn:c.sourceIn,rate:c.rate,gain:voice?1:(sfx?0.55:0),
  audioWindow:voice?{start:voice.start,end:voice.end}:sfx?{start:sfx.start,end:sfx.end}:null,
  sourceAudioKind:voice?'dialogue':sfx?'effect':'none',sourceAudioDescription:sfx?.description||'',dialogue:voice?.text||'',
  anchor:c.anchor,anchorOutput:c.anchorOutput,anchorMethod:c.shot.anchorMethod,title:c.shot.description,
  safety:c.shot.safeRanges?{start:c.range.start,end:c.range.end,guardFrames:c.range.guardFrames,method:c.range.method}:null,
  accentRole:slot.accentRole,accentPolicy:slot.accentPolicy,openingClimax:slot.openingClimax,
  phase:slot.phase,effect:'none',locked:false,decision};}

export async function generateSequence(library,options,{decide,rank,logDir,onProgress}){
  const started=performance.now(),{musicId,prompt='',keepDialogue=true,episodeIds}=options;
  const music=library.music.find(m=>m.id===musicId);if(!music)throw Error('请先导入配乐');
  const duration=Math.min(Number(options.duration||30),music.duration);if(!Number.isFinite(duration)||duration<5||duration>300)throw Error('支持 5–300 秒');
  const originals=library.sources.filter(s=>s.semanticStatus==='complete'&&(!episodeIds?.length||episodeIds.includes(s.episode)));
  const repeats=await removeRepeatedSequences(originals),sources=repeats.sources;
  if(!episodeIds?.length&&sources.length<expectedSourceCount(library))throw Error(`全库 Gemini 理解尚未完成（${sources.length}/全部素材），不会再默认只用第一集生成`);
  if(sources.length<2)throw Error('跨集剪辑至少需要两集完成 Gemini 理解的素材');
  const scope={...library,sources};let retrievalMetrics={};
  onProgress({progress:.02,stage:'先听音乐：识别乐句、情绪、重音和人声留白'});
  const events=await musicEvents(music),beatSeconds=60/music.bpm;events.firstEntry=firstRhythmicEntry(events,beatSeconds);
  const musicIntent=await analyzeMusicIntent(music,{forceReanalyze:options.reanalyzeMusic===true});
  const intensity=options.intensity??musicIntent.suggested_intensity,allowDialogue=keepDialogue&&musicIntent.dialogue_suitability>=.5;
  const brief=[musicIntent.edit_direction,...musicIntent.retrieval_queries,prompt&&'用户额外偏好：'+prompt].filter(Boolean).join('\n').slice(0,1800);
  onProgress({progress:.09,stage:`按音乐方向检索全部 ${sources.length} 集的画面与原声`});
  const recalled=await rank(scope,brief,logDir,s=>retrievalMetrics=s,{episodeIds,limit:220,perEpisode:20});
  onProgress({progress:.12,stage:'复检候选中的切镜与转场，建立安全入出点'});
  const refined=await refineCandidates(sources,recalled),shots=refined.shots;
  onProgress({progress:.15,stage:'结合音乐乐句与实际可用镜头安排剪辑'});
  const plan=await planEdit(music,shots,{duration,prompt:brief,intensity,keepDialogue:allowDialogue,events,musicIntent});
  const accents=await chooseAccentPolicies(events,musicIntent,plan,{decide,logDir});
  const locked=(library.project?.clips||[]).filter(c=>c.locked);
  const baseSlots=slotsFromPlan(plan,music,duration,locked);
  const slots=locked.length?baseSlots:shapeAroundAccents(baseSlots,accents.anchors,beatSeconds);if(slots.length>600)throw Error('规划切换过密');
  let beams=[{clips:[],score:0}],calls=accents.calls,modelMs=accents.ms;
  for(let index=0;index<slots.length;index++){
    const slot=slots[index];if(slot.lockedClip){beams=beams.map(b=>({...b,clips:[...b.clips,structuredClone(slot.lockedClip)]}));continue;}
    const pool=makeCandidates(slot,shots,{keepDialogue:allowDialogue,max:220});
    const edges=[];
    beams.forEach((beam,bi)=>{const counts=new Map(),valid=pool.filter(c=>transitionAllowed(beam.clips,c));
      const selected=valid.filter(c=>{const n=counts.get(c.shot.episode)||0;if(n>=2)return false;counts.set(c.shot.episode,n+1);return true;}).slice(0,6);
      // Audible candidates must reach Winnow; visual-only preselection previously erased all sound.
      const add=(candidate,position)=>{if(candidate&&!selected.some(c=>c.shot.id===candidate.shot.id))selected.splice(Math.min(position,selected.length),1,candidate);};
      if(allowDialogue&&!beam.clips.some(c=>c.dialogue))add(valid.find(c=>c.cue),4);
      add(valid.find(c=>c.sfx),5);
      selected.forEach(c=>edges.push({beam,bi,c,key:'e'+edges.length}));});
    if(!edges.length){
      const extended=beams.flatMap(beam=>{const last=beam.clips.at(-1);if(!last||last.locked||Math.abs(last.end-slot.start)>.04)return [];
        const shot=shots.find(s=>s.id===last.shotId);if(!shot||last.sourceIn+(slot.end-last.start)*last.rate>(last.safety?.end??shot.end)-.002)return [];
        return [{score:beam.score-.1,clips:[...beam.clips.slice(0,-1),{...last,end:slot.end,decision:{...last.decision,heldToCompletePhrase:true}}]}];});
      if(extended.length){beams=extended;onProgress({progress:.18+.8*(index+1)/slots.length,stage:'延续已有动作，完成当前乐句'});continue;}
      throw Error(`第 ${slot.start.toFixed(2)} 秒没有保持动作范围与去重约束的候选；未覆盖现有时间轴`);
    }
    const unique=[...new Map(edges.map(e=>[e.c.shot.id,e.c])).values()].slice(0,12);
    const usable=edges.filter(e=>unique.some(c=>c.shot.id===e.c.shot.id));
    const images=await Promise.all(unique.map(async c=>{const s=sources.find(s=>s.id===c.shot.sourceId);return 'data:image/jpeg;base64,'+(await readFile(path.join(s.dir,c.range.thumb||c.shot.thumb))).toString('base64');}));
    const states=beams.map((b,i)=>({id:'p'+i,previous:b.clips.slice(-2).map(c=>({episode:c.episode,summary:c.title.slice(0,90),dialogue:c.dialogue,source_range:[c.sourceIn,c.sourceIn+(c.end-c.start)*c.rate]}))}));
    const candidates=unique.map((c,i)=>({id:c.shot.id,image:i+1,episode:c.shot.episode,summary:c.shot.description.slice(0,100),subjects:c.shot.characters,direction:c.shot.semantic?.screen_direction,
      emotion:c.shot.semantic?.emotion,shot_size:c.shot.semantic?.shot_size,action:c.shot.semantic?.actions?.map(a=>a.action.slice(0,40)).slice(0,2),dialogue:c.cue?.text||'',sound:c.sfx?.description?.slice(0,60)||'',rate:c.rate,source_range:[c.sourceIn,c.sourceOut],anchor_error:+c.anchorError.toFixed(3)}));
    const {result,ms}=await decide({state:{brief,section:slot.phase,slot:{start:slot.start,end:slot.end,accent:slot.accent,role:slot.accentRole,policy:slot.accentPolicy,openingClimax:slot.openingClimax},audio_intent:slot.audioIntent,predecessors:states,candidates},questions:Object.fromEntries(usable.map(e=>[e.key,{type:'score',instructions:`Evaluate ${e.c.shot.id} after p${e.bi}. Use images, action phase, continuity and accent role. Opening climax must release immediate visual impact, not delay with an establishing shot. Primary: action/visual peak; anticipation: tension; rhythmic: coherent motion. Do not reward motion alone.`,criteria:['衔接差或意图不符','勉强可用','衔接合适','连贯且有表现力']}])) ,winnow:{images}},logDir);
    calls++;modelMs+=ms;
    const expanded=usable.map(e=>{const answer=result.answers?.[e.key];if(!Number.isFinite(answer?.score))throw Error('Winnow 未返回有效镜头衔接评分');
      const seen=new Set(e.beam.clips.map(c=>c.episode)),newEpisode=seen.has(e.c.shot.episode)?0:.03;
      const count=e.beam.clips.filter(c=>c.episode===e.c.shot.episode).length,concentration=Math.max(0,count-8)*.02;
      const audible=e.c.cue&&!e.beam.clips.some(c=>c.dialogue)?.5:e.c.sfx?.15:0;
      const score=e.beam.score+answer.score/3+e.c.localScore*.25+newEpisode-concentration+audible;
      return {score,clips:[...e.beam.clips,toClip(slot,e.c,{source:'Winnow 镜头对评分 + 束搜索',model:result.model,score:answer.score,confidence:answer.confidence,ms})]};
    }).sort((a,b)=>b.score-a.score);
    beams=expanded.slice(0,4);
    onProgress({progress:.18+.8*(index+1)/slots.length,stage:`比较第 ${index+1}/${slots.length} 个镜头的衔接与后续路线`});
  }
  const best=beams[0],episodesUsed=[...new Set(best.clips.map(c=>c.episode))].sort((a,b)=>a-b);
  onProgress({progress:.99,stage:'逐段判断哪些原声音效能强化动作与音乐重音'});
  const sound=await selectSourceSound(sources,best.clips,brief,{decide,logDir});calls+=sound.calls;modelMs+=sound.ms;
  return validateProject({id:randomUUID(),revision:1,musicId,duration,prompt,intensity,keepDialogue,musicGain:.7,clips:best.clips,plan,musicIntent,musicEvents:events,accentDecisions:accents.anchors,sourceSoundDecisions:sound.decisions,cutSafety:refined.audit,repeatedSequencesExcluded:repeats.excluded,style:'dense-mad-early-release',generationMode:'music-first',createdAt:new Date().toISOString(),
    coverage:{episodesSearched:sources.map(s=>s.episode),episodesUsed,catalogShots:sources.reduce((n,s)=>n+s.shots.length,0)},
    metrics:{calls:calls+(retrievalMetrics.calls||0),modelMs:modelMs+(retrievalMetrics.modelMs||0),musicAnalysisMs:musicIntent.metrics.ms,musicAnalysisCached:musicIntent.cached,plannerMs:plan.metrics.ms,plannerCached:plan.cached,totalMs:performance.now()-started,retrieval:retrievalMetrics,search:'beam width 4; no temporal overlap or reverse reuse'}},library);
}
