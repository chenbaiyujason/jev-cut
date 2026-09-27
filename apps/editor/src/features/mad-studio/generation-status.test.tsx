import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor, act } from '@testing-library/react'
import { useMadBridge } from './bridge'
import { GenerationPlaceholder } from './generation-placeholder'
import { JevToolbar } from './jev-chrome'

afterEach(()=>{cleanup();document.querySelector('[data-test-track]')?.remove();useMadBridge.setState({generationId:null,pending:false,pendingClip:null,waitingForClip:false,phase:'已同步'})})
it('shows live model stage in the header and removes a transient placeholder when its clip arrives',async()=>{
 const track=document.createElement('div');track.dataset.testTrack='true';track.dataset.trackId='picture';track.dataset.timelineDropTarget='true';
 const layer=document.createElement('div');layer.dataset.timelineTrackContentLayer='';track.append(layer);document.body.append(track);
 useMadBridge.setState({generationId:'test',pending:true,phase:'第 8 镜 · 上下文选镜',pendingClip:{id:'pending',trackId:'picture',from:30,to:45,index:8}})
 render(<><JevToolbar active onOpen={()=>{}}/><GenerationPlaceholder/></>)
 expect(screen.getByText('第 8 镜 · 上下文选镜')).toBeTruthy()
 await waitFor(()=>expect(screen.getByRole('status',{name:'第 8 镜正在生成'})).toBeTruthy())
 expect(layer.querySelector('[data-timeline-item]')).toBeNull()
 act(()=>useMadBridge.setState({phase:'第 8 镜已排入',pendingClip:null}))
 expect(screen.queryByRole('status',{name:'第 8 镜正在生成'})).toBeNull()
 expect(screen.getByText('第 8 镜已排入')).toBeTruthy()
})
