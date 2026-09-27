import { describe, expect, it, vi, afterEach } from 'vite-plus/test'
import type { Project } from '@/types/project'
import type { MediaMetadata } from '@/types/storage'
import {
  editorialSignature,
  sameOriginMediaUrl,
  StudioApiError,
  studioRequest,
  requestAutomaticDirection,
  connectionRecoveryPhase,
} from './api'
import { scanWorkspaceMediaHealth } from '@/features/media-library/utils/workspace-health'

const project: Project = {
  id: 'mad',
  name: 'Test',
  description: '',
  createdAt: 1,
  updatedAt: 1,
  duration: 5,
  metadata: { width: 960, height: 540, fps: 30 },
  timeline: { tracks: [], items: [], currentFrame: 0, zoomLevel: 1, scrollPosition: 0 },
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('MAD bridge editorial synchronization', () => {
  it('settles a recovered connection at the same revision without claiming pending edits are saved', () => {
    expect(connectionRecoveryPhase(10, 10, false)).toBe('工程已同步')
    expect(connectionRecoveryPhase(10, 10, true)).toBe('连接已恢复 · 本地编辑待保存')
    expect(connectionRecoveryPhase(10, 11, false)).toBe('连接已恢复 · 正在应用更新')
  })
  it('does not treat playback or viewport changes as edits', () => {
    const changed = {
      ...project,
      updatedAt: 99,
      timeline: { ...project.timeline!, currentFrame: 150, zoomLevel: 4, scrollPosition: 300 },
    }
    expect(editorialSignature(changed)).toBe(editorialSignature(project))
  })
  it('does treat clip and resolution edits as editorial changes', () => {
    expect(
      editorialSignature({ ...project, metadata: { ...project.metadata, width: 1920 } }),
    ).not.toBe(editorialSignature(project))
    expect(
      editorialSignature({
        ...project,
        timeline: {
          ...project.timeline!,
          items: [
            {
              id: 'text',
              trackId: 'v',
              type: 'text',
              text: '決意',
              label: '決意',
              from: 0,
              durationInFrames: 12,
            },
          ],
        },
      }),
    ).not.toBe(editorialSignature(project))
  })
  it('can acknowledge server-restored provenance despite JSON key order changes', () => {
    const item = {
      id: 'shot',
      trackId: 'v',
      type: 'video' as const,
      from: 0,
      durationInFrames: 12,
      label: 'shot',
    }
    const local = { ...project, timeline: { ...project.timeline!, items: [item] } }
    const remote = {
      ...project,
      metadata: { fps: 30, height: 540, width: 960 },
      timeline: { ...project.timeline!, items: [{ ...item, mad: { assetId: 'ep01' } }] },
    }
    expect(editorialSignature(remote)).toBe(editorialSignature(local))
  })
  it('only accepts assets under the same-origin local media route', () => {
    expect(sameOriginMediaUrl('/mad-media/ep01/preview.mp4')).toContain(
      '/mad-media/ep01/preview.mp4',
    )
    expect(() => sameOriginMediaUrl('https://external.example/video.mp4')).toThrow()
    expect(() => sameOriginMediaUrl('/mad-api/studio/project')).toThrow()
  })
  it('preserves 409 conflicts for the draft-retention flow', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        text: async () => JSON.stringify({ error: 'revision conflict' }),
      }),
    )
    await expect(studioRequest('studio/project')).rejects.toMatchObject({
      status: 409,
      message: '工程版本已更新，本地编辑已保留',
    })
    expect(new StudioApiError('conflict', 409)).toBeInstanceOf(Error)
  })
  it('marks truncated restart responses as transient and accepts the next response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ revision: 2, project }),
      })
    vi.stubGlobal('fetch', fetchMock)
    await expect(studioRequest('studio/project')).rejects.toMatchObject({
      retryable: true,
      message: '本机服务暂时未返回完整数据，正在自动重连',
    })
    await expect(studioRequest('studio/project')).resolves.toMatchObject({ revision: 2 })
  })
  it('localizes transport errors without classifying them as revision conflicts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(studioRequest('studio/project')).rejects.toMatchObject({
      status: 0,
      retryable: true,
      message: '本机剪辑服务暂时不可用，正在自动重连',
    })
  })
  it('retains conflict semantics even when a conflict response is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 409, text: async () => '' }),
    )
    await expect(studioRequest('studio/project')).rejects.toMatchObject({
      status: 409,
      retryable: false,
    })
  })
  it('checks remote media by HEAD without copying video into OPFS', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const item = {
      id: 'ep01',
      fileName: 'episode01.mp4',
      remoteUrl: '/mad-media/ep01/preview.mp4',
    } as MediaMetadata
    const validate = vi.fn()
    expect(await scanWorkspaceMediaHealth([item], validate)).toEqual({
      healthyIds: ['ep01'],
      broken: [],
    })
    expect(fetchMock).toHaveBeenCalledWith(expect.any(URL), { method: 'HEAD' })
    expect(validate).not.toHaveBeenCalled()
  })
  it('compares effects against the imported revision then fetches the new project', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ revision: 8 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ revision: 8, project, media: [] }),
      })
    vi.stubGlobal('fetch', request)
    await expect(requestAutomaticDirection(7, () => 'unchanged')).resolves.toMatchObject({
      revision: 8,
    })
    expect(request.mock.calls[0]).toMatchObject([
      '/mad-api/studio/autodirect',
      { method: 'POST', body: JSON.stringify({ baseRevision: 7 }) },
    ])
    expect(request.mock.calls[1]?.[0]).toBe('/mad-api/studio/project')
  })
  it('rejects an effect result if a local edit completed during model comparison', async () => {
    let signature = 'before'
    const request = vi.fn().mockImplementation(async () => {
      signature = 'manual-edit'
      return { ok: true, status: 200, text: async () => JSON.stringify({ revision: 8 }) }
    })
    vi.stubGlobal('fetch', request)
    await expect(requestAutomaticDirection(7, () => signature)).rejects.toMatchObject({
      status: 409,
    })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('does not fetch or apply a replacement when the effects pass fails', async () => {
    const request = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: 'effect preview failed' }),
    })
    vi.stubGlobal('fetch', request)
    await expect(requestAutomaticDirection(7, () => 'unchanged')).rejects.toMatchObject({
      status: 500,
    })
    expect(request).toHaveBeenCalledTimes(1)
  })
})
