"""Audio evidence, not instrument/structure ground truth.
Separate percussive band attacks, melodic attacks and sparse salient accents.
"""
import argparse,json,subprocess
from pathlib import Path
import librosa
import numpy as np
from scipy.signal import find_peaks

def scale(values):
    return np.clip(values/max(float(np.quantile(values,.96)),1e-6),0,1.5)

def analyze(file,output):
    sr=22050;decoded=subprocess.run(['ffmpeg','-v','error','-i',file,'-vn','-ac','1','-ar',str(sr),'-f','f32le','pipe:1'],capture_output=True,check=True)
    y=np.frombuffer(decoded.stdout,dtype=np.float32);hop=128;fft=2048
    spec=librosa.stft(y,n_fft=fft,hop_length=hop)
    harmonic,percussive=librosa.decompose.hpss(spec,margin=(2,4));freq=librosa.fft_frequencies(sr=sr,n_fft=fft)
    def flux(matrix,low,high):
        band=np.log1p(20*np.abs(matrix[(freq>=low)&(freq<high)]));return scale(np.r_[0,np.maximum(0,np.diff(band,axis=1)).mean(axis=0)])
    low=flux(percussive,30,180);mid=flux(percussive,180,2400);high=flux(percussive,2400,10000);melody=flux(harmonic,120,7000)
    attack=.45*low+.32*mid+.13*high+.1*melody
    peaks,_=find_peaks(attack,distance=max(1,int(.075*sr/hop)),prominence=.12,height=.22)
    rms=librosa.feature.rms(y=y,frame_length=fft,hop_length=hop)[0];rms=scale(rms)
    events=[]
    for frame in peaks:
        before=rms[max(0,frame-int(.25*sr/hop)):frame];after=rms[frame:min(len(rms),frame+int(.15*sr/hop))]
        rise=max(0,float(np.mean(after)-np.mean(before))) if len(before) and len(after) else 0
        salience=float(attack[frame]+rise*.5)
        band=max([('low',float(low[frame])),('mid',float(mid[frame])),('high',float(high[frame])),('melodic',float(melody[frame]))],key=lambda x:x[1])[0]
        events.append({'time':round(float(frame*hop/sr),4),'salience':round(salience,4),'strength':round(min(1,salience/1.3),4),
          'band':band,'low':round(float(low[frame]),3),'mid':round(float(mid[frame]),3),'high':round(float(high[frame]),3),
          'melodic':round(float(melody[frame]),3),'energyRise':round(rise,3),'role':'pulse'})
    # Sparse anchors: do not call every transient an emotional climax.
    primary=[]
    threshold=float(np.quantile([e['salience'] for e in events],.77)) if events else 2
    for e in sorted(events,key=lambda e:e['salience'],reverse=True):
        if e['salience']>=threshold and .5<e['time']<len(y)/sr-.4 and all(abs(e['time']-p['time'])>=3.2 for p in primary):primary.append(e)
    for e in events:
        if e in primary:e['role']='primary'
        elif e['salience']>=threshold*.67:e['role']='secondary'
    result={'version':1,'duration':len(y)/sr,'hopSeconds':hop/sr,'events':events,'primaryAccents':sorted(primary,key=lambda e:e['time']),
      'method':'HPSS + low/mid/high percussive spectral flux + harmonic attacks + local RMS rise; acoustic candidates, not verified drum labels or downbeats'}
    Path(output).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'events':len(events),'primary':len(primary),'times':[e['time'] for e in result['primaryAccents']]}),flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('audio');p.add_argument('output');args=p.parse_args();analyze(args.audio,args.output)
