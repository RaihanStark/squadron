import StatusBadge from './StatusBadge.jsx'
import AgentDetail from './AgentDetail.jsx'

export default function AgentsPanel({ tasks, selected, setSelected, onOpenChanges }) {
  const sel = tasks.find((t) => t.id === selected) || tasks[0]
  return (
    <div className="agents">
      <div className="agents-list">
        <div className="sidebar-head">AGENTS {tasks.length ? `· ${tasks.length}` : ''}</div>
        {!tasks.length && <div className="muted pad">No agents dispatched yet. Hit ⚡ Dispatch on an issue.</div>}
        {tasks.map((t) => (
          <button
            key={t.id}
            className={`agent-row ${sel?.id === t.id ? 'active' : ''}`}
            onClick={() => setSelected(t.id)}
          >
            <div className="agent-row-top">
              <span className="title">{t.repo} <span className="muted">{t.issueNumber ? `#${t.issueNumber}` : '⚡'}</span></span>
              <StatusBadge status={t.status} />
            </div>
            <span className="muted">{t.issueTitle}</span>
          </button>
        ))}
      </div>
      <div className="agent-detail">
        {sel ? <AgentDetail task={sel} onOpenChanges={onOpenChanges} /> : <div className="empty">No agent selected.</div>}
      </div>
    </div>
  )
}
