import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const manifest=fileURLToPath(new URL('./.local/catalog-v2/input-manifest.json',import.meta.url));
export function expectedSourceCount(library){
  if(process.env.JEV_EXPECTED_SOURCES)return Math.max(1,Number(process.env.JEV_EXPECTED_SOURCES));
  try{return Math.max(1,JSON.parse(readFileSync(manifest,'utf8')).videos.length);}catch{return Math.max(1,library.sources?.length||1);}
}
export function emptyProject(){
  const now=Date.now();return {id:'mad-main',name:'jev剪辑 · 新工程',description:'',duration:0,createdAt:now,updatedAt:now,metadata:{width:960,height:540,fps:30},timeline:{tracks:[['text-pv','字幕','video'],['picture','画面','video'],['source-audio','原声','audio'],['music','配乐','audio']].map(([id,name,kind],order)=>({id,name,kind,order,height:64,locked:false,visible:true,muted:false,solo:false,syncLock:true})),items:[],transitions:[],keyframes:[],compositions:[],currentFrame:0,masterBusDb:0}};
}
