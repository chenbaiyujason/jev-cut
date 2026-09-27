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
import {semanticKey,cachedSemantic,saveSemantic} from './semantic-decision-cache.mjs';
const fail=m=>{const e=Error(m);e.status=499;throw e;};
export async function chooseGlobalShot({project,item,goal='',prompt='',intent='',library,resources,ask,cancelled=()=>false,manageAudio=false,reserveFrames=1,allowKeep=true},{recall=recallForDecision,prepare=prepareGlobalShots,evidence=windowEvidence,events=cachedMusicEvents}={}){
  const started=performance.now(),id=randomUUID(),folder=path.join(root,'.local/studio/global-decisions',id);await mkdir(folder,{recursive:true});
  resources??=await globalResources();const askModel=ask||((body)=>decide(body,folder));let modelMs=0;
  const stages={contextMs:0,recallMs:0,semanticMs:0,safetyMotionMs:0,windowCompileMs:0,framesMs:0,visionMs:0,persistMs:0};const calls=[],check=()=>{if(cancelled())fail('请求已取消或已被更新的修改替代');};
  const compare=async(stage,body,images=[])=>{check();const r=await askModel(body);check();modelMs+=r.ms;calls.push({stage,input:{...body,...(body.winnow?{winnow:{...body.winnow,images:images.map(x=>x.url)}}:{})},output:r.result,ms:r.ms});return r.result.answers;};
  const videos=project.timeline.items.filter(i=>i.type==='video').sort((a,b)=>a.from-b.from),position=videos.findIndex(i=>i.id===item.id),previous=videos.slice(Math.max(0,position-2),position),next=videos.slice(position+1,position+2);
  const fps=project.metadata.fps,music=library.music?.find(m=>project.timeline.items.some(i=>i.trackId==='music'&&i.mediaId===m.id));
  let attacks=[];if(music){const event=await events(music);attacks=event.events.filter(e=>e.time>=item.from/fps-.1&&e.time<(item.from+item.durationInFrames)/fps+.3).map(e=>({time:e.time,strength:e.strength,band:e.band}));}
  const musicUnderstanding=await cachedMusicContext(project,item,music);
  const context={goal,prompt,intent,position:{from:item.from/fps,to:(item.from+item.durationInFrames)/fps},music:{name:music?.name,attacks,understanding:musicUnderstanding},previous:previous.map(i=>i.label),nextTentative:next.map(i=>i.label)};
  const query=[...new Set([goal,prompt,intent].filter(Boolean))].join('；').slice(0,1600)||'根据当前音乐选择有表现力且人物关系清楚的动漫画面';
  const recent=videos.filter(i=>i.id!==item.id).map(i=>({shotId:i.mad?.shotId,sourceId:i.mediaId,start:i.sourceStart/(i.sourceFps||fps),sceneId:resources.shots.find(s=>s.id===i.mad?.shotId)?.sceneId}));
  stages.contextMs=performance.now()-started;const attempted=new Set(),rounds=[];let selected,finalCandidates=[],finalOutput;
  for(let round=0;round<2;round++){
    check();let phaseStart=performance.now();const r=await recall({decisionId:id+'-'+round,context,queries:[{name:'direction',query},{name:'continuity',query,weight:.6,contextShotIds:previous.map(i=>i.mad?.shotId).filter(Boolean)}],limit:round?192:96});stages.recallMs+=performance.now()-phaseStart;check();
    const neededSeconds=item.durationInFrames/project.metadata.fps*(item.speed||1);const batch=pruneDecisionCandidates(r.candidates.filter(s=>!attempted.has(s.id)&&s.id!==item.mad?.shotId&&s.end-s.start>=neededSeconds+.12),{limit:16,recent});rounds.push({scope:r.scope,contextHash:r.contextHash,ms:r.ms,lanes:r.lanes,recallIds:r.candidates.map(s=>s.id),semanticCandidateIds:batch.map(s=>s.id)});
    if(!batch.length)break;
    phaseStart=performance.now();const entries=await Promise.all(batch.map(async shot=>{const key=semanticKey({goal,prompt,intent,shot,musicContext:musicUnderstanding});return {shot,key,cached:await cachedSemantic(key)};})),missing=entries.filter(e=>!e.cached);
    if(missing.length){const scores=await compare('semantic',{state:{goal,prompt,intent,musicUnderstanding,candidates:missing.map(({shot:s},j)=>({id:'c'+j,visual:s.description,dialogue:s.semantic?.dialogue_meaning_zh?.slice(0,50)}))},questions:Object.fromEntries(missing.map((_,j)=>['c'+j,{type:'score',instructions:`c${j}画面对当前创作意图的实际贡献。`,criteria:['不符','间接','适合','直接且有表现力']}]))});await Promise.all(missing.map(async(e,j)=>{const answer=scores['c'+j];if(!Number.isFinite(answer?.score))throw Error('Winnow缺少候选评分');e.cached={answer,traceId:id};await saveSemantic(e.key,e.cached);}));}
    entries.forEach(e=>{e.shot.winnowScore=e.cached.answer.score;});rounds.at(-1).semanticCache={hits:entries.length-missing.length,misses:missing.length,evidence:entries.map(e=>({shotId:e.shot.id,answer:e.cached.answer,originTraceId:e.cached.traceId}))};
    stages.semanticMs+=performance.now()-phaseStart;const finalists=pruneDecisionCandidates(batch,{limit:5,recent});finalists.forEach(s=>attempted.add(s.id));
    phaseStart=performance.now();await prepare([...finalists.map(s=>s.id),...previous.map(i=>i.mad?.shotId).filter(Boolean)],library,resources);stages.safetyMotionMs+=performance.now()-phaseStart;check();
    phaseStart=performance.now();let found;try{found=buildLiveReplacements({project,row:{id:item.id,role:'global',alternatives:finalists.map(s=>({shotId:s.id,visual:s.description,similarity:s.embeddingSimilarity??0,semanticScore:s.winnowScore}))},library,...resources,manageAudio,allowSingle:true,reserveFrames});}catch(e){if(e.status===422&&e.message.includes('没有足够替代')){rounds.at(-1).windowFailure=e.message;stages.windowCompileMs+=performance.now()-phaseStart;continue;}throw e;}
    const currentVisual=resources.shots.find(s=>s.id===item.mad?.shotId)?.description||item.label||'当前镜头';
    let candidates=[...(allowKeep?[{shotId:item.mad?.shotId,visual:currentVisual,item:structuredClone(item),keep:true}]:[]),...found.candidates.filter(c=>!c.keep)].slice(0,6);
    if(!candidates.length)continue;
    const rotation=parseInt(createHash('sha256').update(item.id).digest('hex').slice(0,6),16)%candidates.length;candidates=[...candidates.slice(rotation),...candidates.slice(0,rotation)];
    stages.windowCompileMs+=performance.now()-phaseStart;phaseStart=performance.now();const prev=previous.at(-1),images=await evidence([...candidates.map(c=>c.item),...(prev?[{...prev,sourceStart:Math.max(prev.sourceStart,prev.sourceEnd-3)}]:[])],library);stages.framesMs+=performance.now()-phaseStart;check();
    const map=new Map(resources.shots.map(s=>[s.id,s]));
    phaseStart=performance.now();const answers=await compare('visual',{state:{...context,previousImage:prev?images.length:null,candidates:candidates.map((c,j)=>({id:'c'+j,image:j+1,visual:c.visual,sourceRange:[+(c.item.sourceStart/c.item.sourceFps).toFixed(3),+(c.item.sourceEnd/c.item.sourceFps).toFixed(3)],people:map.get(c.shotId)?.characters,uncertainties:map.get(c.shotId)?.semantic?.uncertainties?.slice(0,1)})),evidence:'每图是本次实际裁剪窗口的起、中、终帧；最后一图为上一镜尾部。选项顺序没有优劣含义。优先保证人物、动作与保护关系可读，白光或像素变化大不能代替动作。'},questions:Object.fromEntries(candidates.map((_,j)=>['c'+j,{type:'score',instructions:`评价c${j}的实际画面对本次意图与前镜衔接的贡献。单镜只需承担局部作用，允许局部动作/近景/短运动模糊；不能要求每镜都讲完整故事或同时出现两个人。错误人物、纯闪白和职员表低分。`,criteria:['不成立','勉强','适合','很有表现力']}])),winnow:{images:images.map(x=>x.data)}},images);
    stages.visionMs+=performance.now()-phaseStart;finalCandidates=candidates.map((c,j)=>({...c,preview:images[j].url}));const ranked=candidates.map((c,j)=>({index:j,score:answers['c'+j]?.score}));if(ranked.some(x=>!Number.isFinite(x.score)))throw Error('Winnow缺少视觉评分');ranked.sort((a,b)=>b.score-a.score);const best=ranked[0];finalOutput={choice:best.score>=1.5?'c'+best.index:'search_more',scores:answers};
    if(finalOutput.choice==='search_more')continue;selected=finalCandidates[best.index];break;
  }
  const noSelection=!selected&&!allowKeep;
  if(selected&&!selected.keep)selected.item.mad={...selected.item.mad,intent};
  selected??={shotId:item.mad?.shotId,visual:item.label||'当前镜头',item:structuredClone(item),keep:true};
  const trace={id,context,rounds,calls,selected:{shotId:selected.shotId,visual:selected.visual,keep:selected.keep,preview:selected.preview},alternatives:finalCandidates.map(({item,...c})=>c),output:finalOutput,timing:{modelMs,totalMs:performance.now()-started,stages},noSuitableCandidate:!finalOutput||finalOutput.choice==='search_more'};
  const persistStart=performance.now();await writeFile(path.join(folder,'trace.json'),JSON.stringify(trace,null,2));stages.persistMs=performance.now()-persistStart;trace.timing.totalMs=performance.now()-started;stages.otherMs=Math.max(0,trace.timing.totalMs-Object.values(stages).reduce((a,b)=>a+b,0));await writeFile(path.join(folder,'trace.json'),JSON.stringify(trace,null,2));if(noSelection){const e=Error('两轮全库召回后仍无合适窗口，未写入时间轴；决策记录 '+id);e.status=422;throw e;}
  return {selected,trace,resources,model:'Winnow-12B',timing:{modelMs,prepareMs:trace.timing.totalMs-modelMs,totalMs:trace.timing.totalMs,stages},traceUrl:'/studio-assets/global-decisions/'+id+'/trace.json'};
}
