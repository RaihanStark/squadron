import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { usePref } from '../prefs.js'
import NewIssueForm from './NewIssueForm.jsx'
import IssueRow from './IssueRow.jsx'
import ChangeCard from './ChangeCard.jsx'
import PrCard from './PrCard.jsx'
import RepoErrand from './RepoErrand.jsx'
import ReleasePanel from './ReleasePanel.jsx'

export default function RepoView({ repo, tab, setTab, onDispatch, onReview, onOpenTask, onOpenPr, onOpenChanges, onOpenIssue, onStartErrand, tasks }) {
  const [owner, name] = repo.nameWithOwner.split('/')
  const [issues, setIssues] = useState(null)
  const [pulls, setPulls] = useState(null)
  const [error, setError] = useState(null)
  const [creating, setCreating] = useState(false)
  const [errandOpen, setErrandOpen] = usePref('errandOpen', false)

  const loadIssues = () => api(`/api/repos/${owner}/${name}/issues`).then(setIssues).catch((e) => setError(e.message))

  useEffect(() => {
    setIssues(null); setPulls(null); setError(null); setCreating(false)
    loadIssues()
    api(`/api/repos/${owner}/${name}/pulls`).then(setPulls).catch((e) => setError(e.message))
  }, [repo.nameWithOwner])

  // Latest issue task (plan/execute) per issue, so the backlog shows live status.
  // Review/resolve tasks are keyed by PR number, not issue number — exclude them
  // so they never bind to a same-numbered backlog issue.
  const taskByIssue = {}
  for (const t of tasks) {
    const kind = t.kind || 'plan'
    if (`${t.owner}/${t.repo}` === repo.nameWithOwner && kind !== 'review' && kind !== 'resolve') taskByIssue[t.issueNumber] = t
  }

  // "Ready to Review" = local agent changes staged in a worktree — kept here
  // through revisions (running/waiting) until pushed or discarded.
  const changeTasks = tasks.filter((t) =>
    `${t.owner}/${t.repo}` === repo.nameWithOwner && (t.kind || 'plan') !== 'review'
    && t.staged && !['pr_open', 'cancelled'].includes(t.status))

  return (
    <>
      <div className="main-head">
        <h1>{repo.nameWithOwner}</h1>
        <div className="tabs">
          <button className={tab === 'backlog' ? 'on' : ''} onClick={() => setTab('backlog')}>
            Backlog {issues ? `· ${issues.length}` : ''}
          </button>
          <button className={`${tab === 'review' ? 'on' : ''} ${changeTasks.length ? 'has-ready' : ''}`} onClick={() => setTab('review')}>
            Ready to Review · {changeTasks.length}
          </button>
          <button className={tab === 'prs' ? 'on' : ''} onClick={() => setTab('prs')}>
            Pull Requests {pulls ? `· ${pulls.length}` : ''}
          </button>
          <button className={tab === 'release' ? 'on' : ''} onClick={() => setTab('release')}>
            Releases
          </button>
          <button className={`errand-toggle ${errandOpen ? 'on' : ''}`} onClick={() => setErrandOpen((o) => !o)}>
            🤖 Quick task
          </button>
        </div>
      </div>

      {error && <div className="error pad">⚠ {error}</div>}

      <div className="repo-body">
      <div className="list">
        {tab === 'backlog' && (
          <>
            {creating
              ? <NewIssueForm repo={repo} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); loadIssues() }} />
              : <button className="new-issue-btn" onClick={() => setCreating(true)}>+ New backlog item</button>}
            {issues === null ? <div className="muted pad">Loading missions…</div>
              : !issues.length ? <div className="muted pad">No open issues yet.</div>
              : issues.map((it) => {
                const key = it.number ?? it.id
                return <IssueRow key={key} issue={it} task={taskByIssue[key]} onOpenTask={onOpenTask}
                  onOpenIssue={() => onOpenIssue(repo, it)} onDispatch={(i, model) => onDispatch(repo, i, model)} />
              })}
          </>
        )}

        {tab === 'review' && (
          changeTasks.length
            ? changeTasks.map((t) => <ChangeCard key={t.id} task={t} onOpen={() => onOpenChanges(t.id)} />)
            : <div className="muted pad">Empty — no local changes staged. Plan an issue in <strong>Backlog</strong> and approve it; the agent's changes land here (committed locally, not pushed) for you to review before opening a PR.</div>
        )}

        {tab === 'prs' && (
          pulls === null ? <div className="muted pad">Loading sorties…</div>
            : pulls.length
              ? pulls.map((pr) => <PrCard key={pr.number} pr={pr} task={undefined} onOpenPr={() => onOpenPr(repo, pr)} cta="Review →" />)
              : <div className="muted pad">No open PRs.</div>
        )}

        {tab === 'release' && <ReleasePanel repo={repo} />}
      </div>
      {errandOpen && <RepoErrand repo={repo} tasks={tasks} onStart={onStartErrand} onOpenChanges={onOpenChanges} />}
      </div>
    </>
  )
}
