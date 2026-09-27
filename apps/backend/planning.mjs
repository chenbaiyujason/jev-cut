import {understand} from './gemini.mjs';
import {understandStream} from './gemini-stream.mjs';
import {analyzeMusicIntent,musicContextAt} from './music-intent.mjs';

// Keep streamed work executable without restarting the whole model request for
// a harmless fractional beat (e.g. 1.5). Never repair invalid/nonpositive values.
export function normalizeStreamingSection(section){
  if(!Array.isArray(section.cut_pattern)||!section.cut_pattern.length||section.cut_pattern.some(x=>!Number.isFinite(x)||x<=0))throw Error('无效剪辑节奏');
  const normalized=section.cut_pattern.slice(0,6).map(x=>Math.max(.5,Math.min(4,Math.round(x*2)/2)));
  return {...section,requested_cut_pattern:section.cut_pattern,cut_pattern:normalized};
}

export function validatePlan(plan,beatTimes,shotIds){
  if(!Array.isArray(plan.sections)||!plan.sections.length||plan.sections.length>12)throw Error('Gemini 未给出有效音乐段落');
  let cursor=0;
  for(const section of plan.sections){
    if(!Number.isInteger(section.from_beat)||!Number.isInteger(section.to_beat)||section.from_beat!==cursor||section.to_beat<=cursor||section.to_beat>=beatTimes.length)throw Error('音乐段落必须连续覆盖且使用给定拍点');
    if(!Array.isArray(section.cut_pattern)||!section.cut_pattern.length||section.cut_pattern.some(x=>![.5,1,1.5,2,2.5,3,3.5,4,8,16].includes(x)))throw Error('无效剪辑节奏');
    if(!Number.isFinite(section.energy)||section.energy<0||section.energy>1)throw Error('段落能量值越界');
    for(const id of section.preferred_shots||[])if(!shotIds.has(id))throw Error('规划引用了素材库中不存在的镜头');
    cursor=section.to_beat;
  }
  if(cursor!==beatTimes.length-1)throw Error('音乐规划没有覆盖到结束');
  return plan;
}

export async function planEdit(music,shots,{duration,prompt,intensity,keepDialogue,events,globalScope=false,musicIntent,onSection,signal}, {understandFn=onSection?understandStream:understand}={}){
  musicIntent??=await analyzeMusicIntent(music);
  const musicalEvidence=musicContextAt(musicIntent,0,duration);
  const times=[0,...music.beats.filter(t=>t>.08&&t<duration-.08),duration];
  const mapped=shots.map((s,i)=>({id:'c'+i,episode:s.episode,summary:s.description,characters:s.characters,
    scene:s.sceneId,action:s.semantic?.actions?.map(a=>a.action).slice(0,2),emotion:s.semantic?.emotion,
    dialogue:s.semantic?.dialogue_meaning_zh,available_seconds:+Math.max(...(s.safeRanges||[s]).map(r=>r.end-r.start)).toFixed(2)}));
  const schema={type:'OBJECT',properties:{title:{type:'STRING'},premise:{type:'STRING'},sections:{type:'ARRAY',items:{type:'OBJECT',properties:{from_beat:{type:'INTEGER'},to_beat:{type:'INTEGER'},intent:{type:'STRING'},energy:{type:'NUMBER'},cut_pattern:{type:'ARRAY',items:{type:'NUMBER'}},preferred_shots:{type:'ARRAY',items:{type:'STRING'}},audio_intent:{type:'STRING'},music_basis:{type:'STRING'},visual_strategy:{type:'STRING'}},required:['from_beat','to_beat','intent','energy','cut_pattern','preferred_shots','audio_intent','music_basis','visual_strategy']}}},required:['title','premise','sections']};
  if(onSection)schema.properties={premise:{type:'STRING',description:'一句话全片情绪发展，最多45个汉字'},sections:schema.properties.sections,title:schema.properties.title};
  const instruction=`你是动漫 MAD 的剪辑导演。依据后面提供的真实音乐理解与程序拍点规划；本次不重复上传音频，不声称重新听过。围绕音乐的情绪发展、声部关系、停顿与释放来安排表达；不要按固定百分比套铺垫/高潮。创作要求：${prompt}。目标时长 ${duration} 秒，节奏强度 ${intensity}。${keepDialogue?'可以保留少量完整原声台词，给重要台词足够的听辨时间。':'不使用原声对白。'}\n候选来自多个完整剧集。应该从全库挑选视觉与叙事上相关的好镜头，允许跨集重组，但不要为了跨集而插入无关镜头。优先让相邻组在人物、动作方向、视觉意象或情绪上有明确联系，避免反复使用同一场戏与无意义倒序。\n只输出素材实际支持的主线和音乐段落。from_beat、to_beat 是下面拍点列表的整数索引，第一段从0开始，段落首尾衔接，最后到索引${times.length-1}。cut_pattern 用0.5/1/2/4表示每刀跨几拍，可长留、半句快切、高潮释放；单个模式最多6项。preferred_shots 从提供的 c编号中选8–20个，按合适顺序给出不同可行候选，不是最终时间轴。请为每段给出具体意图，不写泛泛的战斗/悲伤标签。\n拍点索引与秒数：${JSON.stringify(times.map((t,i)=>[i,+t.toFixed(3)]))}\n可用镜头：${JSON.stringify(mapped)}`;
  const evidenceText=`\n已从真实音频建立的独立音乐理解：${JSON.stringify(musicalEvidence)}\n分开处理音乐事实和用户创作目标。如果情绪相反，明确采用声画反差或改编，不能改写音乐事实。每段music_basis说明依据哪条音乐事实，visual_strategy说明由此采用的视觉关系与剪辑手法；intent和audio_intent必须具体承接音乐的情绪、主导声部、张力变化或人声留白；情绪强弱不等于切换速度。preferred_shots只是可行建议，最终每一镜和转场效果由Winnow决定。`;
  let response,correction='',emitted=0;
  const deliver=onSection?(section,index)=>{
    section=normalizeStreamingSection(section);
    if(section.from_beat!==emitted||section.to_beat>=times.length||!section.music_basis?.trim()||!section.visual_strategy?.trim()||!Array.isArray(section.preferred_shots)||section.preferred_shots.some(id=>!mapped.some(s=>s.id===id)))throw Error('首段规划校验失败，已生成镜头保留');
    validatePlan({sections:[{...section,from_beat:0,to_beat:1}]},[0,1],new Set(mapped.map(s=>s.id)));
    if(!Number.isInteger(section.from_beat)||!Number.isInteger(section.to_beat)||section.to_beat<=section.from_beat||section.cut_pattern.some(x=>x>4))throw Error('段落边界或节奏无效');
    emitted=section.to_beat;onSection({...section,id:'section-'+index,start:times[section.from_beat],end:times[section.to_beat]},times);
  }:undefined;
  for(let attempt=0;attempt<(onSection?1:2);attempt++){
    const dense=events?`\n重要更新，覆盖上面的通用节奏建议：这是高密度动漫MAD，常态以0.5/1/2拍组合剪，4拍只用于极少量明确呼吸或重要台词，禁止8/16拍长留。同一段应交替长短，不能匀速每拍一刀。第一个已经建立的节奏在 ${events.firstEntry.toFixed(3)} 秒，那里必须是首个视觉高潮，第一段 preferred_shots 要给出强动作、爆发或显著视觉释放，不能先用十多秒空镜慢铺垫。全曲最高重音不用等。参考教程的方法是主重音先行、前置短暂呼吸、释放后再次积累；无需改动原曲或插入黑屏。实测稀疏主重音：${JSON.stringify(events.primaryAccents.map(e=>({time:e.time,strength:e.strength,band:e.band})))}。一般镜头0.23–0.9秒、少量呼吸0.9–1.5秒，根据音乐实际节奏决定，不能把平静情绪直接变成长镜头。`:'';
    const globalRule=globalScope?'\n全库决策模式：此处没有预选素材池。每个新镜头都将独立查询完整素材库。只规划音乐对应的表达目标、节奏和声音意图；每段preferred_shots必须为空数组，不编造镜头编号，不建立可用素材白名单。没有画面证据时，visual_strategy必须写成待检索的动作或视觉关系需求，不得宣称已有具体镜头、微观动作或剧情事实；由Winnow检索后确认。music_basis引用的具体时间必须落在本段给定拍点范围内，不得把后段重音安排到本段。':'';
    response=await understandFn([{text:instruction+evidenceText+dense+correction+globalRule+(onSection?'\n按schema顺序先输出一句全局方向，再立即输出sections。各段意图、音乐依据和视觉策略各不超过45字，给可执行的检索目标，不写修辞长文。':'')}],{schema,maxTokens:6000,thinkingLevel:'LOW',onSection:deliver,signal,cacheKey:(globalScope?'global-':'')+'music-context-plan-v4-'+attempt});
    if(onSection)response.result.sections=response.result.sections.map(normalizeStreamingSection);
    if(events&&response.result.sections?.some(s=>s.cut_pattern.some(x=>x>4))){correction='\n上次模式过慢，所有 cut_pattern 只能使用0.5、1、2、4，主要用0.5、1、2。';if(attempt===0&&!onSection)continue;throw Error('音乐计划仍过慢，未覆盖已有时间轴');}
    try{validatePlan(response.result,times,new Set(mapped.map(s=>s.id)));
      if(response.result.sections.some(s=>!s.music_basis?.trim()||!s.visual_strategy?.trim()))throw Error('每段必须说明音乐依据与视觉策略');
      break;}
    catch(error){if(attempt===1||onSection)throw error;correction=`\n上次计划未通过校验：${error.message}。cut_pattern 使用0.5、1、2、4，余下不足的拍数由程序截断。各段首尾必须连续，引用的 c编号必须存在。修正这份计划并重新输出完整 JSON：${JSON.stringify(response.result)}`;}
  }
  const idMap=new Map(mapped.map((s,i)=>[s.id,shots[i].id]));
  const sections=response.result.sections.map((s,i)=>({...s,id:'section-'+i,start:times[s.from_beat],end:times[s.to_beat],preferred_shots:s.preferred_shots.map(id=>idMap.get(id))}));
  return {...response.result,sections,beatTimes:times,musicUnderstandingId:musicIntent.id,inputs:{rawAudio:false,musicUnderstanding:true,acousticBeats:true},model:response.model,metrics:response.metrics,cached:response.cached||false};
}

export function slotsFromPlan(plan,music,duration,locked=[]){
  const slots=[];
  const beatTime=beat=>{const i=Math.floor(beat),fraction=beat-i;return fraction?plan.beatTimes[i]+fraction*(plan.beatTimes[i+1]-plan.beatTimes[i]):plan.beatTimes[i];};
  for(const section of plan.sections){let beat=section.from_beat,i=0;
    while(beat<section.to_beat){let next=Math.min(section.to_beat,beat+section.cut_pattern[i%section.cut_pattern.length]);
      if(beatTime(section.to_beat)-beatTime(next)<.12)next=section.to_beat;
      const start=Math.round(beatTime(beat)*30)/30,end=next===plan.beatTimes.length-1?duration:Math.round(beatTime(next)*30)/30;
      if(end-start>=1/30-1e-6){const accent=(music.accents||[]).filter(a=>a.time>=start&&a.time<end).sort((a,b)=>b.strength-a.strength)[0];
        slots.push({id:'slot-'+slots.length,start,end,beats:next-beat,accent:accent?.time??start,energy:section.energy,phase:[section.intent,section.visual_strategy].filter(Boolean).join('；'),musicBasis:section.music_basis,sectionId:section.id,preferred:section.preferred_shots,audioIntent:section.audio_intent});}
      beat=next;i++;
    }
  }
  if(!locked.length)return slots;
  if(locked.some(c=>c.end>duration))throw Error('新时长会截断锁定镜头');
  const out=[];let cursor=0;
  for(const hold of [...locked].sort((a,b)=>a.start-b.start).concat({start:duration,end:duration})){
    for(const s of slots){const start=Math.max(cursor,s.start),end=Math.min(hold.start,s.end);if(end>start+.02)out.push({...s,start,end,accent:Math.max(start,Math.min(end-.01,s.accent))});}
    if(hold.id)out.push({start:hold.start,end:hold.end,lockedClip:hold});cursor=hold.end;
  }
  return out;
}
