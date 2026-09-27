"""Conservative, cached candidate-shot QA at native fps, using a second detector.

TransNetV2 transition bands + PySceneDetect AdaptiveDetector are exclusion zones.
This does not relabel or pretend inherited parent semantics are fresh annotations.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
from pathlib import Path
import subprocess
import sys
import uuid
import numpy as np
from PIL import Image
from scenedetect import FrameTimecode, StatsManager
from scenedetect.detectors import AdaptiveDetector

ROOT=Path(__file__).resolve().parents[1]
CACHE=ROOT/'.local/cut-safety-v1'

def exclusion_ranges(start,end,forbidden,guard=2,min_frames=6):
    valid=np.ones(end-start,dtype=bool)
    valid[:guard+1]=False;valid[-guard-1:]=False
    for frame in forbidden:
        low=max(start,frame-guard);high=min(end,frame+guard+1)
        if high>low:valid[low-start:high-start]=False
    edges=np.flatnonzero(np.diff(np.r_[False,valid,False].astype(np.int8)))
    return [(start+int(a),start+int(b)) for a,b in zip(edges[::2],edges[1::2]) if b-a>=min_frames]

def refine(source,shot,pts,probability):
    cache=CACHE/(shot['id']+'.json');CACHE.mkdir(parents=True,exist_ok=True)
    if cache.exists():
        try:return json.loads(cache.read_text(encoding='utf-8'))
        except json.JSONDecodeError:pass
    fps=float(source['fps'].split('/')[0])/float(source['fps'].split('/')[1])
    sf,ef=shot['startFrame'],shot['endFrame'];base=max(0,sf-5);finish=min(len(pts),ef+5)
    start=max(0,float(pts[base])-.002);end=float(pts[finish]) if finish<len(pts) else source['duration']
    command=['ffmpeg','-v','error','-threads','2','-ss',str(start),'-i',source['original'],'-t',str(end-start),'-an','-vf','scale=320:180','-fps_mode','passthrough','-pix_fmt','bgr24','-f','rawvideo','pipe:1']
    run=subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if run.returncode:raise RuntimeError(run.stderr.decode(errors='replace')[-1000:])
    frames=np.frombuffer(run.stdout,dtype=np.uint8).reshape(-1,180,320,3)
    if len(frames)<ef-base:raise ValueError(f"Not enough decoded frames for {shot['id']}")
    detector=AdaptiveDetector(adaptive_threshold=3,min_scene_len=2,window_width=2,min_content_val=20)
    stats=StatsManager();detector.stats_manager=stats;cuts=[]
    for i,frame in enumerate(frames):cuts.extend(base+c.get_frames() for c in detector.process_frame(FrameTimecode(i,fps),frame))
    neural=np.flatnonzero(probability[max(0,sf-2):min(len(pts),ef+2)]>=.12)+max(0,sf-2)
    banned=sorted(set(neural.tolist()+cuts));ranges=[]
    folder=Path(source['dir'])/'safe-shots-v1';folder.mkdir(exist_ok=True)
    for a,b in exclusion_ranges(sf,ef,banned):
        sample=frames[a-base:b-base]
        delta=np.mean(np.abs(np.diff(sample.astype(np.int16),axis=0)),axis=(1,2,3))
        peak=a+1+int(np.argmax(delta)) if len(delta) else a
        frame_ids=[a,(a+b-1)//2,b-1];sheet=Image.new('RGB',(960,180))
        for i,index in enumerate(frame_ids):sheet.paste(Image.fromarray(frames[index-base,:,:,::-1]),(320*i,0))
        filename=f"{shot['id']}-{a}-{b}.jpg";sheet.save(folder/filename,quality=84)
        ranges.append({'start':float(pts[a]),'end':float(pts[b]) if b<len(pts) else source['duration'],
          'startFrame':a,'endFrame':b,'anchor':float(pts[peak]),'thumb':f'safe-shots-v1/{filename}',
          'evidenceFrames':frame_ids,'guardFrames':2,'method':'TransNet bands >=0.12 + native-fps AdaptiveDetector 320x180; conservative exclusion'})
    result={'id':shot['id'],'safeRanges':ranges,'internalAdaptiveCuts':[{'frame':f,'time':float(pts[f])} for f in cuts if sf<f<ef],
      'internalNeuralFrames':[int(f) for f in neural if sf<f<ef],'parentShotId':shot['id'],'semantics':'inherited; verified images represent each clean range',
      'fps':fps,'version':1}
    temp=cache.with_suffix('.'+uuid.uuid4().hex+'.tmp.json');temp.write_text(json.dumps(result,ensure_ascii=False),encoding='utf-8');temp.replace(cache);return result

def main(manifest,output):
    payload=json.loads(Path(manifest).read_text(encoding='utf-8'));work=[]
    for source in payload['sources']:
        folder=ROOT/f".local/catalog-v2/episode-{source['episode']:02d}"
        pts=np.load(folder/'frame-times.npy');probs=np.load(folder/'transition-probabilities.npy')
        work.extend((source,s,pts,probs) for s in source['shots'])
    results=[]
    with ThreadPoolExecutor(max_workers=4) as pool:
        jobs=[pool.submit(refine,*args) for args in work]
        for i,job in enumerate(as_completed(jobs)):
            results.append(job.result())
            if (i+1)%20==0:print(json.dumps({'completed':i+1,'total':len(jobs)}),flush=True)
    output=Path(output);output.parent.mkdir(parents=True,exist_ok=True)
    result={'shots':{r['id']:r for r in results},'count':len(results),'withInternalCuts':sum(bool(r['internalAdaptiveCuts']) for r in results),'withNoSafeRange':sum(not r['safeRanges'] for r in results)}
    output.write_text(json.dumps(result,ensure_ascii=False),encoding='utf-8');print(json.dumps({k:v for k,v in result.items() if k!='shots'}),flush=True)

if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8');parser=argparse.ArgumentParser();parser.add_argument('manifest');parser.add_argument('output');args=parser.parse_args();main(args.manifest,args.output)
