import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const catalog=fileURLToPath(new URL('./.local/catalog-v2/',import.meta.url));
export async function expectedCatalogEpisodes(directory=catalog){
 let manifest;
 try{manifest=JSON.parse(await readFile(path.join(directory,'input-manifest.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const episodes=manifest?manifest.videos?.map(v=>v.episode):(await readdir(directory)).filter(n=>/^episode-\d+$/.test(n)).map(n=>Number(n.slice(8)));
 if(!episodes?.length||episodes.some(n=>!Number.isInteger(n)||n<1)||new Set(episodes).size!==episodes.length)throw Error('先准备有效的素材清单和本地目录');
 return episodes.sort((a,b)=>a-b);
}
export async function readyCatalogSources(directory=catalog){
 const episodes=await expectedCatalogEpisodes(directory),sources=[];
 for(const ep of episodes){
  const dir=path.join(directory,'episode-'+String(ep).padStart(2,'0'));
  const prepared=JSON.parse(await readFile(path.join(dir,'source.json'),'utf8'));
  const enriched=JSON.parse(await readFile(path.join(dir,'enriched.json'),'utf8'));
  if(prepared.episode!==ep||enriched.episode!==ep||prepared.thumbVersion!==2||enriched.id!==prepared.id||enriched.sourceSha256!==prepared.sourceSha256||enriched.semanticStatus!=='complete'||!enriched.shots?.length||enriched.shots.some(s=>s.semanticStatus!=='complete'))throw Error(`素材 ${ep} 的镜头证据或语义尚未完整，不能发布索引`);
  sources.push(enriched);
 }
 if(new Set(sources.map(s=>s.id)).size!==sources.length)throw Error('清单包含内容相同的重复视频，请去重后处理');
 return sources;
}
