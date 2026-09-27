import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const dir=new URL('../apps/backend/.local/models/transnetv2/',import.meta.url),file=new URL('weights.pth',dir),sha='46520d66d4bf60414a4d82e0e94a92442ff950e34517a3718b2e54815e642b53';
await mkdir(dir,{recursive:true});let bytes;try{bytes=await readFile(file);}catch{}
if(!bytes||createHash('sha256').update(bytes).digest('hex')!==sha){const url='https://huggingface.co/MiaoshouAI/transnetv2-pytorch-weights/resolve/a97542e4eb22e3af904ac13b10cf06da507e2ff1/transnetv2-pytorch-weights.pth';const r=await fetch(url);if(!r.ok)throw Error('Detector download failed '+r.status);bytes=Buffer.from(await r.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==sha)throw Error('Detector hash mismatch; not installed');await writeFile(file,bytes);}
console.log('TransNetV2 weights verified; stored only in ignored local model cache.');
