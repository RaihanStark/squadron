import { useEffect, useState } from 'react'
import { api, DEMO, PARAMS } from './api.js'
import { ACTIVE, NEEDS_YOU } from './constants.js'
import Sidebar from './components/Sidebar.jsx'
import RepoView from './components/RepoView.jsx'
import AgentsPanel from './components/AgentsPanel.jsx'
import IssueDetail from './components/IssueDetail.jsx'
import ChangesDetail from './components/ChangesDetail.jsx'
import PrDetail from './components/PrDetail.jsx'

export default function App() {
  const [repos, setRepos] = useState([])
  const [reposError, setReposError] = useState(null)
  const [active, setActive] = useState(null)
  const [tab, setTab] = useState('backlog')
  const [view, setView] = useState(PARAMS.get('view') === 'agents' ? 'agents' : 'repo') // 'repo' | 'agents' | 'pr' | 'issue' | 'changes'
  const [selectedPr, setSelectedPr] = useState(null)
  const [selectedChange, setSelectedChange] = useState(null)
  const [selectedIssue, setSelectedIssue] = useState(null)
  const [me, setMe] = useState(null)

  // Tasks keyed by id, kept live via SSE.
  const [tasks, setTasks] = useState({})
  const [selectedTask, setSelectedTask] = useState(DEMO ? 'twait' : null)

  useEffect(() => {
    api('/api/me').then((r) => setMe(r.login)).catch(() => {})

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
        if (payload.type === 'task') return { ...prev, [payload.id]: { ...cur, ...payload.task, events: cur.events || [] } }
        if (payload.type === 'event') return { ...prev, [payload.id]: { ...cur, events: [...(cur.events || []), payload.event] } }
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
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          issueNumber: issue.number ?? issue.id,
          issueTitle: issue.title,
          local: !!issue.local,
          body: issue.body,
          defaultBranch: repoObj.defaultBranchRef?.name,
          model,
        }),
      })
      setTasks((prev) => ({ ...prev, [task.id]: { ...(prev[task.id] || {}), ...task, events: prev[task.id]?.events || [] } }))
      setSelectedTask(task.id)
      setView('agents')
    } catch (e) { alert('Plan failed: ' + e.message) }
  }

  async function review(repoObj, pr, model) {
    const [owner, repo] = repoObj.nameWithOwner.split('/')
    try {
      const task = await api(`/api/repos/${owner}/${repo}/review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prNumber: pr.number, prTitle: pr.title, model }),
      })
      setTasks((prev) => ({ ...prev, [task.id]: { ...(prev[task.id] || {}), ...task, events: prev[task.id]?.events || [] } }))
      setSelectedTask(task.id)
      setView('agents')
    } catch (e) { alert('Review failed: ' + e.message) }
  }

  const openTask = (taskId) => { setSelectedTask(taskId); setView('agents') }
  const openPr = (repoObj, pr) => { setSelectedPr({ repo: repoObj, pr }); setView('pr') }
  const openChanges = (taskId) => { setSelectedChange(taskId); setView('changes') }
  const openIssue = (repoObj, issue) => { setSelectedIssue({ repo: repoObj, issue }); setView('issue') }
  const backToRepo = () => setView('repo')

  const findTask = (pred) => taskList.find(pred)

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
        <Sidebar repos={repos} reposError={reposError} active={active} view={view} taskList={taskList}
          onSelect={(name) => { setActive(name); setView('repo') }} />

        <main className="main">
          {view === 'agents' ? (
            <AgentsPanel tasks={taskList} selected={selectedTask} setSelected={setSelectedTask} onOpenChanges={openChanges} />
          ) : view === 'issue' && selectedIssue ? (
            <IssueDetail repo={selectedIssue.repo} issue={selectedIssue.issue} me={me}
              task={findTask((t) => `${t.owner}/${t.repo}` === selectedIssue.repo.nameWithOwner && (t.kind || 'plan') !== 'review' && t.issueNumber == (selectedIssue.issue.number ?? selectedIssue.issue.id))}
              onDispatch={dispatch} onOpenTask={openTask} onBack={backToRepo} />
          ) : view === 'changes' && selectedChange ? (
            <ChangesDetail task={findTask((t) => t.id === selectedChange)} onBack={backToRepo} />
          ) : view === 'pr' && selectedPr ? (
            <PrDetail repo={selectedPr.repo} pr={selectedPr.pr}
              task={findTask((t) => `${t.owner}/${t.repo}` === selectedPr.repo.nameWithOwner && t.issueNumber === selectedPr.pr.number && (t.kind || 'plan') === 'review')}
              onReview={review} onBack={backToRepo} />
          ) : activeRepo ? (
            <RepoView key={active} repo={activeRepo} tab={tab} setTab={setTab} onDispatch={dispatch} onReview={review}
              onOpenTask={openTask} onOpenPr={openPr} onOpenChanges={openChanges} onOpenIssue={openIssue} tasks={taskList} />
          ) : (
            <div className="empty">Select a repo to begin.</div>
          )}
        </main>
      </div>
    </div>
  )
}
