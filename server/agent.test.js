import { test } from 'node:test'
import assert from 'node:assert/strict'
import { textDelta, describeTool, normalizeChoice, normalizeChangeName } from './agent.js'

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

test('describeTool renders known tools and falls back for unknown ones', () => {
  assert.equal(describeTool({ name: 'Bash', input: { command: 'ls -la' } }), '$ ls -la')
  assert.equal(describeTool({ name: 'Read', input: { file_path: 'a.js' } }), '📖 read a.js')
  assert.equal(describeTool({ name: 'mcp__squadron__read_diff', input: {} }), '🔧 mcp__squadron__read_diff')
})

test('describeTool renders a Task delegation with the subagent type and description', () => {
  assert.equal(describeTool({ name: 'Task', input: { subagent_type: 'scout', description: 'find auth usages' } }), '🤝 scout: find auth usages')
  assert.equal(describeTool({ name: 'Task', input: {} }), '🤝 subagent')
})

test('normalizeChoice trims a real agentId and caps the reason', () => {
  const r = normalizeChoice({ agentId: '  agent-7 ', reason: '  picked it  ' })
  assert.equal(r.agentId, 'agent-7')
  assert.equal(r.reason, 'picked it')
  assert.equal(normalizeChoice({ agentId: 'x', reason: 'y'.repeat(500) }).reason.length, 200)
})

test('normalizeChoice maps blank/non-string agentId and empty reason to null', () => {
  assert.deepEqual(normalizeChoice({ agentId: '   ', reason: '' }), { agentId: null, reason: null })
  assert.deepEqual(normalizeChoice({ agentId: 42, reason: null }), { agentId: null, reason: null })
  assert.deepEqual(normalizeChoice(), { agentId: null, reason: null })
})

test('normalizeChangeName collapses whitespace and caps the title at 72 chars', () => {
  const r = normalizeChangeName({ title: '  add\n  the   thing ', commit: ' feat: add thing ' })
  assert.equal(r.title, 'add the thing')
  assert.equal(r.commit, 'feat: add thing')
  assert.equal(normalizeChangeName({ title: 'x'.repeat(100), commit: '' }).title.length, 72)
})

test('normalizeChangeName returns null only when both fields are empty', () => {
  assert.equal(normalizeChangeName({ title: '', commit: '   ' }), null)
  assert.equal(normalizeChangeName(), null)
  assert.deepEqual(normalizeChangeName({ commit: 'fix: x' }), { title: null, commit: 'fix: x' })
})
