type Presentation = { frame: number; atMs: number; fallback: boolean }
const listeners = new Set<(event: Presentation) => void>()

/** Called only after the preview front buffer has actually been drawn. */
export function notifyPreviewPresentation(frame: number, fallback: boolean): void {
  if (!listeners.size) return
  const event = { frame, fallback, atMs: performance.now() }
  for (const listener of listeners) listener(event)
}

export function waitForPreviewPresentation(
  frame: number,
  timeoutMs = 8000,
): Promise<number | null> {
  return new Promise((resolve) => {
    const cleanup = () => {
      clearTimeout(timer)
      listeners.delete(onFrame)
    }
    const onFrame = (event: Presentation) => {
      if (event.frame !== frame || event.fallback) return
      cleanup()
      // The front buffer is ready; allow the browser to paint that buffer.
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())))
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve(null)
    }, timeoutMs)
    listeners.add(onFrame)
  })
}
