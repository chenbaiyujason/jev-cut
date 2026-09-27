import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { usePlaybackStore } from '@/shared/state/playback'
import { studioRequest } from './api'
import { changeDirectorClip } from './bridge'

type Candidate = { shotId: string; visual: string; similarity: number; preview?: string }
type Decision = {
  id: string
  index: number
  time: [number, number]
  role: string
  chosen: Candidate
  retrievalTop: Candidate
  differentFromRetrieval: boolean
  alternatives: Candidate[]
  winnow: { ms: number }
  policy: Record<string, { choice?: string }>
  globalEntryPolicy?: { choice?: string }
}
type Report = {
  available?: boolean
  revision: number
  summary: {
    clips: number
    differentFromRetrieval: number
    sourceSounds: number
    transitions: number
    effects: number
    voice?: { time: [number, number]; line: string }
  }
  trace: Decision[]
}
type Trial = {
  applied: boolean
  changed: boolean
  ms: number
  model: string
  selected: Candidate
  totalMs?: number
  stateAppliedMs?: number
  frameConfirmed?: boolean
  searchScope?: { eligible: number; episodes: number[] }
  traceUrl?: string
}
const roles: Record<string, string> = {
  clock: '时间钩子',
  rescue: '实际救援',
  bond: '关系动机',
  promise: '承诺',
  loss: '受阻与失去',
  retry: '重试与抵抗',
  resolve: '未竟的决心',
}

export function DecisionPanel({ revision }: { revision: number }) {
  const [report, setReport] = useState<Report | null>(null)
  const [index, setIndex] = useState(0)
  const [prompt, setPrompt] = useState('更忧郁，更珍惜她，保护对象不变')
  const [trial, setTrial] = useState<Trial | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const trialAbort = useRef<AbortController | null>(null)
  useEffect(() => () => trialAbort.current?.abort(), [])
  useEffect(() => {
    const abort = new AbortController()
    void studioRequest<Report>('studio/director/trace', { signal: abort.signal })
      .then((data) => {
        setReport(data)
        setError('')
      })
      .catch((e: unknown) => {
        if (!abort.signal.aborted) setError(e instanceof Error ? e.message : '读取失败')
      })
    return () => abort.abort()
  }, [revision])
  const row = report?.trace?.[index]
  const voiceAtRow =
    row &&
    report?.summary.voice &&
    row.time[0] < report.summary.voice.time[1] &&
    row.time[1] > report.summary.voice.time[0]
  if (error && !row)
    return (
      <div className="mad-error" role="alert">
        {error}
      </div>
    )
  if (!row)
    return (
      <div className="mad-decision-panel">
        {report?.available === false ? '还没有主线剪辑的决策记录。' : '读取决策记录…'}
      </div>
    )
  return (
    <div className="mad-decision-panel" aria-label="jev剪辑 决策依据">
      <div className="mad-decision-heading">
        <div>
          <strong>RAG 找证据，jev剪辑 决定此刻怎样使用</strong>
          <p>
            {report!.summary.clips} 个镜头中，{report!.summary.differentFromRetrieval}{' '}
            次选择不同于同一候选池中检索相似度最高的素材。差异记录不代表自动证明审美优越。
          </p>
        </div>
        <label>
          查看镜头
          <select
            aria-label="查看镜头决策"
            disabled={busy}
            value={index}
            onChange={(e) => {
              setIndex(Number(e.target.value))
              setTrial(null)
              setError('')
            }}
          >
            {report!.trace.map((r, i) => (
              <option key={r.id} value={i}>
                {String(i + 1).padStart(2, '0')} · {r.time[0].toFixed(2)}s ·{' '}
                {roles[r.role] || r.role}
              </option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const p = usePlaybackStore.getState()
            p.pause()
            p.setCurrentFrame(Math.round(row.time[0] * 30))
          }}
        >
          定位到这段
        </Button>
      </div>
      <div className="mad-decision-comparison">
        <article>
          <span>仅按检索相似度排列</span>
          {row.retrievalTop.preview ? (
            <img src={row.retrievalTop.preview} alt="检索候选的范围参考帧" loading="lazy" />
          ) : null}
          <p>{row.retrievalTop.visual}</p>
          <small>相似度 {row.retrievalTop.similarity.toFixed(3)}</small>
        </article>
        <article className="mad-winnow-pick">
          <span>生成时的 jev剪辑 选择 · {roles[row.role]}</span>
          {row.chosen.preview ? (
            <img src={row.chosen.preview} alt="jev剪辑 所选素材的范围参考帧" loading="lazy" />
          ) : null}
          <p>{row.chosen.visual}</p>
          <small>
            {row.time[0].toFixed(2)}–{row.time[1].toFixed(2)} 秒 · 本次选镜{' '}
            {Math.round(row.winnow.ms)} ms
          </small>
          <p>
            <small>
              插入决策：
              {voiceAtRow
                ? '保留完整台词，配乐让位'
                : row.policy.sound?.choice === 'keep'
                  ? '保留动作原声'
                  : '配乐为主'}{' '}
              ·{' '}
              {row.policy.effect?.choice === 'impact'
                ? '重音推近'
                : row.policy.effect?.choice === 'push'
                  ? '轻微推近'
                  : '不叠加冲击效果'}{' '}
              ·{' '}
              {{
                hard: '硬切',
                dissolve: '短叠化',
                dipToColorDissolve: '短压暗',
                blurDissolve: '模糊叠化',
              }[row.globalEntryPolicy?.choice || row.policy.entry?.choice || 'hard'] || '硬切'}
            </small>
          </p>
        </article>
        <article>
          <span>局部情绪编辑</span>
          <p>每次都重新搜索全部剧集，再比较实际裁剪画面。带原声或台词的镜头请用选区编辑处理。</p>
          <input
            aria-label="试算情绪要求"
            disabled={busy}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            maxLength={500}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !prompt.trim()}
            onClick={() => {
              setBusy(true)
              setError('')
              const abort = new AbortController()
              trialAbort.current = abort
              void studioRequest<Trial>('studio/director/preview-change', {
                method: 'POST',
                signal: abort.signal,
                body: JSON.stringify({ baseRevision: revision, occurrenceId: row.id, prompt }),
              })
                .then(setTrial)
                .catch((e: unknown) => {
                  if (!abort.signal.aborted) setError(e instanceof Error ? e.message : '试算失败')
                })
                .finally(() => setBusy(false))
            }}
          >
            {busy ? 'jev剪辑 决策中…' : '试算新选择'}
          </Button>
          <Button
            size="sm"
            disabled={busy || !prompt.trim()}
            onClick={() => {
              setBusy(true)
              setError('')
              setTrial(null)
              void changeDirectorClip(row.id, prompt)
                .then((result) => setTrial({ ...result, ms: result.timing.modelMs }))
                .catch((e: unknown) => setError(e instanceof Error ? e.message : '局部修改失败'))
                .finally(() => setBusy(false))
            }}
          >
            {busy ? '决策处理中…' : 'jev剪辑 决定并替换'}
          </Button>
          {trial ? (
            <p role="status">
              {trial.applied ? '已替换为：' : trial.changed ? '建议换为：' : '保留当前选择：'}
              {trial.selected.visual}
              <br />
              <small>
                决策耗时 {Math.round(trial.ms)} ms ·{' '}
                {trial.applied
                  ? trial.frameConfirmed
                    ? `点击到画面 ${Math.round(trial.totalMs!)} ms · 可撤销`
                    : `时间轴已更新，预览尚未确认 · 可撤销`
                  : '未修改时间轴'}
                {trial.searchScope
                  ? ` · 全库 ${trial.searchScope.eligible} 镜头 / ${trial.searchScope.episodes.length} 集`
                  : ''}
              </small>
              {trial.traceUrl ? (
                <>
                  <br />
                  <a href={trial.traceUrl} target="_blank" rel="noreferrer">
                    本次全库范围、候选图片与完整决策
                  </a>
                </>
              ) : null}
            </p>
          ) : null}
          {error ? <p role="alert">{error}</p> : null}
        </article>
      </div>
      <small>
        记录对应生成版本 v{report!.revision}
        {revision !== report!.revision
          ? '；当前工程已有后续修改，以上显示生成时的决定。'
          : '。'}{' '}
        参考图展示安全镜头范围，实际入出点请看时间轴。
      </small>
    </div>
  )
}
