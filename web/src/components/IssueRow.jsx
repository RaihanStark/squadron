import { useState } from 'react'
import { ACTIVE, timeAgo } from '../constants.js'
import StatusBadge from './StatusBadge.jsx'

export default function IssueRow({ issue: it, task, onDispatch, onOpenTask, onOpenIssue }) {
  const [model, setModel] = useState('opus')
  const [busy, setBusy] = useState(false) // guard against double-click creating two agents
  // An in-flight task owns this issue — show its live status and a way to jump
  // to it, rather than offering a second Plan (which the backend would dedupe).
  const inflight = task && ACTIVE.has(task.status)
  const verb = task?.status === 'planning' ? 'planning…'
    : task?.status === 'planned' ? 'plan ready'
    : task?.status === 'waiting' ? 'needs you'
    : task?.status === 'changes_ready' ? 'changes ready'
    : 'in progress'
  const stop = (e) => e.stopPropagation()
  return (
    <div className="card card-click" onClick={onOpenIssue}>
      <div className="card-main">
        {it.local ? <span className="badge local-badge">draft</span> : <span className="num">#{it.number}</span>}
        <span className="title">{it.title}</span>
      </div>
      <div className="card-meta">
        {it.labels?.map((l) => (
          <span key={l.name} className="label" style={{ '--c': `#${l.color}` }}>{l.name}</span>
        ))}
        <span className="muted">{it.local ? 'local draft' : `${it.comments} 💬`} · {timeAgo(it.updatedAt)}</span>
        {task && task.status !== 'pr_open' && <StatusBadge status={task.status} />}
        {inflight ? (
          <button className="dispatch view-btn" onClick={(e) => { stop(e); onOpenTask(task.id) }}>
            👁 View {verb}
          </button>
        ) : (
          <span className="row-actions" onClick={stop}>
            <select className="model-select" value={model} onChange={(e) => setModel(e.target.value)} title="Model for this plan">
              <option value="opus">Opus</option>
              <option value="sonnet">Sonnet</option>
              <option value="haiku">Haiku</option>
            </select>
            <button className="dispatch" disabled={busy} onClick={() => { setBusy(true); Promise.resolve(onDispatch(it, model)).finally(() => setBusy(false)) }}>{busy ? '…' : '📋 Plan'}</button>
          </span>
        )}
      </div>
    </div>
  )
}
