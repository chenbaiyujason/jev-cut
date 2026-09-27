import {randomUUID} from 'node:crypto';
import {compileTechnique} from './studio-techniques.mjs';
import {applyDirectorOps} from './director-edit.mjs';
import {windowFacts} from './story-continuity.mjs';
import {fpsOf} from './studio-project.mjs';

const end=i=>i.from+i.durationInFrames;
const key=(itemId,property,frame,value,easing='linear')=>({op:'addKeyframe',itemId,property,frame,value,easing});
function catalog(project,resources,library){return {...project,madCatalog:{assets:library.sources.map(s=>({assetId:s.id,mediaId:s.id,sourceFps:fpsOf(s.fps),sourceDurationFrames:Math.floor(s.duration*fpsOf(s.fps)),src:s.url,width:960,height:540})),shots:resources.shots.map(s=>({shotId:s.id,assetId:s.sourceId,sourceIn:s.startFrame,sourceOut:s.endFrame,safeRanges:s.safeRanges.map(r=>({sourceIn:r.startFrame,sourceOut:r.endFrame}))}))}};}
export function remapForAccent(item,shot,at,fps){
 const duration=item.durationInFrames,hit=Math.round(at*fps)-item.from;if(duration<21||hit<6||hit>duration-6)return null;
 const actions=(shot.semantic?.actions||[]).filter(a=>a.confidence>=.7&&Number.isFinite(a.peak)&&/挥|举枪|开火|发射|射击|奔跑|跳|跃|落地|引爆|扣动|按下/.test(a.action||''));
 const peak=actions.sort((a,b)=>Math.abs(a.peak-(item.sourceStart+item.sourceEnd)/2/item.sourceFps)-Math.abs(b.peak-(item.sourceStart+item.sourceEnd)/2/item.sourceFps))[0];if(!peak)return null;
 const split=Math.max(2,Math.floor(hit*.5)),times=[0,split,hit,duration],sourceHit=Math.round(peak.peak*item.sourceFps);
 const source=[Math.round(sourceHit-((hit-split)*1.8+split*.6)*item.sourceFps/fps),Math.round(sourceHit-(hit-split)*1.8*item.sourceFps/fps),sourceHit,Math.round(sourceHit+(duration-hit)*.7*item.sourceFps/fps)];
 if(!shot.safeRanges.some(r=>r.startFrame+1<=source[0]&&r.endFrame-1>=source[3])||(shot.repeatedBands||[]).some(r=>source[0]/item.sourceFps<r.end&&source[3]/item.sourceFps>r.start))return null;
 const segments=times.slice(0,-1).map((t,i)=>({from:t,durationInFrames:times[i+1]-t,sourceStart:source[i],sourceEnd:source[i+1],speed:(source[i+1]-source[i])*fps/((times[i+1]-t)*item.sourceFps)}));
 if(segments.some(s=>s.speed<.25||s.speed>4||s.sourceEnd<=s.sourceStart))return null;
 return {kind:'piecewise-speed-remap',anchor:{musicSeconds:at,sourceSeconds:sourceHit/item.sourceFps,action:peak.action},segments};
}
function cameraOps(project,item,peak,kind){
 const last=item.durationInFrames-1;if(last<3)return [];
 const p=Math.max(1,Math.min(last-1,peak)),start=Math.max(0,p-2),finish=Math.min(last,p+5),w=item.transform?.width||project.metadata.width,h=item.transform?.height||project.metadata.height;
 const keys=[];
 for(const [property,base]of [['width',w],['height',h]])for(const [f,v]of [[0,base],[start,base],[p,base*(kind==='shake'?1.16:1.23)],[finish,base],[last,base]])keys.push(key(item.id,property,f,v));
 if(kind==='shake'){
  for(const [prop,base,amp]of [['x',item.transform?.x||0,14],['y',item.transform?.y||0,8],['rotation',item.transform?.rotation||0,1.4]]){
   for(const [f,v]of [[0,base],[start,base],[p,base+amp],[Math.min(finish,p+1),base-amp*.7],[Math.min(finish,p+3),base+amp*.3],[finish,base],[last,base]])keys.push(key(item.id,prop,f,v));
  }
 }
 return keys;
}
function nativeBlurOps(item,peak,kind){
 const type=kind==='zoom'?'gpu-zoom-blur':'gpu-motion-blur',id='expr-'+randomUUID().slice(0,8),last=item.durationInFrames-1,p=Math.max(1,Math.min(last-1,peak));
 const effect={id,enabled:true,effect:{type:'gpu-effect',gpuEffectType:type,params:kind==='zoom'?{amount:0,centerX:.5,centerY:.5,samples:16}:{amount:0,angle:0,shutterAngle:180,samples:12}}};
 return [{op:'updateItem',id:item.id,updates:{effects:[...(item.effects||[]),effect]}},...[[0,0],[Math.max(0,p-2),0],[p,kind==='zoom'?.16:.055],[Math.min(last,p+4),0],[last,0]].map(([frame,value])=>key(item.id,`effect:${type}:${id}:amount`,frame,value))];
}
function whipOps(project,left,right,direction){
 const width=project.metadata.width,height=project.metadata.height,sign=direction==='left'?-1:1,ops=[];
 for(const [item,incoming]of [[left,false],[right,true]]){
  const last=item.durationInFrames-1,span=Math.min(4,last),a=incoming?0:last-span,b=incoming?span:last;
  // The enlarged image covers the canvas even at the largest lateral offset.
  for(const [property,base]of [['width',width],['height',height]])for(const [f,v]of [[0,incoming?base*1.22:base],[a,base*1.22],[b,base*1.22],[last,incoming?base:base*1.22]])ops.push(key(item.id,property,f,v));
  for(const [f,v]of [[0,incoming?-sign*width*.08:0],[a,incoming?-sign*width*.08:0],[b,incoming?0:sign*width*.08],[last,incoming?0:sign*width*.08]])ops.push(key(item.id,'x',f,v));
 }
 return ops;
}
function splitRemapped(project,item,plan){
 const ids=plan.segments.map((_,n)=>n?item.id+'-r'+n:item.id),oldKeys=project.timeline.keyframes.find(k=>k.itemId===item.id);
 const interpolate=(ks,f)=>{const sorted=ks.toSorted((a,b)=>a.frame-b.frame);const a=sorted.findLast(k=>k.frame<=f)||sorted[0],b=sorted.find(k=>k.frame>f);if(!b||a.easing==='hold')return a.value;return a.value+(b.value-a.value)*(f-a.frame)/(b.frame-a.frame);};
 const parts=plan.segments.map((s,n)=>({...structuredClone(item),id:ids[n],from:item.from+s.from,durationInFrames:s.durationInFrames,sourceStart:s.sourceStart,sourceEnd:s.sourceEnd,speed:s.speed,mad:{...item.mad,occurrenceId:ids[n],remapParent:item.id,timeRemap:plan}}));
 project.timeline.items=project.timeline.items.flatMap(i=>i.id===item.id?parts:[i]);
 project.timeline.keyframes=project.timeline.keyframes.filter(k=>k.itemId!==item.id);
 if(oldKeys)parts.forEach((part,n)=>{const offset=plan.segments[n].from;project.timeline.keyframes.push({itemId:part.id,animationVersion:2,properties:oldKeys.properties.map(p=>({property:p.property,keyframes:Array.from({length:part.durationInFrames},(_,f)=>({id:randomUUID(),frame:f,value:interpolate(p.keyframes,f+offset),easing:'linear'}))}))});});
 for(const t of project.timeline.transitions){if(t.leftClipId===item.id)t.leftClipId=ids.at(-1);if(t.rightClipId===item.id)t.rightClipId=ids[0];}
 return project;
}

/** Accent-level expressive decisions; all options are compiled before Winnow sees them. */
export async function directExpression({project,library,resources,events,ask,onProgress=()=>{},allowRemap=true,allowTransitions=false}){
 const started=performance.now();let p=structuredClone(project);p.timeline.keyframes??=[];p.timeline.transitions??=[];
 const fps=p.metadata.fps,map=new Map(resources.shots.map(s=>[s.id,s])),videos=p.timeline.items.filter(i=>i.type==='video').sort((a,b)=>a.from-b.from),decisions=[],remaps=[];
 const anchors=[];for(const event of [...events.primaryAccents].filter(e=>e.time<project.duration-.15).sort((a,b)=>b.strength-a.strength)){if(anchors.every(a=>Math.abs(a.time-event.time)>.75))anchors.push(event);}anchors.sort((a,b)=>a.time-b.time);
 const animated=new Set(),transitionItems=new Set();
 // User-reviewed A/B preference: automatic expression defaults to action timing only.
 for(const anchor of allowTransitions?anchors:[]){
  const item=videos.find(i=>Math.abs(i.from/fps-anchor.time)<.085)||videos.find(i=>i.from/fps<=anchor.time&&end(i)/fps>anchor.time);if(!item||item.locked||animated.has(item.id))continue;
  const index=videos.findIndex(i=>i.id===item.id),left=videos[index-1],peak=Math.round(anchor.time*fps)-item.from,shot=map.get(item.mad?.shotId);if(!shot)continue;
  const candidates={clean:{description:'保留自然动作，不增加画面扰动',ops:[]}};
  const context=catalog(p,resources,library),requestId='expr-'+randomUUID().slice(0,8);
  /* disabled abrupt camera presets
  candidates.punch={description:'Freecut原生关键帧：重音推近23%＋原生缩放模糊，随后回稳',ops:[...cameraOps(p,item,peak,'punch'),...nativeBlurOps(item,peak,'zoom')]};
  candidates.shake={description:'Freecut原生关键帧：推近＋短促位置/旋转震动＋原生运动模糊，随后回稳',ops:[...cameraOps(p,item,peak,'shake'),...nativeBlurOps(item,peak,'motion')]};
  */
  const atCut=left&&Math.abs(item.from/fps-anchor.time)<.14&&!animated.has(left.id);
  const rejected=[];
  const leftFacts=left?windowFacts(map.get(left.mad?.shotId),left):null,rightFacts=windowFacts(shot,item);
  const lateral=f=>/向左|left/.test(f?.screenDirection||'')?'left':/向右|right/.test(f?.screenDirection||'')?'right':null;
  const direction=lateral(leftFacts),movingPair=direction&&direction===lateral(rightFacts)&&leftFacts.actions?.length&&rightFacts.actions?.length;
  const variants=atCut&&movingPair?[[`slide_${direction}`,'slide',direction==='left'?'from-right':'from-left']]:[];
  // Static emotional handoffs may dissolve briefly; no repeated radial/zoom template.
  if(atCut&&!movingPair&&item.durationInFrames>=18&&left.durationInFrames>=18&&anchor.strength<.85)variants.push(['dissolve','dissolve',undefined]);
  for(const [name,presentation,dir]of variants){try{const ops=compileTechnique({technique:'transition',requestId,leftOccurrenceId:left.id,rightOccurrenceId:item.id,durationInFrames:Math.min(4,left.durationInFrames-1,item.durationInFrames-1),presentation,...(dir?{direction:dir}:{})},context).ops;candidates[name]={description:name==='dissolve'?'在情绪留白用短叠化':'顺着两镜一致的横向运动，用Freecut原生位移衔接',ops,transition:true};}catch(e){rejected.push({name,reason:e.code||e.message});}}
  const hasSourceAudio=p.timeline.items.some(i=>i.type==='audio'&&i.trackId!=='music'&&i.from<end(item)&&end(i)>item.from);
  const timingBeat=[anchor,...(events.events||[]).filter(e=>Math.round(e.time*fps)-item.from>=3&&Math.round(e.time*fps)-item.from<=item.durationInFrames-3).sort((a,b)=>b.strength-a.strength)].find(e=>remapForAccent(item,shot,e.time,fps));
  const remap=allowRemap&&!hasSourceAudio&&!transitionItems.has(item.id)&&timingBeat?remapForAccent(item,shot,timingBeat.time,fps):null;
  if(Object.keys(candidates).length===1&&!remap)continue;
  const state={brief:'用户不接受镜头内突然放大和泛用模糊。靠动作完整性、构图与方向匹配、长短镜头反差建立冲击力。保留原片色彩，默认干净切点。',anchor:{time:anchor.time,strength:anchor.strength,band:anchor.band,localFrame:peak},phrase:item.mad?.phrase,current:windowFacts(shot,item),previous:left?windowFacts(map.get(left.mad?.shotId),left):null,candidates:Object.fromEntries(Object.entries(candidates).map(([k,v])=>[k,v.description])),timing:remap||'此窗口没有可验证且边界安全的变速方案',recent:decisions.slice(-3).map(d=>d.output.answers)};
  const questions={gesture:{type:'choice',instructions:'只有当转场明确接住两镜方向或情绪时才使用。动作或表情本身已经足够时选择clean，不为了重音强加效果。',criteria:Object.fromEntries(Object.entries(candidates).map(([k,v])=>[k,v.description]))},...(remap?{timing:{type:'choice',instructions:'是否让已标注的动作峰值准确落在这个音乐重音？若有完整可读动作，选择变速；纯表情或台词保持原速。',criteria:{original:'保持原速',remap:'慢蓄力→快速发动→峰值卡拍→慢收势；源帧连续、总时长不变'}}}:{})};
  if(Object.keys(candidates).length===1)delete questions.gesture;
  onProgress({at:anchor.time,stage:'重音表现编排'});const input={state,questions},r=await ask(input),selected=r.result.answers.gesture?.choice||(!questions.gesture?'clean':undefined);if(!candidates[selected])throw Error('Invalid expression choice');
  const chosen=candidates[selected];p=applyDirectorOps(p,chosen.ops);if(selected!=='clean')animated.add(item.id);if(chosen.pair||chosen.transition){animated.add(left.id);transitionItems.add(left.id);transitionItems.add(item.id);}
  // Native transitions and nonlinear timing do not share unverified handles.
  const useRemap=remap&&r.result.answers.timing?.choice==='remap'&&!chosen.transition;if(useRemap)remaps.push({itemId:item.id,plan:remap});
  decisions.push({at:anchor.time,occurrenceId:item.id,input,output:r.result,ms:r.ms,applied:{gesture:selected,nativeTransition:!!chosen.transition,retime:!!useRemap},rejectedOptions:rejected,...(remap&&r.result.answers.timing?.choice==='remap'&&chosen.transition?{note:'原生转场已选中，保留原速以保护隐藏帧余量'}:{})});
 }
 // Give action timing its own opportunities between major transition beats.
 let timingOpportunities=0,lastTiming=-Infinity;
 for(const item of allowRemap?videos:[]){
  if(timingOpportunities>=4)break;if(item.locked||transitionItems.has(item.id)||remaps.some(r=>r.itemId===item.id)||item.from/fps-lastTiming<3)continue;
  const shot=map.get(item.mad?.shotId);if(!shot||!/开火|射|挥|跃|跑|引爆|按下|扣动|冲|坠/.test(shot.description))continue;
  if(p.timeline.items.some(i=>i.type==='audio'&&i.trackId!=='music'&&i.from<end(item)&&end(i)>item.from))continue;
  const beats=(events.events||[]).filter(e=>e.time>item.from/fps&&e.time<end(item)/fps).sort((a,b)=>b.strength-a.strength);
  let plan;for(const beat of beats){plan=remapForAccent(item,shot,beat.time,fps);if(plan)break;}if(!plan)continue;
  timingOpportunities++;lastTiming=item.from/fps;
  const input={state:{goal:'用户要求动作节奏卡实际音乐节拍，适合的动作采用慢蓄力—快发动—慢收势。保持总时长和连续源帧，不改变配乐语速。',current:windowFacts(shot,item),proposal:plan},questions:{timing:{type:'choice',instructions:'选择本动作的节奏表达。有明确挥枪、射击、奔跑、引爆峰值且已提供安全对拍方案时优先remap；纯表情或缺乏意义的动作保持original。',criteria:{original:'原速播放',remap:'使用已计算的连续源帧分段变速，让动作峰值卡音乐拍点'}}}};
  const r=await ask(input),choice=r.result.answers.timing?.choice;if(!['original','remap'].includes(choice))throw Error('Invalid retime choice');if(choice==='remap')remaps.push({itemId:item.id,plan});
  decisions.push({at:plan.anchor.musicSeconds,occurrenceId:item.id,input,output:r.result,ms:r.ms,applied:{gesture:'timing_only',retime:choice==='remap'}});
 }
 for(const {itemId,plan}of remaps){if(transitionItems.has(itemId)){const d=decisions.find(d=>d.occurrenceId===itemId);d.applied.retime=false;d.note='后续边界转场使用此镜，保留原速';continue;}p=splitRemapped(p,p.timeline.items.find(i=>i.id===itemId),plan);}
 return {project:p,decisions,timing:{totalMs:performance.now()-started,modelMs:decisions.reduce((a,d)=>a+d.ms,0)},summary:{accentDecisions:decisions.length,gestures:decisions.reduce((a,d)=>(a[d.applied.gesture]=(a[d.applied.gesture]||0)+1,a),{}),retimedActions:decisions.filter(d=>d.applied.retime).length}};
}
