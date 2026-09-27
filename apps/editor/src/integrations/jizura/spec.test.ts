import { afterEach, describe, expect, it } from 'vite-plus/test'
import { jizuraLocalTime, jizuraSpecSchema } from './spec'
import { validateProject } from '@/features/project-bundle/schemas/project-schema'
import { buildDomTextScrubOverlayPlan } from '@/features/preview/utils/dom-text-scrub-overlay'
import { buildTimelineFromStores, hydrateTimelineStoresFromProject } from '@/features/timeline/stores/timeline-persistence'
import { makeTimelineTrack, resetTimelineCompositionTestState } from '@/features/timeline/test-helpers'
import type { Project } from '@/types/project'
import type { TextItem } from '@/types/timeline'

const track = makeTimelineTrack({ id: 'jizura-track', name: '文字 PV', order: 0, kind: 'video', visible: true })
const item: TextItem = {
  id: 'jizura-text', type: 'text', trackId: track.id, from: 30, durationInFrames: 60,
  label: '文字 PV', text: '决心', color: '#ffffff',
  jizura: { version: 1, preset: 'impact', seed: 123, intensity: 0.8, transparent: true, centerFree: false },
}
const project: Project = {
  id: 'jizura-test', name: 'JIZURA test', description: '', createdAt: 1, updatedAt: 1, duration: 3,
  metadata: { width: 640, height: 360, fps: 30 }, timeline: { tracks: [track], items: [item] },
}

describe('JIZURA timeline contract', () => {
  afterEach(() => resetTimelineCompositionTestState())

  it('rejects unbounded or executable action payloads', () => {
    expect(jizuraSpecSchema.safeParse({ ...item.jizura, preset: 'arbitrary' }).success).toBe(false)
    expect(jizuraSpecSchema.safeParse({ ...item.jizura, intensity: 1.01 }).success).toBe(false)
    expect(jizuraSpecSchema.safeParse({ ...item.jizura, script: 'alert(1)' }).success).toBe(false)
  })

  it('uses project frames rather than wall clock and remains seekable', () => {
    expect(jizuraLocalTime(45, 30, 60, 30)).toBe(0.5)
    expect(jizuraLocalTime(30, 30, 60, 30)).toBe(0)
    expect(jizuraLocalTime(45, 30, 60, 30)).toBe(0.5)
    expect(() => jizuraLocalTime(45, 30, 60, 0)).toThrow()
  })

  it('preserves the animated layer through snapshot validation and store round-trip', async () => {
    const parsed = validateProject(project)
    expect(parsed.success, JSON.stringify(parsed.errors)).toBe(true)
    expect(parsed.data?.timeline?.items[0]?.jizura?.seed).toBe(123)
    await hydrateTimelineStoresFromProject(project)
    expect(buildTimelineFromStores().items[0]?.jizura).toEqual(item.jizura)
  })

  it('keeps animated JIZURA out of the static DOM scrub overlay', () => {
    expect(buildDomTextScrubOverlayPlan([{ ...track, items: [item] }], []).enabled).toBe(false)
  })
})
