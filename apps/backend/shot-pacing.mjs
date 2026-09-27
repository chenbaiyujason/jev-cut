// Acoustic and vocal boundaries are options for Winnow, not a predetermined cut list.
export function durationChoices({from,totalFrames,fps=30,music,events,phrases,ending=false}){
 const remaining=totalFrames-from;if(remaining<=fps*.8)return [{frames:remaining,reason:'音乐结束，完成当前动作'}];
 const start=from/fps,min=ending?.65:.48,max=ending?1.8:1.45,choices=new Map();
 const add=(time,reason,priority)=>{const frames=Math.round(time*fps)-from;if(frames<Math.ceil(min*fps)||frames>max*fps||frames>remaining||remaining-frames>0&&remaining-frames<Math.ceil(min*fps))return;const old=choices.get(frames);if(!old||old.priority<priority)choices.set(frames,{frames,reason,priority});};
 for(const a of events.structuralAccents||[])add(a.time,'停顿后重新进入：必须用动作释放或明确切换回应',10);
 for(const p of phrases?.phrases||[])for(const t of [...p.breaks,p.end])add(t,'唱句或半句的停顿（听觉估计）',3);
 for(const a of events.primaryAccents||[])add(a.time,'音乐主重音',2);
 for(const t of music.beats||[])add(t,'音乐拍点，可切也可让动作继续',1);
 const candidates=[...choices.values()].sort((a,b)=>a.frames-b.frames),out=[];
 if(candidates.length){out.push(candidates[0]);const expressive=candidates.filter(c=>c.frames-out[0].frames>=fps*.2).sort((a,b)=>b.priority-a.priority||Math.abs(a.frames/fps-.95)-Math.abs(b.frames/fps-.95))[0];if(expressive)out.push(expressive);const last=candidates.at(-1);if(out.every(x=>Math.abs(x.frames-last.frames)>=fps*.2))out.push(last);}
 if(!out.length)out.push({frames:remaining<Math.round((.85+min)*fps)?remaining:Math.round(.85*fps),reason:'无合适近邻拍点，按完整动作持镜',priority:0});
 const structural=(events.structuralAccents||[]).find(a=>Math.round(a.time*fps)>from&&Math.round(a.time*fps)<=totalFrames&&Math.round(a.time*fps)-from<=max*fps);
 if(structural){const frames=Math.round(structural.time*fps)-from;if(frames>=Math.ceil(min*fps)){const before=out.filter(o=>o.frames<frames&&frames-o.frames>=Math.ceil(min*fps));return [...before,{frames,reason:'停顿后重入的结构性落点；先停在此，下一决策选择释放动作',priority:10}];}}
 return out.sort((a,b)=>a.frames-b.frames);
}

export function applyShotDecision(project,selected,shots){
 const item=selected.item,targetId=selected.continuationOf||item.mad?.continuationOf;
 const items=project.timeline.items.filter(i=>i.id!==item.id);
 if(items.some(i=>i.type==='video'&&i.trackId===item.trackId&&i.id!==targetId&&i.from<item.from+item.durationInFrames&&i.from+i.durationInFrames>item.from))throw Error('生成片段与已有画面重叠，未写入时间轴');
 if(!targetId)return {project:{...project,timeline:{...project.timeline,items:[...items,item]}},action:'cut',occurrenceId:item.id};
 const previous=items.find(i=>i.id===targetId),shot=shots.find(s=>s.id===item.mad?.shotId);
 if(!previous||previous.locked||previous.isLocked||previous.from+previous.durationInFrames!==item.from||previous.mediaId!==item.mediaId||previous.sourceEnd!==item.sourceStart||previous.mad?.shotId!==item.mad?.shotId||!shot?.safeRanges.some(r=>r.startFrame<=previous.sourceStart&&r.endFrame>=item.sourceEnd))throw Error('无法安全延长当前镜头');
 const extended={...previous,durationInFrames:previous.durationInFrames+item.durationInFrames,sourceEnd:item.sourceEnd,mad:{...previous.mad,extensions:[...(previous.mad?.extensions||[]),{at:item.from,addedFrames:item.durationInFrames,sourceEnd:item.sourceEnd}]}};
 return {project:{...project,timeline:{...project.timeline,items:items.map(i=>i.id===targetId?extended:i)}},action:'extend',occurrenceId:targetId};
}

export function trimProjectPrefix(project,duration){
 const fps=project.metadata.fps,end=Math.round(duration*fps),p=structuredClone(project);p.duration=duration;
 p.timeline.items=p.timeline.items.filter(i=>i.from<end).map(i=>{const frames=Math.min(i.durationInFrames,end-i.from);if(frames===i.durationInFrames)return i;return {...i,durationInFrames:frames,sourceEnd:Number.isFinite(i.sourceStart)?Math.min(i.sourceEnd,i.sourceStart+Math.ceil(frames*(i.sourceFps||fps)*(i.speed||1)/fps)):i.sourceEnd};});
 const ids=new Set(p.timeline.items.map(i=>i.id));p.timeline.transitions=(p.timeline.transitions||[]).filter(t=>ids.has(t.leftClipId)&&ids.has(t.rightClipId));p.timeline.keyframes=(p.timeline.keyframes||[]).filter(k=>ids.has(k.itemId));return p;
}
