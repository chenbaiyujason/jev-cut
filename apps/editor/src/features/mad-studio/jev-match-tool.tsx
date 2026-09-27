import { useRef, type DragEvent } from 'react'
import { Crosshair, GripVertical } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { usePlaybackStore } from '@/shared/state/playback'
import { useSelectionStore } from '@/shared/state/selection'
import { useProjectStore } from '@/features/projects/stores/project-store'
import { useItemsStore } from '@/features/timeline/stores/items-store'
import { useCompositionNavigationStore } from '@/features/timeline/stores/composition-navigation-store'
import { useTimelineCommandStore } from '@/features/timeline/stores/timeline-command-store'
import { useTimelineSettingsStore } from '@/features/timeline/stores/timeline-settings-store'
import { createTimelineTemplateItem } from '@/features/timeline/utils/generated-layer-items'
import { isTrackCompatibleWithItemType } from '@/features/timeline/utils/track-item-compatibility'
import { setMediaDragData, clearMediaDragData } from '@/features/media-library/utils/drag-data-cache'
import { useMadBridge } from './bridge'

const template = { type: 'timeline-template' as const, itemType: 'controller' as const, label: 'jev匹配占位 · 点击右侧筛选素材' }

export function JevMatchTool({ onOpen }: { onOpen: () => void }) {
  const pending = useMadBridge((s) => s.pending)
  const conflict = useMadBridge((s) => s.conflict)
  const compositionId = useCompositionNavigationStore((s) => s.activeCompositionId)
  const dragged = useRef(false)
  const disabled = pending || conflict || compositionId !== null
  const dragStart = (event: DragEvent<HTMLButtonElement>) => {
    if (disabled) { event.preventDefault(); return }
    dragged.current = true
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData('application/json', JSON.stringify(template))
    setMediaDragData(template)
    onOpen()
  }
  const insert = () => {
    if (disabled || dragged.current) return
    const project = useProjectStore.getState().currentProject
    if (!project) return
    const { items, tracks } = useItemsStore.getState()
    const selection = useSelectionStore.getState()
    const from = Math.max(0, Math.round(usePlaybackStore.getState().currentFrame))
    const fps = project.metadata.fps
    const music = items.find((item) => item.type === 'audio' && item.trackId === 'music' && item.from <= from && item.from + item.durationInFrames > from)
    if (!music) { toast.error('请先将播放头移到主音乐覆盖的范围内'); return }
    const durationInFrames = Math.min(Math.round(fps * 1.5), music.from + music.durationInFrames - from)
    if (durationInFrames < Math.ceil(fps * .38)) { toast.error('音乐剩余不足 0.38 秒，请向前移动播放头'); return }
    const preferred = selection.activeTrackId || items.find((item) => selection.selectedItemIds.includes(item.id))?.trackId || 'picture'
    const candidates = tracks.filter((track) => !track.locked && !track.isGroup && track.visible !== false && isTrackCompatibleWithItemType(track, items, 'controller'))
      .sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred) || a.order - b.order)
    const availableTrack = candidates.find((track) => !items.some((item) => item.trackId === track.id && item.from < from + durationInFrames && item.from + item.durationInFrames > from))
    const createTrack = !availableTrack
    const track = availableTrack ?? { id: crypto.randomUUID(), name: 'jev匹配', kind: 'video' as const, order: Math.min(0, ...tracks.map((t) => t.order)) - 1, height: 64, locked: false, visible: true, muted: false, solo: false, items: [] }
    const item = createTimelineTemplateItem({ template, placement: { trackId: track.id, from, durationInFrames, canvasWidth: project.metadata.width, canvasHeight: project.metadata.height, fps } })
    useTimelineCommandStore.getState().execute({ type: 'ADD_ITEM', payload: { itemId: item.id } }, () => {
      if (createTrack) useItemsStore.getState().setTracks([...tracks, track])
      useItemsStore.getState()._addItems([item])
      useTimelineSettingsStore.getState().markDirty()
    })
    usePlaybackStore.getState().pause()
    selection.setActiveTool('select')
    selection.selectItems([item.id])
    onOpen()
  }
  return <Button
    type="button" variant="outline" size="sm"
    className="jev-controls jev-match-tool h-7 shrink-0 gap-1 border-primary/50 bg-primary/10 px-2 text-xs text-primary hover:bg-primary/20 cursor-grab active:cursor-grabbing"
    disabled={disabled} draggable={!disabled}
    onPointerDown={() => { dragged.current = false }}
    onKeyDown={() => { dragged.current = false }}
    onDragStart={dragStart} onDragEnd={clearMediaDragData} onClick={insert}
    aria-label="jev匹配：拖入时间轴或点击在播放头添加"
    data-tooltip={compositionId !== null ? '请先返回主时间轴' : '拖到视频轨道空位；也可点击，在播放头添加占位节点'}
  ><GripVertical size={12} aria-hidden="true" /><Crosshair size={13} aria-hidden="true" />jev匹配</Button>
}
