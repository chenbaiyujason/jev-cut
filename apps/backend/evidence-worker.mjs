import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {root} from './catalog.mjs';
let worker,idle;const pending=new Map();
function start(){if(worker)return;const child=spawn((process.env.MAD_PYTHON||path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python')),['-u',path.join(root,'scripts/prepare-global-evidence.py'),'--worker'],{windowsHide:true,stdio:['pipe','pipe','pipe']});worker=child;let errors='';child.stderr.on('data',d=>{errors=(errors+d).slice(-1500);});createInterface({input:child.stdout}).on('line',line=>{let r;try{r=JSON.parse(line);}catch{return;}const p=pending.get(r.id);if(!p)return;clearTimeout(p.timeout);pending.delete(r.id);r.error?p.reject(Error(r.error)):p.resolve();if(!pending.size)idle=setTimeout(()=>{if(worker===child){worker=null;child.stdin.end();}},10000);});const failed=()=>{if(worker===child)worker=null;for(const [id,p]of pending){if(p.child!==child)continue;clearTimeout(p.timeout);p.reject(Error('图像准备进程退出 '+errors));pending.delete(id);}};child.on('error',failed);child.on('exit',failed);}
export function prepareEvidenceTasks(tasks){if(!tasks.length)return Promise.resolve();clearTimeout(idle);start();const id=randomUUID(),child=worker;return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{pending.delete(id);reject(Error('素材窗口准备超时'));child.kill();if(worker===child)worker=null;},60000);pending.set(id,{resolve,reject,timeout,child});child.stdin.write(JSON.stringify({id,tasks})+'\n');});}
export function warmEvidenceWorker(){return prepareEvidenceTasks([{kind:'warmup'}]);}
