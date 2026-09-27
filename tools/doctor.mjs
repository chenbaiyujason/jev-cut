import {readFile,access} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {configuration,understand,embed} from '../apps/backend/gemini.mjs';
import {decide} from '../apps/backend/decision-provider.mjs';
import {expectedCatalogEpisodes,readyCatalogSources} from '../apps/backend/release-catalog.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),backend=path.join(root,'apps/backend'),args=process.argv.slice(2);
if(args.includes('--help')){console.log('npm run doctor -- --stage environment|local|index [--models]\nRead-only local checks. --models additionally sends tiny text-only requests to configured model services; no media is uploaded.');process.exit(0);}
const stage=args.includes('--stage')?args[args.indexOf('--stage')+1]:'environment';
if(!['environment','local','index'].includes(stage))throw Error('Unknown doctor stage');
for(let i=0;i<args.length;i++){if(args[i]==='--stage')i++;else if(args[i]!=='--models')throw Error('Unknown argument');}
const cfg=await configuration(),report={stage,checks:[],modelConfiguration:{understanding:!!cfg.GEMINI_API_KEY&&!!cfg.GEMINI_MODEL,embeddingEnabled:cfg.MAD_EMBEDDING_ENABLED!=='false',decision:!!(cfg.JEV_DECISION_URL||cfg.WINNOW_URL)},errors:[]};
function check(name,ok,detail){report.checks.push({name,ok,detail});if(!ok)report.errors.push(name);}
async function exists(file){try{await access(file);return true;}catch{return false;}}
function command(exe,argv){return spawnSync(exe,argv,{cwd:root,encoding:'utf8',windowsHide:true,timeout:30000});}
const [nodeMajor,nodeMinor]=process.versions.node.split('.').map(Number);
check('node',nodeMajor>22||nodeMajor===22&&nodeMinor>=12,process.versions.node);
for(const [app,pkg]of [['backend','vite'],['editor','vite-plus']])check(app+'-node-dependencies',await exists(path.join(backend,'..',app,'node_modules',pkg,'package.json')),'Run npm run setup if missing');
for(const exe of ['ffmpeg','ffprobe'])check(exe,command(exe,['-version']).status===0,'Must be available on PATH');
const python=process.env.MAD_PYTHON||path.join(backend,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const py=command(python,['-c',"import sys,importlib.util,json; names=['numpy','librosa','soundfile','PIL','scenedetect','torch','cv2']; print(json.dumps({'version':list(sys.version_info[:3]),'missing':[n for n in names if importlib.util.find_spec(n) is None]}))"]);
let pythonInfo;try{pythonInfo=JSON.parse(py.stdout);}catch{}
check('python-runtime',py.status===0&&!!pythonInfo&&pythonInfo.version[0]===3&&pythonInfo.version[1]>=12,pythonInfo||'Create apps/backend/.venv with Python 3.12+ (3.13 tested)');
check('python-packages',!!pythonInfo&&!pythonInfo.missing.length,pythonInfo?.missing||'Install requirements.txt and requirements-vision.txt');
let weightsValid=false;try{weightsValid=createHash('sha256').update(await readFile(path.join(backend,'.local/models/transnetv2/weights.pth'))).digest('hex')==='46520d66d4bf60414a4d82e0e94a92442ff950e34517a3718b2e54815e642b53';}catch{}
check('transnet-weights',weightsValid,'Run node tools/download-detector.mjs');
const editorAssets=JSON.parse(await readFile(path.join(root,'tools/editor-assets.json'),'utf8'));
let assetsValid=true;for(const asset of editorAssets.files){try{const bytes=await readFile(path.join(root,asset.path));if(createHash('sha256').update(bytes).digest('hex')!==asset.sha256)assetsValid=false;}catch{assetsValid=false;}}
check('editor-model-assets',assetsValid,'Run node tools/download-editor-assets.mjs');
if(stage!=='environment'){
 const catalog=path.join(backend,'.local/catalog-v2');let episodes=[];
 try{episodes=await expectedCatalogEpisodes(catalog);check('source-manifest',true,{sources:episodes.length});}catch{check('source-manifest',false,'Run media --stage local with a manifest');}
 for(const ep of episodes){
  try{
   const dir=path.join(catalog,'episode-'+String(ep).padStart(2,'0')),source=JSON.parse(await readFile(path.join(dir,'source.json'),'utf8'));
   check(`source-${ep}-shots`,source.shots?.length>0&&source.thumbVersion===2,{shots:source.shots?.length,subtitleCues:source.cues?.length,exactThumbnails:source.thumbVersion===2});
   const proxy=command('ffprobe',['-v','error','-show_entries','stream=codec_type,nb_frames,avg_frame_rate','-of','json',path.join(source.dir,'edit-preview-v2.mp4')]);
   const data=JSON.parse(proxy.stdout),video=data.streams?.find(s=>s.codec_type==='video');
   const boundaries=JSON.parse(await readFile(path.join(dir,'boundaries.json'),'utf8'));
   check(`source-${ep}-editor-proxy`,proxy.status===0&&Number(video?.nb_frames)===boundaries.frameCount,'Edit proxy must preserve decoded frame count');
   check(`source-${ep}-analysis-proxy`,await exists(path.join(dir,'analysis-proxy.mp4')),'Compressed model input');
  }catch{check(`source-${ep}-local-data`,false,'Inspect preprocessing output and rerun local stage');}
 }
 check('repeated-sequences',await exists(path.join(catalog,'repeated-sequences.json')),'Heuristic edge-duplicate evidence; inspect before excluding content');
 if(stage==='index'){
  try{
   const sources=await readyCatalogSources(catalog),corpus=JSON.parse(await readFile(path.join(catalog,'full-corpus.json'),'utf8'));
   const expectedShots=new Set(sources.flatMap(s=>s.shots.map(shot=>shot.id)));
   check('full-corpus',sources.length===corpus.sources.length&&sources.every(s=>corpus.sources.some(c=>c.id===s.id))&&corpus.shots.length===expectedShots.size&&corpus.shots.every(s=>expectedShots.has(s.id)),{sources:sources.length,shots:corpus.stats?.total,searchable:corpus.stats?.defaultSelectable});
   const index=JSON.parse(await readFile(path.join(catalog,'vector-index.json'),'utf8'));
   if(cfg.MAD_EMBEDDING_ENABLED!=='false'){
    const bytes=await readFile(path.join(catalog,index.vectorFile||'vectors.f32')),ids=new Set(index.entries.map(e=>e.id));
    check('embedding-index',index.model===cfg.GEMINI_EMBEDDING_MODEL&&bytes.length===index.entries.length*index.dimensions*4&&corpus.shots.filter(s=>!s.excluded&&s.semanticStatus==='complete').every(s=>ids.has(s.id)),{modelMatches:index.model===cfg.GEMINI_EMBEDDING_MODEL,vectors:ids.size,dimensions:index.dimensions});
   }else check('embedding-index',true,'Explicitly disabled; lexical retrieval only');
  }catch{check('index-ready',false,'Complete understand, optional embedding, then index; a pilot is not a complete corpus');}
 }
}
if(args.includes('--models')){
 if(report.errors.length)check('model-probes',false,'Skipped because local prerequisites failed');
 else{
  for(const [name,run]of [
   ['understanding',()=>understand([{text:'Return ready=true.'}],{schema:{type:'OBJECT',properties:{ready:{type:'BOOLEAN'}},required:['ready']},maxTokens:512,cacheKey:'doctor-'+Date.now()})],
   ...(cfg.MAD_EMBEDDING_ENABLED==='false'?[]:[['embedding',()=>embed([{text:'environment probe'}])]]),
   ['decision',()=>decide({state:{task:'environment probe'},questions:{pick:{type:'choice',instructions:'Choose ready.',criteria:{ready:null,other:null}}}})],
  ]){try{await run();check('model-'+name,true,'Small text request succeeded; multimodal capability still requires the pilot');}catch{check('model-'+name,false,'Check local credentials, service protocol and available model ID; raw error omitted to protect credentials');}}
 }
}
report.ready=report.errors.length===0;console.log(JSON.stringify(report,null,2));process.exitCode=report.ready?0:1;
