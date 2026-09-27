import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Film, Music2, RefreshCw, Sparkles, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { useProjectStore } from '@/features/projects/stores/project-store'
import { studioRequest } from './api'
import { cancelMadGeneration, generateMad, loadDirectorVersion, refreshMadProject, useMadBridge } from './bridge'

import { jevText } from './jev-label'
import { uploadMadMusic, type MadMusic } from './music-upload'

export function JevToolbar({ active, onOpen }: { active: boolean; onOpen: () => void }) {
  const bridge = useMadBridge()
  return (
    <div className="jev-toolbar jev-controls">
      <span
        className={'jev-save-state' + (bridge.error ? ' is-error' : '')}
        role="status"
        title={`${jevText(bridge.phase)} · v${bridge.revision}`}
      >
        {bridge.generationId || bridge.pending ? <LoaderCircle size={13} className="jev-generating-spinner" aria-hidden="true" /> : <i />}
        {bridge.error ? '需要同步' : bridge.phase || '已同步'}
        {bridge.generationId && bridge.waitingForClip ? ' · 循环等待' : ''}
      </span>
      {bridge.generationId ? (
        <Button size="sm" variant="outline" onClick={() => { void cancelMadGeneration().catch(() => useMadBridge.setState({ error: '停止请求失败，请重试' })) }}>
          停止生成并保留
        </Button>
      ) : null}
      <Button
        size="sm"
        variant={active ? 'secondary' : 'ghost'}
        className="jev-open-button"
        onClick={onOpen}
        aria-label="打开jev剪辑"
        aria-pressed={active}
      >
        <Sparkles size={14} />
        jev剪辑
      </Button>
    </div>
  )
}

export function JevProjectMenu() {
  const [open, setOpen] = useState(false),
    [musicOpen, setMusicOpen] = useState(false),
    [versions, setVersions] = useState<Array<{ id: string; name: string }>>([]),
    [error, setError] = useState('')
  const pending = useMadBridge((s) => s.pending),
    conflict = useMadBridge((s) => s.conflict)
  useEffect(() => {
    const abort = new AbortController()
    void studioRequest<{ versions: Array<{ id: string; name: string }> }>(
      'studio/director/settings',
      { signal: abort.signal },
    )
      .then((s) => setVersions(s.versions))
      .catch((e: unknown) => {
        if (!abort.signal.aborted) setError(e instanceof Error ? e.message : '版本读取失败')
      })
    return () => abort.abort()
  }, [])
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="jev-controls h-7 w-7"
            aria-label="项目与版本"
          >
            <ChevronDown size={14} />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="jev-project-menu jev-controls">
          <small>切换成片</small>
          {versions.map((v) => (
            <button
              key={v.id}
              disabled={pending || conflict}
              onClick={() => {
                setError('')
                void loadDirectorVersion(v.id)
                  .then(() => setOpen(false))
                  .catch((e: unknown) => setError(e instanceof Error ? e.message : '载入失败'))
              }}
            >
              <Film size={14} />
              {v.name}
            </button>
          ))}
          <div className="jev-menu-divider" />
          <button
            disabled={pending}
            onClick={() => {
              setOpen(false)
              setMusicOpen(true)
            }}
          >
            <Music2 size={14} />
            从音乐新建剪辑
          </button>
          <button
            disabled={pending}
            onClick={() => {
              void refreshMadProject().then(() => setOpen(false))
            }}
          >
            <RefreshCw size={14} />
            {conflict ? '保存草稿并同步' : '同步工程'}
          </button>
          {error ? <p role="alert">{error}</p> : null}
        </PopoverContent>
      </Popover>
      <MusicDialog open={musicOpen} onOpenChange={setMusicOpen} />
    </>
  )
}

function MusicDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const [music, setMusic] = useState<MadMusic[]>([]),
    [musicId, setMusicId] = useState(''),
    [duration, setDuration] = useState(20),
    [prompt, setPrompt] = useState(''),
    [ready, setReady] = useState(false),
    [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadPhase, setUploadPhase] = useState('')
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const uploadController = useRef<AbortController | null>(null)
  useEffect(() => () => uploadController.current?.abort(), [])
  const pending = useMadBridge((s) => s.pending),
    conflict = useMadBridge((s) => s.conflict)
  const importMusic = async (files: FileList | null) => {
    if (pending || uploading || !files?.length) return
    if (files.length !== 1) { setError('每次拖入一首配乐'); return }
    const file = files.item(0)
    if (!file) return
    const controller = new AbortController()
    uploadController.current?.abort()
    uploadController.current = controller
    setUploading(true)
    setError('')
    try {
      const result = await uploadMadMusic(file, setUploadPhase, controller.signal)
      setMusic(result.music)
      setMusicId(result.selected.id)
      setDuration(Math.min(20, Math.floor(result.selected.duration * 30) / 30))
      if (result.selected.duration < 5) setError('配乐不足 5 秒，请换一首更长的音频')
    } catch (error) {
      if (!controller.signal.aborted) { setError(error instanceof Error ? error.message : '导入失败'); setUploadPhase('') }
    } finally {
      if (!controller.signal.aborted) setUploading(false)
    }
  }
  useEffect(() => {
    if (!open) return
    const abort = new AbortController()
    void studioRequest<{ progressive: boolean }>('studio/generation/capabilities', { signal: abort.signal })
      .then((value) => { if (!abort.signal.aborted) setReady(value.progressive) })
      .catch(() => { if (!abort.signal.aborted) setReady(false) })
    void studioRequest<{ music: typeof music }>('state', { signal: abort.signal })
      .then((s) => {
        setMusic(s.music)
        const current = useProjectStore
          .getState()
          .currentProject?.timeline?.items.find((i) => i.trackId === 'music')?.mediaId
        setMusicId(current || s.music.at(-1)?.id || '')
      })
      .catch((e: unknown) => {
        if (!abort.signal.aborted) setError(e instanceof Error ? e.message : '读取失败')
      })
    return () => abort.abort()
  }, [open])
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!pending && !uploading) onOpenChange(v)
      }}
    >
      <DialogContent className="jev-controls jev-music-dialog">
        <DialogHeader>
          <DialogTitle>从音乐新建剪辑</DialogTitle>
          <DialogDescription>从空时间轴开始，先铺音乐，再看镜头逐个出现。当前编辑会先保存，可撤销。</DialogDescription>
        </DialogHeader>
        <div
          role="group"
          aria-label="配乐文件拖放区"
          className={'jev-music-drop' + (dragging ? ' is-dragging' : '')}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); if (!pending && !uploading) setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(false); void importMusic(e.dataTransfer.files) }}
        >
          <Music2 size={20} aria-hidden="true" />
          <span>拖入一首新音频</span>
          <small>MP3、WAV、M4A、FLAC 等 · 原片素材库自动复用</small>
          <Button type="button" variant="outline" disabled={pending || uploading} onClick={() => fileInput.current?.click()}>
            {uploading ? '正在导入…' : '选择音频文件'}
          </Button>
          <input ref={fileInput} type="file" hidden aria-label="导入配乐文件" accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.aif,.aiff,.wma" onChange={(e) => { void importMusic(e.target.files); e.target.value = '' }} />
          {uploadPhase ? <p role="status">{uploadPhase}</p> : null}
        </div>
        <label>
          配乐（也可选择已导入音频）
          <select
            aria-label="新剪辑配乐"
            value={musicId}
            disabled={pending || uploading}
            onChange={(e) => {
              setMusicId(e.target.value)
              setDuration(Math.min(20, music.find((m) => m.id === e.target.value)?.duration || 20))
            }}
          >
            {music.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          剪辑目标
          <input
            value={prompt}
            disabled={pending}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="由音乐决定节奏与情绪"
          />
        </label>
        <label>
          时长 / 秒
          <input
            type="number"
            min={5}
            max={300}
            value={duration}
            disabled={pending}
            onChange={(e) => setDuration(Number(e.target.value))}
          />
        </label>
        {error ? <p role="alert">{error}</p> : null}
        <Button
          disabled={!ready || pending || uploading || conflict || !musicId || !Number.isFinite(duration) || duration < 5 || duration > Math.min(300, music.find(m => m.id === musicId)?.duration || 300)}
          onClick={() => {
            onOpenChange(false)
            void generateMad(musicId, prompt, duration)
          }}
        >
          {!ready ? '等待剪辑服务更新' : pending ? '生成中…' : '从零开始生成'}
        </Button>
      </DialogContent>
    </Dialog>
  )
}
