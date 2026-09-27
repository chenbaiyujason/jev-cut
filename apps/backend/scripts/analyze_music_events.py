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

def break_returns(y,sr):
    hop=max(1,round(sr*.005));blocks=y[:len(y)//hop*hop].reshape(-1,hop)
    envelope=np.sqrt(np.mean(blocks**2,axis=1));level=float(np.quantile(envelope,.95));quiet=envelope<max(level*.12,1e-5)
    out=[];begin=None
    for i,q in enumerate(quiet):
        if q and begin is None:begin=i
        if not q and begin is not None:
            length=(i-begin)*hop/sr;after=envelope[i:min(len(envelope),i+round(.15*sr/hop))]
            if length>=.18 and begin*hop/sr>.05 and len(after) and float(after.max())>=level*.5:
                out.append({'time':round(i*hop/sr,4),'quietStart':round(begin*hop/sr,4),'quietSeconds':round(length,4),'role':'break-return','structural':True,'strength':1,'timingEvidence':'5ms PCM RMS return after low-energy gap'})
            begin=None
    return out

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
    structural=break_returns(y,sr)
    for anchor in structural:
        nearby=min(events,key=lambda e:abs(e['time']-anchor['time']),default={})
        if abs(nearby.get('time',-99)-anchor['time'])<.1:anchor['band']=nearby['band']
    result={'version':2,'duration':len(y)/sr,'hopSeconds':hop/sr,'events':events,'primaryAccents':sorted(primary,key=lambda e:e['time']),'structuralAccents':structural,
      'method':'HPSS + low/mid/high percussive spectral flux + harmonic attacks + local RMS rise; acoustic candidates, not verified drum labels or downbeats'}
    Path(output).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'events':len(events),'primary':len(primary),'times':[e['time'] for e in result['primaryAccents']]}),flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('audio');p.add_argument('output');p.add_argument('--structural-only',action='store_true');args=p.parse_args()
    if args.structural_only:
        sr=22050;y=np.frombuffer(subprocess.run(['ffmpeg','-v','error','-i',args.audio,'-vn','-ac','1','-ar',str(sr),'-f','f32le','pipe:1'],capture_output=True,check=True).stdout,dtype=np.float32)
        record=json.loads(Path(args.output).read_text(encoding='utf-8'));record['structuralAccents']=break_returns(y,sr);record['version']=2;Path(args.output).write_text(json.dumps(record,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(record['structuralAccents']))
    else:analyze(args.audio,args.output)
