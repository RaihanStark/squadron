import { test } from 'node:test'
import assert from 'node:assert/strict'
import { textDelta } from './agent.js'

test('textDelta returns the text of a text_delta stream event', () => {
  const msg = { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } } }
  assert.equal(textDelta(msg), 'hello')
})

test('textDelta preserves empty-string deltas (distinct from null)', () => {
  const msg = { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '' } } }
  assert.equal(textDelta(msg), '')
})

test('textDelta ignores tool-input (input_json_delta) deltas', () => {
  const msg = { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"a":' } } }
  assert.equal(textDelta(msg), null)
})

test('textDelta ignores thinking deltas so reasoning never leaks to the log', () => {
  const msg = { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } }
  assert.equal(textDelta(msg), null)
})

test('textDelta ignores block boundary and non-stream messages', () => {
  assert.equal(textDelta({ type: 'stream_event', event: { type: 'content_block_stop' } }), null)
  assert.equal(textDelta({ type: 'assistant', message: { content: [{ type: 'text', text: 'final' }] } }), null)
  assert.equal(textDelta({ type: 'result', result: 'done' }), null)
  assert.equal(textDelta(null), null)
  assert.equal(textDelta(undefined), null)
})
