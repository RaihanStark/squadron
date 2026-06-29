import { timeAgo } from '../constants.js'

// Pick who works a task: a new agent (clean slate) or an existing person, who
// resumes the context they already built — saving the re-exploration tokens.
// Renders nothing when there's nobody to assign yet. `value` is an agentId or ''.
export default function AgentPicker({ agents, repo, value, onChange }) {
  const assignable = agents.filter((a) => a.assignable)
  if (!assignable.length) return null
  // Surface the people who already know this repo first.
  const sorted = [...assignable].sort((a, b) => (b.repos.includes(repo) ? 1 : 0) - (a.repos.includes(repo) ? 1 : 0))
  return (
    <label className="agent-picker" title="Assign a person to this task. An existing agent resumes the context it already built (saves tokens); a new one starts clean.">
      <span className="muted">Assign</span>
      <select className="model-select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">🆕 New agent</option>
        {sorted.map((a) => (
          <option key={a.agentId} value={a.agentId}>
            🎖 {a.name}{a.repos.includes(repo) ? ' · knows this repo' : ''} · {timeAgo(a.lastActiveAt)}
          </option>
        ))}
      </select>
    </label>
  )
}
