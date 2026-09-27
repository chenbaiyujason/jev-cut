import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {compileTechnique} from './studio-techniques.mjs';
import {fpsOf} from './studio-project.mjs';
import {globalResources} from './global-evidence.mjs';
import {actionWindowScore} from './story-continuity.mjs';
let resources;
export async function liveDirectorResources(root){
  return globalResources();
}
function reject(message,status=422){const error=Error(message);error.status=status;throw error;}
export function unmarkedSourceReplay(project,item){
  if(item.mad?.intentionalReuse||item.mad?.repriseAllowed)return false;
  const fps=item.sourceFps||project.metadata.fps,a=item.sourceStart/fps,b=item.sourceEnd/fps,tolerance=1.1/fps;
  return project.timeline.items.some(other=>other.type==='video'&&other.id!==item.id&&other.mediaId===item.mediaId&&Math.min(b,other.sourceEnd/(other.sourceFps||fps))-Math.max(a,other.sourceStart/(other.sourceFps||fps))>tolerance);
}
export function buildLiveReplacements({project,row,library,shots,motion,manageAudio=false,allowSingle=false,reserveFrames=1}){
  const item=project.timeline.items.find(i=>i.id===row.id);
  if(!item||item.type!=='video')reject('当前镜头已不存在，请重新选择');
  const track=project.timeline.tracks.find(t=>t.id===item.trackId);
  if(item.locked||item.isLocked||track?.locked||track?.isLocked)reject('此镜头或轨道已锁定');
  if(item.isReversed||!(item.speed??1))reject('快速替换暂不处理倒放镜头');
  const intersects=i=>i.from<item.from+item.durationInFrames&&i.from+i.durationInFrames>item.from;
  if(!manageAudio&&project.timeline.items.some(i=>i.type==='audio'&&i.trackId!=='music'&&intersects(i)))reject('此镜头关联原声或台词，快速替换暂时保护这段声音；请选择静音画面');
  const sourceMap=new Map(library.sources.map(s=>[s.id,s])),shotMap=new Map(shots.map(s=>[s.id,s]));
  const catalog={assets:library.sources.map(s=>({assetId:s.id,mediaId:s.id,sourceFps:fpsOf(s.fps),sourceDurationFrames:Math.floor(s.duration*fpsOf(s.fps)),src:s.url,width:960,height:540})),shots:shots.map(s=>({shotId:s.id,assetId:s.sourceId,sourceIn:s.startFrame,sourceOut:s.endFrame,safeRanges:s.safeRanges.map(r=>({sourceIn:r.startFrame,sourceOut:r.endFrame}))}))};
  const transitions=(project.timeline.transitions||[]).filter(t=>t.leftClipId===item.id||t.rightClipId===item.id);
  const input=[...row.alternatives];if(!input.some(c=>c.shotId===item.mad?.shotId)){
    const s=shotMap.get(item.mad?.shotId);if(s)input.push({shotId:s.id,visual:s.description,similarity:0});
  }
  const result=[];
  for(const candidate of input){
    const shot=shotMap.get(candidate.shotId),source=shot&&sourceMap.get(shot.sourceId);if(!shot||!source)continue;
    if(candidate.shotId===item.mad?.shotId){result.push({...candidate,item:structuredClone(item),keep:true});continue;}
    const sfps=fpsOf(source.fps),needed=Math.ceil(item.durationInFrames*sfps*(item.speed??1)/project.metadata.fps-1e-9);let best=null;
    const protectReuse=!item.mad?.repriseAllowed&&!item.mad?.intentionalReuse&&!row.repriseAllowed;
    const used=protectReuse?project.timeline.items.filter(i=>i.type==='video'&&i.id!==item.id&&i.mediaId===source.id):[];
    const latestPast=used.filter(i=>i.from<item.from&&i.mad?.shotId===shot.id).reduce((m,i)=>Math.max(m,i.sourceEnd/(i.sourceFps||sfps)),0);
    for(const range of motion[shot.id]?.ranges||[]){
      const margin=Math.max(reserveFrames,transitions.length?4:1);
      for(let offset=margin;offset+needed<=range.delta.length-margin;offset++){
        const startFrame=range.startFrame+offset,endFrame=startFrame+needed;
        if(used.some(i=>startFrame<i.sourceEnd&&endFrame>i.sourceStart))continue;
        const d=range.delta.slice(offset+1,offset+needed),movement=d.reduce((n,v)=>n+v,0)/Math.max(1,d.length);
        const blank=range.brightness.slice(offset,offset+needed).filter((v,j)=>v>244&&range.detail[offset+j]<8||v<5&&range.detail[offset+j]<5).length/needed;
        if(blank>.35||['rescue','retry'].includes(row.role)&&movement<.75)continue;
        const a=(range.startFrame+offset)/sfps,b=(range.startFrame+offset+needed)/sfps;
        if((shot.repeatedBands||[]).some(r=>a<r.end&&b>r.start))continue;
        if(a<latestPast-1/sfps||used.some(i=>Math.min(b,i.sourceEnd/(i.sourceFps||sfps))-Math.max(a,i.sourceStart/(i.sourceFps||sfps))>1.1/sfps))continue;
        const score=Math.min(movement,15)*.025-blank*3+actionWindowScore(shot,a,b,{accentFraction:row.accentFraction??.5,continuityPrevious:row.continuityPrevious});if(best&&score<=best.score)continue;
        const next={...item,label:`${row.role} · EP${source.episode} · ${shot.description}`,mediaId:source.id,src:`/mad-media/${source.id}/edit-preview-v2.mp4`,sourceStart:range.startFrame+offset,sourceEnd:range.startFrame+offset+needed,sourceFps:sfps,sourceDuration:Math.floor(source.duration*sfps),mad:{...item.mad,assetId:source.id,shotId:shot.id,occurrenceId:item.id}};
        const patched={...project,timeline:{...project.timeline,items:project.timeline.items.map(i=>i.id===item.id?next:i)}};
        let valid=true;for(const t of transitions){try{compileTechnique({technique:'transition',requestId:'live-edge',leftOccurrenceId:t.leftClipId,rightOccurrenceId:t.rightClipId,durationInFrames:t.durationInFrames,presentation:t.presentation,alignment:t.alignment??.5},{...patched,timeline:{...patched.timeline,transitions:patched.timeline.transitions.filter(x=>x.id!==t.id)},madCatalog:catalog});}catch{valid=false;break;}}
        if(valid)best={item:next,score};
      }
    }
    if(best)result.push({...candidate,item:best.item,keep:false});
  }
  if(result.length<(allowSingle?1:2))reject('当前时长和转场余量下没有足够替代素材，需要先扩充候选');
  return {item,candidates:result};
}
export function applyLiveReplacement(project,replacement){
  return {...project,timeline:{...project.timeline,items:project.timeline.items.map(i=>i.id===replacement.id?replacement:i)}};
}
