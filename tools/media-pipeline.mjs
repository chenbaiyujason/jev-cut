import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),backend=path.join(root,'apps/backend'),args=process.argv.slice(2);
if(args.includes('--help')||!args.length){console.log('npm run media -- --manifest data/sources.json --stage local|understand|embedding|index|all [--dry-run]\nRun local first to inspect cuts/subtitles before paid model calls.');process.exit(0);}
const value=k=>args[args.indexOf(k)+1],stage=args.includes('--stage')?value('--stage'):'local',manifest=args.includes('--manifest')?path.resolve(value('--manifest')):null;
const python=process.env.MAD_PYTHON||path.join(backend,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
function run(command,argv){return new Promise((resolve,reject)=>{const child=spawn(command,argv,{cwd:backend,stdio:'inherit',windowsHide:true,env:{...process.env,PYTHONUTF8:'1'}});child.on('error',reject);child.on('exit',n=>n===0?resolve():reject(Error('Stage failed; completed caches retained.')));});}
if(['local','all'].includes(stage)){if(!manifest)throw Error('--manifest is required');await run(python,['scripts/prepare_sources.py','--manifest',manifest,...(args.includes('--dry-run')?['--dry-run']:[])]);if(args.includes('--dry-run'))process.exit(0);await run(python,['scripts/refine_thumbnails.py']);await run(python,['scripts/find_repeated_sequences.py']);}
if(['understand','all'].includes(stage))await run(process.execPath,['scripts/enrich-catalog.mjs']);
if(['embedding','all'].includes(stage))await run(process.execPath,['scripts/build-embeddings.mjs']);
if(['index','all'].includes(stage)){
 const {readFile,writeFile,mkdir}=await import('node:fs/promises');const library={sources:[],music:[],project:null};
 const catalog=path.join(backend,'.local/catalog-v2');const {readdir}=await import('node:fs/promises');for(const name of await readdir(catalog))if(/^episode-\d+$/.test(name))library.sources.push(JSON.parse(await readFile(path.join(catalog,name,'enriched.json'),'utf8')));
 const file=path.join(backend,'.local/library.json');let prior;try{prior=JSON.parse(await readFile(file,'utf8'));}catch{}await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify({...library,...prior,sources:library.sources},null,2));
 try{await readFile(path.join(catalog,'vector-index.json'));}catch{await writeFile(path.join(catalog,'vector-index.json'),JSON.stringify({model:'unavailable-no-embeddings',dimensions:768,entries:[],vectorFile:'empty-vectors.f32'}));await writeFile(path.join(catalog,'empty-vectors.f32'),Buffer.alloc(0));}
 await mkdir(path.join(backend,'.local/cut-safety-v1'),{recursive:true});await run(process.execPath,['scripts/cache-full-corpus.mjs']);
}
