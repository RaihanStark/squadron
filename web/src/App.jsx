import { useEffect, useRef, useState } from 'react'
import { demoApi } from './demo.js'

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

const ACTIVE = new Set(['queued', 'preparing', 'planning', 'planned', 'running', 'waiting', 'committing', 'pushing', 'opening_pr'])
const NEEDS_YOU = new Set(['planned', 'waiting'])
const STATUS_LABEL = {
  queued: 'queued', preparing: 'preparing', planning: 'planning', planned: 'plan ready',
  running: 'running', waiting: 'needs you', committing: 'committing', pushing: 'pushing',
  opening_pr: 'opening PR', pr_open: 'PR open', no_changes: 'no changes',
  cancelled: 'cancelled', error: 'error',
}

export default function App() {
  const [repos, setRepos] = useState([])
  const [reposError, setReposError] = useState(null)
  const [active, setActive] = useState(null)
  const [tab, setTab] = useState('backlog')
  const [view, setView] = useState(PARAMS.get('view') === 'agents' ? 'agents' : 'repo') // 'repo' | 'agents'

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

    api('/api/tasks').then((list) => {
      setTasks(Object.fromEntries(list.map((t) => [t.id, t])))
    }).catch(() => {})

    if (DEMO) return // no live stream in demo mode

    const es = new EventSource('/api/stream')
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
      setTasks((prev) => ({ ...prev, [task.id]: { ...task, events: [] } }))
      setSelectedTask(task.id)
      setView('agents')
    } catch (e) {
      alert('Dispatch failed: ' + e.message)
    }
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
            <AgentsPanel tasks={taskList} selected={selectedTask} setSelected={setSelectedTask} />
          ) : activeRepo ? (
            <RepoView key={active} repo={activeRepo} tab={tab} setTab={setTab} onDispatch={dispatch} tasks={taskList} />
          ) : (
            <div className="empty">Select a repo to begin.</div>
          )}
        </main>
      </div>
    </div>
  )
}

function RepoView({ repo, tab, setTab, onDispatch, tasks }) {
  const [owner, name] = repo.nameWithOwner.split('/')
  const [issues, setIssues] = useState(null)
  const [pulls, setPulls] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    setIssues(null); setPulls(null); setError(null)
    api(`/api/repos/${owner}/${name}/issues`).then(setIssues).catch((e) => setError(e.message))
    api(`/api/repos/${owner}/${name}/pulls`).then(setPulls).catch((e) => setError(e.message))
  }, [repo.nameWithOwner])

  // Map issueNumber -> latest task, so a dispatched issue shows live status.
  const taskByIssue = {}
  for (const t of tasks) {
    if (`${t.owner}/${t.repo}` === repo.nameWithOwner) taskByIssue[t.issueNumber] = t
  }

  return (
    <>
      <div className="main-head">
        <h1>{repo.nameWithOwner}</h1>
        <div className="tabs">
          <button className={tab === 'backlog' ? 'on' : ''} onClick={() => setTab('backlog')}>
            Backlog {issues ? `· ${issues.length}` : ''}
          </button>
          <button className={tab === 'prs' ? 'on' : ''} onClick={() => setTab('prs')}>
            Pull Requests {pulls ? `· ${pulls.length}` : ''}
          </button>
        </div>
      </div>

      {error && <div className="error pad">⚠ {error}</div>}

      <div className="list">
        {tab === 'backlog' && (
          <IssueList issues={issues} taskByIssue={taskByIssue} onDispatch={(it, model) => onDispatch(repo, it, model)} />
        )}
        {tab === 'prs' && <PullList pulls={pulls} />}
      </div>
    </>
  )
}

function IssueList({ issues, taskByIssue, onDispatch }) {
  if (issues === null) return <div className="muted pad">Loading missions…</div>
  if (!issues.length) return <div className="muted pad">No open issues. Clear skies. ✦</div>
  return issues.map((it) => (
    <IssueRow key={it.number} issue={it} task={taskByIssue[it.number]} onDispatch={onDispatch} />
  ))
}

function IssueRow({ issue: it, task, onDispatch }) {
  const [model, setModel] = useState('opus')
  const busy = task && ACTIVE.has(task.status)
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
        {task && <StatusBadge status={task.status} />}
        <select
          className="model-select"
          value={model}
          disabled={busy}
          onChange={(e) => setModel(e.target.value)}
          title="Model for this dispatch"
        >
          <option value="opus">Opus</option>
          <option value="sonnet">Sonnet</option>
          <option value="haiku">Haiku</option>
        </select>
        <button className="dispatch" disabled={busy} onClick={() => onDispatch(it, model)}>
          {busy ? '… working' : '📋 Plan'}
        </button>
      </div>
    </div>
  )
}

function PullList({ pulls }) {
  if (pulls === null) return <div className="muted pad">Loading sorties…</div>
  if (!pulls.length) return <div className="muted pad">No open PRs.</div>
  return pulls.map((pr) => (
    <a key={pr.number} className="card" href={pr.url} target="_blank" rel="noreferrer">
      <div className="card-main">
        <span className="num">#{pr.number}</span>
        <span className="title">{pr.title}</span>
        {pr.isDraft && <span className="badge">draft</span>}
      </div>
      <div className="card-meta">
        <span className="diff add">+{pr.additions}</span>
        <span className="diff del">−{pr.deletions}</span>
        {pr.reviewDecision && <span className="badge">{pr.reviewDecision.toLowerCase().replace('_', ' ')}</span>}
        <span className="muted">{timeAgo(pr.updatedAt)}</span>
        <button className="dispatch" disabled title="Coming in slice 3">🔍 Review</button>
      </div>
    </a>
  ))
}

function StatusBadge({ status }) {
  return <span className={`status status-${status}`}>{STATUS_LABEL[status] || status}</span>
}

function AgentsPanel({ tasks, selected, setSelected }) {
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
        {sel ? <AgentDetail task={sel} /> : <div className="empty">No agent selected.</div>}
      </div>
    </div>
  )
}

function AgentDetail({ task }) {
  const logRef = useRef(null)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [approving, setApproving] = useState(false)
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [task.events?.length, task.status])

  async function post(path, body) {
    return api(`/api/tasks/${task.id}/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
  }

  const waiting = task.status === 'waiting'     // execution paused on a question
  const planning = task.status === 'planning'   // planner is thinking
  const planned = task.status === 'planned'     // plan ready, awaiting you
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
          {busy && <button className="cancel" onClick={() => post('cancel')}>Cancel</button>}
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
        {!task.events?.length && <div className="muted">Waiting for the planner to report in…</div>}
      </div>

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
