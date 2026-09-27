// Evidence about the current sequence, never a project-wide eligibility pool.
export function windowFacts(shot,item){
  if(!shot)return {description:item?.label||'',unknown:true,sourceId:item?.mediaId,sourceRange:item?.sourceFps>0?[item.sourceStart/item.sourceFps,item.sourceEnd/item.sourceFps]:undefined,people:[],actions:[]};
  const semantic=shot.semantic||{},start=item?item.sourceStart/item.sourceFps:shot.start,end=item?item.sourceEnd/item.sourceFps:shot.end;
  const actions=(semantic.actions||[]).filter(a=>Number.isFinite(a.start)&&Number.isFinite(a.end)&&a.start<end&&a.end>start).map(a=>({action:a.action,phase:a.phase,direction:a.direction,confidence:a.confidence,visibleFraction:+(Math.max(0,Math.min(end,a.end)-Math.max(start,a.start))/Math.max(.001,a.end-a.start)).toFixed(2),onsetInWindow:a.start>=start&&a.start<end,completionInWindow:a.end>start&&a.end<=end,peakInWindow:Number.isFinite(a.peak)&&a.peak>=start&&a.peak<end}));
  return {shotId:shot.id,episode:shot.episode,sceneId:shot.sceneId,sourceId:shot.sourceId,sourceRange:[start,end],description:shot.description,people:shot.characters||[],setting:semantic.setting,shotSize:semantic.shot_size,screenDirection:semantic.screen_direction,emotion:semantic.emotion,motifs:semantic.visual_motifs?.slice(0,3),actions,dialogueMeaning:semantic.dialogue_meaning_zh?.slice(0,90),uncertainties:semantic.uncertainties?.slice(0,2)};
}
export function isReaction(facts){return /眼|凝视|注视|侧目|表情|脸|面部/.test(facts.description||'')&&!/开火|发射|射击|跃|奔跑|奔逃|抱起|拉住|击中|引爆/.test(facts.description||'');}
export function storyContext(project,item,shots,goal=''){
  const map=new Map(shots.map(s=>[s.id,s])),before=project.timeline.items.filter(i=>i.type==='video'&&i.from<item.from).sort((a,b)=>a.from-b.from);
  const history=before.slice(-6).map(i=>({...windowFacts(map.get(i.mad?.shotId),i),timeline:[i.from/project.metadata.fps,(i.from+i.durationInFrames)/project.metadata.fps]}));
  let reactionRun=0;for(const f of [...history].reverse()){if(!isReaction(f))break;reactionRun++;}
  let sceneRun=0;for(const f of [...history].reverse()){if(!f.sceneId||f.sceneId!==history.at(-1)?.sceneId)break;sceneRun++;}
  const shown=before.map(i=>({...windowFacts(map.get(i.mad?.shotId),i),at:i.from/project.metadata.fps}));
  const relation=f=>(f.people?.length||0)>=2&&/护|抱|救|拉住|挡在|扶住|擦拭/.test(f.description||'');
  const attack=f=>/开火|射击|发射|挥|引爆|扣动|迎击|突进/.test((f.actions||[]).map(a=>a.action).join(' '));
  const milestones=[['relationship',shown.find(relation)],['battle',shown.find(attack)],['setback',shown.find(f=>/受伤|流血|带血|倒地|哭泣|绝望/.test(f.description||''))],['recentRelationship',shown.findLast(relation)]].filter(([,f])=>f).map(([kind,f])=>({kind,at:f.at,shotId:f.shotId,evidence:f.description}));
  const nextNeeds=[],prev=history.at(-1),lastRelation=shown.findLast(relation),now=item.from/project.metadata.fps;
  if(/守护|保护|拯救/.test(goal)&&(!lastRelation||now-lastRelation.at>6))nextNeeds.push({kind:'show-protection',query:'两人同框，救援、挡在身前、拉住、抱起或扶起，交代保护关系。',basis:lastRelation?'保护关系已超过6秒未出现':'尚未展示保护关系，不可仅凭主题宣称观众已看懂'});
  const unfinished=prev?.actions?.filter(a=>a.confidence>=.65&&!a.completionInWindow&&/跑|跃|挥|开火|射击|发射|引爆|抱起|拉住|转身/.test(a.action||''))||[];
  if(unfinished.length)nextNeeds.push({kind:'finish-action',query:'继续真实动作直至完成，或用方向可接的镜头呈现动作结果。',basis:unfinished.map(a=>a.action).join('；')});
  else if(prev&&attack(prev))nextNeeds.push({kind:'show-result',query:'呈现刚才攻击的命中、防御、敌人反应或被保护者的结果。',basis:prev.description});
  if(reactionRun>=2)nextNeeds.push({kind:'advance-event',query:'选择主角实际执行的行动、行动结果或明确的人际回应，推进当前事件；武器与行为必须符合当前人物。',basis:`已经连续${reactionRun}镜为反应特写`});
  if(!nextNeeds.length)nextNeeds.push({kind:before.length?'develop-event':'establish',query:before.length?'接续当前小事件，补动作对象、准备、结果或明确情绪回应。':'建立主角性格、当前处境与人物关系，随音乐起势进入真实行动。',basis:prev?.description||'尚未展示任何画面'});
  const recentDurations=before.slice(-4).map(i=>+(i.durationInFrames/project.metadata.fps).toFixed(2));
  return {history,reactionRun,sceneRun,previous:prev,milestones,nextNeeds:nextNeeds.slice(0,2),recentDurations,evidencePolicy:'milestones来自已选窗口的素材标注，是可见证据线索，不是自动成立的因果。nextNeeds是待补信息建议，只需选一项推进；不能捏造镜头之外的剧情。',instruction:'每2–4镜组成一个可读的小事件：对象/威胁→准备→行动→结果或反应。优先解决nextNeeds中的一项，再考虑新的主题相似画面。动作可在一镜完成，也可跨镜衔接。结合最近持镜时长与音乐句子制造快慢反差，不要持续等长。跨场景是省略或联想，不得凭人物相同声称真实空间连续。'};
}
export function connectionEvidence(facts,story){
  const prev=story.previous;if(!prev)return {opening:true};
  const sameScene=!!facts.sceneId&&facts.sceneId===prev.sceneId;
  return {sameScene,forwardInSource:sameScene?facts.sourceRange[0]>=prev.sourceRange[1]-.05:null,sharedPeople:facts.people.filter(p=>prev.people?.includes(p)),sharedMotifs:(facts.motifs||[]).filter(p=>prev.motifs?.includes(p)),repeatedReaction:story.reactionRun>=2&&isReaction(facts),sceneAlreadyHeld:story.sceneRun>=4,warning:sameScene&&facts.sourceRange[0]<prev.sourceRange[0]?'同场景源时间倒退；只有明确闪回/重复强调才成立':undefined};
}
export function continuationCandidates(shots,story,used){
  const prev=story.previous;if(!prev||story.sceneRun>=4)return [];
  return shots.filter(s=>!s.excluded&&s.semanticStatus==='complete'&&!used.has(s.id)&&s.sourceId===prev.sourceId&&s.sceneId===prev.sceneId&&s.start>=prev.sourceRange[0]&&s.start-prev.sourceRange[1]<18).sort((a,b)=>a.start-b.start).slice(0,3);
}

export function candidateRejections(shot,story,{repriseAllowed=false}={}){
 const reasons=[];if(shot.semantic?.credits_or_logo||shot.qualityFlags?.creditsOrLogo)reasons.push('credits-or-logo');
 if(!repriseAllowed&&story.history.some(p=>p.sourceId===shot.sourceId&&(p.sceneId===shot.sceneId&&!!shot.sceneId||p.sourceRange[0]-shot.end<60&&(shot.characters||[]).some(x=>p.people?.includes(x)))&&shot.end<=p.sourceRange[0]+.02))reasons.push('unmotivated-local-source-reversal');
 return reasons;
}

export function carryWindow(project,item,previous,shots){
 const prev=previous.at(-1);if(!prev||prev.from+prev.durationInFrames!==item.from)return null;
 if(prev.locked||prev.isLocked||(prev.effects||[]).length||(project.timeline.keyframes||[]).some(k=>k.itemId===prev.id)||(project.timeline.tracks||[]).some(t=>t.id===prev.trackId&&(t.locked||t.isLocked)))return null;
 if((project.timeline.transitions||[]).some(t=>t.leftClipId===item.id||t.rightClipId===item.id))return null;
 const shot=shots.find(s=>s.id===prev.mad?.shotId);if(!shot||shot.semantic?.credits_or_logo)return null;
 const start=prev.sourceEnd,needed=Math.ceil(item.durationInFrames*prev.sourceFps*(prev.speed||1)/project.metadata.fps-1e-9),end=start+needed;
 if(!(shot.safeRanges||[]).some(r=>r.startFrame<=start&&r.endFrame>=end+1)||(shot.repeatedBands||[]).some(r=>start/prev.sourceFps<r.end&&end/prev.sourceFps>r.start))return null;
 return {shotId:shot.id,visual:shot.description,continuationOf:prev.id,keep:false,item:{...item,label:prev.label,mediaId:prev.mediaId,src:prev.src,sourceStart:start,sourceEnd:end,sourceFps:prev.sourceFps,sourceDuration:prev.sourceDuration,speed:prev.speed, mad:{...item.mad,assetId:prev.mediaId,shotId:shot.id,occurrenceId:item.id,continuationOf:prev.id}}};
}

export function actionWindowScore(shot,start,end,{accentFraction=.5,continuityPrevious}={}){
  const actions=(shot.semantic?.actions||[]).filter(a=>a.confidence>=.65&&Number.isFinite(a.start)&&Number.isFinite(a.end)&&a.end>a.start);
  const span=end-start;let actionFit=0;
  for(const a of actions){const overlap=Math.max(0,Math.min(end,a.end)-Math.max(start,a.start))/span;
    const peakFit=Number.isFinite(a.peak)&&a.peak>=start&&a.peak<end?1-Math.min(1,Math.abs((a.peak-start)/span-accentFraction)):0;
    actionFit=Math.max(actionFit,overlap*.35+peakFit*.8);
  }
  // Source reversal is evidence for the final decision, not an automatic window penalty.
  return actionFit;
}
