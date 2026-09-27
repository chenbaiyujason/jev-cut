import type { TextItem } from '@/types/timeline'
import { jizuraLocalTime, jizuraSpecSchema } from './spec'

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
type Engine = typeof import('./vendor/engine.js')['default']
type CacheEntry = { canvas: HTMLCanvasElement; renderer: any; plan: any }
let enginePromise: Promise<Engine> | undefined
const plans = new Map<string, CacheEntry>()

async function engine(): Promise<Engine> {
  enginePromise ??= import('./vendor/engine.js').then(({ default: J }) => {
    // Offline fonts only: never fetch Google Fonts or depend on load order.
    J.fontCSS = (key: string, px: number) => {
      const serif = /mincho|tokumin/.test(key)
      const mono = key === 'mono'
      const family = mono ? 'Consolas,monospace' : serif
        ? '"SimSun","Yu Mincho",serif' : '"Microsoft YaHei","Yu Gothic",Arial,sans-serif'
      const weight = /black/.test(key) ? 900 : /bold|dela|zenkaku/.test(key) ? 700 : 500
      return `${weight} ${px.toFixed(2)}px ${family}`
    }
    return J
  })
  return enginePromise
}

function makeEntry(J: Engine, item: TextItem, width: number, height: number, fps: number): CacheEntry {
  const spec = jizuraSpecSchema.parse(item.jizura)
  const duration = item.durationInFrames / fps
  const project = J.defaultProject()
  const choices = {
    impact: { layout: 'huge', enter: 'zoom', exit: 'shrink', hold: 'breathe' },
    kinetic: { layout: 'knSlamStack', enter: 'cut', exit: 'drift', hold: 'still' },
    quiet: { layout: 'center', enter: 'blur', exit: 'blur', hold: 'still' },
  }
  const aspectChoices = [[16 / 9, '16:9'], [9 / 16, '9:16'], [1, '1:1'], [4 / 3, '4:3'], [3 / 4, '3:4'], [21 / 9, '21:9']] as const
  const aspect = [...aspectChoices].sort((a, b) => Math.abs(a[0] - width / height) - Math.abs(b[0] - width / height))[0]![1]
  Object.assign(project, {
    lyrics: item.text.replace(/[\r\n]+/g, ' '), seed: spec.seed, fps, aspect,
    style: 'noir', centerFree: spec.centerFree, typeset: false, unify: false,
    timing: { offset: 0, tail: 0, snap: false, lineScale: 1 },
    overrides: { 0: { ...choices[spec.preset], cuts: 1, decor: [], bg: 'none', cam: 'none', treat: 'none', trans: 'none' } },
    fx: { ...project.fx, motion: spec.intensity, glitch: 0, chroma: spec.preset === 'impact' ? spec.intensity * 0.3 : 0,
      decor: 0, texture: 0, flash: false, hud: 'off', koma: 0, onTwos: false, bgSwitch: 0 },
  })
  // The agent contract is plain text, not JIZURA's lyric-markup language.
  // Keep punctuation, asterisks and slashes visible instead of interpreting
  // them as cuts, emphasis, comments or metadata. Planning is synchronous.
  const parser = J.parseLyrics
  const literal = parser('JIZURA')
  literal.lines[0].text = project.lyrics
  let plan: any
  try {
    J.parseLyrics = () => literal
    plan = J.plan(project, null)
  } finally {
    J.parseLyrics = parser
  }
  // Freecut owns the exact in/out points. JIZURA plans its internal movement
  // once; retiming its local cut preserves seek and export identity.
  plan.cuts = plan.cuts.filter((cut: any) => cut.line === 0 && cut.layout !== 'interlude')
  if (!plan.cuts.length) throw new Error('JIZURA text must contain visible characters')
  const naturalDuration = Math.max(...plan.cuts.map((cut: any) => cut.end))
  const ratio = duration / naturalDuration
  const retime = (cut: any) => {
    for (const field of ['start', 'end', 'dur', 'inDur', 'outDur', 'stagger']) {
      if (typeof cut[field] === 'number') cut[field] *= ratio
    }
    if (cut.companion && typeof cut.companion === 'object') retime(cut.companion)
    cut.inDur = Math.min(spec.preset === 'quiet' ? 0.45 : 0.18, duration * 0.3)
    cut.outDur = Math.min(spec.preset === 'quiet' ? 0.4 : 0.16, duration * 0.25)
  }
  plan.cuts.forEach(retime)
  plan.duration = duration
  plan.events = []
  plan.hud = false
  plan.style.schemes = plan.style.schemes.map((scheme: any) => ({ ...scheme,
    bg: spec.backgroundColor, fg: item.color || '#ffffff', sub: item.color || '#ffffff',
    accent: spec.accentColor, accent2: spec.accentColor, ink: item.color || '#ffffff',
    ghostA: spec.accentColor, ghostB: spec.accentColor,
  }))
  const canvas = document.createElement('canvas')
  // Preserve JIZURA's design aspect and fit into the Freecut item rectangle.
  canvas.width = Math.max(2, Math.round(width))
  canvas.height = Math.max(2, Math.round(width * plan.H / plan.W))
  return { canvas, renderer: new J.Renderer(spec.seed), plan }
}

/** Canonical paint path used by both Freecut export and DOM fallback preview. */
export async function renderJizuraFrame(
  ctx: Context, item: TextItem, relativeFrame: number, fps: number,
  rect: { x: number; y: number; width: number; height: number },
): Promise<void> {
  const J = await engine()
  const spec = jizuraSpecSchema.parse(item.jizura)
  const key = JSON.stringify([item.text, item.color, spec, item.durationInFrames, fps, Math.round(rect.width), Math.round(rect.height)])
  let entry = plans.get(key)
  if (!entry) {
    entry = makeEntry(J, item, rect.width, rect.height, fps)
    plans.set(key, entry)
    if (plans.size > 12) plans.delete(plans.keys().next().value!)
  }
  const t = jizuraLocalTime(relativeFrame, 0, item.durationInFrames, fps)
  entry.renderer.frame(entry.canvas.getContext('2d'), entry.plan, t, {
    scale: entry.canvas.width / entry.plan.W, transparent: spec.transparent,
    noHud: true, noTrans: true,
  })
  ctx.drawImage(entry.canvas, rect.x, rect.y, rect.width, rect.height)
}
