import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {configuration,understand} from './gemini.mjs';
import {root,execFile} from './catalog.mjs';

export function validatePhrases(result,duration){
 if(!Array.isArray(result.phrases))throw Error('Missing musical phrases');
 let previous=0;for(const p of result.phrases){if(!Number.isFinite(p.start)||!Number.isFinite(p.end)||p.start<previous-.05||p.end<=p.start||p.end>duration+.1||p.start<0||!Array.isArray(p.breaks)||p.breaks.some(t=>!Number.isFinite(t)||t<=p.start||t>=p.end))throw Error('Invalid phrase timing');previous=p.end;}
 return result;
}
export async function musicPhrases(music){
 const info=await stat(music.original),model=(await configuration()).GEMINI_MODEL||'gemini-3.8-flash',key=createHash('sha256').update(JSON.stringify({version:1,model,file:music.original,size:info.size,mtime:info.mtimeMs})).digest('hex');
 const dir=path.join(root,'.local/catalog-v2/music-phrases'),file=path.join(dir,key+'.json');
 try{return {...validatePhrases(JSON.parse(await readFile(file,'utf8')),music.duration),cached:true};}catch{}
 await mkdir(dir,{recursive:true});const audio=path.join(dir,key+'.m4a');await execFile('ffmpeg',['-v','error','-y','-i',music.original,'-t',Math.min(music.duration,300),'-vn','-c:a','aac','-b:a','96k',audio]);
 const S={type:'STRING'},N={type:'NUMBER'},response=await understand([{inlineData:{mimeType:'audio/mp4',data:(await readFile(audio)).toString('base64')}},{text:`听这段实际音频（${music.duration}秒），标注可听辨的完整唱句/说话句及半句停顿。时间为本音频秒数。phrases按时间排列不得重叠，start/end是声乐句实际起止，可留伴奏空隙，breaks只写确实可听出的语义半句停顿，不按每个鼓点拆字。text仅记清楚听见的句子，听不清写[听不清]，不得从歌名查歌词补全。meaning概括这句表达，confidence为0至1。无语义人声不编台词，可返回空数组。时间为音频理解估计，不声称逐字强制对齐。`}],{schema:{type:'OBJECT',properties:{phrases:{type:'ARRAY',items:{type:'OBJECT',properties:{start:N,end:N,text:S,meaning:S,breaks:{type:'ARRAY',items:N},confidence:N},required:['start','end','text','meaning','breaks','confidence']}},uncertainties:{type:'ARRAY',items:S}},required:['phrases','uncertainties']},maxTokens:4000,thinkingLevel:'LOW',cacheKey:'music-phrases-v1-'+key});
 const result={...validatePhrases(response.result,music.duration),provenance:'raw-audio-model-estimated',model:response.model,metrics:response.metrics,musicId:music.id};await writeFile(file,JSON.stringify(result,null,2));return result;
}

export function phraseUnits(phrases,duration){
 return phrases.flatMap((p,i)=>{const points=[p.start,...p.breaks,p.end];return points.slice(0,-1).map((start,j)=>({id:`phrase-${i}-${j}`,phraseId:i,start:Math.max(0,start),end:Math.min(duration,points[j+1]),meaning:p.meaning,text:p.text,confidence:p.confidence}));}).filter(p=>p.end>p.start&&p.start<duration);
}
export function attachPhrases(slots,record,duration){
 const units=phraseUnits(record.phrases,duration),fps=30;
 // Shift a nearby cut to the vocal boundary; do not create rapid extra cuts.
 const boundaries=[slots[0].start,...slots.map(s=>s.end)];
 for(const t of units.flatMap(p=>[p.start,p.end])){const frame=Math.round(t*fps)/fps;let index=-1,d=.16;for(let i=1;i<boundaries.length-1;i++){const distance=Math.abs(boundaries[i]-frame);if(distance<d&&frame-boundaries[i-1]>=.16&&boundaries[i+1]-frame>=.16){d=distance;index=i;}}if(index>=0)boundaries[index]=frame;}
 return slots.map((s,i)=>{const start=boundaries[i],end=boundaries[i+1],unit=units.find(p=>p.start<end-.05&&p.end>start+.05);return {...s,start,end,phrase:unit?{...unit,progress:Math.max(0,Math.min(1,(start-unit.start)/(unit.end-unit.start))),timing:'model-estimated'}:null};});
}
