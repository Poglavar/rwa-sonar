// Timeline, caption and cost-ledger logic for the RWA Sonar explainer shorts (run: node --test video/render.test.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTimeline, sentenceCaptions, displayText } from './render.mjs'
import { recordBilling } from './voice.mjs'

// One timestamp per character, 0.1 s each, like ElevenLabs' alignment output.
const alignmentFor = (text) => ({
  characters: [...text],
  character_start_times_seconds: [...text].map((_, i) => i * 0.1),
  character_end_times_seconds: [...text].map((_, i) => i * 0.1 + 0.1),
})

test('splits narration into sentences timed by their first and last character', () => {
  const text = 'John checks the docs: one key. It signs alone.'
  const captions = sentenceCaptions(text, alignmentFor(text))
  assert.deepEqual(captions.map((c) => c.text), ['John checks the docs:', 'one key.', 'It signs alone.'])
  assert.equal(captions[1].start, text.indexOf('one') * 0.1)
  assert.ok(Math.abs(captions[2].end - text.length * 0.1) < 1e-9)
})

test('scene lengths are audio plus padding, captions sit on the global clock and carry their scene', () => {
  const short = { padSeconds: 0.5, scenes: [{ id: 'a', narration: 'Hi.' }, { id: 'b', narration: 'Bye.' }] }
  const timeline = buildTimeline(short, [
    { seconds: 2, alignment: alignmentFor('Hi.') },
    { seconds: 3, alignment: alignmentFor('Bye.') },
  ])
  assert.deepEqual(timeline.scenes.map((s) => [s.id, s.start, s.duration]), [['a', 0, 2.5], ['b', 2.5, 3.5]])
  assert.equal(timeline.total, 6)
  assert.equal(timeline.captions[1].start, 2.5)
  assert.deepEqual(timeline.captions.map((c) => c.scene), ['a', 'b'])
})

test('the spoken domain is shown written out in captions', () => {
  const narration = 'Compare them at RWA Sonar dot com.'
  const short = { padSeconds: 0, captionReplace: { 'RWA Sonar dot com': 'rwasonar.com' }, scenes: [{ id: 'outro', narration }] }
  const timeline = buildTimeline(short, [{ seconds: 3, alignment: alignmentFor(narration) }])
  assert.equal(timeline.captions[0].text, 'Compare them at rwasonar.com.')
  assert.equal(displayText('no change', {}), 'no change')
})

test('the cost ledger sums characters per short and overall', () => {
  const ledger = { shorts: {}, totalCharacters: 0 }
  recordBilling(ledger, 'one', 'hook', 'aaa', 100, 't1')
  recordBilling(ledger, 'one', 'outro', 'bbb', 50, 't2')
  recordBilling(ledger, 'two', 'hook', 'ccc', 70, 't3')
  assert.equal(ledger.shorts.one.characters, 150)
  assert.equal(ledger.shorts.two.characters, 70)
  assert.equal(ledger.totalCharacters, 220)
  assert.deepEqual(ledger.shorts.one.requests[1], { scene: 'outro', hash: 'bbb', characters: 50, at: 't2' })
})
