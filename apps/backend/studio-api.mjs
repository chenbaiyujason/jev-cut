import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {studioState,mutateStudio,migrateLegacyProject,nativeEdit,engineRequest,studioCatalog,studioStore,restoreItemMetadata} from './studio-project.mjs';
import {describeCapabilities,compileTechnique} from './studio-techniques.mjs';
import {decide} from './winnow.mjs';
import {execFile,root} from './catalog.mjs';
import {liveDirectorResources,buildLiveReplacements,applyLiveReplacement} from './director-live.mjs';
import {chooseGlobalShot} from './global-director.mjs';
import {beginEditEpoch} from './edit-epochs.mjs';
import {globalReport} from './global-report.mjs';
import {startEditJob,getEditJob,cancelEditJob,waitEditJob} from './director-edit.mjs';
import {analyzeMusicIntent,readMusicIntent} from './music-intent.mjs';
import {startGeneration,generationStatus,cancelGeneration,waitGeneration} from './progressive-generation.mjs';
import {visionSelectionEnabled,updateDirectorSettings,readDirectorSettings} from './decision-settings.mjs';
import {productionMenu} from './production-menu.mjs';
import {automaticExpressionPolicy} from './editing-policy.mjs';
import {cachedMusicEvents} from './rhythm.mjs';
import {candidatePolicyVersion} from './candidate-selection.mjs';

export async function handleStudio(req,res,url,{library,readJson,json}){
  if(!url.pathname.startsWith('/api/studio/'))return false;
  const route=url.pathname.slice('/api/studio/'.length),send=data=>{json(res,data);return true;};
  if(req.method==='GET'&&route==='generation/capabilities')return send({progressive:true,version:2,cancelKeepsClips:true,modes:['new','append','rebuild'],trimmedMusic:true,automaticExpression:automaticExpressionPolicy,candidatePolicy:candidatePolicyVersion});
  if(req.method==='GET'&&route.startsWith('generation/jobs/')){
    // Publication already uses an atomic revision guard. Comparing an earlier
    // job snapshot with a later disk read here would cancel our own next clip.
    const id=route.split('/').at(-1),after=Number(url.searchParams.get('after')??-1);
    return send(url.searchParams.get('wait')==='1'?await waitGeneration(id,after,{afterEvent:url.searchParams.has('afterEvent')?Number(url.searchParams.get('afterEvent')):undefined}):generationStatus(id,after));
  }
  if(req.method==='GET'&&route==='project')return send(await studioState(library));
  if(req.method==='GET'&&route==='catalog')return send(await studioCatalog(library));
  if(req.method==='GET'&&route==='director/music'){
    const state=await studioState(library),music=library.music.find(m=>state.project.timeline.items.some(i=>i.trackId==='music'&&i.mediaId===m.id));
    const understanding=await readMusicIntent(music);return send({musicId:music?.id,ready:!!understanding,understanding,policy:{perception:'raw-audio-once',planning:'structured-music-understanding',liveEditing:'Winnow with cached local music sections'}});
  }
  if(req.method==='GET'&&route.startsWith('director/jobs/'))return send(url.searchParams.get('wait')==='1'?await waitEditJob(route.split('/').at(-1)):getEditJob(route.split('/').at(-1)));
  if(req.method==='GET'&&route==='director/settings'){
    let saved={};try{saved=JSON.parse(await readFile(path.join(studioStore,'director','settings.json'),'utf8'));}catch{}
    const state=await studioState(library);return send({goal:saved[state.project.name]?.goal??state.project.description??'',visionEnabled:await visionSelectionEnabled(),voiceSeparation:{ready:false,reason:'尚未配置对白分离模型；不会使用混合原声冒充纯人声'},versions:await productionMenu()});
  }
  if(req.method==='GET'&&route==='director/trace'){
    try{return send(JSON.parse(await readFile(path.join(studioStore,'director','latest.json'),'utf8')));}catch(e){if(e.code==='ENOENT')return send({available:false});throw e;}
  }
  if(req.method==='GET'&&['capabilities','techniques'].includes(route)){
    let engine;try{engine=await engineRequest('/v1/capabilities');}catch(e){engine={ready:false,error:e.message};}
    return send({version:1,techniques:describeCapabilities(),engine,director:{trace:'GET director/trace',emotionPreview:'POST director/preview-change',previewApplies:false,searchScope:'full-corpus-per-decision',emotionChange:'POST director/change',scopedEdit:'POST director/edit',jobStatus:'GET director/jobs/:id',cancel:'POST director/cancel',settings:'GET/PUT director/settings',loadVersion:'POST director/load-version',changeScope:'single replacement or explicit selection/range/all sequential optimization; atomic undo',requires:['baseRevision','occurrenceId','prompt']},routes:['POST director/edit','GET director/jobs/:id','POST director/cancel','GET/PUT director/settings','POST director/load-version','GET project','GET catalog','GET director/trace','POST director/preview-change','POST director/change','PUT project','POST import','POST compile','POST ops','POST decide','POST autodirect','POST frame','POST render']});
  }
  const body=await readJson(req);
  if(req.method==='POST'&&route==='generation/start')return send(await startGeneration(body,library));
  if(req.method==='POST'&&route==='generation/cancel')return send(cancelGeneration(body.id));
  if(req.method==='POST'&&route==='director/music/analyze'){
    const state=await studioState(library),music=library.music.find(m=>body.musicId?m.id===body.musicId:state.project.timeline.items.some(i=>i.trackId==='music'&&i.mediaId===m.id));
    if(!music)throw Error('请先选择配乐');
    return send(await analyzeMusicIntent(music,{forceReanalyze:body.forceReanalyze===true}));
  }
  if(req.method==='POST'&&route==='director/edit')return send(await startEditJob(body,library));
  if(req.method==='POST'&&route==='director/cancel')return send(cancelEditJob(body.id));
  if(req.method==='PUT'&&route==='director/settings'){
    const state=await studioState(library);return send(await updateDirectorSettings(state.project.name,body));
  }
  if(req.method==='POST'&&route==='director/load-version'){
    if(!(await productionMenu()).some(v=>v.id===body.id))throw Error('无效版本');
    const current=await studioState(library);if(current.revision!==body.baseRevision){const e=Error('工程已有新修改，请重试');e.status=409;throw e;}
    const activeFile=path.join(studioStore,'director','active-production.json');
    try{const active=JSON.parse(await readFile(activeFile,'utf8'));if((await productionMenu()).some(v=>v.id===active.id)&&current.project.timeline.items.some(i=>i.trackId==='music'&&i.mediaId===active.musicId))await writeFile(path.join(root,'.local/director-productions',active.id,'project.json'),JSON.stringify(current.project,null,2));}catch(e){if(e.code!=='ENOENT')throw e;}
    const folder=path.join(root,'.local/director-productions',body.id),project=JSON.parse(await readFile(path.join(folder,'project.json'),'utf8')),plan=JSON.parse(await readFile(path.join(folder,'plan.json'),'utf8')),summary=JSON.parse(await readFile(path.join(folder,'summary.json'),'utf8')),trace=JSON.parse(await readFile(path.join(folder,'trace.json'),'utf8'));
    const saved=await mutateStudio(library,body.baseRevision,()=>({...project,id:'mad-main'}),'load version '+body.id);
    await writeFile(activeFile,JSON.stringify({id:body.id,musicId:project.timeline.items.find(i=>i.trackId==='music')?.mediaId}));
    await writeFile(path.join(studioStore,'director','latest.json'),JSON.stringify({available:true,revision:saved.revision,theme:plan.theme,plan,summary,trace,exportUrl:'/studio-assets/director/'+body.id+'/homura-mad.mp4'}));return send(saved);
  }
  if(req.method==='POST'&&route==='jev-match'){
    const started=performance.now(),state=await studioState(library);
    if(body.baseRevision!==state.revision){const e=Error('时间轴已有新修改，请重新匹配');e.status=409;throw e;}
    const placeholder=state.project.timeline.items.find(i=>i.id===body.placeholderId&&i.type==='controller'&&i.jevMatchPlaceholder);
    if(!placeholder)throw Error('请先拖入jev匹配占位节点');
    const fps=state.project.metadata.fps,tracks=state.project.timeline.tracks||[];
    const failMatch=message=>{const e=Error(message);e.status=422;throw e;};
    const track=tracks.find(t=>t.id===placeholder.trackId);
    if(!track||placeholder.locked||placeholder.isLocked||track.locked||track.isLocked)failMatch('占位节点或轨道已锁定，请先解锁');
    const musicItem=state.project.timeline.items.find(i=>i.type==='audio'&&i.trackId==='music'&&i.from<=placeholder.from&&i.from+i.durationInFrames>placeholder.from);
    if(!musicItem)failMatch('请将匹配节点放在主音乐实际覆盖的范围内');
    const music=library.music.find(m=>m.id===musicItem.mediaId);if(!music)throw Error('主音乐素材不可用');
    if(musicItem.isReversed)failMatch('单镜匹配暂不支持倒放主音乐');
    const neighbors=state.project.timeline.items.filter(i=>i.id!==placeholder.id&&i.trackId===placeholder.trackId);
    if(neighbors.some(i=>i.from<=placeholder.from&&i.from+i.durationInFrames>placeholder.from))failMatch('占位节点起点与其他素材重叠，请先移动到空位');
    if((state.project.timeline.transitions||[]).some(t=>t.leftClipId===placeholder.id||t.rightClipId===placeholder.id))failMatch('请先移除占位节点上的转场，再匹配素材');
    const trackEnd=Math.min(musicItem.from+musicItem.durationInFrames,...neighbors.filter(i=>i.from>placeholder.from).map(i=>i.from));
    const maxFrames=Math.min(placeholder.durationInFrames,trackEnd-placeholder.from);
    if(maxFrames<Math.ceil(.38*fps))failMatch('可用区间不足 0.38 秒，请延长占位节点或换一个位置');
    const offset=(musicItem.sourceStart||0)/(musicItem.sourceFps||fps),rate=musicItem.speed||1,currentAudio=offset+Math.max(0,placeholder.from-musicItem.from)/fps*rate;
    const events=await cachedMusicEvents(music),options=new Map();
    const add=(sourceTime,reason,priority)=>{const frames=Math.round((sourceTime-currentAudio)/rate*fps);if(frames<Math.ceil(.38*fps)||frames>maxFrames)return;const old=options.get(frames);if(!old||old.priority<priority)options.set(frames,{frames,reason,priority});};
    for(const beat of music.beats||[])add(typeof beat==='number'?beat:beat.time,'普通拍点，可让动作继续',1);
    for(const accent of events.primaryAccents||[])add(accent.time,'音乐主重音',3);
    for(const accent of events.structuralAccents||[])add(accent.time,'乐句变化或重入点',4);
    for(const e of events.events||[])if((e.strength||e.salience||0)>=.72)add(e.time,e.band==='beat-grid-estimate'?'普通拍点':'强拍',2);
    const selectedEnds=[...options.values()].sort((a,b)=>b.priority-a.priority||Math.abs(a.frames-fps*.92)-Math.abs(b.frames-fps*.92)).slice(0,3);
    if(!selectedEnds.some(o=>o.frames===maxFrames))selectedEnds.push({frames:maxFrames,reason:'保持可用区间，让动作完整结束',priority:0});
    const durationOptions=selectedEnds.sort((a,b)=>a.frames-b.frames);
    const width=state.project.metadata.width,height=state.project.metadata.height;
    const item={id:placeholder.id,trackId:placeholder.trackId,from:placeholder.from,durationInFrames:maxFrames,type:'video',label:'jev匹配待选',mediaId:'',src:'',sourceStart:0,sourceEnd:0,sourceFps:fps,sourceDuration:0,speed:1,volume:-60,embeddedAudioMuted:true,sourceWidth:width,sourceHeight:height,transform:{x:0,y:0,width,height,rotation:0,opacity:1,aspectRatioLocked:true}};
    const project={...state.project,duration:Math.max(state.project.duration,trackEnd/fps),timeline:{...state.project.timeline,items:state.project.timeline.items.map(i=>i.id===placeholder.id?item:i)}};
    const [resources,settings]=await Promise.all([liveDirectorResources(),readDirectorSettings()]);
    const goal=String(settings[state.project.name]?.goal??state.project.description??''),prompt=String(body.prompt||'').trim().slice(0,500);
    const result=await chooseGlobalShot({project,item,library,resources,goal,prompt,intent:'当前音乐位置的单镜匹配：看当前动作阶段、人物关系、前后镜头和最近重音，选择完整且接得上的窗口。',ask:q=>decide(q,path.join(studioStore,'jev-match',placeholder.id)),allowKeep:false,manageAudio:true,reserveFrames:1,visionEnabled:body.visionEnabled===true,adaptiveVisual:false,durationOptions});
    const chosen=result.selected.item;
    if(chosen.id!==placeholder.id||chosen.from!==placeholder.from||chosen.durationInFrames>maxFrames||!chosen.mediaId)failMatch('匹配结果超出占位区间，未写入时间轴');
    const nextProject={...state.project,timeline:{...state.project.timeline,items:state.project.timeline.items.map(i=>i.id===placeholder.id?{...chosen,label:chosen.label.replace(/^global · /,'Jev匹配 · ')}:i),keyframes:(state.project.timeline.keyframes||[]).filter(k=>k.itemId!==placeholder.id)}};
    const saved=await mutateStudio(library,state.revision,()=>nextProject,'jev full-corpus match');
    return send({applied:true,placeholderId:placeholder.id,item:{from:chosen.from,durationInFrames:chosen.durationInFrames,label:chosen.label},visual:result.selected.visual,durationSeconds:chosen.durationInFrames/fps,remainingSeconds:(placeholder.durationInFrames-chosen.durationInFrames)/fps,beatReason:durationOptions.find(o=>o.frames===chosen.durationInFrames)?.reason||'Winnow按动作长度裁剪',scope:result.trace.rounds.at(-1)?.scope||{eligible:0,episodes:[]},traceUrl:result.traceUrl,matchId:result.trace.id,state:saved,timing:{prepareMs:result.timing.prepareMs,modelMs:result.timing.modelMs,totalMs:performance.now()-started}});
  }
  if(req.method==='POST'&&['director/change','director/preview-change'].includes(route)){
    const started=performance.now(),state=await studioState(library),apply=route==='director/change';
    if(body.baseRevision!==state.revision){const e=Error('工程已有新版本，本次修改未覆盖');e.status=409;throw e;}
    const item=state.project.timeline.items.find(i=>i.id===body.occurrenceId&&i.type==='video');if(!item)throw Error('找不到当前画面片段');
    const prompt=String(body.prompt||'').trim();if(!prompt||prompt.length>500)throw Error('请输入500字以内的修改要求');
    if(state.project.timeline.items.some(i=>i.type==='audio'&&i.trackId!=='music'&&i.from<item.from+item.durationInFrames&&i.from+i.durationInFrames>item.from)){const e=Error('此镜头关联原声或台词，请使用选区编辑的声音选项');e.status=422;throw e;}
    const ticket=apply?beginEditEpoch(state.project.id):{current:()=>true,cancel:()=>{}};
    res.on('close',()=>{if(!res.writableEnded)ticket.cancel();});
    let report={};try{report=JSON.parse(await readFile(path.join(studioStore,'director','latest.json'),'utf8'));}catch{}
    const result=await chooseGlobalShot({project:state.project,item,library,goal:String(body.goal||report.theme||state.project.description||''),prompt,cancelled:()=>!ticket.current()});
    if(!ticket.current()){const e=Error('此请求已被更新的修改替代');e.status=499;throw e;}
    const selected=result.selected,commitStart=performance.now();
    const saved=apply&&!selected.keep?await mutateStudio(library,state.revision,project=>{if(!ticket.current()){const e=Error('此请求已失效');e.status=499;throw e;}return applyLiveReplacement(project,selected.item);},'Winnow global single edit'):await studioState(library);
    if((!apply||selected.keep)&&saved.revision!==state.revision){const e=Error('决策期间工程有新修改，请重试');e.status=409;throw e;}
    return send({applied:apply&&!selected.keep,changed:!selected.keep,selected:{shotId:selected.shotId,visual:selected.visual,similarity:selected.similarity??0,preview:selected.preview},model:result.model,ms:result.timing.modelMs,item:selected.item,state:saved,revision:saved.revision,searchScope:result.trace.rounds.at(-1)?.scope,traceUrl:result.traceUrl,noSuitableCandidate:result.trace.noSuitableCandidate,timing:{prepareMs:result.timing.prepareMs,modelMs:result.timing.modelMs,commitMs:performance.now()-commitStart,serverMs:performance.now()-started},scope:[item.from/state.project.metadata.fps,(item.from+item.durationInFrames)/state.project.metadata.fps]});
  }
  if(req.method==='PUT'&&route==='project')return send(await mutateStudio(library,body.baseRevision,(_,state)=>restoreItemMetadata(body.project,state.project),'GUI save'));
  if(req.method==='POST'&&route==='import'){const saved=await mutateStudio(library,body.baseRevision,()=>library.project?.nativeProject||migrateLegacyProject(library),'import generated timeline');if(library.project?.globalDecisions){await mkdir(path.join(studioStore,'director'),{recursive:true});await writeFile(path.join(studioStore,'director','latest.json'),JSON.stringify(globalReport(library.project,saved.revision),null,2));}return send(saved);}
  if(req.method==='POST'&&route==='compile'){
    const state=await studioState(library);return send(compileTechnique(body.request||body,{...state.project,madCatalog:await studioCatalog(library)}));
  }
  if(req.method==='POST'&&route==='ops')return send(await mutateStudio(library,body.baseRevision,project=>nativeEdit(project,body.ops),'Agent operation batch'));
  if(req.method==='POST'&&route==='autodirect'){
    const state=await studioState(library);if(body.baseRevision!==state.revision){const e=Error('工作台已有新修改，自动效果未覆盖');e.status=409;throw e;}
    const fps=state.project.metadata.fps,hit=Math.round((library.project?.musicEvents?.firstEntry??.55)*fps);
    const videos=state.project.timeline.items.filter(i=>i.type==='video').sort((a,b)=>a.from-b.from);
    const clip=videos.find(i=>i.from<=hit&&i.from+i.durationInFrames>hit&&i.durationInFrames>=6)||videos.find(i=>i.from>=hit&&i.durationInFrames>=6);
    if(!clip)throw Error('没有足够长的重音候选镜头');
    const localFrame=Math.max(0,Math.min(hit-clip.from,clip.durationInFrames-6)),durationInFrames=Math.min(8,clip.durationInFrames-localFrame),requestId='auto-'+randomUUID().slice(0,8);
    const candidates=[{label:'克制的重音推近',scale:1.07,rgbAmount:0},{label:'更强的推近与色差',scale:1.16,rgbAmount:.009}].map((variant,i)=>({label:variant.label,request:{technique:'impact',requestId:requestId+'-'+i,occurrenceId:clip.id,localFrame,durationInFrames,scale:variant.scale,rgbAmount:variant.rgbAmount}}));
    const r=await fetch('http://127.0.0.1:'+(process.env.PORT||8794)+'/api/studio/decide',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseRevision:state.revision,context:'音乐开始建立节奏的第一波主重音。比较实际渲染后的效果，强化动作释放但不要遮挡主体或用过度色差。',frames:[clip.from+localFrame+1,clip.from+localFrame+Math.floor(durationInFrames/2)],candidates,apply:true})});const result=await r.json();if(!r.ok){const error=Error(result.error||'自动效果比较失败');error.status=r.status;throw error;}return send(result);
  }
  if(req.method==='POST'&&route==='frame'){
    const state=await studioState(library);const project=body.ops?await nativeEdit(state.project,body.ops):state.project;
    const bytes=await engineRequest('/frame',{projectObject:project,frame:body.frame??0,width:body.width??640,height:body.height??360},{binary:true});
    res.writeHead(200,{'Content-Type':'image/png','Content-Length':bytes.length});res.end(bytes);return true;
  }
  if(req.method==='POST'&&route==='render'){
    const state=await studioState(library);const project=body.ops?await nativeEdit(state.project,body.ops):state.project;
    const bytes=await engineRequest('/render',{projectObject:project,codec:'h264',container:'mp4',inSec:body.in??0,...(body.duration!==undefined?{duration:body.duration}:{})},{binary:true});
    const name=randomUUID()+'.mp4';await mkdir(path.join(studioStore,'exports'),{recursive:true});await writeFile(path.join(studioStore,'exports',name),bytes);
    return send({url:'/studio-assets/exports/'+name,bytes:bytes.length,revision:state.revision});
  }
  if(req.method==='POST'&&route==='decide'){
    const state=await studioState(library);if(body.baseRevision!==state.revision){const e=Error('工作台版本已改变');e.status=409;throw e;}
    if(!Array.isArray(body.candidates)||body.candidates.length<2||body.candidates.length>8)throw Error('Winnow 比较需要2–8个有限候选');
    const catalog=await studioCatalog(library),id=randomUUID(),folder=path.join(studioStore,'decisions',id);await mkdir(folder,{recursive:true});const proposals=[],images=[];
    for(let i=0;i<body.candidates.length;i++){
      const input=body.candidates[i],requests=input.requests||[input.request];if(!Array.isArray(requests)||requests.length<1||requests.length>8)throw Error('每个候选程序包含1–8个剪辑手法');
      let candidate=structuredClone(state.project);const compiled={ops:[],explanation:[],checks:[]};
      for(const request of requests){const step=compileTechnique(request,{...candidate,madCatalog:catalog});candidate=await nativeEdit(candidate,step.ops);compiled.ops.push(...step.ops);compiled.explanation.push(step.explanation);compiled.checks.push(step.checks);}
      const times=body.frames||[body.frame??Math.max(0,requests[0].from??0)];if(!Array.isArray(times)||times.length<1||times.length>3||times.some(f=>!Number.isInteger(f)||f<0))throw Error('预览帧必须为1–3个非负整数');
      const files=[];for(let j=0;j<times.length;j++){const bytes=await engineRequest('/frame',{projectObject:candidate,frame:times[j],width:480,height:270},{binary:true}),file=path.join(folder,`${i}-${j}.png`);await writeFile(file,bytes);files.push(file);}
      const sheet=path.join(folder,`${i}.jpg`);await execFile((process.env.MAD_PYTHON||path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python')),['scripts/studio-contact.py',sheet,...files]);images.push('data:image/jpeg;base64,'+(await readFile(sheet)).toString('base64'));
      proposals.push({id:'p'+i,label:String(input.label||requests.map(r=>r.technique).join(' + ')).slice(0,120),request:{technique:requests.map(r=>r.technique).join(' + ')},compiled,project:candidate});
    }
    const model=await decide({state:{context:String(body.context||'选择视觉最清楚、节奏最适合的剪辑表现').slice(0,1000),frames:body.frames||[body.frame??0],candidates:proposals.map((p,i)=>({id:p.id,label:p.label,technique:p.request.technique,image:i+1,explanation:p.compiled.explanation}))},questions:Object.fromEntries(proposals.map(p=>[p.id,{type:'score',instructions:`Evaluate rendered proposal ${p.id}. Compare rhythm intent, visual clarity, subject/text occlusion and appropriate effect strength. Intentional reuse and intercutting are valid; do not reward gratuitous effects.`,criteria:['不合适','勉强','合适','最佳']}])) ,winnow:{images}},folder);
    const scored=proposals.map(p=>({...p,score:model.result.answers?.[p.id]?.score}));if(scored.some(p=>!Number.isFinite(p.score)))throw Error('Winnow 评分缺失');scored.sort((a,b)=>b.score-a.score);const best=scored[0];
    const saved=body.apply===true?await mutateStudio(library,state.revision,()=>best.project,'Winnow selected '+best.id):null;
    const output={decisionId:id,selected:best.id,score:best.score,model:model.result.model,ms:model.ms,applied:!!saved,revision:saved?.revision??state.revision,ops:best.compiled.ops,scores:scored.map(p=>({id:p.id,label:p.label,score:p.score,preview:'/studio-assets/decisions/'+id+'/'+p.id.slice(1)+'.jpg'}))};await writeFile(path.join(folder,'selection.json'),JSON.stringify(output,null,2));return send(output);
  }
  json(res,{error:'未知工作台接口'},404);return true;
}
function projectFps(state){return state.project.metadata.fps;}
