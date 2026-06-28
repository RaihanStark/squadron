import { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { timeAgo } from '../constants.js'

// On-demand picker for adding a repo to the curated sidebar fleet. Opening it is
// the only thing that triggers a full `gh repo list` (via /api/repos/all).
export default function AddRepoPicker({ selected, onAdd, onClose }) {
  const [all, setAll] = useState(null)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    api('/api/repos/all')
      .then(setAll)
      .catch((e) => setError(e.message))
  }, [])

  const taken = useMemo(() => new Set(selected), [selected])
  const matches = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (all || [])
      .filter((r) => !taken.has(r.nameWithOwner))
      .filter((r) => !q || r.nameWithOwner.toLowerCase().includes(q))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
  }, [all, taken, filter])

  return (
    <div className="repo-picker">
      <input
        className="repo-picker-filter"
        placeholder="Filter repos…"
        value={filter}
        autoFocus
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
      />
      <div className="repo-picker-list">
        {error && <div className="error">⚠ {error}</div>}
        {!error && all === null && <div className="muted">Loading repos…</div>}
        {!error && all !== null && !matches.length && (
          <div className="muted">{filter.trim() ? 'No matching repos.' : 'No more repos to add.'}</div>
        )}
        {matches.map((r) => (
          <button key={r.nameWithOwner} className="repo-picker-item" onClick={() => onAdd(r.nameWithOwner)}>
            <span className="repo-name">{r.name} <span className="repo-owner">{r.owner?.login}</span></span>
            <span className="repo-meta">{r.isPrivate ? '🔒' : ''} {timeAgo(r.updatedAt)}</span>
          </button>
        ))}
      </div>
      <button className="link-btn" onClick={onClose}>Cancel</button>
    </div>
  )
}
