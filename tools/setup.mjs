import {spawnSync} from 'node:child_process';
import {mkdir,copyFile,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
for(const app of ['backend','editor']){
 const cwd=path.join(root,'apps',app),npm=process.env.npm_execpath;
 const r=npm?spawnSync(process.execPath,[npm,app==='editor'?'ci':'install'],{cwd,stdio:'inherit',windowsHide:true}):spawnSync('npm',[app==='editor'?'ci':'install'],{cwd,stdio:'inherit',shell:process.platform==='win32',windowsHide:true});
 if(r.status!==0)process.exit(r.status||1);
}
await mkdir(path.join(root,'apps/backend/localdevenv'),{recursive:true});const env=path.join(root,'apps/backend/localdevenv/.env');try{await access(env);}catch{await copyFile(path.join(root,'apps/backend/localdevenv.example.env'),env);}
await import('./download-editor-assets.mjs');
console.log('Node dependencies ready. Configure apps/backend/localdevenv/.env; see docs/SETUP.md for FFmpeg and Python.');
