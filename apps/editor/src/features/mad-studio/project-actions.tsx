import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useItemsStore } from '@/features/timeline/stores/items-store'
import { useMediaLibraryStore } from '@/features/media-library/stores/media-library-store'
import { useProjectStore } from '@/features/projects/stores/project-store'
import { useSelectionStore } from '@/shared/state/selection'
import { saveTimeline } from '@/features/timeline/stores/timeline-persistence'
import { uploadMadMusic } from './music-upload'
import { regenerateCurrentMusic, useMadBridge } from './bridge'

export function ProjectActions({ goal, connected = true }: { goal: string; connected?: boolean }) {
  const items = useItemsStore(s => s.items)
  const media = useMediaLibraryStore(s => s.mediaItems)
  const selectedIds = useSelectionStore(s => s.selectedItemIds)
  const fps = useProjectStore(s => s.currentProject?.metadata.fps) || 30
  const audio = items.filter(i => i.type === 'audio')
  const [basisId, setBasisId] = useState('')
  const main = audio.find(i => i.id === basisId) || audio.find(i => i.trackId === 'music') || (audio.length === 1 ? audio[0] : undefined)
  const selectedAudio = audio.filter(i => selectedIds.includes(i.id))
  const [phase, setPhase] = useState('')
  const [error, setError] = useState('')
  const [working, setWorking] = useState(false)
  const pending = useMadBridge(s => s.pending)
  const autoExtend = useMadBridge(s => s.autoExtend)
  const playWhileGenerating = useMadBridge(s => s.playWhileGenerating)
  const busy = working || (connected && pending)
  const run = async (mode: 'append' | 'rebuild') => {
    if (!main) return
    setWorking(true); setError('')
    try {
      if (connected) await regenerateCurrentMusic(mode, goal, main.id)
      else {
        const metadata = media.find(m => m.id === main.mediaId)
        if (!metadata) throw new Error('请重新连接这条音轨的素材')
        const { mediaLibraryService } = await import('@/features/media-library/services/media-library-service')
        const blob = await mediaLibraryService.getMediaFile(metadata)
        if (!blob) throw new Error('请重新连接这段音频文件')
        const project = useProjectStore.getState().currentProject
        if (project) await saveTimeline(project.id)
        const result = await uploadMadMusic(new File([blob], metadata.fileName, { type: metadata.mimeType }), setPhase, new AbortController().signal)
        sessionStorage.setItem('jev-music-start', JSON.stringify({ musicId: result.selected.id, prompt: goal, duration: main.durationInFrames / fps, musicStart: (main.sourceStart || 0) / (main.sourceFps || fps), musicFrom: main.from / fps, musicRate: main.speed || 1, musicVolume: main.volume }))
        window.location.assign('/mad')
      }
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败') }
    finally { setWorking(false) }
  }
  return <div className="jev-project-actions">
    <p className="jev-hint">{main ? `跟随音轨：${main.label || media.find(m => m.id === main.mediaId)?.fileName || '当前音频'} · ${(main.from / fps).toFixed(1)}–${((main.from + main.durationInFrames) / fps).toFixed(1)} 秒` : '先在时间轴拖入音频；多条音频时，选中剪辑主轴。'}</p>
    {selectedAudio.length === 1 && selectedAudio[0]?.id !== main?.id ? <Button variant="outline" disabled={busy} onClick={() => setBasisId(selectedAudio[0]!.id)}>用所选音轨作为剪辑主轴</Button> : null}
    <Button disabled={busy || !main} onClick={() => { void run('rebuild') }}>{working ? phase || '准备中…' : items.some(i => i.type === 'video') && connected ? '重算全片' : '开始剪辑'}</Button>
    {connected ? <>
      <Button variant="outline" disabled={busy || !main} onClick={() => { void run('append') }}>补齐后续</Button>
      <label><input type="checkbox" checked={autoExtend} onChange={e => useMadBridge.setState({ autoExtend: e.target.checked })} /> 延长主音轨后自动补镜</label>
      <label><input type="checkbox" checked={playWhileGenerating} onChange={e => useMadBridge.setState({ playWhileGenerating: e.target.checked })} /> 边播边生成，等待时循环当前镜头</label>
      <p className="jev-hint">范围直接取自实际音轨。全片重算不受选区限制；下方按钮只修改选区。</p>
    </> : <p className="jev-hint">按实际音轨的起点、长度和裁剪范围开始。当前项目先保存，然后进入自动剪辑工作台。</p>}
    {error ? <p role="alert" className="jev-error">{error}</p> : null}
  </div>
}
