"""Find repeated animated sequences at episode edges without guessing fixed OP/ED times."""
import json
from pathlib import Path
import cv2
import numpy as np

ROOT=Path(__file__).resolve().parents[1]
def phash(frame):
    gray=cv2.cvtColor(frame,cv2.COLOR_RGB2GRAY)
    block=cv2.dct(cv2.resize(gray,(32,32)).astype(np.float32))[:8,:8].reshape(-1)
    bits=block>np.median(block[1:]);bits[0]=False
    return np.packbits(bits).view(np.uint64)[0],bool(gray.std()>12)

def main():
    sources=[]
    for directory in sorted((ROOT/'.local/catalog-v2').glob('episode-*')):
        source=json.loads((directory/'source.json').read_text(encoding='utf-8'))
        pts=np.load(directory/'frame-times.npy');frames=np.memmap(directory/'transnet-rgb.bin',dtype=np.uint8,mode='r',shape=(len(pts),27,48,3))
        groups={}
        for name,times in [('head',np.arange(0,180)),('tail',source['duration']-np.arange(180,0,-1))]:
            indices=np.clip(np.searchsorted(pts,times),0,len(pts)-1);values=[phash(frames[i]) for i in indices]
            groups[name]={'times':times,'hash':np.array([v[0] for v in values],dtype=np.uint64),'valid':np.array([v[1] for v in values])}
        sources.append({'source':source,'groups':groups})
    result={}
    for i,item in enumerate(sources):
        intervals=[]
        for name,group in item['groups'].items():
            votes=np.zeros(len(group['times']),dtype=np.int32)
            for j,other in enumerate(sources):
                if i==j:continue
                best=np.full(len(votes),65,dtype=np.int32);other=other['groups'][name]
                for shift in [-1,0,1]:
                    indices=np.clip(np.arange(len(votes))+shift,0,len(votes)-1)
                    distance=np.bitwise_count(np.bitwise_xor(group['hash'],other['hash'][indices])).astype(np.int32)
                    distance[~other['valid'][indices]]=65;best=np.minimum(best,distance)
                votes+=(best<=6)&group['valid']
            mask=votes>=2
            # Close at most two missing samples, then require a sustained sequence.
            for k in range(2,len(mask)-2):
                if not mask[k] and mask[max(0,k-2):k].any() and mask[k+1:k+3].any():mask[k]=True
            changes=np.flatnonzero(np.diff(np.r_[False,mask,False].astype(np.int8)))
            for a,b in zip(changes[::2],changes[1::2]):
                if b-a>=7:intervals.append({'start':max(0,float(group['times'][a])-2),'end':min(item['source']['duration'],float(group['times'][b-1])+3),'evidence':'same relative edge sequence in >=3 episodes; perceptual hash; 1 fps','region':name})
        result[item['source']['id']]={'episode':item['source']['episode'],'intervals':intervals}
    file=ROOT/'.local/catalog-v2/repeated-sequences.json';file.write_text(json.dumps({'version':1,'sources':result},ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps([{'episode':v['episode'],'intervals':v['intervals']} for v in result.values()],ensure_ascii=False))

if __name__=='__main__':main()
