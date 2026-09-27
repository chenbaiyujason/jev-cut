"""Extract exact in-shot frames in one decode pass, avoiding fixed-FPS thumbnail leakage."""
import json
from pathlib import Path
import subprocess
import sys
import time
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
BASE=ROOT/'.local/catalog-v2'

def write(path,obj):
    tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(obj,ensure_ascii=False,indent=2),encoding='utf-8');tmp.replace(path)

def refine(file):
    source=json.loads(file.read_text(encoding='utf-8'));folder=file.parent
    if source.get('thumbVersion')!=2:
        desired=[];by_shot={}
        for shot in source['shots']:
            a,b=shot['startFrame'],shot['endFrame'];pad=min(3,max(0,(b-a-1)//3))
            indices=[a+pad,(a+b-1)//2,b-1-pad];by_shot[shot['id']]=indices;desired.extend(indices)
        frames=sorted(set(desired));mapping={n:i+1 for i,n in enumerate(frames)}
        samples=folder/'exact-frames';samples.mkdir(exist_ok=True)
        script=folder/'select-frames.txt';script.write_text("select='"+'+'.join(f'eq(n,{n})' for n in frames)+"',scale=256:144",encoding='utf-8')
        command=['ffmpeg','-hide_banner','-v','error','-y','-threads','4','-i',str(Path(source['dir'])/'preview.mp4'),'-an','-filter_script:v',str(script),'-fps_mode','vfr','-q:v','4',str(samples/'%06d.jpg')]
        subprocess.run(command,check=True)
        for shot in source['shots']:
            sheet=Image.new('RGB',(768,144))
            for i,n in enumerate(by_shot[shot['id']]):
                with Image.open(samples/f'{mapping[n]:06d}.jpg') as image:sheet.paste(image,(i*256,0))
            sheet.save(Path(source['dir'])/shot['thumb'],quality=86)
            shot['evidenceFrames']=by_shot[shot['id']]
        source['thumbVersion']=2;source['thumbnailSampling']='three exact frame indices strictly inside detected shot'
        write(file,source)
        print(json.dumps({'episode':source['episode'],'exactFrames':len(frames),'shots':len(source['shots'])}),flush=True)

if __name__=='__main__':
    watch='--watch' in sys.argv
    while True:
        files=sorted(BASE.glob('episode-*/source.json'))
        for file in files:refine(file)
        finished=sum(1 for f in BASE.glob('episode-*/source.json') if json.loads(f.read_text(encoding='utf-8')).get('thumbVersion')==2)
        if not watch or finished>=11:break
        time.sleep(5)
