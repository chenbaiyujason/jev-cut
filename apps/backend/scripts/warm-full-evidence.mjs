import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {globalResources,prepareGlobalShots} from '../global-evidence.mjs';
import {rebuildCorpusCache} from '../corpus-cache.mjs';
const library=JSON.parse(await readFile('.local/library.json','utf8')),resources=await globalResources(),shots=resources.shots.filter(s=>!s.excluded),started=performance.now(),errors=[];
await mkdir('.local/global-benchmark',{recursive:true});
for(let from=0;from<shots.length;from+=32){const batch=shots.slice(from,from+32);try{await prepareGlobalShots(batch.map(s=>s.id),library,resources);}catch(e){errors.push({shots:batch.map(s=>s.id),error:e.message});}const status={done:Math.min(from+32,shots.length),total:shots.length,seconds:(performance.now()-started)/1000,errors:errors.length};await writeFile('.local/global-benchmark/cache-warm-status.json',JSON.stringify(status));if(from%256===0)console.log(JSON.stringify(status));}
await rebuildCorpusCache();await writeFile('.local/global-benchmark/cache-warm-errors.json',JSON.stringify(errors,null,2));console.log(JSON.stringify({complete:true,seconds:(performance.now()-started)/1000,errors:errors.length}));
