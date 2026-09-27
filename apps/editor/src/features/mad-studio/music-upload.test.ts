import { afterEach, expect, it, vi } from 'vitest'
import { uploadMadMusic, validateMusicFile } from './music-upload'

afterEach(() => vi.restoreAllMocks())

it('uploads binary audio, waits for its job, then selects the returned backend music ID', async () => {
  const file = new File(['new-audio'], '新配乐.wav', { type: 'audio/wav' })
  const request = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'job', status: 'running', stage: '节拍分析', progress: 0.5 })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'job', status: 'complete', result: { id: 'new' } })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ music: [{ id: 'old', name: '旧曲', duration: 20 }, { id: 'new', name: file.name, duration: 8 }] })))
  const progress = vi.fn()
  const result = await uploadMadMusic(file, progress, new AbortController().signal)
  expect(request.mock.calls[0]?.[0]).toBe(`/mad-api/upload?kind=music&name=${encodeURIComponent(file.name)}`)
  expect(request.mock.calls[0]?.[1]?.body).toBe(file)
  expect(request.mock.calls[0]?.[1]?.headers).toEqual({ 'Content-Type': 'application/octet-stream' })
  expect(request.mock.calls[1]?.[0]).toBe('/mad-api/jobs/job')
  expect(result.selected.id).toBe('new')
  expect(progress).toHaveBeenCalledWith('节拍分析 · 50%')
})

it('rejects unsupported files and stops on a failed import without selecting an old song', async () => {
  expect(() => validateMusicFile({ name: 'clip.mp4', type: 'video/mp4', size: 50 })).toThrow('音频文件')
  const request = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ id: 'job', status: 'error', error: '音频无法解码' })))
  await expect(uploadMadMusic(new File(['broken'], 'bad.wav'), () => {}, new AbortController().signal)).rejects.toThrow('音频无法解码')
  expect(request).toHaveBeenCalledTimes(1)
})
