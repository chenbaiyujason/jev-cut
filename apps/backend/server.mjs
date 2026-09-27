import {expectedSourceCount} from './release-runtime.mjs';
import http from 'node:http';
import {createReadStream,createWriteStream} from 'node:fs';
import {readFile,writeFile,mkdir,stat,rename,copyFile,readdir} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer as createViteServer} from 'vite';
import {parseSubtitles,validateProject} from './core.mjs';
import {annotate,generate,semanticSearch} from './winnow.mjs';
import {catalogRoot} from './catalog.mjs';
import {configuration} from './gemini.mjs';
import {handleStudio} from './studio-api.mjs';
import {studioStore} from './studio-project.mjs';

const root=path.dirname(fileURLToPath(import.meta.url)),local=path.join(root,'.local');
await mkdir(local,{recursive:true});await mkdir(path.join(local,'uploads'),{recursive:true});
const db=path.join(local,'library.json');
let library;try{library=JSON.parse(await readFile(db,'utf8'));}catch{library={sources:[],music:[],project:null};}
let writeQueue=Promise.resolve();
function persist(){const snapshot=JSON.stringify(library,null,2);writeQueue=writeQueue.then(async()=>{await writeFile(db+'.tmp',snapshot);await rename(db+'.tmp',db);});return writeQueue;}
const catalogTimes=new Map();let catalogSync=Promise.resolve();
async function syncCatalog(){
  catalogSync=catalogSync.catch(()=>{}).then(async()=>{
    let directories=[];try{directories=(await readdir(catalogRoot)).filter(n=>/^episode-\d+$/.test(n));}catch{return;}
    let changed=false;
    for(const directory of directories){
      const folder=path.join(catalogRoot,directory),ready=path.join(folder,'enriched.json'),prepared=path.join(folder,'source.json');
      let file=ready,info;try{info=await stat(file);}catch{file=prepared;try{info=await stat(file);}catch{continue;}}
      const mark=file+':'+info.mtimeMs;if(catalogTimes.get(directory)===mark)continue;
      let source;try{source=JSON.parse(await readFile(file,'utf8'));}catch{continue;}
      const index=library.sources.findIndex(s=>s.id===source.id);
      if(index>=0)library.sources[index]=source;else library.sources.push(source);
      catalogTimes.set(directory,mark);changed=true;
    }
    if(changed){library.sources.sort((a,b)=>(a.episode||0)-(b.episode||0));library.catalogRevision=(library.catalogRevision||0)+1;await persist();}
  });await catalogSync;
}
async function catalogStatus(){
  await syncCatalog();const read=async name=>{try{return JSON.parse(await readFile(path.join(catalogRoot,name),'utf8'));}catch{return null;}};
  const [preprocessing,semantics,embeddings,config]=await Promise.all([read('preprocess-status.json'),read('semantic-status.json'),read('embedding-status.json'),configuration()]);
  return {revision:library.catalogRevision||0,expectedEpisodes:expectedSourceCount(library),preparedEpisodes:library.sources.filter(s=>s.analysisVersion===2).length,
    readyEpisodes:library.sources.filter(s=>s.semanticStatus==='complete').length,totalShots:library.sources.reduce((n,s)=>n+s.shots.length,0),
    understoodShots:library.sources.reduce((n,s)=>n+s.shots.filter(x=>x.semanticStatus==='complete').length,0),
    preprocessing,semantics,embeddings,providers:{geminiConfigured:!!config.GEMINI_API_KEY,understanding:config.GEMINI_MODEL||'gemini-3.8-flash',embedding:config.GEMINI_EMBEDDING_MODEL||'gemini-embedding-2',config:'localdevenv/.env'}};
}
function publicSource(source){return {id:source.id,name:source.name,episode:source.episode,url:source.url,duration:source.duration,width:source.width,height:source.height,
  semanticStatus:source.semanticStatus,analysisVersion:source.analysisVersion,subtitleProvenance:source.subtitleProvenance,shotCount:source.shots.length,cueCount:source.cues?.length||0,
  shots:source.shots.filter(s=>!s.excluded).slice(0,80).map(s=>({id:s.id,sourceId:s.sourceId,episode:source.episode,sceneId:s.sceneId,start:s.start,end:s.end,
    thumbUrl:s.thumbUrl,description:s.description,anchor:s.anchor,anchorMethod:s.anchorMethod,cues:s.cues,semanticStatus:s.semanticStatus}))};}
const jobs=new Map();let mediaBusy=false;
function job(type,fn){const id=randomUUID(),j={id,type,status:'running',stage:'准备中',progress:0};jobs.set(id,j);(async()=>{try{j.result=await fn(p=>Object.assign(j,p));j.status='complete';j.progress=1;}catch(e){j.status='error';j.error=e.message;console.error(type,e.message);}})();return j;}
const python=(process.env.MAD_PYTHON||path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'));
function pythonRun(script,args,onProgress){return new Promise((resolve,reject)=>{
  const p=spawn(python,[path.join(root,'scripts',script),...args],{cwd:root,windowsHide:true,env:{...process.env,PYTHONUTF8:'1'}});
  let pending='',stderr='';p.stdout.on('data',b=>{pending+=b.toString();let i;while((i=pending.indexOf('\n'))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);try{onProgress(JSON.parse(line));}catch{}}});
  p.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-5000);});p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(Error(stderr||'媒体处理失败')));
});}
function attachCues(source,cues,provenance){source.cues=cues;source.subtitleProvenance=provenance;for(const shot of source.shots)shot.cues=cues.filter(c=>c.start<shot.end&&c.end>shot.start);}
async function importFile(input,kind,onProgress){
  if(mediaBusy)throw Error('另一个素材正在分析，请等待完成');mediaBusy=true;
  try{
    const file=path.resolve(input);if(!(await stat(file)).isFile())throw Error('素材路径不是文件');
    const hash=createHash('sha256');for await(const part of createReadStream(file))hash.update(part);const id=hash.digest('hex').slice(0,16);
    const group=kind==='music'?library.music:library.sources;if(group.some(s=>s.id===id))return {id,alreadyImported:true};
    const dir=path.join(local,'media',id);await mkdir(dir,{recursive:true});
    const original=path.join(dir,'original'+path.extname(file).toLowerCase());await copyFile(file,original);
    await pythonRun('analyze.py',[original,dir,'--kind',kind],onProgress);
    const result=JSON.parse(await readFile(path.join(dir,'analysis.json'),'utf8'));
    const item={...result,id,name:path.basename(file),original,dir,url:`/media/${id}/${kind==='music'?'preview.m4a':'preview.mp4'}`};
    if(kind!=='music'){
      item.shots=item.shots.map(s=>({...s,id:id+'-'+s.id,sourceId:id,thumbUrl:`/media/${id}/${s.thumb}`}));
      const sub=item.subtitles.find(s=>['chi','zho','zh','jpn','ja'].includes(s.language))||item.subtitles[0];
      if(sub)attachCues(item,parseSubtitles(await readFile(path.join(dir,sub.file),'utf8')),{type:'embedded',language:sub.language,file:sub.file,aligned:true});
      else attachCues(item,[],{type:'none',aligned:false});
    }
    group.push(item);await persist();return {id};
  }finally{mediaBusy=false;}
}
async function readJson(req){let bytes=0,chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>4*1024*1024)throw Error('请求过大');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}
const json=(res,value,code=200)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
async function serveFile(req,res,file){
  const info=await stat(file),type={'.mp4':'video/mp4','.m4a':'audio/mp4','.wav':'audio/wav','.png':'image/png','.jpg':'image/jpeg','.json':'application/json','.srt':'text/plain','.html':'text/html; charset=utf-8','.md':'text/plain; charset=utf-8'}[path.extname(file)]||'application/octet-stream';
  const headers={'Content-Type':type,'Accept-Ranges':'bytes'};
  if(req.method==='HEAD'){res.writeHead(200,{...headers,'Content-Length':info.size});return res.end();}
  if(req.headers.range){const m=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);if(!m)return res.writeHead(416,{'Content-Range':`bytes */${info.size}`}).end();
    // Native video preload uses open-ended ranges. Bound these responses so
    // several long episodes cannot occupy every browser connection indefinitely.
    // Explicit byte windows (e.g. decoder reads) retain their requested length.
    const start=Number(m[1]),end=Math.min(m[2]?Number(m[2]):start+2*1024*1024-1,info.size-1);if(start>end||start>=info.size)return res.writeHead(416,{'Content-Range':`bytes */${info.size}`}).end();
    res.writeHead(206,{...headers,'Content-Range':`bytes ${start}-${end}/${info.size}`,'Content-Length':end-start+1});createReadStream(file,{start,end}).pipe(res);
  }else{res.writeHead(200,{...headers,'Content-Length':info.size});createReadStream(file).pipe(res);}
}
// Freecut owns the frontend. Starting the retired prototype's Vite watcher here
// scans the large local media/research tree and can starve API/media responses.
const vite=process.env.MAD_LEGACY_UI==='1'?await createViteServer({root,configFile:path.join(root,'vite.config.mjs'),server:{middlewareMode:true},appType:'spa'}):null;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  try{
    if(req.method==='GET'&&url.pathname==='/'&&process.env.MAD_LEGACY_UI!=='1'){res.writeHead(302,{Location:'http://127.0.0.1:8796/mad'});return res.end();}
    if(req.method==='POST'&&req.headers.origin&&!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.origin))return json(res,{error:'只接受本机编辑器请求'},403);
    if(url.pathname.startsWith('/api/studio/')){await syncCatalog();if(await handleStudio(req,res,url,{library,readJson,json}))return;}
    if(url.pathname.startsWith('/studio-assets/')){const file=path.resolve(studioStore,url.pathname.slice('/studio-assets/'.length));if(!file.startsWith(path.resolve(studioStore)+path.sep))throw Error('无效路径');return await serveFile(req,res,file);}
    if(url.pathname==='/api/state'){await syncCatalog();return json(res,{...library,sources:library.sources.map(publicSource),music:library.music.map(({original,dir,...s})=>s)});}
    if(url.pathname==='/api/catalog/status')return json(res,await catalogStatus());
    if(url.pathname==='/api/health'){let online=false;try{online=(await fetch((process.env.WINNOW_URL||'http://127.0.0.1:8091')+'/health',{signal:AbortSignal.timeout(1500)})).ok;}catch{}return json(res,{winnow:online});}
    if(url.pathname.startsWith('/api/jobs/')){const j=jobs.get(url.pathname.split('/').pop());return json(res,j||{error:'找不到任务'},j?200:404);}
    if(req.method==='POST'&&url.pathname==='/api/upload'){
      const name=path.basename(url.searchParams.get('name')||'media.mp4'),kind=url.searchParams.get('kind')==='music'?'music':'video';
      if(!/\.(mp4|mkv|mov|webm|mp3|m4a|wav|flac|ogg)$/i.test(name))throw Error('不支持的媒体格式');
      const file=path.join(local,'uploads',randomUUID()+path.extname(name));await pipeline(req,createWriteStream(file));
      return json(res,job('import',async p=>{const result=await importFile(file,kind,p);const item=[...library.sources,...library.music].find(s=>s.id===result.id);if(item){item.name=name;await persist();}return result;}));
    }
    if(req.method==='POST'&&url.pathname==='/api/import'){const body=await readJson(req);return json(res,job('import',p=>importFile(body.path,body.kind==='music'?'music':'video',p)));}
    if(req.method==='POST'&&url.pathname==='/api/subtitles'){
      const body=await readJson(req),source=library.sources.find(s=>s.id===body.sourceId);if(!source)throw Error('找不到素材');
      if(typeof body.text!=='string'||!Number.isFinite(Number(body.offset||0)))throw Error('字幕参数错误');
      const cues=parseSubtitles(body.text,Number(body.offset||0));if(!cues.length)throw Error('未识别出字幕时间码');
      attachCues(source,cues,{type:'imported',name:body.name||'字幕文件',offset:Number(body.offset||0),aligned:'user-confirmed'});await persist();return json(res,{cues:cues.length});
    }
    if(req.method==='POST'&&url.pathname==='/api/annotate')throw Error('理解和打标仅使用 Gemini。请运行 npm run catalog --workspace=apps/winnow-mad-lab，可断点续跑。');
    if(req.method==='POST'&&url.pathname==='/api/search'){const {query,episodeIds}=await readJson(req);await syncCatalog();if(typeof query!=='string'||query.length>1000)throw Error('查询格式错误');return json(res,job('search',async()=>semanticSearch(library,query,path.join(local,'logs'),()=>{},{episodeIds})));}
    if(req.method==='POST'&&url.pathname==='/api/generate'){const body=await readJson(req);await syncCatalog();const base=library.project?.revision||0;
      return json(res,job('generate',async p=>{const candidate=await generate(library,body,path.join(local,'logs'),p);if((library.project?.revision||0)!==base)throw Error('生成期间时间轴已修改，旧结果未覆盖新编辑');candidate.revision=base+1;library.project=validateProject(candidate,library);await persist();return library.project;}));}
    if(req.method==='POST'&&url.pathname==='/api/project'){const body=await readJson(req);if(body.baseRevision!==(library.project?.revision||0))return json(res,{error:'版本已更新，请重新加载'},409);
      library.project=validateProject({...body.project,revision:body.baseRevision+1},library);await persist();return json(res,library.project);}
    if(req.method==='POST'&&url.pathname==='/api/export'){const {project}=await readJson(req),valid=validateProject(project,library),id=randomUUID(),out=path.join(local,'exports',id);await mkdir(out,{recursive:true});
      const selectedMusic=library.music.find(m=>m.id===valid.musicId);
      const spec={project:valid,output:out,music:selectedMusic.original,musicCredit:selectedMusic.credit||`Music: ${selectedMusic.name}. Attribution details not supplied.`,sources:Object.fromEntries(library.sources.map(s=>[s.id,{path:s.original,hasAudio:s.hasAudio}]))};
      const file=path.join(out,'render.json');await writeFile(file,JSON.stringify(spec));return json(res,job('export',async p=>{await pythonRun('render.py',[file],p);return {url:`/exports/${id}/mad.mp4`,projectUrl:`/exports/${id}/project.json`};}));}
    if(url.pathname.startsWith('/media/')){const parts=url.pathname.split('/').slice(2),id=parts.shift(),item=[...library.sources,...library.music].find(s=>s.id===id);if(!item)throw Error('素材不存在');const file=path.resolve(item.dir,parts.join('/'));if(!file.startsWith(item.dir+path.sep))throw Error('无效路径');return await serveFile(req,res,file);}
    if(url.pathname.startsWith('/exports/')){const file=path.resolve(local,'.'+url.pathname);if(!file.startsWith(path.join(local,'exports')+path.sep))throw Error('无效路径');return await serveFile(req,res,file);}
    if(vite) vite.middlewares(req,res);else json(res,{error:'该页面已迁移到 Freecut 工作台'},404);
  }catch(e){if(!res.headersSent)json(res,{error:e.message},e.status||400);else res.end();}
});
const port=Number(process.env.PORT||8794);server.listen(port,'127.0.0.1',()=>console.log(`Winnow MAD http://127.0.0.1:${port}`));
