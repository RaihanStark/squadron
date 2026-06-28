import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { notifyTransition } from './notify.js'

// Minimal in-memory localStorage + Notification stubs so the React-free notify
// module can be exercised under `node --test`.
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}
globalThis.window = { focus() {} }

class FakeNotification {
  static permission = 'granted'
  static created = []
  constructor(title, opts) {
    this.title = title
    this.options = opts
    this.onclick = null
    FakeNotification.created.push(this)
  }
}
globalThis.Notification = FakeNotification

const TASK = { id: 'abc123', owner: 'me', repo: 'proj', issueNumber: 7, issueTitle: 'Fix bug' }

beforeEach(() => {
  store.clear()
  FakeNotification.permission = 'granted'
  FakeNotification.created = []
})

test('fires a notification for a watched transition with title + body', () => {
  const n = notifyTransition({ ...TASK, status: 'changes_ready' }, {})
  assert.ok(n)
  assert.equal(FakeNotification.created.length, 1)
  assert.equal(n.title, '✅ Ready to Review')
  assert.equal(n.options.body, 'me/proj #7 · Fix bug')
  assert.equal(n.options.tag, 'abc123')
})

test('error and interrupted both map to the failed category', () => {
  assert.equal(notifyTransition({ ...TASK, status: 'error' }, {}).title, '❌ Run failed')
  assert.equal(notifyTransition({ ...TASK, status: 'interrupted' }, {}).title, '❌ Run failed')
})

test('non-watched transitions are ignored', () => {
  assert.equal(notifyTransition({ ...TASK, status: 'committing' }, {}), null)
  assert.equal(notifyTransition({ ...TASK, status: 'running' }, {}), null)
  assert.equal(FakeNotification.created.length, 0)
})

test('respects a muted per-type pref', () => {
  store.set('squadron.notify.waiting', 'false')
  assert.equal(notifyTransition({ ...TASK, status: 'waiting' }, {}), null)
  assert.equal(FakeNotification.created.length, 0)
})

test('pr_open is off by default but on when explicitly enabled', () => {
  assert.equal(notifyTransition({ ...TASK, status: 'pr_open' }, {}), null)
  store.set('squadron.notify.pr_open', 'true')
  assert.ok(notifyTransition({ ...TASK, status: 'pr_open' }, {}))
})

test('skips when permission is not granted', () => {
  FakeNotification.permission = 'denied'
  assert.equal(notifyTransition({ ...TASK, status: 'waiting' }, {}), null)
  FakeNotification.permission = 'default'
  assert.equal(notifyTransition({ ...TASK, status: 'waiting' }, {}), null)
})

test('onclick invokes the supplied navigator with the task', () => {
  let clicked = null
  const task = { ...TASK, status: 'waiting' }
  const n = notifyTransition(task, { onClick: (t) => { clicked = t } })
  n.onclick()
  assert.equal(clicked, task)
})
