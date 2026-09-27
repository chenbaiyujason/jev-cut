"""Local media analysis. Source audio, subtitles and image evidence stay linked."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
import wave
import numpy as np


def run(args):
    p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if p.returncode: raise RuntimeError(p.stderr.decode('utf-8',errors='replace')[-2500:])
    return p.stdout


def progress(stage,value):
    print(json.dumps({'stage':stage,'progress':value},ensure_ascii=False),flush=True)


def analyze(path,out,kind):
    out.mkdir(parents=True,exist_ok=True)
    probe=json.loads(run(['ffprobe','-v','error','-show_format','-show_streams','-of','json',str(path)]))
    duration=float(probe['format']['duration'])
    audio=[s for s in probe['streams'] if s['codec_type']=='audio']
    progress('提取原声音轨',.08)
    if audio:
        run(['ffmpeg','-v','error','-y','-i',str(path),'-map','0:a:0','-ac','1','-ar','22050',str(out/'analysis.wav')])
        import librosa
        y,sr=librosa.load(out/'analysis.wav',sr=22050)
        hop=256
        rms=librosa.feature.rms(y=y,frame_length=1024,hop_length=hop)[0]
        onset=librosa.onset.onset_strength(y=y,sr=sr,hop_length=hop)
        beats_tempo,beats=librosa.beat.beat_track(onset_envelope=onset,sr=sr,hop_length=hop,trim=False)
        tempo=float(np.asarray(beats_tempo).reshape(-1)[0])
        peaks=librosa.onset.onset_detect(onset_envelope=onset,sr=sr,hop_length=hop)
        onset=onset/max(float(np.quantile(onset,.99)),.0001)
        accents=[{'time':round(float(t*hop/sr),4),'strength':round(min(1,float(onset[t])),4)} for t in peaks if onset[t]>.35]
        waveform=[round(float(np.max(np.abs(v))),4) for v in np.array_split(y,min(1800,len(y))) if len(v)]
        sound={'bpm':round(tempo,2),'beats':[round(float(t*hop/sr),4) for t in beats],
               'accents':accents,'waveform':waveform,'method':'librosa beat tracking + spectral onset; downbeat not inferred'}
    else:
        sound={'bpm':0,'beats':[],'accents':[],'waveform':[]};rms=np.zeros(1);sr=22050;hop=256
    if kind=='music':
        if not audio:raise RuntimeError('文件没有音轨')
        run(['ffmpeg','-v','error','-y','-i',str(path),'-vn','-c:a','aac','-b:a','192k',str(out/'preview.m4a')])
        result={'kind':'music','duration':duration,**sound}
    else:
        progress('建立浏览器预览代理',.25)
        video=next(s for s in probe['streams'] if s['codec_type']=='video' and not s.get('disposition',{}).get('attached_pic'))
        run(['ffmpeg','-v','error','-y','-i',str(path),'-map','0:v:0','-map','0:a:0?',
            '-vf',"scale='min(960,iw)':-2",'-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-g','12','-bf','0',
            '-c:a','aac','-b:a','128k','-movflags','+faststart',str(out/'preview.mp4')])
        progress('检测镜头与运动峰值',.5)
        raw=run(['ffmpeg','-v','error','-i',str(path),'-map','0:v:0','-vf','fps=6,scale=96:54,format=gray',
            '-f','rawvideo','-pix_fmt','gray','pipe:1'])
        frames=np.frombuffer(raw,dtype=np.uint8).reshape(-1,54,96).astype(np.float32)
        change=np.mean(np.abs(np.diff(frames,axis=0)),axis=(1,2))
        threshold=max(18,float(np.quantile(change,.91)))
        boundaries=[0.]
        for i,diff in enumerate(change):
            t=(i+1)/6
            if diff>threshold and t-boundaries[-1]>=.7: boundaries.append(t)
        boundaries.append(duration)
        # Long static shots still get bounded retrieval windows; never call these semantic cuts.
        expanded=[]
        for a,b in zip(boundaries,boundaries[1:]):
            count=max(1,int(np.ceil((b-a)/12)))
            expanded.extend(np.linspace(a,b,count+1)[:-1].tolist())
        expanded.append(duration)
        shots=[]
        thumbs=out/'thumbs';thumbs.mkdir(exist_ok=True)
        from PIL import Image,ImageDraw
        samples=out/'samples';samples.mkdir(exist_ok=True)
        run(['ffmpeg','-v','error','-y','-i',str(out/'preview.mp4'),
            '-vf','fps=2,scale=192:108:force_original_aspect_ratio=decrease,pad=192:108:(ow-iw)/2:(oh-ih)/2',
            '-q:v','5',str(samples/'%06d.jpg')])
        sample_count=len(list(samples.glob('*.jpg')))
        for i,(a,b) in enumerate(zip(expanded,expanded[1:])):
            if b-a<.4:continue
            left=max(0,int((a+.2)*6));right=min(len(change),int((b-.15)*6))
            if right>left:
                local=change[left:right];pos=left+int(np.argmax(local));anchor=(pos+1)/6;motion=float(np.mean(local))/25
            else:anchor=(a+b)/2;motion=0
            nearby=[x for x in sound['accents'] if a+.1<=x['time']<=b-.1]
            impact=max(nearby,key=lambda x:x['strength']) if nearby else None
            if impact and abs(impact['time']-anchor)<.5:anchor=(anchor+impact['time'])/2
            sheet=Image.new('RGB',(576,108))
            for j,t in enumerate([a+.15,(a+b)/2,b-.15]):
                sample=max(1,min(sample_count,int(t*2)+1))
                with Image.open(samples/f'{sample:06d}.jpg') as im:sheet.paste(im,(192*j,0))
            sheet.save(thumbs/f'{i:04d}.jpg',quality=83)
            level=rms[int(a*sr/hop):min(len(rms),int(b*sr/hop))]
            shots.append({'id':f'shot-{i:04d}','start':round(a,4),'end':round(b,4),
                'anchor':round(min(b-.05,max(a,anchor)),4),'anchorMethod':'motion peak + nearby audio onset (unverified semantic impact)',
                'motion':round(min(1,motion),4),'audioEnergy':round(float(np.mean(level)) if len(level) else 0,5),
                'audioOnsets':nearby[:16],'thumb':f'thumbs/{i:04d}.jpg','cues':[]})
            if i%30==0:progress(f'提取镜头证据 {i+1}/{len(expanded)-1}',.5+.4*i/max(1,len(expanded)-1))
        subtitle=[s for s in probe['streams'] if s['codec_type']=='subtitle']
        extracted=[]
        for i,s in enumerate(subtitle):
            if s.get('codec_name') in ['ass','subrip','webvtt','mov_text','ssa']:
                file=f'subtitle-{i}.srt'
                run(['ffmpeg','-v','error','-y','-i',str(path),'-map',f'0:{s["index"]}',str(out/file)])
                extracted.append({'file':file,'language':s.get('tags',{}).get('language','und'),'source':'embedded'})
        result={'kind':'video','duration':duration,'width':video['width'],'height':video['height'],
            'fps':video['r_frame_rate'],'hasAudio':bool(audio),'shots':shots,'subtitles':extracted,**sound}
    (out/'analysis.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    progress('分析完成',1)


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    ap=argparse.ArgumentParser();ap.add_argument('input',type=Path);ap.add_argument('output',type=Path)
    ap.add_argument('--kind',choices=['video','music'],default='video');args=ap.parse_args()
    analyze(args.input,args.output,args.kind)
