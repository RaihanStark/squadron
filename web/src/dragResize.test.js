import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createResizeDrag } from './dragResize.js'

// Minimal fake window/document so the React-free controller can be exercised
// under `node --test` (no jsdom in this project).
let body, listeners, win, doc
beforeEach(() => {
  body = { style: { userSelect: '' } }
  listeners = {}
  win = {
    addEventListener: (type, fn) => { (listeners[type] ||= new Set()).add(fn) },
    removeEventListener: (type, fn) => { listeners[type]?.delete(fn) },
  }
  doc = { body }
})
const fire = (type, ev) => listeners[type]?.forEach((fn) => fn(ev))

test('start() sets the global lock; a window mouseup clears it', () => {
  const ctl = createResizeDrag(() => {}, { win, doc })
  ctl.start()
  assert.equal(body.style.userSelect, 'none')
  fire('mouseup')
  assert.equal(body.style.userSelect, '')
})

test('onResize fires only while dragging', () => {
  const seen = []
  const ctl = createResizeDrag((x) => seen.push(x), { win, doc })
  fire('mousemove', { clientX: 10 })   // before start: ignored
  ctl.start()
  fire('mousemove', { clientX: 20 })   // dragging: delivered
  fire('mouseup')
  fire('mousemove', { clientX: 30 })   // after release: ignored
  assert.deepEqual(seen, [20])
})

test('destroy() restores user-select even when unmounted mid-drag (issue #47)', () => {
  const ctl = createResizeDrag(() => {}, { win, doc })
  ctl.start()
  assert.equal(body.style.userSelect, 'none')
  ctl.destroy() // simulate the component unmounting before mouseup
  assert.equal(body.style.userSelect, '')
})

test('destroy() removes all window listeners', () => {
  const ctl = createResizeDrag(() => {}, { win, doc })
  ctl.destroy()
  assert.equal(listeners.mousemove.size, 0)
  assert.equal(listeners.mouseup.size, 0)
})
