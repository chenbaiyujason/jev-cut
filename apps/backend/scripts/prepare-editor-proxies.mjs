import {readFile,writeFile,stat,rename} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
const library=JSON.parse(await readFile('.local/library.json','utf8'));
function run(command,args){return new Promise((resolve,reject)=>{const p=spawn(command,args,{windowsHide:true});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err=(err+b).slice(-3000));p.on('error',reject);p.on('exit',code=>code?reject(Error(err)):resolve(out));});}
const report=[];let next=0;
await Promise.all(Array.from({length:3},async()=>{
  while(next<library.sources.length){
    const s=library.sources[next++],start=performance.now(),output=path.join(s.dir,'edit-preview-v2.mp4');
    try{await stat(output);}catch{
      const temp=path.join(s.dir,'edit-preview-v2.pending.mp4');
      await run('ffmpeg',['-v','error','-y','-i',path.join(s.dir,'preview.mp4'),'-map','0:v:0','-map','0:a:0?','-c:v','h264_nvenc','-pix_fmt','yuv420p','-profile:v','main','-preset','p2','-rc','vbr','-cq','24','-b:v','0','-g','12','-bf','0','-c:a','copy','-movflags','+faststart',temp]);
      const probe=JSON.parse(await run('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=nb_frames,avg_frame_rate,duration','-of','json',temp])).streams[0];
      const expected=JSON.parse(await run('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=nb_frames,avg_frame_rate','-of','json',path.join(s.dir,'preview.mp4')])).streams[0];
      if(probe.nb_frames!==expected.nb_frames||probe.avg_frame_rate!==expected.avg_frame_rate)throw Error('Frame mapping changed for episode '+s.episode);
      await rename(temp,output);
    }
    const r={episode:s.episode,id:s.id,seconds:(performance.now()-start)/1000,bytes:(await stat(output)).size,gopFrames:12};report.push(r);console.log(JSON.stringify(r));
  }
}));
await writeFile('.local/studio/verification/motion/editor-proxies.json',JSON.stringify(report,null,2));
