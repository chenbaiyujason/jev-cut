import { beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { Project } from '@/types/project'
import {
  makeTimelineTrack,
  makeTimelineVideoItem,
  resetTimelineCompositionTestState,
} from '@/features/timeline/test-helpers'
import { useItemsStore } from '@/features/timeline/stores/items-store'
import { useTimelineCommandStore } from '@/features/timeline/stores/timeline-command-store'
import { useTimelineSettingsStore } from '@/features/timeline/stores/timeline-settings-store'
import {
  hydrateTimelineStoresFromProject,
  buildTimelineFromStores,
} from '@/features/timeline/stores/timeline-persistence'
import { useProjectStore } from '@/features/projects/stores/project-store'
import { applyTimelineTransaction, whenEditorReady } from './timeline-sync'
import { usePlaybackStore } from '@/shared/state/playback'

const track = makeTimelineTrack({ id: 'v1', name: '画面', kind: 'video', order: 0 })
const clip = makeTimelineVideoItem({ id: 'shot1', trackId: track.id })
const project: Project = {
  id: 'mad-main',
  name: 'MAD',
  description: '',
  createdAt: 1,
  updatedAt: 1,
  duration: 5,
  metadata: { width: 960, height: 540, fps: 30 },
  timeline: { tracks: [track], items: [clip] },
}
beforeEach(() => {
  resetTimelineCompositionTestState()
  useProjectStore.getState().setCurrentProject(project)
})
afterEach(() => {
  resetTimelineCompositionTestState()
  useProjectStore.getState().setCurrentProject(null)
})

describe('live Agent transaction history', () => {
  it('appends streamed clips without pausing or replacing the active clip object', async () => {
    await hydrateTimelineStoresFromProject(project)
    const initial=useItemsStore.getState().items[0] as typeof clip
    const timeline=buildTimelineFromStores()
    usePlaybackStore.getState().setCurrentFrame(12)
    usePlaybackStore.getState().play()
    const next={...project,timeline:{...timeline,items:[{...timeline.items[0]!,src:initial!.src},makeTimelineVideoItem({id:'shot2',trackId:track.id,from:150})]}}
    expect(await applyTimelineTransaction(next,7,{preservePlayback:true})).toBe('incremental')
    expect(usePlaybackStore.getState().isPlaying).toBe(true)
    expect(usePlaybackStore.getState().currentFrame).toBe(12)
    expect(useItemsStore.getState().items[0]).toBe(initial)
    expect(useItemsStore.getState().items).toHaveLength(2)
    usePlaybackStore.getState().pause()
  })
  it('keeps manual history and makes an Agent batch undoable/redoable through native stores', async () => {
    await hydrateTimelineStoresFromProject(project)
    useTimelineCommandStore
      .getState()
      .execute({ type: 'manual-rename' }, () =>
        useItemsStore.getState().setItems([{ ...clip, label: '手工命名' }]),
      )
    const beforeAgent = { ...project, timeline: buildTimelineFromStores() }
    const afterAgent = {
      ...beforeAgent,
      timeline: {
        ...beforeAgent.timeline,
        items: beforeAgent.timeline.items.map((item) => ({
          ...item,
          transform: {
            x: 25,
            y: 0,
            width: 960,
            height: 540,
            rotation: 0,
            opacity: 1,
            aspectRatioLocked: true,
          },
        })),
      },
    }
    await applyTimelineTransaction(afterAgent, 4)
    expect(useTimelineCommandStore.getState().canUndo).toBe(true)
    expect(useTimelineCommandStore.getState().undoStack).toHaveLength(2)
    useTimelineCommandStore.getState().undo()
    expect(useItemsStore.getState().items[0]?.label).toBe('手工命名')
    expect(useItemsStore.getState().items[0]?.transform?.x).not.toBe(25)
    expect(buildTimelineFromStores().items[0]?.transform?.x).not.toBe(25)
    useTimelineCommandStore.getState().redo()
    expect(useItemsStore.getState().items[0]?.transform?.x).toBe(25)
    useTimelineCommandStore.getState().undo()
    useTimelineCommandStore.getState().undo()
    expect(useItemsStore.getState().items[0]?.label).toBe(clip.label)
  })
  it('waits for the existing editor load without starting another load', () => {
    useTimelineSettingsStore.getState().setTimelineLoading(true)
    const ready = vi.fn()
    const stop = whenEditorReady(ready)
    expect(ready).not.toHaveBeenCalled()
    useTimelineSettingsStore.getState().setTimelineLoading(false)
    expect(ready).toHaveBeenCalledTimes(1)
    useTimelineSettingsStore.getState().setTimelineLoading(true)
    useTimelineSettingsStore.getState().setTimelineLoading(false)
    expect(ready).toHaveBeenCalledTimes(1)
    stop()
  })
})
