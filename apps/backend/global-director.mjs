import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {recallForDecision} from './decision-recall.mjs';
import {candidatePolicyVersion,neutralCandidateOrder,modelRankedCandidates,usageEvidence,scoreSemanticPages,windowMenu,basicFitFacts,basicFitRequest} from './candidate-selection.mjs';
import {globalResources,prepareGlobalShots,windowEvidence} from './global-evidence.mjs';
import {buildLiveReplacements,unmarkedSourceReplay} from './director-live.mjs';
import {cachedMusicEvents} from './rhythm.mjs';
import {cachedMusicContext} from './music-intent.mjs';
import {root} from './catalog.mjs';
import {decide} from './winnow.mjs';
import {semanticKey,cachedSemantic,saveSemantic,semanticMusicContext} from './semantic-decision-cache.mjs';
import {shotQuery} from './query-vectors.mjs';
import {visionSelectionEnabled} from './decision-settings.mjs';
import {storyContext,windowFacts,connectionEvidence,continuationCandidates,candidateRejections,carryWindow} from './story-continuity.mjs';
import {narrativeRejections} from './narrative-policy.mjs';
const fail=m=>{const e=Error(m);e.status=499;throw e;};
export async function chooseGlobalShot({project,item,goal='',prompt='',intent='',library,resources,ask,cancelled=()=>false,manageAudio=false,reserveFrames=1,allowKeep=true,prewarmEvidence=true,visionEnabled,adaptiveVisual=false,onStage=()=>{},durationOptions,narrative},{recall=recallForDecision,prepare=prepareGlobalShots,evidence=windowEvidence,events=cachedMusicEvents}={}){
  const started=performance.now(),id=randomUUID(),folder=path.join(root,'.local/studio/global-decisions',id);await mkdir(folder,{recursive:true});
  resources??=await globalResources();visionEnabled=await visionSelectionEnabled(visionEnabled);const askModel=ask||((body)=>decide(body,folder));let modelMs=0;
  const stages={contextMs:0,recallMs:0,semanticMs:0,safetyMotionMs:0,windowCompileMs:0,framesMs:0,visionMs:0,textSelectionMs:0,persistMs:0};const calls=[],check=()=>{if(cancelled())fail('请求已取消或已被更新的修改替代');};
  const compare=async(stage,body,images=[])=>{check();onStage(stage);const r=await askModel(body);check();modelMs+=r.ms;calls.push({stage,input:{...body,...(body.winnow?{winnow:{...body.winnow,images:images.map(x=>x.url)}}:{})},output:r.result,ms:r.ms,clientQueueMs:r.clientQueueMs});return r.result.answers;};
  const videos=project.timeline.items.filter(i=>i.type==='video').sort((a,b)=>a.from-b.from),position=videos.findIndex(i=>i.id===item.id),previous=videos.slice(Math.max(0,position-2),position),next=videos.slice(position+1,position+2);
  const fps=project.metadata.fps,music=library.music?.find(m=>project.timeline.items.some(i=>i.trackId==='music'&&i.mediaId===m.id));
  const lengths=durationOptions?.length?durationOptions:[{frames:item.durationInFrames,reason:'保持现有时间轴长度'}];
  if(lengths.some(o=>!Number.isInteger(o.frames)||o.frames<1||item.from+o.frames>Math.round(project.duration*fps)))throw Error('无效的动态结束点');
  let attacks=[],structuralAccents=[];if(music){const event=await events(music),track=project.timeline.items.find(i=>i.trackId==='music'&&i.mediaId===music.id),offset=(track.sourceStart||0)/(track.sourceFps||fps),rate=track.speed||1,toTimeline=t=>track.from/fps+(t-offset)/rate;
    const near=t=>t>=item.from/fps-.1&&t<(item.from+Math.max(...lengths.map(o=>o.frames)))/fps+.3;
    attacks=event.events.map(e=>({time:toTimeline(e.time),strength:e.strength,band:e.band})).filter(e=>near(e.time));
    structuralAccents=(event.structuralAccents||[]).map(e=>({...e,time:toTimeline(e.time),quietStart:toTimeline(e.quietStart)})).filter(e=>near(e.time)||item.from/fps>=e.quietStart&&item.from/fps<e.time);
  }
  const landsOnReturn=structuralAccents.some(e=>Math.abs(e.time-item.from/fps)<=1/fps);
  const musicUnderstanding=await cachedMusicContext(project,{...item,durationInFrames:Math.max(...lengths.map(o=>o.frames))},music);
  const story=storyContext(project,item,resources.shots,goal);
  const storyFocus=story.nextNeeds.map(n=>n.query).join(' ');
  const compactStory={milestones:story.milestones,nextNeeds:story.nextNeeds,reactionRun:story.reactionRun,sceneRun:story.sceneRun,recentDurations:story.recentDurations,instruction:story.instruction,recent:story.history.slice(-3).map(f=>({timeline:f.timeline,visual:f.description,people:f.people,direction:f.screenDirection,emotion:f.emotion,actions:f.actions?.slice(0,2).map(a=>({action:a.action,phase:a.phase,completed:a.completionInWindow,visibleFraction:a.visibleFraction}))}))};
  const cast=[...new Set(resources.shots.flatMap(s=>s.characters||[]))].filter(n=>n.length>1&&n.length<12&&goal.includes(n)).slice(0,6).join(' ');
  const storyQuery=(cast||goal.slice(0,60))+' '+storyFocus;
  const context={goal,prompt,intent,position:{from:item.from/fps,to:(item.from+item.durationInFrames)/fps},durationOptions:lengths.map(o=>({seconds:o.frames/fps,reason:o.reason})),music:{name:music?.name,attacks,structuralAccents,landsOnReturn,understanding:musicUnderstanding},previous:previous.map(i=>i.label),nextTentative:next.map(i=>i.label),story,phrase:item.mad?.phrase};
  if(narrative)context.narrative={character:narrative.character,stage:narrative.stage,chapter:narrative.stages[narrative.stage],rule:'只能沿角色成长阶段向后推进，配角用于解释主角经历，不能喧宾夺主'};
  const query=shotQuery({goal,prompt,intent});
  const basicMusic=semanticMusicContext(musicUnderstanding),{sections:musicSections,...stableMusic}=basicMusic;
  const stableState={goal,...(prompt&&prompt!==goal?{prompt}:{}),musicUnderstanding:stableMusic};
  const recent=videos.filter(i=>i.id!==item.id).map(i=>({shotId:i.mad?.shotId,sourceId:i.mediaId,start:i.sourceStart/(i.sourceFps||fps),sceneId:resources.shots.find(s=>s.id===i.mad?.shotId)?.sceneId}));
  stages.contextMs=performance.now()-started;const attempted=new Set(),rounds=[];let selected,finalCandidates=[],finalOutput;
  for(let round=0;round<3;round++){
    onStage('recall');
    const roundIntent=round<2?intent:`衔接优先的补充搜索：接住前镜“${story.previous?.description||'开场'}”，寻找后续动作、结果、保护对象或反应。宏观段落是方向，不要求这一镜完成整段高潮。`;
    const coreGoal=goal.split(/[。；\n]/).find(s=>s.includes('主角'))||goal.slice(0,80);
    const roundQuery=round<2?query:shotQuery({goal:coreGoal,prompt:'',intent:roundIntent});
    check();let phaseStart=performance.now();const r=await recall({decisionId:id+'-'+round,context,queries:[{name:round<2?'direction':'broaden-story',query:roundQuery},{name:'story-continuity',query:storyQuery,weight:1,contextShotIds:previous.map(i=>i.mad?.shotId).filter(Boolean)}],limit:[96,192,384][round]});stages.recallMs+=performance.now()-phaseStart;check();
    const adjacent=continuationCandidates(resources.shots,story,new Set(recent.map(x=>x.shotId)));
    const union=new Map(r.candidates.map(s=>[s.id,s]));for(const s of adjacent)if(!union.has(s.id))union.set(s.id,{...s,recallScore:r.candidates[0]?.recallScore||.02});
    const neededSeconds=Math.min(...lengths.map(o=>o.frames))/project.metadata.fps*(item.speed||1);
    const rejected=[],eligible=[];
    for(const s of union.values()){
      // Respect the explicit reprise policy. Continuation is offered separately as fresh frames;
      // neither this guard nor the window guard imposes a RAG-rank cutoff.
      const reasons=[...candidateRejections(s,story,{repriseAllowed:true}),...narrativeRejections(s,narrative,story.history)];
      if(item.mad?.repriseAllowed!==true&&item.mad?.intentionalReuse!==true&&recent.some(r=>r.shotId===s.id))reasons.push('already-used-shot-without-reprise');
      if(s.excluded)reasons.push('excluded-source-band');
      if(attempted.has(s.id))reasons.push('already-compared-this-decision');
      if(s.id===item.mad?.shotId)reasons.push('current-shot-offered-as-keep');
      if(!(s.end-s.start>=neededSeconds+.12))reasons.push('insufficient-source-duration');
      if(s.cacheState?.boundaries==='no-safe-range')reasons.push('no-safe-range');
      if(s.cacheState?.boundaries==='reviewed'&&!s.safeRanges.some(r=>r.endFrame-r.startFrame>=Math.ceil(neededSeconds*(s.endFrame-s.startFrame)/(s.end-s.start))+reserveFrames*2))reasons.push('insufficient-safe-frames');
      if(reasons.length)rejected.push({shotId:s.id,reasons});else eligible.push(s);
    }
    const seed=r.contextHash||JSON.stringify(context),batch=neutralCandidateOrder(eligible,seed);
    const roundRecord={scope:r.scope,contextHash:r.contextHash,ms:r.ms,lanes:r.lanes,recallIds:r.candidates.map(s=>s.id),rejected,continuationIds:adjacent.map(s=>s.id),semanticCandidateIds:batch.map(s=>s.id),policy:candidatePolicyVersion,preModelRanking:'none',semanticBatches:[]};rounds.push(roundRecord);
    if(!batch.length)continue;
    phaseStart=performance.now();
    const scoringContext={intent:roundIntent,musicSections,...(context.narrative?{narrative:context.narrative}:{})};
    const entries=await Promise.all(batch.map(async shot=>{
      const facts=basicFitFacts(shot);
      const key=semanticKey({goal,prompt,intent:roundIntent,shot,musicContext:musicUnderstanding,decisionContext:{policy:candidatePolicyVersion,...scoringContext,facts}});
      return {shot,facts,key,cached:await cachedSemantic(key)};
    })),missing=entries.filter(e=>!e.cached);
    const makeRequest=page=>basicFitRequest(page,scoringContext,stableState);
    await scoreSemanticPages(missing,{makeRequest,compare,check,onPage:page=>roundRecord.semanticBatches.push(page),onScores:async(page,scores)=>{
      // Validate the entire page before caching any answer.
      const answers=page.map((_,j)=>scores['c'+j]);
      if(answers.some(a=>!Number.isFinite(a?.score)||a.score<0||a.score>3))throw Error('jev 候选评分无效');
      await Promise.all(page.map(async(e,j)=>{e.cached={answer:answers[j],traceId:id};await saveSemantic(e.key,e.cached);}));
    }});
    entries.forEach(e=>{e.shot.winnowScore=e.cached.answer.score;});roundRecord.semanticCache={kind:'basic-fit-only',hits:entries.length-missing.length,misses:missing.length,evidence:entries.map(e=>({shotId:e.shot.id,answer:e.cached.answer,originTraceId:e.cached.traceId}))};
    stages.semanticMs+=performance.now()-phaseStart;
    const finalists=modelRankedCandidates(batch,{limit:6,seed});
    roundRecord.finalists=finalists.map(s=>({shotId:s.id,modelScore:s.winnowScore}));finalists.forEach(s=>attempted.add(s.id));
    onStage('window');phaseStart=performance.now();await prepare([...finalists.map(s=>s.id),...previous.map(i=>i.mad?.shotId).filter(Boolean)],library,resources);stages.safetyMotionMs+=performance.now()-phaseStart;check();
    phaseStart=performance.now();const found={candidates:[]};
    for(const length of lengths){const variant={...item,durationInFrames:length.frames},variantProject={...project,timeline:{...project.timeline,items:project.timeline.items.map(i=>i.id===item.id?variant:i)}};
      try{const windows=buildLiveReplacements({project:variantProject,row:{id:item.id,role:'global',continuityPrevious:story.previous,accentFraction:landsOnReturn?0:(item.mad?.accentFraction??.5),alternatives:finalists.map(s=>({shotId:s.id,visual:s.description,similarity:s.embeddingSimilarity??0,semanticScore:s.winnowScore}))},library,...resources,manageAudio,allowSingle:true,reserveFrames});found.candidates.push(...windows.candidates.filter(c=>!c.keep).map(c=>({...c,durationReason:length.reason})));}
      catch(e){if(e.status!==422||!e.message.includes('没有足够替代'))throw e;}
    }
    if(!found.candidates.length){rounds.at(-1).windowFailure='候选时长均无合法窗口';stages.windowCompileMs+=performance.now()-phaseStart;continue;}
    // Two actual timing alternatives per source, plus at most one continuous extension.
    if(durationOptions){found.candidates=finalists.flatMap(s=>{const windows=found.candidates.filter(c=>c.shotId===s.id).sort((a,b)=>a.item.durationInFrames-b.item.durationInFrames);return windows.length>1?[windows[0],windows.at(-1)]:windows;});}
    const currentVisual=resources.shots.find(s=>s.id===item.mad?.shotId)?.description||item.label||'当前镜头';
    const carry=!landsOnReturn&&durationOptions?.length?(carryWindow(project,{...item,durationInFrames:lengths.at(-1).frames},previous,resources.shots)||carryWindow(project,item,previous,resources.shots)):null;
    let candidates=windowMenu(found.candidates.filter(c=>!c.keep),{special:[...(allowKeep?[{shotId:item.mad?.shotId,visual:currentVisual,item:structuredClone(item),keep:true}]:[]),...(carry?[carry]:[])],limit:durationOptions?12:8});
    if(narrative)candidates=candidates.filter(c=>!narrativeRejections(resources.shots.find(s=>s.id===c.shotId),narrative,story.history).length);
    candidates=candidates.filter(c=>c.keep||!unmarkedSourceReplay(project,c.item));
    if(!candidates.length)continue;
    const rotation=parseInt(createHash('sha256').update(item.id).digest('hex').slice(0,6),16)%candidates.length;candidates=[...candidates.slice(rotation),...candidates.slice(0,rotation)];
    const motionMatch=adaptiveVisual&&/奔跑|挥|举起|开火|射击|转身|跃|坠|跳|冲/.test(story.previous?.description||'')&&candidates.some(c=>/奔跑|挥|举起|开火|射击|转身|跃|坠|跳|冲/.test(c.visual));
    const useVision=visionEnabled||motionMatch;
    stages.windowCompileMs+=performance.now()-phaseStart;phaseStart=performance.now();const prev=previous.at(-1),images=useVision?await evidence([...candidates.map(c=>c.item),...(prev?[{...prev,sourceStart:Math.max(prev.sourceStart,prev.sourceEnd-5)}]:[])],library):[];if(useVision)stages.framesMs+=performance.now()-phaseStart;check();
    const map=new Map(resources.shots.map(s=>[s.id,s]));
    const dynamicContext={intent:roundIntent,position:context.position,rhythmChoices:context.durationOptions,music:{name:music?.name,attacks,structuralAccents,landsOnReturn,sections:musicSections,sourceRange:musicUnderstanding.sourceRange},previous:context.previous,nextTentative:context.nextTentative,story:compactStory,phrase:context.phrase,narrative:context.narrative};
    const candidateFacts=candidates.map((c,j)=>{const shot=map.get(c.shotId),facts=windowFacts(shot,c.item);return {id:'c'+j,...(useVision?{image:j+1}:{}),visual:c.visual,unknown:facts.unknown,dialogueMeaning:facts.dialogueMeaning,sourceRange:facts.sourceRange?.map(t=>+t.toFixed(3)),people:facts.people,shotSize:facts.shotSize,direction:facts.screenDirection,emotion:facts.emotion,actions:(facts.actions||[]).slice(0,3).map(a=>({action:a.action,phase:a.phase,direction:a.direction,visibleFraction:a.visibleFraction,completed:a.completionInWindow,peak:a.peakInWindow})),uncertainties:facts.uncertainties?.slice(0,1),usage:shot?usageEvidence(shot,project,item,story,c.item):undefined,durationSeconds:+(c.item.durationInFrames/fps).toFixed(3),endAt:+((item.from+c.item.durationInFrames)/fps).toFixed(3),cutReason:c.durationReason||'继续前镜动作',connection:{...connectionEvidence(facts,story),continuousSource:!!c.continuationOf}};});
    const questions={};
    questions.pick={type:'choice',instructions:'联合选择素材、实际裁剪窗口和时长。若music.landsOnReturn为true，优先在停顿后的重入点释放实际出招或命中；quietStart到time之间适合蓄势。优先让准备→发动→结果可读，不必每拍换镜。usage.replayedFraction是本窗口已播过的原帧比例，previousWindowOverlap是与紧邻前镜的原帧重叠。1表示重播同一段，不是新动作。一般应推进事件或续接新帧；只有当前音乐/意图需要明确重复强调、A-B-A对切、闪回时才有意重播，不能用同一动作倒带冒充延续。不要因同场景或倒序自动排斥；若指定narrative阶段则遵守该显式约束。跨场景不能伪称空间连续。只需承担局部职责，不要求一镜完成整段。只有全部候选无意义或明显错误才search_more。',criteria:{...Object.fromEntries(candidateFacts.map(c=>[c.id,c.usage?.previousWindowOverlap>.8?'有意重播紧邻前镜的相同原帧；仅在确有重复强调需要时选':c.connection.continuousSource?'连续使用前镜之后的新原帧，推进动作':null])),search_more:'全部候选不合适，重新全库召回'}};
    phaseStart=performance.now();const answers=await compare(useVision?'visual':'window-text',{state:{...dynamicContext,intent:roundIntent,previousImage:useVision&&prev?images.length:null,candidates:candidateFacts,evidence:useVision?'候选图是实际裁剪窗口起中末帧，最后一图是前镜尾部。比较前镜末与候选首：人物画面位置、身体/武器朝向、景别和运动趋势。只有都接得上才称姿势匹配；文本若与实际图片冲突，以图片为准。不能把相同动词当作匹配。':'没有图片；visual是整镜语义，actions仅包含与裁剪窗口相交的已标注动作。无法从文字证明精确姿势/构图，只能判断动作阶段、方向和人物关系。'},questions,winnow:useVision?{static_state:stableState,images:images.map(x=>x.data)}:{static_state:stableState}},images);
    stages[useVision?'visionMs':'textSelectionMs']+=performance.now()-phaseStart;finalCandidates=candidates.map((c,j)=>({...c,facts:candidateFacts[j],...(images[j]?{preview:images[j].url}:{})}));
    const choice=answers.pick?.choice;if(!['search_more',...candidates.map((_,j)=>'c'+j)].includes(choice))throw Error('Winnow缺少合法的比较选择');
    finalOutput={choice,scores:answers,selection:'joint-story-and-continuity-choice',visualReview:useVision};
    if(choice==='search_more')continue;selected=finalCandidates[Number(choice.slice(1))];break;
  }
  const noSelection=!selected&&!allowKeep;
  if(selected&&!selected.keep)selected.item.mad={...selected.item.mad,intent,...(narrative?{storyStage:narrative.stage,storyCharacter:narrative.character,storyEvent:narrative.annotations[selected.shotId]?.event}:{})};
  selected??={shotId:item.mad?.shotId,visual:item.label||'当前镜头',item:structuredClone(item),keep:true};
  const trace={id,visionEnabled,context,rounds,calls,selected:{shotId:selected.shotId,visual:selected.visual,keep:selected.keep,preview:selected.preview},alternatives:finalCandidates.map(({item,...c})=>c),output:finalOutput,timing:{modelMs,totalMs:performance.now()-started,stages},noSuitableCandidate:!finalOutput||finalOutput.choice==='search_more'};
  const persistStart=performance.now();await writeFile(path.join(folder,'trace.json'),JSON.stringify(trace,null,2));stages.persistMs=performance.now()-persistStart;trace.timing.totalMs=performance.now()-started;stages.otherMs=Math.max(0,trace.timing.totalMs-Object.values(stages).reduce((a,b)=>a+b,0));await writeFile(path.join(folder,'trace.json'),JSON.stringify(trace,null,2));if(noSelection){const e=Error('三轮全库召回后仍无合适窗口，未写入时间轴；决策记录 '+id);e.status=422;throw e;}
  return {selected,trace,resources,model:'Winnow-12B',timing:{modelMs,prepareMs:trace.timing.totalMs-modelMs,totalMs:trace.timing.totalMs,stages},traceUrl:'/studio-assets/global-decisions/'+id+'/trace.json'};
}
