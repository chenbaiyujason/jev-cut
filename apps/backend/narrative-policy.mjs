export const sayakaStages=[
 {id:0,name:'日常与牵挂',intent:'开朗直率、与朋友相处、关心病中的上条恭介；尚未成为魔法少女。'},
 {id:1,name:'愿望与正义',intent:'为恭介许愿，成为魔法少女，展现剑术、勇敢和正义感。'},
 {id:2,name:'冲突与感情受挫',intent:'与杏子的价值观冲突、身体真相、仁美与恭介的关系使她受挫。'},
 {id:3,name:'逞强与崩溃',intent:'强撑战斗、愤怒与悲伤加深，关系破裂；仍是人类/魔法少女形态。'},
 {id:4,name:'绝望与余韵',intent:'灵魂宝石污染、变为人鱼魔女及朋友试图挽回的后果；不能回到早期开心日常。'}
];
export function narrativeRejections(shot,policy,history=[]){
 if(!policy)return [];
 const tag=policy.annotations[shot.id],reasons=[];
 if(policy.blockedShotIds?.includes(shot.id))reasons.push('replace-unintentional-repeat');
 if(policy.enforceWithinStageOrder&&tag&&Number.isFinite(policy.maxOrder)&&tag.order>policy.maxOrder)reasons.push('would-skip-next-character-event');
 if(!tag||tag.stage!==policy.stage||tag.confidence<.55)reasons.push('outside-current-growth-stage');
 if(tag&&!tag.onScreen&&!tag.supporting)reasons.push('unrelated-to-protagonist');
 const last=history.at(-1),lastTag=last&&policy.annotations[last.shotId];
 if(tag?.supporting&&!tag.onScreen&&lastTag&&!lastTag.onScreen)reasons.push('consecutive-supporting-shots');
 // Coarse 0/1/2 annotations are editorial hints, not verified event timestamps.
 // Growth-stage ordering remains mandatory; stricter event ordering needs explicit evidence.
 if(policy.enforceWithinStageOrder&&tag&&lastTag?.stage===policy.stage&&Number.isFinite(tag.order)&&Number.isFinite(lastTag.order)&&tag.order<lastTag.order)reasons.push('character-event-order-reversal');
 return reasons;
}

// The middle arc is chronological in TV Edition episodes 4–7: conflict,
// soul separation/revival, bodily pain, then romantic rejection and crying.
// Keep musical duration and chapter boundaries; reorder only already selected blocks.
export function orderSayakaMiddleArc(project,shots){
 const p=structuredClone(project),map=new Map(shots.map(s=>[s.id,s])),videos=p.timeline.items.filter(i=>i.type==='video').sort((a,b)=>a.from-b.from);
 const middle=videos.filter(i=>i.mad?.storyStage===2);if(middle.length<2)return {project:p,changes:[]};
 const blocks=[];for(const item of middle){const parent=item.mad?.remapParent||item.id,last=blocks.at(-1);if(last?.parent===parent)last.items.push(item);else blocks.push({parent,items:[item]});}
 const eligible=blocks.every(b=>{const s=map.get(b.items[0].mad?.shotId);return s&&s.episode>=4&&s.episode<=7;});if(!eligible)return {project:p,changes:[],note:'非主时间线的中段画面未自动按文件顺序调整'};
 const sorted=blocks.toSorted((a,b)=>{const sa=map.get(a.items[0].mad.shotId),sb=map.get(b.items[0].mad.shotId);return sa.episode-sb.episode||a.items[0].sourceStart/a.items[0].sourceFps-b.items[0].sourceStart/b.items[0].sourceFps;});
 let cursor=middle[0].from;const changes=[];
 for(const block of sorted){const first=block.items[0],delta=cursor-first.from;
  for(const item of block.items){if(delta){changes.push({id:item.id,from:item.from,to:item.from+delta,reason:'same-growth-stage causal order'});item.from+=delta;}
   const linked=p.timeline.items.filter(a=>a.type==='audio'&&a.mad?.audioFor===item.id);for(const a of linked)a.from+=delta;
  }cursor+=block.items.reduce((s,i)=>s+i.durationInFrames,0);
 }
 return {project:p,changes};
}
