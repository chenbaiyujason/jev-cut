import { create } from 'zustand'
import type { Project } from '@/types/project'
import {
  createProject,
  getProject,
  updateProject,
  createMedia,
  getMedia,
  updateMedia,
  associateMediaWithProject,
} from '@/infrastructure/storage'
import { setWorkspaceRoot, requireWorkspaceRoot } from '@/infrastructure/storage/workspace-fs/root'
import { bootstrapWorkspace } from '@/infrastructure/storage/workspace-fs/bootstrap'
import { readJson, writeJsonAtomic } from '@/infrastructure/storage/workspace-fs/fs-primitives'
import { blobUrlManager } from '@/infrastructure/browser/blob-url-manager'
import { buildTimelineFromStores } from '@/features/timeline/stores/timeline-persistence'
import { useCompositionNavigationStore } from '@/features/timeline/stores/composition-navigation-store'
import { useMediaLibraryStore } from '@/features/media-library/stores/media-library-store'
import { useProjectStore } from '@/features/projects/stores/project-store'
import { applyTimelineTransaction, whenEditorReady } from './timeline-sync'
import { CURRENT_SCHEMA_VERSION, migrateProject } from '@/shared/projects/migrations'
import { usePlaybackStore } from '@/shared/state/playback'
import { useItemsStore } from '@/features/timeline/stores/items-store'
import { generationPlaybackTarget, musicWasExtended } from './generation-playback'
import { uploadMadMusic } from './music-upload'
import { waitForPreviewPresentation } from '@/shared/media/preview-presentation'
import {
  StudioApiError,
  editorialSignature,
  sameOriginMediaUrl,
  studioRequest,
  type StudioProject,
  connectionRecoveryPhase,
} from './api'

interface BridgeState {
  revision: number
  phase: string
  error: string | null
  conflict: boolean
  mediaCount: number
  pending: boolean
  applying: boolean
  connectionLost: boolean
  operations: number
  generationId: string | null
  lastScopedResult: ScopedEditResult | null
  lastJevMatchResult: JevMatchResult | null
  activeInspectorTab: 'edit' | 'match'
  autoExtend: boolean
  playWhileGenerating: boolean
  waitingForClip: boolean
  pendingClip: PendingGenerationClip | null
}

export type PendingGenerationClip = { id:string; trackId:string; from:number; to:number; index:number }

export const useMadBridge = create<BridgeState>(() => ({
  revision: 0,
  phase: '连接素材库',
  error: null,
  conflict: false,
  mediaCount: 0,
  pending: false,
  applying: false,
  connectionLost: false,
  operations: 0,
  generationId: null,
  lastScopedResult: null,
  lastJevMatchResult: null,
  activeInspectorTab: 'edit',
  autoExtend: true,
  playWhileGenerating: true,
  waitingForClip: false,
  pendingClip: null,
}))

let envelope: StudioProject | null = null
let acceptedSignature = ''
let suppressChanges = false
let transaction: Promise<void> = Promise.resolve()
let initialized: Promise<StudioProject> | null = null
let restoredDraft = false
let uncertainSave: { signature: string; baseRevision: number } | null = null

function exclusive(action: () => Promise<void>): Promise<void> {
  const next = transaction.then(action, action)
  transaction = next.catch(() => {})
  return next
}

async function storeProject(project: Project): Promise<void> {
  if (await getProject(project.id)) await updateProject(project.id, project)
  else await createProject(project)
}

async function registerMedia(data: StudioProject): Promise<void> {
  const register = async () => {
    for (const entry of data.media) {
      const url = sameOriginMediaUrl(entry.url)
      if (blobUrlManager.get(entry.mediaId) !== url) {
        blobUrlManager.invalidate(entry.mediaId)
        blobUrlManager.registerUrl(entry.mediaId, url)
      }
      const metadata = { ...entry.metadata, id: entry.mediaId, remoteUrl: url }
      const existing = await getMedia(entry.mediaId)
      if (!existing) await createMedia(metadata)
      else if (
        existing.remoteUrl !== url ||
        existing.fileSize !== metadata.fileSize ||
        existing.updatedAt !== metadata.updatedAt
      ) {
        await updateMedia(entry.mediaId, metadata)
      }
      await associateMediaWithProject(data.project.id, entry.mediaId)
    }
  }
  // Multiple open editor tabs share OPFS, unlike the in-memory transaction queue.
  if (navigator.locks) await navigator.locks.request('mad-studio-register-media', register)
  else await register()
}

async function saveBridgeState(draft = false): Promise<void> {
  if (!envelope) return
  await writeJsonAtomic(requireWorkspaceRoot(), ['mad-sync.json'], {
    revision: envelope.revision,
    projectId: envelope.project.id,
    acceptedSignature,
    draft,
  })
}

export function initializeMadStudio(): Promise<StudioProject> {
  if (initialized) return initialized
  initialized = (async () => {
    const [opfs, data] = await Promise.all([
      navigator.storage.getDirectory(),
      studioRequest<StudioProject>('studio/project'),
    ])
    const root = await opfs.getDirectoryHandle('winnow-mad-studio', { create: true })
    setWorkspaceRoot(root)
    await bootstrapWorkspace(root)
    const stored = await readJson<{
      revision: number
      projectId: string
      acceptedSignature: string
      draft: boolean
    }>(root, ['mad-sync.json'])
    const previous =
      stored?.projectId === data.project.id ? await getProject(data.project.id) : null
    const draft = stored?.draft && previous ? previous : null
    restoredDraft = Boolean(draft)
    const project = migrateProject(draft || data.project).project
    envelope = { ...data, project }
    if (draft && stored) envelope.revision = stored.revision
    acceptedSignature = draft && stored ? stored.acceptedSignature : editorialSignature(project)
    await storeProject(project)
    await registerMedia(envelope)
    await saveBridgeState(Boolean(draft))
    useMadBridge.setState({
      revision: envelope.revision,
      mediaCount: data.media.length,
      phase: draft ? '已恢复本地编辑草稿' : '素材已连接',
      pending: false,
      conflict: Boolean(draft && stored?.revision !== data.revision),
    })
    return envelope
  })().catch((error: unknown) => {
    initialized = null
    throw error
  })
  return initialized
}

function currentProject(): Project {
  if (!envelope) throw new Error('编辑器尚未连接')
  const current = useProjectStore.getState().currentProject
  return {
    ...envelope.project,
    ...(current?.id === envelope.project.id
      ? { name: current.name, metadata: current.metadata }
      : {}),
    timeline: buildTimelineFromStores(),
    updatedAt: Date.now(),
  }
}

async function applyRemote(data: StudioProject, recordHistory = true): Promise<void> {
  if (useCompositionNavigationStore.getState().activeCompositionId !== null) {
    useMadBridge.setState({ phase: '远端更新等待返回主时间轴' })
    return
  }
  suppressChanges = true
  useMadBridge.setState({ pending: true, applying: true, phase: '应用 Agent 编辑' })
  const project = migrateProject(data.project).project
  try {
    const mediaChanged = JSON.stringify(envelope?.media) !== JSON.stringify(data.media)
    if (mediaChanged) await registerMedia(data)
    await applyTimelineTransaction(project, data.revision, { recordHistory, preservePlayback: true })
    envelope = { ...data, project }
    uncertainSave = null
    await storeProject(project)
    acceptedSignature = editorialSignature(currentProject())
    await saveBridgeState()
    if (mediaChanged) await useMediaLibraryStore.getState().loadMediaItems()
    useMadBridge.setState((state) => ({
      revision: data.revision,
      mediaCount: data.media.length,
      phase: 'Agent 编辑已同步 · 可撤销',
      pending: false,
      conflict: false,
      error: null,
      connectionLost: false,
      operations: state.operations + 1,
    }))
  } finally {
    suppressChanges = false
    useMadBridge.setState({ applying: false })
  }
}

async function flushLocal(): Promise<void> {
  if (!envelope || suppressChanges) return
  const project = currentProject()
  const signature = editorialSignature(project)
  if (signature === acceptedSignature) return
  useMadBridge.setState({ pending: true, phase: '保存手工编辑' })
  await storeProject(project)
  await saveBridgeState(true)
  try {
    if (uncertainSave) {
      const recovered = await studioRequest<StudioProject>('studio/project')
      if (editorialSignature(recovered.project) === uncertainSave.signature) {
        // The server committed our previous PUT before its response was lost.
        // Advance the base, retaining any newer local edits for the next PUT.
        envelope = { ...recovered, project }
        if (uncertainSave.signature === signature) {
          acceptedSignature = signature
          uncertainSave = null
          await saveBridgeState()
          useMadBridge.setState({
            revision: recovered.revision,
            phase: '连接已恢复 · 本地编辑已确认保存',
            pending: false,
            error: null,
            connectionLost: false,
            conflict: false,
          })
          return
        }
      } else if (recovered.revision !== uncertainSave.baseRevision) {
        throw new StudioApiError('工程版本已更新，本地编辑已保留', 409)
      }
      uncertainSave = null
    }
    const baseRevision = envelope.revision
    const updated = await studioRequest<StudioProject>('studio/project', {
      method: 'PUT',
      body: JSON.stringify({ baseRevision, project }),
    }).catch((error: unknown) => {
      if (error instanceof StudioApiError && error.retryable)
        uncertainSave = { signature, baseRevision }
      throw error
    })
    envelope = { ...updated, project }
    acceptedSignature = signature
    await saveBridgeState()
    useMadBridge.setState({
      revision: updated.revision,
      phase: '手工编辑已保存',
      pending: false,
      error: null,
      connectionLost: false,
      conflict: false,
    })
  } catch (error) {
    if (error instanceof StudioApiError && error.status === 409)
      useMadBridge.setState({ conflict: true })
    throw error
  }
}

function report(error: unknown): void {
  const transient = error instanceof StudioApiError && error.retryable
  const message = error instanceof Error ? error.message : String(error)
  useMadBridge.setState({
    error: /[\u4e00-\u9fff]/.test(message) ? message : '同步暂未完成，本地编辑已保留；请稍后重试',
    phase: transient ? '连接暂时中断，自动重连中' : '保留本地草稿，等待同步',
    connectionLost: transient,
    pending: false,
  })
}

/** One polling owner. Serializes reads, saves and model updates; never resets the editor. */
export function startMadBridge(): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout>
  let extensionTimer: ReturnType<typeof setTimeout> | undefined
  let seeking = false
  const stopPlaybackWatch = usePlaybackStore.subscribe(state => {
    const bridge=useMadBridge.getState()
    if(seeking || !state.isPlaying || !bridge.generationId || !bridge.playWhileGenerating) return
    const target=generationPlaybackTarget(useItemsStore.getState().items,state.currentFrame)
    if(bridge.waitingForClip!==target.waiting)useMadBridge.setState({waitingForClip:target.waiting})
    if(target.frame!==state.currentFrame){seeking=true;state.setCurrentFrame(target.frame);seeking=false}
  })
  const stopMusicWatch = useItemsStore.subscribe((next,previous) => {
    if(suppressChanges || stopped || !useMadBridge.getState().autoExtend || !musicWasExtended(previous.items,next.items)) return
    if(useMadBridge.getState().generationId)void cancelMadGeneration().catch(report)
    clearTimeout(extensionTimer)
    extensionTimer=setTimeout(()=>{ if(!stopped){void (async()=>{if(useMadBridge.getState().generationId)await cancelMadGeneration();await regenerateCurrentMusic('append')})().catch(report)} },500)
  })
  const tick = async () => {
    if (stopped) return
    await exclusive(async () => {
      if (!envelope || useMadBridge.getState().conflict) return
      await flushLocal()
      const beforeRequest = editorialSignature(currentProject())
      const next = await studioRequest<StudioProject>('studio/project')
      const afterRequest = editorialSignature(currentProject())
      // Successful reads recover a transient transport failure even when no
      // editorial revision changed. Genuine conflicts/drafts remain untouched.
      if (useMadBridge.getState().connectionLost && !useMadBridge.getState().conflict) {
        useMadBridge.setState({
          connectionLost: false,
          error: null,
          phase: connectionRecoveryPhase(
            envelope.revision,
            next.revision,
            afterRequest !== beforeRequest,
          ),
        })
      }
      // A gesture can finish while the HTTP read is in flight. Preserve it and
      // let the next optimistic save resolve the conflict instead of overwriting.
      if (next.revision !== envelope.revision && afterRequest === beforeRequest)
        await applyRemote(next)
    }).catch(report)
    if (!stopped)
      timer = setTimeout(() => {
        void tick()
      }, 1400)
  }
  const stopWaiting = whenEditorReady(() => {
    if (stopped) return
    if (envelope && !restoredDraft) acceptedSignature = editorialSignature(currentProject())
    void tick()
    const handoff=sessionStorage.getItem('jev-music-start')
    if(handoff){sessionStorage.removeItem('jev-music-start');try{const args=JSON.parse(handoff) as {musicId:string;prompt:string;duration:number;musicStart?:number;musicFrom?:number;musicRate?:number;musicVolume?:number};void runMusicGeneration('new',args.musicId,args.prompt,args.duration,args.musicStart,args)}catch(error){report(error)}}
  })
  return () => {
    stopped = true
    stopWaiting()
    clearTimeout(timer)
    clearTimeout(extensionTimer)
    stopMusicWatch()
    stopPlaybackWatch()
  }
}

export async function refreshMadProject(): Promise<void> {
  return exclusive(async () => {
    if (envelope && useMadBridge.getState().conflict) {
      const draft = currentProject()
      await createProject({
        ...draft,
        id: `${draft.id}-draft-${Date.now()}`,
        name: `${draft.name} · 冲突前草稿`,
      })
    } else await flushLocal()
    await applyRemote(await studioRequest<StudioProject>('studio/project'))
  }).catch(report)
}

export interface DirectorLiveResult {
  applied: boolean
  changed: boolean
  selected: { shotId: string; visual: string; similarity: number; preview?: string }
  model: string
  item: { from: number; durationInFrames: number }
  state: StudioProject
  timing: { prepareMs: number; modelMs: number; commitMs: number; serverMs: number }
  totalMs?: number
  stateAppliedMs?: number
  frameConfirmed?: boolean
  searchScope?: { eligible: number; episodes: number[] }
  traceUrl?: string
}

export interface ScopedEditRequest {
  goal: string
  prompt: string
  operation: 'replace' | 'optimize'
  scope: {
    mode: string
    selectedIds: string[]
    in: number | null
    out: number | null
    cursor: number
  }
  audioMode: string
  allowed: { shots: boolean; effects: boolean; transitions: boolean; grade: boolean }
}
export interface ScopedEditResult {
  targetIds: string[]
  changedVideoIds: string[]
  timelineChanged: boolean
  scope: { from: number; to: number; targets: Array<{ id: string }> }
  decisions: Array<{
    stage: string
    ms: number
    input: unknown
    output: { answers: Record<string, { choice?: string }> }
    searchScope?: { eligible: number; episodes: number[] }
    traceUrl?: string
  }>
  notes: Array<{ id: string; reason: string }>
  timing: { modelMs: number; computeMs: number; totalMs: number }
  state: StudioProject
  visibleMs?: number
}
export interface DirectorProgress {
  id: string
  status: string
  done: number
  total: number
  phase: string
  error?: string
  result?: ScopedEditResult
}

export async function runScopedDirectorEdit(
  request: ScopedEditRequest,
  onProgress: (job: DirectorProgress) => void,
): Promise<ScopedEditResult> {
  const started = performance.now()
  let result: ScopedEditResult | undefined
  await exclusive(async () => {
    if (!envelope || useMadBridge.getState().conflict) throw new Error('请先同步工程')
    if (useCompositionNavigationStore.getState().activeCompositionId !== null)
      throw new Error('请返回主时间轴')
    await flushLocal()
    usePlaybackStore.getState().pause()
    useMadBridge.setState({ pending: true, applying: true, error: null, phase: 'jev剪辑 准备选区' })
    try {
      await studioRequest('studio/director/settings', {
        method: 'PUT',
        body: JSON.stringify({ goal: request.goal }),
      })
      let job = await studioRequest<DirectorProgress>('studio/director/edit', {
        method: 'POST',
        body: JSON.stringify({ ...request, baseRevision: envelope.revision }),
      })
      onProgress(job)
      while (job.status === 'running' || job.status === 'committing') {
        job = await studioRequest<DirectorProgress>(`studio/director/jobs/${job.id}?wait=1`)
        onProgress(job)
        useMadBridge.setState({ phase: job.phase })
      }
      if (job.status !== 'complete' || !job.result)
        throw new Error(job.error || '已取消，时间轴未修改')
      result = job.result
      if (result.timelineChanged) await applyRemote(result.state)
      useMadBridge.setState({ pending: true, applying: true, phase: '等待新画面显示' })
      const first = result.changedVideoIds[0] || result.targetIds[0]
      const item = result.state.project.timeline?.items.find((i) => i.id === first)
      let target = Math.min(
        result.scope.to - 1,
        Math.max(
          result.scope.from,
          item ? item.from + Math.floor(item.durationInFrames / 2) : result.scope.from + 1,
        ),
      )
      if (target === usePlaybackStore.getState().currentFrame)
        target = target + 1 < result.scope.to ? target + 1 : Math.max(result.scope.from, target - 1)
      const presented = waitForPreviewPresentation(target, 3000)
      usePlaybackStore.getState().setCurrentFrame(target)
      const at = await presented
      if (at !== null) result.visibleMs = at - started
      useMadBridge.setState({ phase: '选区已更新 · 整轮可撤销', lastScopedResult: result })
    } finally {
      useMadBridge.setState({ pending: false, applying: false })
    }
  })
  if (!result) throw new Error('选区编辑未完成')
  return result
}

export async function loadDirectorVersion(id: string): Promise<void> {
  await exclusive(async () => {
    if (!envelope || useMadBridge.getState().conflict) throw new Error('请先同步工程')
    if (useCompositionNavigationStore.getState().activeCompositionId !== null)
      throw new Error('请返回主时间轴')
    await flushLocal()
    useMadBridge.setState({ pending: true, applying: true })
    try {
      await applyRemote(
        await studioRequest<StudioProject>('studio/director/load-version', {
          method: 'POST',
          body: JSON.stringify({ id, baseRevision: envelope.revision }),
        }),
      )
    } finally {
      useMadBridge.setState({ pending: false, applying: false })
    }
  })
}

/** The interactive path never runs catalog analysis, the planner or full-film rendering. */
export async function changeDirectorClip(
  occurrenceId: string,
  prompt: string,
): Promise<DirectorLiveResult> {
  const started = performance.now()
  let response: DirectorLiveResult | undefined
  await exclusive(async () => {
    if (!envelope || useMadBridge.getState().conflict) throw new Error('请先同步工程')
    if (useCompositionNavigationStore.getState().activeCompositionId !== null)
      throw new Error('请先返回主时间轴')
    await flushLocal()
    usePlaybackStore.getState().pause()
    useMadBridge.setState({
      pending: true,
      applying: true,
      phase: 'jev剪辑 正在局部决策',
      error: null,
    })
    try {
      response = await studioRequest<DirectorLiveResult>('studio/director/change', {
        method: 'POST',
        body: JSON.stringify({ baseRevision: envelope.revision, occurrenceId, prompt }),
      })
      if (!response.applied) {
        response.totalMs = performance.now() - started
        response.frameConfirmed = false
        useMadBridge.setState({ phase: 'jev剪辑 保留当前镜头', pending: false })
        return
      }
      await applyRemote(response.state)
      useMadBridge.setState({ applying: true, pending: true, phase: '镜头已更新，等待预览显示' })
      response.stateAppliedMs = performance.now() - started
      const clip = response.item
      let target = clip.from + Math.max(1, Math.floor(clip.durationInFrames / 2))
      if (usePlaybackStore.getState().currentFrame === target)
        target = Math.min(clip.from + clip.durationInFrames - 1, target + 2)
      const presented = waitForPreviewPresentation(target)
      usePlaybackStore.getState().setCurrentFrame(target)
      const paintedAt = await presented
      response.frameConfirmed = paintedAt !== null
      response.totalMs = paintedAt === null ? undefined : paintedAt - started
      useMadBridge.setState({
        phase: paintedAt === null ? '镜头已替换，预览待确认 · 可撤销' : '镜头已替换并显示 · 可撤销',
        pending: false,
      })
    } finally {
      useMadBridge.setState({ applying: false, pending: false })
    }
  })
  if (!response) throw new Error('局部编辑未完成')
  return response
}

type GenerationJob = {
  id: string
  status: 'running' | 'complete' | 'cancelled' | 'error'
  phase: string
  clips: number
  eventVersion?: number
  pendingClip?: PendingGenerationClip | null
  state?: StudioProject
  error?: string
}

export async function cancelMadGeneration(): Promise<void> {
  const id = useMadBridge.getState().generationId
  if (id) await studioRequest('studio/generation/cancel', { method: 'POST', body: JSON.stringify({ id }) })
}

export async function generateMad(musicId: string, prompt: string, duration: number, musicStart=0): Promise<void> {
  return runMusicGeneration('new',musicId,prompt,duration,musicStart)
}

export interface JevMatchResult {
  applied: boolean
  placeholderId: string
  item: { from: number; durationInFrames: number; label: string }
  visual: string
  durationSeconds: number
  remainingSeconds: number
  visibleMs?: number
  beatReason: string
  scope: { eligible: number; episodes: number[] }
  traceUrl: string
  state: StudioProject
  timing: { prepareMs: number; modelMs: number; totalMs: number }
}

export async function matchJevPlaceholder(placeholderId: string, prompt: string, visionEnabled = false): Promise<JevMatchResult> {
  const started = performance.now()
  let result: JevMatchResult | undefined
  await exclusive(async () => {
    if (!envelope || useMadBridge.getState().conflict) throw new Error('请先同步工程')
    if (useCompositionNavigationStore.getState().activeCompositionId !== null) throw new Error('请先返回主时间轴')
    try {
      await flushLocal()
      usePlaybackStore.getState().pause()
      const signature = editorialSignature(currentProject())
      useMadBridge.setState({ pending: true, applying: true, phase: 'Jev 匹配：全库搜索与节拍分析', error: null })
      result = await studioRequest<JevMatchResult>('studio/jev-match', {
        method: 'POST',
        body: JSON.stringify({ baseRevision: envelope.revision, placeholderId, prompt, visionEnabled }),
      })
      if (result.applied) {
        if (signature !== editorialSignature(currentProject())) {
          useMadBridge.setState({ conflict: true })
          throw new Error('匹配期间时间轴发生了修改，已保留本地编辑，请先同步工程')
        }
        await applyRemote(result.state)
        result.visibleMs = performance.now() - started
        useMadBridge.setState({ lastJevMatchResult: result, phase: 'Jev 匹配完成 · 可撤销' })
      }
    } catch (error) {
      if (error instanceof StudioApiError && error.status === 409) useMadBridge.setState({ conflict: true })
      useMadBridge.setState({ phase: '匹配未完成 · 占位节点已保留' })
      throw error
    } finally {
      useMadBridge.setState({ pending: false, applying: false })
    }
  })
  if (!result) throw new Error('Jev 匹配未完成')
  return result
}

export async function regenerateCurrentMusic(mode:'append'|'rebuild',prompt?:string,trackId?:string): Promise<void> {
  const current=useProjectStore.getState().currentProject
  let track=useItemsStore.getState().items.find(i=>i.type==='audio'&&(trackId?i.id===trackId:i.trackId==='music'))
  if(!track?.mediaId){report(new Error('请先设置主音轨'));return}
  const [library,settings]=await Promise.all([studioRequest<{music:Array<{id:string}>}>('state'),prompt===undefined?studioRequest<{goal:string}>('studio/director/settings'):Promise.resolve(null)])
  let mediaId=track.mediaId
  if(!library.music.some(m=>m.id===mediaId)){
    const metadata=useMediaLibraryStore.getState().mediaItems.find(m=>m.id===mediaId)
    if(!metadata)throw new Error('请重新连接音轨素材')
    const {mediaLibraryService}=await import('@/features/media-library/services/media-library-service')
    const blob=await mediaLibraryService.getMediaFile(metadata)
    if(!blob)throw new Error('音轨文件不可读取')
    const result=await uploadMadMusic(new File([blob],metadata.fileName,{type:metadata.mimeType}),phase=>useMadBridge.setState({phase}),new AbortController().signal)
    mediaId=result.selected.id
    await registerMedia(await studioRequest<StudioProject>('studio/project'))
  }
  const store=useItemsStore.getState()
  if(track.trackId!=='music'||track.mediaId!==mediaId){
    suppressChanges=true
    try{
      const oldTrack=store.tracks.find(t=>t.id===track!.trackId)
      if(!store.tracks.some(t=>t.id==='music')&&oldTrack)store.setTracks([...store.tracks,{...oldTrack,id:'music',name:'剪辑主音轨',order:Math.max(...store.tracks.map(t=>t.order))+1}])
      if(store.items.some(i=>i.trackId==='music'&&i.id!==track!.id)){
        const otherId=track.trackId==='music'?'other-music':track.trackId
        if(!store.tracks.some(t=>t.id===otherId)&&oldTrack)store.setTracks([...useItemsStore.getState().tracks,{...oldTrack,id:otherId,name:'其他音频',order:Math.max(...store.tracks.map(t=>t.order))+2}])
        for(const i of store.items.filter(i=>i.trackId==='music'&&i.id!==track!.id))store._updateItem(i.id,{trackId:otherId})
      }
      store._updateItem(track.id,{trackId:'music',mediaId,src:`/mad-media/${mediaId}/preview.m4a`})
      track=useItemsStore.getState().itemById[track.id]!
    }finally{suppressChanges=false}
  }
  return runMusicGeneration(mode,mediaId,prompt??settings?.goal??current?.description??'',track.durationInFrames/(current?.metadata.fps||30))
}

async function runMusicGeneration(mode:'new'|'append'|'rebuild',musicId: string, prompt: string, duration: number,musicStart=0,musicOptions:{musicFrom?:number;musicRate?:number;musicVolume?:number}={}): Promise<void> {
  return exclusive(async () => {
    if (!envelope || useMadBridge.getState().conflict) throw new Error('请先同步工程')
    if (useCompositionNavigationStore.getState().activeCompositionId !== null) throw new Error('请返回主时间轴')
    await flushLocal()
    if(!useMadBridge.getState().playWhileGenerating)usePlaybackStore.getState().pause()
    if(mode==='new')usePlaybackStore.getState().setCurrentFrame(0)
    useMadBridge.setState({ pending: true, applying: false, error: null, phase: mode==='append'?'正在补齐后续':'正在准备全片编排' })
    let job: GenerationJob | undefined
    let firstSnapshot = true
    let playbackStarted=mode==='append'||usePlaybackStore.getState().isPlaying
    try {
      job = await studioRequest<GenerationJob>('studio/generation/start', {
        method: 'POST', body: JSON.stringify({ mode, musicId, prompt, duration, musicStart,...musicOptions, baseRevision: envelope.revision }),
      })
      useMadBridge.setState({ generationId: job.id })
      const deadline = Date.now() + 20 * 60_000
      while (true) {
        useMadBridge.setState({pendingClip:job.pendingClip??null,phase:job.phase})
        // Never overwrite a local gesture that arrived between server snapshots.
        if (editorialSignature(currentProject()) !== acceptedSignature) {
          await cancelMadGeneration()
          throw new Error('检测到本地修改，已停止生成并保留本地内容')
        }
        if (job.state && job.state.revision > envelope.revision) {
          await applyRemote(job.state, firstSnapshot)
          firstSnapshot = false
          if(!playbackStarted && useMadBridge.getState().playWhileGenerating){const timeline=job.state.project.timeline;const musicFrom=timeline?.items.find(i=>i.trackId==='music')?.from||0;const clip=timeline?.items.find(i=>i.type==='video'&&i.from<=musicFrom&&i.from+i.durationInFrames>musicFrom);if(clip){usePlaybackStore.getState().setCurrentFrame(musicFrom);usePlaybackStore.getState().play();playbackStarted=true}}
        }
        useMadBridge.setState({ pending: true, applying: false, phase: `${job.phase} · ${job.clips} 个镜头` })
        if (job.status !== 'running') break
        if (Date.now() > deadline) {
          await cancelMadGeneration()
          throw new Error('本轮等待结束，已保留排入的镜头')
        }
        job = await studioRequest<GenerationJob>(`studio/generation/jobs/${job.id}?after=${envelope.revision}&afterEvent=${job.eventVersion??-1}&wait=1`)
      }
      if (job.status === 'error') throw new Error(job.error || '生成中止，已保留排入的镜头')
      useMadBridge.setState({ phase: job.status === 'complete' ? '生成完成 · 可以播放' : '已停止 · 已生成镜头保留' })
    } catch (error) {
      if (job?.status === 'running') await cancelMadGeneration().catch(() => {})
      throw error
    } finally {
      useMadBridge.setState({ pending: false, applying: false, generationId: null,waitingForClip:false,pendingClip:null })
    }
  }).catch(report)
}

export const madMigration = {
  storedSchemaVersion: CURRENT_SCHEMA_VERSION,
  currentSchemaVersion: CURRENT_SCHEMA_VERSION,
  requiresUpgrade: false,
}
