import { useEffect, useRef, useState, Fragment } from 'react'
import { demoApi } from './demo.js'
import { parseDiff, filePath } from './diff.js'

const PARAMS = new URLSearchParams(typeof location !== 'undefined' ? location.search : '')
const DEMO = PARAMS.has('demo')

const api = (path, opts) => {
  if (DEMO) return demoApi(path, opts)
  return fetch(path, opts).then((r) => {
    if (!r.ok) return r.json().then((e) => { throw new Error(e.error || r.statusText) })
    return r.json()
  })
}

function timeAgo(iso) {
  if (!iso) return ''
  const s = (Date.now() - new Date(iso)) / 1000
  for (const [label, secs] of [['y', 31536000], ['mo', 2592000], ['d', 86400], ['h', 3600], ['m', 60]]) {
    const v = Math.floor(s / secs)
    if (v >= 1) return `${v}${label} ago`
  }
  return 'just now'
}

const ACTIVE = new Set(['queued', 'preparing', 'planning', 'planned', 'running', 'waiting', 'committing', 'changes_ready', 'pushing', 'opening_pr', 'reviewing', 'reviewed', 'posting'])
const NEEDS_YOU = new Set(['planned', 'waiting', 'reviewed', 'changes_ready'])
// Statuses where the agent is actively chewing (so the UI shows a live "working"
// indicator) — excludes the awaiting-you states (planned/reviewed/waiting).
const WORKING_LABEL = {
  queued: 'queued…', preparing: 'preparing…', planning: 'planner thinking…',
  running: 'agent working…', reviewing: 'reviewing the diff…', committing: 'committing…',
  pushing: 'pushing…', opening_pr: 'opening PR…', posting: 'posting…',
}
const STATUS_LABEL = {
  queued: 'queued', preparing: 'preparing', planning: 'planning', planned: 'plan ready',
  running: 'running', waiting: 'needs you', committing: 'committing',
  changes_ready: 'changes ready', pushing: 'pushing',
  opening_pr: 'opening PR', pr_open: 'PR open', no_changes: 'no changes',
  reviewing: 'reviewing', reviewed: 'review ready', posting: 'posting', review_posted: 'review posted',
  cancelled: 'cancelled', error: 'error', interrupted: 'interrupted',
}

export default function App() {
  const [repos, setRepos] = useState([])
  const [reposError, setReposError] = useState(null)
  const [active, setActive] = useState(null)
  const [tab, setTab] = useState('backlog')
  const [view, setView] = useState(PARAMS.get('view') === 'agents' ? 'agents' : 'repo') // 'repo' | 'agents' | 'pr'
  const [selectedPr, setSelectedPr] = useState(null) // { repo, pr }
  const [selectedChange, setSelectedChange] = useState(null) // taskId of a changes_ready task

  // Tasks keyed by id, kept live via SSE.
  const [tasks, setTasks] = useState({})
  const [selectedTask, setSelectedTask] = useState(DEMO ? 'twait' : null)

  useEffect(() => {
    api('/api/repos')
      .then((data) => {
        const sorted = [...data].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
        setRepos(sorted)
        if (sorted[0]) setActive(sorted[0].nameWithOwner)
      })
      .catch((e) => setReposError(e.message))

    // Full re-sync from the server (events are persisted). Keep whichever event
    // list is longer so a re-sync never regresses live deltas we already hold.
    const fetchTasks = () => api('/api/tasks').then((list) => {
      setTasks((prev) => {
        const next = { ...prev }
        for (const t of list) {
          const prevEvents = prev[t.id]?.events || []
          const srvEvents = t.events || []
          next[t.id] = { ...t, events: srvEvents.length >= prevEvents.length ? srvEvents : prevEvents }
        }
        return next
      })
    }).catch(() => {})

    fetchTasks()

    if (DEMO) return // no live stream in demo mode

    const es = new EventSource('/api/stream')
    // Re-sync on every (re)connect so events emitted during a drop (e.g. a
    // server restart) aren't lost — SSE itself has no replay.
    es.onopen = () => fetchTasks()
    es.onmessage = (ev) => {
      const payload = JSON.parse(ev.data)
      setTasks((prev) => {
        const cur = prev[payload.id] || { id: payload.id, events: [] }
        if (payload.type === 'task') {
          return { ...prev, [payload.id]: { ...cur, ...payload.task, events: cur.events || [] } }
        }
        if (payload.type === 'event') {
          return { ...prev, [payload.id]: { ...cur, events: [...(cur.events || []), payload.event] } }
        }
        return prev
      })
    }
    return () => es.close()
  }, [])

  const taskList = Object.values(tasks).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  const activeCount = taskList.filter((t) => ACTIVE.has(t.status)).length
  const waitingCount = taskList.filter((t) => NEEDS_YOU.has(t.status)).length
  const activeRepo = repos.find((r) => r.nameWithOwner === active)

  async function dispatch(repoObj, issue, model) {
    const [owner, repo] = repoObj.nameWithOwner.split('/')
    try {
      const task = await api(`/api/repos/${owner}/${repo}/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          issueNumber: issue.number,
          issueTitle: issue.title,
          defaultBranch: repoObj.defaultBranchRef?.name,
          model,
        }),
      })
      setTasks((prev) => ({ ...prev, [task.id]: { ...(prev[task.id] || {}), ...task, events: prev[task.id]?.events || [] } }))
      setSelectedTask(task.id)
      setView('agents')
    } catch (e) {
      alert('Plan failed: ' + e.message)
    }
  }

  async function review(repoObj, pr, model) {
    const [owner, repo] = repoObj.nameWithOwner.split('/')
    try {
      const task = await api(`/api/repos/${owner}/${repo}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prNumber: pr.number, prTitle: pr.title, model }),
      })
      setTasks((prev) => ({ ...prev, [task.id]: { ...(prev[task.id] || {}), ...task, events: prev[task.id]?.events || [] } }))
      setSelectedTask(task.id)
      setView('agents')
    } catch (e) {
      alert('Review failed: ' + e.message)
    }
  }

  function openTask(taskId) {
    setSelectedTask(taskId)
    setView('agents')
  }

  function openPr(repoObj, pr) {
    setSelectedPr({ repo: repoObj, pr })
    setView('pr')
  }

  function openChanges(taskId) {
    setSelectedChange(taskId)
    setView('changes')
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo">🛩 Squadron</span>
        <span className="tagline">command your fleet</span>
        <button
          className={`agents-toggle ${view === 'agents' ? 'on' : ''} ${waitingCount ? 'needs-you' : ''}`}
          onClick={() => setView(view === 'agents' ? 'repo' : 'agents')}
        >
          ⚡ Agents{activeCount ? ` · ${activeCount} active` : ''}{waitingCount ? ` · ${waitingCount} needs you` : ''}

        </button>
      </header>

      <div className="body">
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
                onClick={() => { setActive(r.nameWithOwner); setView('repo') }}
              >
                <span className="repo-name">{r.name} {running ? <span className="dot" title={`${running} agent(s) running`} /> : null}</span>
                <span className="repo-meta">{r.isPrivate ? '🔒' : ''} {timeAgo(r.updatedAt)}</span>
              </button>
            )
          })}
        </aside>

        <main className="main">
          {view === 'agents' ? (
            <AgentsPanel tasks={taskList} selected={selectedTask} setSelected={setSelectedTask} onOpenChanges={openChanges} />
          ) : view === 'changes' && selectedChange ? (
            <ChangesDetail task={taskList.find((t) => t.id === selectedChange)} onBack={() => setView('repo')} />
          ) : view === 'pr' && selectedPr ? (
            <PrDetail
              repo={selectedPr.repo}
              pr={selectedPr.pr}
              task={taskList.find((t) => `${t.owner}/${t.repo}` === selectedPr.repo.nameWithOwner && t.issueNumber === selectedPr.pr.number && (t.kind || 'plan') === 'review')}
              onReview={review}
              onBack={() => setView('repo')}
            />
          ) : activeRepo ? (
            <RepoView key={active} repo={activeRepo} tab={tab} setTab={setTab} onDispatch={dispatch} onReview={review} onOpenTask={openTask} onOpenPr={openPr} onOpenChanges={openChanges} tasks={taskList} />
          ) : (
            <div className="empty">Select a repo to begin.</div>
          )}
        </main>
      </div>
    </div>
  )
}

function RepoView({ repo, tab, setTab, onDispatch, onReview, onOpenTask, onOpenPr, onOpenChanges, tasks }) {
  const [owner, name] = repo.nameWithOwner.split('/')
  const [issues, setIssues] = useState(null)
  const [pulls, setPulls] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    setIssues(null); setPulls(null); setError(null)
    api(`/api/repos/${owner}/${name}/issues`).then(setIssues).catch((e) => setError(e.message))
    api(`/api/repos/${owner}/${name}/pulls`).then(setPulls).catch((e) => setError(e.message))
  }, [repo.nameWithOwner])

  // Latest issue task (plan/execute) per issue, so the backlog shows live status.
  const taskByIssue = {}
  for (const t of tasks) {
    if (`${t.owner}/${t.repo}` === repo.nameWithOwner && (t.kind || 'plan') !== 'review') taskByIssue[t.issueNumber] = t
  }

  // "Ready to Review" = local agent changes, committed in a worktree, not yet pushed.
  const changeTasks = tasks.filter((t) =>
    `${t.owner}/${t.repo}` === repo.nameWithOwner && (t.kind || 'plan') !== 'review' && t.status === 'changes_ready')

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
        </div>
      </div>

      {error && <div className="error pad">⚠ {error}</div>}

      <div className="list">
        {tab === 'backlog' && (
          issues === null ? <div className="muted pad">Loading missions…</div>
            : !issues.length ? <div className="muted pad">No open issues. Clear skies. ✦</div>
            : issues.map((it) => (
              <IssueRow key={it.number} issue={it} task={taskByIssue[it.number]} onOpenTask={onOpenTask}
                onDispatch={(i, model) => onDispatch(repo, i, model)} />
            ))
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
      </div>
    </>
  )
}

function PrCard({ pr, task, onOpenPr, cta }) {
  return (
    <div className="card card-click" onClick={onOpenPr}>
      <div className="card-main">
        <span className="num">#{pr.number}</span>
        <span className="title">{pr.title}</span>
      </div>
      <div className="card-meta">
        <span className="diff add">+{pr.additions}</span>
        <span className="diff del">−{pr.deletions}</span>
        {pr.isDraft && <span className="badge">draft</span>}
        {task?.findings?.length ? <span className="badge model-badge">{task.findings.length} finding(s)</span> : null}
        {task && task.status !== 'reviewed' && <StatusBadge status={task.status} />}
        <span className="chev">{cta}</span>
      </div>
    </div>
  )
}

function IssueRow({ issue: it, task, onDispatch, onOpenTask }) {
  const [model, setModel] = useState('opus')
  // An in-flight task owns this issue — show its live status and a way to jump
  // to it, rather than offering a second Plan (which the backend would dedupe).
  const inflight = task && ACTIVE.has(task.status)
  const verb = task?.status === 'planning' ? 'planning…'
    : task?.status === 'planned' ? 'plan ready'
    : task?.status === 'waiting' ? 'needs you'
    : 'in progress'
  return (
    <div className="card">
      <div className="card-main">
        <a className="num" href={it.url} target="_blank" rel="noreferrer">#{it.number}</a>
        <span className="title">{it.title}</span>
      </div>
      <div className="card-meta">
        {it.labels?.map((l) => (
          <span key={l.name} className="label" style={{ '--c': `#${l.color}` }}>{l.name}</span>
        ))}
        <span className="muted">{it.comments} 💬 · {timeAgo(it.updatedAt)}</span>
        {/* Don't assert PR state from a single stale task — an issue can have many
            PRs, and we don't poll their status. The #number links to GitHub for that. */}
        {task && task.status !== 'pr_open' && <StatusBadge status={task.status} />}
        {inflight ? (
          <button className="dispatch view-btn" onClick={() => onOpenTask(task.id)}>
            👁 View {verb}
          </button>
        ) : (
          <>
            <select
              className="model-select"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              title="Model for this plan"
            >
              <option value="opus">Opus</option>
              <option value="sonnet">Sonnet</option>
              <option value="haiku">Haiku</option>
            </select>
            <button className="dispatch" onClick={() => onDispatch(it, model)}>📋 Plan</button>
          </>
        )}
      </div>
    </div>
  )
}

function ChangeCard({ task, onOpen }) {
  return (
    <div className="card card-click" onClick={onOpen}>
      <div className="card-main">
        <span className="num">#{task.issueNumber}</span>
        <span className="title">{task.issueTitle}</span>
      </div>
      <div className="card-meta">
        {task.branch && <span className="badge">{task.branch}</span>}
        {task.model && <span className="badge model-badge">{task.model}</span>}
        <StatusBadge status={task.status} />
        <span className="chev">Review changes →</span>
      </div>
    </div>
  )
}

function ChangesDetail({ task, onBack }) {
  const [files, setFiles] = useState(null)
  const [error, setError] = useState(null)
  const [pushing, setPushing] = useState(false)

  useEffect(() => {
    if (!task) return
    setFiles(null); setError(null)
    api(`/api/tasks/${task.id}/diff`).then((r) => setFiles(parseDiff(r.diff || ''))).catch((e) => setError(e.message))
  }, [task?.id])

  if (!task) return <div className="empty">These changes are no longer available.</div>

  async function push() {
    setPushing(true)
    try { await api(`/api/tasks/${task.id}/push`, { method: 'POST' }); onBack() }
    catch (e) { alert('Push failed: ' + e.message) }
    finally { setPushing(false) }
  }
  async function discard() {
    if (!confirm('Discard these local changes? This cancels the task and removes its worktree.')) return
    try { await api(`/api/tasks/${task.id}/cancel`, { method: 'POST' }); onBack() } catch (e) { alert(e.message) }
  }

  const ready = task.status === 'changes_ready'
  return (
    <>
      <div className="main-head pr-head">
        <div>
          <button className="link-btn" onClick={onBack}>← back</button>
          <h1>Changes for #{task.issueNumber} <span className="muted">{task.issueTitle}</span></h1>
        </div>
        <div className="agent-actions">
          <StatusBadge status={task.status} />
          {task.branch && <span className="badge">{task.branch}</span>}
          {ready && <button className="cancel" onClick={discard}>Discard</button>}
          {ready && <button className="approve-btn" disabled={pushing} onClick={push}>{pushing ? 'Pushing…' : '⬆ Push & Open PR'}</button>}
          {task.prUrl && <a className="dispatch" href={task.prUrl} target="_blank" rel="noreferrer">Open PR ↗</a>}
        </div>
      </div>

      {task.summary && <div className="review-summary">🤖 {task.summary}</div>}

      <div className="diff-view">
        {error && <div className="error pad">⚠ {error}</div>}
        {files === null && !error && <div className="muted pad">Loading changes…</div>}
        {files && !files.length && <div className="muted pad">No changes in the working tree.</div>}
        {files && files.map((f, fi) => <DiffFile key={fi} file={f} findings={[]} />)}
      </div>
    </>
  )
}

function PrDetail({ repo, pr, task, onReview, onBack }) {
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

function DiffFile({ file, findings }) {
  const placed = new Set()
  return (
    <div className="diff-file">
      <div className="diff-file-head">{filePath(file)}</div>
      {!file.hunks.length && <div className="diff-empty">No textual diff (binary, rename, or mode change).</div>}
      {file.hunks.map((h, hi) => (
        <div className="diff-hunk" key={hi}>
          <div className="diff-line diff-hunkhead"><span className="ln" /><span className="ln" /><span className="diff-code">{h.header} {h.context}</span></div>
          {h.lines.map((ln, li) => {
            const here = findings.filter((fd) => fd.line != null && fd.line === ln.newNum)
            here.forEach((fd) => placed.add(fd))
            return (
              <Fragment key={li}>
                <div className={`diff-line diff-${ln.type}`}>
                  <span className="ln">{ln.oldNum ?? ''}</span>
                  <span className="ln">{ln.newNum ?? ''}</span>
                  <span className="diff-code">{ln.type === 'add' ? '+' : ln.type === 'del' ? '−' : ' '}{ln.text}</span>
                </div>
                {here.map((fd, k) => <FindingCard key={k} f={fd} />)}
              </Fragment>
            )
          })}
        </div>
      ))}
      {findings.filter((fd) => !placed.has(fd)).map((fd, k) => <FindingCard key={`u${k}`} f={fd} unanchored />)}
    </div>
  )
}

function FindingCard({ f, unanchored }) {
  return (
    <div className={`finding sev-${f.severity}`}>
      <div className="finding-head">
        🤖 <span className="finding-sev">{f.severity}</span>
        {unanchored && f.line ? <span className="muted"> · line {f.line} (not in shown diff)</span> : null}
      </div>
      <div className="finding-body">{f.body}</div>
    </div>
  )
}

function StatusBadge({ status }) {
  return <span className={`status status-${status}`}>{STATUS_LABEL[status] || status}</span>
}

function AgentsPanel({ tasks, selected, setSelected, onOpenChanges }) {
  const sel = tasks.find((t) => t.id === selected) || tasks[0]
  return (
    <div className="agents">
      <div className="agents-list">
        <div className="sidebar-head">AGENTS {tasks.length ? `· ${tasks.length}` : ''}</div>
        {!tasks.length && <div className="muted pad">No agents dispatched yet. Hit ⚡ Dispatch on an issue.</div>}
        {tasks.map((t) => (
          <button
            key={t.id}
            className={`agent-row ${sel?.id === t.id ? 'active' : ''}`}
            onClick={() => setSelected(t.id)}
          >
            <div className="agent-row-top">
              <span className="title">{t.repo} <span className="muted">#{t.issueNumber}</span></span>
              <StatusBadge status={t.status} />
            </div>
            <span className="muted">{t.issueTitle}</span>
          </button>
        ))}
      </div>
      <div className="agent-detail">
        {sel ? <AgentDetail task={sel} onOpenChanges={onOpenChanges} /> : <div className="empty">No agent selected.</div>}
      </div>
    </div>
  )
}

function AgentDetail({ task, onOpenChanges }) {
  const logRef = useRef(null)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [approving, setApproving] = useState(false)
  const [, tick] = useState(0) // re-render every second while working, to tick the timer
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [task.events?.length, task.status])

  const workingLabel = WORKING_LABEL[task.status]
  useEffect(() => {
    if (!workingLabel) return
    const i = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(i)
  }, [workingLabel])
  const lastTs = task.events?.length ? task.events[task.events.length - 1].ts : null
  const idleSecs = workingLabel && lastTs ? Math.max(0, Math.floor((Date.now() - lastTs) / 1000)) : 0

  async function post(path, body) {
    return api(`/api/tasks/${task.id}/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
  }

  const waiting = task.status === 'waiting'     // execution paused on a question
  const planning = task.status === 'planning'   // planner is thinking
  const planned = task.status === 'planned'     // plan ready, awaiting you
  const reviewed = task.status === 'reviewed'   // review ready, awaiting you
  const canChat = planning || planned || waiting
  const busy = ACTIVE.has(task.status)

  async function send() {
    const text = reply.trim()
    if (!text) return
    setSending(true)
    try {
      await post(waiting ? 'answer' : 'message', { text }) // answer a question vs. refine the plan
      setReply('')
    } catch (e) { alert('Failed to send: ' + e.message) }
    finally { setSending(false) }
  }

  async function approve() {
    setApproving(true)
    try { await post('approve') } catch (e) { alert('Approve failed: ' + e.message) }
    finally { setApproving(false) }
  }

  const placeholder = waiting
    ? 'Answer the question — the agent is paused…'
    : 'Refine the plan — e.g. “use Argon2id, not the keyring” (⌘/Ctrl+Enter)'

  return (
    <>
      <div className="agent-head">
        <div>
          <h1>{task.owner}/{task.repo} <span className="muted">#{task.issueNumber}</span></h1>
          <div className="muted">{task.issueTitle}</div>
        </div>
        <div className="agent-actions">
          <StatusBadge status={task.status} />
          {task.model && <span className="badge model-badge">{task.model}</span>}
          {task.branch && <span className="badge">{task.branch}</span>}
          {busy && task.status !== 'changes_ready' && <button className="cancel" onClick={() => post('cancel')}>Cancel</button>}
          {task.status === 'changes_ready' && onOpenChanges && (
            <button className="approve-btn" onClick={() => onOpenChanges(task.id)}>Review changes →</button>
          )}
          {task.prUrl && <a className="dispatch" href={task.prUrl} target="_blank" rel="noreferrer">Open PR ↗</a>}
        </div>
      </div>

      {task.error && <div className="error pad">⚠ {task.error}</div>}

      <div className="log" ref={logRef}>
        {(task.events || []).map((e, i) => (
          <div key={i} className={`log-line log-${e.kind}`}>
            {e.kind === 'text' ? <span className="log-text">{e.text}</span>
              : e.kind === 'user' ? <span className="log-user">🧑 {e.text}</span>
              : e.kind === 'tool' ? <span className="log-tool">{e.text}</span>
              : e.kind === 'question' ? <span className="log-question">❓ {e.text}</span>
              : e.kind === 'answer' ? <span className="log-answer">↩︎ {e.text}</span>
              : e.kind === 'result' ? <span className="log-result">{e.ok ? '✅' : '⚠️'} {e.text}{e.costUsd != null ? ` · $${e.costUsd.toFixed(3)}` : ''}</span>
              : e.kind === 'error' ? <span className="log-err">⚠ {e.text}</span>
              : <span className="log-status">▸ {e.text}</span>}
          </div>
        ))}
        {workingLabel && (
          <div className="log-working">
            <span className="dots"><span /><span /><span /></span>
            {workingLabel}{idleSecs >= 3 ? ` · ${idleSecs}s` : ''}
          </div>
        )}
        {!task.events?.length && !workingLabel && <div className="muted">Waiting for the agent to report in…</div>}
      </div>

      {reviewed && (
        <div className="ask">
          <div className="approve-row">
            <span className="muted">Review ready. Approve to post it as a comment on the PR.</span>
            <button className="approve-btn" disabled={approving} onClick={approve}>
              {approving ? 'Posting…' : '✅ Approve & Post'}
            </button>
          </div>
        </div>
      )}

      {canChat && (
        <div className={`ask ${waiting ? 'ask-waiting' : ''}`}>
          {waiting && <div className="ask-q">❓ {task.question}</div>}
          {planned && (
            <div className="approve-row">
              <span className="muted">Plan ready. Refine it below, or send it to execution.</span>
              <button className="approve-btn" disabled={approving} onClick={approve}>
                {approving ? 'Dispatching…' : '✅ Approve & Dispatch'}
              </button>
            </div>
          )}
          <div className="ask-row">
            <textarea
              className="ask-input"
              placeholder={placeholder}
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send() }}
            />
            <button className="dispatch" disabled={sending || !reply.trim()} onClick={send}>
              {sending ? 'Sending…' : 'Send ↵'}
            </button>
          </div>
        </div>
      )}
    </>
  )
}
