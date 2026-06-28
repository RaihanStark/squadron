// Squadron backend. In dev this runs standalone and Vite proxies /api to it.
// Later, this same module becomes the Electron main process.
import express from 'express'
import * as github from './github.js'
import * as runner from './runner.js'
import * as questions from './questions.js'
import * as git from './git.js'
import * as localIssues from './localIssues.js'
import * as preview from './preview.js'
import * as runConfig from './runConfig.js'
import { bus, listTasks, getTask, createTask, findActiveByIssue } from './tasks.js'

const app = express()
const PORT = process.env.PORT || 5174

app.use(express.json())

// Small helper so every route gets consistent error handling.
const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req))
  } catch (err) {
    console.error(`[${req.method} ${req.path}]`, err.message)
    res.status(500).json({ error: err.message })
  }
}

app.get('/api/health', handle(async () => ({ ok: true, ts: Date.now() })))

app.get('/api/me', handle(async () => ({ login: await github.currentUser() })))

app.get('/api/repos', handle((req) =>
  github.listRepos({ limit: Number(req.query.limit) || 100 })))

// Backlog = local drafts (first) + GitHub issues.
app.get('/api/repos/:owner/:repo/issues', handle(async (req) => {
  const { owner, repo } = req.params
  const [remote, local] = await Promise.all([
    github.listIssues(owner, repo),
    localIssues.list(`${owner}/${repo}`),
  ])
  return [...local, ...remote]
}))

// Save a backlog item locally (not posted to GitHub).
app.post('/api/repos/:owner/:repo/issues/local', handle(async (req) => {
  const { title, body } = req.body || {}
  if (!title?.trim()) throw new Error('title is required')
  return localIssues.create(`${req.params.owner}/${req.params.repo}`, { title: title.trim(), body })
}))

// Create a backlog item directly on GitHub.
app.post('/api/repos/:owner/:repo/issues', handle(async (req) => {
  const { title, body } = req.body || {}
  if (!title?.trim()) throw new Error('title is required')
  const url = await github.createIssue(req.params.owner, req.params.repo, { title: title.trim(), body })
  return { url }
}))

// Promote a local draft to a real GitHub issue.
app.post('/api/repos/:owner/:repo/issues/local/:id/post', handle(async (req) => {
  const item = await localIssues.get(req.params.id)
  if (!item) throw new Error('local issue not found')
  const url = await github.createIssue(req.params.owner, req.params.repo, { title: item.title, body: item.body })
  await localIssues.remove(req.params.id)
  return { url }
}))

app.patch('/api/repos/:owner/:repo/issues/local/:id', handle(async (req) => {
  const { title, body } = req.body || {}
  const updated = await localIssues.update(req.params.id, { title, body })
  if (!updated) throw new Error('local issue not found')
  return updated
}))

app.delete('/api/repos/:owner/:repo/issues/local/:id', handle(async (req) => {
  await localIssues.remove(req.params.id)
  return { ok: true }
}))

// Edit a GitHub issue's title/body.
app.patch('/api/repos/:owner/:repo/issues/:number', handle(async (req) => {
  const { owner, repo, number } = req.params
  const { title, body } = req.body || {}
  await github.editIssue(owner, repo, number, { title, body })
  return github.getIssue(owner, repo, number)
}))

// Detail (incl. body) for a GitHub issue.
app.get('/api/repos/:owner/:repo/issues/:number', handle((req) =>
  github.getIssue(req.params.owner, req.params.repo, req.params.number)))

app.get('/api/repos/:owner/:repo/pulls', handle((req) =>
  github.listPulls(req.params.owner, req.params.repo)))

app.get('/api/repos/:owner/:repo/pulls/:number/diff', handle(async (req) =>
  ({ diff: await github.getPrDiff(req.params.owner, req.params.repo, req.params.number) })))

// --- Agents / tasks (slice 2) ---

// Start an interactive planning session for an issue. Returns the created task
// immediately; the plan chat streams over /api/stream.
app.post('/api/repos/:owner/:repo/plan', handle(async (req) => {
  const { owner, repo } = req.params
  const { issueNumber, issueTitle, model, defaultBranch, local, body } = req.body
  if (!issueNumber) throw new Error('issueNumber is required')
  // Dedupe: if a plan/run is already in flight for this issue, return it
  // instead of spawning a second agent.
  const existing = await findActiveByIssue(owner, repo, issueNumber)
  if (existing) return { ...existing, deduped: true }
  const task = await createTask({ owner, repo, issueNumber, issueTitle, model, local: !!local, body })
  runner.startPlan(task, { defaultBranch }).catch((e) => console.error('startPlan crashed', e))
  return task
}))

// Start a read-only review of a PR. Streams over /api/stream; the review then
// waits for approval before posting.
app.post('/api/repos/:owner/:repo/review', handle(async (req) => {
  const { owner, repo } = req.params
  const { prNumber, prTitle, model } = req.body
  if (!prNumber) throw new Error('prNumber is required')
  const existing = await findActiveByIssue(owner, repo, prNumber, 'review')
  if (existing) return { ...existing, deduped: true }
  const task = await createTask({ owner, repo, issueNumber: prNumber, issueTitle: prTitle, model, kind: 'review' })
  runner.startReview(task).catch((e) => console.error('startReview crashed', e))
  return task
}))

// Send a message into a live planning chat.
app.post('/api/tasks/:id/message', handle(async (req) => {
  const text = (req.body?.text || '').trim()
  if (!text) throw new Error('message text is required')
  return { sent: runner.sendMessage(req.params.id, text) }
}))

// Approve the current plan and kick off autonomous execution (local changes).
app.post('/api/tasks/:id/approve', handle(async (req) => ({ approved: await runner.approve(req.params.id) })))

// The diff of a task's local changes (the agent's work), for review before push.
app.get('/api/tasks/:id/diff', handle(async (req) => {
  const t = await getTask(req.params.id)
  if (!t) throw new Error('task not found')
  return { diff: await git.taskDiff(req.params.id, t.base) }
}))

// Push the reviewed local changes and open the PR.
app.post('/api/tasks/:id/push', handle(async (req) => ({ pushed: await runner.pushTask(req.params.id) })))

// Ask the agent for more changes on the staged work (re-runs in the worktree).
app.post('/api/tasks/:id/revise', handle(async (req) =>
  ({ revising: await runner.revise(req.params.id, (req.body?.instruction || '')) })))

// Stop an in-flight revision without discarding the staged work.
app.post('/api/tasks/:id/stop', handle((req) => ({ stopped: runner.stopRun(req.params.id) })))

// Live preview — run the task's worktree to verify the change.
app.get('/api/tasks/:id/preview', handle((req) => preview.getState(req.params.id)))
app.post('/api/tasks/:id/preview', handle((req) => preview.start(req.params.id)))
app.delete('/api/tasks/:id/preview', handle((req) => preview.stop(req.params.id)))

// Per-repo run command (override the auto-detected one).
app.get('/api/repos/:owner/:repo/run-command', handle(async (req) =>
  ({ command: await runConfig.getCmd(`${req.params.owner}/${req.params.repo}`) })))
app.put('/api/repos/:owner/:repo/run-command', handle(async (req) =>
  ({ command: await runConfig.setCmd(`${req.params.owner}/${req.params.repo}`, (req.body?.command || '').trim()) })))

app.get('/api/tasks', handle(() => listTasks()))

app.get('/api/tasks/:id', handle(async (req) => {
  const t = await getTask(req.params.id)
  if (!t) throw new Error('task not found')
  return t
}))

app.post('/api/tasks/:id/cancel', handle(async (req) => ({ cancelled: runner.cancel(req.params.id) })))

// Answer a clarifying question a waiting agent asked via ask_user.
app.post('/api/tasks/:id/answer', handle(async (req) => {
  const text = (req.body?.text || '').trim()
  if (!text) throw new Error('answer text is required')
  return { delivered: questions.answer(req.params.id, text) }
}))

// Global live stream of all task updates + agent events (SSE).
app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  res.flushHeaders?.()
  const onTask = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
  bus.on('task', onTask)
  const ping = setInterval(() => res.write(': ping\n\n'), 25000)
  req.on('close', () => { clearInterval(ping); bus.off('task', onTask) })
})

app.listen(PORT, () => {
  console.log(`\n  🛩  Squadron server ready → http://localhost:${PORT}\n`)
})
