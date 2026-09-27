// Acoustic and vocal boundaries are options for Winnow, not a predetermined cut list.
export function durationChoices({from,totalFrames,fps=30,music,events,phrases,ending=false}){
 const remaining=totalFrames-from;if(remaining<=fps*.8)return [{frames:remaining,reason:'音乐结束，完成当前动作'}];
 const start=from/fps,min=ending?.65:.48,max=ending?1.8:1.45,choices=new Map();
 const add=(time,reason,priority)=>{const frames=Math.round(time*fps)-from;if(frames<Math.ceil(min*fps)||frames>max*fps||frames>remaining||remaining-frames>0&&remaining-frames<Math.ceil(min*fps))return;const old=choices.get(frames);if(!old||old.priority<priority)choices.set(frames,{frames,reason,priority});};
 for(const p of phrases?.phrases||[])for(const t of [...p.breaks,p.end])add(t,'唱句或半句的停顿（听觉估计）',3);
 for(const a of events.primaryAccents||[])add(a.time,'音乐主重音',2);
 for(const t of music.beats||[])add(t,'音乐拍点，可切也可让动作继续',1);
 const candidates=[...choices.values()].sort((a,b)=>a.frames-b.frames),out=[];
 if(candidates.length){out.push(candidates[0]);const expressive=candidates.filter(c=>c.frames-out[0].frames>=fps*.2).sort((a,b)=>b.priority-a.priority||Math.abs(a.frames/fps-.95)-Math.abs(b.frames/fps-.95))[0];if(expressive)out.push(expressive);const last=candidates.at(-1);if(out.every(x=>Math.abs(x.frames-last.frames)>=fps*.2))out.push(last);}
 if(!out.length)out.push({frames:remaining<Math.round((.85+min)*fps)?remaining:Math.round(.85*fps),reason:'无合适近邻拍点，按完整动作持镜',priority:0});
 return out.sort((a,b)=>a.frames-b.frames);
}

export function applyShotDecision(project,selected,shots){
 const item=selected.item,targetId=selected.continuationOf||item.mad?.continuationOf;
 const items=project.timeline.items.filter(i=>i.id!==item.id);
 if(!targetId)return {project:{...project,timeline:{...project.timeline,items:[...items,item]}},action:'cut',occurrenceId:item.id};
 const previous=items.find(i=>i.id===targetId),shot=shots.find(s=>s.id===item.mad?.shotId);
 if(!previous||previous.locked||previous.isLocked||previous.from+previous.durationInFrames!==item.from||previous.mediaId!==item.mediaId||previous.sourceEnd!==item.sourceStart||previous.mad?.shotId!==item.mad?.shotId||!shot?.safeRanges.some(r=>r.startFrame<=previous.sourceStart&&r.endFrame>=item.sourceEnd))throw Error('无法安全延长当前镜头');
 const extended={...previous,durationInFrames:previous.durationInFrames+item.durationInFrames,sourceEnd:item.sourceEnd,mad:{...previous.mad,extensions:[...(previous.mad?.extensions||[]),{at:item.from,addedFrames:item.durationInFrames,sourceEnd:item.sourceEnd}]}};
 return {project:{...project,timeline:{...project.timeline,items:items.map(i=>i.id===targetId?extended:i)}},action:'extend',occurrenceId:targetId};
}
