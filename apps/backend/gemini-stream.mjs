import {configuration} from './gemini.mjs';
export function completedSections(text){
 const match=/"sections"\s*:\s*\[/.exec(text);if(!match)return [];
 const result=[];let quoted=false,escaped=false,depth=0,start=-1;
 for(let i=match.index+match[0].length;i<text.length;i++){
  const c=text[i];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
  if(c==='"'){quoted=true;continue;}if(c==='{'||c==='['){if(depth===0&&c==='{')start=i;depth++;}
  else if(c==='}'||c===']'){if(depth===0)break;depth--;if(depth===0&&start>=0){result.push(JSON.parse(text.slice(start,i+1)));start=-1;}}
 }return result;
}
export async function understandStream(parts,{schema,maxTokens=6000,thinkingLevel='LOW',onSection,signal}={}){
 const c=await configuration(),model=c.GEMINI_MODEL||'gemini-3.8-flash';if(!c.GEMINI_API_KEY)throw Error('未配置Gemini');
 const started=performance.now(),times=[];let firstTextMs=null,text='',buffer='',emitted=0,usage=null,finishReason;
 const response=await fetch(`${c.GEMINI_BASE_URL||'https://generativelanguage.googleapis.com/v1beta'}/models/${model}:streamGenerateContent?alt=sse`,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':c.GEMINI_API_KEY},body:JSON.stringify({contents:[{role:'user',parts}],generationConfig:{temperature:1,maxOutputTokens:maxTokens,responseMimeType:'application/json',responseSchema:schema,thinkingConfig:{thinkingLevel}}}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000)});
 if(!response.ok)throw Error(`Gemini 流式请求失败 HTTP ${response.status}`);
 const event=block=>{const raw=block.split(/\r?\n/).filter(s=>s.startsWith('data:')).map(s=>s.slice(5).trimStart()).join('\n');if(!raw||raw==='[DONE]')return;
  const data=JSON.parse(raw),candidate=data.candidates?.[0];usage=data.usageMetadata||usage;finishReason=candidate?.finishReason||finishReason;
  const delta=(candidate?.content?.parts||[]).filter(p=>!p.thought).map(p=>p.text||'').join('');if(delta&&firstTextMs===null)firstTextMs=performance.now()-started;text+=delta;if(text.length>2_000_000)throw Error('Gemini 输出超过限制');
  const sections=completedSections(text);for(let i=emitted;i<sections.length;i++){times.push(performance.now()-started);onSection?.(sections[i],i);}emitted=sections.length;
 };
 const decoder=new TextDecoder();for await(const chunk of response.body){buffer+=decoder.decode(chunk,{stream:true});let m;while((m=/\r?\n\r?\n/.exec(buffer))){event(buffer.slice(0,m.index));buffer=buffer.slice(m.index+m[0].length);}}
 buffer+=decoder.decode();if(buffer.trim())event(buffer);
 if(finishReason!=='STOP')throw Error('Gemini 输出未完整结束，已生成镜头保留');
 return {result:JSON.parse(text),model,metrics:{ms:performance.now()-started,usage,firstTextMs,sectionReadyMs:times},cached:false};
}
