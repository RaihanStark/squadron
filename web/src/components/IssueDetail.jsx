import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { ACTIVE } from '../constants.js'

export default function IssueDetail({ repo, issue, me, task, onDispatch, onOpenTask, onBack }) {
  const [owner, name] = repo.nameWithOwner.split('/')
  const [model, setModel] = useState('opus')
  const [full, setFull] = useState(issue.local ? issue : null)
  const [error, setError] = useState(null)
  const [acting, setActing] = useState(false)
  const [editing, setEditing] = useState(false)
  const [eTitle, setETitle] = useState('')
  const [eBody, setEBody] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  useEffect(() => {
    setEditing(false)
    setConfirmingDelete(false)
    if (issue.local) { setFull(issue); return }
    setFull(null); setError(null)
    api(`/api/repos/${owner}/${name}/issues/${issue.number}`).then(setFull).catch((e) => setError(e.message))
  }, [repo.nameWithOwner, issue.number, issue.id])

  const inflight = task && ACTIVE.has(task.status)
  // Editable if it's a local draft, a repo you own, or an issue you authored.
  const authorLogin = full?.author?.login || issue.author?.login
  const editable = issue.local || (me && (me === owner || me === authorLogin))
  const title = full?.title ?? issue.title

  function startEdit() {
    setETitle(title)
    setEBody(full?.body || '')
    setEditing(true)
  }
  async function saveEdit() {
    setActing(true)
    try {
      const path = issue.local
        ? `/api/repos/${owner}/${name}/issues/local/${issue.id}`
        : `/api/repos/${owner}/${name}/issues/${issue.number}`
      const updated = await api(path, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: eTitle.trim(), body: eBody }),
      })
      setFull(updated)
      setEditing(false)
    } catch (e) { alert('Save failed: ' + e.message) }
    finally { setActing(false) }
  }

  async function postToGitHub() {
    setActing(true)
    try { const r = await api(`/api/repos/${owner}/${name}/issues/local/${issue.id}/post`, { method: 'POST' }); window.open(r.url, '_blank'); onBack() }
    catch (e) { alert('Failed: ' + e.message) } finally { setActing(false) }
  }
  async function del() {
    try { await api(`/api/repos/${owner}/${name}/issues/local/${issue.id}`, { method: 'DELETE' }); onBack() } catch (e) { alert(e.message) }
  }

  return (
    <>
      <div className="main-head pr-head">
        <div className="issue-head-main">
          <button className="link-btn" onClick={onBack}>← back</button>
          {editing ? (
            <input className="ni-title issue-edit-title" value={eTitle} autoFocus onChange={(e) => setETitle(e.target.value)} />
          ) : (
            <h1>
              {issue.local ? <span className="badge local-badge">draft</span> : <a href={issue.url} target="_blank" rel="noreferrer">#{issue.number}</a>}
              {' '}{title}
            </h1>
          )}
        </div>
        <div className="agent-actions">
          {editing ? (
            <>
              <button className="link-btn" onClick={() => setEditing(false)}>Cancel</button>
              <button className="approve-btn" disabled={acting || !eTitle.trim()} onClick={saveEdit}>{acting ? 'Saving…' : '💾 Save'}</button>
            </>
          ) : (
            <>
              {editable && <button className="dispatch" onClick={startEdit}>✎ Edit</button>}
              {issue.local && (confirmingDelete ? (
                <>
                  <span className="confirm-text">Delete draft?</span>
                  <button className="cancel" onClick={del}>Confirm</button>
                  <button className="link-btn" onClick={() => setConfirmingDelete(false)}>Cancel</button>
                </>
              ) : (
                <button className="cancel" onClick={() => setConfirmingDelete(true)}>Delete</button>
              ))}
              {issue.local && <button className="dispatch" disabled={acting} onClick={postToGitHub}>{acting ? '…' : '🐙 Post to GitHub'}</button>}
              {inflight ? (
                <button className="approve-btn" onClick={() => onOpenTask(task.id)}>👁 View run →</button>
              ) : (
                <>
                  <select className="model-select" value={model} onChange={(e) => setModel(e.target.value)} title="Model">
                    <option value="opus">Opus</option><option value="sonnet">Sonnet</option><option value="haiku">Haiku</option>
                  </select>
                  <button className="approve-btn" onClick={() => onDispatch(repo, issue, model)}>📋 Plan</button>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {!editing && full?.labels?.length ? (
        <div className="issue-labels">{full.labels.map((l) => (
          <span key={l.name} className="label" style={{ '--c': `#${l.color || '888'}` }}>{l.name}</span>
        ))}</div>
      ) : null}

      <div className="issue-body">
        {error && <div className="error pad">⚠ {error}</div>}
        {full === null && !error && <div className="muted pad">Loading…</div>}
        {editing
          ? <textarea className="ni-body issue-edit-body" value={eBody} placeholder="Description (markdown)…" onChange={(e) => setEBody(e.target.value)} />
          : full && <pre className="issue-md">{full.body || '(no description)'}</pre>}
      </div>
    </>
  )
}
