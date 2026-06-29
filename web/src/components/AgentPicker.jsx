import { timeAgo } from '../constants.js'

// Who works a task. By default the MARSHAL auto-routes it to the best agent
// (reusing context to save tokens); you can override to force a fresh agent.
// `value` is 'auto' | 'new' | '<agentId>'. In `compact` mode only the two
// high-level choices are offered (Marshal vs. New) — the Marshal still picks the
// best existing agent under the hood, so there's no per-person list to wade through.
export default function AgentPicker({ agents = [], repo, value, onChange, compact = false }) {
  // Surface the people who already know this repo first (full mode only).
  const sorted = compact ? [] : [...agents.filter((a) => a.assignable)].sort((a, b) => (b.repos.includes(repo) ? 1 : 0) - (a.repos.includes(repo) ? 1 : 0))
  return (
    <label className="agent-picker" title="The Marshal auto-assigns the best agent for this task — continuing one whose context fits (saves tokens) or starting fresh. Override to pin a specific person or force a new agent.">
      <span className="muted">Agent</span>
      <select className="model-select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="auto">🎖 Marshal — auto-assign</option>
        <option value="new">🆕 New agent</option>
        {sorted.map((a) => (
          <option key={a.agentId} value={a.agentId}>
            🎖 {a.name}{a.repos.includes(repo) ? ' · knows this repo' : ''} · {timeAgo(a.lastActiveAt)}
          </option>
        ))}
      </select>
    </label>
  )
}
