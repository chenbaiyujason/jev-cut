import { studioRequest } from './api'

export type MadMusic = { id: string; name: string; duration: number }
type ImportJob = {
  id: string
  status: 'running' | 'complete' | 'error'
  stage: string
  progress: number
  result?: { id: string }
  error?: string
}

export function validateMusicFile(file: Pick<File, 'name' | 'type' | 'size'>): void {
  if (!file.size) throw new Error('音频文件为空')
  if (!file.type.startsWith('audio/') && !/\.(mp3|wav|m4a|aac|flac|ogg|opus|aiff?|wma)$/i.test(file.name)) {
    throw new Error('请拖入音频文件，例如 MP3、WAV、M4A 或 FLAC')
  }
}

export async function uploadMadMusic(
  file: File,
  onProgress: (message: string) => void,
  signal: AbortSignal,
): Promise<{ music: MadMusic[]; selected: MadMusic }> {
  validateMusicFile(file)
  onProgress('正在上传音频…')
  let job = await studioRequest<ImportJob>(`upload?kind=music&name=${encodeURIComponent(file.name)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, signal,
  })
  while (job.status === 'running') {
    onProgress(`${job.stage || '分析配乐'} · ${Math.round((job.progress || 0) * 100)}%`)
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new DOMException('已停止等待', 'AbortError')) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 400)
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
    job = await studioRequest<ImportJob>(`jobs/${job.id}`, { signal })
  }
  if (job.status === 'error') throw new Error(job.error || '配乐导入失败')
  const { music } = await studioRequest<{ music: MadMusic[] }>('state', { signal })
  const selected = music.find(item => item.id === job.result?.id)
  if (!selected) throw new Error('未找到导入的配乐，请重新打开窗口')
  onProgress('音频已就绪，可以开始生成')
  return { music, selected }
}
