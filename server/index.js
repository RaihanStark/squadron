// Squadron backend. In dev this runs standalone and Vite proxies /api to it.
// Later, this same module becomes the Electron main process.
import express from 'express'
import * as github from './github.js'
import * as runner from './runner.js'
import * as questions from './questions.js'
import { bus, listTasks, getTask, createTask } from './tasks.js'

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

// --- Agents / tasks (slice 2) ---

// Dispatch an agent at an issue. Returns the created task immediately; the
// run proceeds in the background and streams over /api/stream.
app.post('/api/repos/:owner/:repo/dispatch', handle(async (req) => {
  const { owner, repo } = req.params
  const { issueNumber, issueTitle, model, defaultBranch } = req.body
  if (!issueNumber) throw new Error('issueNumber is required')
  const task = await createTask({ owner, repo, issueNumber, issueTitle, model })
  runner.dispatch(task, { defaultBranch }).catch((e) => console.error('dispatch crashed', e))
  return task
}))

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
