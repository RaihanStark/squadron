import { useState } from 'react'
import { api } from '../api.js'

export default function NewIssueForm({ repo, onClose, onCreated }) {
  const [owner, name] = repo.nameWithOwner.split('/')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)

  async function save(toGitHub) {
    if (!title.trim()) return
    setBusy(true)
    try {
      await api(`/api/repos/${owner}/${name}/issues${toGitHub ? '' : '/local'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), body }),
      })
      onCreated()
    } catch (e) { alert('Failed: ' + e.message) }
    finally { setBusy(false) }
  }

  return (
    <div className="new-issue">
      <input className="ni-title" placeholder="Title" value={title} autoFocus onChange={(e) => setTitle(e.target.value)} />
      <textarea className="ni-body" placeholder="Description (markdown)…" value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="ni-actions">
        <button className="link-btn" onClick={onClose}>Cancel</button>
        <button className="dispatch" disabled={busy || !title.trim()} onClick={() => save(false)} title="Keep it in Squadron only">
          💾 Save locally
        </button>
        <button className="approve-btn" disabled={busy || !title.trim()} onClick={() => save(true)} title="Create the issue on GitHub">
          {busy ? 'Saving…' : '🐙 Create on GitHub'}
        </button>
      </div>
    </div>
  )
}
