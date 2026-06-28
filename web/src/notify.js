// OS-native desktop notifications for agent lifecycle transitions (issue #32).
//
// Driven from the renderer: App.jsx already receives every task status change over
// SSE and owns the navigation state, so we fire the standard `Notification` API on
// watched transitions. In Electron's renderer this surfaces as a native OS toast;
// in a plain browser it works once permission is granted and is a silent no-op
// otherwise. No Electron main-process / IPC plumbing required.

// Watched status -> notification config. `error` and `interrupted` collapse onto a
// single 'failed' pref so muting "Run failed" covers both. PR-opened defaults off
// since it's the optional, lower-signal one.
const WATCHED = {
  changes_ready: { title: '✅ Ready to Review', prefKey: 'changes_ready', prefDefault: true },
  waiting: { title: '❓ Needs input', prefKey: 'waiting', prefDefault: true },
  error: { title: '❌ Run failed', prefKey: 'failed', prefDefault: true },
  interrupted: { title: '❌ Run failed', prefKey: 'failed', prefDefault: true },
  pr_open: { title: '⬆ PR opened', prefKey: 'pr_open', prefDefault: false },
}

// The per-event-type prefs and their defaults, exported so the settings UI can
// render a toggle per category without duplicating the list.
export const NOTIFY_PREFS = [
  { key: 'changes_ready', label: '✅ Ready to Review', fallback: true },
  { key: 'waiting', label: '❓ Needs input', fallback: true },
  { key: 'failed', label: '❌ Run failed', fallback: true },
  { key: 'pr_open', label: '⬆ PR opened', fallback: false },
]

// Mirror prefs.js's localStorage convention without importing it — prefs.js pulls
// in React (for usePref), and this module stays React-free so it can be unit-tested
// under `node --test`.
function notifyEnabled(prefKey, fallback) {
  try {
    const s = localStorage.getItem(`squadron.notify.${prefKey}`)
    return s != null ? JSON.parse(s) : fallback
  } catch { return fallback }
}

// Ask for notification permission once, early. No-op when unsupported or already
// decided (granted/denied) so we never nag.
export function requestNotifyPermission() {
  if (typeof Notification === 'undefined') return
  if (Notification.permission === 'default') {
    try { Notification.requestPermission().catch(() => {}) } catch { /* older sync API */ }
  }
}

// Fire a notification for a task whose status just transitioned. Returns the
// Notification (handy for tests) or null when skipped. `onClick(task)` is invoked
// when the user clicks the toast — App passes a navigator that deep-links the view.
export function notifyTransition(task, { onClick } = {}) {
  if (typeof Notification === 'undefined') return null
  const cfg = WATCHED[task?.status]
  if (!cfg) return null
  if (Notification.permission !== 'granted') return null
  if (!notifyEnabled(cfg.prefKey, cfg.prefDefault)) return null

  const repo = task.owner && task.repo ? `${task.owner}/${task.repo}` : ''
  const num = task.issueNumber != null ? ` #${task.issueNumber}` : ''
  const title = task.issueTitle ? ` · ${task.issueTitle}` : ''
  const body = `${repo}${num}${title}`.trim()

  let n
  try {
    // tag collapses duplicate emits of the same status for one task into one toast.
    n = new Notification(cfg.title, { body, tag: task.id })
  } catch { return null }
  n.onclick = () => {
    try { window.focus() } catch { /* non-window env */ }
    onClick?.(task)
  }
  return n
}
