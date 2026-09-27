import test from 'node:test';
import assert from 'node:assert/strict';
import {generationWindow,musicForWindow,generationRanges} from '../generation-window.mjs';
const music={id:'m',duration:30,bpm:120,beats:[0,5,6,7,9,11,12],accents:[{time:7,strength:1}]};
const project={metadata:{fps:30},timeline:{items:[{id:'music',type:'audio',trackId:'music',mediaId:'m',from:60,durationInFrames:180,sourceStart:150,sourceFps:30,speed:1},{id:'old',type:'video',trackId:'picture',from:60,durationInFrames:60}]}};
test('trimmed music planning uses actual source offset and appends only uncovered tail',()=>{
 const w=generationWindow(project,music);assert.equal(w.sourceStart,5);assert.equal(w.duration,6);assert.deepEqual(generationRanges(project,w,'append'),[[120,240]]);
 const r=musicForWindow(music,{sections:[{start:0,end:7},{start:7,end:30}]},{events:[{time:7,strength:1}],primaryAccents:[{time:7,strength:1}]},w);
 assert.deepEqual(r.music.beats,[0,1,2,4]);assert.deepEqual(r.intent.sections,[{start:0,end:2},{start:2,end:6}]);assert.equal(r.events.events[0].time,2);
});
test('protected picture intervals remain occupied during full replan; audio overflow is rejected',()=>{
 const p=structuredClone(project);p.timeline.items[1].from=100;p.timeline.items[1].durationInFrames=50;
 assert.deepEqual(generationRanges(p,generationWindow(p,music),'rebuild'),[[60,100],[150,240]]);
 p.timeline.items[0].sourceStart=900;assert.throws(()=>generationWindow(p,music),/超出/);
});
