import { useState } from 'react'
import { ACTIVE, timeAgo } from '../constants.js'
import AddRepoPicker from './AddRepoPicker.jsx'

export default function Sidebar({ repos, reposError, active, view, taskList, onSelect, onAddRepo, onRemoveRepo }) {
  const [picking, setPicking] = useState(false)

  const add = (nwo) => { onAddRepo(nwo); setPicking(false) }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span>REPOS {repos.length ? `· ${repos.length}` : ''}</span>
        <button className="add-repo-btn" title="Add a repo to your fleet" onClick={() => setPicking((p) => !p)}>
          {picking ? '×' : '+ Add'}
        </button>
      </div>
      {picking && <AddRepoPicker selected={repos.map((r) => r.nameWithOwner)} onAdd={add} onClose={() => setPicking(false)} />}
      {reposError && <div className="error">⚠ {reposError}</div>}
      {!reposError && !repos.length && !picking && <div className="muted">No repos yet — add one to begin.</div>}
      {repos.map((r) => {
        const running = taskList.filter((t) => `${t.owner}/${t.repo}` === r.nameWithOwner && ACTIVE.has(t.status)).length
        return (
          <div
            key={r.nameWithOwner}
            className={`repo ${active === r.nameWithOwner && view === 'repo' ? 'active' : ''}`}
            onClick={() => onSelect(r.nameWithOwner)}
            role="button"
          >
            <span className="repo-row">
              <span className="repo-name">{r.name} {running ? <span className="dot" title={`${running} agent(s) running`} /> : null}</span>
              <button
                className="repo-remove"
                title="Remove from fleet"
                onClick={(e) => { e.stopPropagation(); onRemoveRepo(r.nameWithOwner) }}
              >×</button>
            </span>
            <span className="repo-meta">{r.isPrivate ? '🔒' : ''} {timeAgo(r.updatedAt)}</span>
          </div>
        )
      })}
    </aside>
  )
}
