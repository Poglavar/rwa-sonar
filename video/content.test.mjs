// Content guard for the explainer shorts: every script (shorts/*.json) and scene file (scenes/*.js, stage-kit.js)
// must use fictional issuer and protocol names only, and never a branded token symbol (xAAPL, AAPLx, AAPLon, AAPLr).
// Run: node --test video/content.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// Distinctive real names: matched case-insensitively as whole words.
const BANNED = [
  // issuers, brokers and venues of tokenized stocks
  'xStocks', 'Ondo', 'Superstate', 'Securitize', 'Tessera', 'PreStocks', 'Remora', 'Backpack', 'Kraken', 'Robinhood',
  'Dinari', 'Ventuals', 'Stocklana', 'Gemini', 'Coinbase', 'Swarm', 'Mirror', 'Clawpump',
  // Solana DeFi protocols and infrastructure
  'Kamino', 'Loopscale', 'Raydium', 'Meteora', 'marginfi', 'Solend', 'Marinade', 'Sanctum', 'Lifinity', 'OpenBook',
  'Squads', 'Pyth', 'Switchboard', 'Exponent', 'RateX', 'Hawksight', 'Tensor', 'Phantom', 'Solflare',
  // names suggested for the shorts that collide with real crypto projects
  'Harbor', 'Bluefin', 'Kelp', 'Reef', 'Reefswap',
]
// Real names that are also ordinary English words: matched only when capitalised.
const BANNED_CAPITALISED = ['Backed', 'Bullish', 'Shift', 'Republic', 'Jupiter', 'Orca', 'Drift', 'Save', 'Phoenix', 'Carrot']
// Branded token symbols built on a stock ticker: xAAPL, AAPLx, AAPLon, AAPLr.
const BRANDED_SYMBOL = /\b(?:x[A-Z]{2,5}|[A-Z]{2,5}(?:x|on|r))\b/

export function findViolations(text) {
  const hits = []
  for (const name of BANNED) if (new RegExp(`\\b${name}\\b`, 'i').test(text)) hits.push(name)
  for (const name of BANNED_CAPITALISED) if (new RegExp(`\\b${name}\\b`).test(text)) hits.push(name)
  const symbol = text.match(BRANDED_SYMBOL)
  if (symbol) hits.push(symbol[0])
  return hits
}

const files = [
  ...readdirSync(join(here, 'shorts')).filter((f) => f.endsWith('.json')).map((f) => join('shorts', f)),
  ...readdirSync(join(here, 'scenes')).filter((f) => f.endsWith('.js')).map((f) => join('scenes', f)),
  'stage-kit.js',
]

test('the guard itself catches real names and branded symbols', () => {
  assert.deepEqual(findViolations('Deposit AAPLx on Kamino'), ['Kamino', 'AAPLx'])
  assert.deepEqual(findViolations('The Shift team'), ['Shift'])
  assert.deepEqual(findViolations('const shift = 1; AAPL · Oakmere'), [])
  assert.deepEqual(findViolations('xNVDA'), ['xNVDA'])
})

for (const file of files) {
  test(`${file} uses only fictional names and plain tickers`, () => {
    const text = readFileSync(join(here, file), 'utf8')
    assert.deepEqual(findViolations(text), [], `${file} mentions a real issuer/protocol or a branded token symbol`)
  })
}

test('every short has a narration line per scene and ends by pointing to the site', () => {
  for (const file of files.filter((f) => f.endsWith('.json'))) {
    const short = JSON.parse(readFileSync(join(here, file), 'utf8'))
    assert.ok(short.scenes.every((s) => typeof s.narration === 'string' && s.narration.length > 0), file)
    assert.match(short.scenes.at(-1).narration, /RWA Sonar dot com/, `${file} must end by pointing to rwasonar.com`)
  }
})
