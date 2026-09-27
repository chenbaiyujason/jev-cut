import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {root} from './catalog.mjs';
const folder=path.join(root,'.local/global-semantic-cache'),memory=new Map();
// Exact clip cursor is not evidence for basic thematic fit. Section content/bounds and
// music understanding identity remain, including both sections for a boundary-crossing clip.
export function semanticMusicContext(context){if(!context)return context;const {sourceRange,...stable}=context;return stable;}
export function semanticKey({goal,prompt,intent,shot,musicContext,decisionContext,model=process.env.WINNOW_CACHE_MODEL||'Winnow-12B'}){return createHash('sha256').update(JSON.stringify({version:4,model,goal,prompt,intent,musicContext:semanticMusicContext(musicContext),decisionContext,id:shot.id,visual:shot.description,dialogue:shot.semantic?.dialogue_meaning_zh?.slice(0,50)})).digest('hex');}
export async function cachedSemantic(key){if(memory.has(key))return memory.get(key);try{const data=JSON.parse(await readFile(path.join(folder,key+'.json'),'utf8'));memory.set(key,data);return data;}catch{return null;}}
export async function saveSemantic(key,data){await mkdir(folder,{recursive:true});const file=path.join(folder,key+'.json'),tmp=file+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(data));await rename(tmp,file);memory.set(key,data);while(memory.size>4096)memory.delete(memory.keys().next().value);}
