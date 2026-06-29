// Agents (persons) derived from their tasks. An agent is a stable agentId +
// callsign that spans the tasks it works, carrying its session/context forward.
// Mirrors the server's RESUMABLE_STATUS so the roster agrees on who's assignable.
const RESUMABLE_STATUS = ['pr_open', 'no_changes', 'review_posted', 'cancelled']

export function rosterFromTasks(tasks) {
  const byId = new Map()
  for (const t of [...tasks].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))) {
    if (!t.agentId) continue
    let a = byId.get(t.agentId)
    if (!a) { a = { agentId: t.agentId, name: t.agentName, repos: new Set(), lastActiveAt: 0, assignable: false }; byId.set(t.agentId, a) }
    if (t.agentName) a.name = t.agentName
    a.repos.add(`${t.owner}/${t.repo}`)
    a.lastActiveAt = Math.max(a.lastActiveAt, t.createdAt || 0)
    if (t.sessionId && RESUMABLE_STATUS.includes(t.status)) a.assignable = true // tasks sorted asc → reflects latest
  }
  return [...byId.values()]
    .map((a) => ({ ...a, repos: [...a.repos] }))
    .sort((x, y) => y.lastActiveAt - x.lastActiveAt)
}

// Map an AgentPicker value to the dispatch options:
//   'auto'      → {} (let the General route it — the default)
//   'new'       → { fresh: true } (force a clean agent)
//   '<agentId>' → { agentId } (pin a specific person)
export function assignmentOpts(value) {
  if (value === 'new') return { fresh: true }
  if (value && value !== 'auto') return { agentId: value }
  return {}
}
