import { useEffect, useState } from 'react'
import { ChevronDown, Film, Music2, RefreshCw, Sparkles } from 'lucide-react'
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

export function JevToolbar({ active, onOpen }: { active: boolean; onOpen: () => void }) {
  const bridge = useMadBridge()
  return (
    <div className="jev-toolbar jev-controls">
      <span
        className={'jev-save-state' + (bridge.error ? ' is-error' : '')}
        role="status"
        title={`${jevText(bridge.phase)} · v${bridge.revision}`}
      >
        <i />
        {bridge.generationId ? bridge.phase : bridge.pending ? '处理中' : bridge.error ? '需要同步' : '已同步'}
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
  const [music, setMusic] = useState<Array<{ id: string; name: string; duration: number }>>([]),
    [musicId, setMusicId] = useState(''),
    [duration, setDuration] = useState(30),
    [prompt, setPrompt] = useState(''),
    [ready, setReady] = useState(false),
    [error, setError] = useState('')
  const pending = useMadBridge((s) => s.pending),
    conflict = useMadBridge((s) => s.conflict)
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
        if (!pending) onOpenChange(v)
      }}
    >
      <DialogContent className="jev-controls jev-music-dialog">
        <DialogHeader>
          <DialogTitle>从音乐新建剪辑</DialogTitle>
          <DialogDescription>从空时间轴开始，先铺音乐，再看镜头逐个出现。当前编辑会先保存，可撤销。</DialogDescription>
        </DialogHeader>
        <label>
          配乐
          <select
            aria-label="新剪辑配乐"
            value={musicId}
            disabled={pending}
            onChange={(e) => {
              setMusicId(e.target.value)
              setDuration(Math.min(30, music.find((m) => m.id === e.target.value)?.duration || 30))
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
          disabled={!ready || pending || conflict || !musicId || !Number.isFinite(duration) || duration < 5 || duration > Math.min(300, music.find(m => m.id === musicId)?.duration || 300)}
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
