import { useLayoutEffect, useRef } from 'react'
import type { TextItem } from '@/types/timeline'
import { useSequenceContext } from '@/runtime/composition-runtime/deps/player'
import { useVideoConfig } from '@/runtime/composition-runtime/hooks/use-player-compat'
import { renderJizuraFrame } from './renderer'

/** DOM preview fallback. The canonical canvas renderer uses the same paint function. */
export function JizuraContent({ item }: { item: TextItem & { _sequenceFrameOffset?: number } }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const sequence = useSequenceContext()
  const { fps, width, height } = useVideoConfig()
  const frame = (sequence?.localFrame ?? 0) - (item._sequenceFrameOffset ?? 0)
  useLayoutEffect(() => {
    let cancelled = false
    const target = canvas.current
    if (!target) return
    const w = Math.max(2, Math.round(item.transform?.width ?? width))
    const h = Math.max(2, Math.round(item.transform?.height ?? height))
    const buffer = document.createElement('canvas')
    buffer.width = w; buffer.height = h
    const ctx = buffer.getContext('2d')!
    void renderJizuraFrame(ctx, item, frame, fps, { x: 0, y: 0, width: w, height: h }).then(() => {
      if (cancelled) return
      target.width = w; target.height = h
      target.getContext('2d')?.drawImage(buffer, 0, 0)
    })
    return () => { cancelled = true }
  }, [item, frame, fps, width, height])
  return <canvas ref={canvas} aria-label={`JIZURA ${item.text}`} style={{ width: '100%', height: '100%', display: 'block' }} />
}
