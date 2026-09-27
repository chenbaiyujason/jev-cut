import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {root} from './catalog.mjs';
const defaults=[];
export const productionMenuFile=path.join(root,'.local/director-productions/menu.json');
export async function productionMenu(){
 try{const data=JSON.parse(await readFile(productionMenuFile,'utf8'));if(!Array.isArray(data.versions)||data.versions.some(v=>!/^[-a-zA-Z0-9_]+$/.test(v.id)||typeof v.name!=='string'))throw Error('Invalid saved project menu');return data.versions;}
 catch(e){if(e.code==='ENOENT')return defaults;throw e;}
}
