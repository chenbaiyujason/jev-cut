import type { Project } from '@/types/project'
import type { MediaMetadata } from '@/types/storage'

export interface StudioMedia {
  mediaId: string
  url: string
  metadata: MediaMetadata
}

export interface StudioProject {
  revision: number
  project: Project
  media: StudioMedia[]
}

export class StudioApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(message)
  }
}

export function connectionRecoveryPhase(
  localRevision: number,
  serverRevision: number,
  localChanged: boolean,
): string {
  if (localChanged) return '连接已恢复 · 本地编辑待保存'
  return localRevision === serverRevision ? '工程已同步' : '连接已恢复 · 正在应用更新'
}

export async function studioRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/mad-api/${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new StudioApiError('本机剪辑服务暂时不可用，正在自动重连', 0, true)
  }
  let data: Record<string, unknown>
  try {
    data = JSON.parse(await response.text()) as Record<string, unknown>
  } catch {
    if (response.status === 409) throw new StudioApiError('工程版本已更新，本地编辑已保留', 409)
    throw new StudioApiError('本机服务暂时未返回完整数据，正在自动重连', response.status, true)
  }
  if (!response.ok) {
    if (response.status === 409) throw new StudioApiError('工程版本已更新，本地编辑已保留', 409)
    const transient = response.status >= 500 || response.status === 429 || response.status === 408
    const reason =
      typeof data.error === 'string' && /[\u4e00-\u9fff]/.test(data.error) ? data.error : null
    throw new StudioApiError(
      reason ||
        (transient
          ? '本机剪辑服务暂时繁忙，正在自动重试'
          : `操作未完成（服务状态 ${response.status}），本地编辑已保留`),
      response.status,
      transient,
    )
  }
  return data as T
}

/** Playback and viewport changes are not editorial changes. */
export function editorialSignature(project: Project): string {
  const timeline = project.timeline
  if (!timeline) return JSON.stringify([project.metadata, null])
  const { currentFrame: _frame, zoomLevel: _zoom, scrollPosition: _scroll, ...content } = timeline
  return JSON.stringify([project.name, project.metadata, content], (key, value: unknown) => {
    // Provenance is restored by the server after native serialization. It is
    // not a manual edit; key ordering must not turn an acknowledged save into
    // a false conflict after a lost HTTP response.
    if (key === 'mad') return undefined
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((name) => [name, record[name]]),
      )
    }
    return value
  })
}

export function sameOriginMediaUrl(value: string): string {
  const url = new URL(value, window.location.origin)
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/mad-media/')) {
    throw new Error('素材必须来自本机 MAD 媒体服务')
  }
  return url.href
}

/** The model changes the server project; never apply its result over a new local gesture. */
export async function requestAutomaticDirection(
  baseRevision: number,
  readLocalSignature: () => string,
): Promise<StudioProject> {
  const initialSignature = readLocalSignature()
  await studioRequest('studio/autodirect', {
    method: 'POST',
    body: JSON.stringify({ baseRevision }),
  })
  const assertUnchanged = () => {
    if (readLocalSignature() !== initialSignature) {
      throw new StudioApiError('效果比较期间发生了手工编辑，已保留本地时间轴', 409)
    }
  }
  assertUnchanged()
  const next = await studioRequest<StudioProject>('studio/project')
  assertUnchanged()
  return next
}
