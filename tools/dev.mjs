import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),editor=path.join(root,'apps/editor'),backend=path.join(root,'apps/backend');
const apiPort=Number(process.env.JEV_API_PORT||8794),editorPort=Number(process.env.JEV_EDITOR_PORT||8796),enginePort=Number(process.env.JEV_ENGINE_PORT||8787);
const children=[],env={...process.env,PORT:String(apiPort),JEV_EDITOR_PORT:String(editorPort),JEV_API_URL:`http://127.0.0.1:${apiPort}`,MAD_STUDIO_ROOT:editor,MAD_ENGINE_URL:`http://127.0.0.1:${enginePort}`};
async function free(port){try{await fetch(`http://127.0.0.1:${port}`,{signal:AbortSignal.timeout(700)});throw Error(`Port ${port} is occupied; choose isolated JEV_*_PORT values. Existing services were not changed.`);}catch(e){if(e.message.startsWith('Port '))throw e;}}
await Promise.all([apiPort,editorPort,enginePort].map(free));await mkdir(path.join(editor,'.mad-workspace'),{recursive:true});
function start(cwd,args){const p=spawn(process.execPath,args,{cwd,env,stdio:'inherit',windowsHide:true});children.push(p);p.on('error',e=>{console.error(e.message);stop();});return p;}
function stop(){for(const p of children)if(p.exitCode===null)p.kill();}
process.on('SIGINT',()=>{stop();process.exit(0);});process.on('SIGTERM',()=>{stop();process.exit(0);});
start(backend,['server.mjs']);start(editor,['node_modules/vite-plus/bin/vp','dev','--host','127.0.0.1','--port',String(editorPort)]);
try{
 let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(`http://127.0.0.1:${editorPort}/headless.html`,{signal:AbortSignal.timeout(1000)})).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,400));}
 if(!ready)throw Error('Editor did not start; inspect the error above.');
 start(editor,['headless/serve.mjs','--workspace','.mad-workspace','--port',String(enginePort),'--harness-url',`http://127.0.0.1:${editorPort}/headless.html`]);
 console.log(`jev剪辑: http://127.0.0.1:${editorPort}/mad`);
}catch(e){stop();console.error(e.message);process.exitCode=1;}
