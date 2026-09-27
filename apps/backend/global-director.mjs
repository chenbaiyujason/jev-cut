import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {recallForDecision} from './decision-recall.mjs';
import {pruneDecisionCandidates} from './recall-pruning.mjs';
import {globalResources,prepareGlobalShots,windowEvidence} from './global-evidence.mjs';
import {buildLiveReplacements} from './director-live.mjs';
import {cachedMusicEvents} from './rhythm.mjs';
import {cachedMusicContext} from './music-intent.mjs';
import {root} from './catalog.mjs';
import {decide} from './winnow.mjs';
import {semanticKey,cachedSemantic,saveSemantic,semanticMusicContext} from './semantic-decision-cache.mjs';
import {shotQuery} from './query-vectors.mjs';
import {visionSelectionEnabled} from './decision-settings.mjs';
import {storyContext,windowFacts,connectionEvidence,continuationCandidates,candidateRejections,carryWindow} from './story-continuity.mjs';
const fail=m=>{const e=Error(m);e.status=499;throw e;};
export async function chooseGlobalShot({project,item,goal='',prompt='',intent='',library,resources,ask,cancelled=()=>false,manageAudio=false,reserveFrames=1,allowKeep=true,prewarmEvidence=true,visionEnabled,adaptiveVisual=false,onStage=()=>{},durationOptions},{recall=recallForDecision,prepare=prepareGlobalShots,evidence=windowEvidence,events=cachedMusicEvents}={}){
  const started=performance.now(),id=randomUUID(),folder=path.join(root,'.local/studio/global-decisions',id);await mkdir(folder,{recursive:true});
  resources??=await globalResources();visionEnabled=await visionSelectionEnabled(visionEnabled);const askModel=ask||((body)=>decide(body,folder));let modelMs=0;
  const stages={contextMs:0,recallMs:0,semanticMs:0,safetyMotionMs:0,windowCompileMs:0,framesMs:0,visionMs:0,textSelectionMs:0,persistMs:0};const calls=[],check=()=>{if(cancelled())fail('请求已取消或已被更新的修改替代');};
  const compare=async(stage,body,images=[])=>{check();onStage(stage);const r=await askModel(body);check();modelMs+=r.ms;calls.push({stage,input:{...body,...(body.winnow?{winnow:{...body.winnow,images:images.map(x=>x.url)}}:{})},output:r.result,ms:r.ms,clientQueueMs:r.clientQueueMs});return r.result.answers;};
  const videos=project.timeline.items.filter(i=>i.type==='video').sort((a,b)=>a.from-b.from),position=videos.findIndex(i=>i.id===item.id),previous=videos.slice(Math.max(0,position-2),position),next=videos.slice(position+1,position+2);
  const fps=project.metadata.fps,music=library.music?.find(m=>project.timeline.items.some(i=>i.trackId==='music'&&i.mediaId===m.id));
  const lengths=durationOptions?.length?durationOptions:[{frames:item.durationInFrames,reason:'保持现有时间轴长度'}];
  if(lengths.some(o=>!Number.isInteger(o.frames)||o.frames<1||item.from+o.frames>Math.round(project.duration*fps)))throw Error('无效的动态结束点');
  let attacks=[];if(music){const event=await events(music);attacks=event.events.filter(e=>e.time>=item.from/fps-.1&&e.time<(item.from+Math.max(...lengths.map(o=>o.frames)))/fps+.3).map(e=>({time:e.time,strength:e.strength,band:e.band}));}
  const musicUnderstanding=await cachedMusicContext(project,{...item,durationInFrames:Math.max(...lengths.map(o=>o.frames))},music);
  const story=storyContext(project,item,resources.shots,goal),continuationSceneId=story.sceneRun<4?story.previous?.sceneId:undefined;
  const storyFocus=story.nextNeeds.map(n=>n.query).join(' '),storyQuery=goal+' '+storyFocus;
  const context={goal,prompt,intent,position:{from:item.from/fps,to:(item.from+item.durationInFrames)/fps},durationOptions:lengths.map(o=>({seconds:o.frames/fps,reason:o.reason})),music:{name:music?.name,attacks,understanding:musicUnderstanding},previous:previous.map(i=>i.label),nextTentative:next.map(i=>i.label),story,phrase:item.mad?.phrase};
  const query=shotQuery({goal,prompt,intent});
  const basicMusic=semanticMusicContext(musicUnderstanding),{sections:musicSections,...stableMusic}=basicMusic;
  const stableState={goal,prompt,musicUnderstanding:stableMusic};
  const recent=videos.filter(i=>i.id!==item.id).map(i=>({shotId:i.mad?.shotId,sourceId:i.mediaId,start:i.sourceStart/(i.sourceFps||fps),sceneId:resources.shots.find(s=>s.id===i.mad?.shotId)?.sceneId}));
  stages.contextMs=performance.now()-started;const attempted=new Set(),rounds=[];let selected,finalCandidates=[],finalOutput;
  for(let round=0;round<3;round++){
    onStage('recall');
    const roundIntent=round<2?intent:`衔接优先的补充搜索：接住前镜“${story.previous?.description||'开场'}”，寻找后续动作、结果、保护对象或反应。宏观段落是方向，不要求这一镜完成整段高潮。`;
    const roundQuery=round<2?query:shotQuery({goal,prompt,intent:roundIntent});
    check();let phaseStart=performance.now();const r=await recall({decisionId:id+'-'+round,context,queries:[{name:round<2?'direction':'broaden-story',query:roundQuery},{name:'story-continuity',query:storyQuery,weight:1,contextShotIds:previous.map(i=>i.mad?.shotId).filter(Boolean)}],limit:[96,192,384][round]});stages.recallMs+=performance.now()-phaseStart;check();
    const adjacent=continuationCandidates(resources.shots,story,new Set(recent.map(x=>x.shotId)));
    const union=new Map(r.candidates.map(s=>[s.id,s]));for(const s of adjacent)if(!union.has(s.id))union.set(s.id,{...s,recallScore:r.candidates[0]?.recallScore||.02});
    const rejected=[...union.values()].map(s=>({shotId:s.id,reasons:candidateRejections(s,story,{repriseAllowed:item.mad?.repriseAllowed===true})})).filter(x=>x.reasons.length),rejectedIds=new Set(rejected.map(x=>x.shotId));
    const neededSeconds=Math.min(...lengths.map(o=>o.frames))/project.metadata.fps*(item.speed||1);const eligible=[...union.values()].filter(s=>!rejectedIds.has(s.id)&&!attempted.has(s.id)&&s.id!==item.mad?.shotId&&s.end-s.start>=neededSeconds+.12&&(!item.mad?.requiresPhysicalAction||(s.semantic?.actions||[]).some(a=>a.confidence>=.65&&/跑|跃|跳|挥|开火|射击|发射|坠|落地|引爆|扣动|按下|拉住|抱起|转身|伸手|拔出|转动|翻滚|爆炸|撞|迈步|走向/.test(a.action||''))));
    const batch=pruneDecisionCandidates(eligible,{limit:16,recent,continuationSceneId});
    // Preserve up to two eligible forward continuations alongside global alternatives.
    for(const s of adjacent.slice(0,2)){const candidate=eligible.find(c=>c.id===s.id);if(candidate&&!batch.some(c=>c.id===s.id)){if(batch.length>=16)batch.pop();batch.push(candidate);}}
    rounds.push({scope:r.scope,contextHash:r.contextHash,ms:r.ms,lanes:r.lanes,recallIds:r.candidates.map(s=>s.id),rejected,continuationIds:adjacent.map(s=>s.id),semanticCandidateIds:batch.map(s=>s.id)});
    if(!batch.length)break;
    phaseStart=performance.now();const entries=await Promise.all(batch.map(async shot=>{const key=semanticKey({goal,prompt,intent:roundIntent+' 当前缺失信息：'+storyFocus,shot,musicContext:musicUnderstanding});return {shot,key,cached:await cachedSemantic(key)};})),missing=entries.filter(e=>!e.cached);
    // Prepare likely exact windows while the independent text model request runs.
    // This is this decision's disposable shortlist, never the next decision's search scope.
    const warming=missing.length&&prewarmEvidence&&visionEnabled&&!durationOptions?(async()=>{const start=performance.now(),likely=pruneDecisionCandidates(batch,{limit:5,recent});
      await prepare(likely.map(s=>s.id),library,resources);check();
      const windows=buildLiveReplacements({project,row:{id:item.id,role:'global',alternatives:likely.map(s=>({shotId:s.id,visual:s.description}))},library,...resources,manageAudio,allowSingle:true,reserveFrames});
      await evidence(windows.candidates.filter(c=>!c.keep).map(c=>c.item),library);
      rounds.at(-1).evidencePrefetch={windows:windows.candidates.length,ms:performance.now()-start};
    })().catch(e=>{rounds.at(-1).evidencePrefetch={warning:e.message};}):Promise.resolve();
    try{if(missing.length){const scores=await compare('semantic',{state:{intent:roundIntent,storyFocus,musicSections,candidates:missing.map(({shot:s},j)=>({id:'c'+j,visual:s.description,dialogue:s.semantic?.dialogue_meaning_zh?.slice(0,50)}))},questions:Object.fromEntries(missing.map((_,j)=>['c'+j,{type:'score',instructions:`评价dynamic.candidates中的c${j}对static主题、dynamic.storyFocus当前缺失信息及音乐段落的贡献；能补动作结果或保护关系的候选优先于仅有相似情绪的候选。`,criteria:['不符','间接','适合','直接且有表现力']}])) ,winnow:{static_state:stableState}});await Promise.all(missing.map(async(e,j)=>{const answer=scores['c'+j];if(!Number.isFinite(answer?.score))throw Error('Winnow缺少候选评分');e.cached={answer,traceId:id};await saveSemantic(e.key,e.cached);}));}}
    finally{await warming;}
    entries.forEach(e=>{e.shot.winnowScore=e.cached.answer.score;});rounds.at(-1).semanticCache={hits:entries.length-missing.length,misses:missing.length,evidence:entries.map(e=>({shotId:e.shot.id,answer:e.cached.answer,originTraceId:e.cached.traceId}))};
    stages.semanticMs+=performance.now()-phaseStart;const finalists=pruneDecisionCandidates(batch,{limit:durationOptions?4:5,recent,continuationSceneId});
    const nextAction=batch.find(s=>adjacent.some(a=>a.id===s.id)&&s.winnowScore>=1.4);if(nextAction&&!finalists.some(s=>s.id===nextAction.id)){if(finalists.length>=5)finalists.pop();finalists.push(nextAction);}finalists.forEach(s=>attempted.add(s.id));
    onStage('window');phaseStart=performance.now();await prepare([...finalists.map(s=>s.id),...previous.map(i=>i.mad?.shotId).filter(Boolean)],library,resources);stages.safetyMotionMs+=performance.now()-phaseStart;check();
    phaseStart=performance.now();const found={candidates:[]};
    for(const length of lengths){const variant={...item,durationInFrames:length.frames},variantProject={...project,timeline:{...project.timeline,items:project.timeline.items.map(i=>i.id===item.id?variant:i)}};
      try{const windows=buildLiveReplacements({project:variantProject,row:{id:item.id,role:'global',continuityPrevious:story.previous,accentFraction:item.mad?.accentFraction??.5,alternatives:finalists.map(s=>({shotId:s.id,visual:s.description,similarity:s.embeddingSimilarity??0,semanticScore:s.winnowScore}))},library,...resources,manageAudio,allowSingle:true,reserveFrames});found.candidates.push(...windows.candidates.filter(c=>!c.keep).map(c=>({...c,durationReason:length.reason})));}
      catch(e){if(e.status!==422||!e.message.includes('没有足够替代'))throw e;}
    }
    if(!found.candidates.length){rounds.at(-1).windowFailure='候选时长均无合法窗口';stages.windowCompileMs+=performance.now()-phaseStart;continue;}
    // Two actual timing alternatives per source, plus at most one continuous extension.
    if(durationOptions){found.candidates=finalists.flatMap(s=>{const windows=found.candidates.filter(c=>c.shotId===s.id).sort((a,b)=>a.item.durationInFrames-b.item.durationInFrames);return windows.length>1?[windows[0],windows.at(-1)]:windows;});}
    const currentVisual=resources.shots.find(s=>s.id===item.mad?.shotId)?.description||item.label||'当前镜头';
    const carry=carryWindow(project,{...item,durationInFrames:lengths.at(-1).frames},previous,resources.shots)||carryWindow(project,item,previous,resources.shots);
    let candidates=[...(allowKeep?[{shotId:item.mad?.shotId,visual:currentVisual,item:structuredClone(item),keep:true}]:[]),...(carry?[carry]:[]),...found.candidates.filter(c=>!c.keep)].slice(0,durationOptions?10:6);
    if(!candidates.length)continue;
    const rotation=parseInt(createHash('sha256').update(item.id).digest('hex').slice(0,6),16)%candidates.length;candidates=[...candidates.slice(rotation),...candidates.slice(0,rotation)];
    const motionMatch=adaptiveVisual&&/奔跑|挥|举起|开火|射击|转身|跃|坠|跳|冲/.test(story.previous?.description||'')&&candidates.some(c=>/奔跑|挥|举起|开火|射击|转身|跃|坠|跳|冲/.test(c.visual));
    const useVision=visionEnabled||motionMatch;
    stages.windowCompileMs+=performance.now()-phaseStart;phaseStart=performance.now();const prev=previous.at(-1),images=useVision?await evidence([...candidates.map(c=>c.item),...(prev?[{...prev,sourceStart:Math.max(prev.sourceStart,prev.sourceEnd-5)}]:[])],library):[];if(useVision)stages.framesMs+=performance.now()-phaseStart;check();
    const map=new Map(resources.shots.map(s=>[s.id,s]));
    const dynamicContext={intent:roundIntent,position:context.position,rhythmChoices:context.durationOptions,music:{name:music?.name,attacks,sections:musicSections,sourceRange:musicUnderstanding.sourceRange},previous:context.previous,nextTentative:context.nextTentative,story,phrase:context.phrase};
    const candidateFacts=candidates.map((c,j)=>{const facts=windowFacts(map.get(c.shotId),c.item);return {id:'c'+j,...(useVision?{image:j+1}:{}),visual:c.visual,...facts,durationSeconds:c.item.durationInFrames/fps,endAt:(item.from+c.item.durationInFrames)/fps,cutReason:c.durationReason||'继续前镜动作',connection:{...connectionEvidence(facts,story),continuousSource:!!c.continuationOf,meaning:c.continuationOf?'延续前镜真实的后续帧，让动作经过鼓点而不切断；不是重播。':undefined}};});
    const questions=Object.fromEntries(candidates.map((_,j)=>['c'+j,{type:'score',instructions:`评价c${j}对当前小事件的推进及与前镜的连接：动接动关注动作阶段、方向、主体位置和景别；静接静关注视线与情绪的对象，连续眼睛特写没有新增信息应降分。同场景正向动作可接续，跨集构图匹配也可，不为跨集而跳跃。只凭文字不能宣称姿势完全吻合。`,criteria:['不成立','勉强','适合','很有表现力']}]));
    questions.pick={type:'choice',instructions:'联合选择素材、实际裁剪窗口和时长：同一素材的短版/长版也是不同选项。优先让准备→发动→结果可读；不要因为短版更快就选短，不必每拍换镜。允许续接前镜完成动作。综合比较所有候选，决定下一镜。当前唱句/半句内让镜头形成一个事件；先交代动作或注视的对象，再行动，再结果/反应。可让完整动作跨2–4镜推进，不要因同场景就排斥。已有连续反应镜时优先真实行动或关系证据。只需承担局部职责，不要求同时完成整段所有要求。只有全部候选都无意义或明显错误才search_more。',criteria:{...Object.fromEntries(candidates.map((_,j)=>['c'+j,null])),search_more:'全部候选不合适，重新全库召回'}};
    phaseStart=performance.now();const answers=await compare(useVision?'visual':'window-text',{state:{...(useVision?context:dynamicContext),intent:roundIntent,previousImage:useVision&&prev?images.length:null,candidates:candidateFacts,evidence:useVision?'候选图是实际裁剪窗口起中末帧，最后一图是前镜尾部。比较前镜末与候选首：人物画面位置、身体/武器朝向、景别和运动趋势。只有都接得上才称姿势匹配；文本若与实际图片冲突，以图片为准。不能把相同动词当作匹配。':'没有图片；description是整镜语义，actions仅包含与裁剪窗口相交的已标注动作。无法从文字证明精确姿势/构图，只能判断动作阶段、方向和人物关系。'},questions,winnow:useVision?{images:images.map(x=>x.data)}:{static_state:stableState}},images);
    stages[useVision?'visionMs':'textSelectionMs']+=performance.now()-phaseStart;finalCandidates=candidates.map((c,j)=>({...c,facts:candidateFacts[j],...(images[j]?{preview:images[j].url}:{})}));
    const ranked=candidates.map((c,j)=>({index:j,score:answers['c'+j]?.score}));if(ranked.some(x=>!Number.isFinite(x.score)))throw Error('Winnow缺少选镜评分');ranked.sort((a,b)=>b.score-a.score);
    const choice=answers.pick?.choice;if(!['search_more',...candidates.map((_,j)=>'c'+j)].includes(choice))throw Error('Winnow缺少合法的比较选择');
    finalOutput={choice,scores:answers,selection:'joint-story-and-continuity-choice',visualReview:useVision};
    if(choice==='search_more')continue;selected=finalCandidates[Number(choice.slice(1))];break;
  }
  const noSelection=!selected&&!allowKeep;
  if(selected&&!selected.keep)selected.item.mad={...selected.item.mad,intent};
  selected??={shotId:item.mad?.shotId,visual:item.label||'当前镜头',item:structuredClone(item),keep:true};
  const trace={id,visionEnabled,context,rounds,calls,selected:{shotId:selected.shotId,visual:selected.visual,keep:selected.keep,preview:selected.preview},alternatives:finalCandidates.map(({item,...c})=>c),output:finalOutput,timing:{modelMs,totalMs:performance.now()-started,stages},noSuitableCandidate:!finalOutput||finalOutput.choice==='search_more'};
  const persistStart=performance.now();await writeFile(path.join(folder,'trace.json'),JSON.stringify(trace,null,2));stages.persistMs=performance.now()-persistStart;trace.timing.totalMs=performance.now()-started;stages.otherMs=Math.max(0,trace.timing.totalMs-Object.values(stages).reduce((a,b)=>a+b,0));await writeFile(path.join(folder,'trace.json'),JSON.stringify(trace,null,2));if(noSelection){const e=Error('三轮全库召回后仍无合适窗口，未写入时间轴；决策记录 '+id);e.status=422;throw e;}
  return {selected,trace,resources,model:'Winnow-12B',timing:{modelMs,prepareMs:trace.timing.totalMs-modelMs,totalMs:trace.timing.totalMs,stages},traceUrl:'/studio-assets/global-decisions/'+id+'/trace.json'};
}
