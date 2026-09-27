import { useEffect, useState } from 'react'
import { Crosshair, LoaderCircle, WandSparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ControllerItem } from '@/types/timeline'
import { matchJevPlaceholder, useMadBridge, type JevMatchResult } from './bridge'

export function JevMatchPanel({
  placeholder,
  result,
  fps = 30,
}: {
  placeholder: ControllerItem | null
  result: JevMatchResult | null
  fps?: number
}) {
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useMadBridge((s) => s.pending)
  const conflict = useMadBridge((s) => s.conflict)
  const [visionEnabled, setVisionEnabled] = useState(false)
  useEffect(() => { setError('') }, [placeholder?.id])

  const run = async () => {
    if (!placeholder || busy || pending || conflict) return
    setBusy(true)
    setError('')
    try {
      await matchJevPlaceholder(placeholder.id, prompt.trim(), visionEnabled)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '匹配失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="jev-match-panel">
      <div className="jev-match-intro">
        <Crosshair size={18} aria-hidden="true" />
        <div>
          <strong>Jev 单镜匹配</strong>
          <p>结合全片目标、前后镜头和附近重音，从完整素材库选择动作窗口与时长。匹配会在占位范围内完成，后续镜头保持原来的卡点位置。</p>
        </div>
      </div>
      {placeholder ? (
        <div className="jev-match-slot">
          <span>匹配位置</span>
          <strong>{(placeholder.from / fps).toFixed(2)} 秒 · 预留 {(placeholder.durationInFrames / fps).toFixed(2)} 秒</strong>
        </div>
      ) : result ? null : (
        <p className="jev-hint">将时间轴左上角的“jev匹配”拖到视频轨道空位，或点击按钮在播放头添加。拖动占位节点右边缘可调整允许的最大时长。</p>
      )}
      <label className="jev-match-request">
        <span>可选：补充这一镜的意图</span>
        <textarea
          aria-label="jev匹配要求"
          value={prompt}
          maxLength={500}
          rows={3}
          disabled={!placeholder || busy || pending}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="留空时按全片目标和前后镜头自动匹配"
        />
      </label>
      <label className="jev-hint"><input type="checkbox" checked={visionEnabled} disabled={busy || pending} onChange={(event) => setVisionEnabled(event.target.checked)} /> 视觉复核（更适合姿势与构图衔接，耗时更长）</label>
      {conflict ? <p className="jev-error" role="alert">工程有未同步修改，请先通过项目菜单同步。</p> : null}
      <Button className="jev-match-submit" disabled={!placeholder || busy || pending || conflict} onClick={() => void run()}>
        {busy || pending ? <LoaderCircle size={14} className="jev-generating-spinner" /> : <WandSparkles size={14} />}
        {busy || pending ? '全库匹配中…' : '匹配并替换占位节点'}
      </Button>
      {error ? <p className="jev-error" role="alert">{error}</p> : null}
      {result ? (
        <div className="jev-match-result" role="status">
          <strong>{result.visual}</strong>
          <span>{result.durationSeconds.toFixed(2)} 秒 · {result.beatReason}</span>
          <span>模型累计 {(result.timing.modelMs / 1000).toFixed(2)} 秒 · 服务端 {(result.timing.totalMs / 1000).toFixed(2)} 秒{result.visibleMs ? ` · 回填 ${(result.visibleMs / 1000).toFixed(2)} 秒` : ''}</span>
          {result.remainingSeconds > 0 ? <span>占位区间剩余 {result.remainingSeconds.toFixed(2)} 秒空隙，可继续拖入匹配节点。</span> : null}
          <span>本次全库搜索 {result.scope.eligible.toLocaleString()} 镜头、{result.scope.episodes.length} 集</span>
          <a href={result.traceUrl} target="_blank" rel="noreferrer">查看候选与 Winnow 决策</a>
        </div>
      ) : null}
    </div>
  )
}
