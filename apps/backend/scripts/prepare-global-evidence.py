"""Cached native-frame motion and exact decision-window images; never changes the corpus scope."""
import json,sys,uuid
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import cv2
import numpy as np
from PIL import Image
root=Path(__file__).resolve().parents[1]
cache=root/'.local/director-motion-v1';cache.mkdir(exist_ok=True)
from refine_safe_ranges import refine
from functools import lru_cache
@lru_cache(maxsize=16)
def boundary_arrays(episode):
    folder=root/f'.local/catalog-v2/episode-{episode:02d}'
    return np.load(folder/'frame-times.npy'),np.load(folder/'transition-probabilities.npy')
def prepare(task):
    if task.get('kind')=='safety':
        pts,probabilities=boundary_arrays(task['source']['episode'])
        refine(task['source'],task['shot'],pts,probabilities)
        return
    file=Path(task['output']) if task.get('output') else cache/(task['id']+'.json')
    if file.exists():return
    cap=cv2.VideoCapture(task['video'])
    try:
        if task.get('frames'):
            sheet=Image.new('RGB',(960,180))
            for n,f in enumerate(task['frames']):
                cap.set(cv2.CAP_PROP_POS_FRAMES,f);ok,image=cap.read()
                if not ok:raise ValueError('Cannot read evidence frame '+str(f))
                sheet.paste(Image.fromarray(cv2.cvtColor(cv2.resize(image,(320,180)),cv2.COLOR_BGR2RGB)),(320*n,0))
            file.parent.mkdir(parents=True,exist_ok=True);tmp=file.with_suffix('.'+uuid.uuid4().hex+'.tmp.jpg');sheet.save(tmp,quality=86);tmp.replace(file)
        else:
            ranges=[]
            for r in task['ranges']:
                cap.set(cv2.CAP_PROP_POS_FRAMES,r['startFrame']);gray=[]
                for _ in range(r['endFrame']-r['startFrame']):
                    ok,image=cap.read()
                    if not ok:raise ValueError('Incomplete source '+task['id'])
                    gray.append(cv2.resize(cv2.cvtColor(image,cv2.COLOR_BGR2GRAY),(160,90)).astype(np.float32))
                delta=[0]+[round(float(np.abs(b-a).mean()),3) for a,b in zip(gray,gray[1:])]
                ranges.append({**r,'delta':delta,'brightness':[round(float(x.mean()),2) for x in gray],'detail':[round(float(x.std()),2) for x in gray]})
            tmp=file.with_suffix('.'+uuid.uuid4().hex+'.tmp.json');tmp.write_text(json.dumps({'id':task['id'],'ranges':ranges}),encoding='utf-8');tmp.replace(file)
    finally:cap.release()
if len(sys.argv)>1 and sys.argv[1]=='--worker':
    for line in sys.stdin:
        try:
            request=json.loads(line)
            with ThreadPoolExecutor(max_workers=4) as executor:list(executor.map(prepare,request['tasks']))
            print(json.dumps({'id':request['id'],'ok':True}),flush=True)
        except Exception as e:print(json.dumps({'id':request.get('id'),'error':str(e)}),flush=True)
else:
    request=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    with ThreadPoolExecutor(max_workers=4) as executor:list(executor.map(prepare,request['tasks']))
