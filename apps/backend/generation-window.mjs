const end=i=>i.from+i.durationInFrames;
export function generationWindow(project,music){
 const tracks=project.timeline.items.filter(i=>i.type==='audio'&&i.trackId==='music');
 if(tracks.length!==1||tracks[0].mediaId!==music.id)throw Error('自动续剪需要一条明确的主音轨');
 const track=tracks[0],fps=project.metadata.fps,rate=track.speed||1,sourceStart=(track.sourceStart||0)/(track.sourceFps||fps),duration=track.durationInFrames/fps;
 if(!Number.isFinite(rate)||rate<=0||track.isReversed||sourceStart<0||sourceStart+duration*rate>music.duration+.1)throw Error('主音轨裁剪范围超出原始音频，或使用了暂不支持的倒放');
 if(duration<=0||duration>300)throw Error('自动剪辑支持不超过300秒的主音轨');
 return {track,fps,from:track.from,to:end(track),sourceStart,rate,duration};
}
export function musicForWindow(music,understanding,events,window){
 const {sourceStart:start,rate,duration}=window,finish=start+duration*rate;
 const mapTime=t=>(t-start)/rate,inside=t=>t>=start&&t<finish;
 return {
  music:{...music,duration,bpm:music.bpm*rate,beats:(music.beats||[]).filter(inside).map(mapTime),accents:(music.accents||[]).filter(a=>inside(a.time)).map(a=>({...a,time:mapTime(a.time)}))},
  intent:{...understanding,sections:understanding.sections?.filter(s=>s.start<finish&&s.end>start).map(s=>({...s,start:Math.max(0,mapTime(s.start)),end:Math.min(duration,mapTime(s.end))})),sourceWindow:{start,end:finish,rate}},
  events:{...events,events:events.events.filter(e=>inside(e.time)).map(e=>({...e,time:mapTime(e.time)})),primaryAccents:events.primaryAccents.filter(e=>inside(e.time)).map(e=>({...e,time:mapTime(e.time)}))},
 };
}
export function remainingIntervals(from,to,occupied){
 let cursor=from;const result=[];
 for(const row of [...occupied].sort((a,b)=>a.from-b.from)){
  if(end(row)<=cursor||row.from>=to)continue;
  if(row.from>cursor)result.push([cursor,Math.min(row.from,to)]);
  cursor=Math.max(cursor,Math.min(to,end(row)));
 }
 if(cursor<to)result.push([cursor,to]);return result;
}
export function generationRanges(project,window,mode){
 const videos=project.timeline.items.filter(i=>i.type==='video'&&i.trackId==='picture');
 if(mode==='append'){const from=Math.max(window.from,...videos.filter(i=>i.from<window.to).map(end));return from<window.to?[[from,window.to]]:[];}
 return remainingIntervals(window.from,window.to,videos);
}
