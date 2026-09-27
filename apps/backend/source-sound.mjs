import {isSpeechCue} from './core.mjs';

export function sourceSoundCandidate(clip,shot){
  if(clip.gain>0||clip.accentRole==='anticipation')return null;
  const start=clip.sourceIn,end=start+(clip.end-clip.start)*clip.rate;
  const candidates=(shot.semantic?.audio_events||[]).filter(e=>/音效|枪|爆|撞|脚步|齿轮|水花|机械|sfx|effect|impact/i.test(e.type+' '+e.description)&&!/(对白|旁白|speech|dialogue|独白)/i.test(e.type));
  for(const event of candidates){
    const a=Math.max(start,event.start),b=Math.min(end,event.end);
    if(b-a<.08||(shot.cues||[]).some(c=>isSpeechCue(c)&&c.start<b&&c.end>a))continue;
    return {start:a,end:b,description:event.description,type:event.type,partial:a>event.start||b<event.end};
  }
  return null;
}

export function applySoundDecisions(clips,decisions){
  const candidates=decisions.map(d=>({...d,clip:clips.find(c=>c.id===d.clipId)})).filter(d=>d.clip&&d.score>=2.2&&d.clip.accentRole!=='anticipation')
    .sort((a,b)=>(b.score+(b.clip.accentRole==='primary'?.3:0))-(a.score+(a.clip.accentRole==='primary'?.3:0)));
  const kept=[],limit=Math.max(1,Math.ceil((clips.at(-1)?.end||0)/4));
  for(const candidate of candidates){if(kept.length>=limit)break;if(kept.some(d=>Math.abs(d.clip.start-candidate.clip.start)<1.25))continue;kept.push(candidate);}
  for(const {clip,score,sound} of kept){clip.gain=clip.accentRole==='primary'?.6:.4;clip.audioWindow={start:sound.start,end:sound.end};clip.sourceAudioKind='effect';clip.sourceAudioDescription=sound.description;clip.soundDecision={source:'Winnow 原声点缀评分',score,partial:sound.partial};}
  return kept.length;
}

export async function selectSourceSound(sources,clips,brief,{decide,logDir}){
  const shots=new Map(sources.flatMap(s=>s.shots.map(shot=>[shot.id,shot]))),candidates=clips.flatMap((clip,index)=>{
    const shot=shots.get(clip.shotId);if(!shot)return [];const sound=sourceSoundCandidate(clip,shot);return sound?[{id:'s'+index,index,clip,sound}]:[];
  });
  let calls=0,ms=0;const decisions=[];
  for(let i=0;i<candidates.length;i+=12){
    const batch=candidates.slice(i,i+12),result=await decide({state:{brief,clips:batch.map(c=>({id:c.id,visual:c.clip.title,role:c.clip.accentRole,seconds:(c.sound.end-c.sound.start)/c.clip.rate,sound:c.sound.description,partial:c.sound.partial}))},questions:Object.fromEntries(batch.map(c=>[c.id,{type:'score',instructions:`Should original sound ${c.id} accent this visual and music? Keep meaningful impact, mechanism, footstep or motion sound. Reject unrelated ambience, music leakage, clipped speech, or an arbitrary long noise. Short effect excerpts are allowed; dialogue must never be clipped.`,criteria:['不要保留','作用很弱','适合点缀','能明确强化动作或重音']}]))},logDir);
    calls++;ms+=result.ms;
    for(const candidate of batch){const score=result.result.answers?.[candidate.id]?.score;if(!Number.isFinite(score))throw Error('Winnow 原声评分缺失');decisions.push({clipId:candidate.clip.id,score,sound:candidate.sound});
    }
  }
  const kept=applySoundDecisions(clips,decisions);return {calls,ms,decisions,kept};
}
