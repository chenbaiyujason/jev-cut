import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSubtitles,buildSlots,slotsAroundLocks,candidatesForSlot,makeClip,validateProject,isSpeechCue,dialogueUnits} from '../core.mjs';

test('SRT and ASS preserve time, offsets and complete multiline dialogue',()=>{
  const srt='1\n00:00:01,250 --> 00:00:03,500\n<b>一緒に</b>\n帰ろう\n';
  assert.deepEqual(parseSubtitles(srt,.5),[{start:1.75,end:4,text:'一緒に 帰ろう'}]);
  const ass='[Script Info]\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,{\\i1}hello, world\\Nsecond line';
  assert.deepEqual(parseSubtitles(ass),[{start:2,end:4,text:'hello, world second line'}]);
});
test('music marks and vocalizations are not mistaken for meaningful dialogue',()=>{
  for(const text of ['・～','はぁ はぁ はぁ…｡','バチッ バチッ！','チュン チュン…(鳥のさえずり)'])assert.equal(isSpeechCue({text}),false,text);
  assert.equal(isSpeechCue({text:'(ｷｭｩべえの声) でも 君なら 運命を変えられる｡'}),true);
});
test('music slots cover the duration without overlaps and retain strong accents',()=>{
  const music={bpm:120,beats:Array.from({length:120},(_,i)=>i*.5),accents:[{time:12.5,strength:1}]};
  const slots=buildSlots(music,30,.8);
  assert.equal(slots[0].start,0);assert.equal(slots.at(-1).end,30);
  for(let i=1;i<slots.length;i++)assert.equal(slots[i].start,slots[i-1].end);
  assert.ok(slots.some(s=>s.accent===12.5));
});
test('replanning keeps locked clip boundaries and never silently truncates them',()=>{
  const music={bpm:120,beats:Array.from({length:60},(_,i)=>i*.5)};
  const locked=[{id:'keep',start:5,end:9,sourceIn:55,rate:1,locked:true}];
  const slots=slotsAroundLocks(music,20,.6,locked);
  assert.deepEqual(slots.find(s=>s.lockedClip).lockedClip,locked[0]);
  assert.equal(slots[0].start,0);assert.equal(slots.at(-1).end,20);
  for(let i=1;i<slots.length;i++)assert.equal(slots[i].start,slots[i-1].end);
  assert.throws(()=>slotsAroundLocks(music,8,.6,locked),/截断/);
});
test('subtitle continuation markers are joined before choosing a dialogue window',()=>{
  const cues=[{start:1,end:2,text:'だから 僕と契約して・'},{start:2.1,end:4,text:'魔法少女になってよ｡'}];
  assert.equal(dialogueUnits(cues).length,1);assert.equal(dialogueUnits(cues)[0].end,4);
  assert.equal(dialogueUnits([{...cues[0],text:'だから 僕と契約して➡'},cues[1]]).length,1);
});
test('motion anchor maps to the accent and source bounds remain valid',()=>{
  const slot={start:10,end:12,accent:11,phase:'爆发',energy:1};
  const shots=[{id:'s1',sourceId:'v',start:20,end:27,anchor:23,motion:1,cues:[]}];
  const [c]=candidatesForSlot(slot,shots);
  assert.ok(Math.abs(c.anchorOutput-11)<.001);assert.ok(c.sourceIn>=20);assert.ok(c.sourceIn+2*c.rate<=27);
});
test('dialogue stays at 1x and the selected complete line has its own audio window',()=>{
  const slot={start:0,end:4,accent:0,phase:'铺垫',energy:.4};
  const cue={start:10.3,end:12.1,text:'完整的一句台词'};
  const [c]=candidatesForSlot(slot,[{id:'s',sourceId:'v',start:10,end:16,motion:0,cues:[cue]}]);
  assert.equal(c.rate,1);assert.ok(c.sourceIn<=cue.start);assert.ok(c.sourceIn+4>=cue.end);
  const clip=makeClip(slot,c);assert.deepEqual(clip.audioWindow,{start:10.3,end:12.1});
});
test('export rejects overlapping clips, source overflow and nonfinite sound parameters',()=>{
  const library={sources:[{id:'v',duration:20}],music:[{id:'m',duration:30}]};
  const clip={id:'one',sourceId:'v',start:0,end:3,sourceIn:1,rate:1,gain:1,effect:'none'};
  const p={clips:[clip],musicId:'m',duration:10,musicGain:.7};
  assert.equal(validateProject(p,library).clips.length,1);
  assert.throws(()=>validateProject({...p,clips:[clip,{...clip,id:'two',start:2,end:4}]},library),/重叠/);
  assert.throws(()=>validateProject({...p,clips:[{...clip,sourceIn:19}]},library),/超出/);
  assert.throws(()=>validateProject({...p,clips:[{...clip,audioWindow:{start:NaN,end:2}}]},library),/原声范围/);
});
