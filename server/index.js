// Squadron backend. In dev this runs standalone and Vite proxies /api to it.
// Later, this same module becomes the Electron main process.
import express from 'express'
import * as github from './github.js'
import * as runner from './runner.js'
import * as questions from './questions.js'
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

app.get('/api/repos', handle((req) =>
  github.listRepos({ limit: Number(req.query.limit) || 100 })))

app.get('/api/repos/:owner/:repo/issues', handle((req) =>
  github.listIssues(req.params.owner, req.params.repo)))

app.get('/api/repos/:owner/:repo/pulls', handle((req) =>
  github.listPulls(req.params.owner, req.params.repo)))

app.get('/api/repos/:owner/:repo/pulls/:number/diff', handle(async (req) =>
  ({ diff: await github.getPrDiff(req.params.owner, req.params.repo, req.params.number) })))

// --- Agents / tasks (slice 2) ---

// Start an interactive planning session for an issue. Returns the created task
// immediately; the plan chat streams over /api/stream.
app.post('/api/repos/:owner/:repo/plan', handle(async (req) => {
  const { owner, repo } = req.params
  const { issueNumber, issueTitle, model, defaultBranch } = req.body
  if (!issueNumber) throw new Error('issueNumber is required')
  // Dedupe: if a plan/run is already in flight for this issue, return it
  // instead of spawning a second agent.
  const existing = await findActiveByIssue(owner, repo, issueNumber)
  if (existing) return { ...existing, deduped: true }
  const task = await createTask({ owner, repo, issueNumber, issueTitle, model })
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

// Approve the current plan and kick off autonomous execution → PR.
app.post('/api/tasks/:id/approve', handle(async (req) => ({ approved: await runner.approve(req.params.id) })))

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
