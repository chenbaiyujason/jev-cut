/**
 * Adapter exports for timeline dependencies.
 * Keyframes modules should import timeline stores from here.
 */

export { useTimelineStore } from '@/features/timeline/stores/timeline-store'
export { useItemsStore } from '@/features/timeline/stores/items-store'
export { useKeyframesStore } from '@/features/timeline/stores/keyframes-store'
export { useTransitionsStore } from '@/features/timeline/stores/transitions-store'
export {
  getEdgeScrollDelta,
  getPlayheadEdgeScrollVelocity,
} from '@/features/timeline/utils/playhead-edge-scroll'
