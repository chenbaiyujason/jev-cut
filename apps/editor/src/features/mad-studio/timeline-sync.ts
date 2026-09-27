import type { Project } from '@/types/project'
import { captureSnapshot } from '@/features/timeline/stores/commands/snapshot'
import {
  hydrateTimelineStoresFromProject,
  buildTimelineFromStores,
} from '@/features/timeline/stores/timeline-persistence'
import { useTimelineCommandStore } from '@/features/timeline/stores/timeline-command-store'
import { useTimelineSettingsStore } from '@/features/timeline/stores/timeline-settings-store'
import { useProjectStore } from '@/features/projects/stores/project-store'
import { usePlaybackStore } from '@/shared/state/playback'
import { useItemsStore } from '@/features/timeline/stores/items-store'
import type { TimelineItem } from '@/types/timeline'

const stable = (value: unknown) =>
  JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : entry,
  )
function timelineStructure(timeline: NonNullable<Project['timeline']>) {
  const {
    items: _items,
    currentFrame: _frame,
    zoomLevel: _zoom,
    scrollPosition: _scroll,
    ...rest
  } = timeline
  const value: Record<string, unknown> = {
    ...rest,
    tracks: rest.tracks.map((value) => {
      const { height: _height, items: _nested, ...track } = value as typeof value & { items?: unknown }
      return track
    }),
  }
  for (const key of ['transitions', 'keyframes', 'compositions', 'markers', 'topLevelSequenceIds'])
    if (Array.isArray(value[key]) && !value[key].length) delete value[key]
  return stable(value)
}

/** Apply a server transaction to the existing editor without invoking project-open loading. */
export async function applyTimelineTransaction(
  project: Project,
  revision: number,
  options: { recordHistory?: boolean } = {},
): Promise<'incremental' | 'hydrate'> {
  const before = captureSnapshot()
  const frame = usePlaybackStore.getState().currentFrame
  usePlaybackStore.getState().pause()
  const current = useProjectStore.getState().currentProject
  const timeline = buildTimelineFromStores()
  const sameItems =
    project.timeline?.items.length === timeline.items.length &&
    project.timeline.items.every(
      (item, index) =>
        item.id === timeline.items[index]?.id &&
        item.type === timeline.items[index]?.type &&
        !(item as { isReversed?: boolean }).isReversed,
    )
  const incremental =
    current?.id === project.id &&
    stable(current.metadata) === stable(project.metadata) &&
    sameItems &&
    project.timeline &&
    timelineStructure(timeline) === timelineStructure(project.timeline)
  if (incremental) {
    // Retain unrelated clip identities, selection and decoder state on a local edit.
    const stored = useItemsStore.getState()
    for (const next of project.timeline!.items) {
      const previous = stored.itemById[next.id]
      if (stable(previous) === stable(next)) continue
      const updates: Record<string, unknown> = { ...next }
      for (const key of Object.keys(previous ?? {})) if (!(key in next)) updates[key] = undefined
      stored._updateItem(next.id, updates as Partial<TimelineItem>)
    }
  } else await hydrateTimelineStoresFromProject(project, { preserveHistory: true })
  useProjectStore.getState().setCurrentProject(project)
  usePlaybackStore.getState().setCurrentFrame(frame)
  if (options.recordHistory !== false) {
    useTimelineCommandStore
      .getState()
      .addUndoEntry({ type: 'mad-agent-edit', payload: { revision } }, before)
  }
  return incremental ? 'incremental' : 'hydrate'
}

/** Observe the Editor's single initial load; never start a second history-clearing load. */
export function whenEditorReady(callback: () => void): () => void {
  if (!useTimelineSettingsStore.getState().isTimelineLoading) {
    callback()
    return () => {}
  }
  const unsubscribe = useTimelineSettingsStore.subscribe((state) => {
    if (!state.isTimelineLoading) {
      unsubscribe()
      callback()
    }
  })
  return unsubscribe
}
