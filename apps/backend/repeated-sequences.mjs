import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {root,catalogRoot,execFile} from './catalog.mjs';

export async function removeRepeatedSequences(sources){
  const file=path.join(catalogRoot,'repeated-sequences.json');let metadata;
  try{metadata=JSON.parse(await readFile(file,'utf8'));}catch{await execFile((process.env.MAD_PYTHON||path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python')),['scripts/find_repeated_sequences.py']);metadata=JSON.parse(await readFile(file,'utf8'));}
  return filterRepeatedSequences(sources,metadata);
}

export function filterRepeatedSequences(sources,metadata){
  let excluded=0;
  const cleaned=sources.map(source=>{
    const sceneIntervals=(source.scenes||[]).filter(scene=>/片头(?:曲|OP|动画|序列)|片尾.*(?:ED|动画|序列|演出|名单|曲)|\bcredits\b/i.test(scene.narrative_role+' '+scene.summary)).map(scene=>({start:scene.start,end:scene.end}));
    const intervals=[...(metadata.sources[source.id]?.intervals||[]),...sceneIntervals];
    return {...source,shots:source.shots.map(shot=>{
      const composite=(shot.semantic?.uncertainties||[]).some(text=>/镜头内部.*(?:抽帧|切换)|包含多个.*切镜/.test(text));
      const bands=intervals.map(r=>({start:Math.max(r.start,shot.start),end:Math.min(r.end,shot.end)})).filter(r=>r.end>r.start).sort((a,b)=>a.start-b.start);
      const merged=[];for(const band of bands){const last=merged.at(-1);if(last&&band.start<=last.end)last.end=Math.max(last.end,band.end);else merged.push({...band});}
      // Only an entirely repeated OP/ED range is removed from default selection.
      // A partial overlap stays in the corpus: its overlap is an exclusion band.
      const coverage=merged.reduce((n,r)=>n+r.end-r.start,0),repeated=coverage>=shot.end-shot.start-1e-6;
      if(repeated)excluded++;
      return {...shot,excluded:repeated,repeatedSequence:repeated,exclusionReason:repeated?'repeated-opening-ending':null,repeatedBands:merged,
        needsBoundaryReview:composite,qualityFlags:{creditsOrLogo:!!shot.semantic?.credits_or_logo,lowQuality:(shot.semantic?.usable_quality??1)<.3},legacyExcluded:shot.legacyExcluded??!!shot.excluded};
    })};
  });return {sources:cleaned,excluded};
}
