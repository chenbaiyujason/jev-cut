import { z } from 'zod'

/** Bounded, serializable action space; time belongs to the containing TextItem. */
export const jizuraSpecSchema = z.object({
  version: z.literal(1),
  preset: z.enum(['impact', 'kinetic', 'quiet']),
  seed: z.number().int().min(0).max(4294967295),
  intensity: z.number().min(0).max(1).default(0.7),
  transparent: z.boolean().default(true),
  centerFree: z.boolean().default(false),
  accentColor: z.string().regex(/^#[0-9a-f]{6}$/i).default('#ff3366'),
  backgroundColor: z.string().regex(/^#[0-9a-f]{6}$/i).default('#101018'),
}).strict()

export type JizuraSpec = z.input<typeof jizuraSpecSchema>

export const JIZURA_PRESETS = [
  { id: 'impact', label: '重音冲击', description: '大字快速压入，适合短促重音。' },
  { id: 'kinetic', label: '逐词跃动', description: '逐词堆叠和弹性运动，适合切分节奏。' },
  { id: 'quiet', label: '留白叙述', description: '柔和显现与退场，适合完整台词。' },
] as const

export function jizuraLocalTime(frame: number, from: number, durationInFrames: number, fps: number) {
  if (![frame, from, durationInFrames, fps].every(Number.isFinite) || fps <= 0 || durationInFrames <= 0) {
    throw new Error('JIZURA requires a finite frame clock and positive duration/fps')
  }
  return Math.max(0, Math.min(durationInFrames - 1, frame - from)) / fps
}
