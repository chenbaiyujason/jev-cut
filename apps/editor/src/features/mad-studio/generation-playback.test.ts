import { expect, it } from 'vitest'
import type { TimelineItem } from '@/types/timeline'
import { generationPlaybackTarget, musicWasExtended } from './generation-playback'
const music={id:'music',type:'audio',trackId:'music',mediaId:'m',from:0,durationInFrames:180} as TimelineItem
const clip=(id:string,from:number,duration:number)=>({id,type:'video',trackId:'picture',from,durationInFrames:duration}) as TimelineItem
it('loops the last available clip only until the next clip arrives, without changing the timeline',()=>{
 const items=[music,clip('a',0,30)];const original=JSON.stringify(items)
 expect(generationPlaybackTarget(items,29)).toEqual({frame:0,waiting:true})
 expect(generationPlaybackTarget([...items,clip('b',30,30)],29)).toEqual({frame:29,waiting:false})
 expect(generationPlaybackTarget(items,40)).toEqual({frame:0,waiting:true})
 expect(JSON.stringify(items)).toBe(original)
 expect(generationPlaybackTarget([music,clip('end',0,180)],179)).toEqual({frame:179,waiting:false})
})
it('automatic extension responds to music lengthening, not a trim, new import or picture changes',()=>{
 expect(musicWasExtended([music],[{...music,durationInFrames:240}])).toBe(true)
 expect(musicWasExtended([music],[{...music,durationInFrames:100}])).toBe(false)
 expect(musicWasExtended([],[music])).toBe(false)
 expect(musicWasExtended([music],[music,clip('a',0,30)])).toBe(false)
})
