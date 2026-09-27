"""Read-only source snapshot export, with conflict detection on the release side."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from release_adapt import adapt

ROOT=Path(__file__).resolve().parents[1]
POLICY=json.loads((ROOT/'tools/export-policy.json').read_text(encoding='utf-8'))
DENY_PARTS={'.git','.local','.venv','node_modules','localdevenv','__pycache__','.mad-workspace','.mad-state','artifacts','dist','coverage','.claude','.codex'}
DENY_EXT={'.mp4','.mkv','.mov','.mp3','.m4a','.wav','.srt','.ass','.vtt','.gguf','.onnx','.pth','.pt','.safetensors','.bin','.npy','.f32','.torrent','.zip','.log','.pyc'}
def digest(data): return hashlib.sha256(data).hexdigest()
def permitted(rel):
    if Path(rel).as_posix() in POLICY.get('backendPublicMedia',[]): return True
    p=Path(rel)
    return not any(part in DENY_PARTS or part.startswith('.venv') for part in p.parts) and p.suffix.lower() not in DENY_EXT and not p.name.startswith('.env')
def destination(root, rel):
    if Path(rel).is_absolute() or '..' in Path(rel).parts: raise ValueError('Unsafe export path')
    root=Path(root).resolve();target=root/rel
    for part in [target,*target.parents]:
        if part==root: break
        if part.is_symlink(): raise ValueError('Symlink destination is not allowed: '+rel)
    target.resolve().relative_to(root)
    return target
def inventory(backend,editor):
    result={}
    candidates=list(backend.glob('*.mjs'))+[backend/'package.json',backend/'requirements.txt']+list((backend/'tests').rglob('*'))
    candidates += [backend/'scripts'/name for name in POLICY['backendScripts']]
    candidates += [backend/name for name in ['docs/STUDIO_TECHNIQUES.md','vendor/transnetv2/LICENSE','vendor/transnetv2/ORIGIN.md','vendor/transnetv2/transnetv2_pytorch.py']]
    for p in candidates:
        if not p.is_file(): continue
        rel=p.relative_to(backend).as_posix()
        if permitted(rel): result['apps/backend/'+rel]=('backend',rel,p)
    for source_tree,target_tree in POLICY.get('backendPublicTrees',{}).items():
        for p in (backend/source_tree).rglob('*'):
            if not p.is_file():continue
            rel=p.relative_to(backend).as_posix()
            if permitted(rel):result[target_tree+'/'+p.relative_to(backend/source_tree).as_posix()]=('backend',rel,p)
    paths=subprocess.check_output(['git','-C',str(editor),'ls-files','--cached','--others','--exclude-standard','-z']).decode('utf-8').split('\0')
    for rel in paths:
        if not rel or not permitted(rel): continue
        keep=rel in POLICY['editorRootFiles'] or any(rel.startswith(t+'/') for t in POLICY['editorTrees'])
        if not keep or any(rel.startswith(t+'/') for t in POLICY['editorSkipTrees']): continue
        p=editor/rel
        if not p.is_file(): continue
        name='README.upstream.md' if rel=='README.md' else rel
        result['apps/editor/'+name]=('editor',rel,p)
    return result
def capture(backend,editor,only=None):
    for attempt in range(3):
        paths=scoped_inputs(inventory(backend,editor),{},only)[0];snapshot={}
        for dest,(origin,rel,p) in sorted(paths.items()):
            if p.is_symlink(): raise ValueError('Source symlink rejected: '+rel)
            if p.stat().st_size>POLICY['maxFileBytes']: raise ValueError('Oversized source file: '+rel)
            raw=p.read_bytes();data=adapt(dest,raw)
            snapshot[dest]=({'origin':origin,'sourcePath':rel,'sourceHash':digest(raw),'exportedHash':digest(data)},data)
        current=scoped_inputs(inventory(backend,editor),{},only)[0]
        if current.keys()==paths.keys() and all(digest(p.read_bytes())==snapshot[dest][0]['sourceHash'] for dest,(_,__,p) in current.items()): return snapshot
        time.sleep(.2)
    raise RuntimeError('Source kept changing during snapshot; nothing exported. Keep developing and retry later.')
def changes(snapshot,baseline,root=ROOT):
    actions=[];conflicts=[];kept=[]
    for name in sorted(set(snapshot)|set(baseline)):
        target=destination(root,name);old=baseline.get(name);current=digest(target.read_bytes()) if target.is_file() else None;incoming=snapshot.get(name)
        if incoming:
            meta,data=incoming;new=meta['exportedHash']
            if current==new: continue
            if old and new==old['exportedHash']: kept.append(name);continue
            if old and current==old['exportedHash'] or not old and current is None: actions.append((name,data))
            else: conflicts.append(name)
        elif old:
            if current is None: continue
            if current==old['exportedHash']: actions.append((name,None))
            else: conflicts.append(name)
    return actions,conflicts,kept
def scoped_inputs(snapshot,baseline,prefix):
    if not prefix:return snapshot,baseline
    if Path(prefix).is_absolute() or '..' in Path(prefix).parts:raise ValueError('Unsafe sync scope')
    prefix=Path(prefix).as_posix().rstrip('/')
    if prefix in ['', '.']:raise ValueError('Use an explicit destination directory')
    include=lambda name:name==prefix or name.startswith(prefix+'/')
    return ({k:v for k,v in snapshot.items() if include(k)},{k:v for k,v in baseline.items() if include(k)})
def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--backend');parser.add_argument('--editor');parser.add_argument('--apply',action='store_true');parser.add_argument('--snapshot',help='Retained local snapshot ID to replay');parser.add_argument('--only',help='Only sync this destination path prefix');args=parser.parse_args()
    state=ROOT/'.sync';state.mkdir(exist_ok=True);config_file=state/'local.json';config=json.loads(config_file.read_text()) if config_file.exists() else {}
    if args.backend: config['backend']=str(Path(args.backend).resolve())
    if args.editor: config['editor']=str(Path(args.editor).resolve())
    if args.snapshot:
        if not args.snapshot.replace('-','').isalnum(): raise ValueError('Invalid snapshot id')
        folder=destination(state/'snapshots',args.snapshot);meta=json.loads((folder/'manifest.json').read_text())
        if meta.get('format')==2:
            saved_scope=meta.get('scope')
            if saved_scope and args.only and args.only!=saved_scope:raise ValueError('Cannot change a scoped snapshot scope')
            args.only=args.only or saved_scope;meta=meta['files']
        snapshot={k:(v,(folder/'files'/k).read_bytes()) for k,v in meta.items()};stamp=args.snapshot
    else:
        if not all(config.get(k) for k in ['backend','editor']): parser.error('Pass --backend and --editor once; local paths are ignored by Git')
        for value in config.values():
            if Path(value).resolve()==ROOT or ROOT in Path(value).resolve().parents:raise ValueError('Live source directories must be outside the release repository')
        config_file.write_text(json.dumps(config,indent=2),encoding='utf-8');snapshot=capture(Path(config['backend']),Path(config['editor']),args.only);stamp=time.strftime('%Y%m%d-%H%M%S')+'-'+str(time.time_ns()%1000000);folder=state/'snapshots'/stamp;folder.mkdir(parents=True)
        for name,(_,data) in snapshot.items(): p=destination(folder/'files',name);p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data)
        (folder/'manifest.json').write_text(json.dumps({'format':2,'scope':args.only,'files':{k:v[0] for k,v in snapshot.items()}},indent=2),encoding='utf-8')
    manifest=ROOT/'release-manifest.json';old=json.loads(manifest.read_text())['files'] if manifest.exists() else {};snapshot,scoped_old=scoped_inputs(snapshot,old,args.only);actions,conflicts,kept=changes(snapshot,scoped_old)
    report={'snapshot':stamp,'files':len(snapshot),'updates':sum(d is not None for _,d in actions),'updatedPaths':[n for n,d in actions if d is not None],'removals':sum(d is None for _,d in actions),'releaseEditsKept':kept,'conflicts':conflicts,'applied':False}
    if conflicts:
        for name in conflicts:
            if name in snapshot:p=destination(state/'conflicts',name+'.incoming');p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(snapshot[name][1])
    elif args.apply:
        for name,data in actions:
            p=destination(ROOT,name)
            if data is None:p.unlink()
            else:p.parent.mkdir(parents=True,exist_ok=True);tmp=p.with_name(p.name+'.sync-tmp');tmp.write_bytes(data);os.replace(tmp,p)
        meta={k:v for k,v in old.items() if k not in scoped_old} if args.only else {}
        meta.update({k:v[0] for k,v in snapshot.items()})
        for name in kept:
            if name in old:meta[name]=old[name]
        if meta!=old or not manifest.exists(): manifest.write_text(json.dumps({'format':1,'snapshot':stamp,'files':meta},indent=2),encoding='utf-8')
        report['applied']=True
    (state/'last-report.json').write_text(json.dumps(report,indent=2),encoding='utf-8');print(json.dumps(report,ensure_ascii=False,indent=2))
    if conflicts:return 2
    return 0
if __name__=='__main__':sys.exit(main())
