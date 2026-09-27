import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {root} from './catalog.mjs';
const folder=path.join(root,'.local/global-semantic-cache'),memory=new Map();
export function semanticKey({goal,prompt,intent,shot,musicContext}){return createHash('sha256').update(JSON.stringify({version:2,model:'Winnow-12B',goal,prompt,intent,musicContext,id:shot.id,visual:shot.description,dialogue:shot.semantic?.dialogue_meaning_zh?.slice(0,50)})).digest('hex');}
export async function cachedSemantic(key){if(memory.has(key))return memory.get(key);try{const data=JSON.parse(await readFile(path.join(folder,key+'.json'),'utf8'));memory.set(key,data);return data;}catch{return null;}}
export async function saveSemantic(key,data){await mkdir(folder,{recursive:true});memory.set(key,data);await writeFile(path.join(folder,key+'.json'),JSON.stringify(data));}
