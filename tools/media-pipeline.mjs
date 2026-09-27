import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),backend=path.join(root,'apps/backend'),args=process.argv.slice(2);
if(args.includes('--help')||!args.length){console.log('npm run media -- --manifest data/sources.json --stage local|understand|embedding|index|all [--dry-run] [--pilot]\n--dry-run: local only. --pilot: understand only (one chunk; not a complete index).');process.exit(0);}
const value=k=>args[args.indexOf(k)+1],stage=args.includes('--stage')?value('--stage'):'local',manifest=args.includes('--manifest')?path.resolve(value('--manifest')):null;
if(!['local','understand','embedding','index','all'].includes(stage))throw Error('未知 stage');
if(manifest&&!['local','all'].includes(stage))throw Error('后续阶段使用 local 保存的清单；不要传入未准备的新清单');
if(args.includes('--dry-run')&&stage!=='local')throw Error('--dry-run 仅用于 local，不会替其他阶段执行模型调用');
if(args.includes('--pilot')&&stage!=='understand')throw Error('--pilot 仅用于 understand');
for(let i=0;i<args.length;i++){if(['--stage','--manifest'].includes(args[i])){if(!args[i+1]||args[i+1].startsWith('--'))throw Error('参数缺少值');i++;}else if(!['--dry-run','--pilot'].includes(args[i]))throw Error('未知参数 '+args[i]);}
const python=process.env.MAD_PYTHON||path.join(backend,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
function run(command,argv){return new Promise((resolve,reject)=>{const child=spawn(command,argv,{cwd:backend,stdio:'inherit',windowsHide:true,env:{...process.env,PYTHONUTF8:'1'}});child.on('error',reject);child.on('exit',n=>n===0?resolve():reject(Error('Stage failed; completed caches retained.')));});}
if(['local','all'].includes(stage)){if(!manifest)throw Error('--manifest is required');await run(python,['scripts/prepare_sources.py','--manifest',manifest,...(args.includes('--dry-run')?['--dry-run']:[])]);if(args.includes('--dry-run'))process.exit(0);await run(python,['scripts/refine_thumbnails.py']);await run(python,['scripts/find_repeated_sequences.py']);await run(process.execPath,['scripts/prepare-editor-proxies.mjs','--catalog']);}
if(['understand','all'].includes(stage))await run(process.execPath,['scripts/enrich-catalog.mjs',...(args.includes('--pilot')?['--pilot']:[])]);
if(['embedding','all'].includes(stage)){
 const {configuration}=await import('../apps/backend/gemini.mjs');const cfg=await configuration();
 if(cfg.MAD_EMBEDDING_ENABLED==='false'){if(stage==='embedding')throw Error('Embedding 已明确关闭；如需启用，请先修改配置');console.log('Embedding explicitly disabled; using lexical retrieval');}
 else await run(process.execPath,['scripts/build-embeddings.mjs']);
}
if(['index','all'].includes(stage)){
 const {readFile,writeFile,mkdir}=await import('node:fs/promises');const library={sources:[],music:[],project:null};
 const catalog=path.join(backend,'.local/catalog-v2');const {readyCatalogSources}=await import('../apps/backend/release-catalog.mjs');library.sources=await readyCatalogSources(catalog);
 const {configuration}=await import('../apps/backend/gemini.mjs');const cfg=await configuration();
 if(cfg.MAD_EMBEDDING_ENABLED!=='false'){
  const index=JSON.parse(await readFile(path.join(catalog,'vector-index.json'),'utf8'));
  const vectors=await readFile(path.join(catalog,index.vectorFile||'vectors.f32'));
  const {filterRepeatedSequences}=await import('../apps/backend/repeated-sequences.mjs');
  const duplicates=JSON.parse(await readFile(path.join(catalog,'repeated-sequences.json'),'utf8'));
  const searchable=filterRepeatedSequences(library.sources,duplicates).sources.flatMap(s=>s.shots).filter(s=>!s.excluded),ids=new Set(index.entries.map(e=>e.id));
  if(index.model!==(cfg.GEMINI_EMBEDDING_MODEL||'gemini-embedding-2')||index.dimensions!==768||vectors.length!==index.entries.length*768*4||searchable.some(s=>!ids.has(s.id)))throw Error('Embedding 模型、维度或覆盖不完整，请先完成 embedding 阶段');
 }
 await run(process.execPath,['scripts/prepare-editor-proxies.mjs','--catalog']);
 const file=path.join(backend,'.local/library.json');let prior;try{prior=JSON.parse(await readFile(file,'utf8'));}catch{}await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify({...library,...prior,sources:library.sources},null,2));
 try{await readFile(path.join(catalog,'vector-index.json'));}catch{await writeFile(path.join(catalog,'vector-index.json'),JSON.stringify({model:'unavailable-no-embeddings',dimensions:768,entries:[],vectorFile:'empty-vectors.f32'}));await writeFile(path.join(catalog,'empty-vectors.f32'),Buffer.alloc(0));}
 await mkdir(path.join(backend,'.local/cut-safety-v1'),{recursive:true});await run(process.execPath,['scripts/cache-full-corpus.mjs']);
}
