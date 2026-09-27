import {createHash} from 'node:crypto';
import {fullCorpus} from './corpus-cache.mjs';
import {retrieve} from './retrieval.mjs';
import {mergeRecallLanes} from './recall-pruning.mjs';

/** Each decision starts from the authoritative full corpus, never a project/phrase pool. */
export async function recallForDecision({decisionId,context,queries,limit=128},{loadCorpus=fullCorpus,search=retrieve}={}){
  if(!decisionId||!context||!Array.isArray(queries)||!queries.length||queries.some(q=>!q.name||typeof q.query!=='string'||!q.query.trim()))throw Error('决策ID、当前上下文和检索方向不能为空');
  if(!Number.isInteger(limit)||limit<1||limit>512)throw Error('单次召回预算必须为1–512');
  const corpus=await loadCorpus();
  const sources=corpus.sources.map(source=>({...source,shots:corpus.shots.filter(s=>s.sourceId===source.id)}));
  const eligible=corpus.shots.filter(s=>!s.excluded&&s.semanticStatus==='complete'),ids=new Set(eligible.map(s=>s.id)),episodes=[...new Set(eligible.map(s=>s.episode))].sort((a,b)=>a-b);
  const contextHash=createHash('sha256').update(JSON.stringify(context)).digest('hex');
  const scopeHash=createHash('sha256').update([...ids].sort().join('\n')).digest('hex');
  const started=performance.now();
  const lanes=await Promise.all(queries.map(async({name,query,weight=1,contextShotIds=[]})=>{
    // No episodeIds or allowedShotIds are accepted. Per-episode quotas do not gate search.
    const result=await search({sources},query,{perEpisode:Number.MAX_SAFE_INTEGER,limit,contextShotIds});
    if(result.totalEligible!==eligible.length||JSON.stringify([...result.episodesSearched].sort((a,b)=>a-b))!==JSON.stringify(episodes))throw Error('检索范围意外缩小，本次决策已停止');
    if(result.shots.some(s=>!ids.has(s.id)))throw Error('召回返回了全库范围之外或被去重的素材');
    return {name,query,weight,contextShotIds,...result};
  }));
  return {decisionId,contextHash,scope:{kind:'full-corpus-per-decision',scopeHash,corpusBuiltAt:corpus.builtAt,eligible:eligible.length,episodes},ms:performance.now()-started,
    candidates:mergeRecallLanes(lanes,{limit}),lanes:lanes.map(l=>({name:l.name,query:l.query,contextShotIds:l.contextShotIds,method:l.method,warning:l.warning,count:l.shots.length})),candidateLifetime:'this decision and this context only; never becomes a future eligibility list'};
}
