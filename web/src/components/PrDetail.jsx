import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { parseDiff, filePath } from '../diff.js'
import DiffFile from './DiffFile.jsx'

export default function PrDetail({ repo, pr, task, onReview, onBack }) {
  const [owner, name] = repo.nameWithOwner.split('/')
  const [files, setFiles] = useState(null)
  const [error, setError] = useState(null)
  const [model, setModel] = useState('opus')
  const [posting, setPosting] = useState(false)

  useEffect(() => {
    setFiles(null); setError(null)
    api(`/api/repos/${owner}/${name}/pulls/${pr.number}/diff`)
      .then((r) => setFiles(parseDiff(r.diff || '')))
      .catch((e) => setError(e.message))
  }, [repo.nameWithOwner, pr.number])

  async function postReview() {
    if (!task) return
    setPosting(true)
    try { await api(`/api/tasks/${task.id}/approve`, { method: 'POST' }) }
    catch (e) { alert('Post failed: ' + e.message) }
    finally { setPosting(false) }
  }

  const reviewing = task && ['preparing', 'reviewing', 'posting'].includes(task.status)
  const reviewed = task && (task.status === 'reviewed' || task.status === 'review_posted')
  const findings = task?.findings || []
  const findingsByFile = {}
  for (const f of findings) (findingsByFile[f.file] ||= []).push(f)

  return (
    <>
      <div className="main-head pr-head">
        <div>
          <button className="link-btn" onClick={onBack}>← back</button>
          <h1>
            <a href={pr.url} target="_blank" rel="noreferrer">#{pr.number}</a> {pr.title}
            {' '}<span className="diff add">+{pr.additions}</span> <span className="diff del">−{pr.deletions}</span>
          </h1>
        </div>
        <div className="agent-actions">
          {reviewing && <span className="status status-reviewing">reviewing…</span>}
          {task?.status === 'review_posted' && <a className="badge" href={task.prUrl} target="_blank" rel="noreferrer">✓ posted ↗</a>}
          {task?.status === 'reviewed' && (
            <button className="approve-btn" disabled={posting} onClick={postReview}>
              {posting ? 'Posting…' : '✅ Post to PR'}
            </button>
          )}
          {!reviewing && (
            <>
              <select className="model-select" value={model} onChange={(e) => setModel(e.target.value)} title="Model">
                <option value="opus">Opus</option>
                <option value="sonnet">Sonnet</option>
                <option value="haiku">Haiku</option>
              </select>
              <button className="dispatch" onClick={() => onReview(repo, pr, model)}>🤖 {reviewed ? 'Re-review' : 'AI Review'}</button>
            </>
          )}
        </div>
      </div>

      {reviewed && task.review && <div className="review-summary">🤖 {task.review}</div>}
      {reviewed && !findings.length && <div className="review-summary ok">🤖 No issues found.</div>}

      <div className="diff-view">
        {error && <div className="error pad">⚠ {error}</div>}
        {files === null && !error && <div className="muted pad">Loading diff…</div>}
        {files && !files.length && <div className="muted pad">No changes to show.</div>}
        {files && files.map((f, fi) => <DiffFile key={fi} file={f} findings={findingsByFile[filePath(f)] || []} />)}
      </div>
    </>
  )
}
