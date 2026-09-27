import json
from pathlib import Path
import subprocess
import sys


def call(args):
    p=subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y',*args],capture_output=True)
    if p.returncode:raise RuntimeError(p.stderr.decode('utf-8',errors='replace')[-2000:])


def main(file):
    data=json.loads(Path(file).read_text(encoding='utf-8'));project=data['project'];out=Path(data['output']);out.mkdir(parents=True,exist_ok=True)
    fragments=[];cursor=0
    def black(duration):
        if duration<1/60:return
        name=f'{len(fragments):04d}.mp4'
        call(['-f','lavfi','-i','color=c=black:s=960x540:r=30','-f','lavfi','-i','anullsrc=r=48000:cl=stereo',
            '-t',str(duration),'-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p','-c:a','aac',str(out/name)])
        fragments.append((name,duration))
    for i,c in enumerate(project['clips']):
        black(c['start']-cursor)
        duration=c['end']-c['start'];source=data['sources'][c['sourceId']]
        name=f'{len(fragments):04d}.mp4'
        source_duration=duration*c['rate']
        frame_count=round(duration*30)
        video=f"trim=duration={source_duration},setpts=(PTS-STARTPTS)/{c['rate']},scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2,fps=30,tpad=stop_mode=clone:stop_duration=1,trim=end_frame={frame_count},setsar=1"
        if c['effect']=='punch':video+=',scale=1038:584,crop=960:540'
        if c['effect']=='flash':video+=",drawbox=color=white@0.25:t=fill:enable='lt(t,0.067)'"
        gain=str(c['gain'])
        window=c.get('audioWindow')
        if window:
            a=max(0,(window['start']-c['sourceIn'])/c['rate']);b=min(duration,(window['end']-c['sourceIn'])/c['rate'])
            gain=f"{c['gain']}*max(0,min(1,min((t-{a})/0.025,({b}-t)/0.025)))"
        audio=f"atrim=duration={source_duration},asetpts=PTS-STARTPTS,atempo={c['rate']},aformat=sample_rates=48000:channel_layouts=stereo,volume='{gain}':eval=frame,afade=t=in:d=0.015,afade=t=out:st={max(0,duration-.03)}:d=0.03,apad"
        args=['-ss',str(c['sourceIn']),'-i',source['path']]
        if source['hasAudio']:
            args+=['-filter_complex',f'[0:v:0]{video}[v];[0:a:0]{audio}[a]','-map','[v]','-map','[a]']
        else:
            args+=['-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-vf',video,'-map','0:v:0','-map','1:a:0']
        call([*args,'-t',str(duration),'-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-b:a','160k',str(out/name)])
        fragments.append((name,duration));cursor=c['end']
        print(json.dumps({'stage':f'渲染镜头 {i+1}/{len(project["clips"])}','progress':(i+1)/len(project['clips'])*.9},ensure_ascii=False),flush=True)
    black(project['duration']-cursor)
    (out/'concat.txt').write_text('\n'.join(f"file '{f}'\nduration {duration:.9f}" for f,duration in fragments),encoding='utf-8')
    duck='1'
    for c in project['clips']:
        if c['gain']>0 and c.get('dialogue'):
            w=c.get('audioWindow');a=c['start']+(max(0,w['start']-c['sourceIn'])/c['rate'] if w else 0)
            b=min(c['end'],c['start']+(w['end']-c['sourceIn'])/c['rate']) if w else c['end']
            duck+=f'-0.7*between(t,{a},{b})'
    length=project['duration']
    filters=f"[1:a]atrim=duration={length},asetpts=PTS-STARTPTS,volume='{project['musicGain']}*max(0.2,{duck})':eval=frame,afade=t=in:d=0.15,afade=t=out:st={max(0,length-1)}:d=1[bgm];[0:a][bgm]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]"
    call(['-f','concat','-safe','0','-i',str(out/'concat.txt'),'-i',data['music'],
        '-filter_complex',filters,'-map','0:v:0','-map','[a]','-c:v','copy','-c:a','aac','-b:a','192k','-t',str(length),'-movflags','+faststart',str(out/'mad.mp4')])
    (out/'project.json').write_text(json.dumps(project,ensure_ascii=False,indent=2),encoding='utf-8')
    def stamp(t):
        ms=round(max(0,t)*1000);return f'{ms//3600000:02d}:{ms//60000%60:02d}:{ms//1000%60:02d},{ms%1000:03d}'
    captions=[]
    for c in project['clips']:
        if c.get('dialogue') and c['gain']>0 and c.get('audioWindow'):
            w=c['audioWindow'];a=max(c['start'],c['start']+(w['start']-c['sourceIn'])/c['rate']);b=min(c['end'],c['start']+(w['end']-c['sourceIn'])/c['rate'])
            if b>a:captions.append(f"{len(captions)+1}\n{stamp(a)} --> {stamp(b)}\n{c['dialogue']}\n")
    (out/'subtitles.srt').write_text('\n'.join(captions),encoding='utf-8')
    (out/'CREDITS.txt').write_text(data.get('musicCredit','Music attribution not supplied.')+'\nEdits: music excerpt and audio mix; see project.json for source references.\n',encoding='utf-8')
    print(json.dumps({'stage':'导出完成','progress':1},ensure_ascii=False),flush=True)


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8');main(sys.argv[1])
