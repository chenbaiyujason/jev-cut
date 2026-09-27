import {appendFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {configuration} from './gemini.mjs';
let tail=Promise.resolve();
export function validateDecision(body,result){
  if(!result||typeof result.answers!=='object'||Array.isArray(result.answers))throw Error('决策服务未返回 answers 对象');
  for(const [name,q]of Object.entries(body.questions||{})){
    const answer=result.answers[name];if(!answer)throw Error(`缺少决策字段 ${name}`);
    if(q.type==='choice'&&!Object.hasOwn(q.criteria,answer.choice))throw Error(`无效候选 ID：${name}`);
    if(q.type==='score'&&(!Number.isFinite(answer.score)||answer.score<0||answer.score>q.criteria.length-1))throw Error(`无效评分：${name}`);
  }
  return result;
}
export function decide(body,logDir){const task=tail.catch(()=>{}).then(async()=>{
  const cfg=await configuration(),endpoint=(cfg.JEV_DECISION_URL||cfg.WINNOW_URL||'http://127.0.0.1:8091').replace(/\/$/,''),key=cfg.JEV_API_KEY||cfg.WINNOW_API_KEY;
  const request=structuredClone(body);request.winnow={reuse_prefix:true,diagnostics:true,...request.winnow};
  if(cfg.JEV_MODEL)request.model=cfg.JEV_MODEL;
  const hasImages=!!request.winnow.images?.length,policy=cfg.JEV_IMAGE_POLICY||'required';
  if(hasImages&&cfg.JEV_SUPPORTS_IMAGES==='false'&&policy!=='text-only')throw Error('当前决策模型不支持图像；请换视觉模型或显式设置 JEV_IMAGE_POLICY=text-only');
  if(hasImages&&policy==='text-only'){delete request.winnow.images;request.state={...request.state,evidence_warning:'Image evidence explicitly omitted by JEV_IMAGE_POLICY=text-only; decide only from supplied descriptions.'};}
  const started=performance.now(),headers={'Content-Type':'application/json'};if(key)headers.Authorization=`Bearer ${key}`;
  const response=await fetch(endpoint+(cfg.JEV_DECISION_PATH||'/v1/systemone'),{method:'POST',headers,body:JSON.stringify(request),signal:AbortSignal.timeout(Number(cfg.JEV_TIMEOUT_MS||30000))});
  const result=await response.json(),ms=performance.now()-started;
  if(!response.ok){let reason=JSON.stringify(result);if(key)reason=reason.replaceAll(key,'[redacted]');throw Error(`jev 决策服务 ${response.status}: ${reason.slice(0,350)}`);}
  validateDecision(request,result);
  if(logDir){await mkdir(logDir,{recursive:true});await appendFile(path.join(logDir,'decisions.jsonl'),JSON.stringify({at:new Date().toISOString(),request:{...request,winnow:{...request.winnow,images:request.winnow.images?.map(()=>'<local-image>')}},response:result,ms,adapter:{imagePolicy:policy,modelRequested:cfg.JEV_MODEL||null}})+'\n');}
  return {result,ms};
});tail=task;return task;}
