import { timeAgo } from '../constants.js'

// Who works a task. By default the GENERAL auto-routes it to the best agent
// (reusing context to save tokens); you can override to pin a specific person or
// force a fresh agent. `value` is 'auto' | 'new' | '<agentId>'.
export default function AgentPicker({ agents, repo, value, onChange }) {
  const assignable = agents.filter((a) => a.assignable)
  // Surface the people who already know this repo first.
  const sorted = [...assignable].sort((a, b) => (b.repos.includes(repo) ? 1 : 0) - (a.repos.includes(repo) ? 1 : 0))
  return (
    <label className="agent-picker" title="The General auto-assigns the best agent for this task — continuing one whose context fits (saves tokens) or starting fresh. Override to pin a specific person or force a new agent.">
      <span className="muted">Agent</span>
      <select className="model-select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="auto">🎖 General — auto-assign</option>
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
