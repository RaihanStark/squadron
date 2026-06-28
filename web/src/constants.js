// Task status sets + labels shared across components.
export const ACTIVE = new Set(['queued', 'preparing', 'planning', 'planned', 'running', 'errand_idle', 'waiting', 'committing', 'changes_ready', 'pushing', 'opening_pr', 'reviewing', 'reviewed', 'posting', 'releasing'])
export const NEEDS_YOU = new Set(['planned', 'waiting', 'reviewed', 'changes_ready', 'errand_idle'])

// Statuses where the agent is actively chewing (shows a live "working" indicator)
// — excludes the awaiting-you states (planned/reviewed/waiting).
export const WORKING_LABEL = {
  queued: 'queued…', preparing: 'preparing…', planning: 'planner thinking…',
  running: 'agent working…', reviewing: 'reviewing the diff…', committing: 'committing…',
  pushing: 'pushing…', opening_pr: 'opening PR…', posting: 'posting…', releasing: 'cutting release…',
}

export const STATUS_LABEL = {
  queued: 'queued', preparing: 'preparing', planning: 'planning', planned: 'plan ready',
  running: 'running', errand_idle: 'your move', waiting: 'needs you', committing: 'committing',
  changes_ready: 'changes ready', pushing: 'pushing',
  opening_pr: 'opening PR', pr_open: 'PR open', no_changes: 'no changes',
  reviewing: 'reviewing', reviewed: 'review ready', posting: 'posting', review_posted: 'review posted',
  releasing: 'releasing', released: 'released',
  cancelled: 'cancelled', error: 'error', interrupted: 'interrupted',
}

export function timeAgo(iso) {
  if (!iso) return ''
  const s = (Date.now() - new Date(iso)) / 1000
  for (const [label, secs] of [['y', 31536000], ['mo', 2592000], ['d', 86400], ['h', 3600], ['m', 60]]) {
    const v = Math.floor(s / secs)
    if (v >= 1) return `${v}${label} ago`
  }
  return 'just now'
}
