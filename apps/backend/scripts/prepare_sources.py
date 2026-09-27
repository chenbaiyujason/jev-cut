"""Prepare any explicit source manifest without a fixed series or episode count."""
import argparse
import json
import hashlib
import os
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[1]
def load_manifest(file):
    file=Path(file).resolve();data=json.loads(file.read_text(encoding='utf-8-sig'));ids=set()
    if not isinstance(data.get('videos'),list) or not data['videos']:raise ValueError('manifest.videos must be nonempty')
    for item in data['videos']:
        episode=item['episode']
        if not isinstance(episode,int) or episode<1 or episode in ids:raise ValueError('episode must be a unique positive integer')
        ids.add(episode)
        for key in ['file','subtitle']:
            if item.get(key):
                p=(file.parent/item[key]).resolve()
                if not p.is_file():raise ValueError(f'Missing {key} for source {episode}: {p}')
                item[key]=str(p)
    return data
def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--manifest',required=True);p.add_argument('--dry-run',action='store_true');args=p.parse_args();manifest=load_manifest(args.manifest)
    if args.dry_run:print(json.dumps({'valid':True,'sources':len(manifest['videos'])}));return
    import catalog_preprocess as preprocess
    cfg=dict(os.environ);file=ROOT/'localdevenv/.env'
    if file.exists():
        for line in file.read_text(encoding='utf-8-sig').splitlines():
            if '=' in line and not line.lstrip().startswith('#'):k,v=line.split('=',1);cfg[k.strip()]=v.strip()
    if not cfg.get('MAD_VISION_PYTHON'):cfg['MAD_VISION_PYTHON']=sys.executable
    cfg['JEV_COLLECTION']=manifest.get('collection','User supplied footage')
    folder=ROOT/'.local/catalog-v2';folder.mkdir(parents=True,exist_ok=True)
    (folder/'input-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    for item in manifest['videos']:
        existing=folder/f"episode-{item['episode']:02d}"/'source.json'
        if existing.exists():
            previous=json.loads(existing.read_text(encoding='utf-8'))
            with open(item['file'],'rb') as stream:actual=hashlib.file_digest(stream,'sha256').hexdigest()
            if previous.get('sourceSha256')!=actual:raise ValueError('This episode ID already caches another video. Use a new ID or explicitly rebuild only that episode.')
        local={**cfg,'JEV_SUBTITLE_LANGUAGE':item.get('language','und')}
        if item.get('subtitle'):local['JEV_SUBTITLE']=item['subtitle']
        preprocess.process(Path(item['file']),local,item['episode'],len(manifest['videos']))
if __name__=='__main__':main()
