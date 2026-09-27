import {readFile,mkdir,stat,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {understand,configuration} from './gemini.mjs';
import {execFile,catalogRoot} from './catalog.mjs';

const string={type:'STRING'},number={type:'NUMBER'};
const schema={type:'OBJECT',properties:{
  summary:string,mood:string,texture:string,has_intelligible_lyrics:{type:'BOOLEAN'},lyrics_theme:string,
  sections:{type:'ARRAY',items:{type:'OBJECT',properties:{start:number,end:number,energy:number,heard:string,emotion:string,tension:number,vocal_density:number,development:string,visual_response:string},required:['start','end','energy','heard','emotion','tension','vocal_density','development','visual_response']}},
  edit_direction:string,retrieval_queries:{type:'ARRAY',items:string},suggested_intensity:number,
  dialogue_suitability:number,source_audio_reason:string,uncertainties:{type:'ARRAY',items:string}
},required:['summary','mood','texture','has_intelligible_lyrics','lyrics_theme','sections','edit_direction','retrieval_queries','suggested_intensity','dialogue_suitability','source_audio_reason','uncertainties']};

export function validateMusicIntent(result,duration){
  if(!result?.summary?.trim()||!result.edit_direction?.trim()||!Array.isArray(result.retrieval_queries)||!result.retrieval_queries.length||result.retrieval_queries.length>5||result.retrieval_queries.some(q=>typeof q!=='string'||!q.trim()))throw Error('音乐分析没有给出可用的选片方向');
  if(!Array.isArray(result.sections)||!result.sections.length)throw Error('音乐分析缺少实际段落');
  let end=0;
  for(const section of result.sections){
    if(!Number.isFinite(section.start)||!Number.isFinite(section.end)||section.start<0||section.end<=section.start||section.end>duration+.1||section.start<end-.1||!Number.isFinite(section.energy)||section.energy<0||section.energy>1)throw Error('音乐分析段落时间或能量无效');
    end=section.end;
  }
  for(const field of ['suggested_intensity','dialogue_suitability'])if(!Number.isFinite(result[field])||result[field]<0||result[field]>1)throw Error('音乐分析强度值越界');
  return result;
}

const version=3,defaultDirectory=path.join(catalogRoot,'music-understanding'),inFlight=new Map();
async function identity(music,{directory=defaultDirectory,model}={}){
  model??=(await configuration()).GEMINI_MODEL||'gemini-3.8-flash';
  const info=await stat(music.original),duration=Math.min(Number(music.duration),300);
  if(!Number.isFinite(duration)||duration<=0)throw Error('音乐时长无效');
  // Read the whole supported music range once; changing edit length or prompt reuses it.
  const sourceStamp={path:path.resolve(music.original),size:info.size,mtimeMs:info.mtimeMs};
  const id=createHash('sha256').update(JSON.stringify({version,model,sourceStamp,duration})).digest('hex');
  return {id,model,duration,sourceStamp,directory,file:path.join(directory,id+'.json')};
}
export async function readMusicIntent(music,dependencies={}){
  if(!music?.original)return null;
  try{const key=await identity(music,dependencies),r=JSON.parse(await readFile(key.file,'utf8'));validateMusicIntent(r,key.duration);return r.id===key.id?{...r,cached:true,requestMetrics:{modelMs:0}}:null;}catch{return null;}
}
export function musicContextAt(understanding,start,end){
  if(!understanding)return {available:false,reason:'音乐听觉理解尚未建立；不能以歌曲名猜测情绪'};
  return {available:true,id:understanding.id,summary:understanding.summary,mood:understanding.mood,texture:understanding.texture,lyricsTheme:understanding.lyrics_theme,hasLyrics:understanding.has_intelligible_lyrics,sourceAudioReason:understanding.source_audio_reason,sections:understanding.sections.filter(s=>s.start<end&&s.end>start),uncertainties:understanding.uncertainties};
}
export async function cachedMusicContext(project,item,music,load=readMusicIntent){
  if(!music)return musicContextAt(null,0,0);
  const fps=project.metadata.fps,track=project.timeline.items.find(i=>i.trackId==='music'&&i.mediaId===music.id&&i.from<item.from+item.durationInFrames&&i.from+i.durationInFrames>item.from);
  if(!track)return {available:false,reason:'当前片段没有覆盖此配乐'};
  const offset=(track.sourceStart||0)/(track.sourceFps||fps),rate=track.speed||1;
  const start=offset+Math.max(0,item.from-track.from)/fps*rate,end=offset+Math.min(track.durationInFrames,item.from+item.durationInFrames-track.from)/fps*rate;
  return {...musicContextAt(await load(music),start,end),sourceRange:[start,end]};
}
export async function analyzeMusicIntent(music,{forceReanalyze=false}={},dependencies={}){
  const {understandFn=understand,transcode=execFile}=dependencies,key=await identity(music,dependencies);
  if(!forceReanalyze){const cached=await readMusicIntent(music,dependencies);if(cached)return cached;}
  if(inFlight.has(key.file))return inFlight.get(key.file);
  const task=(async()=>{
    const started=performance.now();await mkdir(key.directory,{recursive:true});
    const audio=path.join(key.directory,key.id+'.m4a');try{await stat(audio);}catch{await transcode('ffmpeg',['-v','error','-y','-i',music.original,'-t',key.duration,'-vn','-c:a','aac','-b:a','96k',audio]);}
    const text=`你负责独立理解真实音乐，供后续剪辑导演使用。必须听附带的${key.duration}秒音频。本步骤没有用户故事或角色偏好，不能用假想画面反推音乐情绪。\n记录可听见的音色、主导声部、旋律走势、张力、人声密度、呼吸留白及转折。sections 连续覆盖0至${key.duration}秒；heard写可观察的声音，emotion写情绪质感，tension与energy分开，vocal_density是0–1的人声占用程度，development说明相对上一段的音乐发展，visual_response提出有声音依据的画面运动/对切/重复/持镜方向。不要把音量大等同于情绪强，不要将忧郁自动解释为慢剪。\n听不清的歌词不猜，lyrics_theme仅概括可确认词义，不输出歌词全文。叠加原片对白是否可行必须考虑音乐自身人声与留白。summary、mood、texture是音乐理解；edit_direction、visual_response和3–5条retrieval_queries是创作建议，两者不可混淆。suggested_intensity只表示默认切换密度，用户稍后可覆盖。不要指定动画人物或编造素材镜头。段落时间只是听觉粗定位，精确鼓点由程序计算，不输出猜测的逐拍表。每段文字简练，无法确认的细节写uncertainties。`;
    const media={inlineData:{mimeType:'audio/mp4',data:(await readFile(audio)).toString('base64')}};
    let response,repair='';const refresh=forceReanalyze?Date.now():'';
    for(let attempt=0;attempt<2;attempt++){
      response=await understandFn([media,{text:text+repair}],{schema,maxTokens:6000,thinkingLevel:'LOW',cacheKey:`music-understanding-v${version}:${key.id}:${refresh}:${attempt}`});
      try{validateMusicIntent(response.result,key.duration);
        const sections=response.result.sections;if(Math.abs(sections[0].start)>.1||Math.abs(sections.at(-1).end-key.duration)>.1||sections.some((s,i)=>i&&Math.abs(s.start-sections[i-1].end)>.1))throw Error('音乐段落未连续覆盖全曲');
        if(sections.some(s=>!s.emotion?.trim()||!s.development?.trim()||!s.visual_response?.trim()||!Number.isFinite(s.tension)||s.tension<0||s.tension>1||!Number.isFinite(s.vocal_density)||s.vocal_density<0||s.vocal_density>1))throw Error('缺少有效情绪发展或人声密度');
        break;
      }catch(e){if(attempt===1)throw e;repair=`\n校验失败：${e.message}，请修正。`;}
    }
    const record={...response.result,id:key.id,musicId:music.id,duration:key.duration,sourceStamp:key.sourceStamp,schemaVersion:version,provenance:'raw-audio',model:response.model,metrics:response.metrics,createdAt:new Date().toISOString()};
    await writeFile(key.file+'.tmp',JSON.stringify(record,null,2));await rename(key.file+'.tmp',key.file);
    return {...record,cached:!!response.cached,requestMetrics:{modelMs:response.cached?0:response.metrics?.ms||0,wallMs:performance.now()-started}};
  })();inFlight.set(key.file,task);try{return await task;}finally{inFlight.delete(key.file);}
}
