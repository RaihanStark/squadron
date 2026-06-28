import { ACTIVE, timeAgo } from '../constants.js'

export default function Sidebar({ repos, reposError, active, view, taskList, onSelect }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-head">REPOS {repos.length ? `· ${repos.length}` : ''}</div>
      {reposError && <div className="error">⚠ {reposError}</div>}
      {!reposError && !repos.length && <div className="muted">Loading fleet…</div>}
      {repos.map((r) => {
        const running = taskList.filter((t) => `${t.owner}/${t.repo}` === r.nameWithOwner && ACTIVE.has(t.status)).length
        return (
          <button
            key={r.nameWithOwner}
            className={`repo ${active === r.nameWithOwner && view === 'repo' ? 'active' : ''}`}
            onClick={() => onSelect(r.nameWithOwner)}
          >
            <span className="repo-name">{r.name} {running ? <span className="dot" title={`${running} agent(s) running`} /> : null}</span>
            <span className="repo-meta">{r.isPrivate ? '🔒' : ''} {timeAgo(r.updatedAt)}</span>
          </button>
        )
      })}
    </aside>
  )
}
