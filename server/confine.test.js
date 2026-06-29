import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeConfineHook } from './confine.js'

// Pull the single PreToolUse hook out of the structure makeConfineHook returns.
function hookFor(worktree) {
  return makeConfineHook(worktree).PreToolUse[0].hooks[0]
}

const WT = '/home/u/.squadron/worktrees/abc'

test('confine hook allows WebSearch / WebFetch — web access is not a filesystem escape', async () => {
  const hook = hookFor(WT)

  // WebSearch carries a `query`, WebFetch a `url` — neither is a path, so the
  // confinement guard must let them through (empty object = no deny decision).
  assert.deepEqual(
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'WebSearch', tool_input: { query: 'how to use zod' } }),
    {},
  )
  assert.deepEqual(
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url: 'https://example.com/docs', prompt: 'summarize' } }),
    {},
  )
})

test('confine hook still denies a filesystem escape (allow above is meaningful)', async () => {
  const hook = hookFor(WT)
  const res = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/etc/passwd' } })
  assert.equal(res.hookSpecificOutput?.permissionDecision, 'deny')
})
