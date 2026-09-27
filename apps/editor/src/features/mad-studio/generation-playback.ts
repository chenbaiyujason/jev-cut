import type { TimelineItem } from '@/types/timeline'

/** Preview-only looping: never changes media items, edit ranges, or the exported timeline. */
export function generationPlaybackTarget(items: TimelineItem[], frame: number): { frame: number; waiting: boolean } {
 const music = items.find(i => i.type === 'audio' && i.trackId === 'music')
 if (!music) return { frame, waiting: false }
 const end = music.from + music.durationInFrames
 const clips = items.filter(i => i.type === 'video' && i.trackId === 'picture').sort((a,b) => a.from-b.from)
 const current = clips.find(i => frame >= i.from && frame < i.from+i.durationInFrames)
 if (current) {
   const nextFrame=current.from+current.durationInFrames
   const hasNext=clips.some(i => i.from<=nextFrame && i.from+i.durationInFrames>nextFrame)
   if (nextFrame<end && !hasNext) return {frame:frame>=nextFrame-1?current.from:frame,waiting:true}
   return {frame,waiting:false}
 }
 const previous=clips.filter(i=>i.from<=frame).at(-1)
 if(frame<end)return {frame:previous?.from??clips[0]?.from??music.from,waiting:true}
 return {frame,waiting:false}
}

export function musicWasExtended(before: TimelineItem[], after: TimelineItem[]): boolean {
 const previous=before.find(i=>i.type==='audio'&&i.trackId==='music'),next=after.find(i=>i.type==='audio'&&i.trackId==='music')
 return !!(previous&&next&&previous.id===next.id&&previous.mediaId===next.mediaId&&next.from+next.durationInFrames>previous.from+previous.durationInFrames)
}
