"""Resumable full-series pre-processing. No semantic labels are guessed locally."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import numpy as np
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'.local/catalog-v2'


def env():
    data={}
    for line in (ROOT/'localdevenv/.env').read_text(encoding='utf-8-sig').splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            k,v=line.split('=',1);data[k.strip()]=v.strip()
    return data


def status(stage,**data):
    payload={'at':time.time(),'stage':stage,**data}
    OUT.mkdir(parents=True,exist_ok=True)
    (OUT/'preprocess-status.json').write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(payload,ensure_ascii=False),flush=True)


def ffmpeg(args):
    p=subprocess.run(['ffmpeg','-hide_banner','-v','error','-y',*map(str,args)],capture_output=True)
    if p.returncode:raise RuntimeError(p.stderr.decode('utf-8',errors='replace')[-2000:])


def subtitles(text,duration):
    def timestamp(t):
        h,m,s=t.replace(',','.').split(':');return int(h)*3600+int(m)*60+float(s)
    cues=[];invalid=[]
    for block in re.split(r'\r?\n\s*\r?\n',text.strip()):
        lines=block.splitlines();idx=next((i for i,v in enumerate(lines) if '-->' in v),-1)
        if idx<0:continue
        a,b=[timestamp(v.strip().split()[0]) for v in lines[idx].split('-->')]
        value=re.sub(r'<[^>]*>|\{[^}]*\}','', ' '.join(lines[idx+1:])).strip()
        cue={'id':f'cue-{len(cues):04d}','start':a,'end':min(b,duration),'text':value}
        if a>=duration or b<=a:invalid.append({'start':a,'end':b,'reason':'outside_actual_video'});continue
        cues.append(cue)
    return cues,invalid


def proxy(source,target,width,rate,crf,bitrate,duration):
    if target.exists() and target.stat().st_size>1000:return
    target.parent.mkdir(parents=True,exist_ok=True)
    filters=f'scale={width}:-2'+(f',fps={rate}' if rate else '')
    temp=target.with_name(target.stem+'.partial.mp4')
    args=['-threads','4','-i',source,'-map','0:v:0','-map','0:a:0?','-t',duration,'-vf',filters,
        '-c:v','h264_nvenc','-preset','p4','-rc','vbr','-cq',crf,'-b:v','0','-g','48','-pix_fmt','yuv420p',
        '-c:a','aac','-b:a',f'{bitrate}k','-ac','1' if rate else '2','-movflags','+faststart',temp]
    try:ffmpeg(args)
    except RuntimeError:
        args=['-threads','4','-i',source,'-map','0:v:0','-map','0:a:0?','-t',duration,'-vf',filters,
            '-c:v','libx264','-preset','veryfast','-crf',crf,'-g','48','-pix_fmt','yuv420p','-c:a','aac','-b:a',f'{bitrate}k','-ac','1' if rate else '2','-movflags','+faststart',temp]
        ffmpeg(args)
    temp.replace(target)


def process(source,cfg,episode,total):
    directory=OUT/f'episode-{episode:02d}';directory.mkdir(parents=True,exist_ok=True)
    result_file=directory/'source.json'
    if result_file.exists():return json.loads(result_file.read_text(encoding='utf-8'))
    status('检测原始镜头',episode=episode,total=total)
    boundary_path=directory/'boundaries.json'
    detector_python=cfg.get('MAD_VISION_PYTHON','python')
    old=json.loads(boundary_path.read_text()) if boundary_path.exists() else {}
    if not old.get('containerDuration'):
        subprocess.run([detector_python,str(ROOT/'scripts/detect_shots.py'),str(source),str(directory)],check=True)
    boundaries=json.loads(boundary_path.read_text());duration=boundaries['duration']
    digest=hashlib.file_digest(source.open('rb'),'sha256').hexdigest();source_id=digest[:16]
    media_dir=ROOT/'.local/media'/source_id;media_dir.mkdir(parents=True,exist_ok=True)
    status('制作浏览器与 Gemini 分析代理',episode=episode,total=total)
    proxy(source,media_dir/'preview.mp4',960,None,24,128,duration)
    proxy(source,directory/'analysis-proxy.mp4',int(cfg.get('MAD_ANALYSIS_WIDTH',640)),int(cfg.get('MAD_ANALYSIS_FPS',12)),int(cfg.get('MAD_ANALYSIS_CRF',30)),int(cfg.get('MAD_ANALYSIS_AUDIO_KBPS',64)),duration)
    proxy_info=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration,size,bit_rate:stream=codec_type,width,height,avg_frame_rate','-of','json',str(directory/'analysis-proxy.mp4')]))
    srt=directory/'subtitles.ja.srt'
    external=cfg.get('JEV_SUBTITLE')
    if external:
        ffmpeg(['-i',external,srt])
    else:
        probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','s','-show_streams','-of','json',str(source)]))
        if probe.get('streams'): ffmpeg(['-i',source,'-map','0:s:0',srt])
        else: srt.write_text('',encoding='utf-8')
    cues,invalid=subtitles(srt.read_text(encoding='utf-8-sig'),duration)
    sample_dir=directory/'samples';sample_dir.mkdir(exist_ok=True)
    if not (directory/'samples.complete').exists():
        ffmpeg(['-i',directory/'analysis-proxy.mp4','-vf','fps=2,scale=256:144','-q:v','4',sample_dir/'%06d.jpg'])
        (directory/'samples.complete').write_text('ok')
    samples=sorted(sample_dir.glob('*.jpg'));thumb_dir=media_dir/'v2-thumbs';thumb_dir.mkdir(exist_ok=True)
    pts=np.load(directory/'frame-times.npy');count=len(pts)
    frames=np.memmap(directory/'transnet-rgb.bin',dtype=np.uint8,mode='r',shape=(count,27,48,3))
    # Motion proposals keep frame timestamps and are marked unverified until Gemini supplies event meaning.
    delta=np.mean(np.abs(frames[1:].astype(np.int16)-frames[:-1].astype(np.int16)),axis=(1,2,3))
    shots=[]
    for n,shot in enumerate(boundaries['shots']):
        a,b=shot['start'],shot['end'];sf,ef=shot['startFrame'],shot['endFrame']
        if b-a<.08:continue
        use=[a+min(.15,(b-a)/5),(a+b)/2,b-min(.15,(b-a)/5)]
        sheet=Image.new('RGB',(768,144))
        for j,t in enumerate(use):
            index=min(len(samples)-1,max(0,int(t*2)))
            with Image.open(samples[index]) as im:sheet.paste(im,(j*256,0))
        name=f'{sf:07d}.jpg';sheet.save(thumb_dir/name,quality=85)
        inside_start=min(ef-1,sf+max(1,int(boundaries['fps']*.1)))
        inside_end=max(inside_start+1,ef-max(1,int(boundaries['fps']*.1)))
        proposals=delta[inside_start:inside_end]
        anchor_frame=inside_start+int(np.argmax(proposals))+1 if len(proposals) else sf
        color=np.mean(frames[(sf+ef)//2],axis=(0,1)).tolist()
        hist=np.histogram(frames[(sf+ef)//2],bins=16,range=(0,256))[0].astype(float);hist/=max(1,hist.sum())
        text=[c for c in cues if c['start']<b and c['end']>a]
        context=[c for c in cues if c['start']<b+12 and c['end']>a-12]
        shots.append({**shot,'id':f'{source_id}-f{sf:07d}','sourceId':source_id,'episode':episode,'shotIndex':n,
            'thumb':f'v2-thumbs/{name}','thumbUrl':f'/media/{source_id}/v2-thumbs/{name}',
            'anchor':float(pts[min(anchor_frame,len(pts)-1)]),'anchorMethod':'frame-level motion proposal; semantic confirmation pending',
            'motion':float(min(1,np.mean(proposals)/25)) if len(proposals) else 0,'meanColor':color,'visualSignature':hist.tolist(),
            'cues':text,'contextCues':context,'semanticStatus':'pending','excluded':False,
            'previousShotId':None,'nextShotId':None})
    for i,s in enumerate(shots):
        s['previousShotId']=shots[i-1]['id'] if i else None;s['nextShotId']=shots[i+1]['id'] if i+1<len(shots) else None
    result={'id':source_id,'name':source.name,'episode':episode,'edition':cfg.get('JEV_COLLECTION','User supplied footage'),'original':str(source.resolve()),'dir':str(media_dir.resolve()),
        'url':f'/media/{source_id}/preview.mp4','kind':'video','duration':duration,'containerDuration':boundaries['containerDuration'],
        'fps':boundaries['frameRate'],'width':1920,'height':1080,'hasAudio':True,'shots':shots,'cues':cues,
        'subtitleProvenance':{'type':'external' if external else 'embedded-or-none','language':cfg.get('JEV_SUBTITLE_LANGUAGE','und'),'aligned':'user-verified' if external else 'same-container','discardedOutOfRange':len(invalid)},
        'analysisVersion':2,'detector':'TransNetV2','semanticStatus':'pending','proxy':{'path':str(directory/'analysis-proxy.mp4'),**proxy_info['format'],'streams':proxy_info['streams']},
        'sourceSha256':digest,'preprocessingCompletedAt':time.time()}
    result_file.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    status('单集本地索引完成',episode=episode,total=total,shots=len(shots),cues=len(cues),sourceFile=str(result_file))
    return result


if __name__=='__main__':
    raise SystemExit('Use scripts/prepare_sources.py with a source manifest')
