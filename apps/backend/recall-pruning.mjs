// Single-decision shortlists only. Never feed this output back as the next search scope.
export function mergeRecallLanes(lanes,{limit=128}={}){
  const byId=new Map();for(const lane of lanes)for(const [rank,shot]of lane.shots.entries()){
    if(shot.excluded)continue;let row=byId.get(shot.id);if(!row){row={...shot,recallScore:0,recallEvidence:[]};byId.set(shot.id,row);}
    row.recallScore+=(lane.weight??1)/(60+rank+1);row.recallEvidence.push({lane:lane.name,rank:rank+1,similarity:shot.embeddingSimilarity??null});
  }
  return [...byId.values()].sort((a,b)=>b.recallScore-a.recallScore).slice(0,limit);
}
function similarity(a,b){
  if(a.id===(b.id??b.shotId))return 1;
  if(a.sourceId!==b.sourceId)return 0;
  if(a.sceneId&&a.sceneId===b.sceneId)return .9;
  const distance=Math.abs(a.start-(b.start??b.sourceIn));return Number.isFinite(distance)?Math.max(0,1-distance/30)*.65:0;
}
export function pruneDecisionCandidates(candidates,{limit=8,recent=[],allowReuse=[],continuation=false,continuationSceneId}={}){
  const permitted=new Set(allowReuse),pool=candidates.filter(c=>!c.excluded&&!recent.some(r=>(r.id??r.shotId)===c.id&&!permitted.has(c.id)));
  const result=[],max=Math.max(...pool.map(c=>c.recallScore||0),1e-9);
  while(pool.length&&result.length<limit){let best=-1,bestScore=-Infinity,details;
    for(let i=0;i<pool.length;i++){const c=pool[i],base=Number.isFinite(c.winnowScore)?c.winnowScore/3:(c.recallScore||0)/max;
      const recentPenalty=recent.reduce((m,r)=>Math.max(m,similarity(c,r)),0)*((continuation||continuationSceneId&&c.sceneId===continuationSceneId)?.06:.32);
      const shortlistPenalty=result.reduce((m,r)=>Math.max(m,similarity(c,r)),0)*.24;
      const score=base-recentPenalty-shortlistPenalty;
      if(score>bestScore){best=i;bestScore=score;details={base,recentPenalty,shortlistPenalty,score};}
    }
    result.push({...pool.splice(best,1)[0],pruning:details});
  }
  return result;
}
