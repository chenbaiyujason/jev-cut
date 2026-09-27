// Fixed 3-second technical fixture; no model calls or user-media generation.
// Run after build: node src/integrations/jizura/headless-smoke.mjs
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
import { createHarnessServer } from '../../../headless/server.mjs'
import { chromeLaunchArgs } from '../../../headless/lib/cli.mjs'

const root = path.resolve(import.meta.dirname, '../../..')
const out = path.join(root, 'artifacts/jizura-smoke')
await fs.mkdir(out, { recursive: true })
const server = await createHarnessServer({ distDir: path.join(root, 'dist'), resolveMedia: () => null })
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: chromeLaunchArgs() })
const page = await browser.newPage({ acceptDownloads: true })
page.on('pageerror', (error) => console.error('JIZURA page error:', error.message))
const track = { id: 'text-track', name: '文字 PV', kind: 'video', height: 60, locked: false, syncLock: true, visible: true, muted: false, solo: false, order: 0, items: [] }
const item = { id: 'pv', type: 'text', trackId: track.id, label: '文字 PV', text: '决心 向前 守护', color: '#ffffff', from: 0, durationInFrames: 90,
  transform: { x: 0, y: 0, width: 640, height: 360, rotation: 0, opacity: 1 },
  jizura: { version: 1, preset: 'impact', seed: 731, intensity: 0.8, transparent: true, centerFree: false, accentColor: '#ff3366' } }
const project = { id: 'jizura-smoke', name: 'JIZURA technical fixture', description: '', createdAt: 1, updatedAt: 1, duration: 3, schemaVersion: 10,
  metadata: { width: 640, height: 360, fps: 30, backgroundColor: '#18405e' }, timeline: { tracks: [track], items: [item], transitions: [], keyframes: [] } }
const report = { frames: [], export: null }
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
async function ready() {
  await page.goto(server.harnessUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => window.freecut?.ready)
}
async function frame(preset, frame, name, centerFree = false) {
  const current = structuredClone(project)
  Object.assign(current.timeline.items[0].jizura, { preset, centerFree })
  const download = page.waitForEvent('download', { timeout: 60000 })
  download.catch(() => {})
  const summary = await page.evaluate((input) => window.freecut.renderFrame(input), { project: current, frame })
  assert.equal(summary.ok, true)
  const output = path.join(out, `${name}.png`)
  await (await download).saveAs(output)
  const bytes = await fs.readFile(output)
  const pixels = await page.evaluate(async (bytes) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0)
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let changed = 0
    for (let i = 0; i < data.length; i += 4) if (Math.abs(data[i] - 24) + Math.abs(data[i + 1] - 64) + Math.abs(data[i + 2] - 94) > 15) changed++
    return { changed, corner: [...data.slice(0, 4)] }
  }, [...bytes])
  assert.ok(pixels.changed > 100, `${preset}: expected actual text pixels`)
  // The impact layout deliberately allows large text to cross the frame edge;
  // untouched area, rather than a particular corner, proves transparent blending.
  assert.ok(pixels.changed < 640 * 360 * 0.85, `${preset}: transparent layer must preserve empty background`)
  report.frames.push({ name, preset, frame, sha256: hash(bytes), bytes: bytes.length, ...pixels })
  return hash(bytes)
}
try {
  await ready()
  const first = await frame('impact', 12, 'impact-12')
  assert.notEqual(await frame('impact', 30, 'impact-30'), first, 'animation must change with the frame clock')
  await page.reload(); await page.waitForFunction(() => window.freecut?.ready)
  assert.equal(await frame('impact', 12, 'impact-12-reloaded'), first, 'new engine instance must reproduce the same frame')
  await frame('kinetic', 30, 'kinetic-30')
  await frame('quiet', 30, 'quiet-30', true)
  const download = page.waitForEvent('download', { timeout: 120000 })
  download.catch(() => {})
  const summary = await page.evaluate((input) => window.freecut.renderTimeline(input), {
    tracks: [track], items: [item], transitions: [], fps: 30, width: 640, height: 360, backgroundColor: '#18405e',
    settings: { mode: 'video', codec: 'vp9', container: 'webm', quality: 'high', resolution: { width: 640, height: 360 }, fps: 30, videoBitrate: 2000000 },
    outputFileName: 'jizura-technical.webm',
  })
  assert.equal(summary.ok, true)
  const exportPath = path.join(out, 'jizura-technical.webm')
  await (await download).saveAs(exportPath)
  const stat = await fs.stat(exportPath)
  assert.ok(stat.size > 10000)
  report.export = { bytes: stat.size, summary }
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser.close()
  await server.close()
}
