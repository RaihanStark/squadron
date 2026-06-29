// Squadron backend. In dev this runs standalone and Vite proxies /api to it.
// Later, this same module becomes the Electron main process.
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as github from './github.js'
import * as runner from './runner.js'
import * as questions from './questions.js'
import * as git from './git.js'
import * as localIssues from './localIssues.js'
import * as preview from './preview.js'
import * as usage from './usage.js'
import * as runConfig from './runConfig.js'
import * as selectedRepos from './selectedRepos.js'
import { bus, listTasks, getTask, createTask, findActiveByIssue, resolveAssignment, listAgents, addEvent } from './tasks.js'

const app = express()
const PORT = process.env.PORT || 5174

app.use(express.json())

// Resolve who works a new task. Explicit `agentId`/`fresh` win; otherwise the
// GENERAL auto-routes it to the best agent (or a fresh one). Returns the resolved
// assignment ({ resume, agentId, agentName, model }) plus the General's reason.
async function assignTask({ owner, repo, instruction, agentId, fresh, model }) {
  let reason = null
  if (!agentId && !fresh) {
    const g = await runner.chooseAssignment({ owner, repo, instruction })
    if (g.agentId) agentId = g.agentId
    else fresh = true // the General chose a fresh agent — don't fall back to the heuristic
    reason = g.reason
  }
  const a = await resolveAssignment({ owner, repo, agentId, fresh, model })
  return { ...a, reason }
}

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

// Live Claude subscription usage (the numbers `/usage` shows). Reads the user's
// Claude Code login token — see server/usage.js.
app.get('/api/usage', handle(() => usage.get()))

// The sidebar fleet = only the repos the user has curated. Fetch each in
// parallel; if one was deleted/renamed its `gh repo view` throws — drop it
// rather than failing the whole list.
app.get('/api/repos', handle(async () => {
  const names = await selectedRepos.list()
  const results = await Promise.all(names.map((nwo) =>
    github.getRepo(nwo).catch((err) => {
      console.error(`[GET /api/repos] dropping ${nwo}:`, err.message)
      return null
    })))
  return results.filter(Boolean)
}))

// Every repo accessible to the user — the source for the "Add repo" picker.
// This is the only place `gh repo list` runs, and only on demand.
app.get('/api/repos/all', handle((req) =>
  github.listRepos({ limit: Number(req.query.limit) || 100 })))

// The curated set of nameWithOwner strings.
app.get('/api/selected-repos', handle(() => selectedRepos.list()))

app.post('/api/selected-repos', handle(async (req) => {
  const nwo = (req.body?.nameWithOwner || '').trim()
  if (!nwo) throw new Error('nameWithOwner is required')
  return selectedRepos.add(nwo)
}))

app.delete('/api/selected-repos/:owner/:repo', handle((req) =>
  selectedRepos.remove(`${req.params.owner}/${req.params.repo}`)))

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

// Fresh detail for a single PR (incl. CI rollup + mergeable state).
app.get('/api/repos/:owner/:repo/pulls/:number', handle((req) =>
  github.getPr(req.params.owner, req.params.repo, req.params.number)))

// Merge a PR. Only reachable from the UI when CI is green and the PR is
// mergeable; GitHub enforces branch protection regardless.
app.post('/api/repos/:owner/:repo/pulls/:number/merge', handle(async (req) =>
  ({ merged: await github.mergePr(req.params.owner, req.params.repo, req.params.number, { method: req.body?.method }) })))

// --- Agents / tasks (slice 2) ---

// Start an interactive planning session for an issue. Returns the created task
// immediately; the plan chat streams over /api/stream.
app.post('/api/repos/:owner/:repo/plan', handle(async (req) => {
  const { owner, repo } = req.params
  const { issueNumber, issueTitle, model, defaultBranch, local, body, agentId, fresh } = req.body
  if (!issueNumber) throw new Error('issueNumber is required')
  // Dedupe: if a plan/run is already in flight for this issue, return it
  // instead of spawning a second agent.
  const existing = await findActiveByIssue(owner, repo, issueNumber)
  if (existing) return { ...existing, deduped: true }
  // The General assigns a person to scope this issue (or you can pin one). It
  // continues an existing agent's context when that helps, else starts fresh.
  const a = await assignTask({ owner, repo, instruction: [issueTitle, body].filter(Boolean).join(' — '), agentId, fresh, model })
  const task = await createTask({ owner, repo, issueNumber, issueTitle, model: a.model || model, local: !!local, body, agentId: a.agentId, agentName: a.agentName })
  if (a.reason) addEvent(task.id, { kind: 'status', text: `🎖 General → ${a.agentName || 'a new agent'}: ${a.reason}` })
  runner.startPlan(task, { defaultBranch, resume: a.resume }).catch((e) => console.error('startPlan crashed', e))
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

// Dispatch an agent to fix failing CI on a PR. The fix lands in Ready to Review;
// pushing it updates the existing PR branch (no new PR). Streams over /api/stream.
app.post('/api/repos/:owner/:repo/pulls/:number/fix-ci', handle(async (req) => {
  const { owner, repo, number } = req.params
  const { prTitle, model } = req.body || {}
  const existing = await findActiveByIssue(owner, repo, number, 'fix')
  if (existing) return { ...existing, deduped: true }
  const task = await createTask({ owner, repo, issueNumber: Number(number), issueTitle: prTitle, model, kind: 'fix' })
  runner.startCiFix(task).catch((e) => console.error('startCiFix crashed', e))
  return task
}))

// Start an interactive "quick fix" on an open PR: a plan-less, write-capable
// agent session checked out on the PR's head branch. The operator chats with it,
// stages the result into Ready to Review, then pushes — which updates the PR in
// place (no new PR). Useful for addressing reviewer feedback. Streams over /api/stream.
app.post('/api/repos/:owner/:repo/pulls/:number/fix', handle(async (req) => {
  const { owner, repo, number } = req.params
  const { prTitle, instruction, model } = req.body || {}
  const text = (instruction || '').trim()
  if (!text) throw new Error('instruction is required')
  const existing = await findActiveByIssue(owner, repo, number, 'pr_fix')
  if (existing) return { ...existing, deduped: true }
  const task = await createTask({
    owner, repo, issueNumber: Number(number), issueTitle: prTitle || `PR #${number}`,
    kind: 'pr_fix', local: true, body: text, model,
  })
  runner.startPrFix(task, { instruction: text }).catch((e) => console.error('startPrFix crashed', e))
  return task
}))

// Start an AI merge-conflict resolution for a PR. Merges base into the head in
// an isolated worktree, has the agent resolve the conflicts, then waits for
// operator review before pushing back to the PR's branch. Streams over /api/stream.
app.post('/api/repos/:owner/:repo/resolve', handle(async (req) => {
  const { owner, repo } = req.params
  const { prNumber, prTitle, model } = req.body
  if (!prNumber) throw new Error('prNumber is required')
  const existing = await findActiveByIssue(owner, repo, prNumber, 'resolve')
  if (existing) return { ...existing, deduped: true }
  const task = await createTask({ owner, repo, issueNumber: prNumber, issueTitle: prTitle, model, kind: 'resolve' })
  runner.startResolve(task).catch((e) => console.error('startResolve crashed', e))
  return task
}))

// Start a plan-less interactive "errand": a quick task whose changes land in
// Ready to Review without the plan/approve ceremony. Streams over /api/stream.
app.post('/api/repos/:owner/:repo/errand', handle(async (req) => {
  const { owner, repo } = req.params
  const { instruction, model, defaultBranch, fresh, agentId } = req.body || {}
  const text = (instruction || '').trim()
  if (!text) throw new Error('instruction is required')
  // The General assigns this quick task to the best agent — continuing one whose
  // context fits (saving tokens) or a fresh one. `agentId` pins a specific agent;
  // `fresh: true` forces a clean slate.
  const a = await assignTask({ owner, repo, instruction: text, agentId, fresh, model })
  const task = await createTask({
    owner, repo, issueNumber: null, issueTitle: text.slice(0, 80), kind: 'errand', local: true, body: text,
    model: a.model || model, agentId: a.agentId, agentName: a.agentName,
  })
  if (a.reason) addEvent(task.id, { kind: 'status', text: `🎖 General → ${a.agentName || 'a new agent'}: ${a.reason}` })
  runner.startErrand(task, { instruction: text, defaultBranch, resume: a.resume }).catch((e) => console.error('startErrand crashed', e))
  return task
}))

// Stage an errand's working-tree changes into Ready to Review.
app.post('/api/tasks/:id/stage', handle(async (req) => ({ staged: await runner.stageErrand(req.params.id) })))

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

// Live preview for an open PR — check out its head and run the dev server, so the
// PR can be exercised in the browser before merging. Same-repo PRs only (startPr
// rejects forks). Mirrors the task preview routes above.
app.get('/api/repos/:owner/:repo/pulls/:number/preview', handle((req) =>
  preview.getStatePr(req.params.owner, req.params.repo, req.params.number)))
app.post('/api/repos/:owner/:repo/pulls/:number/preview', handle((req) =>
  preview.startPr(req.params.owner, req.params.repo, req.params.number)))
app.delete('/api/repos/:owner/:repo/pulls/:number/preview', handle((req) =>
  preview.stopPr(req.params.owner, req.params.repo, req.params.number)))

// Per-repo run command (override the auto-detected one).
app.get('/api/repos/:owner/:repo/run-command', handle(async (req) =>
  ({ command: await runConfig.getCmd(`${req.params.owner}/${req.params.repo}`) })))
app.put('/api/repos/:owner/:repo/run-command', handle(async (req) =>
  ({ command: await runConfig.setCmd(`${req.params.owner}/${req.params.repo}`, (req.body?.command || '').trim()) })))

app.get('/api/tasks', handle(() => listTasks()))

// The roster of agents (persons) you can assign work to.
app.get('/api/agents', handle(() => listAgents()))

app.get('/api/tasks/:id', handle(async (req) => {
  const t = await getTask(req.params.id)
  if (!t) throw new Error('task not found')
  return t
}))

app.post('/api/tasks/:id/cancel', handle(async (req) => ({ cancelled: runner.cancel(req.params.id) })))

// Dismiss every inactive agent at once (cleans up worktrees + drops history).
// Declared before the :id route so "clear-inactive" isn't captured as an id.
app.post('/api/tasks/clear-inactive', handle(async () => ({ cleared: await runner.discardInactive() })))

// Dismiss a single inactive agent (finished/cancelled/errored) and reclaim its
// worktree + history. Refuses agents that are still active or awaiting you.
app.delete('/api/tasks/:id', handle(async (req) => {
  const deleted = await runner.discardTask(req.params.id)
  if (!deleted) throw new Error('agent is still active — cancel it first')
  return { deleted }
}))

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

// In the packaged (Electron) app, serve the built frontend from the same origin
// so /api calls need no proxy. SQUADRON_SERVE_WEB is set by the Electron main.
if (process.env.SQUADRON_SERVE_WEB) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const webDist = path.join(__dirname, '..', 'web', 'dist')
  app.use(express.static(webDist))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next()
    res.sendFile(path.join(webDist, 'index.html'))
  })
}

// Resolves once the server is listening (Electron waits on this before opening the window).
export const started = new Promise((resolve) => {
  app.listen(PORT, () => {
    console.log(`\n  🛩  Squadron server ready → http://localhost:${PORT}\n`)
    resolve(PORT)
  })
})
