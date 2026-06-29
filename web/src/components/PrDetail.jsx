import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { parseDiff, filePath } from '../diff.js'
import { ciState, ciChecks, CI_LABEL, CI_CHECK_SYMBOL } from '../ci.js'
import DiffFile from './DiffFile.jsx'
import PrFixPanel from './PrFixPanel.jsx'
import PreviewDock from './PreviewDock.jsx'

export default function PrDetail({ repo, pr, task, fixTask, resolveTask, tasks = [], onReview, onFixCi, onResolve, onStartFix, onOpenChanges, onBack }) {
  const [owner, name] = repo.nameWithOwner.split('/')
  const [files, setFiles] = useState(null)
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState(null)
  const [model, setModel] = useState('opus')
  const [posting, setPosting] = useState(false)
  const [merging, setMerging] = useState(false)
  const [mergeMethod, setMergeMethod] = useState('squash')
  const [fixOpen, setFixOpen] = useState(false)
  const [dispatching, setDispatching] = useState(false) // guard double-click on review/resolve/fix-CI
  const fire = (fn) => { setDispatching(true); Promise.resolve(fn()).finally(() => setDispatching(false)) }

  useEffect(() => {
    setFiles(null); setError(null); setDetail(null)
    api(`/api/repos/${owner}/${name}/pulls/${pr.number}/diff`)
      .then((r) => setFiles(parseDiff(r.diff || '')))
      .catch((e) => setError(e.message))
    // Fresh detail for CI rollup + mergeable state (gates the merge button).
    api(`/api/repos/${owner}/${name}/pulls/${pr.number}`)
      .then(setDetail)
      .catch(() => {})
  }, [repo.nameWithOwner, pr.number])

  async function postReview() {
    if (!task) return
    setPosting(true)
    try { await api(`/api/tasks/${task.id}/approve`, { method: 'POST' }) }
    catch (e) { alert('Post failed: ' + e.message) }
    finally { setPosting(false) }
  }

  async function merge() {
    if (merging) return
    setMerging(true)
    try {
      await api(`/api/repos/${owner}/${name}/pulls/${pr.number}/merge`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: mergeMethod }),
      })
      onBack() // returning to the repo view remounts it and re-fetches the PR list
    } catch (e) { alert('Merge failed: ' + e.message) }
    finally { setMerging(false) }
  }

  const rollup = detail?.statusCheckRollup ?? pr.statusCheckRollup
  const ci = ciState(rollup)
  const checks = ciChecks(rollup)
  const isDraft = detail?.isDraft ?? pr.isDraft
  const mergeable = detail?.mergeable
  // No checks at all is allowed to merge; only an actual failure/pending blocks.
  const ciOk = ci === 'success' || ci === 'none'
  const canMerge = ciOk && mergeable === 'MERGEABLE' && !isDraft
  const mergeReason =
    !detail ? 'Checking merge status…'
    : isDraft ? 'PR is a draft'
    : ci === 'failure' ? 'CI is failing'
    : ci === 'pending' ? 'CI is still running'
    : mergeable === 'CONFLICTING' ? 'PR has merge conflicts'
    : mergeable !== 'MERGEABLE' ? 'PR is not mergeable'
    : `Merge this PR (${mergeMethod})`

  const conflicting = mergeable === 'CONFLICTING'
  const isFork = detail?.isCrossRepository
  const resolving = resolveTask && ['preparing', 'running', 'committing', 'pushing'].includes(resolveTask.status)
  const resolveReady = resolveTask && resolveTask.status === 'changes_ready'

  // A live/staged interactive PR-update task for this PR, if any — lets the Fix
  // button hint that work is in flight and auto-opens the panel.
  const prFix = tasks.find((t) => t.kind === 'pr_fix' && `${t.owner}/${t.repo}` === repo.nameWithOwner
    && t.issueNumber === pr.number && !['pr_open', 'cancelled', 'no_changes', 'error'].includes(t.status))
  useEffect(() => { if (prFix) setFixOpen(true) }, [!!prFix])

  const reviewing = task && ['preparing', 'reviewing', 'posting'].includes(task.status)
  const reviewed = task && (task.status === 'reviewed' || task.status === 'review_posted')
  const fixActive = fixTask && ['preparing', 'running', 'committing', 'waiting'].includes(fixTask.status)
  const fixReady = fixTask && fixTask.status === 'changes_ready'
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
            {' '}<span className={`ci-badge ${CI_LABEL[ci].cls}`}>{CI_LABEL[ci].text}</span>
          </h1>
        </div>
        <div className="agent-actions">
          <button className={`fix-toggle ${fixOpen ? 'on' : ''} ${prFix ? 'busy' : ''}`} onClick={() => setFixOpen((o) => !o)}
            title="Make a quick change to this PR — e.g. to address reviewer feedback">
            🔧 Fix
          </button>
          <select className="model-select" value={mergeMethod} onChange={(e) => setMergeMethod(e.target.value)} disabled={merging} title="Merge method">
            <option value="squash">Squash</option>
            <option value="merge">Merge commit</option>
            <option value="rebase">Rebase</option>
          </select>
          <button className="merge-btn" disabled={!canMerge || merging} onClick={merge} title={mergeReason}>
            {merging ? 'Merging…' : '⛙ Merge'}
          </button>
          {conflicting && !isFork && (
            resolving ? <span className="status status-reviewing">resolving…</span>
            : resolveReady ? <button className="approve-btn" onClick={() => onOpenChanges(resolveTask.id)}>🔀 Review resolution</button>
            : <button className="dispatch" disabled={dispatching} onClick={() => fire(() => onResolve(repo, pr, model))} title="Have AI merge the base branch in and resolve the conflicts">🤖 Resolve conflicts</button>
          )}
          {conflicting && isFork && <span className="status" title="Fork PRs can't be auto-resolved — no push access to the fork's branch">⚠ fork — resolve manually</span>}
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
              <button className="dispatch" disabled={dispatching} onClick={() => fire(() => onReview(repo, pr, model))}>🤖 {reviewed ? 'Re-review' : 'AI Review'}</button>
              {ci === 'failure' && (
                <button className="dispatch" disabled={fixActive || dispatching} onClick={() => fire(() => onFixCi(repo, pr, model))}
                  title="Dispatch an agent to read the failing CI logs and push a fix to this PR">
                  🛠 {fixActive ? 'Fixing CI…' : fixReady ? 'Fix ready ↗' : 'Fix CI'}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="pr-body">
        <div className="pr-main">
          {checks.length > 0 && (
            <div className="ci-checks">
              {checks.map((c, i) => (
                <div key={i} className={`ci-check ${CI_LABEL[c.state].cls}`}>
                  <span className="ci-check-icon">{CI_CHECK_SYMBOL[c.state]}</span>
                  <span className="ci-check-name">
                    {c.link ? <a href={c.link} target="_blank" rel="noreferrer">{c.name}</a> : c.name}
                  </span>
                  {c.description && <span className="ci-check-desc">{c.description}</span>}
                </div>
              ))}
            </div>
          )}

          {reviewed && task.review && <div className="review-summary">🤖 {task.review}</div>}
          {reviewed && !findings.length && <div className="review-summary ok">🤖 No issues found.</div>}

          <div className="diff-view">
            {error && <div className="error pad">⚠ {error}</div>}
            {files === null && !error && <div className="muted pad">Loading diff…</div>}
            {files && !files.length && <div className="muted pad">No changes to show.</div>}
            {files && files.map((f, fi) => <DiffFile key={fi} file={f} findings={findingsByFile[filePath(f)] || []} />)}
          </div>
        </div>

        {fixOpen && (
          <PrFixPanel repo={repo} pr={pr} tasks={tasks} onStartFix={onStartFix}
            onOpenChanges={onOpenChanges} onClose={() => setFixOpen(false)} />
        )}
      </div>

      {/* Run the PR's dev server to exercise it before merging. Fork PRs can't be
          previewed (their branch isn't ours to run), so show a note instead. */}
      {isFork ? (
        <div className="ide-dock">
          <div className="dock-bar">
            <span className="dock-title">▸ Preview &amp; Logs</span>
            <span className="muted">Fork PRs can't be previewed</span>
          </div>
        </div>
      ) : (
        <PreviewDock previewPath={`/api/repos/${owner}/${name}/pulls/${pr.number}`} repoSlug={repo.nameWithOwner} />
      )}
    </>
  )
}
