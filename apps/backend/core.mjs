import {randomUUID} from 'node:crypto';

export const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
export const frame=(v,fps=30)=>Math.round(v*fps)/fps;
export function isSpeechCue(cue){
  const text=cue.text.normalize('NFKC').replace(/[（(][^）)]*[）)]/g,'').replace(/[\s\p{P}\p{S}]/gu,'');
  if(text.length<3)return false;
  if(/^(?:はぁ|あっ|はっ|んっ|うっ|えっ|ふふっ?|ははっ?|んん|ああ|ええ|チュン|バン|ガラ|バチッ|キーン|コーン|カーン)+$/.test(text))return false;
  if(/(?:鳥のさえずり|うがいの音|ドアの音|チャイム|ﾁｬｲﾑ|爆発音|足音)/.test(cue.text)&&text.length<16)return false;
  return true;
}
export function dialogueUnits(cues){
  const units=[];
  for(const cue of cues){
    if(!isSpeechCue(cue))continue;
    const last=units.at(-1);
    if(last&&/[・、,→➡]\s*$/.test(last.text)&&cue.start-last.end<.7&&cue.end-last.start<15){last.end=cue.end;last.text=last.text.replace(/[・、,→➡]\s*$/,' ')+' '+cue.text;}
    else units.push({...cue});
  }
  return units;
}
export function parseSubtitles(text,offset=0) {
  const time=s=>s.trim().split(':').reduce((a,b)=>a*60+Number(b.replace(',','.')),0);
  const clean=s=>s.replace(/\{[^}]*\}/g,'').replace(/<[^>]*>/g,'').replace(/\\N/g,' ').trim();
  if(/^\[Script Info\]/m.test(text)) {
    let format=[];const cues=[];
    for(const line of text.split(/\r?\n/)) {
      if(line.startsWith('Format:') && /Start.*End.*Text/.test(line)) format=line.slice(7).split(',').map(s=>s.trim());
      if(!line.startsWith('Dialogue:')||!format.length)continue;
      const fields=line.slice(9).split(',');
      const get=n=>fields[format.indexOf(n)];
      const start=time(get('Start'))+offset,end=time(get('End'))+offset;
      const content=clean(fields.slice(format.indexOf('Text')).join(','));
      if(Number.isFinite(start)&&end>start&&content)cues.push({start:Math.max(0,start),end,text:content});
    }return cues;
  }
  return text.replace(/^\uFEFF/,'').split(/\r?\n\s*\r?\n/).flatMap(block=>{
    const lines=block.split(/\r?\n/);const i=lines.findIndex(s=>s.includes('-->'));
    if(i<0)return [];
    const [a,b]=lines[i].split('-->').map(s=>s.trim().split(/\s+/)[0]);
    const start=time(a)+offset,end=time(b)+offset,content=clean(lines.slice(i+1).join(' '));
    return Number.isFinite(start)&&end>start&&content?[{start:Math.max(0,start),end,text:content}]:[];
  });
}

export function validateProject(project,library) {
  if(!project||!Array.isArray(project.clips)||project.clips.length>600)throw Error('时间轴格式错误');
  const music=library.music.find(m=>m.id===project.musicId);
  if(!music)throw Error('请选择已分析的配乐');
  if(!Number.isFinite(project.duration)||project.duration<=0||project.duration>Math.min(600,music.duration))throw Error('时长超出配乐范围');
  const clips=[...project.clips].sort((a,b)=>a.start-b.start);
  const ids=new Set();let previousEnd=0;
  for(const clip of clips) {
    if(typeof clip.id!=='string'||ids.has(clip.id))throw Error('镜头 ID 重复或无效');ids.add(clip.id);
    const media=library.sources.find(s=>s.id===clip.sourceId);
    if(!media)throw Error('找不到镜头来源');
    for(const key of ['start','end','sourceIn','rate','gain'])if(!Number.isFinite(clip[key]))throw Error('镜头参数必须是有限数值');
    if(clip.start<previousEnd-1/60||clip.end<=clip.start||clip.end>project.duration+1/30)throw Error('视频轨道存在重叠或超出项目范围');
    if(clip.rate<.5||clip.rate>2||clip.sourceIn<0||clip.sourceIn+(clip.end-clip.start)*clip.rate>media.duration+.04)throw Error('素材入出点或变速超出范围');
    if(clip.safety&&(!Number.isFinite(clip.safety.start)||!Number.isFinite(clip.safety.end)||clip.sourceIn<clip.safety.start-.001||clip.sourceIn+(clip.end-clip.start)*clip.rate>clip.safety.end+.001))throw Error('剪辑越过已复检的安全镜头区间');
    if(clip.gain<0||clip.gain>1.5)throw Error('原声音量超出范围');
    if(clip.audioWindow&&(!Number.isFinite(clip.audioWindow.start)||!Number.isFinite(clip.audioWindow.end)||clip.audioWindow.start<0||clip.audioWindow.end<=clip.audioWindow.start||clip.audioWindow.end>media.duration))throw Error('台词原声范围无效');
    if(!['none','punch','flash'].includes(clip.effect))throw Error('不支持的效果');
    previousEnd=clip.end;
  }
  if(!Number.isFinite(project.musicGain)||project.musicGain<0||project.musicGain>1.5)throw Error('配乐音量超出范围');
  return {...project,clips};
}

export function buildSlots(music,duration,intensity=.6) {
  const beatTimes=music.beats.map(b=>typeof b==='number'?b:b.time).filter(t=>t>0&&t<duration);
  const beat=60/(music.bpm||120);
  const slots=[];let start=0,i=0;
  while(start<duration-.05) {
    const p=start/duration,phase=p<.18?'铺垫':p<.42?'蓄势':p<.85?'爆发':'收束';
    const steps=phase==='爆发'?(intensity>.7?[2,1,1,2,2,4][i%6]:[2,2,4][i%3]):phase==='铺垫'?(i===0?16:8):4;
    let end=beatTimes.find(t=>t>=start+steps*beat-.12)??duration;
    end=frame(Math.min(duration,Math.max(start+.25,end)));
    if(duration-end<.5)end=duration;
    if(end<=start)break;
    const accents=(music.accents||[]).filter(a=>a.time>=start&&a.time<end);
    const strongest=[...accents].sort((a,b)=>b.strength-a.strength)[0];
    slots.push({id:'slot-'+i,start,end,phase,accent:strongest?.time??start,energy:strongest?.strength??.5});
    start=end;i++;
  }
  return slots;
}

export function candidatesForSlot(slot,shots,used=new Set(),allowDialogue=true) {
  const length=slot.end-slot.start;
  return shots.filter(s=>!used.has(s.id)&&s.end-s.start>=length*.65&&!s.excluded).flatMap(shot=>{
    const duration=shot.end-shot.start;
    // Speech is kept at original speed; it is only eligible if the complete cue fits.
    const cue=allowDialogue?dialogueUnits(shot.cues||[]).filter(c=>!/[・、,]\s*$/.test(c.text)&&c.end-c.start<=length-.16&&c.start>=shot.start&&c.end<=shot.end).sort((a,b)=>b.text.length-a.text.length)[0]:null;
    const rates=cue?[1]:[1,.85,1.15,1.5];
    const variants=rates.flatMap(rate=>{
      if(length*rate>duration)return [];
      const anchor=cue?cue.start:(shot.anchor??(shot.start+duration*.5));
      let sourceIn=clamp(anchor-(slot.accent-slot.start)*rate,shot.start,shot.end-length*rate);
      if(cue)sourceIn=clamp(cue.start-.1,Math.max(shot.start,cue.end-length),Math.min(cue.start,shot.end-length));
      const anchorOutput=slot.start+(anchor-sourceIn)/rate;
      const error=Math.abs(anchorOutput-slot.accent);
      const motion=shot.motion??.5;
      const fit=slot.phase==='爆发'?motion:1-motion;
      return [{shot,sourceIn,rate,anchorOutput,anchorError:error,cue,
        localScore:fit*.6+Math.max(0,1-error)*.25+(cue&&slot.phase!=='爆发'?.2:0)-Math.abs(rate-1)*.15+(shot.semanticScore||0)/3*.5}];
    });
    variants.sort((a,b)=>b.localScore-a.localScore);
    return variants.slice(0,1);
  }).sort((a,b)=>b.localScore-a.localScore).slice(0,8);
}

export function slotsAroundLocks(music,duration,intensity,locked=[]){
  if(locked.some(c=>c.end>duration))throw Error('新时长会截断已锁定镜头，请延长时长或先解锁');
  const base=buildSlots(music,duration,intensity),slots=[];let gapStart=0;
  for(const hold of [...locked].sort((a,b)=>a.start-b.start).concat({start:duration,end:duration})){
    for(const s of base){const start=Math.max(gapStart,s.start),end=Math.min(hold.start,s.end);if(end>start+.015)slots.push({...s,start,end,accent:Math.max(start,Math.min(end-.01,s.accent))});}
    if(hold.id)slots.push({start:hold.start,end:hold.end,lockedClip:hold});
    gapStart=hold.end;
  }
  return slots;
}

export function makeClip(slot,candidate,selection={}) {
  const {shot,sourceIn,rate,cue}=candidate;
  return {id:randomUUID(),sourceId:shot.sourceId,shotId:shot.id,start:slot.start,end:slot.end,
    sourceIn,rate,gain:cue?1:0,effect:slot.phase==='爆发'&&slot.energy>.7?'punch':'none',
    dialogue:cue?.text??'',audioWindow:cue?{start:cue.start,end:cue.end}:null,anchor:shot.anchor,anchorOutput:candidate.anchorOutput,
    title:shot.description||shot.label||shot.id,phase:slot.phase,locked:false,
    decision:selection};
}

export function searchShots(shots,query) {
  const terms=query.toLowerCase().match(/[\p{L}\p{N}]+/gu)||[];
  const chars=[...new Set(query.replace(/\s/g,''))];
  return shots.map(shot=>{
    const text=[shot.description,shot.label,...(shot.cues||[]).map(c=>c.text)].join(' ').toLowerCase();
    const score=terms.reduce((sum,t)=>sum+(text.includes(t)?3:0),0)+chars.reduce((sum,c)=>sum+(text.includes(c)?.1:0),0);
    return {...shot,retrievalScore:score};
  }).sort((a,b)=>b.retrievalScore-a.retrievalScore);
}
