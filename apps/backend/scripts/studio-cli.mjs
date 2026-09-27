#!/usr/bin/env node
import {readFile,writeFile} from 'node:fs/promises';
const [command,file]=process.argv.slice(2),base=process.env.MAD_STUDIO_API||'http://127.0.0.1:8794/api/studio';
const routes={capabilities:['capabilities','GET'],project:['project','GET'],catalog:['catalog','GET'],compile:['compile','POST'],apply:['ops','POST'],compare:['decide','POST'],autodirect:['autodirect','POST'],frame:['frame','POST'],render:['render','POST']};
if(!routes[command])throw Error('Usage: studio-cli.mjs capabilities|project|catalog|compile|apply|compare|autodirect|frame|render [request.json]');
const [route,method]=routes[command],body=method==='POST'?JSON.parse(await readFile(file,'utf8')):undefined;
const r=await fetch(base+'/'+route,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
if(!r.ok)throw Error(`HTTP ${r.status}: ${await r.text()}`);
if(command==='frame'){const output=process.argv[4]||'mad-frame.png';await writeFile(output,Buffer.from(await r.arrayBuffer()));console.log(JSON.stringify({output}));}else console.log(JSON.stringify(await r.json(),null,2));
