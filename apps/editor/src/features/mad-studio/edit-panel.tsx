import { useEffect, useRef, useState } from 'react'
import {
  Sparkles,
  ChevronDown,
  ArrowRight,
  SlidersHorizontal,
  History,
  PencilLine,
  X,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { DecisionPanel } from './decision-panel'
import { jevText } from './jev-label'
import { Button } from '@/components/ui/button'
import { useSelectionStore } from '@/shared/state/selection'
import { usePlaybackStore } from '@/shared/state/playback'
import { useMarkersStore } from '@/features/timeline/stores/markers-store'
import { useItemsStore } from '@/features/timeline/stores/items-store'
import { useProjectStore } from '@/features/projects/stores/project-store'
import { studioRequest } from './api'
import {
  runScopedDirectorEdit,
  useMadBridge,
  type DirectorProgress,
  type ScopedEditResult,
} from './bridge'

type Settings = {
  goal: string
  versions: Array<{ id: string; name: string }>
  voiceSeparation: { ready: boolean; reason: string }
}
export function EditPanel() {
  const [goal, setGoal] = useState('')
  const [prompt, setPrompt] = useState('')
  const [scope, setScope] = useState('auto')
  const [audio, setAudio] = useState('preserve')
  const [shots, setShots] = useState(true)
  const [effects, setEffects] = useState(true)
  const [transitions, setTransitions] = useState(true)
  const [grade, setGrade] = useState(true)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [job, setJob] = useState<DirectorProgress | null>(null)
  const result = useMadBridge((s) => s.lastScopedResult)
  const setResult = (value: ScopedEditResult | null) =>
    useMadBridge.setState({ lastScopedResult: value })
  const [mode, setMode] = useState<'replace' | 'optimize'>('replace')
  const [recordsOpen, setRecordsOpen] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const mounted = useRef(true)
  const selectedIds = useSelectionStore((s) => s.selectedItemIds)
  const inPoint = useMarkersStore((s) => s.inPoint)
  const outPoint = useMarkersStore((s) => s.outPoint)
  const items = useItemsStore((s) => s.items)
  const name = useProjectStore((s) => s.currentProject?.name)
  const fps = useProjectStore((s) => s.currentProject?.metadata.fps) || 30
  const pending = useMadBridge((s) => s.pending)
  const conflict = useMadBridge((s) => s.conflict)
  const bridgeError = useMadBridge((s) => s.error)
  const revision = useMadBridge((s) => s.revision)
  const chosen = items.filter((i) => i.type === 'video' && selectedIds.includes(i.id))
  const last = Math.max(0, ...items.map((i) => i.from + i.durationInFrames))
  const validRange = inPoint !== null && outPoint !== null && outPoint > inPoint && outPoint <= last
  const resolvedScope =
    scope === 'auto'
      ? chosen.length
        ? validRange
          ? 'intersection'
          : 'selection'
        : validRange
          ? 'range'
          : 'selection'
      : scope
  const valid =
    resolvedScope === 'all' ||
    resolvedScope === 'after' ||
    (resolvedScope === 'selection' && chosen.length > 0) ||
    (resolvedScope === 'range' && validRange) ||
    (resolvedScope === 'intersection' &&
      validRange &&
      chosen.some((i) => i.from < outPoint! && i.from + i.durationInFrames > inPoint!))
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    const abort = new AbortController()
    void studioRequest<Settings>('studio/director/settings', { signal: abort.signal })
      .then((s) => {
        setSettings(s)
        setGoal(s.goal)
      })
      .catch((e: unknown) => {
        if (!abort.signal.aborted) setError(e instanceof Error ? e.message : '读取失败')
      })
    return () => abort.abort()
  }, [name])
  const run = (operation: 'replace' | 'optimize') => {
    setError('')
    setResult(null)
    setJob(null)
    setLoading(true)
    void runScopedDirectorEdit(
      {
        goal,
        prompt,
        operation,
        audioMode: audio,
        allowed: { shots: operation === 'replace' && shots, effects, transitions, grade },
        scope: {
          mode: resolvedScope,
          selectedIds: [...selectedIds],
          in: inPoint,
          out: outPoint,
          cursor: usePlaybackStore.getState().currentFrame,
        },
      },
      (j) => {
        if (mounted.current) setJob(j)
      },
    )
      .then((r) => {
        if (mounted.current) setResult(r)
      })
      .catch((e: unknown) => {
        if (mounted.current) setError(e instanceof Error ? e.message : '修改失败')
      })
      .finally(() => {
        if (mounted.current) setLoading(false)
      })
  }
  useEffect(() => {
    if (!result || revision !== result.state.revision) return
    const ids = new Set(result.changedVideoIds)
    const nodes = [
      ...document.querySelectorAll<HTMLElement>('[data-timeline-item][data-item-id]'),
    ].filter((n) => ids.has(n.dataset.itemId || ''))
    nodes.forEach((n) => n.classList.add('jev-changed'))
    const clear = () => nodes.forEach((n) => n.classList.remove('jev-changed'))
    const timer = setTimeout(clear, 5000)
    return () => {
      clearTimeout(timer)
      clear()
    }
  }, [result, revision])
  const rangeText = validRange
    ? [(inPoint! / fps).toFixed(2), (outPoint! / fps).toFixed(2)].join('–') + ' 秒'
    : '未设置入出点'
  const scopeText =
    resolvedScope === 'all'
      ? '整条时间轴'
      : resolvedScope === 'after'
        ? '当前游标之后'
        : resolvedScope === 'selection'
          ? chosen.length
            ? '已选 ' + chosen.length + ' 个镜头'
            : '尚未选择范围'
          : resolvedScope === 'intersection'
            ? '已选 ' + chosen.length + ' 个镜头 ∩ ' + rangeText
            : rangeText
  const busy = pending || loading
  return (
    <section className="jev-edit-panel jev-controls" aria-label="jev剪辑编辑面板">
      <div className="jev-panel-scroll">
        <details className="jev-goal">
          <summary>
            <span className="jev-label">全片目标</span>
            <span className="jev-goal-text">{goal || '设置创作目标'}</span>
            <PencilLine size={12} />
          </summary>
          <textarea
            aria-label="全片剪辑目标"
            value={goal}
            rows={2}
            maxLength={1000}
            disabled={busy}
            onChange={(e) => setGoal(e.target.value)}
            onBlur={() => {
              void studioRequest('studio/director/settings', {
                method: 'PUT',
                body: JSON.stringify({ goal }),
              }).catch(() => setError('目标保存失败，请重试'))
            }}
          />
        </details>
        <label className="jev-request">
          <span className="jev-label">本次想怎么改</span>
          <textarea
            aria-label="本次修改要求"
            value={prompt}
            maxLength={1000}
            rows={3}
            disabled={busy}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="更冷峻一点，让眼神接上时间装置…"
          />
        </label>
        <div className="jev-mode" role="group" aria-label="编辑方式">
          <button
            type="button"
            aria-pressed={mode === 'replace'}
            disabled={busy}
            onClick={() => setMode('replace')}
          >
            换镜头
          </button>
          <button
            type="button"
            aria-pressed={mode === 'optimize'}
            disabled={busy}
            onClick={() => setMode('optimize')}
          >
            优化表现
          </button>
        </div>
        <details className="jev-scope">
          <summary>
            <span>
              <span className="jev-label">作用范围</span>
              <strong>{scopeText}</strong>
            </span>
            <ChevronDown size={13} />
          </summary>
          <label>
            使用范围
            <select
              aria-label="修改作用范围"
              value={scope}
              disabled={busy}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="auto">跟随时间轴选择</option>
              <option value="selection">选中片段</option>
              <option value="range">入点到出点</option>
              <option value="intersection">选中片段 ∩ 入出点</option>
              <option value="after">当前游标之后</option>
              <option value="all">整条时间轴</option>
            </select>
          </label>
          <div className="jev-time-fields">
            <label>
              入点 / 秒
              <input
                aria-label="编辑入点秒"
                type="number"
                min={0}
                max={last / fps}
                step={1 / fps}
                value={inPoint === null ? '' : Number((inPoint / fps).toFixed(3))}
                disabled={busy}
                onChange={(e) =>
                  useMarkersStore
                    .getState()
                    .setInPoint(
                      e.target.value === '' ? null : Math.round(Number(e.target.value) * fps),
                    )
                }
              />
            </label>
            <ArrowRight size={12} />
            <label>
              出点 / 秒
              <input
                aria-label="编辑出点秒"
                type="number"
                min={0}
                max={last / fps}
                step={1 / fps}
                value={outPoint === null ? '' : Number((outPoint / fps).toFixed(3))}
                disabled={busy}
                onChange={(e) =>
                  useMarkersStore
                    .getState()
                    .setOutPoint(
                      e.target.value === '' ? null : Math.round(Number(e.target.value) * fps),
                    )
                }
              />
            </label>
          </div>
          <p className="jev-hint">也可以直接在时间轴选镜头、设置入出点。未选中的内容保持不变。</p>
        </details>
        <details className="jev-options">
          <summary>
            <SlidersHorizontal size={13} />
            <span>调整选项</span>
            <small>
              {[effects && '重音', transitions && '转场', grade && '调色']
                .filter(Boolean)
                .join(' · ') || '仅选镜'}
            </small>
            <ChevronDown size={13} />
          </summary>
          <div className="jev-option-grid">
            {(
              [
                ['更换镜头', shots, setShots],
                ['重音效果', effects, setEffects],
                ['转场', transitions, setTransitions],
                ['调色', grade, setGrade],
              ] as const
            ).map(([label, value, setter]) => (
              <label key={label}>
                <input
                  type="checkbox"
                  checked={value}
                  disabled={busy || (label === '更换镜头' && mode === 'optimize')}
                  onChange={(e) => setter(e.target.checked)}
                />
                {label}
              </label>
            ))}
          </div>
          <label className="jev-audio-label">
            原声
            <select
              aria-label="原声使用模式"
              value={audio}
              disabled={busy}
              onChange={(e) => setAudio(e.target.value)}
            >
              <option value="preserve">保留现有声音</option>
              <option value="mute">关闭选区原声</option>
              <option value="auto">自动挑选</option>
              <option value="original">启用完整原声</option>
              <option value="sfx">无对白的动作原声</option>
              <option value="voice" disabled>
                仅人声（尚未接入）
              </option>
            </select>
          </label>
          <p className="jev-hint">
            保留切点与总时长。{settings?.voiceSeparation.ready ? '' : '纯人声分离尚未接入。'}
          </p>
        </details>
        {error || bridgeError ? (
          <p className="jev-error" role="alert">
            {jevText(error || bridgeError || '')}
          </p>
        ) : null}
        {result ? (
          <div className="jev-result">
            <span>
              {revision !== result.state.revision ? '上次运行' : '已完成'} ·{' '}
              {result.changedVideoIds.length} 个镜头已调整
            </span>
            <strong>{((result.visibleMs || result.timing.totalMs) / 1000).toFixed(2)}s</strong>
            {!result.visibleMs ? <small>服务端耗时</small> : null}
          </div>
        ) : null}
        <button className="jev-record-link" type="button" onClick={() => setRecordsOpen(true)}>
          <History size={13} />
          {result ? '查看本轮决策' : '查看剪辑记录'}
          <ArrowRight size={12} />
        </button>
      </div>
      <div className="jev-panel-footer">
        <p className="jev-hint">
          {loading
            ? jevText(job?.phase || '准备中…')
            : !valid
              ? '先选择镜头或设置入出点'
              : mode === 'optimize'
                ? '保留画面，优化效果与声音'
                : '按目标选镜，可一次撤销'}
          {loading && job?.total ? ' (' + job.done + '/' + job.total + ')' : ''}
        </p>
        {loading && job?.total ? <progress max={job.total} value={job.done} /> : null}
        <div className="jev-submit-row">
          <Button
            className="jev-submit"
            disabled={!valid || pending || loading || conflict}
            onClick={() => run(mode)}
          >
            <Sparkles size={14} />
            {loading ? '处理中…' : resolvedScope === 'all' ? '应用到全片' : '应用到选区'}
            <ArrowRight size={14} />
          </Button>
          {loading && job?.id && job.status === 'running' ? (
            <Button
              variant="outline"
              size="icon"
              aria-label="取消本轮"
              onClick={() => {
                void studioRequest('studio/director/cancel', {
                  method: 'POST',
                  body: JSON.stringify({ id: job.id }),
                }).catch((e: unknown) => setError(e instanceof Error ? e.message : '取消失败'))
              }}
            >
              <X size={14} />
            </Button>
          ) : null}
        </div>
      </div>
      <Dialog open={recordsOpen} onOpenChange={setRecordsOpen}>
        <DialogContent
          className="jev-records-drawer jev-controls"
          overlayClassName="jev-records-overlay"
        >
          <DialogHeader>
            <DialogTitle>jev剪辑 · 决策记录</DialogTitle>
            <DialogDescription>
              查看候选、实际选择与耗时。编辑画面与时间轴保持原位。
            </DialogDescription>
          </DialogHeader>
          <div className="jev-records-scroll">
            {result ? (
              <>
                <p>
                  模型 {(result.timing.modelMs / 1000).toFixed(2)}s · 服务端{' '}
                  {(result.timing.totalMs / 1000).toFixed(2)}s
                  {result.visibleMs
                    ? ' · 新画面 ' + (result.visibleMs / 1000).toFixed(2) + 's'
                    : ''}
                </p>
                {result.notes.map((n, i) => (
                  <p key={i}>{jevText(n.reason)}</p>
                ))}
                {result.decisions.map((d, i) => (
                  <details key={i}>
                    <summary>
                      {jevText(d.stage)} · {Math.round(d.ms)}ms ·{' '}
                      {Object.entries(d.output.answers)
                        .map(([k, v]) => k + ': ' + v.choice)
                        .join(' / ')}
                    </summary>
                    {d.searchScope ? (
                      <p>
                        本镜独立搜索全部 {d.searchScope.eligible} 个镜头、
                        {d.searchScope.episodes.length} 集
                      </p>
                    ) : null}
                    {d.traceUrl ? (
                      <a href={d.traceUrl} target="_blank" rel="noreferrer">
                        查看全部候选与实际窗口图片
                      </a>
                    ) : null}
                    <pre>{JSON.stringify({ input: d.input, output: d.output }, null, 2)}</pre>
                  </details>
                ))}
                <details>
                  <summary>生成时的选镜记录</summary>
                  <DecisionPanel revision={revision} />
                </details>
              </>
            ) : (
              <DecisionPanel revision={revision} />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}
