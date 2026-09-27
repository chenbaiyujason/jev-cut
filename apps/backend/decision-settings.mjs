import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import path from 'node:path';
import {root} from './catalog.mjs';
import {configuration} from './gemini.mjs';
const file=path.join(root,'.local/studio/director/settings.json');let updates=Promise.resolve();
export async function readDirectorSettings(){try{return JSON.parse(await readFile(file,'utf8'));}catch{return {};}}
export function updateDirectorSettings(name,body){
 const next=updates.catch(()=>{}).then(async()=>{if(body.visionEnabled!==undefined&&typeof body.visionEnabled!=='boolean')throw Error('视觉复核设置必须为布尔值');const saved=await readDirectorSettings();
  if(body.goal!==undefined)saved[name]={...saved[name],goal:String(body.goal||'').slice(0,1000)};
  if(body.visionEnabled!==undefined)saved._decisionPreferences={...saved._decisionPreferences,visionEnabled:body.visionEnabled};
  await mkdir(path.dirname(file),{recursive:true});await writeFile(file+'.tmp',JSON.stringify(saved,null,2));await rename(file+'.tmp',file);
  return {...saved[name],visionEnabled:await visionSelectionEnabled()};
 });updates=next;return next;
}
export function resolveVisionSetting({override,saved,environment}={}){
 if(typeof override==='boolean')return override;
 if(typeof saved==='boolean')return saved;
 return environment==='true';
}
export async function visionSelectionEnabled(override){
 if(typeof override==='boolean')return override;
 const saved=(await readDirectorSettings())._decisionPreferences?.visionEnabled;
 return resolveVisionSetting({saved,environment:(await configuration()).MAD_WINNOW_VISION_ENABLED});
}
