import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {root} from './catalog.mjs';
const folder=path.join(root,'.local/global-semantic-cache'),memory=new Map();
// Exact clip cursor is not evidence for basic thematic fit. Section content/bounds and
// music understanding identity remain, including both sections for a boundary-crossing clip.
export function semanticMusicContext(context){if(!context)return context;const {sourceRange,...stable}=context;return stable;}
export function semanticKey({goal,prompt,intent,shot,musicContext,model=process.env.WINNOW_CACHE_MODEL||'Winnow-12B'}){return createHash('sha256').update(JSON.stringify({version:3,model,goal,prompt,intent,musicContext:semanticMusicContext(musicContext),id:shot.id,visual:shot.description,dialogue:shot.semantic?.dialogue_meaning_zh?.slice(0,50)})).digest('hex');}
export async function cachedSemantic(key){if(memory.has(key))return memory.get(key);try{const data=JSON.parse(await readFile(path.join(folder,key+'.json'),'utf8'));memory.set(key,data);return data;}catch{return null;}}
export async function saveSemantic(key,data){await mkdir(folder,{recursive:true});memory.set(key,data);while(memory.size>4096)memory.delete(memory.keys().next().value);await writeFile(path.join(folder,key+'.json'),JSON.stringify(data));}
