import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {execFile,root} from './catalog.mjs';
const eventWarmups=new Map();let warmupQueue=Promise.resolve();
/** Interactive reads never synchronously run a whole-song FFT/HPSS analysis. */
export async function cachedMusicEvents(music){
  try{return JSON.parse(await readFile(path.join(root,'.local/music-events',music.id+'-v1.json'),'utf8'));}catch{}
  if(!eventWarmups.has(music.id)){const task=warmupQueue.catch(()=>{}).then(()=>musicEvents(music));warmupQueue=task;eventWarmups.set(music.id,task);task.catch(()=>eventWarmups.delete(music.id));}
  return {method:'cached beat grid; detailed acoustic events pending',events:(music.beats||[]).map(t=>({time:typeof t==='number'?t:t.time,strength:.5,band:'beat-grid-estimate'})),primaryAccents:[]};
}

export async function musicEvents(music){
  const directory=path.join(root,'.local/music-events');await mkdir(directory,{recursive:true});const file=path.join(directory,music.id+'-v1.json');
  try{return JSON.parse(await readFile(file,'utf8'));}catch{}
  await execFile((process.env.MAD_PYTHON||path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python')),['scripts/analyze_music_events.py',music.original,file]);return JSON.parse(await readFile(file,'utf8'));
}

export function firstRhythmicEntry(events,beatSeconds){
  const attacks=events.events.filter(e=>e.time>.18&&e.low>.65&&e.mid>.5&&e.salience>.8);
  // A sustained early pulse train outranks a later global loudness maximum.
  return attacks.find(e=>[1,2,3].filter(k=>attacks.some(next=>Math.abs(next.time-e.time-k*beatSeconds)<beatSeconds*.2)).length>=2)?.time??events.primaryAccents[0]?.time??beatSeconds;
}

export async function chooseAccentPolicies(events,intent,plan,{decide,logDir}){
  const anchors=events.primaryAccents.filter(e=>e.time<plan.beatTimes.at(-1)).map((e,i)=>({...e,id:'a'+i,section:plan.sections.find(s=>s.start<=e.time&&s.end>e.time)?.intent}));
  const policies=['cut','carry','breathe'];
  const questions=Object.fromEntries(anchors.flatMap(e=>policies.map(policy=>[e.id+'_'+policy,{type:'score',instructions:`Score ${policy} at anchor ${e.id}. cut: change shot on accent; carry: let an action reach its peak within a shot; breathe: briefly calm the preceding image, then release on accent. Use musical context and contrast; avoid treating all transients as equal.`,criteria:['不适合','一般','合适','很合适']}])));
  if(!anchors.length)return {anchors:[],calls:0,ms:0};
  const result=await decide({state:{music:intent.summary,referenceRule:'主重音先行，重音前呼吸，密集段和短暂收敛形成反差。镜头内动作峰值也能卡点，不必每个重音都切镜。',anchors},questions},logDir);
  const chosen=anchors.map(e=>{const ranked=policies.map(policy=>({policy,score:result.result.answers?.[e.id+'_'+policy]?.score}));if(ranked.some(x=>!Number.isFinite(x.score)))throw Error('Winnow 重音策略评分缺失');ranked.sort((a,b)=>b.score-a.score);return {...e,...ranked[0],policyScores:ranked};});
  if(events.firstEntry!==undefined){const early=chosen.find(e=>Math.abs(e.time-events.firstEntry)<.1);if(early){early.policy='breathe';early.openingClimax=true;early.constraint='User: first established rhythm must release a climax';}else chosen.unshift({id:'opening',time:events.firstEntry,policy:'breathe',openingClimax:true,role:'primary',strength:1});}
  return {anchors:chosen,calls:1,ms:result.ms};
}

export function shapeAroundAccents(slots,anchors,beatSeconds){
  if(!slots.length)return slots;
  const beginning=slots[0].start,duration=slots.at(-1).end,frame=t=>Math.round(t*30)/30;
  let boundaries=[slots[0].start,...slots.map(s=>s.end)];
  const within=(t,a,b)=>t>a+.025&&t<b-.025;
  for(const anchor of anchors){
    const t=frame(anchor.time);if(t<.2||t>duration-.2)continue;
    if(anchor.policy==='carry'){
      const a=Math.max(beginning,frame(t-beatSeconds*.55)),b=Math.min(duration,frame(t+beatSeconds*.55));
      boundaries=boundaries.filter(x=>!within(x,a,b));boundaries.push(a,b);
    }else{
      // Short visual anticipation, never a forced black gap or silent music splice.
      const breath=anchor.policy==='breathe'?beatSeconds*.85:beatSeconds*.3;
      const a=Math.max(beginning,frame(t-breath));boundaries=boundaries.filter(x=>!within(x,a,t));boundaries.push(t);
      if(anchor.policy==='breathe')boundaries.push(a);
    }
  }
  boundaries=[...new Set(boundaries)].sort((a,b)=>a-b);
  const priority=t=>t===beginning||t===duration?3:anchors.some(a=>Math.abs(frame(a.time)-t)<.02&&a.policy!=='carry')?2:1;
  for(let i=1;i<boundaries.length;){if(boundaries[i]-boundaries[i-1]<.16&&!(priority(boundaries[i])===3&&priority(boundaries[i-1])===3)){const remove=priority(boundaries[i])>priority(boundaries[i-1])?i-1:i;boundaries.splice(remove,1);i=Math.max(1,i-1);}else i++;}
  return boundaries.slice(0,-1).map((start,i)=>{
    const end=boundaries[i+1],base=slots.find(s=>s.start<=start+.02&&s.end>start+.02)||slots.at(-1);
    const hit=anchors.find(a=>a.time>=start-.035&&a.time<end-.02),before=anchors.find(a=>a.policy==='breathe'&&Math.abs(frame(a.time)-end)<.02);
    return {...base,id:'slot-'+i,start,end,accent:hit?Math.max(start,Math.min(end-1/30,hit.time)):Math.max(start,Math.min(end-1/30,base.accent)),
      beats:(end-start)/beatSeconds,energy:hit?Math.max(.85,base.energy):before?base.energy*.6:base.energy,accentRole:hit?'primary':before?'anticipation':'rhythmic',accentPolicy:hit?.policy||null,openingClimax:!!hit?.openingClimax};
  });
}
