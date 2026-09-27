"""Full-frame-rate TransNetV2 inference with bounded 100-frame windows."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time
import numpy as np
import torch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'vendor'/'transnetv2'))
from transnetv2_pytorch import TransNetV2


def output(value):
    print(json.dumps(value,ensure_ascii=False),flush=True)


def run(file,out,threshold=.5,batch_size=4):
    started=time.monotonic();out.mkdir(parents=True,exist_ok=True)
    probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_entries',
        'stream=avg_frame_rate,r_frame_rate,width,height:format=duration','-of','json',str(file)]))
    s=probe['streams'][0];num,den=map(int,s['avg_frame_rate'].split('/'));fps=num/den
    rnum,rden=map(int,s['r_frame_rate'].split('/'))
    if abs(fps-rnum/rden)>.05:raise ValueError('VFR source requires timestamp mapping; cannot use frame/fps')
    raw=out/'transnet-rgb.bin'
    pts_file=out/'frame-times.npy'
    if not raw.exists() or not pts_file.exists():
        output({'stage':'按原帧率解码镜头检测输入','progress':.02})
        log_path=out/'decode-timestamps.log'
        command=['ffmpeg','-hide_banner','-v','info','-y','-hwaccel','cuda','-threads','4','-i',str(file),'-map','0:v:0',
            '-vf','scale=48:27,showinfo','-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo',str(raw)]
        with log_path.open('wb') as log:
            process=subprocess.run(command,stdout=subprocess.DEVNULL,stderr=log)
        if process.returncode:
            command.remove('-hwaccel');command.remove('cuda')
            with log_path.open('wb') as log:subprocess.run(command,stdout=subprocess.DEVNULL,stderr=log,check=True)
        import re
        pts=np.array([float(x) for x in re.findall(r'\bn:\s*\d+.*?pts_time:([0-9.]+)',log_path.read_text(encoding='utf-8',errors='replace'))],dtype=np.float64)
        np.save(pts_file,pts)
    count=raw.stat().st_size//(27*48*3)
    frames=np.memmap(raw,dtype=np.uint8,mode='r',shape=(count,27,48,3))
    pts=np.load(pts_file)
    if len(pts)!=count or np.any(np.diff(pts)<=0):raise ValueError('Frame timestamp count/order mismatch')
    media_end=float(pts[-1]+np.median(np.diff(pts)))
    weights=ROOT/'.local/models/transnetv2/weights.pth'
    if hashlib.sha256(weights.read_bytes()).hexdigest()!='46520d66d4bf60414a4d82e0e94a92442ff950e34517a3718b2e54815e642b53':raise ValueError('Unexpected TransNetV2 weights checksum')
    device='cuda' if torch.cuda.is_available() else 'cpu'
    torch.set_num_threads(4)
    model=TransNetV2();model.load_state_dict(torch.load(weights,map_location='cpu',weights_only=True));model.eval().to(device)
    predictions=np.zeros(count,dtype=np.float32);last_report=0
    with torch.inference_mode():
        for base in range(0,count,50*batch_size):
            positions=list(range(base,min(count,base+50*batch_size),50))
            batch=np.stack([frames[np.clip(np.arange(p-25,p+75),0,count-1)] for p in positions])
            logits,_=model(torch.from_numpy(batch).to(device))
            probs=torch.sigmoid(logits).cpu().numpy()[:,:,0]
            for row,p in enumerate(positions):predictions[p:min(p+50,count)]=probs[row,25:25+min(50,count-p)]
            if time.monotonic()-last_report>10:
                output({'stage':'TransNetV2 检测镜头边界','progress':round(base/max(1,count),4),'frames':base,'totalFrames':count});last_report=time.monotonic()
    np.save(out/'transition-probabilities.npy',predictions)
    transitions=[];i=0
    while i<count:
        if predictions[i]<threshold:i+=1;continue
        j=i+1
        while j<count and predictions[j]>=threshold:j+=1
        peak=i+int(np.argmax(predictions[i:j]));transitions.append({'frame':peak,'startFrame':i,'endFrame':j,'probability':float(predictions[peak])});i=j
    # Keep the learned transition peak as boundary; no arbitrary 12-second splitting.
    cut_frames=sorted(set([0,count]+[t['frame'] for t in transitions if 0<t['frame']<count]))
    shots=[{'startFrame':a,'endFrame':b,'start':float(pts[a]),'end':float(pts[b]) if b<count else media_end} for a,b in zip(cut_frames,cut_frames[1:]) if b>a]
    result={'detector':'TransNetV2','codeRevision':'85cef72af9a916bdfd7cc94a670c9cdfbf12d1ed','threshold':threshold,
        'fps':fps,'frameRate':s['avg_frame_rate'],'frameCount':count,'duration':media_end,'containerDuration':float(probe['format']['duration']),
        'shots':shots,'transitions':transitions,'elapsedSeconds':time.monotonic()-started,'device':device}
    (out/'boundaries.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    output({'stage':'镜头检测完成','progress':1,'shots':len(shots),'elapsedSeconds':result['elapsedSeconds']})


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8');p=argparse.ArgumentParser();p.add_argument('file',type=Path);p.add_argument('output',type=Path);p.add_argument('--threshold',type=float,default=.5);args=p.parse_args();run(args.file,args.output,args.threshold)
