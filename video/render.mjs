#!/usr/bin/env node
/**
 * Renders an RWA Sonar explainer short to MP4: scene lengths come from the voiced narration (voice.mjs), captions
 * from its character timestamps; stage.html?short=<id> (stage-kit.js + scenes/<id>.js) is posed frame by frame in
 * headless Chrome and piped into ffmpeg.
 * Usage:
 *   node video/render.mjs <short.json> --stills [--estimate]  contact sheet of key moments (out/<id>-stills.png);
 *                                                            --estimate times un-voiced scenes at 16 chars/s
 *   node video/render.mjs <short.json> [--width 1080]         full video (out/<id>.mp4); --width 540 for a fast draft
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { sceneAudioPaths } from './voice.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const log = (message, details = {}) => console.log(`[${new Date().toISOString()}] ${message}${Object.keys(details).length ? ' ' + JSON.stringify(details) : ''}`)
const FPS = 30
const FFMPEG = existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg'
const FFPROBE = existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe'

const audioSeconds = (file) => Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim())

/** Sentences of a narration with their start/end in seconds, from ElevenLabs character timestamps. */
export function sentenceCaptions(narration, alignment) {
  const out = []
  const re = /[^.!?:]+[.!?:]+|[^.!?:]+$/g
  let match
  while ((match = re.exec(narration))) {
    const raw = match[0]
    const lead = raw.length - raw.trimStart().length
    const startIdx = match.index + lead
    const endIdx = match.index + raw.trimEnd().length - 1
    if (endIdx < startIdx) continue
    out.push({
      text: raw.trim(),
      start: alignment.character_start_times_seconds[Math.min(startIdx, alignment.character_start_times_seconds.length - 1)],
      end: alignment.character_end_times_seconds[Math.min(endIdx, alignment.character_end_times_seconds.length - 1)],
    })
  }
  return out
}

/** Caption text as displayed: spoken forms swapped for their written ones (e.g. "RWA Sonar dot com" → "rwasonar.com"). */
export const displayText = (text, replace = {}) => Object.entries(replace).reduce((s, [spoken, written]) => s.split(spoken).join(written), text)

/** Scene starts/durations (audio + pad) and global caption times; each caption holds until the next one starts. */
export function buildTimeline(short, scenesAudio) {
  let cursor = 0
  const scenes = []
  const captions = []
  short.scenes.forEach((scene, index) => {
    const { seconds, alignment } = scenesAudio[index]
    const duration = seconds + short.padSeconds
    scenes.push({ id: scene.id, start: cursor, duration, audioSeconds: seconds })
    for (const c of sentenceCaptions(scene.narration, alignment)) captions.push({ scene: scene.id, text: displayText(c.text, short.captionReplace), start: cursor + c.start, end: cursor + c.end + 0.25 })
    cursor += duration
  })
  captions.forEach((c, i) => { if (captions[i + 1]) c.end = Math.max(c.end, Math.min(captions[i + 1].start, c.end + 0.6)) })
  return { scenes, captions, total: cursor }
}

/** Evenly spaced character timestamps at `rate` chars/s: only for --stills --estimate before narration exists. */
export function estimatedAlignment(text, rate = 16) {
  const chars = [...text]
  return { characters: chars, character_start_times_seconds: chars.map((_, i) => i / rate), character_end_times_seconds: chars.map((_, i) => (i + 1) / rate) }
}

async function main() {
  const [shortPath, ...flags] = process.argv.slice(2)
  if (!shortPath || flags.includes('--help')) {
    console.log('Usage: node video/render.mjs <short.json> [--stills [--estimate]] [--width 1080]')
    return
  }
  const short = JSON.parse(readFileSync(shortPath, 'utf8'))
  const stills = flags.includes('--stills')
  const estimate = stills && flags.includes('--estimate')
  const widthArg = flags.indexOf('--width')
  const width = widthArg >= 0 ? Number(flags[widthArg + 1]) : 1080
  const height = Math.round((width * 16) / 9)
  const scenesAudio = short.scenes.map((scene) => {
    const paths = sceneAudioPaths(short, scene)
    if (existsSync(paths.mp3)) return { mp3: paths.mp3, seconds: audioSeconds(paths.mp3), alignment: JSON.parse(readFileSync(paths.alignment, 'utf8')) }
    if (estimate) return { mp3: null, seconds: [...scene.narration].length / 16, alignment: estimatedAlignment(scene.narration) }
    throw new Error(`No narration for scene ${scene.id}; run: node video/voice.mjs ${shortPath} --apply (or --stills --estimate)`)
  })
  const timeline = buildTimeline(short, scenesAudio)
  log('timeline', { total: Number(timeline.total.toFixed(2)), estimated: estimate && scenesAudio.some((s) => !s.mp3), scenes: timeline.scenes.map((s) => `${s.id}@${s.start.toFixed(1)}`) })

  const outDir = join(here, 'out')
  mkdirSync(outDir, { recursive: true })
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--allow-file-access-from-files'] })
  try {
    const page = await browser.newPage({ viewport: { width, height } })
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error))
    const assertNoPageErrors = () => { if (pageErrors.length) throw new Error(`stage page error: ${pageErrors[0].stack || pageErrors[0]}`) }
    await page.goto(`${pathToFileURL(join(here, 'stage.html')).href}?short=${short.id}`)
    await page.waitForFunction(() => window.stageReady === true || window.stageError, null, { timeout: 60000 }).catch((error) => { assertNoPageErrors(); throw error })
    const stageError = await page.evaluate(() => window.stageError)
    if (stageError) throw new Error(stageError)
    assertNoPageErrors()
    await page.evaluate((tl) => window.setTimeline(tl), timeline)

    if (stills) {
      // Two moments per scene (45% and 92%), tiled 4 wide into one contact sheet.
      const frames = []
      const tmp = join(outDir, 'stills', short.id)
      rmSync(tmp, { recursive: true, force: true })
      mkdirSync(tmp, { recursive: true })
      let i = 0
      for (const scene of timeline.scenes) for (const frac of [0.45, 0.92]) {
        await page.evaluate((t) => window.renderAt(t), scene.start + frac * scene.duration)
        const file = join(tmp, `${String(i++).padStart(2, '0')}.png`)
        await page.screenshot({ path: file })
        frames.push(file)
      }
      assertNoPageErrors()
      const sheet = join(outDir, `${short.id}-stills.png`)
      execFileSync(FFMPEG, ['-y', '-v', 'error', '-framerate', '1', '-i', join(tmp, '%02d.png'), '-vf', `scale=${Math.round(width / 2)}:-1,tile=4x${Math.ceil(frames.length / 4)}`, '-frames:v', '1', sheet])
      log('stills', { sheet, frames: frames.length, dir: tmp })
      return
    }

    // Narration track: each scene's audio padded to its scene length, concatenated.
    const narration = join(outDir, `${short.id}-narration.m4a`)
    const inputs = scenesAudio.flatMap((s) => ['-i', s.mp3])
    const filter = timeline.scenes.map((s, i) => `[${i}]apad=whole_dur=${s.duration.toFixed(3)}[a${i}]`).join(';') +
      ';' + timeline.scenes.map((_, i) => `[a${i}]`).join('') + `concat=n=${timeline.scenes.length}:v=0:a=1[out]`
    execFileSync(FFMPEG, ['-y', '-v', 'error', ...inputs, '-filter_complex', filter, '-map', '[out]', '-c:a', 'aac', '-b:a', '160k', narration])

    const output = join(outDir, `${short.id}${width === 1080 ? '' : `-${width}`}.mp4`)
    const ffmpeg = spawn(FFMPEG, ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-i', narration,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-shortest', '-movflags', '+faststart', output], { stdio: ['pipe', 'inherit', 'inherit'] })
    const done = new Promise((resolve, reject) => ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)))))
    const frames = Math.ceil(timeline.total * FPS)
    const started = Date.now()
    for (let f = 0; f < frames; f++) {
      await page.evaluate((t) => window.renderAt(t), f / FPS)
      const jpeg = await page.screenshot({ type: 'jpeg', quality: 92 })
      if (!ffmpeg.stdin.write(jpeg)) await new Promise((resolve) => ffmpeg.stdin.once('drain', resolve))
      if (f % (FPS * 5) === 0) {
        const perFrame = (Date.now() - started) / (f + 1)
        log(`frame ${f}/${frames}`, { pct: Math.round((100 * f) / frames), etaSec: Math.round(((frames - f) * perFrame) / 1000) })
      }
    }
    ffmpeg.stdin.end()
    await done
    assertNoPageErrors()
    log('rendered', { output, seconds: Number(timeline.total.toFixed(2)), frames })
  } finally {
    await browser.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(`[${new Date().toISOString()}] failed:`, error); process.exit(1) })
