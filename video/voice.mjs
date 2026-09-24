#!/usr/bin/env node
/**
 * Narration for an RWA Sonar explainer short: one ElevenLabs request per scene (with character timestamps, for
 * captions), cached by content hash so an unchanged line is never billed twice. Every billed request is written
 * to the cost ledger out/voice-costs.json (characters per scene and per short) and a running total is printed.
 * Usage: node video/voice.mjs <short.json> [--apply]   (without --apply it only prints what would be billed)
 * Needs ELEVENLABS_API_KEY in the environment or in video/.env. The key is never printed.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const LEDGER = join(here, 'out', 'voice-costs.json')
const log = (message, details = {}) => console.log(`[${new Date().toISOString()}] ${message}${Object.keys(details).length ? ' ' + JSON.stringify(details) : ''}`)

function apiKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY
  const envPath = join(here, '.env')
  const line = existsSync(envPath) ? readFileSync(envPath, 'utf8').split('\n').find((l) => l.startsWith('ELEVENLABS_API_KEY=')) : null
  return line ? line.slice('ELEVENLABS_API_KEY='.length).trim().replace(/^["']|["']$/g, '') : ''
}

export function sceneAudioPaths(short, scene) {
  const hash = createHash('sha256').update(JSON.stringify([short.voice.id, short.voice.model, scene.narration])).digest('hex').slice(0, 12)
  const base = join(here, 'cache', short.id, `${scene.id}-${hash}`)
  return { mp3: `${base}.mp3`, alignment: `${base}.json`, hash }
}

/** Adds one billed request to the ledger object and recomputes the per-short and overall totals. */
export function recordBilling(ledger, shortId, sceneId, hash, characters, at = new Date().toISOString()) {
  const short = (ledger.shorts[shortId] ??= { requests: [], characters: 0 })
  short.requests.push({ scene: sceneId, hash, characters, at })
  short.characters = short.requests.reduce((sum, r) => sum + r.characters, 0)
  ledger.totalCharacters = Object.values(ledger.shorts).reduce((sum, s) => sum + s.characters, 0)
  return ledger
}

const readLedger = () => (existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : { shorts: {}, totalCharacters: 0 })

async function main() {
  const [shortPath, ...flags] = process.argv.slice(2)
  if (!shortPath || flags.includes('--help')) {
    console.log('Usage: node video/voice.mjs <short.json> [--apply]')
    return
  }
  const apply = flags.includes('--apply')
  const short = JSON.parse(readFileSync(shortPath, 'utf8'))
  const todo = short.scenes.filter((scene) => !existsSync(sceneAudioPaths(short, scene).mp3))
  const chars = todo.reduce((sum, scene) => sum + scene.narration.length, 0)
  const ledger = readLedger()
  log('plan', { short: short.id, scenes: short.scenes.length, cached: short.scenes.length - todo.length, toGenerate: todo.length, billableCharacters: chars, ledgerTotalSoFar: ledger.totalCharacters })
  if (!apply || !todo.length) return
  const key = apiKey()
  if (!key) throw new Error('ELEVENLABS_API_KEY is not set (environment or video/.env)')
  let billed = 0
  for (const [index, scene] of todo.entries()) {
    const paths = sceneAudioPaths(short, scene)
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${short.voice.id}/with-timestamps?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ text: scene.narration, model_id: short.voice.model, voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.2 } }),
    })
    if (!response.ok) throw new Error(`ElevenLabs ${response.status} for scene ${scene.id}: ${(await response.text()).slice(0, 300)}`)
    const body = await response.json()
    mkdirSync(dirname(paths.mp3), { recursive: true })
    writeFileSync(paths.mp3, Buffer.from(body.audio_base64, 'base64'))
    writeFileSync(paths.alignment, JSON.stringify(body.alignment))
    billed += scene.narration.length
    // Ledger written after every request, so a crash mid-short never loses a billed line.
    mkdirSync(dirname(LEDGER), { recursive: true })
    writeFileSync(LEDGER, JSON.stringify(recordBilling(ledger, short.id, scene.id, paths.hash, scene.narration.length), null, 2) + '\n')
    log(`scene ${index + 1}/${todo.length} voiced`, { scene: scene.id, characters: scene.narration.length, billedSoFar: billed })
  }
  log('done', { short: short.id, billedCharacters: billed, shortTotal: ledger.shorts[short.id].characters, ledgerTotal: ledger.totalCharacters, ledger: LEDGER })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(`[${new Date().toISOString()}] failed:`, error.message); process.exit(1) })
