import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile,root} from './catalog.mjs';

export async function refineCandidates(sources,shots){
  const directory=path.join(root,'.local/cut-safety-v1');await mkdir(directory,{recursive:true});const runId=randomUUID();
  const manifest=path.join(directory,runId+'-input.json'),output=path.join(directory,runId+'-output.json');
  const ids=new Set(shots.map(s=>s.id));
  await writeFile(manifest,JSON.stringify({sources:sources.map(s=>({id:s.id,episode:s.episode,original:s.original,dir:s.dir,fps:s.fps,duration:s.duration,shots:s.shots.filter(shot=>ids.has(shot.id))})).filter(s=>s.shots.length)}));
  await execFile((process.env.MAD_PYTHON||path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python')),['scripts/refine_safe_ranges.py',manifest,output]);
  const result=JSON.parse(await readFile(output,'utf8'));
  return {shots:shots.map(s=>({...s,...result.shots[s.id]})).filter(s=>s.safeRanges?.length),audit:{scanned:result.count,withInternalCuts:result.withInternalCuts,rejected:result.withNoSafeRange}};
}
