import { isInactive } from '../constants.js'
import StatusBadge from './StatusBadge.jsx'
import AgentDetail from './AgentDetail.jsx'

export default function AgentsPanel({ tasks, selected, setSelected, onOpenChanges, onDismiss, onClearInactive }) {
  const sel = tasks.find((t) => t.id === selected) || tasks[0]
  const inactiveCount = tasks.filter((t) => isInactive(t.status)).length
  return (
    <div className="agents">
      <div className="agents-list">
        <div className="sidebar-head agents-head">
          <span>AGENTS {tasks.length ? `· ${tasks.length}` : ''}</span>
          {inactiveCount > 0 && onClearInactive && (
            <button className="clear-inactive" onClick={onClearInactive} title="Dismiss finished, cancelled, errored and interrupted agents">
              Clear {inactiveCount} inactive
            </button>
          )}
        </div>
        {!tasks.length && <div className="muted pad">No agents dispatched yet. Hit ⚡ Dispatch on an issue.</div>}
        {tasks.map((t) => (
          <div
            key={t.id}
            className={`agent-row ${sel?.id === t.id ? 'active' : ''}`}
            onClick={() => setSelected(t.id)}
          >
            <div className="agent-row-top">
              <span className="title">{t.agentName ? <span className="callsign">🎖 {t.agentName}</span> : t.repo} <span className="muted">{t.repo}{t.issueNumber ? ` #${t.issueNumber}` : ' ⚡'}</span></span>
              <span className="agent-row-actions">
                <StatusBadge status={t.status} />
                {isInactive(t.status) && onDismiss && (
                  <button
                    className="agent-dismiss"
                    title="Dismiss this agent"
                    onClick={(e) => { e.stopPropagation(); onDismiss(t.id) }}
                  >×</button>
                )}
              </span>
            </div>
            <span className="muted">{t.issueTitle}</span>
          </div>
        ))}
      </div>
      <div className="agent-detail">
        {sel ? <AgentDetail task={sel} onOpenChanges={onOpenChanges} /> : <div className="empty">No agent selected.</div>}
      </div>
    </div>
  )
}
